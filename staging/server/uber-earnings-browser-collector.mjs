import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {normalizeUberEarnings,readUberEarningsDriverExport} from './uber-earnings.mjs';
import {readReportDownload} from './uber-report-browser-collector.mjs';
import {observeUberEarningsEvidence} from './uber-earnings-evidence.mjs';

const clockSource=await readFile(new URL('../site/timezone.js',import.meta.url),'utf8');
const readerSource=await readFile(new URL('../uber-extension/earnings-reader.js',import.meta.url),'utf8');
const fail=(code,message)=>Object.assign(Error(message),{code});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function taskStart(id){
 globalThis.__ludyEarningsTask?.dispose();const controller=new AbortController();
 const cancel=event=>{if(event.isTrusted)controller.abort();};document.addEventListener('pointerdown',cancel,true);document.addEventListener('keydown',cancel,true);
 globalThis.__ludyEarningsTask={id,controller,dispose(){controller.abort();document.removeEventListener('pointerdown',cancel,true);document.removeEventListener('keydown',cancel,true);}};
}
function inspectPage({id,config,command=null}){
 const task=globalThis.__ludyEarningsTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('earnings_user_interaction');
 const reader=globalThis.LudyUberEarningsReader;let reading;try{reading=reader.inspect(document,location.href,{organizationId:config.organizationId,timeZone:'Africa/Casablanca'});}catch(error){throw Error('earnings_reader:'+(/^[a-z_]+$/.test(error.code||'')?error.code:'unrecognized')+': '+error.message);}
 const samples=[config.now,Date.parse(reading.providerPeriod.start_at),Date.parse(reading.providerPeriod.end_at)];
 if(Intl.DateTimeFormat().resolvedOptions().timeZone!=='Africa/Casablanca'||samples.some(at=>new Date(at).getTimezoneOffset()!==-globalThis.LudyMoroccoTime.moroccoOffsetMinutes(at)))throw Error('earnings_timezone_required');
 const fingerprint=JSON.stringify([reading.providerPeriod,reading.currency,reading.fleet,reading.drivers]);
 const control=command==='next'?reading.pagination.next:command==='first'?reading.pagination.firstControl:command==='previous'?reading.pagination.previous:command==='download'?reading.download:null;
 if(command){if(!control||control.disabled||control.getAttribute('aria-disabled')==='true')throw Error('earnings_control_unavailable');control.click();}
 return {snapshot:reader.snapshot(reading,{observedAt:new Date(config.now).toISOString()}),fingerprint,filtered:reading.filtered,pagination:{first:reading.pagination.first,last:reading.pagination.last,controlsKnown:reading.pagination.controlsKnown,totalRows:reading.pagination.totalRows,canFirst:!!reading.pagination.firstControl},hasDownload:!!reading.download};
}
function expandFleetEarnings({id,knownFields=[]}){
 const task=globalThis.__ludyEarningsTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('earnings_user_interaction');
 const visible=node=>node&&!node.hidden&&!node.closest('[hidden],[aria-hidden="true"]')&&node.getClientRects().length>0;
 const nodes=[...document.querySelectorAll('div,span,p,dt,strong')].filter(node=>visible(node)&&!node.children.length&&!node.closest('table,[role="table"],[role="grid"],[role="dialog"],nav,[role="navigation"],[data-testid^="header-nav-"]'));
 const field=node=>globalThis.LudyUberEarningsReader.fieldFor(String(node.innerText||node.textContent||'').trim());
 // These are the immediate children actually observed under Total earnings.
 // Never expand Fare or derive gross/net by summing the displayed components.
 // A bare navigation label such as Promotions proves no financial field.
 if(knownFields.some(field=>['fare','commission','tips','bonus'].includes(field)))return false;
 const totals=nodes.filter(node=>field(node)==='revenue');if(totals.length!==1)return false;
 totals[0].click();return true;
}
function driverDetails({id,config,driver,index,command,currency}){
 const task=globalThis.__ludyEarningsTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('earnings_user_interaction');
 const reader=globalThis.LudyUberEarningsReader;
 const visible=node=>node&&!node.hidden&&!node.closest('[hidden],[aria-hidden="true"]')&&node.getClientRects().length>0;
 if(command==='open'){
  const reading=reader.inspect(document,location.href,{organizationId:config.organizationId});
  if(JSON.stringify(reading.drivers[index])!==JSON.stringify(driver))throw Error('earnings_driver_changed');
  const rows=[...document.querySelectorAll('table tbody tr,[role="grid"] [role="row"],[role="table"] [role="row"]')].filter(visible).filter(row=>!row.querySelector('th,[role="columnheader"]'));
  const buttons=rows[index]&&[...rows[index].querySelectorAll('button,[role="button"]')].filter(visible);
  if(!buttons||buttons.length!==1||!driver.driverNameComplete)return false;buttons[0].click();return true;
 }
 if(command==='close'){
  const buttons=[...document.querySelectorAll('[data-baseweb="drawer"] button[aria-label="Close"]')].filter(visible);
  if(buttons.length!==1)throw Error('earnings_driver_close_unavailable');buttons[0].click();return true;
 }
 if(command==='present')return [...document.querySelectorAll('[data-baseweb="drawer"]')].some(visible);
 const details=reader.driverDetails(document,{driver,currency});if(!details||details.pending)return details;
 if(command==='expand'&&details.expand){details.expand.click();return {expanding:true};}
 return {metrics:details.metrics,breakdown:details.breakdown};
}
function prepareCustomRange({id,config,expectedPeriod,stage}){
 const task=globalThis.__ludyEarningsTask;if(!task||task.id!==id||task.controller.signal.aborted)throw Error('earnings_user_interaction');
 const visible=node=>node&&!node.hidden&&!node.closest('[hidden],[aria-hidden="true"]')&&node.getClientRects().length>0;
 const text=node=>String(node.innerText||node.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
 const buttons=()=>[...document.querySelectorAll('button,[role="button"],[role="tab"]')].filter(visible);
 const observedDates=()=>[...document.querySelectorAll('input[type="text"][placeholder="YYYY/MM/DD"][aria-label="Select a date range."]')].filter(node=>visible(node)&&!node.disabled&&!node.readOnly);
 if(stage==='open'){
  if(observedDates().length===2)return;
  const label=globalThis.LudyUberEarningsReader.inspect(document,location.href,{organizationId:config.organizationId}).providerPeriod.label.toLowerCase();
  const found=buttons().filter(node=>text(node)===label);if(found.length!==1)throw Error('earnings_custom_unavailable');found[0].click();return;
 }
 if(stage==='custom'){
  const found=buttons().filter(node=>['custom range','plage personnalisee','plage personnalisée','periode personnalisee','période personnalisée'].includes(text(node)));if(found.length!==1)throw Error('earnings_custom_unavailable');found[0].click();return;
 }
 const inputs=[...document.querySelectorAll('input')].filter(node=>visible(node)&&!node.disabled&&!node.readOnly);
 const datesOnly=observedDates();
 if(datesOnly.length===2){
  const values=[];
  for(const [which,instant]of [['start',expectedPeriod.start_at],['end',expectedPeriod.end_at]]){
   const p=globalThis.LudyMoroccoTime.moroccoParts(instant);if(!p||p.hour!==4||p.minute!==0||p.second!==0||Date.parse(instant)%1000!==0)throw Error('earnings_custom_unavailable');
   // Direct typing of End Date was observed to select that date at04h
   // exclusively. Calendar defaults differ: trust only the final UI and
   // passively observed exact bounds, never an assumed inclusive end date.
   const delta=which==='end'?(stage==='dateEndEarlier'?-1:stage==='dateEndLater'?1:0):0;
   const date=new Date(Date.UTC(p.year,p.month-1,p.day+delta));
   values.push(date.getUTCFullYear()+'/'+String(date.getUTCMonth()+1).padStart(2,'0')+'/'+String(date.getUTCDate()).padStart(2,'0'));
  }
  if(stage==='fill')return {dateOnly:true};
  const index=stage==='dateStart'?0:['dateEnd','dateEndEarlier','dateEndLater'].includes(stage)?1:-1;if(index<0)throw Error('earnings_custom_unavailable');
  const input=datesOnly[index];if(input.value!==values[index]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,values[index]);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
  return {dateOnly:true};
 }
 const name=node=>String(node.getAttribute('aria-label')||node.labels?.[0]?.textContent||node.getAttribute('placeholder')||'').trim().toLowerCase();
 const side=(node,which)=>which==='start'?/^(?:start(?: date| time)?|from|date de debut|date de début|heure de debut|heure de début)$/.test(name(node)):/^(?:end(?: date| time)?|to|date de fin|heure de fin)$/.test(name(node));
 const assignments=[];
 for(const [which,instant]of [['start',expectedPeriod.start_at],['end',expectedPeriod.end_at]]){
  const p=globalThis.LudyMoroccoTime.moroccoParts(instant);if(!p||p.second!==0)throw Error('earnings_custom_unavailable');const z=value=>String(value).padStart(2,'0'),date=p.year+'-'+z(p.month)+'-'+z(p.day),time=z(p.hour)+':'+z(p.minute);
  const combined=inputs.filter(node=>node.type==='datetime-local'&&side(node,which));
  if(combined.length===1){assignments.push([combined[0],date+'T'+time]);continue;}
  const dates=inputs.filter(node=>node.type==='date'&&side(node,which)),times=inputs.filter(node=>node.type==='time'&&side(node,which));
  if(combined.length||dates.length!==1||times.length!==1)throw Error('earnings_custom_unavailable');assignments.push([dates[0],date],[times[0],time]);
 }
 // All date/time controls must be recognized before changing any field.
 const apply=buttons().filter(node=>['apply','apply range','done','appliquer','valider'].includes(text(node)));if(apply.length!==1)throw Error('earnings_custom_unavailable');
 for(const [input,value]of assignments){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));if(input.value!==value)throw Error('earnings_custom_unavailable');}
 if(apply[0].disabled||apply[0].getAttribute('aria-disabled')==='true')throw Error('earnings_custom_unavailable');apply[0].click();
}

/** The caller supplies a dedicated, normally authenticated Playwright page.
 * Navigation follows the visible Earnings link, never a guessed provider URL.
 * An ingest callback is injected: this module has no database credentials. */
export function createUberEarningsBrowserCollector({page,ingest,checkLease=async()=>{},onDownload=null,onDiagnostic=()=>{},now=Date.now,maxPages=100,timeoutMs=150000}={}){
 if(!page||typeof ingest!=='function'||!Number.isInteger(maxPages)||maxPages<1||maxPages>100)throw new TypeError('Page dédiée, réception du relevé et limite de pages requises.');
 let active=null,closed=false;
 const pause=()=>{active?.abort();};const close=()=>{closed=true;pause();};page.on('close',close);
 async function collect({organizationId,dedicated=false,expectedPeriod=null,selectCustomRange=false,download=false}={}){
  if(active)throw fail('busy','Une lecture Earnings est déjà en cours.');if(closed||page.isClosed())throw fail('stopped','Navigateur Earnings fermé.');
  if(dedicated!==true)throw fail('dedicated_page_required','La lecture Earnings nécessite un onglet de travail dédié.');
  const controller=new AbortController(),signal=controller.signal,id=randomUUID(),config={organizationId,now:now()},timer=setTimeout(()=>controller.abort(),timeoutMs),evidence=observeUberEarningsEvidence({page,organizationId});let phase='navigation';active=controller;
  const check=()=>{if(evidence.rateLimited)throw Object.assign(fail('rate_limited','Uber limite temporairement les lectures ; la prochaine tentative sera espacée.'),{status:429});if(signal.aborted||closed||page.isClosed())throw fail('stopped','Lecture Earnings interrompue.');};
  const bounded=work=>new Promise((resolve,reject)=>{const abort=()=>reject(fail('stopped','Lecture Earnings interrompue.'));if(signal.aborted){void Promise.resolve(work).catch(()=>{});abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
  const inject=async()=>{await bounded(page.evaluate('(()=>{'+clockSource+'})()'));await bounded(page.evaluate(readerSource));};
  const inspect=command=>bounded(page.evaluate(inspectPage,{id,config,command}));
  const loadingError=error=>/Titre Earnings absent|Tableau Driver earnings absent|Les lignes Earnings ne sont pas encore affichées|contenant le lien Earnings visible|totaux de flotte Uber sont encore à zéro|Devise Earnings non encore affichée|Période Earnings non encore affichée|Ouvrez la page Earnings de cette flotte/.test(String(error.message));
  async function ready(read){const deadline=Date.now()+60000;while(true){check();try{return await read();}catch(error){if(!loadingError(error)||Date.now()>=deadline)throw error;await bounded(sleep(150));}}}
  async function waitChanged(previous){const deadline=Date.now()+15000;let candidate=null,since=0;while(Date.now()<deadline){check();await bounded(sleep(150));const value=await ready(()=>inspect());if(value.fingerprint===previous||!value.snapshot.drivers.length){candidate=null;continue;}if(candidate===value.fingerprint){if(Date.now()-since>=450)return value;}else{candidate=value.fingerprint;since=Date.now();}}throw fail('pagination_stalled','La page suivante Earnings n’a pas changé. Aucun total complet n’est annoncé.');}
  async function enrichDrivers(reading){
   const result=[];
   for(const [index,driver]of reading.snapshot.drivers.entries()){
    check();const call=command=>bounded(page.evaluate(driverDetails,{id,config,driver,index,command,currency:reading.snapshot.currency}));
    if(!await call('open')){result.push(driver);continue;}
    await bounded(sleep(200));if(!await call('present')){result.push(driver);continue;}
    let details;
    try{
     const deadline=Date.now()+12000;let expansionAttempted=false;
     // Some zero-earnings headers keep aria-expanded=false but have no
     // children. One normal click is sufficient: never keep toggling it or
     // turn an absent breakdown into zero gross/net.
     while(Date.now()<deadline){check();details=await call(expansionAttempted?'read':'expand');if(details?.expanding)expansionAttempted=true;if(details&&!details.expanding&&!details.pending)break;await bounded(sleep(250));}
     if(!details||details.expanding||details.pending){onDiagnostic({phase:'driver_details',row:index+1,reason:details?.reason||'detail_unavailable',field:details?.field||null});throw fail('driver_details_changed','Le détail chauffeur ne correspond pas aux cinq montants du tableau. Aucune ventilation n’est enregistrée.');}
     result.push({...driver,metrics:{...driver.metrics,...details.metrics},breakdown:details.breakdown});
    }finally{check();await call('close');await bounded(sleep(350));}
    const after=await ready(()=>inspect());if(after.fingerprint!==reading.fingerprint)throw fail('statement_changed','Le tableau Earnings a changé pendant la lecture du détail chauffeur.');
   }
   return result;
  }
  try{
   check();await bounded(checkLease());await inject();
   const target=await ready(()=>bounded(page.evaluate(({organizationId})=>{const nav=globalThis.LudyUberEarningsReader.earningsNavigation(document,location.href,organizationId);if(!nav.href&&!nav.current)nav.node.click();return nav.href;},config)));
   const current=await bounded(page.evaluate(({organizationId})=>globalThis.LudyUberEarningsReader.providerUrl(location.href,organizationId).url,config));
   if(target&&current!==target){await bounded(page.goto(target,{waitUntil:'domcontentloaded',timeout:20000}));await inject();}
   phase='reading';await bounded(page.evaluate(taskStart,id));let first=await ready(()=>inspect()),customSelected=false;
   if(!first.pagination.first&&first.pagination.canFirst){const previous=first.fingerprint;await inspect('first');first=await waitChanged(previous);}
   if(expectedPeriod&&(first.snapshot.providerPeriod.start_at!==expectedPeriod.start_at||first.snapshot.providerPeriod.end_at!==expectedPeriod.end_at)){
    if(!selectCustomRange)throw fail('custom_range_required','La période Earnings affichée diffère de la période statistique demandée. Sélectionnez une plage personnalisée exacte dans Uber.');
    const previous=first.fingerprint;let rangeMode;
    for(const stage of ['open','custom','fill']){rangeMode=await ready(()=>bounded(page.evaluate(prepareCustomRange,{id,config,expectedPeriod,stage})));await bounded(sleep(100));}
    if(rangeMode?.dateOnly){
     await bounded(page.evaluate(prepareCustomRange,{id,config,expectedPeriod,stage:'dateStart'}));await bounded(sleep(350));
     for(const stage of ['open','custom','dateEnd']){await ready(()=>bounded(page.evaluate(prepareCustomRange,{id,config,expectedPeriod,stage})));await bounded(sleep(150));}
    }
    first=await waitChanged(previous);
    // The observed widget treats past end dates inclusively, but future typed
    // dates exclusively. A single calendar-day correction is allowed only
    // after reading that exact discrepancy. Final bounds remain mandatory.
    const endDifference=Date.parse(first.snapshot.providerPeriod.end_at)-Date.parse(expectedPeriod.end_at);
    if(rangeMode?.dateOnly&&first.snapshot.providerPeriod.start_at===expectedPeriod.start_at&&Math.abs(endDifference)>=23*3600000&&Math.abs(endDifference)<=25*3600000){
     const beforeCorrection=first.fingerprint;
     for(const stage of ['open','custom',endDifference>0?'dateEndEarlier':'dateEndLater']){await ready(()=>bounded(page.evaluate(prepareCustomRange,{id,config,expectedPeriod,stage})));await bounded(sleep(150));}
     first=await waitChanged(beforeCorrection);
    }
    if(first.snapshot.providerPeriod.start_at!==expectedPeriod.start_at||first.snapshot.providerPeriod.end_at!==expectedPeriod.end_at)throw fail('custom_range_required','Uber n’affiche pas les bornes exactes de la période statistique demandée.');customSelected=true;
   }
   phase='components';
   const baseIdentity=value=>JSON.stringify([value.organizationId,value.providerPeriod,value.currency,Object.fromEntries(Object.entries(value.fleet).filter(([key])=>!['fare','commission','taxes','tips','bonus'].includes(key)))]);
   const beforeComponents=baseIdentity(first.snapshot);
   if(await bounded(page.evaluate(expandFleetEarnings,{id,knownFields:Object.keys(first.snapshot.fleet)}))){
    await bounded(sleep(450));const expanded=await ready(()=>inspect());
    if(beforeComponents!==baseIdentity(expanded.snapshot))throw fail('statement_changed','La période ou les totaux Earnings ont changé pendant le dépliage des gains.');
    first=expanded;
   }
   const identity=JSON.stringify([first.snapshot.organizationId,first.snapshot.providerPeriod,first.snapshot.currency,first.snapshot.fleet]);
   phase='pagination';
   const drivers=[],fingerprints=new Set();let reading=first,pages=0,reason=null;
   while(true){
    check();await bounded(checkLease());
    onDiagnostic({phase:'page_read',page:pages+1,rows:reading.snapshot.drivers.length,first:reading.pagination.first,last:reading.pagination.last,controlsKnown:reading.pagination.controlsKnown});
    if(identity!==JSON.stringify([reading.snapshot.organizationId,reading.snapshot.providerPeriod,reading.snapshot.currency,reading.snapshot.fleet]))throw fail('statement_changed','La flotte, la période ou les totaux ont changé pendant la lecture Earnings.');
    if(fingerprints.has(reading.fingerprint))throw fail('pagination_stalled','Une page Earnings a été relue ; couverture non confirmée.');fingerprints.add(reading.fingerprint);pages++;
    drivers.push(...await enrichDrivers(reading));if(drivers.length>5000)throw fail('rows_limit','Relevé Earnings limité à 5 000 chauffeurs.');
    if(reading.pagination.last)break;if(pages>=maxPages){reason='Limite du parcours Earnings atteinte.';break;}
    if(!reading.pagination.controlsKnown){reason='Pagination Earnings non reconnue.';break;}
    const previous=reading.fingerprint;await inspect('next');reading=await waitChanged(previous);
   }
   const complete=first.pagination.first&&reading.pagination.last&&first.pagination.controlsKnown&&!first.filtered&&!reading.filtered&&!reason&&(first.pagination.totalRows===null||first.pagination.totalRows===drivers.length);
   let snapshot={...first.snapshot,providerPeriod:{...first.snapshot.providerPeriod,mode:customSelected?'custom':first.snapshot.providerPeriod.mode},drivers,coverage:{complete,filtered:first.filtered||reading.filtered,driverRowsObserved:drivers.length,driverRowsTotal:first.pagination.totalRows,pages,reason:complete?null:reason||'Liste filtrée, première page absente ou pagination non confirmée.'}};
   // Restore the first page only inside this dedicated work tab, never after a
   // human interaction has cancelled the read.
   if(!reading.pagination.first&&reading.pagination.canFirst){const previous=reading.fingerprint;await inspect('first');reading=await waitChanged(previous);}
   const identified=await bounded(evidence.attach(snapshot));snapshot=identified.snapshot;onDiagnostic({phase:'identities',matched:snapshot.drivers.filter(row=>row.providerDriverId).length,rows:snapshot.drivers.length,...identified.diagnostics});
   if(expectedPeriod&&(snapshot.providerPeriod.start_at!==expectedPeriod.start_at||snapshot.providerPeriod.end_at!==expectedPeriod.end_at))throw fail('custom_range_required','Les bornes exactes reçues d’Uber diffèrent de la plage statistique demandée.');
   // The observed Fleet Hub "Download report" is navigation to Reports, not
   // a CSV download. Passive UI evidence supplies its exact window and IDs.
   // Keep direct-download support for versions that actually offer a CSV.
   if(download&&!identified.observed){
    phase='download';
    if(!reading.hasDownload)throw fail('download_unavailable','Le bouton Download report n’est pas identifiable.');
    const downloads=[],capture=value=>downloads.push(value);page.on('download',capture);let file;
    try{const pending=page.waitForEvent('download',{timeout:15000});const click=inspect('download');const [item]=await bounded(Promise.all([pending,click]));file=await bounded(readReportDownload(item,{signal}));await bounded(sleep(250));if(downloads.length!==1||downloads[0]!==item)throw fail('download_ambiguous','Plusieurs exports Earnings ont été déclenchés.');}
    finally{page.off('download',capture);}
    const after=await inspect();if(identity!==JSON.stringify([after.snapshot.organizationId,after.snapshot.providerPeriod,after.snapshot.currency,after.snapshot.fleet]))throw fail('statement_changed','La période Earnings a changé pendant le téléchargement.');
    if(typeof onDownload==='function')await bounded(onDownload({...file,organizationId:snapshot.organizationId,providerPeriod:snapshot.providerPeriod,currency:snapshot.currency},{signal}));
    snapshot=readUberEarningsDriverExport(file.csv,snapshot,{organizationId,now:config.now});
   }
   phase='ingest';check();const observedAt=now();snapshot={...snapshot,observedAt:new Date(observedAt).toISOString()};const normalized=normalizeUberEarnings(snapshot,{organizationId,now:observedAt});await bounded(checkLease());check();const verified=await inspect();if(identity!==JSON.stringify([verified.snapshot.organizationId,verified.snapshot.providerPeriod,verified.snapshot.currency,verified.snapshot.fleet]))throw fail('statement_changed','La période Earnings a changé avant sa transmission.');const receipt=await bounded(ingest(snapshot,{signal,normalized}));check();
   return {status:'imported',complete:normalized.coverage.complete,rows:normalized.drivers.length,pages,providerPeriod:normalized.provider_period,receipt};
  }catch(error){
   error.phase=phase;const readerCode=String(error.message).match(/earnings_reader:([a-z_]+):/)?.[1];if(readerCode)error.code=readerCode;else if(error.name==='TimeoutError')error.code=phase+'_timeout';
   onDiagnostic({phase,code:error.code||'earnings_unavailable',kind:'failure'});
   if(String(error.message).includes('earnings_user_interaction'))throw fail('user_interaction','Lecture Earnings arrêtée après une interaction dans la page.');
   if(String(error.message).includes('earnings_timezone_required'))throw fail('timezone_required','Le navigateur Earnings doit afficher Africa/Casablanca avec les règles horaires à jour.');
   if(String(error.message).includes('earnings_custom_unavailable'))throw fail('custom_range_unavailable','La plage personnalisée Uber ne permet pas de vérifier deux dates et heures précises. Aucune borne horaire n’est inventée.');
   throw error;
  }finally{clearTimeout(timer);evidence.dispose();controller.abort();if(active===controller)active=null;if(!page.isClosed())await page.evaluate(id=>{if(globalThis.__ludyEarningsTask?.id===id){globalThis.__ludyEarningsTask.dispose();delete globalThis.__ludyEarningsTask;}},id).catch(()=>{});}
 }
 async function stop(){closed=true;pause();page.off('close',close);}
 return {collect,pause,stop};
}
