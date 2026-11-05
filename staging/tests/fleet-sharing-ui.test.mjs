import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';

const scripts=await Promise.all(['fleet.js','direct.js','operations.js'].map(name=>readFile(new URL('../site/'+name,import.meta.url),'utf8')));

test('colleague windows show central connectors and refresh persisted alerts without a GPS poll',async t=>{
 const executablePath=process.env.LUDY_TEST_CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
 const chromiumSandbox=!(process.platform==='linux'&&process.getuid?.()===0);
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox});t.after(()=>browser.close());
 const calls=[],errors=[],stamp=new Date().toISOString();let incident='open';
 const shared=id=>({id,status:'healthy',configured:true,polling:true,collectionRemote:true,last_success_at:stamp});
 const pages=[];
 for(let windowId=0;windowId<2;windowId++){
  const context=await browser.newContext(),page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,'http://127.0.0.1:4173');
   if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:'<!doctype html><main id="page"></main>'});
   assert.equal(request.method(),'GET','no collection mutation may leave a colleague window');calls.push({windowId,path:url.pathname});
   const endpoint=url.pathname.replace('/api/fleet/','');let data;
   if(endpoint==='overview')data={sources:['uber','bolt','geotab','myclicar'].map(shared),drivers:[],alerts:[],settings:{}};
   else if(endpoint==='bolt/config')data={configured:false};
   else if(endpoint==='geotab/status'||endpoint==='myclicar/status')data=shared(endpoint.split('/')[0]);
   else if(endpoint==='validation/status')data={status:'not_started'};
   else if(endpoint==='texat/status')data={configured:false};
   else if(endpoint==='alerts')data={source:shared('geotab'),events:[],motion_alerts:[{id:'persisted',key:'car',plate:'TEST-001',source:'uber',driver_name:'Synthetic colleague',status:incident,distance_m:240,at:stamp}],motion_watches:[],motion_coverage:null};
   else assert.fail('Unexpected fixture endpoint: '+endpoint);
   return route.fulfill({json:data});
  });
  await page.goto('http://127.0.0.1:4173/fixture');await page.clock.install();
  await page.addScriptTag({content:`window.FLOTTE_CONFIG={GEOTAB_LOCAL:true,DESKTOP_PRODUCTION:true};const CFG=FLOTTE_CONFIG,MIN=60000,HOUR=3600000,STATE_CLS={},GRAV_CLS={Critique:'crit'};
   let ROUTING=1;window.fixturePage='connecteurs';const pageOf=()=>window.fixturePage;
   const S={session:{user:{id:'synthetic-colleague'},access_token:'synthetic-token'},sessionRevision:1,timers:[],veh:{car:{key:'car',plate:'TEST-001'}},vehList:[],rules:{},P:{}};
   const $=selector=>document.querySelector(selector),esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),normTxt=value=>String(value??'').toLowerCase();
   const isAdmin=()=>true,workspaceIcon=()=>'',parts=()=>({hour:'10',minute:'00',second:'00'}),fmtDTY=()=> '5 novembre 10:00',fmtDT=fmtDTY;
   const msg=(text,tone)=>'<p class="'+tone+'">'+text+'</p>',badge=text=>'<span>'+esc(text)+'</span>',plate=text=>'<b>'+esc(text)+'</b>',inAgency=()=>key=>key==='car',onNewAlert=()=>{};
  `});
  for(const content of scripts)await page.addScriptTag({content});assert.deepEqual(errors,[]);
  await page.evaluate(()=>pageConnecteurs());
  assert.equal(await page.locator('#geotab-health').innerText(),'Données partagées · Connecté');assert.equal(await page.locator('#myclicar-health').innerText(),'Données partagées · Connecté');
  assert.equal(await page.locator('#geotab-password').isDisabled(),true);assert.equal(await page.locator('#myclicar-start').isVisible(),false);
  await page.evaluate(async()=>{await document.querySelector('#geotab-start').onclick();await document.querySelector('#myclicar-stop').onclick();});
  await page.evaluate(async()=>{
   ROUTING++;fleetCancelReads();operationsCleanup();S.timers.forEach(clearInterval);S.timers=[];window.fixturePage='alertes';
   LIVE.pos={car:{lat:33.5,lon:-7.5}};LIVE.motionCoverage={linked_drivers:2};
   await pageOperationsAlerts();startFleetAlerts(ROUTING);
  });
  await page.locator('#ops-alert-list .critical').waitFor();assert.match(await page.locator('#ops-alert-list').innerText(),/TEST-001.*Synthetic colleague/s);
 }
 assert.equal(calls.filter(call=>call.path==='/api/fleet/alerts').length,2);
 assert.equal(calls.some(call=>call.path==='/api/fleet/geotab/live'),false);
 incident='resolved';
 for(const page of pages){
  await page.clock.runFor(15001);await page.waitForFunction(()=>LIVE.motionHistory?.[0]?.status==='resolved');
  await page.locator('[data-period="past"]').click();assert.match(await page.locator('#ops-alert-list').innerText(),/Épisode terminé/);
  assert.deepEqual(await page.evaluate(()=>({position:LIVE.pos.car,coverage:LIVE.motionCoverage})),{position:{lat:33.5,lon:-7.5},coverage:{linked_drivers:2}});
 }
 const reads=calls.filter(call=>call.path==='/api/fleet/alerts').length;
 await pages[0].evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));await pages[0].clock.runFor(15001);
 assert.equal(calls.filter(call=>call.path==='/api/fleet/alerts').length,reads,'hidden windows do not poll alerts');
 await pages[1].evaluate(()=>{ROUTING++;S.session=null;S.sessionRevision++;fleetCancelReads();operationsCleanup();S.timers.forEach(clearInterval);S.timers=[];});await pages[1].clock.runFor(15001);
 assert.equal(calls.filter(call=>call.path==='/api/fleet/alerts').length,reads,'logout stops this window without any shared request state');
 assert.deepEqual(errors,[]);
});
