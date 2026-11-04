import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {chromium} from 'playwright';

const root=new URL('../uber-extension/',import.meta.url);
const files=Object.fromEntries(await Promise.all(['popup.html','popup.js','popup.css','reports-reader.js','reports-background.js'].map(async name=>[name,await readFile(new URL(name,root),'utf8')])));
const ORG='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const REPORTS=`https://fleethub.uber.com/orgs/${ORG}/reports`,LIVE=`https://fleethub.uber.com/orgs/${OTHER}/livemap`,LUDY='http://127.0.0.1:4173/#uber-reports';
const CONFIG={enabled:true,organization_id:ORG,report_type:'trip_activity',start_date:'2026-10-26',end_date:'2026-11-01',date_format:'dmy',interval_seconds:21600};
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>{await browser?.close();});

// The actual reports background runs in a VM. Only the browser API and local
// bridge are stubbed; no provider page, real pairing or external request is used.
function reportsFixture(active){
 const events=[],created=[],requests=[],injections=[],saved={},tabs=new Map([
  [1,{id:1,url:LIVE,active:active==='uber',status:'complete'}],
  [2,{id:2,url:LUDY,active:active==='ludy',status:'complete'}]
 ]);
 let permission=false,config=CONFIG,statusReads=0;
 const event={addListener:()=>{}},api={
  runtime:{id:'synthetic-extension',getURL:file=>'chrome-extension://synthetic-extension/'+file,onStartup:event},
  permissions:{contains:async()=>permission,onRemoved:event},
  tabs:{
   get:async id=>{assert.ok(tabs.has(id));return tabs.get(id);},
   query:async query=>[...tabs.values()].filter(tab=>!query.url||tab.url.startsWith(query.url.replace(/\*$/,''))),
   create:async spec=>{created.push(structuredClone(spec));const tab={id:7,...spec,status:'complete'};tabs.set(7,tab);return tab;},
   sendMessage:async(id,message)=>{assert.equal(id,7);if(message.type==='LUDY_UBER_REPORTS_CANCEL')return {ok:true};return {ok:true,runId:message.runId,result:{status:'waiting',message:'Rapport de test en cours de génération.'}};},
   onUpdated:event,onRemoved:event
  },
  scripting:{executeScript:async spec=>{injections.push(structuredClone(spec));assert.equal(spec.target.tabId,7);}},
  alarms:{create:async()=>{},clear:async()=>{},onAlarm:event}
 };
 const fetchFn=async(url,options)=>{assert.equal(url,'http://127.0.0.1:4173/api/uber-reports/bridge/config');requests.push({url,options});return {ok:true,json:async()=>config};};
 const sandbox=vm.createContext({URL,TextEncoder,TextDecoder,Date,AbortController,AbortSignal,setTimeout,clearTimeout,crypto:webcrypto,fetch:fetchFn});
 vm.runInContext(files['reports-reader.js'],sandbox);vm.runInContext(files['reports-background.js'],sandbox);
 const automation=sandbox.LudyUberReportsAutomation.create({api,storage:{get:async()=>structuredClone(saved),set:async value=>Object.assign(saved,structuredClone(value))},getPairing:()=>({token:'synthetic-test-pairing'}),pairingReady:Promise.resolve(),fetchFn,now:()=>Date.parse('2026-11-02T10:00:00Z')});
 async function message(message){
  events.push({kind:'message',type:message.type});
  if(message.type==='LUDY_UBER_STATUS')return {ok:true,data:{paired:true,active:true,state:'observing',message:'Lecture Live Map de test active · '+(++statusReads),rows:14,reports:automation.publicState()}};
  try{return {ok:true,data:await automation.handle(message,{id:api.runtime.id,url:api.runtime.getURL('popup.html')})};}catch(error){return {ok:false,error:error.message};}
 }
 return {automation,events,created,requests,injections,tabs,message,setPermission:value=>permission=value,setConfig:value=>config=value};
}

async function fixture(active,work){
 const background=reportsFixture(active),page=await browser.newPage({viewport:{width:420,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('popupBackground',message=>background.message(message));
 await page.exposeFunction('popupPermission',info=>{background.events.push({kind:'permission',...info});background.setPermission(info.granted);return info.granted;});
 await page.addInitScript(()=>{
  window.permissionGranted=true;window.popupCalls=[];
  window.chrome={
   runtime:{sendMessage:message=>{popupCalls.push({kind:'message',type:message.type});return popupBackground(message);}},
   permissions:{request:options=>{const info={options,granted:permissionGranted,activeGesture:navigator.userActivation.isActive};popupCalls.push({kind:'permission',...info});return popupPermission(info);}}
  };
 });
 await page.route('**/*',route=>{const url=new URL(route.request().url());assert.equal(url.origin,'http://popup.invalid');const name=url.pathname.slice(1);assert.ok(['popup.html','popup.js','popup.css'].includes(name),'Unexpected popup request '+url.href);return route.fulfill({contentType:name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body:files[name]});});
 await page.clock.install();await page.goto('http://popup.invalid/popup.html');await page.locator('#status').filter({hasText:'Lecture Live Map de test active'}).waitFor();
 try{await work({page,background});assert.deepEqual(errors,[]);}finally{await background.automation.run();await background.automation.stop();await page.close();}
}

async function pollOnce(page){
 const previous=await page.locator('#status').textContent();
 await page.clock.fastForward(1001);
 await page.waitForFunction(previous=>document.querySelector('#status').textContent!==previous,previous);
}

for(const active of ['uber','ludy'])test(`reports START from the active ${active} tab requests permission within the click and opens the configured fleet separately`,async()=>{
 await fixture(active,async({page,background:f})=>{
  await page.locator('#reports-start').click();await page.waitForFunction(()=>!document.querySelector('#reports-stop').disabled);await f.automation.run();
  const calls=await page.evaluate(()=>popupCalls),permission=calls.findIndex(call=>call.kind==='permission'),start=calls.findIndex(call=>call.type==='LUDY_UBER_REPORTS_START');
  assert.ok(permission>=0&&start>permission);assert.equal(calls[permission].activeGesture,true);assert.deepEqual(calls[permission].options,{origins:['https://fleethub.uber.com/*']});
  assert.deepEqual(f.created,[{url:REPORTS,active:false}]);assert.equal(f.tabs.get(1).url,LIVE);assert.equal(f.tabs.get(2).url,LUDY);assert.equal(f.tabs.get(active==='uber'?1:2).active,true);
  assert.ok(f.injections.length>0);assert.ok(f.injections.every(item=>item.target.tabId===7));assert.ok(f.requests.length>0);
  await pollOnce(page);assert.match(await page.locator('#reports-status').innerText(),/Rapport de test en cours/);assert.equal(await page.locator('#reports-status').getAttribute('data-state'),'waiting_report');
 });
});

test('permission refusal stays visible through polling, performs no background START and a new granted click clears the error',async()=>{
 await fixture('ludy',async({page,background:f})=>{
  await page.evaluate(()=>{permissionGranted=false;});await page.locator('#reports-start').click();await page.locator('#reports-status').filter({hasText:'Autorisation navigateur non accordée'}).waitFor();
  await pollOnce(page);assert.match(await page.locator('#reports-status').innerText(),/Autorisation navigateur non accordée/);assert.equal(await page.locator('#reports-status').getAttribute('data-state'),'error');
  assert.equal(f.events.filter(event=>event.type==='LUDY_UBER_REPORTS_START').length,0);assert.equal(f.created.length,0);assert.equal(f.requests.length,0);
  assert.equal(f.events.find(event=>event.kind==='permission').activeGesture,true);
  await page.evaluate(()=>{permissionGranted=true;});await page.locator('#reports-start').click();await page.waitForFunction(()=>!document.querySelector('#reports-stop').disabled);await f.automation.run();await pollOnce(page);
  assert.doesNotMatch(await page.locator('#reports-status').innerText(),/Autorisation navigateur non accordée/);assert.equal(f.created.length,1);assert.equal(f.events.filter(event=>event.type==='LUDY_UBER_REPORTS_START').length,1);
 });
});

test('a background configuration error also persists through polling and clears only after another successful action',async()=>{
 await fixture('uber',async({page,background:f})=>{
  f.setConfig({...CONFIG,enabled:false});await page.locator('#reports-start').click();await page.locator('#reports-status').filter({hasText:'Activez et configurez'}).waitFor();
  await pollOnce(page);await pollOnce(page);assert.match(await page.locator('#reports-status').innerText(),/Activez et configurez/);assert.equal(await page.locator('#reports-status').getAttribute('data-state'),'error');assert.equal(f.created.length,0);
  f.setConfig(CONFIG);await page.locator('#reports-start').click();await page.waitForFunction(()=>!document.querySelector('#reports-stop').disabled);await f.automation.run();await pollOnce(page);
  assert.doesNotMatch(await page.locator('#reports-status').innerText(),/Activez et configurez/);assert.equal(f.created.length,1);
 });
});
