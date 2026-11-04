'use strict';
const messages={
  connecting:['Ouverture de Ludy…','Connexion au serveur de staging.'],
  missing:['Le staging n’est pas encore relié','Cette archive attend l’adresse du serveur de test. Demandez la version configurée avant de la partager à vos collègues.'],
  invalid:['Cette version doit être reconfigurée','La configuration du serveur de test n’est pas valide. Demandez une nouvelle archive Ludy Staging.'],
  unverified:['Serveur de test non reconnu','Ludy n’a pas pu confirmer que cette adresse correspond au staging. Vérifiez l’adresse avec la personne qui prépare les tests.'],
  offline:['Ludy est momentanément inaccessible','Vérifiez votre connexion Internet et réessayez. Le serveur de staging peut aussi être en cours de redémarrage.']
};
async function render(){
  let data;try{data=await window.ludyClient?.state();}catch{}
  const state=data?.state in messages?data.state:'invalid',[title,message]=messages[state];
  document.getElementById('title').textContent=title;document.getElementById('message').textContent=message;
  document.getElementById('progress').hidden=state!=='connecting';
  const server=document.getElementById('server');server.textContent=data?.server||'';server.hidden=!data?.server;
  document.getElementById('retry').hidden=!data?.canRetry||state==='connecting';document.getElementById('browser').hidden=!data?.canRetry||state==='connecting'||state==='unverified';
  document.getElementById('operator').hidden=!data?.operatorLocal;
}
document.getElementById('retry').onclick=async event=>{event.currentTarget.disabled=true;try{await window.ludyClient.retry();}catch{event.currentTarget.disabled=false;}};
document.getElementById('browser').onclick=()=>window.ludyClient.browser().catch(()=>{});
void render();
