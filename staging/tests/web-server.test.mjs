import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,realpath,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createWebHttpServer,startWebServer,WEB_BIND_HOST,WEB_BIND_PORT} from '../web-runtime/server.mjs';
import {validateWebConfig} from '../web-runtime/config.mjs';

const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_fixture',webOrigin:'https://ludy.example.test'};
const host=new URL(config.webOrigin).host;
const authorization='Bearer SYNTHETIC_USER_A';

async function fixture(t,{handle,servicesAvailable=true}={}){
  // Canonicalize Windows TEMP aliases without weakening the runtime's paths.
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ludy-web-http-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'site'));await mkdir(path.join(root,'node_modules'));
  await writeFile(path.join(root,'site/index.html'),'<!doctype html><h1>Ludy web fixture</h1>');
  await writeFile(path.join(root,'site/app.js'),'window.webFixture=true;');
  await writeFile(path.join(root,'site/spreadsheet-worker.js'),'self.onmessage=()=>{};');
  await mkdir(path.join(root,'private'));await writeFile(path.join(root,'private/session.json'),'PRIVATE_SESSION_FIXTURE');
  const calls=[];
  const services={async handle(req,res){
    calls.push({url:req.url,headers:{...req.headers}});
    if(handle)return handle(req,res);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));return true;
  }};
  const server=createWebHttpServer({config,runtimeRoot:root,instanceId:'web-fixture-instance',services:servicesAvailable?services:null});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const port=server.address().port;
  function request(url,options={}){
    return new Promise((resolve,reject)=>{
      const headers=options.rawHeaders||{Host:host,...(options.body===undefined?{}:{'Content-Length':Buffer.byteLength(options.body)}),...options.headers};
      const req=http.request({hostname:'127.0.0.1',port,path:url,method:options.method||'GET',headers,agent:false},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
        res.on('error',reject);
      });req.on('error',reject);req.end(options.body);
    });
  }
  return {root,request,calls,port};
}

test('web publishes only the public project configuration and distinct browser auth storage',async t=>{
  const f=await fixture(t),response=await f.request('/config.js'),context={window:{}};
  assert.equal(response.status,200);vm.runInNewContext(response.body,context);
  const value=context.window.FLOTTE_CONFIG;
  assert.equal(value.WEB_PRODUCTION,true);assert.equal(value.DESKTOP_PRODUCTION,false);assert.equal(value.STAGING,false);
  assert.equal(value.WEB_ORIGIN,config.webOrigin);assert.equal(value.SUPABASE_URL,config.supabaseUrl);assert.equal(value.SUPABASE_ANON_KEY,config.publishableKey);
  assert.equal(value.AUTH_STORAGE_KEY,`ludy-web-production-${config.projectRef}-auth`);assert.ok(Object.isFrozen(value));
  assert.doesNotMatch(response.body,/PRIVATE_SESSION|service_role|serviceKey|access_token|refresh_token/);
  assert.deepEqual(JSON.parse((await f.request('/health')).body),{environment:'production',mode:'web',projectRef:config.projectRef,instanceId:'web-fixture-instance'});
  assert.equal((await f.request('/health',{method:'HEAD'})).body,'');assert.equal(f.calls.length,0);
});

test('web entry page excludes desktop authentication and collector lifecycle scripts',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'site/index.html'),'<script src="desktop-auth.js"></script>\n<script src="desktop-worker.js"></script>\n<script src="app.js"></script>');
  for(const route of ['/','/index.html']){
    const response=await f.request(route);
    assert.equal(response.status,200);
    assert.doesNotMatch(response.body,/desktop-(?:auth|worker)\.js/);
    assert.match(response.body,/<script src="app\.js"><\/script>/);
  }
});

test('web config rejects privileged keys, unexpected fields, and nonexact HTTPS origins before startup',()=>{
  const jwt=claims=>['header',Buffer.from(JSON.stringify(claims)).toString('base64url'),'signature'].join('.');
  const invalid=[{environment:'staging'},{supabaseUrl:'https://another.supabase.co'},{publishableKey:'sb_secret_synthetic_fixture'},
    {publishableKey:jwt({role:'service_role',ref:config.projectRef})},{serviceKey:'PRIVATE'},
    ...['http://ludy.example.test','https://ludy.example.test/','https://ludy.example.test/path','https://ludy.example.test?x=1','https://ludy.example.test#fragment','https://user:pass@ludy.example.test'].map(webOrigin=>({webOrigin}))];
  for(const extra of invalid)assert.throws(()=>validateWebConfig({...config,...extra}));
  assert.throws(()=>createWebHttpServer({config:{...config,serviceKey:'PRIVATE'},runtimeRoot:'/not-used'}));
});

test('web enforces exact external Host and only permits the narrow loopback health probe',async t=>{
  const f=await fixture(t);
  for(const wrong of ['outside.example',host+'.',host+':443','localhost:'+f.port,'127.0.0.1:'+f.port]){
    assert.equal((await f.request('/',{headers:{Host:wrong}})).status,403,wrong);
    assert.equal((await f.request('/api/fleet/overview',{headers:{Host:wrong,Authorization:authorization}})).status,403,wrong);
  }
  const local={Host:'127.0.0.1:'+f.port};
  assert.equal((await f.request('/health',{headers:local})).status,200);
  assert.equal((await f.request('/health',{method:'HEAD',headers:local})).status,200);
  assert.equal((await f.request('/health',{headers:{...local,Origin:config.webOrigin}})).status,403);
  assert.equal((await f.request('/health',{method:'POST',headers:local})).status,403);
  assert.equal((await f.request('/health/private',{headers:local})).status,403);
  assert.equal((await f.request('https://outside.example/api/fleet/overview',{headers:{Authorization:authorization}})).status,400);
  assert.equal((await f.request('//outside.example/api/fleet/overview',{headers:{Authorization:authorization}})).status,400);
  assert.equal(f.calls.length,0);
});

test('web rejects cross-origin and cross-site reads before calling any service',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:'https://outside.example'},{Origin:'null'},{Origin:''},{Origin:config.webOrigin+'/'},{'Sec-Fetch-Site':'cross-site'}]){
    assert.equal((await f.request('/api/fleet/overview',{headers:{Authorization:authorization,...headers}})).status,403);
    assert.equal((await f.request('/config.js',{headers})).status,403);
  }
  assert.equal(f.calls.length,0);
  for(const headers of [{},{Origin:config.webOrigin},{'Sec-Fetch-Site':'same-origin'}])
    assert.equal((await f.request('/api/fleet/overview',{headers:{Authorization:authorization,...headers}})).status,200);
  assert.equal(f.calls.length,3);
});

test('duplicate security-sensitive raw headers are refused even when their values agree',async t=>{
  const f=await fixture(t);
  for(const [key,value] of [['Host',host],['Authorization',authorization],['Origin',config.webOrigin],['Content-Type','application/json']]){
    const raw=['Host',host,'Authorization',authorization,'Origin',config.webOrigin,'Content-Type','application/json',key.toLowerCase(),value];
    assert.equal((await f.request('/api/fleet/overview',{rawHeaders:raw})).status,403,key);
  }
  assert.equal(f.calls.length,0);
});

test('API requests require a bearer token on every request and expose no desktop lifecycle route',async t=>{
  const f=await fixture(t);
  for(const token of [undefined,'','Basic SYNTHETIC','Bearer','Bearer A B','Bearer A,B']){
    const headers=token===undefined?{}:{Authorization:token};
    assert.equal((await f.request('/api/fleet/overview',{headers})).status,401);
  }
  for(const route of ['/api/desktop','/api/desktop/status','/api/desktop/session','/api/desktop/participation','/api/desktop/logout'])
    assert.equal((await f.request(route,{headers:{Authorization:authorization}})).status,404,route);
  assert.equal(f.calls.length,0);
  assert.equal((await f.request('/api/fleet/overview',{headers:{Authorization:authorization}})).status,200);
  assert.equal((await f.request('/api/fleet/overview')).status,401);
  assert.equal(f.calls.length,1);
});

test('mutations require the exact HTTPS Origin and JSON, and preserve the original request stream',async t=>{
  const received=[];
  const f=await fixture(t,{handle:async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    received.push({method:req.method,body,headers:{...req.headers}});res.end('{"ok":true}');return true;
  }});
  const body=JSON.stringify({name:'Synthetic manual edit'}),base={Authorization:authorization};
  for(const headers of [base,{...base,'Content-Type':'application/json'},{...base,Origin:config.webOrigin},
    {...base,Origin:config.webOrigin,'Content-Type':'text/plain'}, {...base,Origin:config.webOrigin,'Content-Type':'application/jsonp'},
    {...base,Origin:'https://outside.example','Content-Type':'application/json'}])
    assert.equal((await f.request('/api/operations/events/manual',{method:'POST',headers,body})).status,403);
  assert.equal(f.calls.length,0);
  for(const method of ['POST','PATCH','DELETE'])assert.equal((await f.request('/api/operations/events/manual',{method,headers:{...base,Origin:config.webOrigin,'Content-Type':'application/json; charset=utf-8'},body})).status,200);
  assert.equal(received.length,3);
  for(const item of received){assert.equal(item.body,body);assert.equal(item.headers.authorization,authorization);assert.equal(item.headers.host,'127.0.0.1:4173');assert.equal(item.headers.origin,'http://127.0.0.1:4173');}
});

test('proxy headers cannot override HTTP trust or impersonate the user forwarded to handlers',async t=>{
  const f=await fixture(t),spoofed={'X-Forwarded-Host':host,'X-Forwarded-Proto':'https','X-Forwarded-For':'127.0.0.1',Forwarded:'host='+host,'Tailscale-User-Login':'SYNTHETIC_OTHER_USER'};
  assert.equal((await f.request('/api/fleet/overview',{headers:{Host:'outside.example',Authorization:authorization,...spoofed}})).status,403);
  assert.equal((await f.request('/api/fleet/overview',{headers:{Authorization:authorization,...spoofed}})).status,200);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].headers.authorization,authorization);
  for(const name of Object.keys(f.calls[0].headers))assert.ok(!name.startsWith('x-forwarded-')&&!name.startsWith('tailscale-')&&name!=='forwarded',name);
});

test('overlapping web requests retain separate bearer headers while another request finishes',async t=>{
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{handle:async(req,res)=>{
    if(req.headers.authorization===authorization){entered();await gate;}
    res.end(JSON.stringify({authorization:req.headers.authorization,host:req.headers.host}));return true;
  }});
  t.after(()=>release());
  const pending=f.request('/api/fleet/overview',{headers:{Authorization:authorization}});
  await ready;
  const second=await f.request('/api/fleet/overview',{headers:{Authorization:'Bearer SYNTHETIC_USER_B'}});
  assert.equal(JSON.parse(second.body).authorization,'Bearer SYNTHETIC_USER_B');
  release();const first=await pending;assert.equal(JSON.parse(first.body).authorization,authorization);
  assert.equal(f.calls.length,2);
});

test('web static files stay inside the site and approved vendor files, including through symlinks',async t=>{
  const f=await fixture(t);
  await symlink(path.join(f.root,'private'),path.join(f.root,'site/escape'),process.platform==='win32'?'junction':'dir');
  await mkdir(path.join(f.root,'node_modules/leaflet/dist'),{recursive:true});
  await writeFile(path.join(f.root,'node_modules/leaflet/dist/leaflet.js'),'window.leafletFixture=true;');
  await writeFile(path.join(f.root,'node_modules/leaflet/package.json'),'PRIVATE_PACKAGE_FIXTURE');
  assert.equal((await f.request('/')).status,200);assert.equal((await f.request('/app.js')).status,200);
  assert.equal((await f.request('/vendor/leaflet.js')).status,200);
  for(const route of ['/private/session.json','/escape/session.json','/%2e%2e/private/session.json','/%2e%2e%2fprivate/session.json','/.local/session.json','/node_modules/leaflet/package.json','/vendor/leaflet/package.json','/vendor/../private/session.json','/web-runtime/server.mjs','/a%5c..%5cprivate/session.json']){
    const response=await f.request(route);assert.equal(response.status,404,route);assert.doesNotMatch(response.body,/PRIVATE_/);
  }
  assert.equal((await f.request('/%zz')).status,400);assert.equal((await f.request('/%00')).status,400);
  assert.equal((await f.request('/app.js',{method:'POST'})).status,405);
  assert.equal((await f.request('/app.js',{method:'HEAD'})).body,'');assert.equal(f.calls.length,0);
});

test('web responses set browser isolation headers and a narrowly scoped spreadsheet worker policy',async t=>{
  const f=await fixture(t),page=await f.request('/');
  assert.equal(page.headers['x-content-type-options'],'nosniff');assert.equal(page.headers['referrer-policy'],'no-referrer');assert.equal(page.headers['x-frame-options'],'DENY');
  assert.equal(page.headers['cache-control'],'no-store');
  const policy=page.headers['content-security-policy'];
  assert.match(policy,/frame-ancestors 'none'/);assert.match(policy,/object-src 'none'/);assert.match(policy,/base-uri 'self'/);
  assert.ok(policy.includes(config.supabaseUrl));assert.ok(policy.includes(config.supabaseUrl.replace('https:','wss:')));
  assert.doesNotMatch(policy,/unsafe-eval|script-src[^;]*unsafe-inline|connect-src[^;]*\*/);
  const worker=await f.request('/spreadsheet-worker.js');assert.match(worker.headers['content-security-policy'],/connect-src 'none'/);
});

test('unavailable, unknown, and failing APIs return bounded errors without internal details',async t=>{
  const unavailable=await fixture(t,{servicesAvailable:false}),unknown=await fixture(t,{handle:async()=>false}),broken=await fixture(t,{handle:async()=>{throw Error('PRIVATE_INTERNAL_FIXTURE');}});
  const headers={Authorization:authorization};
  assert.equal((await unavailable.request('/api/fleet/overview',{headers})).status,503);
  assert.equal((await unknown.request('/api/unknown',{headers})).status,404);
  const failure=await broken.request('/api/fleet/overview',{headers});assert.equal(failure.status,500);assert.doesNotMatch(failure.body,/PRIVATE_INTERNAL|Error:|stack/);
});

test('web startup binds only IPv4 loopback and closes all sockets even if services fail to close',async()=>{
  const events=[],server=new EventEmitter();
  server.listen=(port,bindHost,callback)=>{assert.equal(port,4180);assert.equal(bindHost,'127.0.0.1');events.push('listen');queueMicrotask(callback);};
  server.close=callback=>{events.push('close-listener');callback();};server.closeIdleConnections=()=>events.push('close-idle');server.closeAllConnections=()=>events.push('close-all');
  assert.equal(WEB_BIND_HOST,'127.0.0.1');assert.equal(WEB_BIND_PORT,4180);
  const app=await startWebServer({config,stateDir:'/unused',runtimeRoot:'/unused',serverFactory:()=>server,servicesFactory:async()=>{
    assert.deepEqual(events,['listen']);events.push('services');return {handle(){},close(){events.push('close-services');throw Error('synthetic shutdown');}};
  }});
  assert.equal(app.origin,config.webOrigin);assert.equal(app.port,4180);
  await assert.rejects(app.close(),/synthetic shutdown/);await assert.rejects(app.close(),/synthetic shutdown/);
  assert.deepEqual(events,['listen','services','close-listener','close-idle','close-services','close-all']);
});
