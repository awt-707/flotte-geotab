import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createGeotabService} from '../server/geotab-service.mjs';

const NOW=Date.parse('2026-10-30T13:12:34Z'),range={from:'2026-10-30T00:00:00Z',to:'2026-10-30T12:00:00Z'};
async function fixture(t) {
  const root=new URL('../.local/',import.meta.url);await fs.mkdir(root,{recursive:true,mode:0o700});
  const dir=await fs.mkdtemp(new URL('history-service-',root).pathname);let now=NOW;
  const rows={fleet_sources:[{id:'geotab',status:'paused',metadata:{}}],vehicles:[{key:'a',plate:'TEST-A',model:'Test',geotab_id:'g1'},{key:'b',plate:'TEST-B',model:'Test',geotab_id:'g2'}],live_status:[]};
  const reads=[],calls=[],hooks={};
  const list=async(table,params={},token)=>{reads.push({table,params,token});return structuredClone(rows[table].filter(row=>!token||token==='admin'||table!=='vehicles'||row.key==='a'));};
  const db=async(table,{params={},token}={})=>list(table,params,token);
  const patch=async(table,params,body)=>Object.assign(rows[table][0],body);
  const health=async(id,status,extra)=>Object.assign(rows.fleet_sources[0],{status,...extra});
  const result=(id,input)=>({id,...input,at:new Date(now).toISOString(),trips:[],events:[],gps:[],coverage:{trips:'complete',events:'complete',counters:'complete'},warnings:[],status:'complete',
    summary:{km:50,fuel_l:5,idle_l:0.5,l100:10,drive_min:60,idle_min:3,trips:1,max_speed:80,events:0,event_counts:{}}});
  class Client {
    async devices(){return [{id:'g1',name:'TEST-A'},{id:'g2',name:'TEST-B'}];}
    async history(id,input){calls.push({mode:'history',id,input});if(hooks.history)await hooks.history();return result(id,input);}
    async detail(id,input){calls.push({mode:'detail',id,input});return {...result(id,input),speed:[],road:[]};}
    async report(ids,input){calls.push({mode:'report',ids,input});return ids.map(id=>result(id,input));}
  }
  const service=createGeotabService({db,list,patch,upsert:async()=>{},health,credentialsPath:dir+'/geotab.json',Client,now:()=>now});
  await service.connect({database:'test',userName:'test@example.invalid',password:'private-test-password'});
  t.after(async()=>{service.close();await fs.rm(dir,{recursive:true,force:true});});
  return {service,rows,reads,calls,hooks,advance:ms=>{now+=ms;}};
}

test('history and reports authorize vehicles through the caller RLS before any provider reads',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.history('viewer',{key:'b',...range}),e=>e.status===404);
  await assert.rejects(f.service.report('viewer',{keys:'a,b',...range}),e=>e.status===404);
  await assert.rejects(f.service.history('',{key:'a',...range}),e=>e.status===401);
  assert.equal(f.calls.length,0);
  const history=await f.service.history('viewer',{key:'a',...range});assert.equal(history.vehicle.key,'a');assert.equal('id' in history,false);
  const report=await f.service.report('viewer',range);assert.deepEqual(report.rows.map(r=>r.key),['a']);assert.equal(report.totals.km,50);
  assert.deepEqual(f.calls.at(-1).ids,['g1']);assert.ok(f.reads.some(r=>r.table==='vehicles'&&r.token==='viewer'));
});

test('history cache coalesces screens, remains immutable and never grants a subsequently hidden vehicle',async t=>{
  const f=await fixture(t);f.hooks.history=()=>new Promise(resolve=>setImmediate(resolve));
  const [a,b]=await Promise.all([f.service.history('viewer',{key:'a',...range}),f.service.history('admin',{key:'a',...range})]);
  assert.equal(f.calls.length,1);assert.equal(a.summary.km,50);a.summary.km=999;
  const cached=await f.service.history('viewer',{key:'a',...range});assert.equal(cached.summary.km,50);assert.equal(cached.cached,true);
  f.rows.vehicles[0].active='NON';await assert.rejects(f.service.history('viewer',{key:'a',...range}),e=>e.status===404);
  assert.equal(f.calls.length,1);
});

test('current day requests share a minute end even when screens request at different seconds',async t=>{
  const f=await fixture(t),today={from:range.from,to:'2026-10-31T00:00:00Z'};
  const a=await f.service.history('viewer',{key:'a',...today});f.advance(1000);
  const b=await f.service.history('viewer',{key:'a',...today});assert.equal(f.calls.length,1);assert.equal(a.to,b.to);assert.equal(a.to,'2026-10-30T13:12:00.000Z');
});

test('detail requests are padded by three minutes and still bounded to 90 minutes',async t=>{
  const f=await fixture(t),from='2026-10-30T11:30:00Z',to='2026-10-30T11:31:00Z';
  const detail=await f.service.detail('viewer',{key:'a',from,to});
  assert.equal(detail.from,'2026-10-30T11:27:00.000Z');assert.equal(detail.to,'2026-10-30T11:34:00.000Z');
  const instant=await f.service.detail('viewer',{key:'a',from,to:from});assert.equal(instant.from,detail.from);assert.equal(instant.to,'2026-10-30T11:33:00.001Z');
  await assert.rejects(f.service.detail('viewer',{key:'a',...range}),e=>e.status===400);
});

test('changing the source while history is in flight cannot publish data from its earlier association',async t=>{
  const f=await fixture(t);let release,enter;const entered=new Promise(resolve=>{enter=resolve;});
  f.hooks.history=()=>{enter();return new Promise(resolve=>{release=resolve;});};
  const pending=f.service.history('viewer',{key:'a',...range});await entered;
  await f.service.stop();release();await assert.rejects(pending,e=>e.status===409);
});

test('historical reads stay bounded by concurrency and invalid catalogue associations fail closed',async t=>{
  const f=await fixture(t);const releases=[];let started=0,ready;const two=new Promise(resolve=>{ready=resolve;});
  f.hooks.history=()=>{if(++started===2)ready();return new Promise(resolve=>releases.push(resolve));};
  const a=f.service.history('admin',{key:'a',...range}),b=f.service.history('admin',{key:'b',...range});await two;
  await assert.rejects(f.service.report('admin',range),e=>e.status===429);
  releases.forEach(fn=>fn());await Promise.all([a,b]);
  f.rows.vehicles[0].geotab_id='wrong';await assert.rejects(f.service.history('viewer',{key:'a',...range}),e=>e.status===409);
});
