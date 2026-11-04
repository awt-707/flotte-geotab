import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),d1=randomUUID(),d2=randomUUID(),e1=randomUUID(),e2=randomUUID(),agency=Date.now()*1000+randomInt(500),users=Object.fromEntries(['admin','manager','viewer','pending'].map(role=>[role,randomUUID()]));
const now=Date.now(),at=new Date(now).toISOString(),from=new Date(now-86400000).toISOString(),org=String(900000000+randomInt(10000000));
const q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
const row=(driver_id=d1,provider_driver_id=e1,external_id='TEST-'+suffix)=>({external_id,driver_id,provider_driver_id,status:'finished',requested_at:new Date(now-7200000).toISOString(),accepted_at:new Date(now-7100000).toISOString(),started_at:new Date(now-6900000).toISOString(),finished_at:new Date(now-6000000).toISOString(),distance_km:8,passenger_distance_km:6,duration_s:900,pickup_duration_s:180,amount:60,currency:'MAD',tip_amount:5,booking_fee:2,toll_fee:0,cancellation_fee:null,is_optional:false,stops:[{type:'pickup',lat:33.58,lng:-7.62,arrived_at:null,departed_at:null}]});
const coverage=[{driver_id:d1,provider_driver_id:e1,from_at:from,to_at:at},{driver_id:d2,provider_driver_id:e2,from_at:from,to_at:at}];
const importSql=(rows=[row(),row(d2,e2,'SECOND-'+suffix)],cover=coverage,when=at)=>`public.fleet_import_bolt_performance(${q(org)},${json(rows)},${json(cover)},${q(when)}::timestamptz)`;
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'performance-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'performance-test: ${label}';end if;end $test$;`;};
const perform=s=>`do $work$ begin perform ${s};end $work$;`,service="reset role;set local role service_role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261206000000_driver_performance.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic Performance A','Casablanca'),(${agency+1},'Synthetic Performance B','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values ${Object.entries(users).map(([role,id])=>`(${q(id)},${q('performance-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(users).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
 `insert into public.fleet_drivers(id,name,agency_id) values(${q(d1)},'Synthetic A',${agency}),(${q(d2)},'Synthetic B',${agency+1});`,
 `insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id) values(${q(d1)},'bolt',${q('performance-'+e1)},${q(e1)},${q(org)}),(${q(d2)},'bolt',${q('performance-'+e2)},${q(e2)},${q(org)});`,service,
 reject(`perform ${importSql([row(),{...row(d2,e2,'BAD-'+suffix),status:'invalid'}])}`,'invalid_second_row_rolls_back_batch'),
 check(`not exists(select 1 from public.fleet_rides where organization_id=${q(org)})`,'no_partial_rides'),
 check(`not exists(select 1 from public.fleet_driver_performance_sync where organization_id=${q(org)})`,'no_partial_coverage'),
 reject(`perform ${importSql([row(),row()])}`,'duplicate_keys_refused'),
 reject(`perform ${importSql([row()],coverage.map(c=>({...c,provider_driver_id:randomUUID()})))}`,'wrong_identity_refused'),
 reject(`perform ${importSql([{...row(),stops:[{type:'pickup',lat:33,lng:-7,address:'SHOULD_NOT_SAVE'}]}])}`,'extra_stop_pii_refused'),
 check(`(${importSql()}->>'imported')::integer=2`,'two_driver_import_committed'),
 check(`(select count(*) from public.fleet_rides where organization_id=${q(org)})=2`,'rides_saved_once'),
 check(`(select count(*) from public.fleet_driver_performance_sync where organization_id=${q(org)})=2`,'coverage_per_driver'),
 check(`(select requested_at is not null and accepted_at is not null and passenger_distance_km=6 and detail_origin='bolt_api' from public.fleet_rides where organization_id=${q(org)} and driver_id=${q(d1)})`,'documented_fields_saved'),
 perform(importSql()),check(`(select count(*) from public.fleet_rides where organization_id=${q(org)})=2`,'repeat_deduplicated'),
 ...['admin','manager','viewer','pending'].flatMap(role=>[auth(role),
  ...['fleet_rides','fleet_driver_performance_sync'].map(table=>check(`(select count(*) from public.${table} where organization_id=${q(org)})=${role==='admin'?2:role==='pending'?0:1}`,role+'_agency_scope_'+table)),
  reject(`perform ${importSql()}`,role+'_cannot_import_rpc','insufficient_privilege'),
  reject(`update public.fleet_driver_performance_sync set status='error' where organization_id=${q(org)}`,role+'_cannot_write_sync','insufficient_privilege')]),
 'reset role;set local role anon;',reject('perform 1 from public.fleet_driver_performance_sync limit 1','anon_cannot_read_sync','insufficient_privilege'),reject(`perform ${importSql()}`,'anon_cannot_import_rpc','insufficient_privilege'),service,
 perform(importSql([],coverage)),check(`(select row_count=0 and status='healthy' from public.fleet_driver_performance_sync where organization_id=${q(org)} and driver_id=${q(d1)})`,'empty_provider_period_is_recorded'),
 check(`(select count(*) from public.fleet_rides where organization_id=${q(org)})=2`,'empty_read_does_not_delete_history'),
 `update public.params set value='not-staging' where key='environment';`,reject(`perform ${importSql()}`,'import_requires_staging'),
 "reset role;rollback;select 'DRIVER_PERFORMANCE_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x),{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1048576});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/performance-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local performance validation failed; rollback retained.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'DRIVER_PERFORMANCE_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
