import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeParkingZone,advanceParking} from '../server/parking-domain.mjs';
assertLocalProject();const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),agency=Date.now()*1000+randomInt(500),z1=randomUUID(),z2=randomUUID(),keys=['PARKING_TEST_'+suffix,'PARKING_OTHER_'+suffix],users=Object.fromEntries(['admin','manager','viewer','pending'].map(r=>[r,randomUUID()])),now=Date.now();
const q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
const zone={id:z1,revision:1,...normalizeParkingZone({name:'Synthetic parking',kind:'parking',agency_id:agency+1,enabled:true,shape:{type:'circle',center:{lat:33.6,lon:-7.6},radius_m:100}})},vehicle={key:keys[0],geotab_id:'SYNTHETIC_DEVICE'},source={status:'healthy',last_success_at:new Date(now).toISOString(),stale_after_s:90};
let previous=null;const batches=[[-20,33.603],[-10,33.6],[-4,33.6]].map(([seconds,lat])=>{const result=advanceParking(previous,{vehicle,position:{device_id:vehicle.geotab_id,lat,lon:-7.6,at:new Date(now+seconds*1000).toISOString()},zones:[zone],source,now});const batch={states:[{vehicle_key:keys[0],zone_id:z1,zone_revision:1,previous_at:previous?.last_at||null,state:result.state}],events:result.event?[result.event]:[]};previous=result.state;return batch;});
const run=(batch=batches[0])=>`public.fleet_commit_parking(${json(batch.states)},${json(batch.events)})`;
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'parking-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'parking-test: ${label}';end if;end $test$;`;};
const perform=s=>`do $work$ begin perform ${s};end $work$;`,service="reset role;set local role service_role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';",auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const otherState={...batches[2].states[0],vehicle_key:keys[1],zone_id:z2,previous_at:null,state:{...batches[2].states[0].state,zone_id:z2,device_id:'OTHER_DEVICE'}};
const otherEvent={...batches[2].events[0],vehicle_key:keys[1],zone_id:z2,event_key:'e'.repeat(64)};
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261208000000_parking.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic parking agency A','Casablanca'),(${agency+1},'Synthetic parking agency B','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values ${Object.entries(users).map(([role,id])=>`(${q(id)},${q('parking-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(users).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
 `insert into public.vehicles(key,plate,geotab_id,agency_id) values(${q(keys[0])},'Synthetic A','SYNTHETIC_DEVICE',${agency}),(${q(keys[1])},'Synthetic B','OTHER_DEVICE',${agency+1});`,
 `insert into public.fleet_parking_zones(id,name,kind,agency_id,shape,enabled,fingerprint) values(${q(z1)},'Synthetic parking','parking',${agency+1},${json(zone.shape)},true,${q(zone.fingerprint)}),(${q(z2)},'Synthetic exclusion','exclusion',${agency},${json(zone.shape)},true,${q(zone.fingerprint)});`,service,
 perform(run()),check(`exists(select 1 from public.fleet_parking_state where vehicle_key=${q(keys[0])})`,'initial_presence_saved'),check(`not exists(select 1 from public.fleet_parking_events where vehicle_key=${q(keys[0])})`,'initialization_creates_no_entry'),
 perform(run(batches[1])),check(`(select state->'pending'->>'samples'='1' from public.fleet_parking_state where vehicle_key=${q(keys[0])})`,'first_crossing_only_pending'),
 reject(`perform ${run({states:batches[2].states,events:[{...batches[2].events[0],first_observed_at:batches[2].events[0].observed_at}]})}`,'two_seconds_or_less_not_confirmed'),
 check(`(select state->'pending'->>'samples'='1' from public.fleet_parking_state where vehicle_key=${q(keys[0])})`,'invalid_event_rolls_back_state'),
 perform(run(batches[2])),check(`(select count(*) from public.fleet_parking_events where vehicle_key=${q(keys[0])})=1`,'confirmed_transition_saved'),
 perform(run(batches[2])),check(`(select count(*) from public.fleet_parking_events where vehicle_key=${q(keys[0])})=1`,'retry_deduplicated'),
 reject(`perform ${run(batches[1])}`,'older_state_cannot_overwrite_newer_state'),
 reject(`perform ${run({states:[{...batches[2].states[0],previous_at:batches[2].states[0].state.last_at,state:{...batches[2].states[0].state,device_id:'WRONG_DEVICE'}}],events:[]})}`,'wrong_device_cannot_reuse_state'),
 reject(`perform ${run({states:[],events:batches[2].events})}`,'event_requires_corresponding_state'),
 perform(run({states:[otherState],events:[otherEvent]})),
 ...['admin','manager','viewer','pending'].flatMap(role=>[auth(role),
  check(`(select count(*) from public.fleet_parking_zones where id in(${q(z1)},${q(z2)}))=${role==='pending'?0:2}`,role+'_zones_are_geographical_staff_catalogue'),
  ...['fleet_parking_state','fleet_parking_events'].map(table=>check(`(select count(*) from public.${table} where vehicle_key in(${q(keys[0])},${q(keys[1])}))=${role==='admin'?2:role==='pending'?0:1}`,role+'_vehicle_scope_'+table)),
  reject(`perform ${run()}`,role+'_cannot_commit_rpc','insufficient_privilege'),
  reject(`update public.fleet_parking_zones set enabled=false where id=${q(z1)}`,role+'_cannot_write_zone_directly','insufficient_privilege')]),
 'reset role;set local role anon;',...['fleet_parking_zones','fleet_parking_state','fleet_parking_events'].map(table=>reject(`perform 1 from public.${table} limit 1`,'anon_cannot_read_'+table,'insufficient_privilege')),reject(`perform ${run()}`,'anon_cannot_commit','insufficient_privilege'),service,
 `update public.fleet_parking_zones set enabled=false where id=${q(z1)};`,check(`not exists(select 1 from public.fleet_parking_state where zone_id=${q(z1)})`,'disable_clears_pending_and_current_state'),check(`(select revision from public.fleet_parking_zones where id=${q(z1)})=2`,'disable_increments_revision'),
 check(`(select count(*) from public.fleet_parking_events where zone_id=${q(z1)})=1`,'historical_events_preserved'),
 reject(`perform ${run(batches[2])}`,'disabled_zone_refuses_delayed_commit'),
 `update public.fleet_parking_zones set enabled=true where id=${q(z1)};`,check(`(select revision from public.fleet_parking_zones where id=${q(z1)})=3`,'enable_new_interval'),reject(`perform ${run(batches[2])}`,'reenabled_zone_refuses_previous_revision'),
 `update public.params set value='not-staging' where key='environment';`,reject(`perform ${run()}`,'commit_requires_staging'),
 "reset role;rollback;select 'PARKING_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x),{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1048576});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/parking-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local parking validation failed; rollback retained.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'PARKING_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
