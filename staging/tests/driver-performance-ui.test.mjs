import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {performancePeriod,summarizeDriverPerformance} from '../server/driver-performance.mjs';
const script=readFileSync(new URL('../site/driver-performance.js',import.meta.url),'utf8'),css=readFileSync(new URL('../site/driver-performance.css',import.meta.url),'utf8');
const direct=readFileSync(new URL('../site/direct.js',import.meta.url),'utf8'),operations=readFileSync(new URL('../site/operations.js',import.meta.url),'utf8'),basemap=direct.slice(direct.indexOf('function osmLayer('),direct.indexOf('function drawMap('))+operations.slice(operations.indexOf('function opsObserveMapTiles('),operations.indexOf('function opsPlatformPills(')),leaflet=readFileSync(new URL('../../node_modules/leaflet/dist/leaflet.js',import.meta.url),'utf8'),leafletCss=readFileSync(new URL('../../node_modules/leaflet/dist/leaflet.css',import.meta.url),'utf8');
const dateHelpers=readFileSync(new URL('../site/timezone.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../site/lib.js',import.meta.url),'utf8')+'\nsetTzRules(STAGING_TZ_RULES);';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=','base64');
test('performance page stays readable on mobile, shows unavailable metrics and guards a changed session',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),id=randomUUID(),period=performancePeriod('2026-11-01','2026-11-01',Date.parse('2026-11-02T12:00:00Z'));
  const rides=[{source:'bolt',driver_id:id,external_id:'SYNTHETIC-RIDE',requested_at:'2026-11-01T10:00:00Z',accepted_at:'2026-11-01T10:01:00Z',started_at:'2026-11-01T10:05:00Z',finished_at:'2026-11-01T10:20:00Z',status:'finished',amount:75,currency:'MAD',distance_km:8,passenger_distance_km:6,duration_s:900,is_optional:false,stops:[{type:'pickup',lat:33.58,lng:-7.62}]}];
  const observations=['on_trip','available','on_break'].flatMap((status,i)=>[0,60].map(t=>({identity_id:'synthetic',status,observed_at:new Date(Date.parse(period.from_at)+(i*120+t)*1000).toISOString()})));
  const detail={driver:{id,name:'Synthetic Driver'},source:'bolt',period,...summarizeDriverPerformance({rides,observations,period,source:'bolt'}),can_sync:true};
  let held=null,hold=false,failRead=false,writes=0,tiles=0;const detailReads=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://tile.openstreetmap.org/**',async route=>{tiles++;assert.equal((await route.request().allHeaders()).referer,'http://127.0.0.1:4173/');return route.fulfill({contentType:'image/png',body:png});});
  await page.route('http://127.0.0.1:4173/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({headers:{'Referrer-Policy':'no-referrer'},contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px Arial;background:#f5f7fa;margin:14px}*{box-sizing:border-box}'+css+leafletCss+'</style><main id="page"></main><script>let ROUTING=1;let S={session:{user:{id:"staff"},access_token:"admin"}};</script><script>'+script+'</script>'});
   assert.ok(u.pathname.startsWith('/api/driver-performance/'),'only the performance API is loaded');
   if(u.pathname.endsWith('/drivers'))return route.fulfill({json:{drivers:[{id,name:'Synthetic Driver',sources:['bolt','uber']}],can_sync:true}});
   if(u.pathname.endsWith('/report-periods'))return route.fulfill({json:{periods:[{from:'2026-10-26',to:'2026-11-01',report_types:['driver_activity','driver_quality']}]}});
   if(u.pathname.endsWith('/sync')){writes++;return route.fulfill({json:{ok:true}});}
   detailReads.push(Object.fromEntries(u.searchParams));if(hold){held=route;return;}if(failRead)return route.fulfill({status:503,json:{error:'Lecture temporairement indisponible'}});return route.fulfill({json:detail});
  });
  await page.goto('http://127.0.0.1:4173/');await page.addScriptTag({content:dateHelpers});await page.addScriptTag({content:leaflet});await page.addScriptTag({content:basemap});await page.evaluate(()=>pageDriverPerformance());await page.waitForSelector('.performance-profile');assert.ok((await page.locator('.performance-metric').allTextContents()).some(t=>t.includes('Gains nets')&&t.includes('—')));assert.equal(await page.locator('.performance-ride').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.locator('#performance-map-status[data-state="ready"]').waitFor();assert.ok(tiles>0);assert.ok(await page.locator('#performance-map .leaflet-control-attribution a[href="https://www.openstreetmap.org/copyright"]').count());await page.locator('.basemap-help summary').click();await page.locator('[data-basemap-hide]').click();assert.equal(await page.locator('#performance-map-status').getAttribute('data-state'),'hidden');assert.equal(await page.locator('#performance-map .leaflet-interactive').count(),1,'points remain visible after hiding a visually refused image');
  const footer=await page.locator('.performance-activity-footer').textContent();assert.match(footer,/Connexion observée \(pauses incluses\) : 0\s*h\s*03/);assert.match(footer,/Temps actif hors pause : 0\s*h\s*02/);assert.match(footer,/Occupation hors pause : 50/);
  assert.match(await page.locator('.performance-footnote').allTextContents().then(texts=>texts.join(' ')),/temps actif comprend l’attente, l’approche et la course/);
  const hiddenTiles=tiles;await page.locator('.performance-ride').click();assert.equal(await page.locator('.performance-steps').count(),1);assert.equal(tiles,hiddenTiles,'selecting a ride does not retry a basemap the user has hidden');await page.locator('#performance-sync').click();await page.waitForFunction(()=>document.querySelector('#performance-sync')?.textContent==='Relire cette période');assert.equal(writes,1);
  await page.setViewportSize({width:1360,height:950});await page.screenshot({path:new URL('../.local/performance-ui-preview.png',import.meta.url).pathname,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.locator('#performance-source').selectOption('uber');await page.waitForFunction(()=>document.querySelector('#performance-to').value==='2026-11-01');assert.equal(await page.locator('#performance-from').inputValue(),'2026-10-26');await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  hold=true;held=null;await page.locator('#performance-filter button').click();await page.waitForTimeout(30);assert.ok(held);const obsolete=held;hold=false;
  await page.locator('[data-days="1"]').click();await page.waitForFunction(()=>!document.querySelector('#performance-filter button').disabled);assert.equal(detailReads.at(-1).from,await page.evaluate(()=>performanceLocalDay()));
  await obsolete.fulfill({json:{...detail,driver:{id,name:'STALE RESPONSE'}}}).catch(()=>{});await page.waitForTimeout(30);assert.doesNotMatch(await page.locator('#performance-detail').innerText(),/STALE RESPONSE/);
  failRead=true;await page.locator('#performance-filter button').click();await page.locator('#performance-error').filter({hasText:'temporairement indisponible'}).waitFor();assert.equal(await page.locator('.performance-profile').count(),0);assert.equal(await page.evaluate(()=>DRIVER_PERFORMANCE.map),null);assert.equal(await page.locator('#performance-filter button').isDisabled(),false);
  failRead=false;await page.locator('#performance-filter button').click();await page.locator('.performance-profile').waitFor();
  held=null;
  hold=true;await page.locator('#performance-filter button').click();await page.waitForTimeout(30);assert.ok(held);await page.evaluate(()=>{ROUTING++;S.session={user:{id:'another'},access_token:'different'};document.querySelector('#page').innerHTML='<p>NEW SESSION</p>';});await held.fulfill({json:detail});await page.waitForTimeout(30);assert.equal(await page.locator('#page').textContent(),'NEW SESSION');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Uber shortcut uses the selected driver’s available report and preserves explicit dates and newer selections',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});
 try{
  const page=await browser.newPage(),first=randomUUID(),second=randomUUID(),empty=randomUUID(),now=Date.parse('2026-11-03T12:00:00Z');let holdFirst=false,held=null,failPeriods=false;const detailReads=[],errors=[];
  const periods={[first]:{from:'2026-10-26',to:'2026-11-01'},[second]:{from:'2026-10-19',to:'2026-10-25'}};
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(({now})=>{Date.now=()=>now;},{now});
  await page.route('http://127.0.0.1:4173/**',async route=>{
   const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><main id="page"></main><script>let ROUTING=1;let S={session:{user:{id:"staff"},access_token:"viewer"}};</script><script>'+script+'</script>'});
   if(u.pathname.endsWith('/drivers'))return route.fulfill({json:{drivers:[first,second,empty].map((id,i)=>({id,name:'Synthetic '+i,sources:['uber']})),can_sync:false}});
   const id=u.searchParams.get('driver_id');
   if(u.pathname.endsWith('/report-periods')){if(holdFirst&&id===first){held=route;return;}return route.fulfill(failPeriods?{status:503,json:{error:'Périodes indisponibles'}}:{json:{periods:periods[id]?[{...periods[id],report_types:['driver_activity']}]:[]}});}
   assert.ok(u.pathname.endsWith('/detail'));const selection=Object.fromEntries(u.searchParams);detailReads.push(selection);const period=performancePeriod(selection.from,selection.to,now),available=periods[id],match=available&&available.from===selection.from&&available.to===selection.to;
   const officialSummaries=match?[{source:'uber',organization_id:'one',report_type:'driver_activity',period_from:period.from_at,period_to:period.to_at,reported_at:new Date(now).toISOString(),trips_completed:13,online_seconds:7200,trip_seconds:3600}]:[];
   return route.fulfill({json:{driver:{id,name:'Synthetic'},source:'uber',period,...summarizeDriverPerformance({period,source:'uber',officialSummaries}),can_sync:false}});
  });
  await page.goto('http://127.0.0.1:4173/#/performance?'+new URLSearchParams({source:'uber',driver_id:first,from:'2026-10-20',to:'2026-10-21'}));await page.addScriptTag({content:dateHelpers});await page.evaluate(()=>pageDriverPerformance());
  assert.equal(detailReads.at(-1).from,'2026-10-20');assert.equal(detailReads.at(-1).to,'2026-10-21');assert.doesNotMatch(await page.locator('#performance-detail').innerText(),/Rapport officiel Uber/);
  await page.locator('#performance-uber-period').click();await page.getByText('Rapport officiel Uber',{exact:true}).waitFor();assert.equal(detailReads.at(-1).from,'2026-10-26');assert.equal(detailReads.at(-1).to,'2026-11-01');
  await page.locator('#performance-driver').selectOption(second);await page.waitForFunction(()=>document.querySelector('#performance-to').value==='2026-10-25');assert.equal(await page.locator('#performance-from').inputValue(),'2026-10-19');
  await page.locator('#performance-driver').selectOption(empty);await page.locator('#performance-uber-period:disabled').waitFor();assert.match(await page.locator('#performance-uber-period').textContent(),/Aucun rapport/);
  holdFirst=true;await page.locator('#performance-driver').selectOption(first);await page.waitForTimeout(30);assert.ok(held);const obsolete=held;
  await page.locator('#performance-driver').selectOption(second);await page.waitForFunction(()=>!document.querySelector('#performance-filter button').disabled);await obsolete.fulfill({json:{periods:[periods[first]]}}).catch(()=>{});await page.waitForTimeout(30);assert.equal(await page.locator('#performance-to').inputValue(),'2026-10-25');assert.equal(detailReads.at(-1).driver_id,second);
  holdFirst=false;await page.locator('#performance-from').fill('2026-10-22');await page.locator('#performance-from').dispatchEvent('change');failPeriods=true;await page.locator('#performance-filter button').click();await page.waitForFunction(()=>!document.querySelector('#performance-filter button').disabled);assert.equal(detailReads.at(-1).from,'2026-10-22');assert.match(await page.locator('#performance-error').innerText(),/dates choisies sont conservées/);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
