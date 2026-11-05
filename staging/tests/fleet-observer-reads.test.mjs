import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createFleetApi} from '../server/fleet.mjs';
import {createObserverReadCache} from '../server/observer-read-cache.mjs';

function fixture(t){
 let clock=Date.parse('2026-11-05T12:00:00Z'),failing=null,privateReads=0,localStatus=0;
 const at=new Date(clock).toISOString(),calls=[],users={alpha:{id:'alpha',role:'viewer',agencies:[1]},beta:{id:'beta',role:'manager',agencies:[2]},admin:{id:'admin',role:'admin',agencies:[]}};
 const tables={profiles:Object.values(users),user_agencies:[],fleet_sources:['uber','bolt','geotab','myclicar'].map(id=>({id,status:'healthy',last_success_at:at,stale_after_s:180,last_error:null,metadata:{private:'never returned'}})),
  fleet_settings:[{id:1,enabled:false,disconnection_enabled:true,disconnection_policy:'any',duty_mode:'contract'}],fleet_drivers:[],vehicles:[],live_status:[],desktop_vehicle_live:[],fleet_latest:[],fleet_identities:[],fleet_motion_alerts:[],fleet_disconnection_alerts:[],fleet_source_events:[],fleet_myclicar_contracts:[],fleet_contract_assignment_overrides:[],fleet_disconnection_checkpoints:[],params:[]};
 for(const [suffix,agency_id] of [['a',1],['b',2]]){
  tables.fleet_drivers.push({id:'driver-'+suffix,name:'Driver '+suffix,agency_id,vehicle_key:'car-'+suffix,vehicle_link_method:'manual'});
  tables.vehicles.push({key:'car-'+suffix,plate:'Plate '+suffix,agency_id,geotab_id:'gps-'+suffix});
  tables.live_status.push({vehicle_key:'car-'+suffix,lat:1,lon:2,speed:10,state:'moving',last_pos_at:at,updated_at:at});
  tables.desktop_vehicle_live.push({vehicle_key:'car-'+suffix,observed_at:at,data:{device_id:'gps-'+suffix,captured_at:at,events:[{id:'event-'+suffix,type:'Speeding',at,end:at}],extra:{}}});
  tables.fleet_identities.push({id:'identity-'+suffix,driver_id:'driver-'+suffix,source:'uber'});
  tables.fleet_latest.push({identity_id:'identity-'+suffix,driver_id:'driver-'+suffix,source:'uber',status:'offline',observed_at:at,offline_since:at,evidence:{}});
  tables.fleet_motion_alerts.push({id:'motion-'+suffix,driver_id:'driver-'+suffix,identity_id:'identity-'+suffix,vehicle_key:'car-'+suffix,source:'uber',status:'open',observed_since:at,opened_at:at,last_seen_at:at,evidence:{ign_on:true}});
  tables.fleet_disconnection_alerts.push({id:'disconnection-'+suffix,driver_id:'driver-'+suffix,identity_id:'identity-'+suffix,vehicle_key:'car-'+suffix,source:'uber',status:'open',disconnected_at:at,observed_online_at:new Date(clock-1000).toISOString(),evidence:{policy:'any'}});
 }
 const fetchFn=async(url,options={})=>{
  const u=new URL(url),token=options.headers.Authorization?.replace('Bearer ',''),user=users[token],method=options.method||'GET',resource=u.pathname.split('/').at(-1),params=Object.fromEntries(u.searchParams),body=options.body?JSON.parse(options.body):null;
  calls.push({resource,token,method,params,body});
  if(u.pathname==='/auth/v1/user')return Response.json({id:user?.id},{status:user?200:401});
  if(resource===failing)return Response.json({}, {status:503});
  if(['fleet_motion_checkpoints','fleet_disconnection_checkpoints','fleet_myclicar_contracts'].includes(resource)&&token!=='service'){privateReads++;return Response.json({}, {status:403});}
  if(resource==='fleet_source_health'){
   if(!user||!['admin','manager','viewer'].includes(user.role))return Response.json({}, {status:403});
   return Response.json(tables.fleet_sources.map(({id,status,last_success_at,last_error,stale_after_s,metadata})=>({id,name:id,status,last_success_at,last_error:last_error?'Collecte temporairement indisponible.':null,stale_after_s,motion_error:!!metadata?.motion_error})));
  }
  if(u.pathname.includes('/rpc/'))return Response.json({}, {status:503});
  let rows=resource==='user_agencies'?Object.values(users).flatMap(owner=>owner.agencies.map(agency_id=>({user_id:owner.id,agency_id}))):tables[resource]||[];
  const matches=row=>Object.entries(params).every(([key,value])=>value.startsWith('eq.')?String(row[key])===value.slice(3):value.startsWith('in.(')?value.slice(4,-1).split(',').includes(String(row[key])):true);
  if(resource==='profiles')rows=rows.map(owner=>({user_id:owner.id,role:owner.role}));
  if(resource==='fleet_sources'&&token!=='service'&&user?.role!=='admin')rows=[];
  if(user&&user.role!=='admin'&&!['profiles','user_agencies','fleet_sources','fleet_settings'].includes(resource))rows=rows.filter(row=>{
   if(resource==='vehicles'||resource==='fleet_drivers')return user.agencies.includes(row.agency_id);
   if(row.driver_id)return tables.fleet_drivers.some(driver=>driver.id===row.driver_id&&user.agencies.includes(driver.agency_id));
   if(row.vehicle_key)return tables.vehicles.some(vehicle=>vehicle.key===row.vehicle_key&&user.agencies.includes(vehicle.agency_id));
   return false;
  });
  rows=rows.filter(matches);
  if(method==='PATCH')for(const row of rows)Object.assign(row,body);
  if(method==='POST'){const values=Array.isArray(body)?body:[body];(tables[resource]??=[]).push(...values);rows=values;}
  const offset=Number(params.offset||0),limit=Number(params.limit||1000);return Response.json(rows.slice(offset,offset+limit));
 };
 const Local=()=>({status:async()=>{localStatus++;throw Error('Local credentials must not be consulted');},close(){}});
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',sharedCollection:true,observerCacheMs:5000,fetchFn,now:()=>clock,Geotab:Local,Myclicar:Local});t.after(()=>handler.close());
 async function call(path,token='alpha',body){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/fleet/'+path,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4173',authorization:'Bearer '+token},socket:{remoteAddress:'127.0.0.1'}});
  let code,value;await handler(req,{writeHead:status=>{code=status;},end:data=>{value=JSON.parse(data);},setHeader(){}});return {code,value};
 }
 return {call,calls,tables,users,advance:ms=>{clock+=ms;},fail:name=>{failing=name;},get privateReads(){return privateReads;},get localStatus(){return localStatus;}};
}

test('observer map and disconnections reuse data across polling without consulting private collector state',async t=>{
 const f=fixture(t),first=await Promise.all([f.call('geotab/live'),f.call('disconnections')]);assert.ok(first.every(r=>r.code===200));
 const firstData=f.calls.filter(call=>!['user','profiles','user_agencies'].includes(call.resource)).length;assert.ok(firstData<=16,firstData+' data reads');
 assert.equal(f.privateReads,0);assert.equal(first[0].value.vehicles[0].key,'car-a');assert.equal(first[1].value.alerts[0].driver_id,'driver-a');
 const before=f.calls.length;f.advance(2000);const second=await Promise.all([f.call('geotab/live'),f.call('disconnections')]);assert.ok(second.every(r=>r.code===200));
 assert.equal(f.calls.slice(before).filter(call=>!['user','profiles','user_agencies'].includes(call.resource)).length,0,'fresh raw rows are shared; authorization is still checked');
 assert.equal(f.calls.slice(before).filter(call=>call.resource==='user_agencies').length,2);
 f.advance(3001);const expired=f.calls.length;await f.call('geotab/live');assert.ok(f.calls.length>expired+3,'the five-second cache expires');
});

test('cached observer data is isolated by token, role and current agency membership',async t=>{
 const f=fixture(t);const [alpha,beta]=await Promise.all([f.call('geotab/live','alpha'),f.call('geotab/live','beta')]);
 assert.deepEqual(alpha.value.vehicles.map(row=>row.key),['car-a']);assert.deepEqual(beta.value.vehicles.map(row=>row.key),['car-b']);
 assert.ok(!JSON.stringify(alpha.value).includes('Driver b'));assert.ok(!JSON.stringify(beta.value).includes('Driver a'));
 f.users.alpha.agencies=[2];const reassigned=await f.call('geotab/live','alpha');assert.deepEqual(reassigned.value.vehicles.map(row=>row.key),['car-b'],'membership changes take effect before the cache TTL');
 assert.equal((await f.call('geotab/live','admin')).value.vehicles.length,2);
 f.users.admin.role='viewer';f.users.admin.agencies=[1];assert.deepEqual((await f.call('geotab/live','admin')).value.vehicles.map(row=>row.key),['car-a'],'the same JWT cannot reuse former administrator rows');
 f.users.alpha.role='pending';assert.equal((await f.call('geotab/live','alpha')).code,403);
});

test('light health and remote connector status never consult local credentials or expose their metadata',async t=>{
 const f=fixture(t),health=await f.call('health');assert.equal(health.code,200);assert.equal(health.value.sources.length,4);
 assert.ok(f.calls.every(call=>['user','profiles','user_agencies','fleet_source_health'].includes(call.resource)));assert.ok(!JSON.stringify(health.value).includes('private'));
 assert.ok(f.calls.filter(call=>call.resource==='fleet_source_health').every(call=>call.token==='alpha'),'health RPC uses the observer JWT, never the worker transport');
 for(const source of ['geotab','myclicar']){const status=await f.call(source+'/status','admin');assert.equal(status.code,200);assert.equal(status.value.collectionRemote,true);assert.equal(status.value.configured,true);assert.equal(status.value.status,'healthy');assert.ok(!Object.hasOwn(status.value,'userName'));}
 assert.equal(f.localStatus,0);const source=f.tables.fleet_sources.find(row=>row.id==='geotab');source.stale_after_s=1;
 f.advance(5001);await f.call('health');const before=f.calls.length;f.advance(1000);const stale=await f.call('health');assert.equal(stale.value.sources.find(row=>row.id==='geotab').status,'stale');
 assert.ok(f.calls.slice(before).every(call=>['user','profiles','user_agencies'].includes(call.resource)),'freshness is calculated now, not frozen in a cached response');
});

test('light alerts preserve scoped persisted incidents and driving events without loading positions or private checkpoints',async t=>{
 const f=fixture(t),response=await f.call('alerts');assert.equal(response.code,200);
 assert.deepEqual(response.value.events.map(row=>row.key),['car-a']);assert.deepEqual(response.value.motion_alerts.map(row=>row.id),['motion-a']);
 assert.equal(response.value.motion_alerts[0].status,'open');assert.ok(!Object.hasOwn(response.value,'vehicles'));assert.ok(!Object.hasOwn(response.value,'motion_coverage'));assert.equal(f.privateReads,0);
 assert.ok(!f.calls.some(call=>['live_status','fleet_motion_checkpoints','fleet_disconnection_checkpoints','fleet_myclicar_contracts'].includes(call.resource)));
});

test('light alerts suspend incidents when a central snapshot is stale or motion processing failed',async t=>{
 for(const mode of ['stale','future','motion_error','source_motion_error']){
  const f=fixture(t),snapshot=f.tables.desktop_vehicle_live[0];
  if(mode==='motion_error')snapshot.data.extra.motion_error='Synthetic processing interruption';
  else if(mode==='source_motion_error')f.tables.fleet_sources.find(row=>row.id==='geotab').metadata.motion_error='Synthetic private error';
  else snapshot.observed_at=new Date(Date.parse(snapshot.observed_at)+(mode==='stale'?-86400000:61000)).toISOString();
  delete snapshot.data.events[0].end;
  const response=await f.call('alerts');assert.equal(response.code,200);assert.equal(response.value.motion_alerts[0].status,'suspended',mode);
  if(['stale','future'].includes(mode))assert.deepEqual(response.value.events,[],'an undated end cannot keep an old snapshot event alive');
 }
});

test('published disconnections suspend an incident after identity reassignment, source mismatch or an older observation',async t=>{
 for(const change of [{driver_id:'driver-b'},{source:'bolt'},{observed_at:'2026-11-05T11:59:59Z'}]){
  const f=fixture(t);Object.assign(f.tables.fleet_latest[0],change);
  const result=await f.call('disconnections','admin');assert.equal(result.code,200);
  assert.equal(result.value.alerts.find(row=>row.id==='disconnection-a').status,'suspended',JSON.stringify(change));
 }
});

test('health projection remains mandatory for non-admin observers and a failed RPC is never cached as success',async t=>{
 const f=fixture(t);f.tables.fleet_sources[0].last_error='private provider account details';
 const response=await f.call('health','beta');assert.equal(response.code,200);
 assert.equal(response.value.sources[0].last_error,'Collecte temporairement indisponible.');assert.ok(!JSON.stringify(response.value).includes('private'));
 f.fail('fleet_source_health');assert.equal((await f.call('health')).code,502);
 f.fail(null);assert.equal((await f.call('health')).value.sources.length,4);
 assert.ok(!f.calls.some(call=>call.resource==='fleet_sources'),'direct source table RLS cannot be mistaken for an empty healthy fleet');
});

test('a standalone collector keeps its live alert semantics without requiring desktop snapshots or the new RPC',async t=>{
 const calls=[],handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',
  fetchFn:async(url,options)=>{calls.push(url);return Response.json(url.includes('/auth/v1/user')?{id:'viewer'}:[{user_id:'viewer',role:'viewer'}]);},
  Geotab:()=>({close(){},live:async token=>{assert.equal(token,'viewer');return {at:'now',source:{status:'healthy'},events:[{id:'driving'}],motion_alerts:[{id:'motion'}],motion_watches:[{key:'car'}],vehicles:[{key:'private position'}]};}}),Myclicar:()=>({close(){}})});
 t.after(()=>handler.close());const req=Readable.from([]);Object.assign(req,{url:'/api/fleet/alerts',method:'GET',headers:{host:'127.0.0.1:4173',authorization:'Bearer viewer'},socket:{remoteAddress:'127.0.0.1'}});
 let code,value;await handler(req,{writeHead:status=>{code=status;},end:data=>{value=JSON.parse(data);}});
 assert.equal(code,200);assert.deepEqual(value.events,[{id:'driving'}]);assert.deepEqual(value.motion_alerts,[{id:'motion'}]);assert.deepEqual(value.motion_watches,[{key:'car'}]);
 assert.ok(!Object.hasOwn(value,'vehicles'));assert.equal(calls.length,2,'only authorization reads precede the existing collector view');
});

test('failed reads are retried and successful settings writes invalidate observer snapshots immediately',async t=>{
 const f=fixture(t);f.fail('live_status');assert.equal((await f.call('geotab/live')).code,502);f.fail(null);assert.equal((await f.call('geotab/live')).code,200);
 assert.equal((await f.call('disconnections','admin')).value.enabled,true);
 assert.equal((await f.call('disconnections/settings','admin',{enabled:false,policy:'any',duty_mode:'contract'})).code,200);
 assert.equal((await f.call('disconnections','admin')).value.enabled,false,'write invalidation does not wait for the TTL');
});

test('observer cache coalesces in-flight reads, isolates returned objects and never restores an invalidated entry',async()=>{
 let clock=0,release,calls=0;const cache=createObserverReadCache({now:()=>clock}),gate=new Promise(resolve=>{release=resolve;});
 const load=async()=>{calls++;await gate;return [{value:1}];},one=cache.read('table',{},'scope-a',load),two=cache.read('table',{},'scope-a',load);
 cache.invalidate(['table']);release();const [a,b]=await Promise.all([one,two]);assert.equal(calls,1);a[0].value=99;assert.equal(b[0].value,1);
 await cache.read('table',{},'scope-a',load);assert.equal(calls,2,'an in-flight read cannot refill an invalidated cache');
 clock=5001;await cache.read('table',{},'scope-a',load);assert.equal(calls,3);
 await assert.rejects(cache.read('other',{},'scope-a',async()=>{throw Error('offline');}),/offline/);
 assert.deepEqual(await cache.read('other',{},'scope-a',async()=>['recovered']),['recovered']);
});
