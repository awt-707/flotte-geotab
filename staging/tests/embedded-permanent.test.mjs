import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {createPermanentDesktop,readPreference}=require('../desktop/embedded-permanent.cjs');
const {startEmbeddedDesktop}=require('../desktop/embedded-main.cjs');
const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_public_key_1234567890'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,{platform='win32',saved,reply=0,execPath='C:\\Ludy Folder\\Ludy.exe'}={}) {
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-permanent-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const filename=path.join(stateDir,'desktop-permanent.json');if(saved!==undefined)await fs.writeFile(filename,JSON.stringify(saved));
  const login=[],dialogs=[],errors=[],trays=[],starts=[],stops=[],throttling=[];
  const app={isPackaged:true,setLoginItemSettings:value=>login.push(value),quit(){app.quits=(app.quits||0)+1;}};
  const win={isDestroyed:()=>false,webContents:{setBackgroundThrottling:value=>throttling.push(value)}};
  class Tray extends EventEmitter{constructor(icon){super();this.icon=icon;trays.push(this);}setToolTip(value){this.tooltip=value;}setContextMenu(value){this.menu=value;}destroy(){this.destroyed=true;}}
  let shown=0;
  const controller=createPermanentDesktop({app,Tray,Menu:{buildFromTemplate:value=>value},
    dialog:{showMessageBox:async(...args)=>{dialogs.push(args.at(-1));return {response:reply};},showErrorBox:(...args)=>errors.push(args)},
    powerSaveBlocker:{start:value=>{starts.push(value);return starts.length-1;},stop:id=>stops.push(id)},
    stateDir,projectRef:config.projectRef,platform,execPath,getWindow:()=>win,showWindow:()=>shown++});
  t.after(()=>controller.shutdown());await controller.initialize();
  return{controller,stateDir,filename,login,dialogs,errors,trays,starts,stops,throttling,app,get shown(){return shown;}};
}
test('permanent mode starts disabled without changing Windows startup or power settings',async t=>{
  const f=await fixture(t);assert.equal(f.controller.enabled,false);assert.equal(f.controller.shouldHide,false);
  assert.deepEqual(f.login,[]);assert.deepEqual(f.starts,[]);assert.deepEqual(f.trays,[]);
  assert.equal(f.controller.menuItem().checked,false);assert.equal(await readPreference(f.filename),false);
});
test('enabling requires an explicit choice and keeps the screen allowed to sleep',async t=>{
  const f=await fixture(t);await f.controller.toggle();
  assert.equal(f.dialogs.length,1);assert.equal(f.dialogs[0].defaultId,1);assert.equal(f.dialogs[0].cancelId,1);
  assert.match(f.dialogs[0].detail,/Aucune session Windows ne sera ouverte automatiquement/);
  assert.equal(f.controller.enabled,true);assert.equal(f.controller.shouldHide,true);
  assert.deepEqual(f.login,[{name:'Ludy-'+config.projectRef,openAtLogin:true,path:'C:\\Ludy Folder\\Ludy.exe',args:[]}]);
  assert.deepEqual(f.starts,['prevent-app-suspension']);assert.equal(f.throttling.at(-1),false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filename,'utf8')),{version:1,enabled:true});
  if(process.platform!=='win32')assert.equal((await fs.stat(f.filename)).mode&0o777,0o600);
});
test('cancelling activation leaves startup, persistence and background behavior unchanged',async t=>{
  const f=await fixture(t,{reply:1});await f.controller.toggle();
  assert.equal(f.controller.enabled,false);assert.equal(f.controller.shouldHide,false);assert.deepEqual(f.login,[]);assert.deepEqual(f.starts,[]);
  await assert.rejects(fs.stat(f.filename),{code:'ENOENT'});
});
test('disabling from the tray reveals the window, removes startup and releases even power blocker zero',async t=>{
  const f=await fixture(t);await f.controller.toggle();const tray=f.trays[0];
  await tray.menu.find(item=>item.label==='Mode poste permanent').click();
  assert.equal(f.controller.enabled,false);assert.equal(f.controller.shouldHide,false);assert.equal(f.login.at(-1).openAtLogin,false);
  assert.equal(f.shown,1);assert.equal(tray.destroyed,true);assert.deepEqual(f.stops,[0]);assert.equal(f.throttling.at(-1),true);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filename,'utf8')),{version:1,enabled:false});
});
test('the saved opt-in restores its tray and updates startup to the opened build without touching other settings',async t=>{
  const f=await fixture(t,{saved:{version:1,enabled:true},execPath:'C:\\New Ludy\\Ludy.exe'});
  assert.equal(f.controller.enabled,true);assert.equal(f.dialogs.length,0);assert.equal(f.login[0].path,'C:\\New Ludy\\Ludy.exe');
  await fs.writeFile(path.join(f.stateDir,'other-preferences.json'),'preserve-existing-settings');
  await f.controller.toggle();assert.equal(await fs.readFile(path.join(f.stateDir,'other-preferences.json'),'utf8'),'preserve-existing-settings');
});
test('explicit Quit and shutdown release resources but preserve the choice for the next Windows session',async t=>{
  const f=await fixture(t,{saved:{version:1,enabled:true}}),tray=f.trays[0];
  tray.emit('click');assert.equal(f.shown,1);tray.menu.find(item=>item.label==='Quitter Ludy').click();assert.equal(f.app.quits,1);
  f.controller.shutdown();f.controller.shutdown();assert.equal(f.controller.shouldHide,false);assert.deepEqual(f.stops,[0]);assert.equal(tray.destroyed,true);
  assert.equal(f.login.length,1);assert.equal(await readPreference(f.filename),true);
});
test('unreadable or malformed preference does not silently opt in',async t=>{
  for(const saved of [{version:1,enabled:'true'},{version:1,enabled:true,password:'unexpected'},{version:2,enabled:true}]){
    const f=await fixture(t,{saved});assert.equal(f.controller.enabled,false);assert.equal(f.errors.length,1);assert.deepEqual(f.login,[]);
  }
});
test('a failed save rolls back the startup registration and visible mode',async t=>{
  const f=await fixture(t);await fs.mkdir(f.filename);await f.controller.toggle();
  assert.equal(f.controller.enabled,false);assert.equal(f.controller.shouldHide,false);assert.deepEqual(f.login.map(x=>x.openAtLogin),[true,false]);
  assert.deepEqual(f.stops,[0]);assert.equal(f.trays[0].destroyed,true);assert.equal(f.errors.length,1);
});
test('macOS and Linux receive no Windows autorun or permanent-mode behavior',async t=>{
  for(const platform of ['darwin','linux']){const f=await fixture(t,{platform,saved:{version:1,enabled:true}});await f.controller.toggle();assert.equal(f.controller.supported,false);assert.equal(f.controller.enabled,false);assert.deepEqual(f.login,[]);assert.deepEqual(f.trays,[]);assert.deepEqual(f.dialogs,[]);}
});

async function desktopFixture(t,{saved=false}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-permanent-main-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const configPath=path.join(dir,'embedded.json');await fs.writeFile(configPath,JSON.stringify(config));
  const stateDir=path.join(dir,'Ludy',config.projectRef);await fs.mkdir(stateDir,{recursive:true});
  if(saved)await fs.writeFile(path.join(stateDir,'desktop-permanent.json'),JSON.stringify({version:1,enabled:true}));
  const app=new EventEmitter(),windows=[],workers=[],trays=[],login=[],starts=[],stops=[];let menu;
  Object.assign(app,{isPackaged:true,setName(){},setPath(){},getPath:()=>dir,enableSandbox(){app.sandbox=true;},requestSingleInstanceLock:()=>true,whenReady:async()=>{},setLoginItemSettings:value=>login.push(value),
    quit(){app.quitCalls=(app.quitCalls||0)+1;const event={prevented:false,preventDefault(){this.prevented=true;}};app.emit('before-quit',event);if(!event.prevented)app.quitCompleted=true;}});
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.destroyed=false;this.hidden=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{isDestroyed:()=>this.destroyed,getURL:()=>this.url||'',setWindowOpenHandler:handler=>this.open=handler,reload(){},setBackgroundThrottling:value=>this.throttling=value});windows.push(this);}
    loadURL(url){this.url=url;return Promise.resolve();}isDestroyed(){return this.destroyed;}isMinimized(){return false;}show(){this.hidden=false;}hide(){this.hidden=true;}focus(){}restore(){}
    close(){const event={prevented:false,preventDefault(){this.prevented=true;}};this.emit('close',event);if(!event.prevented){this.destroyed=true;this.emit('closed');app.emit('window-all-closed');}return event;}
    static fromWebContents(contents){return windows.find(w=>w.webContents===contents);}
  }
  class Tray extends EventEmitter{constructor(){super();trays.push(this);}setToolTip(){}setContextMenu(value){this.menu=value;}destroy(){this.destroyed=true;}}
  const browsing=new EventEmitter();Object.assign(browsing,{webRequest:{onBeforeRequest(){}},setPermissionCheckHandler(){},setPermissionRequestHandler(){}});
  const powerMonitor=new EventEmitter();
  const electron={app,BrowserWindow:Window,session:{fromPartition:()=>browsing},dialog:{showErrorBox(){},showMessageBox:async()=>({response:0})},shell:{openExternal:async()=>{}},Menu:{buildFromTemplate:x=>x,setApplicationMenu:x=>menu=x},Tray,powerMonitor,powerSaveBlocker:{start:value=>{starts.push(value);return 0;},stop:value=>stops.push(value)},
    utilityProcess:{fork(){const worker=new EventEmitter();worker.messages=[];worker.kill=()=>worker.emit('exit',1);worker.postMessage=message=>{worker.messages.push(message);if(message.type==='init')queueMicrotask(()=>worker.emit('message',{type:'ready',nonce:message.nonce,origin:'http://127.0.0.1:4173',instanceId:'synthetic-main-instance',projectRef:config.projectRef}));if(message.type==='stop')queueMicrotask(()=>worker.emit('exit',0));};workers.push(worker);queueMicrotask(()=>worker.emit('spawn'));return worker;}}};
  const runtime=await startEmbeddedDesktop(electron,{configPath,runtimeRoot:dir,platform:'win32'});
  t.after(async()=>{runtime.permanent.shutdown();await runtime.supervisor.stop();});
  return {runtime,app,windows,workers,trays,login,starts,stops,powerMonitor,get menu(){return menu;}};
}
test('the permanent Windows window hides on close while its server stays alive and tray restores it',async t=>{
  const f=await desktopFixture(t,{saved:true}),win=f.runtime.window;
  assert.equal(win.options.webPreferences.backgroundThrottling,false);assert.equal(win.options.webPreferences.sandbox,true);assert.equal(win.options.webPreferences.contextIsolation,true);assert.equal(win.options.webPreferences.nodeIntegration,false);
  assert.equal(win.close().prevented,true);assert.equal(win.hidden,true);assert.equal(win.destroyed,false);assert.equal(f.runtime.supervisor.running,true);assert.equal(f.app.quitCalls,undefined);
  f.trays[0].menu.find(x=>x.label==='Ouvrir Ludy').click();assert.equal(win.hidden,false);
  f.powerMonitor.emit('suspend');f.powerMonitor.emit('resume');assert.deepEqual(f.workers[0].messages.slice(-2).map(x=>x.type),['pause','resume']);
});
test('ordinary colleagues still quit on close; explicit permanent Quit stops the worker and releases wake lock',async t=>{
  const normal=await desktopFixture(t);assert.equal(normal.runtime.window.options.webPreferences.backgroundThrottling,true);
  assert.equal(normal.runtime.window.close().prevented,false);await tick();assert.equal(normal.app.quitCompleted,true);assert.equal(normal.workers[0].messages.at(-1).type,'stop');assert.deepEqual(normal.login,[]);
  const permanent=await desktopFixture(t,{saved:true});permanent.runtime.window.close();permanent.trays[0].menu.find(x=>x.label==='Quitter Ludy').click();await tick();
  assert.equal(permanent.app.quitCompleted,true);assert.equal(permanent.workers[0].messages.at(-1).type,'stop');assert.equal(permanent.runtime.supervisor.running,false);assert.deepEqual(permanent.stops,[0]);assert.equal(permanent.trays[0].destroyed,true);
});
