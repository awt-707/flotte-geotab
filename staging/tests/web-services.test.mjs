import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createWebServices} from '../web-runtime/services.mjs';

const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic'};
const admin='11111111-1111-4111-8111-111111111111',manager='22222222-2222-4222-8222-222222222222',viewer='33333333-3333-4333-8333-333333333333';
const jwt=id=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,role:'authenticated',exp:2000000000})).toString('base64url')+'.signature';
async function fixture(t,{factories={},maxStacks}={}){
 const stateDir=await realpath(await mkdtemp(path.join(os.tmpdir(),'ludy-web-services-')));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const calls=[],roles=new Map([[admin,'admin'],[manager,'manager'],[viewer,'viewer']]);
 const fetchFn=async(input,options={})=>{
  const url=new URL(input),headers=new Headers(options.headers),token=headers.get('authorization')?.slice(7),userId=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).sub;
  const body=options.body?JSON.parse(options.body):null,resource=url.pathname.split('/').at(-1);calls.push({resource,userId,method:options.method||'GET',body});
  if(url.pathname==='/auth/v1/user')return Response.json({id:userId});
  if(resource==='profiles')return Response.json([{user_id:userId,role:roles.get(userId)}]);
  if(resource==='desktop_worker_register')return Response.json({device:{id:body.p_device_id,enabled:body.p_enabled}});
  if(resource==='desktop_admin_request'||resource==='desktop_manager_request')return Response.json({status:204,body:null,headers:{}});
  if(resource==='desktop_worker_request')return Response.json({status:200,body:[],headers:{}});
  if(resource==='fleet_source_health')return Response.json([{id:'geotab',name:'Geotab',status:'healthy',last_success_at:new Date(1800000000000).toISOString(),stale_after_s:180}]);
  if(resource==='agencies')return Response.json([{id:1,city:'Casablanca',name:'Synthetic'}]);
  if(resource==='user_agencies')return Response.json([{agency_id:1,user_id:userId}]);
  return Response.json([]);
 };
 const services=await createWebServices({config,stateDir,runtimeRoot:stateDir,fetchFn,now:()=>1800000000000,factories,maxStacks});t.after(()=>services.close());
 async function call(url,{user=viewer,body,method=body===undefined?'GET':'POST',host='127.0.0.1:4173',origin='http://127.0.0.1:4173'}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method,headers:{host,origin,authorization:'Bearer '+jwt(user)},socket:{remoteAddress:'127.0.0.1'}});
  let code,value;const handled=await services.handle(req,{writeHead(status){code=status;},end(data){value=JSON.parse(data);},setHeader(){}});return {handled,code,value};
 }
 return {services,call,calls,roles};
}

test('web shared maps and alerts reuse existing scoped handlers without starting or registering a collector',async t=>{
 const f=await fixture(t);
 for(const endpoint of ['health','geotab/live','alerts','disconnections']){const result=await f.call('/api/fleet/'+endpoint);assert.equal(result.code,200,endpoint);}
 assert.ok(f.calls.some(call=>call.resource==='fleet_source_health'));
 assert.ok(!f.calls.some(call=>/^desktop_(worker|admin|manager)_/.test(call.resource)));
 assert.equal(f.calls.filter(call=>call.resource==='user').length,4,'each HTTP request freshly verifies Auth once');
 assert.equal(f.calls.filter(call=>call.resource==='profiles').length,4,'handler auth checks reuse only the current request');
});

test('web preserves manual administrator and manager edits under their own RPC context',async t=>{
 const f=await fixture(t);
 const saved=await f.call('/api/fleet/settings',{user:admin,body:{enabled:true,offline_threshold_s:300,schedule:null}});assert.equal(saved.code,200);
 const rush=await f.call('/api/operations/rush',{user:manager,body:{agency_id:1,city:'Casablanca',days:[1],start:'08:00',end:'09:00',enabled:true,label:'Synthetic'}});assert.equal(rush.code,200);
 assert.equal(f.calls.find(call=>call.resource==='desktop_admin_request').userId,admin);
 assert.equal(f.calls.find(call=>call.resource==='desktop_manager_request').userId,manager);
 assert.ok(f.calls.filter(call=>call.resource==='desktop_worker_register').every(call=>call.body.p_enabled===false));
 const denied=await f.call('/api/fleet/settings',{user:viewer,body:{enabled:true,offline_threshold_s:300}});assert.equal(denied.code,403);
 assert.equal(f.calls.filter(call=>call.resource==='desktop_admin_request').length,1);
});

test('all provider, bridge, credential and desktop routes are rejected before a handler or RPC can act',async t=>{
 const f=await fixture(t);
 const cases=[['POST','/api/desktop/participation'],['POST','/api/fleet/geotab/start'],['POST','/api/fleet/geotab/connect'],['POST','/api/fleet/geotab/link'],['GET','/api/fleet/geotab/detail'],['GET','/api/fleet/geotab/history'],['GET','/api/fleet/geotab/report'],['POST','/api/fleet/bolt/config'],['POST','/api/fleet/uber/ingest'],['GET','/api/fleet/uber/collection-status'],['POST','/api/fleet/pair'],['POST','/api/fleet/drivers/match'],['GET','/api/uber-reports/bridge/config'],['GET','/api/uber-reports/browser/config'],['POST','/api/driver-performance/sync'],['POST','/api/provider-earnings/uber'],['POST','/api/operations/fuel/calibrate'],['GET','/api/parking/geotab'],['GET','/api/fleet/texat/status'],['GET','/api/unknown']];
 for(const [method,url]of cases){const response=await f.call(url,{user:admin,method,...(method==='POST'?{body:{enabled:true}}:{})});assert.equal(response.code,409,url);assert.match(response.value.error,/poste collecteur/);}
 assert.equal(f.calls.length,0);
});

test('web services still require the HTTP boundary to normalize a validated origin',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call('/api/fleet/health',{host:'public.example.invalid'})).code,403);
 assert.equal((await f.call('/api/fleet/health',{origin:'https://untrusted.example.invalid'})).code,403);
 assert.equal(f.calls.length,0);
});

test('service instances are separated by user and fresh role, and never call collector lifecycle methods',async t=>{
 const created=[],closed=[];
 const fleet=options=>{
  assert.equal(options.sharedCollection,true);assert.equal(options.isCollectionActive(),false);
  assert.equal(options.Geotab().start,undefined);assert.equal(options.Myclicar().start,undefined);
  const id=created.length;created.push(id);
  const handler=async(req,res)=>{res.writeHead(200);res.end(JSON.stringify({id}));return true;};
  handler.resume=()=>{throw Error('must never resume');};handler.start=()=>{throw Error('must never start');};handler.close=()=>{closed.push(id);};return handler;
 };
 const f=await fixture(t,{factories:{fleet},maxStacks:2});
 const first=await f.call('/api/fleet/health',{user:admin}),other=await f.call('/api/fleet/health',{user:manager});
 assert.notEqual(first.value.id,other.value.id);assert.equal((await f.call('/api/fleet/health',{user:admin})).value.id,first.value.id);
 f.roles.set(admin,'viewer');const changed=await f.call('/api/fleet/health',{user:admin});assert.notEqual(changed.value.id,first.value.id);
 f.roles.set(admin,'pending');assert.equal((await f.call('/api/fleet/health',{user:admin})).code,403);
 await f.services.close();assert.equal(new Set(closed).size,created.length);
});
