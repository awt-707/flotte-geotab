import test from 'node:test';import assert from 'node:assert/strict';import {createFuelCoach} from '../server/fuel-coach.mjs';
const epoch=Date.parse('2026-11-02T10:00:00Z'),iso=n=>new Date(n).toISOString();
function fixture(){let now=epoch,writeFail=false,notifyFail=false,missing=false;
 const tables={ops_fuel_settings:[{id:1,enabled:true,excess_pct:30,min_distance_km:10,cooldown_minutes:60}],vehicles:[{key:'car',plate:'SYNTHETIC',agency_id:1,geotab_id:'box',ref_l100:5}],fleet_drivers:[{id:'driver-a',ludy_driver_code:'A',vehicle_key:'car',agency_id:1,vehicle_link_method:'manual'}],fleet_sources:[],fleet_latest:[],ops_fuel_checkpoints:[]},notifications=new Map(),calls=[];
 const db=async(table,options={})=>{if(table!=='ops_fuel_checkpoints')return structuredClone(tables[table]);calls.push({method:options.method,body:options.body});if(options.method==='POST'){if(writeFail){writeFail=false;throw Error('Synthetic checkpoint failure');}const row=structuredClone(options.body),index=tables[table].findIndex(r=>r.vehicle_key===row.vehicle_key);if(index<0)tables[table].push(row);else tables[table][index]=row;}else if(options.method==='DELETE')tables[table]=tables[table].filter(r=>'eq.'+r.vehicle_key!==options.params.vehicle_key);return [];};
 const notify=async event=>{if(missing)return {delivered:false,reason:'no_active_account'};const duplicate=notifications.has(event.eventKey);if(!duplicate)notifications.set(event.eventKey,structuredClone(event));if(notifyFail){notifyFail=false;throw Error('Synthetic response lost after notification commit');}return {delivered:!duplicate,duplicate};};
 const coach=createFuelCoach({db,list:async table=>structuredClone(tables[table]),notify,now:()=>now});
 const update=async(step,extra={})=>{now=epoch+step*30000;return coach.update([{key:'car',id:'box',at:iso(now),odometer_m:100000+step*500,total_fuel_l:100+step*.05,counter_at:{odometer_m:iso(now),total_fuel_l:iso(now)},...extra}]);};
 return {coach,tables,notifications,calls,update,failWrite:()=>writeFail=true,failNotify:()=>notifyFail=true,missing:value=>missing=value};
}
test('measurement window is attributed only to the current confirmed chauffeur and resets on a handover',async()=>{
 const f=fixture();for(let i=0;i<=19;i++)await f.update(i);assert.equal(f.notifications.size,0);
 Object.assign(f.tables.fleet_drivers[0],{id:'driver-b',ludy_driver_code:'B'});await f.update(20);assert.equal(f.notifications.size,0);
 for(let i=21;i<=40;i++)await f.update(i);assert.equal(f.notifications.size,1);const event=[...f.notifications.values()][0];assert.equal(event.driverCode,'B');assert.equal(event.evidence.driver_id,'driver-b');assert.equal(event.evidence.from_at,iso(epoch+20*30000));assert.equal(event.evidence.distance_km,10);
});
test('checkpoint or notification response failures retry the same event without duplicate delivery',async()=>{
 for(const fail of ['failWrite','failNotify']){const f=fixture();for(let i=0;i<20;i++)await f.update(i);f[fail]();await assert.rejects(f.update(20));assert.equal(f.notifications.size,1);assert.match(f.coach.status().error,/interrompues/);await f.update(21);assert.equal(f.notifications.size,1);assert.equal(f.coach.status().error,null);assert.equal(f.tables.ops_fuel_checkpoints[0].state.from_at,iso(epoch+21*30000));}
});
test('unassigned or incoherent telemetry clears the previous window and cannot blame a stale driver',async()=>{
 const f=fixture();for(let i=0;i<=19;i++)await f.update(i);f.tables.fleet_drivers=[];await f.update(20);assert.equal(f.tables.ops_fuel_checkpoints.length,0);assert.equal(f.notifications.size,0);assert.equal(f.coach.status().unassigned,1);
 f.tables.fleet_drivers=[{id:'fresh',ludy_driver_code:'NEW',vehicle_key:'car',agency_id:1,vehicle_link_method:'manual'}];await f.update(21);assert.equal(f.notifications.size,0);
 await f.update(22,{id:'other-device'});assert.equal(f.tables.ops_fuel_checkpoints.length,0);assert.equal(f.notifications.size,0);
});
test('missing chauffeur accounts do not consume a notification cooldown',async()=>{
 const f=fixture();f.missing(true);for(let i=0;i<=20;i++)await f.update(i);assert.equal(f.notifications.size,0);assert.equal(f.tables.ops_fuel_checkpoints[0].state.last_notice_at,null);
 f.missing(false);for(let i=21;i<=40;i++)await f.update(i);assert.equal(f.notifications.size,1);assert.equal(f.coach.status().queued,1);
});
test('disabled notifications clear measurement checkpoints without creating personal notifications',async()=>{
 const f=fixture();await f.update(0);f.tables.ops_fuel_settings[0].enabled=false;await f.update(1);assert.equal(f.tables.ops_fuel_checkpoints.length,0);assert.equal(f.notifications.size,0);
});
