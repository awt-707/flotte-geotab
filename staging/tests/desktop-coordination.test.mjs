import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopCoordinator} from '../desktop-runtime/coordinator.mjs';
import {createDesktopSession} from '../desktop-runtime/session.mjs';
import {createDesktopTransport,createDesktopRpc,isTransientDesktopError} from '../desktop-runtime/transport.mjs';
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
    return {device:{id,owner:true,enabled:devices.get(id)||false},lease:lease?{scope:'workspace',fence:lease.fence,expires_at:new Date(Date.now()+90000).toISOString(),owned:lease.id===id}:null};
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

function clock(){
  let time=Date.now(),sequence=0;const timers=new Map();
  return {now:()=>time,setTimer:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:time+delay});return id;},clearTimer:id=>timers.delete(id),
    advance:ms=>{time+=ms;},timers,fire:id=>{const timer=timers.get(id);assert.ok(timer);timers.delete(id);timer.fn();}};
}
test('temporary renewal errors retain only the already confirmed fence and original deadline',async t=>{
  for(const error of [Object.assign(Error(),{status:408}),Object.assign(Error(),{status:429}),Object.assign(Error(),{status:502}),Object.assign(Error(),{status:503}),Object.assign(Error(),{status:504}),Object.assign(Error(),{status:500,code:'57014'}),Object.assign(Error(),{name:'TimeoutError'}),Object.assign(Error(),{code:'DESKTOP_NETWORK_UNAVAILABLE'})]){
    await t.test(String(error.status||error.code||error.name),async()=>{
      const timer=clock();let failRenewal=false,started=0,stopped=0;
      const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...timer,
        rpc:async name=>{if(name==='desktop_worker_renew'&&failRenewal)throw error;
          return {lease:{fence:7,expires_at:new Date(timer.now()+90000).toISOString(),owned:true}};},
        onLeader:async()=>started++,onLost:async()=>stopped++});
      await c.register(true);const initial=c.status(),deadline=[...timer.timers].find(([,v])=>v.at===timer.now()+70000);
      stopped=0;timer.advance(25000);failRenewal=true;await c.tick();
      assert.deepEqual(c.status(),initial);assert.equal(started,1);assert.equal(stopped,0);
      assert.deepEqual(timer.timers.get(deadline[0]),deadline[1],'renewal failure does not replace or extend deadline');
      timer.advance(45000);timer.fire(deadline[0]);
      assert.equal(c.status().state,'unavailable');assert.equal(c.status().lease,null);assert.equal(stopped,1);
      await c.close();
    });
  }
});
test('authorization, lost fence, unknown and non-owned renewal responses stop immediately',async t=>{
  for(const [label,outcome]of [['401',{status:401}],['403',{status:403}],['permission despite 503',{status:503,code:'42501'}],['lost fence despite 503',{status:503,code:'55000'}],['unknown',{}],['non-owned',null]]){
    await t.test(label,async()=>{
      let failing=false,stops=0;const timer=clock();
      const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...timer,rpc:async name=>{
        if(name==='desktop_worker_renew'&&failing){if(outcome===null)return {lease:{owned:false}};throw Object.assign(Error(),outcome);}
        return {lease:{fence:1,expires_at:new Date(timer.now()+90000).toISOString(),owned:true}};
      },onLost:async()=>stops++});
      await c.register(true);stops=0;failing=true;await c.tick();
      assert.equal(c.status().lease,null);assert.notEqual(c.status().state,'leader');assert.equal(stops,1);await c.close();
    });
  }
});
test('an explicitly transient claim failure never starts an unconfirmed collector',async()=>{
  let starts=0;const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...clock(),onLeader:async()=>starts++,
    rpc:async name=>{if(name==='desktop_worker_claim')throw Object.assign(Error(),{status:503});return {};}});
  await c.register(true);assert.equal(starts,0);assert.equal(c.status().state,'unavailable');assert.equal(c.status().lease,null);await c.close();
});
test('temporary observer registration retries without starting a collector and is cancelled by suspend or close',async()=>{
  let broken=true,registered=0,starts=0;const timer=clock();
  const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...timer,onLeader:async()=>starts++,rpc:async(name,args)=>{
    assert.equal(name,'desktop_worker_register');assert.equal(args.p_enabled,false);registered++;
    if(broken)throw Object.assign(Error(),{status:503});return {device:{id:'A',owner:true,enabled:false}};
  }});
  await c.restore(false);assert.equal(c.status().state,'unavailable');assert.equal(timer.timers.size,1);
  await c.pause();assert.equal(timer.timers.size,0);await c.tick();assert.equal(registered,1);
  broken=false;await c.resume();assert.equal(registered,2);assert.equal(c.status().state,'paused');assert.equal(starts,0);assert.equal(timer.timers.size,0);
  broken=true;await c.restore(false);assert.equal(timer.timers.size,1);await c.close();assert.equal(timer.timers.size,0);await c.tick();assert.equal(registered,3);
});
test('restoring an enabled preference only reads server approval, never re-enables a disabled device',async()=>{
  let broken=true,serverEnabled=true,starts=0;const calls=[],registered=[],timer=clock();
  const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...timer,onRegistered:async enabled=>registered.push(enabled),onLeader:async()=>starts++,rpc:async name=>{
    calls.push(name);assert.notEqual(name,'desktop_worker_register');
    if(name==='desktop_worker_status'){if(broken)throw Object.assign(Error(),{status:503});return {device:{id:'A',owner:true,enabled:serverEnabled}};}
    return {lease:{fence:4,expires_at:new Date(timer.now()+90000).toISOString(),owned:true}};
  }});
  await c.restore(true);assert.equal(starts,0);broken=false;serverEnabled=false;await c.tick();
  assert.deepEqual(registered,[false]);assert.equal(starts,0);assert.equal(timer.timers.size,0);assert.equal(c.status().state,'paused');
  serverEnabled=true;await c.tick();assert.equal(calls.length,2,'server re-enable alone does not undo a confirmed local disable');await c.close();
});
test('a transient startup status failure resumes an approved collector and terminal errors are not retried',async()=>{
  let broken=true,starts=0;const timer=clock(),calls=[];
  const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...timer,onLeader:async()=>starts++,rpc:async name=>{
    calls.push(name);if(name==='desktop_worker_status'){if(broken)throw Object.assign(Error(),{status:503});return {device:{id:'A',owner:true,enabled:true}};}
    return {lease:{fence:8,expires_at:new Date(timer.now()+90000).toISOString(),owned:true}};
  }});
  await c.restore(true);broken=false;await c.tick();assert.equal(starts,1);assert.equal(c.status().lease.fence,8);
  assert.deepEqual(calls,['desktop_worker_status','desktop_worker_status','desktop_worker_claim']);await c.close();
  let attempts=0;const terminal=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...clock(),rpc:async()=>{attempts++;throw Object.assign(Error(),{status:403});}});
  await terminal.restore(true);await terminal.tick();assert.equal(attempts,1);await terminal.close();
});
test('a pending startup status cannot restore work after close',async()=>{
  const pending=deferred(),entered=deferred();let starts=0,signal;
  const c=createDesktopCoordinator({deviceId:'A',getSession:()=>session,...clock(),onLeader:async()=>starts++,rpc:async(name,args,options)=>{
    assert.equal(name,'desktop_worker_status');signal=options.signal;entered.resolve();return pending.promise;
  }});
  const restoring=c.restore(true);await entered.promise;const closing=c.close();assert.equal(signal.aborted,true);
  pending.resolve({device:{id:'A',owner:true,enabled:true}});await Promise.all([restoring,closing]);
  assert.equal(starts,0);assert.equal(c.status().state,'paused');
});
test('RPC classifies known network failures while preserving unknown errors and cancellation',async()=>{
  const errors=[Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}}),new TypeError('programming error'),new DOMException('cancelled','AbortError')];
  for(const [index,error]of errors.entries()){
    const rpc=createDesktopRpc({config,getSession:()=>session,fetchFn:async()=>{throw error;}});
    await assert.rejects(rpc('desktop_worker_status',{}),actual=>{assert.equal(isTransientDesktopError(actual),index===0);if(index)assert.equal(actual,error);return true;});
  }
});
test('RPC retains temporary body-read failures but invalid JSON never grants renewal grace',async()=>{
  for(const error of [new DOMException('body timed out','TimeoutError'),Object.assign(new TypeError('terminated'),{cause:{code:'UND_ERR_SOCKET'}})]){
    const rpc=createDesktopRpc({config,getSession:()=>session,fetchFn:async()=>({ok:true,json:async()=>{throw error;}})});
    await assert.rejects(rpc('desktop_worker_renew',{}),actual=>isTransientDesktopError(actual));
  }
  for(const status of [401,403]){
    const rpc=createDesktopRpc({config,getSession:()=>session,fetchFn:async()=>({ok:false,status,json:async()=>{throw new DOMException('body timed out','TimeoutError');}})});
    await assert.rejects(rpc('desktop_worker_renew',{}),actual=>actual.status===status&&!isTransientDesktopError(actual));
  }
  const timer=clock();let invalid=false,stops=0;
  const rpc=createDesktopRpc({config,getSession:()=>session,fetchFn:async()=>invalid?new Response('invalid JSON'):
    response({lease:{fence:1,expires_at:new Date(timer.now()+90000).toISOString(),owned:true}})});
  const c=createDesktopCoordinator({rpc,deviceId:'A',getSession:()=>session,...timer,onLost:async()=>stops++});
  await c.register(true);stops=0;invalid=true;await c.tick();assert.equal(stops,1);assert.notEqual(c.status().state,'leader');assert.equal(c.status().lease,null);await c.close();
});
