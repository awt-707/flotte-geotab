import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeParkingZone,advanceParking} from '../server/parking-domain.mjs';
assertLocalProject();const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),agency=Date.now()*1000+randomInt(500),zoneId=randomUUID(),key='OPERATING_TEST_'+suffix,users=Object.fromEntries(['manager','pending'].map(r=>[r,randomUUID()])),now=Date.now();
const q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
const zone={id:zoneId,revision:1,...normalizeParkingZone({name:'Synthetic operating zone',kind:'operating',agency_id:agency,enabled:true,indicative:true,shape:{type:'polygon',points:[{lat:33.5,lon:-7.8},{lat:33.7,lon:-7.8},{lat:33.7,lon:-7.5},{lat:33.5,lon:-7.5}]}})},vehicle={key,geotab_id:'SYNTHETIC_DEVICE',agency_id:agency},source={status:'healthy',last_success_at:new Date(now).toISOString(),stale_after_s:90};
let previous=null;const batches=[-30,-24].map(seconds=>{const result=advanceParking(previous,{vehicle,position:{device_id:vehicle.geotab_id,lat:34,lon:-7.6,at:new Date(now+seconds*1000).toISOString()},zones:[zone],source,now});const batch={states:[{vehicle_key:key,zone_id:zoneId,zone_revision:1,previous_at:previous?.last_at||null,state:result.state}],events:result.event?[result.event]:[]};previous=result.state;return batch;});
const run=batch=>`public.fleet_commit_parking(${json(batch.states)},${json(batch.events)})`;
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'operating-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'operating-test: ${label}';end if;end $test$;`;};
const perform=s=>`do $work$ begin perform ${s};end $work$;`,service="reset role;set local role service_role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';",auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const changed=change=>({states:[{...batches[1].states[0],previous_at:batches[1].states[0].state.last_at,state:{...batches[1].states[0].state,...change}}],events:[]});
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261211000000_authorized_zones.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic operating agency','Casablanca');`,
 `insert into auth.users(id,email,aud,role) values ${Object.entries(users).map(([role,id])=>`(${q(id)},${q('operating-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(users).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(users.manager)},${agency});`,
 `insert into public.vehicles(key,plate,geotab_id,agency_id) values(${q(key)},'Synthetic operating car','SYNTHETIC_DEVICE',${agency});`,
 `insert into public.fleet_parking_zones(id,name,kind,agency_id,shape,enabled,fingerprint,indicative) values(${q(zoneId)},'Synthetic operating zone','operating',${agency},${json(zone.shape)},true,${q(zone.fingerprint)},true);`,service,
 check(`(select indicative and kind='operating' from public.fleet_parking_zones where id=${q(zoneId)})`,'indicative_operating_zone_saved'),
 reject(`update public.fleet_parking_zones set agency_id=null where id=${q(zoneId)}`,'operating_requires_agency','check_violation'),
 perform(run(batches[0])),check(`(select state->>'outside_confirmed_at' is null from public.fleet_parking_state where vehicle_key=${q(key)})`,'first_outside_fix_not_confirmed'),
 check(`not exists(select 1 from public.fleet_parking_events where vehicle_key=${q(key)})`,'initial_outside_does_not_invent_exit'),
 perform(run(batches[1])),check(`(select state->>'outside_confirmed_at' is not null and state->>'outside_samples'='2' from public.fleet_parking_state where vehicle_key=${q(key)})`,'second_fix_confirms_outside'),
 perform(run(batches[1])),check(`(select count(*) from public.fleet_parking_state where vehicle_key=${q(key)})=1`,'retry_deduplicated'),
 reject(`perform ${run(changed({outside_samples:1}))}`,'single_sample_cannot_confirm'),
 reject(`perform ${run(changed({outside_confirmed_at:new Date(now-26000).toISOString()}))}`,'under_five_seconds_cannot_confirm'),
 reject(`perform ${run(changed({outside_from_at:null}))}`,'outside_confirmation_needs_first_fix'),
 reject(`perform ${run(changed({zone_id:zoneId}))}`,'inside_state_cannot_be_outside'),
 reject(`perform ${run(changed({outside_confirmed_at:new Date(now-23000).toISOString()}))}`,'confirmation_cannot_follow_latest_fix'),
 check(`(select state->>'outside_samples'='2' and state->>'zone_id' is null from public.fleet_parking_state where vehicle_key=${q(key)})`,'failed_batches_leave_valid_state_intact'),
 ...['manager','pending'].flatMap(role=>[auth(role),check(`(select count(*) from public.fleet_parking_zones where id=${q(zoneId)})=${role==='manager'?1:0}`,role+'_zone_scope'),check(`(select count(*) from public.fleet_parking_state where vehicle_key=${q(key)})=${role==='manager'?1:0}`,role+'_vehicle_state_scope'),reject(`perform ${run(batches[1])}`,role+'_cannot_write_state','insufficient_privilege')]),
 'reset role;set local role anon;',reject(`perform 1 from public.fleet_parking_zones where id=${q(zoneId)}`,'anonymous_cannot_read_zone','insufficient_privilege'),reject(`perform ${run(batches[1])}`,'anonymous_cannot_commit','insufficient_privilege'),service,
 `update public.fleet_parking_zones set indicative=false where id=${q(zoneId)};`,check(`not exists(select 1 from public.fleet_parking_state where zone_id=${q(zoneId)})`,'editing_contour_precision_resets_previous_confirmation'),check(`(select revision=2 and not indicative from public.fleet_parking_zones where id=${q(zoneId)})`,'edited_configuration_gets_new_revision'),
 reject(`perform ${run(batches[1])}`,'old_configuration_cannot_reappear'),
 "reset role;rollback;select 'OPERATING_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x),{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1048576});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/operating-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local authorized-zone validation failed; rollback retained.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'OPERATING_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
