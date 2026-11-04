// Pinned local Supabase only. Every synthetic fixture and assertion rolls back.
// --with-migration additionally validates the unapplied migration in that transaction.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LOCAL_GUARD, dockerArgs } from '../scripts/import-reference.mjs';
import { assertLocalProject } from '../scripts/guard.mjs';

assertLocalProject();
const args = process.argv.slice(2);
if (args.some(arg => !['--with-migration','--with-inventory-migration'].includes(arg)) || args.length > 1) throw new Error('Choose one optional local migration validation.');
const withMigration = args.includes('--with-migration');
const withInventoryMigration=args.includes('--with-inventory-migration');
const suffix = randomUUID(), q = value => "'" + String(value).replaceAll("'", "''") + "'";
const agencyA = Date.now() * 1000 + randomInt(999), agencyB = agencyA + 1;
const names = ['a', 'b', 'ambiguous', 'conflict', 'missingVehicle', 'departure', 'inactive', 'cross', 'manual', 'legacy', 'expired'];
const ids = Object.fromEntries([...names, 'admin', 'manager', 'viewer', 'aUber', 'aBolt', 'bBolt', 'expiredBolt'].map(name => [name, randomUUID()]));
const code = name => 'MYCLICAR_DRIVER_' + name + '_' + suffix;
const car = name => 'MYCLICAR_CAR_' + name + '_' + suffix;
const plate = name => 'SYNTHETIC-' + name + '-' + suffix;
const number = name => 'MYCLICAR_CONTRACT_' + name + '_' + suffix;
const external = name => 'MYCLICAR_EXTERNAL_' + name + '_' + suffix;
const oldPlateB = 'SYNTHETIC-OLD-B-' + suffix;
const vehicleNames = ['a', 'b', 'ambiguous1', 'ambiguous2', 'conflict1', 'conflict2', 'missingDriver', 'departure', 'inactive', 'cross', 'manualWanted', 'manualKept'];
const row = (name, driver, vehicle, extra = {}) => ({ external_id: external(name), num: number(name), client_code: code(driver),
  name: 'Same synthetic provider name', plate: plate(vehicle), temporary_plate: '', model: 'Synthetic vehicle', status: 'IN_PROGRESS',
  start_at: '2020-01-01T12:00:00.000Z', effective_start_at: '2020-01-01T12:00:00.000Z', end_at: null,
  provider_updated_at: '2020-01-01T12:00:00.000Z', deleted: false, ...extra });
const contracts = [row('a', 'a', 'a'), row('b', 'b', 'b', { plate: '', temporary_plate: oldPlateB }),
  row('ambiguous', 'ambiguous', 'ambiguous'), row('conflict1', 'conflict', 'conflict1'), row('conflict2', 'conflict', 'conflict2'),
  row('missingDriver', 'missingDriver', 'missingDriver'), row('missingVehicle', 'missingVehicle', 'missingVehicle'),
  row('departure', 'departure', 'departure', { effective_start_at: null }), row('inactive', 'inactive', 'inactive'),
  row('cross', 'cross', 'cross'), row('manual', 'manual', 'manualWanted')];
const payload = rows => q(JSON.stringify(rows)) + '::jsonb';
const sync = (rows = contracts, observed = 'now()') => `public.fleet_sync_myclicar(${payload(rows)},${observed})`;
const link = (driver, contract = driver) => `public.fleet_auto_link_myclicar_vehicle(${q(ids[driver])},${q(external(contract))})`;
const fixtureIDs = contracts.map(contract => q(contract.external_id)).join(',');
const fixtureNumbers = contracts.map(contract => q(contract.num)).join(',');
let checks = 0;
const check = (condition, label) => {
  checks++;
  return `do $test$ begin if (${condition}) is distinct from true then raise exception 'myclicar-test: ${label}'; end if; end $test$;`;
};
const denied = (statement, label, error = 'insufficient_privilege') => {
  checks++;
  return `do $test$ declare refused boolean:=false; begin
    begin ${statement}; exception when ${error} then refused:=true; end;
    if not refused then raise exception 'myclicar-test: ${label}'; end if; end $test$;`;
};
const perform = expression => `do $work$ begin perform ${expression}; end $work$;`;
const auth = name => `reset role; set local role authenticated;
  set local request.jwt.claim.sub=${q(ids[name])};
  set local request.jwt.claims=${q(JSON.stringify({ sub: ids[name], role: 'authenticated' }))};`;
const service = "reset role; set local request.jwt.claim.sub=''; set local request.jwt.claims='{}'; set local role service_role;";
const clearA = `update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}' where id=${q(ids.a)};`;
const checkpoint = (identity, vehicle) => `insert into public.fleet_motion_checkpoints(identity_id,vehicle_key,source,state,updated_at)
  values(${q(ids[identity])},${q(car(vehicle))},'bolt',jsonb_build_object('version',1,'identity_id',${q(ids[identity])},
    'vehicle_key',${q(car(vehicle))},'source','bolt','distance_m',125),now());`;

const sql = [
  "begin; set local statement_timeout='20s'; set local lock_timeout='2s'; set local client_min_messages=warning;",
  LOCAL_GUARD,
  "load 'safeupdate';",
  ...(withMigration ? [check("to_regclass('public.fleet_myclicar_contracts') is null", 'migration_already_applied'),
    readFileSync(new URL('../supabase/migrations/20261124000000_myclicar.sql', import.meta.url), 'utf8')] : []),
  check("to_regclass('public.fleet_myclicar_contracts') is not null", 'migration_missing'),
  ...(withInventoryMigration?[check("to_regclass('public.fleet_myclicar_vehicles') is null",'inventory_migration_already_applied'),readFileSync(new URL('../supabase/migrations/20261207000000_full_inventory.sql',import.meta.url),'utf8')]:[]),
  perform("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
  `insert into public.agencies(id,name) overriding system value values
    (${agencyA},'Synthetic MyClicar A'),(${agencyB},'Synthetic MyClicar B');`,
  `insert into public.vehicles(key,plate,other_plates,model,agency_id,geotab_id,active) values ${vehicleNames.map(name =>
    `(${q(car(name))},${q(plate(name.startsWith('ambiguous') ? 'ambiguous' : name))},${q(name === 'b' ? oldPlateB : '')},'Local model',
      ${name === 'cross' ? agencyB : agencyA},${q('SYNTHETIC-GEOTAB-' + name + '-' + suffix)},${q(name === 'inactive' ? 'NON' : 'OUI')})`).join(',')};`,
  `insert into public.drivers(code,name,phone,email,note,agency_id,source,status) values ${names.map(name =>
    `(${q(code(name))},${q('Local synthetic ' + name)},'0000000000',${q(name + '@example.invalid')},'Keep local note',${agencyA},${q(name === 'legacy' ? 'contrats' : 'manuel')},'ACTIF')`).join(',')};`,
  `insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,link_method) values ${names.map(name =>
    `(${q(ids[name])},${q('Fleet synthetic ' + name)},${q(code(name))},${agencyA},'exact_name')`).join(',')};`,
  `update public.fleet_drivers set vehicle_key=${q(car('manualKept'))},vehicle_link_method='manual',auto_link_disabled=true where id=${q(ids.manual)};`,
  `insert into public.fleet_identities(id,driver_id,source,source_key) values
    (${q(ids.aUber)},${q(ids.a)},'uber',${q('myclicar-a-uber-' + suffix)}),
    (${q(ids.aBolt)},${q(ids.a)},'bolt',${q('myclicar-a-bolt-' + suffix)}),
    (${q(ids.bBolt)},${q(ids.b)},'bolt',${q('myclicar-b-bolt-' + suffix)}),
    (${q(ids.expiredBolt)},${q(ids.expired)},'bolt',${q('myclicar-expired-' + suffix)});`,
  `insert into public.contracts(num,client_code,name,phone,email,comment,imported_at) values
    (${q(number('a'))},${q(code('a'))},'Previous name','1111111111','contract@example.invalid','Keep contract note','2020-01-01T00:00:00Z');`,
  `insert into auth.users(id,email,aud,role) values ${['admin', 'manager', 'viewer'].map(name =>
    `(${q(ids[name])},${q('myclicar-' + name + '-' + suffix + '@example.invalid')},'authenticated','authenticated')`).join(',')};`,
  ...['admin', 'manager', 'viewer'].map(name => `update public.profiles set role=${q(name)} where user_id=${q(ids[name])};`),
  `insert into public.user_agencies(user_id,agency_id) values (${q(ids.manager)},${agencyA}),(${q(ids.viewer)},${agencyA});`,
  service,
  check(`(${sync()}->>'contracts')::integer=11`, 'eleven_contract_snapshot'),
  check(`(select count(*) from public.fleet_myclicar_contracts where external_id in (${fixtureIDs}) and current)=11`, 'complete_snapshot_saved'),
  check(`(select count(*) from public.contracts where num in (${fixtureNumbers}))=8`, 'reference_import_requires_exact_existing_references'),
  check(`(select name='Local synthetic a' and phone='0000000000' and email='a@example.invalid' and note='Keep local note'
    and agency_id=${agencyA} and source='manuel' and n_contracts=1 from public.drivers where code=${q(code('a'))})`, 'driver_contacts_and_manual_choices_preserved'),
  check(`exists(select 1 from public.drivers where code=${q(code('legacy'))} and source='contrats')`, 'global_refresh_drivers_not_invoked'),
  check(`(select phone='1111111111' and email='contract@example.invalid' and comment='Keep contract note'
    and imported_at='2020-01-01T00:00:00Z'::timestamptz from public.contracts where num=${q(number('a'))})`, 'existing_contract_contacts_preserved'),
  check(`(select model='Local model' and agency_id=${agencyA} and geotab_id=${q('SYNTHETIC-GEOTAB-a-' + suffix)} from public.vehicles where key=${q(car('a'))})`, 'geotab_and_local_vehicle_preserved'),
  check(`(select vehicle_key=${q(car('b'))} and eligible from public.fleet_myclicar_contracts where external_id=${q(external('b'))})`, 'temporary_historical_plate_resolved'),
  ...Object.entries({ ambiguous: 'ambiguous_vehicle', conflict1: 'conflicting_contracts', conflict2: 'conflicting_contracts',
    missingDriver: 'unknown_driver', missingVehicle: 'unknown_vehicle', departure: 'departure_unconfirmed', inactive: 'inactive_vehicle', cross: 'agency_mismatch' })
    .map(([name, reason]) => check(`(select not eligible and reason=${q(reason)} from public.fleet_myclicar_contracts where external_id=${q(external(name))})`, 'reject_' + reason + '_' + name)),
  ...['manager', 'viewer'].flatMap(name => [auth(name),
    check(`case when to_regclass('public.fleet_myclicar_vehicles') is not null then (select count(*) from public.fleet_myclicar_contracts where external_id in (${fixtureIDs}))=8 else not exists(select 1 from public.fleet_myclicar_contracts) end`, name + '_provider_contracts_scoped'),
    check("not exists(select 1 from public.fleet_sources where id='myclicar')", name + '_cannot_read_source_metadata'),
    denied(`perform ${sync([])}`, name + '_cannot_sync'), denied(`perform ${link('a')}`, name + '_cannot_auto_assign'),
    denied(`update public.fleet_myclicar_contracts set status='CLOSED' where external_id=${q(external('a'))}`, name + '_cannot_write')]),
  auth('admin'),
  check(`(select count(*) from public.fleet_myclicar_contracts where external_id in (${fixtureIDs}))=11`, 'admin_can_read_provider_contracts'),
  denied(`perform ${sync([])}`, 'browser_admin_cannot_sync'), denied(`perform ${link('a')}`, 'browser_admin_cannot_auto_assign'),
  'reset role; set local role anon;',
  denied('perform 1 from public.fleet_myclicar_contracts limit 1', 'anonymous_cannot_read'),
  denied(`perform ${sync([])}`, 'anonymous_cannot_sync'), denied(`perform ${link('a')}`, 'anonymous_cannot_auto_assign'),
  service,
  check("not has_function_privilege('service_role','public.fleet_auto_link_vehicle_platform_base(uuid,text,jsonb)','EXECUTE')", 'platform_base_cannot_bypass_guard'),
  `update public.fleet_sources set status='healthy',last_success_at=now(),stale_after_s=300 where id='myclicar';`,
  check(`not ${link('a', 'notPresent')}`, 'absent_contract_refused'), check(`not ${link('b', 'a')}`, 'wrong_exact_driver_code_refused'),
  ...[['ambiguous', 'ambiguous'], ['conflict', 'conflict1'], ['missingVehicle', 'missingVehicle'], ['departure', 'departure'], ['inactive', 'inactive'], ['cross', 'cross']]
    .map(([driver, contract]) => check(`not ${link(driver, contract)}`, 'unsafe_assignment_refused_' + driver)),
  check(`not ${link('manual')}`, 'manual_choice_takes_priority'),
  check(`(select vehicle_key=${q(car('manualKept'))} and auto_link_disabled and vehicle_link_method='manual' from public.fleet_drivers where id=${q(ids.manual)})`, 'manual_choice_unchanged'),
  `update public.fleet_sources set status='paused' where id='myclicar';`, check(`not ${link('a')}`, 'paused_source_refused'),
  `update public.fleet_sources set status='error' where id='myclicar';`, check(`not ${link('a')}`, 'failed_source_refused'),
  `update public.fleet_sources set status='healthy',last_success_at=now()-interval '301 seconds' where id='myclicar';`, check(`not ${link('a')}`, 'stale_source_refused'),
  `update public.fleet_sources set last_success_at=now() where id='myclicar';
   update public.fleet_myclicar_contracts set observed_at=now()-interval '301 seconds' where external_id=${q(external('a'))};`,
  check(`not ${link('a')}`, 'stale_contract_refused'),
  `update public.fleet_myclicar_contracts set observed_at=now() where external_id=${q(external('a'))};`,
  `update public.fleet_drivers set vehicle_key=${q(car('a'))},vehicle_link_method='platform_plate',
    vehicle_link_evidence=jsonb_build_object('expires_at',now()-interval '1 second') where id=${q(ids.expired)};`,
  check(link('a'), 'exact_code_and_plate_assign'),
  check(`(select vehicle_key is null from public.fleet_drivers where id=${q(ids.expired)})`, 'expired_automatic_holder_released'),
  check(`(select vehicle_key=${q(car('a'))} and vehicle_link_method='myclicar_contract'
    and vehicle_link_evidence->>'contract_id'=${q(external('a'))}
    and (vehicle_link_evidence->>'expires_at')::timestamptz=now()+interval '300 seconds'
    from public.fleet_drivers where id=${q(ids.a)})`, 'assignment_has_bounded_contract_proof'),
  check(link('b'), 'historical_plate_assign'),
  clearA,
  `update public.fleet_sources set status='healthy',last_success_at=now(),stale_after_s=150 where id in('uber','bolt');
   insert into public.fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence)
   values(${q(ids.aUber)},${q(ids.a)},'uber','available',now(),now(),${q(plate('b'))},'{"method":"visible_dom"}');`,
  check(`not ${link('a')}`, 'fresh_visible_platform_contradiction_refused'),
  `update public.fleet_latest set observed_at=now()-interval '151 seconds' where identity_id=${q(ids.aUber)};`,
  check(link('a'), 'stale_platform_label_does_not_override_contract'), clearA,
  `update public.fleet_latest set observed_at=now(),vehicle_label=${q(plate('a'))} where identity_id=${q(ids.aUber)};
   insert into public.fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence)
   values(${q(ids.aBolt)},${q(ids.a)},'bolt','available',now(),now(),${q(plate('b'))},'{"method":"official_api","vehicle_origin":"bolt_live"}');`,
  check(`not ${link('a')}`, 'fresh_bolt_live_contradiction_refused'),
  `update public.fleet_latest set evidence='{"method":"official_api","vehicle_origin":"bolt_catalog"}' where identity_id=${q(ids.aBolt)};`,
  check(link('a'), 'catalogue_only_label_is_not_live_evidence'),
  check(`not public.fleet_auto_link_vehicle(${q(ids.a)},${q(car('b'))},jsonb_build_object('method','platform_plate','source','bolt',
    'observed_at',now(),'expires_at',now()+interval '150 seconds'))`, 'platform_rpc_cannot_override_current_contract'),
  denied(`perform ${sync([contracts[0], contracts[0]])}`, 'duplicate_snapshot_refused', 'raise_exception'),
  denied(`perform ${sync(contracts, "now()-interval '301 seconds'")}`, 'stale_snapshot_refused', 'raise_exception'),
  check(`(select count(*) from public.fleet_myclicar_contracts where external_id in (${fixtureIDs}) and current)=11`, 'invalid_snapshot_keeps_complete_previous_state'),
  checkpoint('aBolt', 'a'), checkpoint('bBolt', 'b'),
  perform(sync(contracts.filter(contract => contract.external_id !== external('a')))),
  check(`(select not current and not eligible and end_at is null from public.fleet_myclicar_contracts where external_id=${q(external('a'))})`, 'absence_revokes_without_inventing_return'),
  check(`(select vehicle_key is null and vehicle_link_evidence='{}'::jsonb from public.fleet_drivers where id=${q(ids.a)})`, 'missing_contract_revokes_lease'),
  check(`not exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(ids.aBolt)})`, 'missing_contract_discards_motion_checkpoint'),
  check(`exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(ids.bBolt)})`, 'unrelated_valid_checkpoint_preserved'),
  check(`(select end_at is null and status='IN_PROGRESS' from public.contracts where num=${q(number('a'))})`, 'absence_does_not_close_reference_contract'),
  check(`not ${link('a')}`, 'absent_contract_cannot_recreate_assignment'),
  check(`exists(select 1 from public.fleet_link_audit where driver_id=${q(ids.a)} and action='vehicle_revoke' and method='myclicar_contract')`, 'revocation_audited'),
  perform(sync([])),
  check(`not exists(select 1 from public.fleet_myclicar_contracts where external_id in (${fixtureIDs}) and current)`, 'complete_empty_snapshot_invalidates_all_claims'),
  check(`(select vehicle_key is null from public.fleet_drivers where id=${q(ids.b)})`, 'empty_snapshot_revokes_last_automatic_lease'),
  check(`not exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(ids.bBolt)})`, 'empty_snapshot_discards_last_checkpoint'),
  check(`(select vehicle_key=${q(car('manualKept'))} from public.fleet_drivers where id=${q(ids.manual)})`, 'empty_snapshot_preserves_manual_assignment'),
  check(`(select count(*) from public.contracts where num in (${fixtureNumbers}))=8`, 'complete_empty_snapshot_preserves_contract_history'),
  'reset role; rollback;', "select 'MYCLICAR_LOCAL_ROLLBACK_OK';"
].join('\n');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
// The local superuser loads the same safe-update guard as PostgREST; fixtures
// and connector calls below still run under their explicit browser/service roles.
const localArgs = dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--file=/dev/stdin'])
  .map(arg => arg === '--username=postgres' ? '--username=supabase_admin' : arg);
const result = spawnSync('docker', localArgs,
  { env, input: sql, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
if (result.error || result.status !== 0) {
  const label = String(result.stderr || '').match(/myclicar-test: ([a-zA-Z_]+)/)?.[1];
  const state = String(result.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
  throw new Error('Local MyClicar validation failed; transaction rolled back.' + (label ? ' Check: ' + label : state ? ' SQLSTATE: ' + state : ' No database output disclosed.'));
}
assert.equal(result.stdout.trim(), 'MYCLICAR_LOCAL_ROLLBACK_OK');
console.log(JSON.stringify({ ok: true, checks, contracts: contracts.length, migration_simulated: withMigration, rolled_back: true }));
