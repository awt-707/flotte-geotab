import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMyClicarContracts,parseMyClicarLocalTime,myClicarClaims} from '../server/myclicar-contracts.mjs';
import {planDriverMatches,createDriverMatcher} from '../server/driver-matching.mjs';
import {trustedVehicleLease} from '../server/vehicle-evidence.mjs';

const now=Date.parse('2026-10-30T12:00:00Z'),at=new Date(now).toISOString();
const raw=()=>({id:101,reference:'000042',clientReference:'000012',contactName:'Synthetic Driver',status:'IN_PROGRESS',
  departureDate:'2026-10-30T07:00:00Z',departureConditionDate:'30/10/2026 à 08h51',actualReturnDate:null,checkoutDate:'',
  endDueDate:'2026-10-30T08:00:00Z',vehicleRegistration:'1234-A',vehicleTemporaryRegistration:'WW987654',
  vehicleBrand:'Test',vehicleModel:'Example',updatedAt:'2026-10-30T10:00:00+01:00',deletedAt:null,
  phone:'must not be copied',email:'private@example.invalid',otherPrivateData:'must not be copied'});
const projected=()=>normalizeMyClicarContracts([raw()],{observedAt:at,now}).contracts[0];
function fixture(){const contract={...projected(),current:true,observed_at:at,vehicle_key:'CAR_A',vehicle_candidates:['CAR_A'],eligible:true};
  return {now,drivers:[{id:'driver',name:'Synthetic Driver',ludy_driver_code:'000012',auto_link_disabled:false}],reference:[{code:'000012',name:'Synthetic Driver',agency_id:1}],
    vehicles:[{key:'CAR_A',plate:'1234-A',agency_id:1,active:'OUI'},{key:'CAR_B',plate:'5678-B',agency_id:1,active:'OUI'}],
    identities:[{id:'bolt-identity',driver_id:'driver',source:'bolt'}],latest:[],
    sources:[{id:'myclicar',status:'healthy',last_success_at:at,stale_after_s:300},{id:'bolt',status:'healthy',last_success_at:at,stale_after_s:150}],
    myclicarContracts:[contract]};}

test('projects only operational fields, preserves reference strings and separates effective departure from due date',()=>{
  const value=normalizeMyClicarContracts([raw()],{observedAt:at,now}),contract=value.contracts[0];
  assert.equal(contract.num,'000042');assert.equal(contract.client_code,'000012');assert.equal(contract.external_id,'101');
  assert.equal(contract.effective_start_at,'2026-10-30T08:51:00.000Z');assert.equal(contract.start_at,contract.effective_start_at);
  assert.equal(contract.provider_updated_at,'2026-10-30T09:00:00.000Z');assert.equal(contract.end_at,null);
  assert.equal(value.counts.active_contracts,1);
  assert.equal(JSON.stringify(value).includes('must not be copied'),false);assert.equal('endDueDate' in contract,false);
});

test('actual return and checkout close contracts while scheduled departure alone proves no current assignment',()=>{
  const returned=raw();returned.actualReturnDate='2026-10-30T10:15:00Z';returned.checkoutDate='30/10/2026 à 11h20';
  const r=normalizeMyClicarContracts([returned],{observedAt:at,now});assert.equal(r.contracts[0].end_at,'2026-10-30T10:15:00.000Z');assert.equal(r.counts.active_contracts,0);
  const planned=raw();planned.departureConditionDate='';const p=normalizeMyClicarContracts([planned],{observedAt:at,now});
  assert.equal(p.contracts[0].start_at,'2026-10-30T07:00:00.000Z');assert.equal(p.contracts[0].effective_start_at,null);assert.equal(p.counts.active_contracts,0);
});

test('invalid, incomplete or contradictory snapshots fail as a whole',()=>{
  for(const change of [r=>r.reference='',r=>r.departureDate='2026-10-30 07:00',r=>r.departureDate='2026-02-30T07:00:00Z',
    r=>r.departureConditionDate='31/02/2026 à 08h51',r=>r.departureConditionDate='30/10/2026 à 25h00',
    r=>r.actualReturnDate='2026-10-29T10:00:00Z',r=>r.clientReference={},r=>r.status='']){
    const invalid=raw();change(invalid);assert.throws(()=>normalizeMyClicarContracts([raw(),{...invalid,id:102,reference:invalid.reference==='000042'?'000043':invalid.reference}],{observedAt:at,now}));
  }
  assert.throws(()=>normalizeMyClicarContracts([raw(),raw()],{observedAt:at,now}));
  assert.throws(()=>normalizeMyClicarContracts([raw(),{...raw(),id:102}],{observedAt:at,now}));
  assert.throws(()=>normalizeMyClicarContracts([raw()],{observedAt:at,now:now+300001}));
  assert.throws(()=>normalizeMyClicarContracts([raw()],{observedAt:at,now:now-5001}));
  assert.throws(()=>parseMyClicarLocalTime('15/02/2026 à 02h30'),'ambiguous Moroccan wall time');
  assert.deepEqual(normalizeMyClicarContracts([],{observedAt:at,now}).contracts,[]);
});

test('a fresh unique contract creates an expiring assignment even with an offline selected Bolt vehicle',()=>{
  const f=fixture();f.latest.push({driver_id:'driver',source:'bolt',status:'offline',observed_at:at,vehicle_label:'5678-B',evidence:{method:'official_api',vehicle_origin:'bolt_selected'}});
  const row=planDriverMatches(f).rows[0];assert.equal(row.vehicle_ready,true);assert.equal(row.vehicle_key,'CAR_A');
  assert.equal(row.vehicle_evidence.method,'myclicar_contract');assert.equal(row.vehicle_evidence.expires_at,new Date(now+300000).toISOString());
  assert.equal(trustedVehicleLease(row.vehicle_evidence),true);
  assert.equal(trustedVehicleLease({...row.vehicle_evidence,expires_at:new Date(now+300001).toISOString()}),false);
  assert.equal(trustedVehicleLease({...row.vehicle_evidence,method:'platform_plate'}),false);
});

test('stale, paused, future, returned, absent or unconfirmed contracts cannot create or preserve a lease',()=>{
  for(const change of [f=>f.sources[0].status='paused',f=>f.sources[0].last_success_at=new Date(now-300001).toISOString(),
    f=>f.myclicarContracts[0].observed_at=new Date(now-300001).toISOString(),f=>f.myclicarContracts[0].effective_start_at=new Date(now+1000).toISOString(),
    f=>f.myclicarContracts[0].end_at=at,f=>f.myclicarContracts[0].current=false,f=>f.myclicarContracts[0].effective_start_at=null,
    f=>f.myclicarContracts[0].status='CANCELED',f=>f.myclicarContracts[0].deleted=true,f=>f.myclicarContracts[0].eligible=false]){
    const f=fixture(),evidence=planDriverMatches(f).rows[0].vehicle_evidence;
    Object.assign(f.drivers[0],{vehicle_key:'CAR_A',vehicle_link_method:'myclicar_contract',vehicle_link_evidence:evidence});change(f);
    const row=planDriverMatches(f).rows[0];assert.equal(row.vehicle_ready,false);assert.equal(row.vehicle_invalidate,true);
  }
});

test('two contracts for one driver or one car reject every competing assignment',()=>{
  for(const sameDriver of [true,false]){
    const f=fixture();f.reference.push({code:'SECOND',name:'Other Driver',agency_id:1});f.drivers.push({id:'other',name:'Other Driver',ludy_driver_code:'SECOND'});
    f.myclicarContracts.push({...f.myclicarContracts[0],external_id:'102',num:'000043',client_code:sameDriver?'000012':'SECOND',vehicle_key:sameDriver?'CAR_B':'CAR_A',vehicle_candidates:[sameDriver?'CAR_B':'CAR_A']});
    assert.ok(planDriverMatches(f).rows.every(r=>!r.vehicle_ready));
  }
  const f=fixture();f.myclicarContracts.push({...f.myclicarContracts[0],external_id:'102',num:'000043',client_code:'UNKNOWN',vehicle_key:null,vehicle_candidates:['CAR_A','CAR_B'],eligible:false});
  assert.equal(planDriverMatches(f).rows[0].vehicle_ready,false);
});

test('a recognized live platform plate replaces contract fallback while an unknown plate still requires review',()=>{
  for(const source of ['uber','bolt'])for(const plate of ['5678-B','UNRECOGNIZED']){
    const f=fixture(),evidence=planDriverMatches(f).rows[0].vehicle_evidence;
    Object.assign(f.drivers[0],{vehicle_key:'CAR_A',vehicle_link_method:'myclicar_contract',vehicle_link_evidence:evidence});
    f.sources.push({...f.sources[1],id:'uber'});f.latest.push({driver_id:'driver',source,status:'available',observed_at:at,vehicle_label:plate,
      evidence:source==='uber'?{method:'visible_dom'}:{method:'official_api',vehicle_origin:'bolt_live'}});
    const row=planDriverMatches(f).rows[0];assert.equal(row.vehicle_ready,plate==='5678-B');assert.equal(row.vehicle_invalidate,true);
    if(plate==='5678-B'){assert.equal(row.vehicle_key,'CAR_B');assert.equal(row.vehicle_evidence.method,'platform_plate');}
  }
  const f=fixture();f.latest.push({driver_id:'driver',source:'bolt',status:'available',observed_at:at,vehicle_label:'1234-A',evidence:{method:'official_api',vehicle_origin:'bolt_live'}});
  assert.equal(planDriverMatches(f).rows[0].vehicle_evidence.method,'platform_plate');
});

test('a recorded move to another car prevents the same driver reverting to the unchanged rental after going offline',()=>{
  const f=fixture(),contract=f.myclicarContracts[0];
  f.latest.push({driver_id:'driver',source:'bolt',status:'available',observed_at:at,vehicle_label:'5678-B',evidence:{method:'official_api',vehicle_origin:'bolt_live'}});
  let row=planDriverMatches(f).rows[0];assert.equal(row.vehicle_ready,true);assert.equal(row.vehicle_key,'CAR_B');
  f.contractOverrides=[{contract_id:contract.external_id,client_code:contract.client_code,vehicle_key:contract.vehicle_key,effective_start_at:contract.effective_start_at}];
  Object.assign(f.drivers[0],{vehicle_key:'CAR_B',vehicle_link_method:'platform_plate',vehicle_link_evidence:row.vehicle_evidence});
  f.now=now+400000;const later=new Date(f.now).toISOString();
  f.latest[0].status='offline';f.latest[0].observed_at=later;f.latest[0].evidence.vehicle_origin='bolt_selected';
  for(const source of f.sources)source.last_success_at=later;
  contract.observed_at=later;
  row=planDriverMatches(f).rows[0];assert.equal(row.vehicle_ready,false);assert.equal(row.vehicle_invalidate,true);
  assert.match(row.vehicle_reason,/Contrat MyClicar écarté/);
});

test('an ineligible rental reference cannot block an unambiguous live platform assignment',()=>{
  const f=fixture();f.myclicarContracts[0].eligible=false;f.myclicarContracts[0].vehicle_key=null;
  f.latest.push({driver_id:'driver',source:'bolt',status:'on_trip',observed_at:at,vehicle_label:'5678-B',evidence:{method:'official_api',vehicle_origin:'bolt_live'}});
  const row=planDriverMatches(f).rows[0];assert.equal(row.vehicle_ready,true);assert.equal(row.vehicle_key,'CAR_B');assert.equal(row.vehicle_evidence.method,'platform_plate');
});

test('manual choices, unmatched client codes, agency mismatches and inactive cars remain unassigned automatically',()=>{
  for(const change of [f=>f.drivers[0].auto_link_disabled=true,f=>f.drivers[0].vehicle_link_method='manual',f=>f.reference[0].code='DIFFERENT',f=>f.vehicles[0].agency_id=2,f=>f.vehicles[0].active='NON']){
    const f=fixture();change(f);assert.equal(planDriverMatches(f).rows[0].vehicle_ready,false);
  }
  const f=fixture();f.drivers.push({id:'manual',name:'Another',ludy_driver_code:'OTHER',vehicle_key:'CAR_A',vehicle_link_method:'manual'});
  assert.equal(planDriverMatches(f).rows[0].vehicle_ready,false);
});

test('matcher writes contract evidence through its dedicated validating RPC and revokes expired proof with method guards',async()=>{
  const f=fixture(),tables={fleet_drivers:f.drivers,drivers:f.reference,fleet_identities:f.identities,fleet_latest:f.latest,vehicles:f.vehicles,fleet_sources:f.sources,fleet_myclicar_contracts:f.myclicarContracts},calls=[];
  const matcher=createDriverMatcher({list:async name=>structuredClone(tables[name]),now:()=>now,db:async(name,args)=>{
    calls.push({name,...args});if(name==='rpc/fleet_reconcile_vehicle_contracts')return 0;if(name==='rpc/fleet_auto_link_myclicar_vehicle')return true;
    assert.equal(name,'fleet_drivers');assert.equal(args.params.vehicle_link_method,'eq.myclicar_contract');assert.equal(args.params.auto_link_disabled,'eq.false');Object.assign(tables.fleet_drivers[0],args.body);return [];
  }});
  assert.equal((await matcher.run()).vehicle_linked,1);assert.equal(calls[0].name,'rpc/fleet_reconcile_vehicle_contracts');assert.deepEqual(calls[1].body,{p_driver:'driver',p_contract_id:'101'});
  Object.assign(f.drivers[0],{vehicle_key:'CAR_A',vehicle_link_method:'myclicar_contract',vehicle_link_evidence:planDriverMatches(f).rows[0].vehicle_evidence});
  f.myclicarContracts[0].current=false;
  assert.equal((await matcher.run({force:true})).vehicle_linked,0);assert.equal(calls[3].name,'fleet_drivers');assert.equal(f.drivers[0].vehicle_key,null);
});

test('freshness is bounded by both source and snapshot and cannot be stretched above five minutes',()=>{
  const f=fixture();f.sources[0].stale_after_s=3600;f.sources[0].last_success_at=new Date(now-100000).toISOString();
  const evidence=myClicarClaims({contracts:f.myclicarContracts,source:f.sources[0],now}).get('000012').evidence;
  assert.equal(evidence.expires_at,new Date(now+200000).toISOString());
  f.sources[0].stale_after_s=45;assert.equal(myClicarClaims({contracts:f.myclicarContracts,source:f.sources[0],now}).size,0);
});
