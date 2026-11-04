import assert from 'node:assert/strict';
import {randomInt, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD, dockerArgs} from '../scripts/import-reference.mjs';
import {getRevenuePeriod} from '../site/revenue-metrics.js';

// Synthetic rows exist only inside this transaction in the guarded local DB.
// No cloud URL, migration, provider call, or financial job can be requested.
assertLocalProject();
if (process.argv.length !== 2) throw Error('Ce contrôle local ne prend aucun argument.');
const suffix = randomUUID();
const agency = Date.now() * 1000 + randomInt(500);
const roles = ['admin', 'manager', 'viewer', 'pending'];
const users = Object.fromEntries(roles.map(role => [role, randomUUID()]));
const week = getRevenuePeriod({kind: 'week', at: '2026-11-03T12:00:00Z'});
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
let checks = 0;
const check = (condition, label) => {
  checks++;
  return `do $test$ begin if (${condition}) is distinct from true then raise exception 'revenue-test: ${label}';end if;end $test$;`;
};
const denied = (statement, label) => {
  checks++;
  return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when insufficient_privilege then refused:=true;end;if not refused then raise exception 'revenue-test: ${label}';end if;end $test$;`;
};
const auth = role => `reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub: users[role], role: 'authenticated'}))};`;
const finance = ['uber_payments', 'bolt_sessions', 'cash_moves'];
const scope = `agency_id in (${agency},${agency + 1})`;
const sql = [
  "begin;set local statement_timeout='15s';set local lock_timeout='2s';set local client_min_messages=warning;",
  LOCAL_GUARD,
  `insert into public.agencies(id,name,city) overriding system value values (${agency},'Synthetic Revenue A','Casablanca'),(${agency + 1},'Synthetic Revenue B','Marrakech');`,
  `insert into auth.users(id,email,aud,role) values ${roles.map(role => `(${q(users[role])},${q('revenue-' + role + '-' + suffix + '@example.invalid')},'authenticated','authenticated')`).join(',')};`,
  ...roles.map(role => `update public.profiles set role=${q(role)} where user_id=${q(users[role])};`),
  `insert into public.user_agencies(user_id,agency_id) values (${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
  ...[agency, agency + 1].flatMap((id, index) => [
    `insert into public.uber_payments(tx,at,agency_id,revenue,raw) values
      (${q(suffix + '-' + index + '-before')},'2026-11-02T03:59:59Z',${id},999,'{"currency":"MAD"}'::jsonb),
      (${q(suffix + '-' + index + '-start')},'2026-11-02T04:00:00Z',${id},100,'{"currency":"MAD"}'::jsonb),
      (${q(suffix + '-' + index + '-end')},'2026-11-09T04:00:00Z',${id},999,'{"currency":"MAD"}'::jsonb);`,
    `insert into public.bolt_sessions(key,at,agency_id,total) values (${q(suffix + '-' + index)},'2026-11-03T12:00:00Z',${id},50);`,
    `insert into public.cash_moves(id,caisse,kind,flow,amount,course_amount,day,agency_id) values (${agency + index},'courses','course','in',25,25,'2026-11-03',${id});`
  ]),
  ...roles.flatMap(role => {
    const agencies = role === 'admin' ? 2 : role === 'manager' ? 1 : 0;
    return [auth(role),
      ...finance.map(table => check(`(select count(*) from public.${table} where ${scope})=${agencies * (table === 'uber_payments' ? 3 : 1)}`, role + '_' + table)),
      check(`(select coalesce(sum(revenue),0) from public.uber_payments where ${scope} and at>=${q(week.start)}::timestamptz and at<${q(week.end)}::timestamptz)=${100 * agencies}`, role + '_monday_four_bounds'),
      ...(role === 'manager' ? finance.map(table => check(`not exists(select 1 from public.${table} where agency_id=${agency + 1})`, 'manager_other_agency_' + table)) : [])
    ];
  }),
  'reset role;set local role anon;',
  ...finance.map(table => denied(`perform 1 from public.${table} limit 1`, 'anonymous_' + table)),
  "reset role;rollback;select 'REVENUE_RLS_ROLLBACK_OK';"
].join('\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result = spawnSync('docker', dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--file=/dev/stdin'])
  .map(value => value === '--username=postgres' ? '--username=supabase_admin' : value),
  {env, input: sql, encoding: 'utf8', timeout: 30000, maxBuffer: 1048576});
if (result.error || result.status !== 0) {
  const label = String(result.stderr || '').match(/revenue-test: ([a-zA-Z_0-9]+)/)?.[1];
  const state = String(result.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
  throw Error('Contrôle financier local interrompu, transaction annulée.' + (label ? ' Contrôle : ' + label : state ? ' SQLSTATE : ' + state : ''));
}
assert.equal(result.stdout.trim(), 'REVENUE_RLS_ROLLBACK_OK');
console.log(JSON.stringify({ok: true, checks, target: 'local-staging-only', rolledBack: true}));
