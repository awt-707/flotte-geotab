import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const direct=await readFile(new URL('../site/direct.js',import.meta.url),'utf8'),markerCode=direct.slice(direct.indexOf('const CAR_SVG ='),direct.indexOf('function osmLayer('));
const css=await readFile(new URL('../site/style.css',import.meta.url),'utf8'),leaflet=await readFile(new URL('../../node_modules/leaflet/dist/leaflet.js',import.meta.url),'utf8'),leafletCss=await readFile(new URL('../../node_modules/leaflet/dist/leaflet.css',import.meta.url),'utf8');
test('map markers update platform, parking and critical states in place while brands stay horizontal and accessible',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:820},reducedMotion:'reduce'}),errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!=='http://fixture.invalid'||url.pathname!=='/'){network.push(url.hostname);return route.abort();}return route.fulfill({contentType:'text/html',body:'<!doctype html><html data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+leafletCss+'body{margin:0;padding:24px;background:#eef3f6}.marker-preview h1{font:600 24px system-ui;margin:0 0 8px}.marker-preview>p{color:#5b6f7c;margin:0 0 24px}.samples{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.sample{position:relative;min-height:176px;background:#fff;border:1px solid #d6e0e6;border-radius:15px;padding:16px}.sample h2{font:600 16px system-ui;margin:0}.sample p{font:12px/1.5 system-ui;color:#536d7e;position:absolute;bottom:12px;left:16px;right:16px;margin:0}.sample-marker{position:absolute;top:60px;left:20px;width:40px;height:40px}#marker-map{height:390px;margin-top:24px;background:#dce8ed;border-radius:15px;background-image:linear-gradient(#fff6 1px,transparent 1px),linear-gradient(90deg,#fff6 1px,transparent 1px);background-size:40px 40px}.leaflet-container{font-family:system-ui}@media(max-width:650px){body{padding:14px}.samples{grid-template-columns:1fr}.sample{min-height:150px}.sample-marker{left:30px;top:52px}}</style><section class="marker-preview"><h1>Les repères de la flotte</h1><p>Plateforme confirmée, voiture au parking et état Geotab.</p><div class="samples"></div></section><div id="marker-map"></div></html>'});});
  await page.goto('http://fixture.invalid/');await page.addScriptTag({content:leaflet});
  await page.evaluate(()=>{window.LIVE={fast:{},over:{},motion:{},markers:{},trails:{}};window.CFG={GEOTAB_LOCAL:true};window.TRAIL_MAX=240;window.HORS='HORS';window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.f0=n=>String(Math.round(n));window.fH=n=>String(n);window.plate=p=>'<b>'+esc(p)+'</b>';window.fmtHMS=v=>v;window.fmtDT=v=>v;window.ST_CLS=s=>s==='En route'?'ok':s==='Arrêté, contact mis'?'warn':'mute';window.appearances={uber:{kind:'uber',status:'on_trip',label:'Uber · En course'},bolt:{kind:'bolt',status:'to_pickup',label:'Bolt · Vers le client'},both:{kind:'both',status:'available',label:'Uber et Bolt · Disponibles'},parking:{kind:'parking',status:'parking',label:'Inutilisé au parking'},neutral:{kind:'neutral',status:'unknown',label:'Plateforme non confirmée'}};window.mapVehicleAppearance=r=>appearances[r.vehicle_key];window.rows=Object.keys(appearances).map((kind,i)=>({vehicle_key:kind,plate:'TEST-0'+(i+1),model:'SYNTHETIC',driver_name:'Chauffeur de test',lat:33.6+(i%2)*.01,lon:-7.63+i*.012,state:kind==='parking'?'Garé':'En route',speed:34,bearing:i*45,live:true,last_pos_at:'2026-11-02T12:00:00Z'}));window.MAP=L.map('marker-map',{zoomControl:false}).setView([33.605,-7.606],13);});
  await page.addScriptTag({content:markerCode});await page.evaluate(()=>{document.querySelector('.samples').innerHTML=rows.map(r=>'<article class="sample"><h2>'+({uber:'Uber',bolt:'Bolt',both:'Uber + Bolt',parking:'Au parking',neutral:'Non confirmé'}[r.vehicle_key])+'</h2><div class="sample-marker">'+vIcon(r).html+'</div><p>'+esc(appearances[r.vehicle_key].label)+'</p></article>').join('');rows.forEach(placeMarker);});
  assert.equal(await page.locator('#marker-map .leaflet-marker-icon').count(),5);
  assert.equal(await page.locator('#marker-map [data-kind="both"]').locator('..').locator('.vmk-brand').count(),2);
  assert.equal(await page.locator('#marker-map [data-kind="parking"] .vmk-parking').textContent(),'P');
  assert.match(await page.locator('#marker-map [data-kind="parking"]').getAttribute('aria-label'),/Inutilisé au parking/);
  await mkdir(new URL('../.local/screenshots/',import.meta.url),{recursive:true});
  await page.locator('.marker-preview').screenshot({path:new URL('../.local/screenshots/map-markers-preview.png',import.meta.url).pathname});
  await writeFile(new URL('../.local/map-markers-preview.html',import.meta.url),await page.content());
  await page.evaluate(()=>{window.savedMarker=LIVE.markers.uber;window.savedCoordinates=savedMarker.getLatLng();appearances.uber={kind:'bolt',status:'available',label:'Bolt confirmé · Disponible'};LIVE.motion.uber={id:'synthetic-critical'};rows[0].bearing=135;placeMarker(rows[0]);});
  assert.equal(await page.evaluate(()=>LIVE.markers.uber===savedMarker&&savedMarker.getLatLng().equals(savedCoordinates)),true,'status changes retain the existing marker and position');
  assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-pin').classList.contains('has-critical')),true);
  assert.equal(await page.evaluate(()=>getComputedStyle(savedMarker.getElement().querySelector('.vmk-pin')).borderTopColor),'rgb(98, 107, 120)');
  assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-brand').textContent),'Bolt');
  assert.match(await page.evaluate(()=>savedMarker.getTooltip().getContent()),/Bolt confirmé/);assert.match(await page.evaluate(()=>savedMarker.getPopup().getContent()),/Bolt confirmé/);
  assert.equal(await page.evaluate(()=>getComputedStyle(savedMarker.getElement().querySelector('.vmk-brand')).transform),'none');
  assert.notEqual(await page.evaluate(()=>getComputedStyle(savedMarker.getElement().querySelector('.vmk-car-direction')).transform),'none');
  assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-critical').textContent),'!');
  for(const [status,color] of [['available','rgb(98, 107, 120)'],['on_trip','rgb(37, 99, 235)'],['to_pickup','rgb(22, 132, 86)'],['on_break','rgb(184, 117, 9)'],['offline','rgb(189, 44, 64)'],['unknown','rgb(153, 165, 180)']]){
    await page.evaluate(status=>{appearances.uber={kind:'bolt',status,label:'Bolt · '+status};placeMarker(rows[0]);},status);
    assert.equal(await page.evaluate(()=>getComputedStyle(savedMarker.getElement().querySelector('.vmk-car-body')).fill),color,'car body follows '+status);
    assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-pin').dataset.status),status);
    assert.equal(await page.evaluate(()=>savedMarker===LIVE.markers.uber),true);
    assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-critical').textContent),'!','critical alert never replaces platform activity');
  }
  await page.evaluate(()=>{appearances.uber={kind:'parking',status:'parking',label:'Inutilisé au parking'};rows[0].state='Garé';placeMarker(rows[0]);});assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-brands')===null&&savedMarker.getElement().querySelector('.vmk-parking').textContent==='P'),true);
  await page.evaluate(()=>{appearances.uber={kind:'parking',status:'parking',lastKnown:true,label:'Dernière position au parking · Zone test · 02/11 08:00'};rows[0].live=false;placeMarker(rows[0]);});
  assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-pin').dataset.positionBasis),'last_known_parking');
  assert.equal(await page.evaluate(()=>getComputedStyle(savedMarker.getElement().querySelector('.vmk-pin')).borderTopColor),'rgb(126, 139, 157)');
  assert.match(await page.evaluate(()=>savedMarker.getTooltip().getContent()),/Dernière position au parking.*02\/11 08:00/);
  assert.equal(await page.evaluate(()=>rows[0].live),false,'historical parking never turns GPS into a live position');
  await page.evaluate(()=>{delete window.mapVehicleAppearance;placeMarker(rows[0]);});assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-pin').dataset.kind),'neutral');assert.match(await page.evaluate(()=>savedMarker.getTooltip().getContent()),/Plateforme non confirmée/);
  assert.equal(await page.evaluate(()=>savedMarker.getElement().querySelector('.vmk-pin').dataset.positionBasis),'last_known');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(network,[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
