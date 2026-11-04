/* Navigation only: a chosen zone never changes vehicle filters or live tracking. */
function mapZonesMarkup(){return '<form class="map-zones" aria-label="Centrer la carte sur une zone"><label>Aller vers une zone<select data-map-zone aria-label="Zone à afficher" disabled><option value="">Chargement des zones…</option></select></label><button type="submit" data-map-zone-go disabled>Aller</button><button type="button" data-map-zone-refresh class="map-zones-refresh" aria-label="Actualiser les zones" title="Actualiser les zones">↻</button><p data-map-zone-status role="status" aria-live="polite"></p></form>';}

function mapZoneShapeValid(shape){
 const point=p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=85&&Math.abs(p.lon)<=180;
 return shape?.type==='circle'?point(shape.center)&&Number.isFinite(shape.radius_m)&&shape.radius_m>=40&&shape.radius_m<=50000:shape?.type==='polygon'&&Array.isArray(shape.points)&&shape.points.length>=3&&shape.points.length<=1000&&shape.points.every(point);
}

function mountMapZones({map,container,isCurrent=()=>true,onNavigate=()=>{},getAgency=()=>typeof agFilter==='function'?agFilter():''}){
 const form=container?.matches('.map-zones')?container:container?.querySelector('.map-zones');
 if(!map||!form)throw Error('Carte et contrôle de zones requis');
 const select=form.querySelector('[data-map-zone]'),go=form.querySelector('[data-map-zone-go]'),refreshButton=form.querySelector('[data-map-zone-refresh]'),status=form.querySelector('[data-map-zone-status]');
 const owner=S.session?.user?.id;let disposed=false,controller=null,pending=null,zones=[],agencies=[],scope=null,lastRead=0,loaded=false,loadError=false,outline=null,outlineId=null,outlineShape=null;
 const current=()=>!disposed&&form.isConnected&&isCurrent()&&!!owner&&S.session?.user?.id===owner;
 const kindLabel=kind=>kind==='operating'?'Zone autorisée':kind==='exclusion'?'Exclusion':'Parking';
 const removeOutline=()=>{if(outline&&map.hasLayer(outline))map.removeLayer(outline);outline=null;outlineId=null;outlineShape=null;};
 const permitted=()=>zones.filter(z=>!scope||z.agency_id==null||String(z.agency_id)===scope);
 const setStatus=text=>{status.textContent=text;};
 function drawOutline(zone){
  const shapeKey=JSON.stringify([zone.shape,zone.kind,zone.enabled,zone.indicative]);
  if(outlineId===zone.id&&outlineShape===shapeKey)return outline;
  removeOutline();const options={color:zone.kind==='operating'?'#386ed0':zone.kind==='exclusion'?'#bd3455':'#22815d',weight:3,fillOpacity:.08,interactive:false,dashArray:zone.enabled===false?'6 5':null};
  outline=zone.shape.type==='circle'?L.circle([zone.shape.center.lat,zone.shape.center.lon],{...options,radius:zone.shape.radius_m}):L.polygon(zone.shape.points.map(p=>[p.lat,p.lon]),options);
  outline.addTo(map);outlineId=zone.id;outlineShape=shapeKey;return outline;
 }
 function paint(){
  if(!current())return;scope=String(getAgency()||'');const rows=permitted(),selected=select.value,fragment=document.createDocumentFragment(),placeholder=document.createElement('option');
  placeholder.value='';placeholder.textContent=rows.length?'Choisir une zone…':loaded?'Aucune zone pour cette agence':'Chargement des zones…';fragment.append(placeholder);
  const groups=new Map();
  for(const zone of rows){
   const agency=agencies.find(a=>String(a.id)===String(zone.agency_id));
   const groupLabel=zone.agency_id==null?'Toutes les agences':agency?[agency.city,agency.name].filter(Boolean).join(' · '):'Agence '+zone.agency_id;
   if(!groups.has(groupLabel))groups.set(groupLabel,[]);groups.get(groupLabel).push(zone);
  }
  for(const [label,entries]of [...groups].sort(([a],[b])=>a.localeCompare(b,'fr'))){
   const group=document.createElement('optgroup');group.label=label;
   for(const zone of entries.sort((a,b)=>a.name.localeCompare(b.name,'fr'))){const option=document.createElement('option');option.value=zone.id;option.textContent=zone.name+' · '+kindLabel(zone.kind)+(zone.enabled===false?' · désactivée':'')+(zone.indicative?' · indicatif':'');group.append(option);}fragment.append(group);
  }
  select.replaceChildren(fragment);select.value=rows.some(z=>z.id===selected)?selected:'';select.disabled=!rows.length;go.disabled=!select.value;
  if(outlineId){const zone=rows.find(z=>z.id===outlineId);if(!zone)removeOutline();else drawOutline(zone);}
  if(!loadError)setStatus(rows.length?'':loaded?'Aucune zone configurée pour cette agence.':'Chargement des zones…');
 }
 function syncScope(){if(!current()){cleanup();return;}if(scope!==String(getAgency()||''))paint();}
 function cleanup(){if(disposed)return;disposed=true;controller?.abort();controller=null;removeOutline();form.removeEventListener('submit',navigate);select.removeEventListener('change',changed);select.removeEventListener('focus',focused);refreshButton.removeEventListener('click',refresh);map.off('unload',cleanup);zones=[];agencies=[];select.replaceChildren();select.disabled=true;go.disabled=true;refreshButton.disabled=true;setStatus('');}
 async function refresh(){
  if(!current()){cleanup();return;}if(pending)return pending;
  controller=new AbortController();refreshButton.disabled=true;loadError=false;setStatus('Actualisation des zones…');
  pending=(async()=>{
   try{
    const response=await fetch('/api/parking/zones',{headers:{Authorization:'Bearer '+S.session.access_token},credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw Error(response.status===401?'Session expirée. Reconnectez-vous.':'Zones indisponibles. Réessayez.');
    const data=await response.json();if(!current()){cleanup();return;}
    if(!Array.isArray(data.zones)||!Array.isArray(data.agencies))throw Error('Liste des zones invalide. Réessayez.');
    const ids=new Set();zones=data.zones.filter(z=>z&&typeof z.id==='string'&&z.id&&!ids.has(z.id)&&typeof z.name==='string'&&['operating','parking','exclusion'].includes(z.kind)&&z.archived_at==null&&mapZoneShapeValid(z.shape)&&(ids.add(z.id),true));
    agencies=data.agencies.filter(a=>a&&a.id!=null&&typeof a.name==='string');loaded=true;lastRead=Date.now();loadError=false;paint();
   }catch(error){if(current()){loadError=true;setStatus(loaded?'Actualisation impossible. Les derniers contours sont conservés.':error.name==='TimeoutError'?'Les zones mettent trop de temps à répondre. Réessayez.':error.message||'Zones indisponibles. Réessayez.');if(!loaded){select.replaceChildren(new Option('Zones indisponibles',''));select.disabled=true;go.disabled=true;}}}
   finally{pending=null;controller=null;if(current())refreshButton.disabled=false;}
  })();return pending;
 }
 function changed(){if(!current()){cleanup();return;}syncScope();go.disabled=!permitted().some(z=>z.id===select.value);if(!select.value)removeOutline();}
 function focused(){if(loaded&&Date.now()-lastRead>60000)void refresh();}
 function navigate(event){
  event.preventDefault();if(!current()){cleanup();return;}syncScope();const zone=permitted().find(z=>z.id===select.value);if(!zone){go.disabled=true;return;}
  const layer=drawOutline(zone),bounds=layer.getBounds();if(!bounds.isValid())return;
  onNavigate(zone);map.stop();map.fitBounds(bounds,{paddingTopLeft:[40,110],paddingBottomRight:[30,45],maxZoom:16,animate:false});
  if(!loadError)setStatus(zone.name+(zone.enabled===false?' · détection désactivée':zone.indicative?' · contour indicatif':'')+'.');
 }
 // The form may sit over the Leaflet container, without stealing map gestures.
 if(L.DomEvent){L.DomEvent.disableClickPropagation(form);L.DomEvent.disableScrollPropagation(form);}
 form.addEventListener('submit',navigate);select.addEventListener('change',changed);select.addEventListener('focus',focused);refreshButton.addEventListener('click',refresh);map.on('unload',cleanup);
 void refresh();return {cleanup,syncScope,refresh};
}
