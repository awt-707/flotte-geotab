import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {validateUberBatch} from '../server/fleet-domain.mjs';
const root=new URL('../uber-extension/',import.meta.url),protocolSource=await fs.readFile(new URL('protocol.js',root),'utf8');
const contentSource=await fs.readFile(new URL('content.js',root),'utf8');
const id='11111111-1111-4111-8111-111111111111',now=Date.parse('2026-10-30T12:00:00Z');
const stamp=offset=>new Date(now+offset).toISOString();
const make=()=>({observedAt:stamp(0),sourceAt:null,organizationId:id,status:'observing',warnings:[],
  rows:Array.from({length:25},(_,i)=>({sourceId:null,name:'Synthetic Driver '+i,rawState:'Pastille #276ef1',state:'on_trip',sourceAt:null,readAt:stamp(-15000+i*500)})),
  coverage:{mode:'list_sweep',complete:true,observed:25,reason:'end_of_list'}});
function bridge(){const context=vm.createContext({URL,TextEncoder,Date});vm.runInContext(protocolSource,context);return context.LudyUberProtocol;}
test('a 25-driver sweep preserves the real reading time of each viewport across bridge and server validation',()=>{
 const data=make(),payload=bridge().payload(data,id,now),valid=validateUberBatch(payload,now);
 assert.equal(valid.rows.length,25);assert.equal(valid.coverage.complete,true);
 assert.deepEqual(valid.rows.map(r=>r.readAt),data.rows.map(r=>r.readAt));
 assert.equal(valid.rows[0].readAt,stamp(-15000));assert.equal(valid.observedAt,stamp(0));
});
test('sweeps cannot freshen old rows, accept future readings, or claim a different number of observed drivers',()=>{
 for(const change of [b=>b.rows[0].readAt=stamp(-20001),b=>b.rows[0].readAt=stamp(1),b=>b.coverage.observed=200,b=>b.coverage.complete='true',b=>b.coverage.session='private']){
  const b=make();change(b);assert.throws(()=>bridge().payload(b,id,now));assert.throws(()=>validateUberBatch({...b,collectorId:id},now));
 }
 const b=make();b.coverage.complete=false;b.coverage.reason='filtered_view';assert.equal(bridge().payload(b,id,now).coverage.complete,false);
});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function collector(){
 let listener,finish;const requests=[],ticks=new Map();
 const context=vm.createContext({AbortController,setTimeout,clearTimeout,chrome:{runtime:{id:'test',onMessage:{addListener:fn=>{listener=fn;},removeListener(){}},sendMessage:async m=>{requests.push(m);return {ok:true,data:{active:true}};}}},
  LudyUberScanner:{scan:({signal})=>new Promise(resolve=>{finish=()=>resolve(make());context.signal=signal;})},
  document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},addEventListener(){},removeEventListener(){},setInterval:fn=>{ticks.set(1,fn);return 1;},clearInterval:n=>ticks.delete(n)});
 vm.runInContext(contentSource,context);
 return {context,requests,ticks,finish:()=>finish(),command:m=>listener(m,{id:'test'},()=>{})};
}
test('stopping a sweep aborts scrolling and a late scan result is never transmitted',async()=>{
 const f=collector();f.command({type:'LUDY_UBER_START',runId:'first'});assert.equal(f.context.signal.aborted,false);
 f.command({type:'LUDY_UBER_SCAN'});f.command({type:'LUDY_UBER_STOP'});assert.equal(f.context.signal.aborted,true);
 f.finish();await flush();assert.equal(f.requests.length,0);assert.equal(f.ticks.size,0);
});
test('a running sweep is not duplicated and the same script is not installed twice',async()=>{
 const f=collector();f.command({type:'LUDY_UBER_START',runId:'first'});const abort=f.context.signal;
 f.command({type:'LUDY_UBER_SCAN'});assert.equal(f.context.signal,abort);vm.runInContext(contentSource,f.context);
 f.finish();await flush();assert.equal(f.requests.length,1);f.context.__ludyUberCollector.dispose();assert.equal(f.ticks.size,0);
});
test('refresh handshake waits for both scrolling and the local acknowledgement, then suspends new scans',async()=>{
 let listener,finish,ack,scans=0;const requests=[],ticks=new Map();
 const context=vm.createContext({AbortController,setTimeout,clearTimeout,chrome:{runtime:{id:'test',onMessage:{addListener:fn=>{listener=fn;},removeListener(){}},sendMessage:m=>{requests.push(m);return m.type==='LUDY_UBER_READ'?new Promise(resolve=>{ack=()=>resolve({ok:true,data:{active:true}});}):Promise.resolve({ok:true});}}},
 LudyUberScanner:{scan:({signal})=>{scans++;context.signal=signal;return new Promise(resolve=>{finish=()=>resolve(make());});}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},addEventListener(){},removeEventListener(){},setInterval:fn=>{ticks.set(1,fn);return 1;},clearInterval:n=>ticks.delete(n)});
 vm.runInContext(contentSource,context);const command=m=>{let reply;listener(m,{id:'test'},value=>reply=value);return reply;};
 command({type:'LUDY_UBER_START',runId:'run'});assert.equal(command({type:'LUDY_UBER_PREPARE_REFRESH',runId:'run'}).busy,true);assert.equal(context.signal.aborted,false);assert.equal(ticks.size,0);
 finish();await flush();assert.equal(requests.length,1);assert.equal(requests[0].type,'LUDY_UBER_READ');command({type:'LUDY_UBER_SCAN'});assert.equal(scans,1);
 ack();await flush();assert.equal(requests[1].type,'LUDY_UBER_REFRESH_READY');assert.equal(command({type:'LUDY_UBER_PREPARE_REFRESH',runId:'run'}).ready,true);assert.equal(scans,1);
 command({type:'LUDY_UBER_CANCEL_REFRESH',runId:'run'});assert.equal(ticks.size,1);command({type:'LUDY_UBER_STOP'});assert.equal(ticks.size,0);
});
test('a late completed sweep cannot request refresh after Stop',async()=>{
 const f=collector();f.command({type:'LUDY_UBER_START',runId:'first'});f.command({type:'LUDY_UBER_PREPARE_REFRESH',runId:'first'});f.command({type:'LUDY_UBER_STOP'});f.finish();await flush();assert.equal(f.requests.length,0);assert.equal(f.ticks.size,0);
});
test('an old injected collector requires page reload instead of installing concurrent listeners',()=>{
 const context=vm.createContext({__ludyUberCollector:{version:'0.3.0'}});assert.throws(()=>vm.runInContext(contentSource,context),/Rechargez la page/);
});

test('hiding the tab immediately sends an error and suppresses the interrupted sweep result',async()=>{
 let listener,onVisibility,finish;const sent=[];
 const document={visibilityState:'visible',addEventListener:(event,fn)=>{if(event==='visibilitychange')onVisibility=fn;},removeEventListener(){}};
 const context=vm.createContext({AbortController,document,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){},
 chrome:{runtime:{id:'test',onMessage:{addListener:fn=>{listener=fn;},removeListener(){}},sendMessage:async m=>{sent.push(m.result);return {ok:true,data:{active:true}};}}},
 LudyUberScanner:{scan:()=>document.visibilityState==='visible'?new Promise(resolve=>{finish=()=>resolve(make());}):Promise.resolve({...make(),status:'error',rows:[],coverage:{mode:'list_sweep',observed:0,complete:false,reason:'hidden'}})}});
 vm.runInContext(contentSource,context);listener({type:'LUDY_UBER_START',runId:'test'},{id:'test'},()=>{});
 document.visibilityState='hidden';onVisibility();await flush();assert.equal(sent.length,1);assert.equal(sent[0].status,'error');assert.equal(sent[0].organizationId,id);
 finish();await flush();assert.equal(sent.length,1);context.__ludyUberCollector.dispose();
});
