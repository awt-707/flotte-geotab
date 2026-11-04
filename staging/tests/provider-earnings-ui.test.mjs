import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import '../site/timezone.js';
import {renderProviderEarnings,createProviderConfigReader,providerOrganizationIds} from '../site/provider-earnings-ui.js';

const ORG='11111111-1111-4111-8111-111111111111';
const config={uber:{enabled:true,organization_id:ORG,organization_label:'Synthetic fleet',time_zone:'Africa/Casablanca'},bolt:{status:'unsupported',canReplaceLegacyStatements:false}};
const period={start:'2026-11-02T04:00:00.000Z',end:'2026-11-09T04:00:00.000Z',timeZone:'Africa/Casablanca'};
const amount=value=>({minor:value,known:value===null?0:1,missing:value===null?1:0,complete:value!==null});
const report={id:'snapshot-fixture',organizationId:ORG,currency:'MAD',scope:{kind:'agency',agencyId:'1',driverCode:null},period:{start:'2026-11-02T05:02:00.000Z',end:'2026-11-03T15:15:00.000Z'},observedAt:'2026-11-03T15:16:00.000Z',observedDriverRows:3,exactWindow:false,canReplaceLegacy:false,coverage:{complete:true,mappingComplete:true},currencies:[{currency:'MAD',currencyCode:'MAD',revenue:amount(60000),gross:amount(null),net:amount(null),reportedPayout:amount(-35000),cash:amount(10000),startBalance:amount(0),endBalance:amount(25500)}]};
const result={reports:[report],selected:[],coverage:{queryComplete:true},fetchedAt:'2026-11-03T15:17:00.000Z'};
test('provider presentation keeps exact settlement boundaries, stocks, currencies, scope and unknown fields separate',()=>{
 const html=renderProviderEarnings({current:result,config,requestedPeriod:period,context:'cash'});
 assert.match(html,/02\/11\/2026 à 05:02/);assert.match(html,/03\/11\/2026 à 15:15/);assert.match(html,/02\/11\/2026 à 04:00/);
 assert.match(html,/Dernière lecture chez Uber : 03\/11\/2026 à 15:16/);assert.match(html,/sans prorata/);assert.match(html,/Chauffeurs rattachés à l’agence sélectionnée/);
 assert.match(html,/Brut avant frais<\/dt><dd>—<\/dd>/);assert.match(html,/Net après commissions · avant Taxes Uber<\/dt><dd>—<\/dd>/);assert.match(html,/Revenus déclarés<\/dt><dd>600,00/);assert.match(html,/Solde final<\/dt><dd>255,00/);
 assert.match(html,/hors chiffre d’affaires/);assert.match(html,/aucun mouvement de caisse/);assert.match(html,/Importer un relevé Bolt/);assert.match(html,/inDrive · non utilisé actuellement/);assert.match(html,/au moins cinq minutes/);assert.match(html,/relevé financier non fourni par l’API documentée/);
 const older={...report,id:'older',observedAt:'2026-11-03T14:00:00Z',period:{...report.period,end:'2026-11-03T14:00:00Z'}},unsafe={...report,id:'<img src=x onerror=1>'};
 const limited=renderProviderEarnings({current:{...result,reports:[unsafe,older]},config});assert.equal((limited.match(/data-provider-report=/g)||[]).length,1);assert.ok(!limited.includes('<img'));assert.match(limited,/se chevauchent ne sont jamais additionnées/);
 const unavailable=renderProviderEarnings({current:{...result,coverage:{queryComplete:false}},config,error:true});assert.match(unavailable,/Derniers relevés conservés/);assert.match(unavailable,/15:16/);
 const detail=renderProviderEarnings({current:{...result,reports:[{...report,byDriver:[{driverKey:'D1',driverName:'<Synthetic driver>',currencies:report.currencies}],unmatched:{records:1,currencies:report.currencies}}]},config});assert.match(detail,/Détail des chauffeurs confirmés/);assert.match(detail,/&lt;Synthetic driver&gt;/);assert.match(detail,/Revenus déclarés non rapprochés/);assert.match(detail,/Contrôle administrateur uniquement/);assert.match(detail,/#\/rapprochements-financiers\?snapshot=/);assert.ok(!detail.includes('<Synthetic driver>'));
 const aggregated=renderProviderEarnings({current:{...result,reports:[{...report,currencies:[{...report.currencies[0],net:{...amount(32000),basis:'sum_complete_driver_rows'}}],notes:['Relevé <complet> : somme des champs net déclarés.']}]},config});assert.match(aggregated,/320,00/);assert.match(aggregated,/Somme de tous les chauffeurs du relevé/);assert.match(aggregated,/Relevé &lt;complet&gt;/);
});

test('configuration uses the current bearer session on the same origin, redacts unrelated fields and rejects session rotation',async()=>{
 let session={user:{id:'one'},access_token:'fixture-token'},requests=[];
 const supabase={auth:{getSession:async()=>({data:{session}})}};
 const read=createProviderConfigReader({supabase,fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({...config,secret:'not-returned',uber:{...config.uber,credential:'not-returned'}})};}});
 const value=await read();assert.deepEqual(providerOrganizationIds(value),[ORG]);assert.ok(!JSON.stringify(value).includes('not-returned'));
 assert.equal(requests[0].url,'/api/provider-earnings/config');assert.equal(requests[0].options.headers.Authorization,'Bearer fixture-token');assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.credentials,'same-origin');read.dispose();await assert.rejects(read(),{name:'AbortError'});
 const rotating=createProviderConfigReader({supabase,fetchImpl:async()=>({ok:true,json:async()=>{session={user:{id:'other'},access_token:'new-fixture'};return config;}})});await assert.rejects(rotating(),{name:'AbortError'});rotating.dispose();
 const denied=createProviderConfigReader({supabase,fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:'private server detail'})})});await assert.rejects(denied(),error=>error.status===403&&!error.message.includes('private'));denied.dispose();
});

test('a currency coverage refusal visibly preserves the import basis and escapes its explanation',()=>{
 const message='Les imports Uber sont conservés : devise <non confirmée>. Les relevés restent séparés.';
 const html=renderProviderEarnings({current:{...result,replacement:{allowed:false,reason:'legacy_currency_scope_unproven',message}},config});
 assert.match(html,/provider-warning/);assert.match(html,/Les imports Uber sont conservés/);
 assert.match(html,/&lt;non confirmée&gt;/);assert.ok(!html.includes('<non confirmée>'));
 assert.match(html,/data-provider-report=/,'the separately displayed provider report remains available');
});

const site=new URL('../site/',import.meta.url),names=['provider-earnings-ui.js','provider-earnings-ui.css','revenue-metrics.js','timezone.js','caisse.js'];
const files=Object.fromEntries(names.map(name=>[name,readFileSync(new URL(name,site),'utf8')]));
async function fixture({cash=false}={}){
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'}),page=await browser.newPage({viewport:{width:1360,height:900}}),calls=[],errors=[],state={hold:false,fail:false,deny:false,pending:[]};
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('__read',async request=>{calls.push(request);if(state.hold){state.hold=false;return new Promise((resolve,reject)=>state.pending.push({resolve,reject}));}if(state.deny)throw Error('forbidden');if(state.fail)throw Error('read unavailable');return result;});
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,'http://127.0.0.1:4173');
  if(url.pathname==='/api/provider-earnings/config')return route.fulfill({contentType:'application/json',body:JSON.stringify(config)});
  if(url.pathname==='/provider-earnings-data.js')return route.fulfill({contentType:'text/javascript',body:`export function createProviderEarningsLoader(){return window.__loader();}`});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px Arial;margin:18px;background:#f4f7f9}*{box-sizing:border-box}${files['provider-earnings-ui.css']}</style><main id="page">${cash?'':'<div id="provider"></div>'}</main><script src="/timezone.js"></script><script>
   let ROUTING=1;const S={session:{user:{id:'staff'},access_token:'fixture-token'},sessionRevision:1,agencies:[{id:1,name:'Synthetic agency'}],profile:{role:'admin'}};
   const canEdit=()=>['admin','manager'].includes(S.profile.role),canSee=()=>true,$=selector=>document.querySelector(selector),esc=value=>String(value),qs=()=>new URLSearchParams(location.hash.split('?')[1]||''),today=()=> '2026-11-03',addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),agFilter=()=>'';
   window.__current=true;window.__hidden=false;Object.defineProperty(document,'hidden',{get:()=>window.__hidden});window.__intervals=new Map();let intervalId=0;window.setInterval=(fn,ms)=>{const id=++intervalId;window.__intervals.set(id,fn);return id;};window.clearInterval=id=>window.__intervals.delete(id);window.__tick=()=>[...window.__intervals.values()].forEach(fn=>fn());
   window.__disposed=0;window.__removed=0;window.__signals=[];window.__channels=[];window.__denied=0;
   const sb={auth:{getSession:async()=>({data:{session:S.session}})},channel:()=>{const c={subscriptions:[],on(event,filter,callback){this.subscriptions.push({event,...filter});this.callback=callback;return this;},subscribe(){return this;}};window.__channels.push(c);return c;},removeChannel:async()=>{window.__removed++;}};
   window.__loader=()=>({load({signal,...request}){window.__signals.push(signal);return window.__read(request).catch(error=>{if(error.message.includes('forbidden'))error.status=403;throw error;});},dispose(){window.__disposed++;}});
   </script>${cash?'<script src="/caisse.js"></script>':''}<script type="module">
   const ui=await import('/provider-earnings-ui.js');window.__ui=ui;
   ${cash?`cshLoad=async()=>{CS.drivers=[];CS.udrv=[];CS.uuid2code={};};cshShiftSel=()=>({day:'2026-11-03'});cshTabBord=()=>cshBody('<p id="original-cash">Espèces en caisse : 17 MAD</p>');await pageCaisse();`:`window.__view=ui.mountProviderEarnings({element:document.querySelector('#provider'),loader:window.__loader(),configReader:ui.createProviderConfigReader({supabase:sb}),supabase:sb,isCurrent:()=>window.__current&&canEdit(),selection:()=>({period:${JSON.stringify(period)},agencyId:'1',driverCode:null}),onAccessLost:()=>window.__denied++});`}
   window.__ready=true;</script></html>`});
  if(files[url.pathname.slice(1)])return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:files[url.pathname.slice(1)]});return route.fulfill({status:404,body:''});
 });
 await page.goto('http://127.0.0.1:4173/#/caisse?du=2026-11-02&au=2026-11-03');await page.waitForFunction(()=>window.__ready===true);await page.locator('[data-provider-report]').first().waitFor();return {browser,page,calls,errors,state};
}

test('shared provider panel scopes reads, refreshes only visible pages and removes its marker subscription on unmount',async()=>{
 const f=await fixture();try{assert.deepEqual(f.calls[0],{period,agencyId:'1',driverCode:null,organizationIds:[ORG]});
  assert.deepEqual(await f.page.evaluate(()=>window.__channels[0].subscriptions),['INSERT','UPDATE'].map(event=>({event,schema:'public',table:'revenue_refresh'})));
  await f.page.evaluate(()=>{window.__hidden=true;window.__tick();});assert.equal(f.calls.length,1);await f.page.evaluate(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));});await f.page.waitForFunction(()=>window.__signals.length===2);
  for(const width of [390,1360]){await f.page.setViewportSize({width,height:900});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  f.state.hold=true;await f.page.evaluate(()=>void window.__view.refresh());await f.page.waitForFunction(()=>window.__signals.length===3);await f.page.evaluate(()=>{window.__view.dispose();document.querySelector('#provider').innerHTML='Autre page';});f.state.pending.shift().resolve(result);await f.page.waitForTimeout(30);
  assert.equal(await f.page.locator('#provider').innerText(),'Autre page');assert.deepEqual(await f.page.evaluate(()=>({timers:window.__intervals.size,disposed:window.__disposed,removed:window.__removed,aborted:window.__signals.at(-1).aborted})),{timers:0,disposed:1,removed:1,aborted:true});assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

test('read failures keep an explicitly stale date, while permission loss removes all provider amounts',async()=>{
 const f=await fixture();try{f.state.fail=true;await f.page.evaluate(()=>window.__view.refresh());assert.match(await f.page.locator('#provider').innerText(),/Derniers relevés conservés/);assert.match(await f.page.locator('#provider').innerText(),/15:16/);
  f.state.deny=true;await f.page.evaluate(()=>window.__view.refresh());assert.equal(await f.page.locator('[data-provider-report]').count(),0);assert.match(await f.page.locator('#provider').innerText(),/montants ont été masqués/);assert.equal(await f.page.evaluate(()=>window.__denied),1);assert.equal(await f.page.evaluate(()=>window.__intervals.size),0);
 }finally{await f.browser.close();}
 const revoked=await fixture();try{await revoked.page.evaluate(()=>{S.profile.role='viewer';window.__tick();});assert.equal(await revoked.page.locator('[data-provider-report]').count(),0);assert.equal(await revoked.page.evaluate(()=>window.__disposed),1);}finally{await revoked.browser.close();}
});

test('Caisse reads the selected Morocco calendar days and agency without changing its cash view; route or auth changes clean up',async()=>{
 const f=await fixture({cash:true});try{assert.equal(f.calls[0].period.start,'2026-11-02T00:00:00.000Z');assert.equal(f.calls[0].period.end,'2026-11-04T00:00:00.000Z');assert.equal(f.calls[0].agencyId,'1');assert.equal(await f.page.locator('#original-cash').innerText(),'Espèces en caisse : 17 MAD');
  assert.match(await f.page.locator('#cshprovider').innerText(),/ne modifient pas les rapprochements par shift/);await f.page.evaluate(()=>{ROUTING++;cshProviderCleanup();document.querySelector('#page').innerHTML='Navigation suivante';});assert.equal(await f.page.evaluate(()=>window.__intervals.size),0);assert.equal(await f.page.evaluate(()=>window.__removed),1);assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
 const denied=await fixture({cash:true});try{denied.state.deny=true;await denied.page.evaluate(()=>CSH_PROVIDER.view.refresh());assert.equal(await denied.page.locator('#original-cash').count(),0);assert.match(await denied.page.locator('#page').innerText(),/données financières ont été masquées/);}finally{await denied.browser.close();}
});
