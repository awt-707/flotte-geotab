import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {normalizeParkingZone} from '../server/parking-domain.mjs';

const [script,css,leaflet,leafletCss,app]=await Promise.all([
 '../site/parking.js','../site/parking.css','../../node_modules/leaflet/dist/leaflet.js','../../node_modules/leaflet/dist/leaflet.css','../site/app.js'
].map(file=>readFile(new URL(file,import.meta.url),'utf8')));
const agencyHelper=app.slice(app.indexOf('function agencyPickerRows('),app.indexOf('function agOptions('));
const ZONE='11111111-1111-4111-8111-111111111111';let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>browser?.close());
async function fixture(work,{admin=true,mobile=true}={}){
 const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:1000}}),errors=[],writes=[],state={holdNext:false,held:null,holdWrite:false,heldWrite:null};
 const data={zones:[{id:ZONE,name:'Casa historique',kind:'operating',agency_id:1,enabled:true,revision:1,shape:{type:'polygon',points:[{lat:33.58,lon:-7.64},{lat:33.61,lon:-7.64},{lat:33.61,lon:-7.60},{lat:33.58,lon:-7.60}]}}],agencies:[{id:1,name:'Agence Casa',city:'Casablanca'},{id:2,name:'Agence Marrakech',city:'Marrakech'}],vehicles:[],events:[{zone_id:ZONE,zone_name:'Casa historique',zone_kind:'operating',zone_archived:false,kind:'entered',observed_at:'2026-11-02T10:00:00Z'}],counts:{tracked:0,total:0,fresh:0,parked:0,exclusion:0,outside_operating:0},detector:{at:null,error:null},source:{status:'healthy'}};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(url.origin,'http://zones.invalid');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:12px;background:#f5f7fa;font:14px system-ui}button,input,select{font:inherit;padding:9px;max-width:100%}button{cursor:pointer}.ops-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.stat{padding:10px;background:white}.stat strong{display:block}.ops-header h1{font-size:26px}'+css+leafletCss+'</style><main id="page"></main>'});
  if(url.pathname==='/api/parking/overview'){if(state.holdNext){state.holdNext=false;state.held={route,data:structuredClone(data)};return;}return route.fulfill({json:data});}
  const body=request.postDataJSON();writes.push({path:url.pathname,body});
  if(url.pathname==='/api/parking/zones/archive'){
   assert.equal(admin,true);const zone=data.zones.find(z=>z.id===body.id);if(!zone||zone.revision!==body.revision)return route.fulfill({status:409,json:{error:'La zone a été modifiée. Actualisez avant de la supprimer.'}});
   data.zones=data.zones.filter(z=>z.id!==body.id);for(const event of data.events.filter(e=>e.zone_id===zone.id))Object.assign(event,{zone_name:zone.name,zone_kind:zone.kind,zone_archived:true});
   return route.fulfill({json:{ok:true,id:zone.id,revision:zone.revision+1,archived_at:'2026-11-02T11:00:00Z'}});
  }
  assert.equal(url.pathname,'/api/parking/zones');assert.equal(admin,true);
  let normalized;try{normalized=normalizeParkingZone(body);}catch(error){return route.fulfill({status:400,json:{error:error.message}});}
  const old=data.zones.find(z=>z.id===body.id),id=body.id||body.request_id,revision=(old?.revision||0)+1,row={...normalized,id,revision};data.zones=data.zones.filter(z=>z.id!==id);data.zones.push(row);
  if(state.holdWrite){state.holdWrite=false;state.heldWrite={route,id,revision};return;}
  return route.fulfill({json:{ok:true,id,revision}});
 });
 await page.goto('http://zones.invalid/');await page.evaluate(admin=>{window.S={P:{},session:{user:{id:'fixture'},access_token:'synthetic'}};window.ROUTING=1;window.$=s=>document.querySelector(s);window.isAdmin=()=>admin;window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.normTxt=v=>String(v).toLowerCase();window.fmtHMS=v=>String(v);window.msg=v=>v;window.opsHeader=(a,b,c)=>'<header class="ops-header"><p>'+a+'</p><h1>'+b+'</h1><p>'+c+'</p></header>';window.opsLink=()=>'';window.opsStat=(a,b,c)=>'<div class="stat">'+a+'<strong>'+b+'</strong><small>'+c+'</small></div>';},admin);
 await page.addScriptTag({content:leaflet});await page.evaluate(()=>{window.osmLayer=()=>L.layerGroup();});await page.addScriptTag({content:agencyHelper});await page.addScriptTag({content:script});await page.clock.install();await page.evaluate(()=>pageParking());
 try{await work({page,data,writes,state});assert.deepEqual(errors,[]);}finally{await page.evaluate(()=>parkingCleanup()).catch(()=>{});await page.close();}
}
async function point(page,x,y){await page.locator('#parking-map').scrollIntoViewIfNeeded();const box=await page.locator('#parking-map').boundingBox();await page.mouse.click(box.x+box.width*x,box.y+box.height*y);}
async function newZone(page){await page.locator('#parking-new-zone').click();await page.locator('#parking-agency').selectOption('2');await page.locator('#parking-redraw').click();}
async function triangle(page){for(const [x,y]of [[.25,.25],[.7,.25],[.7,.7]])await point(page,x,y);}

test('mobile creation guides agency, points and undo, then creates one editable authorised zone',async()=>{
 await fixture(async({page,writes,data,state})=>{
  await page.locator('#parking-new-zone').click();assert.equal(await page.locator('#parking-kind').inputValue(),'operating');assert.equal(await page.locator('#parking-agency').evaluate(e=>e.required),true);assert.match(await page.locator('#parking-agency option[value="2"]').textContent(),/Marrakech.*Agence Marrakech/);
  await page.locator('#parking-agency').selectOption('2');assert.ok(Math.abs(await page.evaluate(()=>PARKING.map.getCenter().lat)-31.63)<.01);await page.locator('#parking-redraw').click();
  await point(page,.25,.25);await point(page,.7,.25);assert.equal(await page.locator('#parking-finish').isDisabled(),true);await point(page,.7,.7);assert.equal(await page.locator('#parking-finish').isDisabled(),false);
  await page.locator('#parking-undo').click();assert.equal(await page.evaluate(()=>PARKING.selected.points.length),2);await point(page,.7,.7);const drawn=await page.evaluate(()=>structuredClone(PARKING.selected));
  const polled=page.waitForResponse(r=>r.url().endsWith('/overview'));await page.clock.fastForward(10100);await polled;assert.deepEqual(await page.evaluate(()=>PARKING.selected),drawn);
  await page.locator('#parking-finish').click();assert.equal(await page.locator('#parking-draw-tools').isVisible(),false);assert.equal(writes.length,0);assert.equal(await page.locator('.parking-vertex').count(),3);
  state.holdWrite=true;await page.locator('#parking-save').click();await page.waitForFunction(()=>document.querySelector('#parking-name').disabled);assert.equal(writes.length,1);assert.equal(writes[0].body.kind,'operating');assert.equal(writes[0].body.agency_id,2);assert.equal(writes[0].body.shape.type,'polygon');assert.deepEqual(writes[0].body.shape,drawn);
  await state.heldWrite.route.fulfill({json:{ok:true,id:state.heldWrite.id,revision:state.heldWrite.revision}});await page.locator('#parking-form-status').filter({hasText:'Zone enregistrée'}).waitFor();assert.equal(data.zones.length,2);
  await page.locator('#parking-name').fill('Marrakech centre ajusté');await page.locator('#parking-save').click();await page.locator('#parking-form-status').filter({hasText:'Zone enregistrée'}).waitFor();assert.equal(writes[1].body.id,writes[0].body.request_id);assert.equal(writes[1].body.revision,1);assert.equal(data.zones.length,2);
  await page.locator('#parking-new-zone').click();await page.locator('#parking-agency').selectOption('2');await page.locator('#parking-redraw').click();await triangle(page);await page.locator('#parking-finish').click();await page.locator('#parking-save').click();await page.locator('#parking-form-status').filter({hasText:'Zone enregistrée'}).waitFor();assert.notEqual(writes[2].body.request_id,writes[0].body.request_id);assert.equal(data.zones.length,3);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 });
});

test('cancelling a redraw restores the saved outline and cancelling the editor writes nothing',async()=>{
 await fixture(async({page,data,writes})=>{
  const original=structuredClone(data.zones[0].shape);await page.locator('[data-zone="'+ZONE+'"]').click();await page.locator('#parking-redraw').click();await point(page,.4,.4);assert.equal(await page.evaluate(()=>PARKING.selected.points.length),1);
  await page.locator('#parking-cancel-draw').click();assert.deepEqual(await page.evaluate(()=>PARKING.selected),original);assert.deepEqual(data.zones[0].shape,original);assert.equal(await page.locator('.parking-vertex').count(),4);
  await page.locator('#parking-cancel-edit').click();assert.equal(await page.locator('#parking-create').evaluate(e=>e.open),false);assert.equal(await page.locator('.parking-vertex').count(),0);assert.equal(writes.length,0);
 });
});

test('delete requires confirmation, clears the map and keeps named historical crossings',async()=>{
 await fixture(async({page,data,writes})=>{
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-zone-delete="'+ZONE+'"]').click();assert.equal(writes.length,0);assert.equal(data.zones.length,1);
  await page.locator('[data-zone="'+ZONE+'"]').click();page.once('dialog',dialog=>{assert.match(dialog.message(),/Casa historique/);assert.match(dialog.message(),/conservées/);return dialog.accept();});await page.locator('[data-zone-delete="'+ZONE+'"]').click();await page.locator('#parking-status').filter({hasText:'Zone supprimée'}).waitFor();
  assert.equal(writes.length,1);assert.deepEqual(writes[0],{path:'/api/parking/zones/archive',body:{id:ZONE,revision:1}});assert.equal(data.events.length,1);assert.equal(await page.locator('[data-zone="'+ZONE+'"]').count(),0);assert.equal(await page.evaluate(zone=>PARKING.features.has('zone:'+zone),ZONE),false);assert.match(await page.locator('#parking-events').innerText(),/Casa historique.*zone supprimée/);assert.equal(await page.locator('#parking-create').evaluate(e=>e.open),false);
 });
});

test('a concurrent modification keeps the zone visible until an up-to-date deletion is confirmed',async()=>{
 await fixture(async({page,data,writes})=>{
  data.zones[0].revision=2;page.once('dialog',dialog=>dialog.accept());await page.locator('[data-zone-delete="'+ZONE+'"]').click();await page.locator('#parking-status').filter({hasText:'La zone a été modifiée'}).waitFor();assert.equal(data.zones.length,1);assert.equal(await page.locator('[data-zone="'+ZONE+'"]').count(),1);
  const polled=page.waitForResponse(r=>r.url().endsWith('/overview'));await page.clock.fastForward(10100);await polled;page.once('dialog',dialog=>dialog.accept());await page.locator('[data-zone-delete="'+ZONE+'"]').click();await page.locator('#parking-status').filter({hasText:'Zone supprimée'}).waitFor();assert.equal(writes[1].body.revision,2);assert.equal(data.zones.length,0);
 });
});

test('an overview started before deletion cannot bring the removed zone back',async()=>{
 await fixture(async({page,data,state})=>{
  state.holdNext=true;await page.clock.fastForward(10100);while(!state.held)await new Promise(resolve=>setTimeout(resolve,5));
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-zone-delete="'+ZONE+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-zone-delete]')?.disabled);assert.equal(data.zones.length,0);
  await state.held.route.fulfill({json:state.held.data});await page.locator('#parking-status').filter({hasText:'Zone supprimée'}).waitFor();assert.equal(await page.locator('[data-zone="'+ZONE+'"]').count(),0);assert.equal(await page.evaluate(()=>PARKING.data.zones.length),0);
 });
});

test('a rejected crossed outline remains editable, with no zone created',async()=>{
 await fixture(async({page,data,writes})=>{
  await newZone(page);for(const [x,y]of [[.25,.25],[.7,.7],[.25,.7],[.7,.25]])await point(page,x,y);await page.locator('#parking-finish').click();await page.locator('#parking-save').click();await page.locator('#parking-form-status').filter({hasText:'se croise'}).waitFor();assert.equal(data.zones.length,1);assert.equal(writes.length,1);assert.equal(await page.locator('.parking-vertex').count(),4);assert.equal(await page.locator('#parking-save').isDisabled(),false);
 });
});

test('viewers can inspect contours and history without creating, editing or deleting zones',async()=>{
 await fixture(async({page,writes})=>{assert.equal(await page.locator('#parking-new-zone').count(),0);assert.equal(await page.locator('[data-zone-delete]').count(),0);assert.equal(await page.locator('#parking-form').count(),0);await page.locator('[data-zone="'+ZONE+'"]').click();assert.equal(await page.locator('.parking-vertex').count(),0);assert.equal(writes.length,0);assert.match(await page.locator('#parking-events').innerText(),/Casa historique/);},{admin:false,mobile:false});
});
