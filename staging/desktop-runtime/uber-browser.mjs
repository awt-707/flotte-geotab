import path from 'node:path';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ensurePrivateDirectory} from '../server/private-files.mjs';
import {createReportLedger,createUberBrowserCollector,reportBrowserConfig,reportPageUrl} from '../server/uber-report-browser-collector.mjs';
import {moroccoOffsetMinutes} from '../server/morocco-time.mjs';
import {getRevenuePeriod} from '../site/revenue-metrics.js';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const REPORTS='/api/uber-reports/browser/';
const error=(code,message)=>Object.assign(Error(message),{code});
export function desktopUberPaths({projectRef,stateDir,userId}) {
  if(!/^[a-z0-9]{20}$/.test(projectRef||'')||!UUID.test(userId||'')||!path.isAbsolute(stateDir||''))throw TypeError('Projet, compte et dossier privé requis.');
  const directory=path.join(stateDir,'uber',projectRef,userId.toLowerCase());
  return {directory,profile:path.join(directory,'profile'),downloads:path.join(directory,'downloads'),ledger:path.join(directory,'report-ledger')};
}
export async function assertDesktopUberTimezone(page,config,{now=Date.now()}={}) {
  const samples=[now,Date.parse(config.start_date+'T00:00:00Z'),Date.parse(config.end_date+'T00:00:00Z')+86400000];
  const actual=await page.evaluate(samples=>({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,offsets:samples.map(at=>new Date(at).getTimezoneOffset())}),samples);
  if(actual?.zone!=='Africa/Casablanca'||!Array.isArray(actual.offsets)||actual.offsets.length!==samples.length||actual.offsets.some((offset,index)=>offset!==-moroccoOffsetMinutes(samples[index])))throw error('browser_timezone','Le navigateur doit utiliser les règles actuelles de l’heure du Maroc.');
}
export function desktopEarningsPlan(at,previousRead=null) {
  const period=getRevenuePeriod({kind:'week',at,timeZone:'Africa/Casablanca',weekStartHour:4});
  return [{kind:'current',start_at:period.start,end_at:period.end},...(!previousRead||previousRead.end!==period.previousEnd||!Number.isFinite(previousRead.at)||at-previousRead.at>=86400000?[{kind:'previous',start_at:period.previousStart,end_at:period.previousEnd}]:[])];
}
function sameFleetPage(value,organizationId){try{const url=new URL(value);return url.origin==='https://fleethub.uber.com'&&!url.username&&!url.password&&url.pathname.startsWith('/orgs/'+organizationId+'/');}catch{return false;}}
function publicCode(value){return /^[a-z_]{1,60}$/.test(value||'')?value:'browser_unavailable';}

/** Dedicated visible profile. It never reads credentials, cookies, browser
 * profiles or staging runtime files. Live Map remains owned by the extension. */
export function createDesktopUberBrowser({projectRef,stateDir,userId,request,assertLease,onStatus=()=>{},chromium,executablePath,
  now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,ledgerFactory=createReportLedger,
  reportCollectorFactory=createUberBrowserCollector,earningsCollectorFactory,
  checkTimezone=assertDesktopUberTimezone,ensureDirectory=ensurePrivateDirectory,checkExecutable=access}={}) {
  const paths=desktopUberPaths({projectRef,stateDir,userId});
  if([request,assertLease,onStatus].some(fn=>typeof fn!=='function'))throw TypeError('Transport, bail et statut requis.');
  if(executablePath!==undefined&&!path.isAbsolute(executablePath))throw TypeError('Exécutable Chromium absolu requis.');
  const collectorId=randomUUID();let browser=null,mainPage=null,collector=null,ledger=null,controller=null,starting=null,loop=null,stopping=null,heartbeatTimer=null,heartbeatPending=null,claimed=false,running=false,closed=false;
  let snapshot={state:'stopped',reports:'waiting',earnings:'waiting',lastReportAt:null,lastEarningsAt:null,code:null};
  let nextEarningsAt=0,previousEarningsRead=null,earningsFailures=0;
  const status=()=>({...snapshot});
  const publish=patch=>{snapshot={...snapshot,...patch};onStatus(status());};
  function check(signal){if(closed||!running||signal?.aborted)throw error('stopped','Navigateur arrêté.');}
  async function permitted(signal){check(signal);await assertLease({signal});check(signal);}
  async function call(endpoint,options={}){
    const signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[]),AbortSignal.timeout(20000)]);
    await permitted(signal);return request(endpoint,{...options,signal});
  }
  async function heartbeat(){
    if(!heartbeatPending)heartbeatPending=call(REPORTS+'heartbeat',{method:'POST',body:{collectorId}}).finally(()=>heartbeatPending=null);
    return heartbeatPending;
  }
  function armHeartbeat(){
    if(!running||controller.signal.aborted)return;
    heartbeatTimer=setTimer(()=>{heartbeatTimer=null;void heartbeat().then(armHeartbeat,()=>{publish({state:'paused',code:'lease_unavailable'});void stop();});},30000);
    heartbeatTimer?.unref?.();
  }
  function sleep(ms,signal){
    return new Promise(resolve=>{
      if(signal.aborted)return resolve();
      const done=()=>{clearTimer(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimer(done,ms);
      timer?.unref?.();signal.addEventListener('abort',done,{once:true});
    });
  }
  async function ingest(endpoint,body,signal){await permitted(signal);return call(endpoint,{method:'POST',body,signal});}
  async function configuration(){return reportBrowserConfig({...await call(REPORTS+'config?collectorId='+encodeURIComponent(collectorId)),end_exclusive:true});}
  async function setup(config,signal){
    const engine=chromium||(await import('playwright')).chromium,binary=executablePath||engine.executablePath();
    if(!path.isAbsolute(binary||''))throw error('browser_install_required','Navigateur Chromium indisponible.');
    try{await checkExecutable(binary,constants.F_OK);}catch{throw error('browser_install_required','Installez le navigateur Chromium de Ludy.');}
    await permitted(signal);
    for(const directory of [paths.directory,paths.profile,paths.downloads,paths.ledger])await ensureDirectory(directory);
    ledger=await ledgerFactory(paths.ledger);await permitted(signal);
    browser=await engine.launchPersistentContext(paths.profile,{headless:false,chromiumSandbox:true,
      handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,executablePath:binary,acceptDownloads:true,
      downloadsPath:paths.downloads,viewport:{width:1280,height:900},timezoneId:'Africa/Casablanca',args:['--no-first-run']});
    await permitted(signal);
    browser.on('close',()=>{if(running){publish({state:'stopped',code:'browser_closed'});void stop();}});
    mainPage=browser.pages()[0]||await browser.newPage();
    await checkTimezone(mainPage,config,{now:now()});
    await mainPage.addInitScript(()=>{globalThis.__ludyLastUserInput=0;for(const type of ['pointerdown','keydown'])document.addEventListener(type,event=>{if(event.isTrusted)globalThis.__ludyLastUserInput=Date.now();},true);});
    await mainPage.goto(reportPageUrl(config),{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    await permitted(signal);publish({state:'login_required',code:null});
  }
  async function workPage(config,signal){
    await heartbeat();await permitted(signal);
    const page=await browser.newPage();
    try{await checkTimezone(page,config,{now:now()});await page.goto(reportPageUrl(config),{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});await permitted(signal);return page;}
    catch(error){await page.close().catch(()=>{});throw error;}
  }
  async function reports(config,signal){
    if(!config.report_types.some(type=>(ledger.get(ledger.key(config,type)).nextAt||0)<=now()))return;
    let selected=config;
    if(config.report_types.some(type=>{const at=ledger.get(ledger.key(config,type)).calendarUnavailableAt;return at&&now()<at+21600000;}))selected={...config,start_date:new Date(Date.parse(config.start_date)-86400000).toISOString().slice(0,10),end_date:new Date(Date.parse(config.end_date)-86400000).toISOString().slice(0,10)};
    if(!selected.report_types.some(type=>(ledger.get(ledger.key(selected,type)).nextAt||0)<=now()))return;
    let page;
    try{
      page=await workPage(selected,signal);
      collector=reportCollectorFactory({page,ledger,checkLease:heartbeat,now,
        ingest:(body,{signal:readSignal})=>ingest(REPORTS+'ingest',{collectorId,...body},AbortSignal.any([signal,readSignal])),
        onStatus:result=>publish({reports:publicCode(result.status),code:result.code?publicCode(result.code):null})});
      const result=await collector.tick(selected);await permitted(signal);
      publish({reports:publicCode(result.status),...(result.status==='imported'?{lastReportAt:new Date(now()).toISOString()}:{}),...(result.status==='login_required'?{state:'login_required'}:{})});
    }finally{const active=collector;collector=null;await active?.stop();await page?.close().catch(()=>{});}
  }
  async function earnings(config,signal){
    if(now()<nextEarningsAt)return;
    nextEarningsAt=now()+300000;let page;
    try{
      const finance=(await call('/api/provider-earnings/config')).uber;
      if(finance?.enabled!==true){publish({earnings:'disabled'});return;}
      if(finance.organization_id!==config.organization_id||finance.time_zone!=='Africa/Casablanca')throw error('configuration','La configuration des gains ne correspond pas à la flotte.');
      page=await workPage(config,signal);
      const factory=earningsCollectorFactory||(await import('../server/uber-earnings-browser-collector.mjs')).createUberEarningsBrowserCollector;
      collector=factory({page,now,checkLease:heartbeat,
        ingest:(value,{signal:readSignal})=>ingest('/api/provider-earnings/uber',{snapshot:value},AbortSignal.any([signal,readSignal])),
        onDiagnostic:value=>publish({earnings:'reading',code:value.code?publicCode(value.code):null})});
      let complete=true;
      for(const period of desktopEarningsPlan(now(),previousEarningsRead)){
        await permitted(signal);
        const result=await collector.collect({organizationId:finance.organization_id,dedicated:true,download:true,selectCustomRange:true,expectedPeriod:{start_at:period.start_at,end_at:period.end_at}});
        await permitted(signal);complete=complete&&result.complete;
        if(period.kind==='previous'&&result.complete)previousEarningsRead={end:period.end_at,at:now()};
      }
      earningsFailures=0;publish({earnings:complete?'ready':'partial',lastEarningsAt:new Date(now()).toISOString(),code:null});
    }catch(cause){
      if(cause.status===429||cause.code==='rate_limited'){earningsFailures++;nextEarningsAt=now()+Math.min(3600000,900000*2**Math.min(earningsFailures-1,2));}
      if(signal.aborted||[401,403,409].includes(cause.status))throw cause;
      publish({earnings:'action_required',code:publicCode(cause.code)});
    }finally{const active=collector;collector=null;await active?.stop();await page?.close().catch(()=>{});}
  }
  async function run(signal){
    while(running&&!signal.aborted){
      try{
        const config=await configuration();await permitted(signal);
        if(!mainPage||mainPage.isClosed())throw error('browser_closed','Fenêtre Uber fermée.');
        if(!sameFleetPage(mainPage.url(),config.organization_id)){publish({state:'login_required',code:null});await sleep(15000,signal);continue;}
        const pageState=await mainPage.evaluate(()=>({lastInput:globalThis.__ludyLastUserInput||0,login:!!document.querySelector('input[type="password"]')})).catch(()=>null);
        if(!pageState||pageState.login||now()-pageState.lastInput<15000){publish({state:pageState?.login?'login_required':'waiting',code:null});await sleep(15000,signal);continue;}
        publish({state:'running',code:null});await earnings(config,signal);await reports(config,signal);
      }catch(cause){
        if(signal.aborted)break;
        if([401,403,409].includes(cause.status)||['browser_timezone','browser_closed','stopped'].includes(cause.code))throw cause;
        publish({state:'action_required',code:publicCode(cause.code)});
      }
      await sleep(15000,signal);
    }
  }
  async function cleanup(){
    const active=collector,context=browser;collector=null;browser=null;mainPage=null;
    await Promise.allSettled([Promise.resolve().then(()=>active?.stop()),Promise.resolve().then(()=>context?.close())]);
    if(claimed){claimed=false;await request(REPORTS+'release',{method:'POST',body:{collectorId},signal:AbortSignal.timeout(5000)}).catch(()=>{});}
  }
  async function start(){
    if(closed)throw error('stopped','Navigateur arrêté.');if(stopping)await stopping;if(starting)return starting;if(running)return status();
    controller=new AbortController();running=true;nextEarningsAt=0;previousEarningsRead=null;earningsFailures=0;
    const signal=controller.signal;publish({state:'starting',code:null});
    starting=(async()=>{
      try{
        await call(REPORTS+'claim',{method:'POST',body:{collectorId}});claimed=true;
        const config=await configuration();await setup(config,signal);await permitted(signal);armHeartbeat();
        loop=run(signal).catch(cause=>{if(!signal.aborted)publish({state:'paused',code:publicCode(cause.code)});queueMicrotask(()=>{void stop();});});
        return status();
      }catch(cause){
        running=false;controller.abort();await cleanup();
        if(cause.code==='browser_install_required')publish({state:'browser-install-required',code:cause.code});
        else if(cause.code!=='stopped')publish({state:cause.code==='configuration'||cause.status===409?'configuration_required':'action_required',code:publicCode(cause.code)});
        throw cause;
      }
    })().finally(()=>starting=null);return starting;
  }
  function stop(){
    if(stopping)return stopping;running=false;controller?.abort();clearTimer(heartbeatTimer);heartbeatTimer=null;
    stopping=(async()=>{await Promise.allSettled([cleanup(),starting,loop,heartbeatPending]);await cleanup();publish({state:'stopped'});})().finally(()=>stopping=null);
    return stopping;
  }
  return {status,start,stop,async close(){closed=true;await stop();},async openLogin(){await start();await mainPage?.bringToFront();return status();}};
}
