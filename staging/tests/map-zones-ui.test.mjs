import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const [script,css,operationsCss,leaflet,leafletCss]=await Promise.all(['../site/map-zones.js','../site/map-zones.css','../site/operations.css','../../node_modules/leaflet/dist/leaflet.js','../../node_modules/leaflet/dist/leaflet.css'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>browser?.close());
function catalog(){return {zones:[
 {id:'casa',name:'Casablanca centre',agency_id:1,kind:'operating',enabled:true,indicative:true,shape:{type:'polygon',points:[{lat:33.5,lon:-7.8},{lat:33.7,lon:-7.8},{lat:33.7,lon:-7.5},{lat:33.5,lon:-7.5}]}},
 {id:'marrakech',name:'Parking Marrakech',agency_id:2,kind:'parking',enabled:true,shape:{type:'circle',center:{lat:31.63,lon:-8.01},radius_m:120}},
 {id:'restricted',name:'Exclusion locale',agency_id:null,kind:'exclusion',enabled:false,shape:{type:'circle',center:{lat:33.61,lon:-7.62},radius_m:200}},
 {id:'archived',name:'Ancienne zone',agency_id:1,kind:'operating',archived_at:'2026-11-02T12:00:00Z',shape:{type:'circle',center:{lat:33.6,lon:-7.6},radius_m:100}},
 {id:'invalid',name:'Contour invalide',agency_id:1,kind:'operating',shape:{type:'polygon',points:[{lat:null,lon:0}]}}
 ],agencies:[{id:1,name:'Agence Casa',city:'Casablanca'},{id:2,name:'Agence Marrakech',city:'Marrakech'}]};}
async function fixture(work,{mobile=false,initialHold=false,initialFailure=false}={}){
 const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1240,height:900}}),errors=[],calls=[],state={data:catalog(),hold:initialHold,held:null,failure:initialFailure};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,'http://map-zones.invalid');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+leafletCss+operationsCss+css+'*{box-sizing:border-box}body{margin:0;font:14px system-ui}.ops-map-panel{height:650px;width:100%}#map{height:100%;width:100%}</style><section class="ops-map-panel"><div id="map"></div><div class="ops-map-tools"><button class="button-link" id="fit">Recentrer la flotte</button><span class="ops-map-live">Suivi en direct</span></div></section>'});
  assert.equal(url.pathname,'/api/parking/zones');assert.equal(route.request().method(),'GET');assert.equal(route.request().headers().authorization,'Bearer synthetic');calls.push(url.pathname);
  if(state.hold){state.hold=false;state.held={route,data:structuredClone(state.data)};return;}
  return route.fulfill(state.failure?{status:503,json:{error:'Indisponible'}}:{json:state.data});
 });
 await page.goto('http://map-zones.invalid');await page.addScriptTag({content:leaflet});await page.evaluate(()=>{window.S={session:{access_token:'synthetic',user:{id:'viewer-fixture'}}};window.ROUTING=1;window.agency='';window.agFilter=()=>agency;window.navigationCount=0;window.map=L.map('map',{zoomAnimation:false}).setView([32.4,-7.7],6);window.initialCenter=map.getCenter();window.initialZoom=map.getZoom();});await page.addScriptTag({content:script});await page.clock.install();
 await page.evaluate(()=>{document.querySelector('.ops-map-tools').insertAdjacentHTML('beforeend',mapZonesMarkup());window.handle=mountMapZones({map,container:document.querySelector('.ops-map-tools'),isCurrent:()=>ROUTING===1,onNavigate:()=>{navigationCount++;}});});
 if(!initialHold)await page.waitForFunction(()=>!document.querySelector('[data-map-zone-refresh]').disabled);
 try{await work({page,calls,state});assert.deepEqual(errors,[]);}finally{await page.evaluate(()=>{handle.cleanup();map.remove();}).catch(()=>{});await page.close();}
}
const value=page=>page.locator('[data-map-zone]').inputValue();
async function navigate(page,id){await page.locator('[data-map-zone]').selectOption(id);await page.locator('[data-map-zone-go]').click();}

test('viewers choose configured polygon, parking and exclusion without changing the initial map or fleet',async()=>{
 await fixture(async({page,calls})=>{
  assert.equal(calls.length,1);assert.deepEqual(await page.evaluate(()=>map.getCenter()),await page.evaluate(()=>initialCenter));assert.equal(await page.evaluate(()=>navigationCount),0);
  assert.deepEqual(await page.locator('[data-map-zone] option').evaluateAll(options=>options.map(o=>o.value)),['','casa','marrakech','restricted']);assert.match(await page.locator('optgroup').first().getAttribute('label'),/Casablanca/);
  await page.locator('[data-map-zone]').selectOption('casa');assert.equal(await page.evaluate(()=>navigationCount),0);await page.locator('[data-map-zone-go]').click();assert.equal(await page.evaluate(()=>navigationCount),1);assert.match(await page.locator('[data-map-zone-status]').innerText(),/Casablanca centre.*indicatif/);
  assert.ok(await page.evaluate(()=>map.getBounds().contains([33.5,-7.8])&&map.getBounds().contains([33.7,-7.5])));
  await navigate(page,'marrakech');assert.ok(await page.evaluate(()=>map.getBounds().contains([31.63,-8.01])));assert.equal(await page.evaluate(()=>map.getZoom()),16);
  await navigate(page,'restricted');assert.match(await page.locator('[data-map-zone-status]').innerText(),/détection désactivée/);assert.equal(await page.evaluate(()=>Object.values(map._layers).filter(layer=>layer instanceof L.Path).length),1);assert.equal(calls.length,1);
 });
});

test('agency changes filter cached zones and remove an out-of-scope outline without recentering',async()=>{
 await fixture(async({page,calls})=>{
  await navigate(page,'casa');const center=await page.evaluate(()=>map.getCenter());
  await page.evaluate(()=>{agency='2';handle.syncScope();});assert.deepEqual(await page.locator('[data-map-zone] option').evaluateAll(options=>options.map(o=>o.value)),['','marrakech','restricted']);assert.equal(await value(page),'');assert.equal(await page.locator('[data-map-zone-go]').isDisabled(),true);assert.equal(await page.evaluate(()=>Object.values(map._layers).filter(layer=>layer instanceof L.Path).length),0);assert.deepEqual(await page.evaluate(()=>map.getCenter()),center);
  await navigate(page,'marrakech');await page.evaluate(()=>{agency='';handle.syncScope();});assert.equal(await value(page),'marrakech');assert.equal(calls.length,1);
 });
});

test('two-second paints and elapsed time preserve selection and framing without rereading zones',async()=>{
 await fixture(async({page,calls})=>{
  await navigate(page,'marrakech');await page.evaluate(()=>map.panTo([31.65,-8.02],{animate:false}));const center=await page.evaluate(()=>map.getCenter()),zoom=await page.evaluate(()=>map.getZoom());
  await page.clock.fastForward(120000);await page.evaluate(()=>{for(let i=0;i<60;i++)handle.syncScope();});assert.equal(await value(page),'marrakech');assert.deepEqual(await page.evaluate(()=>map.getCenter()),center);assert.equal(await page.evaluate(()=>map.getZoom()),zoom);assert.equal(calls.length,1);assert.equal(await page.evaluate(()=>navigationCount),1);
  await page.locator('#fit').focus();const next=page.waitForResponse(r=>r.url().endsWith('/zones'));await page.locator('[data-map-zone]').focus();await next;assert.equal(calls.length,2);assert.equal(await value(page),'marrakech');assert.deepEqual(await page.evaluate(()=>map.getCenter()),center);
 });
});

test('explicit refresh removes a deleted selection and outline while retaining the current map position',async()=>{
 await fixture(async({page,calls,state})=>{
  await navigate(page,'casa');const center=await page.evaluate(()=>map.getCenter());state.data.zones=state.data.zones.filter(z=>z.id!=='casa');await page.evaluate(()=>handle.refresh());assert.equal(calls.length,2);assert.equal(await value(page),'');assert.equal(await page.locator('[data-map-zone-go]').isDisabled(),true);assert.equal(await page.evaluate(()=>Object.values(map._layers).filter(layer=>layer instanceof L.Path).length),0);assert.deepEqual(await page.evaluate(()=>map.getCenter()),center);
 });
});

test('late responses after route or account changes never expose the old catalogue',async()=>{
 for(const change of ['route','account'])await fixture(async({page,state})=>{
  await page.waitForFunction(()=>document.querySelector('[data-map-zone-refresh]').disabled);while(!state.held)await new Promise(r=>setTimeout(r,5));
  await page.evaluate(change=>{if(change==='route')ROUTING=2;else S.session={access_token:'new-session',user:{id:'other-viewer'}};},change);await state.held.route.fulfill({json:state.held.data});await page.waitForFunction(()=>document.querySelector('[data-map-zone]').options.length===0);assert.equal(await page.locator('[data-map-zone]').isDisabled(),true);assert.equal(await page.evaluate(()=>navigationCount),0);
 },{initialHold:true});
});

test('failed loading offers retry and a failed refresh keeps the previous readable contours',async()=>{
 await fixture(async({page,state,calls})=>{
  assert.match(await page.locator('[data-map-zone-status]').innerText(),/indisponibles/);assert.equal(await page.locator('[data-map-zone-go]').isDisabled(),true);state.failure=false;await page.evaluate(()=>handle.refresh());await navigate(page,'casa');state.failure=true;await page.evaluate(()=>handle.refresh());assert.equal(await value(page),'casa');assert.match(await page.locator('[data-map-zone-status]').innerText(),/derniers contours/);assert.equal(await page.locator('[data-map-zone-go]').isDisabled(),false);assert.equal(calls.length,3);
 },{initialFailure:true});
});

test('mobile zone controls remain within the map and keyboard submission centers the chosen zone',async()=>{
 await fixture(async({page})=>{
  const panel=await page.locator('.ops-map-panel').boundingBox(),form=await page.locator('.map-zones').boundingBox();assert.ok(form.x>=panel.x&&form.x+form.width<=panel.x+panel.width+1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('[data-map-zone]').selectOption('marrakech');await page.locator('[data-map-zone-go]').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>navigationCount),1);assert.ok(await page.evaluate(()=>map.getBounds().contains([31.63,-8.01])));assert.ok((await page.locator('[data-map-zone-go]').boundingBox()).height>=36);
 },{mobile:true});
});
