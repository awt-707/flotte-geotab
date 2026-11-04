import test from 'node:test';
import assert from 'node:assert/strict';
import {planDriverMatches,createDriverMatcher} from '../server/driver-matching.mjs';
import {trustedVehicleLease} from '../server/vehicle-evidence.mjs';
const now=Date.parse('2026-10-30T12:00:00Z'),iso=new Date(now).toISOString();
function fixture(){return {now,drivers:[{id:'u',name:'Émile Ben-Ali'},{id:'b',name:'BEN ALI EMILE'}],reference:[{code:'L1',name:'Emile Ben Ali',agency_id:1}],
  identities:[{id:'iu',driver_id:'u',source:'uber',organization_id:'fleet'},{id:'ib',driver_id:'b',source:'bolt',organization_id:'fleet'}],
  vehicles:[{key:'1234A',plate:'1234-A',other_plates:'OLD-123',agency_id:1,active:'OUI'}],
  latest:[{driver_id:'b',source:'bolt',status:'available',observed_at:iso,vehicle_label:'1234 A',evidence:{method:'official_api',vehicle_origin:'bolt_live'}}],sources:[{id:'bolt',status:'healthy',last_success_at:iso,stale_after_s:150}]};}
test('unique complete names reconcile accents, punctuation and token order across platforms',()=>{
  const p=planDriverMatches(fixture());assert.equal(p.counts.eligible,2);assert.equal(p.counts.vehicle_ready,1);assert.equal(p.rows[1].vehicle_key,'1234A');
  assert.equal(p.rows[1].vehicle_evidence.expires_at,new Date(now+150000).toISOString());
});
test('homonyms, duplicate accounts within one platform and short names require review',()=>{
  const f=fixture();f.reference.push({code:'L2',name:'EMILE BEN ALI'});assert.ok(planDriverMatches(f).rows.every(r=>r.status==='ambiguous'));
  const g=fixture();g.identities[1].source='uber';assert.ok(planDriverMatches(g).rows.every(r=>r.status==='ambiguous'));
  const h=fixture();h.drivers[0].name='Emile';h.reference[0].name='Emile';assert.equal(planDriverMatches(h).rows[0].status,'unmatched');
});
test('partial names produce suggestions but never automatic links',()=>{
  const f=fixture();f.drivers[0].name='Ben Ali';const r=planDriverMatches(f).rows[0];assert.equal(r.status,'unmatched');assert.equal(r.candidates[0].code,'L1');assert.equal(r.vehicle_ready,false);
});
test('manual links and explicit manual unlinking are never overwritten',()=>{
  const f=fixture();f.drivers[0].auto_link_disabled=true;f.drivers[1]={...f.drivers[1],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'manual'};
  const p=planDriverMatches(f);assert.equal(p.rows[0].status,'manual');assert.equal(p.rows[1].status,'linked');assert.equal(p.rows[1].vehicle_ready,false);
});
test('an automatic merge cannot attach a new platform account to a manually frozen canonical driver',()=>{
  const f=fixture();f.drivers[0]={...f.drivers[0],ludy_driver_code:'L1',auto_link_disabled:true};
  const plan=planDriverMatches(f);assert.equal(plan.rows[1].status,'manual');assert.equal(plan.rows[1].vehicle_ready,false);assert.match(plan.rows[1].reason,/mode manuel/);
  f.drivers[0].auto_link_disabled=false;assert.equal(planDriverMatches(f).rows[1].status,'ready');
});
test('stale, suspended, mismatched agency or ambiguous plates cannot establish a vehicle assignment',()=>{
  for(const change of [f=>f.sources[0].status='paused',f=>f.sources[0].last_success_at=new Date(now+6000).toISOString(),f=>f.sources[0].last_success_at='invalid',f=>f.latest[0].observed_at=new Date(now-151000).toISOString(),f=>f.latest[0].evidence.account_status='suspended',f=>f.vehicles[0].agency_id=2,f=>f.vehicles.push({...f.vehicles[0],key:'DUPLICATE'})]){
    const f=fixture();change(f);assert.equal(planDriverMatches(f).rows[1].vehicle_ready,false);
  }
});
test('cross-platform contradictory plates and two different people claiming a car are rejected',()=>{
  const f=fixture();f.vehicles.push({key:'5678B',plate:'5678-B',agency_id:1});f.sources.push({...f.sources[0],id:'uber'});f.latest.push({driver_id:'b',source:'uber',status:'available',observed_at:iso,vehicle_label:'5678-B'});
  assert.equal(planDriverMatches(f).rows[1].vehicle_ready,false);
  const g=fixture();g.drivers[0].name='Another Person';g.reference.push({code:'L2',name:'Another Person',agency_id:1});g.sources.push({...g.sources[0],id:'uber'});g.latest.push({driver_id:'u',source:'uber',status:'available',observed_at:iso,vehicle_label:'1234-A'});
  assert.ok(planDriverMatches(g).rows.every(r=>r.vehicle_ready===false));
});
test('matcher batches name reconciliation before refreshing vehicle proposals and throttles repeated ingestion',async()=>{
  const f=fixture(),calls=[];let clock=now;
  const tables={fleet_drivers:f.drivers,drivers:f.reference,fleet_identities:f.identities,fleet_latest:f.latest,vehicles:f.vehicles,fleet_sources:f.sources};
  const list=async t=>structuredClone(tables[t]);
  const db=async(t,{body})=>{calls.push(t);if(t==='rpc/fleet_auto_link_driver'){tables.fleet_drivers.find(d=>d.id===body.p_driver).ludy_driver_code=body.p_ludy_code;return body.p_driver;}return true;};
  const matcher=createDriverMatcher({list,db,now:()=>clock});const result=await matcher.run();assert.equal(result.applied,2);assert.equal(result.vehicle_linked,1);assert.equal(calls[0],'rpc/fleet_reconcile_vehicle_contracts');assert.equal(calls[3],'rpc/fleet_auto_link_vehicle');
  assert.equal((await matcher.run()).skipped,true);assert.equal(calls.length,4);clock+=11000;await matcher.run();assert.equal(calls.length,6);
});

test('an expired automatic vehicle claim cannot block a new driver while a manual claim still can',()=>{
  const f=fixture();f.reference.push({code:'L2',name:'Another Driver',agency_id:1});
  f.drivers[0]={...f.drivers[0],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'bolt_live',expires_at:new Date(now-1000).toISOString()}};
  f.drivers[1]={...f.drivers[1],name:'Another Driver',ludy_driver_code:'L2'};
  const plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_invalidate,true);assert.equal(plan.rows[1].vehicle_ready,true);
  f.drivers[0].vehicle_link_method='manual';const manual=planDriverMatches(f);assert.equal(manual.rows[0].vehicle_invalidate,false);assert.equal(manual.rows[1].vehicle_ready,false);
});

test('fresh contradictory, unknown or wrong-agency plates revoke only automatic evidence immediately',()=>{
  for(const change of [
    f=>{f.sources.push({...f.sources[0],id:'uber'});f.vehicles.push({key:'4567B',plate:'4567-B',agency_id:1});f.latest.push({driver_id:'b',source:'uber',status:'available',observed_at:iso,vehicle_label:'4567-B'});},
    f=>{f.latest[0].vehicle_label='UNKNOWN-PLATE';},
    f=>{f.vehicles[0].agency_id=2;}
  ]) {
    const f=fixture();f.drivers[1]={...f.drivers[1],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'bolt_live',expires_at:new Date(now+150000).toISOString()}};
    change(f);const row=planDriverMatches(f).rows[1];assert.equal(row.vehicle_invalidate,true);assert.equal(row.vehicle_ready,false);
    f.drivers[1].vehicle_link_method='manual';assert.equal(planDriverMatches(f).rows[1].vehicle_invalidate,false);
  }
});

test('two fresh people claiming the same car invalidate an earlier automatic claim without selecting a winner',()=>{
  const f=fixture();f.reference.push({code:'L2',name:'Another Driver',agency_id:1});f.drivers[0]={...f.drivers[0],name:'Another Driver',ludy_driver_code:'L2'};
  f.drivers[1]={...f.drivers[1],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'bolt_live',expires_at:new Date(now+150000).toISOString()}};
  f.sources.push({...f.sources[0],id:'uber'});f.latest.push({driver_id:'u',source:'uber',status:'available',observed_at:iso,vehicle_label:'1234 A'});
  const plan=planDriverMatches(f);assert.ok(plan.rows.every(r=>!r.vehicle_ready));assert.equal(plan.rows[1].vehicle_invalidate,true);
});

test('matcher clears expired evidence with guarded writes before applying a replacement vehicle claim',async()=>{
  const f=fixture();f.reference.push({code:'L2',name:'Another Driver',agency_id:1});
  f.drivers[0]={...f.drivers[0],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'bolt_live',expires_at:new Date(now-1000).toISOString()}};
  f.drivers[1]={...f.drivers[1],name:'Another Driver',ludy_driver_code:'L2'};
  const tables={fleet_drivers:f.drivers,drivers:f.reference,fleet_identities:f.identities,fleet_latest:f.latest,vehicles:f.vehicles,fleet_sources:f.sources},calls=[];
  const matcher=createDriverMatcher({list:async name=>structuredClone(tables[name]),now:()=>now,db:async(name,args)=>{
    calls.push({name,...args});
    if(name==='rpc/fleet_reconcile_vehicle_contracts')return 0;
    if(name==='fleet_drivers') {const row=tables.fleet_drivers.find(d=>args.params.id==='eq.'+d.id);assert.equal(args.params.vehicle_link_method,'eq.platform_plate');assert.equal(args.params.auto_link_disabled,'eq.false');Object.assign(row,args.body);return [row];}
    if(name==='rpc/fleet_auto_link_vehicle'){const row=tables.fleet_drivers.find(d=>d.id===args.body.p_driver);row.vehicle_key=args.body.p_vehicle_key;return true;}
    throw Error('Unexpected mutation');
  }});
  const result=await matcher.run();assert.equal(result.vehicle_linked,1);assert.equal(calls[0].name,'rpc/fleet_reconcile_vehicle_contracts');assert.equal(calls[1].name,'fleet_drivers');assert.equal(calls[2].name,'rpc/fleet_auto_link_vehicle');
  assert.equal(tables.fleet_drivers[0].vehicle_key,null);assert.equal(tables.fleet_drivers[1].vehicle_key,'1234A');
});

test('an offline selected Bolt car cannot create or renew a current assignment',()=>{
 const f=fixture();f.drivers[1].ludy_driver_code='L1';
 Object.assign(f.latest[0],{status:'offline',evidence:{method:'official_api',vehicle_origin:'bolt_selected',is_online:false}});
 let row=planDriverMatches(f).rows[1];assert.equal(row.vehicle_ready,false);assert.equal(row.vehicle_key,null);assert.match(row.vehicle_reason,/sélectionné/);
 f.drivers[1].vehicle_key='1234A';f.drivers[1].vehicle_link_method='platform_plate';f.drivers[1].vehicle_link_evidence={source:'bolt',observed_at:iso,expires_at:new Date(now+150000).toISOString()};
 row=planDriverMatches(f).rows[1];assert.equal(row.vehicle_invalidate,true,'legacy selected-vehicle evidence must be revoked immediately');assert.equal(row.vehicle_ready,false);
 f.drivers[1].vehicle_link_method='manual';row=planDriverMatches(f).rows[1];assert.equal(row.vehicle_invalidate,false,'a manual operator assignment remains authoritative');
});

test('a proven live Bolt lease survives a brief offline transition without refreshing its expiry',()=>{
 const f=fixture(),expiry=new Date(now+100000).toISOString();f.drivers[1]={...f.drivers[1],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'bolt_live',expires_at:expiry}};
 Object.assign(f.latest[0],{status:'offline',vehicle_label:'AN-OLD-SELECTION',evidence:{method:'official_api',vehicle_origin:'bolt_selected'}});
 const row=planDriverMatches(f).rows[1];assert.equal(row.vehicle_ready,false);assert.equal(row.vehicle_invalidate,false);assert.equal(row.vehicle_evidence,null);assert.equal(f.drivers[1].vehicle_link_evidence.expires_at,expiry);
 f.now=now+100001;assert.equal(planDriverMatches(f).rows[1].vehicle_invalidate,true,'old selected metadata never prolongs a live lease');
 assert.equal(trustedVehicleLease({source:'bolt',vehicle_origin:'bolt_selected'}),false);assert.equal(trustedVehicleLease({source:'bolt'}),false);assert.equal(trustedVehicleLease({source:'bolt',vehicle_origin:'bolt_live'}),true);assert.equal(trustedVehicleLease({source:'uber'}),true);
});

test('a matcher run clears legacy Bolt selections instead of renewing them from repeated offline snapshots',async()=>{
 const f=fixture();f.drivers=[{...f.drivers[1],ludy_driver_code:'L1',vehicle_key:'1234A',vehicle_link_method:'platform_plate',auto_link_disabled:false,vehicle_link_evidence:{source:'bolt',expires_at:new Date(now+150000).toISOString()}}];
 Object.assign(f.latest[0],{status:'offline',evidence:{method:'official_api',vehicle_origin:'bolt_selected',is_online:false}});
 const tables={fleet_drivers:f.drivers,drivers:f.reference,fleet_identities:f.identities,fleet_latest:f.latest,vehicles:f.vehicles,fleet_sources:f.sources},calls=[];
 const matcher=createDriverMatcher({list:async name=>structuredClone(tables[name]),now:()=>now,db:async(name,args)=>{calls.push(name);if(name==='rpc/fleet_reconcile_vehicle_contracts')return 0;assert.equal(name,'fleet_drivers');assert.equal(args.params.vehicle_link_method,'eq.platform_plate');assert.equal(args.params.auto_link_disabled,'eq.false');Object.assign(tables.fleet_drivers[0],args.body);return [tables.fleet_drivers[0]];}});
 const result=await matcher.run();assert.equal(result.vehicle_linked,0);assert.deepEqual(calls,['rpc/fleet_reconcile_vehicle_contracts','fleet_drivers']);assert.equal(tables.fleet_drivers[0].vehicle_key,null);assert.deepEqual(tables.fleet_drivers[0].vehicle_link_evidence,{});
});

test('spacing-only full names match uniquely without phonetic guessing, while duplicates stay ambiguous',()=>{
 const f=fixture();f.drivers=[{id:'u',name:'Synthetic Elperson'}];f.reference=[{code:'L1',name:'SYNTHETIC EL PERSON',agency_id:1}];f.latest=[];
 let plan=planDriverMatches(f);assert.equal(plan.rows[0].status,'ready');assert.equal(plan.rows[0].link_method,'name_spacing');assert.equal(plan.rows[0].vehicle_ready,false);
 f.reference.push({code:'L2',name:'Synthetic Elperson'});assert.equal(planDriverMatches(f).rows[0].status,'ready','an exact unique match keeps the existing strict rule');
 f.reference=[{code:'L1',name:'SYNTHETIC EL PERSON'},{code:'L2',name:'SYNTHETIC ELPER SON'}];assert.equal(planDriverMatches(f).rows[0].status,'ambiguous');
 f.reference=[{code:'L1',name:'Synthetic Al Person'}];assert.equal(planDriverMatches(f).rows[0].status,'unmatched');
 f.reference=[{code:'L1',name:'Synthetic El Person'}];f.drivers.push({id:'second',name:'Synthetic El Person'});f.identities.push({id:'second-id',driver_id:'second',source:'uber',organization_id:'fleet'});assert.equal(planDriverMatches(f).rows[0].status,'ambiguous');
});

function shiftFixture(){
 const stamp=seconds=>new Date(now+seconds*1000).toISOString();
 return {now,drivers:[
  {id:'day',name:'Synthetic Day Driver',ludy_driver_code:'DAY',vehicle_key:'SHIFT-CAR',vehicle_link_method:'platform_plate',auto_link_disabled:false,vehicle_link_evidence:{method:'platform_plate',source:'uber',observed_at:stamp(-30),expires_at:stamp(150)}},
  {id:'night',name:'Synthetic Night Driver',ludy_driver_code:'NIGHT',auto_link_disabled:false}],
  reference:[{code:'DAY',name:'Synthetic Day Driver',agency_id:1},{code:'NIGHT',name:'Synthetic Night Driver',agency_id:1}],
  identities:[{id:'id-day',driver_id:'day',source:'uber',organization_id:'shift-test'},{id:'id-night',driver_id:'night',source:'uber',organization_id:'shift-test'}],
  vehicles:[{key:'SHIFT-CAR',plate:'00001-T-1',model:'Synthetic Staria',agency_id:1,active:'OUI'}],
  sources:[{id:'uber',status:'healthy',last_success_at:stamp(0),stale_after_s:45}],
  latest:[{identity_id:'id-day',driver_id:'day',source:'uber',status:'offline',observed_at:stamp(0),vehicle_label:'00001-T-1',evidence:{method:'visible_dom',vehicle_observed_at:stamp(-30),vehicle_status:'on_trip',vehicle_model:'Synthetic Staria'}},
   {identity_id:'id-night',driver_id:'night',source:'uber',status:'on_trip',observed_at:stamp(0),vehicle_label:'00001-T-1',evidence:{method:'visible_dom',vehicle_observed_at:stamp(0),vehicle_status:'on_trip',vehicle_model:'Synthetic Staria'}}],myclicarContracts:[]};
}

async function applyShiftFixture(f){
 const tables={fleet_drivers:f.drivers,drivers:f.reference,fleet_identities:f.identities,fleet_latest:f.latest,vehicles:f.vehicles,fleet_sources:f.sources,fleet_myclicar_contracts:f.myclicarContracts,fleet_contract_assignment_overrides:f.contractOverrides||[]},calls=[];
 const matcher=createDriverMatcher({list:async table=>structuredClone(tables[table]),now:()=>f.now,db:async(table,args)=>{
  calls.push({table,...args});
  if(table==='rpc/fleet_reconcile_vehicle_contracts')return f.reconcile?f.reconcile(tables):0;
  if(table==='fleet_drivers'){
   const old=tables.fleet_drivers.find(d=>args.params.id==='eq.'+d.id);
   assert.equal(args.params.auto_link_disabled,'eq.false');assert.equal(old.auto_link_disabled,false);assert.equal(args.params.vehicle_link_method,'eq.'+old.vehicle_link_method);
   Object.assign(old,args.body);return [old];
  }
  assert.equal(table,'rpc/fleet_auto_link_vehicle');
  assert.equal(tables.fleet_drivers.some(d=>d.id!==args.body.p_driver&&d.vehicle_key===args.body.p_vehicle_key),false,'the previous association must already be removed');
  Object.assign(tables.fleet_drivers.find(d=>d.id===args.body.p_driver),{vehicle_key:args.body.p_vehicle_key,vehicle_link_method:'platform_plate',vehicle_link_evidence:args.body.p_evidence});return true;
 }});
 return {result:await matcher.run(),calls};
}

test('a new shift revokes the offline previous driver lease before assigning the same car to the online driver',async()=>{
 const f=shiftFixture(),plan=planDriverMatches(f);
 assert.equal(plan.rows[0].vehicle_ready,false);assert.equal(plan.rows[0].vehicle_invalidate,true,'an unexpired 180-second old lease cannot collect the new driver distance');
 assert.equal(plan.rows[1].vehicle_ready,false,'the first plan does not choose a winner while the earlier assignment is still present');
 const {result,calls}=await applyShiftFixture(f);assert.equal(result.vehicle_linked,1);assert.deepEqual(calls.map(c=>c.table),['rpc/fleet_reconcile_vehicle_contracts','fleet_drivers','rpc/fleet_auto_link_vehicle']);
 assert.equal(f.drivers[0].vehicle_key,null);assert.equal(f.drivers[1].vehicle_key,'SHIFT-CAR');assert.equal(result.review.rows[1].vehicle_ready,true);
});

test('a fresh plate from an unidentified next-shift driver suspends the old assignment without inventing their Ludy identity',async()=>{
 const f=shiftFixture();f.drivers[1].ludy_driver_code=null;f.drivers[1].name='Unknown Incoming Person';
 const plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_invalidate,true);assert.equal(plan.rows[1].status,'unmatched');assert.equal(plan.rows[1].vehicle_ready,false);
 const {result,calls}=await applyShiftFixture(f);assert.equal(result.vehicle_linked,0);assert.deepEqual(calls.map(c=>c.table),['rpc/fleet_reconcile_vehicle_contracts','fleet_drivers']);
 assert.equal(f.drivers[0].vehicle_key,null);assert.equal(f.drivers[1].ludy_driver_code,null);assert.equal(f.drivers[1].vehicle_key,undefined);
});

test('two fresh online claims remain unassigned across the second pass even when one plate was observed more recently',async()=>{
 const f=shiftFixture();f.latest[0].status='available';
 const {result,calls}=await applyShiftFixture(f);assert.equal(result.vehicle_linked,0);assert.deepEqual(calls.map(c=>c.table),['rpc/fleet_reconcile_vehicle_contracts','fleet_drivers']);
 assert.equal(f.drivers[0].vehicle_key,null);assert.ok(result.review.rows.every(r=>!r.vehicle_ready));
});

test('a manual assignment remains intact and its fresh platform contradiction is reported for review',async()=>{
 const f=shiftFixture();Object.assign(f.drivers[0],{vehicle_link_method:'manual',auto_link_disabled:true});
 const plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_invalidate,false);assert.equal(plan.rows[0].vehicle_conflict,true);assert.match(plan.rows[0].vehicle_reason,/manuelle.*contredite/);
 assert.equal(plan.rows[1].vehicle_ready,false);const {result,calls}=await applyShiftFixture(f);assert.equal(result.vehicle_linked,0);assert.deepEqual(calls.map(c=>c.table),['rpc/fleet_reconcile_vehicle_contracts']);assert.equal(f.drivers[0].vehicle_key,'SHIFT-CAR');
});

test('cached vehicle details preserve their own 180-second deadline while platform status must still be fresh',()=>{
 const f=shiftFixture();f.drivers[0].vehicle_key=null;f.latest=f.latest.slice(1);
 const at=new Date(now-179000).toISOString();f.latest[0].evidence.vehicle_observed_at=at;
 const row=planDriverMatches(f).rows[1];assert.equal(row.vehicle_ready,true);assert.equal(row.vehicle_evidence.observed_at,at);assert.equal(row.vehicle_evidence.expires_at,new Date(now+1000).toISOString());
 assert.equal(row.vehicle_evidence.vehicle_model,'Synthetic Staria');
 f.now=now+1001;assert.equal(planDriverMatches(f).rows[1].vehicle_ready,false,'a new status read cannot extend an old plate');
 f.now=now;f.latest[0].observed_at=new Date(now-46000).toISOString();f.latest[0].evidence.vehicle_observed_at=f.latest[0].observed_at;
 assert.equal(planDriverMatches(f).rows[1].vehicle_ready,false,'a valid 180-second plate is insufficient with a stale 45-second status');
});

test('expired, future, offline or unidentifiable vehicle details never revoke another current assignment',()=>{
 for(const change of [
  f=>{f.latest[1].evidence.vehicle_observed_at=new Date(now-181000).toISOString();},
  f=>{f.latest[1].evidence.vehicle_observed_at=new Date(now+1000).toISOString();},
  f=>{f.latest[1].status='offline';},
  f=>{f.latest[1].evidence.vehicle_status='offline';},
  f=>{f.latest[1].vehicle_label=null;},
  f=>{f.latest[1].vehicle_label='UNKNOWN-PLATE';},
  f=>{f.vehicles.push({...f.vehicles[0],key:'AMBIGUOUS'});}
 ]){
  const f=shiftFixture();change(f);const plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_invalidate,false);assert.equal(plan.rows[1].vehicle_ready,false);
 }
});

test('a matching model alone never identifies a car or changes the former driver association',()=>{
 const f=shiftFixture();f.latest[1].vehicle_label=null;f.vehicles.push({...f.vehicles[0],key:'SECOND',plate:'00002-T-1'});
 const plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_invalidate,false);assert.equal(plan.rows[1].vehicle_ready,false);assert.equal(plan.rows[1].vehicle_key,null);
});

function contractShiftFixture(){
 const f=shiftFixture();
 f.sources.push({id:'myclicar',status:'healthy',last_success_at:iso,stale_after_s:300});
 f.myclicarContracts=[{external_id:'SHIFT-RENTAL',num:'SHIFT-42',client_code:'DAY',vehicle_key:'SHIFT-CAR',vehicle_candidates:['SHIFT-CAR'],
  current:true,eligible:true,status:'IN_PROGRESS',deleted:false,end_at:null,effective_start_at:new Date(now-86400000).toISOString(),observed_at:iso}];
 f.contractOverrides=[];
 Object.assign(f.drivers[0],{vehicle_link_method:'myclicar_contract',vehicle_link_evidence:{method:'myclicar_contract',source:'myclicar',contract_id:'SHIFT-RENTAL',
  contract_num:'SHIFT-42',client_code:'DAY',vehicle_key:'SHIFT-CAR',observed_at:iso,expires_at:new Date(now+300000).toISOString()}});
 return f;
}
const overrideFor=contract=>({contract_id:contract.external_id,client_code:contract.client_code,vehicle_key:contract.vehicle_key,
 effective_start_at:contract.effective_start_at,observed_at:iso,evidence:{reason:'current_platform_assignment'}});

test('an incoming live driver takes priority over another driver contract without choosing between two live claims',async()=>{
 const f=contractShiftFixture(),plan=planDriverMatches(f);
 assert.equal(plan.rows[0].vehicle_ready,false);assert.equal(plan.rows[0].vehicle_invalidate,true);
 assert.match(plan.rows[0].vehicle_reason,/Contrat MyClicar écarté/);
 assert.equal(plan.rows[1].vehicle_ready,true);assert.equal(plan.rows[1].vehicle_evidence.method,'platform_plate');
 assert.equal(plan.rows[1].vehicle_conflict,false,'a rental holder alone is not another observed current driver');
 const {result,calls}=await applyShiftFixture(f);assert.equal(result.vehicle_linked,1);
 assert.deepEqual(calls.map(c=>c.table),['rpc/fleet_reconcile_vehicle_contracts','fleet_drivers','rpc/fleet_auto_link_vehicle']);
 assert.equal(f.drivers[0].vehicle_key,null);assert.equal(f.drivers[1].vehicle_key,'SHIFT-CAR');
 const two=contractShiftFixture();two.latest[0].status='available';
 const conflict=planDriverMatches(two);assert.ok(conflict.rows.every(r=>!r.vehicle_ready&&r.vehicle_conflict));
});

test('persisted contract handover survives offline status, expired platform proof and a restarted matcher',async()=>{
 const f=contractShiftFixture();let reconciled=0;
 f.reconcile=tables=>{reconciled++;if(!tables.fleet_contract_assignment_overrides.length)tables.fleet_contract_assignment_overrides.push(overrideFor(f.myclicarContracts[0]));return 1;};
 assert.equal((await applyShiftFixture(f)).result.vehicle_linked,1);
 assert.equal(f.contractOverrides.length,1,'the authoritative reconciliation barrier is loaded by snapshots');
 assert.equal(f.drivers[0].vehicle_key,null);assert.equal(f.drivers[1].vehicle_key,'SHIFT-CAR');
 const refresh=elapsed=>{
  f.now=now+elapsed;const current=new Date(f.now).toISOString();
  for(const source of f.sources)source.last_success_at=current;
  for(const row of f.latest){row.status='offline';row.observed_at=current;}
  f.myclicarContracts[0].observed_at=current;
 };
 refresh(10000);const offline=await applyShiftFixture(f);
 assert.equal(offline.result.vehicle_linked,0);assert.equal(f.drivers[0].vehicle_key,null);
 assert.equal(f.drivers[1].vehicle_key,'SHIFT-CAR','the incoming driver briefly retains their original bounded proof');
 refresh(400000);const restarted=await applyShiftFixture(f);
 assert.equal(restarted.result.vehicle_linked,0);assert.equal(f.drivers[0].vehicle_key,null);assert.equal(f.drivers[1].vehicle_key,null);
 assert.match(restarted.result.review.rows[0].vehicle_reason,/Contrat MyClicar écarté/);
 assert.equal(reconciled,3);assert.equal(f.contractOverrides.length,1);
});

test('only a new contract assignment fingerprint can restore fallback after a recorded handover',()=>{
 for(const changed of ['external_id','client_code','vehicle_key','effective_start_at']){
  const f=contractShiftFixture();f.latest=[];f.drivers[0].vehicle_key=null;
  const contract=f.myclicarContracts[0];f.contractOverrides.push(overrideFor(contract));
  assert.ok(planDriverMatches(f).rows.every(r=>!r.vehicle_ready));
  let expected='DAY';
  if(changed==='external_id')contract.external_id='NEW-RENTAL';
  if(changed==='client_code'){contract.client_code='NIGHT';expected='NIGHT';}
  if(changed==='vehicle_key'){f.vehicles.push({...f.vehicles[0],key:'SECOND-CAR',plate:'00002-T-1'});contract.vehicle_key='SECOND-CAR';contract.vehicle_candidates=['SECOND-CAR'];}
  if(changed==='effective_start_at')contract.effective_start_at=new Date(now-3600000).toISOString();
  const row=planDriverMatches(f).rows.find(r=>r.ludy_driver_code===expected);
  assert.equal(row.vehicle_ready,true,changed+' identifies a new assignment');assert.equal(row.vehicle_evidence.method,'myclicar_contract');
 }
 const f=contractShiftFixture();f.latest=[];f.drivers[0].vehicle_key=null;f.contractOverrides.push(overrideFor(f.myclicarContracts[0]));
 f.myclicarContracts[0].num='CORRECTED-DISPLAY-NUMBER';f.myclicarContracts[0].observed_at=new Date(now+1000).toISOString();
 f.contractOverrides[0].effective_start_at=f.myclicarContracts[0].effective_start_at.replace('Z','+00:00');
 assert.ok(planDriverMatches(f).rows.every(r=>!r.vehicle_ready),'refresh, display metadata and timezone serialization do not erase the handover');
});

test('a fresh unidentified incoming profile suspends contract fallback without inventing an identity',()=>{
 const f=contractShiftFixture();f.drivers[1].name='Unrecognized Incoming Driver';f.drivers[1].ludy_driver_code=null;
 let plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_invalidate,true);assert.equal(plan.rows[0].vehicle_ready,false);
 assert.equal(plan.rows[1].status,'unmatched');assert.equal(plan.rows[1].vehicle_ready,false);
 f.contractOverrides.push(overrideFor(f.myclicarContracts[0]));f.latest=[];
 plan=planDriverMatches(f);assert.equal(plan.rows[0].vehicle_ready,false);assert.equal(plan.rows[1].status,'unmatched');
});

test('two simultaneous live claims remain blocked and their later offline state cannot resurrect the old contract',async()=>{
 const f=contractShiftFixture();f.latest[0].status='available';
 f.reconcile=tables=>{if(!tables.fleet_contract_assignment_overrides.length)tables.fleet_contract_assignment_overrides.push(overrideFor(f.myclicarContracts[0]));return 1;};
 const conflict=await applyShiftFixture(f);
 assert.equal(conflict.result.vehicle_linked,0);assert.ok(conflict.result.review.rows.every(r=>!r.vehicle_ready));
 assert.ok(f.drivers.every(d=>!d.vehicle_key));assert.equal(f.contractOverrides.length,1);
 f.now=now+400000;const later=new Date(f.now).toISOString();
 for(const row of f.latest){row.status='offline';row.observed_at=later;}
 for(const source of f.sources)source.last_success_at=later;
 f.myclicarContracts[0].observed_at=later;
 const offline=await applyShiftFixture(f);
 assert.equal(offline.result.vehicle_linked,0);assert.ok(f.drivers.every(d=>!d.vehicle_key));
 assert.equal(offline.result.review.rows[0].vehicle_ready,false);assert.match(offline.result.review.rows[0].vehicle_reason,/Contrat MyClicar écarté/);
});

test('a persisted contract override never replaces an explicit manual vehicle choice',async()=>{
 const f=contractShiftFixture();f.contractOverrides.push(overrideFor(f.myclicarContracts[0]));
 Object.assign(f.drivers[0],{vehicle_link_method:'manual',auto_link_disabled:true});
 const {result,calls}=await applyShiftFixture(f);
 assert.equal(result.vehicle_linked,0);assert.equal(f.drivers[0].vehicle_key,'SHIFT-CAR');
 assert.ok(result.review.rows.every(r=>r.vehicle_conflict));
 assert.deepEqual(calls.map(c=>c.table),['rpc/fleet_reconcile_vehicle_contracts']);
});

test('stale or unidentifiable platform details do not suppress current contract fallback',()=>{
 for(const change of [
  f=>{f.latest[1].evidence.vehicle_observed_at=new Date(now-181000).toISOString();},
  f=>{f.latest[1].status='offline';},
  f=>{f.sources[0].last_success_at=new Date(now+6000).toISOString();},
  f=>{f.sources[0].status='paused';},
  f=>{f.latest[1].vehicle_label='UNKNOWN-CAR';},
  f=>{f.vehicles.push({...f.vehicles[0],key:'AMBIGUOUS-CAR'});}
 ]){
  const f=contractShiftFixture();change(f);const row=planDriverMatches(f).rows[0];
  assert.equal(row.vehicle_ready,true);assert.equal(row.vehicle_invalidate,false);assert.equal(row.vehicle_evidence.method,'myclicar_contract');
 }
});

test('failure to persist handover barriers stops assignments before any matching writes',async()=>{
 const f=contractShiftFixture(),calls=[];
 const matcher=createDriverMatcher({now:()=>now,list:async()=>{throw Error('snapshot must follow successful reconciliation');},db:async(name,args)=>{
  calls.push(name);assert.deepEqual(args,{method:'POST',body:{}});throw Error('local reconciliation failed');
 }});
 await assert.rejects(matcher.run(),/local reconciliation failed/);
 assert.deepEqual(calls,['rpc/fleet_reconcile_vehicle_contracts']);assert.match(matcher.error,/interrompu/);
 assert.equal(f.drivers[0].vehicle_key,'SHIFT-CAR');
});
