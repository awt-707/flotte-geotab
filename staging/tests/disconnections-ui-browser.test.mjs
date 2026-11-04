import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const files=Object.fromEntries(await Promise.all(['fleet.js','operations.js','disconnections.js','operations.css','disconnections.css'].map(async name=>[name,await readFile(new URL('../site/'+name,import.meta.url),'utf8')])));
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>{await browser?.close();});
const incident=(id='incident-a')=>({id,driver_id:'driver-a',driver_name:'Synthetic Driver',source:'uber',vehicle_key:null,plate:null,status:'open',disconnected_at:'2026-10-31T10:00:00Z',observed_online_at:'2026-10-31T09:59:00Z'});
async function fixture({enabled=true,alerts=[incident()],viewport={width:1200,height:900}}={},work){
 const page=await browser.newPage({viewport}),errors=[],calls=[],state={enabled,policy:'any',duty_mode:'contract',alerts,warnings:[],coverage:{expected_drivers:2},fail:false,denied:false,drivers:[{id:'driver-a',name:'Authorized Driver'}],holdNext:null};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!=='http://fixture.invalid')throw new Error('Unexpected external request');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Disconnection fixture</title><style>:root{--panel:#fff;--bg:#f6f7f9;--line:#e6e9ef;--ink:#202736}:root[data-theme="dark"]{--panel:#1b2230;--bg:#101722;--line:#303949;--ink:#e5eaf2}*{box-sizing:border-box}body{margin:0;font:14px sans-serif;background:var(--bg);color:var(--ink)}main{max-width:1200px;margin:0 auto;padding:24px}button,select{font:inherit;padding:9px}button{cursor:pointer}.ghost{border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink)}button:disabled{opacity:.5}a{color:inherit}</style><main id="page"></main>'});
  const path=url.pathname.replace('/api/fleet/','');calls.push({path,method:request.method(),body:request.postDataJSON()});
  if(path==='disconnections/settings'){Object.assign(state,request.postDataJSON());return route.fulfill({json:{enabled:state.enabled,policy:state.policy,duty_mode:state.duty_mode}});}
  if(path==='disconnections'){
   if(state.holdNext){const hold=state.holdNext;state.holdNext=null;await hold.promise;try{return await route.fulfill({json:hold.value});}catch{return;}}
   if(state.fail||state.denied)return route.fulfill({status:state.denied?403:503,json:{error:'Synthetic backend failure'}});
   return route.fulfill({json:{at:new Date().toISOString(),enabled:state.enabled,policy:state.policy,duty_mode:state.duty_mode,coverage:state.coverage,warnings:state.warnings,alerts:state.alerts}});
  }
  if(path==='overview')return route.fulfill({json:{drivers:state.drivers,sources:[],alerts:[]}});
  throw new Error('Unexpected local request '+path);
 });
 await page.goto('http://fixture.invalid/');await page.clock.install();
 await page.evaluate(()=>{
  window.S={session:{user:{id:'user-a'},access_token:'synthetic-token-a'},vehList:[],veh:{},timers:[]};window.ROUTING=1;window.LIVE={alerts:[],motionHistory:[],localSource:{status:'error'}};
  window.$=selector=>document.querySelector(selector);window.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  window.workspaceIcon=()=>'';window.fmtDT=value=>new Date(value).toISOString();window.fmtHMS=window.fmtDT;window.normTxt=value=>String(value??'').toLowerCase();window.inAgency=()=>()=>true;window.isAdmin=()=>true;window.GRAV_CLS={Critique:'crit',Haute:'err',Moyenne:'warn'};
  window.msg=text=>'<p>'+esc(text)+'</p>';window.badge=text=>esc(text);window.plate=text=>esc(text);window.historyCalls=[];window.onNewAlert=()=>{throw new Error('Geotab notification path must not be used');};
 });
 for(const name of ['operations.css','disconnections.css'])await page.addStyleTag({content:files[name]});
 for(const name of ['fleet.js','operations.js','disconnections.js'])await page.addScriptTag({content:files[name]});
 await page.evaluate(async()=>{fleetHistory=async(driver,my)=>historyCalls.push({id:driver.id,name:driver.name,my});await pageOperationsAlerts();disconnectionsStart(ROUTING);});
 await page.waitForFunction(()=>DISCONNECTIONS.snapshot!==null);
 try{await work({page,state,calls,errors});assert.deepEqual(errors,[]);}finally{await page.evaluate(()=>disconnectionsReset());await page.close();}
}
async function poll(page){await page.clock.fastForward(2100);await page.waitForFunction(()=>!DISCONNECTIONS.loop?.busy);}

test('an urgent disconnection without vehicle is deduplicated, survives Geotab refreshes, and becomes retained history on return online',async()=>{
 await fixture({},async({page,state,calls})=>{
  assert.equal(await page.locator('.disconnection-toast').count(),1);assert.equal(await page.locator('[data-disconnections-view] .urgent').count(),1);
  assert.match(await page.locator('.disconnection-toast').innerText(),/Synthetic Driver/);assert.equal(await page.evaluate(()=>LIVE.alerts.length),0);
  await poll(page);await poll(page);assert.equal(await page.locator('.disconnection-toast').count(),1);assert.equal(calls.filter(c=>c.path==='disconnections').length,3);
  await page.evaluate(()=>{LIVE.alerts=[];LIVE.motionHistory=[];operationsSnapshot();});assert.equal(await page.locator('[data-disconnections-view] .urgent').count(),1);
  state.alerts=[{...incident(),status:'resolved'}];await poll(page);assert.equal(await page.locator('.disconnection-toast').count(),0);assert.equal(await page.locator('[data-disconnections-view] .urgent').count(),0);
  await page.locator('[data-dc-history] summary').click();assert.match(await page.locator('.disconnection-history').innerText(),/Épisode terminé/);assert.match(await page.locator('.disconnection-history').innerText(),/Synthetic Driver/);
  assert.ok(calls.every(c=>c.path==='disconnections'));
 });
});
test('alerts keep polling outside the map and route changes preserve deduplication while hidden pages stop reads',async()=>{
 await fixture({},async({page,state,calls})=>{
  await page.evaluate(()=>{disconnectionsStop();ROUTING++;document.querySelector('#page').innerHTML='<p>Contrats</p>';disconnectionsStart(ROUTING);});await page.waitForFunction(()=>!DISCONNECTIONS.loop.busy);
  assert.equal(await page.locator('.disconnection-toast').count(),1);
  state.alerts=[incident(),{...incident('incident-b'),source:'bolt'}];await poll(page);assert.equal(await page.locator('.disconnection-toast').count(),2);
  const before=calls.length;await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.fastForward(6100);assert.equal(calls.length,before);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>!DISCONNECTIONS.loop.busy);assert.equal(calls.length,before+1);
  await page.evaluate(()=>disconnectionsStop());await page.clock.fastForward(6100);assert.equal(calls.length,before+1);
 });
});
test('permission loss clears notices and data; a late response from an old user cannot repopulate another session',async()=>{
 await fixture({},async({page,state})=>{
  state.denied=true;await poll(page);assert.equal(await page.locator('.disconnection-toast').count(),0);assert.doesNotMatch(await page.locator('[data-disconnections-view]').innerText(),/Synthetic Driver/);
  state.denied=false;let release;const promise=new Promise(resolve=>release=resolve);state.holdNext={promise,value:{at:new Date().toISOString(),enabled:true,policy:'any',duty_mode:'contract',coverage:{},warnings:[],alerts:[incident('old-user')]}};
  await page.clock.fastForward(2100);await page.waitForFunction(()=>DISCONNECTIONS.loop.busy);state.alerts=[];
  await page.evaluate(()=>{disconnectionsReset();S.session={user:{id:'user-b'},access_token:'synthetic-token-b'};ROUTING++;disconnectionsStart(ROUTING);});release();await page.waitForFunction(()=>DISCONNECTIONS.owner==='user-b'&&!DISCONNECTIONS.loop.busy);
  assert.equal(await page.locator('.disconnection-toast').count(),0);assert.equal(await page.evaluate(()=>DISCONNECTIONS.snapshot.alerts.length),0);assert.doesNotMatch(await page.locator('[data-disconnections-view]').innerText(),/Synthetic Driver/);
  await page.evaluate(()=>{disconnectionsReset();S.session=null;ROUTING++;});await page.clock.fastForward(6100);assert.equal(await page.evaluate(()=>DISCONNECTIONS.owner),null);
 });
});
test('driver buttons use a fresh authorized overview and never build a driver from alert text',async()=>{
 await fixture({},async({page,state,calls})=>{
  await page.locator('[data-disconnections-view] [data-dc-driver]').first().click();await page.waitForFunction(()=>historyCalls.length===1);
  assert.deepEqual(await page.evaluate(()=>historyCalls[0]),{id:'driver-a',name:'Authorized Driver',my:1});
  state.drivers=[];await page.locator('[data-disconnections-view] [data-dc-driver]').first().click();await page.locator('.disconnection-card .disconnection-action-status').filter({hasText:'plus accessible'}).waitFor();assert.equal(await page.evaluate(()=>historyCalls.length),1);
  assert.equal(calls.filter(c=>c.path==='overview').length,2);
 });
});
test('a slow snapshot never overlaps another poll and dismissing its notification does not discard the incident or show it again',async()=>{
 await fixture({},async({page,state,calls})=>{
  await page.locator('.disconnection-close').click();assert.equal(await page.locator('.disconnection-toast').count(),0);
  let release;const promise=new Promise(resolve=>release=resolve);state.holdNext={promise,value:{at:new Date().toISOString(),enabled:true,policy:'any',duty_mode:'contract',coverage:{},warnings:[],alerts:[incident()]}};
  await page.clock.fastForward(2100);await page.waitForFunction(()=>DISCONNECTIONS.loop.busy);const before=calls.length;
  await page.clock.fastForward(4100);assert.equal(calls.length,before);release();await page.waitForFunction(()=>!DISCONNECTIONS.loop.busy);
  assert.equal(await page.locator('.disconnection-toast').count(),0);assert.equal(await page.locator('[data-disconnections-view] .urgent').count(),1);
 });
});
test('connector controls stay disabled by default until saved and call only their dedicated local settings endpoint',async()=>{
 await fixture({enabled:false},async({page,state,calls})=>{
  await page.evaluate(()=>{document.querySelector('#page').innerHTML=disconnectionsSettingsHtml();disconnectionsPaintSettings();});
  assert.equal(await page.locator('#disconnections-enabled').isChecked(),false);assert.equal(await page.locator('.disconnection-toast').count(),0);
  assert.equal(await page.locator('#disconnections-policy').inputValue(),'any');assert.equal(await page.locator('#disconnections-duty').inputValue(),'contract');assert.match(await page.locator('.disconnection-settings').innerText(),/Un compte jamais connecté/);
  assert.match(await page.locator('.disconnection-settings').innerText(),/sans affectation véhicule actuelle sur la plateforme/);assert.match(await page.locator('.disconnection-settings').innerText(),/contrat doit identifier un véhicule reconnu dans Ludy/);assert.match(await page.locator('.disconnection-settings').innerText(),/prochaine observation reçue d’Uber ou Bolt/);
  await page.locator('#disconnections-enabled').check();await page.locator('#disconnections-settings button[type="submit"]').click();await page.locator('#disconnections-settings-result').filter({hasText:'Suivi enregistré'}).waitFor();
  assert.equal(state.enabled,true);assert.deepEqual(calls.filter(c=>c.method==='POST'),[{path:'disconnections/settings',method:'POST',body:{enabled:true,policy:'any',duty_mode:'contract'}}]);
  assert.equal(await page.locator('.disconnection-toast').count(),1);
 });
});
test('stale snapshots lose urgency without deleting dated incidents and warning text stays inert on mobile and in dark mode',async()=>{
 await fixture({viewport:{width:390,height:844}},async({page,state})=>{
  state.coverage={expected_drivers:4};state.warnings=[{code:'contracts_excluded',count:6,message:'Contrats écartés.'},{code:'unknown_vehicle',count:2,message:'Véhicules non reconnus.'},{code:'unknown',count:1,message:'<img src=x onerror=bad()> Un état reste à confirmer.'}];await poll(page);
  assert.equal(await page.locator('.disconnection-warnings img').count(),0);assert.match(await page.locator('.disconnection-warnings').innerText(),/Un état reste/);
  assert.match(await page.locator('.disconnection-summary').innerText(),/4 chauffeurs attendus/);assert.match(await page.locator('.disconnection-warnings').innerText(),/6 · Contrats écartés/);assert.match(await page.locator('.disconnection-warnings').innerText(),/2 · Véhicules non reconnus/);assert.match(await page.locator('.disconnections-panel').innerText(),/prochaine observation reçue d’Uber ou Bolt/);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');assert.equal(await page.locator('.disconnections-panel').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(27, 34, 48)');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  state.fail=true;await poll(page);assert.equal(await page.locator('.disconnection-toast').count(),0);assert.equal(await page.locator('[data-disconnections-view] .urgent').count(),0);
  await page.locator('[data-dc-history] summary').click();assert.match(await page.locator('.disconnection-history').innerText(),/Dernier état reçu/);
 });
});
