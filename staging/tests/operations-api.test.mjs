import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createOperationsApi} from '../server/operations.mjs';
import {createDemandCityReview,demandReviewIdentity,demandReviewSignature} from '../server/demand-city-review.mjs';

const NOW=Date.parse('2026-11-02T10:00:00Z'),stamp=offset=>new Date(NOW+(offset||0)).toISOString();
function fixture(t,options={}){
 const userIds=Object.fromEntries(['admin','manager','viewer','pending'].map(role=>[role,randomUUID()]));
 const ruleId=randomUUID(),foreignRuleId=randomUUID(),eventId=randomUUID();
 const tables={profiles:Object.entries(userIds).map(([role,user_id])=>({role,user_id})),agencies:[{id:1,name:'Synthetic Casa',city:'Casablanca'},{id:2,name:'Synthetic Marrakech',city:'Marrakech'}],
 ops_demand_imports:[],ops_demand_rides:[],
 ops_rush_rules:[{id:ruleId,agency_id:1,city:'Casablanca',days:[1],start:'10:00',end:'13:00',enabled:true,label:'Synthetic rush'},{id:foreignRuleId,agency_id:2,city:'Marrakech',days:[1],start:'10:00',end:'13:00',enabled:true,label:'Other agency'}],
 ops_events:[{id:eventId,source_id:'manual',external_key:'synthetic',title:'Synthetic event',city:'Casablanca',starts_at:stamp(3600000),fingerprint:'a'.repeat(64),status:'pending'}],ops_event_sources:[{id:'manual',status:'manual'}],
 fleet_sources:[{id:'bolt',status:'healthy',last_success_at:stamp(),stale_after_s:150,metadata:{private:'never return'}}],
 fleet_drivers:[{id:'driver-1',ludy_driver_code:'CODE1',name:'Synthetic One',agency_id:1},{id:'driver-2',ludy_driver_code:'CODE2',name:'Synthetic Two',agency_id:2}],
 fleet_latest:[{identity_id:'identity-1',driver_id:'driver-1',agency_id:1,source:'bolt',status:'on_break',observed_at:stamp()},{identity_id:'identity-2',driver_id:'driver-2',agency_id:2,source:'bolt',status:'on_break',observed_at:stamp()}],
 vehicles:[{key:'CAR1',plate:'SYNTHETIC1',agency_id:1,ref_l100:null},{key:'CAR2',plate:'SYNTHETIC2',agency_id:2,ref_l100:null}],ops_fuel_settings:[{id:1,enabled:true,excess_pct:30,min_distance_km:10,cooldown_minutes:60}],fleet_rotation_contracts:[],fleet_myclicar_contracts:[],fleet_rotation_sync:[],fleet_observations:[],fleet_source_events:[],params:[]};
 const requests=[],unexpected=[],failures=new Set();
 const fetchFn=async(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421','API tests make no external provider request');
  const token=options.headers.Authorization?.slice(7),method=options.method||'GET',table=u.pathname.split('/').at(-1),payload=options.body?JSON.parse(options.body):undefined;
  requests.push({table,token,method,body:payload,params:Object.fromEntries(u.searchParams)});
  if(failures.has(table))return Response.json({code:'57014',message:'Synthetic read failure'},{status:500});
  if(u.pathname==='/auth/v1/user')return userIds[token]?Response.json({id:userIds[token]}):Response.json({}, {status:401});
  if(table==='ops_import_demand'){
   assert.equal(token,'service');const duplicate=tables.ops_demand_imports.some(row=>row.agency_id===payload.p_import.agency_id&&row.fingerprint===payload.p_import.fingerprint);
   if(!duplicate)tables.ops_demand_imports.push({id:randomUUID(),...payload.p_import});
   return Response.json({duplicate,inserted:duplicate?0:payload.p_rows.length});
  }
  if(table==='ops_ingest_events'){assert.equal(token,'service');return Response.json(payload.p_rows.length);}
  if(table==='ops_mutate_manual_event'){assert.equal(token,'service');return Response.json({ok:true,id:payload.p_id});}
  if(!Object.hasOwn(tables,table)){unexpected.push(table);throw Error('Unexpected table '+table);}
  let rows=tables[table];
  if(token!=='service'){
   if(table==='profiles')rows=rows.filter(row=>row.user_id===userIds[token]);
   else if(table==='fleet_sources'&&token!=='admin')rows=[];
   else if(token!=='admin'&&['agencies','vehicles','fleet_drivers','fleet_latest','ops_demand_imports','ops_demand_rides','ops_rush_rules'].includes(table))rows=rows.filter(row=>Number(table==='agencies'?row.id:row.agency_id)===1);
  }
  const matches=row=>[...u.searchParams].every(([key,value])=>value.startsWith('eq.')?String(row[key])===value.slice(3):true);rows=rows.filter(matches);
  if(method==='PATCH'){assert.equal(token,'service');rows.forEach(row=>Object.assign(row,payload));}
  else if(method==='POST'){assert.equal(token,'service');const row={id:randomUUID(),...payload};tables[table].push(row);rows=[row];}
  else assert.equal(method,'GET');
  const offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100000);return Response.json(rows.slice(offset,offset+limit));
 };
 const api=createOperationsApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',fetchFn,now:()=>NOW,setTimer(){assert.fail('Reading or saving must not start public event polling');},clearTimer(){},...options});
 t.after(()=>{api.close();assert.deepEqual(unexpected,[]);});
 async function call(path,{token='admin',body,raw,method=body===undefined&&raw===undefined?'GET':'POST',origin='http://127.0.0.1:4173'}={}){const req=Readable.from(body===undefined&&raw===undefined?[]:[Buffer.from(raw===undefined?JSON.stringify(body):raw)]);Object.assign(req,{url:'/api/operations/'+path,method,headers:{host:'127.0.0.1:4173',...(origin?{origin}:{}),...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});let status,data;const handled=await api(req,{writeHead:value=>status=value,end:value=>data=JSON.parse(value)});return {handled,status,data};}
 return {api,call,tables,requests,failures,ruleId,foreignRuleId,eventId,userIds};
}
const importBody=()=>({agency_id:1,city:'Casablanca',file_name:'synthetic.xlsx',rows:[{external_id:'TRIP1',started_at:stamp(-3600000),pickup_zone:'Synthetic pickup',status:'completed'}]});

test('operations reject untrusted origins and non-staff sessions before reading operational tables',async t=>{
 const f=fixture(t);assert.equal((await f.call('demand',{origin:'https://foreign.invalid'})).status,403);assert.equal(f.requests.length,0);
 for(const [token,status] of [[null,401],['unknown',401],['pending',403],['dps_'+'a'.repeat(43),401]]){
  const at=f.requests.length;assert.equal((await f.call('demand',{token})).status,status);assert.ok(f.requests.slice(at).every(row=>['user','profiles'].includes(row.table)));
 }
 for(const path of ['events/manual','events/refresh','fuel/settings','fuel/reference'])assert.equal((await f.call(path,{token:'manager',raw:'malformed'})).status,403);
 assert.equal((await f.call('demand/import',{token:'viewer',raw:'malformed'})).status,403);
 assert.ok(f.requests.every(row=>row.method==='GET'));
});
test('demand and rush reads use caller agency scope; imports cannot target a hidden agency',async t=>{
 const f=fixture(t);f.tables.ops_demand_imports.push({agency_id:1,city:'Casablanca',fingerprint:'a'.repeat(64)},{agency_id:2,city:'Marrakech',fingerprint:'b'.repeat(64)});
 const view=await f.call('demand',{token:'viewer'});assert.equal(view.status,200);assert.equal(view.data.imports.length,1);assert.equal(view.data.agencies.length,1);
 assert.deepEqual(view.data.pickup_reference.cities.map(row=>row.name),['Casablanca']);
 assert.equal(view.data.pickup_reference.cities[0].entries.length,45);assert.equal(view.data.pickup_reference.cities[0].declared.verified,false);
 assert.equal((await f.call('demand?agency_id=2',{token:'manager'})).status,403);assert.equal((await f.call('demand?city=Unknown')).status,400);
 assert.equal((await f.call('demand/import',{token:'manager',body:{...importBody(),agency_id:2,city:'Marrakech'}})).status,403);
 assert.equal(f.requests.filter(row=>row.method!=='GET').length,0);
 assert.equal((await f.call('rush',{token:'viewer'})).data.rules.length,1);
});
test('private city review is applied after caller RLS and never exposes reviewed identities or evidence',async t=>{
 const rows=[1,2].map(agency_id=>{const row={agency_id,external_id:'synthetic-reviewed-'+agency_id,city:agency_id===1?'Casablanca':'Marrakech',started_at:stamp(-3600000),pickup_zone:'Synthetic uncertain place',status:'completed'};row.ride_key=demandReviewIdentity(row);return row;});
 const plan={version:1,reviewed_at:stamp(),source_sha256:'c'.repeat(64),entries:rows.map(row=>({agency_id:row.agency_id,ride_key:row.ride_key,signature:demandReviewSignature(row),decision:'quarantined',basis:'unresolved_locality',evidence:[]}))};
 const f=fixture(t,{demandCityReview:createDemandCityReview(plan)});f.tables.ops_demand_rides.push(...rows);
 const view=await f.call('demand',{token:'manager'});assert.equal(view.status,200);assert.equal(view.data.summary.total,0);assert.equal(view.data.summary.coverage.report_rows,1);assert.equal(view.data.summary.coverage.city_review.quarantined,1);assert.equal(view.data.pickup_reference.cities[0].imported.requests,0);
 assert.doesNotMatch(JSON.stringify(view.data),/synthetic-reviewed|source_sha256|signature|ride_key|unresolved_locality/);
 assert.ok(f.requests.filter(r=>r.table==='ops_demand_rides').every(r=>r.token==='manager'));assert.ok(f.requests.every(r=>r.method==='GET'));
});
test('normalized demand imports use one atomic RPC, reject contradictions and deduplicate file retries',async t=>{
 const f=fixture(t);const input=importBody();const first=await f.call('demand/import',{token:'manager',body:input});assert.equal(first.status,200);assert.equal(first.data.duplicate,false);
 const writes=f.requests.filter(row=>row.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].table,'ops_import_demand');assert.equal(writes[0].body.p_rows.length,1);assert.match(writes[0].body.p_import.fingerprint,/^[0-9a-f]{64}$/);
 assert.equal((await f.call('demand/import',{token:'manager',body:input})).data.duplicate,true);
 const before=f.requests.filter(row=>row.method!=='GET').length;
 for(const body of [null,[],{}, {...input,rows:[input.rows[0],{...input.rows[0],pickup_zone:'Contradictory'}]}, {...input,rows:[{...input.rows[0],started_at:'not a date'}]}])assert.equal((await f.call('demand/import',{body})).status,400);
 assert.equal(f.requests.filter(row=>row.method!=='GET').length,before);
});
test('rush updates verify old and new agencies and never allow a viewer write',async t=>{
 const f=fixture(t),rule={...f.tables.ops_rush_rules[0],label:'Updated'};
 assert.equal((await f.call('rush',{token:'manager',body:{...rule,id:f.foreignRuleId}})).status,404);
 assert.equal((await f.call('rush',{token:'manager',body:{...rule,agency_id:2}})).status,403);
 assert.equal((await f.call('rush',{token:'viewer',body:rule})).status,403);
 assert.equal((await f.call('rush',{token:'manager',body:{...rule,days:[0,8]}})).status,400);
 assert.equal((await f.call('rush',{token:'manager',body:rule})).status,200);assert.equal(f.tables.ops_rush_rules[0].label,'Updated');
 assert.equal(f.requests.filter(row=>row.method!=='GET').length,1);
});
test('manager pause detection uses safe source health and only authorized driver observations',async t=>{
 const f=fixture(t),result=await f.call('pauses',{token:'manager'});assert.equal(result.status,200);assert.equal(result.data.pauses.length,1);assert.equal(result.data.pauses[0].driver_name,'Synthetic One');assert.equal(result.data.pauses[0].rush,true);
 assert.doesNotMatch(JSON.stringify(result.data),/Synthetic Two|private|metadata/);const sourceReads=f.requests.filter(row=>row.table==='fleet_sources');assert.ok(sourceReads.length);assert.ok(sourceReads.every(row=>row.params.select==='id,status,last_success_at,stale_after_s'));
 for(const table of ['fleet_latest','fleet_drivers','ops_rush_rules'])assert.ok(f.requests.filter(row=>row.table===table).every(row=>row.token==='manager'));
});
test('manual event writes require an admin and no collector resumes or refreshes',async t=>{
 const f=fixture(t),input={city:'Casablanca',title:'Synthetic future event',place:'Synthetic address',starts_local:'2026-11-03T20:00',request_id:randomUUID()};
 assert.equal((await f.call('events/manual',{body:input})).status,200);const saved=f.requests.find(row=>row.table==='ops_mutate_manual_event');assert.equal(saved.body.p_action,'create');assert.equal(saved.body.p_user,f.userIds.admin);assert.equal(saved.body.p_id,input.request_id);assert.equal(saved.body.p_row.place,input.place);
 for(const body of [null,[],{...input,place:''},{...input,city:'Unknown'},{...input,starts_local:'2026-02-31T20:00'},{...input,ends_local:'2026-11-03T18:00'}])assert.equal((await f.call('events/manual',{body})).status,400);
 for(const action of ['update','delete']){
  const path='events/'+f.eventId+'/'+action;assert.equal((await f.call(path,{token:'manager',body:input})).status,403);assert.equal((await f.call(path,{body:input})).status,400);
  assert.equal((await f.call(path,{body:{...input,fingerprint:'a'.repeat(64)}})).status,200);
 }
 const count=f.requests.length;await f.api.resume();assert.equal(f.requests.length,count);assert.equal((await f.call('events/refresh',{body:{}})).status,410);
 const read=await f.call('events');assert.equal(read.data.manual_only,true);assert.ok(f.requests.filter(r=>r.table==='ops_events').every(r=>r.params.source_id==='eq.manual'));assert.equal(f.requests.some(r=>r.table==='ops_event_sources'),false);
});
test('fuel settings validate input, preserve fields, and staff status does not reveal global fleet counts',async t=>{
 const f=fixture(t),result=await f.call('fuel',{token:'viewer'});assert.equal(result.status,200);assert.equal(result.data.vehicles.length,1);assert.equal(result.data.status.missing_reference,1);assert.equal(result.data.status.unassigned,undefined);assert.equal(result.data.status.measured,undefined);assert.equal(result.data.status.queued,undefined);
 const valid={enabled:true,excess_pct:30,min_distance_km:10,cooldown_minutes:60};
 for(const body of [null,[],{...valid,enabled:'yes'},{...valid,excess_pct:0},{...valid,min_distance_km:1},{...valid,cooldown_minutes:1}])assert.equal((await f.call('fuel/settings',{body})).status,400);
 assert.equal((await f.call('fuel/settings',{body:{...valid,arbitrary:'ignored'}})).status,200);assert.equal(f.tables.ops_fuel_settings[0].arbitrary,undefined);
 assert.equal((await f.call('fuel/settings',{raw:'{bad'})).status,400);assert.equal((await f.call('fuel/settings',{body:{padding:'x'.repeat(65536)}})).status,413);
});
test('rotations use actual contracts without reading optional high-volume platform history',async t=>{
 const f=fixture(t);f.tables.fleet_rotation_contracts.push({external_id:'old',client_code:'CODE1',vehicle_key:'CAR1',agency_id:1,effective_start_at:stamp(-7200000),end_at:stamp(-3600000)});
 f.tables.fleet_myclicar_contracts.push({external_id:'new',client_code:'CODE2',vehicle_key:'CAR1',agency_id:1,effective_start_at:stamp(-1800000)});
 const result=await f.call('rotations');assert.equal(result.status,200);assert.equal(result.data.summary.mean_minutes,30);assert.equal(f.requests.some(r=>r.table==='fleet_observations'),false);assert.equal(f.requests.some(r=>r.table==='fleet_source_events'),false);
 assert.equal((await f.call('rotations?to=invalid')).status,400);
});
test('rotations retain measured results when optional observations time out and keep each query scoped and bounded',async t=>{
 const f=fixture(t);f.tables.fleet_rotation_contracts.push({external_id:'known',client_code:'CODE1',vehicle_key:'CAR1',agency_id:1,effective_start_at:stamp(-10800000),end_at:stamp(-9000000)},
 {external_id:'missing',client_code:'CODE2',vehicle_key:'CAR1',agency_id:1,effective_start_at:stamp(-7200000),end_at:null});
 f.tables.fleet_myclicar_contracts.push({external_id:'current',client_code:'CODE1',vehicle_key:'CAR1',agency_id:1,effective_start_at:stamp(-1800000)});
 f.failures.add('fleet_observations');const result=await f.call('rotations');assert.equal(result.status,200);assert.equal(result.data.summary.mean_minutes,30);assert.equal(result.data.summary.unknown_count,1);assert.equal(result.data.coverage.observation_coverage_complete,false);
 const requests=f.requests.filter(r=>r.table==='fleet_observations');assert.equal(requests.length,4);assert.ok(requests.every(r=>r.token==='admin'&&r.params.driver_id.startsWith('eq.')&&['eq.uber','eq.bolt'].includes(r.params.source)&&r.params.order==='observed_at.desc'&&r.params.limit==='200'));
 assert.ok(result.data.warnings.some(w=>w.includes('Historique des connexions partiel')));
});
