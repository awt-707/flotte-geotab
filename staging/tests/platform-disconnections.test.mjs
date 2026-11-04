import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceDisconnection} from '../server/platform-disconnections.mjs';
const beginning=Date.parse('2026-10-31T20:00:00Z'),iso=ms=>new Date(ms).toISOString();
const duty={driver_id:'driver',duty_key:'duty',contract_id:'contract',contract_fingerprint:'proof',vehicle_key:'car',started_at:iso(beginning-3600000),ends_at:null,evidence:{source:'myclicar'}};
const sample=(status='on_trip',offset=0)=>({now:beginning+offset,duty,policy:'any',row:{identity_id:'identity',driver_id:'driver',source:'uber',status,observed_at:iso(beginning+offset),evidence:{}},source:{id:'uber',status:'healthy',last_success_at:iso(beginning+offset),stale_after_s:45}});
test('a fresh connection then explicit disconnection in the same service produces one provider-specific event',()=>{
 for(const status of ['available','on_trip','to_pickup','on_break']){
  const first=advanceDisconnection(null,sample(status));assert.equal(first.event,null);
  const input=sample('offline',15000),next=advanceDisconnection(first.state,input);
  assert.equal(next.event.source,'uber');assert.equal(next.event.observed_online_at,iso(beginning));assert.equal(next.event.disconnected_at,iso(beginning+15000));assert.equal(next.event.duty_key,duty.duty_key);
  assert.equal(advanceDisconnection(next.state,input).event,null);
  assert.equal(advanceDisconnection(next.state,sample('offline',30000)).event,null);
 }
});
test('initially offline, unknown, absent, stale and interrupted data cannot invent a disconnection',()=>{
 const first=advanceDisconnection(null,sample()).state;
 assert.equal(advanceDisconnection(null,sample('offline',15000)).event,null);
 assert.equal(advanceDisconnection(first,sample('unknown',15000)).state,null);
 assert.equal(advanceDisconnection(first,{...sample('offline',15000),row:null}).state,null);
 assert.equal(advanceDisconnection(first,sample('offline',46000)).event,null);
 for(const source of ['uber','myclicar'])for(const offset of [0,1000])assert.equal(advanceDisconnection(first,{...sample('offline',15000),interruptions:[{source,status:'error',at:iso(beginning+offset)}]}).event,null,'interruption at or after the online reading breaks continuity');
 for(const state of ['error','paused','stale']){const input=sample('offline',15000);input.source.status=state;assert.equal(advanceDisconnection(first,input).state,null);}
});
test('service changes, invalid timestamps, future samples and disabled accounts break the baseline',()=>{
 const first=advanceDisconnection(null,sample()).state;
 const mutations=[
  input=>input.duty=null,
  input=>input.duty={...duty,duty_key:'new-contract'},
  input=>input.duty={...duty,started_at:iso(beginning+20000)},
  input=>input.row.observed_at='invalid',
  input=>input.row.observed_at=iso(input.now+6000),
  input=>input.source.last_success_at=iso(input.now+6000),
  input=>input.row.evidence.account_status='suspended',
  input=>input.row.evidence.account_status='deactivated'
 ];
 for(const change of mutations){const input=sample('offline',15000);change(input);assert.equal(advanceDisconnection(first,input).event,null);}
 const changedPolicy=advanceDisconnection(first,{...sample('offline',15000),policy:'all'});assert.equal(changedPolicy.event,null);
});
test('an old replay cannot overwrite a newer connection, and a real reconnection permits a new incident',()=>{
 const online=advanceDisconnection(null,sample()).state;
 const offline=advanceDisconnection(online,sample('offline',10000));
 const reconnected=advanceDisconnection(offline.state,sample('available',20000));
 const old=sample('offline',10000);old.now=beginning+20000;old.source.last_success_at=iso(old.now);
 const replay=advanceDisconnection(reconnected.state,old);assert.equal(replay.event,null);assert.equal(replay.state.status,'available');
 const second=advanceDisconnection(reconnected.state,sample('offline',30000));assert.equal(second.event.disconnected_at,iso(beginning+30000));
});
