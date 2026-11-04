// Electron UI smoke with synthetic pages only: no staging database or external providers.
// ELECTRON_TEST_EXECUTABLE=/path/to/electron node staging/tests/desktop-runtime.e2e.mjs
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=path.resolve(fileURLToPath(new URL('../desktop/',import.meta.url)));
const executablePath=process.env.ELECTRON_TEST_EXECUTABLE||path.join(desktop,'node_modules/electron/dist/electron');
await access(executablePath);
const dir=await mkdtemp(path.join(tmpdir(),'ludy-desktop-ui-'));
let application;
const errors=[];
function samplePdf(){
 const stream='BT /F1 16 Tf 40 80 Td (Ludy test document) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 250 140] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const xref=pdf.length;pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('');return pdf+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
async function launch(config,{healthy=true}={}){
 const profile=path.join(dir,'profile-'+Math.random().toString(36).slice(2)),configPath=path.join(profile,'server.json');
 await import('node:fs/promises').then(fs=>fs.mkdir(profile,{recursive:true}));await writeFile(configPath,JSON.stringify(config));
 const entry=path.join(profile,'entry.cjs');
 const html=`<!doctype html><html><body><h1>Ludy fictif</h1><button id="pdf">Voir le PDF</button><a id="download" href="/rapport.csv" download="rapport.csv">Exporter</a><script>document.querySelector('#pdf').onclick=()=>{const file=new Blob([${JSON.stringify(samplePdf())}],{type:'application/pdf'});window.open(URL.createObjectURL(file),'_blank','noopener');};</script></body></html>`;
 await writeFile(entry,`const electron=require('electron');const {app,session}=electron;app.setPath('appData',${JSON.stringify(profile)});globalThis.fixtureRequests=[];globalThis.fixtureDownloads=[];electron.dialog.showMessageBox=async()=>({response:0});const config=require(${JSON.stringify(path.join(desktop,'config.cjs'))}).validateConfig(${JSON.stringify(config)});app.once('ready',()=>{if(!config.configured)return;session.fromPartition(config.partition).protocol.handle('https',request=>{fixtureRequests.push(request.url);const pathname=new URL(request.url).pathname;if(pathname==='/health')return ${healthy?"Response.json({environment:'staging',project:'ludy-staging'})":"new Response('Login',{headers:{'content-type':'text/html'}})"};if(pathname==='/rapport.csv')return new Response('day,total\\n2026-11-03,12\\n',{headers:{'content-type':'text/csv','content-disposition':'attachment; filename="rapport.csv"'}});return new Response(${JSON.stringify(html)},{headers:{'content-type':'text/html'}});});});require(${JSON.stringify(path.join(desktop,'main.cjs'))}).startDesktop(electron,{configPath:${JSON.stringify(configPath)}}).then(runtime=>{globalThis.fixtureRuntime=runtime;session.fromPartition(config.partition).on('will-download',(event,item)=>{fixtureDownloads.push(item.getSaveDialogOptions());event.preventDefault();});});`);
 application=await electron.launch({executablePath,args:[entry],timeout:30000,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});
 const page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));return page;
}
try{
 let page=await launch({environment:'staging',serverUrl:null,appName:'Ludy Staging'});
 await page.getByRole('heading',{name:'Le staging n’est pas encore relié'}).waitFor();
 assert.equal(await page.locator('#retry').isVisible(),false);assert.equal(await page.locator('#browser').isVisible(),false);
 assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.ludyClient.state),'function');
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,540));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await application.close();application=null;
 page=await launch({environment:'staging',serverUrl:'https://staging.example.test',appName:'Ludy Staging'});
 await page.getByRole('heading',{name:'Ludy fictif'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>({bridge:typeof window.ludyClient,node:typeof window.require,process:typeof window.process})),{bridge:'undefined',node:'undefined',process:'undefined'});
 await page.waitForFunction(()=>Notification.permission==='granted');
 const notificationPermission=await page.evaluate(()=>Notification.permission);assert.equal(notificationPermission,'granted');
 assert.deepEqual(await application.evaluate(()=>fixtureRequests),['https://staging.example.test/health','https://staging.example.test/']);
 const windowsBefore=application.windows().length;await page.locator('#pdf').click();await new Promise(resolve=>setTimeout(resolve,700));assert.equal(application.windows().length,windowsBefore+1);
 const popup=application.windows().find(candidate=>candidate!==page);assert.match(popup.url(),/^blob:https:\/\/staging\.example\.test\//);
 assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(win=>{const p=win.webContents.getLastWebPreferences();return p.sandbox&&p.contextIsolation&&!p.nodeIntegration;})),true);
 await popup.close();await page.locator('#download').click();await page.waitForTimeout(200);
 const downloads=await application.evaluate(()=>fixtureDownloads);assert.equal(downloads.length,1);assert.equal(downloads[0].defaultPath,'rapport.csv');
 assert.equal(await page.evaluate(()=>typeof window.ludyClient),'undefined');await application.close();application=null;
 page=await launch({environment:'staging',serverUrl:'https://staging.example.test',appName:'Ludy Staging'},{healthy:false});
 await page.getByRole('heading',{name:'Serveur de test non reconnu'}).waitFor();assert.equal(await page.locator('#browser').isVisible(),false);assert.equal(await page.locator('#retry').isVisible(),true);
 assert.deepEqual(await application.evaluate(()=>fixtureRequests),['https://staging.example.test/health']);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:20,providerRequests:0,notificationPermission,scenarios:['missing-configuration','sandboxed-local-shell','verified-synthetic-server','no-remote-preload','PDF-popup','explicit-download-dialog','unverified-server']}));
}finally{if(application)await application.close();await rm(dir,{recursive:true,force:true});}
