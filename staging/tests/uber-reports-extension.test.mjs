import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {chromium} from 'playwright';
import {normalizeUberCsv,uberReportPeriod,assertUberReportSource} from '../server/uber-reports.mjs';
const root=new URL('../uber-extension/',import.meta.url),readerSource=await readFile(new URL('reports-reader.js',root),'utf8'),contentSource=await readFile(new URL('reports-content.js',root),'utf8'),backgroundSource=await readFile(new URL('reports-background.js',root),'utf8');
const ORG='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',TRIP='33333333-3333-4333-8333-333333333333',URL_REPORTS='https://fleethub.uber.com/orgs/'+ORG+'/reports',CSV='Trip UUID,Trip request time,Pickup address,Trip status\n'+TRIP+',2026-11-01 10:00,Centre Casablanca,completed\n';
const CONFIG={enabled:true,organization_id:ORG,report_type:'trip_activity',start_date:'2026-10-26',end_date:'2026-11-01',date_format:'dmy',interval_seconds:21600};
const CSV_TYPES={trip_activity:CSV,driver_activity:`Driver UUID,Trips completed,Hours online,Hours on trip\n${ORG},14,26.5,12.25`,driver_quality:`Driver UUID,Trips completed,Acceptance rate,Cancellation rate\n${ORG},14,0.85,0.05`};
let browser;before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});after(async()=>{await browser?.close();});
const form='<label>Report type<select id="kind"><option value="payments">Payments</option><option value="trips">Trip activity</option></select></label><label for="from">Start date</label><input id="from" type="date"><label for="until">End date</label><input id="until" type="date"><button id="generate">Generate</button>';
async function pageFixture(html,work,{timezoneId='Africa/Casablanca'}={}){
 const page=await browser.newPage({timezoneId}),requests=[];await page.route('**/*',route=>{const url=new URL(route.request().url());assert.equal(url.origin,'https://fleethub.uber.com');requests.push(url.pathname);if(url.pathname.endsWith('/reports'))return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body>'+html+'</body></html>'});if(url.pathname==='/download/activity.csv')return route.fulfill({contentType:'text/csv',body:CSV});throw Error('Unexpected UI request '+url.pathname);});
 await page.goto(URL_REPORTS);await page.addScriptTag({content:readerSource});try{await work(page,requests);}finally{await page.close();}
}
test('report UI only prepares the recognized trip report and exact named date fields',async()=>{
 await pageFixture(form,async page=>{
  const result=await page.evaluate(config=>{const state=LudyUberReportsReader.inspect(document,location.href,config);LudyUberReportsReader.prepare(state,config);window.generated=0;document.querySelector('#generate').onclick=()=>generated++;LudyUberReportsReader.generate(state,config);return {kind:state.select.value,start:state.start.value,end:state.end.value,generated};},CONFIG);
  assert.deepEqual(result,{kind:'trips',start:CONFIG.start_date,end:CONFIG.end_date,generated:1});
  for(const mutation of [{organization_id:OTHER},{start_date:'2026-02-30'},{end_date:'2026-09-01'}])assert.equal(await page.evaluate(config=>{try{LudyUberReportsReader.inspect(document,location.href,config);return false;}catch{return true;}},{...CONFIG,...mutation}),true);
 });
});
test('a matching completed report is read only from its rendered download link; other periods and foreign hosts are refused',async()=>{
 const row=(type,dates,url)=>`<tr><td>${type}</td><td>${dates}</td><td><a href="${url}">Download</a></td></tr>`;
 await pageFixture('<table>'+row('Payments','2026-10-26 – 2026-11-01','/download/payments.csv')+row('Trip activity','2026-10-26 – 2026-11-01','/download/activity.csv?signature=private-fixture')+'</table>',async(page,requests)=>{
  const result=await page.evaluate(async config=>{const state=LudyUberReportsReader.inspect(document,location.href,config);return {status:state.status,csv:await LudyUberReportsReader.readDownload(state.download.url,location.href)};},CONFIG);assert.equal(result.csv,CSV);assert.equal(result.status,'download');assert.equal(requests.filter(path=>path.includes('payments')).length,0);
 });
 for(const [dates,url]of [['2026-10-25 – 2026-11-01','/download/activity.csv'],['2026-10-26 – 2026-11-01','https://files.example.invalid/activity.csv']])await pageFixture('<table>'+row('Trip activity',dates,url)+'</table>',async(page,requests)=>{assert.equal(await page.evaluate(config=>{try{LudyUberReportsReader.inspect(document,location.href,config);return false;}catch{return true;}},CONFIG),true);assert.equal(requests.length,1);});
});
test('ambiguous report rows or controls, login pages and non-trip CSV cannot be silently accepted',async()=>{
 for(const html of [form+form,'<input type="password">','<button>Download</button>'])await pageFixture(html,async page=>assert.equal(await page.evaluate(config=>{try{LudyUberReportsReader.inspect(document,location.href,config);return false;}catch{return true;}},CONFIG),true));
 await pageFixture(form,async page=>{
  for(const csv of ['Driver UUID,Time online\na,1','<html>login</html>','Payment ID,Amount\na,20'])assert.equal(await page.evaluate(value=>{try{LudyUberReportsReader.validateCSV(value);return false;}catch{return true;}},csv),true);
  assert.equal(await page.evaluate(config=>{const start=document.querySelector('#from');start.id='unknown';document.querySelector('label[for="from"]').remove();try{LudyUberReportsReader.inspect(document,location.href,config);return false;}catch{return true;}},CONFIG),true);
 });
});
test('the browser and server agree on exact CSV aliases, delimiters and explicit date formats',async()=>{
 const documents=[CSV,`\ufeffsep=;\r\n"Trip id";"Trip request time";"Pick-up address";"Trip status"\r\n${TRIP};2026-11-01 10:00;Centre Casablanca;completed`, `Id de la course\tDate et heure de demande de course\tLieu de prise en charge\tStatut course\n${TRIP}\t01/11/2026 10:00\tCentre Casablanca\tTerminée`];
 await pageFixture(form,async page=>{
  for(const csv of documents){assert.equal(await page.evaluate(csv=>LudyUberReportsReader.validateCSV(csv),csv),csv);assert.equal(normalizeUberCsv(csv,{...CONFIG,city_agencies:{Casablanca:1}},{now:Date.parse('2026-11-02T10:00:00Z')}).counts.imported,1);}
  for(const csv of [CSV.replace('Trip UUID','Driver UUID'),CSV.replace('Trip status','Trip status,Trip UUID')])assert.equal(await page.evaluate(csv=>{try{LudyUberReportsReader.validateCSV(csv);return false;}catch{return true;}},csv),true);
 });
});
test('content generation is a one-step UI action and subsequent checks wait instead of requesting another export',async()=>{
 await pageFixture(form,async page=>{
  await page.evaluate(()=>{window.reservations=[];window.chrome={runtime:{id:'extension',onMessage:{addListener:fn=>window.reportListener=fn},sendMessage:async message=>{reservations.push({message,generated});return {ok:true,data:{reserved:true}};}}};window.generated=0;document.querySelector('#generate').onclick=()=>generated++;});await page.addScriptTag({content:contentSource});
  const call=message=>page.evaluate(message=>new Promise(resolve=>reportListener(message,{id:'extension'},resolve)),message);
  let result=await call({type:'LUDY_UBER_REPORTS_RUN',runId:'run',config:CONFIG,requested:false});assert.equal(result.result.status,'requested');assert.equal(await page.evaluate(()=>generated),1);assert.deepEqual(await page.evaluate(()=>reservations),[{message:{type:'LUDY_UBER_REPORTS_RESERVE',runId:'run'},generated:0}]);
  result=await call({type:'LUDY_UBER_REPORTS_RUN',runId:'run2',config:CONFIG,requested:true});assert.equal(result.result.status,'waiting');assert.equal(await page.evaluate(()=>generated),1);
  await page.evaluate(()=>{document.body.innerHTML='<table><tr><td>Trip activity</td><td>2026-10-26 – 2026-11-01</td><td><a href="/download/activity.csv">Download</a></td></tr></table>';});
  result=await call({type:'LUDY_UBER_REPORTS_RUN',runId:'run3',config:CONFIG,requested:true});assert.equal(result.result.status,'ready');assert.equal(result.result.csv,CSV);assert.equal(result.result.sourceUrl,URL_REPORTS);
 });
});
function workerFixture(saved={},options={}){
 let clock=Date.parse('2026-11-02T10:00:00Z'),token='synthetic-pairing-secret',permission=true,mode='ready',config=CONFIG,importResponse={ok:true,inserted:1};const requests=[],messages=[],injections=[],created=[],events={},alarms=new Map(),tabs=new Map([[1,{id:1,url:URL_REPORTS.replace('/reports','/livemap'),status:'complete'}]]);
 const event=name=>({addListener:fn=>{(events[name]??=[]).push(fn);}}),ID='extension',popup='chrome-extension://extension/popup.html';
 const api={runtime:{id:ID,getURL:file=>'chrome-extension://'+ID+'/'+file,onStartup:event('startup')},permissions:{contains:async()=>permission,onRemoved:event('permission')},storage:{},
  tabs:{get:async id=>{if(!tabs.has(id))throw Error('Missing tab');return tabs.get(id);},query:async()=>[...tabs.values()],create:async spec=>{created.push(spec);const tab={id:7,url:spec.url,status:'complete'};tabs.set(7,tab);return tab;},sendMessage:async(id,message)=>{messages.push({id,message});if(message.type==='LUDY_UBER_REPORTS_CANCEL')return {ok:true};const type=message.config.report_type;if(mode==='transient')return {ok:false,runId:message.runId,retryable:true,message:'Lecture interrompue par une interaction.'};if(['waiting','reserved_lost_reply'].includes(mode)&&!message.requested)await automation.handle({type:'LUDY_UBER_REPORTS_RESERVE',runId:message.runId},{id:ID,url:URL_REPORTS,tab:{id},frameId:0});if(mode==='reserved_lost_reply')return new Promise(()=>{});if(mode==='missing_activity'&&type==='driver_activity')return {ok:false,runId:message.runId,message:'Formulaire de ce rapport non reconnu.'};return {ok:true,runId:message.runId,result:mode==='ready'||mode==='missing_activity'?{status:'ready',organizationId:ORG,reportType:type,filename:'activity.csv',sourceUrl:URL_REPORTS,csv:CSV_TYPES[type]}:{status:message.requested?'waiting':'requested',message:'Waiting'}};},onUpdated:event('updated'),onRemoved:event('removed')},
  scripting:{executeScript:async spec=>{injections.push(spec);if(mode==='hanging')return new Promise(()=>{});}},alarms:{create:async(name,spec)=>alarms.set(name,spec),clear:async name=>alarms.delete(name),onAlarm:event('alarm')}};
 const storage={get:async()=>structuredClone(saved),set:async values=>Object.assign(saved,structuredClone(values))};
 const fetchFn=async(url,options)=>{assert.ok(url.startsWith('http://127.0.0.1:4173/api/uber-reports/bridge/'));requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/config')?config:importResponse};};
 const sandbox=vm.createContext({URL,TextEncoder,TextDecoder,Date,AbortController,AbortSignal,setTimeout,clearTimeout,crypto:webcrypto,fetch:fetchFn});vm.runInContext(readerSource,sandbox);vm.runInContext(backgroundSource,sandbox);const automation=sandbox.LudyUberReportsAutomation.create({api,storage,getPairing:()=>({token,collectorId:options.collectorId}),pairingReady:Promise.resolve(),fetchFn,now:()=>clock,...options});
 return {automation,requests,messages,injections,created,events,alarms,tabs,saved,advance:ms=>clock+=ms,setMode:value=>mode=value,setPermission:value=>permission=value,setConfig:value=>config=value,setImportResponse:value=>importResponse=value,call:type=>automation.handle({type},{id:ID,url:popup}),sender:{id:ID,url:URL_REPORTS,tab:{id:7},frameId:0}};
}
test('report automation opens a separate background tab, keeps pairing private and sends only to the fixed local bridge',async()=>{
 const f=workerFixture();await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 assert.deepEqual(structuredClone(f.created),[{url:URL_REPORTS,active:false}]);assert.equal(f.tabs.get(1).url,URL_REPORTS.replace('/reports','/livemap'));
 assert.ok(f.injections.every(spec=>spec.target.tabId===7));assert.ok(f.messages.every(({id,message})=>id===7&&!JSON.stringify(message).includes('synthetic-pairing-secret')));
 const sent=f.requests.find(request=>request.url.endsWith('/ingest'));assert.ok(sent);assert.equal(sent.options.headers.Authorization,'Bearer synthetic-pairing-secret');assert.equal(sent.options.credentials,'omit');assert.equal(sent.options.redirect,'error');assert.deepEqual(JSON.parse(sent.options.body),{organizationId:ORG,reportType:'trip_activity',filename:'uber-trip-activity-2026-10-26-2026-11-01.csv',sourceUrl:URL_REPORTS,csv:CSV});
 assert.ok(!JSON.stringify(f.saved).includes('synthetic-pairing-secret'));assert.ok(!JSON.stringify(f.saved).includes(TRIP));assert.equal(f.automation.publicState().status,'ready');
 const payload=JSON.parse(sent.options.body);assertUberReportSource(payload.sourceUrl,ORG);assert.deepEqual(uberReportPeriod(Date.parse('2026-11-02T10:00:00Z')),{start_date:CONFIG.start_date,end_date:CONFIG.end_date});assert.equal(normalizeUberCsv(payload.csv,{...CONFIG,city_agencies:{Casablanca:1,Marrakech:2}},{now:Date.parse('2026-11-02T10:00:00Z')}).counts.imported,1,'the real backend accepts the extension payload and date convention');
 f.advance(6*3600000-1);await f.automation.run({force:true});assert.equal(f.requests.filter(request=>request.url.endsWith('/ingest')).length,1,'tab reload cannot bypass the six-hour schedule');
 f.advance(1);await f.automation.run();assert.equal(f.requests.filter(request=>request.url.endsWith('/ingest')).length,2,'the existing report is read again after six hours to receive corrections');await f.automation.stop();
});
test('a requested report survives worker recreation without another Generate action and manual stop prevents wake-ups',async()=>{
 const f=workerFixture();f.setMode('waiting');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();assert.equal(f.saved.reportsConnector.jobs.trip_activity.requested_period,'2026-10-26:2026-11-01');
 const g=workerFixture(structuredClone(f.saved));g.tabs.set(7,{id:7,url:URL_REPORTS,status:'complete'});g.setMode('waiting');g.advance(60000);await g.automation.run();assert.equal(g.messages.find(row=>row.message.type==='LUDY_UBER_REPORTS_RUN').message.requested,true);
 await g.call('LUDY_UBER_REPORTS_STOP');const before=g.requests.length;g.advance(60000);await g.automation.run();assert.equal(g.requests.length,before);assert.equal(g.alarms.size,0);await f.automation.stop();
});
test('successful imports retain the six-hour delay through restart and a closed report tab',async()=>{
 const f=workerFixture();await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 for(const listener of f.events.removed||[])listener(7);f.tabs.delete(7);await new Promise(resolve=>setTimeout(resolve,0));
 const g=workerFixture(structuredClone(f.saved));
 for(const listener of g.events.startup||[])listener();await new Promise(resolve=>setTimeout(resolve,0));await g.automation.run({force:true});assert.equal(g.requests.length,0);
 g.advance(60000);g.tabs.set(8,{id:8,url:URL_REPORTS,status:'complete'});await g.automation.run({force:true});assert.equal(g.requests.length,0);
 g.advance(6*3600000-60000);await g.automation.run();assert.equal(g.requests.filter(request=>request.url.endsWith('/ingest')).length,1);await f.automation.stop();await g.automation.stop();
});
test('a slow export is only rechecked and resumes when its existing download becomes available',async()=>{
 const f=workerFixture();f.setMode('waiting');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 f.advance(16*60000);await f.automation.run();assert.equal(f.automation.publicState().status,'action_required');
 f.setMode('ready');f.advance(6*3600000);await f.automation.run();assert.equal(f.automation.publicState().status,'ready');assert.equal(f.requests.filter(request=>request.url.endsWith('/ingest')).length,1);
 const readings=f.messages.filter(row=>row.message.type==='LUDY_UBER_REPORTS_RUN');assert.deepEqual(readings.map(row=>row.message.requested),[false,true,true],'no second Generate action is requested');await f.automation.stop();
});
test('an empty usable report reports exclusions instead of promising an up-to-date analysis',async()=>{
 const f=workerFixture();f.setImportResponse({ok:true,duplicate:true,counts:{imported:0,unlocated_city:3,unconfigured_city:1,excluded_status:2,missing_cancelled_pickup:1}});await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();assert.match(f.automation.publicState().message,/aucune course exploitable/);assert.match(f.automation.publicState().message,/7 ligne/);assert.doesNotMatch(f.automation.publicState().message,/Analyse à jour/);await f.automation.stop();
});
test('three report types have independent sequential cycles and an unavailable type never blocks the others',async()=>{
 const f=workerFixture();f.setConfig({...CONFIG,report_types:['trip_activity','driver_activity','driver_quality']});f.setMode('missing_activity');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 f.advance(60000);await f.automation.run();f.advance(60000);await f.automation.run();
 const bodies=f.requests.filter(r=>r.url.endsWith('/ingest')).map(r=>JSON.parse(r.options.body));assert.deepEqual(bodies.map(b=>b.reportType),['trip_activity','driver_quality']);assert.equal(bodies[1].startDate,CONFIG.start_date);assert.equal(bodies[1].endDate,CONFIG.end_date);
 assert.deepEqual(f.messages.filter(r=>r.message.type==='LUDY_UBER_REPORTS_RUN').map(r=>r.message.config.report_type),['trip_activity','driver_activity','driver_quality']);
 const states=f.automation.publicState().reports;assert.equal(states.find(r=>r.report_type==='driver_activity').status,'action_required');assert.equal(states.find(r=>r.report_type==='driver_quality').status,'ready');assert.equal(f.tabs.get(1).url,URL_REPORTS.replace('/reports','/livemap'));
 const g=workerFixture(structuredClone(f.saved));g.setConfig({...CONFIG,report_types:['trip_activity','driver_activity','driver_quality']});g.tabs.set(7,{id:7,url:URL_REPORTS,status:'complete'});g.advance(3*60000);await g.automation.run();assert.equal(g.requests.length,0,'restart keeps each successful/unavailable job deadline');await f.automation.stop();await g.automation.stop();
});
test('activity and quality reports use their own exact headers and their own visible selector option',async()=>{
 const html=form.replace('</select>','<option value="drivers">Driver activity</option><option value="quality">Driver quality</option></select>');
 await pageFixture(html,async page=>{
  for(const [report_type,option] of [['driver_activity','drivers'],['driver_quality','quality']]){
   const result=await page.evaluate(config=>{const state=LudyUberReportsReader.inspect(document,location.href,config);LudyUberReportsReader.prepare(state,config);return state.select.value;},{...CONFIG,report_type});assert.equal(result,option);
   assert.equal(await page.evaluate(({csv,type})=>LudyUberReportsReader.validateCSV(csv,type),{csv:CSV_TYPES[report_type],type:report_type}),CSV_TYPES[report_type]);
   assert.equal(await page.evaluate(type=>{try{LudyUberReportsReader.validateCSV('Driver UUID,Trips completed,Hours online,Hours on trip\nx,1,1,1',type);return false;}catch{return true;}},'driver_quality'),true);
  }
 });
});
test('content senders cannot configure report automation and missing permission prevents every browser/provider action',async()=>{
 const f=workerFixture();await assert.rejects(f.automation.handle({type:'LUDY_UBER_REPORTS_START'},f.sender),/réservée/);assert.equal(f.requests.length,0);
 f.setPermission(false);await assert.rejects(f.call('LUDY_UBER_REPORTS_START'),/Autorisez/);assert.equal(f.requests.length,0);assert.equal(f.created.length,0);await f.automation.stop();
});

test('a browser operation without reply is bounded and the same worker can retry',async()=>{
 const f=workerFixture({}, {timeoutMs:40});f.setMode('hanging');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 assert.equal(f.automation.publicState().status,'retrying');assert.equal(f.requests.filter(r=>r.url.endsWith('/ingest')).length,0);
 f.setMode('ready');f.advance(60000);await f.automation.run();assert.equal(f.requests.filter(r=>r.url.endsWith('/ingest')).length,1);await f.automation.stop();
});
test('a user interaction is retried after a minute instead of blocking that report for six hours',async()=>{
 const f=workerFixture();f.setMode('transient');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();assert.equal(f.automation.publicState().status,'retrying');
 f.setMode('ready');f.advance(59999);await f.automation.run();assert.equal(f.requests.filter(r=>r.url.endsWith('/ingest')).length,0);
 f.advance(1);await f.automation.run();assert.equal(f.requests.filter(r=>r.url.endsWith('/ingest')).length,1);await f.automation.stop();
});
test('stop/start keeps the existing generation reservation and does not request a duplicate export',async()=>{
 const f=workerFixture();f.setMode('waiting');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 assert.equal(f.saved.reportsConnector.jobs.trip_activity.requested_period,'2026-10-26:2026-11-01');
 await f.automation.stop();await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();f.advance(60000);await f.automation.run();
 assert.deepEqual(f.messages.filter(r=>r.message.type==='LUDY_UBER_REPORTS_RUN').map(r=>r.message.requested),[false,true]);await f.automation.stop();
});
test('untrusted content cannot reserve or replay report generation',async()=>{
 const f=workerFixture();await assert.rejects(f.automation.handle({type:'LUDY_UBER_REPORTS_RESERVE',runId:'foreign'},f.sender),/hors de la page/);assert.equal(f.requests.length,0);await f.automation.stop();
});

test('the extension reports its version and liveness without source contents or the pairing secret',async()=>{
 const f=workerFixture({}, {collectorId:ORG});await f.call('LUDY_UBER_REPORTS_STATUS');await f.automation.publishStatus();
 const heartbeats=f.requests.filter(r=>r.url.endsWith('/status'));assert.equal(heartbeats.length,1);
 const body=JSON.parse(heartbeats[0].options.body);assert.equal(body.version,'0.6.6');assert.equal(body.active,false);assert.equal(body.collectorId,ORG);assert.doesNotMatch(JSON.stringify(body),/synthetic-pairing-secret|Trip UUID|csv/);
 f.advance(59999);await f.automation.publishStatus();assert.equal(f.requests.filter(r=>r.url.endsWith('/status')).length,1);
 f.advance(1);await f.automation.publishStatus();assert.equal(f.requests.filter(r=>r.url.endsWith('/status')).length,2);await f.automation.stop();
});

test('a lost acknowledgement after reserving generation survives worker restart without a second request',async()=>{
 const f=workerFixture({}, {timeoutMs:40});f.setMode('reserved_lost_reply');await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();
 assert.equal(f.saved.reportsConnector.jobs.trip_activity.requested_period,'2026-10-26:2026-11-01');assert.equal(f.automation.publicState().status,'retrying');
 const g=workerFixture(structuredClone(f.saved));g.tabs.set(7,{id:7,url:URL_REPORTS,status:'complete'});g.setMode('waiting');g.advance(60000);await g.automation.run();
 assert.equal(g.messages.find(r=>r.message.type==='LUDY_UBER_REPORTS_RUN').message.requested,true);assert.equal(g.automation.publicState().status,'waiting_report');await f.automation.stop();await g.automation.stop();
});

const landing='<h1>Reports</h1><button id="schedule">Create new schedule</button><button id="open-report">Generate Report</button><table><thead><tr><th>Report name</th><th>Report type</th><th>Report time range</th><th>Generated on</th></tr></thead></table>';
const drawer=`<aside role="dialog"><h2>Generate Report</h2><p>Generate one time report manually by selecting options below</p><div><span>Report type</span><select id="report-kind"><option value="activity">Driver Activity</option><option value="trips">Trip Activity</option><option value="quality">Driver Quality</option></select></div><div><span>Start of report</span><input id="report-from" value="2026/10/20"></div><div><span>End of report</span><input id="report-until" value="2026/10/25"></div><div><span>Start time</span><select id="time-from"><option value="12:00 AM">12:00 AM</option><option value="1:00 AM">1:00 AM</option></select></div><div><span>End time</span><select id="time-until"><option value="11:59 PM">11:59 PM</option><option value="1:00 AM">1:00 AM</option></select></div><div><span>Select organizations to include in report</span><button id="branches" aria-haspopup="listbox">Select organizations to include in report</button></div><section id="branch-options" hidden><input placeholder="Branches"><label><input id="branch-choice" type="checkbox">SYNTHETIC FLEET</label></section><button id="cancel-report">Cancel</button><button id="final-generate" disabled>Generate</button></aside>`;
async function contentFixture(page){await page.evaluate(()=>{window.reservations=[];window.generated=0;window.schedules=0;window.chrome={runtime:{id:'extension',onMessage:{addListener:fn=>window.reportListener=fn,removeListener(){}},sendMessage:async message=>{reservations.push({message,generated});return {ok:true,data:{reserved:true}};}}};});await page.addScriptTag({content:contentSource});}
async function wireDrawer(page){await page.evaluate(()=>{document.querySelector('#branches').onclick=()=>document.querySelector('#branch-options').hidden=!document.querySelector('#branch-options').hidden;document.querySelector('#branch-choice').onchange=event=>{document.querySelector('#branches').textContent=event.target.checked?'SYNTHETIC FLEET':'Select organizations to include in report';document.querySelector('#final-generate').disabled=!event.target.checked;};document.querySelector('#final-generate').onclick=()=>{generated++;document.querySelector('aside').remove();};});}
const contentCall=(page,extra={})=>page.evaluate(message=>new Promise(resolve=>reportListener(message,{id:'extension'},resolve)),{type:'LUDY_UBER_REPORTS_RUN',runId:'drawer-run',config:{...CONFIG,organization_label:'SYNTHETIC FLEET'},requested:false,...extra});
test('the real Reports landing opens its drawer and fills slash dates, full-day times and exact organization before reserving Generate',async()=>{
 await pageFixture(landing,async page=>{
  await contentFixture(page);await page.evaluate(html=>{document.querySelector('#schedule').onclick=()=>schedules++;document.querySelector('#open-report').onclick=()=>{document.body.insertAdjacentHTML('beforeend',html);document.querySelector('#branches').onclick=()=>document.querySelector('#branch-options').hidden=!document.querySelector('#branch-options').hidden;document.querySelector('#branch-choice').onchange=event=>{document.querySelector('#branches').textContent=event.target.checked?'SYNTHETIC FLEET':'Select organizations to include in report';document.querySelector('#final-generate').disabled=!event.target.checked;};document.querySelector('#final-generate').onclick=()=>{window.submitted={type:document.querySelector('#report-kind').value,start:document.querySelector('#report-from').value,end:document.querySelector('#report-until').value,startTime:document.querySelector('#time-from').value,endTime:document.querySelector('#time-until').value,organization:document.querySelector('#branch-choice').checked};generated++;document.querySelector('aside').remove();};};},drawer);
  const result=await contentCall(page);assert.equal(result.ok,true,result.message);assert.equal(result.result.status,'requested');assert.deepEqual(await page.evaluate(()=>submitted),{type:'trips',start:'2026/10/26',end:'2026/11/01',startTime:'12:00 AM',endTime:'11:59 PM',organization:true});assert.equal(await page.evaluate(()=>schedules),0);assert.deepEqual(await page.evaluate(()=>reservations.map(r=>r.generated)),[0]);
  const next=await contentCall(page,{requested:true});assert.equal(next.result.status,'waiting');assert.equal(await page.evaluate(()=>generated),1);assert.equal(await page.locator('aside').count(),0,'an already requested report does not reopen the drawer');
 });
});
test('unknown or ambiguous organizations and read-only wrong dates cannot reserve a report',async()=>{
 for(const mode of ['missing-label','duplicate','other-selected','read-only'])await pageFixture(landing+drawer,async page=>{
  await contentFixture(page);await wireDrawer(page);
  await page.evaluate(mode=>{if(mode==='duplicate')document.querySelector('#branch-options').insertAdjacentHTML('beforeend','<label><input type="checkbox">SYNTHETIC FLEET</label>');if(mode==='other-selected')document.querySelector('#branch-options').insertAdjacentHTML('beforeend','<label><input type="checkbox" checked>OTHER FLEET</label>');if(mode==='read-only')document.querySelector('#report-from').readOnly=true;},mode);
  const result=await contentCall(page,mode==='missing-label'?{config:CONFIG}:{});assert.equal(result.ok,false,mode);assert.equal(await page.evaluate(()=>generated),0);assert.equal(await page.evaluate(()=>reservations.length),0);
 });
});
test('custom report combobox uses its visible exact option and preserves full-day boundaries',async()=>{
 const html=drawer.replace('<select id="report-kind"><option value="activity">Driver Activity</option><option value="trips">Trip Activity</option><option value="quality">Driver Quality</option></select>','<button id="report-kind" role="combobox" aria-controls="types">Driver Activity</button><div id="types" role="listbox" hidden><div role="option">Driver Activity</div><div role="option">Trip Activity</div><div role="option">Driver Quality</div></div>');
 await pageFixture(landing+html,async page=>{
  await contentFixture(page);await wireDrawer(page);await page.evaluate(()=>{document.querySelector('#report-kind').onclick=()=>document.querySelector('#types').hidden=false;for(const node of document.querySelectorAll('[role="option"]'))node.onclick=()=>{document.querySelector('#report-kind').textContent=node.textContent;document.querySelector('#types').hidden=true;};document.querySelector('#time-from').value='1:00 AM';document.querySelector('#time-until').value='1:00 AM';});
  const result=await contentCall(page);assert.equal(result.ok,true,result.message);assert.equal(result.result.status,'requested');assert.equal(await page.evaluate(()=>generated),1);
 });
});
test('the visible dated period identifies the existing export and a button-only download does not request a duplicate',async()=>{
 const row='<tr><td>20261026-20261101-trip_activity</td><td>Trip Activity</td><td>October 26 – November 1, 2026</td><td>November 2, 2026</td><td>CONTROL</td></tr>';
 for(const [control,status]of [['<a href="/download/activity.csv">Download</a>','ready'],['<button>Download</button>','blocked']])await pageFixture(landing.replace('</table>',row.replace('CONTROL',control)+'</table>'),async page=>{
  await contentFixture(page);const result=await contentCall(page);if(status==='ready'){assert.equal(result.ok,true,result.message);assert.equal(result.result.status,'ready');}else{assert.equal(result.ok,false);assert.match(result.message,/bouton Download sans lien/);}assert.equal(await page.evaluate(()=>reservations.length),0);
 });
});

test('React replacement of type/date controls keeps preparation on the current rendered form',async()=>{
 await pageFixture(landing+drawer,async page=>{
  await contentFixture(page);await wireDrawer(page);
  await page.evaluate(()=>{for(const id of ['report-kind','report-from','report-until']){const node=document.getElementById(id);node.addEventListener('change',()=>{for(const input of document.querySelectorAll('aside input:not([type="checkbox"]),aside select')){const copy=input.cloneNode(true);copy.value=input.value;input.replaceWith(copy);}});}});
  const result=await contentCall(page);assert.equal(result.ok,true,result.message);assert.equal(result.result.status,'requested');assert.equal(await page.evaluate(()=>reservations.length),1);
 });
});
test('collector error diagnostics are predefined categories rather than page text or data',async()=>{
 await pageFixture(landing+drawer,async page=>{
  await contentFixture(page);await wireDrawer(page);const result=await contentCall(page,{config:CONFIG});assert.equal(result.diagnostic,'organization_required');
  assert.equal(await page.evaluate(()=>LudyUberReportsReader.diagnostic(Error('private customer name and email@example.invalid'))),null);
 });
});

test('a disabled report option or missing organization control cannot generate an export',async()=>{
 for(const mode of ['disabled','missing-organization'])await pageFixture(landing+drawer,async page=>{
  await contentFixture(page);await wireDrawer(page);
  await page.evaluate(mode=>{if(mode==='disabled')document.querySelector('#report-kind option[value="trips"]').disabled=true;else document.querySelector('#branches').remove();},mode);
  const result=await contentCall(page);assert.equal(result.ok,false,mode);assert.equal(await page.evaluate(()=>generated),0);assert.equal(await page.evaluate(()=>reservations.length),0);
 });
});

test('a manual START clears obsolete job errors while preserving an existing generation reservation',async()=>{
 const period=CONFIG.start_date+':'+CONFIG.end_date,old={active:true,url:URL_REPORTS,status:'action_required',enabled_types:['trip_activity','driver_activity','driver_quality'],next_attempt_at:Date.parse('2026-11-02T16:00:00Z'),jobs:Object.fromEntries(['trip_activity','driver_activity','driver_quality'].map(type=>[type,{status:'action_required',message:'OLD ERROR',diagnostic:'form_unrecognized',structure:{scope:'document'},requested_period:period,requested_at:Date.parse('2026-11-02T09:59:00Z'),next_attempt_at:Date.parse('2026-11-02T16:00:00Z')}]))};
 const f=workerFixture({reportsConnector:old});f.setConfig({...CONFIG,report_types:['trip_activity','driver_activity','driver_quality']});f.setMode('hanging');
 const state=await f.call('LUDY_UBER_REPORTS_START');assert.equal(state.active,true);assert.ok(state.reports.every(row=>row.status==='waiting'&&row.diagnostic===null&&row.structure===null&&!row.message.includes('OLD ERROR')));assert.ok(Object.values(f.saved.reportsConnector.jobs).every(job=>job.requested_period===period));await f.automation.stop();await f.automation.run();
});
test('slow report heartbeats remain ordered and START never publishes its internal stop as the current state',async()=>{
 const states=[];let release,first=true;const gate=new Promise(resolve=>release=resolve);
 const f=workerFixture({}, {collectorId:ORG,fetchFn:async(url,options)=>{if(url.endsWith('/status')){states.push(JSON.parse(options.body));if(first){first=false;await gate;}}return {ok:true,json:async()=>url.endsWith('/config')?CONFIG:{ok:true,inserted:1}};}});
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(states[0].active,false);
 await f.call('LUDY_UBER_REPORTS_START');await f.automation.run();assert.equal(states.length,1,'the initial delayed status cannot be overtaken by START');release();await f.automation.publishStatus({force:true});assert.ok(states.slice(1).every(row=>row.active===true&&row.status!=='stopped'));await f.automation.stop();await f.automation.publishStatus({force:true});assert.equal(states.at(-1).active,false);
});
test('form structure reports only bounded field categories, never values, names, URLs or identifiers',async()=>{
 await pageFixture(landing+drawer,async page=>{
  await page.evaluate(()=>{document.querySelector('#report-from').value='private-driver@example.invalid';document.querySelector('#branches').textContent='PRIVATE ORGANIZATION';document.querySelector('#branch-options').insertAdjacentHTML('beforeend','<div>PRIVATE CUSTOMER</div>');});
  const summary=await page.evaluate(()=>LudyUberReportsReader.structure(document));assert.equal(summary.scope,'dialog');assert.equal(summary.matches.report_type,1);assert.equal(summary.matches.start_date,1);assert.equal(summary.matches.end_date,1);assert.equal(summary.matches.organization,1);assert.equal(summary.matches.generate,1);
  assert.equal(summary.fields.find(row=>row.field==='start_date').values[0],'other');assert.doesNotMatch(JSON.stringify(summary),/private|PRIVATE|example|report-from|SYNTHETIC|https?:/);assert.ok(Buffer.byteLength(JSON.stringify(summary))<=2000);
 });
});

test('custom time comboboxes keep their empty search input and choose the visible complete-day options',async()=>{
 const combo=(id,label,value)=>`<div><span>${label}</span><div data-baseweb="select"><span id="${id}-selected">${value}</span><input id="${id}" role="combobox" aria-controls="${id}-options" value=""></div><div role="listbox" id="${id}-options" hidden><div role="option">12:00 AM</div><div role="option">11:59 PM</div><div role="option">1:00 AM</div></div></div>`;
 const html=drawer.replace(/<div><span>Start time<\/span>.*?<\/div>/,combo('custom-start','Start time','1:00 AM')).replace(/<div><span>End time<\/span>.*?<\/div>/,combo('custom-end','End time','1:00 AM'));
 await pageFixture(landing+html,async page=>{
  await contentFixture(page);await wireDrawer(page);await page.evaluate(()=>{for(const id of ['custom-start','custom-end']){const input=document.getElementById(id),options=document.getElementById(id+'-options');input.onclick=()=>options.hidden=false;for(const option of options.children)option.onclick=()=>{document.getElementById(id+'-selected').textContent=option.textContent;options.hidden=true;};}document.querySelector('#final-generate').onclick=()=>{generated++;window.times={start:document.getElementById('custom-start-selected').textContent,end:document.getElementById('custom-end-selected').textContent,startInput:document.getElementById('custom-start').value,endInput:document.getElementById('custom-end').value};};});
  const result=await contentCall(page);assert.equal(result.ok,true,result.message);assert.deepEqual(await page.evaluate(()=>times),{start:'12:00 AM',end:'11:59 PM',startInput:'',endInput:''});assert.equal(await page.evaluate(()=>generated),1);
 });
});

test('contradictory report captions inside a custom select are refused before reserving generation',async()=>{
 const html=drawer.replace('<select id="report-kind"><option value="activity">Driver Activity</option><option value="trips">Trip Activity</option><option value="quality">Driver Quality</option></select>','<div data-baseweb="select"><span>Driver Activity</span><input role="combobox" value=""><span>Trip Activity</span></div>');
 await pageFixture(landing+html,async page=>{await contentFixture(page);await wireDrawer(page);const result=await contentCall(page);assert.equal(result.ok,false);assert.equal(result.diagnostic,'control_unrecognized');assert.match(result.message,/plusieurs types/);assert.equal(await page.evaluate(()=>reservations.length),0);assert.equal(await page.evaluate(()=>generated),0);});
});

test('visible time labels with missing controls stop generation instead of silently skipping day boundaries',async()=>{
 await pageFixture(landing+drawer,async page=>{await contentFixture(page);await wireDrawer(page);await page.evaluate(()=>{document.querySelector('#time-from').remove();document.querySelector('#time-until').remove();});const result=await contentCall(page);assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>reservations.length),0);assert.equal(await page.evaluate(()=>generated),0);});
});
test('date inputs commit through their normal focus-out event before organization rerenders',async()=>{
 await pageFixture(landing+drawer,async page=>{await contentFixture(page);await wireDrawer(page);await page.evaluate(()=>{const end=document.querySelector('#report-until');let committed=end.value;end.addEventListener('focusout',()=>{committed=end.value;window.committedDate=committed;});const choice=document.querySelector('#branch-choice'),prior=choice.onchange;choice.onchange=event=>{prior(event);end.value=committed;};});const result=await contentCall(page);assert.equal(result.ok,true,result.message);assert.equal(await page.evaluate(()=>committedDate),CONFIG.end_date.replaceAll('-','/'));assert.equal(await page.evaluate(()=>generated),1);});
});

test('explicit report labels take precedence over a neighboring help button',async()=>{
 const html='<label for="report">Report type</label><button>Help</button><select id="report"><option>Trip activity</option></select><label for="from">Start date</label><input id="from" type="date"><label for="until">End date</label><input id="until" type="date"><button>Generate</button>';
 await pageFixture(html,async page=>{const state=await page.evaluate(config=>{const form=LudyUberReportsReader.inspect(document,location.href,config);return {status:form.status,id:form.select.id};},CONFIG);assert.deepEqual(state,{status:'form',id:'report'});});
});
test('read-only dates never inherit the selected type from a neighboring report combobox',async()=>{
 const html='<section role="dialog"><div><div role="combobox" id="report"><span>Driver Activity</span></div><label for="from">Start date</label><input id="from" readonly value="2026-10-26"><label for="until">End date</label><input id="until" readonly value="2026-11-01"><button>Generate</button></div></section>';
 await pageFixture(html,async page=>{const state=await page.evaluate(config=>{const form=LudyUberReportsReader.inspect(document,location.href,config);return {status:form.status,id:form.select.id};},CONFIG);assert.deepEqual(state,{status:'form',id:'report'});});
});
test('an absent organization selector never falls through to the Cancel button',async()=>{
 await pageFixture(landing+drawer,async page=>{await contentFixture(page);await wireDrawer(page);await page.evaluate(()=>{window.cancelled=0;document.querySelector('#branches').remove();document.querySelector('#cancel-report').onclick=()=>cancelled++;});const result=await contentCall(page);assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>cancelled),0);assert.equal(await page.evaluate(()=>reservations.length),0);});
});


test('an extension browser in another timezone cannot generate or download mislabeled Moroccan reports',async()=>{
 await pageFixture(landing+drawer,async page=>{await contentFixture(page);await wireDrawer(page);const result=await contentCall(page);assert.equal(result.ok,false);assert.match(result.message,/Africa\/Casablanca/);assert.equal(await page.evaluate(()=>generated),0);assert.equal(await page.evaluate(()=>reservations.length),0);},{timezoneId:'Europe/Paris'});
});
