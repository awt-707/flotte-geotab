import {privateModeValid,syncPrivateDirectory} from './private-files.mjs';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TYPES=['trip_activity','driver_activity','driver_quality'],MAX_BYTES=6*1024*1024,HOUR=3600000;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fail=(code,message)=>Object.assign(Error(message),{code});
const readerSource=await readFile(new URL('../uber-extension/reports-reader.js',import.meta.url),'utf8');
const consumedDownloadPages=new WeakSet();
export function reportBrowserConfig(value){
 if(value?.enabled!==true||!UUID.test(value.organization_id||'')||!Array.isArray(value.report_types)||!value.report_types.length||value.report_types.some(type=>!TYPES.includes(type))||new Set(value.report_types).size!==value.report_types.length)throw fail('configuration','Rapports Uber désactivés ou non configurés dans Ludy.');
 for(const key of ['start_date','end_date'])if(!/^\d{4}-\d{2}-\d{2}$/.test(value[key]||'')||new Date(value[key]).toISOString().slice(0,10)!==value[key])throw fail('configuration','Période des rapports invalide.');
 const duration=Date.parse(value.end_date)-Date.parse(value.start_date);if(duration<0||duration>31*86400000)throw fail('configuration','Période des rapports invalide.');
 return {...value,organization_id:value.organization_id.toLowerCase(),interval_seconds:Math.max(21600,Number(value.interval_seconds)||21600)};
}
export function reportPageUrl(config){return 'https://fleethub.uber.com/orgs/'+config.organization_id+'/reports';}
export function isReportPage(url,config){try{const u=new URL(url);return u.origin==='https://fleethub.uber.com'&&!u.username&&!u.password&&(u.pathname==='/orgs/'+config.organization_id+'/reports'||u.pathname==='/orgs/'+config.organization_id+'/reports/');}catch{return false;}}
export function reportPageState(url,config){if(isReportPage(url,config))return 'reports';try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password&&['auth.uber.com','login.uber.com','accounts.uber.com'].includes(u.hostname))return 'login';if(u.origin==='https://fleethub.uber.com'&&/^\/orgs\/[a-f0-9-]+\/reports\/?$/i.test(u.pathname))return 'wrong_organization';}catch{}return 'navigation_pending';}
export async function privateDirectory(directory){
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||!privateModeValid(info,0o700,directory)||await realpath(directory)!==path.resolve(directory))throw fail('storage','Dossier privé du navigateur invalide (0700 requis).');
}
export async function createReportLedger(directory){
 await privateDirectory(directory);const filename=path.join(directory,'report-jobs.json');let entries={};
 try{const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||!privateModeValid(info,0o600,filename)||info.size>131072)throw Error();const data=JSON.parse(await file.readFile('utf8'));if(data.version!==1||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))throw Error();for(const [key,row]of Object.entries(data.entries)){if(!/^[a-f0-9-]{36}:(?:trip_activity|driver_activity|driver_quality):\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(key)||!row||typeof row!=='object'||Array.isArray(row)||['requestedAt','importedAt','nextAt','calendarUnavailableAt'].some(field=>row[field]!=null&&(!Number.isFinite(row[field])||row[field]<0)))throw Error();entries[key]={requestedAt:row.requestedAt||null,importedAt:row.importedAt||null,nextAt:row.nextAt||0,calendarUnavailableAt:row.calendarUnavailableAt||null};}}finally{await file.close();}}catch(error){if(error.code!=='ENOENT')throw fail('storage','Journal privé des rapports illisible ; aucune nouvelle génération demandée.');}
 let queue=Promise.resolve();
 const key=(config,type)=>[config.organization_id,type,config.start_date,config.end_date].join(':');
 function update(id,patch){const job=queue.then(async()=>{const next={...entries,[id]:{...(entries[id]||{}),...patch}},cutoff=Date.now()-90*86400000;for(const [k,v]of Object.entries(next))if(Math.max(v.requestedAt||0,v.importedAt||0,v.nextAt||0)<cutoff)delete next[k];const tmp=filename+'.'+randomUUID()+'.tmp';let handle;try{handle=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(JSON.stringify({version:1,entries:next})+'\n');await handle.sync();await handle.close();handle=null;await rename(tmp,filename);await syncPrivateDirectory(directory);entries=next;}finally{await handle?.close();await rm(tmp,{force:true});}});queue=job.catch(()=>{});return job;}
 return {key,get:id=>({...entries[id]}),update};
}

// Runs only in the dedicated Reports page. It returns the exact DOM control,
// never a reconstructed provider endpoint or a list of browser downloads.
function scanPage(config){
 const reader=globalThis.LudyUberReportsReader;
 if(!reader?.permittedUrl(location.href)||reader.organizationId(location.href)!==config.organization_id)throw Error('wrong_organization');
 const visible=node=>{if(!node||node.hidden||node.closest('[hidden],[aria-hidden="true"]'))return false;const css=getComputedStyle(node);return css.display!=='none'&&css.visibility!=='hidden'&&node.getClientRects().length>0;};
 if([...document.querySelectorAll('input[type="password"]')].some(visible))return {state:'login'};
 const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/_/g,' ').replace(/\s+/g,' ').trim();
 const labels={trip_activity:['trip activity','trip history','activite liee aux courses','activite des courses','historique des courses'],driver_activity:['driver activity','activite des chauffeurs','activite des conducteurs'],driver_quality:['driver quality','qualite des chauffeurs','qualite des conducteurs']}[config.report_type];

 const rows=[...document.querySelectorAll('tr,[role="row"],li,article,[data-report-id]')].filter(visible).filter(row=>{const words=normalize(row.innerText||row.textContent);return words.length<=2500&&labels.some(label=>words.includes(label))&&reader.rowPeriodMatches(row,config);});
 const unique=rows.filter(row=>!rows.some(other=>other!==row&&row.contains(other)));
 if(unique.length>1)return {state:'ambiguous'};
 if(!unique.length)return {state:'missing'};
 const buttons=[...unique[0].querySelectorAll('button,a,[role="button"]')].filter(node=>visible(node)&&/^(download|telecharger)$/.test(normalize(node.innerText||node.textContent||node.getAttribute('aria-label'))));
 if(buttons.length>1)return {state:'ambiguous'};
 const button=buttons[0];if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')return {state:'pending'};
 return {state:'download',button};
}
function beginPageTask(id){
 globalThis.__ludyBrowserReportTask?.dispose?.();const controller=new AbortController();
 const cancel=event=>{if(event.isTrusted)controller.abort();};document.addEventListener('pointerdown',cancel,true);document.addEventListener('keydown',cancel,true);
 globalThis.__ludyBrowserReportTask={id,controller,dispose(){controller.abort();document.removeEventListener('pointerdown',cancel,true);document.removeEventListener('keydown',cancel,true);}};
}
function pageTaskCurrent(id){const task=globalThis.__ludyBrowserReportTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('user_interaction');return true;}
async function preparePage({config,id}){
 const task=globalThis.__ludyBrowserReportTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('user_interaction');const reader=globalThis.LudyUberReportsReader;
 task.config=config;let form=reader.inspect(document,location.href,config);
 if(form.status==='landing'){form.open.click();form=await reader.waitFor(()=>{try{const next=reader.inspect(document,location.href,config);return next.status==='form'?next:null;}catch{return null;}},{signal:task.controller.signal,timeout:5000});}
 if(form.status!=='form')throw Error('form_unrecognized');await reader.prepareForm(form,config,{signal:task.controller.signal,onStep:field=>task.field=field});
 if(task.controller.signal.aborted)throw Error('user_interaction');reader.verify(reader.inspect(document,location.href,config),config);return true;
}
function generatePage({config,id}){const task=globalThis.__ludyBrowserReportTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('user_interaction');const reader=globalThis.LudyUberReportsReader;reader.generate(reader.inspect(document,location.href,config),config);return true;}
function reportDiagnosticPage(message){
 const reader=globalThis.LudyUberReportsReader,kind=reader?.diagnostic?.({message})||null,raw=reader?.structure?.(document),names=['report_type','start_date','end_date','start_time','end_time','organization'];
 const count=n=>Number.isInteger(n)&&n>=0&&n<=20?n:0,allowed=(v,items)=>Array.isArray(v)?[...new Set(v.filter(x=>items.includes(x)))]:[];
 let checks=null;try{const cfg=globalThis.__ludyBrowserReportTask?.config;if(cfg){const result=reader.verification(reader.inspect(document,location.href,cfg),cfg);checks=Object.fromEntries([...names,'generate_enabled'].map(k=>[k,result[k]===true]));}}catch{}
 return {kind,checks,field:[...names,'verify'].includes(globalThis.__ludyBrowserReportTask?.field)?globalThis.__ludyBrowserReportTask.field:null,structure:raw?{scope:['dialog','drawer','document'].includes(raw.scope)?raw.scope:'document',matches:Object.fromEntries(['report_type','start_date','end_date','generate','organization'].map(k=>[k,count(raw.matches?.[k])])),fields:(raw.fields||[]).filter(f=>names.includes(f.field)).slice(0,6).map(f=>({field:f.field,labels:count(f.labels),tags:allowed(f.tags,['INPUT','SELECT','BUTTON','DIV','SPAN','LABEL','TEXTAREA','OPTION']),roles:allowed(f.roles,['combobox','button','listbox','option','checkbox','textbox']),inputs:allowed(f.inputs,['text','date','time','checkbox','other']),readonly:count(f.readonly),values:allowed(f.values,['empty','date_ymd','time','report_type','other'])}))}:null};
}
function bounded(work,signal){const pending=Promise.resolve(work);if(signal.aborted){void pending.catch(()=>{});return Promise.reject(fail('stopped','Lecture arrêtée.'));}return new Promise((resolve,reject)=>{const abort=()=>reject(fail('stopped','Lecture arrêtée.'));signal.addEventListener('abort',abort,{once:true});pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
export async function readReportDownload(download,{signal,maxBytes=MAX_BYTES}={}){
 let stream;const chunks=[];let bytes=0;
 try{
  if(signal?.aborted)throw fail('stopped','Lecture arrêtée.');
  const filename=download.suggestedFilename();if(typeof filename!=='string'||filename.length>200||/[\\/\0]/.test(filename)||!filename.toLowerCase().endsWith('.csv'))throw fail('not_csv','Uber n’a pas fourni un fichier CSV.');
  stream=await download.createReadStream();if(!stream)throw fail('download','Téléchargement Uber indisponible.');
  // Node expects _read to report failures through destroy(error), not through
  // a returned promise. Playwright 1.56 returns an async _read whose channel
  // can reject after cancellation. Keep that rejection on this stream.
  const originalRead=stream._read;
  stream._read=function(size){try{const pending=originalRead.call(this,size);if(pending&&typeof pending.then==='function')void Promise.resolve(pending).catch(error=>this.destroy(error));}catch(error){this.destroy(error);}};
  const abort=()=>stream.destroy(fail('stopped','Lecture arrêtée.'));signal?.addEventListener('abort',abort,{once:true});
  try{if(signal?.aborted)abort();for await(const chunk of stream){bytes+=chunk.length;if(bytes>maxBytes)throw fail('oversize','Rapport supérieur à 6 Mo.');chunks.push(chunk);}}finally{signal?.removeEventListener('abort',abort);stream.destroy();}
  if(signal?.aborted)throw fail('stopped','Lecture arrêtée.');let csv;try{csv=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{throw fail('not_csv','Le CSV téléchargé n’est pas encodé en UTF-8.');}return {filename,csv};
 }catch(error){await download.cancel().catch(()=>{});throw error;}
}
export function createUberBrowserCollector({page,ledger,checkLease,ingest,now=Date.now,onStatus=()=>{},taskTimeout=45000,downloadTimeout=20000,generationTimeout=15000}){
 let closed=false,pending=null,controller=null,cursor=0;
 const pageClosed=()=>{closed=true;controller?.abort();};page.on('close',pageClosed);
 const assertActive=signal=>{if(closed||signal.aborted||page.isClosed())throw fail('stopped','Lecture arrêtée.');};
 async function current(config,id,signal){assertActive(signal);if(!isReportPage(page.url(),config))throw fail('wrong_organization','Revenez aux rapports de la flotte configurée dans Ludy.');await bounded(page.evaluate(pageTaskCurrent,id),signal);assertActive(signal);}
 async function scan(config,signal){const handle=await bounded(page.evaluateHandle(scanPage,config),signal);const state=await handle.evaluate(value=>value.state);return {handle,state};}
 async function waitForGeneration(config,id,signal){
  const deadline=Date.now()+generationTimeout;
  while(Date.now()<deadline){
   await current(config,id,signal);const reading=await scan(config,signal);
   try{if(reading.state==='pending'||reading.state==='download')return;if(reading.state==='ambiguous')throw fail('ambiguous','Plusieurs rapports de ce type et de cette période sont visibles.');}finally{await reading.handle.dispose();}
   await bounded(new Promise(resolve=>setTimeout(resolve,150)),signal);
  }
  throw fail('generation_unconfirmed','Demande envoyée, confirmation Uber non reçue. Aucune nouvelle génération automatique de ce rapport.');
 }
 async function process(config,type){
  controller=new AbortController();const own=controller,signal=own.signal,timer=setTimeout(()=>own.abort(),taskTimeout),id=randomUUID(),report={...config,report_type:type},key=ledger.key(config,type),old=ledger.get(key),downloads=[],downloadGuard=new AbortController();let handle=null,download=null,phase='lease';
  const capture=item=>{downloads.push(item);if(downloads.length>1)downloadGuard.abort();};
  try{
   assertActive(signal);await bounded(checkLease(),signal);assertActive(signal);
   const pageState=reportPageState(page.url(),config);if(pageState==='login')return {status:'login_required',reportType:type,message:'Connectez-vous à Uber dans ce navigateur, puis ouvrez les rapports de la flotte configurée.',retryIn:15000};if(pageState==='wrong_organization')throw fail('wrong_organization','Revenez aux rapports de la flotte configurée dans Ludy.');if(pageState!=='reports')throw fail('navigation_pending','Navigation vers les rapports encore incomplète.');
   phase='read_page';await bounded(page.evaluate(readerSource),signal);await bounded(page.evaluate(beginPageTask,id),signal);
   let reading=await scan(report,signal);handle=reading.handle;
   if(reading.state==='login')return {status:'login_required',reportType:type,retryIn:15000};
   if(reading.state==='ambiguous')throw fail('ambiguous','Plusieurs rapports de ce type et de cette période sont visibles.');
   if(reading.state==='pending'||reading.state==='missing'&&old.requestedAt){await ledger.update(key,{requestedAt:old.requestedAt||now(),nextAt:now()+60000});return {status:'waiting_report',reportType:type,retryIn:60000};}
   if(reading.state==='missing'){
    phase='prepare_form';
    await bounded(page.evaluate(preparePage,{config:report,id}),signal);await current(config,id,signal);await bounded(checkLease(),signal);await current(config,id,signal);
    // Durable intent is written before the final normal Generate click. A
    // crash after that point never creates another report for this period.
    phase='reserve_report';await ledger.update(key,{requestedAt:now(),nextAt:now()+60000});await current(config,id,signal);
    await handle.dispose();reading=await scan(report,signal);handle=reading.handle;
    if(reading.state==='missing'){phase='generate_report';await bounded(page.evaluate(generatePage,{config:report,id}),signal);await waitForGeneration(report,id,signal);}
    return {status:'waiting_report',reportType:type,retryIn:60000};
   }
   if(reading.state!=='download')throw fail('page','Tableau des rapports non reconnu.');
   await current(config,id,signal);await bounded(checkLease(),signal);await current(config,id,signal);
   const button=await handle.getProperty('button'),element=button.asElement();if(!element)throw fail('page','Bouton Download indisponible.');
   phase='download';consumedDownloadPages.add(page);page.on('download',capture);const event=page.waitForEvent('download',{timeout:downloadTimeout});
   // A DOM click uses only the exact rendered control. Real pointer/keyboard
   // interaction still aborts this task and cannot supply another user's file.
   const clicked=element.evaluate(node=>node.click());
   [download]=await bounded(Promise.all([event,clicked]),signal);await current(config,id,signal);
   const captureSignal=AbortSignal.any([signal,downloadGuard.signal]);
   const file=await bounded(readReportDownload(download,{signal:captureSignal}),captureSignal);await bounded(new Promise(resolve=>setTimeout(resolve,250)),captureSignal);await current(config,id,signal);
   if(downloads.length!==1||downloads[0]!==download)throw fail('download_ambiguous','Plusieurs téléchargements ont été déclenchés. Aucun fichier importé.');
   // The local backend owns CSV structure/business validation and archives
   // structurally valid reports even when Uber introduces new column names.
   await current(config,id,signal);
   phase='ingest';const result=await bounded(ingest({organizationId:config.organization_id,reportType:type,filename:file.filename,csv:file.csv,sourceUrl:reportPageUrl(config),startDate:config.start_date,endDate:config.end_date},{signal}),signal);assertActive(signal);
   await ledger.update(key,{importedAt:now(),nextAt:now()+config.interval_seconds*1000});return {status:'imported',reportType:type,retryIn:config.interval_seconds*1000,result};
  }catch(error){
   if(closed)return {status:'stopped',reportType:type};
   if(signal.aborted){await ledger.update(key,{nextAt:now()+60000});return {status:'retrying',reportType:type,code:'timeout',phase,retryIn:60000};}
   if(downloadGuard.signal.aborted)error=fail('download_ambiguous','Plusieurs téléchargements ont été déclenchés. Aucun fichier importé.');
   if([401,403,409].includes(error.status))throw error;
   if(error.status>=400&&error.status<500&&error.code==='timezone_required')error=fail('timezone_required','CSV conservé ; confirmez son fuseau horaire dans les réglages Ludy.');else if(error.status>=400&&error.status<500)error=fail('report_rejected',error.localFileStored?'CSV conservé ; rapport à vérifier dans Ludy.':'CSV à vérifier dans Ludy.');
   const known=['configuration','storage','wrong_organization','not_csv','oversize','ambiguous','download_ambiguous','download','page','report_rejected','timezone_required','generation_unconfirmed','navigation_pending'].includes(error.code),transient=!known||error.code==='download'||error.code==='generation_unconfirmed'||error.code==='navigation_pending';
   let diagnostic=null;if(['read_page','prepare_form','generate_report'].includes(phase)&&!page.isClosed())try{diagnostic=await bounded(page.evaluate(reportDiagnosticPage,String(error.message||'').slice(0,2000)),AbortSignal.timeout(1500));}catch{}
   if(diagnostic?.field==='end_date'&&/la date demandée est indisponible/.test(error.message||'')){await ledger.update(key,{nextAt:now()+6*HOUR,calendarUnavailableAt:now()});return {status:'action_required',reportType:type,code:'calendar_period_unavailable',phase,diagnostic,message:'La dernière borne de la période n’est pas encore disponible dans le calendrier Uber.',retryIn:6*HOUR};}
   await ledger.update(key,{nextAt:now()+(transient?60000:6*HOUR)});return {status:transient?'retrying':'action_required',reportType:type,code:known?error.code:'page_interrupted',phase,...(diagnostic?{diagnostic}:{}),message:known?error.message:'Lecture du navigateur interrompue. Nouvelle vérification dans une minute.',retryIn:transient?60000:6*HOUR};
  }finally{
   clearTimeout(timer);page.off('download',capture);await handle?.dispose().catch(()=>{});for(const item of new Set([...downloads,...(download?[download]:[])])){if(signal.aborted||downloadGuard.signal.aborted)await item.cancel().catch(()=>{});await item.delete().catch(()=>{});}await page.evaluate(id=>{if(globalThis.__ludyBrowserReportTask?.id===id)globalThis.__ludyBrowserReportTask.dispose();},id).catch(()=>{});if(controller===own)controller=null;
  }
 }
 function tick(value){if(pending)return pending;if(closed)return Promise.resolve({status:'stopped'});const config=reportBrowserConfig(value),types=config.report_types,rotated=[...types.slice(cursor),...types.slice(0,cursor)],type=rotated.filter(type=>(ledger.get(ledger.key(config,type)).nextAt||0)<=now()).sort((a,b)=>(ledger.get(ledger.key(config,a)).nextAt||0)-(ledger.get(ledger.key(config,b)).nextAt||0))[0];if(!type)return Promise.resolve({status:'idle',nextAt:Math.min(...types.map(type=>ledger.get(ledger.key(config,type)).nextAt||0))});if(consumedDownloadPages.has(page))return Promise.resolve({status:'page_reset_required',reportType:type});cursor=(types.indexOf(type)+1)%types.length;pending=process(config,type).then(result=>{onStatus(result);return result;}).finally(()=>pending=null);return pending;}
 async function stop(){closed=true;controller?.abort();await page.evaluate(()=>globalThis.__ludyBrowserReportTask?.dispose()).catch(()=>{});await pending?.catch(()=>{});page.off('close',pageClosed);}
 async function pause(){controller?.abort();await page.evaluate(()=>globalThis.__ludyBrowserReportTask?.dispose()).catch(()=>{});await pending?.catch(()=>{});}
 return {tick,stop,pause};
}
