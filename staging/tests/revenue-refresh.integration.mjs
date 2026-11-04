import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomInt, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD, dockerArgs} from '../scripts/import-reference.mjs';

// Explicit local-only rehearsal; all synthetic data and optional DDL roll back.
// --with-migration rehearses the migration twice to exercise idempotence.
assertLocalProject();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(value => value !== '--with-migration')) throw Error('Only --with-migration is supported.');
const simulate = args.includes('--with-migration');
const suffix = randomUUID(), agency = Date.now() * 1000 + randomInt(500);
const roles = ['admin', 'manager', 'viewer', 'pending'];
const users = Object.fromEntries(roles.map(role => [role, randomUUID()]));
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const owner = "reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth = role => `reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub: users[role], role: 'authenticated'}))};`;
let checks = 0;
const check = (condition, label) => {
  checks++;
  return `do $test$ begin if (${condition}) is distinct from true then raise exception 'refresh-test: ${label}';end if;end $test$;`;
};
const denied = (statement, label) => {
  checks++;
  return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when insufficient_privilege then refused:=true;end;if not refused then raise exception 'refresh-test: ${label}';end if;end $test$;`;
};
const version = id => `(select version from public.revenue_refresh where agency_id=${id})`;
const migration = readFileSync(new URL('../supabase/migrations/20261223000000_revenue_realtime.sql', import.meta.url), 'utf8');
const sql = [
  "begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",
  LOCAL_GUARD,
  "create temporary table refresh_before_publication as select pubname,schemaname,tablename from pg_publication_tables;",
  ...(simulate ? [migration, migration] : []),
  check("not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('uber_payments','bolt_sessions','cash_moves'))", 'financial_rows_not_published'),
  check("(select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='revenue_refresh')=1", 'marker_published_once'),
  check("not exists(select 1 from (select * from refresh_before_publication except select pubname,schemaname,tablename from pg_publication_tables) removed)", 'previous_publications_preserved'),
  check("not exists(select 1 from (select pubname,schemaname,tablename from pg_publication_tables except select * from refresh_before_publication) added where pubname<>'supabase_realtime' or schemaname<>'public' or tablename<>'revenue_refresh')", 'only_marker_publication_added'),
  check("(select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='revenue_refresh')=array['agency_id','version','touched_at']", 'minimal_payload'),
  check("(select relrowsecurity and relreplident='d' from pg_class where oid='public.revenue_refresh'::regclass)", 'rls_default_replica_identity'),
  check("not exists(select 1 from pg_constraint where conrelid='public.revenue_refresh'::regclass and contype='f')", 'no_cascading_foreign_key'),
  check("(select count(*) from pg_trigger where tgrelid in ('public.uber_payments'::regclass,'public.bolt_sessions'::regclass,'public.cash_moves'::regclass) and tgname in ('revenue_refresh_insert','revenue_refresh_update','revenue_refresh_delete') and not tgisinternal)=9", 'nine_statement_triggers_after_replay'),
  check("(select prosecdef and array_to_string(proconfig,',') in ('search_path=','search_path=\"\"') from pg_proc where oid='public.revenue_refresh_after_statement()'::regprocedure)", 'definer_with_empty_search_path'),
  "create temporary table refresh_zero_baseline as select coalesce((select version from public.revenue_refresh where agency_id=0),0) version;",
  `insert into public.agencies(id,name,city) overriding system value values (${agency},${q('Refresh A ' + suffix)},'Casablanca'),(${agency + 1},${q('Refresh B ' + suffix)},'Rabat');`,
  `insert into auth.users(id,email,aud,role) values ${roles.map(role => `(${q(users[role])},${q('refresh-' + role + '-' + suffix + '@example.invalid')},'authenticated','authenticated')`).join(',')};`,
  ...roles.map(role => `update public.profiles set role=${q(role)} where user_id=${q(users[role])};`),
  `insert into public.user_agencies(user_id,agency_id) values (${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
  `insert into public.uber_payments(tx,at,agency_id,revenue) values (${q(suffix + '-u1')},now(),${agency},10),(${q(suffix + '-u2')},now(),${agency},20),(${q(suffix + '-u3')},now(),${agency + 1},30);`,
  check(`${version(agency)}=1 and ${version(agency + 1)}=1`, 'one_bump_per_agency_per_import_statement'),
  `insert into public.bolt_sessions(key,at,agency_id,total) values (${q(suffix + '-b1')},now(),${agency},15),(${q(suffix + '-b2')},now(),${agency + 1},25);`,
  `insert into public.cash_moves(id,caisse,kind,flow,amount,course_amount,day,agency_id) values (${agency},'courses','course','in',40,40,current_date,${agency}),(${agency + 1},'courses','course','in',50,50,current_date,${agency + 1});`,
  check(`${version(agency)}=3 and ${version(agency + 1)}=3`, 'all_financial_tables_invalidate'),
  `update public.uber_payments set agency_id=${agency + 1} where tx=${q(suffix + '-u1')};`,
  check(`${version(agency)}=4 and ${version(agency + 1)}=4`, 'agency_change_invalidates_old_and_new'),
  `update public.uber_payments set revenue=21 where tx=${q(suffix + '-u2')};`,
  check(`${version(agency)}=5 and ${version(agency + 1)}=4`, 'same_agency_update_bumps_once'),
  `delete from public.bolt_sessions where key=${q(suffix + '-b1')};`,
  check(`${version(agency)}=6`, 'financial_delete_updates_marker_without_deleting_it'),
  `update public.uber_payments set agency_id=null where tx=${q(suffix + '-u2')};`,
  check(`${version(agency)}=7 and ${version(0)}=(select version+1 from refresh_zero_baseline)`, 'unassigned_scope_refreshes_admin_marker'),
  `delete from public.uber_payments where tx=${q(suffix + '-u2')};`,
  check(`${version(0)}=(select version+2 from refresh_zero_baseline)`, 'unassigned_delete_keeps_marker'),
  `update public.uber_payments set revenue=1 where tx=${q(suffix + '-absent')};`,
  check(`${version(agency)}=7 and ${version(agency + 1)}=4`, 'zero_row_statement_has_no_notification'),
  ...roles.flatMap(role => [auth(role),
    check(`(select count(*) from public.revenue_refresh where agency_id in (0,${agency},${agency + 1}))=${role === 'admin' ? 3 : role === 'manager' ? 1 : 0}`, role + '_marker_visibility'),
    denied(`insert into public.revenue_refresh(agency_id) values(${agency + 3})`, role + '_cannot_insert_marker'),
    denied(`update public.revenue_refresh set version=999 where agency_id=${agency}`, role + '_cannot_update_marker'),
    denied(`delete from public.revenue_refresh where agency_id=${agency}`, role + '_cannot_delete_marker'),
    denied('perform public.revenue_refresh_after_statement()', role + '_cannot_call_trigger_helper')
  ]),
  auth('manager'),
  `insert into public.cash_moves(id,caisse,kind,flow,amount,course_amount,day,agency_id) values (${agency + 2},'courses','course','in',60,60,current_date,${agency});`,
  check(`${version(agency)}=8`, 'authorized_financial_writer_can_trigger_without_helper_grant'),
  denied(`insert into public.cash_moves(id,caisse,kind,flow,amount,course_amount,day,agency_id) values (${agency + 3},'courses','course','in',70,70,current_date,${agency + 1})`, 'manager_cannot_invalidate_other_agency'),
  owner,
  check(`${version(agency + 1)}=4`, 'rejected_financial_write_did_not_bump_other_marker'),
  'set local role anon;',
  denied('perform 1 from public.revenue_refresh limit 1', 'anonymous_cannot_read_marker'),
  denied('perform public.revenue_refresh_after_statement()', 'anonymous_cannot_call_helper'),
  owner,
  check("not has_table_privilege('service_role','public.revenue_refresh','INSERT') and not has_table_privilege('service_role','public.revenue_refresh','UPDATE') and not has_table_privilege('service_role','public.revenue_refresh','DELETE')", 'service_role_cannot_write_markers_directly'),
  "rollback;select 'REVENUE_REFRESH_ROLLBACK_OK';"
].join('\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result = spawnSync('docker', dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--file=/dev/stdin'])
  .map(value => value === '--username=postgres' ? '--username=supabase_admin' : value),
  {env, input: sql, encoding: 'utf8', timeout: 40000, maxBuffer: 1048576});
if (result.error || result.status !== 0) {
  const label = String(result.stderr || '').match(/refresh-test: ([a-zA-Z_0-9]+)/)?.[1];
  const state = String(result.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
  throw Error('Contrôle des notifications locales interrompu ; transaction annulée.' + (label ? ' Contrôle : ' + label : state ? ' SQLSTATE : ' + state : ''));
}
assert.equal(result.stdout.trim(), 'REVENUE_REFRESH_ROLLBACK_OK');
console.log(JSON.stringify({ok: true, checks, target: 'local-staging-only', migrationSimulated: simulate, rolledBack: true}));
