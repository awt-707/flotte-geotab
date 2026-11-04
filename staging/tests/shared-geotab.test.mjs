import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedGeotabLive} from '../server/shared-geotab.mjs';
const now=Date.parse('2026-11-04T09:00:00Z'),at=new Date(now-1000).toISOString();
const input=()=>({now,source:{status:'healthy',last_success_at:at},vehicles:[{key:'v1',plate:'TEST',geotab_id:'g1'}],positions:[{vehicle_key:'v1',state:'Conduite',lat:1,lon:2,speed:20,last_pos_at:at,updated_at:at,ign_on:true}],
  snapshots:[{vehicle_key:'v1',observed_at:at,data:{device_id:'g1',captured_at:at,bearing:90,telemetry:{at,odometer_km:123},events:[{at,end:at,name:'Synthetic event'}],extra:{telemetry_status:'healthy',events_status:'healthy'}}}],motion:{alerts:[],coverage:{},watches:[]}});
test('standby reconstructs fresh positions, sensor data and events without local provider credentials',()=>{
  const result=sharedGeotabLive(input());assert.equal(result.source.status,'healthy');assert.equal(result.source.polling,true);assert.equal(result.source.collectionRemote,true);
  assert.equal(result.vehicles[0].fresh,true);assert.equal(result.vehicles[0].bearing,90);assert.equal(result.telemetry.v1.odometer_km,123);assert.equal(result.telemetry.v1.fresh,true);assert.equal(result.events[0].key,'v1');
});
test('old snapshots and changed tracker bindings never carry sensor proof into a new vehicle binding',()=>{
  const old=input();old.snapshots[0].observed_at=new Date(now-60000).toISOString();const result=sharedGeotabLive(old);assert.deepEqual(result.telemetry,{});assert.equal(result.vehicles[0].bearing,null);
  const rebound=input();rebound.vehicles[0].geotab_id='g2';const changed=sharedGeotabLive(rebound);assert.deepEqual(changed.telemetry,{});
  assert.equal(changed.vehicles[0].fresh,false);assert.equal(changed.vehicles[0].speed,null);assert.equal(changed.vehicles[0].ign_on,null);
});
test('loss of shared heartbeat suspends fresh motion claims and source freshness on every standby',()=>{
  const data=input();data.source.last_success_at=new Date(now-90000).toISOString();data.motion={alerts:[{key:'v1',status:'open'}],watches:[{key:'v1'}],coverage:{}};
  const result=sharedGeotabLive(data);assert.equal(result.source.status,'stale');assert.equal(result.vehicles[0].speed,null);assert.equal(result.telemetry.v1.fresh,false);assert.equal(result.motion_alerts[0].status,'suspended');assert.deepEqual(result.motion_watches,[]);
});
test('rows outside the user-visible vehicle catalogue are omitted from all output collections',()=>{
  const data=input();data.vehicles=[];const result=sharedGeotabLive(data);assert.deepEqual(result.vehicles,[]);assert.deepEqual(result.events,[]);assert.deepEqual(result.telemetry,{});
});
test('shared motion errors suspend alerts and watches even while positions remain fresh',()=>{
  const data=input();data.snapshots[0].data.extra.motion_error='Surveillance indisponible';
  data.motion={alerts:[{key:'v1',status:'open'}],watches:[{key:'v1'}],coverage:{}};
  const result=sharedGeotabLive(data);assert.equal(result.vehicles[0].fresh,true);
  assert.equal(result.motion_alerts[0].status,'suspended');assert.deepEqual(result.motion_watches,[]);
});
test('future telemetry and position receipt timestamps cannot establish freshness',()=>{
  const data=input(),future=new Date(now+120000).toISOString();
  data.snapshots[0].data.telemetry.at=future;data.positions[0].updated_at=future;
  const result=sharedGeotabLive(data);assert.equal(result.telemetry.v1.fresh,false);assert.equal(result.vehicles[0].fresh,false);
});
