import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { driverPlatformActivity } from '../server/platform-activity.mjs';

const [appearance,fleet,operations]=await Promise.all(['map-vehicle-appearance.js','fleet.js','operations.js'].map(file=>readFile(new URL('../site/'+file,import.meta.url),'utf8')));
const observationCode=fleet.slice(fleet.indexOf('function fleetObservation('),fleet.indexOf('function fleetPill('));
const assignmentCode=operations.slice(operations.indexOf('function opsDriverForVehicle('),operations.indexOf('function opsVehicleAssignmentLabel('));
const observedCode=operations.slice(operations.indexOf('function opsObservedDriverForVehicle('),operations.indexOf('function opsDriverNeedsReview('));
function fixture(){
 let time=Date.parse('2026-11-02T12:00:00Z');const at=new Date(time).toISOString(),driver={id:'driver-one',vehicle_key:'test-car',ludy_driver_code:'L1',vehicle_link_method:'manual',sources:{}},sources=['uber','bolt','myclicar'].map(id=>({id,status:'healthy',last_success_at:at,stale_after_s:90}));
 const context=vm.createContext({Date:class extends Date{static now(){return time;}},S:{session:{user:{id:'local-user'}}},OPS:{owner:'local-user',overviewAt:time,overview:{drivers:[driver],sources}},parking:null,row:{vehicle_key:'test-car',speed:0,live:true,last_pos_at:at}});
 vm.runInContext('function mapUnusedParking(){return parking;}',context);vm.runInContext(observationCode+assignmentCode+observedCode+appearance,context);
 function set(states){
  const latest=Object.entries(states).map(([source,status])=>({identity_id:source+'-account',driver_id:driver.id,source,status,observed_at:at,received_at:at,offline_since:status==='offline'?at:null,stale_after_s:90,evidence:{}}));
  driver.sources=Object.fromEntries(latest.map(row=>[row.source,row]));driver.platform_activity=driverPlatformActivity({driverId:driver.id,latest,identities:latest.map(row=>({id:row.identity_id,source:row.source,driver_id:driver.id})),sources,now:time});
  return latest;
 }
 set({uber:'available'});
 return {context,driver,sources,at,now:()=>time,set,advance:ms=>time+=ms,read:()=>JSON.parse(JSON.stringify(vm.runInContext('mapVehicleAppearance(row)',context)))};
}

test('fresh Uber and Bolt observations expose the exact platform status independently of GPS motion',()=>{
 for(const provider of ['uber','bolt'])for(const [status,label]of Object.entries({available:'Disponible',on_trip:'En course',to_pickup:'Vers le client',on_break:'En pause',offline:'Hors ligne'})){
  const f=fixture();f.set({[provider]:status});f.context.row.state='En route';f.context.row.speed=55;let result=f.read();assert.equal(result.kind,provider);assert.equal(result.status,status);assert.equal(result.statusLabel,label);
  f.context.row.state='Garé';f.context.row.speed=0;result=f.read();assert.equal(result.status,status,'stationary GPS does not rewrite a platform observation');
 }
});

test('current trip, pickup, availability and break evidence have deterministic cross-platform priority',()=>{
 const f=fixture();
 for(const [states,kind,status]of [
  [{uber:'on_trip',bolt:'offline'},'uber','on_trip'],[{uber:'offline',bolt:'on_trip'},'bolt','on_trip'],
  [{uber:'available',bolt:'to_pickup'},'bolt','to_pickup'],[{uber:'on_trip',bolt:'to_pickup'},'uber','on_trip'],
  [{uber:'on_break',bolt:'available'},'bolt','available'],[{uber:'available',bolt:'available'},'both','available'],
  [{uber:'on_trip',bolt:'on_trip'},'both','on_trip'],[{uber:'offline',bolt:'offline'},'both','offline']
 ]){f.set(states);assert.equal(f.read().kind,kind);assert.equal(f.read().status,status);}
});

test('an offline account cannot hide another account or an unobserved known identity',()=>{
 const f=fixture(),latest=f.set({uber:'offline'}),other={...latest[0],identity_id:'second-uber-account',status:'on_trip',offline_since:null};
 f.driver.platform_activity=driverPlatformActivity({driverId:f.driver.id,latest:[...latest,other],identities:[...latest,other].map(row=>({id:row.identity_id,source:row.source,driver_id:row.driver_id})),sources:f.sources,now:f.now()});
 assert.equal(f.driver.platform_activity.status,'online');assert.equal(f.read().status,'unknown','a hidden active account prevents red without guessing its visible status');
 f.driver.platform_activity=driverPlatformActivity({driverId:f.driver.id,latest,identities:[{id:latest[0].identity_id,source:'uber',driver_id:f.driver.id},{id:'known-bolt-no-observation',source:'bolt',driver_id:f.driver.id}],sources:f.sources,now:f.now()});
 assert.equal(f.driver.platform_activity.status,'unknown');assert.equal(f.read().status,'unknown');
 delete f.driver.platform_activity;assert.equal(f.read().status,'unknown','the display never invents an all-account offline verdict');
});

test('stale observations, failed sources and inactive accounts never create a red marker',()=>{
 for(const mutate of [
  f=>f.driver.sources.uber.observed_at=new Date(f.now()-91000).toISOString(),
  f=>f.driver.sources.uber.observed_at=new Date(f.now()+6000).toISOString(),
  f=>f.driver.sources.uber.stale=true,
  f=>f.sources[0].status='error',
  f=>f.sources[0].last_success_at=new Date(f.now()-91000).toISOString(),
  f=>f.driver.sources.uber.evidence.account_status='suspended',
  f=>f.driver.sources.uber.evidence.account_status='deactivated'
 ]){const f=fixture();f.set({uber:'offline'});mutate(f);assert.equal(f.read().status,'unknown');assert.equal(f.read().kind,'neutral');}
 const f=fixture();f.set({uber:'offline',bolt:'available'});f.sources[0].status='error';assert.equal(f.read().status,'available');assert.equal(f.read().kind,'bolt');
});

test('branding stops with an expired, conflicting or wrong-owner vehicle assignment',()=>{
 const f=fixture();f.driver.vehicle_link_method='platform_plate';f.driver.vehicle_link_evidence={source:'uber',method:'platform_plate',observed_at:f.at,expires_at:new Date(f.now()+120000).toISOString()};
 assert.equal(f.read().kind,'uber');f.driver.vehicle_link_evidence.expires_at=f.at;assert.equal(f.read().status,'unknown');
 f.driver.vehicle_link_method='manual';f.driver.vehicle_conflict=true;assert.equal(f.read().status,'unknown');f.driver.vehicle_conflict=false;
 f.context.OPS.overview.drivers.push({...f.driver,id:'another-driver'});assert.equal(f.read().status,'unknown');f.context.OPS.overview.drivers.pop();
 f.context.OPS.overviewAt=f.now()-30001;assert.equal(f.read().kind,'neutral');f.context.OPS.overviewAt=f.now();f.context.S.session.user.id='another-user';assert.equal(f.read().kind,'neutral');
});

test('proof of unused parking overrides offline only while the position remains current and stationary',()=>{
 const f=fixture();f.set({uber:'offline'});f.context.parking={vehicle_key:'test-car',position_at:f.at,zone_name:'Synthetic parking'};
 assert.equal(f.read().status,'parking');assert.equal(f.read().kind,'parking');f.context.row.speed=20;assert.equal(f.read().status,'offline');
 f.context.row.speed=0;f.context.row.last_pos_at=new Date(f.now()-1000).toISOString();assert.equal(f.read().status,'offline','a position preceding the parking proof cannot reuse it');
 f.context.row.last_pos_at=f.at;f.set({uber:'available'});assert.equal(f.read().status,'available','current platform use takes priority over a parking sample');
 f.context.parking=null;f.context.OPS.overview.drivers=[];assert.equal(f.read().status,'unknown','a stopped unassigned car is not inferred to be parked');
});

test('a display-only platform observation paints the real current driver without becoming an offline assignment',()=>{
 const f=fixture();f.set({uber:'offline'});f.driver.vehicle_key=null;f.driver.ludy_driver_code=null;
 f.context.OPS.overview.vehicle_observations=[{vehicle_key:'test-car',driver_id:f.driver.id,source:'uber',status:'on_trip',observed_at:f.at,expires_at:new Date(f.now()+90000).toISOString()}];
 assert.equal(f.read().kind,'uber');assert.equal(f.read().status,'on_trip');assert.equal(f.driver.vehicle_key,null);assert.equal(f.driver.ludy_driver_code,null);
 assert.equal(vm.runInContext('opsDriverForVehicle(row.vehicle_key)',f.context),null,'the display evidence does not become a current Ludy assignment');
 f.context.OPS.overview.vehicle_observations[0].expires_at=f.at;assert.equal(f.read().status,'unknown');
 f.context.OPS.overview.vehicle_observations[0].expires_at=new Date(f.now()+90000).toISOString();f.context.OPS.overview.vehicle_observations[0].status='offline';assert.equal(f.read().status,'unknown','only a confirmed assignment can display the all-account offline verdict');
});
