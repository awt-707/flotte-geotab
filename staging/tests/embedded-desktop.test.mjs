import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {validateEmbeddedConfig,allowedEmbeddedRequest,trustedEmbeddedURL,LOCAL_ORIGIN}=require('../desktop/embedded-config.cjs');
const {createEmbeddedSupervisor}=require('../desktop/embedded-supervisor.cjs');
const {attachEmbeddedBootstrap}=require('../desktop/embedded-bootstrap.cjs');
import {EMBEDDED_CLIENT_FILES,EMBEDDED_SITE_FILES,EMBEDDED_EXTENSION_FILES,prepareEmbeddedSources,dependencyInventory,parseEmbeddedBuildArgs,verifySiteScripts} from '../scripts/build-embedded-desktop.mjs';
const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_public_key_1234567890'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const jwt=payload=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.synthetic';
test('embedded config accepts only a fixed production project and public credentials',()=>{
  assert.deepEqual(validateEmbeddedConfig(config),config);
  validateEmbeddedConfig({...config,publishableKey:jwt({role:'anon',ref:config.projectRef})});
  for(const changes of [{environment:'staging'},{serviceKey:'synthetic'},{supabaseUrl:'https://another.supabase.co'},{publishableKey:'sb_secret_do_not_ship'},{publishableKey:jwt({role:'service_role',ref:config.projectRef})},{publishableKey:jwt({role:'authenticated',ref:config.projectRef})},{publishableKey:jwt({role:'anon',ref:'another'})}])assert.throws(()=>validateEmbeddedConfig({...config,...changes}));
});
test('embedded webview trusts only its own local server and its explicit Supabase project',()=>{
  assert.ok(trustedEmbeddedURL(LOCAL_ORIGIN+'/api/test'));assert.ok(trustedEmbeddedURL('blob:'+LOCAL_ORIGIN+'/pdf',{blob:true}));
  for(const url of ['http://localhost:4173/','http://127.0.0.1:4174/','https://example.test','file:///tmp/test','blob:https://example.test/id'])assert.equal(trustedEmbeddedURL(url,{blob:true}),false);
  assert.ok(allowedEmbeddedRequest(config.supabaseUrl+'/auth/v1/token','xhr',config));
  assert.ok(allowedEmbeddedRequest(config.supabaseUrl.replace('https:','wss:')+'/realtime/v1','webSocket',config));
  assert.ok(allowedEmbeddedRequest('https://tile.openstreetmap.org/0/0/0.png','image',config));
  for(const [url,type] of [[config.supabaseUrl+'/code.js','script'],['https://other.supabase.co/rest/v1/x','xhr'],['https://tile.openstreetmap.org/code.js','script'],['file:///etc/passwd','xhr'],['data:text/html,test','mainFrame']])assert.equal(allowedEmbeddedRequest(url,type,config),false);
});
function workerFixture(extra={}) {
  const child=new EventEmitter(),messages=[],calls=[];child.postMessage=message=>messages.push(message);child.kill=()=>{child.killed=true;child.emit('exit',1);};
  const supervisor=createEmbeddedSupervisor({utilityProcess:{fork:(file,args,options)=>{calls.push({file,args,options});return child;}},config,stateDir:'/synthetic/state',runtimeRoot:'/synthetic/runtime',timeoutMs:1000,...extra});
  const ready=()=>{child.emit('spawn');child.emit('message',{type:'ready',nonce:messages[0].nonce,origin:LOCAL_ORIGIN,instanceId:'synthetic-instance',projectRef:config.projectRef});};
  return{child,messages,calls,supervisor,ready};
}
test('supervisor verifies ready IPC, filters inherited secrets, pauses and stops its owned worker',async()=>{
  const key='LUDY_PRODUCTION_SERVICE_KEY',old=process.env[key];process.env[key]='synthetic-not-for-runtime';
  try {
    const f=workerFixture(),pending=f.supervisor.start();assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.env[key],undefined);assert.equal(f.calls[0].options.allowLoadingUnsignedLibraries,false);
    f.ready();assert.equal((await pending).origin,LOCAL_ORIGIN);assert.equal(f.supervisor.running,true);
    f.supervisor.pause();f.supervisor.resume();assert.deepEqual(f.messages.slice(1).map(message=>message.type),['pause','resume']);
    const stopped=f.supervisor.stop();assert.equal(f.messages.at(-1).type,'stop');f.child.emit('exit',0);await stopped;assert.equal(f.supervisor.running,false);
  }finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
test('wrong project or listener identity never makes the service ready',async()=>{
  for(const changes of [{origin:'http://0.0.0.0:4173'},{projectRef:'different'},{instanceId:''}]) {
    const f=workerFixture(),pending=f.supervisor.start();f.child.emit('spawn');
    f.child.emit('message',{type:'ready',nonce:f.messages[0].nonce,origin:LOCAL_ORIGIN,instanceId:'synthetic-instance',projectRef:config.projectRef,...changes});
    await assert.rejects(pending);assert.equal(f.supervisor.running,false);assert.ok(f.child.killed);
  }
  const f=workerFixture(),pending=f.supervisor.start();f.child.emit('spawn');f.child.emit('message',{type:'ready',nonce:'wrong',origin:LOCAL_ORIGIN,instanceId:'synthetic-instance',projectRef:config.projectRef});assert.equal(f.supervisor.running,false);f.child.emit('exit',1);await assert.rejects(pending);
});
test('worker startup failure can be retried and timeout kills the owned child',async()=>{
  let attempts=0;
  const supervisor=createEmbeddedSupervisor({utilityProcess:{fork:()=>{attempts++;throw Error('synthetic spawn error');}},config,stateDir:'/synthetic/state',runtimeRoot:'/synthetic/runtime'});
  await assert.rejects(supervisor.start());await assert.rejects(supervisor.start());assert.equal(attempts,2);
  const f=workerFixture({timeoutMs:5});await assert.rejects(f.supervisor.start());assert.ok(f.child.killed);
});
test('Chromium is installed once on collector demand and its successful exit resumes the worker',async()=>{
  const children=[],calls=[];
  const supervisor=createEmbeddedSupervisor({utilityProcess:{fork:(file,args,options)=>{const child=new EventEmitter();child.messages=[];child.postMessage=value=>child.messages.push(value);child.kill=()=>child.emit('exit',1);children.push(child);calls.push({file,args,options});return child;}},config,stateDir:'/state',runtimeRoot:'/runtime'});
  const started=supervisor.start(),worker=children[0];worker.emit('spawn');const nonce=worker.messages[0].nonce;
  worker.emit('message',{type:'ready',nonce,origin:LOCAL_ORIGIN,instanceId:'instance123',projectRef:config.projectRef});await started;
  for(let count=0;count<2;count++)worker.emit('message',{type:'status',nonce,state:'browser-install-required'});
  assert.equal(children.length,2);assert.equal(calls[1].file,'/runtime/node_modules/playwright/cli.js');assert.deepEqual(calls[1].args,['install','chromium']);assert.equal(calls[1].options.env.PLAYWRIGHT_BROWSERS_PATH,'/state/browsers');
  children[1].emit('exit',0);assert.equal(worker.messages.at(-1).type,'browser-installed');worker.emit('message',{type:'status',nonce,state:'browser-install-required'});assert.equal(children.length,2);
  const stopped=supervisor.stop();worker.emit('exit',0);await stopped;
});
test('bootstrap starts the explicit runtime and serializes pause, resume and close',async()=>{
  const port=new EventEmitter(),sent=[],actions=[];port.postMessage=message=>sent.push(message);
  const nonce='12345678-1234-1234-1234-123456789abc';
  const bootstrap=attachEmbeddedBootstrap(port,{load:async file=>{assert.equal(file,'/runtime/desktop-runtime/server.mjs');return{startDesktopServer:async input=>{assert.deepEqual(input.config,config);return{origin:LOCAL_ORIGIN,instanceId:'instance123',pause:async()=>actions.push('pause'),resume:async()=>actions.push('resume'),close:async()=>actions.push('close')};}};},exit:code=>actions.push('exit:'+code)});
  port.emit('message',{data:{type:'init',nonce,config,stateDir:'/state',runtimeRoot:'/runtime'}});await bootstrap.settled();assert.equal(sent[0].type,'ready');
  for(const type of ['pause','resume','stop'])port.emit('message',{data:{type,nonce}});
  await bootstrap.settled();assert.deepEqual(actions,['pause','resume','close','exit:0']);
});
test('bootstrap never echoes provider errors or secret values to the client',async()=>{
  const port=new EventEmitter(),sent=[],exits=[];port.postMessage=message=>sent.push(message);
  const bootstrap=attachEmbeddedBootstrap(port,{load:async()=>{throw Error('synthetic-provider-password');},exit:code=>exits.push(code)});
  port.emit('message',{data:{type:'init',nonce:'12345678-1234-1234-1234-123456789abc',config,stateDir:'/state',runtimeRoot:'/runtime'}});await bootstrap.settled();
  assert.equal(sent[0].type,'failed');assert.ok(!JSON.stringify(sent).includes('password'));assert.deepEqual(exits,[1]);
});
async function sourceFixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-embedded-build-'))),source=path.join(root,'staging');await fs.mkdir(source);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=[...EMBEDDED_SITE_FILES.map(file=>'site/'+file),...EMBEDDED_CLIENT_FILES.map(file=>'desktop/'+file),...EMBEDDED_EXTENSION_FILES,'desktop/embedded-bootstrap.cjs','desktop/package.json','desktop-runtime/server.mjs','server/fixture.mjs','package.json','package-lock.json','vendor/xlsx-0.20.3.tgz'];
  for(const file of files){await fs.mkdir(path.dirname(path.join(source,file)),{recursive:true});await fs.writeFile(path.join(source,file),file==='desktop/package.json'?JSON.stringify({version:'0.1.1'}):'synthetic source');}
  return{root,source};
}
test('embedded package source allowlist excludes local credentials, profiles, tests and staging entrypoints',async t=>{
  const {root,source}=await sourceFixture(t);
  for(const file of ['.local/geotab.json','desktop/server.json','desktop/.env','desktop-runtime/secret.json','server/module.test.mjs','scripts/serve.mjs','node_modules/private.txt','site/private-data.json']){await fs.mkdir(path.dirname(path.join(source,file)),{recursive:true});await fs.writeFile(path.join(source,file),'NEVER_INCLUDE_PRIVATE');}
  const out=await prepareEmbeddedSources(path.join(root,'out'),config,source);
  assert.ok(out.inventory.some(file=>file.path==='site/timezone.js'));
  for(const entry of out.inventory)assert.ok(!(await fs.readFile(path.join(out.runtime,entry.path))).includes('NEVER_INCLUDE_PRIVATE'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out.client,'embedded.json'),'utf8')),config);
  const runtimeFiles=await fs.readdir(out.runtime,{recursive:true});assert.ok(!runtimeFiles.some(file=>file.includes('.local')||file.includes('profiles')||file.includes('serve.mjs')||file.includes('secret.json')));
  await fs.rm(path.join(source,'desktop/embedded-main.cjs'));await fs.symlink(path.join(source,'.local/geotab.json'),path.join(source,'desktop/embedded-main.cjs'));
  await assert.rejects(prepareEmbeddedSources(path.join(root,'rejected'),config,source),/non régulière/);
});
test('all HTML script sources are included explicitly and newly added scripts block packaging',async t=>{
  await verifySiteScripts();const {source}=await sourceFixture(t);
  await fs.writeFile(path.join(source,'site/index.html'),'<script src="new-module.js"></script>');
  await assert.rejects(verifySiteScripts(source),/new-module.js/);
});
test('build requires public config and refuses unverified native dependencies',async t=>{
  assert.throws(()=>parseEmbeddedBuildArgs([]));assert.throws(()=>parseEmbeddedBuildArgs(['--draft']));
  assert.equal(parseEmbeddedBuildArgs(['--config','public.json']).target,'windows-x64');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-native-dependency-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'module.node'),'synthetic');
  await assert.rejects(dependencyInventory(root),/native non validée/);
});
