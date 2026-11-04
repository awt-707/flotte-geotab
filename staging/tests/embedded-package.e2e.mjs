// Run in a network namespace with loopback UP. Tests the actual packaged app,
// utilityProcess Node runtime and HTTP site without reaching production.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const executablePath=process.argv[2];if(!path.isAbsolute(executablePath||''))throw Error('Absolute packaged Linux executable required.');
const directory=await mkdtemp(path.join(tmpdir(),'ludy-embedded-e2e-'));
let app;const errors=[];
try{
  app=await electron.launch({executablePath,args:[],env:{...process.env,XDG_CONFIG_HOME:directory},timeout:40000});
  const page=await app.firstWindow({timeout:40000});page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'Bienvenue sur Ludy'}).waitFor({timeout:20000});
  assert.equal(page.url(),'http://127.0.0.1:4173/');
  assert.deepEqual(await page.evaluate(()=>({node:typeof require,bridge:typeof window.ludyClient,desktop:window.FLOTTE_CONFIG.DESKTOP_PRODUCTION,worker:typeof window.desktopWorkerSessionChanged,authRefresh:typeof window.createDesktopAuthRefresh})),{node:'undefined',bridge:'undefined',desktop:true,worker:'function',authRefresh:'function'});
  const health=await page.evaluate(()=>fetch('/health').then(r=>r.json()));assert.equal(health.environment,'production');assert.match(health.instanceId,/^[a-f0-9-]{36}$/);
  const processes=await app.evaluate(({app,BrowserWindow})=>({stateDir:app.getPath('userData'),utility:app.getAppMetrics().some(x=>x.type==='Utility'),safe:BrowserWindow.getAllWindows().every(w=>{const p=w.webContents.getLastWebPreferences();return p.sandbox&&p.contextIsolation&&!p.nodeIntegration;})}));
  assert.ok(processes.stateDir.startsWith(directory+path.sep));assert.equal(processes.utility,true);assert.equal(processes.safe,true);
  assert.equal(await page.evaluate(()=>fetch('/api/desktop/status').then(r=>r.status)),401);
  assert.equal(await page.evaluate(()=>fetch('/desktop-runtime/services.mjs').then(r=>r.status)),404);
  assert.equal(await page.evaluate(()=>fetch('/api/desktop/logout',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'}).then(r=>r.status)),403);
  const assets=await page.evaluate(async()=>Promise.all([...document.scripts].filter(s=>s.src).map(async s=>[new URL(s.src).pathname,(await fetch(s.src)).status])));
  assert.ok(assets.length>10);assert.ok(assets.every(([,status])=>status===200));
  await page.goto('http://127.0.0.1:4173/uber-extension/');
  await page.getByRole('heading',{name:'Installer l’extension Uber Fleet',exact:true}).waitFor();
  await app.evaluate(({BrowserWindow})=>{
    globalThis.extensionDownload=null;
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(event,item)=>{
      globalThis.extensionDownload={filename:item.getFilename(),options:item.getSaveDialogOptions(),bytes:item.getTotalBytes()};event.preventDefault();
    });
  });
  await page.getByRole('link',{name:'Télécharger l’extension Chrome / Edge'}).click();
  let download=null;
  for(let attempt=0;attempt<50&&!download;attempt++){download=await app.evaluate(()=>globalThis.extensionDownload);if(!download)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(download?.filename,'ludy-uber-chromium.zip');
  assert.equal(download.options.defaultPath,'ludy-uber-chromium.zip');assert.ok(download.bytes>1000);
  assert.deepEqual(errors,[]);
  await app.close();app=null;
  await assert.rejects(fetch('http://127.0.0.1:4173/health',{signal:AbortSignal.timeout(1000)}));
  console.log(JSON.stringify({ok:true,checks:16,packaged:true,embeddedServer:true,extensionDownload:true,productionRequests:0,network:'isolated-loopback',projectRef:health.projectRef}));
}finally{await app?.close();await rm(directory,{recursive:true,force:true});}
