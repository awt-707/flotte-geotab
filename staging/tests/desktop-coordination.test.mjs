import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopCoordinator} from '../desktop-runtime/coordinator.mjs';
import {createDesktopSession} from '../desktop-runtime/session.mjs';
import {createDesktopTransport,createDesktopRpc} from '../desktop-runtime/transport.mjs';
import {createDesktopDatabaseTarget,resolveBackendTarget} from '../server/database-target.mjs';
const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst'};
const userId='10000000-0000-4000-8000-000000000001';
const session={userId,role:'admin',token:'user-access'};
const jwt=(id=userId,role='authenticated')=>['e30',Buffer.from(JSON.stringify({sub:id,role,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'signature'].join('.');
const response=x=>new Response(JSON.stringify(x));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('default database policy remains loopback only; production capability is bound to one origin',()=>{
  assert.throws(()=>resolveBackendTarget(config.supabaseUrl));
  assert.throws(()=>resolveBackendTarget(config.supabaseUrl,{origin:config.supabaseUrl}));
  const capability=createDesktopDatabaseTarget(config);assert.equal(resolveBackendTarget(config.supabaseUrl,capability),config.supabaseUrl);
  assert.throws(()=>resolveBackendTarget('https://anotherproject.supabase.co',capability));
  assert.equal(resolveBackendTarget('http://127.0.0.1:57421'),'http://127.0.0.1:57421');
});
test('late Auth result cannot restore a logged-out session',async()=>{
  const pending=deferred();let calls=0;
  const auth=createDesktopSession({config,fetchFn:async()=>++calls===1?pending.promise:response([{role:'admin'}])});
  const signing=auth.authenticate(jwt());auth.clear();pending.resolve(response({id:userId}));
  await assert.rejects(signing,{status:409});assert.equal(auth.current(),null);
});
test('Auth verifies user and profile remotely and refuses service role tokens',async()=>{
  let calls=0;const auth=createDesktopSession({config,fetchFn:async()=>response(++calls===1?{id:userId}:[{role:'manager'}])});
  assert.equal((await auth.authenticate(jwt())).role,'manager');auth.clear();
  await assert.rejects(auth.authenticate(jwt(userId,'service_role')),{status:401});assert.equal(calls,2);
});
test('internal writes carry the fixed fence, preserve repeated filters, and never send internal credential',async()=>{
  const calls=[],controller=new AbortController();
  const rpc=createDesktopRpc({config,getSession:()=>session,fetchFn:async(url,options)=>{calls.push({url,options});return response({status:200,body:[{id:1}],headers:{'content-range':'0-0/1'}});}});
  const transport=createDesktopTransport({config,deviceId:userId,getSession:()=>session,rpc,fence:7,signal:controller.signal,fetchFn:()=>assert.fail('direct network forbidden')});
  const result=await transport.fetchFn(config.supabaseUrl+'/rest/v1/telemetry_observations?observed_at=gte.2026-01-01&observed_at=lt.2026-02-01',{headers:{Authorization:'Bearer '+transport.serviceKey}});
  assert.deepEqual(await result.json(),[{id:1}]);assert.equal(result.headers.get('content-range'),'0-0/1');
  const args=JSON.parse(calls[0].options.body);assert.equal(args.p_fence,7);assert.deepEqual(args.p_params.observed_at,['gte.2026-01-01','lt.2026-02-01']);
  assert.equal(calls[0].options.headers.Authorization,'Bearer user-access');assert.ok(!JSON.stringify(calls).includes(transport.serviceKey));
  controller.abort();await assert.rejects(transport.fetchFn(config.supabaseUrl+'/rest/v1/fleet_sources',{method:'PATCH',headers:{Authorization:'Bearer '+transport.serviceKey},body:'{}'}),{status:409});assert.equal(calls.length,1);
});
test('standby denies provider traffic and internal writes; user JWT reads preserve RLS',async()=>{
  const calls=[];const t=createDesktopTransport({config,deviceId:userId,getSession:()=>session,rpc:()=>assert.fail('gateway must not run'),fetchFn:async(url,options)=>{calls.push({url,options});return response([]);}});
  await assert.rejects(t.fetchFn('https://provider.invalid/api'),{status:409});
  await assert.rejects(t.fetchFn(config.supabaseUrl+'/rest/v1/fleet_sources',{method:'POST',headers:{authorization:'Bearer '+t.serviceKey},body:'{}'}),{status:409});
  await t.fetchFn(config.supabaseUrl+'/rest/v1/vehicles',{headers:{authorization:'Bearer real-user'}});
  assert.equal(calls[0].options.headers.get('authorization'),'Bearer real-user');assert.equal(calls.length,1);
});
function controlPlane(){
  let lease=null,sequence=0;const devices=new Map();
  return async(name,args)=>{
    const id=args.p_device_id;
    if(name==='desktop_worker_register')devices.set(id,args.p_enabled);
    if(name==='desktop_worker_release'){if(lease?.id===id&&lease.fence===args.p_fence)lease=null;return {released:true};}
    if(name==='desktop_worker_claim'&&devices.get(id)&&!lease)lease={id,fence:++sequence};
    return {lease:lease?{scope:'workspace',fence:lease.fence,expires_at:new Date(Date.now()+90000).toISOString(),owned:lease.id===id}:null};
  };
}
test('two simulated PCs elect one collector and transfer ownership on explicit release',async()=>{
  const rpc=controlPlane(),active=new Set(),timers=[];
  const make=id=>createDesktopCoordinator({rpc,deviceId:id,getSession:()=>session,onLeader:async()=>{active.add(id);assert.equal(active.size,1);},onLost:async()=>active.delete(id),setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});
  const a=make('A'),b=make('B');await a.register(true);await b.register(true);
  assert.equal(a.status().state,'leader');assert.equal(b.status().state,'follower');assert.deepEqual([...active],['A']);
  await a.pause();await b.tick();assert.equal(b.status().state,'leader');assert.deepEqual([...active],['B']);
  await b.close();assert.equal(active.size,0);
});
test('pending claim is invalidated by sleep, never starts a collector, and gets released',async()=>{
  const pending=deferred();let claims=0,started=0,releases=0;
  const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,rpc:async name=>{
    if(name==='desktop_worker_claim'){claims++;return pending.promise;}if(name==='desktop_worker_release'){releases++;return{};}return{};
  },onLeader:async()=>started++,setTimer:()=>1,clearTimer:()=>{}});
  const registering=c.register(true);while(!claims)await new Promise(r=>setImmediate(r));
  const pausing=c.pause();pending.resolve({lease:{scope:'workspace',fence:1,expires_at:new Date(Date.now()+90000).toISOString(),owned:true}});
  await Promise.all([registering,pausing]);assert.equal(started,0);assert.equal(releases,1);await c.close();
});
test('failed renewal stops collection immediately instead of waiting for TTL',async()=>{
  let broken=false,stops=0;
  const rpc=controlPlane();const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,rpc:(...a)=>{if(broken)throw Error('offline');return rpc(...a);},onLost:async()=>stops++,setTimer:()=>1,clearTimer:()=>{}});
  await c.register(true);assert.equal(c.status().state,'leader');broken=true;await c.tick();assert.equal(c.status().state,'unavailable');assert.ok(stops>=1);await c.close();
});
test('a registration completing after suspend stays paused until explicit resume',async()=>{
  const pending=deferred(),entered=deferred();let claims=0,started=0;
  const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,rpc:async name=>{
    if(name==='desktop_worker_register'){entered.resolve();return pending.promise;}
    if(name==='desktop_worker_claim'){claims++;return {lease:{scope:'workspace',fence:1,expires_at:new Date(Date.now()+90000).toISOString(),owned:true}};}
    return {};
  },onLeader:async()=>started++,setTimer:()=>1,clearTimer:()=>{}});
  const registering=c.register(true);await entered.promise;
  await c.pause();pending.resolve({});await registering;
  assert.equal(claims,0);assert.equal(started,0);assert.equal(c.status().state,'paused');
  await c.resume();assert.equal(claims,1);assert.equal(started,1);await c.close();
});
