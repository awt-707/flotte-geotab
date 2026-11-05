import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=new URL('../uber-extension/',import.meta.url),protocol=await fs.readFile(new URL('protocol.js',root),'utf8'),background=await fs.readFile(new URL('background.js',root),'utf8');
const ORG='11111111-1111-4111-8111-111111111111',URL_UBER='https://fleethub.uber.com/orgs/'+ORG+'/livemap',ID='fixture-extension',POPUP='chrome-extension://'+ID+'/popup.html';
const token='ludy_uber_'+'x'.repeat(43);
function fixture(saved={}, {fakeTimers=false,onStore}={}){
  let clock=Date.parse('2026-10-30T12:00:00Z'),listener,response={ok:true,status:200},statusResponse,tab={id:7,url:URL_UBER,status:'complete',active:true},content={running:false,runId:null},permission=false,otherTabs=[];
  const requests=[],messages=[],events={},alarms=new Map(),injections=[],reloads=[],timeouts=new Map();let trusted=false,reloadError=null,timerId=0;
  const event=name=>({addListener:fn=>{events[name]=fn;}});
  class DateMock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const api={runtime:{id:ID,getURL:name=>'chrome-extension://'+ID+'/'+name,onMessage:{addListener:fn=>{listener=fn;}},onStartup:event('startup'),onInstalled:event('installed')},
    storage:{local:{get:async()=>structuredClone(saved),set:async value=>{await onStore?.(value);Object.assign(saved,structuredClone(value));},setAccessLevel:async value=>{trusted=value.accessLevel==='TRUSTED_CONTEXTS';}}},
    permissions:{contains:async()=>permission,onRemoved:event('permissionRemoved')},
    tabs:{query:async()=>[tab,...otherTabs].filter(Boolean),get:async id=>{if(!tab||tab.id!==id)throw Error('missing');return tab;},sendMessage:async(id,message)=>{
      messages.push(message);if(message.type==='LUDY_UBER_PING')return content;if(message.type==='LUDY_UBER_START')content={running:true,runId:message.runId,version:'0.6.8'};if(message.type==='LUDY_UBER_STOP')content={running:false,runId:null};
      if(message.type==='LUDY_UBER_PREPARE_REFRESH')return {ok:true,runId:content.runId,version:content.version,ready:content.running&&!content.busy&&!content.hidden,busy:!!content.busy};return {ok:true};
    },reload:async(id,options)=>{if(reloadError)throw reloadError;reloads.push({id,options});tab={...tab,status:'loading'};content={running:false,runId:null};},onRemoved:event('removed'),onUpdated:event('updated'),onActivated:event('activated')},
    alarms:{create:async(name,spec)=>{alarms.set(name,spec);},clear:async name=>{alarms.delete(name);},onAlarm:event('alarm')},
    scripting:{executeScript:async spec=>{injections.push(spec);}}};
  const context=vm.createContext({chrome:api,URL,TextEncoder,Date:DateMock,crypto:webcrypto,
    setTimeout:fakeTimers?(fn,delay)=>{const id=++timerId;timeouts.set(id,{fn,delay});return id;}:setTimeout,
    clearTimeout:fakeTimers?id=>timeouts.delete(id):clearTimeout,AbortController,
    fetch:async(url,options)=>{requests.push({url,options,at:clock});const result=url.endsWith('/collection-status')?statusResponse:response;if(result instanceof Error)throw result;return typeof result==='function'?result(options):result;}});
  vm.runInContext(protocol,context);vm.runInContext(background,context);
  const call=(message,sender={id:ID,url:POPUP})=>new Promise(resolve=>listener(message,sender,resolve));
  const batch=()=>({observedAt:new Date(clock).toISOString(),sourceAt:null,organizationId:ORG,status:'observing',rows:[{sourceId:null,name:'Alex Fictif',state:'available',rawState:'Disponible',readAt:new Date(clock).toISOString(),sourceAt:null}],warnings:[]});
  const read=(extra={})=>call({type:'LUDY_UBER_READ',runId:saved.connector.runId,result:{...batch(),...extra}},{id:ID,url:URL_UBER,frameId:0,tab:{id:7}});
  // Lifecycle tests let fire-and-forget browser events settle before inspecting
  // their result. Raw call(STATUS) below checks the popup's immediate response.
  const status=async()=>{await new Promise(resolve=>setImmediate(resolve));return call({type:'LUDY_UBER_STATUS'});};
  return {saved,requests,messages,events,alarms,injections,reloads,timeouts,call,read,status,batch,advance:ms=>{clock+=ms;},respond:value=>{response=value;},respondStatus:value=>{statusResponse=value;},content:value=>{content=value;},setTab:value=>{tab=value;},trusted:()=>trusted,reloadError:value=>{reloadError=value;},
    grant:value=>{permission=value;},otherTabs:value=>{otherTabs=value;},
    start:async()=>{await call({type:'LUDY_UBER_PAIR',token});return call({type:'LUDY_UBER_START'});}};
}
test('a temporary local outage retries fresh observations with backoff without stopping the page',async()=>{
  const f=fixture();await f.start();f.respond(Error('offline'));let result=await f.read();assert.equal(result.data.active,true);assert.equal(result.data.state,'retrying');
  assert.equal(f.requests.length,1);f.advance(5000);await f.read();assert.equal(f.requests.length,1,'no eager retry during cooldown');
  f.advance(10000);f.respond({ok:true,status:200});result=await f.read();assert.equal(result.data.state,'observing');assert.equal(f.requests.length,2);
  assert.notEqual(JSON.parse(f.requests[0].options.body).observedAt,JSON.parse(f.requests[1].options.body).observedAt,'do not replay old positions');
  assert.equal(result.data.nextRetryAt,null);assert.equal(f.trusted(),true);assert.ok(!JSON.stringify(result.data).includes(token));assert.ok(f.messages.every(m=>!JSON.stringify(m).includes(token)));
});
test('slow local ingestion gets twenty-five seconds and never queues a second observation',async()=>{
 const f=fixture({}, {fakeTimers:true});await f.start();let accept,entered;const sending=new Promise(resolve=>{entered=resolve;});
 f.respond(()=>{entered();return new Promise(resolve=>{accept=resolve;});});const first=f.read();await sending;
 assert.deepEqual([...f.timeouts.values()].map(timer=>timer.delay),[25000]);
 f.advance(18000);assert.equal(f.requests[0].options.signal.aborted,false);
 assert.equal((await f.read()).ok,false);assert.equal(f.requests.length,1,'no stale observation waits behind the active ingest');
 accept({ok:true,status:200,json:async()=>({ok:true,observations:1})});const state=(await first).data;
 assert.equal(state.state,'observing');assert.equal(state.lastHealthyAt,'2026-10-30T12:00:00.000Z');assert.equal(f.saved.connector.pendingUntil,0);assert.equal(f.timeouts.size,0);
 f.respond({ok:true,status:200});await f.read();assert.equal(f.requests.length,2);
 assert.equal(JSON.parse(f.requests[1].options.body).observedAt,'2026-10-30T12:00:18.000Z');
});
test('popup status responds during a hanging ingest and stop still cancels that ingest',async()=>{
 const f=fixture({}, {fakeTimers:true});await f.start();let accept,entered,snapshot,readFinished=false;
 const sending=new Promise(resolve=>{entered=resolve;});
 f.respond(()=>{entered();return new Promise(resolve=>{accept=resolve;});});
 const first=f.read().then(result=>{readFinished=true;return result;});await sending;
 const pendingStatus=f.call({type:'LUDY_UBER_STATUS'}).then(result=>{snapshot=result;return result;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(snapshot,'popup responds without resolving the ingest or advancing its deadline');
 assert.equal(snapshot.ok,true);assert.equal(snapshot.data.active,true);assert.equal(snapshot.data.paired,true);
 assert.equal(snapshot.data.lastHealthyAt,null);assert.equal(JSON.stringify(snapshot).includes(token),false);
 assert.equal(readFinished,false);assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.signal.aborted,false);
 f.respond({ok:true,status:200});const stopping=f.call({type:'LUDY_UBER_STOP'});
 assert.equal(f.requests[0].options.signal.aborted,true);await stopping;await first;await pendingStatus;
 assert.equal((await f.call({type:'LUDY_UBER_STATUS'})).data.active,false);
 accept({ok:true,status:200,json:async()=>({ok:true,observations:1})});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.saved.connector.active,false);assert.equal(f.saved.connector.lastHealthyAt,null);
});
test('immediate popup status still waits for stored initialization and excludes private pairing data',async()=>{
 let entered,release,snapshot;const loading=new Promise(resolve=>{entered=resolve;});
 const f=fixture({connector:{token,collectorId:'fixture-collector',active:false}}, {onStore:async()=>{entered();await new Promise(resolve=>{release=resolve;});}});
 const pending=f.call({type:'LUDY_UBER_STATUS'}).then(result=>{snapshot=result;return result;});
 await loading;await new Promise(resolve=>setImmediate(resolve));assert.equal(snapshot,undefined);
 release();const result=await pending;assert.equal(result.ok,true);assert.equal(result.data.paired,true);
 assert.equal(JSON.stringify(result).includes(token),false);assert.equal(JSON.stringify(result).includes('fixture-collector'),false);
});
test('popup status requires both the trusted extension sender and its exact popup URL',async()=>{
 const f=fixture();await f.start();
 for(const sender of [{id:'another-extension',url:POPUP},{id:ID,url:URL_UBER,frameId:0,tab:{id:7}},{id:ID,url:POPUP+'?other'}]){
  const result=await f.call({type:'LUDY_UBER_STATUS'},sender);
  assert.equal(result.ok,false);assert.equal(result.data,undefined);assert.equal(JSON.stringify(result).includes(token),false);
 }
 assert.equal((await f.call({type:'LUDY_UBER_STATUS'})).data.paired,true);
});
test('the local deadline releases an unresponsive fetch and only retries a fresh batch after backoff',async()=>{
 const f=fixture({}, {fakeTimers:true});await f.start();let accept,entered;const sending=new Promise(resolve=>{entered=resolve;});
 f.respond(()=>{entered();return new Promise(resolve=>{accept=resolve;});});const first=f.read();await sending;
 f.advance(25000);[...f.timeouts.values()][0].fn();const state=(await first).data;
 assert.equal(f.requests[0].options.signal.aborted,true);assert.equal(state.state,'retrying');assert.equal(state.lastHealthyAt,null);
 assert.equal(state.nextRetryAt,'2026-10-30T12:00:40.000Z');
 accept({ok:true,status:200});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.saved.connector.lastHealthyAt,null,'late success cannot revive the timed-out observation');
 f.advance(14999);await f.read();assert.equal(f.requests.length,1);
 f.advance(1);f.respond({ok:true,status:200});assert.equal((await f.read()).data.state,'observing');
 assert.equal(f.requests.length,2);assert.equal(JSON.parse(f.requests[1].options.body).observedAt,'2026-10-30T12:00:40.000Z');
});
test('worker recreation waits out an interrupted transmission without storing or replaying its rows',async()=>{
 const f=fixture({}, {fakeTimers:true});await f.start();let accept,entered;const sending=new Promise(resolve=>{entered=resolve;});
 f.respond(()=>{entered();return new Promise(resolve=>{accept=resolve;});});const first=f.read();await sending;
 const saved=structuredClone(f.saved);assert.equal(saved.connector.pendingUntil,Date.parse('2026-10-30T12:00:40Z'));assert.ok(!JSON.stringify(saved).includes('Alex Fictif'));
 const g=fixture(saved,{fakeTimers:true});await g.status();assert.equal((await g.read()).data.state,'retrying');assert.equal(g.requests.length,0);
 g.advance(39999);await g.read();assert.equal(g.requests.length,0);g.advance(1);assert.equal((await g.read()).data.state,'observing');
 assert.equal(g.requests.length,1);assert.equal(JSON.parse(g.requests[0].options.body).observedAt,'2026-10-30T12:00:40.000Z');
 accept({ok:true,status:200});await first;
});
test('stop, forget and pairing changes interrupt ingestion immediately and reject late success',async()=>{
 for(const type of ['LUDY_UBER_STOP','LUDY_UBER_FORGET','LUDY_UBER_PAIR']){
  const f=fixture({}, {fakeTimers:true});await f.start();let accept,entered;const sending=new Promise(resolve=>{entered=resolve;});
  f.respond(()=>{entered();return new Promise(resolve=>{accept=resolve;});});const first=f.read();await sending;
  f.respond({ok:true,status:200});const newToken='ludy_uber_'+'n'.repeat(43),stopping=f.call({type,token:newToken});
  assert.equal(f.requests[0].options.signal.aborted,true);await stopping;await first;
  assert.equal(f.saved.connector.active,false);assert.equal(f.saved.connector.lastHealthyAt,null);
  assert.equal(f.saved.connector.token,type==='LUDY_UBER_FORGET'?null:type==='LUDY_UBER_PAIR'?newToken:token);
  accept({ok:true,status:200});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.saved.connector.active,false);assert.equal(f.saved.connector.lastHealthyAt,null);
  if(type!=='LUDY_UBER_FORGET'){
   await f.call({type:'LUDY_UBER_START'});const count=f.requests.length;await f.read();assert.equal(f.requests.length,count,'a new run waits out any orphaned old server request');
   f.advance(40000);await f.read();assert.equal(f.requests.length,count+1);
  }
 }
});
test('hiding the tracked page cancels ingestion but immediately reports the interrupted source',async()=>{
 const f=fixture({}, {fakeTimers:true});await f.start();let accept,entered;const sending=new Promise(resolve=>{entered=resolve;});
 f.respond(()=>{entered();return new Promise(resolve=>{accept=resolve;});});const first=f.read();await sending;
 f.respond({ok:true,status:200});const hidden=f.read({status:'error',rows:[],warnings:['La Live Map est masquée.']});
 assert.equal(f.requests[0].options.signal.aborted,true);assert.equal((await hidden).data.state,'error');await first;
 assert.equal(f.requests.length,2);assert.equal(JSON.parse(f.requests[1].options.body).status,'error');assert.equal(f.saved.connector.lastHealthyAt,null);
 accept({ok:true,status:200});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.saved.connector.state,'error');
 await f.read();assert.equal(f.requests.length,2,'fresh observing reads still respect the interrupted request deadline');
});
test('cancellation during a slow storage write is handled before a fetch can begin',async()=>{
 let release,entered,blocked=false;const storing=new Promise(resolve=>{entered=resolve;});
 const f=fixture({}, {fakeTimers:true,onStore:async value=>{
  if(value.connector.pendingUntil&&!blocked){blocked=true;entered();await new Promise(resolve=>{release=resolve;});}
 }});await f.start();const first=f.read();await storing;
 const stopping=f.call({type:'LUDY_UBER_STOP'});await new Promise(resolve=>setImmediate(resolve));release();await stopping;await first;
 assert.equal(f.saved.connector.active,false);assert.equal(f.saved.connector.lastHealthyAt,null);
 assert.ok(f.requests.every(request=>JSON.parse(request.options.body).status==='stopped'),'no observing request after cancellation');
});
test('worker recreation keeps the pairing and collection; browser restart keeps only the pairing',async()=>{
  const f=fixture();await f.start();await f.read();const stored=structuredClone(f.saved),g=fixture(stored);
  assert.equal((await g.status()).data.active,true);assert.equal((await g.read()).data.state,'observing');
  g.events.startup();const state=(await g.status()).data;assert.equal(state.active,false);assert.equal(state.paired,true);assert.match(state.message,/code est conservé/);
  assert.equal((await g.call({type:'LUDY_UBER_START'})).data.active,true);
});
test('long outages cap retries and a successful read resets failures',async()=>{
  const f=fixture();await f.start();f.respond({ok:false,status:503});const delays=[];
  for(let i=0;i<9;i++){const result=await f.read();delays.push(Date.parse(result.data.nextRetryAt)-f.requests.at(-1).at);f.advance(delays.at(-1));}
  assert.deepEqual(delays,[15000,30000,60000,120000,120000,120000,120000,120000,120000]);
  f.advance(8*3600000);f.respond({ok:true,status:200});assert.equal((await f.read()).data.state,'observing');
  f.respond({ok:false,status:503});const result=await f.read();assert.equal(Date.parse(result.data.nextRetryAt)-f.requests.at(-1).at,15000);
});
test('refused pairing stops transmission and clears the token rather than retrying forever',async()=>{
  for(const status of [401,403]){
    const f=fixture();await f.start();f.respond({ok:false,status});const result=await f.read();assert.equal(result.data.active,false);assert.equal(result.data.paired,false);assert.equal(result.data.state,'pairing_required');
    const count=f.requests.length;f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.requests.length,count);assert.equal(f.saved.connector.token,null);
  }
});
test('same-page reload is recovered automatically, another fleet is never adopted',async()=>{
  const f=fixture();await f.start();await f.read();const before=f.saved.connector.runId;
  f.content({running:false,runId:null});f.events.updated(7,{status:'complete'});await f.status();assert.notEqual(f.saved.connector.runId,before);assert.equal(f.injections.length,2);
  f.events.updated(7,{url:URL_UBER.replace(ORG,'22222222-2222-4222-8222-222222222222')});const state=(await f.status()).data;assert.equal(state.active,false);assert.equal(state.paired,true);
});
test('Live Map refreshes after twenty minutes and resumes one collector without changing pairing or Reports',async()=>{
 const f=fixture();await f.start();await f.read();const identity=f.saved.connector.collectorId,originalRun=f.saved.connector.runId,healthy=f.saved.connector.lastHealthyAt;
 assert.equal(f.alarms.get('ludy-uber-map-refresh').when,Date.parse('2026-10-30T12:20:00Z'));
 f.advance(20*60000-1);f.events.alarm({name:'ludy-uber-map-refresh'});await f.status();assert.equal(f.reloads.length,0);
 f.advance(1);await f.read();f.events.alarm({name:'ludy-uber-map-refresh'});await f.status();assert.equal(f.reloads.length,1);assert.equal(f.reloads[0].id,7);assert.equal(f.saved.connector.token,token);assert.equal(f.saved.connector.collectorId,identity);
 assert.equal(f.saved.connector.lastHealthyAt,'2026-10-30T12:20:00.000Z');assert.notEqual(healthy,f.saved.connector.lastHealthyAt,'only the completed fresh scan updates source freshness');
 f.events.alarm({name:'ludy-uber-map-refresh'});f.events.updated(22,{status:'complete',url:URL_UBER.replace('/livemap','/reports')});await f.status();assert.equal(f.reloads.length,1,'Reports updates never reload the Live Map');
 f.setTab({id:7,url:URL_UBER,active:true,status:'complete'});f.events.updated(7,{status:'complete'});await f.status();assert.notEqual(f.saved.connector.runId,originalRun);assert.equal(f.injections.length,2);assert.equal(f.saved.connector.nextRefreshAt,Date.parse('2026-10-30T12:40:00Z'));
 const stale=await f.call({type:'LUDY_UBER_READ',runId:originalRun,result:f.batch()},{id:ID,url:URL_UBER,frameId:0,tab:{id:7}});assert.equal(stale.ok,false);assert.equal((await f.read()).ok,true);
 await f.call({type:'LUDY_UBER_STOP'});
});
test('refresh waits for an entire sweep and its acknowledgement before reloading, without stopping or duplicating it',async()=>{
 const f=fixture();await f.start();const runId=f.saved.connector.runId;f.content({running:true,runId,version:'0.6.8',busy:true});f.advance(20*60000);
 const stops=f.messages.filter(m=>m.type==='LUDY_UBER_STOP').length;f.events.alarm({name:'ludy-uber-map-refresh'});await f.status();assert.equal(f.reloads.length,0);assert.equal(f.saved.connector.refreshPending,true);assert.equal(f.messages.filter(m=>m.type==='LUDY_UBER_STOP').length,stops);
 await f.read();f.content({running:true,runId,version:'0.6.8',busy:false});const sender={id:ID,url:URL_UBER,frameId:0,tab:{id:7}};
 assert.equal((await f.call({type:'LUDY_UBER_REFRESH_READY',runId},sender)).ok,true);assert.equal(f.reloads.length,1);
 await f.call({type:'LUDY_UBER_REFRESH_READY',runId},sender);assert.equal(f.reloads.length,1);await f.call({type:'LUDY_UBER_STOP'});
});
test('stopping while refresh waits cancels future reloads and rejects late ready signals',async()=>{
 const f=fixture();await f.start();const runId=f.saved.connector.runId;f.content({running:true,runId,version:'0.6.8',busy:true});f.advance(20*60000);f.events.alarm({name:'ludy-uber-map-refresh'});await f.status();await f.call({type:'LUDY_UBER_STOP'});
 assert.equal((await f.call({type:'LUDY_UBER_REFRESH_READY',runId},{id:ID,url:URL_UBER,frameId:0,tab:{id:7}})).ok,false);f.events.alarm({name:'ludy-uber-map-refresh'});f.events.updated(7,{status:'complete'});await f.status();assert.equal(f.reloads.length,0);assert.equal(f.alarms.size,0);assert.equal(f.saved.connector.token,token);
});
test('hidden or changed pages are not refreshed and a failed browser reload resumes collection before retry',async()=>{
 const f=fixture();await f.start();const runId=f.saved.connector.runId;f.content({running:true,runId,version:'0.6.8',hidden:true});f.advance(20*60000);f.events.alarm({name:'ludy-uber-map-refresh'});await f.status();assert.equal(f.reloads.length,0);
 f.content({running:true,runId,version:'0.6.8'});f.reloadError(Error('browser refused'));f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.reloads.length,0);assert.equal(f.messages.at(-1).type,'LUDY_UBER_CANCEL_REFRESH');assert.equal(f.saved.connector.active,true);assert.equal(f.saved.connector.lastRefreshAt,null);
 f.reloadError(null);f.advance(60000);f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.reloads.length,1);await f.call({type:'LUDY_UBER_STOP'});
});
test('worker recreation preserves the twenty-minute schedule and a foreign tab cannot request refresh',async()=>{
 const f=fixture();await f.start();const g=fixture(structuredClone(f.saved));await g.status();g.content({running:true,runId:g.saved.connector.runId,version:'0.6.8'});
 const request={type:'LUDY_UBER_REFRESH_READY',runId:g.saved.connector.runId};assert.equal((await g.call(request,{id:ID,url:URL_UBER.replace('/livemap','/reports'),frameId:0,tab:{id:7}})).ok,false);
 g.advance(20*60000);g.events.alarm({name:'ludy-uber-map-refresh'});await g.status();assert.equal(g.reloads.length,1);assert.equal(g.saved.connector.collectorId,f.saved.connector.collectorId);await f.call({type:'LUDY_UBER_STOP'});await g.call({type:'LUDY_UBER_STOP'});
});
test('watchdog only wakes an existing reader and manual stop never restarts it',async()=>{
  const f=fixture();await f.start();await f.read();f.advance(60000);f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.injections.length,1);assert.ok(f.messages.some(m=>m.type==='LUDY_UBER_SCAN'));
  await f.call({type:'LUDY_UBER_STOP'});const before=f.injections.length;f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.injections.length,before);assert.equal(f.alarms.size,0);
});

test('quota retry deadlines are respected without replaying a stored observation',async()=>{
  const f=fixture();await f.start();f.respond({ok:false,status:429,headers:{get:()=> '90'}});
  const result=await f.read();assert.equal(Date.parse(result.data.nextRetryAt)-f.requests.at(-1).at,90000);
  f.advance(60000);await f.read();assert.equal(f.requests.length,1);f.advance(30000);f.respond({ok:true,status:200});await f.read();assert.equal(f.requests.length,2);
});

test('the content reader survives a suspended worker and a late message cannot restart a stopped reader',async()=>{
  const contentSource=await fs.readFile(new URL('content.js',root),'utf8');
  let listener,requests=0,fail=true;const timers=new Map();
  const context=vm.createContext({AbortController,LudyUberScanner:{scan:async()=>({rows:[]})},
    chrome:{runtime:{id:ID,onMessage:{addListener:fn=>{listener=fn;}},sendMessage:async()=>{requests++;if(fail)throw Error('worker starting');return {ok:true,data:{active:true}};}}},
    document:{addEventListener(){}},addEventListener(){},setTimeout,clearTimeout,setInterval:fn=>{timers.set(1,fn);return 1;},clearInterval:id=>timers.delete(id)});
  vm.runInContext(contentSource,context);
  const command=message=>listener(message,{id:ID},()=>{}),flush=()=>new Promise(resolve=>setImmediate(resolve));
  command({type:'LUDY_UBER_START',runId:'sample-run'});await flush();assert.equal(requests,1);assert.equal(timers.size,1);
  fail=false;await timers.get(1)();assert.equal(requests,2);assert.equal(timers.size,1);
  command({type:'LUDY_UBER_STOP'});command({type:'LUDY_UBER_SCAN'});await flush();assert.equal(timers.size,0);assert.equal(requests,2);
});

test('automatic browser/tab recovery requires explicit host permission and preserves the chosen fleet',async()=>{
  const f=fixture();await f.start();assert.equal((await f.call({type:'LUDY_UBER_AUTO',enabled:true})).ok,false);
  f.grant(true);assert.equal((await f.call({type:'LUDY_UBER_AUTO',enabled:true})).data.autoResume,true);await f.read();
  f.setTab(null);f.events.removed(7);assert.equal((await f.status()).data.active,true);assert.equal(f.saved.connector.tabId,null);assert.equal(JSON.parse(f.requests.at(-1).options.body).status,'error');
  f.setTab({id:8,url:URL_UBER.replace(ORG,'22222222-2222-4222-8222-222222222222'),active:true,status:'complete'});f.events.updated(8,{status:'complete'});await f.status();assert.equal(f.injections.length,1,'never adopt another fleet');
  f.setTab({id:9,url:URL_UBER,active:true,status:'complete'});f.events.updated(9,{status:'complete'});await f.status();assert.equal(f.saved.connector.tabId,9);assert.equal(f.injections.length,2);
  f.events.startup();await f.status();assert.equal(f.saved.connector.tabId,9);assert.equal(f.saved.connector.active,true);assert.equal(f.injections.length,3,'browser restart reattaches only with the optional permission');
  await f.call({type:'LUDY_UBER_STOP'});f.events.startup();f.events.activated();f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.injections.length,3,'manual stop persists across all automatic triggers');
});

test('ambiguous or hidden restored tabs wait rather than adopting arbitrary page; permission removal stops collection',async()=>{
  const f=fixture();await f.start();f.grant(true);await f.call({type:'LUDY_UBER_AUTO',enabled:true});f.setTab(null);f.events.removed(7);await f.status();
  f.otherTabs([{id:8,url:URL_UBER,active:false,status:'complete'}]);f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.injections.length,1);
  f.otherTabs([8,9].map(id=>({id,url:URL_UBER,active:true,status:'complete'})));f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.injections.length,1);assert.match(f.saved.connector.message,/Plusieurs/);
  f.otherTabs([]);f.setTab({id:8,url:URL_UBER,active:true,status:'complete'});f.events.alarm({name:'ludy-uber-watchdog'});await f.status();assert.equal(f.injections.length,2);
  f.grant(false);f.events.permissionRemoved({origins:['https://fleethub.uber.com/*']});const state=(await f.status()).data;assert.equal(state.active,false);assert.equal(state.autoResume,false);assert.equal(f.alarms.size,0);assert.equal(JSON.parse(f.requests.at(-1).options.body).status,'stopped');
});

test('an ignored or conflicting collector response never confirms a healthy transmission',async()=>{
 const f=fixture();await f.start();f.respond({ok:true,status:200,json:async()=>({ok:true,ignored:true})});let state=(await f.read()).data;
 assert.equal(state.state,'collector_conflict');assert.equal(state.lastHealthyAt,null);assert.equal(state.lastSentAt,null);assert.equal(state.active,true);
 f.advance(15000);f.respond({ok:false,status:409});state=(await f.read()).data;assert.equal(state.state,'collector_standby');assert.equal(state.lastHealthyAt,null);
 f.advance(60000);f.respondStatus({ok:true,status:200,json:async()=>({active:true})});f.events.alarm({name:'ludy-uber-watchdog'});await f.status();
 f.respond({ok:true,status:200,json:async()=>({ok:true,observations:1})});assert.equal((await f.read()).data.state,'observing');
});

test('409 suspends DOM reading and refresh until paired local status confirms this PC is active',async()=>{
 const f=fixture();await f.start();await f.read();const oldRun=f.saved.connector.runId,identity=f.saved.connector.collectorId,healthy=f.saved.connector.lastHealthyAt;
 f.advance(15000);f.respond({ok:false,status:409});let state=(await f.read()).data;
 assert.equal(state.standby,true);assert.equal(state.active,true);assert.equal(state.nextRefreshAt,null);assert.equal(f.messages.at(-1).type,'LUDY_UBER_STOP');assert.equal(f.alarms.has('ludy-uber-map-refresh'),false);
 const before=f.requests.length,injections=f.injections.length,messages=f.messages.length;
 f.respondStatus({ok:true,status:200,json:async()=>({active:false})});
 // A late scan, a popup start, tab restoration and old refresh alarms cannot restart it.
 assert.equal((await f.call({type:'LUDY_UBER_READ',runId:oldRun,result:f.batch()},{id:ID,url:URL_UBER,frameId:0,tab:{id:7}})).ok,false);
 await f.call({type:'LUDY_UBER_START'});assert.equal(f.requests.length,before);
 f.advance(21*60000);f.events.alarm({name:'ludy-uber-map-refresh'});f.events.updated(7,{status:'complete'});await f.status();
 assert.equal(f.requests.length,before+1);assert.equal(f.requests.at(-1).url,'http://127.0.0.1:4173/api/fleet/uber/collection-status');
 assert.equal(f.requests.at(-1).options.method,'GET');assert.equal(f.requests.at(-1).options.headers.Authorization,'Bearer '+token);assert.equal(f.requests.at(-1).options.body,undefined);
 assert.equal(f.injections.length,injections);assert.equal(f.messages.length,messages);assert.equal(f.reloads.length,0);
 assert.equal(f.saved.connector.lastHealthyAt,healthy);assert.equal(f.saved.connector.collectorId,identity);
 f.advance(60000);f.respondStatus({ok:true,status:200,json:async()=>({active:true})});f.events.alarm({name:'ludy-uber-watchdog'});state=(await f.status()).data;
 assert.equal(state.standby,false);assert.equal(state.state,'starting');assert.equal(f.injections.length,injections+1);assert.notEqual(f.saved.connector.runId,oldRun);assert.equal(f.reloads.length,0);
 assert.equal(f.saved.connector.nextRefreshAt,f.requests.at(-1).at+20*60000);assert.equal(f.saved.connector.lastHealthyAt,healthy,'leadership does not invent a fresh observation');
 f.respond({ok:true,status:200});await f.read();assert.equal(f.requests.at(-1).options.method,'POST');assert.notEqual(f.saved.connector.lastHealthyAt,healthy);
 await f.call({type:'LUDY_UBER_STOP'});
});

test('standby survives worker recreation, fails closed on unavailable status and clears pairing on logout or revocation',async()=>{
 const f=fixture();await f.start();f.respond({ok:false,status:409});await f.read();
 const g=fixture(structuredClone(f.saved));await g.status();assert.equal(g.saved.connector.standby,true);assert.equal(g.alarms.has('ludy-uber-map-refresh'),false);
 for(const response of [Error('offline'),{ok:false,status:503},{ok:true,status:200,json:async()=>({active:true,extra:'unexpected'})}]){
   g.advance(60000);g.respondStatus(response);g.events.alarm({name:'ludy-uber-watchdog'});await g.status();assert.equal(g.saved.connector.standby,true);assert.equal(g.injections.length,0);assert.equal(g.reloads.length,0);
 }
 for(const status of [401,403]){
   const h=fixture(structuredClone(f.saved));await h.status();h.advance(60000);h.respondStatus({ok:false,status});h.events.alarm({name:'ludy-uber-watchdog'});
   const state=(await h.status()).data;assert.equal(state.state,'pairing_required');assert.equal(state.paired,false);assert.equal(state.active,false);assert.equal(h.saved.connector.token,null);
   const count=h.requests.length;h.advance(60000);h.events.alarm({name:'ludy-uber-watchdog'});await h.status();assert.equal(h.requests.length,count);
 }
 await g.call({type:'LUDY_UBER_STOP'});const count=g.requests.length;g.respondStatus({ok:true,status:200,json:async()=>({active:true})});g.advance(60000);g.events.alarm({name:'ludy-uber-watchdog'});await g.status();assert.equal(g.requests.length,count);assert.equal(g.injections.length,0);
});

test('a stop or pairing change received during status polling cannot restart the old DOM reader',async()=>{
 for(const type of ['LUDY_UBER_STOP','LUDY_UBER_FORGET','LUDY_UBER_PAIR']){
   const f=fixture();await f.start();f.respond({ok:false,status:409});await f.read();const injections=f.injections.length;
   let resolveStatus,entered;const pending=new Promise(resolve=>{entered=resolve;});
   f.respondStatus(()=>{entered();return new Promise(resolve=>{resolveStatus=resolve;});});
   f.advance(60000);f.events.alarm({name:'ludy-uber-watchdog'});await pending;
   const stop=f.call({type,token:'ludy_uber_'+'n'.repeat(43)});
   assert.equal(f.requests.at(-1).options.signal.aborted,true);
   // Even a fetch implementation ignoring AbortSignal cannot resume this run.
   resolveStatus({ok:true,status:200,json:async()=>({active:true})});await stop;
   assert.equal(f.injections.length,injections);assert.equal(f.saved.connector.active,false);assert.equal(f.saved.connector.runId,null);assert.equal(f.alarms.size,0);
 }
});

test('popup describes standby refresh as suspended while preserving the explicit stop control',async()=>{
 const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},addEventListener(){},replaceChildren(){}});return elements.get(id);};
 const state={active:true,standby:true,paired:true,state:'collector_standby',message:'En attente',rows:0};
 const context=vm.createContext({chrome:{runtime:{sendMessage:async()=>({ok:true,data:state})}},document:{getElementById:element,createElement:()=>({}),querySelectorAll:()=>[]},Date,setInterval:()=>0,addEventListener(){}});
 vm.runInContext(await fs.readFile(new URL('popup.js',root),'utf8'),context);await new Promise(resolve=>setImmediate(resolve));
 assert.match(element('map-refresh').textContent,/Actualisation suspendue/);assert.equal(element('stop').disabled,false);
});

test('a message with no response cannot freeze the visible content reader forever',async()=>{
 const contentSource=await fs.readFile(new URL('content.js',root),'utf8');let listener,requests=0,id=0;const ticks=new Map(),deadlines=new Map();
 const context=vm.createContext({AbortController,LudyUberScanner:{scan:async()=>({rows:[]})},chrome:{runtime:{id:ID,onMessage:{addListener:fn=>{listener=fn;}},sendMessage:()=>{requests++;return new Promise(()=>{});}}},document:{addEventListener(){}},addEventListener(){},setInterval:fn=>{ticks.set(1,fn);return 1;},clearInterval:n=>ticks.delete(n),setTimeout:(fn,delay)=>{deadlines.set(++id,{fn,delay});return id;},clearTimeout:n=>deadlines.delete(n)});
 vm.runInContext(contentSource,context);listener({type:'LUDY_UBER_START',runId:'run'},{id:ID},()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,1);
 assert.deepEqual([...deadlines.values()].map(timer=>timer.delay),[35000],'the reader waits longer than the local POST deadline');
 await ticks.get(1)();assert.equal(requests,1,'the next scan tick cannot overlap the pending acknowledgement');
 for(const timer of deadlines.values())timer.fn();await new Promise(resolve=>setImmediate(resolve));
 void ticks.get(1)();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,2,'a later fresh read is attempted after the first message times out');
 listener({type:'LUDY_UBER_STOP'},{id:ID},()=>{});for(const timer of deadlines.values())timer.fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(ticks.size,0);
});

test('the updated extension injects the scanner before content and reports complete or partial list coverage',async()=>{
  const f=fixture();await f.start();
  assert.deepEqual(Array.from(f.injections[0].files),['reader.js','scanner.js','content.js']);
  let state=(await f.read({coverage:{mode:'list_sweep',complete:true,observed:1}})).data;
  assert.equal(state.coverage.complete,true);assert.equal(state.coverage.observed,1);assert.equal(state.rows,1);
  assert.match(state.message,/Liste affichée parcourue/);assert.ok(!JSON.stringify(state).includes(token));
  f.advance(15000);
  state=(await f.read({coverage:{mode:'list_sweep',complete:false,observed:1,reason:'user_interaction'}})).data;
  assert.equal(state.coverage.complete,false);assert.equal(state.coverage.reason,'user_interaction');assert.match(state.message,/Lecture partielle/);
  assert.equal(JSON.parse(f.requests.at(-1).options.body).coverage.complete,false);
  state=(await f.call({type:'LUDY_UBER_STOP'})).data;
  assert.equal(state.coverage,null);assert.equal(state.rows,0);
});

test('a zero-row collection preserves the diagnostic and cannot claim a complete list',async()=>{
  const f=fixture();await f.start();
  const state=(await f.read({status:'error',rows:[],warnings:['Aucun chauffeur exploitable dans la vue affichée.'],
    coverage:{mode:'list_sweep',complete:false,observed:0,reason:'unrecognized'}})).data;
  assert.equal(state.state,'error');assert.equal(state.rows,0);assert.equal(state.coverage.complete,false);
  assert.match(state.message,/Aucun chauffeur exploitable/);assert.equal(state.lastHealthyAt,null);
});

test('the public popup state exposes only coverage fields and never arbitrary persisted diagnostics',async()=>{
  const f=fixture({connector:{coverage:{mode:'list_sweep',complete:false,observed:1,reason:'limit',private:'fixture-private'},rows:1}});
  const state=(await f.status()).data;
  assert.deepEqual(JSON.parse(JSON.stringify(state.coverage)),{mode:'list_sweep',complete:false,observed:1,reason:'limit'});
  assert.equal(JSON.stringify(state).includes('fixture-private'),false);
});

test('extension updates verify a recent collector version and stop an old injected loop before replacement',async()=>{
  const f=fixture();await f.start();await f.read();
  const oldRun=f.saved.connector.runId,stopCount=f.messages.filter(message=>message.type==='LUDY_UBER_STOP').length;
  f.content({running:true,runId:oldRun,version:'0.3.0'});
  f.events.installed();const state=(await f.status()).data;
  assert.equal(state.active,true);assert.equal(f.injections.length,2,'installation checks even a just-read collector');
  assert.notEqual(f.saved.connector.runId,oldRun);assert.equal(f.messages.filter(message=>message.type==='LUDY_UBER_STOP').length,stopCount+1);
  const newCount=f.injections.length;f.events.installed();await f.status();
  assert.equal(f.injections.length,newCount,'the current collector is reused');
  assert.equal(f.messages.at(-1).type,'LUDY_UBER_SCAN');
});
