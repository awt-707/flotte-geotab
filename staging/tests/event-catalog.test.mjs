import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeManualEvent,createEventCatalog,eventFingerprint} from '../server/event-catalog.mjs';
const input=()=>({title:' Concert ',city:'Casablanca',place:' Rue du test ',starts_local:'2026-11-03T19:00',ends_local:'2026-11-03T21:00'});
test('manual events require an address and valid Moroccan wall times regardless of server timezone',()=>{
 const row=normalizeManualEvent(input());assert.equal(row.title,'Concert');assert.equal(row.place,'Rue du test');assert.equal(row.starts_at,'2026-11-03T19:00:00.000Z');assert.equal(row.ends_at,'2026-11-03T21:00:00.000Z');assert.equal(row.fingerprint,eventFingerprint(row));
 assert.equal(normalizeManualEvent({...input(),ends_local:''}).ends_at,null);
 for(const value of [null,[],{}, {...input(),place:' '},{...input(),title:2},{...input(),city:'Rabat'},{...input(),starts_local:'2026-02-31T12:00'},{...input(),starts_local:'2026-11-03T24:00'},{...input(),ends_local:'2026-11-03T18:00'},{...input(),place:'x'.repeat(241)},{...input(),starts_local:undefined,starts_at:'2026-11-03T19:00:00Z'}])assert.throws(()=>normalizeManualEvent(value),e=>e.status===400);
});
test('manual catalog has no startup, polling or source refresh capability',()=>{
 let calls=0;const catalog=createEventCatalog({db(){calls++;},fetchFn(){assert.fail('No external requests');},setTimer(){assert.fail('No polling');}});
 assert.equal(catalog.start,undefined);assert.equal(catalog.refresh,undefined);assert.equal(calls,0);
});
test('manual writes use atomic RPC, explicit administrator and stable creation id for retries',async()=>{
 const writes=[],id=randomUUID(),user=randomUUID(),catalog=createEventCatalog({db:async(table,args)=>{writes.push({table,...args});return {ok:true,id};}});
 await catalog.create({...input(),request_id:id,status:'rejected',source_url:'https://ignored.invalid'},user);await catalog.create({...input(),request_id:id},user);
 assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[0].table,'rpc/ops_mutate_manual_event');assert.equal(writes[0].body.p_user,user);assert.equal(writes[0].body.p_id,id);assert.equal(writes[0].body.p_row.source_url,'');assert.equal(writes[0].body.p_row.status,undefined);
 await catalog.update(id,{...input(),fingerprint:'a'.repeat(64)},user);assert.equal(writes[2].body.p_action,'update');assert.equal(writes[2].body.p_expected,'a'.repeat(64));
 await catalog.remove(id,{fingerprint:'a'.repeat(64)},user);assert.equal(writes[3].body.p_row,null);assert.equal(writes[3].body.p_action,'delete');
 const before=writes.length;await assert.rejects(catalog.create({...input(),request_id:'wrong'},user),e=>e.status===400);await assert.rejects(catalog.remove(id,{},user),e=>e.status===400);assert.equal(writes.length,before);
});
test('concurrent changes and missing events return actionable conflicts instead of silently overwriting',async()=>{
 for(const [result,status] of [[{conflict:true},409],[{missing:true},404],[{},502]]){
  const catalog=createEventCatalog({db:async()=>result});await assert.rejects(catalog.update(randomUUID(),{...input(),fingerprint:'a'.repeat(64)},randomUUID()),e=>e.status===status);
 }
});
