import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {Readable} from 'node:stream';
import {validationSample,validationSummary,createValidationMonitor} from '../server/validation.mjs';import {createFleetApi} from '../server/fleet.mjs';
const T=Date.parse('2026-10-30T12:00:00Z'),iso=offset=>new Date(T+offset).toISOString();
function fixture(at=T){return {now:at,sources:['uber','bolt','geotab','myclicar'].map(id=>({id,status:'healthy',last_success_at:new Date(at).toISOString(),stale_after_s:90,coverage:{drivers:11,complete:true}})),drivers:[{id:'private-person-id',name:'Private Person',ludy_driver_code:'private-code',vehicle_key:'private-car'}],identities:[{id:'private-account',driver_id:'private-person-id',source:'uber'}],latest:[{identity_id:'private-account',driver_id:'private-person-id',source:'uber',status:'on_trip',observed_at:new Date(at).toISOString()}],motion:[{id:'private-alert-id',driver_id:'private-person-id',vehicle_key:'private-car',status:'open',evidence:{private:'Secret'}}],duration:[],contracts:[]};}
test('the 24-hour record contains only aggregates, detects contradictions and preserves source coverage',()=>{
 const f=fixture(),s=validationSample(f);assert.equal(s.counts.alerts_with_online_driver,1);assert.equal(s.counts.motion_open,1);assert.equal(s.sources.uber.fresh,true);assert.doesNotMatch(JSON.stringify(s),/private|Secret|Person/);
 f.sources[0].last_success_at=iso(-91000);f.sources[1].coverage.complete=false;const stale=validationSample(f);assert.equal(stale.sources.uber.fresh,false);assert.equal(stale.counts.alerts_with_online_driver,0);assert.equal(stale.sources.bolt.complete,false);
});
test('a restart or sleeping PC leaves a measurable gap and cannot become a successfully observed day',()=>{
 const samples=[];for(const at of [0,60000,3600000])samples.push(validationSample({...fixture(T+at),previous:samples.at(-1)}));
 const state={status:'running',started_at:iso(0),target_at:iso(86400000),samples};const out=validationSummary(state,T+3600000);
 assert.equal(out.gaps,1);assert.equal(out.gap_seconds,3480);assert.equal(out.confirmed_contradictions,1);assert.equal(out.conclusion,'in_progress');
 state.status='completed';assert.equal(validationSummary(state,T+86400000).conclusion,'incomplete');
});
test('a full measured day reports completion separately from real incident confirmation',()=>{
 const samples=Array.from({length:1441},(_,i)=>{const f=fixture(T+i*60000);f.motion=[];return validationSample(f);});
 const report=validationSummary({status:'completed',started_at:iso(0),target_at:iso(86400000),samples},T+86400000);
 assert.equal(report.observed_hours,24);assert.equal(report.conclusion,'observation_finished');assert.equal(report.real_motion_incident_seen,false);assert.equal(report.sources.uber.availability_pct,100);
 for(const sample of samples)sample.sources.uber.fresh=false;
 assert.equal(validationSummary({status:'completed',started_at:iso(0),target_at:iso(86400000),samples},T+86400000).conclusion,'needs_review');
 for(const sample of samples)sample.sources.uber.fresh=true;
 samples[500].sources.bolt.complete=false;
 assert.equal(validationSummary({status:'completed',started_at:iso(0),target_at:iso(86400000),samples},T+86400000).conclusion,'needs_review');
});
test('monitor resumes a private report, never writes to a provider, and records local read failures',async t=>{
 const root=new URL('../.local/',import.meta.url);await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(new URL('validation-test-',root).pathname);t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let clock=T,bad=false,nextDelay;const timers=new Set(),calls=[];const tables={fleet_sources:fixture().sources,fleet_drivers:[],fleet_identities:[],fleet_latest:[],fleet_motion_alerts:[],fleet_alerts:[],fleet_myclicar_contracts:[]};
 const make=()=>createValidationMonitor({filename:dir+'/report.json',list:async(table)=>{calls.push(table);assert.ok(table in tables);if(bad)throw Error('private-provider-secret');return tables[table];},now:()=>clock,setTimer:(fn,delay)=>{nextDelay=delay;timers.add(fn);return fn;},clearTimer:fn=>timers.delete(fn)});
 let m=make();let status=await m.start();assert.equal(status.status,'running');assert.equal(status.samples,1);assert.equal(timers.size,1);await m.start();assert.equal((await m.status()).samples,1);assert.equal((await fs.stat(dir+'/report.json')).mode&0o777,0o600);
 m.close();clock+=40000;m=make();await m.resume();assert.equal((await m.status()).samples,1);assert.equal(nextDelay,20000,'restart keeps the next scheduled observation instead of postponing it by a full minute');
 m.close();clock=T+3600000;m=make();await m.resume();assert.equal((await m.status()).gaps,1);clock+=60000;bad=true;await m.sample();assert.equal((await m.status()).read_errors,1);assert.doesNotMatch(await fs.readFile(dir+'/report.json','utf8'),/private-provider-secret/);m.close();assert.equal(timers.size,0);
 await fs.chmod(dir+'/report.json',0o644);await assert.rejects(make().status(),/indisponible/);
});
test('validation report endpoints require the local administrator role',async()=>{
 for(const role of ['admin','manager','viewer']){
  const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',fetchFn:async url=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421');return Response.json(u.pathname==='/auth/v1/user'?{id:'account'}:[{user_id:'account',role}]);}});
  const req=Readable.from([]);Object.assign(req,{url:'/api/fleet/validation/status',method:'GET',headers:{host:'127.0.0.1:4173',authorization:'Bearer test'},socket:{remoteAddress:'127.0.0.1'}});let code;
  try{await handler(req,{writeHead:s=>{code=s;},end(){},setHeader(){}});assert.equal(code,role==='admin'?200:403);}finally{handler.close();}
 }
});


test('different transient anomalies are not confirmed as persistent and correlation IDs never survive persistence',()=>{
 const first=validationSample(fixture());const different=fixture(T+60000);different.motion[0].id='another-private-alert';
 assert.equal(validationSample({...different,previous:first}).confirmed_issues,0);
 assert.equal(validationSample({...fixture(T+60000),previous:first}).confirmed_issues,1);
 assert.equal(validationSample({...fixture(T+60000),previous:JSON.parse(JSON.stringify(first))}).confirmed_issues,0);
 assert.doesNotMatch(JSON.stringify(first),/private-alert/);
});
test('invalid or contradictory assignment evidence is flagged and resolved real incidents between ticks are still recorded',()=>{
 const f=fixture();Object.assign(f.drivers[0],{vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'uber',observed_at:iso(-1000),expires_at:'invalid'}});
 assert.equal(validationSample(f).counts.motion_without_current_assignment,1);
 f.motion=[{id:'one',status:'resolved',opened_at:iso(30000)},{id:'old',status:'open',opened_at:iso(-60000)},{id:'corrected',status:'resolved',opened_at:iso(1000),evidence:{correction_reason:'invalid_association'}}];
 const record=validationSample({...f,now:T+60000,startedAt:iso(0)});assert.equal(record.counts.motion_since_start,1);
 assert.equal(validationSummary({status:'running',started_at:iso(0),target_at:iso(86400000),samples:[record]},T+60000).real_motion_incident_seen,true);
 f.motion[0].evidence={correction_reason:'invalid_association'};
 const corrected=validationSample({...f,now:T+120000,startedAt:iso(0)});
 assert.equal(validationSummary({status:'running',started_at:iso(0),target_at:iso(86400000),samples:[record,corrected]},T+120000).real_motion_incident_seen,false);
});
