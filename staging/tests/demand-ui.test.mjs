import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import XLSX from 'xlsx';
import {pickupReferenceForScope} from '../server/pickup-reference.mjs';
const [source,css,xlsx]=await Promise.all([
 readFile(new URL('../site/demand.js',import.meta.url),'utf8'),readFile(new URL('../site/demand.css',import.meta.url),'utf8'),readFile(new URL('../node_modules/xlsx/dist/xlsx.full.min.js',import.meta.url),'utf8')
]);
const spreadsheetAssets=Object.fromEntries(await Promise.all(['spreadsheet.js','spreadsheet-worker.js','spreadsheet-guard.js','pickup-reference.js'].map(async f=>['/'+f,await readFile(new URL('../site/'+f,import.meta.url),'utf8')])));
let browser;before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});after(async()=>{await browser?.close();});
const summary={completed:0,cancelled:0,coverage:{observed_days:0},by_hour:[],by_weekday:[],zones:[],recommendations:[],pause_windows:[],warnings:['Les observations ne couvrent pas toute la demande.']};
async function fixture({role='admin',view='demand',mobile=false,reference=null}={},work){
 const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900}}),calls=[],errors=[];
 const state={summary,imports:[],rules:[],pauses:[],warnings:[],agencies:[{id:1,name:'Agence A',city:'Casablanca'}],fail:false,hold:null,holdPauses:null,denied:false};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(url.origin,'http://fixture.invalid','no provider call');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="page"></main></body></html>'});
  if(spreadsheetAssets[url.pathname])return route.fulfill({contentType:'text/javascript',body:spreadsheetAssets[url.pathname]});if(url.pathname==='/vendor/xlsx.full.min.js')return route.fulfill({contentType:'text/javascript',body:xlsx});
  const path=url.pathname.replace('/api/operations/',''),body=request.postDataJSON();calls.push({path,method:request.method(),body,query:Object.fromEntries(url.searchParams)});
  if(state.fail)return route.fulfill({status:503,json:{error:'Synthetic read failure'}});
  if(state.denied)return route.fulfill({status:403,json:{error:'Synthetic access denied'}});
  if(path==='demand/import')return route.fulfill({json:{counts:{imported:body.rows.length}}});
  if(path==='demand'){if(state.hold){const hold=state.hold;state.hold=null;await hold.promise;return route.fulfill({json:hold.value});}return route.fulfill({json:{summary:state.summary,imports:state.imports,agencies:state.agencies,pickup_reference:reference}});}
  if(path==='rush'&&request.method()==='POST'){if(body.id){Object.assign(state.rules.find(row=>row.id===body.id),body);}else state.rules.push({...body,id:'rule-1'});return route.fulfill({json:{ok:true}});}
  if(path==='rush')return route.fulfill({json:{rules:state.rules,agencies:state.agencies}});
  if(path==='pauses'){if(state.holdPauses){const hold=state.holdPauses;state.holdPauses=null;await hold.promise;try{return await route.fulfill({json:hold.value});}catch{return;}}return route.fulfill({json:{at:new Date().toISOString(),pauses:state.pauses,warnings:state.warnings}});}
  throw Error('Unexpected request '+path);
 });
 await page.goto('http://fixture.invalid/');await page.clock.install();
 await page.evaluate(role=>{window.S={session:{user:{id:'synthetic-user'},access_token:'synthetic-token'},profile:{role},agencies:[{id:1,name:'Agence A',city:'Casablanca'}]};window.ROUTING=1;window.$=selector=>document.querySelector(selector);window.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');window.isAdmin=()=>S.profile.role==='admin';window.fmtDT=value=>new Date(value).toISOString();},role);
 await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;padding:18px;font:15px Arial;color:#202736;background:#f6f7f9}button,select,input{font:inherit}button{padding:10px;border:1px solid #ddd;border-radius:6px}h1{font-size:28px}.ops-heading-actions{display:flex;gap:12px;flex-wrap:wrap}'});await page.addStyleTag({content:css});await page.addScriptTag({content:spreadsheetAssets['/spreadsheet.js']});await page.addScriptTag({content:source});
 await page.evaluate(view=>view==='rush'?pageRush():pageDemand(),view);
 try{await work({page,state,calls});assert.deepEqual(errors,[]);}finally{await page.evaluate(()=>demandCleanup());await page.close();}
}
test('supplied pickup references remain offline, explicit about their denominator and distinct from computed rides',async()=>{
 const rides=Array.from({length:5219},(_,i)=>({agency_id:1,city:'Casablanca',ride_key:'synthetic-'+i,status:i<4125?'completed':'cancelled',started_at:'2026-11-02T12:00:00Z'}));
 const reference=pickupReferenceForScope({rides,agencies:[{id:1,city:'Casablanca'}]});
 await fixture({reference,mobile:true},async({page,state,calls})=>{
  await page.locator('.pickup-reference').waitFor();assert.equal(await page.locator('.pickup-reference svg').count(),1);
  const text=await page.locator('.pickup-reference').innerText();assert.match(text,/5.?945 demandes/);assert.match(text,/5.?219 demandes/);assert.match(text,/726 demandes/);
  assert.match(text,/non vérifié/);assert.match(text,/Aucun pourcentage fourni n’est présenté comme un calcul Ludy/);
  assert.match(text,/Contrôle du fichier source/);assert.match(text,/5.?214/);assert.match(text,/555 autres lignes/);
  await page.locator('.pickup-reference-group summary').first().click();
  assert.match(await page.locator('.pickup-reference-table').first().innerText(),/Plus code déclaré/);
  assert.match(await page.locator('.pickup-reference-table').first().innerText(),/Wikipedia déclarée/);
  assert.match(await page.locator('.pickup-reference-table').first().innerText(),/Localisation publiée par l’établissement/);
  assert.match(await page.locator('.pickup-reference-table').first().innerText(),/Point initial conservé/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'reference fits a phone viewport');
  assert.ok(calls.every(call=>call.path==='demand'),'no geocoder or extra operational write occurs');
  assert.ok(await page.locator('.pickup-reference a[target="_blank"]').count()>0,'Maps links require an explicit click');
  state.fail=true;await page.locator('#demand-refresh').click();await page.locator('#demand-status').filter({hasText:'Lecture interrompue'}).waitFor();
  assert.equal(await page.locator('.pickup-reference').count(),0,'an unsuccessful refresh does not retain reference counts from a previous scope');
 });
});

test('uncertain city rows remain visible as separate counts on desktop and mobile',async()=>{
 for(const mobile of [false,true])await fixture({mobile},async({page,state,calls})=>{
  state.summary={...summary,completed:10,cancelled:2,coverage:{observed_days:3,report_rows:17,analyzed_rows:12,city_review:{status:'loaded',matched:5,confirmed:0,quarantined:5,changed:0,completed:4,cancelled:1}}};
  await page.locator('#demand-refresh').click();await page.locator('.demand-city-review').waitFor();
  const text=await page.locator('.demand-city-review').innerText();assert.match(text,/5 courses à part/);assert.match(text,/4 terminées et 1 annulées/);assert.match(text,/ne participent ni aux chiffres/);assert.match(text,/pas sur une position GPS/);
  assert.equal(await page.locator('.demand-stats strong').first().innerText(),'10');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(calls.every(call=>call.method==='GET'));
 });
});

test('CSV mapping previews raw values, requires review and sends only selected columns with explicit date format',async()=>{
 await fixture({},async({page,calls})=>{
  await page.locator('#demand-import summary').click();await page.locator('#demand-import-agency').selectOption('1');await page.locator('#demand-import-city').selectOption('Casablanca');
  await page.locator('#demand-file').setInputFiles({name:'uber-activity.csv',mimeType:'text/csv',buffer:Buffer.from('trip_id,request_time,pickup_zone,status,driver_email\ntrip-a,02/11/2026 10:30,<b>Centre</b>,Completed,private@example.invalid\n')});
  await page.locator('#demand-preview-count').filter({hasText:'1 ligne'}).waitFor();assert.equal(calls.filter(call=>call.method==='POST').length,0,'choosing a file never imports automatically');
  assert.equal(await page.locator('#demand-preview td b').count(),0,'preview text is inert');assert.match(await page.locator('#demand-preview').innerText(),/02\/11\/2026 10:30/);
  await page.locator('#demand-date-format').selectOption('dmy');await page.locator('#demand-import-submit').click();await page.locator('#demand-import-result').filter({hasText:'Rapport enregistré'}).waitFor();
  const post=calls.find(call=>call.path==='demand/import');assert.equal(post.body.date_format,'dmy');assert.equal(post.body.city,'Casablanca');assert.deepEqual(post.body.rows,[{external_id:'trip-a',started_at:'02/11/2026 10:30',pickup_zone:'<b>Centre</b>',status:'Completed'}]);assert.doesNotMatch(JSON.stringify(post.body),/private@example/);
 });
});
test('a workbook without status needs explicit all-completed confirmation and preserves numeric Excel dates',async()=>{
 const workbook=XLSX.utils.book_new(),serial=(Date.UTC(2026,10,2,10,30)-Date.UTC(1899,11,30))/86400000;
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['trip_id','pickup_time','pickup_zone'],['trip-b',serial,'Gare']]),'Courses');
 await fixture({},async({page,calls})=>{
  await page.locator('#demand-import summary').click();await page.locator('#demand-import-agency').selectOption('1');await page.locator('#demand-import-city').selectOption('Marrakech');
  await page.locator('#demand-file').setInputFiles({name:'synthetic.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(workbook,{bookType:'xlsx',type:'buffer'})});await page.locator('#demand-all-completed').waitFor();
  assert.equal(await page.locator('#demand-import-submit').isDisabled(),true);await page.locator('#demand-all-completed').check();assert.equal(await page.locator('#demand-import-submit').isDisabled(),false);
  await page.locator('#demand-import-submit').click();await page.locator('#demand-import-result').filter({hasText:'Rapport enregistré'}).waitFor();
  const post=calls.find(call=>call.path==='demand/import');assert.equal(post.body.default_status,'completed');assert.equal(post.body.rows[0].started_at,serial);assert.equal(post.body.date_system,'1900');
 });
});
test('invalid mappings cannot import, viewers have no write controls and agency/city filters travel to the API',async()=>{
 await fixture({},async({page,calls})=>{
  await page.locator('#demand-import summary').click();await page.locator('#demand-file').setInputFiles({name:'columns.csv',mimeType:'text/csv',buffer:Buffer.from('pickup_time,pickup_zone,status\n2026-11-02 12:00,Centre,Completed\n')});await page.locator('#demand-col-pickup_zone').waitFor();
  await page.locator('#demand-col-pickup_zone').selectOption('0');assert.equal(await page.locator('#demand-import-submit').isDisabled(),true);assert.match(await page.locator('#demand-import-result').innerText(),/un seul champ/);assert.equal(calls.filter(call=>call.method==='POST').length,0);
 });
 await fixture({role:'viewer'},async({page,calls})=>{
  assert.equal(await page.locator('#demand-import-form').count(),0);await page.locator('#demand-city').selectOption('Marrakech');await page.waitForFunction(()=>!document.querySelector('#demand-refresh').disabled);assert.ok(calls.some(call=>call.query.city==='Marrakech'));
 });
});
test('rush controls persist overnight periods and platform pauses remain read-only observations with warnings',async()=>{
 await fixture({view:'rush'},async({page,state,calls})=>{
  state.pauses=[{driver_name:'Synthetic Driver',agency_name:'Agence A',city:'Casablanca',source:'bolt',observed_at:'2026-11-02T09:30:00Z',rush:true,cross_platform_activity:false,message:'Pause observée pendant un rush.'}];
  await page.locator('#rush-refresh').click();await page.locator('.demand-pause-label').filter({hasText:'Pause pendant un rush'}).waitFor();
  await page.locator('.demand-rule-form summary').click();await page.locator('#rush-agency').selectOption('1');await page.locator('#rush-city').selectOption('Casablanca');await page.locator('#rush-label').fill('Rush de nuit');await page.locator('#rush-start').fill('22:00');await page.locator('#rush-end').fill('02:00');await page.locator('[name="rush-day"][value="7"]').check();await page.locator('#rush-form button').click();await page.locator('#rush-form-result').filter({hasText:'Créneau enregistré'}).waitFor();
  assert.deepEqual(calls.find(call=>call.path==='rush'&&call.method==='POST').body,{agency_id:1,city:'Casablanca',label:'Rush de nuit',days:[7],start:'22:00',end:'02:00',enabled:true});
  await page.locator('[data-rush-toggle="rule-1"]').click();await page.waitForFunction(()=>document.querySelector('[data-rush-toggle="rule-1"]')?.textContent==='Activer');assert.equal(state.rules[0].enabled,false);
  assert.ok(calls.every(call=>['rush','pauses'].includes(call.path)),'no provider or driver action is sent');
 });
});
test('rush reads stop on route cleanup and a read failure removes stale current pause claims',async()=>{
 await fixture({view:'rush',mobile:true},async({page,state,calls})=>{
  state.pauses=[{driver_name:'Synthetic Driver',source:'bolt',rush:true,message:'Pause'}];await page.locator('#rush-refresh').click();await page.locator('.demand-pause-label').waitFor();
  state.fail=true;await page.locator('#rush-refresh').click();await page.locator('#rush-status').filter({hasText:'Observation interrompue'}).waitFor();assert.equal(await page.locator('.demand-pause-label').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile layout fits viewport');
  await page.evaluate(()=>{demandCleanup();ROUTING++;});const before=calls.length;await page.clock.fastForward(31000);assert.equal(calls.length,before);
 });
});
const watchedPause=()=>({identity_id:'bolt-id',driver_id:'driver-id',driver_name:'Synthetic Driver',source:'bolt',status:'on_break',rush:true,cross_platform_activity:false,observed_at:'2026-11-02T09:30:00Z'});
async function watchPoll(page){await page.clock.fastForward(15100);await page.waitForFunction(()=>!DEMAND_UI.watch?.busy);}
test('global rush notices deduplicate refreshed observation times and withdraw on cross-platform work, end of rush or missing observations',async()=>{
 await fixture({},async({page,state})=>{
  state.pauses=[watchedPause()];await page.evaluate(()=>demandWatchRush(ROUTING));await page.locator('.demand-rush-toast').waitFor();assert.match(await page.locator('.demand-rush-toast').innerText(),/Pause déclarée sur Bolt pendant un rush, à vérifier/);
  state.pauses=[{...watchedPause(),observed_at:'2026-11-02T09:30:15Z'}];await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),1);
  await page.locator('.demand-rush-dismiss').click();await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),0,'dismissed episode is not repeated on the next observation');
  state.pauses=[];await watchPoll(page);state.pauses=[watchedPause()];await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),1,'a newly observed episode may notify again');
  for(const change of [{cross_platform_activity:true},{rush:false},{status:'available'}]){state.pauses=[{...watchedPause(),...change}];await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),0);state.pauses=[watchedPause()];await watchPoll(page);}
  state.pauses=[];await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),0);
 });
});
test('global rush watch survives view initialization, stops while hidden and removes data on permission loss and logout',async()=>{
 await fixture({},async({page,state,calls})=>{
  state.pauses=[watchedPause()];await page.evaluate(()=>demandWatchRush(ROUTING));await page.locator('.demand-rush-toast').waitFor();
  await page.evaluate(()=>pageDemand());assert.equal(await page.evaluate(()=>!!DEMAND_UI.watch),true,'view cleanup never cancels the global watch');await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),1);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});const before=calls.filter(call=>call.path==='pauses').length;await page.clock.fastForward(31000);assert.equal(calls.filter(call=>call.path==='pauses').length,before);assert.equal(await page.locator('.demand-rush-toast').count(),0);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await page.locator('.demand-rush-toast').waitFor();
  state.denied=true;await watchPoll(page);assert.equal(await page.locator('.demand-rush-toast').count(),0);assert.equal(await page.evaluate(()=>DEMAND_UI.watchSeen.size),0);
  await page.evaluate(()=>{S.session=null;demandCleanup();ROUTING++;});const stopped=calls.length;await page.clock.fastForward(31000);assert.equal(calls.length,stopped);assert.equal(await page.evaluate(()=>DEMAND_UI.watchOwner),null);
 });
});
test('a late rush snapshot from a previous route or user cannot restore an old notification',async()=>{
 await fixture({},async({page,state})=>{
  let release;const promise=new Promise(resolve=>release=resolve);state.holdPauses={promise,value:{pauses:[watchedPause()],warnings:[]}};
  await page.evaluate(()=>demandWatchRush(ROUTING));await page.waitForFunction(()=>DEMAND_UI.watch?.busy);state.pauses=[];
  await page.evaluate(()=>{demandCleanup();S.session={user:{id:'new-user'},access_token:'new-token'};ROUTING++;demandWatchRush(ROUTING);});release();await page.waitForFunction(()=>DEMAND_UI.watchOwner==='new-user'&&!DEMAND_UI.watch.busy);
  assert.equal(await page.locator('.demand-rush-toast').count(),0);assert.equal(await page.evaluate(()=>DEMAND_UI.watchSeen.size),0);
 });
});
