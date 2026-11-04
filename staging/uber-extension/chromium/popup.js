'use strict';
const api=globalThis.browser || globalThis.chrome;
let busy=false,lastState=null,reportsActionError=null;
async function request(type,extra={}){
  const response=await api.runtime.sendMessage({type,...extra});
  if(!response?.ok)throw Error(response?.error || 'Extension indisponible.');
  return response.data;
}
function render(state){
  lastState=state;
  document.getElementById('status').textContent=state.message;
  document.getElementById('status').dataset.state=state.state;
  const last=state.lastHealthyAt || state.lastSentAt,age=last?Math.max(0,Math.round((Date.now()-Date.parse(last))/1000)):null;
  document.getElementById('last-read').textContent=last?`Dernière observation : ${new Date(last).toLocaleTimeString('fr-FR')} · ${state.rows} chauffeur(s)${age>45?' · ancienne ('+age+' s)':''}${state.nextRetryAt?' · nouvelle tentative à '+new Date(state.nextRetryAt).toLocaleTimeString('fr-FR'):''}`:'Aucune lecture transmise.';
  document.getElementById('map-refresh').textContent=state.standby?'Actualisation suspendue : ce poste attend la collecte.':state.active?state.refreshPending?'Actualisation prévue : attente de la fin du parcours.':state.nextRefreshAt?'Live Map actualisée toutes les 20 min · prochaine à '+new Date(state.nextRefreshAt).toLocaleTimeString('fr-FR'):'Actualisation automatique de la Live Map active.':'Actualisation automatique suspendue.';
  const coverage=document.getElementById('coverage'),sweep=state.coverage;
  coverage.hidden=!sweep;
  coverage.textContent=sweep?sweep.complete?'La liste affichée a été parcourue. Les filtres Uber peuvent limiter les chauffeurs présents.':'Parcours incomplet : seuls les chauffeurs effectivement lus sont transmis. Les autres ne sont jamais déclarés hors ligne.':'';
  if(sweep&&Number.isInteger(sweep.vehicleObserved))coverage.textContent+=` Plaques lues depuis moins de 3 minutes : ${sweep.vehicleObserved}/${state.rows}.`;
  document.getElementById('start').disabled=busy || !state.paired || state.active && state.state!=='waiting_page';
  document.getElementById('stop').disabled=busy || !state.active;
  document.getElementById('forget').disabled=busy || !state.paired;
  document.getElementById('auto-resume').checked=!!state.autoResume;
  document.getElementById('auto-resume').disabled=busy;
  renderReports(state.reports);
}
function renderReports(state){
  const status=document.getElementById('reports-status');
  status.textContent=reportsActionError||state?.message||'Configurez les rapports Uber dans Ludy.';
  status.dataset.state=reportsActionError?'error':state?.status||'waiting';
  document.getElementById('reports-start').disabled=busy||!lastState?.paired;
  document.getElementById('reports-stop').disabled=busy||!state?.active;
  const labels={trip_activity:'Courses',driver_activity:'Activité',driver_quality:'Qualité'},statuses={ready:'reçu',retrying:'nouvel essai automatique',action_required:'à vérifier',waiting_report:'en génération',waiting:'en attente',waiting_page:'page à ouvrir'};
  document.getElementById('reports-jobs').replaceChildren(...(state?.reports||[]).map(report=>{
    const item=document.createElement('li');
    item.textContent=(labels[report.report_type]||'Rapport')+' : '+(statuses[report.status]||'en attente')+(report.message&&['action_required','retrying','waiting_page'].includes(report.status)?' · '+report.message:'');
    return item;
  }));
}
async function reportAction(type){
  if(busy)return;
  busy=true;reportsActionError=null;renderReports(lastState?.reports);
  try{
    // Request the optional host permission directly during the button gesture,
    // before waiting for any background response, even when Ludy is the active tab.
    if(type==='LUDY_UBER_REPORTS_START'&&!await api.permissions.request({origins:['https://fleethub.uber.com/*']}))throw Error('Autorisation navigateur non accordée. Cliquez à nouveau sur Activer les rapports pour réessayer.');
    const state=await request(type);if(lastState)lastState.reports=state;
    busy=false;renderReports(state);
  }catch(error){
    busy=false;reportsActionError=error.message||'Activation des rapports impossible.';renderReports(lastState?.reports);
  }
}
async function action(type,extra){
  busy=true;for(const button of document.querySelectorAll('button'))button.disabled=true;
  try{const state=await request(type,extra);busy=false;render(state);}
  catch(error){busy=false;document.getElementById('status').textContent=error.message;document.getElementById('status').dataset.state='error';}
  finally{busy=false;document.querySelector('form button').disabled=false;}
}
document.getElementById('pair-form').addEventListener('submit',event=>{event.preventDefault();const field=document.getElementById('token'),token=field.value.trim();field.value='';void action('LUDY_UBER_PAIR',{token});});
document.getElementById('start').addEventListener('click',()=>void action('LUDY_UBER_START'));
document.getElementById('stop').addEventListener('click',()=>void action('LUDY_UBER_STOP'));
document.getElementById('forget').addEventListener('click',()=>void action('LUDY_UBER_FORGET'));
document.getElementById('reports-start').addEventListener('click',()=>void reportAction('LUDY_UBER_REPORTS_START'));
document.getElementById('reports-stop').addEventListener('click',()=>void reportAction('LUDY_UBER_REPORTS_STOP'));
document.getElementById('auto-resume').addEventListener('change',async event=>{
  const enabled=event.target.checked,origins=['https://fleethub.uber.com/*'];
  try{
    // The browser permission prompt must be initiated directly by this user gesture.
    if(enabled&&!await api.permissions.request({origins})){event.target.checked=false;return;}
    await action('LUDY_UBER_AUTO',{enabled});
    if(!enabled&&!lastState?.reports?.active)await api.permissions.remove({origins});
  }catch{event.target.checked=false;document.getElementById('status').textContent='Autorisation non accordée. Le démarrage manuel reste disponible.';}
});
const refresh=()=>{if(!busy)request('LUDY_UBER_STATUS').then(render).catch(()=>{});};
refresh();const timer=setInterval(refresh,1000);addEventListener('unload',()=>clearInterval(timer));
