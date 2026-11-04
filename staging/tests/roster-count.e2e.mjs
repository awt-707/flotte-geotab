// Fictional provider observations; real local login only, no provider or association writes.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const c=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(c.environment,'staging-local-only');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
let writes=0,checks=0,offlineExtra=false;const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'});page.on('pageerror',e=>errors.push(e.message));
 const fixture=()=>{
  const now=Date.now(),at=new Date(now).toISOString();const ob=(status='available',age=0)=>({status,observed_at:new Date(now-age).toISOString(),stale_after_s:150});
  const drivers=Array.from({length:11},(_,i)=>({id:'synthetic-uber-'+i,name:'Synthetic Uber '+i,ludy_driver_code:'TEST-'+i,agency_id:1,vehicle_key:'synthetic-car-'+i,sources:{uber:ob()}}));
  drivers[0].sources.bolt=ob();
  if(offlineExtra)drivers[1].sources.uber=ob('offline');
  drivers.push(...Array.from({length:3},(_,i)=>({id:'synthetic-bolt-'+i,name:'Synthetic Bolt '+i,ludy_driver_code:null,vehicle_key:null,agency_id:i===0?2:null,sources:{bolt:ob(i===0?'offline':i===1?'unknown':'on_trip')}})));
  drivers.push({id:'synthetic-old-shift',name:'Synthetic Previous Shift',agency_id:1,sources:{uber:ob('on_trip',86400000)}});
  return {at,drivers,alerts:[],settings:{},sources:['uber','bolt'].map(id=>({id,status:'healthy',last_success_at:at,stale_after_s:150}))};
 };
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
  if(url.pathname.startsWith('/api/fleet/')&&req.method()!=='GET'){writes++;return route.abort();}
  if(url.pathname==='/rest/v1/rpc/session_ping')return route.fulfill({json:null});
  if(url.pathname==='/api/fleet/overview')return route.fulfill({json:fixture()});
  if(url.pathname==='/api/fleet/geotab/live')return route.fulfill({json:{source:{status:'healthy'},vehicles:[],events:[],motion_alerts:[],telemetry:{}}});
  return route.continue();
 });
 await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(c.email);await page.locator('#lp').fill(c.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
 await page.waitForFunction(()=>document.querySelector('#fleet-metrics strong')?.textContent==='14');
 const metric=page.locator('#fleet-metrics .ops-stat').first();assert.match(await metric.innerText(),/11 Uber.*4 Bolt.*1 commun/s);checks++;
 const metricValue=label=>page.locator('#fleet-metrics .ops-stat').filter({has:page.locator('span').getByText(label,{exact:true})}).locator('strong');
 // Fourteen recently observed profiles include offline/unknown states; twelve
 // are currently online, independently of the number of vehicles with GPS.
 assert.equal(await metricValue('Chauffeurs en ligne').innerText(),'12');assert.equal(await metricValue('En course').innerText(),'1');assert.equal(await metricValue('État indisponible').innerText(),'1');
 assert.match(await metric.innerText(),/y compris hors ligne/);
 assert.equal(await metricValue('Véhicules suivis GPS').innerText(),await page.evaluate(()=>opsVehicles().filter(v=>v.geotab_id).length+' / '+opsVehicles().length));checks+=5;
 offlineExtra=true;await page.locator('#fleet-refresh').click();await page.waitForFunction(()=>[...document.querySelectorAll('#fleet-metrics .ops-stat')].find(n=>n.querySelector('span').textContent==='Chauffeurs en ligne')?.querySelector('strong').textContent==='11');assert.equal(await metric.locator('strong').innerText(),'14');checks++;
 offlineExtra=false;await page.locator('#fleet-refresh').click();await page.waitForFunction(()=>[...document.querySelectorAll('#fleet-metrics .ops-stat')].find(n=>n.querySelector('span').textContent==='Chauffeurs en ligne')?.querySelector('strong').textContent==='12');checks++;
 assert.equal(await page.locator('#fleet-roster-content tbody tr').count(),14);assert.equal(await page.locator('#fleet-roster-content').getByText('Synthetic Bolt 0',{exact:true}).count(),1);assert.equal(await page.locator('#fleet-roster-content').getByText('Synthetic Previous Shift',{exact:true}).count(),0);checks+=3;
 await page.locator('#fleet-provider').selectOption('bolt');assert.equal(await page.locator('#fleet-roster-content tbody tr').count(),4);checks++;
 await page.locator('#fleet-provider').selectOption('');await page.locator('#fleet-range-all').click();assert.equal(await page.locator('#fleet-roster-content tbody tr').count(),15);assert.equal(await metric.locator('strong').innerText(),'14');checks+=2;
 await page.locator('#fleet-range-recent').click();await page.evaluate(()=>{localStorage.setItem('agence','1');route();});await page.waitForFunction(()=>document.querySelector('#fleet-metrics strong')?.textContent==='11');
 assert.match(await page.locator('#fleet-scope').innerText(),/agence/i);assert.match(await page.locator('#fleet-scope').innerText(),/3.*hors.*périmètre/i);checks+=2;
 await page.locator('#fleet-all-scope').click();await page.waitForFunction(()=>document.querySelector('#fleet-metrics strong')?.textContent==='14');assert.equal(await page.evaluate(()=>agFilter()),'');checks++;
 await page.evaluate(()=>{S.mine=new Set(Array.from({length:11},(_,i)=>'synthetic-car-'+i));localStorage.setItem('mesveh','1');OPS.paint();});await page.waitForFunction(()=>document.querySelector('#fleet-metrics strong')?.textContent==='11');assert.match(await page.locator('#fleet-scope').innerText(),/Mes véhicules/);checks++;
 await page.locator('#fleet-all-scope').click();await page.waitForFunction(()=>document.querySelector('#fleet-metrics strong')?.textContent==='14');assert.equal(await page.evaluate(()=>mineOn()),false);checks++;
 await page.setViewportSize({width:390,height:800});assert.equal(await page.locator('.ops-cockpit').evaluate(e=>e.scrollWidth<=e.clientWidth),true);checks++;
 assert.equal(writes,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,providerWrites:0}));
}finally{await browser.close();}
