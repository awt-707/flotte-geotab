import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {chromium} from 'playwright';
const scripts=await Promise.all(['fleet.js','direct.js','operations.js','zone-notifications.js','map-vehicle-appearance.js'].map(name=>fs.readFile(new URL('../site/'+name,import.meta.url),'utf8')));
async function fixture(t){
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',()=>assert.fail('No network request in counter fixtures'));
 await page.setContent('<main class="ops-direct"><div id="livecards"></div><div id="livecoverage"></div><div id="ops-unlocated-drivers"></div><div id="livest"></div><div id="ops-map-count"></div><div id="vlist"></div><div id="ops-map-alerts"></div></main>');
 await page.addScriptTag({content:`window.FLOTTE_CONFIG={GEOTAB_LOCAL:true};const CFG=FLOTTE_CONFIG,MIN=60000,HOUR=3600000,HORS='unknown',SHIFTS=['Jour','Nuit'],STATE_CLS={};const S={P:{},veh:{},vehList:[],session:{user:{id:'synthetic-admin'}},mine:null};const $=s=>document.querySelector(s),esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),normTxt=s=>String(s||'').toLowerCase(),workspaceIcon=()=>'',plate=s=>'<b>'+esc(s)+'</b>',f0=n=>String(n),num=n=>Number(n)||0,isAdmin=()=>true,agFilter=()=>window.selectedAgency||'',mineOn=()=>false,inAgency=()=>key=>!window.selectedAgency||String(S.veh[key]?.agency_id)===String(window.selectedAgency),shiftAt=()=>({s:'Jour',day:'2026-11-03'}),shiftStart=()=>new Date(0),shiftAdv=()=>2,ctrEffEnds=rows=>rows;`});
 for(const content of scripts)await page.addScriptTag({content});assert.deepEqual(errors,[]);
 await page.evaluate(()=>{
  const now=new Date().toISOString(),ob=()=>({status:'on_trip',observed_at:now,stale_after_s:90});
  S.vehList=Array.from({length:19},(_,i)=>({key:'car-'+i,plate:'TEST-'+i,model:'Synthetic',agency_id:1,geotab_id:i<11?'device-'+i:null,active:'OUI'}));S.veh=Object.fromEntries(S.vehList.map(v=>[v.key,v]));
  const drivers=Array.from({length:14},(_,i)=>({id:'driver-'+i,name:'Synthetic driver '+i,ludy_driver_code:'CODE-'+i,agency_id:1,vehicle_key:'car-'+i,vehicle_link_method:'manual',sources:{[i<11?'uber':'bolt']:ob()}}));drivers[0].sources.bolt=ob();
  OPS.overview={drivers,sources:['uber','bolt'].map(id=>({id,status:'healthy',last_success_at:now,stale_after_s:90})),alerts:[]};
  OPS.owner=S.session.user.id;OPS.overviewAt=Date.now();
  LIVE.localSource={configured:true,polling:true,status:'healthy',last_success_at:now,interval_s:2,stale_after_s:20};
  LIVE.pos=Object.fromEntries(S.vehList.slice(0,11).map(v=>[v.key,{key:v.key,plate:v.plate,state:'En route',speed:20,lat:33.5,lon:-7.5,at:now,fresh:true}]));
  consoGauge=()=>'';opsMotionCoverage=()=>'';liveStatusTxt=()=>'Suivi local';paintOperationsDirect();
 });
 t.after(()=>assert.deepEqual(errors,[]));return page;
}
test('the map separates 14 online people, 11 GPS devices and 19 inventory vehicles',async t=>{
 const page=await fixture(t);
 const stats=await page.locator('#livecards .ops-stat').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.querySelector('span').textContent,n.querySelector('strong').textContent])));
 assert.equal(stats['Véhicules suivis GPS'],'11 / 19');assert.equal(stats['Chauffeurs en ligne'],'14');assert.equal(stats['Positions récentes'],'11 / 19');
 assert.equal(await page.locator('#vlist .vcard').count(),19);assert.equal(await page.locator('#vlist .vcard').filter({hasText:'Sans suivi GPS'}).count(),8);
 assert.match(await page.locator('#ops-unlocated-drivers summary').innerText(),/14 chauffeur.*3 sans position GPS/);
 await page.locator('#ops-unlocated-drivers summary').click();assert.equal(await page.locator('.ops-unlocated-list a').count(),3);
 assert.equal(await page.evaluate(()=>liveRows().filter(row=>!S.veh[row.vehicle_key].geotab_id).every(row=>row.lat===null&&row.lon===null&&row.live===0)),true);
});
test('offline and stale observations change their own counters without hiding unlocalized cars',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{OPS.overview.drivers[13].sources.bolt.status='offline';LIVE.pos['car-0'].at=new Date(Date.now()-240000).toISOString();paintOperationsDirect();});
 const stats=await page.locator('#livecards .ops-stat').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.querySelector('span').textContent,n.querySelector('strong').textContent])));
 assert.equal(stats['Chauffeurs en ligne'],'13');assert.equal(stats['Véhicules suivis GPS'],'11 / 19');assert.equal(stats['Positions récentes'],'10 / 19');
 assert.match(await page.locator('#ops-unlocated-drivers summary').innerText(),/13 chauffeur.*3 sans position GPS/);assert.equal(await page.locator('#vlist .vcard').count(),19);
 await page.evaluate(()=>{OPS.overview.drivers[12].sources.bolt.stale=true;paintOperationsDirect();});
 assert.match(await page.locator('#ops-unlocated-drivers summary').innerText(),/12 chauffeur.*2 sans position GPS/);
});
test('agency selection does not expose the other agency in counters or missing-position profiles',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{for(const row of S.vehList.slice(10))row.agency_id=2;for(const row of OPS.overview.drivers.slice(10))row.agency_id=2;window.selectedAgency=1;paintOperationsDirect();});
 const stats=await page.locator('#livecards .ops-stat').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.querySelector('span').textContent,n.querySelector('strong').textContent])));
 assert.equal(stats['Véhicules suivis GPS'],'10 / 10');assert.equal(stats['Chauffeurs en ligne'],'10');assert.equal(await page.locator('#vlist .vcard').count(),10);
 assert.match(await page.locator('#ops-unlocated-drivers summary').innerText(),/10 chauffeur.*0 sans position GPS/);
});
test('a new trip hides cached unused-parking badges in both the list and drawer',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{
  window.badge=(text,cls)=>'<span class="badge '+esc(cls)+'">'+esc(text)+'</span>';window.fmtHMS=value=>new Date(value).toISOString();
  LIVE.pos['car-0'].speed=0;LIVE.pos['car-0'].state='Garé';for(const observation of Object.values(OPS.overview.drivers[0].sources))observation.status='offline';
  ZONE_NOTICES.owner=S.session.user.id;ZONE_NOTICES.readAt=Date.now();ZONE_NOTICES.parked=[{vehicle_key:'car-0',position_at:LIVE.pos['car-0'].at,zone_name:'Synthetic depot'}];paintOperationsDirect();opsOpenVehicle('car-0');
 });assert.equal(await page.locator('.ops-parking-state').count(),2);
 await page.evaluate(()=>{OPS.overview.drivers[0].sources.uber.status='on_trip';paintOperationsDirect();});assert.equal(await page.locator('.ops-parking-state').count(),0);assert.equal(await page.evaluate(()=>mapVehicleAppearance(liveRows().find(r=>r.vehicle_key==='car-0')).kind),'uber');
});
test('a display-only current trip suppresses a superseded available-outside-zone badge',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{
  const driver=OPS.overview.drivers[0];driver.vehicle_key=null;OPS.overview.vehicle_observations=[{driver_id:driver.id,vehicle_key:'car-0',source:'uber',status:'on_trip',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+90000).toISOString()}];
  ZONE_NOTICES.owner=S.session.user.id;ZONE_NOTICES.readAt=Date.now();ZONE_NOTICES.alerts=[{id:'superseded',vehicle_key:'car-0',category:'outside_operating',zone_name:'Synthetic city'}];paintOperationsDirect();
 });assert.equal(await page.locator('.ops-zone-badge').count(),0);assert.equal(await page.evaluate(()=>opsDriverForVehicle('car-0')),null);assert.equal(await page.evaluate(()=>opsObservedDriverForVehicle('car-0').sources.uber.status),'on_trip');
});
test('available outside-zone badges follow current scoped alerts without replacing movement or offline-motion severity',async t=>{
 const page=await fixture(t),css=await fs.readFile(new URL('../site/operations.css',import.meta.url),'utf8');
 await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font:14px Arial}:root{--panel:white;--line:#ddd;--ink:#202937}'+css});
 const card=page.locator('.vcard[data-vk="car-0"]'),stateColor=await card.locator('.ops-vehicle-state').evaluate(el=>getComputedStyle(el).color);
 await page.evaluate(()=>{
  window.badge=(text,cls)=>'<span class="badge '+esc(cls)+'">'+esc(text)+'</span>';window.fmtHMS=value=>new Date(value).toISOString();
  for(const ob of Object.values(OPS.overview.drivers[0].sources))ob.status='available';
  ZONE_NOTICES.owner=S.session.user.id;ZONE_NOTICES.readAt=Date.now();ZONE_NOTICES.hidden.add('zone-active');
  ZONE_NOTICES.alerts=[{id:'zone-active',vehicle_key:'car-0',category:'outside_operating',zone_name:'Casa <img src=x onerror=bad()>',indicative:true},{id:'exclusion',vehicle_key:'car-0',category:'exclusion',zone_name:'Excluded zone'},{id:'other',vehicle_key:'car-1',category:'outside_operating',zone_name:'Other car',indicative:false}];
  paintOperationsDirect();opsOpenVehicle('car-0');
 });
 assert.match(await card.locator('.ops-zone-badge').innerText(),/Disponible hors zone.*indicatif/);assert.match(await card.getAttribute('aria-label'),/Disponible hors zone.*indicatif/);
 assert.equal(await card.locator('.ops-vehicle-state').evaluate(el=>getComputedStyle(el).color),stateColor);assert.equal(await card.locator('.ops-vehicle-alert').count(),0);assert.equal(await card.evaluate(el=>el.classList.contains('has-critical')),false);
 assert.equal(await page.locator('.vcard .ops-zone-badge').count(),1,'an explicit trip suppresses a superseded availability notice');
 const drawer=page.locator('#ops-vehicle-drawer');assert.equal(await drawer.locator('.ops-zone-badge').count(),1);assert.equal(await drawer.locator('.ops-zone-signal').count(),1);assert.match(await drawer.locator('.ops-zone-signal').innerText(),/Casa <img/);assert.equal(await drawer.locator('img').count(),0);assert.equal(await drawer.locator('.ops-zone-signal').getAttribute('href'),'#/parkings');assert.match(await drawer.locator('.ops-drawer-heading').innerText(),/En mouvement/);
 await page.setViewportSize({width:390,height:844});assert.equal(await drawer.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
 await page.evaluate(()=>{OPS.overview.drivers[0].sources.uber.status='on_trip';paintOperationsDirect();});assert.equal(await page.locator('.ops-zone-badge,.ops-zone-signal').count(),0);
 await page.evaluate(()=>{OPS.overview.drivers[0].sources.uber.status='available';paintOperationsDirect();});assert.equal(await page.locator('.ops-zone-badge').count(),2);
 await page.evaluate(()=>{ZONE_NOTICES.readAt=Date.now()-16000;paintOperationsDirect();});assert.equal(await page.locator('.ops-zone-badge,.ops-zone-signal').count(),0);
 await page.evaluate(()=>{ZONE_NOTICES.readAt=Date.now();ZONE_NOTICES.owner='another-session';paintOperationsDirect();});assert.equal(await page.locator('.ops-zone-badge,.ops-zone-signal').count(),0);
 await page.evaluate(()=>{ZONE_NOTICES.owner=S.session.user.id;ZONE_NOTICES.alerts=ZONE_NOTICES.alerts.filter(a=>a.id==='zone-active').map(a=>({...a,indicative:false}));paintOperationsDirect();});assert.doesNotMatch(await card.locator('.ops-zone-badge').innerText(),/indicatif/);assert.equal(await drawer.locator('.ops-zone-signal').count(),1);
 await drawer.locator('.ops-zone-signal').click();assert.equal(await page.locator('#ops-vehicle-drawer').count(),0);assert.equal(await page.evaluate(()=>location.hash),'#/parkings');assert.equal(await page.evaluate(()=>Object.keys(LIVE.motion).length),0);
});
