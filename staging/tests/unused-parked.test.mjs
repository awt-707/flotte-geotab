import test from 'node:test';import assert from 'node:assert/strict';
import {unusedParkedVehicle,lastKnownUnusedParking} from '../server/unused-parked.mjs';
const now=Date.parse('2026-11-02T12:00:00Z'),at=new Date(now).toISOString(),older=new Date(now-301000).toISOString();
function fixture(){return {now,vehicle:{key:'CAR',plate:'TEST-1',other_plates:'OLD-1',vin:'VIN-ONE',myclicar_external_id:'provider-car',geotab_id:'gps',parked:true,position:{fresh:true,speed:0,at}},inventory:[{external_id:'provider-car',vehicle_key:'CAR',plate:'TEST-1',vin:'VIN-ONE',status:'AVAILABLE',is_blocked:false,archived:false,deleted_at:null,current:true,reason:'matched',observed_at:at}],inventorySync:{status:'healthy',last_success_at:at,counts:{current_vehicles:1}},contracts:[],drivers:[],identities:[],latest:[],sources:[{id:'geotab',status:'healthy',last_success_at:at,stale_after_s:20},{id:'myclicar',status:'healthy',last_success_at:at,stale_after_s:300,coverage:{contracts:0}},{id:'uber',status:'healthy',last_success_at:at,stale_after_s:90},{id:'bolt',status:'unconnected',last_success_at:null,stale_after_s:90}]};}
const contract=(f,extra={})=>{f.contracts=[{external_id:'contract',status:'IN_PROGRESS',current:true,observed_at:at,deleted:false,end_at:null,...extra}];f.sources.find(s=>s.id==='myclicar').coverage.contracts=1;};
function observed(f,{status='offline',plate='TEST-1',assigned=false}={}){f.identities=[{id:'account',driver_id:'driver',source:'uber'}];f.latest=[{identity_id:'account',driver_id:'driver',source:'uber',status,observed_at:at,vehicle_label:plate,evidence:{}}];if(assigned)f.drivers=[{id:'driver',vehicle_key:'CAR'}];}
test('fresh available inventory and a complete empty contract snapshot prove a parked car unused without inventing a return',()=>{
 const f=fixture();assert.equal(unusedParkedVehicle(f),true);assert.equal('last_return_at' in f,false);
 observed(f,{assigned:true});assert.equal(unusedParkedVehicle(f),true);
});
test('parking, GPS, snapshot completeness, timestamps and provider binding are all required',()=>{
 const changes=[f=>f.vehicle.parked=false,f=>f.vehicle.position.fresh=false,f=>f.vehicle.position.speed=4,f=>f.vehicle.position.speed=-1,f=>f.vehicle.position.at=older,f=>f.vehicle.position.at=new Date(now+10000).toISOString(),f=>f.vehicle.geotab_id=null,
 f=>f.sources[0].status='paused',f=>f.sources[1].status='error',f=>f.sources[1].last_success_at=older,f=>f.sources[1].coverage.contracts=1,f=>delete f.sources[1].coverage,f=>f.sources[1].stale_after_s=0,
 f=>f.inventorySync.status='error',f=>f.inventorySync.last_success_at=older,f=>f.inventorySync.counts.current_vehicles=2,f=>f.inventory[0].observed_at=older,f=>f.inventory[0].status='RENTED',f=>f.inventory[0].status='RESERVED',f=>f.inventory[0].is_blocked=true,f=>delete f.inventory[0].is_blocked,f=>f.inventory[0].archived=true,f=>f.inventory[0].current=false,f=>f.inventory[0].reason='ambiguous_vehicle',f=>f.inventory[0].external_id='different',f=>f.inventory[0].vin='OTHER',f=>{f.inventory.push({...f.inventory[0],external_id:'duplicate'});f.inventorySync.counts.current_vehicles=2;}];
 for(const change of changes){const f=fixture();change(f);assert.equal(unusedParkedVehicle(f),false,String(change));}
});
test('active contracts block by key, ambiguous candidate, alias, provider reference and historical VIN even when ineligible',()=>{
 for(const evidence of [{vehicle_key:'CAR'},{vehicle_candidates:['CAR','OTHER']},{plate:'OLD-1'},{temporary_plate:'TEST 1'},{vehicle_external_id:'provider-car'},{}]){const f=fixture();contract(f,{eligible:false,...evidence});assert.equal(unusedParkedVehicle(f),false);}
 const f=fixture();f.inventory.push({external_id:'historical-car',plate:'UNKNOWN',vin:'VIN-ONE',current:true,archived:true});contract(f,{vehicle_external_id:'historical-car',plate:'UNKNOWN',eligible:false});assert.equal(unusedParkedVehicle(f),false);
 const separate=fixture();contract(separate,{vehicle_key:'OTHER',plate:'OTHER-2'});assert.equal(unusedParkedVehicle(separate),true);
 separate.contracts[0].observed_at=older;assert.equal(unusedParkedVehicle(separate),false,'mixed or stale complete batches cannot establish absence');
});
test('a live, unknown or stale platform claim prevents P regardless of assignment completeness',()=>{
 for(const status of ['available','on_trip','to_pickup','on_break','unknown']){const f=fixture();observed(f,{status});assert.equal(unusedParkedVehicle(f),false,status);}
 const assigned=fixture();observed(assigned,{assigned:true,plate:'DIFFERENT',status:'available'});assert.equal(unusedParkedVehicle(assigned),false);
 const stale=fixture();observed(stale);stale.latest[0].observed_at=older;assert.equal(unusedParkedVehicle(stale),false);
 const missing=fixture();observed(missing,{assigned:true});missing.latest=[];assert.equal(unusedParkedVehicle(missing),false);
 const noAccounts=fixture();noAccounts.drivers=[{id:'driver',vehicle_key:'CAR'}];assert.equal(unusedParkedVehicle(noAccounts),false);
 const malformed=fixture();observed(malformed);malformed.latest[0].driver_id='other';assert.equal(unusedParkedVehicle(malformed),false);
});
test('provider outages and competing or contradictory assignments remain unknown',()=>{
 for(const status of ['stale','paused','error','unknown']){const f=fixture();f.sources.find(s=>s.id==='uber').status=status;assert.equal(unusedParkedVehicle(f),false);}
 const f=fixture();f.drivers=[{id:'one',vehicle_key:'CAR'},{id:'two',vehicle_key:'CAR'}];assert.equal(unusedParkedVehicle(f),false);
 const c=fixture();observed(c,{assigned:true});c.drivers[0].vehicle_link_evidence={assignment_conflict:{requires_confirmation:true}};assert.equal(unusedParkedVehicle(c),false);
 const dormant=fixture();dormant.identities=[{id:'bolt-account',source:'bolt',driver_id:'unrelated'}];assert.equal(unusedParkedVehicle(dormant),false,'known accounts prevent treating their failed provider as unused');
});

function returned(f){f.returnSync={status:'healthy',last_success_at:at};f.returns=[{external_id:'returned-contract',vehicle_key:'CAR',vehicle_external_id:'provider-car',details_verified:true,deleted:false,status:'DONE',effective_start_at:new Date(now-3600000).toISOString(),end_at:new Date(now-60000).toISOString(),observed_at:at}];}
test('only a verified actual return can retire an older unassigned platform claim',()=>{
 const f=fixture();observed(f,{status:'on_trip'});f.latest[0].observed_at=new Date(now-120000).toISOString();assert.equal(unusedParkedVehicle(f),false);returned(f);assert.equal(unusedParkedVehicle(f),true);
 for(const change of [x=>x.returns[0].details_verified=false,x=>x.returns[0].end_at=null,x=>x.returns[0].end_at='invalid',x=>x.returns[0].end_at=new Date(now+60000).toISOString(),x=>x.returns[0].deleted=true,x=>x.returns[0].vehicle_key='OTHER',x=>x.returns[0].vehicle_external_id='OTHER',x=>x.returns[0].status='IN_PROGRESS',x=>x.returnSync.status='error',x=>x.returnSync.last_success_at=older,x=>x.returns[0].observed_at=older,x=>x.latest[0].observed_at=at,x=>x.latest[0].evidence.vehicle_observed_at=at,x=>x.drivers=[{id:'driver',vehicle_key:'CAR'}]]){
  const copy=structuredClone(f);change(copy);assert.equal(unusedParkedVehicle(copy),false,String(change));
 }
});
test('future or invalid contract return dates and a known running engine never prove unused parking',()=>{
 for(const end_at of [new Date(now+3600000).toISOString(),'invalid']){const f=fixture();contract(f,{vehicle_key:'CAR',end_at});assert.equal(unusedParkedVehicle(f),false);}
 const f=fixture();f.vehicle.position.ign_on=true;assert.equal(unusedParkedVehicle(f),false);
});
test('a long-stopped vehicle has a dated last-known parking proof without making its GPS fresh',()=>{
 const f=fixture();Object.assign(f.vehicle.position,{fresh:false,at:new Date(now-3600000).toISOString(),received_at:at,lat:33.6,lon:-7.6,ign_on:false});
 assert.equal(unusedParkedVehicle(f),false);assert.equal(lastKnownUnusedParking(f),true);assert.equal(f.vehicle.position.fresh,false);assert.equal(f.vehicle.position.at,new Date(now-3600000).toISOString());
 const changes=[x=>x.vehicle.parked=false,x=>x.vehicle.position.ign_on=true,x=>x.vehicle.position.ign_on=null,x=>x.vehicle.position.speed=4,x=>x.vehicle.position.speed=-1,x=>x.vehicle.position.lat=null,x=>x.vehicle.position.received_at=older,x=>x.vehicle.position.at=new Date(now-8*86400000).toISOString(),x=>x.vehicle.position.at=at,x=>x.sources[0].status='paused',x=>x.inventory[0].status='RENTED',x=>contract(x,{vehicle_key:'CAR'}),x=>observed(x,{status:'available'})];
 for(const change of changes){const copy=structuredClone(f);change(copy);assert.equal(lastKnownUnusedParking(copy),false,String(change));}
 const proof=structuredClone(f);observed(proof,{status:'available'});proof.latest[0].observed_at=new Date(now-120000).toISOString();returned(proof);assert.equal(lastKnownUnusedParking(proof),true);proof.latest[0].observed_at=at;assert.equal(lastKnownUnusedParking(proof),false);
});
