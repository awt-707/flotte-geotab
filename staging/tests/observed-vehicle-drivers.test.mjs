import test from 'node:test';
import assert from 'node:assert/strict';
import {observedVehicleDrivers} from '../server/observed-vehicle-drivers.mjs';
const NOW=Date.parse('2026-11-02T12:00:00Z'),stamp=offset=>new Date(NOW+offset).toISOString();
function fixture(){
 return {now:NOW,drivers:[{id:'unlinked-driver',name:'Synthetic Driver',ludy_driver_code:null,vehicle_key:null}],vehicles:[{key:'car-one',plate:'86437-T-1',other_plates:'OLD-123',active:'OUI'},{key:'car-two',plate:'968201WW',active:'OUI'}],
 sources:['uber','bolt'].map(id=>({id,status:'healthy',stale_after_s:90,last_success_at:stamp(0)})),
 latest:[{identity_id:'uber-one',driver_id:'unlinked-driver',source:'uber',status:'on_trip',vehicle_label:'86437-T-1',observed_at:stamp(0),evidence:{method:'visible_dom',vehicle_observed_at:stamp(0),vehicle_status:'on_trip'}}]};
}
test('a unique current platform plate exposes only display evidence without creating an assignment',()=>{
 const input=fixture(),before=JSON.stringify(input),rows=observedVehicleDrivers(input);assert.deepEqual(rows,[{vehicle_key:'car-one',driver_id:'unlinked-driver',source:'uber',status:'on_trip',observed_at:stamp(0),expires_at:stamp(90000)}]);assert.equal(JSON.stringify(input),before);assert.deepEqual(Object.keys(rows[0]).sort(),['driver_id','expires_at','observed_at','source','status','vehicle_key']);assert.equal(input.drivers[0].vehicle_key,null);assert.equal(input.drivers[0].ludy_driver_code,null);
});
test('Bolt requires its live vehicle, while Moroccan plate aliases follow the existing exact normalization',()=>{
 const f=fixture();f.latest[0]={...f.latest[0],source:'bolt',vehicle_label:'WW968201',evidence:{method:'official_api',vehicle_origin:'selected'}};assert.deepEqual(observedVehicleDrivers(f),[]);f.latest[0].evidence.vehicle_origin='bolt_live';assert.equal(observedVehicleDrivers(f)[0].vehicle_key,'car-two');
 f.latest[0].vehicle_label='old123';assert.equal(observedVehicleDrivers(f)[0].vehicle_key,'car-one');
});
test('the projection respects visible drivers and vehicles and excludes inactive vehicles',()=>{
 for(const change of [f=>f.drivers=[],f=>f.vehicles=[],f=>f.vehicles[0].active=false,f=>f.vehicles[0].active='NON']){const f=fixture();change(f);assert.deepEqual(observedVehicleDrivers(f),[]);}
});
test('stale, paused, unknown or inactive-account observations cannot paint a platform vehicle',()=>{
 for(const change of [
  f=>f.latest[0].status='offline',f=>f.latest[0].status='unknown',
  f=>f.latest[0].observed_at=stamp(-91000),f=>f.latest[0].observed_at=stamp(6000),
  f=>f.latest[0].evidence.vehicle_observed_at=stamp(-181000),f=>f.latest[0].evidence.vehicle_observed_at=stamp(1000),
  f=>f.latest[0].evidence.account_status='suspended',f=>f.latest[0].evidence.account_status='deactivated',
  f=>f.sources[0].status='paused',f=>f.sources[0].last_success_at=stamp(-91000),f=>f.sources[0].last_success_at=stamp(6000),
  f=>f.sources[0].stale_after_s=0,f=>f.sources.push({...f.sources[0]})
 ]){const f=fixture();change(f);assert.deepEqual(observedVehicleDrivers(f),[]);}
});
test('ambiguous registration plates and simultaneous competing drivers never select an arbitrary driver',()=>{
 const f=fixture();f.vehicles.push({...f.vehicles[0],key:'duplicate-plate'});assert.deepEqual(observedVehicleDrivers(f),[]);
 const g=fixture();g.drivers.push({id:'other-driver'});g.latest.push({...g.latest[0],identity_id:'other-identity',driver_id:'other-driver'});assert.deepEqual(observedVehicleDrivers(g),[]);
});
test('one driver claiming multiple cars is left unprojected, including an unmatched plate',()=>{
 for(const plate of ['968201WW','UNMATCHED-CAR']){const f=fixture();f.latest.push({...f.latest[0],identity_id:'bolt-two',source:'bolt',vehicle_label:plate,evidence:{method:'official_api',vehicle_origin:'bolt_live'}});assert.deepEqual(observedVehicleDrivers(f),[]);}
});
test('two providers on the same vehicle remain visible and duplicate accounts use their strongest current activity',()=>{
 const f=fixture();f.latest.push({...f.latest[0],identity_id:'bolt-two',source:'bolt',status:'available',evidence:{method:'official_api',vehicle_origin:'bolt_live'}});
 f.latest.push({...f.latest[0],identity_id:'uber-two',status:'available'});const rows=observedVehicleDrivers(f);assert.equal(rows.length,2);assert.equal(rows.find(row=>row.source==='uber').status,'on_trip');assert.equal(rows.find(row=>row.source==='bolt').status,'available');
});
test('expiry is bounded by the platform sample, source health and separate vehicle observation',()=>{
 const f=fixture();f.latest[0].observed_at=stamp(-20000);f.latest[0].evidence.vehicle_observed_at=stamp(-140000);f.sources[0].last_success_at=stamp(-10000);assert.equal(observedVehicleDrivers(f)[0].expires_at,stamp(40000));
 f.latest[0].evidence.vehicle_observed_at=stamp(-20000);f.sources[0].last_success_at=stamp(-60000);assert.equal(observedVehicleDrivers(f)[0].expires_at,stamp(30000));
});
