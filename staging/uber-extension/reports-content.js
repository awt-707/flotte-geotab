(() => {
 'use strict';const api=globalThis.browser||globalThis.chrome,reader=globalThis.LudyUberReportsReader;if(!reader)return;
 const previous=globalThis.__ludyUberReportsContent;if(previous?.version===reader.VERSION)return;
 if(previous&&!previous.dispose)throw Error('Rechargez l’onglet Rapports pour appliquer la nouvelle extension.');
 previous?.dispose?.();let active=null;
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const structure=()=>{try{return reader.structure(document);}catch{return null;}};
 const untilAbort=(work,signal)=>new Promise((resolve,reject)=>{const aborted=()=>reject(Error('Lecture interrompue.'));if(signal.aborted)return aborted();signal.addEventListener('abort',aborted,{once:true});Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));});
 const onMessage=(message,sender,respond)=>{
  if(sender.id!==api.runtime.id||!['LUDY_UBER_REPORTS_RUN','LUDY_UBER_REPORTS_CANCEL'].includes(message?.type))return false;
  if(message.type==='LUDY_UBER_REPORTS_CANCEL'){active?.abort();active=null;respond({ok:true});return false;}
  if(active){respond({ok:false,message:'Une lecture de rapport est déjà en cours.'});return false;}
  const controller=new AbortController();active=controller;const cancel=event=>{if(event.isTrusted)controller.abort();};document.addEventListener('pointerdown',cancel,true);document.addEventListener('keydown',cancel,true);
  const timeout=setTimeout(()=>controller.abort(),25000);
  (async()=>{
   const config=message.config;if(!config?.enabled||message.runId==null)throw Error('Collecte des rapports non autorisée.');
   if(Intl.DateTimeFormat().resolvedOptions().timeZone!=='Africa/Casablanca')throw Error('Les rapports demandent un navigateur réglé sur Africa/Casablanca. Utilisez le collecteur Ludy dédié, qui fixe l’heure du Maroc.');
   let state=reader.inspect(document,location.href,config);if(controller.signal.aborted)throw Error('Lecture interrompue par votre interaction.');
   if(state.status==='landing'){
    if(message.requested)return {status:'waiting',message:'Rapport déjà demandé : attente de son lien dans le tableau Uber.'};
    // This opens Uber's normal drawer. It does not generate a report or create
    // a schedule. The final Generate action is reserved separately below.
    state.open.click();
    state=await reader.waitFor(()=>{try{const next=reader.inspect(document,location.href,config);return next.status==='landing'?null:next;}catch{return null;}},{signal:controller.signal,timeout:5000});
   }
   if(state.status==='form'){
    if(message.requested)return {status:'waiting',message:'Rapport demandé : attente du lien de téléchargement dans cet onglet.'};
    state=await reader.prepareForm(state,config,{signal:controller.signal});await pause(100);if(controller.signal.aborted)throw Error('Lecture interrompue par votre interaction.');state=reader.inspect(document,location.href,config);
    if(state.status==='form'){
     reader.verify(state,config);
     // Persist the generation intent before clicking. A worker restart or a
     // lost acknowledgement can then wait for the existing export safely.
     const reserved=await untilAbort(api.runtime.sendMessage({type:'LUDY_UBER_REPORTS_RESERVE',runId:message.runId}),controller.signal);
     if(!reserved?.ok||!reserved.data?.reserved)throw Error('Demande déjà enregistrée ou lecture interrompue. Vérifiez la génération dans Uber.');
     if(controller.signal.aborted)throw Error('Lecture interrompue par votre interaction.');
     reader.generate(state,config);return {status:'requested',message:'Rapport d’activité demandé dans Uber. Attente de sa génération.'};
    }
   }
   if(state.status!=='download')throw Error('Téléchargement du rapport non reconnu.');
   const csv=await reader.readDownload(state.download.url,location.href,{signal:controller.signal,reportType:config.report_type});if(controller.signal.aborted)throw Error('Lecture du rapport interrompue.');
   return {status:'ready',organizationId:state.organizationId,reportType:config.report_type,filename:`uber-${config.report_type.replaceAll('_','-')}-${config.start_date}-${config.end_date}.csv`,sourceUrl:location.origin+location.pathname,csv};
  })().then(result=>respond({ok:true,runId:message.runId,result}),error=>respond({ok:false,runId:message.runId,retryable:controller.signal.aborted||error.name==='TypeError',diagnostic:reader.diagnostic(error),structure:reader.diagnostic(error)?structure():null,message:controller.signal.aborted?'Lecture du rapport interrompue. Nouvel essai lorsque l’onglet est disponible.':error.message})).finally(()=>{clearTimeout(timeout);document.removeEventListener('pointerdown',cancel,true);document.removeEventListener('keydown',cancel,true);if(active===controller)active=null;});
  return true;
 };
 api.runtime.onMessage.addListener(onMessage);
 globalThis.__ludyUberReportsContent={version:reader.VERSION,dispose(){active?.abort();active=null;api.runtime.onMessage.removeListener(onMessage);}};
})();
