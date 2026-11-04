import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {advanceParking,normalizeParkingZone,parkingSignedDistance,parkingDistance,operatingAvailability} from '../server/parking-domain.mjs';
import {createParkingApi} from '../server/parking.mjs';
const start=Date.parse('2026-11-02T12:00:00Z'),stamp=t=>new Date(start+t*1000).toISOString(),center={lat:33.6,lon:-7.6},outside={lat:33.603,lon:-7.6};
const zone=(kind='parking')=>({id:randomUUID(),revision:1,...normalizeParkingZone({name:'Synthetic '+kind,kind,agency_id:kind==='operating'?2:1,enabled:true,shape:{type:'circle',center,radius_m:100}})});
const vehicle={key:'SYNTHETIC',plate:'TEST',geotab_id:'device-synthetic',agency_id:2};
const health=t=>({status:'healthy',last_success_at:stamp(t),stale_after_s:90});
const position=(t,point=center)=>({key:vehicle.key,device_id:vehicle.geotab_id,at:stamp(t),...point,speed:0});
const step=(previous,t,point,z,extra={})=>advanceParking(previous,{vehicle,position:position(t,point),zones:[z],source:health(t),now:start+t*1000,...extra});

test('parking geometry validates circles and polygons and uses inside/outside distance margins',()=>{
 const z=zone();assert.equal(parkingSignedDistance(center,z.shape),100);assert.ok(parkingSignedDistance(outside,z.shape)<-200);assert.ok(Math.abs(parkingDistance(center,outside)-333.6)<2);
 const polygon=normalizeParkingZone({name:'Synthetic polygon',enabled:true,shape:{type:'polygon',points:[{lat:33.599,lon:-7.601},{lat:33.601,lon:-7.601},{lat:33.601,lon:-7.599},{lat:33.599,lon:-7.599},{lat:33.599,lon:-7.601}]}});assert.equal(polygon.shape.points.length,4);assert.ok(parkingSignedDistance(center,polygon.shape)>80);assert.ok(parkingSignedDistance(outside,polygon.shape)<-200);
 for(const input of [{...z,shape:{type:'circle',center,radius_m:10}},{...z,shape:{type:'polygon',points:[center,center,center]}},{...z,shape:{type:'circle',center:{lat:NaN,lon:0},radius_m:100}},{...z,enabled:'yes'}])assert.throws(()=>normalizeParkingZone(input));
});
test('initial presence is not an entry; transitions need two distinct GPS timestamps at least five seconds apart',()=>{
 const z=zone(),initial=step(null,0,center,z);assert.equal(initial.event,null);assert.equal(initial.state.zone_id,z.id);
 let state=step(null,0,outside,z).state;let result=step(state,10,center,z);assert.equal(result.event,null);assert.equal(result.state.pending.samples,1);state=result.state;
 result=step(state,10,center,z,{now:start+13000,source:health(13)});assert.equal(result.state.pending.samples,1);assert.equal(result.event,null);
 result=step(result.state,14,center,z);assert.equal(result.event,null);result=step(result.state,16,center,z);assert.equal(result.event.kind,'entered');assert.equal(result.event.first_observed_at,stamp(10));assert.equal(result.state.zone_id,z.id);
 result=step(result.state,20,outside,z);assert.equal(result.event,null);result=step(result.state,26,outside,z);assert.equal(result.event.kind,'exited');assert.equal(result.state.zone_id,null);
});
test('boundary jitter cancels a pending transition and unclear multi-zone input stays unknown',()=>{
 const z=zone(),border={lat:center.lat+110/111195,lon:center.lon};let state=step(null,0,outside,z).state;state=step(state,10,center,z).state;const ambiguous=step(state,13,border,z);assert.equal(ambiguous.event,null);assert.equal(ambiguous.state.pending,null);state=step(ambiguous.state,20,center,z).state;assert.equal(step(state,24,center,z).event,null);
 assert.equal(advanceParking(null,{vehicle,position:position(0),zones:[z,zone()],source:health(0),now:start}).state,null);
});
test('stale, paused, invalid coordinates, bad accuracy and changed devices cannot create a crossing',()=>{
 const z=zone(),previous=step(null,0,outside,z).state;
 for(const extra of [{source:{...health(10),status:'paused'}},{position:{...position(10),lat:null}},{position:{...position(10),accuracy_m:-1}},{position:{...position(10),accuracy_m:41}},{position:{...position(10),accuracy_m:'10'}},{position:{...position(10),device_id:'other-device'}},{position:position(0),now:start+121000},{source:{...health(10),last_success_at:stamp(-200)}},{position:position(30),now:start+10000}])assert.equal(step(previous,10,center,z,extra).state,null);
 const rebound=step(previous,10,center,z,{vehicle:{...vehicle,geotab_id:'new'},position:{...position(10),device_id:'new'}});assert.equal(rebound.event,null);assert.equal(rebound.state.device_id,'new');
});
test('out-of-order positions are ignored and restart/config changes cannot invent an entry',()=>{
 const z=zone();let state=step(null,10,outside,z).state;const stale=step(state,9,center,z,{now:start+12000,source:health(12)});assert.deepEqual(stale.state,state);assert.equal(stale.event,null);
 state=step(state,20,center,z).state;const restart=step(JSON.parse(JSON.stringify(state)),26,center,z);assert.equal(restart.event.kind,'entered');
 const lateRestart=step(state,120,center,z);assert.equal(lateRestart.event,null);assert.equal(lateRestart.state.pending,null);
 const revised=step(state,26,center,{...z,revision:3});assert.equal(revised.event,null);assert.equal(revised.state.zone_revision,3);
});

function fixture({unstableVehicleOrder=false}={}){
 let time=start,failCommit=false,hold=null,minimalCreated=false;const user=randomUUID(),parking=zone(),exclusion=zone('exclusion'),calls=[],providerCalls=[];
 const tables={profiles:[],vehicles:[{...vehicle},{key:'OTHER',plate:'OTHER',geotab_id:'device-other',agency_id:3}],live_status:[],fleet_parking_zones:[parking,exclusion],fleet_parking_state:[],fleet_parking_events:[],agencies:[{id:1,name:'Parking agency'},{id:2,name:'Vehicle agency'}],fleet_sources:[{id:'geotab',...health(0)}],fleet_source_events:[],fleet_drivers:[],fleet_latest:[],fleet_identities:[],fleet_myclicar_vehicles:[],fleet_inventory_sync:[],fleet_myclicar_contracts:[],fleet_rotation_contracts:[],fleet_rotation_sync:[]};
 const fetchFn=async(url,options={})=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421');const token=options.headers.Authorization.slice(7);if(u.pathname==='/auth/v1/user')return ['admin','manager','viewer','pending'].includes(token)?Response.json({id:user}):Response.json({},{status:401});
  const table=u.pathname.split('/').at(-1),params=Object.fromEntries(u.searchParams),body=options.body?JSON.parse(options.body):null,method=options.method||'GET';calls.push({table,params,body,token,method});
  if(hold?.table===table&&(!hold.method||hold.method===method)){const gate=hold;hold=null;gate.entered();await gate.wait;}
  if(table==='profiles')return Response.json([{role:token}]);
  if(table==='fleet_archive_parking_zone'){assert.equal(token,'service');assert.equal(body.p_user,user);const row=tables.fleet_parking_zones.find(z=>z.id===body.p_id);if(!row)return Response.json({outcome:'missing'});if(row.archived_at!=null||row.revision!==body.p_revision)return Response.json({outcome:'conflict'});Object.assign(row,{enabled:false,archived_at:new Date(time).toISOString(),archived_by:user,revision:row.revision+1});tables.fleet_parking_state=tables.fleet_parking_state.filter(s=>s.zone_id!==row.id);return Response.json({outcome:'archived',id:row.id,revision:row.revision,archived_at:row.archived_at});}
  if(table==='fleet_commit_parking'){assert.equal(token,'service');if(failCommit)return Response.json({},{status:500});for(const row of body.p_states){const i=tables.fleet_parking_state.findIndex(s=>s.vehicle_key===row.vehicle_key&&s.zone_id===row.zone_id);if(i>=0)tables.fleet_parking_state.splice(i,1);if(row.state)tables.fleet_parking_state.push({vehicle_key:row.vehicle_key,zone_id:row.zone_id,state:row.state});}for(const e of body.p_events)if(!tables.fleet_parking_events.some(old=>old.event_key===e.event_key))tables.fleet_parking_events.push(e);return new Response(null,{status:204});}
  assert.ok(Object.hasOwn(tables,table),table);const matches=row=>Object.entries(params).every(([k,v])=>v==='is.null'?row[k]==null:v==='not.is.null'?row[k]!=null:v.startsWith('in.(')?JSON.parse('['+v.slice(4,-1)+']').includes(row[k]):v.startsWith('eq.')?String(row[k])===v.slice(3):v.startsWith('neq.')?String(row[k])!==v.slice(4):true);let rows=tables[table].filter(matches);
  if(method==='PATCH'){assert.equal(token,'service');rows.forEach(r=>{Object.assign(r,body,{revision:r.revision+1});tables.fleet_parking_state=tables.fleet_parking_state.filter(s=>s.zone_id!==r.id);});return Response.json(options.headers.Prefer?.includes('return=representation')?rows:[]);}
  if(method==='POST'){assert.equal(token,'service');if(params.on_conflict==='id'&&tables[table].some(row=>row.id===body.id))return Response.json([]);if(params.on_conflict==='source,source_id'){const prior=tables[table].find(row=>row.source===body.source&&row.source_id===body.source_id);if(prior){Object.assign(prior,body,{revision:prior.revision+1});tables.fleet_parking_state=tables.fleet_parking_state.filter(s=>s.zone_id!==prior.id);return Response.json([prior]);}}const created={id:randomUUID(),revision:1,...body};tables[table].push(created);return minimalCreated?new Response(null,{status:201}):Response.json([created]);}
  if(['viewer','manager'].includes(token)&&['vehicles','live_status','fleet_parking_state','fleet_parking_events'].includes(table))rows=rows.filter(r=>(table==='vehicles'?r.key:r.vehicle_key)===vehicle.key);
  if(unstableVehicleOrder&&table==='vehicles'){
   rows.sort((a,b)=>a.key.localeCompare(b.key));
   if(!String(params.order||'').split(',').includes('key')&&Number(params.offset)>0)rows.reverse();
  }
  return Response.json(rows.slice(Number(params.offset||0),Number(params.offset||0)+Number(params.limit||1000)));
 };
 const api=createParkingApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>time,getGeotabZones:async()=>{providerCalls.push(true);return {zones:[{id:'global-exclusion',name:'OTHER FLEET forbidden',points:[{lat:33.599,lon:-7.601},{lat:33.601,lon:-7.601},{lat:33.6,lon:-7.599}]}],types:[]};}});
 async function call(path,{token='admin',body,origin='http://127.0.0.1:4173'}={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/parking/'+path,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4173',origin,...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});let status,data;await api(req,{writeHead:s=>status=s,end:v=>data=JSON.parse(v)});return {status,data};}
 async function observe(t,point=center){time=start+t*1000;tables.fleet_sources[0]={id:'geotab',...health(t)};tables.live_status=[{vehicle_key:vehicle.key,...point,speed:0,last_pos_at:stamp(t),updated_at:stamp(t)}];await api.onPositions([position(t,point)],health(t));await api.flush();}
 return {api,tables,calls,providerCalls,parking,exclusion,call,observe,newInstance:()=>createParkingApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>time}),setTime:t=>time=start+t*1000,failCommit:value=>failCommit=value,minimalCreated:()=>minimalCreated=true,holdNext:(table,method)=>{let entered,release;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);hold={table,method,entered,wait};return {ready,release};}};
}
test('the complete park does not duplicate or omit vehicles across database pages',async()=>{
 const f=fixture({unstableVehicleOrder:true});
 f.tables.vehicles=Array.from({length:1002},(_,i)=>({key:'fleet-'+String(i).padStart(4,'0'),plate:'SYNTHETIC-'+i,agency_id:1}));
 const result=await f.call('overview');assert.equal(result.status,200);
 assert.equal(result.data.counts.total,1002);assert.equal(new Set(result.data.vehicles.map(v=>v.key)).size,1002);
 assert.equal(result.data.vehicles.at(-1).key,'fleet-1001');
});
test('overlapping parking and exclusion remain independent and unique vehicle counts respect caller RLS',async()=>{
 const f=fixture();await f.observe(0,outside);await f.observe(10);await f.observe(16);assert.equal(f.tables.fleet_parking_events.length,2);const r=await f.call('overview',{token:'viewer'});assert.equal(r.status,200);assert.equal(r.data.counts.total,1);assert.equal(r.data.counts.parked,1);assert.equal(r.data.counts.exclusion,1);assert.equal(r.data.zones.length,2);assert.equal(r.data.vehicles[0].agency_id,2);assert.equal(f.parking.agency_id,1);
 assert.ok(f.calls.filter(c=>['vehicles','live_status','fleet_parking_state','fleet_parking_events'].includes(c.table)&&c.token==='viewer').length>=4);
 const reads=f.calls.filter(c=>c.table==='vehicles'&&c.token==='service');assert.equal(reads.length,1,'configuration cache is shared for thirty seconds');
});
test('source pause, missing coordinates, changed device and future/stale timestamps never count as current presence',async()=>{
 const f=fixture();await f.observe(0);for(const modify of [()=>f.tables.live_status[0].lat=null,()=>f.tables.live_status[0].updated_at=stamp(1000),()=>f.tables.vehicles[0].geotab_id=null,()=>f.tables.fleet_sources[0].status='paused']){await f.observe(10);modify();const r=await f.call('overview');assert.equal(r.data.counts.fresh,0);assert.equal(r.data.counts.parked,0);assert.equal(r.data.counts.exclusion,0);f.tables.vehicles[0].geotab_id=vehicle.geotab_id;}
 await f.observe(20);f.tables.vehicles[0].geotab_id='changed-device';const changed=await f.call('overview');assert.equal(changed.data.vehicles[0].zones.length,0);
});
test('configuration pause clears continuity and re-enabling starts as presence without an artificial entry',async()=>{
 const f=fixture();await f.observe(0,outside);await f.observe(10);assert.equal(f.tables.fleet_parking_events.length,0);
 for(const enabled of [false,true])assert.equal((await f.call('zones',{body:{...f.parking,enabled}})).status,200);
 await f.observe(16);assert.equal(f.tables.fleet_parking_events.filter(e=>e.zone_id===f.parking.id).length,0);const state=f.tables.fleet_parking_state.find(s=>s.zone_id===f.parking.id).state;assert.equal(state.zone_revision,3);assert.equal(state.pending,null);
});
test('source invalidation discards pending crossings and unchanged GPS timestamps cannot confirm an entry',async()=>{
 const f=fixture();await f.observe(0,outside);await f.observe(10);f.api.invalidateSource('paused');await f.observe(16);assert.equal(f.tables.fleet_parking_events.length,0);
 await f.observe(20,outside);await f.observe(26,outside);assert.equal(f.tables.fleet_parking_events.length,2);await f.observe(30);await f.observe(30);assert.equal(f.tables.fleet_parking_events.length,2);await f.observe(36);assert.equal(f.tables.fleet_parking_events.length,4);
});
test('global exclusion alerts distinguish initial presence from confirmed entry and disappear when stale, paused or outside',async()=>{
 const f=fixture();await f.observe(0);let alert=(await f.call('alerts',{token:'viewer'})).data.alerts;assert.equal(alert.length,1);assert.equal(alert[0].kind,'presence');assert.equal(alert[0].entered_at,null);const initialId=alert[0].id;
 await f.observe(6);alert=(await f.call('alerts',{token:'viewer'})).data.alerts;assert.equal(alert[0].id,initialId);assert.equal(alert[0].vehicle_key,vehicle.key);
 f.tables.fleet_sources[0].status='paused';assert.deepEqual((await f.call('alerts')).data.alerts,[]);
 await f.observe(10,outside);await f.observe(20);await f.observe(26);alert=(await f.call('alerts',{token:'viewer'})).data.alerts;assert.equal(alert.length,1);assert.equal(alert[0].kind,'entered');assert.equal(alert[0].entered_at,stamp(26));assert.ok(f.tables.fleet_parking_events.some(e=>e.event_key===alert[0].id));
 f.setTime(200);assert.deepEqual((await f.call('alerts')).data.alerts,[]);await f.observe(210,outside);assert.deepEqual((await f.call('alerts')).data.alerts,[]);
 assert.equal((await f.call('alerts',{token:'dps_'+'a'.repeat(43)})).status,401);
});
test('restart loads interruption history and discards pending transitions recorded before a source pause',async()=>{
 const f=fixture();await f.observe(0,outside);await f.observe(10);f.api.close();f.tables.fleet_source_events.push({source:'geotab',status:'paused',at:stamp(15)});f.setTime(26);const restarted=f.newInstance();await restarted.onPositions([position(26)],health(26));await restarted.flush();assert.equal(f.tables.fleet_parking_events.length,0);assert.equal(f.tables.fleet_parking_state[0].state.pending,null);assert.equal(f.tables.fleet_parking_state[0].state.since_at,stamp(26));restarted.close();
});
test('GPS ingestion coalesces without blocking and persistence failure does not advance cached state',async()=>{
 const f=fixture(),gate=f.holdNext('fleet_parking_zones');await f.api.onPositions([position(0,outside)],health(0));await gate.ready;
 await f.api.onPositions([position(5)],health(5));await f.api.onPositions([position(10)],health(10));f.setTime(10);gate.release();await f.api.flush();assert.equal(f.tables.fleet_parking_events.length,0);assert.equal(f.tables.fleet_parking_state[0].state.pending.from_at,stamp(10));
 f.failCommit(true);await f.observe(16);assert.equal(f.tables.fleet_parking_events.length,0);assert.equal((await f.call('overview')).data.detector.error!==null,true);f.failCommit(false);await f.observe(20);assert.equal(f.tables.fleet_parking_events.length,2);await f.observe(20);assert.equal(f.tables.fleet_parking_events.length,2);
});
test('parking administration requires staff/admin identity and catalog reads never activate any provider exclusion',async()=>{
 const f=fixture();for(const [token,status] of [[null,401],['dps_'+'a'.repeat(43),401],['pending',403]])assert.equal((await f.call('overview',{token})).status,status);
 assert.equal((await f.call('geotab',{token:'viewer'})).status,403);assert.equal((await f.call('zones',{token:'viewer',body:f.parking})).status,403);assert.equal((await f.call('zones',{token:'manager',body:f.parking})).status,403);assert.equal(f.providerCalls.length,0);
 const before=f.tables.fleet_parking_zones.length;const catalog=await f.call('geotab');assert.equal(catalog.status,200);assert.equal(catalog.data.zones[0].suggested_kind,'exclusion');assert.equal(f.tables.fleet_parking_zones.length,before);await f.call('geotab');assert.equal(f.providerCalls.length,1);
 assert.equal((await f.call('zones',{body:{source_id:'global-exclusion',kind:'exclusion',name:'Explicit choice',agency_id:1}})).status,400,'activation must be explicit');
 assert.equal((await f.call('overview',{origin:'https://foreign.invalid'})).status,403);
});

test('zone navigation reads only the non-archived catalogue and agencies under each staff JWT',async()=>{
 for(const token of ['admin','manager','viewer']){
  const f=fixture();f.parking.archived_at=stamp(0);const response=await f.call('zones',{token});assert.equal(response.status,200);assert.deepEqual(Object.keys(response.data).sort(),['agencies','zones']);assert.deepEqual(response.data.zones.map(z=>z.id),[f.exclusion.id]);
  assert.deepEqual(f.calls.map(c=>c.table).sort(),['agencies','fleet_parking_zones','profiles']);assert.ok(f.calls.every(c=>c.token===token&&c.method==='GET'));assert.equal(f.calls.find(c=>c.table==='fleet_parking_zones').params.archived_at,'is.null');assert.equal(f.providerCalls.length,0);f.api.close();
 }
});
test('zone navigation rejects unauthenticated, driver, pending and foreign-origin requests',async()=>{
 const f=fixture();for(const [token,status]of [[null,401],['dps_'+'a'.repeat(43),401],['pending',403]])assert.equal((await f.call('zones',{token})).status,status);assert.equal((await f.call('zones',{origin:'https://foreign.invalid'})).status,403);assert.ok(!f.calls.some(c=>c.table==='fleet_parking_zones'));f.api.close();
});

test('successful empty 201 responses create manual and selected provider zones without reporting a failure',async()=>{
 const f=fixture();f.minimalCreated();
 assert.equal((await f.call('zones',{body:{name:'Synthetic manual',kind:'parking',agency_id:1,enabled:true,shape:f.parking.shape}})).status,200);
 assert.equal((await f.call('zones',{body:{name:'Synthetic provider',source_id:'global-exclusion',kind:'exclusion',agency_id:1,enabled:true}})).status,200);
 assert.equal(f.tables.fleet_parking_zones.length,4);
});
test('city perimeters require an agency and accept large indicative polygons without inheriting parking limits',()=>{
 const input={name:'Synthetic operating city',kind:'operating',enabled:true,agency_id:2,indicative:true,shape:{type:'polygon',points:[{lat:33.5,lon:-7.8},{lat:33.7,lon:-7.8},{lat:33.7,lon:-7.5},{lat:33.5,lon:-7.5}]}};
 assert.equal(normalizeParkingZone(input).indicative,true);assert.throws(()=>normalizeParkingZone({...input,agency_id:null}));assert.throws(()=>normalizeParkingZone({...input,indicative:'true'}));
 assert.throws(()=>normalizeParkingZone({...input,kind:'parking'}));
});
test('initial outside state needs two distinct GPS fixes five seconds apart and hysteresis suppresses boundary jitter',()=>{
 const z=zone('operating');let state=step(null,0,outside,z).state;assert.equal(state.outside_confirmed_at,null);
 let result=step(state,0,outside,z,{now:start+6000,source:health(6)});assert.equal(result.state.outside_confirmed_at,null);
 result=step(state,4,outside,z);assert.equal(result.state.outside_confirmed_at,null);result=step(result.state,6,outside,z);assert.equal(result.state.outside_confirmed_at,stamp(6));assert.equal(result.event,null);
 const border={lat:center.lat+110/111195,lon:center.lon};result=step(result.state,10,border,z);assert.equal(result.state.outside_confirmed_at,stamp(6),'confirmed outside classification stays stable in the boundary band');
 result=step(result.state,15,center,z);assert.equal(result.state.zone_id,null);result=step(result.state,21,center,z);assert.equal(result.state.zone_id,z.id);assert.equal(result.state.outside_confirmed_at,null);
 let unconfirmed=step(null,0,outside,z).state;unconfirmed=step(unconfirmed,6,border,z).state;unconfirmed=step(unconfirmed,10,outside,z).state;assert.equal(unconfirmed.outside_confirmed_at,null);assert.equal(unconfirmed.outside_from_at,stamp(10));
 const changed=step(state,6,outside,{...z,revision:2});assert.equal(changed.state.outside_confirmed_at,null);assert.equal(step(state,6,outside,z,{vehicle:{...vehicle,agency_id:3}}).state,null,'transfer to another city discards the old confirmation');
});
function operatingFixture(){
 const f=fixture(),operating={...zone('operating'),agency_id:vehicle.agency_id,indicative:true},driver={id:randomUUID(),name:'Synthetic Driver',vehicle_key:vehicle.key,ludy_driver_code:'TEST_CLIENT',vehicle_link_method:'manual',link_evidence:{method:'manual',at:stamp(-60)}};
 f.tables.fleet_parking_zones=[operating];f.tables.fleet_drivers=[driver];
 for(const provider of ['uber','bolt']){const id=randomUUID();f.tables.fleet_sources.push({id:provider,...health(0)});f.tables.fleet_identities.push({id,driver_id:driver.id,source:provider});f.tables.fleet_latest.push({identity_id:id,driver_id:driver.id,source:provider,status:provider==='uber'?'available':'offline',observed_at:stamp(0),evidence:{}});}
 return {...f,operating,driver};
}
test('availability requires an exact current assignment and every known account to be fresh with none on trip or approach',()=>{
 const f=operatingFixture(),args={driver:f.driver,vehicle,identities:f.tables.fleet_identities,latest:f.tables.fleet_latest,sources:f.tables.fleet_sources,now:start};
 assert.equal(operatingAvailability(args).driver_id,f.driver.id);
 for(const status of ['on_trip','to_pickup','unknown']){f.tables.fleet_latest[1].status=status;assert.equal(operatingAvailability(args),null);}
 f.tables.fleet_latest[1].status='offline';f.tables.fleet_latest[1].observed_at=stamp(-1000);assert.equal(operatingAvailability(args),null);f.tables.fleet_latest[1].observed_at=stamp(0);
 assert.equal(operatingAvailability({...args,driver:{...f.driver,vehicle_key:'OTHER'}}),null);assert.equal(operatingAvailability({...args,driver:{...f.driver,vehicle_link_method:null}}),null);assert.equal(operatingAvailability({...args,driver:{...f.driver,vehicle_link_evidence:{assignment_conflict:{requires_confirmation:true}}}}),null);
 const proof={method:'myclicar_contract',source:'myclicar',contract_id:'CONTRACT',client_code:f.driver.ludy_driver_code,vehicle_key:vehicle.key,observed_at:stamp(0),expires_at:stamp(60)},auto={...f.driver,vehicle_link_method:'myclicar_contract',vehicle_link_evidence:proof};
 args.sources.push({id:'myclicar',...health(0)});assert.ok(operatingAvailability({...args,driver:auto}));assert.equal(operatingAvailability({...args,driver:{...auto,vehicle_link_evidence:{...proof,client_code:'OTHER'}}}),null);assert.equal(operatingAvailability({...args,driver:{...auto,vehicle_link_evidence:{...proof,expires_at:stamp(-1)}}}),null);
});
test('confirmed outside plus available triggers a scoped indicative warning, and switching from a trip needs no new crossing',async()=>{
 const f=operatingFixture();f.tables.fleet_latest[0].status='on_trip';await f.observe(0,outside);assert.deepEqual((await f.call('alerts')).data.alerts,[]);await f.observe(6,outside);assert.deepEqual((await f.call('alerts')).data.alerts,[]);
 f.tables.fleet_latest[0].status='available';f.tables.fleet_latest[0].observed_at=stamp(6);
 let response=await f.call('alerts',{token:'viewer'}),a=response.data.alerts;assert.equal(a.length,1);assert.equal(a[0].category,'outside_operating');assert.equal(a[0].label,'Disponible hors zone · contour indicatif');assert.equal(a[0].indicative,true);assert.equal(a[0].driver_id,f.driver.id);assert.equal(a[0].vehicle_key,vehicle.key);assert.equal(a[0].position_at,stamp(6));assert.deepEqual(a[0].available_sources,[{source:'uber',observed_at:stamp(6)}]);const id=a[0].id;
 const overview=(await f.call('overview',{token:'viewer'})).data;assert.equal(overview.counts.outside_operating,1);assert.equal(overview.vehicles[0].operating_alert.id,id);
 f.tables.fleet_latest[1].status='to_pickup';assert.deepEqual((await f.call('alerts')).data.alerts,[]);f.tables.fleet_latest[1].status='offline';assert.equal((await f.call('alerts')).data.alerts[0].id,id);
 f.tables.fleet_latest[0].status='unknown';assert.deepEqual((await f.call('alerts')).data.alerts,[]);f.tables.fleet_latest[0].status='available';
 f.tables.fleet_sources[0].status='paused';assert.deepEqual((await f.call('alerts')).data.alerts,[]);
 assert.equal(f.providerCalls.length,0);
});
test('authorized areas form a per-agency union; other cities and incomplete or stale location evidence cannot warn',async()=>{
 const f=operatingFixture(),other={...zone('operating'),agency_id:3};f.tables.fleet_parking_zones=[other];await f.observe(0,outside);await f.observe(6,outside);assert.deepEqual((await f.call('alerts')).data.alerts,[]);
 const g=operatingFixture(),permitted={...zone('operating'),agency_id:vehicle.agency_id,shape:{type:'circle',center:outside,radius_m:100}};g.tables.fleet_parking_zones.push(permitted);await g.observe(0,outside);await g.observe(6,outside);assert.deepEqual((await g.call('alerts')).data.alerts,[],'inside another authorized area of the same agency is allowed');
 const h=operatingFixture();await h.observe(0,outside);await h.observe(6,outside);h.tables.live_status[0].lat=null;assert.deepEqual((await h.call('alerts')).data.alerts,[]);await h.observe(10,outside);h.tables.fleet_source_events.push({source:'geotab',status:'paused',at:stamp(11)});h.setTime(12);assert.deepEqual((await h.call('alerts')).data.alerts,[],'an interruption invalidates an earlier confirmed outside state');h.tables.fleet_source_events=[];h.setTime(200);assert.deepEqual((await h.call('alerts')).data.alerts,[]);
});
test('duplicate assignments and a competing live platform plate claim suspend outside attribution',async()=>{
 const f=operatingFixture();await f.observe(0,outside);await f.observe(6,outside);f.tables.fleet_drivers.push({...f.driver,id:randomUUID(),ludy_driver_code:'OTHER'});assert.deepEqual((await f.call('alerts')).data.alerts,[]);f.tables.fleet_drivers.pop();
 const other={...f.driver,id:randomUUID(),ludy_driver_code:'OTHER',vehicle_key:'OTHER'};f.tables.fleet_drivers.push(other);f.tables.fleet_latest.push({identity_id:randomUUID(),driver_id:other.id,source:'uber',status:'available',observed_at:stamp(6),vehicle_label:vehicle.plate,evidence:{method:'visible_dom'}});assert.deepEqual((await f.call('alerts')).data.alerts,[]);
});

test('unused parked markers require complete local proof, stay RLS-scoped, and expose no VIN or contract details',async()=>{
 const f=fixture();await f.observe(0);const extra=f.tables.vehicles[1];
 f.tables.live_status.push({vehicle_key:extra.key,...center,speed:0,last_pos_at:stamp(0),updated_at:stamp(0)});
 const state=f.tables.fleet_parking_state.find(s=>s.zone_id===f.parking.id).state;
 f.tables.fleet_parking_state.push({vehicle_key:extra.key,zone_id:f.parking.id,state:{...state,device_id:extra.geotab_id}});
 for(const [i,v] of f.tables.vehicles.entries()){v.myclicar_external_id='provider-'+i;v.vin='PRIVATE-VIN-'+i;f.tables.fleet_myclicar_vehicles.push({external_id:v.myclicar_external_id,vehicle_key:v.key,plate:v.plate,vin:v.vin,status:'AVAILABLE',is_blocked:false,archived:false,deleted_at:null,current:true,reason:'matched',observed_at:stamp(0)});}
 f.tables.fleet_inventory_sync=[{id:1,status:'healthy',last_success_at:stamp(0),counts:{current_vehicles:2}}];
 f.tables.fleet_sources.push({id:'myclicar',...health(0),stale_after_s:300,coverage:{contracts:0}},{id:'uber',...health(0)},{id:'bolt',status:'unconnected',stale_after_s:90});
 const admin=await f.call('alerts');assert.equal(admin.status,200);assert.equal(admin.data.parked_vehicles.length,2);
 const scoped=await f.call('alerts',{token:'viewer'});assert.deepEqual(scoped.data.parked_vehicles,[{vehicle_key:vehicle.key,position_at:stamp(0),parked_at:stamp(0),zone_name:f.parking.name}]);assert.equal(scoped.data.alerts.length,1,'existing exclusion alert preserved');assert.doesNotMatch(JSON.stringify(scoped.data.parked_vehicles),/OTHER|PRIVATE-VIN|provider-/);
 const overview=await f.call('overview',{token:'viewer'});assert.equal(overview.data.vehicles[0].unused_parked,true);assert.equal(overview.data.vehicles[0].parked,true);assert.equal(Object.hasOwn(overview.data.vehicles[0],'vin'),false);assert.equal(Object.hasOwn(overview.data.vehicles[0],'myclicar_external_id'),false);
 const id=randomUUID();f.tables.fleet_identities.push({id,source:'uber',driver_id:'unassigned-driver'});f.tables.fleet_latest.push({identity_id:id,source:'uber',driver_id:'unassigned-driver',status:'on_trip',observed_at:stamp(0),vehicle_label:vehicle.plate,evidence:{}});
 const claimed=await f.call('alerts',{token:'viewer'});assert.deepEqual(claimed.data.parked_vehicles,[]);assert.equal(claimed.data.alerts.length,1);
 f.tables.fleet_latest[0].status='offline';f.tables.fleet_inventory_sync[0].status='error';const unknown=await f.call('overview',{token:'viewer'});assert.equal(unknown.status,200);assert.equal(unknown.data.vehicles[0].unused_parked,false);assert.equal(unknown.data.vehicles[0].parked,true);
 assert.equal(f.providerCalls.length,0,'the proof uses only local reads');
});

test('verified returns allow a dated last-known parking marker without reviving presence or crossing events',async()=>{
 const f=fixture();await f.observe(0);f.setTime(600);
 const v=f.tables.vehicles[0];Object.assign(v,{myclicar_external_id:'provider-private',vin:'PRIVATE-VIN'});
 Object.assign(f.tables.live_status[0],{speed:0,ign_on:false,updated_at:stamp(600)});
 Object.assign(f.tables.fleet_sources[0],health(600));
 f.tables.fleet_sources.push({id:'myclicar',...health(600),stale_after_s:300,coverage:{contracts:0}},{id:'uber',...health(600)},{id:'bolt',status:'unconnected',stale_after_s:90});
 f.tables.fleet_myclicar_vehicles=[{external_id:v.myclicar_external_id,vehicle_key:v.key,plate:v.plate,vin:v.vin,status:'AVAILABLE',is_blocked:false,archived:false,deleted_at:null,current:true,reason:'matched',observed_at:stamp(600)}];
 f.tables.fleet_inventory_sync=[{id:1,status:'healthy',last_success_at:stamp(600),counts:{current_vehicles:1}}];
 const identity=randomUUID();f.tables.fleet_identities=[{id:identity,driver_id:'former',source:'uber'}];f.tables.fleet_latest=[{identity_id:identity,driver_id:'former',source:'uber',status:'available',observed_at:stamp(0),vehicle_label:v.plate,evidence:{}}];
 assert.deepEqual((await f.call('alerts',{token:'viewer'})).data.parked_vehicles,[],'old claims require a real return');
 f.tables.fleet_rotation_sync=[{id:1,status:'healthy',last_success_at:stamp(600)}];f.tables.fleet_rotation_contracts=[{external_id:'private-return',vehicle_key:v.key,vehicle_external_id:v.myclicar_external_id,status:'DONE',effective_start_at:stamp(-3600),end_at:stamp(300),observed_at:stamp(600),details_verified:true,deleted:false}];
 const response=(await f.call('overview',{token:'viewer'})).data,proof=response.vehicles[0].last_known_unused_parking;
 assert.ok(proof);assert.equal(proof.position_basis,'last_known_parking');assert.equal(proof.presence_current,false);assert.equal(proof.position_at,stamp(0));assert.equal(proof.checked_at,stamp(600));assert.equal(proof.device_id,v.geotab_id);assert.equal(proof.lat,center.lat);assert.equal(proof.lon,center.lon);assert.equal(proof.ign_on,false);
 assert.equal(response.counts.parked,0);assert.equal(response.counts.fresh,0);assert.equal(response.vehicles[0].position.fresh,false);assert.equal(response.vehicles[0].parked,false);assert.equal(response.vehicles[0].unused_parked,false);assert.deepEqual(response.events,[]);assert.deepEqual(response.alerts,[]);
 const markers=(await f.call('alerts',{token:'viewer'})).data.parked_vehicles;assert.deepEqual(markers,[proof]);assert.doesNotMatch(JSON.stringify(markers),/PRIVATE-VIN|provider-private|private-return|former|OTHER/);
 // Return reads are scoped to the caller's parking candidates, not the whole
 // fleet history. The real return may be on a later page and must not be lost.
 const returned=f.tables.fleet_rotation_contracts[0];f.tables.fleet_rotation_contracts=[...Array.from({length:1000},(_,i)=>({...returned,external_id:'unverified-'+i,details_verified:false})),returned,{...returned,external_id:'other-agency-return',vehicle_key:'OTHER'}];
 const before=f.calls.length;assert.deepEqual((await f.call('alerts',{token:'viewer'})).data.parked_vehicles,[proof]);
 const proofReads=f.calls.slice(before).filter(c=>c.table==='fleet_rotation_contracts');assert.equal(proofReads.length,2);assert.deepEqual(proofReads.map(c=>c.params.offset),['0','1000']);assert.ok(proofReads.every(c=>c.params.vehicle_key==='in.('+JSON.stringify(vehicle.key)+')'&&c.params.order==='vehicle_key,end_at.desc,external_id'));
 assert.ok(f.calls.slice(before).filter(c=>['fleet_myclicar_contracts','fleet_latest'].includes(c.table)).every(c=>c.params.vehicle_key===undefined),'competing active contracts and platform claims stay complete');
 f.tables.fleet_latest[0].observed_at=stamp(600);assert.deepEqual((await f.call('alerts',{token:'viewer'})).data.parked_vehicles,[],'new platform activity after return blocks historical unused marker');f.tables.fleet_latest[0].observed_at=stamp(0);
 f.parking.archived_at=stamp(600);f.parking.enabled=false;assert.deepEqual((await f.call('alerts',{token:'viewer'})).data.parked_vehicles,[]);f.parking.archived_at=null;f.parking.enabled=true;
 f.tables.live_status[0].ign_on=true;assert.deepEqual((await f.call('alerts',{token:'viewer'})).data.parked_vehicles,[]);
 assert.equal(f.providerCalls.length,0);
});

test('parking creation retries reuse one zone and later edits target its returned identity',async()=>{
 const f=fixture(),input={name:'Synthetic reusable parking',kind:'parking',agency_id:1,enabled:true,shape:f.parking.shape,request_id:randomUUID()},before=f.tables.fleet_parking_zones.length;
 const first=await f.call('zones',{body:input}),second=await f.call('zones',{body:input});assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(first.data.id,input.request_id);assert.equal(second.data.id,input.request_id);assert.equal(f.tables.fleet_parking_zones.length,before+1);
 assert.equal((await f.call('zones',{body:{...input,name:'Changed retry content'}})).status,409);assert.equal(f.tables.fleet_parking_zones.find(z=>z.id===input.request_id).name,input.name);
 assert.equal((await f.call('zones',{body:{...input,id:first.data.id,name:'Edited existing parking'}})).status,200);assert.equal(f.tables.fleet_parking_zones.length,before+1);assert.equal(f.tables.fleet_parking_zones.find(z=>z.id===input.request_id).name,'Edited existing parking');
});
test('archive requires an administrator, exact UUID and positive integer revision before any mutation',async()=>{
 const f=fixture(),body={id:f.parking.id,revision:1};
 for(const token of ['manager','viewer'])assert.equal((await f.call('zones/archive',{token,body})).status,403);
 for(const value of [{...body,id:'-'.repeat(36)},{...body,id:1},{...body,revision:'1'},{...body,revision:0},{...body,revision:1.1},{...body,revision:Number.MAX_SAFE_INTEGER+1}])assert.equal((await f.call('zones/archive',{body:value})).status,400);
 assert.equal(f.calls.some(c=>c.table==='fleet_archive_parking_zone'),false);assert.equal((await f.call('zones/archive',{body:{id:randomUUID(),revision:1}})).status,404);
 assert.equal((await f.call('zones/archive',{body:{...body,revision:2}})).status,409);assert.equal(f.parking.enabled,true);
});
test('archived zones disappear from maps and alerts while scoped history retains their name and kind',async()=>{
 const f=fixture();await f.observe(0,outside);await f.observe(10);await f.observe(16);const eventCount=f.tables.fleet_parking_events.length;
 const response=await f.call('zones/archive',{body:{id:f.exclusion.id,revision:1,userId:'ignored'}});assert.equal(response.status,200);assert.equal(response.data.revision,2);assert.equal(response.data.archived_at,stamp(16));
 assert.equal(f.tables.fleet_parking_zones.length,2);assert.equal(f.tables.fleet_parking_events.length,eventCount);assert.equal(f.tables.fleet_parking_state.some(s=>s.zone_id===f.exclusion.id),false);
 f.tables.fleet_parking_events.push({event_key:'other',vehicle_key:'OTHER',zone_id:f.exclusion.id,kind:'entered',observed_at:stamp(16)});
 const view=await f.call('overview',{token:'viewer'});assert.equal(view.data.zones.length,1);assert.equal(view.data.counts.exclusion,0);assert.equal(view.data.events.length,eventCount);const historical=view.data.events.find(e=>e.zone_id===f.exclusion.id);assert.equal(historical.zone_name,f.exclusion.name);assert.equal(historical.zone_kind,'exclusion');assert.equal(historical.zone_archived,true);
 assert.deepEqual((await f.call('alerts')).data.alerts,[]);const before=f.calls.filter(c=>c.table==='fleet_commit_parking').length;await f.observe(22);
 for(const call of f.calls.filter(c=>c.table==='fleet_commit_parking').slice(before))assert.equal(call.body.p_states.some(s=>s.zone_id===f.exclusion.id),false);
 assert.equal((await f.call('zones/archive',{body:{id:f.exclusion.id,revision:1}})).status,409);assert.equal((await f.call('zones',{body:{...f.exclusion,enabled:true}})).status,409);
 assert.equal(f.calls.some(c=>c.method==='DELETE'),false);
});
test('optimistic edits cannot reactivate a zone archived while their PATCH was waiting',async()=>{
 const f=fixture(),input={...f.parking,name:'New name',revision:1},gate=f.holdNext('fleet_parking_zones','PATCH'),editing=f.call('zones',{body:input});await gate.ready;
 assert.equal((await f.call('zones/archive',{body:{id:f.parking.id,revision:1}})).status,200);gate.release();assert.equal((await editing).status,409);assert.equal(f.parking.enabled,false);assert.equal(f.parking.name,'Synthetic parking');
 const g=fixture(),first=await g.call('zones',{body:{...g.parking,name:'First edit',revision:1}});assert.equal(first.status,200);assert.equal(first.data.revision,2);assert.equal((await g.call('zones',{body:{...g.parking,name:'Stale edit',revision:1}})).status,409);
});
test('manual creation retries never restore an archive; an explicit Geotab reimport restores only its existing source identity',async()=>{
 const f=fixture(),manual={name:'Manual',kind:'parking',agency_id:1,enabled:true,shape:f.parking.shape,request_id:randomUUID()};let made=await f.call('zones',{body:manual});assert.equal(made.data.revision,1);
 await f.call('zones/archive',{body:{id:made.data.id,revision:1}});assert.equal((await f.call('zones',{body:manual})).status,409);assert.equal(f.tables.fleet_parking_zones.find(z=>z.id===manual.request_id).enabled,false);
 const provider={name:'Imported parking',source_id:'global-exclusion',kind:'parking',agency_id:1,enabled:true};made=await f.call('zones',{body:provider});const id=made.data.id;await f.call('zones/archive',{body:{id,revision:1}});const count=f.tables.fleet_parking_zones.length;
 const restored=await f.call('zones',{body:provider});assert.equal(restored.status,200);assert.equal(restored.data.id,id);assert.equal(restored.data.revision,3);assert.equal(f.tables.fleet_parking_zones.length,count);assert.equal(f.tables.fleet_parking_zones.find(z=>z.id===id).archived_at,null);assert.equal(f.tables.fleet_parking_zones.find(z=>z.id===id).enabled,true);
});
