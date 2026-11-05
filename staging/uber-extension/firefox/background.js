/* Le code local reste dans le fond de l'extension, jamais dans la page Uber. */
if(typeof importScripts==='function')importScripts('protocol.js','reports-reader.js','reports-background.js');
const extensionApi=globalThis.browser || globalThis.chrome;
const bridge=globalThis.LudyUberProtocol;
const WATCHDOG='ludy-uber-watchdog',REFRESH_ALARM='ludy-uber-map-refresh',REFRESH_MS=20*60000,RETRY_MIN=15000,RETRY_MAX=120000,TRANSMIT_MS=25000,READER_VERSION='0.6.7';
const UBER_ORIGIN='https://fleethub.uber.com/*';
const storage=extensionApi.storage.local || extensionApi.storage.session;
let connector={collectorId:null,token:null,tabId:null,runId:null,mapUrl:null,active:false,standby:false,autoResume:false,state:'stopped',lastReadAt:null,lastSentAt:null,lastHealthyAt:null,nextAttemptAt:0,pendingUntil:0,nextRefreshAt:0,lastRefreshAt:null,refreshPending:false,failures:0,rows:0,coverage:null,message:'Associez Ludy puis démarrez la lecture de la Live Map.'};
let reportsAutomation=null;
let collectionPoll=null,collectionPollRevision=0;
const cancelCollectionPoll=()=>{collectionPollRevision++;collectionPoll?.abort();};
let transmission=null,transmissionRevision=0,pendingReads=0;
const cancelTransmission=()=>{transmissionRevision++;transmission?.abort();};
const publicCoverage=value=>value?.mode==='list_sweep'&&typeof value.complete==='boolean'&&Number.isInteger(value.observed)&&value.observed>=0&&value.observed<=200
  ?{mode:'list_sweep',complete:value.complete,observed:value.observed,...(typeof value.reason==='string'&&value.reason.length<=160?{reason:value.reason}:{}),
    ...(Number.isInteger(value.vehicleObserved)&&value.vehicleObserved>=0&&value.vehicleObserved<=value.observed?{vehicleObserved:value.vehicleObserved}:{}),
    ...(typeof value.vehicleComplete==='boolean'?{vehicleComplete:value.vehicleComplete}:{})}:null;
const ready=(async()=>{
  try{await extensionApi.storage.local?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});}catch{}
  let saved=await storage.get('connector');
  if(!saved.connector&&extensionApi.storage.local&&extensionApi.storage.session)saved=await extensionApi.storage.session.get('connector');
  if(saved.connector&&typeof saved.connector==='object'){
    for(const key of Object.keys(connector))if(key in saved.connector)connector[key]=saved.connector[key];
    if(!connector.token||!connector.collectorId){connector.active=false;connector.tabId=null;connector.runId=null;}
    // An interrupted worker never replays its batch or overlaps its possibly
    // still-running server request. Persist only a bounded deadline, not rows.
    if(!Number.isFinite(connector.pendingUntil)||connector.pendingUntil<=Date.now())connector.pendingUntil=0;
    else {
      connector.pendingUntil=Math.min(connector.pendingUntil,Date.now()+TRANSMIT_MS+RETRY_MIN);
      connector.nextAttemptAt=Math.max(connector.nextAttemptAt,connector.pendingUntil);
      if(connector.active){connector.state='retrying';connector.message='Transmission interrompue. Attente avant une nouvelle lecture de la Live Map.';}
    }
    await storage.set({connector});
    if(extensionApi.storage.local)await extensionApi.storage.session?.remove?.('connector');
  }
})();
let queue=Promise.resolve();
const serialize=work=>{const result=queue.then(()=>ready).then(work);queue=result.catch(()=>{});return result;};
const persist=()=>storage.set({connector});
const publicState=()=>({active:connector.active,standby:connector.standby,autoResume:connector.autoResume,state:connector.state,lastSentAt:connector.lastSentAt,lastHealthyAt:connector.lastHealthyAt,lastRefreshAt:connector.lastRefreshAt,nextRefreshAt:connector.active&&!connector.standby&&connector.nextRefreshAt?new Date(connector.nextRefreshAt).toISOString():null,refreshPending:connector.refreshPending,
  nextRetryAt:connector.nextAttemptAt?new Date(connector.nextAttemptAt).toISOString():null,rows:connector.rows,coverage:publicCoverage(connector.coverage),message:connector.message,paired:!!connector.token,reports:reportsAutomation?.publicState()||null});
const arm=async()=>{if(connector.active){await extensionApi.alarms?.create?.(WATCHDOG,{periodInMinutes:1});if(connector.standby){await extensionApi.alarms?.clear?.(REFRESH_ALARM);return;}if(!Number.isFinite(connector.nextRefreshAt)||connector.nextRefreshAt<=0){connector.nextRefreshAt=Date.now()+REFRESH_MS;await persist();}if(connector.nextRefreshAt>Date.now())await extensionApi.alarms?.create?.(REFRESH_ALARM,{when:connector.nextRefreshAt});}};
const scope=url=>{try{return new URL(url).pathname.split('/')[2]?.toLowerCase();}catch{return null;}};
const automaticAllowed=async()=>connector.autoResume&&!!await extensionApi.permissions?.contains?.({origins:[UBER_ORIGIN]});
async function transmit(result) {
  const data=bridge.payload(result,connector.collectorId);
  const observing=result.status==='observing',revision=transmissionRevision,controller=new AbortController();
  const cancelled=()=>Error(revision!==transmissionRevision?'cancelled':'local_timeout');
  let rejectAbort;const interrupted=new Promise((_,reject)=>{rejectAbort=()=>reject(cancelled());});
  void interrupted.catch(()=>{}); // Cancellation may precede a slow storage write.
  controller.signal.addEventListener('abort',rejectAbort,{once:true});transmission=controller;
  // Keep fetch below Chrome MV3's 30-second response limit. The content reader
  // waits longer than this deadline and never schedules an overlapping sweep.
  const timeout=setTimeout(()=>controller.abort(),observing?TRANSMIT_MS:5000);
  try{
    if(observing){connector.pendingUntil=Date.now()+TRANSMIT_MS+RETRY_MIN;await persist();}
    if(controller.signal.aborted)throw cancelled();
    const response=await Promise.race([fetch(bridge.destination(bridge.ENDPOINT),{method:'POST',headers:{Authorization:`Bearer ${connector.token}`,'Content-Type':'application/json'},body:JSON.stringify(data),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal}),interrupted]);
    if(controller.signal.aborted||revision!==transmissionRevision)throw cancelled();
    if(!response.ok){const error=Error(response.status===401||response.status===403?'pairing':response.status===409?'collector_conflict':'local');
      if(response.status===409)error.collectionInactive=true;
      if(response.status===429){const retry=Number(response.headers?.get?.('retry-after'));if(Number.isFinite(retry)&&retry>0)error.retryMs=Math.min(300000,retry*1000);}
      throw error;
    }
    const accepted=await Promise.race([response.json?.(),interrupted]);
    if(controller.signal.aborted||revision!==transmissionRevision)throw cancelled();
    if(result.status==='observing'&&accepted?.ignored)throw Error(accepted.reason==='stale_batch'?'stale_read':'collector_conflict');
    connector.lastSentAt=result.observedAt;connector.rows=result.rows.length;connector.state=result.status;connector.coverage=publicCoverage(data.coverage);
    if(result.status==='observing')connector.lastHealthyAt=result.observedAt;
    connector.failures=0;connector.nextAttemptAt=0;
    const scope=connector.coverage?(connector.coverage.complete?'Liste affichée parcourue':'Lecture partielle de la liste'):'Vue visible';
    connector.message=result.status==='observing'?`${scope} : ${result.rows.length} chauffeur(s) transmis à Ludy. Parcours automatique actif.`:result.warnings[0] || 'Lecture arrêtée.';
  }finally{
    clearTimeout(timeout);controller.signal.removeEventListener('abort',rejectAbort);
    if(transmission===controller)transmission=null;
    if(observing&&revision===transmissionRevision)connector.pendingUntil=0;
  }
}
async function stop(message='Lecture arrêtée.',notify=true) {
  const tabId=connector.tabId,wasActive=connector.active;
  connector.active=false;connector.standby=false;connector.tabId=null;connector.runId=null;connector.mapUrl=null;connector.state='stopped';connector.rows=0;connector.coverage=null;connector.failures=0;connector.nextAttemptAt=0;connector.nextRefreshAt=0;connector.refreshPending=false;
  await extensionApi.alarms?.clear?.(WATCHDOG);
  await extensionApi.alarms?.clear?.(REFRESH_ALARM);
  if(tabId!==null)try{await extensionApi.tabs.sendMessage(tabId,{type:'LUDY_UBER_STOP'});}catch{}
  if(notify&&wasActive&&connector.token)try{await transmit({observedAt:new Date().toISOString(),sourceAt:null,status:'stopped',rows:[],warnings:[message]});}catch{}
  connector.message=message;await persist();return publicState();
}
async function failure(error) {
  if(error?.message==='cancelled')return publicState();
  if(error?.message==='pairing'){
    await stop('Association expirée ou refusée. Créez un nouveau code dans Ludy.',false);
    connector.token=null;connector.state='pairing_required';await persist();return publicState();
  }
  if(error?.collectionInactive){
    connector.standby=true;connector.runId=null;connector.lastReadAt=null;connector.rows=0;connector.coverage=null;connector.refreshPending=false;connector.nextRefreshAt=0;
    connector.state='collector_standby';connector.nextAttemptAt=Date.now()+60000;
    connector.message='Collecte en attente sur ce poste. Lecture et actualisation Uber suspendues ; reprise automatique lorsque Ludy rend ce poste actif.';
    await persist();await arm();
    if(connector.tabId!==null)try{await extensionApi.tabs.sendMessage(connector.tabId,{type:'LUDY_UBER_STOP'});}catch{}
    return publicState();
  }
  connector.failures++;connector.nextAttemptAt=Date.now()+Math.max(error?.retryMs||0,Math.min(RETRY_MAX,RETRY_MIN*2**Math.min(connector.failures-1,4)));
  connector.state=error?.message==='collector_conflict'?'collector_conflict':'retrying';
  connector.message=error?.message==='collector_conflict'?'Une autre fenêtre Uber assure déjà la collecte. Gardez une seule extension active ; nouvelle tentative automatique.':error?.message==='stale_read'?'Lecture ancienne ou déjà reçue écartée. Attente de la prochaine observation visible.':'Ludy local indisponible. Reconnexion automatique ; les anciennes observations ne seront pas renvoyées.';
  await persist();await arm();return publicState();
}
async function resumeCollection(){
  if(!connector.standby)return true;
  if(Date.now()<connector.nextAttemptAt)return false;
  connector.nextAttemptAt=Date.now()+60000;
  const revision=collectionPollRevision,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);collectionPoll=controller;
  try{
    const response=await fetch(bridge.destination(bridge.COLLECTION_STATUS),{method:'GET',headers:{Authorization:`Bearer ${connector.token}`},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
    if(response.status===401||response.status===403){await failure(Error('pairing'));return false;}
    if(!response.ok)throw Error('local');
    const status=await response.json();
    if(controller.signal.aborted||revision!==collectionPollRevision)return false;
    if(!status||typeof status.active!=='boolean'||Object.keys(status).length!==1)throw Error('local');
    if(!status.active){await persist();return false;}
    connector.standby=false;connector.nextAttemptAt=0;connector.failures=0;connector.nextRefreshAt=Date.now()+REFRESH_MS;
    await persist();await arm();return true;
  }catch{
    if(revision!==collectionPollRevision)return false;
    connector.state='collector_standby';connector.message='Collecte suspendue. Statut du poste momentanément indisponible ; vérification locale dans une minute.';
    await persist();return false;
  }finally{clearTimeout(timeout);if(collectionPoll===controller)collectionPoll=null;}
}
async function begin(tab) {
  const previousTab=connector.tabId;
  if(previousTab!==null)try{await extensionApi.tabs.sendMessage(previousTab,{type:'LUDY_UBER_STOP'});}catch{}
  const url=new URL(tab.url);connector.tabId=tab.id;connector.mapUrl=url.origin+url.pathname;connector.runId=crypto.randomUUID();
  connector.active=true;connector.state='starting';connector.lastReadAt=null;connector.rows=0;connector.coverage=null;connector.refreshPending=false;connector.message='Parcours de la liste Uber affichée…';
  if(!Number.isFinite(connector.nextRefreshAt)||connector.nextRefreshAt<=0)connector.nextRefreshAt=Date.now()+REFRESH_MS;
  await persist();await arm();
  try{
    await extensionApi.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['reader.js','scanner.js','content.js']});
    await extensionApi.tabs.sendMessage(tab.id,{type:'LUDY_UBER_START',runId:connector.runId});
  }catch{
    connector.state='waiting_page';connector.message='Rechargez la page Uber pour appliquer l’extension 0.6.7, puis démarrez la lecture.';await persist();
  }
  return publicState();
}
async function waitForPage(message,notify=true) {
  const previousTab=connector.tabId;
  connector.tabId=null;connector.runId=null;connector.lastReadAt=null;connector.rows=0;connector.coverage=null;connector.refreshPending=false;connector.state='waiting_page';connector.message=message;
  if(previousTab!==null)try{await extensionApi.tabs.sendMessage(previousTab,{type:'LUDY_UBER_STOP'});}catch{}
  if(notify&&connector.token&&!connector.standby)try{await transmit({observedAt:new Date().toISOString(),sourceAt:null,status:'error',rows:[],warnings:[message]});}catch(error){await failure(error);}
  if(connector.standby)connector.state='collector_standby';
  else if(connector.active&&connector.state!=='retrying')connector.state='waiting_page';
  await persist();await arm();return publicState();
}
async function refreshMap(tab){
  if(!connector.active||connector.standby||!connector.runId||!connector.nextRefreshAt||Date.now()<connector.nextRefreshAt)return false;
  const currentRun=connector.runId;
  let reply;try{reply=await extensionApi.tabs.sendMessage(tab.id,{type:'LUDY_UBER_PREPARE_REFRESH',runId:currentRun});}catch{return false;}
  if(reply?.runId!==currentRun||reply.version!==READER_VERSION||!reply.ok)return false;
  connector.refreshPending=!!reply.busy;
  if(!reply.ready){await persist();return true;}
  // The content reader has stopped scheduling scans and acknowledged that its
  // current sweep AND local transmission are finished. No scan is cancelled.
  const currentTab=await extensionApi.tabs.get(tab.id).catch(()=>null);
  if(!connector.active||connector.runId!==currentRun||!currentTab||currentTab.active===false||currentTab.status==='loading'||!bridge.permittedUrl(currentTab.url)||scope(currentTab.url)!==scope(connector.mapUrl)){
    try{await extensionApi.tabs.sendMessage(tab.id,{type:'LUDY_UBER_CANCEL_REFRESH',runId:currentRun});}catch{}connector.refreshPending=false;return false;
  }
  connector.state='refreshing';connector.refreshPending=true;connector.message='Actualisation de la Live Map après le parcours terminé. Reprise automatique…';await persist();
  try{
    await extensionApi.tabs.reload(tab.id,{bypassCache:false});
    connector.lastRefreshAt=new Date().toISOString();connector.nextRefreshAt=Date.now()+REFRESH_MS;connector.lastReadAt=null;connector.rows=0;connector.coverage=null;
  }catch{
    try{await extensionApi.tabs.sendMessage(tab.id,{type:'LUDY_UBER_CANCEL_REFRESH',runId:currentRun});}catch{}
    connector.state='waiting_page';connector.nextRefreshAt=Date.now()+60000;connector.message='Actualisation de la Live Map indisponible. Nouvelle tentative dans une minute ; association conservée.';
  }
  connector.refreshPending=false;await persist();await arm();return true;
}
async function recover({force=false}={}) {
  if(!connector.active||!connector.token)return;
  const revision=collectionPollRevision;
  if(!await resumeCollection()||revision!==collectionPollRevision)return;
  const automatic=await automaticAllowed();let tab;
  if(connector.autoResume&&!automatic){connector.autoResume=false;return stop('Autorisation de reprise retirée. Ouvrez la Live Map puis cliquez sur Démarrer.');}
  if(connector.tabId!==null)try{tab=await extensionApi.tabs.get(connector.tabId);}catch{}
  if(tab&&(!bridge.permittedUrl(tab.url)||connector.mapUrl&&scope(tab.url)!==scope(connector.mapUrl))) {
    if(!automatic)return stop('Navigation hors de la Live Map suivie.');
    await waitForPage('En attente de la Live Map suivie. La reprise sera automatique lorsqu’elle sera visible.');tab=null;
  }
  if(!tab){
    if(!automatic)return stop('Onglet Uber fermé. Ouvrez sa Live Map puis démarrez la lecture.',false);
    if(!bridge.permittedUrl(connector.mapUrl))return stop('Choisissez la Live Map à suivre puis cliquez sur Démarrer.',false);
    const matches=(await extensionApi.tabs.query({url:'https://fleethub.uber.com/orgs/*/livemap*'})).filter(t=>t.active!==false&&!t.discarded&&bridge.permittedUrl(t.url)&&scope(t.url)===scope(connector.mapUrl));
    if(matches.length!==1){connector.state='waiting_page';connector.message=matches.length>1?'Plusieurs Live Map de cette flotte sont visibles. Gardez un seul onglet pour reprendre.':'Ouvrez la Live Map suivie sur le second écran. La lecture reprendra automatiquement.';await persist();return;}
    if(matches[0].status==='loading')return;
    return begin(matches[0]);
  }
  if(tab.status==='loading')return;
  if(await refreshMap(tab))return;
  if(!force&&connector.lastReadAt&&Date.now()-Date.parse(connector.lastReadAt)<35000)return;
  try{
    const reply=await extensionApi.tabs.sendMessage(tab.id,{type:'LUDY_UBER_PING'});
    if(reply?.runId===connector.runId&&reply.running&&reply.version===READER_VERSION){await extensionApi.tabs.sendMessage(tab.id,{type:'LUDY_UBER_SCAN'});return;}
  }catch{}
  await begin(tab);
}
async function handle(message,sender) {
  if(sender.id!==extensionApi.runtime.id)throw Error('Émetteur refusé.');
  const popup=sender.url===extensionApi.runtime.getURL('popup.html');
  if(popup&&message?.type==='LUDY_UBER_STATUS'){void reportsAutomation?.publishStatus();return publicState();}
  if(popup&&message?.type==='LUDY_UBER_PAIR'){
    if(typeof message.token!=='string'||message.token.length<20||message.token.length>1024||/\s/.test(message.token))throw Error('Copiez le code d’association fourni par Ludy.');
    await reportsAutomation?.stop();await stop();connector.token=message.token;connector.collectorId=crypto.randomUUID();connector.message='Code enregistré sur ce navigateur. Ouvrez la Live Map puis démarrez.';await persist();return publicState();
  }
  if(popup&&message?.type==='LUDY_UBER_START'){
    if(!connector.token)throw Error('Associez d’abord l’extension dans Ludy.');
    if(connector.standby){await recover({force:true});return publicState();}
    const tabs=await extensionApi.tabs.query({active:true,currentWindow:true}),tab=tabs[0];
    if(!tab||!bridge.permittedUrl(tab.url))throw Error('Ouvrez la Live Map Uber Fleet dans cet onglet avant de démarrer.');
    await stop();return begin(tab);
  }
  if(popup&&message?.type==='LUDY_UBER_STOP')return stop();
  if(popup&&message?.type==='LUDY_UBER_FORGET'){await reportsAutomation?.stop('Association effacée : collecte des rapports arrêtée.');await stop();connector.token=null;connector.message='Association locale effacée.';await persist();return publicState();}
  if(popup&&message?.type==='LUDY_UBER_AUTO'){
    if(typeof message.enabled!=='boolean')throw Error('Choix invalide.');
    if(message.enabled&&!await extensionApi.permissions?.contains?.({origins:[UBER_ORIGIN]}))throw Error('Autorisez la reprise dans le navigateur.');
    connector.autoResume=message.enabled;
    if(!message.enabled&&connector.active)await stop('Reprise automatique désactivée. Cliquez sur Démarrer pour une lecture manuelle.');
    await persist();return publicState();
  }
  if(!sender.tab||sender.frameId!==0||sender.tab.id!==connector.tabId||!connector.active||connector.standby||message.runId!==connector.runId||!bridge.permittedUrl(sender.url))throw Error('Lecture hors de la page suivie.');
  if(connector.mapUrl&&scope(sender.url)!==scope(connector.mapUrl))throw Error('Flotte incohérente.');
  if(message.type==='LUDY_UBER_REFRESH_READY'){await recover({force:true});return publicState();}
  if(message.type==='LUDY_UBER_CLOSED'){
    connector.state='waiting_page';connector.lastReadAt=null;connector.message='Page Uber en cours de rechargement. Reprise automatique sur la même Live Map.';
    try{await transmit({observedAt:new Date().toISOString(),sourceAt:null,status:'error',rows:[],warnings:[connector.message]});}catch(error){await failure(error);}
    if(connector.active&&connector.state==='error')connector.state='waiting_page';
    await persist();return publicState();
  }
  if(message.type==='LUDY_UBER_READ'){
    const expected=scope(sender.url);if(message.result?.organizationId!==expected)throw Error('Flotte incohérente.');
    bridge.payload(message.result,connector.collectorId);connector.lastReadAt=new Date().toISOString();
    if(message.result.status==='observing'&&Date.now()<Math.max(connector.nextAttemptAt,connector.pendingUntil)){
      connector.nextAttemptAt=Math.max(connector.nextAttemptAt,connector.pendingUntil);await persist();return publicState();
    }
    try{await transmit(message.result);await persist();return publicState();}catch(error){return failure(error);}
  }
  throw Error('Action refusée.');
}
reportsAutomation=globalThis.LudyUberReportsAutomation?.create({api:extensionApi,storage,getPairing:()=>({token:connector.token,collectorId:connector.collectorId}),pairingReady:ready})||null;
extensionApi.runtime.onMessage.addListener((message,sender,respond)=>{
  // Explicit stop/pairing changes interrupt pending local I/O before entering
  // the serialized queue. Late responses cannot confirm the cancelled run.
  if(sender.id===extensionApi.runtime.id&&sender.url===extensionApi.runtime.getURL('popup.html')&&
    (['LUDY_UBER_STOP','LUDY_UBER_FORGET','LUDY_UBER_PAIR'].includes(message?.type)||message?.type==='LUDY_UBER_AUTO'&&message.enabled===false)){cancelCollectionPoll();cancelTransmission();}
  const trackedPage=sender.id===extensionApi.runtime.id&&sender.tab?.id===connector.tabId&&sender.frameId===0&&message?.runId===connector.runId&&bridge.permittedUrl(sender.url);
  if(trackedPage&&(message.type==='LUDY_UBER_CLOSED'||message.type==='LUDY_UBER_READ'&&message.result?.status!=='observing'))cancelTransmission();
  if(typeof message?.type==='string'&&message.type.startsWith('LUDY_UBER_REPORTS_')){
    if(!reportsAutomation){respond({ok:false,error:'Rechargez l’extension pour activer les rapports.'});return false;}
    reportsAutomation.handle(message,sender).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:String(error.message||'Rapports indisponibles.').slice(0,400)}));return true;
  }
  const read=sender.id===extensionApi.runtime.id&&sender.tab&&sender.frameId===0&&message?.type==='LUDY_UBER_READ'&&bridge.permittedUrl(sender.url);
  // Never queue observations behind an unfinished ingest: by the time it
  // finishes they may be stale. The content reader will take a fresh sample.
  if(read&&message.result?.status==='observing'&&pendingReads){respond({ok:false,error:'Une lecture est déjà en cours de transmission.'});return false;}
  if(read)pendingReads++;
  serialize(()=>handle(message,sender)).then(data=>{if(read)pendingReads--;respond({ok:true,data});},()=>{if(read)pendingReads--;respond({ok:false,error:'Action impossible. Vérifiez la Live Map, le code d’association et le serveur local.'});});
  return true;
});
extensionApi.tabs.onRemoved.addListener(tabId=>{if(tabId===connector.tabId)cancelTransmission();void serialize(async()=>{
  if(tabId!==connector.tabId)return;
  if(await automaticAllowed())return waitForPage('Onglet Uber fermé. Reprise automatique quand la même Live Map sera visible.');
  return stop('Onglet Uber fermé.');
});});
extensionApi.tabs.onUpdated.addListener((tabId,change)=>{if(tabId===connector.tabId&&change.url&&(!bridge.permittedUrl(change.url)||connector.mapUrl&&scope(change.url)!==scope(connector.mapUrl)))cancelTransmission();void serialize(async()=>{
  if(!connector.active)return;
  if(tabId!==connector.tabId){if(connector.autoResume&&connector.tabId===null&&change.status==='complete')await recover();return;}
  if(change.url&&(!bridge.permittedUrl(change.url)||connector.mapUrl&&scope(change.url)!==scope(connector.mapUrl))) {
    if(await automaticAllowed())return waitForPage('En attente de la Live Map suivie. Reprise automatique après votre retour.');
    return stop('Navigation hors de la Live Map suivie.');
  }
  if(change.status==='complete'){connector.lastReadAt=null;connector.refreshPending=false;connector.nextRefreshAt=Date.now()+REFRESH_MS;await arm();await recover();}
});});
extensionApi.tabs.onActivated?.addListener(()=>{void serialize(()=>connector.active&&connector.tabId===null?recover():undefined);});
extensionApi.alarms?.onAlarm?.addListener(alarm=>{if(alarm.name===WATCHDOG||alarm.name===REFRESH_ALARM)void serialize(recover);});
extensionApi.runtime.onStartup?.addListener(()=>{void serialize(async()=>{
  if(!connector.active)return;
  if(await automaticAllowed()){await waitForPage('Navigateur relancé. Reprise automatique sur la Live Map suivie.',false);await recover();}
  else {connector.autoResume=false;await stop('Navigateur relancé. Ouvrez la Live Map puis cliquez sur Démarrer ; le code est conservé.',false);}
});});
extensionApi.permissions?.onRemoved?.addListener(()=>{void serialize(async()=>{
  if(connector.autoResume&&!await automaticAllowed()){connector.autoResume=false;await stop('Autorisation de reprise retirée. La collecte est arrêtée.');}
});});
extensionApi.runtime.onInstalled?.addListener(()=>{void serialize(async()=>{await arm();await recover({force:true});});});
void serialize(arm);
