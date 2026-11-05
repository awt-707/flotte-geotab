/* The access token stays in memory; Supabase remains the Auth session owner. */
(() => {
  'use strict';
  const config=window.FLOTTE_CONFIG || {};
  const enabled=config.DESKTOP_PRODUCTION===true && config.STAGING===false && config.ENVIRONMENT==='production' && location.origin==='http://127.0.0.1:4173';
  let token=null,userId=null,revision=0,queue=Promise.resolve(),timer=null,requestController=null,status=null,admin=false,busy=false,message='Connexion au poste…',observed=false;
  const current=version=>version===revision;
  function stopPoll(){clearTimeout(timer);timer=null;requestController?.abort();requestController=null;}
  function participation(){return status?.participationEnabled ?? status?.participation?.enabled ?? status?.enabled ?? false;}
  function collectionInstruction(){
    if(!admin)return 'Un administrateur doit activer la collecte sur un poste pour actualiser les connecteurs.';
    if(status?.coordinator?.state==='follower')return 'Un autre poste assure la collecte. Utilisez ce poste pour piloter les connecteurs ; celui-ci prendra le relais lorsque la collecte sera disponible.';
    return 'Cliquez sur « Participer à la collecte » pour activer les connecteurs sur cet ordinateur.';
  }
  // Only our known messages are translated. Never render arbitrary provider,
  // database or network error text, which can contain credentials or URLs.
  function safeReason(value){
    const messages={
      'Coordination non disponible : vérifier les migrations de production.':'Collecte indisponible : demandez à l’administrateur de vérifier la mise à jour de la base Ludy.',
      'Coordination Supabase indisponible.':'Coordination indisponible. Vérifiez Internet, puis réessayez ; si le problème persiste, contactez l’administrateur.',
      'Un connecteur demande une vérification.':'Un connecteur demande une vérification. Ouvrez « Connecteurs » pour contrôler son état.',
      'Connectez Uber sur ce poste pour reprendre ses rapports.':'Uber demande une connexion. Utilisez « Connecter Uber » sur le poste qui collecte.',
      'Connexion Ludy requise.':'Reconnectez-vous à Ludy pour accéder aux connecteurs.',
      'Session Ludy expirée.':'Votre session Ludy a expiré. Déconnectez-vous, puis reconnectez-vous.',
      'Session Ludy expirée ou invalide.':'Votre session Ludy a expiré ou n’est plus valide. Déconnectez-vous, puis reconnectez-vous.',
      'Session remplacée.':'La session du poste a changé. Reconnectez-vous à Ludy.',
      'Session du poste remplacée.':'La session du poste a changé. Reconnectez-vous à Ludy.',
      'Administrateur requis.':'Connectez-vous avec un compte administrateur pour piloter la collecte.',
      'Accès administrateur requis.':'Connectez-vous avec un compte administrateur pour piloter la collecte.'
    };
    if(typeof value!=='string')return '';
    if(['Cette action demande la collecte active sur ce poste.','Activez la collecte sur ce poste avant de connecter Uber.','Collecte suspendue.'].includes(value))return collectionInstruction();
    if(value==='La collecte appartient à un autre poste.')return 'Un autre poste assure la collecte. Utilisez ce poste pour piloter les connecteurs.';
    return Object.hasOwn(messages,value)?messages[value]:'';
  }
  const errorMessage=(error,fallback)=>error?.desktopMessage||fallback;
  function label(){
    if(!token)return 'Connectez-vous pour accéder aux données partagées.';
    if(message)return message;
    const state=status?.coordinator?.state ?? status?.state ?? status?.phase;
    if(status?.error)return (state==='leader'||state==='collecting'?'Collecte active sur ce poste · ':'')+(safeReason(status.error)||'La collecte demande une vérification. Ouvrez « Connecteurs » ou contactez l’administrateur.');
    if(state==='leader'||state==='collecting')return 'Collecte active sur ce poste';
    if(state==='follower')return 'Données partagées · un autre poste collecte';
    if(state==='error'||state==='unavailable')return 'Collecte indisponible. Vérifiez Internet ; une nouvelle tentative est automatique. Les données partagées restent consultables.';
    if(!participation())return 'Collecte désactivée sur ce poste. '+collectionInstruction();
    if(state==='paused')return 'Collecte suspendue sur ce poste. Gardez Ludy ouvert et vérifiez la participation de cet ordinateur.';
    if(state==='waiting'||state==='acquiring')return 'Participation active · attente de la collecte';
    return 'Données partagées · vérification de la collecte';
  }
  function paint(){
    if(!enabled)return;
    for(const element of document.querySelectorAll('[data-desktop-worker-status]'))element.textContent=label();
    for(const button of document.querySelectorAll('[data-desktop-worker-toggle]')){
      button.hidden=!admin||!token;button.disabled=busy||!status;
      button.textContent=participation()?'Suspendre la collecte sur ce poste':'Participer à la collecte';
      button.onclick=toggle;
    }
    const uber=status?.uber?.state;
    const uberLabel={'login_required':'Uber : connexion requise sur ce poste','browser-install-required':'Uber : installation du navigateur nécessaire','ready':'Uber : navigateur connecté','running':'Uber : lecture des rapports active','stopped':'Uber : navigateur arrêté','action_required':'Uber : vérifiez la fenêtre du navigateur','configuration_required':'Uber : configurez la flotte dans les rapports'}[uber]||'';
    for(const element of document.querySelectorAll('[data-desktop-uber-status]'))element.textContent=uberLabel;
    for(const button of document.querySelectorAll('[data-desktop-uber-open]')){
      button.hidden=!admin||!token;button.disabled=busy||!status||status.coordinator?.state!=='leader';
      button.onclick=openUber;
    }
  }
  async function request(route,{method='GET',accessToken=token,body,signal}={}){
    const response=await fetch('/api/desktop/'+route,{method,headers:{...(accessToken?{Authorization:'Bearer '+accessToken}:{}),...(method==='GET'?{}:{'Content-Type':'application/json'})},
      ...(method==='GET'?{}:{body:JSON.stringify(body??{})}),credentials:'same-origin',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
    if(!response.ok){
      const result=await response.json().catch(()=>null);
      const fallback=response.status===401?'Votre session Ludy a expiré. Déconnectez-vous, puis reconnectez-vous.':response.status===403?'Action non autorisée. Vérifiez votre compte administrateur.':response.status===409?collectionInstruction():response.status>=500?'Le poste ne répond pas correctement. Vérifiez Internet, puis fermez et rouvrez Ludy si le problème persiste.':'Action refusée. Réessayez ; si le problème persiste, contactez l’administrateur.';
      throw Object.assign(Error('Requête du poste refusée.'),{status:response.status,desktopMessage:safeReason(result?.error)||fallback});
    }
    return response.status===204?null:response.json();
  }
  async function poll(version){
    if(!current(version)||!token)return;
    const controller=new AbortController();requestController=controller;
    try {
      const result=await request('status',{signal:controller.signal});
      if(!current(version))return;
      status=result?.status && typeof result.status==='object'?result.status:result;message='';
    } catch(error) {if(current(version)){status=null;message=errorMessage(error,'État du poste indisponible · nouvelle vérification en cours');}}
    finally {
      if(requestController===controller)requestController=null;
      if(current(version)&&token){paint();timer=setTimeout(()=>{timer=null;void poll(version);},5000);}
    }
  }
  async function toggle(){
    if(!enabled||!admin||!token||busy||!status)return;
    const version=revision;busy=true;paint();stopPoll();
    try {await request('participation',{method:'POST',body:{enabled:!participation()}});if(current(version))await poll(version);}
    catch(error) {if(current(version)){message='Participation inchangée. '+errorMessage(error,'Vérifiez Internet, puis réessayez.');timer=setTimeout(()=>{timer=null;void poll(version);},5000);}}
    finally {if(current(version)){busy=false;paint();}}
  }
  async function openUber(){
    if(!enabled||!admin||!token||busy||status?.coordinator?.state!=='leader')return;
    const version=revision;busy=true;paint();stopPoll();
    try {await request('uber/open',{method:'POST'});if(current(version))await poll(version);}
    catch(error) {if(current(version)){message=errorMessage(error,'Ouverture d’Uber indisponible. Vérifiez la participation de ce poste.');timer=setTimeout(()=>{timer=null;void poll(version);},5000);}}
    finally {if(current(version)){busy=false;paint();}}
  }
  async function bindSession(version,accessToken,attempt=0){
    if(!current(version)||token!==accessToken)return;
    const controller=new AbortController();requestController=controller;
    try {
      await request('session',{method:'POST',accessToken,signal:controller.signal});
      if(current(version)&&token===accessToken)await poll(version);
    } catch(error) {
      if(!current(version)||token!==accessToken)return;
      const retryable=!Number.isInteger(error?.status)||error.status===408||error.status===429||error.status>=500;
      message=retryable?'Connexion du poste indisponible · nouvelle tentative automatique. Vérifiez Internet.':errorMessage(error,'Connexion du poste refusée. Reconnectez-vous.');
      paint();
      if(retryable){
        // One bounded-backoff retry, outside the queue so a logout never waits
        // for it. Every attempt belongs to this exact in-memory session.
        timer=setTimeout(()=>{
          if(!current(version)||token!==accessToken)return;
          timer=null;
          queue=queue.catch(()=>{}).then(()=>bindSession(version,accessToken,attempt+1));
        },Math.min(30000,2000*2**Math.min(attempt,4)));
      }
    } finally {if(requestController===controller)requestController=null;}
  }
  function sessionChanged(session){
    if(!enabled)return Promise.resolve();
    const next=typeof session?.access_token==='string'&&session?.user?.id?session.access_token:null;
    const nextUser=next?session.user.id:null;
    if(observed&&next===token&&nextUser===userId)return queue;
    observed=true;const previous=token,version=++revision;token=next;status=null;busy=false;
    if(userId!==nextUser)admin=false;userId=nextUser;
    message=next?'Connexion du poste…':'';stopPoll();paint();
    // Serialise transitions: an earlier login response cannot restore a signed-out UI.
    queue=queue.catch(()=>{}).then(async()=>{
      if(!current(version))return;
      if(next)return bindSession(version,next);
      try {
        await request('logout',{method:'POST',accessToken:previous});
      } catch {if(current(version)){message='';paint();}}
    });
    return queue;
  }
  function mount(options={}){if(enabled){admin=options.admin===true;paint();}}
  function html(){return enabled?'<div class="desktop-worker"><p data-desktop-worker-status role="status" aria-live="polite">Connexion au poste…</p><button type="button" class="ghost" data-desktop-worker-toggle hidden>Participer à la collecte</button><p data-desktop-uber-status role="status"></p><button type="button" class="ghost" data-desktop-uber-open hidden>Connecter Uber</button></div>':'';}
  window.desktopWorkerSessionChanged=sessionChanged;
  window.desktopWorkerMount=mount;
  window.desktopWorkerHtml=html;
})();
