import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createFleetApi} from '../server/fleet.mjs';

async function fixture(t){
  const root=new URL('../.local/',import.meta.url);await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(new URL('automation-test-',root).pathname);
  await fs.writeFile(dir+'/bolt.env','BOLT_CLIENT_ID=synthetic\nBOLT_CLIENT_SECRET=synthetic\n',{mode:0o600});
  let clock=Date.parse('2026-10-30T12:00:00Z'),attempts=0,commits=0,work=null;const timers=[],handlers=[];
  const tables={profiles:['admin','manager','viewer'].map(role=>({user_id:role+'-id',role})),fleet_sources:['bolt','uber','geotab','myclicar'].map(id=>({id,status:'unconnected',stale_after_s:180,metadata:{},coverage:{}})),fleet_settings:[{id:1,enabled:true,offline_threshold_s:60}],fleet_drivers:[],fleet_identities:[],fleet_latest:[],fleet_observations:[],fleet_alerts:[],fleet_source_events:[],fleet_provider_vehicles:[],fleet_myclicar_contracts:[],drivers:[],vehicles:[],contracts:[]};
  Object.assign(tables,{fleet_contract_assignment_overrides:[],params:[],fleet_disconnection_checkpoints:[],fleet_disconnection_alerts:[]});
  const fetchFn=async(url,options={})=>{
    const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421','all database access stays local');
    if(u.pathname==='/auth/v1/user'){const role=options.headers.Authorization?.slice(7);return ['admin','manager','viewer'].includes(role)?Response.json({id:role+'-id'}):Response.json({error:'Unknown synthetic session'},{status:401});}
    if(u.pathname==='/rest/v1/rpc/fleet_commit_disconnections'){
      assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer service');
      const body=JSON.parse(options.body);assert.deepEqual(body.p_alerts,[]);assert.deepEqual(body.p_changes,[]);
      tables.fleet_disconnection_checkpoints=structuredClone(body.p_states);commits++;
      return Response.json({alerts_created:0,changes_applied:0,states_saved:body.p_states.length,states_removed:0});
    }
    if(u.pathname==='/rest/v1/rpc/fleet_reconcile_vehicle_contracts')return Response.json(0);
    const table=u.pathname.split('/').pop(),rows=tables[table];assert.ok(rows,'known table '+table);
    const match=r=>[...u.searchParams].every(([k,v])=>!v.startsWith('eq.')||String(r[k])===v.slice(3));
    if(options.method==='PATCH'){const selected=rows.filter(match);selected.forEach(r=>Object.assign(r,JSON.parse(options.body)));return Response.json(selected);}
    if(options.method==='POST'){const data=JSON.parse(options.body),added=Array.isArray(data)?data:[data];rows.push(...added);return Response.json(added);}
    return Response.json(rows.filter(match));
  };
  class Bolt {async snapshot(){attempts++;if(work)return work();return {at:new Date(clock).toISOString(),rows:[],vehicles:[],companies:[]};}}
  const setTimer=(fn,delay)=>{const timer={fn,delay,cancelled:false,unref(){}};timers.push(timer);return timer;};const clearTimer=timer=>{if(timer)timer.cancelled=true;};
  const make=(options={})=>{const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',boltEnvPath:dir+'/bolt.env',connectorStatePath:dir+'/state.json',fetchFn,now:()=>clock,setTimer,clearTimer,Bolt,...options});handlers.push(handler);return handler;};
  async function call(handler,path,body={},{method='POST',token='admin'}={}){const req=Readable.from(method==='GET'?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/fleet/'+path,method,headers:{host:'127.0.0.1:4173',...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});let status,data;await handler(req,{writeHead:s=>{status=s;},end:s=>{data=JSON.parse(s);},setHeader(){}});return {status,data};}
  t.after(async()=>{handlers.forEach(h=>h.close());await fs.rm(dir,{recursive:true,force:true});});
  return {make,call,tables,dir,attempts:()=>attempts,commits:()=>commits,work:fn=>{work=fn;},pending:()=>timers.filter(x=>!x.cancelled),fire:async(delay)=>{const index=timers.findIndex(timer=>!timer.cancelled&&(delay===undefined||timer.delay===delay));assert.ok(index>=0,'requested timer is pending');const [timer]=timers.splice(index,1);clock+=timer.delay;await timer.fn();}};
}
test('Bolt retries the first failed read, follows provider backoff and makes repeated activation idempotent',async t=>{
  const f=await fixture(t),h=f.make();f.work(()=>{throw Object.assign(new Error('Quota Bolt atteint'),{status:429,retryAfter:120});});
  const first=await f.call(h,'bolt/start');assert.equal(first.status,200);assert.equal(first.data.polling,true);assert.equal(first.data.auto_resume,true);assert.equal(first.data.retrying,true);assert.equal(f.pending()[0].delay,120000);
  await f.call(h,'bolt/start');assert.equal(f.attempts(),1);assert.equal(f.pending().length,1);
  f.work(null);await f.fire();assert.equal(f.tables.fleet_sources[0].status,'healthy');assert.equal(f.pending()[0].delay,60000);
});
test('Bolt timers keep long provider deadlines without overflowing or reading early',async t=>{
 for(const seconds of [7200,3000000]){
  const f=await fixture(t),h=f.make(),delay=seconds*1000;f.work(()=>{throw Object.assign(Error('Quota Bolt atteint'),{status:429,retryAfter:seconds});});
  const first=await f.call(h,'bolt/start');assert.equal(first.data.retrying,true);assert.equal(f.attempts(),1);assert.equal(f.pending()[0].delay,Math.min(delay,2147483647));
  if(delay>2147483647){await f.fire(2147483647);assert.equal(f.attempts(),1);assert.equal(f.pending()[0].delay,delay-2147483647);}
  f.work(null);await f.fire();assert.equal(f.attempts(),2);assert.equal(f.tables.fleet_sources[0].status,'healthy');h.close();
 }
});
test('Bolt resumes after a server restart and a manual pause remains durable',async t=>{
  const f=await fixture(t);let h=f.make();await h.resume();assert.equal(f.attempts(),0);
  await f.call(h,'bolt/start');h.close();h=f.make();await h.resume();assert.equal(f.attempts(),2);
  await f.call(h,'bolt/stop');
  assert.deepEqual(f.pending().map(timer=>timer.delay),[5000],'only the independent local disconnection watcher remains');
  const commits=f.commits();await f.fire(5000);
  assert.equal(f.attempts(),2,'the local watcher never restarts Bolt or reads its provider');
  assert.equal(f.commits(),commits+1,'the surviving timer really performs local reconciliation');
  assert.deepEqual(f.pending().map(timer=>timer.delay),[5000],'Bolt has no retry or polling timer after pause');
  h.close();assert.equal(f.pending().length,0,'server shutdown cancels the local watcher too');
  h=f.make();await h.resume();assert.equal(f.attempts(),2);
  assert.deepEqual(f.pending().map(timer=>timer.delay),[5000],'restart preserves Bolt pause and restores only the local watcher');
  const resumedCommits=f.commits();await f.fire(5000);assert.equal(f.attempts(),2);assert.equal(f.commits(),resumedCommits+1);
});
test('a late Bolt response or error after pause cannot restore source health or schedule a retry',async t=>{
  for(const reject of [false,true]){
    const f=await fixture(t),h=f.make();let finish,entered;const ready=new Promise(r=>{entered=r;});
    f.work(()=>{entered();return new Promise((resolve,fail)=>{finish=()=>reject?fail(new Error('late failure')):resolve({at:'2026-10-30T12:00:00Z',rows:[],vehicles:[],companies:[]});});});
    const start=f.call(h,'bolt/start');await ready;await f.call(h,'bolt/stop');finish();const result=await start;
    assert.equal(result.data.polling,false);assert.equal(f.tables.fleet_sources[0].status,'paused');assert.equal(f.pending().length,0);
  }
});

test('a failed Geotab configuration write after pause does not lose automatic recovery',async t=>{
  const f=await fixture(t);let polling=false,starts=0;
  const service={get polling(){return polling;},start:async()=>{polling=true;starts++;return {polling};},stop:async()=>{polling=false;return {polling};},close:()=>{polling=false;},connect:async()=>{polling=false;throw Object.assign(new Error('Local write failed'),{status:502});}};
  const h=f.make({Geotab:()=>service});
  await f.call(h,'geotab/start');const failure=await f.call(h,'geotab/connect');
  assert.equal(failure.status,502);assert.equal(failure.data.error,'Local write failed');assert.equal(polling,true);assert.equal(starts,2);
  await f.call(h,'geotab/stop');await f.call(h,'geotab/connect');assert.equal(starts,2,'a saved pause is never resumed by a failing configuration write');
});

test('MyClicar preserves automatic recovery across restart and keeps manual pause durable',async t=>{
  const f=await fixture(t);let starts=0;
  const Myclicar=()=>{
    let polling=false;
    const status=async()=>({configured:true,httpConfigured:true,status:polling?'healthy':'paused',polling});
    return {get polling(){return polling;},status,connect:status,
      start:async()=>{if(!polling)starts++;polling=true;return status();},
      stop:async()=>{polling=false;return status();},close:()=>{polling=false;}};
  };
  let h=f.make({Myclicar});await h.resume();assert.equal(starts,0);
  const connected=await f.call(h,'myclicar/connect',{email:'synthetic@example.invalid'});
  assert.equal(connected.status,200);assert.equal(connected.data.auto_resume,false);assert.equal(starts,0,'validating credentials alone does not activate automatic reads');
  const active=await f.call(h,'myclicar/start');assert.equal(active.status,200);assert.equal(active.data.auto_resume,true);assert.equal(active.data.polling,true);
  assert.deepEqual(JSON.parse(await fs.readFile(f.dir+'/state.json','utf8')).enabled,{bolt:false,geotab:false,myclicar:true});
  h.close();h=f.make({Myclicar});await h.resume();assert.equal(starts,2);
  const resumed=await f.call(h,'myclicar/status',{}, {method:'GET'});assert.equal(resumed.status,200);assert.equal(resumed.data.auto_resume,true);assert.equal(resumed.data.polling,true);
  const stopped=await f.call(h,'myclicar/stop');assert.equal(stopped.status,200);assert.equal(stopped.data.auto_resume,false);assert.equal(stopped.data.polling,false);
  h.close();h=f.make({Myclicar});await h.resume();assert.equal(starts,2,'restart respects the saved pause');
  const paused=await f.call(h,'myclicar/status',{}, {method:'GET'});assert.equal(paused.data.auto_resume,false);assert.equal(paused.data.polling,false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.dir+'/state.json','utf8')).enabled,{bolt:false,geotab:false,myclicar:false});
});

test('a failed MyClicar configuration write preserves automatic recovery and a saved pause',async t=>{
  const f=await fixture(t);let polling=false,starts=0;
  const status=async()=>({configured:true,status:polling?'healthy':'paused',polling});
  const service={get polling(){return polling;},status,start:async()=>{polling=true;starts++;return status();},stop:async()=>{polling=false;return status();},close:()=>{polling=false;},connect:async()=>{polling=false;throw Object.assign(new Error('Synthetic local write failed'),{status:502});}};
  const h=f.make({Myclicar:()=>service});
  await f.call(h,'myclicar/start');const failure=await f.call(h,'myclicar/connect');
  assert.equal(failure.status,502);assert.equal(failure.data.error,'Synthetic local write failed');assert.equal(polling,true);assert.equal(starts,2);
  let saved=await f.call(h,'myclicar/status',{}, {method:'GET'});assert.equal(saved.data.auto_resume,true);assert.equal(saved.data.polling,true);
  assert.equal(JSON.parse(await fs.readFile(f.dir+'/state.json','utf8')).enabled.myclicar,true);
  await f.call(h,'myclicar/stop');const pausedFailure=await f.call(h,'myclicar/connect');
  assert.equal(pausedFailure.status,502);assert.equal(polling,false);assert.equal(starts,2,'a saved pause is not resumed by a failing configuration write');
  saved=await f.call(h,'myclicar/status',{}, {method:'GET'});assert.equal(saved.data.auto_resume,false);assert.equal(saved.data.polling,false);
  assert.equal(JSON.parse(await fs.readFile(f.dir+'/state.json','utf8')).enabled.myclicar,false);
});

test('MyClicar status and every mutation require an administrator before invoking the connector',async t=>{
  const f=await fixture(t),calls=[];
  const service=Object.fromEntries(['status','connect','start','stop'].map(action=>[action,async()=>{calls.push(action);return {configured:true,polling:false,status:'paused'};}]));
  service.close=()=>{};service.polling=false;
  const h=f.make({Myclicar:()=>service});
  for(const token of ['viewer','manager',null,'unknown'])for(const action of ['status','connect','start','stop']){
    const response=await f.call(h,'myclicar/'+action,{}, {method:action==='status'?'GET':'POST',token});
    assert.equal(response.status,token==='viewer'||token==='manager'?403:401,`${token} cannot ${action}`);
  }
  assert.deepEqual(calls,[],'denied users cannot read credentials or alter connector state');
  await assert.rejects(fs.access(f.dir+'/state.json'),{code:'ENOENT'});
  for(const action of ['status','connect','start','stop'])assert.equal((await f.call(h,'myclicar/'+action,{}, {method:action==='status'?'GET':'POST'})).status,200);
  assert.deepEqual(calls,['status','connect','start','stop']);
});
