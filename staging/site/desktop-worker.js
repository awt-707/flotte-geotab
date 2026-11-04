/* The access token stays in memory; Supabase remains the Auth session owner. */
(() => {
  'use strict';
  const config=window.FLOTTE_CONFIG || {};
  const enabled=config.DESKTOP_PRODUCTION===true && config.STAGING===false && config.ENVIRONMENT==='production' && location.origin==='http://127.0.0.1:4173';
  let token=null,userId=null,revision=0,queue=Promise.resolve(),timer=null,requestController=null,status=null,admin=false,busy=false,message='Connexion au poste…',observed=false;
  const current=version=>version===revision;
  function stopPoll(){clearTimeout(timer);timer=null;requestController?.abort();requestController=null;}
  function participation(){return status?.participationEnabled ?? status?.participation?.enabled ?? status?.enabled ?? false;}
  function label(){
    if(!token)return 'Connectez-vous pour accéder aux données partagées.';
    if(message)return message;
    const state=status?.coordinator?.state ?? status?.state ?? status?.phase;
    if(state==='leader'||state==='collecting')return 'Collecte active sur ce poste';
    if(state==='follower')return 'Données partagées · un autre poste collecte';
    if(state==='paused'||!participation())return 'Données partagées · collecte suspendue sur ce poste';
    if(state==='waiting'||state==='acquiring')return 'Participation active · attente de la collecte';
    if(state==='error'||state==='unavailable')return 'Collecte indisponible · données partagées consultables';
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
    if(!response.ok)throw Error('Poste indisponible.');
    return response.status===204?null:response.json();
  }
  async function poll(version){
    if(!current(version)||!token)return;
    const controller=new AbortController();requestController=controller;
    try {
      const result=await request('status',{signal:controller.signal});
      if(!current(version))return;
      status=result?.status && typeof result.status==='object'?result.status:result;message='';
    } catch {if(current(version)){status=null;message='État du poste indisponible · nouvelle vérification en cours';}}
    finally {
      if(requestController===controller)requestController=null;
      if(current(version)&&token){paint();timer=setTimeout(()=>{timer=null;void poll(version);},5000);}
    }
  }
  async function toggle(){
    if(!enabled||!admin||!token||busy||!status)return;
    const version=revision;busy=true;paint();stopPoll();
    try {await request('participation',{method:'POST',body:{enabled:!participation()}});if(current(version))await poll(version);}
    catch {if(current(version)){message='Participation inchangée : réessayez.';timer=setTimeout(()=>{timer=null;void poll(version);},5000);}}
    finally {if(current(version)){busy=false;paint();}}
  }
  async function openUber(){
    if(!enabled||!admin||!token||busy||status?.coordinator?.state!=='leader')return;
    const version=revision;busy=true;paint();stopPoll();
    try {await request('uber/open',{method:'POST'});if(current(version))await poll(version);}
    catch {if(current(version)){message='Ouverture d’Uber indisponible. Vérifiez la participation de ce poste.';timer=setTimeout(()=>{timer=null;void poll(version);},5000);}}
    finally {if(current(version)){busy=false;paint();}}
  }
  function sessionChanged(session){
    if(!enabled)return Promise.resolve();
    const next=typeof session?.access_token==='string'&&session?.user?.id?session.access_token:null;
    if(observed&&next===token)return queue;
    observed=true;const previous=token,version=++revision;token=next;status=null;busy=false;
    if(userId!==session?.user?.id)admin=false;userId=next?session.user.id:null;
    message=next?'Connexion du poste…':'';stopPoll();paint();
    // Serialise transitions: an earlier login response cannot restore a signed-out UI.
    queue=queue.catch(()=>{}).then(async()=>{
      if(!current(version))return;
      try {
        if(next)await request('session',{method:'POST',accessToken:next});
        else await request('logout',{method:'POST',accessToken:previous});
        if(current(version)&&next)await poll(version);
      } catch {if(current(version)){message=next?'Connexion du poste indisponible. Reconnectez-vous.':'';paint();}}
    });
    return queue;
  }
  function mount(options={}){if(enabled){admin=options.admin===true;paint();}}
  function html(){return enabled?'<div class="desktop-worker"><p data-desktop-worker-status role="status" aria-live="polite">Connexion au poste…</p><button type="button" class="ghost" data-desktop-worker-toggle hidden>Participer à la collecte</button><p data-desktop-uber-status role="status"></p><button type="button" class="ghost" data-desktop-uber-open hidden>Connecter Uber</button></div>':'';}
  window.desktopWorkerSessionChanged=sessionChanged;
  window.desktopWorkerMount=mount;
  window.desktopWorkerHtml=html;
})();
