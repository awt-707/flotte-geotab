import test from 'node:test';
import assert from 'node:assert/strict';
import {createDisconnectionService} from '../server/platform-disconnection-service.mjs';
import {nextCounters} from '../server/fleet-domain.mjs';

function fixture(policy='any'){
 let time=Date.parse('2026-10-31T20:00:00Z'),failBefore=false,failAfter=false;
 const iso=()=>new Date(time).toISOString(),driver='driver',identity='uber-id';
 const tables={fleet_drivers:[{id:driver,name:'Synthetic Driver',ludy_driver_code:'CODE',agency_id:1}],vehicles:[{key:'car',plate:'SYNTHETIC-CAR',agency_id:1,active:'OUI'}],
  fleet_sources:['uber','bolt','myclicar'].map(id=>({id,status:'healthy',last_success_at:iso(),stale_after_s:id==='uber'?45:150})),
  fleet_myclicar_contracts:[{external_id:'contract',num:'Synthetic contract',client_code:'CODE',vehicle_key:'car',vehicle_candidates:['car'],eligible:true,status:'IN_PROGRESS',current:true,deleted:false,end_at:null,effective_start_at:new Date(time-3600000).toISOString(),observed_at:iso()}],
  fleet_contract_assignment_overrides:[],params:[],fleet_settings:[{id:1,disconnection_enabled:true,disconnection_policy:policy,duty_mode:'contract'}],
  fleet_latest:[{identity_id:identity,driver_id:driver,source:'uber',status:'on_trip',observed_at:iso(),offline_since:null,offline_samples:0,evidence:{}}],fleet_identities:[{id:identity,driver_id:driver,source:'uber'}],
  fleet_disconnection_checkpoints:[],fleet_disconnection_alerts:[],fleet_source_events:[]};
 const calls=[];
 const filter=(rows,params={})=>rows.filter(row=>Object.entries(params).every(([key,value])=>typeof value!=='string'?true:value.startsWith('eq.')?String(row[key])===value.slice(3):value.startsWith('in.(')?value.slice(4,-1).split(',').includes(String(row[key])):true));
 const list=async(table,params={},token)=>{assert.ok(tables[table],table);const rows=token==='hidden'&&['fleet_drivers','vehicles'].includes(table)?[]:filter(tables[table],params);return structuredClone(params.select?rows.map(row=>Object.fromEntries(params.select.split(',').filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))):rows);};
 const db=async(table,args={})=>{
  if(table!=='rpc/fleet_commit_disconnections')return list(table,args.params,args.token);
  calls.push(structuredClone(args.body));
  if(failBefore){failBefore=false;throw Error('Synthetic commit failure');}
  const {p_states,p_alerts,p_changes}=args.body;
  tables.fleet_disconnection_checkpoints=structuredClone(p_states);
  for(const row of p_alerts)if(!tables.fleet_disconnection_alerts.some(old=>old.identity_id===row.identity_id&&old.disconnected_at===row.disconnected_at&&old.duty_key===row.duty_key))tables.fleet_disconnection_alerts.push({id:'alert-'+(tables.fleet_disconnection_alerts.length+1),...structuredClone(row)});
  for(const change of p_changes)Object.assign(tables.fleet_disconnection_alerts.find(row=>row.id===change.id),change);
  if(failAfter){failAfter=false;throw Error('Synthetic response lost after commit');}
  return {ok:true};
 };
 const options={list,db,now:()=>time},create=()=>createDisconnectionService(options);
 const observe=(source,status)=>{const row=tables.fleet_latest.find(row=>row.source===source),next={...row,status,observed_at:iso()};Object.assign(row,next,nextCounters(row,next,tables.fleet_sources.find(s=>s.id===source).stale_after_s));};
 const advance=(status,delta=10000)=>{time+=delta;for(const source of tables.fleet_sources)source.last_success_at=iso();for(const contract of tables.fleet_myclicar_contracts)contract.observed_at=iso();observe(tables.fleet_latest[0].source,status);};
 return {tables,calls,create,advance,observe,iso,options,failBefore:()=>{failBefore=true;},failAfter:()=>{failAfter=true;}};
}
test('a switch between used platforms does not alert; the last connected account disconnecting still does',async()=>{
 const f=fixture();f.tables.fleet_identities.push({id:'bolt-id',driver_id:'driver',source:'bolt'});f.tables.fleet_latest.push({identity_id:'bolt-id',driver_id:'driver',source:'bolt',status:'available',observed_at:f.iso(),evidence:{account_status:'active'}});
 const service=f.create();try{
  await service.reconcile();f.advance('offline');await service.reconcile();await service.reconcile();
  assert.equal(f.tables.fleet_disconnection_alerts.length,0);assert.equal(f.tables.fleet_disconnection_checkpoints.find(c=>c.identity_id==='uber-id').state.offline_at,null);
  f.advance('offline');f.observe('bolt','offline');await service.reconcile();
  assert.equal(f.tables.fleet_disconnection_alerts.length,1);assert.equal(f.tables.fleet_disconnection_alerts[0].source,'bolt');assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'open');
  f.advance('available');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');
  f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,2);
 }finally{service.close();}
 const initial=fixture();initial.tables.fleet_latest[0].status='offline';const initialService=initial.create();try{await initialService.reconcile();initial.advance('offline');await initialService.reconcile();assert.equal(initial.tables.fleet_disconnection_alerts.length,0);}finally{initialService.close();}
});
test('optional all-platform policy does not alert while another known account is online',async()=>{
 const f=fixture('all');f.tables.fleet_identities.push({id:'bolt-id',driver_id:'driver',source:'bolt'});f.tables.fleet_latest.push({identity_id:'bolt-id',driver_id:'driver',source:'bolt',status:'available',observed_at:f.iso(),evidence:{account_status:'active'}});
 const service=f.create();try{await service.reconcile();f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0);}finally{service.close();}
});
function secondAccount(f,status='unknown') {
 f.tables.fleet_identities.push({id:'bolt-id',driver_id:'driver',source:'bolt'});
 f.tables.fleet_latest.push({identity_id:'bolt-id',driver_id:'driver',source:'bolt',status,observed_at:f.iso(),offline_since:status==='offline'?f.iso():null,offline_samples:status==='offline'?1:0,evidence:{account_status:'active'}});
}
test('all-platform confirmation uses the projected offline_since and alerts when the last used account disconnects',async()=>{
 const f=fixture('all');secondAccount(f,'available');const service=f.create();try{
  await service.reconcile();f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0);
  f.advance('offline');f.observe('bolt','offline');await service.reconcile();
  assert.equal(f.tables.fleet_disconnection_alerts.length,1);assert.equal(f.tables.fleet_disconnection_alerts[0].source,'bolt');assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'open');
 }finally{service.close();}
});
test('all-platform mode defers an unknown account and confirms a continuous pending transition once it is explicitly offline',async()=>{
 const f=fixture('all');secondAccount(f);let service=f.create();try{
  await service.reconcile();f.advance('offline');const disconnected=f.iso();await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0);
  assert.equal(f.tables.fleet_disconnection_checkpoints.find(c=>c.identity_id==='uber-id').state.offline_at,disconnected);
  service.close();service=f.create();f.advance('offline');f.observe('bolt','offline');await service.reconcile();
  assert.equal(f.tables.fleet_disconnection_alerts.length,1);const alert=f.tables.fleet_disconnection_alerts[0];assert.equal(alert.source,'uber');assert.equal(alert.disconnected_at,disconnected);assert.equal(alert.evidence.deferred_confirmation,true);assert.equal(alert.opened_at,f.iso());
  alert.disconnected_at=alert.disconnected_at.replace('Z','+00:00');
  await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,1);assert.equal(f.calls.at(-1).p_alerts.length,0);
 }finally{service.close();}
});
test('a pending transition is discarded after an online alternative, a collection gap or an interruption',async()=>{
 for(const reason of ['online_alternative','gap','source_event']){
  const f=fixture('all');secondAccount(f);const service=f.create();try{
   await service.reconcile();f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0);
   if(reason==='online_alternative'){f.advance('offline');f.observe('bolt','on_trip');await service.reconcile();assert.equal(f.tables.fleet_disconnection_checkpoints.find(c=>c.identity_id==='uber-id').state.offline_at,null);}
   f.advance('offline',reason==='gap'?46000:10000);f.observe('bolt',reason==='online_alternative'?'unknown':'offline');
   if(reason==='source_event')f.tables.fleet_source_events.push({source:'uber',status:'error',at:f.iso()});
   await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0,reason);
   f.advance('offline');f.observe('bolt','offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0,reason+' cannot replay later');
  }finally{service.close();}
 }
});
test('a fresh connection on the other platform resolves an old incident immediately for either policy',async()=>{
 for(const policy of ['any','all']){
  const f=fixture(policy),service=f.create();try{
   await service.reconcile();f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,1);
   f.advance('offline');secondAccount(f,'to_pickup');
   assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'resolved');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');
   f.advance('offline');f.observe('bolt','offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,2);assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');assert.equal(f.tables.fleet_disconnection_alerts[1].source,'bolt');
  }finally{service.close();}
 }
});
test('any-policy reports a proven platform transition despite unknown other accounts; all-policy waits',async()=>{
 for(const policy of ['any','all']){
  const f=fixture(policy);secondAccount(f);const service=f.create();try{await service.reconcile();f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,policy==='any'?1:0);}finally{service.close();}
 }
});
test('stale, disabled or misattributed online evidence cannot resolve a driver incident',async()=>{
 for(const reason of ['stale','disabled','misattributed','source_outage','predates_incident']){
  const f=fixture(),service=f.create();try{
   await service.reconcile();f.advance('offline');await service.reconcile();const incidentAt=f.iso();f.advance('offline');secondAccount(f,'on_trip');const other=f.tables.fleet_latest[1];
   if(reason==='stale')other.observed_at='2026-10-30T20:00:00Z';
   if(reason==='disabled')other.evidence.account_status='deactivated';
   if(reason==='misattributed')f.tables.fleet_identities[1].driver_id='another-driver';
   if(reason==='source_outage')f.tables.fleet_sources.find(s=>s.id==='bolt').status='error';
   if(reason==='predates_incident')other.observed_at=new Date(Date.parse(incidentAt)-1000).toISOString();
   assert.notEqual((await service.read('admin',{admin:true})).alerts[0].status,'resolved',reason);
  }finally{service.close();}
 }
});
test('a newer offline episode or reset counter cannot reactivate an older incident after an unseen reconnection or gap',async()=>{
 for(const policy of ['any','all'])for(const reason of ['unseen_reconnection','gap','missing_counter']){
  const f=fixture(policy),service=f.create();try{
   await service.reconcile();f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,1);
   if(reason==='unseen_reconnection'){f.advance('available');f.advance('offline');}
   else f.advance('offline',reason==='gap'?46000:10000);
   if(reason==='missing_counter')f.tables.fleet_latest[0].offline_since=null;
   assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'suspended',policy+' '+reason);
   await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'suspended');assert.equal(f.tables.fleet_disconnection_alerts.length,1);
  }finally{service.close();}
 }
});
test('atomic retry and restart preserve an incident without duplicating it',async()=>{
 for(const failure of ['failBefore','failAfter']){
  const f=fixture(),service=f.create();await service.reconcile();f.advance('offline');f[failure]();await assert.rejects(service.reconcile());service.close();
  const restarted=f.create();try{await restarted.reconcile();await restarted.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,1);assert.equal(f.tables.fleet_disconnection_alerts[0].status,'open');}finally{restarted.close();}
 }
});
test('an interruption, stale observation or completed contract cannot manufacture a transition',async()=>{
 for(const reason of ['source_event','gap','contract_return','override']){
  const f=fixture(),service=f.create();try{
   await service.reconcile();f.advance('offline',reason==='gap'?46000:10000);
   if(reason==='source_event')f.tables.fleet_source_events.push({source:'uber',status:'error',at:f.iso()});
   if(reason==='contract_return')f.tables.fleet_myclicar_contracts[0].end_at=f.iso();
   if(reason==='override'){const c=f.tables.fleet_myclicar_contracts[0];f.tables.fleet_contract_assignment_overrides.push({contract_id:c.external_id,client_code:c.client_code,vehicle_key:c.vehicle_key,effective_start_at:c.effective_start_at});}
   await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0,reason);
  }finally{service.close();}
 }
});
test('a source outage suspends the visible alert immediately and reconnection resolves it',async()=>{
 const f=fixture(),service=f.create();try{
  await service.reconcile();f.advance('offline');await service.reconcile();f.tables.fleet_sources[0].status='error';
  assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'suspended');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'suspended');
  f.tables.fleet_sources[0].status='healthy';f.advance('available');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');
 }finally{service.close();}
});
test('a quick pause and recovery suspends the prior episode before reconciliation and cannot revive it after event expiry',async()=>{
 for(const interruptedSource of ['uber','myclicar']){
  const f=fixture(),service=f.create();try{
   await service.reconcile();f.advance('offline');await service.reconcile();
   f.advance('offline',1000);f.tables.fleet_source_events.push({source:interruptedSource,status:'paused',at:f.iso()});
   f.advance('offline',1000);
   assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'suspended',interruptedSource+' read before reconciliation');
   await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'suspended');
   for(let n=0;n<40;n++){f.advance('offline');await service.reconcile();}
   f.tables.fleet_source_events=[];
   assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'suspended',interruptedSource+' expired interruption history');
   await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,1);assert.equal(f.tables.fleet_disconnection_alerts[0].status,'suspended');
   f.advance('available');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');
   f.advance('offline');await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,2);assert.equal(f.tables.fleet_disconnection_alerts[1].status,'open');
  }finally{service.close();}
 }
});
test('an unrelated provider pause does not hide a confirmed platform disconnection',async()=>{
 const f=fixture(),service=f.create();try{
  await service.reconcile();f.advance('offline');await service.reconcile();
  f.advance('offline',1000);f.tables.fleet_source_events.push({source:'bolt',status:'paused',at:f.iso()});
  f.advance('offline',1000);assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'open');
  await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'open');
 }finally{service.close();}
});
test('contract return ends its incident and scoped readers cannot see another agency or its coverage',async()=>{
 const f=fixture(),service=f.create();try{
  await service.reconcile();f.advance('offline');await service.reconcile();
  const hidden=await service.read('hidden');assert.equal(hidden.alerts.length,0);assert.equal(hidden.coverage.expected_drivers,0);assert.equal(Object.hasOwn(hidden.coverage,'contracts_seen'),false);
  f.tables.fleet_myclicar_contracts[0].end_at=f.iso();await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');
 }finally{service.close();}
});
test('disabled monitoring clears baselines and cannot replay an offline transition on reactivation',async()=>{
 const f=fixture(),service=f.create();try{
  await service.reconcile();f.tables.fleet_settings[0].disconnection_enabled=false;await service.reconcile();assert.equal(f.tables.fleet_disconnection_checkpoints.length,0);
  f.advance('offline');f.tables.fleet_settings[0].disconnection_enabled=true;await service.reconcile();assert.equal(f.tables.fleet_disconnection_alerts.length,0);
 }finally{service.close();}
});
test('a contract missing from the active feed suspends its incident without claiming a confirmed return',async()=>{
 const f=fixture(),service=f.create();try{
  await service.reconcile();f.advance('offline');await service.reconcile();
  f.tables.fleet_myclicar_contracts[0].current=false;await service.reconcile();
  assert.equal(f.tables.fleet_disconnection_alerts[0].status,'suspended');
  assert.equal((await service.read('admin',{admin:true})).alerts[0].status,'suspended');
  f.tables.fleet_myclicar_contracts[0].end_at=f.iso();await service.reconcile();
  assert.equal(f.tables.fleet_disconnection_alerts[0].status,'resolved');
 }finally{service.close();}
});
