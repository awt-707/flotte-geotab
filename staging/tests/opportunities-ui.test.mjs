import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {chromium} from 'playwright';
let browser;const script=await readFile(new URL('../site/opportunities.js',import.meta.url),'utf8'),css=await readFile(new URL('../site/opportunities.css',import.meta.url),'utf8');
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});after(async()=>browser?.close());
const dateHelpers=(await readFile(new URL('../site/timezone.js',import.meta.url),'utf8'))+'\n'+(await readFile(new URL('../site/lib.js',import.meta.url),'utf8'))+'\nsetTzRules(STAGING_TZ_RULES);';
const event=()=>({id:'event-a',fingerprint:'version-one',city:'Casablanca',title:'Événement à examiner',place:'Lieu public',starts_at:'2026-11-02T18:00:00Z',ends_at:null,time_precision:'minute',status:'approved',source_id:'manual'});
async function fixture({role='admin',view='events'}={},work){
 const page=await browser.newPage({viewport:{width:390,height:844},timezoneId:'America/New_York'}),requests=[],errors=[];
 const state={events:[event()],fail:false,conflict:false,hold:null,fuel:{settings:{enabled:true,excess_pct:30,min_distance_km:10,cooldown_minutes:60},vehicles:[{key:'visible-car',plate:'VISIBLE-1',ref_l100:6}],status:{at:'2026-11-02T18:00:00Z',measured:1,unassigned:0,missing_reference:0,error:null}}};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://opportunities.invalid');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><style>:root{--panel:#fff;--line:#ddd;--ink:#1b2230;--bg:#f4f5f8;--muted:#64748b}*{box-sizing:border-box}body{margin:0;padding:12px;font:14px sans-serif}.panel{padding:16px;background:var(--panel)}input,select,button{padding:8px;font:inherit}button{max-width:100%}h1{font-size:25px}</style><main id="page"></main>'});
  const path=url.pathname.replace('/api/operations/',''),body=req.postDataJSON();requests.push({path,method:req.method(),body});
  assert.match(req.headers().authorization,/^Bearer synthetic-/);
  if(state.hold){const hold=state.hold;state.hold=null;await hold.promise;return route.fulfill({json:hold.value});}
  if(state.fail)return route.fulfill({status:403,json:{error:'Accès indisponible pour cette session.'}});
  if(path==='events')return route.fulfill({json:{events:state.events,manual_only:true}});
  if(path==='events/event-a/update'||path==='events/event-a/delete'){
   if(state.conflict){state.conflict=false;state.events[0]={...state.events[0],title:'Nouvelle version à examiner',fingerprint:'version-two'};return route.fulfill({status:409,json:{error:'Cet événement a changé. Relisez sa nouvelle version.'}});}
   assert.equal(body.fingerprint,state.events[0].fingerprint);
   if(path.endsWith('/delete'))state.events=[];else state.events[0]={...state.events[0],title:body.title,city:body.city,place:body.place,fingerprint:'version-three'};
   return route.fulfill({json:{ok:true}});
  }
  if(path==='events/manual'){
   if(!state.events.some(e=>e.id===body.request_id))state.events.push({...event(),id:body.request_id,title:body.title,city:body.city,place:body.place,status:'approved'});
   if(state.failCreateOnce){state.failCreateOnce=false;return route.fulfill({status:503,json:{error:'Réponse interrompue. Réessayez.'}});}
   return route.fulfill({json:{ok:true}});
  }
  if(path==='fuel')return route.fulfill({json:state.fuel});
  if(path==='fuel/settings'){Object.assign(state.fuel.settings,body);return route.fulfill({json:{ok:true}});}
  if(path==='fuel/reference'){assert.equal(body.vehicle_key,'visible-car');state.fuel.vehicles[0].ref_l100=body.ref_l100;return route.fulfill({json:{ok:true}});}
  throw Error('Unexpected local path '+path);
 });
 await page.goto('http://opportunities.invalid/');await page.clock.install({time:new Date('2026-11-02T12:00:00Z')});await page.addScriptTag({content:dateHelpers});await page.addStyleTag({content:css});await page.evaluate(role=>{
  window.S={session:{user:{id:'user-'+role},access_token:'synthetic-'+role},profile:{role}};window.ROUTING=1;window.$=s=>document.querySelector(s);window.isAdmin=()=>S.profile.role==='admin';window.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 },role);await page.addScriptTag({content:script});await page.evaluate(view=>view==='events'?pageEvents():pageFuelCoach(),view);
 try{await work({page,state,requests});assert.deepEqual(errors,[]);}finally{await page.evaluate(()=>growthCleanup());await page.close();}
}
async function fillEvent(page){await page.locator('#events-add').click();await page.locator('#events-manual [name="title"]').fill('Sortie culturelle');await page.locator('#events-manual [name="city"]').selectOption('Marrakech');await page.locator('#events-manual [name="place"]').fill('Rue du test, quartier test');await page.locator('[name="starts_local"]').fill('2026-11-02T19:00');await page.locator('[name="ends_local"]').fill('2026-11-02T21:00');}
test('manual creation requires address and submits Moroccan wall time from a different browser timezone',async()=>{
 await fixture({},async({page,state,requests})=>{
  assert.equal(await page.locator('#events-refresh,[data-decision]').count(),0);assert.doesNotMatch(await page.locator('#page').innerText(),/Agenda public|Collecte toutes/);
  await fillEvent(page);await page.locator('#events-manual [name="place"]').fill('');await page.locator('#events-manual [type="submit"]').click();assert.equal(requests.filter(r=>r.method==='POST').length,0);
  await page.locator('#events-manual [name="place"]').fill('Rue du test');await page.locator('#events-manual [type="submit"]').click();await page.locator('#events-status').filter({hasText:'ajouté et validé'}).waitFor();
  const body=requests.find(r=>r.path==='events/manual').body;assert.equal(body.starts_local,'2026-11-02T19:00');assert.equal(body.ends_local,'2026-11-02T21:00');assert.equal(body.city,'Marrakech');assert.match(body.request_id,/^[a-f0-9-]{36}$/);assert.equal(state.events.at(-1).status,'approved');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('#events-city').selectOption('Marrakech');assert.equal(await page.locator('[data-event-card]').count(),1);
 });
});
test('manual creation retries preserve the request id and cannot duplicate an uncertain save',async()=>{
 await fixture({},async({page,state,requests})=>{state.failCreateOnce=true;await fillEvent(page);await page.locator('#events-manual [type="submit"]').click();await page.locator('#events-manual-status').filter({hasText:'Réessayez'}).waitFor();await page.locator('#events-manual [type="submit"]').click();await page.locator('#events-status').filter({hasText:'ajouté et validé'}).waitFor();const writes=requests.filter(r=>r.path==='events/manual');assert.equal(writes.length,2);assert.equal(writes[0].body.request_id,writes[1].body.request_id);assert.equal(state.events.length,2);});
});
test('edit conflicts preserve the user draft and require reading the new version before saving',async()=>{
 await fixture({},async({page,state,requests})=>{await page.locator('[data-edit]').click();assert.equal(await page.locator('[name="starts_local"]').inputValue(),'2026-11-02T18:00');await page.locator('[name="title"]').fill('Mon brouillon');state.conflict=true;await page.locator('#events-manual [type="submit"]').click();await page.locator('#events-manual-status').filter({hasText:'a changé'}).waitFor();assert.equal(await page.locator('[name="title"]').inputValue(),'Mon brouillon');assert.equal(state.events[0].title,'Nouvelle version à examiner');await page.locator('[data-edit]').click();assert.equal(await page.locator('[name="title"]').inputValue(),'Nouvelle version à examiner');await page.locator('[name="title"]').fill('Version validée');await page.locator('#events-manual [type="submit"]').click();await page.locator('#events-status').filter({hasText:'modifié et validé'}).waitFor();assert.equal(requests.filter(r=>r.path.endsWith('/update'))[1].body.fingerprint,'version-two');assert.equal(state.events[0].title,'Version validée');});
});
test('deletion requires an explicit confirmation and uses the displayed version',async()=>{
 await fixture({},async({page,state,requests})=>{await page.locator('[data-delete]').click();await page.locator('[data-delete-cancel]').click();assert.equal(requests.filter(r=>r.path.endsWith('/delete')).length,0);await page.locator('[data-delete]').click();await page.clock.fastForward(30001);assert.equal(await page.locator('[data-delete-confirm]').count(),1);await page.locator('[data-delete-confirm]').click();await page.waitForFunction(()=>document.querySelector('#events-list').textContent.includes('Aucun événement'));assert.equal(state.events.length,0);assert.deepEqual(requests.find(r=>r.path.endsWith('/delete')).body,{fingerprint:'version-one'});});
});
test('viewer has no event mutation controls and denied reloads remove stale event cards',async()=>{
 await fixture({role:'viewer'},async({page,state,requests})=>{assert.equal(await page.locator('[data-edit],[data-delete],#events-add,#events-manual').count(),0);state.fail=true;await page.clock.fastForward(30001);await page.locator('#events-status').filter({hasText:'Accès indisponible'}).waitFor();assert.equal(await page.locator('.growth-card').count(),0);assert.ok(requests.every(r=>r.method==='GET'));});
});
test('fuel controls submit only visible reference and dedicated settings fields',async()=>{
 await fixture({view:'fuel'},async({page,state,requests})=>{assert.match(await page.locator('.growth-reference-list').innerText(),/VISIBLE-1/);assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE-OTHER-AGENCY/);await page.locator('[name="excess_pct"]').fill('40');await page.locator('#fuel-settings button').click();await page.locator('#fuel-settings-status').filter({hasText:'enregistrée'}).waitFor();assert.deepEqual(requests.find(r=>r.path==='fuel/settings').body,{enabled:true,excess_pct:40,min_distance_km:10,cooldown_minutes:60});await page.locator('[name="ref_l100"]').fill('7.2');await page.locator('.growth-reference button').click();await page.locator('.growth-reference span').filter({hasText:'Enregistré'}).waitFor();assert.deepEqual(requests.find(r=>r.path==='fuel/reference').body,{vehicle_key:'visible-car',ref_l100:7.2});assert.equal(state.fuel.vehicles[0].ref_l100,7.2);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));});
});
test('fuel viewer fields are read-only and cannot issue writes',async()=>{
 await fixture({view:'fuel',role:'viewer'},async({page,requests})=>{assert.equal(await page.locator('button').count(),0);for(const field of await page.locator('input').all())assert.equal(await field.isDisabled(),true);await page.evaluate(()=>document.querySelector('#fuel-settings').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.ok(requests.every(r=>r.method==='GET'));});
});
test('late data from a previous user cannot populate the new session',async()=>{
 await fixture({view:'fuel'},async({page,state})=>{let release;const promise=new Promise(r=>release=r);state.hold={promise,value:{...state.fuel,vehicles:[{key:'private',plate:'PRIVATE-OTHER-AGENCY',ref_l100:9}]}};const pending=page.evaluate(()=>pageFuelCoach());await page.waitForFunction(()=>GROWTH.controllers.size===1);await page.evaluate(()=>{growthCleanup();S.session={user:{id:'new-viewer'},access_token:'synthetic-viewer'};S.profile.role='viewer';ROUTING++;document.querySelector('#page').innerHTML='<p>Nouvelle session</p>';});release();await pending;assert.equal(await page.locator('#page').innerText(),'Nouvelle session');});
});
