// Pinned local Supabase only. All changes, including --with-migration, roll back.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LOCAL_GUARD, dockerArgs } from '../scripts/import-reference.mjs';
import { assertLocalProject } from '../scripts/guard.mjs';

assertLocalProject();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--with-migration')) throw new Error('Only --with-migration is supported.');
const withMigration = args.includes('--with-migration');
const suffix = randomUUID();
const ids = Object.fromEntries(['driver', 'uber', 'bolt', 'admin', 'viewer'].map(name => [name, randomUUID()]));
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const code = 'DETAIL_DRIVER_' + suffix, car = 'DETAIL_CAR_' + suffix, otherCar = 'DETAIL_OTHER_' + suffix;
const plate = 'DETAIL-ONE-' + suffix, otherPlate = 'DETAIL-TWO-' + suffix, alias = 'DETAIL-OLD-' + suffix;
const contract = 'DETAIL_CONTRACT_' + suffix;
const link = `public.fleet_auto_link_myclicar_vehicle(${q(ids.driver)},${q(contract)})`;
const helperSignature = 'public.fleet_vehicle_observation_current(text,text,timestamp with time zone,jsonb,text,timestamp with time zone,integer)';
const helper = "public.fleet_vehicle_observation_current('uber','on_trip',now(),'{}'::jsonb,'healthy',now(),45)";
let checks = 0;
const check = (condition, label) => {
  checks++;
  return `do $test$ begin if (${condition}) is distinct from true then raise exception 'vehicle-details-test: ${label}'; end if; end $test$;`;
};
const denied = (expression, label) => {
  checks++;
  return `do $test$ declare refused boolean:=false; begin
    begin perform ${expression}; exception when insufficient_privilege then refused:=true; end;
    if not refused then raise exception 'vehicle-details-test: ${label}'; end if; end $test$;`;
};
const json = value => q(JSON.stringify(value)) + '::jsonb';
const service = "reset role; set local request.jwt.claim.sub=''; set local request.jwt.claims='{}'; set local role service_role;";
const auth = name => `reset role; set local role authenticated;
  set local request.jwt.claim.sub=${q(ids[name])};
  set local request.jwt.claims=${q(JSON.stringify({ sub: ids[name], role: 'authenticated' }))};`;
const resetDriver = `update public.fleet_drivers set vehicle_key=null,vehicle_link_method=null,vehicle_link_evidence='{}'
  where id=${q(ids.driver)};`;
const freshSources = `update public.fleet_sources set status='healthy',last_success_at=now(),
  stale_after_s=case id when 'uber' then 45 when 'bolt' then 150 else 300 end
  where id in ('uber','bolt','myclicar');`;
const scenario = (label, shouldBlock, options = {}) => {
  const source = options.source || 'uber';
  const evidence = { method: source === 'uber' ? 'visible_dom' : 'official_api',
    ...(source === 'bolt' ? { vehicle_origin: 'bolt_live' } : {}), ...options.evidence };
  const proof = json(evidence) + (options.capturedAt
    ? `||jsonb_build_object('vehicle_observed_at',${options.capturedAt})` : '');
  return [resetDriver, freshSources,
    `delete from public.fleet_latest where driver_id=${q(ids.driver)};
     insert into public.fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence)
     values(${q(ids[source])},${q(ids.driver)},${q(source)},${q(options.status || 'on_trip')},
       ${options.observedAt || 'now()'},now(),${q(options.plate ?? otherPlate)},${proof});`,
    options.sourceUpdate ? `update public.fleet_sources set ${options.sourceUpdate} where id=${q(source)};` : '',
    check(shouldBlock ? `not ${link}` : link, label),
    check(shouldBlock
      ? `(select vehicle_key is null from public.fleet_drivers where id=${q(ids.driver)})`
      : `(select vehicle_key=${q(car)} and vehicle_link_method='myclicar_contract'
           and vehicle_link_evidence->>'contract_id'=${q(contract)}
           from public.fleet_drivers where id=${q(ids.driver)})`, label + '_assignment')].join('\n');
};

const sql = [
  "begin; set local statement_timeout='20s'; set local lock_timeout='2s'; set local client_min_messages=warning;",
  LOCAL_GUARD,
  "load 'safeupdate';",
  ...(withMigration ? [readFileSync(new URL('../supabase/migrations/20261126000000_platform_vehicle_details.sql', import.meta.url), 'utf8')] : []),
  check(`to_regprocedure(${q(helperSignature)}) is not null`, 'migration_available'),
  "do $work$ begin perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0)); end $work$;",
  `insert into public.vehicles(key,plate,other_plates,model,active) values
    (${q(car)},${q(plate)},${q(alias)},'Same synthetic model','OUI'),
    (${q(otherCar)},${q(otherPlate)},'','Same synthetic model','OUI');
   insert into public.drivers(code,name) values(${q(code)},'Synthetic shift driver');
   insert into public.fleet_drivers(id,name,ludy_driver_code,link_method)
     values(${q(ids.driver)},'Synthetic shift driver',${q(code)},'exact_name');
   insert into public.fleet_identities(id,driver_id,source,source_key) values
     (${q(ids.uber)},${q(ids.driver)},'uber',${q('detail-uber-' + suffix)}),
     (${q(ids.bolt)},${q(ids.driver)},'bolt',${q('detail-bolt-' + suffix)});
   insert into public.fleet_myclicar_contracts(external_id,num,client_code,plate,status,effective_start_at,
     vehicle_key,vehicle_candidates,current,eligible,observed_at)
     values(${q(contract)},${q(contract)},${q(code)},${q(plate)},'IN_PROGRESS',now()-interval '1 day',
       ${q(car)},array[${q(car)}],true,true,now());`,
  `insert into auth.users(id,email,aud,role) values ${['admin', 'viewer'].map(name =>
    `(${q(ids[name])},${q('vehicle-details-' + name + '-' + suffix + '@example.invalid')},'authenticated','authenticated')`).join(',')};`,
  ...['admin', 'viewer'].map(name => `update public.profiles set role=${q(name)} where user_id=${q(ids[name])};`),
  service, freshSources,
  check(helper, 'service_can_evaluate_proof'),
  check(`has_function_privilege('service_role',${q(helperSignature)},'EXECUTE')`, 'service_helper_granted'),
  check("not has_function_privilege('service_role','public.fleet_auto_link_vehicle_platform_base(uuid,text,jsonb)','EXECUTE')", 'platform_base_still_private'),
  ...['admin', 'viewer'].flatMap(name => [auth(name), denied(helper, name + '_cannot_call_helper'), denied(link, name + '_cannot_auto_assign')]),
  'reset role; set local role anon;', denied(helper, 'anonymous_cannot_call_helper'), denied(link, 'anonymous_cannot_auto_assign'),
  service,
  ...['available', 'on_trip', 'to_pickup', 'on_break'].map(status =>
    scenario('fresh_uber_' + status + '_blocks', true, { status })),
  scenario('cached_detail_120s_with_fresh_status_blocks', true, {
    capturedAt: "now()-interval '120 seconds'", evidence: { vehicle_status: 'available', vehicle_model: 'Same synthetic model' } }),
  scenario('cached_detail_just_before_expiry_blocks', true, { capturedAt: "now()-interval '179.999 seconds'", evidence: { vehicle_status: 'on_trip' } }),
  scenario('cached_detail_expired_does_not_block', false, { capturedAt: "now()-interval '180 seconds'", evidence: { vehicle_status: 'on_trip' } }),
  scenario('cached_detail_old_does_not_block', false, { capturedAt: "now()-interval '1 day'", evidence: { vehicle_status: 'on_trip' } }),
  scenario('cached_detail_newer_than_status_does_not_block', false, { capturedAt: 'now()', observedAt: "now()-interval '1 second'" }),
  scenario('future_detail_does_not_block', false, { capturedAt: "now()+interval '1 second'" }),
  scenario('fresh_detail_stale_status_does_not_block', false, { capturedAt: "now()-interval '100 seconds'", observedAt: "now()-interval '46 seconds'" }),
  scenario('fresh_detail_stale_source_does_not_block', false, { capturedAt: "now()-interval '100 seconds'", sourceUpdate: "last_success_at=now()-interval '46 seconds'" }),
  scenario('paused_source_does_not_block', false, { sourceUpdate: "status='paused'" }),
  scenario('future_source_does_not_block', false, { sourceUpdate: "last_success_at=now()+interval '6 seconds'" }),
  scenario('future_state_does_not_block', false, { observedAt: "now()+interval '6 seconds'", capturedAt: 'now()' }),
  ...['offline', 'unknown'].flatMap(status => [
    scenario('offline_detail_' + status + '_does_not_block', false, { capturedAt: "now()-interval '30 seconds'", evidence: { vehicle_status: status } }),
    scenario('current_' + status + '_does_not_block', false, { status, capturedAt: "now()-interval '30 seconds'", evidence: { vehicle_status: 'on_trip' } }),
    scenario('legacy_' + status + '_does_not_block', false, { status })]),
  ...['suspended', 'deactivated'].map(account_status => scenario(account_status + '_account_does_not_block', false, { evidence: { account_status } })),
  scenario('null_detail_time_uses_fresh_status', true, { evidence: { vehicle_observed_at: null } }),
  scenario('malformed_detail_time_does_not_block', false, { evidence: { vehicle_observed_at: 'not-a-date' } }),
  scenario('structured_detail_time_does_not_block', false, { evidence: { vehicle_observed_at: { at: 'bad' } } }),
  scenario('infinite_detail_time_does_not_block', false, { evidence: { vehicle_observed_at: 'infinity' } }),
  scenario('unrecognized_detail_status_does_not_block', false, { evidence: { vehicle_status: 'unrecognized' } }),
  scenario('untrusted_uber_method_does_not_block', false, { evidence: { method: 'catalogue' } }),
  scenario('legacy_vehicle_proof_capped_at_180s', false, {
    observedAt: "now()-interval '200 seconds'", sourceUpdate: 'stale_after_s=300' }),
  scenario('matching_plate_does_not_block', false, { plate }),
  scenario('matching_old_plate_does_not_block', false, { plate: alias }),
  scenario('matching_model_different_plate_still_blocks', true, { evidence: { vehicle_model: 'Same synthetic model' } }),
  scenario('bolt_live_vehicle_blocks', true, { source: 'bolt' }),
  scenario('bolt_catalogue_vehicle_does_not_block', false, { source: 'bolt', evidence: { vehicle_origin: 'bolt_catalog' } }),
  scenario('bolt_offline_vehicle_does_not_block', false, { source: 'bolt', status: 'offline' }),
  scenario('bolt_stale_vehicle_does_not_block', false, { source: 'bolt', observedAt: "now()-interval '151 seconds'" }),
  scenario('bolt_rejects_non_official_vehicle', false, { source: 'bolt', evidence: { method: 'visible_dom' } }),
  'reset role; rollback;', "select 'PLATFORM_VEHICLE_DETAILS_ROLLBACK_OK';"
].join('\n');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const localArgs = dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--file=/dev/stdin'])
  .map(arg => arg === '--username=postgres' ? '--username=supabase_admin' : arg);
const result = spawnSync('docker', localArgs, { env, input: sql, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
if (result.error || result.status !== 0) {
  const label = String(result.stderr || '').match(/vehicle-details-test: ([a-zA-Z_0-9]+)/)?.[1];
  const state = String(result.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
  throw new Error('Local platform vehicle validation failed; transaction rolled back.' +
    (label ? ' Check: ' + label : state ? ' SQLSTATE: ' + state : ' No database output disclosed.'));
}
assert.equal(result.stdout.trim(), 'PLATFORM_VEHICLE_DETAILS_ROLLBACK_OK');
console.log(JSON.stringify({ ok: true, checks, migration_simulated: withMigration, rolled_back: true }));
