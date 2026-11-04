/* Independent, sequential Reports jobs. Neither the Live Map queue nor its
 * refresh alarm is used here. Pairing stays in this background context. */
(() => {
 'use strict';const ORIGIN='https://fleethub.uber.com/*',BASE='http://127.0.0.1:4173/api/uber-reports/bridge/',ALARM='ludy-uber-reports-watchdog';
 const LABELS={trip_activity:'Courses',driver_activity:'Activité chauffeurs',driver_quality:'Qualité chauffeurs'},TYPES=Object.keys(LABELS);
 const blank=()=>({status:'waiting',message:'En attente de lecture.',last_import_at:null,next_attempt_at:0,requested_period:null,requested_at:0,completed_period:null,last_checked_at:0,diagnostic:null,structure:null});
 function create({api,storage,getPairing,pairingReady,fetchFn=fetch,now=Date.now,timeoutMs=35000}){
  const reader=globalThis.LudyUberReportsReader;let state={active:false,tabId:null,url:null,status:'stopped',message:'Configurez les rapports dans Ludy, puis activez leur collecte.',last_import_at:null,next_attempt_at:0,enabled_types:['trip_activity'],jobs:{}},generation=0,pending=null,controller=null,reservation=null,lastHeartbeat=0,heartbeatQueue=Promise.resolve();
  function bounded(work,signal){if(signal.aborted)return Promise.reject(Object.assign(Error('Lecture interrompue ; nouvel essai automatique.'),{retryable:true}));return new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(Error('Lecture interrompue ; nouvel essai automatique.'),{retryable:true}));signal.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
  const ready=(async()=>{await pairingReady;try{const saved=(await storage.get('reportsConnector')).reportsConnector;if(saved&&typeof saved==='object'){for(const key of Object.keys(state))if(key in saved)state[key]=saved[key];if(!saved.jobs){state.jobs={trip_activity:blank()};for(const key of Object.keys(state.jobs.trip_activity))if(key in saved)state.jobs.trip_activity[key]=saved[key];}}if(!state.jobs||typeof state.jobs!=='object')state.jobs={};for(const type of TYPES){const clean=blank();for(const key of Object.keys(clean))if(state.jobs[type]&&key in state.jobs[type])clean[key]=state.jobs[type][key];state.jobs[type]=clean;}}catch{state.active=false;}})();
  const persist=()=>storage.set({reportsConnector:state});
  const publicState=()=>({active:state.active,status:state.status,message:state.message,last_import_at:state.last_import_at,next_attempt_at:state.next_attempt_at?new Date(state.next_attempt_at).toISOString():null,reports:(state.enabled_types||[]).filter(t=>TYPES.includes(t)).map(type=>({report_type:type,status:state.jobs[type]?.status||'waiting',message:state.jobs[type]?.message||'',diagnostic:state.jobs[type]?.diagnostic||null,structure:state.jobs[type]?.structure||null,last_import_at:state.jobs[type]?.last_import_at||null,next_attempt_at:state.jobs[type]?.next_attempt_at?new Date(state.jobs[type].next_attempt_at).toISOString():null}))});
  const allowed=async()=>!!await bounded(api.permissions?.contains?.({origins:[ORIGIN]}),AbortSignal.timeout(10000));
  async function local(path,body,signal){const token=getPairing().token;if(!token)throw Error('Associez d’abord le navigateur à Ludy.');const response=await fetchFn(BASE+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',signal});const result=await response.json();if(!response.ok)throw Object.assign(Error(response.status===401||response.status===403?'Association ou accès aux rapports refusé. Vérifiez les réglages de Ludy.':response.status>=400&&response.status<500&&typeof result?.error==='string'?result.error.slice(0,400):'Serveur local indisponible pour les rapports.'),{status:response.status});return result;}
  async function publishStatus({force=false}={}){
   await ready;const pair=getPairing();if(!pair.token||!pair.collectorId||!force&&now()-lastHeartbeat<60000)return;
   lastHeartbeat=now();const visible=publicState();
   const payload={version:reader.VERSION,collectorId:pair.collectorId,organizationId:reader.organizationId(state.url),active:state.active,status:state.status,nextAttemptAt:visible.next_attempt_at,reports:visible.reports.map(({report_type,status,last_import_at,next_attempt_at,diagnostic,structure})=>({report_type,status,last_import_at,next_attempt_at,diagnostic,structure}))};
   // Keep status messages in event order. A slow stopped heartbeat must not
   // arrive after a successful START and overwrite the current active state.
   heartbeatQueue=heartbeatQueue.catch(()=>{}).then(()=>getPairing().token===pair.token&&getPairing().collectorId===pair.collectorId?local('status',payload,AbortSignal.timeout(4000)):undefined).catch(()=>{});await heartbeatQueue;
  }
  function validConfig(config){if(config?.enabled!==true)throw Error('Activez et configurez les rapports Uber dans Ludy.');const url='https://fleethub.uber.com/orgs/'+String(config.organization_id||'')+'/reports',types=config.report_types||[config.report_type];if(!reader.permittedUrl(url)||!Array.isArray(types)||!types.length||types.length>3||new Set(types).size!==types.length||types.some(t=>!TYPES.includes(t)))throw Error('Flotte ou types de rapports non configurés.');reader.period(config);return {url,types};}
  async function stop(message='Collecte des rapports arrêtée.',{publish=true}={}){generation++;state.active=false;controller?.abort();controller=null;await api.alarms?.clear?.(ALARM);if(state.tabId!=null)try{await bounded(api.tabs.sendMessage(state.tabId,{type:'LUDY_UBER_REPORTS_CANCEL'}),AbortSignal.timeout(2000));}catch{}state.status='stopped';state.message=message;state.next_attempt_at=0;reservation=null;await persist();if(publish)void publishStatus({force:true});return publicState();}
  async function findTab(url,createMissing=false,signal=AbortSignal.timeout(10000)){
   if(state.tabId!=null)try{const tab=await bounded(api.tabs.get(state.tabId),signal);if(reader.permittedUrl(tab.url)&&reader.organizationId(tab.url)===reader.organizationId(url))return tab;}catch{}
   const candidates=(await bounded(api.tabs.query({url:url+'*'}),signal)).filter(tab=>reader.permittedUrl(tab.url)&&reader.organizationId(tab.url)===reader.organizationId(url)&&!tab.discarded);
   if(candidates.length>1)throw Error('Plusieurs onglets Rapports de cette flotte sont ouverts. Gardez-en un seul pour la collecte.');if(candidates.length)return candidates[0];if(createMissing)return bounded(api.tabs.create({url,active:false}),signal);return null;
  }
  function run({force=false}={}){
   if(pending)return pending;
   pending=(async()=>{
    await ready;void publishStatus();if(!state.active||now()<state.next_attempt_at)return publicState();if(!await allowed())return stop('Autorisation Uber retirée. Réactivez la collecte des rapports.');
    const own=generation,token=getPairing().token;controller=new AbortController();const ownController=controller,signal=ownController.signal,timeout=setTimeout(()=>ownController.abort(),timeoutMs),current=()=>state.active&&generation===own&&getPairing().token===token;
    try{
     const config=await bounded(local('config',undefined,signal),signal),{url,types}=validConfig(config),key=reader.period(config),interval=Math.max(21600,Number(config.interval_seconds)||21600)*1000;
     if(!current())return publicState();if(state.url&&reader.organizationId(state.url)!==reader.organizationId(url))return stop('La flotte des rapports a changé dans Ludy. Réactivez la collecte pour cette flotte.');
     state.enabled_types=types;const type=types.filter(t=>now()>=state.jobs[t].next_attempt_at).sort((a,b)=>state.jobs[a].next_attempt_at-state.jobs[b].next_attempt_at||state.jobs[a].last_checked_at-state.jobs[b].last_checked_at||TYPES.indexOf(a)-TYPES.indexOf(b))[0];
     if(!type){state.next_attempt_at=Math.min(...types.map(t=>state.jobs[t].next_attempt_at));await persist();return publicState();}
     const job=state.jobs[type];job.last_checked_at=now();job.diagnostic=null;job.structure=null;
     try{
      const tab=await findTab(url,false,signal);if(!tab||tab.status==='loading'){job.status='waiting_page';job.message='Ouvrez l’onglet Rapports de la flotte suivie ; la Live Map reste indépendante.';job.next_attempt_at=now()+60000;}
      else{
       state.tabId=tab.id;state.url=url;await bounded(api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['reports-reader.js','reports-content.js']}),signal);if(!current())return publicState();
       const runId=crypto.randomUUID();reservation={runId,tabId:tab.id,type,key,organizationId:config.organization_id,generation:own};const reply=await bounded(api.tabs.sendMessage(tab.id,{type:'LUDY_UBER_REPORTS_RUN',runId,config:{enabled:true,organization_id:config.organization_id,organization_label:config.organization_label||null,start_date:config.start_date,end_date:config.end_date,date_format:config.date_format,report_type:type},requested:job.requested_period===key}),signal);
       if(!current())return publicState();if(!reply?.ok||reply.runId!==runId)throw Object.assign(Error(String(reply?.message||'Rechargez l’onglet Rapports pour appliquer l’extension.').slice(0,400)),{retryable:reply?.retryable===true,diagnostic:reply?.diagnostic||null,structure:reply?.structure||null});const result=reply.result;
       if(result?.status==='requested'||result?.status==='waiting'){
        if(result.status==='requested'){job.requested_period=key;job.requested_at=now();}const delayed=job.requested_period===key&&now()-job.requested_at>15*60000;job.status=delayed?'action_required':'waiting_report';job.message=delayed?'Génération lente : nouvelle vérification dans six heures, sans autre demande.':String(result.message||'Génération en cours.').slice(0,400);job.next_attempt_at=now()+(delayed?interval:60000);
       }else if(result?.status==='ready'){
        const currentTab=await bounded(api.tabs.get(tab.id),signal);if(!current()||!reader.permittedUrl(currentTab.url)||reader.organizationId(currentTab.url)!==config.organization_id)throw Error('L’onglet Rapports a changé de flotte.');
        if(result.organizationId!==config.organization_id||result.reportType!==type||result.sourceUrl!==url&&result.sourceUrl!==url+'/')throw Error('Rapport provenant d’une autre flotte ou page.');reader.validateCSV(result.csv,type);
        const sent=await local('ingest',{organizationId:config.organization_id,reportType:type,filename:`uber-${type.replaceAll('_','-')}-${config.start_date}-${config.end_date}.csv`,csv:result.csv,sourceUrl:url,...(type==='trip_activity'?{}:{startDate:config.start_date,endDate:config.end_date})},signal);if(!current())return publicState();
        job.last_import_at=new Date(now()).toISOString();job.completed_period=key;job.requested_period=null;job.requested_at=0;job.status='ready';job.next_attempt_at=now()+interval;
        const counts=sent.counts,kept=type==='trip_activity'?counts?.imported:counts?.driver_imported,excluded=counts?Number(counts.excluded_status||0)+Number(counts.unlocated_city||0)+Number(counts.unconfigured_city||0)+Number(counts.missing_cancelled_pickup||0):0,unmatched=Number(counts?.driver_unmatched||0);
        job.message=kept===0?`Rapport reçu : aucune ${type==='trip_activity'?'course exploitable':'fiche liée'}. ${excluded} ligne(s) écartée(s), ${unmatched} non liée(s) ; consultez le journal dans Ludy.`:sent.duplicate?'Rapport déjà reçu, associations revérifiées.':`Rapport transmis à Ludy.${excluded?' '+excluded+' ligne(s) écartée(s).':''}${unmatched?' '+unmatched+' ligne(s) sans chauffeur confirmé.':''}`;
       }else throw Error('Réponse du lecteur de rapports invalide.');
      }
     }catch(error){if(!current())return publicState();const retry=error.retryable===true||error.name==='AbortError'||error.status>=500||error instanceof TypeError;job.status=retry?'retrying':'action_required';job.diagnostic=error.diagnostic||null;job.structure=error.structure||null;job.message=String(error.message||'Rapport indisponible.').slice(0,400);job.next_attempt_at=now()+(retry?60000:interval);}
     state.status=job.status;state.message=LABELS[type]+' : '+job.message;state.last_import_at=types.map(t=>state.jobs[t].last_import_at).filter(Boolean).sort().at(-1)||null;state.next_attempt_at=Math.min(...types.map(t=>state.jobs[t].next_attempt_at));await persist();void publishStatus({force:true});return publicState();
    }catch(error){if(current()){state.status='action_required';state.message=String(error.message||'Collecte interrompue.').slice(0,400);state.next_attempt_at=now()+60000;await persist();}return publicState();}
    finally{clearTimeout(timeout);if(controller===ownController)controller=null;if(reservation?.generation===own)reservation=null;}
   })().catch(async()=>{if(state.active){state.status='retrying';state.message='Vérification du navigateur interrompue. Nouvelle tentative dans une minute.';state.next_attempt_at=now()+60000;await persist().catch(()=>{});}return publicState();}).finally(()=>{pending=null;});return pending;
  }
  async function handle(message,sender){
   await ready;
   if(message.type==='LUDY_UBER_REPORTS_RESERVE'){
    const task=reservation;if(sender.id!==api.runtime.id||!state.active||!task||message.runId!==task.runId||generation!==task.generation||sender.tab?.id!==task.tabId||sender.frameId!==0||reader.organizationId(sender.url)!==task.organizationId)throw Error('Demande de rapport hors de la page suivie.');
    const job=state.jobs[task.type];if(job.requested_period===task.key)throw Error('Cette période a déjà été demandée. Attendez son export dans Uber.');
    job.requested_period=task.key;job.requested_at=now();await persist();return {reserved:true};
   }
   if(sender.id!==api.runtime.id||sender.url!==api.runtime.getURL('popup.html'))throw Error('Action rapports réservée à l’extension.');
   if(message.type==='LUDY_UBER_REPORTS_STATUS')return publicState();if(message.type==='LUDY_UBER_REPORTS_STOP')return stop();
   if(message.type==='LUDY_UBER_REPORTS_START'){
    if(!await allowed())throw Error('Autorisez le navigateur à lire l’onglet Rapports.');const config=await local('config',undefined,AbortSignal.timeout(10000)),{url,types}=validConfig(config);const sameOrganization=reader.organizationId(state.url)===reader.organizationId(url);await stop(undefined,{publish:false});if(pending)await pending;let tab;try{tab=await findTab(url,true);}catch(error){state.status='action_required';state.message=String(error.message||'Onglet Rapports indisponible.').slice(0,400);await persist();void publishStatus({force:true});throw error;}
    generation++;state.active=true;state.tabId=tab.id;state.url=url;state.status='starting';state.message='Collecte des rapports activée dans un onglet séparé.';state.next_attempt_at=0;state.enabled_types=types;for(const type of TYPES){if(!sameOrganization)state.jobs[type]=blank();else if(['retrying','waiting_page','action_required'].includes(state.jobs[type].status)){const job=state.jobs[type];job.next_attempt_at=0;job.status='waiting';job.message=job.requested_period===reader.period(config)?'Rapport déjà demandé : nouvelle vérification de son export.':'Nouvelle lecture demandée.';job.diagnostic=null;job.structure=null;}}await persist();await api.alarms?.create?.(ALARM,{periodInMinutes:1});void publishStatus({force:true});void run({force:true});return publicState();
   }throw Error('Action rapports inconnue.');
  }
  api.alarms?.onAlarm?.addListener(alarm=>{if(alarm.name===ALARM)void run();});
  api.tabs.onUpdated?.addListener((tabId,change)=>{if(state.active&&tabId===state.tabId&&change.status==='complete')void run({force:true});});
  api.tabs.onRemoved?.addListener(tabId=>{if(tabId===state.tabId){generation++;controller?.abort();state.tabId=null;state.status='waiting_page';state.message='Onglet Rapports fermé. Réouvrez-le pour reprendre ; la Live Map reste active.';state.next_attempt_at=Math.max(state.next_attempt_at,now()+60000);void persist();}});
  api.permissions?.onRemoved?.addListener(()=>{void ready.then(async()=>{if(state.active&&!await allowed())await stop('Autorisation Uber retirée : rapports arrêtés.');});});
  api.runtime.onStartup?.addListener(()=>{void ready.then(async()=>{if(state.active){state.tabId=null;await api.alarms?.create?.(ALARM,{periodInMinutes:1});await run();}});});
  void ready.then(async()=>{if(state.active)await api.alarms?.create?.(ALARM,{periodInMinutes:1});});void ready.then(()=>publishStatus());return {publicState,handle,stop,run,publishStatus};
 }
 globalThis.LudyUberReportsAutomation=Object.freeze({create});
})();
