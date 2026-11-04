import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import vm from 'node:vm';
test('exclusion notices follow current authorized presence, preserve dismissal and discard an old session response',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'}),page=await browser.newPage();
 let alerts=[{id:'episode-a',plate:'TEST-ZONE',zone_name:'Synthetic restriction'}],status=200,hold=null;const errors=[],parked=[{vehicle_key:'unused-car',position_at:new Date().toISOString(),zone_name:'Synthetic parking'}];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const url=new URL(route.request().url());assert.equal(url.origin,'http://fixture.invalid');if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<main id="toasts"></main>'});assert.equal(url.pathname,'/api/parking/alerts');assert.equal(route.request().method(),'GET');const delayed=hold;if(delayed){hold=null;await delayed.promise;}return route.fulfill({status,json:{alerts:delayed?.alerts||alerts,parked_vehicles:parked}});});
 try{await page.goto('http://fixture.invalid/');await page.evaluate(()=>{window.S={session:{user:{id:'synthetic-user'},access_token:'synthetic-token'}};window.ROUTING=1;window.esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.setInterval=fn=>{window.nextZoneRead=fn;return 1;};window.clearInterval=()=>{};});await page.addScriptTag({content:await fs.readFile(new URL('../site/zone-notifications.js',import.meta.url),'utf8')});
  await page.evaluate(()=>zoneNotificationsStart(1));await page.locator('.toast').waitFor();assert.match(await page.locator('.toast').innerText(),/TEST-ZONE/);assert.equal(await page.evaluate(()=>mapUnusedParking('unused-car')?.zone_name),'Synthetic parking');
  await page.locator('.toast button').click();await page.evaluate(()=>nextZoneRead());await page.waitForTimeout(30);assert.equal(await page.locator('.toast').count(),0);
  alerts=[];await page.evaluate(()=>nextZoneRead());await page.waitForTimeout(30);alerts=[{id:'episode-b',plate:'TEST-NEXT',zone_name:'Synthetic restriction'}];await page.evaluate(()=>nextZoneRead());await page.locator('.toast').waitFor();
  alerts=[{id:'outside-available',vehicle_key:'test-car',plate:'TEST-AVAILABLE',zone_name:'Synthetic city',category:'outside_operating',indicative:true}];await page.evaluate(()=>nextZoneRead());assert.match(await page.locator('.toast').innerText(),/Disponible hors zone/);assert.match(await page.locator('.toast').innerText(),/contour approximatif/);assert.doesNotMatch(await page.locator('.toast').innerText(),/Zone d’exclusion/);
  assert.equal(await page.evaluate(()=>zoneAlertsForVehicle('test-car').length),1);await page.locator('.toast button').click();assert.equal(await page.evaluate(()=>zoneAlertsForVehicle('test-car').length),1,'dismissal does not hide the current vehicle flag');assert.equal(await page.evaluate(()=>{ZONE_NOTICES.readAt-=16000;return zoneAlertsForVehicle('test-car').length;}),0,'stale cache cannot retain a vehicle flag');
  status=503;await page.evaluate(()=>nextZoneRead());await page.locator('.toast').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>mapUnusedParking('unused-car')),null);
  status=200;let release;hold={promise:new Promise(resolve=>release=resolve),alerts:[{id:'old-user',plate:'PRIVATE_OLD',zone_name:'Old'}]};await page.evaluate(()=>{void nextZoneRead();});await page.waitForTimeout(20);await page.evaluate(()=>{ROUTING=2;S.session={user:{id:'next-user'},access_token:'next-token'};zoneNotificationsCleanup();});release();await page.waitForTimeout(50);assert.equal(await page.locator('.toast').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('an aborted previous read cannot erase parking proof loaded by a restart on the same route',async()=>{
 const requests=[],script=await fs.readFile(new URL('../site/zone-notifications.js',import.meta.url),'utf8');
 const context=vm.createContext({Date,Set,AbortController,setTimeout,clearTimeout,setInterval:()=>1,clearInterval:()=>{},S:{session:{user:{id:'same-viewer'},access_token:'synthetic-token'}},ROUTING:1,document:{hidden:false,getElementById:()=>null},fetch:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))});
 vm.runInContext(script,context);vm.runInContext('zoneNotificationsStart(1);zoneNotificationsStart(1);',context);assert.equal(requests.length,2);
 const proof={vehicle_key:'unused-car',position_basis:'last_known_parking',position_at:'2026-11-02T12:00:00Z',checked_at:new Date().toISOString()};requests[1].resolve(Response.json({alerts:[],parked_vehicles:[proof]}));await new Promise(setImmediate);
 assert.equal(vm.runInContext('mapUnusedParking("unused-car")?.position_basis',context),'last_known_parking');requests[0].reject(Error('Aborted previous read'));await new Promise(setImmediate);
 assert.equal(vm.runInContext('mapUnusedParking("unused-car")?.position_basis',context),'last_known_parking');
 vm.runInContext('ZONE_NOTICES.parked.push({...ZONE_NOTICES.parked[0]})',context);assert.equal(vm.runInContext('mapUnusedParking("unused-car")',context),null,'ambiguous duplicate proofs do not choose an arbitrary parking');vm.runInContext('zoneNotificationsCleanup()',context);
});
test('zone notices and parking proofs expire even when the page is hidden and no refresh finishes',async()=>{
 let time=Date.now(),removed=0,sequence=0;const timers=new Map(),script=await fs.readFile(new URL('../site/zone-notifications.js',import.meta.url),'utf8');
 const context=vm.createContext({Date:class extends Date{static now(){return time;}},Set,AbortController,setTimeout:(fn,delay)=>{timers.set(++sequence,{fn,delay});return sequence;},clearTimeout:id=>timers.delete(id),setInterval:()=>1,clearInterval:()=>{},S:{session:{user:{id:'viewer'},access_token:'synthetic-token'}},ROUTING:1,document:{hidden:false,getElementById:()=>null},fetch:async()=>Response.json({alerts:[{id:'current',vehicle_key:'car'}],parked_vehicles:[{vehicle_key:'car',position_at:new Date(time).toISOString()}]}),node:{remove:()=>removed++}});
 vm.runInContext(script,context);vm.runInContext('zoneNotificationsStart(1)',context);await new Promise(setImmediate);assert.equal(vm.runInContext('zoneAlertsForVehicle("car").length',context),1);assert.ok(vm.runInContext('mapUnusedParking("car")',context));vm.runInContext('ZONE_NOTICES.node=node;document.hidden=true',context);
 const expiry=[...timers.values()].find(timer=>timer.delay===15001);assert.ok(expiry);time+=16000;expiry.fn();assert.equal(removed,1);assert.equal(vm.runInContext('zoneAlertsForVehicle("car").length',context),0);assert.equal(vm.runInContext('mapUnusedParking("car")',context),null);assert.equal(vm.runInContext('ZONE_NOTICES.node',context),null);vm.runInContext('zoneNotificationsCleanup()',context);
});
