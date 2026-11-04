import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGeotabService, geotabIntervalMs } from '../server/geotab-service.mjs';

const privateRoot=new URL('../.local/',import.meta.url);
async function fixture(t,{fakeTimers=false}={}) {
  await fs.mkdir(privateRoot,{recursive:true,mode:0o700});
  const folder=await fs.mkdtemp(new URL('geotab-test-',privateRoot).pathname);
  const credentialsPath=folder+'/credentials.json';
  let clock=Date.parse('2026-10-30T12:00:00Z'),requests=0,positionsHook=null,healthHook=null,devicesHook=null;
  const rows={fleet_sources:[{id:'geotab',status:'unconnected',metadata:{}}],vehicles:[{key:'a',plate:'TEST-A',model:'Test',geotab_id:null,geotab_auto_link_disabled:false},{key:'b',plate:'TEST-B',model:'Test',geotab_id:null,geotab_auto_link_disabled:false}],live_status:[]};
  const matches=(r,params)=>Object.entries(params).every(([k,v])=>v==='is.null'?r[k]==null:!String(v).startsWith('eq.')||String(r[k])===v.slice(3));
  const list=async(table,params={},token)=>{
    assert.ok(table in rows,'only expected local tables');
    return structuredClone(rows[table].filter(r=>matches(r,params)&&(!token||token!=='manager'||(r.key||r.vehicle_key)==='a')));
  };
  const db=async(table,{params={},method='GET',token}={})=>{
    if(method==='DELETE'){rows[table]=rows[table].filter(r=>!matches(r,params));return null;}
    assert.equal(method,'GET');return list(table,params,token);
  };
  const patch=async(table,params,body)=>{for(const row of rows[table].filter(r=>matches(r,params)))Object.assign(row,body);};
  const upsert=async(table,data,key)=>{for(const row of data){const old=rows[table].find(x=>x[key]===row[key]);if(old)Object.assign(old,row);else rows[table].push({...row});}};
  const health=async(id,status,extra={})=>{assert.equal(id,'geotab');Object.assign(rows.fleet_sources[0],{status},extra);healthHook?.(status);};
  class Client {
    constructor({credentials}){this.credentials=credentials;}
    async devices(){requests++;const creds=await this.credentials();if(devicesHook)return devicesHook();if(creds.password==='rejected')throw Object.assign(new Error('Identifiants Geotab refusés'),{name:'GeotabError',status:401});return [{id:'g1',name:'Test One',plate:'TEST-A'},{id:'g2',name:'Test Two',plate:'TEST-B'}];}
    async positions(ids){requests++;if(positionsHook)return positionsHook(ids);return ids.map(id=>({id,at:new Date(clock).toISOString(),state:'Garé',speed:0,lat:33,lon:-7,ign_on:false,since_min:1}));}
  }
  const timers=[];
  const setTimer=(fn,delay)=>{const timer={fn,delay,cancelled:false,unref(){}};timers.push(timer);return timer;};
  const clearTimer=timer=>{if(timer)timer.cancelled=true;};
  const service=createGeotabService({db,list,patch,upsert,health,credentialsPath,Client,now:()=>clock,...(fakeTimers?{setTimer,clearTimer}:{})});
  t.after(async()=>{service.close();await fs.rm(folder,{recursive:true,force:true});});
  const connect=()=>service.connect({database:'testdb',userName:'staging@example.invalid',password:'fake-private-password'});
  return {service,rows,connect,credentialsPath,advance:ms=>{clock+=ms;},now:()=>clock,requestCount:()=>requests,positions:fn=>{positionsHook=fn;},devices:fn=>{devicesHook=fn;},onHealth:fn=>{healthHook=fn;},pending:()=>timers.filter(t=>!t.cancelled),fire:()=>{let timer;do{timer=timers.shift();}while(timer?.cancelled);assert.ok(timer,'a scheduled poll is expected');clock+=timer.delay;return timer.fn();}};
}

test('a closed Geotab service cannot restart provider reads or create a timer',async t=>{
  const f=await fixture(t,{fakeTimers:true});await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});await f.service.start();
  const requests=f.requestCount(),before=structuredClone(f.rows.fleet_sources[0]);f.service.close();
  for(const action of [()=>f.service.start(),()=>f.service.refresh(),()=>f.service.devices(),()=>f.service.autoAssociate()])await assert.rejects(action,error=>error.status===409);
  assert.equal(f.requestCount(),requests);assert.equal(f.pending().length,0);assert.equal(f.service.polling,false);assert.deepEqual(f.rows.fleet_sources[0],before);
});

test('closing Geotab during a connection test cannot save credentials or publish a catalogue',async t=>{
  const f=await fixture(t,{fakeTimers:true});let entered,finish;const ready=new Promise(resolve=>{entered=resolve;});
  f.devices(()=>{entered();return new Promise(resolve=>{finish=resolve;});});const connecting=f.connect();await ready;f.service.close();finish([{id:'late'}]);
  const result=await connecting;assert.equal(result.ignored,true);assert.equal(result.configured,false);assert.equal(f.rows.fleet_sources[0].status,'unconnected');assert.deepEqual(f.rows.fleet_sources[0].metadata,{});
  await assert.rejects(fs.access(f.credentialsPath),{code:'ENOENT'});assert.equal(f.pending().length,0);
});

test('a late catalogue read after stop or close preserves the last validated catalogue',async t=>{
  for(const close of [false,true]){
    const f=await fixture(t,{fakeTimers:true});await f.connect();const before=structuredClone(f.rows.fleet_sources[0].metadata);let entered,finish;const ready=new Promise(resolve=>{entered=resolve;});
    f.devices(()=>{entered();return new Promise(resolve=>{finish=resolve;});});const reading=f.service.devices();await ready;
    const stopping=close?(f.service.close(),Promise.resolve()):f.service.stop();finish([{id:'late'}]);
    const result=await reading;await stopping;assert.equal(result.ignored,true);assert.deepEqual(f.rows.fleet_sources[0].metadata,before);assert.equal(f.pending().length,0);
  }
});

test('credentials are tested before saving, private, and never returned in status',async t=>{
  const f=await fixture(t);assert.equal((await f.service.status()).configured,false);assert.equal(f.requestCount(),0);
  const status=await f.connect();assert.equal(status.configured,true);assert.equal(status.polling,false);assert.equal(status.devices.length,2);
  assert.equal(JSON.stringify(status).includes('fake-private-password'),false);assert.equal((await fs.stat(f.credentialsPath)).mode&0o077,0);
  const before=await fs.readFile(f.credentialsPath,'utf8');
  await assert.rejects(f.service.connect({database:'testdb',userName:'staging@example.invalid',password:'rejected'}),/refusés/);
  assert.equal(await fs.readFile(f.credentialsPath,'utf8'),before);
});
test('mappings are explicit, unique and confined to the authenticated catalog',async t=>{
  const f=await fixture(t);await f.connect();assert.ok(f.rows.vehicles.every(v=>v.geotab_id===null));
  await assert.rejects(f.service.link({vehicle_key:'a',device_id:'other'}),/catalogue/);
  await f.service.link({vehicle_key:'a',device_id:'g1'});
  await assert.rejects(f.service.link({vehicle_key:'b',device_id:'g1'}),/déjà associé/);
  await assert.rejects(f.service.connect({database:'different',userName:'staging@example.invalid',password:'fake'}),/Déliez/);
  assert.equal(f.rows.vehicles[0].geotab_id,'g1');assert.equal(f.rows.vehicles[1].geotab_id,null);
});
test('automatic associations use only the local validated catalogue and keep active polling running',async t=>{
 const f=await fixture(t);await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});await f.service.start();const requests=f.requestCount();
 const result=await f.service.autoAssociate();assert.equal(result.linked,1);assert.equal(f.rows.vehicles[1].geotab_id,'g2');assert.equal(f.service.polling,true);assert.equal(f.requestCount(),requests,'matching makes no provider call');
 assert.equal((await f.service.autoAssociate()).linked,0);
});
test('manual unlink, different account catalogues and contradictory VIN evidence prevent automatic association',async t=>{
 const f=await fixture(t);await f.connect();await f.service.link({vehicle_key:'a',device_id:null});assert.equal(f.rows.vehicles[0].geotab_auto_link_disabled,true);
 f.rows.vehicles[1].vin='VIN-B';f.rows.fleet_sources[0].metadata.devices[1].vin='VIN-OTHER';const r=await f.service.autoAssociate();assert.equal(r.linked,0);assert.equal(r.conflicts,1);assert.ok(f.rows.vehicles.every(v=>v.geotab_id===null));
 f.rows.fleet_sources[0].metadata.database='another-database';assert.equal((await f.service.autoAssociate()).reason,'catalog_unavailable');
});
test('local snapshots respect source timestamps and agency access; viewing consumes no Geotab calls',async t=>{
  const f=await fixture(t);await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});await f.service.link({vehicle_key:'b',device_id:'g2'});
  await f.service.start();assert.equal(f.rows.live_status.length,2);const n=f.requestCount();
  const live=await f.service.live('manager');assert.deepEqual(live.vehicles.map(v=>v.key),['a']);assert.equal(live.vehicles[0].fresh,true);assert.equal(live.vehicles[0].speed,0);
  await f.service.live('manager');assert.equal(f.requestCount(),n);
  f.advance(180001);const stale=await f.service.live('manager');assert.equal(stale.vehicles[0].fresh,false);assert.equal(stale.vehicles[0].state,'Position ancienne');assert.equal(stale.vehicles[0].speed,null);
  await f.service.stop();assert.equal((await f.service.status()).polling,false);
});
test('stopping in-flight collection prevents delayed data and health from reviving it',async t=>{
  const f=await fixture(t);await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});
  let release,entered;const pending=new Promise(resolve=>{entered=resolve;});
  f.positions(()=>{entered();return new Promise(resolve=>{release=resolve;});});
  const start=f.service.start();await pending;await f.service.stop();release([{id:'g1',at:'2026-10-30T12:00:00Z',state:'En route',speed:20,lat:33,lon:-7}]);
  const result=await start;assert.equal(result.ignored,true);assert.equal(result.polling,false);assert.equal(f.rows.live_status.length,0);assert.equal(f.rows.fleet_sources[0].status,'paused');
});
test('changing an association pauses collection and clears the old local position',async t=>{
  const f=await fixture(t);await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});await f.service.start();
  await f.service.link({vehicle_key:'a',device_id:'g2'});assert.equal(f.rows.live_status.length,0);assert.equal((await f.service.status()).polling,false);
});
test('a stop requested while the snapshot commits still prevents start from installing its timer',async t=>{
  const f=await fixture(t);await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});
  let stopped;f.onHealth(status=>{if(status==='healthy')stopped=f.service.stop();});
  const result=await f.service.start();await stopped;
  assert.equal(result.ignored,true);assert.equal(f.service.polling,false);assert.equal(f.rows.fleet_sources[0].status,'paused');
});
test('polls start every two seconds without adding the duration of the last read',async t=>{
  const f=await fixture(t,{fakeTimers:true});await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});
  const attempts=[];f.positions(()=>{attempts.push(f.now());f.advance(1200);return [];});
  const state=await f.service.start();assert.equal(state.interval_s,2);assert.equal(state.stale_after_s,20);assert.equal(f.pending()[0].delay,800);
  await f.fire();await f.fire();
  assert.deepEqual(attempts.map(t=>t-attempts[0]),[0,2000,4000]);
  const before=f.requestCount();await f.service.start();assert.equal(f.requestCount(),before,'start on active collection does not multiply requests');
  await f.service.stop();assert.equal(f.pending().length,0);
});
test('slow reads never overlap and pause cancels their future scheduling',async t=>{
  const f=await fixture(t,{fakeTimers:true});await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});await f.service.start();
  let release,enter;const entered=new Promise(resolve=>{enter=resolve;});f.positions(()=>{enter();return new Promise(resolve=>{release=resolve;});});
  const work=f.fire();await entered;const count=f.requestCount();
  const other=f.service.refresh();assert.equal(f.requestCount(),count);assert.equal(f.pending().length,0);
  f.advance(20000);await f.service.stop();release([]);await work;await other;
  assert.equal(f.pending().length,0);assert.equal(f.service.polling,false);
});
test('provider backoff overrides the fast polling interval',async t=>{
  const f=await fixture(t,{fakeTimers:true});await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});await f.service.start();
  f.positions(()=>{throw Object.assign(new Error('Quota Geotab atteint'),{name:'GeotabError',status:429,retryAfter:120});});
  await f.fire();assert.equal(f.rows.fleet_sources[0].status,'error');assert.equal(f.pending()[0].delay,120000);assert.equal(f.service.polling,true);
});
test('Geotab timers keep long provider deadlines without overflowing or reading early',async t=>{
 for(const seconds of [7200,3000000]){
  const f=await fixture(t,{fakeTimers:true});await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});const before=f.requestCount(),delay=seconds*1000;
  f.positions(()=>{throw Object.assign(Error('Quota Geotab atteint'),{name:'GeotabError',status:429,retryAfter:seconds});});
  await f.service.start();assert.equal(f.requestCount(),before+1);assert.equal(f.pending()[0].delay,Math.min(delay,2147483647));
  if(delay>2147483647){await f.fire();assert.equal(f.requestCount(),before+1);assert.equal(f.pending()[0].delay,delay-2147483647);}
  f.positions(()=>[]);await f.fire();assert.equal(f.requestCount(),before+2);assert.equal(f.rows.fleet_sources[0].status,'healthy');await f.service.stop();
 }
});
test('an outage on the very first Geotab read keeps automatic recovery armed and a pause cancels it',async t=>{
  const f=await fixture(t,{fakeTimers:true});await f.connect();await f.service.link({vehicle_key:'a',device_id:'g1'});
  f.positions(()=>{throw Object.assign(new Error('Quota Geotab atteint'),{name:'GeotabError',status:429,retryAfter:120});});
  const start=await f.service.start();assert.equal(start.polling,true);assert.equal(start.retrying,true);assert.equal(f.pending()[0].delay,120000);
  f.positions(null);await f.fire();assert.equal(f.rows.fleet_sources[0].status,'healthy');assert.equal((await f.service.status()).retrying,false);
  await f.service.stop();assert.equal(f.pending().length,0);
});
test('large fleets retain headroom under the per-entity quota',()=>{
  assert.equal(geotabIntervalMs(11),2000);assert.equal(geotabIntervalMs(50),9000);assert.equal(geotabIntervalMs(51),9000);assert.equal(geotabIntervalMs(100),17000);
  for(let count=1;count<=100;count++)assert.ok(count*60000/geotabIntervalMs(count)<=360);
});
