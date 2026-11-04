// Agency-only analysis of imported rides. Raw workbooks stay in this page until
// the user reviews the mapping; only selected operational columns are uploaded.
const DEMAND_UI={controllers:new Set(),timer:null,generation:0,watch:null,watchOwner:null,watchSeen:new Set(),watchDismissed:new Set(),watchNotices:new Map()};
const DEMAND_DAYS=['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];
function demandViewCleanup(){DEMAND_UI.generation++;for(const controller of DEMAND_UI.controllers)controller.abort();DEMAND_UI.controllers.clear();clearInterval(DEMAND_UI.timer);DEMAND_UI.timer=null;}
function demandClearRushNotices(){for(const node of DEMAND_UI.watchNotices.values())node.remove();DEMAND_UI.watchNotices.clear();document.getElementById('demand-rush-notices')?.remove();}
function demandStopRushWatch(){const loop=DEMAND_UI.watch;DEMAND_UI.watch=null;if(loop){clearInterval(loop.timer);loop.controller?.abort();document.removeEventListener('visibilitychange',loop.visibility);}demandClearRushNotices();}
function demandCleanup(){demandViewCleanup();demandStopRushWatch();if(DEMAND_UI.watchOwner!==S.session?.user?.id){DEMAND_UI.watchOwner=null;DEMAND_UI.watchSeen.clear();DEMAND_UI.watchDismissed.clear();}}
function demandEditable(){return typeof isAdmin==='function'&&isAdmin()||S.profile?.role==='manager';}
async function demandRequest(path,body){
  const token=S.session?.access_token;if(!token)throw new Error('Reconnectez-vous à Ludy.');
  const controller=new AbortController();DEMAND_UI.controllers.add(controller);const timeout=setTimeout(()=>controller.abort(),30000);
  try{
    const response=await fetch('/api/operations/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'same-origin',redirect:'error'});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Opération indisponible ('+response.status+').');return result;
  }finally{clearTimeout(timeout);DEMAND_UI.controllers.delete(controller);}
}
function demandWatchRush(my){
  demandStopRushWatch();const owner=S.session?.user?.id;if(!owner||!['admin','manager','viewer'].includes(S.profile?.role))return;
  if(DEMAND_UI.watchOwner!==owner){DEMAND_UI.watchOwner=owner;DEMAND_UI.watchSeen.clear();DEMAND_UI.watchDismissed.clear();}
  const loop={timer:null,controller:null,busy:false,visibility:null};DEMAND_UI.watch=loop;
  const current=()=>DEMAND_UI.watch===loop&&my===ROUTING&&owner===S.session?.user?.id;
  loop.read=async()=>{
    if(!current()||loop.busy||document.hidden)return;loop.busy=true;const controller=new AbortController();loop.controller=controller;const timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch('/api/operations/pauses',{headers:{Authorization:'Bearer '+S.session.access_token},signal:controller.signal,cache:'no-store',credentials:'same-origin',redirect:'error'});
      if(!current()||controller.signal.aborted)return;
      if(!response.ok){if(response.status===401||response.status===403){DEMAND_UI.watchSeen.clear();DEMAND_UI.watchDismissed.clear();}throw new Error('Lecture des pauses indisponible');}
      const snapshot=await response.json();if(!current()||document.hidden||controller.signal.aborted)return;
      if(!Array.isArray(snapshot.pauses))throw new Error('Instantané de pauses invalide');
      const active=new Map();for(const row of snapshot.pauses.slice(0,1000)){
        if(row?.rush!==true||row.cross_platform_activity===true||row.status!=='on_break'||!['uber','bolt'].includes(row.source)||typeof row.identity_id!=='string'||!row.identity_id||!Number.isFinite(Date.parse(row.observed_at)))continue;
        const key=row.source+':'+row.identity_id;active.set(key,row);
      }
      for(const key of DEMAND_UI.watchSeen)if(!active.has(key)){DEMAND_UI.watchSeen.delete(key);DEMAND_UI.watchDismissed.delete(key);}
      for(const [key,node]of DEMAND_UI.watchNotices)if(!active.has(key)){node.remove();DEMAND_UI.watchNotices.delete(key);}
      for(const [key,row]of active){
        if(DEMAND_UI.watchDismissed.has(key)||DEMAND_UI.watchNotices.has(key))continue;
        let box=document.getElementById('demand-rush-notices');if(!box){box=document.createElement('div');box.id='demand-rush-notices';box.setAttribute('aria-label','Pauses pendant les rushs');document.body.appendChild(box);}
        const known=DEMAND_UI.watchSeen.has(key);DEMAND_UI.watchSeen.add(key);const node=document.createElement('article');node.className='demand-rush-toast';node.setAttribute('role',known?'status':'alert');
        node.innerHTML=`<button class="demand-rush-dismiss" aria-label="Masquer ce signalement">×</button><strong>Pause pendant un rush</strong><b>${esc(String(row.driver_name||'Chauffeur').slice(0,160))}</b><p>Pause déclarée sur ${row.source==='bolt'?'Bolt':'Uber'} pendant un rush, à vérifier.</p><a href="#/pauses-rush">Voir les pauses et les créneaux →</a>`;
        node.querySelector('button').onclick=()=>{DEMAND_UI.watchDismissed.add(key);node.remove();DEMAND_UI.watchNotices.delete(key);demandRushDigest();};box.appendChild(node);DEMAND_UI.watchNotices.set(key,node);
      }
      demandRushDigest();
    }catch{if(current()&&!document.hidden)demandClearRushNotices();}finally{clearTimeout(timeout);if(loop.controller===controller)loop.controller=null;loop.busy=false;}
  };
  loop.visibility=()=>{if(document.hidden){loop.controller?.abort();demandClearRushNotices();}else void loop.read();};document.addEventListener('visibilitychange',loop.visibility);loop.timer=setInterval(loop.read,15000);void loop.read();
}
function demandRushDigest(){
  const box=document.getElementById('demand-rush-notices');if(!box)return;const nodes=[...DEMAND_UI.watchNotices.values()];nodes.forEach((node,index)=>node.hidden=index>=2);box.querySelector('.demand-rush-digest')?.remove();
  if(nodes.length>2){const link=document.createElement('a');link.className='demand-rush-digest';link.href='#/pauses-rush';link.textContent=(nodes.length-2)+' autres pauses à vérifier →';box.appendChild(link);}if(!nodes.length)box.remove();
}
function demandCityOptions(value='',all=false){return (all?'<option value="">Les deux villes</option>':'<option value="">Choisir la ville</option>')+['Casablanca','Marrakech'].map(city=>`<option ${city===value?'selected':''} value="${city}">${city}</option>`).join('');}
function demandAgencyOptions(agencies,all=false,value=''){return (all?'<option value="">Toutes mes agences</option>':'<option value="">Choisir l’agence</option>')+agencies.map(agency=>`<option value="${esc(String(agency.id))}" ${String(agency.id)===String(value)?'selected':''}>${esc(agency.name)}</option>`).join('');}
function demandHour(value){return String(value).padStart(2,'0')+' h';}
function demandNumber(value){return Number.isFinite(Number(value))?Number(value).toLocaleString('fr-FR'):'—';}
function demandHeader(title,subtitle){return `<div class="ops-heading"><div><span class="eyebrow">ACTIVITÉ & ORGANISATION</span><h1>${title}</h1><p>${subtitle}</p></div><div class="ops-heading-actions">${typeof isAdmin==='function'&&isAdmin()?'<a class="button-link" href="#/uber-rapports">Collecte automatique Uber</a>':''}<a class="button-link secondary" href="#/demande">Analyse Uber</a><a class="button-link secondary" href="#/pauses-rush">Pauses et rush</a></div></div>`;}
function demandWarnings(warnings=[]){return warnings.length?'<div class="demand-warnings" role="status">'+warnings.map(text=>'<p>'+esc(typeof text==='string'?text:text?.message||'')+'</p>').join('')+'</div>':'';}
function demandTable(headers,rows,empty){return `<div class="demand-table-scroll"><table class="demand-table"><thead><tr>${headers.map(title=>'<th>'+title+'</th>').join('')}</tr></thead><tbody>${rows.length?rows.map(cells=>'<tr>'+cells.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+headers.length+'">'+empty+'</td></tr>'}</tbody></table></div>`;}
function demandSummaryHtml(summary={}){
  const hours=Array.isArray(summary.by_hour)?summary.by_hour:[],peak=Math.max(1,...hours.map(row=>Number(row.count)||0)),coverage=summary.coverage||{};
  return `<div class="demand-stats"><div><span>Courses terminées</span><strong>${demandNumber(summary.completed||0)}</strong></div><div><span>Journées observées</span><strong>${demandNumber(coverage.observed_days||0)}</strong></div><div><span>Courses annulées</span><strong>${demandNumber(summary.cancelled||0)}</strong></div></div>
    ${coverage.city_review?.quarantined?`<section class="demand-panel demand-city-review" role="status"><h2>Ville à confirmer : ${demandNumber(coverage.city_review.quarantined)} courses à part</h2><p>${demandNumber(coverage.city_review.completed)} terminées et ${demandNumber(coverage.city_review.cancelled)} annulées restent conservées dans les imports. Elles ne participent ni aux chiffres ci-dessus ni aux horaires, zones et recommandations.</p><p>La validation porte sur le nom de la ville dans la source, pas sur une position GPS de prise en charge.</p></section>`:''}
    ${demandWarnings(summary.warnings)}<section class="demand-panel"><div class="demand-section-heading"><div><span class="eyebrow">HEURE DU MAROC</span><h2>Quand les courses ont lieu</h2></div><span>Historique importé</span></div><div class="demand-hours" role="img" aria-label="Courses terminées par heure, heure du Maroc">${hours.map(row=>`<div class="demand-hour" title="${demandHour(row.hour)} : ${Number(row.count)||0} courses sur ${Number(row.observed_days)||0} jours"><b>${Number(row.count)||0}</b><div><i style="height:${Math.round((Number(row.count)||0)/peak*100)}%"></i></div><span>${String(row.hour).padStart(2,'0')}</span></div>`).join('')}</div><p class="ops-footnote">Les heures sans course ne prouvent pas une absence de demande. La période disponible dépend du fichier importé.</p></section>
    <div class="demand-two-columns"><section class="demand-panel"><h2>Zones et horaires à considérer</h2><p>Créneaux retrouvés sur au moins 3 jours et 5 courses.</p>${demandTable(['Ville / zone','Heure','Courses','Jours'],(summary.recommendations||[]).map(row=>[esc(row.city)+'<br><b>'+esc(row.zone)+'</b>',demandHour(row.hour),demandNumber(row.count),demandNumber(row.observed_days)]),'Importer davantage de journées pour obtenir des recommandations étayées.')}</section>
    <section class="demand-panel"><h2>Créneaux possibles pour les pauses</h2><p>Heures moins actives dans les courses observées, à confronter aux rushs et au service.</p>${demandTable(['Ville','Heure','Courses','Jours'],(summary.pause_windows||[]).map(row=>[esc(row.city),demandHour(row.hour),demandNumber(row.count),demandNumber(row.observed_days)]),'Échantillon insuffisant pour comparer les créneaux de pause.')}<a href="#/pauses-rush">Configurer les créneaux de rush →</a></section></div>
    <div class="demand-two-columns"><section class="demand-panel"><h2>Zones de prise en charge</h2>${demandTable(['Ville / zone','Courses','Jours'],(summary.zones||[]).slice(0,30).map(row=>[esc(row.city)+' · '+esc(row.zone),demandNumber(row.count),demandNumber(row.observed_days)]),'Aucune zone importée.')}</section><section class="demand-panel"><h2>Répartition dans la semaine</h2>${demandTable(['Jour','Courses','Jours observés'],(summary.by_weekday||[]).map(row=>[DEMAND_DAYS[row.weekday-1]||'—',demandNumber(row.count),demandNumber(row.observed_days)]),'Aucune course importée.')}</section></div>`;
}
function demandGuessColumns(headers){
  const text=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
  const find=pattern=>headers.findIndex(header=>pattern.test(text(header)));
  return {external_id:find(/uuid|trip.?id|ride.?id|identifiant.*course|id.*course/),started_at:find(/pickup.*time|request.*time|start.*time|heure.*(debut|depart)|date.*course|horodatage/),pickup_zone:find(/pickup.*(zone|area|location|address)|zone.*(prise|depart)|lieu.*(prise|depart)|adresse.*depart/),status:find(/trip.*status|ride.*status|statut|etat.*course|^status$/)};
}
function demandMappedRows(grid,mapping){
  if(!Array.isArray(grid)||grid.length<2||grid.length>20001)throw new Error('Choisir une feuille contenant de 1 à 20 000 courses.');
  const keys=['external_id','started_at','pickup_zone','status'],indexes=keys.map(key=>mapping[key]).filter(index=>index>=0);
  if(new Set(indexes).size!==indexes.length)throw new Error('Chaque colonne doit correspondre à un seul champ.');
  if(!Number.isInteger(mapping.started_at)||mapping.started_at<0||!Number.isInteger(mapping.pickup_zone)||mapping.pickup_zone<0)throw new Error('Associer la date/heure et la zone de prise en charge.');
  return grid.slice(1).filter(row=>row.some(value=>value!==null&&value!==undefined&&String(value).trim()!=='')).map(row=>Object.fromEntries(keys.filter(key=>mapping[key]>=0).map(key=>[key,row[mapping[key]]??''])));
}
function demandImportHtml(agencies){return `<details class="demand-panel demand-import" id="demand-import"><summary><span>Importer le rapport d’activité Uber</span><small>CSV ou Excel · aperçu avant enregistrement</small></summary><p>Dans Uber Fleet, exporter « activité liée aux courses ». Les colonnes et les dates sont vérifiées avant l’enregistrement. Les imports financiers de la caisse restent séparés.</p><form id="demand-import-form"><div class="demand-form-grid"><label>Agence<select id="demand-import-agency" required>${demandAgencyOptions(agencies)}</select></label><label>Ville<select id="demand-import-city" required>${demandCityOptions()}</select></label><label>Rapport<input id="demand-file" type="file" accept=".csv,.xlsx,.xls" required></label></div><div id="demand-mapping"></div><div id="demand-import-result" role="status"></div><button type="submit" id="demand-import-submit" disabled>Vérifier et importer</button></form></details>`;}
async function pageDemand(){
  demandViewCleanup();const generation=DEMAND_UI.generation,my=ROUTING,owner=S.session?.user?.id,current=()=>my===ROUTING&&generation===DEMAND_UI.generation&&owner===S.session?.user?.id;let agencies=S.agencies||[],workbook=null,grid=null,dateSystem='1900',loading=false,reload=false;
  $('#page').innerHTML=`<div class="ops-page demand-page">${demandHeader('Comprendre l’activité Uber','Des zones et des créneaux fondés sur vos courses, avec la couverture du rapport toujours visible.')}<p class="demand-auto-intro">Les rapports récupérés par l’extension Uber alimentent automatiquement cette analyse après activation de la collecte. L’import de fichier ci-dessous reste disponible en complément.</p><div class="demand-toolbar"><label>Agence<select id="demand-agency">${demandAgencyOptions(agencies,true)}</select></label><label>Ville<select id="demand-city">${demandCityOptions('',true)}</select></label><button class="ghost" id="demand-refresh">Actualiser</button></div><div id="demand-status" role="status"></div><div id="demand-import-area">${demandEditable()?demandImportHtml(agencies):''}</div><div id="demand-summary"></div><div id="demand-reference"></div><section class="demand-panel"><h2>Rapports importés</h2><div id="demand-import-history"></div></section></div>`;
  const read=async()=>{if(!current())return;if(loading){reload=true;return;}loading=true;$('#demand-refresh').disabled=true;try{
    const params=new URLSearchParams();if($('#demand-agency').value)params.set('agency_id',$('#demand-agency').value);if($('#demand-city').value)params.set('city',$('#demand-city').value);
    const scope=[$('#demand-agency').value,$('#demand-city').value].join('|');
    $('#demand-reference').replaceChildren();
    const result=await demandRequest('demand'+(params.size?'?'+params:''));if(!current())return;if(scope!==[$('#demand-agency').value,$('#demand-city').value].join('|')){reload=true;return;}
    if(Array.isArray(result.agencies))agencies=result.agencies;$('#demand-summary').innerHTML=demandSummaryHtml(result.summary||{});$('#demand-status').textContent='';
    if(result.pickup_reference){const {renderPickupReference}=await import('./pickup-reference.js');if(!current())return;if(scope!==[$('#demand-agency').value,$('#demand-city').value].join('|')){reload=true;return;}$('#demand-reference').innerHTML=renderPickupReference(result.pickup_reference);}
    $('#demand-import-history').innerHTML=demandTable(['Rapport','Ville','Courses','Importé le'],(result.imports||[]).slice(0,30).map(row=>[esc(row.file_name||'Rapport'),esc(row.city||''),demandNumber(row.counts?.imported??row.row_count??0),esc(row.created_at?fmtDT(row.created_at):'—')]),'Aucun rapport importé pour ce périmètre.');
  }catch(error){if(current())$('#demand-status').textContent='Lecture interrompue : '+error.message;}finally{loading=false;if(current()){$('#demand-refresh').disabled=false;if(reload){reload=false;void read();}}}};
  $('#demand-refresh').onclick=read;$('#demand-agency').onchange=read;$('#demand-city').onchange=read;
  if(demandEditable()){
    const form=$('#demand-import-form'),result=$('#demand-import-result'),mappingNode=$('#demand-mapping'),submit=$('#demand-import-submit');let selectedFile=null,fileGeneration=0,fileController=null;
    const mapping=()=>Object.fromEntries(['external_id','started_at','pickup_zone','status'].map(key=>[key,Number(document.getElementById('demand-col-'+key)?.value??-1)]));
    const preview=()=>{try{const rows=demandMappedRows(grid,mapping());$('#demand-preview').innerHTML=demandTable(['Identifiant','Date / heure brute','Zone','État'],rows.slice(0,5).map(row=>[esc(row.external_id||'Calculé à partir des colonnes'),esc(String(row.started_at??'')),esc(String(row.pickup_zone??'')),esc(String(row.status||($('#demand-all-completed').checked?'Terminée (confirmation)':'À préciser')))]),'Aucune ligne.');$('#demand-preview-count').textContent=rows.length+' ligne(s) à vérifier. Les dates seront converties à l’heure du Maroc par le serveur.';submit.disabled=!rows.length||mapping().status<0&&!$('#demand-all-completed').checked;result.textContent='';}catch(error){submit.disabled=true;result.textContent=error.message;}};
    const sheet=()=>{
      const name=$('#demand-sheet')?.value||workbook.SheetNames[0];grid=spreadsheetRows(workbook,name);while(grid.length&&grid.at(-1).every(cell=>String(cell).trim()===''))grid.pop();
      if(grid.length<2||grid.length>20001||!grid[0]?.length||grid[0].length>200)throw new Error('Feuille vide ou trop volumineuse : maximum 20 000 lignes et 200 colonnes.');
      const headers=grid[0].map((value,index)=>String(value||'Colonne '+(index+1))),guesses=demandGuessColumns(headers),labels={external_id:'Identifiant unique de course (recommandé)',started_at:'Date et heure de prise en charge',pickup_zone:'Zone ou lieu de prise en charge',status:'État de la course'};
      mappingNode.innerHTML=`<div class="demand-mapping"><label>Feuille<select id="demand-sheet">${workbook.SheetNames.map(value=>`<option value="${esc(value)}" ${value===name?'selected':''}>${esc(value)}</option>`).join('')}</select></label><div class="demand-form-grid">${Object.entries(labels).map(([key,label])=>`<label>${label}<select id="demand-col-${key}"><option value="-1">Non renseigné</option>${headers.map((header,index)=>`<option value="${index}" ${guesses[key]===index?'selected':''}>${esc(header)}</option>`).join('')}</select></label>`).join('')}<label>Format des dates texte<select id="demand-date-format"><option value="ymd">Année-mois-jour (2026-11-02)</option><option value="dmy">Jour/mois/année (02/11/2026)</option><option value="mdy">Mois/jour/année (11/02/2026)</option></select></label></div><label class="demand-checkbox"><input id="demand-all-completed" type="checkbox"> Sans colonne d’état, je confirme que ce rapport contient uniquement des courses terminées.</label><p class="ops-footnote">Les dates avec décalage UTC sont conservées. Les cellules Excel sont interprétées en heure du Maroc. Une date sans heure ou une heure ambiguë sera refusée. Sans identifiant, deux courses de même heure et zone peuvent être fusionnées : privilégier l’identifiant Uber.</p><p id="demand-preview-count"></p><div id="demand-preview"></div></div>`;
      $('#demand-sheet').onchange=()=>{try{sheet();}catch(error){result.textContent=error.message;submit.disabled=true;}};mappingNode.querySelectorAll('select:not(#demand-sheet),input').forEach(node=>node.onchange=preview);preview();
    };
    $('#demand-file').onchange=async()=>{
      fileController?.abort();selectedFile=$('#demand-file').files[0];const file=selectedFile,reading=++fileGeneration;workbook=null;grid=null;submit.disabled=true;mappingNode.innerHTML='';result.textContent='';if(!file)return;
      try{if(file.size>8*1024*1024)throw new Error('Le fichier doit faire moins de 8 Mo.');if(!/\.(csv|xlsx|xls)$/i.test(file.name))throw new Error('Choisir un fichier CSV ou Excel.');
        const controller=fileController=new AbortController();DEMAND_UI.controllers.add(controller);try{workbook=await readSpreadsheet(file,file.name,{mode:'raw',maxRows:20001,maxBytes:8*1024*1024,signal:controller.signal});}finally{DEMAND_UI.controllers.delete(controller);}if(!current()||reading!==fileGeneration)return;if(!workbook.SheetNames.length)throw new Error('Aucune feuille trouvée.');dateSystem=workbook.date1904?'1904':'1900';sheet();
      }catch(error){if(current()&&reading===fileGeneration)result.textContent='Lecture du fichier impossible : '+error.message;}
    };
    form.onsubmit=async event=>{event.preventDefault();if(submit.disabled||!current())return;try{
      const rows=demandMappedRows(grid,mapping()),body={agency_id:Number($('#demand-import-agency').value),city:$('#demand-import-city').value,file_name:selectedFile.name,rows,date_format:$('#demand-date-format').value,date_system:dateSystem};
      if(mapping().status<0){if(!$('#demand-all-completed').checked)throw new Error('Associer la colonne d’état ou confirmer le contenu du rapport.');body.default_status='completed';}
      submit.disabled=true;result.textContent='Validation et enregistrement…';const saved=await demandRequest('demand/import',body);if(!current())return;
      result.textContent=saved.duplicate?'Ce rapport était déjà importé.':`Rapport enregistré : ${saved.counts?.imported??rows.length} ligne(s) validée(s). Les courses déjà connues restent dédupliquées.`;
      await read();
    }catch(error){if(current())result.textContent=error.message;}finally{if(current())submit.disabled=false;}};
  }
  await read();
}

function demandPauseHtml(snapshot={}){
  return `${demandWarnings(snapshot.warnings)}${demandTable(['Chauffeur','Agence / ville','Observation','Situation'],(snapshot.pauses||[]).map(row=>[esc(row.driver_name),esc(row.agency_name||'Agence')+'<br>'+esc(row.city||'Ville à renseigner'),esc(row.source==='bolt'?'Bolt':'Uber')+'<br>'+esc(row.observed_at?fmtDT(row.observed_at):'—'),'<span class="demand-pause-label '+(row.rush&&!row.cross_platform_activity?'rush':'')+'">'+(row.rush?'Pause pendant un rush':'Pause plateforme')+'</span><small>'+esc(row.message||'')+'</small>']),'Aucune pause plateforme confirmée par une observation récente.')}<p class="ops-footnote">La lecture porte sur le cache local. Un véhicule arrêté ne signifie pas que son chauffeur est en pause. Aucune sanction ni interdiction automatique n’est appliquée.</p>`;
}
async function pageRush(){
  demandViewCleanup();const generation=DEMAND_UI.generation,my=ROUTING,owner=S.session?.user?.id,current=()=>my===ROUTING&&generation===DEMAND_UI.generation&&owner===S.session?.user?.id;let agencies=S.agencies||[],rules=[],busy=false;
  $('#page').innerHTML=`<div class="ops-page demand-page">${demandHeader('Pauses et créneaux de rush','Repérer les pauses déclarées sur les plateformes et organiser les périodes de forte activité.')}<div id="rush-status" role="status"></div><section class="demand-panel"><div class="demand-section-heading"><h2>Pauses observées</h2><button class="ghost" id="rush-refresh">Actualiser</button></div><div id="rush-pauses">Lecture en cours…</div></section><section class="demand-panel"><h2>Créneaux de rush</h2><p>Heure du Maroc. Les créneaux traversant minuit se rattachent au jour de début.</p><div id="rush-rules"></div>${demandEditable()?`<details class="demand-rule-form"><summary>Ajouter un créneau</summary><form id="rush-form"><div class="demand-form-grid"><label>Agence<select id="rush-agency" required>${demandAgencyOptions(agencies)}</select></label><label>Ville<select id="rush-city" required>${demandCityOptions()}</select></label><label>Nom du créneau<input id="rush-label" maxlength="100" placeholder="Ex. Départs du soir"></label><label>Début<input id="rush-start" type="time" required></label><label>Fin<input id="rush-end" type="time" required></label></div><fieldset class="demand-days"><legend>Jours</legend>${DEMAND_DAYS.map((day,index)=>`<label><input type="checkbox" name="rush-day" value="${index+1}">${day}</label>`).join('')}</fieldset><button type="submit">Enregistrer le créneau</button><div id="rush-form-result" role="status"></div></form></details>`:''}</section></div>`;
  const paintRules=()=>{
    $('#rush-rules').innerHTML=demandTable(['Agence / ville','Créneau','Jours','État',...(demandEditable()?['Action']:[])],rules.map(rule=>[esc(agencies.find(a=>String(a.id)===String(rule.agency_id))?.name||'Agence')+'<br>'+esc(rule.city),'<b>'+esc(rule.label||'Rush')+'</b><br>'+esc(rule.start)+' – '+esc(rule.end),(rule.days||[]).map(day=>DEMAND_DAYS[day-1]?.slice(0,3)||'?').join(', '),rule.enabled?'Actif':'En pause',...(demandEditable()?[`<button class="ghost small" data-rush-toggle="${esc(String(rule.id))}">${rule.enabled?'Mettre en pause':'Activer'}</button>`]:[])]),'Aucun créneau défini.');
    $('#rush-rules').querySelectorAll('[data-rush-toggle]').forEach(button=>button.onclick=async()=>{const rule=rules.find(r=>String(r.id)===button.dataset.rushToggle);if(!rule)return;button.disabled=true;try{await demandRequest('rush',{id:rule.id,enabled:!rule.enabled});if(current())await read();}catch(error){if(current())$('#rush-status').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}});
  };
  const read=async()=>{if(busy||!current()||document.hidden)return;busy=true;try{const [settings,snapshot]=await Promise.all([demandRequest('rush'),demandRequest('pauses')]);if(!current())return;rules=settings.rules||[];if(Array.isArray(settings.agencies))agencies=settings.agencies;paintRules();$('#rush-pauses').innerHTML=demandPauseHtml(snapshot);$('#rush-status').textContent='';}catch(error){if(current()){$('#rush-status').textContent='Observation interrompue : '+error.message;$('#rush-pauses').innerHTML='<p>Pauses actuelles non confirmées. Actualisez lorsque la connexion est rétablie.</p>';}}finally{busy=false;}};
  $('#rush-refresh').onclick=read;
  if(demandEditable())$('#rush-form').onsubmit=async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button[type="submit"]'),status=$('#rush-form-result');button.disabled=true;try{
    const days=[...document.querySelectorAll('input[name="rush-day"]:checked')].map(input=>Number(input.value));if(!days.length)throw new Error('Choisir au moins un jour.');
    await demandRequest('rush',{agency_id:Number($('#rush-agency').value),city:$('#rush-city').value,label:$('#rush-label').value,days,start:$('#rush-start').value,end:$('#rush-end').value,enabled:true});if(current()){status.textContent='Créneau enregistré.';await read();}
  }catch(error){if(current())status.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}};
  await read();if(current())DEMAND_UI.timer=setInterval(()=>{if(!current()){demandViewCleanup();return;}void read();},15000);
}
