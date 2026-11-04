import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {validateConfig,readConfig,isShellURL,isTrustedURL,isAllowedRequest,safeExternalURL,downloadName,SHELL_URL,WEB_PREFERENCES}=require('../desktop/config.cjs');
const {startDesktop,probeStaging}=require('../desktop/main.cjs');
const base={environment:'staging',serverUrl:'https://staging.example.test',appName:'Ludy Staging'};
const remote=validateConfig(base),local=validateConfig({...base,mode:'operator-local',serverUrl:'http://127.0.0.1:4173'},{platform:'linux'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('desktop config requires an explicit staging server and keeps each origin in its own persistent session',()=>{
 const missing=validateConfig({environment:'staging',serverUrl:null});assert.equal(missing.configured,false);assert.equal(missing.serverUrl,null);
 assert.equal(remote.serverUrl,'https://staging.example.test/');assert.match(remote.partition,/^persist:ludy-staging-[a-f0-9]{16}$/);
 assert.notEqual(validateConfig({...base,serverUrl:'https://another.example.test'}).partition,remote.partition);
 assert.equal(validateConfig({...base,serverUrl:'https://staging.example.test/'}).partition,remote.partition);
});
test('desktop config rejects credentials, known production, non-HTTPS remote hosts, paths and unexpected fields',()=>{
 for(const serverUrl of ['http://staging.example.test','https://ludy-flotte.pages.dev','https://ludy-flotte.pages.dev.','https://cgiiwumbblimvmrypxlc.supabase.co','https://localhost','https://127.0.0.1','https://[::1]','https://staging.local','https://a:b@staging.example.test','https://staging.example.test/app','https://staging.example.test/?token=123','https://staging.example.test/#/direct','https://staging.example.test\n'])assert.throws(()=>validateConfig({...base,serverUrl}),{code:'CONFIG_INVALID'},serverUrl);
 assert.throws(()=>validateConfig({...base,environment:'production'}));assert.throws(()=>validateConfig({...base,password:'not-accepted'}));
});
test('operator-local is explicit, Linux-only, and accepts only the staging UI loopback address',()=>{
 assert.equal(local.mode,'operator-local');assert.equal(local.origin,'http://127.0.0.1:4173');
 for(const platform of ['darwin','win32'])assert.throws(()=>validateConfig({...base,mode:'operator-local',serverUrl:local.origin},{platform}));
 for(const serverUrl of ['http://localhost:4173','http://127.0.0.1:57421','https://staging.example.test'])assert.throws(()=>validateConfig({...base,mode:'operator-local',serverUrl},{platform:'linux'}));
});
test('config reading handles absence honestly and refuses malformed or oversized config',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ludy-desktop-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'server.json');
 assert.equal(readConfig(file).configured,false);await writeFile(file,'{"environment":');assert.throws(()=>readConfig(file),{code:'CONFIG_INVALID'});
 await writeFile(file,' '.repeat(8200));assert.throws(()=>readConfig(file),{code:'CONFIG_INVALID'});await writeFile(file,JSON.stringify(base));assert.equal(readConfig(file).origin,remote.origin);
});
test('renderer traffic permits only its server and explicit map services with suitable resource types',()=>{
 for(const [url,type] of [[remote.origin+'/api/parking/zones','xhr'],[remote.origin+'/vendor/font.woff2','font'],['wss://staging.example.test/realtime/v1/websocket','webSocket'],['https://tile.openstreetmap.org/10/22/33.png','image'],['https://photon.komoot.io/api/?q=Casablanca','xhr'],['data:image/png;base64,AA','image']])assert.equal(isAllowedRequest(url,type,remote),true,url);
 for(const [url,type] of [['https://outside.example.test/api','xhr'],['https://tile.openstreetmap.org/code.js','script'],['https://photon.komoot.io/site','mainFrame'],['http://127.0.0.1:57421/auth/v1/token','xhr'],['wss://other.example.test/ws','webSocket'],['file:///tmp/file','image'],['data:text/html,hello','mainFrame']])assert.equal(isAllowedRequest(url,type,remote),false,url);
 for(const url of ['http://127.0.0.1:4173/api/fleet','http://127.0.0.1:57421/auth/v1/token','ws://127.0.0.1:57421/realtime/v1/websocket'])assert.equal(isAllowedRequest(url,'xhr',local),true);
 for(const url of ['http://127.0.0.1:57423','http://localhost:57421','http://192.168.1.1:57421'])assert.equal(isAllowedRequest(url,'xhr',local),false);
});
test('blob documents retain the same strict origin as ordinary pages',()=>{
 assert.equal(isTrustedURL('blob:https://staging.example.test/document-id',remote,{blob:true}),true);
 assert.equal(isTrustedURL('blob:https://staging.example.test/document-id',remote),false);
 for(const url of ['blob:https://outside.example.test/document-id','blob:null/document-id','blob:https://user:password@staging.example.test/document-id','https://staging.example.test.outside.test/'])assert.equal(isTrustedURL(url,remote,{blob:true}),false);
});
test('local shell and external URLs do not accept arbitrary native schemes',()=>{
 assert.equal(isShellURL(SHELL_URL),true);assert.equal(isShellURL(SHELL_URL+'?x=1'),false);assert.equal(isShellURL('ludy-client://shell/../main.cjs'),false);
 assert.equal(safeExternalURL('https://docs.example.test/help'),'https://docs.example.test/help');assert.equal(safeExternalURL('mailto:help@example.test'),'mailto:help@example.test');assert.equal(safeExternalURL('tel:+212600000000'),'tel:+212600000000');
 for(const url of ['file:///tmp/data','javascript:void(0)','data:text/html,hello','http://127.0.0.1:4173','https://user:secret@example.test/','mailto:help@example.test?body=x%0d%0aY'])assert.equal(safeExternalURL(url),null);
 assert.equal(downloadName('../../report.pdf'),'report.pdf');assert.equal(downloadName('C:\\temp\\report.pdf'),'report.pdf');assert.equal(downloadName('CON.txt'),'document');assert.equal(downloadName('rapport:fin?.csv'),'rapport_fin_.csv');
});
test('health probe verifies the staging identity before loading any hosted UI',async()=>{
 const requests=[];await probeStaging(async(url,options)=>{requests.push({url,options});return Response.json({environment:'staging',project:'ludy-staging'});},remote);
 assert.equal(requests[0].url,remote.origin+'/health');assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.cache,'no-store');
 for(const response of [new Response('Login',{headers:{'content-type':'text/html'}}),Response.json({environment:'production',project:'ludy-staging'}),Response.json({environment:'staging',project:'another-project'}),Response.json({environment:'staging',project:'ludy-staging',padding:'x'.repeat(4096)}),new Response('invalid',{headers:{'content-type':'application/json'}}),new Response(null,{status:204})])await assert.rejects(()=>probeStaging(async()=>response,remote),{code:'UNVERIFIED'});
 await assert.rejects(()=>probeStaging(async()=>{throw Error('offline');},remote),/offline/);
});
test('preload exposes only fixed shell methods, never Node or IPC on remote pages or PDFs',async()=>{
 const source=await readFile(new URL('../desktop/shell-preload.cjs',import.meta.url),'utf8');
 for(const url of [SHELL_URL,remote.origin+'/',`blob:${remote.origin}/document-id`,'ludy-client://shell/status?x=1']){
  const exposures=[],calls=[];vm.runInNewContext(source,{location:new URL(url),require:module=>{assert.equal(module,'electron');return{contextBridge:{exposeInMainWorld:(key,value)=>exposures.push([key,value])},ipcRenderer:{invoke:channel=>{calls.push(channel);return Promise.resolve(null);}}};}});
  assert.equal(exposures.length,url===SHELL_URL?1:0,url);if(exposures.length){assert.equal(exposures[0][0],'ludyClient');assert.deepEqual(Object.keys(exposures[0][1]),['state','retry','browser']);await exposures[0][1].state('ignored');await exposures[0][1].retry();await exposures[0][1].browser();assert.deepEqual(calls,['ludy-client:state','ludy-client:retry','ludy-client:browser']);}
 }
});

async function fixture(t,{config=base,fetchFn=async()=>Response.json({environment:'staging',project:'ludy-staging'}),platform='linux',notificationPreference='granted'}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'ludy-desktop-main-'));t.after(()=>rm(dir,{recursive:true,force:true}));const configPath=path.join(dir,'server.json');await writeFile(configPath,JSON.stringify(config));
 if(notificationPreference)await writeFile(path.join(dir,'notifications-'+validateConfig(config,{platform}).partition.split('-').at(-1)+'.json'),JSON.stringify({notifications:notificationPreference}));
 const app=new EventEmitter();Object.assign(app,{setName(){},setPath(){},getPath:()=>dir,enableSandbox(){app.sandbox=true;},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){app.quits=(app.quits||0)+1;}});
 const instances=[],handlers=new Map(),dialogs=[],external=[],resources=new Map();
 class Window extends EventEmitter{constructor(options){super();this.options=options;this.destroyed=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{url:''},getURL:()=>this.url||'',isDestroyed:()=>this.destroyed,setWindowOpenHandler:handler=>{this.open=handler;},reload(){}});instances.push(this);}loadURL(url){this.url=url;this.webContents.mainFrame.url=url;return Promise.resolve();}isDestroyed(){return this.destroyed;}isMinimized(){return false;}show(){}focus(){}setTitle(){}static fromWebContents(contents){return instances.find(win=>win.webContents===contents);}}
 const browsing=new EventEmitter();Object.assign(browsing,{protocol:{handle:(scheme,handler)=>resources.set(scheme,handler)},webRequest:{onBeforeRequest:handler=>{browsing.request=handler;}},setPermissionCheckHandler:handler=>{browsing.check=handler;},setPermissionRequestHandler:handler=>{browsing.permission=handler;},fetch:fetchFn});
 let menu;const electron={app,BrowserWindow:Window,session:{fromPartition:partition=>{browsing.partition=partition;return browsing;}},protocol:{registerSchemesAsPrivileged(){}},ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)},dialog:{showMessageBox:async(owner,options)=>{dialogs.push({owner,options});return{response:0};}},shell:{openExternal:async url=>external.push(url)},Menu:{buildFromTemplate:template=>template,setApplicationMenu(template){menu=template;}}};
 const runtime=await startDesktop(electron,{configPath,platform});await tick();await tick();
 t.after(()=>app.emit('before-quit'));
 const sender=()=>({sender:runtime.window.webContents,senderFrame:runtime.window.webContents.mainFrame});
 const event=(extra={})=>({prevented:false,preventDefault(){this.prevented=true;},...extra});
 return{runtime,app,instances,handlers,dialogs,external,browsing,resources,sender,event,menu,dir};
}
test('main starts the verified staging in a sandboxed persistent window; shell IPC is denied to hosted content',async t=>{
 const f=await fixture(t),win=f.runtime.window;assert.equal(f.runtime.state,'ready');assert.equal(win.url,remote.serverUrl);assert.equal(f.app.sandbox,true);assert.equal(f.browsing.partition,remote.partition);
 for(const [key,value]of Object.entries(WEB_PREFERENCES))assert.equal(win.options.webPreferences[key],value,key);
 assert.equal(f.handlers.get('ludy-client:state')(f.sender()),null);assert.equal(f.handlers.get('ludy-client:browser')(f.sender()),false);
 const blocked=f.event({url:'https://other.example.test/iframe',isMainFrame:false});win.webContents.emit('will-frame-navigate',blocked);assert.equal(blocked.prevented,true);
 const same=f.event({url:remote.origin+'/document',isMainFrame:false});win.webContents.emit('will-frame-navigate',same);assert.equal(same.prevented,false);
 const redirect=f.event({url:'https://other.example.test/redirect'});win.webContents.emit('will-redirect',redirect);assert.equal(redirect.prevented,true);
});
test('unconfigured and unverified endpoints stay on the local shell without opening a login page',async t=>{
 const missing=await fixture(t,{config:{environment:'staging',serverUrl:null}});assert.equal(missing.runtime.window.url,SHELL_URL);assert.equal(missing.runtime.state,'missing');assert.equal(missing.handlers.get('ludy-client:state')(missing.sender()).canRetry,false);
 const unverified=await fixture(t,{fetchFn:async()=>new Response('Proxy login',{headers:{'content-type':'text/html'}})});assert.equal(unverified.runtime.state,'unverified');assert.equal(unverified.runtime.window.url,SHELL_URL);
 const wrongFrame={...missing.sender(),senderFrame:{url:SHELL_URL}};assert.equal(missing.handlers.get('ludy-client:state')(wrongFrame),null);
});
test('network failure can be retried and a completed older connection never replaces the latest one',async t=>{
 let fetches=0,oldResolve;const f=await fixture(t,{fetchFn:async()=>{fetches++;if(fetches===1)throw Error('network');if(fetches===2)return new Promise(resolve=>{oldResolve=resolve;});return Response.json({environment:'staging',project:'ludy-staging'});}});
 assert.equal(f.runtime.state,'offline');const older=f.runtime.connect();await tick();const newer=f.runtime.connect();await newer;assert.equal(f.runtime.state,'ready');
 oldResolve(Response.json({environment:'production',project:'wrong'}));await older;assert.equal(f.runtime.state,'ready');assert.equal(f.runtime.window.url,remote.serverUrl);
});
test('same-origin PDF popups are sandboxed; external navigation needs explicit native confirmation',async t=>{
 const f=await fixture(t),win=f.runtime.window;
 const pdf=win.open({url:`blob:${remote.origin}/document-id`});assert.equal(pdf.action,'allow');assert.equal(pdf.overrideBrowserWindowOptions.webPreferences.sandbox,true);assert.equal(pdf.overrideBrowserWindowOptions.webPreferences.nodeIntegration,false);
 assert.equal(win.open({url:'https://docs.example.test/help'}).action,'deny');await tick();assert.deepEqual(f.external,['https://docs.example.test/help']);assert.equal(f.dialogs[0].options.defaultId,1);
 assert.equal(win.open({url:'file:///tmp/example.pdf'}).action,'deny');await tick();assert.equal(f.external.length,1);
 const nav=f.event({url:'https://help.example.test/guide'});win.webContents.emit('will-navigate',nav);assert.equal(nav.prevented,true);await tick();assert.equal(f.external[1],'https://help.example.test/guide');
});
test('downloads always retain the native save dialog and cannot fetch documents from unrelated origins',async t=>{
 const f=await fixture(t),win=f.runtime.window,item=new EventEmitter();Object.assign(item,{getURLChain:()=>[remote.origin+'/api/export'],getFilename:()=>'../rapport.csv',setSaveDialogOptions:options=>{item.options=options;},setSavePath:()=>assert.fail('A download must never silently choose a local destination')});
 const valid=f.event();f.browsing.emit('will-download',valid,item,win.webContents);assert.equal(valid.prevented,false);assert.equal(item.options.defaultPath,'rapport.csv');assert.ok(item.options.properties.includes('showOverwriteConfirmation'));
 item.getURLChain=()=>[remote.origin+'/redirect','https://other.example.test/file'];const other=f.event();f.browsing.emit('will-download',other,item,win.webContents);assert.equal(other.prevented,true);
});
test('permissions are restricted to notifications with user confirmation; camera and geolocation are denied',async t=>{
 const f=await fixture(t,{notificationPreference:null}),win=f.runtime.window,ask=permission=>new Promise(resolve=>f.browsing.permission(win.webContents,permission,resolve,{isMainFrame:true}));
 assert.equal(await ask('camera'),false);assert.equal(await ask('geolocation'),false);assert.equal(await ask('clipboard-sanitized-write'),true);assert.equal(await ask('notifications'),true);assert.equal(f.browsing.check(win.webContents,'notifications',remote.origin),true);
 await win.loadURL(SHELL_URL);assert.equal(await ask('notifications'),false);
});
test('notification choice is private, retained, and can be enabled then disabled through the native menu',async t=>{
 const f=await fixture(t,{notificationPreference:'denied'}),contents=f.runtime.window.webContents;
 assert.equal(f.dialogs.length,0,'a previous refusal does not prompt again at startup');
 const toggle=f.menu.find(item=>item.label==='Affichage').submenu.find(item=>item.label==='Notifications…');
 const ask=()=>new Promise(resolve=>f.browsing.permission(contents,'notifications',resolve,{isMainFrame:true}));
 assert.equal(await ask(),false);toggle.click();assert.equal(await ask(),true);assert.equal(f.browsing.check(contents,'notifications',remote.origin),true);
 const preference=path.join(f.dir,'notifications-'+remote.partition.split('-').at(-1)+'.json');assert.deepEqual(JSON.parse(await readFile(preference,'utf8')),{notifications:'granted'});assert.equal((await stat(preference)).mode&0o777,0o600);
 toggle.click();assert.equal(await ask(),false);assert.deepEqual(JSON.parse(await readFile(preference,'utf8')),{notifications:'denied'});assert.equal(f.browsing.check(contents,'notifications',remote.origin),false);
});
test('operator-local browser recovery opens only the configured local endpoint',async t=>{
 const f=await fixture(t,{config:{...base,mode:'operator-local',serverUrl:local.serverUrl},fetchFn:async()=>{throw Error('offline');}});assert.equal(f.handlers.get('ludy-client:browser')(f.sender()),true);await tick();assert.deepEqual(f.external,[local.serverUrl]);
});
test('custom shell serves only fixed resources with a restrictive CSP',async t=>{
 const f=await fixture(t,{config:{environment:'staging',serverUrl:null}}),serve=f.resources.get('ludy-client');
 const page=await serve({url:SHELL_URL,method:'GET'});assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);
 assert.equal((await serve({url:'ludy-client://shell/main.cjs',method:'GET'})).status,404);assert.equal((await serve({url:SHELL_URL,method:'POST'})).status,404);
});
