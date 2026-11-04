import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {summarizeRevenue,compareRevenueSummaries,getRevenueComparisonWindow} from '../site/revenue-metrics.js';

const site=new URL('../site/',import.meta.url);
const files=Object.fromEntries(['revenue.js','revenue.css','revenue-metrics.js','provider-earnings-ui.js','provider-earnings-ui.css','timezone.js','lib.js','style.css','workspace.css'].map(name=>[name,readFileSync(new URL(name,site),'utf8')]));
const fixedNow=Date.parse('2026-11-05T12:00:00Z');
const records=[
 {id:'uber-a',source:'uber',sourceKind:'statement',at:'2026-11-03T08:00:00Z',currency:'MAD',revenueMinor:10000,grossMinor:15000,netMinor:8000,reportedPayoutMinor:7000,tipsMinor:500,commissionMinor:-2000,cashMinor:3000,fareMinor:9000,bonusMinor:200,tollsMinor:100,driverKey:'driver-a',driverName:'Synthetic <driver>'},
 {id:'uber-b',source:'uber',sourceKind:'statement',at:'2026-11-05T08:00:00Z',currency:'MAD',revenueMinor:2000,grossMinor:3000,netMinor:1500,reportedPayoutMinor:1200,driverKey:'driver-a',driverName:'Synthetic <driver>'},
 {id:'uber-old',source:'uber',sourceKind:'statement',at:'2026-10-27T08:00:00Z',currency:'MAD',revenueMinor:6000,grossMinor:9000,netMinor:4000,reportedPayoutMinor:3500,driverKey:'driver-a',driverName:'Synthetic <driver>'},
 {id:'bolt-a',source:'bolt',sourceKind:'statement',at:'2026-11-03T08:00:00Z',currency:'MAD',assumedCurrency:true,revenueMinor:3000,driverKey:'driver-b',driverName:'Synthetic Bolt'},
 {id:'unknown-a',source:'bolt',sourceKind:'statement',at:'2026-11-03T08:00:00Z',currency:null,revenueMinor:5000000},
 {id:'private-today',source:'private',sourceKind:'private_course',day:'2026-11-05',currency:'MAD',assumedCurrency:true,revenueMinor:8000,grossMinor:8000,driverKey:'driver-b',driverName:'Synthetic Bolt'}
];

function resultFor(request,now=fixedNow,selectedRecords=records){
 const window=getRevenueComparisonWindow(request.period,now),scoped=selectedRecords.filter(row=>(request.source==='all'||row.source===request.source)&&(!request.driverCode||row.driverKey===request.driverCode));
 const current=summarizeRevenue(scoped,{start:window.start,end:window.end,timeZone:request.period.timeZone});
 const previous=summarizeRevenue(scoped,{start:window.previousStart,end:window.previousEnd,timeZone:request.period.timeZone});
 return {period:request.period,comparisonWindow:window,current,previous,comparison:compareRevenueSummaries(current,previous,{equalDuration:window.equalDuration}),
  fetchedAt:new Date(now).toISOString(),coverage:{complete:false,queryComplete:true,notes:['Les imports présents ne prouvent pas que toutes les courses ont été reçues.']},
  sourceStatus:[{source:'uber',status:'partial',lastRecordAt:'2026-11-05T08:00:00Z',lastImportedAt:'2026-11-05T11:00:00Z',note:'Relevés reçus uniquement.'},{source:'bolt',status:'partial',lastRecordAt:'2026-11-03T08:00:00Z',lastImportedAt:'2026-11-05T10:00:00Z'},{source:'private',status:'partial',lastRecordDay:'2026-11-05',lastUpdatedAt:'2026-11-05T10:30:00Z'}],
  choices:{agencies:[{id:'agency-a',name:'Agence synthétique'}],drivers:[{code:'driver-a',name:'Synthetic <driver>',agency_id:'agency-a'},{code:'driver-b',name:'Synthetic Bolt',agency_id:'agency-a'}]}};
}

async function fixture({width=1360,hash='',now=fixedNow,role='admin',data=resultFor,subscribeFails=false}={}){
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});
 const page=await browser.newPage({viewport:{width,height:950}}),calls=[],errors=[],state={hold:false,fail:false,pending:[],now};
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('__testLoad',async input=>{calls.push(input);if(state.hold){state.hold=false;return new Promise((resolve,reject)=>state.pending.push({input,resolve,reject}));}if(state.fail)throw Error('Lecture financière interrompue');return data(input,state.now);});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,'http://127.0.0.1:4173','browser fixture must not access an external service');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${files['style.css']}${files['workspace.css']}*{box-sizing:border-box}body{font:14px Arial;background:#f5f7fa;margin:20px}button,input,select{font:inherit}${files['revenue.css']}${files['provider-earnings-ui.css']}</style><main id="page"></main>
   <script>let ROUTING=1,S={session:{user:{id:'staff'}},sessionRevision:1,agencies:[{id:'agency-a',name:'Agence synthétique'}]};window.__role=${JSON.stringify(role)};window.__now=${now};Date.now=()=>window.__now;
   window.__canSee=true;const canEdit=()=>['admin','manager'].includes(window.__role),canSee=()=>window.__canSee,agFilter=()=>'';
   window.__hidden=false;Object.defineProperty(document,'hidden',{get:()=>window.__hidden});
   window.__intervals=new Map();window.__nextInterval=100;const originalSetInterval=window.setInterval,originalClearInterval=window.clearInterval;
   window.setInterval=(fn,ms)=>{if(ms!==30000)return originalSetInterval(fn,ms);const id=++window.__nextInterval;window.__intervals.set(id,fn);return id;};window.clearInterval=id=>{window.__intervals.delete(id);originalClearInterval(id);};window.__tick=()=>[...window.__intervals.values()].forEach(fn=>fn());
   window.__channels=[];window.__removed=0;window.__disposed=0;window.__signals=[];window.__subscribeFails=${JSON.stringify(subscribeFails)};
   const sb={channel:name=>{const channel={name,callbacks:[],subscriptions:[],on(event,options,callback){this.callbacks.push(callback);this.subscriptions.push({event,...options});return this;},subscribe(){if(window.__subscribeFails)throw Error('Realtime unavailable');return this;}};window.__channels.push(channel);return channel;},removeChannel:async()=>{window.__removed++;}};
   </script><script src="/timezone.js"></script><script src="/lib.js"></script><script src="/revenue.js"></script></html>`});
  if(url.pathname==='/revenue-data.js')return route.fulfill({contentType:'text/javascript',body:`export function createRevenueDataLoader(options){window.__providerConfigInjected=typeof options.providerConfig==='function';return {load({signal,...request}){window.__signals.push(signal);return window.__testLoad(request).catch(error=>{if(window.__serverCode)error.code=window.__serverCode;throw error;});},dispose(){window.__disposed++;}};}`});
  const file=files[url.pathname.slice(1)];if(file)return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:file});
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://127.0.0.1:4173/#/chiffre-affaires'+hash);await page.evaluate(()=>pageRevenueDashboard());
 return {browser,page,calls,errors,state};
}

async function settled(page){await page.waitForFunction(()=>document.querySelector('#revenue-results')?.getAttribute('aria-busy')==='false');}

test('Uber provider freshness names the actual provider read and period reports instead of missing CSV import dates',async()=>{
 const data=(request,now)=>{const value=resultFor(request,now);value.sourceStatus=value.sourceStatus.map(status=>status.source==='uber'?{source:'uber',status:'complete',records:0,providerPeriods:2,lastProviderObservedAt:'2026-11-05T11:58:00.000Z',lastRecordAt:null,lastImportedAt:null,note:'Relevé Uber Fleet Earnings'}:status);return value;};
 const f=await fixture({data});try{await settled(f.page);const text=await f.page.locator('[data-source="uber"]').innerText();assert.match(text,/Dernière lecture chez Uber : 05\/11\/2026 à 11:58/);assert.match(text,/2 relevé\(s\) de période/);assert.ok(!text.includes('Dernier import connu'));assert.ok(!text.includes('Dernière donnée dans les périodes lues'));assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});

test('CA exposes provider windows separately without adding their overlapping totals or balances to the selected statistics',async()=>{
 const metric=minor=>({minor,known:minor===null?0:1,missing:minor===null?1:0,complete:minor!==null});
 const data=(request,now)=>({...resultFor(request,now),provider:{config:{uber:{enabled:true,organization_id:'11111111-1111-4111-8111-111111111111',time_zone:'Africa/Casablanca'},bolt:{status:'unsupported'}},current:{reports:[{id:'fixture-window',organizationId:'11111111-1111-4111-8111-111111111111',currency:'MAD',scope:{kind:'fleet'},period:{start:'2026-11-02T05:02:00.000Z',end:'2026-11-05T11:59:00.000Z'},observedAt:'2026-11-05T12:00:00.000Z',observedDriverRows:2,coverage:{complete:true,mappingComplete:false},exactWindow:false,canReplaceLegacy:false,currencies:[{currency:'MAD',currencyCode:'MAD',revenue:metric(99900),gross:metric(null),net:metric(null),endBalance:metric(90000)}]}],coverage:{queryComplete:true}}}});
 const f=await fixture({data});try{await settled(f.page);assert.equal(await f.page.evaluate(()=>window.__providerConfigInjected),true);assert.match(await f.page.locator('[data-revenue-value="revenue"]').innerText(),/120,00/);assert.match(await f.page.locator('.provider-earnings').innerText(),/999,00/);assert.match(await f.page.locator('.provider-earnings').innerText(),/05:02/);assert.match(await f.page.locator('.provider-earnings').innerText(),/sans prorata/);assert.match(await f.page.locator('.provider-earnings').innerText(),/Flotte entière/);
  if(process.env.LUDY_PROVIDER_PREVIEW){await f.page.screenshot({path:process.env.LUDY_PROVIDER_PREVIEW+'-desktop.png',fullPage:true});await f.page.setViewportSize({width:390,height:844});await f.page.screenshot({path:process.env.LUDY_PROVIDER_PREVIEW+'-mobile.png',fullPage:true});}
  assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

test('open-week provider totals name their observation and preserve the real individual cutoff without an equal-duration comparison',async()=>{
 const data=(request,now)=>{const value=resultFor(request,now);value.current.providerOpenWeek=true;value.current.providerObservedAt='2026-11-05T11:58:00.000Z';value.provider={current:{reports:[],basis:{kind:'open_week',periodStart:request.period.start,periodEnd:request.period.end,observedAt:value.current.providerObservedAt,comparisonAllowed:false}}};return value;};
 const f=await fixture({data});try{await settled(f.page);const text=await f.page.locator('.revenue-open-week').innerText();assert.match(text,/Semaine en cours/);assert.match(text,/05\/11\/2026 à 11:58/);assert.match(text,/écritures individuelles restent arrêtées au 05\/11\/2026 à 12:00/);assert.equal(await f.page.locator('.revenue-metric .revenue-delta:not(.unavailable)').count(),0);assert.match(await f.page.locator('.provider-open-week').innerText(),/ne désigne pas une lecture effectuée dans le futur/);
 await f.page.evaluate(()=>{URL.createObjectURL=blob=>{window.__exported=blob;return 'blob:synthetic';};HTMLAnchorElement.prototype.click=function(){};});await f.page.locator('#revenue-export').click();const csv=await f.page.evaluate(()=>window.__exported.text());assert.match(csv,/Base fournisseur/);assert.match(csv,/Semaine en cours observée/);const uberLine=csv.split('\r\n').find(line=>line.includes('"Uber"'));assert.match(uberLine,/^"2026-11-02T04:00:00.000Z";"2026-11-09T04:00:00.000Z";"";/,'an open provider week has no fabricated exact-read cutoff');assert.ok(uberLine.endsWith('"2026-11-02T04:00:00.000Z";"2026-11-09T04:00:00.000Z"'));
 assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});

test('financial UI separates currencies and unavailable net, explains day-only amounts and source freshness, and exports the actual read window',async()=>{
 const f=await fixture();try{
  const {page,calls}=f;await settled(page);
  assert.match(await page.locator('[data-revenue-value="revenue"]').innerText(),/120,00\s+MAD/);
  assert.match(await page.locator('[data-revenue-value="gross"]').innerText(),/180,00\s+MAD/);
  assert.match(await page.locator('[data-revenue-value="net"]').innerText(),/95,00\s+MAD/);
  assert.match(await page.locator('.revenue-secondary-details').innerText(),/transactions ou relevés/);assert.match(await page.locator('.revenue-breakdown').innerText(),/-20,00\s+MAD/);
  if(process.env.LUDY_REVENUE_PREVIEW){await page.screenshot({path:process.env.LUDY_REVENUE_PREVIEW+'-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:process.env.LUDY_REVENUE_PREVIEW+'-mobile.png',fullPage:true});await page.setViewportSize({width:1360,height:950});}
  assert.deepEqual(await page.locator('#revenue-currency option').evaluateAll(options=>options.map(option=>option.value)).then(values=>values.sort()),['MAD','MAD_LEGACY','UNKNOWN']);
  assert.match(await page.locator('[data-source="uber"]').innerText(),/Dernier import connu : 05\/11\/2026 à 11:00/);
  assert.match(await page.locator('[data-source="private"]').innerText(),/05\/11\/2026 · heure non renseignée/);
  assert.equal(await page.locator('script injected').count(),0);assert.equal(await page.locator('.revenue-table tbody strong').first().innerText(),'Synthetic <driver>');
  const chartPath=await page.locator('.revenue-line').getAttribute('d');assert.equal((chartPath.match(/M /g)||[]).length,2,'an absent calendar day breaks the chart instead of implying a continuous daily amount');
  await page.locator('#revenue-currency').selectOption('MAD_LEGACY');assert.match(await page.locator('[data-revenue-value="revenue"]').innerText(),/30,00\s+MAD/);assert.equal(await page.locator('[data-revenue-value="net"]').innerText(),'—');
  assert.match(await page.locator('.revenue-uncertain').innerText(),/80,00\s+MAD/);assert.match(await page.locator('.revenue-uncertain').innerText(),/hors des totaux/);
  await page.locator('#revenue-currency').selectOption('UNKNOWN');assert.equal(await page.locator('[data-revenue-value="revenue"]').innerText(),'—');
  await page.locator('#revenue-currency').selectOption('MAD');
  await page.evaluate(()=>{window.__exported=null;URL.createObjectURL=blob=>{window.__exported=blob;return 'blob:synthetic';};HTMLAnchorElement.prototype.click=function(){};});
  await page.locator('#revenue-export').click();const exported=await page.evaluate(()=>window.__exported.text());assert.match(exported,/Fin de lecture exclue/);assert.match(exported,/2026-11-05T12:00:00.000Z/);assert.match(exported,/partielle ou non confirmée/);assert.match(exported,/Dernier import/);
  assert.equal(await page.evaluate(()=>revenueCSVCell(' =HYPERLINK("bad")')),`"' =HYPERLINK(""bad"")"`);
  await page.locator('#revenue-source').selectOption('uber');await settled(page);assert.equal(calls.at(-1).source,'uber');assert.equal(await page.locator('.revenue-source-card').count(),1);assert.match(await page.locator('.revenue-primary .revenue-delta').innerText(),/\+60,00\s+MAD.*\+100/);
  await page.locator('#revenue-driver').selectOption('driver-a');await settled(page);assert.equal(calls.at(-1).driverCode,'driver-a');
  for(const width of [390,1360]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no page overflow at ${width}px`);}
  assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

test('week picker follows Morocco Monday 04h and calendar navigation, with explicit inclusive custom dates',async()=>{
 const now=Date.parse('2026-11-02T03:59:00Z'),f=await fixture({now});try{
  const {page,calls,state}=f;assert.equal(calls[0].period.start,'2026-10-26T04:00:00.000Z');assert.equal(calls[0].period.end,'2026-11-02T04:00:00.000Z');
  state.now=Date.parse('2026-11-02T04:00:00Z');await page.evaluate(value=>{window.__now=value;window.__tick();},state.now);await settled(page);assert.equal(calls.at(-1).period.start,'2026-11-02T04:00:00.000Z');
  await page.locator('#revenue-previous').click();await settled(page);assert.equal(calls.at(-1).period.start,'2026-10-26T04:00:00.000Z');assert.match(await page.locator('#revenue-period-label').innerText(),/26\/10\/2026 à 04:00/);
  await page.locator('[data-revenue-preset="day"]').click();await settled(page);assert.equal(calls.at(-1).period.start,'2026-11-02T00:00:00.000Z');
  await page.locator('[data-revenue-preset="month"]').click();await settled(page);assert.equal(calls.at(-1).period.start,'2026-11-01T00:00:00.000Z');
  await page.locator('[data-revenue-preset="custom"]').click();await settled(page);await page.locator('#revenue-from').fill('2026-10-27');await page.locator('#revenue-to').fill('2026-10-29');await page.locator('#revenue-to').dispatchEvent('change');await settled(page);
  assert.equal(calls.at(-1).period.start,'2026-10-27T00:00:00.000Z');assert.equal(calls.at(-1).period.end,'2026-10-30T00:00:00.000Z');assert.equal(calls.at(-1).period.days,3);
  const reads=calls.length;await page.locator('#revenue-from').fill('2026-10-30');await page.locator('#revenue-from').dispatchEvent('change');await page.locator('#revenue-error:visible').waitFor();assert.equal(calls.length,reads);assert.equal(await page.locator('#revenue-refresh').isDisabled(),false);assert.equal(await page.locator('.revenue-metric').count(),0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

test('refreshes only visible pages, retains honest read errors, and rejects stale requests after selection, navigation or session changes',async()=>{
 const f=await fixture();try{
  const {page,calls,state}=f;const reads=calls.length;
  await page.evaluate(()=>{window.__hidden=true;window.__tick();});assert.equal(calls.length,reads);
  await page.evaluate(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));});await settled(page);assert.equal(calls.length,reads+1);
  state.hold=true;await page.locator('#revenue-refresh').click();await page.waitForFunction(()=>document.querySelector('#revenue-refresh').disabled);assert.equal(state.pending.length,1);
  await page.locator('#revenue-source').selectOption('bolt');await settled(page);assert.equal(await page.evaluate(()=>window.__signals.at(-2).aborted),true);const newest=await page.locator('#revenue-results').innerText();
  state.pending.shift().resolve(resultFor(calls[0]));await page.waitForTimeout(30);assert.equal(await page.locator('#revenue-results').innerText(),newest);
  state.fail=true;await page.locator('#revenue-refresh').click();await page.locator('#revenue-error:visible').waitFor();assert.match(await page.locator('#revenue-read-status').innerText(),/dernière lecture conservée/);assert.equal(await page.locator('#revenue-results').innerText(),newest);
  await page.locator('#revenue-source').selectOption('private');await settled(page);assert.equal(await page.locator('.revenue-metric').count(),0,'a failed new filter cannot retain unrelated amounts');state.fail=false;
  await page.locator('#revenue-refresh').click();await settled(page);assert.equal(await page.locator('#revenue-currency').inputValue(),'MAD_LEGACY');assert.match(await page.locator('.revenue-uncertain').innerText(),/80,00/);
  state.hold=true;await page.locator('#revenue-refresh').click();assert.equal(state.pending.length,1);await page.evaluate(()=>{ROUTING++;revenueCleanup();document.querySelector('#page').innerHTML='<p>Autre page</p>';window.__channels[0].callbacks[0]();});state.pending.shift().resolve(resultFor(calls.at(-1)));await page.waitForTimeout(450);
  assert.equal(await page.locator('#page').innerText(),'Autre page');assert.deepEqual(await page.evaluate(()=>({intervals:window.__intervals.size,removed:window.__removed,disposed:window.__disposed})),{intervals:0,removed:1,disposed:1});
  await page.evaluate(()=>pageRevenueDashboard());await settled(page);state.hold=true;await page.locator('#revenue-refresh').click();await page.evaluate(()=>{S.sessionRevision++;S.session={user:{id:'new-user'}};document.querySelector('#page').innerHTML='<p>Nouvelle session</p>';});state.pending.shift().resolve(resultFor(calls.at(-1)));await page.waitForTimeout(30);assert.equal(await page.locator('#page').innerText(),'Nouvelle session');assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

test('financial page refuses viewer access before reading and does not present a comparison after a failed source',async()=>{
 const denied=await fixture({role:'viewer'});try{assert.equal(denied.calls.length,0);assert.match(await denied.page.locator('#page').innerText(),/réservée aux administrateurs et gestionnaires/);}finally{await denied.browser.close();}
 const f=await fixture({data:(request,now)=>{const result=resultFor(request,now);result.coverage.queryComplete=false;result.sourceStatus[1]={source:'bolt',status:'error',note:'Source non disponible'};return result;}});try{
  assert.equal(await f.page.locator('.revenue-delta.up').count(),0);assert.equal(await f.page.locator('.revenue-delta.unavailable').count(),4);assert.match(await f.page.locator('[data-source="bolt"]').innerText(),/Lecture indisponible/);assert.match(await f.page.locator('.revenue-source-warning').innerText(),/Lecture incomplète : Bolt/);assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});


test('a role or page-permission loss hides financial data and disposes polling and subscriptions',async()=>{
 const f=await fixture();try{const {page,calls}=f;const reads=calls.length;await page.evaluate(()=>{window.__role='viewer';window.__tick();});assert.equal(calls.length,reads);assert.equal(await page.locator('.revenue-metric').count(),0);assert.match(await page.locator('#page').innerText(),/données financières ont été masquées/);assert.deepEqual(await page.evaluate(()=>({intervals:window.__intervals.size,removed:window.__removed,disposed:window.__disposed})),{intervals:0,removed:1,disposed:1});await page.evaluate(()=>{window.__role='admin';return pageRevenueDashboard();});await settled(page);await page.evaluate(()=>{window.__canSee=false;window.__tick();});assert.equal(await page.locator('.revenue-metric').count(),0);assert.equal(await page.evaluate(()=>window.__removed),2);assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});


test('a server-side permission refusal clears the snapshot even if the cached UI profile is still admin',async()=>{
 const f=await fixture();try{const {page,state}=f;state.fail=true;await page.evaluate(()=>window.__serverCode='revenue_access_denied');await page.locator('#revenue-refresh').click();await page.getByText('Votre accès à cette vue a changé. Les données financières ont été masquées.').waitFor();assert.equal(await page.locator('.revenue-metric').count(),0);assert.equal(await page.evaluate(()=>window.__role),'admin');assert.equal(await page.evaluate(()=>window.__intervals.size),0);assert.equal(await page.evaluate(()=>window.__removed),1);assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});


test('a linked driver and agency filter is applied to the first read rather than briefly loading every driver',async()=>{
 const f=await fixture({hash:'?source=uber&agency=agency-a&driver=driver-a'});try{assert.equal(f.calls.length,1);assert.equal(f.calls[0].source,'uber');assert.equal(f.calls[0].agencyId,'agency-a');assert.equal(f.calls[0].driverCode,'driver-a');assert.equal(await f.page.locator('#revenue-driver').inputValue(),'driver-a');assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});


test('realtime subscribes only to insert/update markers and rereads authorized financial data without using notification payloads',async()=>{
 const f=await fixture();try{const {page,calls}=f;assert.deepEqual(await page.evaluate(()=>window.__channels[0].subscriptions),[{event:'INSERT',schema:'public',table:'revenue_refresh'},{event:'UPDATE',schema:'public',table:'revenue_refresh'}]);const before=calls.length;await page.evaluate(()=>{const channel=window.__channels[0];for(const callback of channel.callbacks)callback({new:{agency_id:'outside-filter',revenue:999999999,driver_name:'UNTRUSTED PAYLOAD'}});});await page.waitForFunction(count=>window.__signals.length===count+1,before);await settled(page);assert.equal(calls.length,before+1,'marker bursts are debounced into a single authenticated load');assert.equal(calls.at(-1).source,'all');assert.doesNotMatch(await page.locator('#page').innerText(),/UNTRUSTED PAYLOAD|999999999/);assert.match(await page.locator('[data-revenue-value="revenue"]').innerText(),/120,00\s+MAD/);await page.evaluate(()=>revenueCleanup());assert.equal(await page.evaluate(()=>window.__removed),1);assert.equal(await page.evaluate(()=>window.__intervals.size),0);assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});

test('the 30 second polling fallback remains active when the realtime marker subscription is unavailable',async()=>{
 const f=await fixture({subscribeFails:true});try{const {page,calls}=f;assert.equal(await page.evaluate(()=>window.__removed),1,'failed channel is disposed');assert.equal(await page.evaluate(()=>window.__intervals.size),1);const before=calls.length;await page.evaluate(()=>window.__tick());await settled(page);assert.equal(calls.length,before+1);assert.match(await page.locator('[data-revenue-value="revenue"]').innerText(),/120,00\s+MAD/);await page.evaluate(()=>revenueCleanup());assert.equal(await page.evaluate(()=>window.__intervals.size),0);assert.equal(await page.evaluate(()=>window.__removed),1);assert.deepEqual(f.errors,[]);}finally{await f.browser.close();}
});
