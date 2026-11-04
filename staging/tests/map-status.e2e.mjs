// Local cached fleet only; map tiles are delayed or failed in the browser, with no provider reads.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const credentials=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=','base64');
const errors=[],held=[];let mode='hold',providerRequests=0;
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'});page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://tile.openstreetmap.org/**',async route=>{if(mode==='hold'){held.push(route);return;}if(mode==='fail')return route.abort('failed');await route.fulfill({contentType:'image/png',body:png});});
 page.on('request',request=>{if(/\/api\/fleet\/geotab\/(history|report|detail|start)/.test(request.url()))providerRequests++;});
 await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(credentials.email);await page.locator('#lp').fill(credentials.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
 await page.goto('http://127.0.0.1:4173/#/direct');await page.locator('#ops-map-status[data-state="loading"]').waitFor();await page.locator('#map .leaflet-marker-icon').first().waitFor();
 await page.evaluate(()=>{window.__tileTestMap=MAP;window.__tileTestStatus=document.querySelector('#ops-map-status');});await page.waitForTimeout(2300);
 assert.equal(await page.evaluate(()=>MAP===window.__tileTestMap&&document.querySelector('#ops-map-status')===window.__tileTestStatus),true);
 assert.equal(await page.locator('#ops-map-status').getAttribute('data-state'),'loading');assert.equal(await page.locator('#map #ops-map-status').count(),0,'status remains outside the vehicle map');
 mode='ready';await Promise.all(held.splice(0).map(route=>route.fulfill({contentType:'image/png',body:png})));await page.locator('#ops-map-status[data-state="ready"]').waitFor();
 mode='fail';await page.evaluate(()=>MAP.panBy([900,0],{animate:false}));await page.locator('#ops-map-status[data-state="error"]').waitFor();assert.match(await page.locator('#ops-map-status').innerText(),/Les positions restent disponibles/);assert.ok(await page.locator('#map .leaflet-marker-icon').count()>0);
 await page.goto('http://127.0.0.1:4173/#/cockpit');await page.locator('#fleet-search').waitFor();assert.equal(await page.locator('#ops-map-status').count(),0);assert.equal(providerRequests,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:8,providerRequests:0,scenarios:['slow-tiles','live-poll-stability','tiles-ready','tiles-error','route-cleanup']}));
}finally{await browser.close();}
