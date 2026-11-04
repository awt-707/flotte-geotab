import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createDesktopHttpServer,startDesktopServer} from '../desktop-runtime/server.mjs';

const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_fixture'};
const origin='http://127.0.0.1:4173';
async function fixture(t,extra={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'ludy-http-'));
  await mkdir(path.join(root,'site'),{recursive:true});await mkdir(path.join(root,'node_modules'),{recursive:true});
  await writeFile(path.join(root,'site/index.html'),'<!doctype html><h1>Ludy fixture</h1>');
  await writeFile(path.join(root,'site/spreadsheet-worker.js'),'self.onmessage=()=>{};');
  await writeFile(path.join(root,'private.json'),'PRIVATE_FIXTURE');
  await symlink(path.join(root,'private.json'),path.join(root,'site/escape.json'));
  const calls=[];
  const services={async handle(req,res){calls.push(req.url);res.setHeader('content-type','application/json');res.end('{"ok":true}');return true;}};
  const server=createDesktopHttpServer({config:{...config,...extra},runtimeRoot:root,instanceId:'fixture-instance',services});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  function request(url,options={}){
    return new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method:options.method||'GET',headers:{Host:'127.0.0.1:4173',...options.headers}},res=>{
        const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));
      });req.on('error',reject);req.end(options.body);
    });
  }
  return {root,request,calls};
}
test('embedded static server exposes only public project configuration and an instance-bound health',async t=>{
  const f=await fixture(t,{serviceKey:'MUST_NOT_BE_PUBLISHED',unrelatedSecret:'ALSO_PRIVATE'});
  const result=await f.request('/config.js'),context={window:{}};vm.runInNewContext(result.body,context);
  const value=context.window.FLOTTE_CONFIG;
  assert.equal(result.status,200);assert.equal(value.DESKTOP_PRODUCTION,true);assert.equal(value.STAGING,false);
  assert.equal(value.AUTH_STORAGE_KEY,'ludy-production-'+config.projectRef+'-auth');
  assert.equal(value.SUPABASE_ANON_KEY,config.publishableKey);assert.equal(value.SUPABASE_URL,config.supabaseUrl);
  assert.doesNotMatch(result.body,/MUST_NOT|ALSO_PRIVATE|serviceKey|unrelatedSecret/);
  assert.match(result.headers['content-security-policy'],/https:\/\/abcdefghijklmnopqrst\.supabase\.co wss:\/\/abcdefghijklmnopqrst\.supabase\.co/);
  assert.doesNotMatch(result.headers['content-security-policy'],/57421|connect-src[^;]*\*/);
  assert.deepEqual(JSON.parse((await f.request('/health')).body),{environment:'production',projectRef:config.projectRef,instanceId:'fixture-instance'});
  assert.equal((await f.request('/health',{method:'HEAD'})).body,'');assert.deepEqual(f.calls,[]);
});
test('embedded server confines static files and refuses host confusion',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/')).status,200);
  for(const url of ['/escape.json','/%2e%2e/private.json','/.local/runtime.json','/vendor/../../private.json','/vendor/missing.js'])assert.equal((await f.request(url)).status,404,url);
  assert.equal((await f.request('/%zz')).status,400);
  assert.equal((await f.request('/health',{headers:{Host:'outside.example'}})).status,403);
  assert.equal((await f.request('/health',{headers:{Host:'localhost:4173'}})).status,403);
  const worker=await f.request('/spreadsheet-worker.js');assert.match(worker.headers['content-security-policy'],/connect-src 'none'/);
  assert.deepEqual(f.calls,[]);
});
test('desktop session and participation mutations require the exact origin and JSON',async t=>{
  const f=await fixture(t),base={method:'POST',headers:{Authorization:'Bearer SYNTHETIC'},body:'{}'};
  for(const route of ['session','logout','participation']){
    assert.equal((await f.request('/api/desktop/'+route,base)).status,403);
    assert.equal((await f.request('/api/desktop/'+route,{...base,headers:{...base.headers,Origin:'https://outside.example','Content-Type':'application/json'}})).status,403);
    assert.equal((await f.request('/api/desktop/'+route,{...base,headers:{...base.headers,Origin:origin,'Content-Type':'text/plain'}})).status,403);
  }
  assert.deepEqual(f.calls,[]);
  assert.equal((await f.request('/api/desktop/status',{headers:{Origin:'https://outside.example'}})).status,403);
  assert.equal((await f.request('/api/desktop/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.request('/api/desktop/session',{...base,headers:{...base.headers,Origin:origin,'Content-Type':'application/json'}})).status,200);
  assert.deepEqual(f.calls,['/api/desktop/session']);
});
test('the connector installation link serves its guide and downloads the bundled extension',async t=>{
  const f=await fixture(t);
  const guide=await readFile(new URL('../site/uber-extension.html',import.meta.url),'utf8');
  await writeFile(path.join(f.root,'site/uber-extension.html'),guide);
  await mkdir(path.join(f.root,'uber-extension'));
  const archive='PK\x03\x04SYNTHETIC_EXTENSION';
  await writeFile(path.join(f.root,'uber-extension/ludy-uber-chromium.zip'),archive);
  for(const route of ['/uber-extension/','/uber-extension']){
    const page=await f.request(route);
    assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);
    assert.match(page.body,/href="\/uber-extension\/ludy-uber-chromium.zip" download=/);
  }
  const zip=await f.request('/uber-extension/ludy-uber-chromium.zip');
  assert.equal(zip.status,200);assert.equal(zip.headers['content-type'],'application/zip');
  assert.match(zip.headers['content-disposition'],/attachment; filename="ludy-uber-chromium.zip"/);
  assert.equal(zip.body,archive);
  const head=await f.request('/uber-extension/ludy-uber-chromium.zip',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(head.body,'');
  assert.equal(Number(head.headers['content-length']),Buffer.byteLength(archive));
  assert.deepEqual(f.calls,[]);
});
test('invalid or privileged production configuration is refused before serving',()=>{
  const jwt=claims=>['header',Buffer.from(JSON.stringify(claims)).toString('base64url'),'signature'].join('.');
  for(const value of [{...config,environment:'staging'},{...config,supabaseUrl:'https://other.supabase.co'},{...config,publishableKey:'sb_secret_fixture'},{...config,publishableKey:jwt({role:'service_role',ref:config.projectRef})},{...config,publishableKey:jwt({role:'anon',ref:'other'})}]){
    assert.throws(()=>createDesktopHttpServer({config:value,runtimeRoot:'/irrelevant'}),/Configuration publique|Clé publique/);
  }
});
test('a port conflict never reuses another process or constructs collectors',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ludy-conflict-'));await mkdir(path.join(root,'site'));await mkdir(path.join(root,'node_modules'));
  const occupied=net.createServer(socket=>socket.destroy());let own=false,calls=0;
  await new Promise((resolve,reject)=>{occupied.once('error',error=>error.code==='EADDRINUSE'?resolve():reject(error));occupied.listen(4173,'127.0.0.1',()=>{own=true;resolve();});});
  t.after(async()=>{if(own)await new Promise(resolve=>occupied.close(resolve));await rm(root,{recursive:true,force:true});});
  await assert.rejects(startDesktopServer({config,stateDir:root,runtimeRoot:root,servicesFactory:async()=>{calls++;throw Error('must not construct');}}),{code:'DESKTOP_PORT_BUSY'});
  assert.equal(calls,0);if(own)assert.equal(occupied.listening,true);
});
test('desktop lifecycle starts services after listening and closes sockets even when service shutdown fails',async()=>{
  const events=[],server=new EventEmitter();
  server.listen=(port,host)=>{assert.equal(port,4173);assert.equal(host,'127.0.0.1');events.push('listen');queueMicrotask(()=>server.emit('listening'));};
  server.close=callback=>{events.push('close-listener');callback();};server.closeIdleConnections=()=>events.push('close-idle');server.closeAllConnections=()=>events.push('close-all');
  const application=await startDesktopServer({config,stateDir:'/unused',runtimeRoot:'/unused',serverFactory:()=>server,
    servicesFactory:async()=>{assert.deepEqual(events,['listen']);events.push('services');return {handle(){},pause(){events.push('pause');},resume(){events.push('resume');},close(){events.push('close-services');throw Error('fixture shutdown');}};}});
  application.pause();application.resume();assert.equal(application.origin,origin);assert.match(application.instanceId,/^[a-f0-9-]{36}$/);
  await assert.rejects(application.close(),/fixture shutdown/);await assert.rejects(application.close(),/fixture shutdown/);
  assert.deepEqual(events,['listen','services','pause','resume','close-listener','close-idle','close-services','close-all']);
});
