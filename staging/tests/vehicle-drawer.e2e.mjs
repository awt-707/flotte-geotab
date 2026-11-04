// Fictional live observations over local reference vehicles; no provider requests or connector mutations.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const c=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(c.environment,'staging-local-only');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
let key=null,phase='active',rosterError=false,conflict=false,requests=0,checks=0,providerRequests=0,mutations=0;
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
   if(url.pathname.startsWith('/api/fleet/')&&req.method()!=='GET'){mutations++;return route.abort();}
   if(/\/api\/fleet\/geotab\/(history|report|detail|start)/.test(url.pathname)){providerRequests++;return route.abort();}
   return route.continue();
 });
 await page.route('**/api/fleet/overview',async route=>{if(rosterError)return route.fulfill({status:503,json:{error:'Synthetic roster outage'}});const at=new Date().toISOString();await route.fulfill({json:{at,sources:[{id:'bolt',status:'healthy',last_success_at:at,stale_after_s:180}],drivers:key?[{id:'synthetic-driver',vehicle_key:key,ludy_driver_code:'TEST',name:'Current Driver',vehicle_link_method:'manual',vehicle_conflict:conflict,sources:{bolt:{vehicle_label:'SELECTED-123',evidence:{vehicle_model:'Hyundai Sonata',vehicle_origin:'bolt_selected'},status:phase==='resolved'?'on_trip':'offline',observed_at:at,stale_after_s:180}}}]:[],alerts:[],settings:{}}});});
 await page.route('**/api/fleet/geotab/live',async route=>{
   requests++;if(phase==='network-error'){await route.fulfill({status:503,json:{error:'Synthetic local outage'}});return;}
   const at=new Date().toISOString();await route.fulfill({json:{source:{configured:true,polling:true,status:'healthy',last_success_at:at,stale_after_s:20,telemetry_status:'healthy',interval_s:2},
    vehicles:key?[{key,plate:'TEST-CAR',at,state:'En route',speed:9,lat:33.6,lon:-7.6,ign_on:phase==='engine-off'?false:true,fresh:true}]:[],
    events:[],telemetry:key?{[key]:{at:phase==='stale-telemetry'?new Date(Date.now()-300000).toISOString():at,km:24,fuel_l:1.2,fresh:phase!=='stale-telemetry'}}:{},motion_alerts:key?[{id:'synthetic-incident',key,plate:'TEST-CAR',driver_name:'Current Driver',source:'bolt',distance_m:300,status:phase==='resolved'?'resolved':'open',at,ign_on:true}]:[]}});
 });
 await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(c.email);await page.locator('#lp').fill(c.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
 key=await page.evaluate(()=>Object.keys(S.veh)[0]);assert.ok(key);
 await page.locator('#fleet-refresh').click();await page.locator('#fleet-roster-content').getByText('Current Driver',{exact:true}).waitFor();
 await page.locator('#fleet-search').fill('Sonata');
 assert.match(await page.locator('#fleet-roster-content').innerText(),/SELECTED-123 · Hyundai Sonata/);assert.match(await page.locator('#fleet-roster-content').innerText(),/Sélection Bolt · affectation à confirmer/);checks+=2;
 await page.goto('http://127.0.0.1:4173/#/direct');await page.locator('#vlist .vcard').first().waitFor();
 await page.waitForFunction(()=>OPS.overview?.drivers?.some(d=>d.name==='Current Driver'));
 await page.evaluate(()=>{contractAt=()=>({name:'Imported Driver',num:'IMPORT-OLD',client_code:'OLD',start_at:new Date(Date.now()-3600000).toISOString(),end_at:new Date(Date.now()+3600000).toISOString()});paintOperationsDirect();});
 await page.locator('#vlist .vcard').first().click();await page.locator('#ops-vehicle-drawer[open]').waitFor();
 assert.equal(await page.getByRole('dialog',{name:'TEST-CAR',exact:true}).count(),1);checks++;
 const drawer=page.locator('#ops-drawer-content');assert.match(await drawer.innerText(),/Current Driver/);assert.match(await drawer.innerText(),/Mouvement du véhicule · Geotab/);assert.match(await drawer.innerText(),/Disponibilité sur les plateformes/);checks+=3;
 assert.match(await drawer.locator('.ops-drawer-platforms').innerText(),/SELECTED-123 · Hyundai Sonata/);assert.match(await drawer.locator('.ops-drawer-platforms').innerText(),/Sélection Bolt · affectation à confirmer/);checks+=2;
 rosterError=true;await page.evaluate(async()=>{OPS.overviewAt=0;await opsRefreshMapRoster(ROUTING);});
 assert.match(await page.locator('#ops-roster-status').innerText(),/Actualisation des affectations interrompue/);assert.equal(await page.evaluate(()=>LIVE.localSource.status),'healthy');checks+=2;
 rosterError=false;await page.evaluate(async()=>{OPS.overviewAt=0;await opsRefreshMapRoster(ROUTING);});assert.equal(await page.locator('#ops-roster-status').innerText(),'');checks++;
 conflict=true;await page.evaluate(async()=>{OPS.overviewAt=0;await opsRefreshMapRoster(ROUTING);});
 assert.match(await drawer.locator('.ops-drawer-driver').innerText(),/Conflit d’affectation à vérifier/);assert.doesNotMatch(await drawer.locator('.ops-drawer-driver').innerText(),/Current Driver|Affectation actuelle confirmée/);checks+=2;
 conflict=false;await page.evaluate(async()=>{OPS.overviewAt=0;await opsRefreshMapRoster(ROUTING);});
 const stat=label=>drawer.locator('.ops-stat').filter({has:page.locator('span',{hasText:new RegExp('^'+label+'$')})}).locator('strong');
 assert.match(await stat('Distance du jour').innerText(),/^24\s*km$/);assert.match(await stat('Consommation').innerText(),/^5\s*L\/100$/);checks+=2;
 await drawer.locator('#ops-contract-summary').click();await page.evaluate(()=>{window.__drawerSummary=document.querySelector('#ops-contract-summary');});
 await page.waitForFunction(()=>document.querySelector('#ops-contract-summary')!==window.__drawerSummary);
 assert.equal(await drawer.locator('.ops-contract-reference').evaluate(d=>d.open),true);assert.equal(await page.evaluate(()=>document.activeElement?.id),'ops-contract-summary');checks+=2;
 assert.equal(await drawer.locator('.ops-stat').filter({has:page.locator('span', {hasText:/^Contact$/})}).locator('strong').innerText(),'Mis');checks++;
 const popup=await page.evaluate(key=>LIVE.markers[key].getPopup().getContent(),key);assert.match(popup,/Current Driver/);assert.doesNotMatch(popup,/Imported Driver|IMPORT-OLD/);checks++;
 assert.match(await page.locator('#vlist .ops-vehicle-state').first().innerText(),/En mouvement · Geotab/);assert.equal(await page.locator('#vlist .has-critical').count(),1);assert.equal(await page.locator('.ops-new-alert,#ops-alert-digest').count(),1);checks+=3;
 phase='stale-telemetry';await page.waitForFunction(()=>LIVE.drv[Object.keys(LIVE.pos)[0]]?.fresh===false);
 assert.equal(await stat('Distance du jour').innerText(),'—');assert.equal(await stat('Consommation').innerText(),'—');assert.match(await stat('Vitesse').innerText(),/^9\s*km\/h$/);assert.match(await drawer.locator('.ops-freshness').innerText(),/données à actualiser/);checks+=4;
 phase='engine-off';await page.waitForFunction(()=>LIVE.pos[Object.keys(LIVE.pos)[0]]?.ign_on===false);
 assert.equal(await drawer.locator('.ops-stat').filter({has:page.locator('span', {hasText:/^Contact$/})}).locator('strong').innerText(),'Coupé');assert.match(await drawer.innerText(),/contact mis au relevé de l’alerte/);checks+=2;
 phase='resolved';await page.waitForFunction(()=>LIVE.motionHistory?.some(a=>a.status==='resolved'));
 assert.equal(await page.locator('#vlist .has-critical').count(),0);assert.equal(await drawer.locator('.ops-alert-card').count(),0);assert.equal(await page.locator('.ops-new-alert,#ops-alert-digest').count(),0);checks+=3;
 phase='active';await page.waitForFunction(()=>LIVE.alerts.some(a=>a.motion));assert.equal(await page.locator('#vlist .has-critical').count(),1);checks++;
 phase='network-error';await page.waitForFunction(()=>LIVE.localSource.status==='error');
 assert.equal(await page.locator('#vlist .has-critical').count(),0);assert.equal(await page.locator('.ops-new-alert,#ops-alert-digest').count(),0);assert.equal(await drawer.locator('.ops-stat').filter({has:page.locator('span', {hasText:/^Contact$/})}).locator('strong').innerText(),'Inconnu');checks+=3;
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#ops-vehicle-drawer'));assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('vcard')),true);checks++;
 await page.setViewportSize({width:390,height:640});await page.locator('#vlist .vcard').first().click();await page.getByRole('dialog',{name:'TEST-CAR',exact:true}).waitFor();
 await page.locator('#ops-contract-summary').click();await page.locator('#ops-vehicle-drawer').evaluate(d=>{d.scrollTop=d.scrollHeight;});
 const box=await page.getByRole('button',{name:'Fermer le véhicule'}).boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=640,'close stays visible at the bottom of the mobile drawer');
 assert.equal(await page.locator('#ops-vehicle-drawer').evaluate(d=>d.scrollWidth<=d.clientWidth),true);checks+=2;
 await page.getByRole('button',{name:'Fermer le véhicule'}).click();await page.waitForFunction(()=>!document.querySelector('#ops-vehicle-drawer'));checks++;
 assert.equal(providerRequests,0);assert.equal(mutations,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,localSnapshots:requests,providerRequests,mutations}));
} finally {await browser.close();}
