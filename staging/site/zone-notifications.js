const ZONE_NOTICES={timer:null,expiryTimer:null,controller:null,owner:null,hidden:new Set(),node:null,busy:false,alerts:[],parked:[],readAt:0,revision:0};
function zoneAlertsForVehicle(key){return ZONE_NOTICES.owner===S.session?.user?.id&&Date.now()-ZONE_NOTICES.readAt>=0&&Date.now()-ZONE_NOTICES.readAt<=15000?ZONE_NOTICES.alerts.filter(a=>a.vehicle_key===key):[];}
function mapUnusedParking(key){if(ZONE_NOTICES.owner!==S.session?.user?.id||Date.now()-ZONE_NOTICES.readAt<0||Date.now()-ZONE_NOTICES.readAt>15000)return null;const rows=ZONE_NOTICES.parked.filter(v=>v.vehicle_key===key);return rows.length===1?rows[0]:null;}
function zoneNotificationsPaint(){if(typeof pageOf==='function'&&pageOf()==='direct'&&document.getElementById('vlist')&&typeof paintOperationsDirect==='function')paintOperationsDirect();}
function zoneNotificationsCleanup(){ZONE_NOTICES.revision++;clearInterval(ZONE_NOTICES.timer);ZONE_NOTICES.timer=null;clearTimeout(ZONE_NOTICES.expiryTimer);ZONE_NOTICES.expiryTimer=null;ZONE_NOTICES.controller?.abort();ZONE_NOTICES.controller=null;ZONE_NOTICES.busy=false;ZONE_NOTICES.node?.remove();ZONE_NOTICES.node=null;ZONE_NOTICES.alerts=[];ZONE_NOTICES.parked=[];ZONE_NOTICES.readAt=0;}
function zoneNotificationsStart(routing){
 zoneNotificationsCleanup();const owner=S.session?.user?.id,revision=ZONE_NOTICES.revision;if(!owner)return;if(ZONE_NOTICES.owner!==owner){ZONE_NOTICES.hidden.clear();ZONE_NOTICES.owner=owner;}
 const current=()=>revision===ZONE_NOTICES.revision&&routing===ROUTING&&owner===S.session?.user?.id;
 const expire=()=>{if(!current())return;ZONE_NOTICES.expiryTimer=null;ZONE_NOTICES.alerts=[];ZONE_NOTICES.parked=[];ZONE_NOTICES.readAt=0;ZONE_NOTICES.node?.remove();ZONE_NOTICES.node=null;zoneNotificationsPaint();};
 async function read(){
  if(!current()||document.hidden||ZONE_NOTICES.busy)return;ZONE_NOTICES.busy=true;const controller=new AbortController();ZONE_NOTICES.controller=controller;const timeout=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch('/api/parking/alerts',{headers:{Authorization:'Bearer '+S.session.access_token},credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});if(!response.ok)throw Error('Zones indisponibles');const data=await response.json();if(!current()||controller.signal.aborted)return;if(!Array.isArray(data.alerts))throw Error('Alertes invalides');const ids=new Set(data.alerts.map(a=>a.id));for(const id of ZONE_NOTICES.hidden)if(!ids.has(id))ZONE_NOTICES.hidden.delete(id);
   ZONE_NOTICES.alerts=data.alerts;ZONE_NOTICES.parked=Array.isArray(data.parked_vehicles)?data.parked_vehicles:[];ZONE_NOTICES.readAt=Date.now();clearTimeout(ZONE_NOTICES.expiryTimer);ZONE_NOTICES.expiryTimer=setTimeout(expire,15001);zoneNotificationsPaint();
   const shown=data.alerts.filter(a=>!ZONE_NOTICES.hidden.has(a.id));ZONE_NOTICES.node?.remove();ZONE_NOTICES.node=null;if(!shown.length)return;
   const box=document.getElementById('toasts');if(!box)return;const node=document.createElement('aside');node.className='toast';node.style.borderLeft='4px solid '+(shown.every(a=>a.indicative)?'#a96808':'#b62848');node.setAttribute('role','status');
   const title=shown.every(a=>a.category==='outside_operating')?'Disponible hors zone':shown.every(a=>a.category!=='outside_operating')?'Zone d’exclusion':'Signalements de zone';
   node.innerHTML=`<button class="x" aria-label="Masquer ce signalement">×</button><strong>${title} · ${shown.length} véhicule${shown.length>1?'s':''}</strong>${shown.slice(0,3).map(a=>'<p><b>'+esc(a.plate)+'</b> · '+esc(a.zone_name)+(a.indicative?'<br><small>Signalement indicatif · contour approximatif</small>':'')+'</p>').join('')}<a href="#/parkings">Voir les zones et les observations</a>`;
   node.querySelector('button').onclick=()=>{shown.forEach(a=>ZONE_NOTICES.hidden.add(a.id));node.remove();ZONE_NOTICES.node=null;};box.appendChild(node);ZONE_NOTICES.node=node;
  }catch{if(current()){clearTimeout(ZONE_NOTICES.expiryTimer);expire();}}
  finally{clearTimeout(timeout);if(ZONE_NOTICES.controller===controller){ZONE_NOTICES.controller=null;ZONE_NOTICES.busy=false;}}
 }
 void read();ZONE_NOTICES.timer=setInterval(read,5000);
}
