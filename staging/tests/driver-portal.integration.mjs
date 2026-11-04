// Only the pinned local staging database. Synthetic rows and migration roll back.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.some(arg=>arg!=='--with-migration')||args.length>1)throw Error('Only --with-migration is supported');
const id=randomUUID(),code='PORTAL_TEST_'+id,q=value=>"'"+String(value).replaceAll("'","''")+"'",tables=['driver_portal_accounts','driver_portal_sessions','driver_reports','driver_notifications'];
let checks=0;const check=(condition,label)=>{checks++;return `do $$ begin if (${condition}) is distinct from true then raise exception 'portal-test: ${label}';end if;end $$;`;};
const denied=(statement,label)=>{checks++;return `do $$ declare refused boolean:=false;begin begin ${statement};exception when insufficient_privilege then refused:=true;end;if not refused then raise exception 'portal-test: ${label}';end if;end $$;`;};
const sql=["begin;set local statement_timeout='15s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,
 ...(args.includes('--with-migration')?[readFileSync(new URL('../supabase/migrations/20261130000000_driver_portal.sql',import.meta.url),'utf8')]:[]),
 `insert into public.drivers(code,name) values(${q(code)},'Synthetic driver portal');set local role service_role;`,
 `insert into public.driver_portal_accounts(id,ludy_driver_code,display_name,credential_hash) values(${q(id)},${q(code)},'Synthetic driver portal',repeat('a',64));`,
 `insert into public.driver_portal_sessions(token_hash,account_id,expires_at) values(repeat('b',64),${q(id)},now()+interval '1 hour');`,
 `insert into public.driver_reports(account_id,category,city,place,description) values(${q(id)},'traffic','Casablanca','Synthetic street','Synthetic incident for access test');`,
 `insert into public.driver_notifications(account_id,event_key,kind,title,message,observed_at,evidence) values(${q(id)},'synthetic-event','overconsumption','Synthetic alert','Synthetic message',now(),'{"private":true}');`,
 ...tables.map(table=>check(`exists(select 1 from public.${table})`,'service_can_read_'+table)),
 ...['anon','authenticated'].flatMap(role=>[`reset role;set local role ${role};`,...tables.flatMap(table=>[
 denied(`perform 1 from public.${table} limit 1`,role+'_cannot_read_'+table),
 denied(`delete from public.${table} where false`,role+'_cannot_delete_'+table),
 check(`not has_table_privilege(current_user,'public.${table}','INSERT') and not has_table_privilege(current_user,'public.${table}','UPDATE')`,role+'_cannot_write_'+table)
 ])]),
 'reset role;set local role service_role;',
 check(`(select count(*)=1 from public.driver_notifications where account_id=${q(id)})`,'private_notice_intact'),
 `delete from public.driver_portal_accounts where id=${q(id)};`,
 ...['driver_portal_sessions','driver_reports','driver_notifications'].map(table=>check(`not exists(select 1 from public.${table} where account_id=${q(id)})`,'account_delete_cascades_'+table)),
 "reset role;rollback;select 'DRIVER_PORTAL_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(arg=>arg==='--username=postgres'?'--username=supabase_admin':arg),{env,input:sql,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/portal-test: ([a-zA-Z_0-9]+)/)?.[1];throw Error('Local driver portal validation failed; transaction rolled back.'+(label?' Check: '+label:''));}
assert.equal(result.stdout.trim(),'DRIVER_PORTAL_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:args.includes('--with-migration'),rolled_back:true}));
