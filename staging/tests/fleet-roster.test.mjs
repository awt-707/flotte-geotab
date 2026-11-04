import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../site/fleet.js',import.meta.url),'utf8');
const now=Date.parse('2026-10-31T12:00:00Z');
const observation=(status='available',seconds=0,ttl=90)=>({status,observed_at:new Date(now-seconds*1000).toISOString(),stale_after_s:ttl});
function summary(drivers){const context=vm.createContext({Date,Map,Number,drivers,now});vm.runInContext(source,context);return JSON.parse(JSON.stringify(vm.runInContext('fleetRosterSummary(drivers,now)',context)));}
test('11 Uber and 4 Bolt with one canonical profile in common produce 14 followed profiles',()=>{
 const rows=Array.from({length:11},(_,i)=>({id:'uber-'+i,ludy_driver_code:'CODE-'+i,sources:{uber:observation()}}));
 rows[0].sources.bolt=observation();
 rows.push(...Array.from({length:3},(_,i)=>({id:'bolt-'+i,vehicle_key:null,ludy_driver_code:null,sources:{bolt:observation(i===0?'offline':i===1?'unknown':'on_trip')}})));
 rows.push({id:'old-shift',sources:{uber:observation('on_trip',86400)}});
 const result=summary(rows);assert.equal(result.recent.length,14);assert.equal(result.uber,11);assert.equal(result.bolt,4);assert.equal(result.shared,1);assert.equal(result.unlinked,3);assert.equal(result.historical.length,1);assert.equal(result.total,15);
 assert.equal(result.uber+result.bolt-result.shared,result.recent.length);
});
test('duplicate render records for a canonical profile count once while identical names alone do not merge people',()=>{
 const rows=[{id:'same',name:'Synthetic Person',sources:{uber:observation()}},{id:'same',name:'Synthetic Person',sources:{bolt:observation()}},{id:'other',name:'Synthetic Person',sources:{bolt:observation()}}];
 const before=structuredClone(rows),result=summary(rows);
 assert.equal(result.recent.length,2);assert.equal(result.uber,1);assert.equal(result.bolt,2);assert.equal(result.shared,1);assert.deepEqual(rows,before);
});
test('source ages are separate and old shifts remain available without inflating the recent union',()=>{
 const result=summary([
  {id:'both',sources:{uber:observation('unknown',46,45),bolt:observation('offline',120,150)}},
  {id:'uber-edge',sources:{uber:observation('available',45,45)}},
  {id:'old',sources:{uber:observation('available',46,45),bolt:observation('offline',151,150)}},
  {id:'never',sources:{}}
 ]);
 assert.equal(result.recent.length,2);assert.equal(result.uber,1);assert.equal(result.bolt,1);assert.equal(result.shared,0);assert.equal(result.historical.length,2);
});
test('recent unknown and offline states count without a vehicle, while invalid and future dates do not',()=>{
 const result=summary([
  {id:'offline',vehicle_key:null,sources:{bolt:observation('offline')}},
  {id:'interrupted',sources:{uber:{...observation('unknown'),stale:true}}},
  {id:'future',sources:{uber:observation('available',-6)}},
  {id:'invalid',sources:{bolt:{observed_at:'invalid'}}}
 ]);
 assert.deepEqual(result.recent.map(d=>d.id),['offline','interrupted']);assert.equal(result.historical.length,2);
});
