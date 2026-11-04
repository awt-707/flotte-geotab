// Uses local auth/cache only; explicit history/report reads are intercepted with fictional data.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const credentials=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[],requests=[];let checks=0;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=','base64');
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.hostname==='tile.openstreetmap.org')return route.fulfill({contentType:'image/png',body:png});
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname.startsWith('/api/fleet/')&&request.method()!=='GET')return route.abort();
  return route.continue();
 });
 await page.route('**/api/fleet/geotab/history?*',async route=>{requests.push('history');const u=new URL(route.request().url()),from=u.searchParams.get('from'),to=u.searchParams.get('to'),key=u.searchParams.get('key'),start=Date.parse(from)+8*3600000,stop=start+1200000;
  await route.fulfill({json:{at:new Date().toISOString(),from,to,vehicle:{key,plate:'TEST-TRIP',model:'Véhicule de test'},trips:[{id:'trip-test',start:new Date(start).toISOString(),stop:new Date(stop).toISOString(),distance_km:12,drive_min:20,idle_min:0,max_speed:63,partial:false}],gps:[[start,0,33.6,-7.6],[start+600000,63,33.61,-7.59],[stop,0,33.62,-7.58]],events:[],summary:{km:12,fuel_l:.8,l100:6.67,drive_min:20,trips:1},coverage:{gps:'complete',trips:'complete',events:'complete',counters:'complete'},warnings:[]}});
 });
 await page.route('**/api/fleet/geotab/report?*',async route=>{requests.push('report');const u=new URL(route.request().url());await route.fulfill({json:{at:new Date().toISOString(),from:u.searchParams.get('from'),to:u.searchParams.get('to'),rows:[{key:'fixture',plate:'TEST-REPORT',model:'Test',km:12,fuel_l:.8,l100:6.67,drive_min:20,idle_min:null,trips:1,events:0,status:'partial',warnings:['Ralenti non transmis']}],totals:{km:12,fuel_l:.8,l100:6.67,drive_min:20,events:0},coverage:{vehicles:1,complete:0,partial:1,unavailable:0},warnings:['Certaines données sont indisponibles.']}});});
 await page.route('**/api/fleet/drivers/matches',route=>route.fulfill({json:{at:new Date().toISOString(),counts:{linked:0,unmatched:1,ambiguous:0,manual:0,vehicle_ready:0},rows:[{driver_id:'fixture',driver_name:'Chauffeur de test',status:'unmatched',reason:'Correspondance à vérifier',vehicle_key:null}]}}));
 await page.route('**/api/fleet/geotab/detail?*',async route=>{requests.push('detail');const u=new URL(route.request().url()),start=Date.parse(u.searchParams.get('from'))-180000,end=start+360000;await route.fulfill({json:{key:u.searchParams.get('key'),plate:'TEST-DETAIL',from:new Date(start).toISOString(),to:new Date(end).toISOString(),gps:[[start,20,33.6,-7.6],[start+180000,37,33.61,-7.59],[end,0,33.62,-7.58]],speed:[[start,20],[start+180000,37],[end,0]],road:null,events:[],coverage:{gps:'complete',speed:'complete'},warnings:[]}});});
 await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(credentials.email);await page.locator('#lp').fill(credentials.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
 await page.waitForFunction(()=>document.querySelector('#fleet-read-time')?.textContent.startsWith('Actualisé'));checks++;
 await page.screenshot({path:'staging/.local/screenshots/operations-cockpit-desktop.png',fullPage:true});
 await page.goto('http://127.0.0.1:4173/#/direct');await page.locator('#vlist .vcard').first().waitFor();
 const key=await page.locator('#vlist .vcard').first().getAttribute('data-vk');
 await page.evaluate(()=>{window.__opsMap=MAP;window.__opsCard=document.querySelector('#vlist .vcard');});
 await page.locator('#ops-map-search').focus();await page.waitForTimeout(2300);
 assert.equal(await page.evaluate(()=>MAP===window.__opsMap),true);assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#vlist .vcard')].find(c=>c.dataset.vk===window.__opsCard.dataset.vk)===window.__opsCard),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'ops-map-search');checks+=3;
 await page.locator('#toasts .x').evaluateAll(nodes=>nodes.forEach(n=>n.click()));
 await page.screenshot({path:'staging/.local/screenshots/operations-map-desktop.png',fullPage:true});
 await page.locator('#vlist .vcard').first().click();await page.locator('#ops-vehicle-drawer[open]').waitFor();assert.equal(await page.locator('#ops-drawer-content a[href*="trajets"]').count(),1);await page.keyboard.press('Escape');await page.locator('#ops-vehicle-drawer').waitFor({state:'detached'});checks+=2;
 await page.evaluate(key=>openAlertDetail({id:'EV|detail-test',vehicle_key:key,plate:'TEST-DETAIL',at:new Date().toISOString(),type:'Freinage brusque',severity:'Moyenne',cat:'Freinage',detail:'Événement fictif pour vérifier le détail',driver_name:'Chauffeur test'}),key);await page.locator('#adbody .adgrid').waitFor();assert.match(await page.locator('#adbody').innerText(),/Vitesse max/);await page.locator('#adlg .adclose').first().click();checks++;
 await page.goto('http://127.0.0.1:4173/#/trajets?key='+encodeURIComponent(key));await page.locator('#ops-history-form').waitFor();assert.equal(requests.filter(r=>r==='history').length,0,'historical reads require explicit action');await page.locator('#ops-history-form button').click();await page.locator('.ops-trip').waitFor();assert.equal(await page.locator('.ops-speed-chart').count(),1);await page.locator('.ops-trip').click();checks+=2;
 await page.locator('#ops-history-map .leaflet-tile-loaded').first().waitFor({timeout:8000}).catch(()=>{});
 await page.screenshot({path:'staging/.local/screenshots/operations-history-desktop.png',fullPage:true});
 await page.goto('http://127.0.0.1:4173/#/bilans');await page.locator('#ops-report-form button').click();await page.locator('.ops-report-table').waitFor();assert.match(await page.locator('#ops-report-content').innerText(),/Partielle/);const download=page.waitForEvent('download');await page.locator('#ops-export-report').click();assert.ok((await download).suggestedFilename().endsWith('.csv'));checks+=2;
 await page.goto('http://127.0.0.1:4173/#/rapprochements');await page.locator('.ops-match-card').waitFor();assert.match(await page.locator('.ops-match-card').innerText(),/Chauffeur de test/);checks++;
 await page.route('**/api/fleet/geotab/live',route=>route.fulfill({json:{source:{status:'healthy'},motion_alerts:[{id:'past-fixture',key,plate:'TEST-PAST',source:'uber',status:'resolved',distance_m:241,at:new Date().toISOString()}]}}));
 await page.goto('http://127.0.0.1:4173/#/alertes');await page.locator('#ops-alert-tabs').waitFor();await page.waitForFunction(()=>LIVE.motionHistory?.some(a=>a.id==='MOTION|past-fixture'));
await page.locator('[data-period="past"]').click();assert.match(await page.locator('#ops-alert-list').innerText(),/Épisode terminé/);await page.locator('#ops-alert-list [data-la]').first().click();assert.match(await page.locator('#adlg .panel').innerText(),/241 m/);await page.locator('#adlg .adclose').first().click();checks++;await page.unroute('**/api/fleet/geotab/live');
 await page.setViewportSize({width:390,height:844});
 for(const route of ['cockpit','direct','alertes','trajets','bilans','rapprochements']){await page.goto('http://127.0.0.1:4173/#/'+route);await page.locator('.ops-page,.ops-direct').waitFor();await page.waitForTimeout(180);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+' overflow');checks++;}
 await page.goto('http://127.0.0.1:4173/#/direct');await page.locator('#ops-map-search').waitFor();await page.evaluate(()=>themeApply('dark'));assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.ops-map-workspace')).backgroundColor),'rgb(27, 34, 48)');await page.evaluate(()=>[...OPS.notices.values()].forEach(n=>n.collapse()));await page.screenshot({path:'staging/.local/screenshots/operations-map-mobile-dark.png',fullPage:true});checks++;
 await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>themeApply('auto'));assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ops-muted').trim()),'#a0adbf');checks++;
 await page.clock.install();const before=await page.evaluate(()=>LIVE.alerts.map(a=>a.id));
 await page.evaluate(()=>{opsClearNotifications();let box=document.querySelector('#toasts');if(!box){box=document.createElement('div');box.id='toasts';document.body.appendChild(box);}const node=document.createElement('div');node.className='toast crit';node.innerHTML='<button class="x">×</button><b>Signalement de test</b>';box.prepend(node);opsTrackAlertToast(node,{id:'toast-test'},box);});assert.equal(await page.locator('.ops-new-alert').count(),1);await page.clock.fastForward(12500);assert.equal(await page.locator('.ops-new-alert').count(),0);assert.match(await page.locator('#ops-alert-digest').innerText(),/1 signalement reçu/);assert.deepEqual(await page.evaluate(()=>LIVE.alerts.map(a=>a.id)),before);await page.locator('#ops-alert-digest .x').click();assert.equal(await page.locator('#ops-alert-digest').count(),0);checks++;
 assert.deepEqual(errors,[]);assert.deepEqual(requests,['detail','history','report']);console.log(JSON.stringify({ok:true,checks,providerRequests:0,viewports:['1440x1000','390x844']}));
}finally{await browser.close();}
