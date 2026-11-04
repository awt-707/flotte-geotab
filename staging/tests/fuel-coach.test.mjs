import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceFuel,fuelDriver} from '../server/fuel-coach.mjs';
const origin=Date.parse('2026-11-02T10:00:00Z'),iso=t=>new Date(t).toISOString();
const vehicle={key:'car',agency_id:1,geotab_id:'box',ref_l100:5},driver={id:'driver',ludy_driver_code:'D1',vehicle_key:'car',agency_id:1,vehicle_link_method:'manual'};
const settings={enabled:true,excess_pct:30,min_distance_km:10,cooldown_minutes:60};
const input=(step,extra={})=>{const now=origin+step*30000;return {vehicle,driver,settings,now,row:{id:'box',at:iso(now),odometer_m:100000+step*500,total_fuel_l:100+step*.05,counter_at:{odometer_m:iso(now),total_fuel_l:iso(now)}},...extra};};
test('notifies only after enough actual distance measured within the same confirmed driver assignment',()=>{
 let state;for(let i=0;i<=20;i++){const next=advanceFuel(state,input(i));state=next.state;assert.equal(!!next.event,i===20);if(next.event){assert.equal(next.event.kind,'overconsumption');assert.equal(next.event.driverCode,'D1');assert.ok(Math.abs(next.event.evidence.l100-10)<.001);assert.equal(next.event.evidence.cause,'undetermined');}}
 for(let i=21;i<=40;i++){const next=advanceFuel(state,input(i));state=next.state;assert.equal(next.event,null,'cooldown retained across windows');}
});
test('missing data, old counters, driver changes, counter resets and long gaps never blame another driver',()=>{
 const first=advanceFuel(null,input(0));
 for(const args of [input(1,{driver:null}),input(1,{vehicle:{...vehicle,ref_l100:null}}),input(1,{settings:{...settings,enabled:false}})])assert.equal(advanceFuel(first.state,args).state,null);
 const stale=input(10);stale.row.counter_at.total_fuel_l=iso(origin);assert.equal(advanceFuel(first.state,stale).state,null);
 const changed=input(20,{driver:{...driver,ludy_driver_code:'D2'}});assert.equal(advanceFuel(first.state,changed).event,null);
 const reset=input(1);reset.row.odometer_m=5;assert.equal(advanceFuel(first.state,reset).event,null);assert.equal(advanceFuel(first.state,input(20)).event,null,'gap is not a measured window');
});
test('replayed observations and impossible counter jumps are ignored and event keys survive notification commit retries',()=>{
 let state;for(let i=0;i<20;i++)state=advanceFuel(state,input(i)).state;
 const replay=advanceFuel(state,input(18));assert.equal(replay.state,state);assert.equal(replay.event,null);
 const a=advanceFuel(state,input(20)),b=advanceFuel(state,input(21));assert.equal(a.event.eventKey,b.event.eventKey);
 const jump=input(20);jump.row.odometer_m=999999999;assert.equal(advanceFuel(state,jump).event,null);
});
test('vehicle ownership refuses conflicts, duplicates, expired leases and wrong agencies',()=>{
 assert.equal(fuelDriver(vehicle,[driver],[],new Set(),origin),driver);
 assert.equal(fuelDriver(vehicle,[driver],[],new Set(['car']),origin),null);
 assert.equal(fuelDriver(vehicle,[driver,{...driver,id:'another'}],[],new Set(),origin),null);
 assert.equal(fuelDriver(vehicle,[{...driver,agency_id:2}],[],new Set(),origin),null);
 assert.equal(fuelDriver({...vehicle,agency_id:null},[{...driver,agency_id:null}],[],new Set(),origin),null);
 assert.equal(fuelDriver(vehicle,[{...driver,vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'uber',observed_at:iso(origin-90000),expires_at:iso(origin-1)}}],[{id:'uber',status:'healthy',last_success_at:iso(origin),stale_after_s:45}],new Set(),origin),null);
});
test('counter timestamps, device identity and settings changes cannot bridge incompatible measurement windows',()=>{
 const state=advanceFuel(null,input(0)).state;
 const cases=[i=>i.row.id='other-box',i=>i.row.counter_at.total_fuel_l=iso(i.now-10000),i=>i.row.total_fuel_l=-5,i=>i.settings={...settings,min_distance_km:NaN}];
 for(const change of cases){const i=input(1);change(i);assert.equal(advanceFuel(state,i).state,null);}
 for(const change of [{min_distance_km:5},{cooldown_minutes:15},{excess_pct:50}]){const next=advanceFuel(state,input(1,{settings:{...settings,...change}}));assert.equal(next.event,null);assert.equal(next.state.from_at,iso(origin+30000));}
});
test('automatic driver proof requires a bounded lease and a current source clock',()=>{
 const proof={source:'uber',observed_at:iso(origin-10000),expires_at:iso(origin+80000)},auto={...driver,vehicle_link_method:'platform_plate',vehicle_link_evidence:proof},source={id:'uber',status:'healthy',last_success_at:iso(origin),stale_after_s:45};
 assert.equal(fuelDriver(vehicle,[auto],[source],new Set(),origin),auto);
 for(const s of [{...source,last_success_at:iso(origin+10000)},{...source,stale_after_s:0},{...source,stale_after_s:'invalid'},{...source,status:'paused'}])assert.equal(fuelDriver(vehicle,[auto],[s],new Set(),origin),null);
 assert.equal(fuelDriver(vehicle,[{...auto,vehicle_link_evidence:{...proof,observed_at:iso(origin-3600000)}}],[source],new Set(),origin),null);
 assert.equal(fuelDriver(vehicle,[{...auto,vehicle_link_evidence:{...proof,vehicle_key:'another-car'}}],[source],new Set(),origin),null);
});
