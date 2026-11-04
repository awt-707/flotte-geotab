import test from 'node:test';
import assert from 'node:assert/strict';
import { BoltClient } from '../server/bolt.mjs';
import {trustedVehicleObservation} from '../server/vehicle-evidence.mjs';
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
const credentials=async()=>({clientId:'test-id',clientSecret:'test-secret'});
test('Bolt token stays server-side, refreshes before expiry and pagination is complete',async()=>{
 let time=1000000,tokens=0;const requests=[];
 const client=new BoltClient({credentials,now:()=>time,fetchFn:async(url,opt)=>{
   requests.push([url,opt]);if(url.endsWith('/token')){tokens++;assert.match(opt.body,/scope=fleet-integration%3Aapi/);return response({access_token:'TOKEN'+tokens,expires_in:600});}
   assert.equal(opt.headers.Authorization,'Bearer TOKEN'+tokens);assert.equal(opt.redirect,'error');assert.ok(!opt.body.includes('test-secret'));
   const b=JSON.parse(opt.body);return response({code:0,data:{drivers:b.offset===0?Array.from({length:1000},(_,i)=>({uuid:String(i)})):[{uuid:'last'}],total_rows:1001}});
 }});
 const rows=await client.pages('getDrivers',{company_id:1},'drivers');assert.equal(rows.length,1001);assert.equal(tokens,1);
 time+=550000;await client.call('getDrivers',{company_id:1,offset:1000});assert.equal(tokens,2);
 assert.equal(JSON.parse(requests.filter(([u])=>u.endsWith('getDrivers'))[1][1].body).offset,1000);
});
test('HTTP 200 business error never becomes successful empty data',async()=>{
 const c=new BoltClient({credentials,fetchFn:async url=>url.endsWith('/token')?response({access_token:'TOKEN'}):response({code:498813,message:'ENDPOINT_DENIED',error_hint:'private upstream details'})});
 await assert.rejects(c.call('getOnlineDrivers',{company_id:1}),e=>e.status===502 && !e.message.includes('private') && e.message.includes('498813'));
});
test('Bolt 503 auth code retries once with a new token; quota is returned with bounded retry',async()=>{
 let tokens=0,calls=0;const c=new BoltClient({credentials,fetchFn:async url=>{if(url.endsWith('/token'))return response({access_token:'TOKEN'+(++tokens)});calls++;return calls===1?response({code:503}):response({code:0,data:{companies:[]}});}});
 assert.deepEqual(await c.call('getCompanies'),{companies:[]});assert.equal(tokens,2);assert.equal(calls,2);
 const q=new BoltClient({credentials,fetchFn:async url=>url.endsWith('/token')?response({access_token:'TOKEN'}):response({code:1005},429,{'retry-after':'120'})});
 await assert.rejects(q.call('getCompanies'),e=>e.status===429 && e.retryAfter===120);
});
test('OAuth quota preserves Retry-After and never starts a Bolt API read',async()=>{
 const calls=[],client=new BoltClient({credentials,fetchFn:async url=>{calls.push(url);return new Response('Too many requests',{status:429,headers:{'retry-after':'600'}});}});
 await assert.rejects(client.call('getCompanies'),error=>error.status===429&&error.retryAfter===600&&/Quota Bolt/.test(error.message));
 assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/token'));
 assert.equal(client.token,null);assert.equal(client.tokenPromise,null);
});
test('Bolt OAuth and read quotas recognize HTTP-date Retry-After without exposing response bodies',async()=>{
 const time=Date.parse('2026-11-03T00:00:00Z'),retryAt=new Date(time+300000).toUTCString();
 for(const tokenLimited of [true,false]){
  const client=new BoltClient({credentials,now:()=>time,fetchFn:async url=>url.endsWith('/token')&&!tokenLimited?response({access_token:'TOKEN'}):new Response('Private provider diagnostic',{status:429,headers:{'retry-after':retryAt}})});
  await assert.rejects(client.call('getCompanies'),error=>error.status===429&&error.retryAfter===300&&!error.message.includes('Private'));
 }
});
test('a Bolt quota pauses every caller sharing the client until the provider retry time',async()=>{
 for(const tokenLimited of [true,false]){
  let time=Date.parse('2026-11-03T00:00:00Z'),calls=0,limited=true;
  const client=new BoltClient({credentials,now:()=>time,fetchFn:async url=>{
   calls++;if(limited&&(tokenLimited||!url.endsWith('/token')))return response({code:1005},429,{'retry-after':'300'});
   return url.endsWith('/token')?response({access_token:'TOKEN',expires_in:600}):response({code:0,data:{companies:[]}});
  }});
  await assert.rejects(client.call('getCompanies'),error=>error.status===429&&error.retryAfter===300);const before=calls;
  time+=10000;await assert.rejects(client.call('getCompanies'),error=>error.status===429&&error.retryAfter===290);
  await assert.rejects(client.accessToken(true),error=>error.status===429);assert.equal(calls,before,'other readers and token refresh must respect the shared cooldown');
  limited=false;time+=290000;assert.deepEqual(await client.call('getCompanies'),{companies:[]});assert.ok(calls>before);
 }
});
test('Bolt keeps a two-hour provider deadline for numeric and HTTP-date quotas',async()=>{
 for(const dated of [false,true])for(const tokenLimited of [false,true]){
  let time=Date.parse('2026-11-03T00:00:00Z'),calls=0,limited=true;const header=dated?new Date(time+7200000).toUTCString():'7200';
  const client=new BoltClient({credentials,now:()=>time,fetchFn:async url=>{calls++;return limited&&(tokenLimited||!url.endsWith('/token'))?response({},429,{'retry-after':header}):url.endsWith('/token')?response({access_token:'TOKEN'}):response({code:0,data:{companies:[]}});}});
  await assert.rejects(client.call('getCompanies'),e=>e.status===429&&e.retryAfter===7200);const initialCalls=calls;
  time+=3600000;await assert.rejects(client.call('getCompanies'),e=>e.status===429&&e.retryAfter===3600);assert.equal(calls,initialCalls);
  time+=3599999;await assert.rejects(client.accessToken(true),e=>e.status===429&&e.retryAfter===1);assert.equal(calls,initialCalls);
  time++;limited=false;assert.deepEqual(await client.call('getCompanies'),{companies:[]});assert.equal(calls,initialCalls+2);
 }
});
test('snapshot joins drivers and online states without inferring offline from missing rows',async()=>{
 const c=new BoltClient({credentials,now:()=>Date.parse('2026-10-30T12:00:00Z'),fetchFn:async url=>{
  if(url.endsWith('/token'))return response({access_token:'TOKEN'});
  const endpoint=url.split('/').pop();const data={getCompanies:{companies:[{company_id:1,legal_name:'Synthetic'}]},getDrivers:{drivers:[{uuid:'a',display_name:'Test A',is_online:false},{uuid:'b',display_name:'Test B',is_online:true}],total_rows:2},getOnlineDrivers:{drivers:[]},getVehicles:{vehicles:[],total_rows:0}}[endpoint];return response({code:0,data});
 }});
 const s=await c.snapshot();assert.deepEqual(s.rows.map(x=>x.state),['offline','unknown']);assert.ok(s.rows.every(x=>x.sourceAt===null));
});
test('connector rejects non-read endpoints and ride periods over 31 days',async()=>{
 const c=new BoltClient({credentials,fetchFn:async()=>{throw Error('network must not run');}});
 await assert.rejects(c.call('deleteDriver'),/non autorisé/);
 await assert.rejects(c.rides(1,'2026-01-01T00:00:00Z','2026-03-01T00:00:00Z'),/31 jours/);
});
test('the selected Bolt vehicle is distinguished from a vehicle actually reported by the online feed',async()=>{
 const c=new BoltClient({credentials,now:()=>Date.parse('2026-10-30T12:00:00Z'),fetchFn:async url=>{
  if(url.endsWith('/token'))return response({access_token:'TOKEN'});
  const endpoint=url.split('/').pop(),data={
   getCompanies:{companies:[{company_id:1}]},
   getDrivers:{drivers:[
    {uuid:'offline',display_name:'Synthetic Offline',is_online:false,vehicles:{selected:{registration_number:'OLD-CAR'}}},
    {uuid:'live',display_name:'Synthetic Live',is_online:true,vehicles:{selected:{registration_number:'OLD-CAR'}}},
    {uuid:'fallback',display_name:'Synthetic Fallback',is_online:true,vehicles:{selected:{registration_number:'SELECTED-CAR'}}}
   ],total_rows:3},
   getOnlineDrivers:{drivers:[
    {uuid:'live',current_state:{code:'on_ride'},vehicle:{registration_number:'CURRENT-CAR'}},
    {uuid:'fallback',current_state:{code:'waiting'},vehicle:{}},
    {uuid:'new-live',current_state:{code:'waiting'},vehicle:{registration_number:'NEW-CAR'}}
   ]},getVehicles:{vehicles:[],total_rows:0}
  }[endpoint];return response({code:0,data});
 }});
 const {rows}=await c.snapshot(),byId=Object.fromEntries(rows.map(r=>[r.sourceId,r]));
 assert.equal(byId.offline.state,'offline');assert.equal(byId.offline.vehicleLabel,'OLD-CAR');assert.equal(byId.offline.evidence.vehicle_origin,'bolt_selected');
 assert.equal(byId.live.vehicleLabel,'CURRENT-CAR');assert.equal(byId.live.evidence.vehicle_origin,'bolt_live');
 assert.equal(byId.fallback.evidence.vehicle_origin,'bolt_selected');assert.equal(byId['new-live'].evidence.vehicle_origin,'bolt_live');
 const trusted=row=>trustedVehicleObservation({source:'bolt',status:row.state,vehicle_label:row.vehicleLabel,evidence:row.evidence});
 assert.equal(trusted(byId.offline),false);assert.equal(trusted(byId.fallback),false);assert.equal(trusted(byId.live),true);assert.equal(trusted(byId['new-live']),true);
});

function pagingClient(getPage){
 const requests=[];
 const client=new BoltClient({credentials,fetchFn:async(url,opt)=>{
  if(url.endsWith('/token'))return response({access_token:'TOKEN'});
  const body=JSON.parse(opt.body),endpoint=url.split('/').pop();requests.push({endpoint,body});
  return response({code:0,data:getPage(endpoint,body,requests.length)});
 }});
 return {client,requests};
}
test('a short Bolt page continues to its declared total using the number actually received',async()=>{
 const {client,requests}=pagingClient((endpoint,body)=>({drivers:body.offset===0?[{uuid:'a'},{uuid:'b'}]:body.offset===2?[{uuid:'c'}]:[{uuid:'d'}],total_rows:4}));
 const rows=await client.pages('getDrivers',{company_id:1},'drivers');assert.deepEqual(rows.map(x=>x.uuid),['a','b','c','d']);
 assert.deepEqual(requests.map(x=>x.body.offset),[0,2,3]);assert.ok(requests.every(x=>x.body.limit===1000));
});
test('missing totals, changing totals, premature empty pages and repeated identities reject the whole paginated read',async()=>{
 const cases=[
  ()=>({drivers:[{uuid:'a'}]}),()=>({drivers:[{uuid:'a'}],total_rows:'1'}),()=>({drivers:[],total_rows:-1}),
  ()=>({drivers:[],total_rows:0.5}),()=>({drivers:[],total_rows:100001}),()=>({drivers:[{}],total_rows:1}),
  ()=>({drivers:[{uuid:'a'},{uuid:'a'}],total_rows:2}),()=>({drivers:[{uuid:'a'},{uuid:'b'}],total_rows:1}),
  (ep,b)=>({drivers:b.offset===0?[{uuid:'a'}]:[],total_rows:2}),
  (ep,b)=>({drivers:[{uuid:b.offset===0?'a':'b'}],total_rows:b.offset===0?2:3}),
  ()=>({drivers:[{uuid:'repeated'}],total_rows:2})
 ];
 for(const fixture of cases){const {client,requests}=pagingClient(fixture);await assert.rejects(client.pages('getDrivers',{company_id:1},'drivers'),/incomplète ou incohérente/);assert.ok(requests.length<=2);}
});
test('pagination respects its request cap and a spent deadline cannot start a new provider request',async()=>{
 const {client,requests}=pagingClient((ep,b)=>({drivers:[{uuid:'item-'+b.offset}],total_rows:101}));
 await assert.rejects(client.pages('getDrivers',{company_id:1},'drivers'),/Pagination Bolt trop longue/);assert.equal(requests.length,100);
 const before=requests.length;await assert.rejects(client.pageSet('getDrivers',{company_id:1},'drivers','total_rows',performance.now()-1),/Délai de lecture/);assert.equal(requests.length,before);
});
test('ride pagination uses order references and rejects replayed orders instead of silently duplicating them',async()=>{
 const {client}=pagingClient(()=>({orders:[{order_reference:'same-order'}],total:2}));
 await assert.rejects(client.rides(1,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z'),/incomplète ou incohérente/);
});
test('performance ride reads apply validated UUID filters and stop at the declared row ceiling',async()=>{
 const id='497f6eca-6276-4993-bfeb-53cbbbba6f08',{client,requests}=pagingClient(()=>({orders:[],total:25000}));
 await assert.rejects(client.rides(1,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',{driverUuids:[id,id],maxRows:20000}),e=>e.status===413);
 assert.equal(requests.length,1);assert.deepEqual(requests[0].body.driver_uuids,[id]);
 await assert.rejects(client.rides(1,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',{driverUuids:['invalid']}),e=>e.status===400);
 await assert.rejects(client.rides(0,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z'),e=>e.status===400);assert.equal(requests.length,1);
});
test('ride history sends UTC whole seconds accepted by the provider validator',async()=>{
 const {client,requests}=pagingClient((endpoint,body)=>{
  assert.equal(endpoint,'getRideHistory');
  for(const field of ['start_datetime','end_datetime'])assert.match(body[field],/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  return {orders:[],total:0};
 });
 await client.rides(1,'2026-10-01T01:02:03.456+01:00','2026-10-02T00:00:00.987Z');
 assert.equal(requests[0].body.start_datetime,'2026-10-01T00:02:03Z');
 assert.equal(requests[0].body.end_datetime,'2026-10-02T00:00:00Z');
 await assert.rejects(client.rides(1,'2026-10-01T00:00:00.100Z','2026-10-01T00:00:00.900Z'),e=>e.status===400&&/seconde/.test(e.message));
 assert.equal(requests.length,1);
});
test('ride validation failures expose only recognized field names, never submitted values',async()=>{
 const c=new BoltClient({credentials,fetchFn:async url=>url.endsWith('/token')?response({access_token:'TOKEN'}):response({code:702,message:'private submitted value',validation_errors:[
  {property:'start_datetime',error:'Bad date: private submitted value'},
  {property:'start_datetime',error:'Repeated'},
  {property:'end_datetime',error:'Bad date'},
  {property:'private-driver-identifier',error:'private payload'}
 ]})});
 await assert.rejects(c.call('getRideHistory',{}),e=>e.status===502&&/702/.test(e.message)&&/start_datetime, end_datetime/.test(e.message)&&!e.message.includes('private'));
});
function snapshotClient(change=()=>{},clock=()=>Date.parse('2026-10-30T12:00:00Z')){
 const calls=[],client=new BoltClient({credentials,now:clock,fetchFn:async(url,opt)=>{
  if(url.endsWith('/token'))return response({access_token:'TOKEN'});
  const endpoint=url.split('/').pop(),body=opt.body?JSON.parse(opt.body):undefined;calls.push({endpoint,body});
  const data={getCompanies:{companies:[{company_id:1,status_code:'active'}]},
   getDrivers:{drivers:[{uuid:'a',display_name:'Synthetic A',status:'active',is_online:false},{uuid:'b',display_name:'Synthetic B',status:'suspended',is_online:false}],total_rows:2},
   getOnlineDrivers:{drivers:[{uuid:'new',display_name:'Synthetic New',current_state:{code:'waiting'}}]},
   getVehicles:{vehicles:[{uuid:'car'}],total_rows:1}}[endpoint];
  change(endpoint,data,body);return response({code:0,data});
 }});return {client,calls};
}
test('coverage describes the unfiltered scope accessible to the API key and preserves online arrivals outside the roster',async()=>{
 const {client,calls}=snapshotClient(),snapshot=await client.snapshot();
 assert.deepEqual(snapshot.coverage,{kind:'company_roster',complete:true,scope:'api_key_companies',companies:1,drivers:3,vehicles:1,
  roster_drivers:2,online_drivers:1,online_only_drivers:1,driver_statuses:{active:1,suspended:1,deactivated:0,unknown:0},
  by_company:[{company_id:1,drivers:3,vehicles:1,online_drivers:1,online_only_drivers:1,drivers_total:2,vehicles_total:1}]});
 assert.ok(!JSON.stringify(snapshot.coverage).includes('Synthetic'));assert.equal(snapshot.rows.find(x=>x.sourceId==='new').state,'available');
 for(const {endpoint,body} of calls){if(endpoint==='getCompanies')assert.equal(body,undefined);else assert.deepEqual(Object.keys(body).sort(),endpoint==='getOnlineDrivers'?['company_id']:['company_id','limit','offset']);}
});
test('an invalid company, duplicate online identity, or advertised partial live response prevents any snapshot',async()=>{
 for(const change of [
  (ep,d)=>{if(ep==='getCompanies')d.companies.push({...d.companies[0]});},
  (ep,d)=>{if(ep==='getCompanies')d.companies[0].company_id=NaN;},
  (ep,d)=>{if(ep==='getOnlineDrivers')d.drivers.push({...d.drivers[0],current_state:{code:'on_ride'}});},
  (ep,d)=>{if(ep==='getOnlineDrivers')d.drivers.push({});},
  (ep,d)=>{if(ep==='getOnlineDrivers')d.total_rows=2;},
  (ep,d)=>{if(ep==='getOnlineDrivers')d.has_more=true;},
  (ep,d)=>{if(ep==='getOnlineDrivers')d.next_cursor='next';},
  (ep,d)=>{if(ep==='getVehicles')d.vehicles.push({...d.vehicles[0]});}
 ])await assert.rejects(snapshotClient(change).client.snapshot(),/incomplète ou incohérente/);
});
test('company scopes are retained even when the same driver UUID is present in two allowed companies',async()=>{
 const {client}=snapshotClient((ep,d)=>{if(ep==='getCompanies')d.companies.push({company_id:2,status_code:'active'});});
 const snapshot=await client.snapshot();assert.equal(snapshot.coverage.companies,2);assert.equal(snapshot.coverage.drivers,6);
 assert.deepEqual(snapshot.rows.filter(x=>x.sourceId==='a').map(x=>x.organizationId),['1','2']);
});
test('vehicle inventory latency never freshens earlier roster or online status observations',async()=>{
 let time=Date.parse('2026-10-30T12:00:00Z');const initial=time;
 const {client}=snapshotClient((ep,d)=>{if(ep==='getOnlineDrivers')time+=5000;if(ep==='getVehicles')time+=20000;},()=>time);
 const snapshot=await client.snapshot();assert.equal(snapshot.at,new Date(initial+25000).toISOString());
 assert.equal(snapshot.rows.find(x=>x.sourceId==='a').readAt,new Date(initial).toISOString());
 assert.equal(snapshot.rows.find(x=>x.sourceId==='new').readAt,new Date(initial+5000).toISOString());
});

test('live vehicle details win over the selected car and missing models use a unique catalogue identity',async()=>{
 const {client}=snapshotClient((ep,d)=>{
  if(ep==='getDrivers')Object.assign(d,{drivers:[
   {uuid:'live',is_online:true,vehicles:{selected:{registration_number:'OLD-CAR',make:'Old',model:'Selection'}}},
   {uuid:'id-only',is_online:true},{uuid:'plate-only',is_online:true},
   {uuid:'offline',is_online:false,vehicles:{selected:{uuid:'selected',registration_number:'SELECTED-CAR'}}}
  ],total_rows:4});
  if(ep==='getOnlineDrivers')d.drivers=[
   {uuid:'live',current_state:{code:'on_ride'},vehicle:{registration_number:'CURRENT-CAR',make:'Hyundai',model:'Staria'}},
   {uuid:'id-only',current_state:{code:'waiting'},vehicle:{uuid:'catalogue-car'}},
   {uuid:'plate-only',current_state:{code:'waiting'},vehicle:{registration_number:'86122-T-1'}},
   {uuid:'online-arrival',current_state:{code:'waiting'},vehicle:{registration_number:'86122 T 1',model:'Sonata'}}
  ];
  if(ep==='getVehicles')Object.assign(d,{vehicles:[
   {uuid:'catalogue-car',registration_number:'86121-T-1',make:'Hyundai',model:'Staria'},
   {uuid:'other-car',registration_number:'86122 T 1',make:'Hyundai',model:'Sonata'},
   {uuid:'selected',registration_number:'SELECTED-CAR',make:'Toyota',model:'Corolla'}
  ],total_rows:3});
 });
 const {rows}=await client.snapshot(),byId=Object.fromEntries(rows.map(r=>[r.sourceId,r]));
 assert.equal(byId.live.vehicleLabel,'CURRENT-CAR');assert.equal(byId.live.vehicleModel,'Hyundai Staria');assert.equal(byId.live.evidence.vehicle_model_origin,'vehicle_payload');
 assert.equal(byId['id-only'].vehicleLabel,'86121-T-1');assert.equal(byId['id-only'].vehicleModel,'Hyundai Staria');assert.equal(byId['id-only'].evidence.vehicle_uuid,'catalogue-car');assert.equal(byId['id-only'].evidence.vehicle_origin,'bolt_live');
 assert.equal(byId['plate-only'].vehicleModel,'Hyundai Sonata');assert.equal(byId['plate-only'].evidence.vehicle_model_origin,'vehicle_inventory');
 assert.equal(byId['online-arrival'].vehicleModel,'Hyundai Sonata');assert.equal(byId['online-arrival'].evidence.vehicle_origin,'bolt_live');
 assert.equal(byId.offline.vehicleModel,'Toyota Corolla');assert.equal(byId.offline.evidence.vehicle_origin,'bolt_selected');
 assert.equal(trustedVehicleObservation({source:'bolt',status:byId.offline.state,vehicle_label:byId.offline.vehicleLabel,evidence:byId.offline.evidence}),false);
});

test('ambiguous plates, contradictory identifiers and a model alone never select a catalogue car',async()=>{
 const {client}=snapshotClient((ep,d)=>{
  if(ep==='getDrivers')Object.assign(d,{drivers:[],total_rows:0});
  if(ep==='getOnlineDrivers')d.drivers=[
   {uuid:'ambiguous',current_state:{code:'waiting'},vehicle:{registration_number:'DUP-1'}},
   {uuid:'conflict',current_state:{code:'waiting'},vehicle:{uuid:'one',registration_number:'OTHER-1'}},
   {uuid:'unknown-id',current_state:{code:'waiting'},vehicle:{uuid:'missing',registration_number:'OTHER-1'}},
   {uuid:'conflicting-make',current_state:{code:'waiting'},vehicle:{uuid:'one',registration_number:'DUP-1',make:'Toyota'}},
   {uuid:'model-only',current_state:{code:'waiting'},vehicle:{make:'Hyundai',model:'Staria'}}
  ];
  if(ep==='getVehicles')Object.assign(d,{vehicles:[
   {uuid:'one',registration_number:'DUP-1',make:'Hyundai',model:'Staria'},
   {uuid:'two',registration_number:'DUP 1',make:'Hyundai',model:'Sonata'},
   {uuid:'three',registration_number:'OTHER-1',make:'Toyota',model:'Corolla'}
  ],total_rows:3});
 });
 const {rows}=await client.snapshot(),byId=Object.fromEntries(rows.map(r=>[r.sourceId,r]));
 for(const id of ['ambiguous','conflict','unknown-id','conflicting-make'])assert.equal(byId[id].vehicleModel,null,id);
 assert.equal(byId['model-only'].vehicleLabel,null);assert.equal(byId['model-only'].evidence.vehicle_origin,null);
 assert.equal(byId['model-only'].vehicleModel,'Hyundai Staria');
});

test('catalogue vehicle models remain company-scoped when registration numbers coincide',async()=>{
 const {client}=snapshotClient((ep,d,body)=>{
  if(ep==='getCompanies')d.companies=[{company_id:1},{company_id:2}];
  if(ep==='getDrivers')Object.assign(d,{drivers:[],total_rows:0});
  if(ep==='getOnlineDrivers')d.drivers=[{uuid:'driver-'+body.company_id,current_state:{code:'waiting'},vehicle:{registration_number:'SAME-PLATE'}}];
  if(ep==='getVehicles')Object.assign(d,{vehicles:[{uuid:'car-'+body.company_id,registration_number:'SAME-PLATE',make:'Synthetic',model:body.company_id===1?'First':'Second'}],total_rows:1});
 });
 const {rows}=await client.snapshot();assert.deepEqual(rows.map(r=>[r.organizationId,r.vehicleModel]),[['1','Synthetic First'],['2','Synthetic Second']]);
});

test('a shift change follows the live driver while the previous driver keeps only an untrusted selected car',async()=>{
 let shift='day',clock=Date.parse('2026-10-30T12:00:00Z');
 const {client}=snapshotClient((ep,d)=>{
  if(ep==='getDrivers')Object.assign(d,{drivers:['day','night'].map(uuid=>({uuid,is_online:uuid===shift,vehicles:{selected:{uuid:'shared'}}})),total_rows:2});
  if(ep==='getOnlineDrivers')d.drivers=[{uuid:shift,current_state:{code:'on_ride'},vehicle:{uuid:'shared',registration_number:'SHIFT-1'}}];
  if(ep==='getVehicles')Object.assign(d,{vehicles:[{uuid:'shared',registration_number:'SHIFT-1',make:'Hyundai',model:'Staria'}],total_rows:1});
 },()=>clock);
 const first=await client.snapshot();shift='night';clock+=60000;const next=await client.snapshot();
 const trusted=row=>trustedVehicleObservation({source:'bolt',status:row.state,vehicle_label:row.vehicleLabel,evidence:row.evidence});
 assert.deepEqual(first.rows.filter(trusted).map(r=>r.sourceId),['day']);assert.deepEqual(next.rows.filter(trusted).map(r=>r.sourceId),['night']);
 assert.equal(next.rows.find(r=>r.sourceId==='day').evidence.vehicle_origin,'bolt_selected');
 assert.ok(next.rows.every(r=>r.vehicleLabel==='SHIFT-1'&&r.vehicleModel==='Hyundai Staria'));
 assert.ok(next.rows.every(r=>Date.parse(r.readAt)===clock));assert.equal(first.rows.find(r=>r.sourceId==='day').state,'on_trip');
});
