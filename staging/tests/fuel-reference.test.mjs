import test from 'node:test';
import assert from 'node:assert/strict';
import {fuelReferenceWindow,measuredFuelReference,createFuelReferenceService} from '../server/fuel-reference.mjs';
const NOW=Date.parse('2026-11-02T13:00:00Z'),range=fuelReferenceWindow(NOW);
const row=()=>({key:'CAR',km:700,fuel_l:42,counter_at:{km:{...range},fuel_l:{...range}}});
test('reference covers seven completed Moroccan days and measures weighted litres per distance',()=>{
 assert.deepEqual(range,{from:'2026-10-26T00:00:00.000Z',to:'2026-11-02T00:00:00.000Z'});
 assert.equal(measuredFuelReference(row(),range,NOW).value,6);
 assert.equal(measuredFuelReference({...row(),km:100,fuel_l:7.01},range,NOW).value,7);
});
test('reference refuses missing, reset, undersampled and asynchronous counters or future periods',()=>{
 for(const extra of [{km:99},{km:-100},{km:Infinity},{fuel_l:0},{fuel_l:-3},{fuel_l:1000},{counter_at:{}},{counter_at:{km:range,fuel_l:{...range,to:'2026-11-01T20:00:00Z'}}}])assert.equal(measuredFuelReference({...row(),...extra},range,NOW),null);
 assert.equal(measuredFuelReference(row(),{from:range.from,to:'2026-11-03T00:00:00Z'},NOW),null);
 assert.equal(measuredFuelReference(row(),{from:range.to,to:range.to},NOW),null);
});
function fixture(){
 let at=NOW,fail=false,blocked=null,onSave=null;const calls=[],saved=[],state={id:1,status:'pending'};
 const rows=[row()];
 const vehicles=[{key:'CAR',geotab_id:'BOX',ref_l100:null,active:'OUI'},{key:'MANUAL',geotab_id:'OTHER',ref_l100:8},{key:'NO_GPS',ref_l100:null},{key:'INACTIVE',geotab_id:'NO',ref_l100:null,active:'NON'}];
 const db=async(table,options={})=>{
  if(table==='ops_fuel_reference_runs'){if(options.method==='PATCH')Object.assign(state,options.body);return [structuredClone(state)];}
  assert.equal(table,'rpc/ops_set_measured_fuel_reference');saved.push(options.body);onSave?.();return true;
 };
 const service=createFuelReferenceService({db,list:async()=>structuredClone(vehicles),now:()=>at,readReport:async input=>{calls.push(input);if(blocked)await blocked;if(fail)throw Error('Synthetic provider unavailable');return {...input,rows:structuredClone(rows)};},setTimer:()=>({unref(){}}),clearTimer(){}});
 return {service,state,calls,saved,vehicles,rows,onSave:fn=>onSave=fn,advance:ms=>at+=ms,fail:()=>fail=true,block:promise=>blocked=promise};
}
test('automatic calibration fills only missing active vehicle references and preserves its retry lease',async()=>{
 const f=fixture();await f.service.refresh();assert.equal(f.calls.length,1);assert.equal(f.calls[0].keys,'CAR');assert.equal(f.saved.length,1);assert.equal(f.saved[0].p_device,'BOX');assert.equal(f.state.status,'complete');assert.equal(f.state.applied,1);
 await f.service.refresh();assert.equal(f.calls.length,1,'no second historical read before its daily deadline');
 f.advance(86400000);await f.service.refresh();assert.equal(f.calls.length,2);
});
test('provider failure waits thirty minutes instead of looping and concurrent requests share one read',async()=>{
 const f=fixture();f.fail();await f.service.refresh();assert.equal(f.state.status,'waiting');assert.equal(f.saved.length,0);
 await f.service.refresh();assert.equal(f.calls.length,1);f.advance(1800000);await f.service.refresh();assert.equal(f.calls.length,2);
 const g=fixture();let release;g.block(new Promise(r=>release=r));const a=g.service.refresh(),b=g.service.refresh();assert.equal(a,b);release();await a;assert.equal(g.calls.length,1);
});
test('closing the service discards a late historical response',async()=>{
 const f=fixture();let release;f.block(new Promise(r=>release=r));const pending=f.service.refresh();await new Promise(r=>setImmediate(r));f.service.close();release();await pending;assert.equal(f.saved.length,0);
});

test('inactive string FALSE is excluded and closing during an RPC prevents subsequent writes',async()=>{
 const f=fixture();f.vehicles.push({key:'FALSE_CAR',geotab_id:'FALSE_BOX',ref_l100:null,active:'FALSE'});await f.service.refresh();assert.equal(f.calls[0].keys,'CAR');
 const g=fixture();g.vehicles.push({key:'SECOND',geotab_id:'BOX2',ref_l100:null});g.rows.push({...row(),key:'SECOND'});g.onSave(()=>g.service.close());await g.service.refresh();assert.equal(g.saved.length,1);assert.equal(g.state.status,'reading');
});
test('reference evidence retains counter endpoints and cannot include data after the closed day',()=>{
 const good=measuredFuelReference(row(),range,NOW);assert.deepEqual(good.counter_at,{km:range,fuel_l:range});
 const after=new Date(Date.parse(range.to)+60000).toISOString();assert.equal(measuredFuelReference({...row(),counter_at:{km:{...range,to:after},fuel_l:{...range,to:after}}},range,NOW),null);
 const short={...range,from:new Date(Date.parse(range.to)-3*86400000).toISOString()};assert.equal(measuredFuelReference({...row(),counter_at:{km:short,fuel_l:short}},short,NOW),null);
});
