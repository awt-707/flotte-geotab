import test from 'node:test';
import assert from 'node:assert/strict';
import {GeotabClient} from '../server/geotab.mjs';
import {historyWindow,historyTrips,historySummary,reportTotals,HISTORY_DAY_MS,HISTORY_REPORT_MS} from '../server/geotab-history.mjs';

const NOW=Date.parse('2026-10-30T13:12:34Z'),FROM='2026-10-30T00:00:00.000Z',TO='2026-10-30T12:00:00.000Z';
const creds={database:'test',userName:'test@example.invalid',password:'private-test-password'};
const response=result=>new Response(JSON.stringify({result}));
function fixture(hook) {
  const calls=[];
  const client=new GeotabClient({credentials:async()=>creds,now:()=>NOW,fetchFn:async(_url,options)=>{
    const body=JSON.parse(options.body);assert.equal(options.redirect,'error');
    if(body.method==='Authenticate')return response({path:'ThisServer',credentials:{sessionId:'TEST-SESSION'}});
    assert.ok(!options.body.includes(creds.password));calls.push(body);
    const intercepted=hook?.(body);if(intercepted)return intercepted;
    if(body.method==='GetRoadMaxSpeeds')return response({['2026-10-30T11:40:00Z']:80});
    assert.equal(body.method,'ExecuteMultiCall');assert.ok(body.params.calls.length<=50);
    return response(body.params.calls.map(({params:p})=>{
      const id=p.search.deviceSearch.id,from=p.search.fromDate,to=p.search.toDate;
      if(p.typeName==='Trip')return [{id:'trip-'+id,device:{id},start:'2026-10-30T01:00:00Z',stop:'2026-10-30T02:00:00Z',nextTripStart:'2026-10-30T03:00:00Z',distance:50,drivingDuration:'01:00:00',idlingDuration:'00:04:30',stopDuration:'01:00:00',maximumSpeed:85},
        {id:'other-trip',device:{id:'other'},start:from,stop:to,distance:9999}];
      if(p.typeName==='ExceptionEvent')return [{id:'event-'+id,device:{id},rule:{id:'RuleHarshBrakingId'},activeFrom:'2026-10-30T01:20:00Z',activeTo:'2026-10-30T01:20:01Z',duration:'00:00:00.500',distance:0.01}];
      if(p.typeName==='LogRecord')return [{id:'fix-'+id,device:{id},dateTime:from,latitude:33,longitude:-7,speed:25},{device:{id},dateTime:to,latitude:33.01,longitude:-7.01,speed:0},{id:'foreign',device:{id:'other'},dateTime:from,latitude:30,longitude:-9,speed:150}];
      if(p.typeName==='StatusData'){
        const diagnostic=p.search.diagnosticSearch.id;
        if(diagnostic==='DiagnosticEngineRoadSpeedId')return [{device:{id},dateTime:from,data:40,diagnostic:{id:diagnostic}}];
        const baseline=from===FROM,values={DiagnosticOdometerId:baseline?100000:150000,DiagnosticDeviceTotalFuelId:baseline?100:105,DiagnosticDeviceTotalIdleFuelId:baseline?10:10.5};
        return [{device:{id},diagnostic:{id:diagnostic},dateTime:from,data:values[diagnostic]}];
      }
      return [];
    }));
  }});
  return {client,calls};
}

test('period windows are bounded, respect 25-hour local days and stabilize current-day snapshots',()=>{
  assert.deepEqual(historyWindow({from:FROM,to:'2026-10-31T00:00:00Z'},HISTORY_DAY_MS,NOW),{from:FROM,to:'2026-10-30T13:12:00.000Z'});
  for(const input of [{from:'wrong',to:TO},{from:TO,to:FROM},{from:'2026-07-01T00:00:00Z',to:'2026-07-02T00:00:00Z'},{from:FROM,to:'2026-11-01T00:00:00Z'}])assert.throws(()=>historyWindow(input,HISTORY_DAY_MS,NOW),e=>e.status===400);
  assert.equal(Date.parse(historyWindow({from:'2026-10-29T00:00:00Z',to:'2026-10-30T01:00:00Z'},HISTORY_DAY_MS,NOW).to)-Date.parse('2026-10-29T00:00:00Z'),25*3600000);
});

test('history combines measured counter deltas, scoped trips, observed GPS and fractional driving events',async()=>{
  const {client,calls}=fixture();const result=await client.history('b1',{from:FROM,to:TO});
  assert.equal(result.trips.length,1);assert.equal(result.trips[0].distance_km,50);assert.equal(result.gps.length,2);assert.equal(result.gps_interpolated,1);
  assert.deepEqual([result.summary.km,result.summary.fuel_l,result.summary.idle_l,result.summary.l100,result.summary.drive_min,result.summary.idle_min],[50,5,0.5,10,60,4.5]);
  assert.equal(result.events[0].dur_min,0.5/60);assert.equal(result.summary.events,1);assert.equal(result.status,'complete');
  assert.ok(calls.every(c=>c.params.calls.every(x=>x.params.search.deviceSearch.id==='b1')));
  assert.equal(JSON.stringify(result).includes('private-test-password'),false);
});

test('missing permissions remain explicit while available history and counters remain useful',async()=>{
  const {client}=fixture(body=>body.params.calls?.[0].params.typeName==='Trip'?new Response(JSON.stringify({error:{data:{type:'SecurityException'},message:creds.password}})):null);
  const result=await client.history('b1',{from:FROM,to:TO});
  assert.equal(result.coverage.trips,'unavailable');assert.equal(result.summary.trips,null);assert.equal(result.summary.drive_min,null);assert.equal(result.summary.km,50);assert.equal(result.status,'partial');
  assert.ok(!JSON.stringify(result).includes(creds.password));
});

test('full result pages and quota failures reject an incomplete history instead of reporting empty success',async()=>{
  for(const limit of [2000,5000,20000]) {
    const {client}=fixture(body=>body.params.calls?.[0].params.resultsLimit===limit?response([Array(limit).fill({})]):null);
    await assert.rejects(client.history('b1',{from:FROM,to:TO}),/incomplet/);
  }
  const {client}=fixture(()=>new Response('{}',{status:429,headers:{'retry-after':'30'}}));
  await assert.rejects(client.history('b1',{from:FROM,to:TO}),e=>e.kind==='quota'&&e.status===429);
});

test('reports reject unbounded periods or vehicle counts before any external request',async()=>{
  const {client,calls}=fixture();
  await assert.rejects(client.report(Array.from({length:26},(_,i)=>'b'+i),{from:FROM,to:TO}),e=>e.status===400);
  await assert.rejects(client.history('b1',{from:'2026-10-27T00:00:00Z',to:TO}),e=>e.status===400);
  await assert.rejects(client.detail('b1',{from:FROM,to:TO}),e=>e.status===400);
  assert.equal(calls.length,0);
  const rows=await client.report(['b1','b2'],{from:FROM,to:TO});assert.equal(rows.length,2);assert.equal(rows[1].summary.events,1);
});

test('details expose bounded GPS, sensor speed and optional road limits without arbitrary API calls',async()=>{
  const {client,calls}=fixture();const from='2026-10-30T11:30:00Z';
  const result=await client.detail('b1',{from,to:TO});
  assert.equal(result.speed[0][1],40);assert.equal(result.gps.length,2);assert.deepEqual(result.road,[[Date.parse('2026-10-30T11:40:00Z'),80]]);
  assert.equal(calls.filter(c=>c.method==='GetRoadMaxSpeeds').length,1);
  const denied=fixture(body=>body.method==='GetRoadMaxSpeeds'?new Response('{}',{status:403}):null);
  const partial=await denied.client.detail('b1',{from,to:TO});assert.equal(partial.road,null);assert.equal(partial.coverage.road,'unavailable');assert.equal(partial.gps.length,2);
});

test('boundary-crossing trip measures are not silently prorated or counted as exact period totals',()=>{
  const trips=historyTrips([{id:'cross',device:{id:'b1'},start:'2026-10-29T23:30:00Z',stop:'2026-10-30T01:00:00Z',nextTripStart:'2026-10-30T02:00:00Z',distance:100,drivingDuration:'01:30:00',idlingDuration:'00:30:00'}],'b1',FROM,TO);
  const row=historySummary(trips,[],{km:50,fuel_l:5,idle_l:null},{trips:'complete',events:'complete'},FROM,TO);
  assert.equal(trips[0].distance_km,100);assert.equal(trips[0].partial,true);assert.equal(row.km,50);assert.equal(row.drive_min,null);assert.equal(row.idle_min,null);
  const totals=reportTotals([row,{...row,km:null}]);assert.equal(totals.km,null);assert.equal(totals.fuel_l,10);assert.equal(totals.l100,null);
});

test('a fully retrieved report remains partial when trip boundaries prevent complete duration metrics',async()=>{
  const {client}=fixture(body=>body.params.calls?.[0].params.typeName==='Trip'?response([[{id:'boundary',device:{id:'b1'},start:'2026-10-29T23:30:00Z',stop:'2026-10-30T01:00:00Z',nextTripStart:'2026-10-30T02:00:00Z',distance:100,drivingDuration:'01:30:00',idlingDuration:'00:30:00'}]]):null);
  const [row]=await client.report(['b1'],{from:FROM,to:TO});
  assert.equal(row.coverage.trips,'complete','retrieval itself is complete');
  assert.equal(row.summary.drive_min,null);assert.equal(row.status,'partial');assert.ok(row.warnings.some(w=>w.includes('chevauchent')));
});
