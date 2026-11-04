import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createDesktopUberBrowser,desktopUberPaths,desktopEarningsPlan,assertDesktopUberTimezone} from '../desktop-runtime/uber-browser.mjs';
import {moroccoOffsetMinutes} from '../server/morocco-time.mjs';

const projectRef='abcdefghijklmnopqrst',userId='12345678-1234-1234-1234-123456789abc',organization='87654321-1234-1234-1234-123456789abc';
const reportConfig={enabled:true,organization_id:organization,report_types:['trip_activity'],start_date:'2026-10-27',end_date:'2026-11-03',interval_seconds:21600};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t,options={}){
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'ludy-uber-')),calls=[],launches=[],states=[],timers=new Map();let timerId=0,clock=Date.parse('2026-11-04T12:00:00Z'),validLease=true;
  class Page extends EventEmitter{
    constructor(main=false){super();this.main=main;this.address='about:blank';this.closed=false;this.gotos=[];this.front=0;}
    url(){return this.address;}isClosed(){return this.closed;}
    async goto(value){this.gotos.push(value);this.address=this.main&&options.login?'https://auth.uber.com/login':value;}
    async evaluate(fn,args){if(Array.isArray(args))return {zone:'Africa/Casablanca',offsets:args.map(at=>-moroccoOffsetMinutes(at))};return {lastInput:0,login:false};}
    async addInitScript(){this.init=true;}async bringToFront(){this.front++;}
    async close(){if(!this.closed){this.closed=true;this.emit('close');}}
  }
  class Context extends EventEmitter{
    constructor(){super();this.all=[new Page(true)];this.closed=false;}
    pages(){return this.all.filter(p=>!p.closed);}async newPage(){const page=new Page();this.all.push(page);return page;}
    async close(){if(!this.closed){this.closed=true;await Promise.all(this.all.map(p=>p.close()));this.emit('close');}}
  }
  const contexts=[],engine={executablePath:()=>path.join(stateDir,'chromium'),async launchPersistentContext(profile,config){launches.push({profile,config});const context=new Context();contexts.push(context);return context;}};
  const entries=new Map(),ledger={key:(config,type)=>[config.organization_id,type,config.start_date,config.end_date].join(':'),get:key=>entries.get(key)||{},async update(key,value){entries.set(key,{...entries.get(key),...value});}};
  const request=async(endpoint,settings={})=>{
    calls.push({endpoint,settings});if(options.request){const result=options.request(endpoint,settings);if(result!==undefined)return result;}
    if(endpoint.startsWith('/api/uber-reports/browser/config'))return structuredClone(reportConfig);
    if(endpoint==='/api/provider-earnings/config')return {uber:{enabled:options.finance===true,organization_id:organization,time_zone:'Africa/Casablanca'}};
    return {ok:true};
  };
  const browser=createDesktopUberBrowser({projectRef,stateDir,userId,request,chromium:engine,
    assertLease:async()=>{if(!validLease)throw Object.assign(Error('expired'),{status:409});},onStatus:s=>states.push(s),
    now:()=>clock,setTimer:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimer:id=>timers.delete(id),
    checkExecutable:options.checkExecutable||(async()=>{}),ledgerFactory:async()=>ledger,
    reportCollectorFactory:options.reportFactory||(({ingest})=>({async tick(config){await ingest({report_type:'trip_activity',csv:'synthetic fixture'},{signal:new AbortController().signal});await ledger.update(ledger.key(config,'trip_activity'),{nextAt:clock+21600000});return {status:'imported'};},async stop(){}})),
    earningsCollectorFactory:options.earningsFactory||(({ingest})=>({async collect(config){await ingest({synthetic:true,period:config.expectedPeriod},{signal:new AbortController().signal});return {complete:true};},async stop(){}}))});
  t.after(async()=>{await browser.close();await rm(stateDir,{recursive:true,force:true});});
  return {browser,stateDir,calls,launches,states,timers,contexts,expire:()=>{validLease=false;},async tick(delay=15000){clock+=delay;const entry=[...timers].find(([,value])=>value.delay===delay);assert.ok(entry,'scheduled tick');timers.delete(entry[0]);entry[1].fn();await settle();}};
}
test('browser construction is inert; start uses a dedicated visible profile and waits for normal Uber login',async t=>{
  const f=await fixture(t,{login:true});assert.equal(f.calls.length,0);assert.equal(f.launches.length,0);
  await f.browser.start();await settle();assert.equal(f.browser.status().state,'login_required');
  const launch=f.launches[0];assert.ok(launch.profile.includes(path.join(projectRef,userId,'profile')));
  assert.equal(launch.config.headless,false);assert.equal(launch.config.chromiumSandbox,true);assert.equal(launch.config.timezoneId,'Africa/Casablanca');
  assert.deepEqual(launch.config.args,['--no-first-run']);assert.ok(!f.calls.some(c=>c.endpoint.endsWith('/ingest')||c.endpoint==='/api/provider-earnings/uber'));
  await f.browser.openLogin();assert.equal(f.contexts[0].all[0].front,1);assert.equal(f.launches.length,1);
});
test('reports and both financial weeks use existing ingestion endpoints; no Live Map collector is started',async t=>{
  const f=await fixture(t,{finance:true});await f.browser.start();await settle();await settle();
  assert.equal(f.calls.filter(c=>c.endpoint==='/api/provider-earnings/uber').length,2);
  assert.equal(f.calls.filter(c=>c.endpoint==='/api/uber-reports/browser/ingest').length,1);
  const report=f.calls.find(c=>c.endpoint.endsWith('/ingest'));assert.match(report.settings.body.collectorId,/^[a-f0-9-]{36}$/);
  assert.equal(f.browser.status().reports,'imported');assert.equal(f.browser.status().earnings,'ready');
  assert.equal(f.contexts[0].all.filter(p=>!p.closed).length,1,'each work tab is closed after its task');
  assert.ok(f.calls.every(c=>!c.endpoint.includes('/api/fleet/')));assert.ok(f.contexts[0].all.every(p=>p.gotos.every(url=>url===`https://fleethub.uber.com/orgs/${organization}/reports`)));
});
test('missing Chromium is reported for installation without spawning a browser',async t=>{
  const f=await fixture(t,{checkExecutable:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}});
  await assert.rejects(f.browser.start(),{code:'browser_install_required'});
  assert.equal(f.browser.status().state,'browser-install-required');assert.equal(f.launches.length,0);
  assert.equal(f.calls.at(-1).endpoint,'/api/uber-reports/browser/release');
});
test('lease loss prevents an in-flight read from submitting observations',async t=>{
  const hold=deferred(),entered=deferred();
  const f=await fixture(t,{reportFactory:({ingest})=>({async tick(){entered.resolve();await hold.promise;await ingest({csv:'uncommitted'},{signal:new AbortController().signal});return {status:'imported'};},async stop(){hold.resolve();}})});
  await f.browser.start();await entered.promise;f.expire();hold.resolve();await settle();await settle();
  assert.ok(!f.calls.some(c=>c.endpoint.endsWith('/ingest')));assert.equal(f.contexts[0].closed,true);assert.equal(f.timers.size,0);
});
test('closing aborts an in-flight ingestion and closes the persistent context without removing its profile',async t=>{
  const entered=deferred();let capturedSignal;
  const f=await fixture(t,{request:(endpoint,options)=>{
    if(endpoint.endsWith('/ingest'))return new Promise((resolve,reject)=>{capturedSignal=options.signal;entered.resolve();options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  }});
  await f.browser.start();await entered.promise;await f.browser.close();
  assert.equal(capturedSignal.aborted,true);assert.equal(f.contexts[0].closed,true);assert.equal(f.timers.size,0);
  await assert.rejects(f.browser.start(),{code:'stopped'});
});
test('financial rate limits postpone earnings without blocking activity reports',async t=>{
  let earnings=0;const f=await fixture(t,{finance:true,earningsFactory:()=>({async collect(){earnings++;throw Object.assign(Error('limited'),{status:429,code:'rate_limited'});},async stop(){}})});
  await f.browser.start();await settle();await settle();assert.equal(earnings,1);assert.equal(f.browser.status().reports,'imported');
  await f.tick();assert.equal(earnings,1);assert.equal(f.browser.status().earnings,'action_required');
});
test('profile paths reject traversal and separate project and account',()=>{
  assert.throws(()=>desktopUberPaths({projectRef,stateDir:'/private',userId:'../another'}),TypeError);
  assert.throws(()=>desktopUberPaths({projectRef:'../project',stateDir:'/private',userId}),TypeError);
  const a=desktopUberPaths({projectRef,stateDir:'/private',userId}),b=desktopUberPaths({projectRef,stateDir:'/private',userId:'99999999-1234-1234-1234-123456789abc'});
  assert.notEqual(a.profile,b.profile);
});
test('Monday 04:00 Morocco financial boundaries and browser timezone are verified',async()=>{
  const at=Date.parse('2026-11-04T12:00:00Z'),plan=desktopEarningsPlan(at);
  assert.deepEqual(plan,[{kind:'current',start_at:'2026-11-02T04:00:00.000Z',end_at:'2026-11-09T04:00:00.000Z'},{kind:'previous',start_at:'2026-10-26T04:00:00.000Z',end_at:'2026-11-02T04:00:00.000Z'}]);
  assert.equal(desktopEarningsPlan(at,{end:plan[1].end_at,at}).length,1);
  assert.equal(desktopEarningsPlan(at+86400000,{end:plan[1].end_at,at}).length,2);
  await assert.rejects(assertDesktopUberTimezone({evaluate:async()=>({zone:'Europe/Paris',offsets:[-60,-60,-60]})},reportConfig,{now:at}),{code:'browser_timezone'});
});
