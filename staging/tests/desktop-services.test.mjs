import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import http from 'node:http';
import {createDesktopServices} from '../desktop-runtime/services.mjs';
import {createDesktopCoordinator} from '../desktop-runtime/coordinator.mjs';
import {createFleetApi} from '../server/fleet.mjs';
const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst'};
const id='10000000-0000-4000-8000-000000000001';
const tokenExpiry=Math.floor(Date.now()/1000)+3600;
const token=(uid=id)=>['e30',Buffer.from(JSON.stringify({sub:uid,role:'authenticated',exp:tokenExpiry})).toString('base64url'),'signature'].join('.');
async function setup(t,{role='admin',stackFactory,browserFactory=null,authenticationFailure=null,rpcFailure=null,coordinatorOptions={}}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'ludy-desktop-services-'));let lease=false,fence=0,deviceEnabled=false;const requests=[],stacks=[],coordinators=[];
  const fetchFn=async(url,opts={})=>{
    requests.push({url,opts});
    if(authenticationFailure&&(authenticationFailure.endpoint==='auth'?url.endsWith('/auth/v1/user'):url.includes('/rest/v1/profiles?'))){
      return Response.json({error:'private upstream detail '+token()},{status:authenticationFailure.status});
    }
    if(url.endsWith('/auth/v1/user'))return Response.json({id});
    if(url.includes('/rest/v1/profiles?'))return Response.json([{role}]);
    const name=url.split('/').at(-1),args=JSON.parse(opts.body);
    const fault=rpcFailure?.(name,args);if(fault)return Response.json({code:fault.code},{status:fault.status});
    if(name==='desktop_worker_register'){lease=false;deviceEnabled=args.p_enabled;}
    if(name==='desktop_worker_release'){lease=false;return Response.json({released:true});}
    if(name==='desktop_worker_claim'){lease=true;fence++;}
    return Response.json({device:{id:args.p_device_id,owner:true,enabled:deviceEnabled},lease:lease?{scope:'workspace',fence,expires_at:new Date(Date.now()+90000).toISOString(),owned:true}:null});
  };
  const services=await createDesktopServices({config,stateDir:directory,runtimeRoot:directory,fetchFn,browserFactory,
    coordinatorFactory:options=>{const c=createDesktopCoordinator({...options,...coordinatorOptions});coordinators.push(c);return c;},
    stackFactory:stackFactory|| (async options=>{const s={options,started:false,closed:false,handle:async()=>false,start:async()=>{s.started=true;},close:async()=>{s.closed=true;}};stacks.push(s);return s;})});
  t.after(async()=>{await services.close();await rm(directory,{recursive:true,force:true});});
  const call=async(route,{body={},access=token(),method='POST'}={})=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:'/api/desktop/'+route,headers:{authorization:'Bearer '+access}});
    let status,data;const res={headersSent:false,writeHead(s){status=s;this.headersSent=true;},end(x){data=JSON.parse(x);}};
    await services.handle(req,res);return{status,data};
  };
  return {services,call,directory,requests,stacks,coordinators,setDeviceEnabled:value=>{deviceEnabled=value;if(!value)lease=false;}};
}
test('the desktop session HTTP handler preserves retryable upstream failures and terminal refusals without leaking details',async t=>{
  for(const [endpoint,status,expected] of [['auth',408,503],['profile',429,503],['auth',503,503],['profile',502,503],['auth',401,401],['profile',403,403]]){
    await t.test(`${endpoint} ${status}`,async t=>{
      const {services,call,stacks}=await setup(t,{authenticationFailure:{endpoint,status}});
      const result=await call('session');
      assert.equal(result.status,expected);
      assert.deepEqual(result.data,{error:expected===503?'Vérification de la session Ludy momentanément indisponible.':expected===403?'Accès Ludy refusé.':'Session Ludy expirée ou invalide.'});
      assert.equal(services.status().role,null);assert.equal(stacks.length,0);
      assert.ok(!JSON.stringify(result.data).includes(token()));
    });
  }
});
test('sign-in creates only a reader, explicit participation starts one isolated collector, logout stops it',async t=>{
  const {services,call,stacks,directory}=await setup(t);
  await services.setSession(token());assert.equal(services.status().participationEnabled,false);assert.equal(stacks.length,1);assert.equal(stacks[0].started,false);
  const enabled=await call('participation',{body:{enabled:true}});assert.equal(enabled.status,200);assert.equal(services.status().coordinator.state,'leader');
  assert.equal(stacks[0].closed,true);assert.equal(stacks.at(-1).started,true);
  const privateText=await readFile(path.join(directory,'users',id,'desktop.json'),'utf8');assert.ok(!privateText.includes(token()));
  await call('logout');assert.equal(stacks.at(-1).closed,true);assert.equal(services.status().role,null);
  const denied=await call('status',{method:'GET'});assert.equal(denied.status,401);
});
test('viewer can read but cannot enable collection or register a privileged device',async t=>{
  const {services,call,requests,stacks}=await setup(t,{role:'manager'});
  await services.setSession(token());const denied=await call('participation',{body:{enabled:true}});
  assert.equal(denied.status,403);assert.equal(stacks[0].started,false);assert.ok(requests.every(x=>!x.url.includes('desktop_worker_register')));
});
test('sleep aborts in-flight generation and resume constructs a fresh fenced stack',async t=>{
  const {services,call,stacks}=await setup(t);await services.setSession(token());await call('participation',{body:{enabled:true}});
  const leader=stacks.at(-1);await services.pause();assert.equal(leader.closed,true);assert.equal(services.status().coordinator.state,'paused');
  await services.resume();assert.notEqual(stacks.at(-1),leader);assert.equal(stacks.at(-1).started,true);
  await assert.rejects(leader.options.transport.fetchFn('https://provider.invalid/api'),{status:409});
});
test('runtime never writes the access token or any service key to persisted preferences',async t=>{
  const {services,directory}=await setup(t);await services.setSession(token());
  const files=await readdir(path.join(directory,'users',id));assert.deepEqual(files,['desktop.json']);
  const data=JSON.parse(await readFile(path.join(directory,'users',id,'desktop.json'),'utf8'));assert.deepEqual(Object.keys(data).sort(),['deviceId','enabled','version']);
});
test('a browser created after sleep is closed without starting or replacing the current browser',async t=>{
  let finishFactory,enteredFactory;
  const ready=new Promise(resolve=>{enteredFactory=resolve;}),pending=new Promise(resolve=>{finishFactory=resolve;});
  const browser={started:0,closed:0,start:async()=>{browser.started++;},close:async()=>{browser.closed++;},status:()=>({state:'browser-active'})};
  const {services,call,stacks}=await setup(t,{browserFactory:async()=>{enteredFactory();return pending;}});
  await services.setSession(token());
  const enabling=call('participation',{body:{enabled:true}});await ready;
  const pausing=services.pause();
  finishFactory(browser);await Promise.all([enabling,pausing]);
  assert.equal(browser.started,0);assert.equal(browser.closed,1);
  assert.equal(stacks.at(-1).closed,true);assert.equal(services.status().uber.state,'stopped');
  assert.equal(services.status().coordinator.state,'paused');
});

test('an observer recovers temporary registration failure without resetting its session or reader',async t=>{
  let broken=true;
  const {services,stacks,coordinators,requests}=await setup(t,{rpcFailure:name=>name==='desktop_worker_register'&&broken?{status:503}:null});
  await services.setSession(token());const reader=stacks[0],coordinator=coordinators[0];
  assert.equal(services.status().role,'admin');assert.equal(services.status().coordinator.state,'unavailable');assert.equal(reader.started,false);
  await services.setSession(token());assert.equal(coordinators.length,1);assert.equal(stacks.length,1);assert.equal(reader.closed,false);
  broken=false;await coordinator.tick();
  assert.equal(services.status().coordinator.state,'paused');assert.equal(services.status().error,null);
  assert.equal(stacks[0],reader);assert.equal(reader.closed,false);assert.equal(reader.started,false);
  const registration=requests.filter(r=>r.url.endsWith('/desktop_worker_register'));
  assert.equal(registration.length,2);assert.ok(registration.every(r=>JSON.parse(r.opts.body).p_enabled===false));
});
test('an approved collector recovers startup status timeout without replaying activation',async t=>{
  let broken=false;
  const {services,call,stacks,coordinators,requests}=await setup(t,{rpcFailure:name=>name==='desktop_worker_status'&&broken?{status:504}:null});
  await services.setSession(token());await call('participation',{body:{enabled:true}});await call('logout');
  broken=true;const before=requests.length;await services.setSession(token());const reader=stacks.at(-1);
  assert.equal(reader.started,false);assert.equal(services.status().participationEnabled,true);assert.equal(services.status().coordinator.state,'unavailable');
  await services.setSession(token());assert.equal(coordinators.length,2);assert.equal(reader.closed,false);
  broken=false;await coordinators.at(-1).tick();
  assert.equal(services.status().coordinator.state,'leader');assert.equal(services.status().error,null);assert.equal(stacks.at(-1).started,true);
  assert.ok(requests.slice(before).every(r=>!r.url.endsWith('/desktop_worker_register')));
});
test('a centrally disabled collector remains disabled at subsequent login and persists the server decision',async t=>{
  const {services,call,directory,requests,stacks,setDeviceEnabled}=await setup(t);
  await services.setSession(token());await call('participation',{body:{enabled:true}});await call('logout');
  setDeviceEnabled(false);const before=requests.length;await services.setSession(token());
  assert.equal(services.status().participationEnabled,false);assert.equal(services.status().coordinator.state,'paused');assert.equal(stacks.at(-1).started,false);
  assert.ok(requests.slice(before).every(r=>!r.url.endsWith('/desktop_worker_register')));
  const stored=JSON.parse(await readFile(path.join(directory,'users',id,'desktop.json'),'utf8'));assert.equal(stored.enabled,false);
});
test('an explicit activation timeout is not retried automatically or persisted as enabled',async t=>{
  const {services,call,requests,coordinators,directory}=await setup(t,{rpcFailure:(name,args)=>name==='desktop_worker_register'&&args.p_enabled?{status:503}:null});
  await services.setSession(token());assert.equal((await call('participation',{body:{enabled:true}})).status,503);
  const before=requests.length;await coordinators[0].tick();await services.setSession(token());
  assert.equal(services.status().participationEnabled,false);assert.notEqual(services.status().coordinator.state,'leader');
  assert.ok(requests.slice(before).every(r=>!r.url.endsWith('/desktop_worker_register')));
  assert.equal(JSON.parse(await readFile(path.join(directory,'users',id,'desktop.json'),'utf8')).enabled,false);
});
test('logout cancels observer registration retries even when the former coordinator is ticked again',async t=>{
  const {services,call,coordinators,requests}=await setup(t,{rpcFailure:name=>name==='desktop_worker_register'?{status:503}:null});
  await services.setSession(token());const former=coordinators[0];await call('logout');const before=requests.length;
  await former.tick();assert.equal(requests.length,before);assert.equal(services.status().role,null);
});

test('paired HTTP status passes CORS in standby, requires pairing and keeps 409 and logout 401 visible to the extension',async t=>{
 const {services,call,requests}=await setup(t,{stackFactory:async options=>{
   const fleet=createFleetApi({supabaseUrl:config.supabaseUrl,databaseTarget:options.databaseTarget,anonKey:config.publishableKey,...options.transport,
     isCollectionActive:options.isCollectionActive,uberPairingPath:path.join(options.stateDir,'uber-pairing.json')});
   return {handle:fleet,start:async()=>{},close:()=>fleet.close()};
 }});
 await services.setSession(token());
 const server=http.createServer((req,res)=>{void services.handle(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin='chrome-extension://fixture-extension',base='http://127.0.0.1:'+server.address().port;
 const send=(pathname,{method='GET',access=token(),origin:requestOrigin=origin,body}={})=>new Promise((resolve,reject)=>{
   const request=http.request(base+'/api/fleet/'+pathname,{method,headers:{Host:'127.0.0.1:4173',Origin:requestOrigin,Authorization:'Bearer '+access,'Content-Type':'application/json'}},response=>{
     const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(response.statusCode===204?null:Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
   });request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
 });
 const pairResponse=await send('pair',{method:'POST',origin:'http://127.0.0.1:4173',body:{}});assert.equal(pairResponse.status,200,await pairResponse.clone().text());const pair=(await pairResponse.json()).token;
 let response=await send('uber/collection-status',{method:'OPTIONS',access:''});assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);
 response=await send('uber/collection-status',{access:'ludy_uber_'+'x'.repeat(43)});assert.equal(response.status,401);assert.equal(response.headers.get('access-control-allow-origin'),origin);
 response=await send('uber/collection-status',{access:pair});assert.equal(response.status,200);assert.deepEqual(await response.json(),{active:false});
 response=await send('uber/collection-status',{access:pair,origin:'https://untrusted.invalid'});assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
 response=await send('uber/ingest',{method:'POST',access:pair,body:{}});assert.equal(response.status,409);assert.equal(response.headers.get('access-control-allow-origin'),origin);
 await call('participation',{body:{enabled:true}});response=await send('uber/collection-status',{access:pair});assert.equal(response.status,200);assert.deepEqual(await response.json(),{active:true});
 await services.pause();response=await send('uber/collection-status',{access:pair});assert.equal(response.status,200);assert.deepEqual(await response.json(),{active:false});
 await call('logout');response=await send('uber/collection-status',{access:pair});assert.equal(response.status,401);assert.equal(response.headers.get('access-control-allow-origin'),origin);
 assert.ok(requests.every(r=>r.url.startsWith(config.supabaseUrl+'/')),'no provider request is performed');
});
