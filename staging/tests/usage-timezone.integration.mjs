import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
if(process.argv.length!==2)throw Error('Unexpected arguments');
const migration=readFileSync(new URL('../supabase/migrations/20261221000000_usage_morocco_calendar.sql',import.meta.url),'utf8');
const kind='synthetic-timezone-'+randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'";
let checks=0;const check=(condition,label)=>{checks++;return `do $$ begin if (${condition}) is distinct from true then raise exception 'usage-timezone-test: ${label}';end if;end $$;`;};
const sql=["begin;set local statement_timeout='15s';set local lock_timeout='1s';set local client_min_messages=warning;",LOCAL_GUARD,
 `insert into public.usage_daily(day,kind,n) values('2026-09-19',${q(kind)},17);`,migration,
 check(`(select n=17 from public.usage_daily where day='2026-09-19' and kind=${q(kind)})`,'existing_counts_preserved'),
 check("('2026-11-03T23:30:00Z'::timestamptz at time zone 'Africa/Casablanca')::date='2026-11-03'::date",'permanent_gmt_calendar'),
 check("('2026-06-03T23:30:00Z'::timestamptz at time zone 'Africa/Casablanca')::date='2026-06-04'::date",'historical_summer_calendar'),
 check("('2026-02-20T23:30:00Z'::timestamptz at time zone 'Africa/Casablanca')::date='2026-02-20'::date",'historical_ramadan_calendar'),
 check("('2026-09-20T00:59:59Z'::timestamptz at time zone 'Africa/Casablanca')::time='01:59:59'::time and ('2026-09-20T01:00:00Z'::timestamptz at time zone 'Africa/Casablanca')::time='01:00:00'::time",'official_september_fold'),
 ...['public','anon','authenticated'].map(role=>check(`not has_function_privilege(${q(role)},'public.bump_usage(text)','EXECUTE')`,'counter_no_'+role)),
 check("has_function_privilege('service_role','public.bump_usage(text)','EXECUTE')",'counter_service_only'),
 ...['public','anon'].map(role=>check(`not has_function_privilege(${q(role)},'public.usage_stats()','EXECUTE')`,'stats_no_'+role)),
 ...['authenticated','service_role'].map(role=>check(`has_function_privilege(${q(role)},'public.usage_stats()','EXECUTE')`,'stats_'+role)),
 "set local timezone='Pacific/Honolulu';set local role service_role;set local request.jwt.claims='{\"role\":\"service_role\"}';",
 `select public.bump_usage(${q(kind)});select public.bump_usage(${q(kind)});`,
 check(`(select n=2 from public.usage_daily where day=(now() at time zone 'Africa/Casablanca')::date and kind=${q(kind)})`,'counter_ignores_session_timezone'),
 check("public.usage_stats()->>'month'=date_trunc('month',now() at time zone 'Africa/Casablanca')::date::text",'month_ignores_session_timezone'),
 "reset role;set local role authenticated;set local request.jwt.claim.sub='';set local request.jwt.claims='{\"role\":\"authenticated\"}';",
 "do $$ declare refused boolean:=false;begin begin perform public.usage_stats();exception when others then refused:=true;end;if not refused then raise exception 'usage-timezone-test: stats_non_admin_refused';end if;end $$;",
 "reset role;rollback;select 'USAGE_TIMEZONE_ROLLBACK_OK';"
].join('\n');checks++;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x),{env,input:sql,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/usage-timezone-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Usage timezone validation failed; transaction rolled back. '+(label||state||'Local database unavailable'));}
assert.equal(result.stdout.trim(),'USAGE_TIMEZONE_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:true,rolled_back:true}));
