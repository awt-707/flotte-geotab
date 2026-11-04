// Read-only integration smoke against the running local staging. No provider reads,
// business writes, saved browser state, or persistent test fixtures are allowed.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const credentials=JSON.parse(await readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(credentials.environment,'staging-local-only');
const base='http://127.0.0.1:4173';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=','base64');
const browser=await chromium.launch({executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium',headless:true});
const errors=[],blocked=[],failures=[],counts={};let checks=0;
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'fr-FR'}),page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{const url=new URL(response.url());if(response.status()>=400&&url.pathname.startsWith('/api/'))failures.push({path:url.pathname,status:response.status()});});
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(url.hostname==='tile.openstreetmap.org')return route.fulfill({contentType:'image/png',body:png});
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!['4173','57421'].includes(url.port)){blocked.push('external');return route.abort();}
  // Session bookkeeping is unrelated to the data being checked and is not stored.
  if(url.pathname==='/rest/v1/rpc/session_ping')return route.fulfill({json:null});
  const providerGet=/^\/api\/(?:parking\/geotab|fleet\/geotab\/(?:history|report|detail))(?:\/|$)/.test(url.pathname);
  if(providerGet||url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(method)||url.pathname.startsWith('/rest/v1/')&&!url.pathname.startsWith('/rest/v1/rpc/')&&!['GET','HEAD','OPTIONS'].includes(method)){
   blocked.push(url.pathname);return route.abort();
  }
  return route.continue();
 });
 await page.goto(base);await page.locator('#le').fill(credentials.email);await page.locator('#lp').fill(credentials.password);await page.locator('button[type="submit"]').click();
 await page.waitForFunction(()=>document.querySelector('#fleet-read-time')?.textContent.startsWith('Actualisé'));
 assert.equal(await page.evaluate(()=>NAV[0][0]),'cockpit');assert.equal(await page.evaluate(()=>firstAllowed()),'cockpit');assert.equal(await page.evaluate(()=>navEntries()[0].id),'cockpit');checks+=3;
 assert.equal(await page.evaluate(()=>navGroupOf('parkings')),'ops');assert.equal(await page.evaluate(()=>navGroupOf('performance-chauffeur')),'analyse');checks+=2;
 const cockpit=await page.evaluate(()=>({fleet:opsVehicles().length,gps:opsVehicles().filter(v=>v.geotab_id).length,drivers:fleetRosterSummary(opsCockpitScope(OPS.overview.drivers)).recent.length,metrics:[...document.querySelectorAll('#fleet-metrics .ops-stat')].map(n=>({label:n.querySelector('span').textContent,value:n.querySelector('strong').textContent}))}));
 assert.ok(cockpit.fleet>0);assert.ok(cockpit.gps<=cockpit.fleet);assert.equal(Number(cockpit.metrics.find(m=>m.label==='Chauffeurs suivis').value),cockpit.drivers);assert.equal(cockpit.metrics.find(m=>m.label==='Véhicules suivis GPS').value,`${cockpit.gps} / ${cockpit.fleet}`);checks+=4;
 Object.assign(counts,{vehicles:cockpit.fleet,gps:cockpit.gps,recentDrivers:cockpit.drivers});
 Object.assign(counts,await page.evaluate(()=>{
  const roster=opsCockpitScope(OPS.overview.drivers),summary=fleetRosterSummary(roster),online=opsOnlineDrivers(),states=['available','on_trip','to_pickup','on_break'];
  const perPlatform=Object.fromEntries(['uber','bolt'].map(provider=>[provider,{recent:summary.recent.filter(d=>fleetRecentObservation(d.sources?.[provider])).length,online:online.filter(d=>states.some(s=>fleetHasState(d,s,provider))).length}]));
  return {allProfiles:roster.length,onlineDrivers:online.length,sharedRecentDrivers:summary.shared,perPlatform};
 }));
 async function go(route,selector){await page.goto(base+'/#/'+route);await page.locator(selector).first().waitFor();await page.waitForFunction(()=>ZONE_NOTICES.timer!==null);}
 async function checkViewport(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,name+' exceeds viewport');checks++;}
 await go('parkings','#parking-vehicles tbody tr');
 const parking=await page.evaluate(()=>({total:PARKING.data.counts.total,gps:PARKING.data.counts.tracked,rows:document.querySelectorAll('#parking-vehicles tbody tr').length,links:[...document.querySelectorAll('#parking-vehicles a')].every(a=>new URLSearchParams(a.hash.split('?')[1]).has('k')),timer:!!PARKING.timer}));
 assert.equal(parking.total,cockpit.fleet);assert.equal(parking.rows,parking.total);assert.equal(parking.links,true);assert.equal(parking.timer,true);checks+=4;await checkViewport('parking desktop');
 await page.locator('#parking-filter').selectOption('no-gps');
 assert.equal(await page.locator('#parking-vehicles a').count(),parking.total-parking.gps);checks++;await page.locator('#parking-filter').selectOption('all');
 await go('performance-chauffeur','.performance-profile');
 assert.equal(await page.evaluate(()=>PARKING.map===null&&PARKING.timer===null&&PARKING.controller===null),true);assert.equal(await page.locator('.performance-metric').count(),8);assert.equal(await page.locator('#performance-error').textContent(),'');checks+=3;await checkViewport('performance desktop');
 await page.locator('#performance-source').selectOption('uber');await page.locator('#performance-filter button[type="submit"]').click();await page.locator('.performance-provider.uber').waitFor();
 assert.equal(await page.locator('#performance-from').inputValue(),await page.evaluate(()=>performanceLocalDay(Date.now()-7*86400000)));assert.equal(await page.locator('#performance-to').inputValue(),await page.evaluate(()=>performanceLocalDay(Date.now()-86400000)));checks+=2;
 await go('direct','#vlist .vcard');await page.waitForFunction(()=>OPS.overview!==null);
 assert.equal(await page.evaluate(()=>DRIVER_PERFORMANCE.map===null&&DRIVER_PERFORMANCE.controller===null),true);assert.equal(await page.locator('#vlist .vcard').count(),cockpit.fleet);assert.equal(await page.evaluate(()=>liveRows().length),cockpit.fleet);assert.equal(await page.locator('#ops-unlocated-drivers details').count(),1);checks+=4;await checkViewport('direct desktop');
 Object.assign(counts,await page.evaluate(()=>{const rows=liveRows(),online=opsOnlineDrivers(),unlocated=online.filter(d=>!d.vehicle_key||opsDriverForVehicle(d.vehicle_key)?.id!==d.id||!rows.some(r=>r.vehicle_key===d.vehicle_key&&r.live&&Number.isFinite(r.lat)&&Number.isFinite(r.lon)));return {onlineDriversAtMap:online.length,onlineWithoutConfirmedPosition:unlocated.length,recentVehiclePositions:rows.filter(r=>r.live&&Number.isFinite(r.lat)&&Number.isFinite(r.lon)).length};}));
 await page.evaluate(()=>{window.__smokeMap=MAP;window.__smokeCard=document.querySelector('#vlist .vcard');window.__smokeZoneTimer=ZONE_NOTICES.timer;});await page.locator('#ops-map-search').focus();await page.waitForTimeout(2200);
 assert.equal(await page.evaluate(()=>MAP===window.__smokeMap),true);assert.equal(await page.evaluate(()=>document.querySelector('#vlist .vcard[data-vk="'+window.__smokeCard.dataset.vk+'"]')===window.__smokeCard),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'ops-map-search');checks+=3;
 await page.locator('#vlist .vcard').first().click();await page.locator('#ops-vehicle-drawer[open]').waitFor();await go('cockpit','#fleet-search');
 assert.equal(await page.evaluate(()=>MAP===null&&document.querySelector('#ops-vehicle-drawer')===null),true);assert.equal(await page.evaluate(()=>ZONE_NOTICES.timer!==window.__smokeZoneTimer),true);checks+=2;
 await page.setViewportSize({width:390,height:844});
 for(const [route,selector] of [['parkings','#parking-vehicles tbody tr'],['performance-chauffeur?source=uber','.performance-profile'],['cockpit','#fleet-search'],['direct','#vlist .vcard']]){await go(route,selector);await checkViewport(route+' mobile');}
 // Route changes clean the previous map/controller; the global watcher is recreated once.
 await go('cockpit','#fleet-search');assert.equal(await page.evaluate(()=>PARKING.map===null&&PARKING.timer===null&&DRIVER_PERFORMANCE.map===null&&DRIVER_PERFORMANCE.controller===null&&MAP===null&&!!ZONE_NOTICES.timer),true);checks++;
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(blocked,[]);
 console.log(JSON.stringify({ok:true,checks,counts,providerRequests:0,businessWrites:0,viewports:['1440x1000','390x844']}));
}finally{await browser.close();}
