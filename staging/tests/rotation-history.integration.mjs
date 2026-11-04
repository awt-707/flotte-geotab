// Only the pinned local database; every schema/data mutation is rolled back.
import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {randomUUID,randomInt} from 'node:crypto';import assert from 'node:assert/strict';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();if(process.argv.slice(2).some(a=>a!=='--with-migration'))throw Error('Unsupported option');
const withMigration=process.argv.includes('--with-migration'),suffix=randomUUID(),q=s=>"'"+String(s).replaceAll("'","''")+"'",json=value=>q(JSON.stringify(value))+'::jsonb';
const agency=Date.now()*1000+randomInt(900),car='ROT-CAR-'+suffix,old='OLD-'+suffix,ids=Object.fromEntries(['admin','manager','viewer','pending'].map(k=>[k,randomUUID()]));
const now=Date.now()-1000,at=new Date(now).toISOString(),from=new Date(now-7*86400000).toISOString(),start=new Date(now-3600000).toISOString(),end=new Date(now-60000).toISOString();
const row={external_id:old,num:old,client_code:'SYNTHETIC',plate:car,status:'DONE',effective_start_at:start,end_at:end,deleted:false};
const rpc=(rows=[row],stamp=at)=>`public.fleet_sync_rotation_contracts(${json(rows)},${q(stamp)},${q(from)},${q(at)})`;
let checks=0;const check=(condition,label)=>{checks++;return `do $check$ begin if (${condition}) is distinct from true then raise exception 'rotation-test:${label}';end if;end $check$;`;};
const reject=(expression,label,kind='raise_exception')=>{checks++;return `do $check$ declare refused boolean:=false;begin begin perform ${expression};exception when ${kind} then refused:=true;end;if not refused then raise exception 'rotation-test:${label}';end if;end $check$;`;};
const service="reset role;set local role service_role;set local request.jwt.claims='{}';set local request.jwt.claim.sub='';";
const auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(ids[role])};set local request.jwt.claims=${q(JSON.stringify({sub:ids[role],role:'authenticated'}))};`;
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(withMigration?[readFileSync(new URL('../supabase/migrations/20261201000000_rotation_history.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},${q('Synthetic rotation '+suffix)},'Casablanca'),(${agency+1},${q('Other rotation '+suffix)},'Marrakech');
 insert into public.vehicles(key,plate,agency_id) values(${q(car)},${q(car)},${agency});
 insert into auth.users(id,email,aud,role) values ${Object.entries(ids).map(([role,id])=>`(${q(id)},${q('rotation-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(ids).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(ids.manager)},${agency}),(${q(ids.viewer)},${agency+1});`,service,
 check(`(${rpc()}->>'contracts')::integer=1`,'commit'),check(`(select end_at=${q(end)} and effective_start_at=${q(start)} and vehicle_key=${q(car)} and agency_id=${agency} from public.fleet_rotation_contracts where external_id=${q(old)})`,'actual_times_and_unique_vehicle'),
 check(`(select status='healthy' and from_at=${q(from)} from public.fleet_rotation_sync where id=1)`,'history_health'),
 check(`(${rpc()}->>'contracts')::integer=1`,'idempotent_upsert'),check(`(select count(*) from public.fleet_rotation_contracts where external_id=${q(old)})=1`,'no_duplicate'),
 ...['admin','manager','viewer','pending'].flatMap(role=>[auth(role),check(`(select count(*) from public.fleet_rotation_contracts where external_id=${q(old)})=${['admin','manager'].includes(role)?1:0}`,role+'_scope'),check(`(select count(*) from public.fleet_rotation_sync)=${role==='pending'?0:1}`,role+'_sync_scope'),reject(rpc(),role+'_cannot_sync','insufficient_privilege')]),
 'reset role;set local role anon;',reject('(select count(*) from public.fleet_rotation_contracts)','anonymous_cannot_read','insufficient_privilege'),service,
 reject(rpc([{...row,status:'IN_PROGRESS'}]),'wrong_status'),reject(rpc([row,row]),'duplicate_ids'),reject(rpc([{...row,end_at:new Date(now+60000).toISOString()}]),'future_return'),reject(rpc([{...row,end_at:new Date(now-7200000).toISOString()}]),'return_before_departure'),
 check(`(select end_at=${q(end)} from public.fleet_rotation_contracts where external_id=${q(old)})`,'failed_import_keeps_return'),
 check(`(${rpc([{...row,external_id:old+'-missing',num:old+'-missing',plate:'MISSING-'+suffix,end_at:null}])}->>'contracts')::integer=1`,'missing_return_stays_stored'),
 check(`(select vehicle_key is null and end_at is null from public.fleet_rotation_contracts where external_id=${q(old+'-missing')})`,'unknown_not_invented'),
 `update public.params set value='not-staging' where key='environment';`,reject(rpc(),'staging_guard'),
 'reset role;rollback;',"select 'ROTATION_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const args=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(s=>s==='--username=postgres'?'--username=supabase_admin':s);
const result=spawnSync('docker',args,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.status!==0){const label=result.stderr?.match(/rotation-test:([a-z_]+)/)?.[1];throw Error('Local rotation SQL verification failed; rollback. '+(label||'No private database output disclosed.'));}
assert.equal(result.stdout.trim(),'ROTATION_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,rolled_back:true,migration_simulated:withMigration}));
