import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {normalizeUberCsv,publicPickupLabel,uberReportPeriod,assertUberReportSource,createUberReportsApi} from '../server/uber-reports.mjs';
const now=Date.parse('2026-11-02T10:00:00Z'),org='692d0268-9766-4061-9c0e-85d7c124d10e',trip1='11111111-1111-4111-8111-111111111111',trip2='22222222-2222-4222-8222-222222222222';
const config={id:1,enabled:true,organization_id:org,city_agencies:{Casablanca:1,Marrakech:2},date_format:'dmy',csv_timezone:'Africa/Casablanca',revision:1};
const line=(id,address,status='completed')=>`${id},2026-11-01T10:00:00Z,"${address}",${status},Private Passenger,private@example.invalid`;
const csv=(rows=[line(trip1,'124 Rue Exemple, Casablanca'),line(trip2,'99 Avenue Exemple, Marrakech')])=>'Trip UUID,Trip request time,Pickup address,Trip status,Rider name,Driver email\n'+rows.join('\n');
test('header matching imports two city agencies without passenger data or street numbers',()=>{
 const result=normalizeUberCsv(csv(),config,{now});assert.equal(result.batches.length,2);assert.equal(result.counts.imported,2);assert.deepEqual(result.batches.map(row=>[row.city,row.agency_id]),[['Casablanca',1],['Marrakech',2]]);
 const value=JSON.stringify(result);assert.doesNotMatch(value,/Private Passenger|private@example|124 Rue|99 Avenue/);assert.match(value,/Rue Exemple, Casablanca/);
 assert.equal(publicPickupLabel('25 Rue Public, appartement 4, +212 612345678, name@example.invalid, Casablanca'),'Rue Public, Casablanca');
 const fr='Identifiant de la course;Heure de demande de course;Adresse de prise en charge;Statut de la course\n'+trip1+';01/11/2026 11:00;"12 Rue Exemple, Casablanca";Terminée';assert.equal(normalizeUberCsv(fr,config,{now}).batches[0].rows[0].started_at,'2026-11-01T11:00:00.000Z');
});
test('excluded trip states and unknown cities are counted without inventing demand or a location',()=>{
 const rows=[line(trip1,'12 Rue Exemple, Casablanca','rider_cancelled'),line(trip2,'23 Rue Exemple, Marrakech','reserved'),line(randomUUID(),'Quartier inconnu'),line(randomUUID(),'Rue Casablanca, Marrakech'),line(randomUUID(),'Rue Exemple, Marrakech')];
 const result=normalizeUberCsv(csv(rows),{...config,city_agencies:{Casablanca:1}},{now});assert.equal(result.counts.cancelled,1);assert.equal(result.counts.excluded_status,1);assert.equal(result.counts.unlocated_city,2);assert.equal(result.counts.unconfigured_city,1);assert.equal(result.counts.imported,1);
 assert.equal(normalizeUberCsv(csv([line(trip1,'Unknown area')]),config,{now}).batches.length,0);
});
test('malformed, ambiguous, incomplete and contradictory reports fail closed',()=>{
 for(const bad of [csv().replace('Trip UUID','Driver UUID'),csv().replace('Rider name','Trip UUID'),csv([line(trip1,'Casablanca','new_status')]),csv([line(trip1,'Casablanca'),line(trip1,'Marrakech')]),csv([line('not-a-uuid','Casablanca')]),csv()+'\n"unfinished',csv()+'\nextra,columns',csv().replace('2026-11-01T10:00:00Z','not a date'),'<html>private data</html>'])assert.throws(()=>normalizeUberCsv(bad,config,{now}));
 const duplicated=normalizeUberCsv(csv([line(trip1,'Casablanca'),line(trip1,'Casablanca')]),config,{now});assert.equal(duplicated.counts.imported,1);assert.equal(duplicated.counts.duplicates,1);
});
test('report period follows Morocco and source URLs are exact organization report pages',()=>{
 assert.deepEqual(uberReportPeriod(Date.parse('2026-11-01T23:30:00Z')),{start_date:'2026-10-25',end_date:'2026-10-31'});
 assert.equal(assertUberReportSource('https://fleethub.uber.com/orgs/'+org+'/reports',org),'/orgs/'+org+'/reports');
 for(const url of ['https://evil.invalid/orgs/'+org+'/reports','https://fleethub.uber.com/orgs/'+randomUUID()+'/reports','https://fleethub.uber.com/orgs/'+org+'/livemap','https://fleethub.uber.com/orgs/'+org+'/reports?secret=abc','https://user:password@fleethub.uber.com/orgs/'+org+'/reports'])assert.throws(()=>assertUberReportSource(url,org));
});
test('automatic imports enforce the exact seven complete Moroccan days without guessing ambiguous CSV dates',()=>{
 const reportAt=value=>csv([line(trip1,'Casablanca').replace('2026-11-01T10:00:00Z',value)]);
 const strict={...config,date_format:'ymd'};
 for(const value of ['2026-10-26T00:00:00Z','2026-11-01T23:59:59Z','2026-10-26 00:00','2026-11-01 23:59:59'])assert.equal(normalizeUberCsv(reportAt(value),strict,{now}).counts.imported,1,value);
 for(const value of ['2026-10-25T23:59:59Z','2026-11-02T00:00:00Z','2026-10-25 23:59:59','2026-11-02 00:00'])assert.throws(()=>normalizeUberCsv(reportAt(value),strict,{now}),/hors période/,value);
 assert.throws(()=>normalizeUberCsv(reportAt('01/11/2026 11:00'),strict,{now}),/invalide/);
 assert.equal(normalizeUberCsv(reportAt('2026-11-01 11:00'),config,{now}).batches[0].rows[0].started_at,'2026-11-01T11:00:00.000Z');
 const ramadanNow=Date.parse('2026-02-17T10:00:00Z');assert.equal(normalizeUberCsv(reportAt('2026-02-16T23:30:00Z'),strict,{now:ramadanNow}).counts.imported,1,'Morocco is UTC during Ramadan');
});
function fixture({reportFiles=null,browserLease=null,commitError=false}={}){
 const adminId=randomUUID(),calls=[],state={...config},agencies=[{id:1,name:'Synthetic Casa',city:'CASABLANCA'},{id:2,name:'Synthetic Marrakech',city:'Marrakech'}];let pairCalls=0;
 const fetchFn=async(url,options={})=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421','report backend never fetches supplied URLs or providers');const table=u.pathname.split('/').at(-1),token=options.headers.Authorization.slice(7),method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;calls.push({table,token,method,body,params:Object.fromEntries(u.searchParams)});
  if(u.pathname==='/auth/v1/user')return ['admin','viewer'].includes(token)?Response.json({id:adminId}):Response.json({}, {status:401});
  if(table==='profiles')return Response.json([{role:token==='admin'?'admin':'viewer'}]);
  if(table==='uber_report_settings'){if(method==='PATCH')Object.assign(state,body);return Response.json([{...state}]);}
  if(table==='agencies')return Response.json(agencies.filter(row=>!u.searchParams.has('id')||u.searchParams.get('id')==='eq.'+row.id));
  if(table==='fleet_identities')return Response.json([{organization_id:org},{organization_id:org}]);
  if(table==='uber_driver_report_imports')return Response.json([]);
  if(table==='uber_report_configure'){Object.assign(state,{enabled:body.p_enabled,organization_id:body.p_org,organization_label:body.p_org_label,csv_timezone:body.p_csv_timezone,city_agencies:body.p_mapping,date_format:body.p_format,revision:state.revision+1});return Response.json(state);}
  if(table==='uber_driver_report_commit')return commitError?Response.json({}, {status:500}):Response.json({duplicate:false,counts:body.p_counts,results:body.p_batches.map(row=>({city:row.city,agency_id:row.agency_id,result:{inserted:row.rows.length}}))});
  throw Error('Unknown local route '+table);
 };
 const pair='ludy_uber_'+'a'.repeat(43),api=createUberReportsApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',fetchFn,reportFiles,browserLease,now:()=>now,authorizePair:async req=>{pairCalls++;if(req.headers.authorization!=='Bearer '+pair)throw Object.assign(Error('Revoked pair'),{status:401});}});
 async function call(path,{body,token='admin',origin='http://127.0.0.1:4173',method=body===undefined?'GET':'POST'}={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/uber-reports/'+path,method,headers:{host:'127.0.0.1:4173',origin,...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});let status,data;const headers={};await api(req,{writeHead:value=>status=value,setHeader:(key,value)=>headers[key]=value,end:value=>data=value?JSON.parse(value):undefined});return {status,data,headers};}
 const report=()=>({organizationId:org,reportType:'trip_activity',filename:'uber.csv',csv:csv(),sourceUrl:'https://fleethub.uber.com/orgs/'+org+'/reports'});
 return {call,calls,pair,report,state,adminId,pairCalls:()=>pairCalls};
}
test('settings are administrator-only; extension pair tokens can access only the bridge',async()=>{
 const f=fixture();assert.equal((await f.call('settings',{token:'viewer'})).status,403);assert.equal((await f.call('settings',{origin:'chrome-extension://synthetic'})).status,403);assert.equal((await f.call('settings',{token:f.pair})).status,401);
 assert.equal((await f.call('bridge/config',{token:'admin',origin:'chrome-extension://synthetic'})).status,401);assert.equal(f.pairCalls(),0);
 const read=await f.call('bridge/config',{token:f.pair,origin:'chrome-extension://synthetic'});assert.equal(read.status,200);assert.equal(read.data.organization_id,org);assert.equal(read.data.interval_seconds,21600);assert.equal(read.data.settings,undefined);
 const view=await f.call('settings');assert.equal(view.status,200);assert.deepEqual(view.data.organizations,[org]);assert.equal(f.calls.some(row=>row.method==='POST'),false);
});
test('Chrome and Firefox bridge preflights have narrow CORS and do not require or validate pairing',async()=>{
 const f=fixture();for(const origin of ['chrome-extension://synthetic','moz-extension://synthetic']){const preflight=await f.call('bridge/ingest',{method:'OPTIONS',token:null,origin});assert.equal(preflight.status,204);assert.equal(preflight.headers['Access-Control-Allow-Origin'],origin);assert.equal(preflight.headers['Access-Control-Allow-Headers'],'Authorization, Content-Type');assert.equal(preflight.headers['Access-Control-Allow-Methods'],'GET, POST, OPTIONS');}
 assert.equal(f.pairCalls(),0);assert.equal(f.calls.length,0);assert.equal((await f.call('bridge/config',{method:'OPTIONS',origin:'https://foreign.invalid'})).status,403);assert.equal((await f.call('settings',{method:'OPTIONS'})).status,405);
});
test('city mappings must match real agencies and activation is explicit',async()=>{
 const f=fixture();for(const body of [null,[],{enabled:true,date_format:'dmy',organization_id:org,city_agencies:{Casablanca:2}},{enabled:true,date_format:'dmy',organization_id:org,city_agencies:{Unknown:1}},{enabled:true,date_format:'dmy',organization_id:null,city_agencies:{Casablanca:1}}])assert.equal((await f.call('settings',{body})).status,400);
 assert.equal(f.calls.some(row=>row.table==='uber_report_configure'),false);
 const saved=await f.call('settings',{body:{enabled:true,organization_id:org,city_agencies:{Casablanca:1,Marrakech:2},date_format:'dmy'}});assert.equal(saved.status,200);assert.equal(saved.data.settings.enabled,true);
});
test('an optional exact organization label is validated, trimmed and sent only through authenticated configuration',async()=>{
 const f=fixture(),settings={enabled:true,organization_id:org,city_agencies:{Casablanca:1,Marrakech:2},date_format:'dmy'};
 for(const organization_label of [false,123,{},[],'','  ','x'.repeat(161),'Fleet\nName','\tFleet','Fleet\u007f','Fleet\u0085']){
  assert.equal((await f.call('settings',{body:{...settings,organization_label}})).status,400);
 }
 assert.equal(f.calls.some(row=>row.table==='uber_report_configure'),false);
 const saved=await f.call('settings',{body:{...settings,organization_label:'  Synthetic Fleet & Partners  '}});
 assert.equal(saved.status,200);assert.equal(saved.data.settings.organization_label,'Synthetic Fleet & Partners');assert.equal(saved.data.bridge.organization_label,'Synthetic Fleet & Partners');
 assert.equal(f.calls.find(row=>row.table==='uber_report_configure').body.p_org_label,'Synthetic Fleet & Partners');
 assert.equal((await f.call('bridge/config',{token:f.pair,origin:'chrome-extension://synthetic'})).data.organization_label,'Synthetic Fleet & Partners');
 assert.equal((await f.call('settings',{body:{...settings,organization_label:'x'.repeat(160)}})).status,200);
 assert.equal((await f.call('settings',{body:{...settings,organization_label:null}})).data.settings.organization_label,null);
 assert.equal((await f.call('settings',{body:settings})).data.bridge.organization_label,null);
});
test('bridge refuses wrong organizations, revoked pairing, wrong pages and disabled collection before importing',async()=>{
 const f=fixture();const opts={token:f.pair,origin:'chrome-extension://synthetic'};
 for(const body of [{...f.report(),organizationId:randomUUID()},{...f.report(),reportType:'driver_status'},{...f.report(),sourceUrl:'https://evil.invalid/report'},{...f.report(),filename:'file.xlsx'}])assert.equal((await f.call('bridge/ingest',{...opts,body})).status,400);
 assert.equal((await f.call('bridge/ingest',{...opts,token:'ludy_uber_'+'b'.repeat(43),body:f.report()})).status,401);assert.equal(f.calls.some(row=>row.table==='uber_driver_report_commit'),false);
 f.state.enabled=false;assert.equal((await f.call('bridge/ingest',{...opts,body:f.report()})).status,409);
});
test('one authenticated report invokes one atomic multi-city RPC without retaining raw CSV or extra PII',async()=>{
 const f=fixture(),result=await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body:f.report()});assert.equal(result.status,200);assert.equal(result.data.counts.imported,2);
 const commits=f.calls.filter(row=>row.table==='uber_driver_report_commit');assert.equal(commits.length,1);assert.equal(commits[0].body.p_batches.length,2);assert.equal(commits[0].body.p_revision,1);assert.match(commits[0].body.p_hash,/^[a-f0-9]{64}$/);
 const persisted=JSON.stringify(f.calls.filter(row=>row.method!=='GET').map(row=>row.body));assert.doesNotMatch(persisted,/Private Passenger|private@example|Trip UUID|124 Rue/);
 const bad=f.report();bad.csv=bad.csv.replace('Trip UUID','Driver UUID');assert.equal((await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body:bad})).status,400);assert.equal(f.calls.filter(row=>row.table==='uber_driver_report_commit').length,1);assert.equal(f.state.last_status,'error');
 const outside=f.report();outside.csv=outside.csv.replace('2026-11-01T10:00:00Z','2026-10-24T10:00:00Z');assert.equal((await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body:outside})).status,400);assert.equal(f.calls.filter(row=>row.table==='uber_driver_report_commit').length,1,'out-of-period rows cannot reach the atomic import');
});
test('driver summary types require the configured period and commit through the same isolated bridge',async()=>{
 const f=fixture(),opts={token:f.pair,origin:'moz-extension://synthetic'},body={...f.report(),reportType:'driver_activity',startDate:'2026-10-26',endDate:'2026-11-01',csv:'Driver UUID,Trips completed,Hours online,Hours on trip\n'+trip1+',14,26.5,12.25'};
 let result=await f.call('bridge/ingest',{...opts,body});assert.equal(result.status,200);let commit=f.calls.filter(r=>r.table==='uber_driver_report_commit').at(-1);assert.equal(commit.body.p_type,'driver_activity');assert.equal(commit.body.p_rows[0].online_seconds,95400);assert.deepEqual(commit.body.p_batches,[]);
 result=await f.call('bridge/ingest',{...opts,body:{...body,startDate:'2026-10-25'}});assert.equal(result.status,400);assert.match(result.data.error,/période/);
 result=await f.call('bridge/ingest',{...opts,body:{...body,reportType:'driver_quality',csv:'Driver UUID,Trips completed,Acceptance rate,Cancellation rate\n'+trip1+',14,0.85,0.05'}});assert.equal(result.status,200);commit=f.calls.filter(r=>r.table==='uber_driver_report_commit').at(-1);assert.equal(commit.body.p_rows[0].acceptance_rate,.85);
});
test('collector diagnostics persist only authenticated bounded operational metadata',async()=>{
 const f=fixture(),body={version:'0.6.3',collectorId:trip1,organizationId:org,active:true,status:'retrying',nextAttemptAt:'2026-11-02T10:01:00Z',reports:[{report_type:'trip_activity',status:'retrying',last_import_at:null,next_attempt_at:'2026-11-02T10:01:00Z'}],token:'SECRET_NOT_ALLOWED',csv:'PRIVATE_CSV_NOT_ALLOWED',message:'PRIVATE_BROWSER_URL_NOT_ALLOWED'};
 assert.equal((await f.call('bridge/status',{body,token:'admin',origin:'chrome-extension://synthetic'})).status,401);
 const result=await f.call('bridge/status',{body,token:f.pair,origin:'chrome-extension://synthetic'});assert.equal(result.status,200);
 assert.equal(f.state.collector_seen_at,'2026-11-02T10:00:00.000Z');assert.equal(f.state.collector_state.version,'0.6.3');assert.equal(f.state.collector_state.status,'retrying');
 assert.doesNotMatch(JSON.stringify(f.state.collector_state),/SECRET|PRIVATE|message|csv|token/);
 assert.equal(f.state.last_attempt_at,undefined,'heartbeat is not a report import attempt');
 for(const patch of [{version:'invalid'},{collectorId:'not-an-id'},{status:'made_up'},{nextAttemptAt:'2099-01-01'},{reports:[...body.reports,...body.reports]}])assert.equal((await f.call('bridge/status',{body:{...body,...patch},token:f.pair,origin:'chrome-extension://synthetic'})).status,400);
 assert.equal((await f.call('bridge/status',{body:{...body,organizationId:randomUUID()},token:f.pair,origin:'chrome-extension://synthetic'})).status,409);
});

test('a valid header-only export records zero activity without treating it as a broken connector',async()=>{
 const f=fixture(),body=f.report();body.csv=body.csv.split('\n')[0];
 const result=await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body});assert.equal(result.status,200);assert.equal(result.data.counts.received,0);assert.equal(result.data.counts.imported,0);assert.equal(result.data.counts.driver_rows,0);
 assert.equal(f.calls.filter(row=>row.table==='uber_driver_report_commit').length,1);
 for(const reportType of ['driver_activity','driver_quality']){const csv=reportType==='driver_activity'?'Driver UUID,Trips completed,Hours online,Hours on trip':'Driver UUID,Trips completed,Acceptance rate,Cancellation rate';const r=await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body:{...body,csv,reportType,startDate:'2026-10-26',endDate:'2026-11-01'}});assert.equal(r.status,200);assert.equal(r.data.counts.driver_rows,0);}
 assert.throws(()=>normalizeUberCsv('\n',config,{now}));
});

test('report diagnostics accept only known categories and discard arbitrary browser text',async()=>{
 const f=fixture(),body={version:'0.6.3',collectorId:trip1,organizationId:org,active:true,status:'action_required',reports:[{report_type:'trip_activity',status:'action_required',diagnostic:'organization_required'},{report_type:'driver_activity',status:'action_required',diagnostic:'PRIVATE_BROWSER_TEXT'}]};
 const result=await f.call('bridge/status',{body,token:f.pair,origin:'chrome-extension://synthetic'});assert.equal(result.status,200);assert.equal(f.state.collector_state.reports[0].diagnostic,'organization_required');assert.equal(f.state.collector_state.reports[1].diagnostic,null);assert.doesNotMatch(JSON.stringify(f.state),/PRIVATE_BROWSER_TEXT/);
});

test('form diagnostics keep only bounded control categories and clear after a successful read',async()=>{
 const f=fixture(),structure={scope:'dialog',matches:{report_type:0,start_date:1,end_date:1,generate:1,organization:1,raw:'PRIVATE_VALUE'},fields:[{field:'report_type',labels:1,tags:['INPUT','PRIVATE_TAG','INPUT'],roles:['combobox','PRIVATE_ROLE'],inputs:['text'],readonly:0,values:['empty','PRIVATE_VALUE'],raw:'PRIVATE_VALUE'},{field:'start_date',labels:1,tags:['INPUT'],roles:[],inputs:['text'],readonly:1,values:['date_ymd']},{field:'PRIVATE_FIELD',labels:1},{field:'report_type',labels:2}],raw:'PRIVATE_VALUE'};
 const body={version:'0.6.4',collectorId:trip1,organizationId:org,active:true,status:'action_required',reports:[{report_type:'trip_activity',status:'action_required',diagnostic:'form_unrecognized',structure}]};
 const send=()=>f.call('bridge/status',{body,token:f.pair,origin:'chrome-extension://synthetic'});
 assert.equal((await send()).status,200);
 const saved=f.state.collector_state.reports[0].structure;
 assert.deepEqual(saved.matches,{report_type:0,start_date:1,end_date:1,generate:1,organization:1});assert.equal(saved.fields.length,2);assert.deepEqual(saved.fields[0],{field:'report_type',labels:1,tags:['INPUT'],roles:['combobox'],inputs:['text'],readonly:0,values:['empty']});assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|raw/);
 body.reports[0].structure={scope:'document',matches:{start_date:-1,end_date:1.5,generate:1000},fields:[{field:'start_date',labels:99,readonly:-4}]};assert.equal((await send()).status,200);assert.equal(f.state.collector_state.reports[0].structure.matches.generate,0);assert.equal(f.state.collector_state.reports[0].structure.fields[0].labels,0);
 body.reports[0].structure={...structure,scope:'PRIVATE_SCOPE'};assert.equal((await send()).status,200);assert.equal(f.state.collector_state.reports[0].structure,null);
 body.reports[0].structure=structure;for(const status of ['ready','stopped','waiting','waiting_report']){body.reports[0].status=status;assert.equal((await send()).status,200);assert.equal(f.state.collector_state.reports[0].structure,null);assert.equal(f.state.collector_state.reports[0].diagnostic,null);}
 body.reports[0].status='action_required';body.reports[0].diagnostic='PRIVATE_DIAGNOSTIC';assert.equal((await send()).status,200);assert.equal(f.state.collector_state.reports[0].structure,null);
});

function privateStoreFixture({persistError=false,receiptError=false}={}){
 const writes=[],states=[];
 return {writes,states,async persistReport(input){if(persistError)throw Error('disk unavailable');writes.push(input);return {token:'a'.repeat(64),created:true,receipt:{file:'files/synthetic.csv',status:'pending'}};},async markImported(token){if(receiptError)throw Error('receipt unavailable');states.push(['imported',token]);return {status:'imported',file:'files/synthetic.csv'};},async markFailed(token){states.push(['failed',token]);return {status:'failed'};}};
}
function leaseFixture(){
 let state=null;
 const assertOwner=async owner=>{if(!state||state.collectorId!==owner.collectorId||state.userId!==owner.userId)throw Object.assign(Error('Wrong owner'),{status:409});return state;};
 return {current:async()=>state,assertOwner,async claim(owner){if(state)await assertOwner(owner);state={...owner,expiresAt:'2026-11-02T10:01:30.000Z'};return state;},heartbeat:assertOwner,async release(owner){await assertOwner(owner);state=null;return {released:true};}};
}
test('the dedicated browser may import exactly one explicitly dated earlier seven-day window',async()=>{
 const reportFiles=privateStoreFixture(),browserLease=leaseFixture(),f=fixture({reportFiles,browserLease}),collectorId=randomUUID();await f.call('browser/claim',{body:{collectorId}});
 const body={...f.report(),collectorId,startDate:'2026-10-25',endDate:'2026-10-31',csv:csv().replaceAll('2026-11-01T10:00:00Z','2026-10-31T10:00:00Z')};
 const result=await f.call('browser/ingest',{body});assert.equal(result.status,200);assert.equal(result.data.counts.period_lag_days,1);assert.equal(result.data.counts.report_start_date,'2026-10-25');assert.equal(result.data.counts.report_end_date,'2026-10-31');assert.deepEqual(reportFiles.writes[0].period,{start_date:'2026-10-25',end_date:'2026-10-31'});const committed=f.calls.find(row=>row.table==='uber_driver_report_commit');assert.equal(committed.body.p_from,'2026-10-25T00:00:00.000Z');assert.equal(committed.body.p_to,'2026-11-01T00:00:00.000Z');
 for(const dates of [{startDate:'2026-10-24',endDate:'2026-10-30'},{startDate:'2026-10-25',endDate:'2026-11-01'},{startDate:'2026-10-27',endDate:'2026-11-02'}])assert.equal((await f.call('browser/ingest',{body:{...body,...dates}})).status,400);
 const boundary=await f.call('browser/ingest',{body:{...body,csv:body.csv.replaceAll('2026-10-31T10:00:00Z','2026-11-01T00:00:00Z')}});assert.equal(boundary.status,200);assert.equal(boundary.data.counts.driver_rows,0);assert.equal(boundary.data.counts.driver_outside_request_period,2,'exact next-day midnight is excluded from the business period');assert.equal(f.calls.filter(row=>row.table==='uber_driver_report_commit').length,2);
 await f.call('browser/release',{body:{collectorId}});assert.equal((await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body})).status,400,'extension reports retain the exact configured period');
});
test('the dedicated browser requires an admin and a matching lease, without replacing Live Map pairing',async()=>{
 const reportFiles=privateStoreFixture(),browserLease=leaseFixture(),f=fixture({reportFiles,browserLease}),collectorId=randomUUID();
 assert.equal((await f.call('browser/claim',{token:'viewer',body:{collectorId}})).status,403);
 assert.equal((await f.call('browser/claim',{token:f.pair,body:{collectorId}})).status,401);
 assert.equal((await f.call('browser/claim',{body:{collectorId,userId:'ignored-client-user'}})).status,200);
 assert.equal((await browserLease.current()).userId,f.adminId);
 assert.equal((await f.call('browser/config?collectorId='+collectorId)).data.organization_id,org);
 assert.equal((await f.call('browser/config?collectorId='+randomUUID())).status,409);
 assert.equal((await f.call('bridge/config',{token:f.pair,origin:'chrome-extension://synthetic'})).status,409);
 assert.equal((await f.call('bridge/status',{token:f.pair,origin:'chrome-extension://synthetic',body:{version:'0.6.5',collectorId:randomUUID(),organizationId:org,active:false,status:'stopped',reports:[]}})).status,409);assert.equal(f.state.collector_seen_at,undefined);
 assert.equal((await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body:f.report()})).status,409);
 assert.equal((await f.call('browser/ingest',{body:{...f.report(),collectorId:randomUUID()}})).status,409);
 assert.equal(reportFiles.writes.length,0);
 const received=await f.call('browser/ingest',{body:{...f.report(),collectorId}});
 assert.equal(received.status,200);assert.deepEqual(received.data.local_file,{stored:true,status:'imported',file:'files/synthetic.csv'});
 assert.equal(reportFiles.writes.length,1);assert.equal(reportFiles.writes[0].csv,f.report().csv);assert.deepEqual(reportFiles.writes[0].period,{start_date:'2026-10-26',end_date:'2026-11-01'});assert.equal(reportFiles.writes[0].filename,undefined);
 assert.deepEqual(reportFiles.states,[['imported','a'.repeat(64)]]);
 const settings=await f.call('settings');assert.equal(settings.data.local_browser.active,true);assert.equal(settings.data.local_files.enabled,true);
 assert.equal((await f.call('browser/heartbeat',{body:{collectorId}})).status,200);
 assert.equal((await f.call('browser/release',{body:{collectorId}})).status,200);
 assert.equal((await f.call('bridge/config',{token:f.pair,origin:'chrome-extension://synthetic'})).status,200);
 assert.equal(f.calls.some(row=>/pair|link/.test(row.table)),false);
});

test('CSV validation precedes local storage and storage precedes the database commit',async()=>{
 const store=privateStoreFixture(),f=fixture({reportFiles:store}),opts={token:f.pair,origin:'chrome-extension://synthetic'};
 assert.equal((await f.call('bridge/ingest',{...opts,body:{...f.report(),csv:'not a report'}})).status,400);assert.equal(store.writes.length,0);
 const unavailable=privateStoreFixture({persistError:true}),g=fixture({reportFiles:unavailable});
 assert.equal((await g.call('bridge/ingest',{...opts,body:g.report()})).status,500);assert.equal(g.calls.some(row=>row.table==='uber_driver_report_commit'),false);
 const failed=privateStoreFixture(),h=fixture({reportFiles:failed,commitError:true});
 assert.equal((await h.call('bridge/ingest',{...opts,body:h.report()})).status,502);assert.deepEqual(failed.states,[['failed','a'.repeat(64)]]);
});

test('a structurally valid CSV with new business columns is retained for review without importing its rows',async()=>{
 const store=privateStoreFixture(),f=fixture({reportFiles:store});
 const body={...f.report(),csv:f.report().csv.replace('Trip UUID','Unsupported reference')};
 const result=await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body});
 assert.equal(result.status,400);assert.equal(store.writes.length,1);assert.equal(store.writes[0].csv,body.csv);assert.equal(f.calls.some(row=>row.table==='uber_driver_report_commit'),false);assert.deepEqual(store.states,[['failed','a'.repeat(64)]]);assert.deepEqual(result.data.local_file,{stored:true,status:'failed',file:'files/synthetic.csv'});
});

test('turning reports off revokes the local browser lease on its next heartbeat',async()=>{
 const browserLease=leaseFixture(),f=fixture({reportFiles:privateStoreFixture(),browserLease}),collectorId=randomUUID();
 assert.equal((await f.call('browser/claim',{body:{collectorId}})).status,200);f.state.enabled=false;
 assert.equal((await f.call('browser/heartbeat',{body:{collectorId}})).status,409);assert.equal(await browserLease.current(),null);
 assert.equal((await f.call('browser/ingest',{body:{...f.report(),collectorId}})).status,409);
});

test('a receipt write failure does not falsely report a successful database import as failed',async()=>{
 const store=privateStoreFixture({receiptError:true}),f=fixture({reportFiles:store});
 const result=await f.call('bridge/ingest',{token:f.pair,origin:'chrome-extension://synthetic',body:f.report()});
 assert.equal(result.status,200);assert.equal(result.data.local_file.status,'pending');assert.match(result.data.archive_warning,/Données importées/);assert.equal(f.calls.filter(row=>row.table==='uber_driver_report_commit').length,1);assert.deepEqual(store.states,[]);
});

test('CSV timezone must be confirmed before trip analysis, preserving the original and leaving summaries available',async()=>{
 const reportFiles=privateStoreFixture(),f=fixture({reportFiles});f.state.csv_timezone=null;const opts={token:f.pair,origin:'chrome-extension://synthetic'};
 const result=await f.call('bridge/ingest',{...opts,body:f.report()});assert.equal(result.status,400);assert.equal(result.data.code,'timezone_required');assert.equal(result.data.local_file.stored,true);assert.equal(reportFiles.writes.length,1);assert.equal(reportFiles.writes[0].csv,f.report().csv);assert.equal(f.calls.some(r=>r.table==='uber_driver_report_commit'),false);
 const summary={...f.report(),reportType:'driver_activity',startDate:'2026-10-26',endDate:'2026-11-01',csv:'Driver UUID,Trips completed,Hours online,Hours on trip\n'+trip1+',14,26.5,12.25'};assert.equal((await f.call('bridge/ingest',{...opts,body:summary})).status,200);
 const settings={enabled:true,organization_id:org,city_agencies:{Casablanca:1},date_format:'ymd'};
 for(const csv_timezone of ['UTC','Africa/Casablanca',null]){const result=await f.call('settings',{body:{...settings,csv_timezone}});assert.equal(result.status,200);assert.equal(result.data.settings.csv_timezone,csv_timezone);assert.equal(f.calls.filter(r=>r.table==='uber_report_configure').at(-1).body.p_csv_timezone,csv_timezone);}
 for(const csv_timezone of ['Europe/Paris','',1,{}])assert.equal((await f.call('settings',{body:{...settings,csv_timezone}})).status,400);
});
