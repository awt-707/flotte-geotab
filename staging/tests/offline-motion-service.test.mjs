import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineMotionService } from '../server/offline-motion-service.mjs';

const T=Date.parse('2026-10-30T12:00:00Z'), iso=s=>new Date(T+s*1000).toISOString();
const point=(s,m)=>({key:'vehicle-a',at:iso(s),lat:48+m/6371008.8*180/Math.PI,lon:2,speed:36,ign_on:true,device_id:'geotab-a'});
function fixture() {
  let clock=T, counter=0, rejectWrite=false, rejectCheckpoint=false;
  const rows={
    fleet_sources:['uber','bolt','geotab'].map(id=>({id,status:'healthy',last_success_at:iso(0),stale_after_s:id==='geotab'?20:45,metadata:{private:'must-not-leak'}})),
    fleet_drivers:[{id:'driver-a',name:'Driver A',vehicle_key:'vehicle-a',ludy_driver_code:'local-a',agency_id:1}],
    fleet_latest:[{identity_id:'identity-a',driver_id:'driver-a',source:'uber',status:'offline',observed_at:iso(0),offline_since:iso(0),evidence:{}}],
    fleet_identities:[],
    vehicles:[{key:'vehicle-a',plate:'STAGING-A',geotab_id:'geotab-a'}],fleet_motion_alerts:[],fleet_motion_checkpoints:[],fleet_source_events:[],fleet_myclicar_contracts:[],fleet_disconnection_alerts:[]
  };
  const calls=[];
  const matches=(row,params)=>Object.entries(params).every(([key,value])=>{
    if(String(value).startsWith('eq.'))return (row[key]&&typeof row[key]==='object'?JSON.stringify(row[key]):String(row[key]))===String(value).slice(3);
    if(String(value).startsWith('in.('))return String(value).slice(4,-1).split(',').includes(String(row[key]));
    return true;
  });
  const visible=(table,row,token)=>token!=='agency-a'||(table==='vehicles'?row.key==='vehicle-a':table==='fleet_drivers'?row.id==='driver-a':!('driver_id'in row)||row.driver_id==='driver-a');
  const list=async(table,params={},token)=>{
    calls.push({method:'GET',table,params,token});assert.ok(table in rows);
    return structuredClone(rows[table].filter(r=>matches(r,params)&&visible(table,r,token)));
  };
  const db=async(table,{params={},token,method='GET',body}={})=>{
    if(table==='rpc/fleet_save_motion_checkpoints') {
      assert.equal(method,'POST');calls.push({method:'RPC',table});
      if(rejectCheckpoint){rejectCheckpoint=false;throw Error('Checkpoint unavailable');}
      rows.fleet_motion_checkpoints=structuredClone(body.p_states);return null;
    }
    assert.equal(method,'GET');return list(table,params,token);
  };
  const patch=async(table,params,body)=>{
    calls.push({method:'PATCH',table,params,body});
    if(rejectWrite){rejectWrite=false;throw Error('Local write unavailable');}
    for(const row of rows[table].filter(r=>matches(r,params)))Object.assign(row,structuredClone(body));
  };
  const upsert=async(table,data,conflict)=>{
    calls.push({method:'POST',table,conflict});
    if(rejectWrite){rejectWrite=false;throw Error('Local write unavailable');}
    const keys=conflict.split(',');
    for(const row of data) {
      const existing=rows[table].find(r=>keys.every(key=>r[key]===row[key]));
      if(existing)Object.assign(existing,structuredClone(row));
      else rows[table].push({id:'alert-'+(++counter),...structuredClone(row)});
    }
  };
  const make=()=>createOfflineMotionService({db,list,upsert,patch,now:()=>clock});
  let service=make();
  const set=(s,m)=>{
    clock=T+s*1000;
    for(const source of rows.fleet_sources)source.last_success_at=iso(s);
    for(const row of rows.fleet_latest)row.observed_at=iso(s);
    return {positions:[point(s,m)],geotab:{status:'healthy',last_success_at:iso(s),stale_after_s:20}};
  };
  return {rows,calls,get service(){return service;},restart:()=>{service=make();},
    set,update:async(s,m)=>{const {positions,geotab}=set(s,m);return service.update(positions,geotab);},
    advance:s=>{clock+=s*1000;},failNextWrite:()=>{rejectWrite=true;},failNextCheckpoint:()=>{rejectCheckpoint=true;}};
}
async function cross(f){await f.update(0,0);await f.update(10,100);await f.update(22,220);}

test('coverage counts current work needing assignment instead of every historical platform profile',async()=>{
 const f=fixture();
 for(let n=1;n<=12;n++){f.rows.fleet_drivers.push({id:'linked-'+n,vehicle_key:'car-'+n});f.rows.vehicles.push({key:'car-'+n});}
 f.rows.fleet_drivers.push({id:'online-unlinked',vehicle_key:null},{id:'contract-unlinked',vehicle_key:null,ludy_driver_code:'working-client'});
 f.rows.fleet_latest.push({identity_id:'online-account',driver_id:'online-unlinked',source:'uber',status:'on_trip',observed_at:iso(0),evidence:{}});
 f.rows.fleet_myclicar_contracts.push({client_code:'working-client',status:'IN_PROGRESS',current:true,deleted:false,effective_start_at:iso(-3600),end_at:null,observed_at:iso(0)});
 for(let n=1;n<=20;n++){f.rows.fleet_drivers.push({id:'historical-'+n,vehicle_key:null});f.rows.fleet_latest.push({identity_id:'historical-account-'+n,driver_id:'historical-'+n,source:'bolt',status:'unknown',observed_at:iso(0),evidence:{}});}
 const result=await f.service.read('admin');assert.deepEqual(result.coverage,{linked_drivers:13,unassigned_drivers:2,tracking:0,conflicting_vehicles:0,total_drivers:35,eligible_drivers:15,ignored_profiles:20});assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.rows.fleet_motion_alerts.length,0);
});

test('coverage retains current service until an actual return and retains unresolved incidents',async()=>{
 const f=fixture();f.rows.fleet_drivers[0].vehicle_key=null;
 const contract={client_code:'local-a',status:'IN_PROGRESS',current:true,deleted:false,effective_start_at:iso(-3600),end_at:null,observed_at:iso(-3600)};f.rows.fleet_myclicar_contracts.push(contract);
 for(const end of [null,iso(300),'invalid']){contract.end_at=end;assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,1,'an unconfirmed or future return cannot remove the assignment requirement');}
 contract.end_at=iso(-1);assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,0);
 f.rows.fleet_disconnection_alerts.push({driver_id:'driver-a',status:'suspended'});assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,1);
 f.rows.fleet_disconnection_alerts[0].status='resolved';assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,0);
});

test('coverage ignores ancient and inactive accounts but preserves recent positive activity during a source outage',async()=>{
 const f=fixture();f.rows.fleet_drivers[0].vehicle_key=null;f.rows.fleet_latest[0].status='on_trip';f.rows.fleet_sources[0].status='error';
 assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,1);
 f.rows.fleet_latest[0].observed_at=iso(-46);assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,0);
 f.rows.fleet_latest[0].observed_at=iso(0);f.rows.fleet_latest[0].evidence.account_status='deactivated';assert.equal((await f.service.read('admin')).coverage.unassigned_drivers,0);
});

test('internal contract evidence cannot add another agency driver to coverage',async()=>{
 const f=fixture();f.rows.fleet_drivers.push({id:'driver-b',ludy_driver_code:'private-code',vehicle_key:null,agency_id:2});
 f.rows.fleet_myclicar_contracts.push({client_code:'private-code',status:'IN_PROGRESS',current:true,deleted:false,effective_start_at:iso(-3600),end_at:null,observed_at:iso(0)});
 f.rows.fleet_disconnection_alerts.push({driver_id:'driver-b',status:'open'});
 const result=await f.service.read('agency-a');assert.equal(result.coverage.total_drivers,1);assert.equal(result.coverage.unassigned_drivers,0);assert.doesNotMatch(JSON.stringify(result),/driver-b|private-code/);
});

test('the default service clock is callable without an injected test clock',async()=>{
  const service=createOfflineMotionService({list:async()=>[],db:async()=>null,upsert:async()=>{},patch:async()=>{}});
  assert.deepEqual(await service.update(),{tracking:0,alerts_created:0,alerts_resumed:0});
});

test('a PostgreSQL timestamp representation keeps the same current movement episode',async()=>{
  const f=fixture();await cross(f);const alarm=f.rows.fleet_motion_alerts[0];
  alarm.observed_since=iso(0).replace('Z','+00:00');
  assert.equal((await f.service.read('admin')).alerts[0].status,'open');
  await f.update(30,300);assert.equal(alarm.status,'open');assert.ok(alarm.distance_m>299.9);assert.equal(f.rows.fleet_motion_alerts.length,1);
  f.restart();await f.update(32,320);assert.equal(alarm.status,'open');assert.equal(f.rows.fleet_motion_alerts.length,1);
});

test('a pause and resume between GPS callbacks resets distance even when both final sources are healthy',async()=>{
  for(const source of ['geotab','uber'])for(const restart of [false,true]){
    const f=fixture();await f.update(0,0);await f.update(10,100);
    f.rows.fleet_source_events.push({source,status:'paused',at:iso(11)},{source,status:'healthy',at:iso(19)});
    if(restart)f.restart();await f.update(22,220);
    assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal(f.rows.fleet_motion_checkpoints[0].state.distance_m,0);
    await f.update(44,440);assert.equal(f.rows.fleet_motion_alerts.length,1);assert.equal(f.rows.fleet_motion_alerts[0].evidence.measurement_started_at,iso(22));
  }
});

test('interruptions on an unused provider do not erase a confirmed observation',async()=>{
  const f=fixture();await f.update(0,0);await f.update(10,100);
  f.rows.fleet_source_events.push({source:'myclicar',status:'paused',at:iso(11)},{source:'bolt',status:'error',at:iso(12)});
  await f.update(22,220);assert.equal(f.rows.fleet_motion_alerts.length,1);
});
test('a read after rapid pause/resume suspends an old incident before the next GPS callback without writing',async()=>{
  const f=fixture();await cross(f);f.rows.fleet_source_events.push({source:'geotab',status:'paused',at:iso(24)});
  f.set(26,260);const writes=f.calls.filter(c=>c.method!=='GET').length,read=await f.service.read('admin');
  assert.equal(read.alerts[0].status,'suspended');assert.equal(read.coverage.tracking,0);assert.equal(read.watches.length,0);
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,writes);assert.equal(f.rows.fleet_motion_alerts[0].status,'open');
});

test('an expired automatic vehicle proof disables tracking and engine reminders',async()=>{
  const f=fixture();Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'uber',expires_at:iso(15)}});
  await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,0);
  const result=await f.service.read('admin');assert.equal(result.coverage.linked_drivers,0);assert.equal(result.watches.length,0);
});

test('pausing the platform supplying an automatic plate immediately disables that vehicle proof',async()=>{
  const f=fixture();Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'bolt_live',observed_at:iso(0),expires_at:iso(150)}});
  await f.update(0,0);await f.update(10,100);assert.equal((await f.service.read('admin')).coverage.tracking,1);
  f.rows.fleet_sources.find(s=>s.id==='bolt').status='paused';await f.update(22,220);
  assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal((await f.service.read('admin')).coverage.linked_drivers,0);
});

test('MyClicar assignments require a healthy current source and an unexpired contract proof',async()=>{
  for(const problem of ['paused','expired']){
    const f=fixture();f.rows.fleet_sources.push({id:'myclicar',status:'healthy',last_success_at:iso(0),stale_after_s:300});
    Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'myclicar_contract',vehicle_link_evidence:{method:'myclicar_contract',
      source:'myclicar',contract_id:'contract-a',client_code:'local-a',vehicle_key:'vehicle-a',observed_at:iso(0),expires_at:iso(problem==='expired'?15:300)}});
    await f.update(0,0);await f.update(10,100);
    if(problem==='paused')f.rows.fleet_sources.find(s=>s.id==='myclicar').status='paused';
    await f.update(22,220);assert.equal(f.rows.fleet_motion_alerts.length,0);
    assert.equal((await f.service.read('admin')).coverage.linked_drivers,0);
  }
  const f=fixture();f.rows.fleet_sources.push({id:'myclicar',status:'healthy',last_success_at:iso(0),stale_after_s:300});
  Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'myclicar_contract',vehicle_link_evidence:{method:'myclicar_contract',
    source:'myclicar',contract_id:'contract-a',client_code:'local-a',vehicle_key:'vehicle-a',observed_at:iso(0),expires_at:iso(300)}});
  await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,1);
});

test('MyClicar evidence must belong to the current chauffeur and car, and cannot come from the future or another method',async()=>{
  for(const change of [p=>p.client_code='another-driver',p=>p.vehicle_key='another-car',p=>{p.observed_at=iso(60);p.expires_at=iso(360);},p=>p.source='uber',p=>p.expires_at='invalid']){
    const f=fixture();f.rows.fleet_sources.push({id:'myclicar',status:'healthy',last_success_at:iso(0),stale_after_s:300});
    const proof={method:'myclicar_contract',source:'myclicar',contract_id:'contract-a',client_code:'local-a',vehicle_key:'vehicle-a',observed_at:iso(0),expires_at:iso(300)};
    change(proof);Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'myclicar_contract',vehicle_link_evidence:proof});
    await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal((await f.service.read('admin')).coverage.linked_drivers,0);
  }
});

test('a checkpoint cannot bridge an assignment lease expiry and its later renewal during restart',async()=>{
  const f=fixture();f.rows.fleet_sources.push({id:'myclicar',status:'healthy',last_success_at:iso(0),stale_after_s:300});
  const proof={method:'myclicar_contract',source:'myclicar',contract_id:'contract-a',client_code:'local-a',vehicle_key:'vehicle-a',observed_at:iso(0),expires_at:iso(15)};
  Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'myclicar_contract',vehicle_link_evidence:proof});
  await f.update(0,0);await f.update(10,100);assert.equal(f.rows.fleet_motion_checkpoints[0].state.assignment_expires_at,iso(15));
  f.restart();proof.observed_at=iso(22);proof.expires_at=iso(322);await f.update(22,220);
  assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal(f.rows.fleet_motion_checkpoints[0].state.distance_m,0);
  await f.update(44,440);assert.equal(f.rows.fleet_motion_alerts.length,1);const evidence=f.rows.fleet_motion_alerts[0].evidence;
  assert.equal(evidence.measurement_started_at,iso(22));assert.equal(evidence.assignment.contract_id,'contract-a');
  assert.equal(evidence.assignment.observed_at,iso(22));assert.equal(evidence.assignment.expires_at,iso(322));
  assert.deepEqual(evidence.platform_observations,[{source:'uber',identity_id:'identity-a',status:'offline',observed_at:iso(44),offline_since:iso(0),account_status:null}]);
  assert.deepEqual(evidence.source_health.find(s=>s.id==='myclicar'),{id:'myclicar',status:'healthy',last_success_at:iso(44),stale_after_s:300});
  const original=structuredClone(evidence);await f.update(46,460);
  assert.deepEqual(f.rows.fleet_motion_alerts[0].evidence.platform_observations,original.platform_observations,'opening observations remain immutable');
  assert.equal(f.rows.fleet_motion_alerts[0].evidence.latest_platform_observations[0].observed_at,iso(46));
});

test('a confirmed offline movement persists one critical alert and updates it without replay',async()=>{
  const f=fixture();await cross(f);
  assert.equal(f.rows.fleet_motion_alerts.length,1);
  const alarm=f.rows.fleet_motion_alerts[0], opened=alarm.opened_at;
  assert.equal(alarm.status,'open');assert.equal(alarm.severity,'critical');assert.equal(alarm.kind,'offline_movement');
  assert.equal(alarm.vehicle_key,'vehicle-a');assert.equal(alarm.identity_id,'identity-a');
  await f.update(30,300);await f.update(40,400);
  assert.equal(f.rows.fleet_motion_alerts.length,1);assert.equal(alarm.opened_at,opened);
  assert.ok(alarm.distance_m>399);assert.equal(alarm.last_seen_at,iso(40));
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('source pause suspends alerts; a fresh confirmed 200 m reopens the same incident without replay',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_sources.find(s=>s.id==='uber').status='paused';await f.update(24,240);
  const alarm=f.rows.fleet_motion_alerts[0], opened=alarm.opened_at;
  assert.equal(alarm.status,'suspended');
  f.rows.fleet_sources.find(s=>s.id==='uber').status='healthy';
  await f.update(30,300);await f.update(40,400);assert.equal(alarm.status,'suspended');
  const result=await f.update(52,520);
  assert.equal(alarm.status,'open');assert.equal(alarm.opened_at,opened);assert.equal(f.rows.fleet_motion_alerts.length,1);
  assert.equal(result.alerts_resumed,1);assert.equal(alarm.evidence.resumed_at,iso(52));
});

test('online resolves an alert; a later explicit offline episode creates its own alert',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_latest[0].status='available';await f.update(23,230);
  assert.equal(f.rows.fleet_motion_alerts[0].status,'resolved');assert.equal(f.rows.fleet_motion_alerts[0].resolved_at,iso(23));
  f.rows.fleet_latest[0].status='offline';f.rows.fleet_latest[0].offline_since=iso(30);
  await f.update(30,300);await f.update(40,400);await f.update(52,520);
  assert.equal(f.rows.fleet_motion_alerts.length,2);assert.equal(f.rows.fleet_motion_alerts[1].status,'open');
  assert.equal(f.rows.fleet_motion_alerts[1].observed_since,iso(30));
});

test('a server restart cannot overwrite original alert timestamps or replay a resolved episode',async()=>{
  const f=fixture();await cross(f);
  const alarm=f.rows.fleet_motion_alerts[0], opened=alarm.opened_at;
  alarm.status='resolved';alarm.resolved_at=iso(23);
  f.restart();await f.update(30,300);await f.update(40,400);await f.update(52,520);
  assert.equal(f.rows.fleet_motion_alerts.length,1);assert.equal(alarm.status,'resolved');assert.equal(alarm.opened_at,opened);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('ambiguous vehicle assignments suspend existing alerts and disable tracking for both drivers',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_drivers.push({id:'driver-b',name:'Driver B',vehicle_key:'vehicle-a',ludy_driver_code:'local-b',agency_id:1});
  f.rows.fleet_latest.push({identity_id:'identity-b',driver_id:'driver-b',source:'bolt',status:'offline',observed_at:iso(24),offline_since:iso(24)});
  const result=await f.update(24,240);
  assert.equal(result.tracking,0);assert.equal(f.rows.fleet_motion_alerts[0].status,'suspended');
  const read=await f.service.read('admin');
  assert.deepEqual(read.coverage,{linked_drivers:0,unassigned_drivers:2,tracking:0,conflicting_vehicles:0,total_drivers:2,eligible_drivers:2,ignored_profiles:0});
});

test('unlinked, deactivated and suspended accounts never create motion alerts',async()=>{
  for(const kind of ['unlinked','deactivated','suspended']) {
    const f=fixture();
    if(kind==='unlinked')f.rows.fleet_drivers[0].vehicle_key=null;
    else f.rows.fleet_latest[0].evidence.account_status=kind;
    await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,0);
    assert.equal((await f.service.read('admin')).coverage.tracking,0);
  }
});

test('unknown status, disappeared identity and stale observations suspend instead of resolve',async()=>{
  for(const condition of ['unknown','missing','stale']) {
    const f=fixture();await cross(f);
    const {positions,geotab}=f.set(24,240);
    if(condition==='unknown')f.rows.fleet_latest[0].status='unknown';
    if(condition==='missing')f.rows.fleet_latest=[];
    if(condition==='stale')f.rows.fleet_latest[0].observed_at=iso(-30);
    await f.service.update(positions,geotab);
    assert.equal(f.rows.fleet_motion_alerts[0].status,'suspended');
    assert.equal(f.rows.fleet_motion_alerts[0].resolved_at,null);
  }
});

test('an explicit Geotab pause wins over an obsolete healthy callback',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_sources.find(s=>s.id==='geotab').status='paused';
  await f.update(24,240);
  assert.equal(f.rows.fleet_motion_alerts[0].status,'suspended');
  assert.equal((await f.service.read('admin')).coverage.tracking,0);
});

test('read uses caller RLS for drivers, vehicles, identities and alerts and intersects driver/vehicle visibility',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_drivers.push({id:'driver-b',name:'Private Driver B',vehicle_key:'vehicle-b',agency_id:2});
  f.rows.vehicles.push({key:'vehicle-b',plate:'PRIVATE-B',geotab_id:'geotab-b'});
  f.rows.fleet_motion_alerts.push({...f.rows.fleet_motion_alerts[0],id:'other-alert',driver_id:'driver-b',identity_id:'identity-b',vehicle_key:'vehicle-b'});
  f.rows.fleet_motion_alerts.push({...f.rows.fleet_motion_alerts[0],id:'mismatched-alert',vehicle_key:'vehicle-b'});
  const start=f.calls.length, result=await f.service.read('agency-a');
  assert.equal(result.alerts.length,1);assert.equal(result.alerts[0].key,'vehicle-a');assert.equal(result.alerts[0].driver_name,'Driver A');
  assert.equal(result.alerts[0].plate,'STAGING-A');assert.equal(result.alerts[0].ign_on,true);
  assert.equal(JSON.stringify(result).includes('Private'),false);assert.equal(JSON.stringify(result).includes('must-not-leak'),false);
  assert.deepEqual(result.coverage,{linked_drivers:1,unassigned_drivers:0,tracking:1,conflicting_vehicles:0,total_drivers:1,eligible_drivers:1,ignored_profiles:0});
  for(const call of f.calls.slice(start)) {
    if(['fleet_sources','fleet_source_events','fleet_myclicar_contracts'].includes(call.table))assert.equal(call.params.select.includes('metadata'),false);
    else assert.equal(call.token,'agency-a');
  }
});

test('read marks old/paused alerts suspended without writing and a cold service starts suspended',async()=>{
  const f=fixture();await cross(f);
  f.advance(61);const writes=f.calls.filter(c=>c.method!=='GET').length;
  assert.equal((await f.service.read('admin')).alerts[0].status,'suspended');
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,writes);
  assert.equal(f.rows.fleet_motion_alerts[0].status,'open');
  f.set(85,850);f.restart();
  assert.equal((await f.service.read('admin')).alerts[0].status,'suspended');
  assert.equal((await f.service.read('admin')).coverage.tracking,0);
});

test('failed persistence does not consume the crossing event; retry persists it',async()=>{
  const f=fixture();await f.update(0,0);await f.update(10,100);
  f.failNextWrite();await assert.rejects(f.update(22,220),/Local write unavailable/);
  assert.equal(f.rows.fleet_motion_alerts.length,0);
  const result=await f.update(23,230);
  assert.equal(result.alerts_created,1);assert.equal(f.rows.fleet_motion_alerts.length,1);
});

test('duplicate vehicle fixes cannot be selected arbitrarily and unauthenticated reads fail closed',async()=>{
  const f=fixture();const input=f.set(0,0);input.positions.push({...input.positions[0],device_id:'other-unit'});
  assert.equal((await f.service.update(input.positions,input.geotab)).tracking,0);
  await assert.rejects(f.service.read(),/Session locale requise/);
});

test('engine-on offline reminders are fresh, scoped to visible assignments, and disappear once ignition is off',async()=>{
  const f=fixture();await f.update(0,0);await f.update(10,100);
  const read=await f.service.read('agency-a');
  assert.equal(read.watches.length,1);assert.equal(read.watches[0].key,'vehicle-a');
  assert.equal(read.watches[0].source,'uber');assert.equal(read.watches[0].ign_on,true);
  assert.equal(read.watches[0].driver_name,'Driver A');assert.ok(read.watches[0].distance_m<=100);
  assert.equal(read.alerts.length,0,'engine reminder is not a critical movement alert');
  const input=f.set(12,100);input.positions[0].ign_on=false;input.positions[0].speed=0;
  await f.service.update(input.positions,input.geotab);
  assert.equal((await f.service.read('agency-a')).watches.length,0);
  await f.update(14,120);f.advance(61);
  assert.equal((await f.service.read('agency-a')).watches.length,0);
});

test('Uber and Bolt retain pre-threshold progress across a short restart without an unobserved GPS bridge',async()=>{
  for(const source of ['uber','bolt']) {
    const f=fixture();f.rows.fleet_latest[0].source=source;
    await f.update(0,0);await f.update(10,100);f.restart();
    assert.equal((await f.service.read('admin')).coverage.tracking,0,'a checkpoint alone is not a fresh observation');
    await f.update(22,220);
    assert.equal(f.rows.fleet_motion_alerts.length,1);assert.equal(f.rows.fleet_motion_alerts[0].source,source);
    assert.equal(f.rows.fleet_motion_alerts[0].evidence.measurement_started_at,iso(0));
    f.restart();await f.update(24,240);assert.equal(f.rows.fleet_motion_alerts.length,1);
    assert.equal(f.rows.fleet_motion_alerts[0].status,'open');
  }
});

test('expired, malformed and changed-assignment checkpoints cannot contribute distance after restart',async()=>{
  for(const kind of ['expired','future','identity','vehicle','source','driver','platform-gap']) {
    const f=fixture();await f.update(0,0);await f.update(10,100);
    const saved=f.rows.fleet_motion_checkpoints[0];
    if(kind==='future')saved.updated_at=iso(100);
    if(kind==='identity')saved.state.identity_id='other';
    if(kind==='vehicle')saved.state.vehicle_key='other';
    if(kind==='source')saved.state.source='bolt';
    if(kind==='driver')saved.state.episode=JSON.stringify(['identity-a','old-driver','vehicle-a','geotab-a',iso(0)]);
    f.restart();await f.update(kind==='expired'?75:kind==='platform-gap'?60:22,220);
    assert.equal(f.rows.fleet_motion_alerts.length,0,kind);
    assert.equal(f.rows.fleet_motion_checkpoints[0].state.distance_m,0,kind);
  }
});

test('the active checkpoint set removes online, unknown, deactivated and stale identities',async()=>{
  for(const condition of ['available','unknown','deactivated','paused']) {
    const f=fixture();f.rows.fleet_latest[0].source='bolt';await f.update(0,0);await f.update(10,100);
    assert.equal(f.rows.fleet_motion_checkpoints.length,1);
    if(condition==='deactivated')f.rows.fleet_latest[0].evidence.account_status='deactivated';
    else if(condition==='paused')f.rows.fleet_sources.find(s=>s.id==='bolt').status='paused';
    else f.rows.fleet_latest[0].status=condition;
    await f.update(12,120);assert.equal(f.rows.fleet_motion_checkpoints.length,0,condition);
    f.restart();assert.equal((await f.service.read('admin')).coverage.tracking,0);
  }
});

test('checkpoint failure after alert persistence retries the existing incident and does not consume progress',async()=>{
  const f=fixture();await f.update(0,0);await f.update(10,100);f.failNextCheckpoint();
  await assert.rejects(f.update(22,220),/Checkpoint unavailable/);
  assert.equal(f.rows.fleet_motion_alerts.length,1);assert.ok(f.rows.fleet_motion_checkpoints[0].state.distance_m<101);
  f.restart();await f.update(23,230);
  assert.equal(f.rows.fleet_motion_alerts.length,1);assert.equal(f.rows.fleet_motion_alerts[0].status,'open');
  assert.ok(f.rows.fleet_motion_checkpoints[0].state.distance_m>229);
});

test('an old open incident becomes suspended after a long restart until fresh movement is reconfirmed',async()=>{
  const f=fixture();await cross(f);const opened=f.rows.fleet_motion_alerts[0].opened_at;
  f.restart();await f.update(90,900);assert.equal(f.rows.fleet_motion_alerts[0].status,'suspended');
  await f.update(100,1000);assert.equal(f.rows.fleet_motion_alerts[0].status,'suspended');
  await f.update(112,1120);assert.equal(f.rows.fleet_motion_alerts[0].status,'open');
  assert.equal(f.rows.fleet_motion_alerts.length,1);assert.equal(f.rows.fleet_motion_alerts[0].opened_at,opened);
});

test('Bolt offline never produces an offline movement alert while the driver is active on Uber',async()=>{
  const f=fixture();f.rows.fleet_latest[0].source='bolt';
  f.rows.fleet_latest.push({identity_id:'uber-online',driver_id:'driver-a',source:'uber',status:'on_trip',observed_at:iso(0),offline_since:null,evidence:{}});
  await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal((await f.service.read('admin')).watches.length,0);
});

test('a legacy Bolt selected-vehicle proof never counts as a current driver assignment',async()=>{
  const f=fixture();Object.assign(f.rows.fleet_drivers[0],{vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',expires_at:iso(150)}});
  await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal((await f.service.read('admin')).coverage.linked_drivers,0);
});

test('another active platform resolves an old incident and the next all-offline period starts a new measurement',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_latest.push({identity_id:'second-identity',driver_id:'driver-a',source:'bolt',status:'on_trip',observed_at:iso(23),offline_since:null,evidence:{}});
  await f.update(23,230);assert.equal(f.rows.fleet_motion_alerts[0].status,'resolved');assert.equal(f.rows.fleet_motion_checkpoints.length,0);
  f.rows.fleet_latest[1].status='offline';f.rows.fleet_latest[1].offline_since=iso(30);
  await f.update(30,300);await f.update(40,400);assert.equal(f.rows.fleet_motion_alerts.length,1,'distance before the last platform went offline is excluded');
  await f.update(52,520);assert.equal(f.rows.fleet_motion_alerts.length,2,'one consolidated incident, not one per platform');
  const alert=f.rows.fleet_motion_alerts[1];assert.equal(alert.observed_since,iso(30));assert.deepEqual(alert.evidence.platforms_offline,['bolt','uber']);assert.equal(alert.status,'open');
});

test('a known platform with no current observation suspends movement alerts instead of assuming offline',async()=>{
  const f=fixture();await cross(f);
  f.rows.fleet_identities.push({id:'missing-bolt',driver_id:'driver-a',source:'bolt'});
  await f.update(24,240);assert.equal(f.rows.fleet_motion_alerts[0].status,'suspended');assert.equal(f.rows.fleet_motion_checkpoints.length,0);
});

test('a shift contradiction suspends a manual association durably without moving the operator choice',async()=>{
 for(const source of ['uber','bolt']){
  const f=fixture(),driver=f.rows.fleet_drivers[0];Object.assign(driver,{vehicle_link_method:'manual',auto_link_disabled:true,link_evidence:{at:iso(-60)},vehicle_link_evidence:{}});
  await f.update(0,0);await f.update(10,100);
  f.rows.fleet_drivers.push({id:'driver-night',name:'Synthetic Night Driver',vehicle_key:null});
  f.rows.fleet_latest.push({identity_id:'identity-night',driver_id:'driver-night',source,status:'on_trip',observed_at:iso(10),vehicle_label:'STAGING-A',evidence:source==='uber'?{method:'visible_dom',vehicle_observed_at:iso(10),vehicle_status:'on_trip'}:{method:'official_api',vehicle_origin:'bolt_live'}});
  await f.update(22,220);assert.equal(f.rows.fleet_motion_alerts.length,0);assert.equal(driver.vehicle_key,'vehicle-a');assert.equal(driver.vehicle_link_method,'manual');assert.equal(driver.vehicle_link_evidence.assignment_conflict.requires_confirmation,true);
  let result=await f.service.read('admin');assert.equal(result.coverage.tracking,0);assert.equal(result.coverage.conflicting_vehicles,1);assert.equal(result.watches.length,0);
  f.rows.fleet_latest[1].status='offline';f.restart();await f.update(30,300);await f.update(55,550);
  assert.equal(f.rows.fleet_motion_alerts.length,0,'the old manual choice stays suspended after the new chauffeur goes offline or the server restarts');
  assert.equal((await f.service.read('admin')).coverage.linked_drivers,0);
  const guard=f.calls.find(c=>c.method==='PATCH'&&c.table==='fleet_drivers');assert.equal(guard.params.link_evidence,'eq.'+JSON.stringify({at:iso(-60)}));
 }
});

test('an old or merely selected vehicle does not manufacture a shift conflict',async()=>{
 for(const problem of ['cached_expired','offline','selected']){
  const f=fixture();f.rows.fleet_drivers.push({id:'driver-night',vehicle_key:null});
  f.rows.fleet_latest.push({identity_id:'identity-night',driver_id:'driver-night',source:problem==='selected'?'bolt':'uber',status:problem==='offline'?'offline':'on_trip',observed_at:iso(0),vehicle_label:'STAGING-A',evidence:problem==='selected'?{method:'official_api',vehicle_origin:'bolt_selected'}:{method:'visible_dom',vehicle_observed_at:iso(problem==='cached_expired'?-181:0),vehicle_status:'on_trip'}});
  await cross(f);assert.equal(f.rows.fleet_motion_alerts.length,1,problem);assert.equal((await f.service.read('admin')).coverage.conflicting_vehicles,0);
 }
});
