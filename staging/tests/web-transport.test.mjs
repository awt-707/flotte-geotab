import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWebTransport} from '../web-runtime/transport.mjs';
import {withDesktopAdminRequest} from '../desktop-runtime/admin-context.mjs';

const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic'};
const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',manager:'33333333-3333-4333-8333-333333333333',viewer:'44444444-4444-4444-8444-444444444444'};
const jwt=(id,exp=2000000000)=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,role:'authenticated',exp})).toString('base64url')+'.signature';
async function setup(t){
 const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'ludy-web-transport-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[],roles=new Map([[ids.a,'admin'],[ids.b,'admin'],[ids.manager,'manager'],[ids.viewer,'viewer']]);let before=async()=>{};
 const fetchFn=async(input,options={})=>{
  const url=new URL(input),headers=new Headers(options.headers),token=headers.get('authorization')?.slice(7),userId=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).sub;
  const body=options.body?JSON.parse(options.body):null,call={path:url.pathname,params:Object.fromEntries(url.searchParams),method:options.method||'GET',body,token,userId,signal:options.signal};calls.push(call);await before(call);
  if(url.pathname==='/auth/v1/user')return Response.json({id:userId});
  if(url.pathname==='/rest/v1/profiles')return Response.json(roles.has(userId)?[{user_id:userId,role:roles.get(userId)}]:[]);
  if(url.pathname==='/rest/v1/rpc/desktop_worker_register')return Response.json({device:{id:body.p_device_id,enabled:body.p_enabled}});
  if(url.pathname==='/rest/v1/rpc/desktop_worker_request')return Response.json({status:200,body:[{userId,resource:body.p_resource}],headers:{}});
  if(url.pathname==='/rest/v1/rpc/desktop_admin_request'||url.pathname==='/rest/v1/rpc/desktop_manager_request')return Response.json({status:204,body:null,headers:{}});
  if(url.pathname==='/rest/v1/rpc/fleet_source_health')return Response.json(['uber','geotab'].map(id=>({id,name:id,status:'healthy',last_success_at:'2026-11-05T12:00:00Z',last_error:null,stale_after_s:180,motion_error:false})));
  return Response.json([{userId}]);
 };
 const transport=await createWebTransport({config,stateDir:directory,fetchFn,now:()=>1800000000000});t.after(()=>transport.close());
 const session=id=>transport.authenticate(jwt(id));
 const internal=(table,method='GET',body)=>transport.fetchFn(config.supabaseUrl+'/rest/v1/'+table,{method,headers:{Authorization:'Bearer '+transport.serviceKey},...(body?{body:JSON.stringify(body)}:{})});
 return {directory,calls,roles,fetchFn,transport,session,internal,setBefore:fn=>{before=fn;}};
}

test('concurrent web administrators retain their own token and disabled observer through interleaved RPCs',async t=>{
 const f=await setup(t),[a,b]=await Promise.all([f.session(ids.a),f.session(ids.b)]);let release,started;
 const blocked=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 f.setBefore(async call=>{if(call.userId===ids.a&&call.path.endsWith('/desktop_worker_register')){started();await gate;}});
 const one=f.transport.run(a,async()=>await(await f.internal('fleet_sources')).json());await blocked;
 const two=await f.transport.run(b,async()=>await(await f.internal('fleet_sources')).json());release();const first=await one;
 assert.equal(first[0].userId,ids.a);assert.equal(two[0].userId,ids.b);
 const registrations=f.calls.filter(call=>call.path.endsWith('/desktop_worker_register'));assert.equal(registrations.length,2);
 assert.ok(registrations.every(call=>call.body.p_enabled===false));assert.notEqual(registrations[0].body.p_device_id,registrations[1].body.p_device_id);
 for(const call of f.calls.filter(call=>call.path.endsWith('/desktop_worker_request'))){const owner=registrations.find(row=>row.body.p_device_id===call.body.p_device_id);assert.equal(owner.userId,call.userId);assert.equal(call.body.p_fence,null);assert.equal(call.body.p_method,'GET');}
 const refreshed=await f.session(ids.a);await f.transport.run(refreshed,()=>f.internal('vehicles'));
 assert.equal(f.calls.filter(call=>call.path.endsWith('/desktop_worker_register')).length,2,'registration is not repeated by polling');
 const stored=JSON.parse(await readFile(path.join(f.directory,'users',ids.a,'web-observer.json'),'utf8'));
 assert.deepEqual(Object.keys(stored).sort(),['deviceId','userId','version']);assert.equal(stored.userId,ids.a);
 assert.ok(!JSON.stringify(stored).includes(a.token));
});

test('manual admin and manager mutations retain existing RPC permissions without acquiring a collector lease',async t=>{
 const f=await setup(t),admin=await f.session(ids.a),manager=await f.session(ids.manager);
 await f.transport.run(admin,()=>withDesktopAdminRequest({url:'/api/fleet/settings',method:'POST'},admin,()=>f.internal('fleet_settings','PATCH',{enabled:true})));
 await f.transport.run(manager,()=>withDesktopAdminRequest({url:'/api/operations/rush',method:'POST'},manager,()=>f.internal('ops_rush_rules','POST',{label:'Synthetic'})));
 const adminCall=f.calls.find(call=>call.path.endsWith('/desktop_admin_request')),managerCall=f.calls.find(call=>call.path.endsWith('/desktop_manager_request'));
 assert.equal(adminCall.userId,ids.a);assert.equal(managerCall.userId,ids.manager);assert.ok(!Object.hasOwn(managerCall.body,'p_device_id'));
 await assert.rejects(f.transport.run(manager,()=>f.internal('fleet_settings','PATCH',{enabled:false})),{status:403});
 assert.ok(f.calls.every(call=>!/(claim|renew|release|set_enabled)$/.test(call.path)));
 assert.equal(f.calls.filter(call=>call.path.endsWith('/desktop_worker_register')).length,1);
});

test('closed, forged, foreign-token and expired request scopes cannot reuse a previous user or reach provider URLs',async t=>{
 const f=await setup(t),a=await f.session(ids.a);let later;
 await f.transport.run(a,async()=>{
  later=()=>f.internal('vehicles');
  await assert.rejects(f.transport.fetchFn('https://provider.example.invalid/data',{headers:{Authorization:'Bearer '+f.transport.serviceKey}}),{status:403});
  await assert.rejects(f.transport.fetchFn(config.supabaseUrl+'/rest/v1/vehicles',{headers:{Authorization:'Bearer '+jwt(ids.b)}}),{status:401});
  await assert.rejects(f.transport.fetchFn(config.supabaseUrl+'/rest/v1/rpc/desktop_worker_claim',{method:'POST',headers:{Authorization:'Bearer '+a.token},body:'{}'}),{status:403});
  await assert.rejects(f.internal('fleet_latest','POST',{status:'offline'}),{status:409});
 });
 await assert.rejects(later(),{status:401});await assert.rejects(f.transport.run({...a},async()=>{}),{status:401});
 await assert.rejects(f.transport.authenticate(jwt(ids.a,1)),{status:401});
 assert.equal(f.calls.filter(call=>call.path.includes('/rpc/desktop_')).length,0);
});

test('auth and current role are checked per HTTP request while repeated handler auth reads stay within that request',async t=>{
 const f=await setup(t),viewer=await f.session(ids.viewer),before=f.calls.length;
 await f.transport.run(viewer,async()=>{
  const headers={Authorization:'Bearer '+viewer.token};
  assert.equal((await(await f.transport.fetchFn(config.supabaseUrl+'/auth/v1/user',{headers})).json()).id,ids.viewer);
  assert.equal((await(await f.transport.fetchFn(config.supabaseUrl+'/rest/v1/profiles?select=role&user_id=eq.'+ids.viewer,{headers})).json())[0].role,'viewer');
 });
 assert.equal(f.calls.length,before);
 f.roles.set(ids.viewer,'pending');await assert.rejects(f.session(ids.viewer),{status:403});f.roles.delete(ids.viewer);await assert.rejects(f.session(ids.viewer),{status:403});
});

test('non-admin internal source reads use only the health projection, preserving fields and source filters',async t=>{
 const f=await setup(t),viewer=await f.session(ids.viewer);
 const rows=await f.transport.run(viewer,async()=>await(await f.internal('fleet_sources?select=id,status&order=id&id=eq.geotab&offset=0&limit=1000')).json());
 assert.deepEqual(rows,[{id:'geotab',status:'healthy'}]);
 assert.ok(!f.calls.some(call=>call.path.endsWith('/fleet_sources')||call.path.includes('/rpc/desktop_')));
 assert.equal(f.calls.find(call=>call.path.endsWith('/fleet_source_health')).userId,ids.viewer);
});

test('observer identifiers survive restart but are unique to this web installation, and registration failures can retry',async t=>{
 const f=await setup(t),a=await f.session(ids.a);let failOnce=true;
 f.setBefore(async call=>{if(failOnce&&call.path.endsWith('/desktop_worker_register')){failOnce=false;throw Object.assign(Error('Synthetic outage'),{code:'ETIMEDOUT'});}});
 await assert.rejects(f.transport.run(a,()=>f.internal('fleet_sources')));await f.transport.run(a,()=>f.internal('fleet_sources'));
 const id=f.calls.find(call=>call.path.endsWith('/desktop_worker_register')).body.p_device_id;f.transport.close();
 const next=await createWebTransport({config,stateDir:f.directory,fetchFn:f.fetchFn,now:()=>1800000000000});t.after(()=>next.close());
 const verified=await next.authenticate(jwt(ids.a));await next.run(verified,()=>next.fetchFn(config.supabaseUrl+'/rest/v1/fleet_sources',{headers:{Authorization:'Bearer '+next.serviceKey}}));
 assert.equal(f.calls.filter(call=>call.path.endsWith('/desktop_worker_register')).at(-1).body.p_device_id,id);
 const separate=await setup(t),other=await separate.session(ids.a);await separate.transport.run(other,()=>separate.internal('fleet_sources'));
 assert.notEqual(separate.calls.find(call=>call.path.endsWith('/desktop_worker_register')).body.p_device_id,id,'a different web installation never reuses this device');
});

test('same-admin concurrent registration is coalesced and an aborted first request cannot poison later registration',async t=>{
 const f=await setup(t),a=await f.session(ids.a),controller=new AbortController();let started;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.setBefore(async call=>{if(call.path.endsWith('/desktop_worker_register')){started();await new Promise((resolve,reject)=>{call.signal.addEventListener('abort',()=>reject(new DOMException('Synthetic aborted request','AbortError')),{once:true});});}});
 const one=f.transport.run(a,()=>f.internal('fleet_sources'),{signal:controller.signal});await waiting;
 const two=f.transport.run(a,()=>f.internal('vehicles'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.filter(call=>call.path.endsWith('/desktop_worker_register')).length,1);
 controller.abort();const outcomes=await Promise.allSettled([one,two]);assert.ok(outcomes.every(result=>result.status==='rejected'));
 f.setBefore(async()=>{});await f.transport.run(await f.session(ids.a),()=>f.internal('fleet_sources'));
 const registrations=f.calls.filter(call=>call.path.endsWith('/desktop_worker_register'));assert.equal(registrations.length,2);assert.ok(registrations.every(call=>call.body.p_enabled===false));
 assert.equal(registrations[0].body.p_device_id,registrations[1].body.p_device_id);
});
