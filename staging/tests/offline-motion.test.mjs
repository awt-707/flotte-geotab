import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceOfflineMotion, gpsDistanceMetres} from '../server/offline-motion.mjs';

const T = Date.parse('2026-10-30T12:00:00Z');
const iso = seconds => new Date(T + seconds * 1000).toISOString();
const point = (metres, seconds, extra={}) => ({lat:48 + metres / 6371008.8 * 180 / Math.PI, lon:2, at:iso(seconds), speed:36, ign_on:true, ...extra});
function sample(seconds, metres, extra={}) {
  return {now:T + seconds * 1000,
    row:{identity_id:'uber-identity', driver_id:'driver-one', source:'uber', status:'offline', observed_at:iso(seconds), offline_since:iso(0)},
    source:{id:'uber', status:'healthy', stale_after_s:45},
    driver:{id:'driver-one', vehicle_key:'vehicle-one'},
    geotab:{status:'healthy', last_success_at:iso(seconds), stale_after_s:20},
    position:point(metres, seconds), ...extra};
}
function run(points, extra={}) {
  let state=null; const results=[];
  for (const [seconds, metres, overrides={}] of points) {
    const result=advanceOfflineMotion(state, sample(seconds, metres, {...extra,...overrides}));
    results.push(result); state=result.state;
  }
  return results;
}

test('GPS distance handles valid coordinates and refuses missing, string, zero and impossible fixes',()=>{
  assert.ok(Math.abs(gpsDistanceMetres(point(0,0), point(200,20))-200)<1e-6);
  for (const invalid of [{lat:0,lon:0}, {lat:'48',lon:2}, {lat:91,lon:2}, {lat:48,lon:181}, {lat:NaN,lon:2}, null]) assert.equal(gpsDistanceMetres(point(0,0),invalid),null);
});

test('offline movement alerts strictly beyond 200 m and emits only once in an episode',()=>{
  const results=run([[0,0],[10,100],[20,200],[21,211],[30,300]]);
  assert.ok(results.slice(0,3).every(r=>r.alert===null));
  const alert=results[3].alert;
  assert.equal(alert.kind,'offline_movement');
  assert.equal(alert.severity,'critical');
  assert.equal(alert.source,'uber');
  assert.ok(alert.distance_m>=211 && alert.distance_m<=212);
  assert.equal(alert.threshold_m,200);
  assert.equal(alert.evidence.method,'gps_segments');
  assert.equal(alert.evidence.engine_state,'on');
  assert.equal(alert.observed_since,iso(0));
  assert.equal(results[4].alert,null);
  assert.equal(results[4].reason,'already_alerted');
});

test('Bolt uses its own explicit offline episode without requiring Uber to be offline',()=>{
  let state;
  for(const [seconds,metres] of [[0,0],[10,100],[22,220]]) {
    const input=sample(seconds,metres);
    input.row={...input.row, identity_id:'bolt-identity', source:'bolt'};
    input.source={...input.source,id:'bolt'};
    const result=advanceOfflineMotion(state,input);state=result.state;
    if(seconds===22)assert.equal(result.alert.source,'bolt');
  }
});

test('an inactive Bolt account never starts an offline movement watch',()=>{
  for(const account_status of ['deactivated','suspended','SUSPENDED']) {
    const input=sample(0,0);input.row.source='bolt';input.source.id='bolt';input.row.evidence={account_status};
    assert.equal(advanceOfflineMotion(null,input).reason,'account_inactive');
  }
});

test('unknown, absent and online states cannot start or retain a movement watch',()=>{
  const tracked=run([[0,0],[10,100]])[1].state;
  for(const status of ['available','on_trip','to_pickup','unknown','on_break',null]) {
    const input=sample(15,150);input.row.status=status;
    assert.equal(advanceOfflineMotion(tracked,input).state,null);
  }
  assert.equal(advanceOfflineMotion(tracked,{...sample(15,150),row:null}).state,null);
});

test('a current explicit driver to vehicle assignment is mandatory; names never assign a driver',()=>{
  for (const driver of [null,{id:'driver-one',name:'Example'},{id:'different-driver',vehicle_key:'vehicle-one'}]) {
    assert.equal(advanceOfflineMotion(null,sample(0,0,{driver})).reason,'assignment_missing');
  }
  const input=sample(0,0);input.source.id='bolt';
  assert.equal(advanceOfflineMotion(null,input).reason,'source_mismatch');
});

test('renewing a MyClicar lease preserves distance but changing contract resets it for the same driver and car',()=>{
  const assigned=(contract,seconds)=>({id:'driver-one',vehicle_key:'vehicle-one',vehicle_link_method:'myclicar_contract',
    vehicle_link_evidence:{contract_id:contract,observed_at:iso(seconds),expires_at:iso(seconds+300)}});
  const baseline=advanceOfflineMotion(null,sample(0,0,{driver:assigned('contract-a',0)})).state;
  const renewed=advanceOfflineMotion(baseline,sample(15,150,{driver:assigned('contract-a',15)}));
  assert.ok(renewed.state.distance_m>149);
  const replaced=advanceOfflineMotion(renewed.state,sample(25,250,{driver:assigned('contract-b',25)}));
  assert.equal(replaced.reason,'baseline');assert.equal(replaced.state.distance_m,0);assert.equal(replaced.alert,null);
  const next=advanceOfflineMotion(replaced.state,sample(35,350,{driver:assigned('contract-b',35)}));
  assert.ok(next.state.distance_m<101);assert.equal(next.alert,null);
});

test('a refreshed assignment cannot bridge an expired lease hidden by a short restart',()=>{
  const assigned=(observed,expiry)=>({id:'driver-one',vehicle_key:'vehicle-one',vehicle_link_method:'myclicar_contract',
    vehicle_link_evidence:{contract_id:'contract-a',observed_at:iso(observed),expires_at:iso(expiry)}});
  const baseline=advanceOfflineMotion(null,sample(0,0,{driver:assigned(0,15)})).state;
  const previous=advanceOfflineMotion(baseline,sample(10,100,{driver:assigned(0,15)})).state;
  const interrupted=advanceOfflineMotion(previous,sample(22,220,{driver:assigned(22,322)}));
  assert.equal(interrupted.reason,'assignment_gap');assert.equal(interrupted.state.distance_m,0);assert.equal(interrupted.alert,null);
  const overlapping=advanceOfflineMotion(previous,sample(22,220,{driver:assigned(14,314)}));
  assert.ok(overlapping.alert);assert.equal(overlapping.state.assignment_expires_at,iso(314));
});

test('renewing assignment evidence on a duplicate GPS fix retains its expiry without earning distance twice',()=>{
  const driver=(observed,expiry)=>({id:'driver-one',vehicle_key:'vehicle-one',vehicle_link_method:'platform_plate',
    vehicle_link_evidence:{source:'uber',observed_at:iso(observed),expires_at:iso(expiry)}});
  const state=advanceOfflineMotion(null,sample(0,0,{driver:driver(0,15)})).state;
  const renewal=advanceOfflineMotion(state,sample(12,0,{driver:driver(12,27),position:point(0,0)}));
  assert.equal(renewal.state.assignment_expires_at,iso(27));assert.equal(renewal.state.distance_m,0);
  const later=advanceOfflineMotion(renewal.state,sample(22,220,{driver:driver(22,37)}));
  assert.equal(later.reason,'threshold_exceeded');
});

test('a new manual association confirmation resets movement for the same driver and vehicle',()=>{
  const driver=at=>({id:'driver-one',vehicle_key:'vehicle-one',vehicle_link_method:'manual',link_evidence:{method:'manual',at:iso(at)}});
  const baseline=advanceOfflineMotion(null,sample(0,0,{driver:driver(0)})).state;
  const previous=advanceOfflineMotion(baseline,sample(10,100,{driver:driver(0)})).state;
  const changed=advanceOfflineMotion(previous,sample(22,220,{driver:driver(15)}));
  assert.equal(changed.reason,'baseline');assert.equal(changed.state.distance_m,0);assert.equal(changed.alert,null);
});

test('stale, stopped, unhealthy or future platform observations reset continuity',()=>{
  const tracked=run([[0,0],[10,100]])[1].state;
  for(const status of ['paused','error','unconnected','stale']) {
    const input=sample(20,200);input.source.status=status;
    assert.equal(advanceOfflineMotion(tracked,input).reason,'platform_stale');
  }
  const input=sample(61,250);input.row.observed_at=iso(10);
  assert.equal(advanceOfflineMotion(tracked,input).state,null);
  input.row.observed_at=iso(67);
  assert.equal(advanceOfflineMotion(tracked,input).reason,'platform_stale');
});

test('Geotab outages, stale fixes and unknown offline start cannot earn distance',()=>{
  const tracked=run([[0,0],[10,100]])[1].state;
  for(const overrides of [
    {geotab:{status:'error',last_success_at:iso(20),stale_after_s:20}},
    {geotab:{status:'healthy',last_success_at:iso(-1),stale_after_s:20}},
    {position:point(300,-41)},
    {position:point(300,26)},
  ]) assert.equal(advanceOfflineMotion(tracked,sample(20,300,overrides)).state,null);
  const input=sample(20,200);input.row.offline_since=null;
  assert.equal(advanceOfflineMotion(tracked,input).reason,'offline_start_missing');
  input.row.offline_since=iso(21);
  assert.equal(advanceOfflineMotion(tracked,input).reason,'offline_start_missing');
});

test('only positions at or after the offline observation may establish the baseline',()=>{
  const input=sample(10,100);input.position=point(0,-1);
  assert.equal(advanceOfflineMotion(null,input).reason,'position_before_offline');
  const baseline=advanceOfflineMotion(null,sample(10,100));
  assert.equal(baseline.state.distance_m,0);
  assert.equal(baseline.state.started_at,iso(10));
});

test('duplicates and older fixes are ignored, even if coordinates changed',()=>{
  const state=run([[0,0],[10,100]])[1].state;
  for(const at of [iso(10),iso(5)]) {
    const result=advanceOfflineMotion(state,sample(12,500,{position:point(500,12,{at})}));
    assert.equal(result.state,state);assert.equal(result.alert,null);
    assert.equal(result.reason,'duplicate_or_older_position');
  }
  const input=sample(12,120);input.row.observed_at=iso(5);
  assert.equal(advanceOfflineMotion(state,input).reason,'older_platform_observation');
});

test('clock rollback does not retain future progress as a current movement proof',()=>{
  const previous=run([[0,0],[10,100],[22,220]])[2].state;
  const result=advanceOfflineMotion(previous,sample(15,150));
  assert.equal(result.reason,'clock_regression');assert.equal(result.state.distance_m,0);assert.equal(result.alert,null);
});

test('observation gaps never add the distance between disconnected samples',()=>{
  const previous=run([[0,0],[10,100]])[1].state;
  const result=advanceOfflineMotion(previous,sample(71,700));
  assert.equal(result.reason,'position_gap');assert.equal(result.state.distance_m,0);
  assert.equal(result.state.started_at,iso(71));assert.equal(result.alert,null);
});

test('a platform observation gap hidden by a restart cannot be bridged by fresh GPS',()=>{
  const previous=run([[0,0],[10,100]])[1].state;
  const result=advanceOfflineMotion(previous,sample(60,600));
  assert.equal(result.reason,'platform_gap');assert.equal(result.state.distance_m,0);
  assert.equal(result.alert,null);
});

test('implausible jumps reset distance and cannot trigger a critical alert',()=>{
  const previous=run([[0,0],[10,100]])[1].state;
  const jumped=advanceOfflineMotion(previous,sample(12,1000));
  assert.equal(jumped.reason,'implausible_jump');assert.equal(jumped.state.distance_m,0);assert.equal(jumped.alert,null);
  const back=advanceOfflineMotion(jumped.state,sample(14,140));
  assert.equal(back.reason,'implausible_jump');assert.equal(back.alert,null);
});

test('stationary drift and unknown speed cannot accumulate an offline movement alert',()=>{
  for(const speed of [0,null,undefined]) {
    let state;
    for(let seconds=0;seconds<300;seconds+=2) {
      const result=advanceOfflineMotion(state,sample(seconds,seconds%8,{position:point(seconds%8,seconds,{speed,ign_on:false})}));
      state=result.state;assert.equal(result.alert,null);
    }
    assert.equal(state.distance_m,0);
  }
});

test('small moving segments accumulate only once their displacement exceeds the GPS tolerance',()=>{
  const results=run([[0,0],[2,4],[4,8],[6,12],[8,16],[10,20],[12,24]]);
  assert.equal(results[2].state.distance_m,0);
  assert.ok(Math.abs(results[3].state.distance_m-12)<1e-6);
  assert.ok(Math.abs(results[6].state.distance_m-24)<1e-6);
});

test('engine off or unknown does not erase confirmed offline travel or imply a passenger ride',()=>{
  let state=run([[0,0],[10,100]])[1].state;
  state=advanceOfflineMotion(state,sample(12,100,{position:point(100,12,{speed:0,ign_on:false})})).state;
  state=advanceOfflineMotion(state,sample(14,100,{position:point(100,14,{speed:0,ign_on:false})})).state;
  assert.ok(Math.abs(state.distance_m-100)<1e-6);
  const result=advanceOfflineMotion(state,sample(26,220,{position:point(220,26,{ign_on:null})}));
  assert.equal(result.alert.severity,'critical');
  assert.equal(result.alert.evidence.engine_state,'unknown');
  assert.match(result.alert.evidence.statement,/motif à vérifier/);
});

test('changed platform identity, vehicle, Geotab unit or offline episode gets its own baseline',()=>{
  const previous=run([[0,0],[10,100]])[1].state;
  const inputs=[sample(20,210),sample(20,210),sample(20,210),sample(20,210)];
  inputs[0].row.identity_id='new-identity';
  inputs[1].driver.vehicle_key='new-vehicle';
  inputs[2].position.device_id='different-unit';
  inputs[3].row.offline_since=iso(15);
  for(const input of inputs) {
    const result=advanceOfflineMotion(previous,input);
    assert.equal(result.reason,'baseline');assert.equal(result.state.distance_m,0);assert.equal(result.alert,null);
  }
});

test('the reducer is immutable and state is JSON serializable',()=>{
  const state=run([[0,0],[10,100]])[1].state;
  const before=JSON.stringify(state);
  Object.freeze(state);Object.freeze(state.last_point);Object.freeze(state.anchor);
  const result=advanceOfflineMotion(state,sample(22,220));
  assert.equal(JSON.stringify(state),before);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state)),result.state);
});
