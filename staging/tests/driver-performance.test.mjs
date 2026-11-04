import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {normalizeBoltPerformance,summarizeDriverPerformance,performancePeriod,availableUberReportPeriods,createDriverPerformanceApi} from '../server/driver-performance.mjs';
const now=Date.parse('2026-11-02T12:00:00Z'),driver=randomUUID(),other=randomUUID(),external=randomUUID(),identity=randomUUID(),period=performancePeriod('2026-11-01','2026-11-01',now);
const identities=[{id:identity,driver_id:driver,source:'bolt',external_id:external,organization_id:'123',provisional:false}];
const raw=(change={})=>({order_reference:'SYNTHETIC-ORDER',status:'finished',is_optional:false,request_created_datetime:'2026-11-01T08:00:00Z',driver_accepted_datetime:'2026-11-01T08:01:00Z',pickup_datetime:'2026-11-01T08:05:00Z',finished_datetime:'2026-11-01T08:20:00Z',total_ride_distance_km:9,pickup_to_dropoff_distance_km:7,ride_duration_seconds:900,pickup_duration_seconds:180,driver:{uuid:external,email:'PRIVATE@example.invalid',phone:'PRIVATE_PHONE',first_name:'PRIVATE'},vehicle:{vin:'PRIVATE_VIN'},price:{total:70,currency:'MAD',tip:5,booking_fee:2,toll_fee:0,cancellation_fee:null},stops:[{type:'pickup',address:'PRIVATE_ADDRESS',location:{lat:33.58,lng:-7.62},arrived_at_datetime:'2026-11-01T08:04:00Z'},{type:'dropoff',location:{lat:33.59,lng:-7.64}}],...change});
const normalize=orders=>normalizeBoltPerformance(orders,{organizationId:'123',identities,from:period.from_at,to:period.to_at,now});
test('documented Bolt ride fields are retained without contacts, addresses or invented net earnings',()=>{
 const result=normalize([raw()]),row=result.rows[0];assert.equal(row.driver_id,driver);assert.equal(row.amount,70);assert.equal(row.tip_amount,5);assert.equal(row.duration_s,900);assert.equal(row.requested_at,'2026-11-01T08:00:00.000Z');assert.equal(row.passenger_distance_km,7);assert.equal(row.stops.length,2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|email|phone|address|vin|net_earnings/);
 assert.equal(row.stops[0].type,'pickup');assert.equal(row.stops[0].lat,33.58);
});
test('documented three-letter currencies accept lowercase while malformed currency values still reject the import',()=>{
 const orders=['mad','MaD','MAD',' eur '].map((currency,i)=>raw({order_reference:'CURRENCY-'+i,price:{total:10,currency}}));
 const {rows}=normalize(orders);assert.deepEqual(rows.map(r=>r.currency),['MAD','MAD','MAD','EUR']);
 const summary=summarizeDriverPerformance({rides:rows,period,source:'bolt'});
 assert.deepEqual(summary.money.map(m=>[m.currency,m.total,m.known]),[['MAD',30,3],['EUR',10,1]]);
 for(const currency of ['',123,{},'M4D','€UR','ßad','MAD\u0000','MAD-extra'])assert.throws(()=>normalize([raw(),raw({order_reference:'INVALID',price:{total:null,currency}})]),/Devise Bolt/);
 assert.throws(()=>normalize([raw({price:{total:10,currency:null}})]),/Devise Bolt/);
 assert.equal(normalize([raw({price:{total:null,currency:null}})]).rows[0].currency,null);
});
test('identity joins are exact and company-scoped; malformed provider data never creates partial rows',()=>{
 assert.equal(normalize([raw({driver:{uuid:randomUUID()}})]).counts.unmatched,1);
 assert.equal(normalizeBoltPerformance([raw()],{organizationId:'456',identities,from:period.from_at,to:period.to_at,now}).rows.length,0);
 const contradictory=[...identities,{...identities[0],driver_id:other},{...identities[0]}];assert.equal(normalizeBoltPerformance([raw()],{organizationId:'123',identities:contradictory,from:period.from_at,to:period.to_at,now}).rows.length,0);
 for(const invalid of [raw({status:'invented'}),raw({request_created_datetime:null}),raw({ride_duration_seconds:-1}),raw({price:{total:20,currency:'???'}}),raw({finished_datetime:'2026-11-01T07:00:00Z'})])assert.throws(()=>normalize([raw(),{...invalid,order_reference:'SECOND'}]));
 assert.throws(()=>normalize([raw(),raw()]));assert.equal(normalize([raw({request_created_datetime:'2026-10-30T08:00:00Z'})]).counts.outside_period,1);
});
test('period boundaries use Moroccan calendar days and reject invalid, future or oversized intervals',()=>{
 assert.equal(period.from_at,'2026-11-01T00:00:00.000Z');assert.equal(period.to_at,'2026-11-02T00:00:00.000Z');
 const autumn=performancePeriod('2026-09-01','2026-10-01',now);assert.equal(Date.parse(autumn.to_at)-Date.parse(autumn.from_at),31*86400000+3600000,'31 calendar days include the repeated hour');
 assert.throws(()=>performancePeriod('2026-09-01','2026-10-02',now),e=>e.status===400);
 for(const [from,to] of [['2026-02-30','2026-03-01'],['bad','2026-11-01'],['2026-11-02','2026-11-01'],['2026-10-01','2026-11-01'],['2026-11-01','2026-12-01']])assert.throws(()=>performancePeriod(from,to,now),e=>e.status===400);
});
test('financial currencies, explicit acceptance and missing metrics remain separate',()=>{
 const rides=normalize([raw(),raw({order_reference:'REJECT',status:'driver_rejected',driver_accepted_datetime:null,pickup_datetime:null,finished_datetime:null,ride_duration_seconds:null,price:{total:null,currency:'MAD'}}),raw({order_reference:'NOANSWER',status:'driver_did_not_respond',driver_accepted_datetime:null,pickup_datetime:null,finished_datetime:null,price:{total:null,currency:'MAD'}}),raw({order_reference:'EURO',is_optional:true,price:{total:8,currency:'EUR'}})]).rows;
 const s=summarizeDriverPerformance({rides,period,source:'bolt'});assert.equal(s.counts.total,4);assert.equal(s.counts.accepted,2);assert.equal(s.counts.completed,2);assert.equal(s.counts.rejected,1);assert.equal(s.counts.unanswered,1);assert.equal(s.acceptance.value,1/3);assert.equal(s.money.length,2);assert.equal(s.money.find(m=>m.currency==='MAD').total,70);assert.ok(s.unavailable.net_earnings);assert.equal(s.coverage.complete,false);
 const missing=summarizeDriverPerformance({rides:normalize([raw({ride_duration_seconds:null})]).rows,period,source:'bolt'});assert.equal(missing.ride_seconds.value,null);assert.equal(missing.unavailable.earnings_per_hour.length>0,true);
});
test('sampled activity never fills gaps, conflicts or outages and never doubles overlapping identities',()=>{
 const at=t=>new Date(Date.parse(period.from_at)+t*1000).toISOString(),row=(t,status='available',id='one')=>({identity_id:id,status,observed_at:at(t)});
 const observations=[row(0),row(30),row(60),row(600),row(630,'on_break'),row(660,'on_break'),row(0,'available','two'),row(30,'available','two'),row(30,'on_trip','three'),row(60,'on_trip','three')];
 const s=summarizeDriverPerformance({period,source:'bolt',observations});assert.equal(s.activity.seconds.available,30);assert.equal(s.activity.seconds.on_break,30);assert.equal(s.activity.seconds.on_trip,0);assert.equal(s.activity.observed_seconds,60);
 const outage=summarizeDriverPerformance({period,source:'bolt',observations:[row(0),row(30)],sourceEvents:[{at:at(10),status:'paused'}]});assert.equal(outage.activity.observed_seconds,0);
 assert.equal(s.map_points.length,0);assert.ok(s.unavailable.gps_track);
});
test('observed connection includes explicit breaks while utilization uses working time excluding breaks and offline',()=>{
 const at=t=>new Date(Date.parse(period.from_at)+t*1000).toISOString(),pair=(start,status,id='one')=>[start,start+60].map(t=>({identity_id:id,status,observed_at:at(t)}));
 const observations=[...pair(0,'on_trip'),...pair(120,'available'),...pair(240,'to_pickup'),...pair(360,'on_break'),...pair(480,'offline'),...pair(360,'on_break','overlap')];
 const {activity}=summarizeDriverPerformance({period,source:'bolt',observations});
 assert.equal(activity.seconds.on_break,60);assert.equal(activity.observed_seconds,300);
 assert.equal(activity.online_observed_seconds,240);assert.equal(activity.working_observed_seconds,180);assert.equal(activity.utilization_observed,1/3);
 const paused=summarizeDriverPerformance({period,source:'bolt',observations:pair(0,'on_break')}).activity;
 assert.equal(paused.online_observed_seconds,60);assert.equal(paused.working_observed_seconds,0);assert.equal(paused.utilization_observed,null);
 const offline=summarizeDriverPerformance({period,source:'bolt',observations:pair(0,'offline')}).activity;
 assert.equal(offline.online_observed_seconds,0);assert.equal(offline.working_observed_seconds,0);assert.equal(offline.utilization_observed,null);
});
test('official Uber summaries require an exact interval and cannot combine overlapping organizations',()=>{
 const official={source:'uber',organization_id:'one',report_type:'driver_activity',period_from:period.from_at,period_to:period.to_at,reported_at:'2026-11-02T10:00:00Z',trips_completed:5,online_seconds:7200};
 const exact=summarizeDriverPerformance({period,source:'uber',officialSummaries:[official]});assert.equal(exact.official.activity.trips_completed,5);
 const overlap=summarizeDriverPerformance({period,source:'uber',officialSummaries:[{...official,period_from:'2026-10-30T23:00:00Z'}]});assert.equal(overlap.official.activity,null);assert.equal(overlap.official.other_periods,1);
 const companies=summarizeDriverPerformance({period,source:'uber',officialSummaries:[official,{...official,organization_id:'two'}]});assert.equal(companies.official.activity,null);
});
test('available Uber periods use actual full Moroccan days, newest first, without combining organizations or prorating',()=>{
 const row=(from,to,extra={})=>{const p=performancePeriod(from,to,now);return {source:'uber',organization_id:'one',report_type:'driver_activity',period_from:p.from_at,period_to:p.to_at,...extra};};
 const reports=[row('2026-10-19','2026-10-25'),row('2026-10-26','2026-11-01'),row('2026-10-26','2026-11-01',{report_type:'driver_quality'}),row('2026-10-20','2026-10-26'),row('2026-10-20','2026-10-26',{organization_id:'two',report_type:'driver_quality'}),row('2026-10-30','2026-11-01',{period_from:'2026-10-30T02:00:00Z'}),row('2026-10-30','2026-11-01',{period_to:'2026-11-05T00:00:00Z'}),row('2026-10-30','2026-11-01',{source:'bolt'}),row('2026-10-30','2026-11-01',{report_type:'trip_activity'})];
 assert.deepEqual(availableUberReportPeriods(reports,{now}),[{from:'2026-10-26',to:'2026-11-01',report_types:['driver_activity','driver_quality']},{from:'2026-10-19',to:'2026-10-25',report_types:['driver_activity']}]);
 assert.deepEqual(availableUberReportPeriods([],{now}),[]);
});

function fixture({providerFail=false,pageMutation}={}){
 const calls=[],providerCalls=[],timers=[],user=randomUUID();let time=now,release=null;
 const data={profiles:[],fleet_drivers:[{id:driver,name:'Synthetic Driver',ludy_driver_code:'SYNTHETIC',agency_id:1},{id:other,name:'Other Agency',agency_id:2}],fleet_identities:identities,fleet_sources:[{id:'bolt',status:'healthy'}],fleet_rides:[],fleet_observations:[],fleet_source_events:[],fleet_driver_performance_sync:[],fleet_driver_report_summaries:[]};
 const fetchFn=async(url,options={})=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421');const token=options.headers.Authorization.slice(7);if(u.pathname==='/auth/v1/user')return ['admin','viewer','pending'].includes(token)?Response.json({id:user}):Response.json({},{status:401});
  const table=u.pathname.split('/').at(-1),params=Object.fromEntries(u.searchParams),body=options.body?JSON.parse(options.body):null;calls.push({table,params,body,token,method:options.method||'GET'});
  if(table==='profiles')return Response.json([{role:token}]);
  if(table==='fleet_import_bolt_performance'){assert.equal(token,'service');data.fleet_rides.push(...body.p_rows);return Response.json({imported:body.p_rows.length,drivers:body.p_coverage.length});}
  if(options.method==='POST'){assert.equal(token,'service');data[table].push(...(Array.isArray(body)?body:[body]));return Response.json([]);}
  assert.ok(Object.hasOwn(data,table),table);pageMutation?.(table,params,data);let rows=data[table].filter(r=>Object.entries(params).every(([key,v])=>v.startsWith('eq.')?String(r[key])===v.slice(3):true));if(token==='viewer'&&['fleet_drivers','fleet_identities','fleet_rides','fleet_driver_performance_sync','fleet_driver_report_summaries'].includes(table))rows=rows.filter(r=>(table==='fleet_drivers'?r.id:r.driver_id)===driver);rows=rows.slice(Number(params.offset||0),Number(params.offset||0)+Number(params.limit||1000));if(params.select&&params.select!=='*')rows=rows.map(row=>Object.fromEntries(params.select.split(',').filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])));return Response.json(rows);
 };
 const boltClient={rides:async(company,from,to,options)=>{providerCalls.push({company,from,to,options});if(release)await new Promise(resolve=>release.resolve=resolve);const failure=typeof providerFail==='function'?providerFail(company):providerFail;if(failure)throw failure instanceof Error?failure:Object.assign(Error('Bolt getRideHistory indisponible (code 498813)'),{status:502});return [raw()];}};
 const api=createDriverPerformanceApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',boltClient,fetchFn,now:()=>time,setTimer:(fn,ms)=>{const item={fn,ms};timers.push(item);return item;},clearTimer:()=>{}});
 async function call(path,{token='admin',body,origin='http://127.0.0.1:4173'}={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/driver-performance/'+path,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4173',origin,...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});let status,json;await api(req,{writeHead:s=>status=s,end:s=>json=JSON.parse(s)});return {status,data:json};}
 return {api,data,calls,providerCalls,timers,call,advance:ms=>time+=ms,hold:()=>{release={};return ()=>release.resolve?.();}};
}
test('performance API enforces staff authentication and caller RLS before any provider read',async()=>{
 const f=fixture();for(const [token,status] of [[null,401],['dps_'+'a'.repeat(43),401],['pending',403]])assert.equal((await f.call('drivers',{token})).status,status);
 const listing=await f.call('drivers',{token:'viewer'});assert.equal(listing.status,200);assert.equal(listing.data.drivers.length,1);assert.equal(listing.data.can_sync,false);
 const detail='detail?'+new URLSearchParams({driver_id:driver,source:'bolt',from:'2026-11-01',to:'2026-11-01'});assert.equal((await f.call(detail,{token:'viewer'})).status,200);
 assert.equal((await f.call(detail.replace(driver,other),{token:'viewer'})).status,404);
 assert.equal((await f.call('sync',{token:'viewer',body:{driver_id:driver,from:'2026-11-01',to:'2026-11-01'}})).status,403);assert.equal(f.providerCalls.length,0);
 assert.equal((await f.call('drivers',{origin:'https://foreign.invalid'})).status,403);
 assert.ok(f.calls.filter(c=>['fleet_drivers','fleet_rides','fleet_observations','fleet_driver_performance_sync'].includes(c.table)).every(c=>c.token==='viewer'));
});
test('Uber period availability is driver-scoped under caller RLS and never reads another agency or a provider',async()=>{
 const f=fixture(),own=performancePeriod('2026-10-26','2026-11-01',now),foreign=performancePeriod('2026-10-25','2026-10-31',now);
 f.data.fleet_driver_report_summaries.push({source:'uber',organization_id:'org-one',driver_id:driver,report_type:'driver_activity',period_from:own.from_at,period_to:own.to_at},{source:'uber',organization_id:'org-two',driver_id:other,report_type:'driver_quality',period_from:foreign.from_at,period_to:foreign.to_at});
 const path='report-periods?driver_id='+driver,r=await f.call(path,{token:'viewer'});assert.equal(r.status,200);assert.deepEqual(r.data.periods,[{from:'2026-10-26',to:'2026-11-01',report_types:['driver_activity']}]);
 const read=f.calls.find(c=>c.table==='fleet_driver_report_summaries');assert.equal(read.token,'viewer');assert.equal(read.params.driver_id,'eq.'+driver);assert.equal(read.params.source,'eq.uber');assert.doesNotMatch(JSON.stringify(r.data),/org-two|2026-10-25/);
 const count=f.calls.filter(c=>c.table==='fleet_driver_report_summaries').length;assert.equal((await f.call('report-periods?driver_id='+other,{token:'viewer'})).status,404);assert.equal(f.calls.filter(c=>c.table==='fleet_driver_report_summaries').length,count);
 assert.equal((await f.call(path,{token:'pending'})).status,403);assert.equal((await f.call(path,{token:null})).status,401);assert.equal(f.providerCalls.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
 f.data.fleet_driver_report_summaries=[];assert.deepEqual((await f.call(path,{token:'viewer'})).data.periods,[]);
});
test('manual Bolt read is bounded, UUID-filtered, atomic locally and throttled',async()=>{
 const f=fixture(),body={driver_id:driver,from:'2026-11-01',to:'2026-11-01'},r=await f.call('sync',{body});assert.equal(r.status,200);assert.equal(f.providerCalls.length,1);assert.deepEqual(f.providerCalls[0].options.driverUuids,[external]);assert.equal(f.providerCalls[0].company,123);
 const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].table,'fleet_import_bolt_performance');assert.doesNotMatch(JSON.stringify(writes),/PRIVATE/);
 assert.equal((await f.call('sync',{body})).status,429);assert.equal(f.providerCalls.length,1);
 assert.equal((await f.call('sync',{body:{...body,from:'2026-01-01'}})).status,400);assert.equal(f.providerCalls.length,1);
});
test('automatic reads initialize seven days, skip paused connectors and do not overlap manual reads',async()=>{
 const f=fixture();await f.api.resume();assert.equal(f.timers[0].ms,3000);await f.api.collect();assert.equal(f.providerCalls.length,1);assert.equal(Date.parse(f.providerCalls[0].to)-Date.parse(f.providerCalls[0].from),7*86400000);
 f.advance(15*60000);f.data.fleet_sources[0].status='paused';await f.api.collect();assert.equal(f.providerCalls.length,1);f.data.fleet_sources[0].status='healthy';
 const release=f.hold(),pending=f.api.collect();await new Promise(r=>setImmediate(r));assert.equal((await f.call('sync',{body:{driver_id:driver,from:'2026-11-01',to:'2026-11-01'}})).status,409);release();await pending;f.api.close();
});
test('provider failure stores only safe error metadata and never commits partial rides',async()=>{
 const f=fixture({providerFail:true}),r=await f.call('sync',{body:{driver_id:driver,from:'2026-11-01',to:'2026-11-01'}});assert.equal(r.status,502);assert.equal(f.data.fleet_rides.length,0);assert.equal(f.data.fleet_driver_performance_sync[0].status,'error');assert.doesNotMatch(JSON.stringify(f.data.fleet_driver_performance_sync),/PRIVATE|token|secret/);
});
test('performance automation and manual reads keep the full two-hour provider cooldown',async()=>{
 let limited=true;const f=fixture({providerFail:()=>limited?Object.assign(Error('Quota Bolt atteint'),{status:429,retryAfter:7200}):false});
 await f.api.resume();f.advance(3000);await f.timers[0].fn();assert.equal(f.providerCalls.length,1);assert.equal(f.timers.at(-1).ms,7200000);
 f.advance(3600000);await assert.rejects(f.api.collect(),e=>e.status===429);assert.equal(f.providerCalls.length,1);
 f.advance(3599999);await assert.rejects(f.api.collect(),e=>e.status===429);assert.equal(f.providerCalls.length,1);
 f.advance(1);limited=false;await f.api.collect();assert.equal(f.providerCalls.length,2);f.api.close();
});
test('long performance waits split timers without advancing the provider deadline',async()=>{
 let limited=true;const delay=3000000000,f=fixture({providerFail:()=>limited?Object.assign(Error('Quota Bolt atteint'),{status:429,retryAfter:delay/1000}):false});
 await f.api.resume();f.advance(3000);await f.timers[0].fn();assert.equal(f.timers.at(-1).ms,2147483647);
 f.advance(2147483647);await f.timers.at(-1).fn();assert.equal(f.providerCalls.length,1);assert.equal(f.timers.at(-1).ms,delay-2147483647);
 limited=false;f.advance(delay-2147483647);await f.timers.at(-1).fn();assert.equal(f.providerCalls.length,2);f.api.close();
});

test('provider timestamps require an explicit zone and cannot describe an impossible or reversed chronology',()=>{
 for(const change of [{request_created_datetime:'2026-11-01T08:00:00'},{request_created_datetime:'2026-02-30T08:00:00Z'},{driver_accepted_datetime:'2026-11-01T07:59:00Z'},{driver_accepted_datetime:'2026-11-01T08:10:00Z'},{pickup_datetime:null,finished_datetime:'2026-11-01T07:59:00Z'}])assert.throws(()=>normalize([raw(change)]));
 assert.equal(normalize([raw({request_created_datetime:'2026-11-01T09:00:00+01:00'})]).rows[0].requested_at,'2026-11-01T08:00:00.000Z');
});
test('pagination has deterministic tie breakers and refuses a repeated ride rather than double-counting it',async()=>{
 const f=fixture({pageMutation:(table,params,data)=>{if(table==='fleet_rides'&&params.offset==='1000')data.fleet_rides.unshift({...data.fleet_rides[0],external_id:'NEW-RIDE'});}});
 f.data.fleet_rides=Array.from({length:1001},(_,i)=>({...normalize([raw()]).rows[0],external_id:'RIDE-'+i}));
 const path='detail?'+new URLSearchParams({driver_id:driver,source:'bolt',from:'2026-11-01',to:'2026-11-01'}),result=await f.call(path);
 assert.equal(result.status,502);assert.equal(result.data.counts,undefined);assert.equal(f.providerCalls.length,0);
 const pages=f.calls.filter(c=>c.table==='fleet_rides');assert.equal(pages.length,2);assert.equal(pages[0].params.order,'requested_at.desc.nullslast,external_id,source,organization_id');
});
test('a provider reply after service close cannot commit rides or error metadata',async()=>{
 const f=fixture(),release=f.hold(),pending=f.api.collect();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.providerCalls.length,1);
 f.api.close();release();await assert.rejects(pending,/arrêtée/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.data.fleet_rides.length,0);
});
test('one unavailable Bolt company does not prevent the remaining companies from refreshing',async()=>{
 const f=fixture({providerFail:company=>company===123});f.data.fleet_identities.push({...identities[0],id:randomUUID(),driver_id:other,external_id:randomUUID(),organization_id:'456'});
 const result=await f.api.collect();assert.equal(result.failed_companies,1);assert.deepEqual(f.providerCalls.map(c=>c.company),[123,456]);assert.equal(f.calls.filter(c=>c.table==='fleet_import_bolt_performance').length,1);assert.equal(f.calls.find(c=>c.table==='fleet_import_bolt_performance').body.p_org,'456');f.api.close();
});

test('UUID letter case cannot silently drop a known Bolt driver or bypass identity conflicts',()=>{
 const row=normalize([raw({driver:{uuid:external.toUpperCase()}})]).rows[0];assert.equal(row.driver_id,driver);assert.equal(row.provider_driver_id,external);
 const conflicted=[...identities,{...identities[0],driver_id:other,external_id:external.toUpperCase()},identities[0]];
 const result=normalizeBoltPerformance([raw()],{organizationId:'123',identities:conflicted,from:period.from_at,to:period.to_at,now});assert.equal(result.rows.length,0);assert.equal(result.counts.unmatched,1);
});
