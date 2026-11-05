import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFleetApi } from '../server/fleet.mjs';
import { sourceKey } from '../server/fleet-domain.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {initializePrivateRoot} from '../server/private-files.mjs';
import {readBoltCredentials} from '../server/bolt.mjs';

test('standby Bolt configuration is local, administrator-only and never starts collection or returns secrets',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-bolt-http-')));await initializePrivateRoot(root);t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {tables,fetchFn,requests}=mockLocal(),file=path.join(root,'bolt.env');let resets=0,reads=0;
 class NoNetworkBolt{resetCredentials(){resets++;}snapshot(){reads++;throw Error('Provider must not run during configuration');}}
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,boltEnvPath:file,sharedCollection:true,Bolt:NoNetworkBolt});t.after(()=>handler.close());
 assert.deepEqual(await callApi(handler,'bolt/config'),{code:200,value:{configured:false}});
 assert.equal((await callApi(handler,'bolt/config',undefined,'invalid')).code,401);
 const credentials={clientId:'synthetic-id',clientSecret:'synthetic-secret'};
 tables.profiles[0].role='viewer';assert.equal((await callApi(handler,'bolt/config',credentials)).code,403);assert.equal((await callApi(handler,'bolt/config')).code,403);assert.equal(await readBoltCredentials(file),null);
 tables.profiles[0].role='admin';assert.deepEqual(await callApi(handler,'bolt/config',credentials),{code:200,value:{configured:true}});assert.deepEqual(await readBoltCredentials(file),credentials);
 assert.deepEqual(await callApi(handler,'bolt/config'),{code:200,value:{configured:true}});
 assert.equal((await callApi(handler,'bolt/config',{...credentials,clientSecret:'invalid\nvalue'})).code,400);assert.deepEqual(await readBoltCredentials(file),credentials);
 assert.equal(resets,1);assert.equal(reads,0);assert.ok(requests.every(r=>r.method==='GET'&&r.table==='profiles'),'configuration never writes shared business data');
});

test('Bolt configuration cannot change credentials while local collection is running',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-bolt-http-')));await initializePrivateRoot(root);t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {fetchFn}=mockLocal(),file=path.join(root,'bolt.env');let reads=0;
 class EmptyBolt{resetCredentials(){}async snapshot(){reads++;return {rows:[],vehicles:[],companies:[],at:new Date().toISOString()};}}
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,boltEnvPath:file,Bolt:EmptyBolt,setTimer:()=>({unref(){}}),clearTimer(){}});t.after(()=>handler.close());
 const credentials={clientId:'synthetic-id',clientSecret:'synthetic-secret'};assert.equal((await callApi(handler,'bolt/config',credentials)).code,200);
 assert.equal((await callApi(handler,'bolt/start',{})).code,200);assert.equal(reads,1);
 assert.equal((await callApi(handler,'bolt/config',{...credentials,clientSecret:'replacement'})).code,409);assert.deepEqual(await readBoltCredentials(file),credentials);
 assert.equal((await callApi(handler,'bolt/stop',{})).code,200);assert.equal((await callApi(handler,'bolt/config',{...credentials,clientSecret:'replacement'})).code,200);assert.equal(reads,1);
});

test('Live Map preserves a report-certified provider UUID under its original provisional source key',async()=>{
 const {tables,fetchFn,requests}=mockLocal();let at=Date.parse('2026-11-03T00:00:00Z');
 const org='12345678-1234-4123-8123-123456789abc',provider='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',name='Synthetic Report Driver';
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 const batch=()=>({collectorId:'report-fixture',organizationId:org,observedAt:new Date(at).toISOString(),status:'observing',rows:[{sourceId:null,name,state:'on_trip',rawState:'On trip',readAt:new Date(at).toISOString()}]});
 try{
  assert.equal((await callApi(handler,'uber/ingest',batch())).code,200);
  assert.equal(tables.fleet_identities.length,1);const identity=tables.fleet_identities[0],driver=tables.fleet_drivers[0];
  assert.equal(identity.provisional,true);assert.equal(identity.source_key,sourceKey(org,null,name));
  // This is the exact two-column update performed by the SQL promotion, whose
  // eligibility/atomic replay are tested against PostgreSQL with rollback.
  Object.assign(identity,{external_id:provider,provisional:false});
  const expected=structuredClone(identity),requestOffset=requests.length;at+=15000;
  assert.equal((await callApi(handler,'uber/ingest',batch())).code,200);
  assert.equal(tables.fleet_drivers.length,1);assert.equal(tables.fleet_drivers[0].id,driver.id);assert.equal(tables.fleet_identities.length,1);assert.deepEqual(tables.fleet_identities[0],expected);
  assert.equal(tables.fleet_latest[0].identity_id,identity.id);assert.equal(tables.fleet_latest[0].driver_id,driver.id);assert.equal(tables.fleet_latest[0].status,'on_trip');
  assert.ok(!requests.slice(requestOffset).some(r=>r.table==='fleet_identities'&&r.method!=='GET'));
 }finally{handler.close();}
});

function mockLocal(){
 const tables={profiles:[{user_id:'admin-id',role:'admin'}],fleet_sources:['uber','bolt','geotab','myclicar'].map(id=>({id,name:id,status:'unconnected',stale_after_s:45,metadata:{},coverage:{}})),fleet_settings:[{id:1,enabled:true,offline_threshold_s:60,schedule:null}],fleet_drivers:[],fleet_identities:[],vehicles:[],fleet_latest:[],fleet_observations:[],fleet_alerts:[],fleet_source_events:[],alerts:[{id:'legacy-geotab'}]};let seq=0;const requests=[];
 const fetchFn=async(url,opt={})=>{
  const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421');
  if(u.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:'admin-id'}),{status:opt.headers.Authorization==='Bearer admin'?200:401});
  const table=u.pathname.split('/').pop(),items=tables[table];assert.ok(items,'known table '+table);
  requests.push({table,method:opt.method||'GET',authorization:opt.headers.Authorization});
  const matches=r=>[...u.searchParams].every(([k,v])=>!v.startsWith('eq.')||String(r[k])===v.slice(3));
  const method=opt.method||'GET';let result;
  if(method==='GET')result=items.filter(matches).slice(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('offset')||0)+Number(u.searchParams.get('limit')||100000));
  else if(method==='PATCH'){result=items.filter(matches);for(const r of result)Object.assign(r,JSON.parse(opt.body));}
  else if(method==='POST'){
    const body=JSON.parse(opt.body),rows=Array.isArray(body)?body:[body];result=[];
    for(const row of rows){const keys=(u.searchParams.get('on_conflict')||'').split(',').filter(Boolean),old=keys.length?items.find(r=>keys.every(k=>r[k]===row[k])):null;
      if(old){if(!opt.headers.Prefer?.includes('ignore-duplicates'))Object.assign(old,row);result.push(old);}
      else{const item={id:'test-'+(++seq),...(table==='fleet_alerts'?{status:'open'}:{}),...row};items.push(item);result.push(item);}}
  }else throw Error('unexpected method');
  return new Response(JSON.stringify(result),{status:200});
 };
 return{tables,fetchFn,requests};
}

test('automatic vehicle mode preserves a chosen person, releases a manual car and applies current plate evidence',async()=>{
 const local=mockLocal(),{tables}=local,at=Date.now();
 const id='12345678-1234-1234-1234-123456789abc',stamp=new Date(at).toISOString();
 Object.assign(tables,{drivers:[{code:'SYNTHETIC',name:'Synthetic Driver',agency_id:1}],fleet_myclicar_contracts:[],fleet_contract_assignment_overrides:[]});
 tables.vehicles.push({key:'CAR-NEW',plate:'TEST-NEW',agency_id:1,active:'OUI'});
 tables.fleet_drivers.push({id,name:'Synthetic Driver',ludy_driver_code:'SYNTHETIC',agency_id:1,link_method:'manual',auto_link_disabled:true,vehicle_key:'CAR-OLD',vehicle_link_method:'manual',vehicle_link_evidence:{assignment_conflict:{requires_confirmation:true}}});
 tables.fleet_identities.push({id:'identity',driver_id:id,source:'uber'});
 tables.fleet_latest.push({driver_id:id,source:'uber',status:'on_trip',observed_at:stamp,vehicle_label:'TEST-NEW',evidence:{method:'visible_dom',vehicle_status:'on_trip',vehicle_observed_at:stamp}});
 Object.assign(tables.fleet_sources[0],{status:'healthy',last_success_at:stamp});
 const rpc=[];let matchingFails=false;
 const fetchFn=async(url,opt={})=>{
   const name=new URL(url).pathname.split('/').at(-1);
   if(!new URL(url).pathname.includes('/rpc/'))return local.fetchFn(url,opt);
   rpc.push(name);const body=JSON.parse(opt.body),driver=tables.fleet_drivers[0];let result;
   if(name==='fleet_link_driver_automatic'){
     assert.equal(opt.headers.Authorization,'Bearer service');assert.equal(body.p_ludy_code,'SYNTHETIC');
     Object.assign(driver,{auto_link_disabled:false,vehicle_key:null,vehicle_link_method:null,vehicle_link_evidence:{}});result=id;
   }else if(name==='fleet_reconcile_vehicle_contracts'){
     if(matchingFails)return new Response('{}',{status:503});result=0;
   }else if(name==='fleet_auto_link_vehicle'){
     assert.equal(body.p_vehicle_key,'CAR-NEW');Object.assign(driver,{vehicle_key:body.p_vehicle_key,vehicle_link_method:'platform_plate',vehicle_link_evidence:body.p_evidence});result=true;
   }else throw Error('unexpected RPC '+name);
   return new Response(JSON.stringify(result),{status:200});
 };
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 const input={driver_id:id,ludy_driver_code:'SYNTHETIC',vehicle_mode:'automatic'};
 try{
   const response=await callApi(handler,'drivers/link',input);assert.equal(response.code,200);assert.equal(response.value.automatic,true);assert.equal(response.value.association_pending,false);
   const saved=response.value.drivers[0];assert.equal(saved.ludy_driver_code,'SYNTHETIC');assert.equal(saved.link_method,'manual');assert.equal(saved.auto_link_disabled,false);assert.equal(saved.vehicle_key,'CAR-NEW');assert.equal(saved.vehicle_link_method,'platform_plate');
   assert.equal((await callApi(handler,'drivers/link',{...input,vehicle_key:'FORCED-CAR'})).code,400);
   assert.equal((await callApi(handler,'drivers/link',{...input,vehicle_mode:'unknown'})).code,400);
   assert.equal((await callApi(handler,'drivers/link',{...input,ludy_driver_code:null})).code,400);
   const before=rpc.length;tables.profiles[0].role='viewer';assert.equal((await callApi(handler,'drivers/link',input)).code,403);assert.equal(rpc.length,before);tables.profiles[0].role='admin';
   matchingFails=true;const pending=await callApi(handler,'drivers/link',input);assert.equal(pending.code,200);assert.equal(pending.value.association_pending,true);assert.equal(pending.value.drivers[0].auto_link_disabled,false);assert.equal(pending.value.drivers[0].vehicle_key,null);
 }finally{handler.close();}
});
test('authenticated Uber observations persist idempotently; positive activity resolves duration alerts without touching Geotab',async()=>{
 const {tables,fetchFn}=mockLocal();let t=Date.parse('2026-10-30T12:00:00Z');
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>t});
 async function call(path,body,token='admin'){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/fleet/'+path,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4173',authorization:'Bearer '+token},socket:{remoteAddress:'127.0.0.1'}});
  let code,value;await handler(req,{writeHead:s=>{code=s;},end:s=>{value=JSON.parse(s);},setHeader:()=>{}});return{code,value};
 }
 const ingest=(state='offline',status='observing')=>call('uber/ingest',{collectorId:'screen',organizationId:'fleet-test',observedAt:new Date(t).toISOString(),status,rows:status==='observing'?[{sourceId:'driver-a',name:'Synthetic Driver',state,rawState:'fixture',readAt:new Date(t).toISOString()}]:[]});
 assert.equal((await ingest()).code,200);assert.equal(tables.fleet_observations.length,1);
 await ingest();assert.equal(tables.fleet_observations.length,1,'same observation is idempotent');
 t+=30000;await ingest();assert.equal(tables.fleet_alerts.length,0);
 t+=30000;await ingest();assert.equal(tables.fleet_alerts.length,1);assert.equal(tables.fleet_alerts[0].status,'open');
 t+=15000;await ingest('available');assert.equal(tables.fleet_alerts[0].status,'resolved');
 t+=15000;await ingest('available');assert.equal(tables.fleet_alerts[0].status,'resolved');
 assert.deepEqual(tables.alerts,[{id:'legacy-geotab'}]);
 t+=10000;await ingest('offline');
 t+=10000;await ingest('unknown','stopped');assert.equal(tables.fleet_sources[0].status,'paused');assert.equal(tables.fleet_latest[0].offline_samples,0);
 t+=10000;await ingest('offline');assert.equal(tables.fleet_latest[0].offline_since,new Date(t).toISOString());
 const paired=await call('pair',{});assert.equal(paired.code,200);assert.ok(paired.value.token);
 t+=2*3600000+1;
 const sustained=await call('uber/ingest',{collectorId:'screen',status:'observing',observedAt:new Date(t).toISOString(),rows:[]},paired.value.token);assert.equal(sustained.code,200);
 t+=31*86400000;const expired=await call('uber/ingest',{},paired.value.token);assert.equal(expired.code,401);
 handler.close();
});

async function callApi(handler,path,body,token='admin'){
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/fleet/'+path,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4173',authorization:'Bearer '+token},socket:{remoteAddress:'127.0.0.1'}});
 let code,value;await handler(req,{writeHead:s=>{code=s;},end:s=>{value=JSON.parse(s);},setHeader(){}});return {code,value};
}
function beginApi(handler,path,body){
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/fleet/'+path,method:'POST',headers:{host:'127.0.0.1:4173',authorization:'Bearer admin'},socket:{remoteAddress:'127.0.0.1'}});
 let resolveReply,code,ends=0;const response=new Promise(resolve=>{resolveReply=resolve;});
 const completed=handler(req,{writeHead:status=>{code=status;},end:json=>{ends++;resolveReply({code,value:JSON.parse(json)});},setHeader(){}});
 return {response,completed,get ends(){return ends;}};
}
test('Uber acknowledges durable observations while derived work retains the queue ahead of the next batch',{timeout:3000},async t=>{
 const local=mockLocal();let at=Date.parse('2026-11-05T12:00:00Z'),release;
 const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());let reconciliations=0;
 const fetchFn=async(url,options)=>{
  if(new URL(url).pathname.endsWith('/rpc/fleet_reconcile_vehicle_contracts')){if(++reconciliations===1)await gate;return Response.json({}, {status:503});}
  return local.fetchFn(url,options);
 };
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});t.after(()=>handler.close());
 const first=beginApi(handler,'uber/ingest',uberBatch(at,'offline')),accepted=await first.response;
 assert.equal(accepted.code,200);assert.equal(accepted.value.observations,1);assert.equal(first.ends,1);
 assert.equal(local.tables.fleet_latest.length,1);assert.equal(local.tables.fleet_sources[0].status,'healthy');
 at+=1000;const second=beginApi(handler,'uber/ingest',uberBatch(at,'available'));let secondAcknowledged=false;second.response.then(()=>{secondAcknowledged=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reconciliations,1);assert.equal(secondAcknowledged,false);assert.equal(local.tables.fleet_observations.length,1,'later observations cannot overtake pending alert processing');
 release();await first.completed;assert.equal((await second.response).code,200);await second.completed;
 assert.equal(first.ends,1);assert.equal(second.ends,1);assert.equal(local.tables.fleet_observations.length,2);assert.equal(local.tables.fleet_latest[0].status,'available');
});

for(const failure of ['fleet_observations','fleet_latest','health'])test('Uber does not acknowledge before '+failure+' is durable',async t=>{
 const local=mockLocal(),at=Date.parse('2026-11-05T12:00:00Z');let reconciliations=0;
 const fetchFn=async(url,options={})=>{
  const resource=new URL(url).pathname.split('/').at(-1);
  if(resource==='fleet_reconcile_vehicle_contracts')reconciliations++;
  if(options.method==='POST'&&resource===failure||failure==='health'&&resource==='fleet_sources'&&options.method==='PATCH'&&JSON.parse(options.body).status==='healthy')return Response.json({}, {status:503});
  return local.fetchFn(url,options);
 };
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});t.after(()=>handler.close());
 const request=beginApi(handler,'uber/ingest',uberBatch(at,'offline'));assert.equal((await request.response).code,502);await request.completed;
 assert.equal(request.ends,1);assert.equal(reconciliations,0);assert.equal(local.tables.fleet_sources[0].status,'error');
});

test('a failed derived alert calculation after Uber acknowledgement records degradation without a second response',async t=>{
 const local=mockLocal(),at=Date.parse('2026-11-05T12:00:00Z');
 const fetchFn=async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.includes('/rpc/')||path.endsWith('/fleet_settings'))return Response.json({}, {status:503});
  return local.fetchFn(url,options);
 };
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});t.after(()=>handler.close());
 const request=beginApi(handler,'uber/ingest',uberBatch(at,'offline'));assert.equal((await request.response).code,200);await request.completed;
 assert.equal(request.ends,1);assert.equal(local.tables.fleet_observations.length,1);assert.equal(local.tables.fleet_sources[0].status,'error');
 assert.match(local.tables.fleet_sources[0].last_error,/Observations Uber reçues.*traitement des alertes interrompu/);
 assert.equal(local.tables.fleet_latest[0].offline_samples,0,'failed alert processing remains conservative about continuity');
});
test('paired collection status is minimal, available in standby and rejects invalid or revoked pairing without provider calls',async()=>{
 const {tables,fetchFn,requests}=mockLocal();let active=false;
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,isCollectionActive:()=>active});
 try{
   const pair=await callApi(handler,'pair',{});assert.equal(pair.code,200);
   assert.equal((await callApi(handler,'uber/collection-status',undefined,'admin')).code,401,'an ordinary session token is not a pairing token');
   assert.equal((await callApi(handler,'uber/collection-status',undefined,'ludy_uber_'+'x'.repeat(43))).code,401);
   const start=requests.length;
   assert.deepEqual(await callApi(handler,'uber/collection-status',undefined,pair.value.token),{code:200,value:{active:false}});
   active=true;assert.deepEqual(await callApi(handler,'uber/collection-status',undefined,pair.value.token),{code:200,value:{active:true}});
   assert.ok(requests.slice(start).every(r=>r.table==='profiles'&&r.method==='GET'),'status never starts a provider or writes business data');
   tables.profiles[0].role='viewer';assert.equal((await callApi(handler,'uber/collection-status',undefined,pair.value.token)).code,403);
   tables.profiles[0].role='admin';assert.equal((await callApi(handler,'uber/collection-status',undefined,pair.value.token)).code,401,'revocation is permanent for this pairing');
 }finally{handler.close();}
 const staging=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn});
 try{const pair=await callApi(staging,'pair',{});assert.deepEqual((await callApi(staging,'uber/collection-status',undefined,pair.value.token)).value,{active:true});}finally{staging.close();}
});
function seedCanonical(tables,at){
 const stamp=offset=>new Date(at+offset).toISOString();
 tables.fleet_drivers.push({id:'canonical',name:'Synthetic Driver'});
 for(const source of ['uber','bolt']){
   Object.assign(tables.fleet_sources.find(s=>s.id===source),{status:'healthy',stale_after_s:180,last_success_at:stamp(0)});
   tables.fleet_identities.push({id:source+'-identity',driver_id:'canonical',source,source_key:'test:'+source+'-driver'});
   tables.fleet_latest.push({identity_id:source+'-identity',driver_id:'canonical',source,status:'offline',observed_at:stamp(-1000),offline_since:stamp(-300000),offline_samples:5,recovery_samples:0,evidence:{}});
 }
}
const uberBatch=(at,state,extra=[])=>({collectorId:'screen',organizationId:'test',observedAt:new Date(at).toISOString(),status:'observing',rows:[{sourceId:'uber-driver',name:'Synthetic Driver',state,readAt:new Date(at).toISOString()},...extra]});

test('overview includes the all-account activity verdict even when the visible provider row hides an older active account',async()=>{
 const {tables,fetchFn}=mockLocal(),at=Date.parse('2026-11-02T12:00:00Z');seedCanonical(tables,at);tables.fleet_identities=tables.fleet_identities.filter(row=>row.source==='uber');tables.fleet_latest=tables.fleet_latest.filter(row=>row.source==='uber');
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 try{
  let view=await callApi(handler,'overview');assert.equal(view.code,200);assert.equal(view.value.drivers[0].platform_activity.status,'offline');
  tables.fleet_identities.push({id:'second-uber',driver_id:'canonical',source:'uber'});tables.fleet_latest.push({...tables.fleet_latest[0],identity_id:'second-uber',status:'on_trip',observed_at:new Date(at-2000).toISOString(),offline_since:null});
  view=await callApi(handler,'overview');assert.equal(view.value.drivers[0].sources.uber.status,'offline');assert.equal(view.value.drivers[0].platform_activity.status,'online');
  tables.fleet_latest.pop();view=await callApi(handler,'overview');assert.equal(view.value.drivers[0].platform_activity.status,'unknown','an unobserved known account cannot be assumed offline');
 }finally{handler.close();}
});

test('viewer overview exposes a fresh unique vehicle observation using only authorized driver and vehicle reads',async()=>{
 const {tables,fetchFn,requests}=mockLocal(),at=Date.parse('2026-11-02T12:00:00Z'),stamp=new Date(at).toISOString();tables.profiles[0].role='viewer';
 tables.fleet_drivers.push({id:'unlinked',name:'Synthetic Driver',vehicle_key:null,ludy_driver_code:null});tables.vehicles.push({key:'car-one',plate:'86437-T-1',active:'OUI'});
 tables.fleet_identities.push({id:'uber-account',driver_id:'unlinked',source:'uber'});tables.fleet_latest.push({identity_id:'uber-account',driver_id:'unlinked',source:'uber',status:'on_trip',vehicle_label:'86437-T-1',observed_at:stamp,evidence:{method:'visible_dom',vehicle_status:'on_trip',vehicle_observed_at:stamp}});
 Object.assign(tables.fleet_sources[0],{status:'healthy',last_success_at:stamp});const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 try{
  const view=await callApi(handler,'overview');assert.equal(view.code,200);assert.deepEqual(view.value.vehicle_observations,[{vehicle_key:'car-one',driver_id:'unlinked',source:'uber',status:'on_trip',observed_at:stamp,expires_at:new Date(at+45000).toISOString()}]);assert.equal(tables.fleet_drivers[0].vehicle_key,null);assert.equal(tables.fleet_drivers[0].ludy_driver_code,null);
  assert.ok(requests.filter(row=>['fleet_drivers','fleet_latest','vehicles'].includes(row.table)).every(row=>row.authorization==='Bearer admin'));assert.ok(requests.every(row=>row.method==='GET'));
 }finally{handler.close();}
});

test('an Uber trip immediately hides and resolves a persisted Bolt offline duration alert using scoped identities',async()=>{
 const {tables,fetchFn,requests}=mockLocal();const at=Date.parse('2026-10-30T12:00:00Z');seedCanonical(tables,at);
 Object.assign(tables.fleet_latest.find(row=>row.source==='uber'),{status:'on_trip',offline_since:null,offline_samples:0});
 tables.fleet_alerts.push({id:'old-bolt-alert',driver_id:'canonical',identity_id:'bolt-identity',source:'bolt',status:'open',observed_since:new Date(at-300000).toISOString(),threshold_s:60});
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 try{
   const view=await callApi(handler,'overview');assert.equal(view.code,200);assert.equal(view.value.alerts[0].status,'resolved');
   assert.equal(tables.fleet_alerts[0].status,'open','overview does not mutate historical records');
   const identityReads=requests.filter(r=>r.table==='fleet_identities');assert.equal(identityReads.length,1);assert.equal(identityReads[0].authorization,'Bearer admin');
   assert.equal((await callApi(handler,'uber/ingest',uberBatch(at,'on_trip'))).code,200);
   assert.equal(tables.fleet_alerts[0].status,'resolved');assert.equal(tables.fleet_alerts.length,1);
 }finally{handler.close();}
});

test('duration threshold starts at the last platform going offline and creates a new episode after online activity',async()=>{
 const {tables,fetchFn}=mockLocal();let at=Date.parse('2026-10-30T12:00:00Z');const beginning=at;seedCanonical(tables,at);
 Object.assign(tables.fleet_latest.find(row=>row.source==='uber'),{status:'on_trip',offline_since:null,offline_samples:0});
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 const refreshBolt=()=>{Object.assign(tables.fleet_latest.find(row=>row.source==='bolt'),{observed_at:new Date(at).toISOString(),offline_samples:9});tables.fleet_sources.find(s=>s.id==='bolt').last_success_at=new Date(at).toISOString();};
 const ingest=async state=>{refreshBolt();const res=await callApi(handler,'uber/ingest',uberBatch(at,state));assert.equal(res.code,200);};
 try{
   await ingest('offline');assert.equal(tables.fleet_alerts.length,0);
   at+=30000;await ingest('offline');assert.equal(tables.fleet_alerts.length,0);
   at+=30000;await ingest('offline');assert.equal(tables.fleet_alerts.length,1);assert.equal(tables.fleet_alerts[0].observed_since,new Date(beginning).toISOString());assert.equal(tables.fleet_alerts[0].status,'open');
   at+=15000;await ingest('on_trip');assert.equal(tables.fleet_alerts[0].status,'resolved');
   at+=15000;const second=at;await ingest('offline');assert.equal(tables.fleet_alerts.length,1);
   at+=30000;await ingest('offline');assert.equal(tables.fleet_alerts.length,1);
   at+=30000;await ingest('offline');assert.equal(tables.fleet_alerts.length,2);assert.equal(tables.fleet_alerts[1].observed_since,new Date(second).toISOString());assert.equal(tables.fleet_alerts[1].status,'open');
 }finally{handler.close();}
});

test('a missing or stale known platform suspends duration alerts immediately and cannot create a new one',async()=>{
 for(const missing of [true,false]){
   const {tables,fetchFn}=mockLocal();const at=Date.parse('2026-10-30T12:00:00Z');seedCanonical(tables,at);
   if(missing)tables.fleet_latest=tables.fleet_latest.filter(row=>row.source!=='uber');else tables.fleet_latest.find(row=>row.source==='uber').observed_at=new Date(at-181000).toISOString();
   tables.fleet_alerts.push({id:'old-bolt-alert',driver_id:'canonical',identity_id:'bolt-identity',source:'bolt',status:'open',observed_since:new Date(at-300000).toISOString(),threshold_s:60});
   const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
   try{
     const view=await callApi(handler,'overview');assert.equal(view.code,200);assert.equal(view.value.alerts[0].status,'suspended');
     const empty={...uberBatch(at,'offline'),rows:[]};assert.equal((await callApi(handler,'uber/ingest',empty)).code,200);
     assert.equal(tables.fleet_alerts[0].status,'suspended');assert.equal(tables.fleet_alerts.length,1);
   }finally{handler.close();}
 }
});

test('duration decisions wait for every row in the batch before creating any alert',async()=>{
 const {tables,fetchFn,requests}=mockLocal();const at=Date.parse('2026-10-30T12:00:00Z');seedCanonical(tables,at);
 tables.fleet_identities.push({id:'uber-second',driver_id:'canonical',source:'uber',source_key:'test:second'});
 tables.fleet_latest.push({...tables.fleet_latest.find(row=>row.source==='uber'),identity_id:'uber-second'});
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 try{
   const batch=uberBatch(at,'offline',[{sourceId:'second',name:'Synthetic Driver',state:'on_trip',readAt:new Date(at).toISOString()}]);
   assert.equal((await callApi(handler,'uber/ingest',batch)).code,200);
   assert.equal(tables.fleet_alerts.length,0);assert.equal(requests.filter(r=>r.table==='fleet_alerts'&&r.method==='POST').length,0,'not even a transient false alert is inserted');
 }finally{handler.close();}
});
test('large extension payload is rejected before ingestion, invalid row returns 400',async()=>{
 const {tables,fetchFn}=mockLocal();const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn});
 async function send(buffer){const req=Readable.from([buffer]);Object.assign(req,{url:'/api/fleet/uber/ingest',method:'POST',headers:{host:'localhost:4173',authorization:'Bearer admin'},socket:{remoteAddress:'127.0.0.1'}});let code;await handler(req,{writeHead:s=>{code=s;},end:()=>{},setHeader:()=>{}});return code;}
 assert.equal(await send(Buffer.alloc(65537,'a')),413);
 assert.equal(await send(Buffer.from(JSON.stringify({status:'observing',collectorId:'x',observedAt:new Date().toISOString(),rows:[{name:'Test',state:'invented'}]}))),400);
 assert.equal(tables.fleet_observations.length,0);handler.close();
});
test('Uber collector ownership, stop ordering and takeover cannot fabricate uninterrupted offline time',async()=>{
 const {tables,fetchFn}=mockLocal();let t=Date.parse('2026-10-30T12:00:00Z');
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>t});
 async function ingest(collectorId,status='observing',observed=t){
   const body={collectorId,status,organizationId:'test',observedAt:new Date(observed).toISOString(),rows:status==='observing'?[{sourceId:'driver',name:'Test Driver',state:'offline',readAt:new Date(observed).toISOString()}]:[]};
   const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/fleet/uber/ingest',method:'POST',headers:{host:'127.0.0.1:4173',authorization:'Bearer admin'},socket:{remoteAddress:'127.0.0.1'}});let code,value;await handler(req,{writeHead:s=>{code=s;},end:s=>{value=JSON.parse(s);},setHeader(){}});return {code,value};
 }
 try{
   await ingest('one');t+=1000;assert.equal((await ingest('two')).code,409);assert.equal(tables.fleet_sources[0].metadata.collector_id,'one');
   t+=1000;await ingest('one','stopped');assert.equal(tables.fleet_sources[0].status,'paused');
   const stale=await ingest('one','observing',t-1000);assert.equal(stale.value.ignored,true);assert.equal(tables.fleet_sources[0].status,'paused');
   t+=1000;await ingest('two');assert.equal(tables.fleet_latest[0].offline_since,new Date(t).toISOString());
   t+=1000;const oldStop=await ingest('one','stopped');assert.equal(oldStop.value.ignored,true);assert.equal(tables.fleet_sources[0].status,'healthy');
   t+=46000;await ingest('three');assert.equal(tables.fleet_latest[0].offline_since,new Date(t).toISOString());assert.equal(tables.fleet_sources[0].metadata.collector_id,'three');
   await ingest('three','stopped');assert.equal(tables.fleet_sources[0].status,'paused','manual stop wins equal rounded browser timestamps');
   assert.equal((await ingest('three')).value.ignored,true);assert.equal(tables.fleet_sources[0].status,'paused');
 }finally{handler.close();}
});

test('a swept Uber list persists more than ten drivers at their actual read times and reports partial coverage without inventing offline rows',async()=>{
 const {tables,fetchFn}=mockLocal();let at=Date.parse('2026-10-30T12:00:00Z');
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 const rows=Array.from({length:25},(_,i)=>({sourceId:'sweep-'+i,name:'Synthetic Driver '+i,state:'available',rawState:'Pastille #545454',readAt:new Date(at-15000+i*500).toISOString()}));
 const batch={collectorId:'screen',organizationId:'test',observedAt:new Date(at).toISOString(),status:'observing',rows,coverage:{mode:'list_sweep',complete:true,observed:25,reason:'end_of_list'}};
 try{
  assert.equal((await callApi(handler,'uber/ingest',batch)).code,200);
  assert.equal(tables.fleet_latest.length,25);assert.equal(tables.fleet_latest[0].observed_at,rows[0].readAt);
  assert.equal(tables.fleet_sources[0].coverage.kind,'list_sweep');assert.equal(tables.fleet_sources[0].coverage.complete,true);
  at+=15000;const partial=rows.slice(0,12).map(r=>({...r,readAt:new Date(at).toISOString()}));
  assert.equal((await callApi(handler,'uber/ingest',{...batch,observedAt:new Date(at).toISOString(),rows:partial,coverage:{mode:'list_sweep',complete:false,observed:12,reason:'filtered_view'}})).code,200);
  assert.equal(tables.fleet_sources[0].coverage.complete,false);assert.equal(tables.fleet_latest.length,25);
  assert.equal(tables.fleet_latest[24].observed_at,rows[24].readAt);assert.ok(tables.fleet_latest.every(r=>r.status==='available'));
 }finally{handler.close();}
});

test('Uber plaque, model and detail timestamp survive ingestion and remain distinct from platform status time',async()=>{
 const {tables,fetchFn}=mockLocal();const at=Date.parse('2026-10-30T12:00:00Z');
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,now:()=>at});
 try{
  const batch=uberBatch(at,'on_trip');Object.assign(batch.rows[0],{vehicleLabel:'86121-T-1',vehicleModel:'2026 Hyundai Staria',vehicleReadAt:new Date(at-60000).toISOString(),vehicleState:'available'});
  batch.coverage={mode:'list_sweep',observed:1,complete:true,vehicleObserved:1,vehicleComplete:true};
  assert.equal((await callApi(handler,'uber/ingest',batch)).code,200);
  const row=tables.fleet_latest[0];assert.equal(row.vehicle_label,'86121-T-1');assert.equal(row.evidence.vehicle_model,'2026 Hyundai Staria');assert.equal(row.evidence.vehicle_observed_at,batch.rows[0].vehicleReadAt);assert.equal(row.observed_at,new Date(at).toISOString());assert.equal(row.evidence.vehicle_status,'available');
  const overview=await callApi(handler,'overview');assert.equal(overview.code,200);assert.equal(overview.value.drivers[0].vehicle_model,'2026 Hyundai Staria');assert.equal(tables.fleet_sources.find(s=>s.id==='uber').coverage.vehicleObserved,1);
 }finally{handler.close();}
});
