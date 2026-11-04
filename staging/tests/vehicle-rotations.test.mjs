import test from 'node:test';import assert from 'node:assert/strict';
import {rotationReport,rotationLocalDay} from '../server/vehicle-rotations.mjs';
const now=Date.parse('2026-11-02T23:00:00Z'),day='2026-11-02';
const agencies=[{id:1,name:'Agence Casa',city:'Casablanca'},{id:2,name:'Agence Marrakech',city:'Marrakech'}];
const vehicles=[{key:'car',plate:'TEST-1',other_plates:'OLD-1',agency_id:1},{key:'car2',plate:'TEST-2',agency_id:2}];
const drivers=[{id:'old',ludy_driver_code:'OLD',name:'Ancien chauffeur'},{id:'new',ludy_driver_code:'NEW',name:'Nouveau chauffeur'}];
const c=(id,code,start,end=null,key='car')=>({external_id:id,client_code:code,vehicle_key:key,effective_start_at:start,end_at:end,observed_at:'2026-11-02T22:50:00Z',provider_updated_at:'2026-11-02T22:45:00Z',deleted:false});
const report=(contracts,options={})=>rotationReport({contracts,agencies,vehicles,drivers,from:day,to:day,now,historyStatus:{status:'healthy',last_success_at:'2026-11-02T22:50:00Z'},...options});
test('actual return to next actual departure measures minutes, agency, city and Moroccan shift',()=>{
 const r=report([c('a','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z'),c('b','NEW','2026-11-02T18:25:00Z')]);
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].minutes,25);assert.equal(r.rows[0].status,'measured');assert.equal(r.rows[0].city,'Casablanca');assert.equal(r.rows[0].shift,'Nuit');assert.equal(r.summary.mean_minutes,25);assert.equal(r.batches[0].rotation_minutes,25);assert.equal(r.batches[0].complete,true);
});
test('a missing return remains unknown, never zero, and scheduled dates are ignored',()=>{
 const r=report([{...c('a','OLD','2026-11-02T06:00:00Z'),end_due_at:'2026-11-02T18:00:00Z'},c('b','NEW','2026-11-02T18:25:00Z')]);
 assert.equal(r.rows[0].status,'unknown');assert.equal(r.rows[0].minutes,null);assert.equal(r.summary.mean_minutes,null);assert.equal(r.batches[0].complete,false);
});
test('eight vehicle batch spans first return to last departure and stays pending until every measured restart',()=>{
 const cars=Array.from({length:8},(_,i)=>({key:'car'+i,plate:'TEST-'+i,agency_id:1}));
 const contracts=cars.flatMap((v,i)=>[c('old'+i,'OLD','2026-11-02T06:00:00Z',new Date(Date.parse('2026-11-02T18:00:00Z')+i*60000).toISOString(),v.key),...(i<7?[c('new'+i,'NEW',new Date(Date.parse('2026-11-02T18:30:00Z')+i*60000).toISOString(),null,v.key)]:[])]);
 let r=report(contracts,{vehicles:cars});assert.equal(r.batches[0].total_vehicles,8);assert.equal(r.batches[0].departed,7);assert.equal(r.batches[0].pending,1);assert.equal(r.batches[0].rotation_minutes,null);assert.equal(r.summary.mean_minutes,30);
 r=report([...contracts,c('new7','NEW','2026-11-02T18:50:00Z',null,'car7')],{vehicles:cars});assert.equal(r.batches[0].rotation_minutes,50);assert.equal(r.batches[0].complete,true);assert.equal(r.summary.mean_minutes,31.6);
});
test('agencies and cities retain separate measured averages and unknown city is explicit',()=>{
 const r=report([c('a','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z'),c('b','NEW','2026-11-02T18:25:00Z'),c('x','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z','car2'),c('y','NEW','2026-11-02T19:00:00Z',null,'car2')]);
 assert.equal(r.agencies.find(a=>a.agency_id===1).mean_minutes,25);assert.equal(r.agencies.find(a=>a.agency_id===2).mean_minutes,60);assert.equal(r.summary.mean_minutes,42.5);
 const missing=report([c('a','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z')],{agencies:[{id:1,name:'Nom sans ville'}]});assert.equal(missing.rows[0].city,'Ville non renseignée');assert.ok(missing.warnings.some(x=>x.includes('ville')));
});
test('repeated vehicle returns in one shift never inflate departed vehicle counts',()=>{
 const r=report([c('a','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z'),c('b','NEW','2026-11-02T18:10:00Z','2026-11-02T19:00:00Z'),c('c','OLD','2026-11-02T19:20:00Z')]);
 assert.equal(r.summary.measured_count,2);assert.equal(r.summary.mean_minutes,15);
 const batch=r.batches[0];assert.equal(batch.total_vehicles,1);assert.equal(batch.returned,1);assert.equal(batch.departed,0);assert.equal(batch.uncertain,1);assert.equal(batch.complete,false);assert.equal(batch.rotation_minutes,null);assert.match(batch.coverage_note,/Plusieurs retours/);assert.ok(r.warnings.some(text=>text.includes('même véhicule')));
});
test('overlapping or simultaneous contracts are excluded from measured averages',()=>{
 const r=report([c('a','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z'),c('b','NEW','2026-11-02T17:50:00Z')]);assert.equal(r.rows[0].status,'conflict');assert.equal(r.summary.mean_minutes,null);assert.equal(r.coverage.conflicts,1);
});
test('history and active copies deduplicate the same contract without losing the confirmed return',()=>{
 const old=c('a','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z');
 const r=report([old,{...old,end_at:null,observed_at:'2026-11-02T19:00:00Z',provider_updated_at:'2026-11-02T17:00:00Z'},c('b','NEW','2026-11-02T18:25:00Z')]);assert.equal(r.rows.length,1);assert.equal(r.rows[0].minutes,25);
});
function observation(identity,driver,status,at,vehicle='TEST-1'){return {identity_id:identity,driver_id:driver,source:'uber',status,observed_at:at,vehicle_label:vehicle,evidence:{method:'visible_dom'}};}
test('two explicit connection transitions may estimate a handover but never enter the measured average',()=>{
 const observations=[observation('old-i','old','available','2026-11-02T17:59:45Z'),observation('old-i','old','offline','2026-11-02T18:00:00Z'),observation('new-i','new','offline','2026-11-02T18:24:45Z'),observation('new-i','new','available','2026-11-02T18:25:00Z')];
 const contracts=[c('a','OLD','2026-11-02T06:00:00Z'),c('b','NEW','2026-11-02T18:25:00Z')];
 const r=report(contracts,{observations});assert.equal(r.rows[0].status,'estimated');assert.equal(r.rows[0].minutes,25);assert.equal(r.summary.estimated_count,1);assert.equal(r.summary.mean_minutes,null);assert.equal(r.batches[0].complete,false);
 for(const invalid of [observations.slice(1),observations.slice(0,3),observations.map(o=>({...o,vehicle_label:'unknown'})),observations.map(o=>o.status==='available'?{...o,observed_at:new Date(Date.parse(o.observed_at)-600000).toISOString()}:o)])assert.equal(report(contracts,{observations:invalid}).rows[0].status,'unknown');
 assert.equal(report(contracts,{observations,sourceEvents:[{source:'uber',status:'error',at:'2026-11-02T17:59:50Z'}]}).rows[0].status,'unknown');
 assert.equal(report(contracts,{observations:[...observations,observation('old-i','old','unknown','2026-11-02T17:59:50Z')]}).rows[0].status,'unknown');
 assert.equal(report(contracts,{observations:observations.map(o=>({...o,source:'bolt',evidence:{method:'official_api',vehicle_origin:'selected_vehicle'}}))}).rows[0].status,'unknown');
});
test('multiple possible connection handovers refuse an estimate',()=>{
 const observations=[observation('old-i','old','available','2026-11-02T17:59:45Z'),observation('old-i','old','offline','2026-11-02T18:00:00Z'),observation('new-i','new','offline','2026-11-02T18:24:45Z'),observation('new-i','new','available','2026-11-02T18:25:00Z'),observation('new-j','new','offline','2026-11-02T18:29:45Z'),observation('new-j','new','available','2026-11-02T18:30:00Z')];
 assert.equal(report([c('a','OLD','2026-11-02T06:00:00Z'),c('b','NEW','2026-11-02T18:25:00Z')],{observations}).rows[0].status,'unknown');
});
test('periods use Moroccan days across midnight and reject invalid or excessive ranges',()=>{
 assert.equal(rotationLocalDay(Date.parse('2026-11-01T23:30:00Z')),'2026-11-01');
 for(const options of [{from:'2026-02-30'},{from:'2026-09-01'},{to:'2027-01-01'},{from:'2026-11-03'}])assert.throws(()=>report([],options),e=>e.status===400);
 const r=report([c('a','OLD','2026-11-01T06:00:00Z','2026-11-01T23:30:00Z'),c('b','NEW','2026-11-01T23:50:00Z')],{from:'2026-11-01'});assert.equal(r.rows[0].minutes,20);assert.equal(r.rows[0].shift_day,'2026-11-01');
});
test('unknown vehicles and invalid actual dates are reported, without manufacturing rotations',()=>{
 const r=report([c('bad','OLD','invalid','2026-11-02T18:00:00Z'),c('future','OLD','2026-11-02T06:00:00Z','2026-11-03T18:00:00Z'),c('unknown','OLD','2026-11-02T06:00:00Z','2026-11-02T18:00:00Z','missing')]);assert.equal(r.rows.length,0);assert.equal(r.coverage.invalid_contracts,2);assert.equal(r.coverage.unknown_vehicles,1);
});
