#!/usr/bin/env node
import path from 'node:path';
import { constants } from 'node:fs';
import { open, rm, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readRuntime } from './guard.mjs';
import { LOCAL_DIR, SITE_URL, API_URL } from './paths.mjs';
import {moroccoOffsetMinutes} from '../server/morocco-time.mjs';
import {getRevenuePeriod} from '../site/revenue-metrics.js';
import { createReportLedger, createUberBrowserCollector, privateDirectory, reportBrowserConfig, reportPageUrl, isReportPage } from '../server/uber-report-browser-collector.mjs';

export const HELP=`Collecteur local des rapports Uber pour Ludy staging.

  npm --prefix staging run uber:reports-browser
  npm --prefix staging run uber:reports-browser -- --headless
  npm --prefix staging run uber:reports-browser -- --earnings
  npm --prefix staging run uber:reports-browser -- --earnings-only
  npm --prefix staging run uber:reports-browser -- --help

Un navigateur Chromium dédié s’ouvre. Connectez-vous normalement à Uber
(avec la validation habituelle si elle est demandée), puis gardez cette
fenêtre ouverte. Votre profil Chromium personnel n’est jamais utilisé.
Après cette connexion, --headless réutilise la session dédiée sans fenêtre.
Une nouvelle demande de connexion impose de relancer sans cette option.

Profil privé : staging/.local/uber-reports-browser/profile
Les CSV d’activité passent par l’import et l’archivage privés de Ludy.
--earnings relit Earnings au moins 5 min après la fin du dernier relevé ;
un export direct peut compléter la lecture si la page le propose. Une limitation
du fournisseur espace les tentatives. --earnings-only conserve uniquement cette lecture financière.
La semaine en cours et la précédente sont sélectionnées dans Custom range,
avec relecture obligatoire lundi04h → lundi04h, heure du Maroc. La semaine
précédente est relue au démarrage, au changement de semaine puis chaque jour.
Une semaine en cours conserve sa date réelle d’observation. La session et le bail restent partagés.
La Live Map de l’extension reste indépendante ; ses rapports sont suspendus
pendant le bail de ce collecteur. Ctrl+C ou fermer ce navigateur arrête la
collecte et libère ce bail.
`;
const publicError=message=>Object.assign(Error(message),{publicMessage:message});
export function createLeaseRecovery({claim,heartbeat,pause,onChange=()=>{}}){
 let paused=false,pausePending=Promise.resolve();
 function suspend(){if(!paused){paused=true;pausePending=Promise.resolve(pause()).catch(()=>{});onChange(false);}}
 async function beat(){if(paused)throw Object.assign(publicError('Collecte suspendue pendant la reconnexion locale.'),{status:503});try{return await heartbeat();}catch(error){suspend();throw error;}}
 async function recover(){await pausePending;try{await claim();paused=false;onChange(true);return true;}catch(error){if([401,403,409].includes(error.status))throw error;return false;}}
 return {beat,recover,suspend,get paused(){return paused;}};
}
function sleep(ms,signal){return new Promise(resolve=>{if(signal.aborted)return resolve();const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});});}
async function privateJson(filename){const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.size>65536)throw Error();return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}}
async function profileLock(directory){
 const filename=path.join(directory,'run.lock');
 for(let attempt=0;attempt<2;attempt++){
  try{const file=await open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.writeFile(JSON.stringify({pid:process.pid})+'\n');await file.close();return async()=>{await rm(filename,{force:true});};}
  catch(error){if(error.code!=='EEXIST')throw error;let prior;try{prior=await privateJson(filename);}catch{throw publicError('Verrou du navigateur illisible. Vérifiez que le collecteur est arrêté.');}if(!Number.isInteger(prior.pid)||prior.pid<=0)throw publicError('Verrou du navigateur invalide.');let alive=true;try{process.kill(prior.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}if(alive)throw publicError('Un collecteur utilise déjà ce profil. Arrêtez-le avant de relancer.');await rm(filename);}
 }
 throw publicError('Le profil du navigateur est déjà utilisé.');
}
export async function assertReportBrowserTimezone(page,config,{now=Date.now()}={}){
 const samples=[now,Date.parse(config.start_date+'T00:00:00Z'),Date.parse(config.end_date+'T00:00:00Z')+86400000],expected=samples.map(at=>-moroccoOffsetMinutes(at)),actual=await page.evaluate(samples=>({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,offsets:samples.map(at=>new Date(at).getTimezoneOffset())}),samples);
 if(actual?.zone!=='Africa/Casablanca'||!Array.isArray(actual.offsets)||actual.offsets.length!==expected.length||actual.offsets.some((offset,index)=>offset!==expected[index]))throw Object.assign(publicError('Les règles horaires du navigateur sont incompatibles avec l’heure du Maroc. Utilisez le Chromium Playwright à jour ; aucune génération de rapport n’a été demandée.'),{code:'browser_timezone'});
}
export function previousCompleteReportPeriod(config){return {...config,start_date:new Date(Date.parse(config.start_date)-86400000).toISOString().slice(0,10),end_date:new Date(Date.parse(config.end_date)-86400000).toISOString().slice(0,10),period_lag_days:1};}
export function parseUberBrowserArgs(args){
 if(!Array.isArray(args)||new Set(args).size!==args.length||args.some(arg=>!['--headless','--earnings','--earnings-only'].includes(arg))||args.includes('--earnings')&&args.includes('--earnings-only'))throw publicError('Arguments incompatibles ou inconnus. Utilisez --help.');
 return {headless:args.includes('--headless'),earnings:args.includes('--earnings')||args.includes('--earnings-only'),reports:!args.includes('--earnings-only')};
}
export function createEarningsSchedule({run,now=Date.now}={}){
 if(typeof run!=='function')throw new TypeError('Tâche Earnings requise.');let nextAt=0,pending=null,rateFailures=0;
 return {due:()=>!pending&&now()>=nextAt,tick(config){if(pending)return pending;if(now()<nextAt)return Promise.resolve({status:'waiting'});let delay=300000;pending=Promise.resolve().then(()=>run(config,{download:true})).then(result=>{rateFailures=0;return result;},error=>{if(error.status===429||error.code==='rate_limited'){rateFailures++;delay=Math.min(3600000,900000*2**Math.min(rateFailures-1,2));}throw error;}).finally(()=>{nextAt=now()+delay;pending=null;});return pending;}};
}
export function earningsWeekPlan({at=Date.now(),previousRead=null}={}){
 const period=getRevenuePeriod({kind:'week',at,timeZone:'Africa/Casablanca',weekStartHour:4});
 const plan=[{kind:'current',start_at:period.start,end_at:period.end}];
 if(previousRead?.end!==period.previousEnd||!Number.isFinite(previousRead?.at)||at-previousRead.at>=86400000)plan.push({kind:'previous',start_at:period.previousStart,end_at:period.previousEnd});
 return plan;
}
function sameFleetPage(url,organizationId){try{const u=new URL(url);return u.origin==='https://fleethub.uber.com'&&!u.username&&!u.password&&u.pathname.startsWith('/orgs/'+organizationId+'/');}catch{return false;}}
export async function main(args=process.argv.slice(2)){
 if(args.includes('--help')||args.includes('-h')){console.log(HELP);return;}
 const {headless,earnings:earningsEnabled,reports:reportsEnabled}=parseUberBrowserArgs(args);
 let health;try{const response=await fetch(SITE_URL+'/health',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();health=await response.json();}catch{throw publicError('Démarrez Ludy staging sur http://127.0.0.1:4173 avant ce collecteur.');}
 if(health?.environment!=='staging'||health.project!=='ludy-staging')throw publicError('Le serveur ne correspond pas au staging local Ludy.');
 const runtime=readRuntime(),credentials=await privateJson(path.join(LOCAL_DIR,'credentials.json'));
 if(credentials.environment!=='staging-local-only'||credentials.siteUrl!==SITE_URL||typeof credentials.email!=='string'||typeof credentials.password!=='string'||!credentials.userId)throw publicError('Compte administrateur local indisponible. Relancez le staging.');
 // Earnings normalization loads the installed spreadsheet parser. Keep help,
 // offline source validation and the activity-only CLI independent of it.
 const createUberEarningsBrowserCollector=earningsEnabled?(await import('../server/uber-earnings-browser-collector.mjs')).createUberEarningsBrowserCollector:null;
 const directory=path.join(LOCAL_DIR,'uber-reports-browser');await privateDirectory(directory);await privateDirectory(path.join(directory,'profile'));await privateDirectory(path.join(directory,'downloads'));
 const unlock=await profileLock(directory),collectorId=randomUUID(),shutdown=new AbortController();let browser=null,collector=null,heartbeat=null,claimed=false,auth=null,authPending=null,leasePending=false,fatal=null,stopReason=null;
 const halt=reason=>{if(!shutdown.signal.aborted)stopReason=reason;shutdown.abort();},interrupt=()=>halt('interruption du terminal'),terminate=()=>halt('arrêt demandé au processus'),hangup=()=>halt('terminal fermé (SIGHUP)');process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);process.once('SIGHUP',hangup);
 async function token(){
  if(auth?.expiresAt>Date.now()+60000)return auth.token;
  if(!authPending)authPending=(async()=>{const response=await fetch(API_URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:runtime.anonKey,'Content-Type':'application/json'},body:JSON.stringify({email:credentials.email,password:credentials.password}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});if(!response.ok)throw publicError('Connexion au compte administrateur local refusée. Vérifiez staging/.local/credentials.json.');const result=await response.json();if(result.user?.id!==credentials.userId||typeof result.access_token!=='string')throw publicError('Compte administrateur local incohérent.');auth={token:result.access_token,expiresAt:Date.now()+Math.min(Number(result.expires_in)||3600,3600)*1000};return auth.token;})().finally(()=>authPending=null);
  return authPending;
 }
 async function request(endpoint,{method='GET',body,provider=false,signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(20000)])}={}){
  const jwt=await token();const response=await fetch(SITE_URL+(provider?'/api/provider-earnings/':'/api/uber-reports/browser/')+endpoint,{method,headers:{Authorization:'Bearer '+jwt,Origin:SITE_URL,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',credentials:'omit',cache:'no-store',signal});
  if(!response.ok){const error=publicError([401,403].includes(response.status)?'Accès administrateur local refusé.':response.status===409?'Le bail des rapports est indisponible ou appartient à un autre collecteur.':'Serveur Ludy indisponible pour les rapports.');error.status=response.status;const details=await response.json().catch(()=>null);error.localFileStored=details?.local_file?.stored===true;if(details?.code==='timezone_required')error.code='timezone_required';throw error;}
  const text=await response.text();return text?JSON.parse(text):{};
 }
 const recovery=createLeaseRecovery({claim:()=>request('claim',{method:'POST',body:{collectorId}}),heartbeat:()=>request('heartbeat',{method:'POST',body:{collectorId}}),pause:()=>collector?.pause(),onChange:connected=>console.log(connected?'Ludy local retrouvé. Bail confirmé, reprise de la collecte.':'Ludy local indisponible. Collecte suspendue ; le navigateur reste ouvert.')});
 const beat=()=>recovery.beat();
 function unavailable(error){if(error.code==='browser_timezone'||[401,403].includes(error.status)||error.status>=400&&error.status<500&&error.status!==409){fatal=error;shutdown.abort();void collector?.pause();}else recovery.suspend();}
 try{
  await request('claim',{method:'POST',body:{collectorId}});claimed=true;
  heartbeat=setInterval(()=>{if(leasePending||shutdown.signal.aborted||recovery.paused)return;leasePending=true;void beat().catch(unavailable).finally(()=>leasePending=false);},30000);
  const config=reportBrowserConfig({...await request('config?collectorId='+encodeURIComponent(collectorId)),end_exclusive:true}),ledger=await createReportLedger(path.join(directory,'morocco-calendar'));
  const {chromium}=await import('playwright');
  console.log(headless?'Reprise du navigateur Uber dédié sans fenêtre, avec sa session existante. Si Uber demande une connexion, relancez sans --headless.':'Ouverture du navigateur Uber dédié à Ludy. Connectez-vous normalement ; aucun identifiant Uber n’est demandé dans ce terminal.');
  try{browser=await chromium.launchPersistentContext(path.join(directory,'profile'),{headless,chromiumSandbox:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,executablePath:process.env.LUDY_REPORTS_CHROMIUM||chromium.executablePath(),acceptDownloads:true,downloadsPath:path.join(directory,'downloads'),viewport:{width:1280,height:900},timezoneId:'Africa/Casablanca',args:['--no-first-run']});}catch{throw publicError('Impossible d’ouvrir Chromium. Vérifiez le Chromium fourni avec Playwright ou LUDY_REPORTS_CHROMIUM ; le mode visible nécessite une session graphique.');}
  browser.on('close',()=>halt('navigateur Chromium dédié fermé ou interrompu'));const page=browser.pages()[0]||await browser.newPage();await assertReportBrowserTimezone(page,config);page.on('close',()=>{if(!headless)halt('connexion à l’onglet principal Uber interrompue');});
  await page.addInitScript(()=>{globalThis.__ludyLastUserInput=0;for(const type of ['pointerdown','keydown'])document.addEventListener(type,event=>{if(event.isTrusted)globalThis.__ludyLastUserInput=Date.now();},true);});
  await page.goto(reportPageUrl(config),{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
  let lastStatus='',fallbackNotice=null,diagnosticWrites=Promise.resolve();
  const saveDiagnostic=result=>{const value={at:new Date().toISOString(),status:result.status,report_type:result.reportType||null,code:result.code||null,phase:result.phase||null,diagnostic:result.diagnostic||null};diagnosticWrites=diagnosticWrites.then(async()=>{const target=path.join(directory,'last-diagnostic.json'),temporary=target+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,target);if(value.diagnostic){await writeFile(path.join(directory,value.report_type+'-diagnostic.json'),JSON.stringify(value)+'\n',{mode:0o600});}}finally{await rm(temporary,{force:true}).catch(()=>{});}}).catch(()=>{});};
  const createCollector=workingPage=>createUberBrowserCollector({page:workingPage,ledger,checkLease:beat,ingest:async(body,{signal})=>{try{return await request('ingest',{method:'POST',body:{collectorId,...body},signal:AbortSignal.any([signal,shutdown.signal,AbortSignal.timeout(20000)])});}catch(error){if(!signal.aborted&&(!error.status||error.status>=500||error.status===409))recovery.suspend();throw error;}},onStatus:result=>{saveDiagnostic(result);const key=[result.status,result.reportType,result.code,result.phase,result.diagnostic?.kind].join(':');if(key===lastStatus)return;lastStatus=key;const names={trip_activity:'Courses',driver_activity:'Activité chauffeurs',driver_quality:'Qualité chauffeurs'},messages={imported:'CSV reçu par Ludy et traité par son archivage privé.',waiting_report:'Attente du rapport déjà demandé ; aucune demande en double.',login_required:'Connectez-vous à Uber et revenez aux rapports de la flotte configurée.',retrying:'Lecture interrompue ; nouvelle vérification dans une minute.',action_required:result.message||'Vérifiez le tableau des rapports dans ce navigateur.',stopped:'Collecte arrêtée.'};console.log((names[result.reportType]||'Uber')+' : '+(messages[result.status]||result.status)+(result.phase?' [étape : '+result.phase+' ; diagnostic : '+(result.diagnostic?.kind||result.code||'indisponible')+']':''));}});
  let lastEarningsStatus='',previousEarningsRead=null;
  const earningsSchedule=createEarningsSchedule({run:async(current,{download})=>{
   const response=await request('config',{provider:true}),finance=response?.uber;
   if(finance?.enabled!==true)return {status:'disabled'};
   if(finance.organization_id!==current.organization_id||finance.time_zone!=='Africa/Casablanca')throw publicError('Configuration Earnings incohérente avec la flotte et le fuseau du navigateur.');
   let workingPage;
   try{
    await beat();workingPage=await browser.newPage();await assertReportBrowserTimezone(workingPage,current);await workingPage.goto(reportPageUrl(current),{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    collector=createUberEarningsBrowserCollector({page:workingPage,checkLease:beat,onDiagnostic:diagnostic=>saveDiagnostic({reportType:'earnings',status:diagnostic.kind==='failure'?'retrying':'reading',code:diagnostic.code,phase:diagnostic.phase,diagnostic}),ingest:(snapshot,{signal})=>request('uber',{provider:true,method:'POST',body:{snapshot},signal:AbortSignal.any([signal,shutdown.signal,AbortSignal.timeout(20000)])})});
    let currentResult,complete=true;
    for(const period of earningsWeekPlan({at:Date.now(),previousRead:previousEarningsRead})){
     const result=await collector.collect({organizationId:finance.organization_id,dedicated:true,download,expectedPeriod:{start_at:period.start_at,end_at:period.end_at},selectCustomRange:true});
     complete=complete&&result.complete;if(period.kind==='current')currentResult=result;
     if(period.kind==='previous'&&result.complete)previousEarningsRead={end:period.end_at,at:Date.now()};
    }
    return {status:complete?'ready':'partial',rows:currentResult.rows,period:currentResult.providerPeriod};
   }finally{await collector?.stop();collector=null;await workingPage?.close().catch(()=>{});}
  }});
  while(!shutdown.signal.aborted){
   if(recovery.paused){if(!await recovery.recover()){await sleep(15000,shutdown.signal);continue;}}
   let current;try{current=reportBrowserConfig({...await request('config?collectorId='+encodeURIComponent(collectorId)),end_exclusive:true});}catch(error){if(error.code==='configuration')throw error;unavailable(error);await sleep(15000,shutdown.signal);continue;}
   if(recovery.paused||shutdown.signal.aborted)continue;
   const basePeriodKey=current.start_date+':'+current.end_date;if(current.report_types.some(type=>{const at=ledger.get(ledger.key(current,type)).calendarUnavailableAt;return at&&Date.now()<at+21600000;})){current=previousCompleteReportPeriod(current);if(fallbackNotice!==basePeriodKey){console.log('Calendrier Uber indisponible pour la dernière borne : collecte explicite du '+current.start_date+' au '+current.end_date+' inclus. La période récente reste incomplète.');fallbackNotice=basePeriodKey;}}else fallbackNotice=null;
   const due=reportsEnabled&&current.report_types.some(type=>(ledger.get(ledger.key(current,type)).nextAt||0)<=Date.now()),earningsDue=earningsEnabled&&earningsSchedule.due();
   if(!due&&!earningsDue){await sleep(15000,shutdown.signal);continue;}
   if(!headless&&!(earningsEnabled?sameFleetPage(page.url(),current.organization_id):isReportPage(page.url(),current))){if(lastStatus!=='login'){console.log('Connectez-vous à Uber dans la fenêtre principale, puis ouvrez les rapports de la flotte configurée.');lastStatus='login';}await sleep(15000,shutdown.signal);continue;}
   const state=headless?{lastInput:0,login:false}:await page.evaluate(()=>({lastInput:globalThis.__ludyLastUserInput||0,login:!!document.querySelector('input[type="password"]')})).catch(()=>null);
   if(headless&&state?.login)throw publicError('Connexion Uber requise : relancez sans --headless pour terminer la connexion normale.');
   if(!state||state.login||Date.now()-state.lastInput<15000){await sleep(15000,shutdown.signal);continue;}
   if(earningsDue){
    try{const result=await earningsSchedule.tick(current),key=result.status; if(key!==lastEarningsStatus){lastEarningsStatus=key;console.log('Earnings : '+({ready:'relevé financier reçu, période fournisseur exacte conservée.',partial:'lecture reçue avec une couverture partielle.',disabled:'lecture désactivée dans Ludy.'}[key]||'en attente.'));}}
    catch(error){const code=error.code||'earnings_unavailable';if([401,403,409].includes(error.status)||error.status>=500)unavailable(error);if(code!==lastEarningsStatus){lastEarningsStatus=code;console.log('Earnings : lecture interrompue ['+String(code).replace(/[^a-z_]/gi,'').slice(0,60)+']. Vérifiez la page Earnings ; les lectures d’activité restent indépendantes.');}}
    if(recovery.paused||shutdown.signal.aborted)continue;
   }
   if(!due){await sleep(15000,shutdown.signal);continue;}
   // Every work page is used for one cycle only. A delayed download from an
   // earlier page can never satisfy the next page's download listener.
   let workingPage;
   try{
    await beat();if(recovery.paused||shutdown.signal.aborted)continue;
    workingPage=await browser.newPage();await assertReportBrowserTimezone(workingPage,current);
    await workingPage.goto(reportPageUrl(current),{waitUntil:'networkidle',timeout:20000}).catch(()=>{});
    if(recovery.paused||shutdown.signal.aborted)continue;
    collector=createCollector(workingPage);const result=await collector.tick(current);if(headless&&result.status==='login_required'){fatal=publicError('Connexion Uber requise : relancez sans --headless pour terminer la connexion normale.');shutdown.abort();}
   }catch(error){unavailable(error);}
   finally{await collector?.stop();collector=null;await workingPage?.close().catch(()=>{});}
   await sleep(15000,shutdown.signal);
  }
  if(fatal)throw fatal;if(stopReason)console.log('Collecte arrêtée : '+stopReason+'.');
 }finally{
  shutdown.abort();clearInterval(heartbeat);await collector?.stop();await browser?.close().catch(()=>{});
  if(claimed)await request('release',{method:'POST',body:{collectorId},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  await unlock();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);process.removeListener('SIGHUP',hangup);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().catch(error=>{console.error(error.name==='AbortError'?'Collecte arrêtée.':error.publicMessage||(['configuration','storage'].includes(error.code)?error.message:'Collecteur interrompu. Vérifiez le serveur local et la fenêtre Chromium, puis relancez la commande.'));process.exitCode=error.name==='AbortError'?0:1;});}
