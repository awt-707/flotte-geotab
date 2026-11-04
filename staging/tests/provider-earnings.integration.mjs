import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomInt, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD, dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeUberEarnings, parseUberEarningsPeriod} from '../server/uber-earnings.mjs';
import {getRevenuePeriod} from '../site/revenue-metrics.js';

assertLocalProject();
const args = process.argv.slice(2);
if (new Set(args).size !== args.length || args.some(value => !['--with-migration','--with-semantics','--with-calculations'].includes(value))) throw Error('Only --with-migration and --with-semantics are supported.');
const simulate = args.includes('--with-migration'), semantics = simulate || args.includes('--with-semantics'), now = Date.now(), suffix = randomUUID();
const organization = randomUUID(), agency = now * 1000 + randomInt(500);
const driverA = randomUUID(), driverB = randomUUID(), providerA = randomUUID(), providerB = randomUUID(), unknown = randomUUID();
const codeA = 'STG-EARNINGS-A-' + suffix, codeB = 'STG-EARNINGS-B-' + suffix;
const roles = ['admin', 'manager', 'viewer', 'pending'], users = Object.fromEntries(roles.map(role => [role, randomUUID()]));
const current = getRevenuePeriod({kind: 'week', at: now});
const wall = value => { const p = globalThis.LudyMoroccoTime.moroccoParts(Date.parse(value)); return [p.day,p.month].map(n => String(n).padStart(2,'0')).join('/') + '/' + p.year + ' ' + String(p.hour).padStart(2,'0') + ':' + String(p.minute).padStart(2,'0'); };
const providerPeriod = bounds => ({...parseUberEarningsPeriod(wall(bounds.start) + ' - ' + wall(bounds.end)), mode: 'custom'});
const row = (id, name, amount) => ({providerDriverId: id, driverName: name, driverNameComplete: true, metrics: {revenue: amount + ' MAD', cash: '10 MAD'}});
const baseRows = [row(providerA, 'Synthetic Earnings A', '100'), row(providerB, 'Synthetic Earnings B', '200'), row(unknown, 'Synthetic Earnings Unknown', '300')];
function snapshot(rows = baseRows, {shift = 0, period = current, complete = true, total = rows.length, fleet = '600'} = {}) {
  return normalizeUberEarnings({version: 1, source: 'uber_fleet_earnings', organizationId: organization,
    sourceUrl: `https://fleethub.uber.com/orgs/${organization}/earnings`, observedAt: new Date(now + shift).toISOString(),
    providerPeriod: providerPeriod(period), currency: 'MAD', fleet: {revenue: fleet + ' MAD', end_balance: '90 MAD',reported_net_earnings:'315 MAD'},
    drivers: rows, coverage: {complete, driverRowsObserved: rows.length, driverRowsTotal: total, pages: 1}},
  {organizationId: organization, now: now + Math.max(0, shift)});
}
const first = snapshot(), next = snapshot([row(providerA, 'Synthetic Earnings A', '150'), baseRows[1]], {shift: 1000, fleet: '350'});
const partial = snapshot([baseRows[0]], {shift: 2000, complete: false, total: 2});
const stale = snapshot(baseRows, {shift: -1000});
const conflict = snapshot([row(providerA, 'Synthetic Earnings A', '999')], {shift: 1000});
const history = snapshot([baseRows[0]], {shift: 3000, period: {start: current.previousStart, end: current.previousEnd}, fleet: '100'});
const remapped = snapshot([row(providerA, 'Synthetic Earnings A', '150'), baseRows[1]], {shift: 4000, fleet: '350'});
const badAmount = structuredClone(next); badAmount.observed_at = new Date(now + 5000).toISOString(); badAmount.drivers[1].revenue_minor = 'invalid';
const forgedAgency = structuredClone(next); forgedAgency.drivers[0].agency_id = agency + 1;
const filteredComplete = structuredClone(next); filteredComplete.coverage.filtered = true;
const invalidReportedNet = structuredClone(next); invalidReportedNet.fleet.reported_net_earnings_minor = 'invalid';
const oldNormalizer=structuredClone(next);delete oldNormalizer.fleet.reported_net_earnings_minor;
const legacyOrganization=randomUUID(),legacyAmounts={...first.fleet,net_minor:12345};delete legacyAmounts.reported_net_earnings_minor;
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const j = value => q(JSON.stringify(value)) + '::jsonb';
const call = value => `public.provider_earnings_commit(${j(value)})`;
const perform = value => `do $work$ begin perform ${call(value)};end $work$;`;
const owner = "reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const service = owner + 'set local role service_role;';
const auth = role => `reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub: users[role], role: 'authenticated'}))};`;
const header = `source='uber' and organization_id=${q(organization)}::uuid and period_start=${q(current.start)}::timestamptz`;
const currentId = `(select id from public.provider_earnings_snapshots where ${header})`;
let checks = 0;
const check = (condition, label) => { checks++; return `do $test$ begin if (${condition}) is distinct from true then raise exception 'earnings-test: ${label}';end if;end $test$;`; };
const reject = (statement, label, exception = 'others') => { checks++; return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'earnings-test: ${label}';end if;end $test$;`; };
const migration = readFileSync(new URL('../supabase/migrations/20261224000000_provider_earnings.sql', import.meta.url), 'utf8');
const calculationsMigration = readFileSync(new URL('../supabase/migrations/20261228000000_provider_earnings_calculations.sql', import.meta.url), 'utf8');
const semanticsMigration = readFileSync(new URL('../supabase/migrations/20261226000000_provider_earnings_semantics.sql', import.meta.url), 'utf8');
const semanticsGuard=semanticsMigration.match(/do \$\$ begin[\s\S]*?end \$\$;/)?.[0];if(!semanticsGuard)throw Error('Semantic audit guard missing.');
const sql = [
  "begin;set local statement_timeout='25s';set local lock_timeout='2s';set local client_min_messages=warning;", LOCAL_GUARD,
  ...(simulate ? [migration] : []),
  ...(semantics ? [semanticsMigration] : []),
  ...(args.includes('--with-calculations') ? [calculationsMigration] : []),
  `insert into public.agencies(id,name,city) overriding system value values (${agency},${q('Earnings A ' + suffix)},'Casablanca'),(${agency + 1},${q('Earnings B ' + suffix)},'Rabat');`,
  `insert into auth.users(id,email,aud,role) values ${roles.map(role => `(${q(users[role])},${q('earnings-' + role + '-' + suffix + '@example.invalid')},'authenticated','authenticated')`).join(',')};`,
  ...roles.map(role => `update public.profiles set role=${q(role)} where user_id=${q(users[role])};`),
  `insert into public.user_agencies(user_id,agency_id) values (${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
  `insert into public.drivers(code,name,agency_id,source) values (${q(codeA)},'Synthetic Earnings A',${agency},'manuel'),(${q(codeB)},'Synthetic Earnings B',${agency + 1},'manuel');`,
  `insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,link_method) values (${q(driverA)},'Synthetic Earnings A',${q(codeA)},${agency},'manual'),(${q(driverB)},'Synthetic Earnings B',${q(codeB)},${agency + 1},'manual');`,
  `insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional) values (${q(driverA)},'uber',${q(suffix + '-a')},${q(providerA)},${q(organization)},false),(${q(driverB)},'uber',${q(suffix + '-b')},${q(providerB)},${q(organization)},false);`,
  'create temporary table earnings_legacy_counts as select (select count(*) from public.uber_payments) uber,(select count(*) from public.bolt_sessions) bolt,(select count(*) from public.cash_moves) cash;',
  service,
  check(`(${call(first)}->>'rows')::integer=3`, 'initial_capture_committed'),
  check(`(select count(*) from public.provider_earnings_snapshots where ${header})=1`, 'one_exact_period_header'),
  check(`(select (fleet_amounts->>'revenue_minor')::bigint=60000 and (fleet_amounts->>'end_balance_minor')::bigint=9000 and fleet_amounts->'net_minor'='null'::jsonb and not mapping_complete from public.provider_earnings_snapshots where ${header})`, 'fleet_balance_and_unknown_net_preserved'),
  check(`(select (fleet_amounts->>'reported_net_earnings_minor')::bigint=31500 and fleet_amounts->'net_minor'='null'::jsonb from public.provider_earnings_snapshots where ${header})`, 'reported_net_earnings_separate_from_income_net'),
  check(`(select count(*) from public.provider_earnings_rows where snapshot_id=${currentId} and mapping_status='confirmed')=2`, 'confirmed_uuid_associations_only'),
  check(`(select agency_id is null and driver_code is null and mapping_status='unmatched' from public.provider_earnings_rows where snapshot_id=${currentId} and provider_driver_id=${q(unknown)})`, 'unknown_driver_admin_only'),
  ...roles.flatMap(role => [auth(role),
    check(`(select count(*) from public.provider_earnings_snapshots where organization_id=${q(organization)})=${role === 'admin' ? 1 : 0}`, role + '_fleet_access'),
    check(`(select count(*) from public.provider_earnings_rows where organization_id=${q(organization)})=${role === 'admin' ? 3 : role === 'manager' ? 1 : 0}`, role + '_row_access'),
    reject(`perform ${call(first)}`, role + '_cannot_ingest', 'insufficient_privilege'),
    reject(`update public.provider_earnings_rows set agency_id=${agency + 1} where organization_id=${q(organization)}`, role + '_cannot_forge_mapping', 'insufficient_privilege')
  ]),
  owner, 'create temporary table earnings_refresh_before as select agency_id,version from public.revenue_refresh;', service,
  check(`(${call(first)}->>'duplicate')::boolean`, 'exact_replay_idempotent'),
  check(`(select revision from public.provider_earnings_snapshots where ${header})=1`, 'duplicate_keeps_revision'),
  owner,
  check(`not exists(select 1 from public.revenue_refresh r join earnings_refresh_before b using(agency_id) where r.version<>b.version)`, 'duplicate_has_no_notification'),
  service,
  check(`(${call(next)}->>'revision')::integer=2`, 'same_window_new_version'),
  check(`(select count(*) from public.provider_earnings_rows where snapshot_id=${currentId})=2`, 'same_window_rows_replaced_atomically'),
  check(`(select bool_and(mapping_complete and coverage_complete and agency_rows_total=1 and driver_rows_total=1 and snapshot_revision=2) from public.provider_earnings_rows where snapshot_id=${currentId})`, 'scope_counts_and_revision_consistent'),
  check(`(${call(partial)}->>'reason')='complete_snapshot_preserved'`, 'partial_does_not_erase_complete'),
  check(`(${call(stale)}->>'reason')='stale_observation'`, 'late_response_does_not_roll_back_values'),
  reject(`perform ${call(conflict)}`, 'conflicting_same_instant_refused'),
  reject(`perform ${call(badAmount)}`, 'invalid_second_row_rolls_back_batch'),
  reject(`perform ${call(forgedAgency)}`, 'client_agency_field_refused'),
  reject(`perform ${call(filteredComplete)}`, 'filtered_population_cannot_be_complete'),
  reject(`perform ${call(invalidReportedNet)}`, 'reported_net_earnings_requires_integer_or_null'),
  reject(`perform ${call(oldNormalizer)}`, 'old_normalizer_requires_updated_semantic_contract'),
  check(`(select revision=2 and (fleet_amounts->>'revenue_minor')::bigint=35000 from public.provider_earnings_snapshots where ${header})`, 'failed_capture_preserves_previous_values'),
  perform(history),
  check(`(select count(*) from public.provider_earnings_snapshots where organization_id=${q(organization)})=2`, 'different_period_preserves_history'),
  owner,
  'create temporary table earnings_before_remap as select agency_id,version from public.revenue_refresh;',
  `update public.drivers set agency_id=${agency + 1} where code=${q(codeA)};update public.fleet_drivers set agency_id=${agency + 1} where id=${q(driverA)};`,
  service, perform(remapped),
  check(`(select bool_and(agency_id=${agency + 1} and agency_rows_total=2 and snapshot_revision=3) from public.provider_earnings_rows where snapshot_id=${currentId})`, 'updated_confirmed_mapping_is_atomic'),
  owner,
  check(`(select bool_and(r.version=b.version+1) from public.revenue_refresh r join earnings_before_remap b using(agency_id) where r.agency_id in (0,${agency},${agency + 1}))`, 'old_and_new_scopes_refreshed'),
  check(`(select count(*) from public.provider_earnings_rows where organization_id=${q(organization)} and period_start=${q(current.previousStart)}::timestamptz and agency_id=${agency})=1`, 'historical_window_mapping_preserved'),
  check("not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('provider_earnings_snapshots','provider_earnings_rows'))", 'financial_payload_not_published'),
  check('(select uber=(select count(*) from public.uber_payments) and bolt=(select count(*) from public.bolt_sessions) and cash=(select count(*) from public.cash_moves) from earnings_legacy_counts)', 'legacy_financial_tables_unchanged'),
  `insert into public.provider_earnings_snapshots(source,organization_id,period_start,period_end,time_zone,period_label,period_mode,currency,observed_at,sha256,content_fingerprint,mapping_fingerprint,coverage,mapping_complete,fleet_amounts,source_url)
   values('uber',${q(legacyOrganization)},${q(current.start)},${q(current.end)},'Africa/Casablanca','Synthetic legacy net audit','custom','MAD',now(),${q('0'.repeat(64))},'synthetic','synthetic','{}',false,${j(legacyAmounts)},${q('https://fleethub.uber.com/orgs/'+legacyOrganization+'/earnings')});`,
  reject(semanticsGuard.replace(/;$/,''),'historical_net_requires_explicit_audit'),
  check(`(select (fleet_amounts->>'net_minor')::integer=12345 and not(fleet_amounts ? 'reported_net_earnings_minor') from public.provider_earnings_snapshots where organization_id=${q(legacyOrganization)})`,'historical_net_never_rewritten'),
  'set local role anon;',
  reject('perform 1 from public.provider_earnings_snapshots limit 1', 'anonymous_no_header', 'insufficient_privilege'),
  reject('perform 1 from public.provider_earnings_rows limit 1', 'anonymous_no_rows', 'insufficient_privilege'),
  reject(`perform ${call(first)}`, 'anonymous_no_ingestion', 'insufficient_privilege'),
  service,
  reject(`delete from public.provider_earnings_rows where organization_id=${q(organization)}`, 'service_role_cannot_bypass_atomic_rpc', 'insufficient_privilege'),
  owner,
  "rollback;select 'PROVIDER_EARNINGS_ROLLBACK_OK';"
].join('\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result = spawnSync('docker', dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--file=/dev/stdin'])
  .map(value => value === '--username=postgres' ? '--username=supabase_admin' : value),
  {env, input: sql, encoding: 'utf8', timeout: 45000, maxBuffer: 1048576});
if (result.error || result.status !== 0) {
  const label = String(result.stderr || '').match(/earnings-test: ([a-zA-Z_0-9]+)/)?.[1];
  const state = String(result.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
  const known = [...migration.matchAll(/raise exception '([^']+)'/g)].map(match => match[1])
    .find(message => String(result.stderr || '').includes(': ' + message + '\n'));
  throw Error('Répétition Earnings locale interrompue, transaction annulée.' + (label ? ' Contrôle : ' + label : state ? ' SQLSTATE : ' + state : '') + (known ? ' Validation : ' + known : ''));
}
assert.equal(result.stdout.trim(), 'PROVIDER_EARNINGS_ROLLBACK_OK');
console.log(JSON.stringify({ok: true, checks, target: 'local-staging-only', migrationSimulated: simulate, semanticsSimulated:semantics, rolledBack: true}));
