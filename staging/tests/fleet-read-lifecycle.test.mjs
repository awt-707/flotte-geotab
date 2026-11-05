import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const fleet=readFileSync(new URL('../site/fleet.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
const health=app.slice(app.indexOf('function healthPaint()'),app.indexOf('// ---------- EN DIRECT'));
const route=app.slice(app.indexOf('async function route()'),app.indexOf("window.addEventListener('hashchange', route)"));
const response=data=>({ok:true,json:async()=>data});
function fixture(){
 const calls=[],timeouts=[],label={};let now=100000;
 class Clock extends Date {static now(){return now;}}
 const context=vm.createContext({Date:Clock,AbortController,AbortSignal:{any:AbortSignal.any.bind(AbortSignal),timeout:ms=>{timeouts.push(ms);return new AbortController().signal;}},
  S:{session:{user:{id:'first'},access_token:'synthetic-first'},sessionRevision:1,timers:[]},ROUTING:1,CFG:{GEOTAB_LOCAL:true,DESKTOP_PRODUCTION:true},document:{hidden:false},$:()=>label,
  fetch:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,resolve:data=>resolve(response(data)),reject}))});
 vm.runInContext(fleet,context);vm.runInContext(health,context);
 return {context,calls,timeouts,label,advance:ms=>{now+=ms;},run:code=>vm.runInContext(code,context)};
}

test('concurrent snapshot consumers share a single request, with no completed snapshot cache',async()=>{
 const f=fixture(),a=f.run("fleetApi('geotab/live')"),b=f.run("fleetApi('geotab/live')");
 assert.equal(f.calls.length,1);f.calls[0].resolve({vehicles:[{key:'visible'}]});
 assert.deepEqual(await a,await b);
 const next=f.run("fleetApi('geotab/live')");assert.equal(f.calls.length,2);f.calls[1].resolve({vehicles:[]});await next;
});

test('navigation cancels old GETs and late responses cannot remove a new route request',async()=>{
 const f=fixture(),old=f.run("fleetApi('geotab/live')"),rejected=assert.rejects(old,{name:'AbortError'});
 f.context.ROUTING++;f.run('fleetCancelReads()');assert.equal(f.calls[0].options.signal.aborted,true);
 const next=f.run("fleetApi('geotab/live')");f.calls[0].resolve({vehicles:[{key:'old'}]});await rejected;
 const duplicate=f.run("fleetApi('geotab/live')");assert.equal(f.calls.length,2);
 f.calls[1].resolve({vehicles:[{key:'new'}]});assert.deepEqual(await next,await duplicate);
});

test('account and token changes never reuse an old request, even on the same route',async()=>{
 for(const sameUser of [false,true]){
  const f=fixture(),old=f.run("fleetApi('overview')"),rejected=assert.rejects(old,{name:'AbortError'});
  if(!sameUser){f.context.S.session.user.id='second';f.context.S.sessionRevision++;}
  f.context.S.session.access_token='synthetic-new';const next=f.run("fleetApi('overview')");
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.calls[1].options.headers.Authorization,'Bearer synthetic-new');
  f.calls[0].resolve({drivers:[{id:'old'}]});await rejected;f.calls[1].resolve({drivers:[]});await next;
 }
});

test('separate windows and query scopes never share data or cancel each other',async()=>{
 const first=fixture(),second=fixture(),a=first.run("fleetApi('history?driver_id=a')"),b=first.run("fleetApi('history?driver_id=b')"),c=second.run("fleetApi('history?driver_id=a')");
 assert.equal(first.calls.length,2);assert.equal(second.calls.length,1);
 const rejected=Promise.all([assert.rejects(a,{name:'AbortError'}),assert.rejects(b,{name:'AbortError'})]);first.run('fleetCancelReads()');
 assert.equal(second.calls[0].options.signal.aborted,false);
 first.calls.forEach(call=>call.resolve({}));await rejected;second.calls[0].resolve({id:'second-window'});assert.equal((await c).id,'second-window');
});

test('navigation neither cancels nor coalesces provider actions and preserves their long deadline',async()=>{
 const f=fixture(),a=f.run("fleetApi('geotab/start', {})"),b=f.run("fleetApi('geotab/start', {})"),read=f.run("fleetApi('geotab/status')"),rejected=assert.rejects(read,{name:'AbortError'});
 assert.equal(f.calls.length,3);assert.deepEqual(f.timeouts,[120000,120000,20000]);
 f.run('fleetCancelReads()');assert.equal(f.calls[0].options.signal.aborted,false);assert.equal(f.calls[1].options.signal.aborted,false);assert.equal(f.calls[2].options.signal.aborted,true);
 f.calls.forEach(call=>call.resolve({ok:true}));await Promise.all([a,b,rejected]);
});

test('sidebar uses a lightweight shared status, coalesces callers and pauses while hidden',async()=>{
 const f=fixture(),a=f.run('health()'),b=f.run('health()');assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/fleet/health');
 f.calls[0].resolve({sources:[{id:'geotab',status:'healthy',collectionRemote:true}]});await Promise.all([a,b]);assert.equal(f.label.textContent,'Geotab : suivi actif');
 f.context.ROUTING++;f.advance(29999);await f.run('health()');assert.equal(f.calls.length,1,'navigation reuses recent health only, without rereading the map');
 f.advance(1);f.context.document.hidden=true;await f.run('health()');assert.equal(f.calls.length,1);
 f.context.document.hidden=false;const refreshed=f.run('health()');assert.equal(f.calls.length,2);f.calls[1].resolve({sources:[{id:'geotab',status:'paused'}]});await refreshed;assert.equal(f.label.textContent,'Geotab : en pause');
});

test('an intentionally cancelled sidebar read preserves the last known source',async()=>{
 const f=fixture(),first=f.run('health()');f.calls[0].resolve({sources:[{id:'geotab',status:'healthy'}]});await first;
 f.advance(60000);const next=f.run('health()');f.run('fleetCancelReads()');f.calls[1].resolve({sources:[]});await next;
 assert.equal(f.context.S.geotabHealth.source.status,'healthy');assert.equal(f.context.S.geotabHealth.unavailable,undefined);assert.equal(f.label.textContent,'Geotab : suivi actif');
});

test('cockpit schedules persisted alerts and lightweight health without reading GPS snapshots',async()=>{
 const f=fixture(),timers=[];
 Object.assign(f.context,{LIVE:{},processLocalLive(){},SITE_NEW:false,pageOf:()=> 'cockpit',extHide(){},loadRef:async()=>{},rhGate:async()=>true,mineLoad:async()=>{},canSee:()=>true,shell:()=> 'cockpit',PAGES:{cockpit:async()=>{}},ADMIN_PAGES:{},watchAlerts(){},sessPing(){},window:{},clearInterval(){},setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length;}});
 f.context.S.profile={role:'admin'};f.context.document.getElementById=()=>null;vm.runInContext(route,f.context);await f.run('route()');
 assert.deepEqual(timers.map(timer=>timer.ms),[15000,60000,60000]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/fleet/alerts');f.calls[0].resolve({source:{status:'healthy'},events:[],motion_alerts:[]});
 const status=timers[1].fn();assert.equal(f.calls.length,2);assert.equal(f.calls[1].url,'/api/fleet/health');f.calls[1].resolve({sources:[]});await status;
});
test('persisted alerts never overwrite GPS or coverage and stop for hidden or departed views',async()=>{
 const f=fixture(),timers=[],accepted=[],positions={known:{lat:33.5}},telemetry={known:{km:5}},coverage={linked_drivers:4};let painted=0;
 Object.assign(f.context,{LIVE:{pos:positions,drv:telemetry,motionCoverage:coverage},pageOf:()=> 'cockpit',setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length;},processLocalLive:data=>accepted.push(data),operationsSnapshot:()=>painted++});
 f.run('startFleetAlerts(1)');assert.equal(f.calls.length,1);await timers[0].fn();assert.equal(f.calls.length,1,'a slow alert read never overlaps');
 f.calls[0].resolve({source:{status:'healthy'},events:[],motion_alerts:[{id:'incident'}],motion_coverage:null});await new Promise(setImmediate);
 assert.equal(accepted[0].motion_alerts[0].id,'incident');assert.equal(f.context.LIVE.pos,positions);assert.equal(f.context.LIVE.drv,telemetry);assert.equal(f.context.LIVE.motionCoverage,coverage);assert.equal(painted,1);
 f.context.document.hidden=true;await timers[0].fn();assert.equal(f.calls.length,1);f.context.document.hidden=false;
 const old=timers[0].fn();f.context.ROUTING++;f.run('fleetCancelReads()');f.calls[1].resolve({motion_alerts:[{id:'late'}]});await old;assert.equal(accepted.length,1);assert.equal(painted,1);
 await timers[0].fn();assert.equal(f.calls.length,2);
 for(const page of ['direct','application','connecteurs']){f.context.pageOf=()=>page;f.run('startFleetAlerts(2)');}assert.equal(timers.length,1,'other pages do not start this alert polling loop');
});
