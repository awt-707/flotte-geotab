import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {chromium} from 'playwright';
import {createReportLedger,createUberBrowserCollector,readReportDownload,reportBrowserConfig,reportPageUrl} from '../server/uber-report-browser-collector.mjs';
import {normalizeUberCsv} from '../server/uber-reports.mjs';
import {createLeaseRecovery,previousCompleteReportPeriod,assertReportBrowserTimezone} from '../scripts/uber-reports-browser.mjs';
const ORG='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',TRIP='33333333-3333-4333-8333-333333333333';
const CONFIG={enabled:true,organization_id:ORG,organization_label:'SYNTHETIC FLEET',report_types:['trip_activity'],date_format:'dmy',start_date:'2026-10-26',end_date:'2026-11-01',interval_seconds:21600};
const URL=reportPageUrl(CONFIG),CSV=`Trip UUID,Trip request time,Pickup address,Trip status\n${TRIP},2026-11-01 10:00,Centre Casablanca,completed\n`;
const row=control=>`<tr><td>20261026-20261101-trip_activity</td><td>Trip Activity</td><td>20261026-20261101</td><td>${control}</td></tr>`,head='<h1>Reports</h1><table><thead><tr><th>Report name</th><th>Report type</th><th>Report time range</th><th>Generated on</th></tr></thead><tbody>',form='<label>Report type<select id="type"><option value="trip">Trip activity</option></select></label><label for="from">Start date</label><input id="from" type="date"><label for="to">End date</label><input id="to" type="date"><button id="generate">Generate</button>';
let browser;before(async()=>{browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});});after(async()=>browser?.close());
async function fixture(html,work,{csv=CSV,downloadName='uber-trip-activity-2026-10-26-2026-11-01.csv',url=URL,delay=0}={}){
 const dir=await mkdtemp(new globalThis.URL('../.local/uber-browser-test-',import.meta.url)),context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),imports=[],statuses=[];let clock=Date.now(),lease=0;
 await context.route('**/*',route=>{assert.equal(new globalThis.URL(route.request().url()).origin,'https://fleethub.uber.com');return route.fulfill({contentType:'text/html',body:'<!doctype html>'+html});});await context.addInitScript(({csv,downloadName,delay})=>{const wire=()=>{window.generated=0;window.downloadClicks=0;for(const button of document.querySelectorAll('.download'))button.onclick=()=>{downloadClicks++;setTimeout(()=>{const href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})),a=document.createElement('a');a.href=href;a.download=downloadName;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);},delay);};const generate=document.querySelector('#generate');if(generate)generate.onclick=()=>generated++;;};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire,{once:true});else wire();},{csv,downloadName,delay});await page.goto(url);
 const ledger=await createReportLedger(dir),collector=createUberBrowserCollector({page,ledger,checkLease:async()=>lease++,ingest:async(body,{signal})=>{assert.equal(signal.aborted,false);normalizeUberCsv(body.csv,{...CONFIG,city_agencies:{Casablanca:1}},{now:Date.parse('2026-11-02T12:00:00Z')});imports.push(body);return {ok:true,local_file:{stored:true}};},now:()=>clock,onStatus:status=>statuses.push(status),taskTimeout:5000,downloadTimeout:2500});
 try{await work({dir,page,context,ledger,collector,imports,statuses,advance:ms=>clock+=ms,now:()=>clock,lease:()=>lease});}finally{await collector.stop();await context.close();await rm(dir,{recursive:true,force:true});}
}
test('the exact page Download produces a bounded CSV import and subsequent ticks respect six hours',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{const result=await f.collector.tick(CONFIG);assert.equal(result.status,'imported');assert.equal(f.imports.length,1);assert.equal(f.imports[0].csv,CSV);assert.equal(f.imports[0].sourceUrl,URL);assert.equal(f.imports[0].startDate,CONFIG.start_date);assert.ok(f.lease()>=2);assert.equal(await f.page.evaluate(()=>downloadClicks),1);assert.equal((await f.collector.tick(CONFIG)).status,'idle');assert.equal((await stat(f.dir+'/report-jobs.json')).mode&0o777,0o600);assert.doesNotMatch(await readFile(f.dir+'/report-jobs.json','utf8'),/Trip UUID|Centre Casablanca|csv|token|password/);f.advance(21600000);assert.equal((await f.collector.tick(CONFIG)).status,'page_reset_required');const nextPage=await f.context.newPage();await nextPage.goto(URL);const next=createUberBrowserCollector({page:nextPage,ledger:f.ledger,checkLease:async()=>{},ingest:async body=>{f.imports.push(body);return {ok:true};},now:f.now});try{assert.equal((await next.tick(CONFIG)).status,'imported');assert.equal(f.imports.length,2);}finally{await next.stop();await nextPage.close();}});
});
test('other organization pages, ambiguous rows and mismatched CSV types never import',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{const result=await f.collector.tick(CONFIG);assert.equal(result.status,'action_required');assert.equal(result.code,'wrong_organization');assert.equal(f.imports.length,0);assert.equal(await f.page.evaluate(()=>downloadClicks),0);},{url:URL.replace(ORG,OTHER)});
 await fixture(head+row('<button class="download">Download</button>')+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{const result=await f.collector.tick(CONFIG);assert.equal(result.code,'ambiguous');assert.equal(f.imports.length,0);assert.equal(await f.page.evaluate(()=>downloadClicks),0);});
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{const result=await f.collector.tick(CONFIG);assert.equal(result.status,'action_required');assert.equal(result.code,'report_rejected');assert.equal(f.imports.length,0);},{csv:'Driver UUID,Trips completed,Hours online,Hours on trip\nx,1,2,1'});
});
test('an unrecognized form yields bounded structural diagnostics without page content',async()=>{
 await fixture(head+'</tbody></table><p>private-person@example.invalid</p>',async f=>{const result=await f.collector.tick(CONFIG);assert.equal(result.phase,'prepare_form');assert.equal(result.diagnostic.kind,'form_unrecognized');assert.equal(result.diagnostic.structure.scope,'document');assert.equal(result.diagnostic.structure.matches.report_type,0);assert.doesNotMatch(JSON.stringify(result.diagnostic),/private-person|example\.invalid|Reports/);assert.ok(JSON.stringify(result.diagnostic).length<2000);assert.equal(f.ledger.get(f.ledger.key(CONFIG,'trip_activity')).requestedAt??null,null);assert.equal(f.imports.length,0);});
});
test('complete days use next-day midnight when the provider only offers quarter hours',async()=>{
 const fullDay={...CONFIG,end_exclusive:true},times='<label>Start time<select id="start-time"><option>12:00 AM</option><option>12:15 AM</option></select></label><label>End time<select id="end-time"><option>12:00 AM</option><option>11:45 PM</option></select></label><label>Organizations<select id="org"><option value="'+ORG+'">SYNTHETIC FLEET</option></select></label>';
 await fixture(head+'</tbody></table>'+form+times,async f=>{await f.page.evaluate(pending=>document.querySelector('#generate').onclick=()=>{generated++;window.submitted={start:document.querySelector('#from').value,end:document.querySelector('#to').value,startTime:document.querySelector('#start-time').value,endTime:document.querySelector('#end-time').value};document.querySelector('tbody').innerHTML=pending;},row('<span>Processing</span>').replaceAll('20261101','20261102'));const result=await f.collector.tick(fullDay);assert.equal(result.status,'waiting_report');assert.deepEqual(await f.page.evaluate(()=>submitted),{start:'2026-10-26',end:'2026-11-02',startTime:'12:00 AM',endTime:'12:00 AM'});assert.ok(f.ledger.get(f.ledger.key(CONFIG,'trip_activity')).requestedAt);});
 await fixture(head+row('<button class="download">Download</button>').replaceAll('20261101','20261102')+'</tbody></table>',async f=>{assert.equal((await f.collector.tick(fullDay)).status,'imported');assert.equal(f.imports[0].startDate,'2026-10-26');assert.equal(f.imports[0].endDate,'2026-11-01');});
});
test('a pending exact row is remembered across restart and prevents another generation even if the row disappears',async()=>{
 await fixture(head+row('<span>Processing</span>')+'</tbody></table>'+form,async f=>{assert.equal((await f.collector.tick(CONFIG)).status,'waiting_report');assert.ok(f.ledger.get(f.ledger.key(CONFIG,'trip_activity')).requestedAt);await f.collector.stop();await f.page.evaluate(()=>document.querySelector('tbody').replaceChildren());const restored=await createReportLedger(f.dir),next=createUberBrowserCollector({page:f.page,ledger:restored,checkLease:async()=>{},ingest:async()=>assert.fail('No import'),now:()=>f.now()+60000});try{assert.equal((await next.tick(CONFIG)).status,'waiting_report');assert.equal(await f.page.evaluate(()=>generated),0);}finally{await next.stop();}});
});
test('a slow failed report cannot starve other report types across dedicated work pages',async()=>{
 const types=['trip_activity','driver_activity','driver_quality'],config={...CONFIG,report_types:types},html=head+types.map(type=>row('<span>Processing</span>').replace('trip_activity',type).replace('Trip Activity',type.split('_').map(x=>x[0].toUpperCase()+x.slice(1)).join(' '))).join('')+'</tbody></table>';
 await fixture(html,async f=>{assert.equal((await f.collector.tick(config)).reportType,'trip_activity');await f.collector.stop();f.advance(120000);const next=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{},ingest:async()=>assert.fail('Pending reports do not import'),now:f.now});try{assert.equal((await next.tick(config)).reportType,'driver_activity');f.advance(120000);assert.equal((await next.tick(config)).reportType,'driver_quality');}finally{await next.stop();}});
});
test('the unavailable-period fallback retains exactly seven complete days across month boundaries',()=>{
 const fallback=previousCompleteReportPeriod({...CONFIG,start_date:'2026-10-27',end_date:'2026-11-02',end_exclusive:true});assert.equal(fallback.start_date,'2026-10-26');assert.equal(fallback.end_date,'2026-11-01');assert.equal(fallback.period_lag_days,1);assert.equal(fallback.end_exclusive,true);assert.equal(fallback.organization_id,ORG);assert.equal(Date.parse(fallback.end_date)-Date.parse(fallback.start_date),6*86400000);
});
test('generation writes its durable reservation before the final Generate click',async()=>{
 await fixture(head+'</tbody></table>'+form,async f=>{await f.page.exposeFunction('reservationBeforeClick',()=>!!f.ledger.get(f.ledger.key(CONFIG,'trip_activity')).requestedAt);await f.page.evaluate(pendingRow=>document.querySelector('#generate').onclick=async()=>{generated++;window.hadReservation=await reservationBeforeClick();document.querySelector('tbody').innerHTML=pendingRow;},row('<span>Processing</span>'));assert.equal((await f.collector.tick(CONFIG)).status,'waiting_report');await f.page.waitForFunction(()=>hadReservation===true);assert.equal(await f.page.evaluate(()=>generated),1);f.advance(60000);assert.equal((await f.collector.tick(CONFIG)).status,'waiting_report');assert.equal(await f.page.evaluate(()=>generated),1);});
});
test('generation awaits the provider UI acknowledgement before its work page can close',async()=>{
 await fixture(head+'</tbody></table>'+form,async f=>{
  await f.context.route('**/mock-generate',async route=>{await new Promise(resolve=>setTimeout(resolve,500));await route.fulfill({contentType:'application/json',body:'{"accepted":true}'});});
  await f.page.evaluate(pendingRow=>{document.querySelector('#generate').onclick=async()=>{generated++;await fetch('/mock-generate',{method:'POST'});document.querySelector('tbody').innerHTML=pendingRow;window.acknowledged=true;};},row('<span>Processing</span>'));
  let finished=false;const running=f.collector.tick(CONFIG).then(result=>{finished=true;return result;});await f.page.waitForFunction(()=>generated===1);await new Promise(resolve=>setTimeout(resolve,150));assert.equal(finished,false);assert.equal((await running).status,'waiting_report');assert.equal(await f.page.evaluate(()=>acknowledged),true);assert.equal(await f.page.evaluate(()=>generated),1);
 });
});
test('an uncertain generation keeps its durable reservation without another Generate click',async()=>{
 await fixture(head+'</tbody></table>'+form,async f=>{await f.collector.stop();const collector=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{},ingest:async()=>assert.fail('No import'),now:f.now,generationTimeout:200});try{const result=await collector.tick(CONFIG);assert.equal(result.status,'retrying');assert.equal(result.code,'generation_unconfirmed');assert.ok(f.ledger.get(f.ledger.key(CONFIG,'trip_activity')).requestedAt);f.advance(60000);assert.equal((await collector.tick(CONFIG)).status,'waiting_report');assert.equal(await f.page.evaluate(()=>generated),1);}finally{await collector.stop();}});
});
test('a crash after reserving a generation cannot duplicate the export on the next run',async()=>{
 await fixture(head+'</tbody></table>'+form,async f=>{await f.collector.stop();let first=true;const wrapped={...f.ledger,update:async(key,patch)=>{await f.ledger.update(key,patch);if(first&&patch.requestedAt){first=false;throw Error('simulated interruption');}}};const attempt=createUberBrowserCollector({page:f.page,ledger:wrapped,checkLease:async()=>{},ingest:async()=>assert.fail('No import'),now:f.now});assert.equal((await attempt.tick(CONFIG)).status,'retrying');await attempt.stop();assert.equal(await f.page.evaluate(()=>generated),0);f.advance(60000);const resumed=createUberBrowserCollector({page:f.page,ledger:await createReportLedger(f.dir),checkLease:async()=>{},ingest:async()=>assert.fail('No import'),now:f.now});try{assert.equal((await resumed.tick(CONFIG)).status,'waiting_report');assert.equal(await f.page.evaluate(()=>generated),0);}finally{await resumed.stop();}});
});
test('an oversized or non-CSV download is cancelled and never sent to the local import',async()=>{
 for(const opts of [{csv:CSV+'x'.repeat(6*1024*1024)},{downloadName:'report.html'}])await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{const result=await f.collector.tick(CONFIG);assert.equal(result.status,'action_required');assert.ok(['oversize','not_csv'].includes(result.code));assert.equal(f.imports.length,0);},opts);
});
test('real operator interaction during a download pauses that task without importing another file',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{const running=f.collector.tick(CONFIG);await f.page.waitForFunction(()=>downloadClicks===1);await f.page.keyboard.press('Shift');assert.equal((await running).status,'retrying');assert.equal(f.imports.length,0);},{delay:300});
});
test('Stop and closing the dedicated page abort an in-flight read and prevent future activity',async()=>{
 for(const close of [false,true])await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{await f.page.evaluate(()=>document.querySelector('.download').onclick=()=>downloadClicks++);const running=f.collector.tick(CONFIG);await f.page.waitForFunction(()=>downloadClicks===1);if(close)await f.page.close();else await f.collector.stop();assert.equal((await running).status,'stopped');assert.equal(f.imports.length,0);assert.equal((await f.collector.tick(CONFIG)).status,'stopped');});
});
test('lease refusal prevents every provider action and is surfaced to the owner loop',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{await f.collector.stop();const blocked=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{throw Object.assign(Error('Lease lost'),{status:409});},ingest:async()=>assert.fail('No import')});try{await assert.rejects(blocked.tick(CONFIG),error=>error.status===409);assert.equal(await f.page.evaluate(()=>downloadClicks),0);}finally{await blocked.stop();}});
});
test('download streams honor interruption and the content limit before returning bytes',async()=>{
 let cancelled=0;const download={suggestedFilename:()=> 'report.csv',createReadStream:async()=>Readable.from([Buffer.alloc(7)]),cancel:async()=>cancelled++};await assert.rejects(readReportDownload(download,{maxBytes:6}),error=>error.code==='oversize');assert.equal(cancelled,1);const controller=new AbortController();controller.abort();await assert.rejects(readReportDownload(download,{signal:controller.signal}),error=>error.code==='stopped');assert.equal(cancelled,2);
 assert.throws(()=>reportBrowserConfig({...CONFIG,organization_id:'invalid'}));assert.throws(()=>reportBrowserConfig({...CONFIG,end_date:'2026-02-30'}));
});
test('a UTF-8 CSV byte order mark is preserved for the original local archive',async()=>{
 const original=Buffer.from('\ufeff'+CSV,'utf8'),download={suggestedFilename:()=> 'report.csv',createReadStream:async()=>Readable.from([original]),cancel:async()=>assert.fail('No cancellation')};const file=await readReportDownload(download);assert.deepEqual(Buffer.from(file.csv,'utf8'),original);
});
test('an asynchronous stream read rejected during cancellation remains a handled stream error',async()=>{
 let rejectRead,started;const readingStarted=new Promise(resolve=>started=resolve),controller=new AbortController();let cancelled=0;
 const stream=new Readable({read(){started();return new Promise((_resolve,reject)=>rejectRead=reject);},destroy(error,done){queueMicrotask(()=>rejectRead(Error('Synthetic download channel closed')));done(error);}});
 const download={suggestedFilename:()=> 'report.csv',createReadStream:async()=>stream,cancel:async()=>cancelled++},reading=readReportDownload(download,{signal:controller.signal});
 const rejected=assert.rejects(reading,error=>error.code==='stopped');await readingStarted;controller.abort();await rejected;await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,1);assert.equal(stream.destroyed,true);
});

test('multiple page download events are rejected instead of choosing the first CSV arbitrarily',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{await f.page.evaluate(csv=>{document.querySelector('.download').onclick=()=>{downloadClicks++;for(let n=0;n<2;n++){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='report-'+n+'.csv';a.click();}};},CSV);const result=await f.collector.tick(CONFIG);assert.equal(result.status,'action_required');assert.equal(result.code,'download_ambiguous');assert.equal(f.imports.length,0);});
});
test('a temporary pause cancels the active task but permits collection after the lease is reacquired',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{await f.page.evaluate(()=>{window.workingDownload=document.querySelector('.download').onclick;document.querySelector('.download').onclick=()=>downloadClicks++;});const pending=f.collector.tick(CONFIG);await f.page.waitForFunction(()=>downloadClicks===1);await f.collector.pause();assert.equal((await pending).status,'retrying');assert.equal(f.imports.length,0);f.advance(60000);assert.equal((await f.collector.tick(CONFIG)).status,'page_reset_required');const nextPage=await f.context.newPage();await nextPage.goto(URL);const next=createUberBrowserCollector({page:nextPage,ledger:f.ledger,checkLease:async()=>{},ingest:async body=>{f.imports.push(body);return {ok:true};},now:f.now});try{assert.equal((await next.tick(CONFIG)).status,'imported');assert.equal(f.imports.length,1);}finally{await next.stop();await nextPage.close();}});
});
test('a task timeout remains retryable without permanently stopping the collector',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{await f.collector.stop();await f.page.evaluate(()=>{window.workingDownload=document.querySelector('.download').onclick;document.querySelector('.download').onclick=()=>downloadClicks++;});const collector=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{},ingest:async()=>({ok:true}),now:f.now,taskTimeout:100,downloadTimeout:1000});try{const result=await collector.tick(CONFIG);assert.equal(result.status,'retrying');assert.equal(result.code,'timeout');assert.equal((await collector.tick(CONFIG)).status,'idle');}finally{await collector.stop();}});
});
test('lease recovery pauses once, retries local downtime and rejects another owner',async()=>{
 let pauses=0,beats=0,claims=0,online=false;const guard=createLeaseRecovery({claim:async()=>{claims++;if(!online)throw Object.assign(Error(),{status:503});},heartbeat:async()=>{beats++;throw Object.assign(Error(),{status:503});},pause:async()=>pauses++});
 await assert.rejects(guard.beat());assert.equal(guard.paused,true);assert.equal(pauses,1);await assert.rejects(guard.beat());assert.equal(beats,1);assert.equal(await guard.recover(),false);online=true;assert.equal(await guard.recover(),true);assert.equal(guard.paused,false);assert.equal(claims,2);
 const conflict=createLeaseRecovery({claim:async()=>{throw Object.assign(Error(),{status:409});},heartbeat:async()=>{},pause:async()=>{}});conflict.suspend();await assert.rejects(conflict.recover(),error=>error.status===409);
});
test('a structurally corrupt reservation ledger is refused rather than treated as a new request',async()=>{
 const {writeFile}=await import('node:fs/promises');for(const value of [true,[],"text"]){const dir=await mkdtemp(new globalThis.URL('../.local/uber-browser-corrupt-',import.meta.url));try{await writeFile(dir+'/report-jobs.json',JSON.stringify({version:1,entries:{[ORG+':trip_activity:2026-10-26:2026-11-01']:value}}),{mode:0o600});await assert.rejects(createReportLedger(dir),error=>error.code==='storage');}finally{await rm(dir,{recursive:true,force:true});}}
});
test('new business columns reach the backend for archival and a rejection pauses instead of losing the CSV',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{await f.collector.stop();let received;const collector=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{},ingest:async body=>{received=body.csv;throw Object.assign(Error('unknown columns'),{status:400,localFileStored:true});},now:f.now});try{const result=await collector.tick(CONFIG);assert.equal(received,'New Uber Column,Another Column\na,b\n');assert.equal(result.status,'action_required');assert.equal(result.code,'report_rejected');assert.match(result.message,/conservé/);assert.equal((await collector.tick(CONFIG)).status,'idle');}finally{await collector.stop();}},{csv:'New Uber Column,Another Column\na,b\n'});
});

test('a late download from an expired page cannot be attributed to the following report period',async()=>{
 const oldCsv='Driver UUID,Trips completed,Hours online,Hours on trip\n'+TRIP+',1,2,1\n',newCsv='Driver UUID,Trips completed,Hours online,Hours on trip\n'+TRIP+',9,12,7\n',activity={...CONFIG,report_types:['driver_activity']};
 const html=(head+row('<button class="download">Download</button>')+'</tbody></table>').replaceAll('trip_activity','driver_activity').replaceAll('Trip Activity','Driver Activity');
 await fixture(html,async f=>{
  await f.collector.stop();const imported=[],first=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{},ingest:async body=>{imported.push(body);return {ok:true};},now:f.now,downloadTimeout:150,taskTimeout:1500});
  assert.equal((await first.tick(activity)).status,'retrying');const newer={...activity,start_date:'2026-10-27',end_date:'2026-11-02'};
  assert.equal((await first.tick(newer)).status,'page_reset_required');await first.stop();
  const prohibited=createUberBrowserCollector({page:f.page,ledger:f.ledger,checkLease:async()=>{},ingest:async()=>assert.fail('Old page must never be reused'),now:f.now});assert.equal((await prohibited.tick(newer)).status,'page_reset_required');await prohibited.stop();
  const nextPage=await f.context.newPage();await nextPage.goto(URL);await nextPage.evaluate(({csv})=>{document.querySelector('tbody td').textContent='20261027-20261102-driver_activity';document.querySelectorAll('tbody td')[2].textContent='20261027-20261102';document.querySelector('.download').onclick=()=>{setTimeout(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='new-period.csv';a.click();},650);};},{csv:newCsv});
  const next=createUberBrowserCollector({page:nextPage,ledger:f.ledger,checkLease:async()=>{},ingest:async body=>{imported.push(body);return {ok:true};},now:f.now,downloadTimeout:1500,taskTimeout:3000});
  try{assert.equal((await next.tick(newer)).status,'imported');assert.equal(imported.length,1);assert.equal(imported[0].csv,newCsv);assert.equal(imported[0].startDate,newer.start_date);assert.equal(imported[0].filename,'new-period.csv');}finally{await next.stop();await nextPage.close();}
 },{csv:oldCsv,delay:450,downloadName:'old-period.csv'});
});

test('an incomplete navigation retries without claiming an Uber logout, while an actual login URL requires the operator',async()=>{
 await fixture(head+row('<button class="download">Download</button>')+'</tbody></table>',async f=>{
  await f.page.goto('about:blank');let result=await f.collector.tick(CONFIG);assert.equal(result.status,'retrying');assert.equal(result.code,'navigation_pending');assert.equal(f.page.isClosed(),false);assert.equal(f.imports.length,0);
  f.advance(60000);await f.context.route('https://auth.uber.com/**',route=>route.fulfill({contentType:'text/html',body:'<input type="password">'}));await f.page.goto('https://auth.uber.com/v2/');result=await f.collector.tick(CONFIG);assert.equal(result.status,'login_required');assert.equal(f.imports.length,0);assert.equal(f.page.isClosed(),false);
 });
});

test('the visible report range overrides a filename produced in another browser timezone',async()=>{
 const fullDay={...CONFIG,end_exclusive:true},old='<tr><td>20261026-20261102-trip_activity</td><td>Trip Activity</td><td>October 25 - November 1, 2026</td><td><button class="download" data-wrong="true">Download</button></td></tr>',correct='<tr><td>20261027-20261103-trip_activity</td><td>Trip Activity</td><td>October 26 - November 2, 2026</td><td><button class="download">Download</button></td></tr>';
 await fixture(head+old+correct+'</tbody></table>',async f=>{await f.page.evaluate(()=>document.querySelector('[data-wrong]').onclick=()=>{window.wrongRangeClicked=true});const result=await f.collector.tick(fullDay);assert.equal(result.status,'imported');assert.equal(f.imports.length,1);assert.equal(await f.page.evaluate(()=>window.wrongRangeClicked===true),false);});
 await fixture(head+old+'</tbody></table>',async f=>{const result=await f.collector.tick(fullDay);assert.equal(result.status,'retrying');assert.equal(result.diagnostic.kind,'form_unrecognized');assert.equal(f.imports.length,0);assert.equal(await f.page.evaluate(()=>downloadClicks),0);});
});


test('the dedicated browser rejects obsolete Morocco offsets even when the zone name is correct',async()=>{
 const now=Date.parse('2026-11-03T01:00:00Z');
 const context=await browser.newContext({timezoneId:'Africa/Casablanca'}),page=await context.newPage();try{await assertReportBrowserTimezone(page,CONFIG,{now});}finally{await context.close();}
 for(const actual of [{zone:'Europe/Paris',offsets:[-60,-60,-60]},{zone:'Africa/Casablanca',offsets:[-60,-60,-60]},{zone:'Africa/Casablanca',offsets:[0,-60,0]}])await assert.rejects(assertReportBrowserTimezone({evaluate:async()=>actual},CONFIG,{now}),error=>error.code==='browser_timezone');
});
