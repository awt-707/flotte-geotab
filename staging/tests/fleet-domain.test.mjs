import test from 'node:test';
import assert from 'node:assert/strict';
import { boltState,effectiveState,historyIntervals,nextCounters,sourceKey,validateUberBatch,inSchedule } from '../server/fleet-domain.mjs';
import { assertLocalSupabase,requestAllowed,createFleetApi } from '../server/fleet.mjs';
const T=Date.parse('2026-10-30T12:00:00Z'),iso=n=>new Date(T+n*1000).toISOString();
test('Bolt distinguishes explicit offline, missing state, waiting, break and accepted pickup',()=>{
  assert.equal(boltState({is_online:false},null),'offline');
  assert.equal(boltState({is_online:true},null),'unknown');
  assert.equal(boltState({},null),'unknown');
  assert.equal(boltState({},{current_state:{code:'waiting'}}),'available');
  assert.equal(boltState({},{current_state:{code:'on_break'}}),'on_break');
  assert.equal(boltState({},{current_state:{code:'on_ride'},current_order:{state:'driver_accepted',stops:[]}}),'to_pickup');
  assert.equal(boltState({},{current_state:{code:'on_ride'},current_order:{state:'driver_accepted',stops:[{type:'pickup',departed_at_datetime:iso(-60)}]}}),'on_trip');
});
test('no stale or paused source is represented as currently offline',()=>{
 const row={status:'offline',observed_at:iso(0)};
 assert.equal(effectiveState(row,{status:'healthy',stale_after_s:45},T+44000).status,'offline');
 assert.equal(effectiveState(row,{status:'healthy',stale_after_s:45},T+46000).status,'unknown');
 assert.equal(effectiveState(row,{status:'paused',stale_after_s:45},T+1000).status,'unknown');
});
test('offline continuity resets across source gaps and pauses; online recovery needs distinct samples',()=>{
 const p={status:'offline',observed_at:iso(0),offline_since:iso(-240),offline_samples:4,recovery_samples:0};
 assert.equal(nextCounters(p,{status:'offline',observed_at:iso(60)},150).offline_since,iso(-240));
 assert.equal(nextCounters(p,{status:'offline',observed_at:iso(160)},150).offline_since,iso(160));
 assert.equal(nextCounters({...p,offline_samples:0,offline_since:null},{status:'offline',observed_at:iso(60)},150).offline_since,iso(60));
 assert.equal(nextCounters(p,{status:'available',observed_at:iso(60)},150).recovery_samples,1);
});
test('history shows unknown gaps and ends observation at a collection interruption',()=>{
 const source=[{id:'uber',stale_after_s:45}];
 const obs=[{source:'uber',status:'offline',observed_at:iso(0)},{source:'uber',status:'available',observed_at:iso(90)}];
 const out=historyIntervals(obs,source,[{source:'uber',status:'paused',at:iso(20)}],iso(0),iso(150));
 assert.deepEqual(out.map(x=>[x.status,x.duration_s]),[['offline',20],['unknown',70],['available',45],['unknown',15]]);
 assert.ok(out.every(x=>x.estimated));
});
test('provisional name identity is scoped by organization and never joins provider UUID',()=>{
 assert.equal(sourceKey('one',null,'Ali TEST'),sourceKey('one',null,'Test Ali'));
 assert.notEqual(sourceKey('one',null,'Test Ali'),sourceKey('two',null,'Test Ali'));
 assert.notEqual(sourceKey('one','external-id','Test Ali'),sourceKey('one',null,'Test Ali'));
});
test('Uber batch omits ambiguous identities and refuses replay/unknown shape',()=>{
 const b={collectorId:'test',observedAt:iso(0),status:'observing',rows:[{name:'Test One',state:'available',readAt:iso(0),sourceId:null}]};
 assert.equal(validateUberBatch(b,T).rows[0].sourceAt,null);
 assert.equal(validateUberBatch({...b,rows:[...b.rows,...b.rows]},T).ambiguous,2);
 assert.equal(validateUberBatch({...b,rows:[...b.rows,...b.rows]},T).rows.length,0);
 assert.throws(()=>validateUberBatch(b,T+31000),/périmée/);
 assert.throws(()=>validateUberBatch({...b,rows:Array(201).fill(b.rows[0])},T),/200/);
 assert.throws(()=>validateUberBatch({...b,rows:[{...b.rows[0],state:'approved'}]},T),/invalide/);
});
test('optional schedule never interprets lack of a plan as a break reason',()=>{
 assert.equal(inSchedule(null,T),true);
 assert.equal(inSchedule({timezone:'UTC',days:[5],start:'07:00',end:'19:00'},T),true);
 assert.equal(inSchedule({timezone:'UTC',days:[4],start:'07:00',end:'19:00'},T),false);
 assert.equal(inSchedule({timezone:'UTC',days:[5],start:'19:00',end:'07:00'},T),false);
 const saturday2=Date.parse('2026-10-31T02:00:00Z');
 assert.equal(inSchedule({timezone:'UTC',days:[5],start:'19:00',end:'07:00'},saturday2),true,'Saturday morning belongs to Friday night');
 assert.equal(inSchedule({timezone:'UTC',days:[6],start:'19:00',end:'07:00'},saturday2),false);
});

test('Uber vehicle details keep their original age separately from a freshly read status',()=>{
 const row={sourceId:'driver',name:'Synthetic Shift Driver',state:'on_trip',readAt:iso(0),vehicleLabel:'86121-T-1',vehicleModel:'2026 Hyundai Staria',vehicleReadAt:iso(-100),vehicleState:'available'};
 const batch={collectorId:'screen',status:'observing',observedAt:iso(0),rows:[row],coverage:{mode:'list_sweep',observed:1,complete:true,vehicleObserved:1,vehicleComplete:true}};
 const first=validateUberBatch(batch,T);assert.equal(first.rows[0].vehicleReadAt,iso(-100));assert.equal(first.rows[0].vehicleModel,'2026 Hyundai Staria');assert.equal(first.coverage.vehicleObserved,1);
 const expired=validateUberBatch({...batch,rows:[{...row,vehicleReadAt:iso(-181)}]},T).rows[0];assert.equal(expired.state,'on_trip');assert.equal(expired.vehicleLabel,null);assert.equal(expired.vehicleReadAt,null);
 for(const changed of [{vehicleReadAt:iso(1)},{vehicleReadAt:'not-a-date'},{vehicleModel:{}},{vehicleState:'not-a-state'}])assert.throws(()=>validateUberBatch({...batch,rows:[{...row,...changed}]},T),/véhicule/);
 assert.throws(()=>validateUberBatch({...batch,coverage:{...batch.coverage,vehicleObserved:2}},T),/Couverture/);
 assert.throws(()=>validateUberBatch({...batch,coverage:{...batch.coverage,vehicleObserved:0}},T),/Couverture/);
 const legacy=validateUberBatch({...batch,rows:[{...row,vehicleReadAt:undefined,vehicleState:undefined}]},T).rows[0];assert.equal(legacy.vehicleReadAt,iso(0));assert.equal(legacy.vehicleState,'on_trip');
});
test('only explicit local Supabase target and loopback web origins accepted',()=>{
 assert.equal(assertLocalSupabase('http://127.0.0.1:57421'),'http://127.0.0.1:57421');
 for(const url of ['https://example.supabase.co','http://localhost:54321','http://127.0.0.1:57421/other','http://u:p@127.0.0.1:57421'])assert.throws(()=>assertLocalSupabase(url));
 const req={headers:{host:'127.0.0.1:4173',origin:'https://example.com'},socket:{remoteAddress:'127.0.0.1'}};
 assert.equal(requestAllowed(req),false);
 assert.equal(requestAllowed({...req,headers:{...req.headers,origin:'chrome-extension://abcdef'}},true),true);
 assert.equal(requestAllowed({...req,headers:{...req.headers,origin:'chrome-extension://abcdef'}}),false);
 assert.equal(requestAllowed({...req,headers:{host:'127.0.0.1:4173'},socket:{remoteAddress:'10.0.0.2'}},true),false);
});
test('fleet API rejects unauthenticated requests and expired pairing before processing data',async()=>{
 let calls=0;const handler=createFleetApi({supabaseUrl:'http://localhost:57421',serviceKey:'svc',anonKey:'anon',fetchFn:async()=>{calls++;throw Error('unexpected request');},now:()=>T});
 const request=async(path,token)=>{let code,body;await handler({url:path,method:'POST',headers:{host:'localhost:4173',...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}},{writeHead:(s)=>{code=s;},end:s=>{body=JSON.parse(s);}});return{code,body};};
 assert.equal((await request('/api/fleet/pair')).code,401);
 assert.equal((await request('/api/fleet/uber/ingest','ludy_uber_expired')).code,401);
 assert.equal(calls,0);handler.close();
});
