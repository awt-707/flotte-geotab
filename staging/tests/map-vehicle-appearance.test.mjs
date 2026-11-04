import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const timezone=await readFile(new URL('../site/timezone.js',import.meta.url),'utf8');
const script=await readFile(new URL('../site/map-vehicle-appearance.js',import.meta.url),'utf8');
function fixture(){
 const now=Date.parse('2026-11-02T12:00:00Z'),at=new Date(now).toISOString();
 const context=vm.createContext({Date:class extends Date{static now(){return now;}},S:{session:{user:{id:'test-user'}}},OPS:{owner:'test-user',overviewAt:now,overview:{sources:['uber','bolt'].map(id=>({id,status:'healthy',last_success_at:at,stale_after_s:90}))}},driver:{sources:{uber:{status:'available'}}},parking:null,row:{vehicle_key:'test-car',speed:0,live:1,last_pos_at:at}});
 vm.runInContext('function opsDriverForVehicle(){return driver;} function fleetObservation(d,p){return d.sources[p]||null;} function mapUnusedParking(){return parking;}',context);vm.runInContext(timezone+'\n'+script,context);
 return {context,at,now,kind:()=>vm.runInContext('mapVehicleAppearance(row).kind',context)};
}
test('car badges follow the current active platforms, prioritizing the platform carrying a trip',()=>{
 const f=fixture();assert.equal(f.kind(),'uber');f.context.driver.sources.bolt={status:'available'};assert.equal(f.kind(),'both');
 f.context.driver.sources.bolt.status='on_trip';assert.equal(f.kind(),'bolt');
 f.context.driver.sources.bolt.status='offline';assert.equal(f.kind(),'uber');
 f.context.driver.sources.uber.status='unknown';assert.equal(f.kind(),'neutral');
 f.context.driver={sources:{bolt:{status:'to_pickup'}}};assert.equal(f.kind(),'bolt','shift changes use the new current assignment');
 f.context.driver=null;assert.equal(f.kind(),'neutral','an unconfirmed assignment is not attributed to a provider');
});
test('failed sources, stale overview and changed session remove platform branding',()=>{
 const f=fixture();f.context.OPS.overview.sources[0].status='error';assert.equal(f.kind(),'neutral');
 f.context.OPS.overview.sources[0].status='healthy';f.context.OPS.overview.sources[0].last_success_at=new Date(f.now-91000).toISOString();assert.equal(f.kind(),'neutral');
 f.context.OPS.overview.sources[0].last_success_at=f.at;f.context.driver.sources.uber.evidence={account_status:'suspended'};assert.equal(f.kind(),'neutral');
 delete f.context.driver.sources.uber.evidence;f.context.OPS.overviewAt=f.now-31000;assert.equal(f.kind(),'neutral');
 f.context.OPS.overviewAt=f.now;f.context.S.session.user.id='another-user';assert.equal(f.kind(),'neutral');
});
test('a parking icon requires server proof and a current stationary position; active platform usage takes priority',()=>{
 const f=fixture();f.context.parking={vehicle_key:'test-car',position_at:f.at,zone_name:'Synthetic parking'};assert.equal(f.kind(),'uber');
 f.context.driver=null;assert.equal(f.kind(),'parking');f.context.row.speed=12;assert.equal(f.kind(),'neutral');
 f.context.row.speed=0;f.context.row.live=0;assert.equal(f.kind(),'neutral');f.context.row.live=1;
 f.context.row.last_pos_at=new Date(f.now-60000).toISOString();assert.equal(f.kind(),'neutral','a delayed GPS response cannot reuse a newer parking confirmation');
 f.context.row.last_pos_at=new Date(f.now+1000).toISOString();assert.equal(f.kind(),'neutral','a newer position cannot borrow a proof for the previous parking fix');
 f.context.row.last_pos_at=f.at;f.context.parking=null;assert.equal(f.kind(),'neutral','being stopped alone cannot imply unused parking');
});

function historicalFixture(){
 const f=fixture(),position_at=new Date(f.now-7*60000).toISOString();f.context.driver=null;f.context.S.veh={'test-car':{geotab_id:'test-device'}};
 f.context.LIVE={err:'',localSource:{polling:true,status:'healthy',last_success_at:f.at,stale_after_s:20}};
 Object.assign(f.context.row,{last_pos_at:position_at,lat:33.6,lon:-7.6,speed:null,live:0,ign_on:null});
 f.context.parking={vehicle_key:'test-car',position_at,checked_at:f.at,zone_name:'Synthetic parking',lat:33.6,lon:-7.6,device_id:'test-device',ign_on:false,position_basis:'last_known_parking',presence_current:false};return f;
}
test('a recently checked unused vehicle can show a dated historical parking mark without inventing live presence',()=>{
 const f=historicalFixture(),appearance=vm.runInContext('mapVehicleAppearance(row)',f.context);assert.equal(appearance.kind,'parking');assert.equal(appearance.parkingFresh,false);assert.equal(appearance.lastKnown,true);assert.equal(appearance.positionAt,f.context.row.last_pos_at);assert.equal(appearance.positionBasis,'last_known_parking');assert.equal(appearance.statusLabel,'Dernière position au parking');assert.match(appearance.label,/02\/11\/2026 11:53.*Synthetic parking/);assert.equal(f.context.row.live,0);assert.equal(f.context.row.speed,null);assert.equal(f.context.row.ign_on,null);
 f.context.driver={sources:{uber:{status:'on_trip'}}};assert.equal(f.kind(),'uber','confirmed current platform usage outranks a historical parking fix');
});
test('historical parking requires the same fix, coordinates, device and a recent explicit server assessment',()=>{
 const changes=[
  f=>f.context.parking.checked_at=new Date(f.now-15001).toISOString(),
  f=>f.context.parking.checked_at=new Date(f.now+6000).toISOString(),
  f=>delete f.context.parking.checked_at,
  f=>f.context.parking.position_at=f.at,
  f=>f.context.row.last_pos_at=f.at,
  f=>f.context.row.lat+=.001,
  f=>f.context.row.lon=null,
  f=>delete f.context.S.veh,
  f=>f.context.S.veh['test-car'].geotab_id='replacement-device',
  f=>f.context.parking.presence_current=true,
  f=>delete f.context.parking.presence_current,
  f=>f.context.parking.ign_on=null,
  f=>f.context.row.ign_on=true,
  f=>f.context.row.speed=12,
  f=>f.context.row.crs={id:'current-private-mission'},
  f=>f.context.LIVE.localSource.status='error',
  f=>f.context.LIVE.localSource.polling=false,
  f=>f.context.LIVE.localSource.last_success_at=new Date(f.now-21000).toISOString(),
  f=>f.context.LIVE.err='Unavailable',
  f=>delete f.context.LIVE,
  f=>{const old=new Date(f.now-8*86400000).toISOString();f.context.row.last_pos_at=old;f.context.parking.position_at=old;},
  f=>f.context.S.session=null
 ];
 for(const change of changes){const f=historicalFixture();change(f);assert.equal(f.kind(),'neutral',String(change));}
});
test('a current private mission also prevents interpreting a fresh stationary car as unused parking',()=>{
 const f=fixture();f.context.driver=null;f.context.parking={position_at:f.at,zone_name:'Synthetic parking'};assert.equal(f.kind(),'parking');f.context.row.crs={id:'current-private-mission'};assert.equal(f.kind(),'neutral');
});
