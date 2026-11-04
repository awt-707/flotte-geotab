// Read-only financial dashboard. The authenticated data adapter owns source selection;
// the shared metrics module owns calendar boundaries and money aggregation.
// Every asynchronous render belongs to one route, session and request revision.
const REVENUE_PAGE={revision:0,controller:null,timer:null,refreshTimer:null,visibility:null,channel:null,loader:null,providerConfig:null};
function revenueCleanup(){
 REVENUE_PAGE.revision++;REVENUE_PAGE.controller?.abort();REVENUE_PAGE.controller=null;
 clearInterval(REVENUE_PAGE.timer);clearTimeout(REVENUE_PAGE.refreshTimer);REVENUE_PAGE.timer=null;REVENUE_PAGE.refreshTimer=null;
 if(REVENUE_PAGE.visibility)document.removeEventListener('visibilitychange',REVENUE_PAGE.visibility);REVENUE_PAGE.visibility=null;
 if(REVENUE_PAGE.channel&&typeof sb?.removeChannel==='function')Promise.resolve(sb.removeChannel(REVENUE_PAGE.channel)).catch(()=>{});REVENUE_PAGE.channel=null;
 REVENUE_PAGE.loader?.dispose?.();REVENUE_PAGE.loader=null;
 REVENUE_PAGE.providerConfig?.dispose?.();REVENUE_PAGE.providerConfig=null;
}
const revenueEsc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const REVENUE_SOURCES={uber:'Uber',bolt:'Bolt',private:'Courses privées'};
const revenueFinite=value=>typeof value==='number'&&Number.isFinite(value);
function revenueCurrencyLabel(group){const key=typeof group==='string'?group:group?.currency;return key==='MAD_LEGACY'?'MAD · convention des anciens imports':key==='UNKNOWN'?'Devise non renseignée':key||'Devise non renseignée';}
function revenueMoney(minor,group){
 if(!Number.isSafeInteger(minor))return '—';
 const currency=group?.currencyCode||(/^[A-Z]{3}$/.test(group?.currency||'')?group.currency:null);
 return currency?new Intl.NumberFormat('fr-FR',{style:'currency',currency,currencyDisplay:'code',minimumFractionDigits:2,maximumFractionDigits:2}).format(minor/100):new Intl.NumberFormat('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(minor/100)+' · devise inconnue';
}
function revenueMetric(group,field){const value=group?.[field];return value&&(value.minor===null||Number.isSafeInteger(value.minor))?value:{minor:null,known:0,missing:0,complete:false};}
function revenueGroup(summary,key){return (summary?.currencies||[]).find(group=>group.currency===key)||null;}
function revenueDate(value,withTime=true){
 if(!value||!Number.isFinite(Date.parse(value)))return 'Non renseignée';
 if(typeof parts==='function'){const p=parts(value);return p.day+'/'+p.month+'/'+p.year+(withTime?' à '+p.hour+':'+p.minute:'');}
 return new Date(value).toISOString().replace('T',' ').slice(0,withTime?16:10)+' UTC';
}
function revenueDayLabel(value){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));return m?m[3]+'/'+m[2]:String(value||'');}
function revenueCSVCell(value){let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
function revenueMetricNote(metric){return !metric.known?'Non fourni par les données reçues':metric.missing?metric.known+' montant(s) connu(s) · '+metric.missing+' non renseigné(s)':metric.known+' montant(s) renseigné(s)';}
function revenueComparison(data,key,field,group){
 const currency=(data.comparison?.currencies||[]).find(row=>row.currency===key),value=currency?.[field];
 if(data.current?.providerOpenWeek===true||data.comparison?.available===false||data.coverage?.queryComplete===false||!value||value.comparable!==true||currency?.comparable===false||data.comparison?.comparable===false||!Number.isSafeInteger(value.deltaMinor))return '<span class="revenue-delta unavailable">Comparaison non établie</span>';
 const percent=revenueFinite(value.percent)?' · '+(value.percent>0?'+':'')+value.percent.toLocaleString('fr-FR',{maximumFractionDigits:1})+' %':value.baselineZero?' · référence à zéro':'';
 return '<span class="revenue-delta '+(value.deltaMinor>0?'up':value.deltaMinor<0?'down':'same')+'">'+(value.deltaMinor>0?'+':'')+revenueEsc(revenueMoney(value.deltaMinor,group))+revenueEsc(percent)+'</span>';
}
function revenueChart(rows,key){
 const points=rows.filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.day||'')).map(row=>({day:row.day,dayIndex:Date.parse(row.day+'T00:00:00Z')/86400000,group:revenueGroup(row,key)})).sort((a,b)=>a.dayIndex-b.dayIndex).map(row=>({...row,value:revenueMetric(row.group,'revenue').minor}));
 const known=points.filter(point=>Number.isSafeInteger(point.value));
 if(!known.length)return '<div class="revenue-empty">Aucun montant journalier renseigné pour cette sélection.</div>';
 const width=800,height=240,left=76,right=18,top=20,bottom=37,min=Math.min(0,...known.map(p=>p.value)),max=Math.max(0,...known.map(p=>p.value));
 const range=max-min||100,x=i=>left+(points[i].dayIndex-points[0].dayIndex)*(width-left-right)/Math.max(points.at(-1).dayIndex-points[0].dayIndex,1),y=value=>top+(max-value)/range*(height-top-bottom);
 let path='',open=false;points.forEach((point,index)=>{if(!Number.isSafeInteger(point.value)){open=false;return;}if(index&&point.dayIndex-points[index-1].dayIndex>1)open=false;path+=(open?' L ':' M ')+x(index).toFixed(2)+' '+y(point.value).toFixed(2);open=true;});
 const ticks=[max,min+(max-min)/2,min].filter((value,index,list)=>index===0||value!==list[index-1]);
 const labelIndices=[...new Set([0,Math.floor((points.length-1)/2),points.length-1])];
 return '<div class="revenue-chart-scroll"><svg class="revenue-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Revenus déclarés par date. Les journées sans montant ne sont pas estimées.">'+
 ticks.map(value=>'<line x1="'+left+'" y1="'+y(value)+'" x2="'+(width-right)+'" y2="'+y(value)+'" class="revenue-gridline"/><text x="'+(left-10)+'" y="'+(y(value)+4)+'" text-anchor="end">'+revenueEsc((value/100).toLocaleString('fr-FR',{maximumFractionDigits:0}))+'</text>').join('')+
 '<path d="'+path+'" class="revenue-line"/>'+points.map((point,index)=>Number.isSafeInteger(point.value)?'<circle cx="'+x(index)+'" cy="'+y(point.value)+'" r="4" class="revenue-point"><title>'+revenueEsc(revenueDayLabel(point.day)+' : '+revenueMoney(point.value,point.group))+'</title></circle>':'').join('')+
 labelIndices.map(index=>'<text x="'+x(index)+'" y="'+(height-10)+'" text-anchor="'+(index===0?'start':index===points.length-1?'end':'middle')+'">'+revenueEsc(revenueDayLabel(points[index].day))+'</text>').join('')+'</svg></div>';
}

async function pageRevenueDashboard(){
 revenueCleanup();const generation=REVENUE_PAGE.revision,my=ROUTING,owner=S.session?.user?.id,sessionRevision=S.sessionRevision||0,host=document.querySelector('#page');
 const current=()=>{
  if(generation!==REVENUE_PAGE.revision||my!==ROUTING||document.querySelector('#page')!==host)return false;
  if(!owner||owner!==S.session?.user?.id||sessionRevision!==(S.sessionRevision||0)||!canEdit()||typeof canSee==='function'&&!canSee('chiffre-affaires')){revenueCleanup();if(host?.querySelector('.revenue-page'))host.innerHTML='<section class="revenue-panel"><h1>Chiffre d’affaires</h1><p>Votre accès à cette vue a changé. Les données financières ont été masquées.</p></section>';return false;}
  return true;
 };
 if(!host)return;
 if(!owner||!canEdit()||typeof canSee==='function'&&!canSee('chiffre-affaires')){host.innerHTML='<section class="revenue-panel"><h1>Chiffre d’affaires</h1><p>Cette vue est réservée aux administrateurs et gestionnaires autorisés.</p></section>';return;}
 host.innerHTML='<div class="revenue-page"><div class="revenue-loading">Préparation du tableau de chiffre d’affaires…</div></div>';
 let metrics,loader,providerUI;
 try{const modules=await Promise.all([import('./revenue-metrics.js'),import('./revenue-data.js'),import('./provider-earnings-ui.js')]);if(!current())return;metrics=modules[0];providerUI=modules[2];const providerConfig=providerUI.createProviderConfigReader({supabase:sb});REVENUE_PAGE.providerConfig=providerConfig;loader=modules[1].createRevenueDataLoader({supabase:sb,providerConfig});REVENUE_PAGE.loader=loader;}
 catch{if(current())host.innerHTML='<section class="revenue-panel"><h1>Chiffre d’affaires</h1><p>Le module financier est indisponible. Rechargez la page pour réessayer.</p></section>';return;}
 const query=new URLSearchParams(location.hash.split('?')[1]||''),today=metrics.revenueDay(Date.now()),allowedPresets=['day','week','month','custom'];
 let preset=allowedPresets.includes(query.get('period'))?query.get('period'):'week',rolling=!query.has('anchor')&&!query.has('from')&&!query.has('to'),anchor=/^\d{4}-\d{2}-\d{2}$/.test(query.get('anchor')||'')?query.get('anchor'):today;
 let period=null,result=null,requestRevision=0,busy=false,currencyKey='',lastKey='',lastRefresh=null;
 const initialSource=Object.hasOwn(REVENUE_SOURCES,query.get('source'))?query.get('source'):'all';
 host.innerHTML=`<div class="revenue-page"><header class="revenue-heading"><div><p class="revenue-eyebrow">FINANCES · VUE CONSOLIDÉE</p><h1>Chiffre d’affaires</h1><p>Uber, Bolt et courses privées, avec les montants réellement renseignés.</p></div><a class="revenue-link" href="#/caisse">Ouvrir la caisse <span aria-hidden="true">↗</span></a></header>
 <section class="revenue-toolbar" aria-label="Filtres du chiffre d’affaires"><div class="revenue-presets" role="group" aria-label="Période"><button type="button" data-revenue-preset="day">Jour</button><button type="button" data-revenue-preset="week">Semaine Uber</button><button type="button" data-revenue-preset="month">Mois</button><button type="button" data-revenue-preset="custom">Dates libres</button></div>
 <form id="revenue-filters" class="revenue-filters"><div id="revenue-anchor-wrap" class="revenue-anchor"><button type="button" id="revenue-previous" aria-label="Période précédente">‹</button><label><span id="revenue-anchor-label">Choisir une semaine</span><input type="date" id="revenue-anchor" required value="${revenueEsc(anchor)}" max="${today}"></label><button type="button" id="revenue-next" aria-label="Période suivante">›</button></div>
 <div id="revenue-custom" class="revenue-custom" hidden><label>Du<input type="date" id="revenue-from" value="${revenueEsc(query.get('from')||today)}" max="${today}"></label><label>Au, inclus<input type="date" id="revenue-to" value="${revenueEsc(query.get('to')||today)}" max="${today}"></label></div>
 <label>Source<select id="revenue-source"><option value="all">Toutes les sources</option>${Object.entries(REVENUE_SOURCES).map(([id,name])=>'<option value="'+id+'" '+(id===initialSource?'selected':'')+'>'+name+'</option>').join('')}</select></label>
 <label>Agence<select id="revenue-agency"><option value="">Toutes mes agences</option></select></label><label>Chauffeur<select id="revenue-driver"><option value="">Tous les chauffeurs</option></select></label><button type="submit" id="revenue-refresh">Actualiser</button></form>
 <div class="revenue-period-info"><span id="revenue-period-label"></span><span>Heure du Maroc · bornes de semaine à 04 h le lundi</span></div></section>
 <div id="revenue-error" class="revenue-warning" role="alert" hidden></div><div class="revenue-read-state"><span id="revenue-read-status" role="status">Lecture des données…</span><span>Actualisation toutes les 30 s · aucune estimation entre deux lectures</span></div>
 <div id="revenue-results" aria-busy="true"><div class="revenue-loading">Lecture des montants enregistrés…</div></div></div>`;
 const node=id=>host.querySelector('#'+id),showError=text=>{node('revenue-error').textContent=text||'';node('revenue-error').hidden=!text;};
 function chooseOptions(id,rows,blank,valueKey='id'){
  const element=node(id),selected=element.value;const options=rows.filter(row=>row&&row[valueKey]!=null).map(row=>({value:String(row[valueKey]),label:String(row.name??row.label??row[valueKey])}));
  if(selected&&!options.some(option=>option.value===selected))options.push({value:selected,label:selected+' · filtre sélectionné'});
  element.innerHTML='<option value="">'+blank+'</option>'+options.map(option=>'<option value="'+revenueEsc(option.value)+'">'+revenueEsc(option.label)+'</option>').join('');element.value=selected;
 }
 chooseOptions('revenue-agency',S.agencies||[],'Toutes mes agences');
 function initialFilter(id,value){if(value&&!Array.from(node(id).options).some(option=>option.value===String(value)))node(id).add(new Option(String(value)+' · filtre sélectionné',String(value)));node(id).value=value||'';}
 initialFilter('revenue-agency',query.get('agency')||(typeof agFilter==='function'?agFilter():''));initialFilter('revenue-driver',query.get('driver'));
 function updatePeriod(){
  period=preset==='custom'?metrics.getCustomRevenuePeriod({fromDay:node('revenue-from').value,toDay:node('revenue-to').value,timeZone:'Africa/Casablanca'}):metrics.getRevenuePeriod({kind:preset,at:rolling?Date.now():node('revenue-anchor').value+'T12:00:00Z',timeZone:'Africa/Casablanca',weekStartHour:4});
  if(Date.parse(period.end)-Date.parse(period.start)>366*86400000+3600000)throw Error('Choisissez une période de 366 jours maximum.');
  node('revenue-anchor-wrap').hidden=preset==='custom';node('revenue-custom').hidden=preset!=='custom';node('revenue-anchor').required=preset!=='custom';
  node('revenue-from').required=node('revenue-to').required=preset==='custom';node('revenue-anchor-label').textContent=preset==='week'?'Choisir une semaine':preset==='month'?'Choisir un mois':'Choisir un jour';
  node('revenue-period-label').textContent=revenueDate(period.start)+' → '+revenueDate(period.end)+' (fin exclue)';node('revenue-next').disabled=Date.parse(period.end)>Date.now();
  host.querySelectorAll('[data-revenue-preset]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.revenuePreset===preset)));
  return period;
 }
 function selection(){return {period:updatePeriod(),source:node('revenue-source').value,agencyId:node('revenue-agency').value||null,driverCode:node('revenue-driver').value||null};}
 function sourceStatus(source){return (result?.sourceStatus||[]).find(row=>(row.source||row.id)===source)||{};}
 function sourceLast(status){return status.lastRecordAt||status.lastRecordDay||null;}
 function sourceFreshness(status){if(status.lastProviderObservedAt)return '<small>Dernière lecture chez Uber : '+revenueEsc(revenueDate(status.lastProviderObservedAt))+'</small><small>'+Number(status.providerPeriods||0)+' relevé(s) de période ; aucun détail horaire inventé</small>';const day=status.lastRecordDay,at=status.lastRecordAt,dated=at?revenueDate(at):day?day.split('-').reverse().join('/')+' · heure non renseignée':'Non renseignée';return '<small>Dernière donnée dans les périodes lues : '+revenueEsc(dated)+'</small><small>'+(status.source==='private'?'Dernière modification connue : '+revenueEsc(revenueDate(status.lastUpdatedAt)):'Dernier import connu : '+revenueEsc(revenueDate(status.lastImportedAt)))+'</small>';}
 function paint(){
  if(!current()||!result)return;
  const currencies=[...(result.current?.currencies||[]),...(result.current?.uncertainDay?.currencies||[])],previousCurrencies=[...(result.previous?.currencies||[]),...(result.previous?.uncertainDay?.currencies||[])],keys=[...new Set([...currencies,...previousCurrencies].map(group=>group.currency))];
  if(!keys.includes(currencyKey))currencyKey=keys.includes('MAD')?'MAD':keys[0]||'UNKNOWN';
  const group=revenueGroup(result.current,currencyKey),recorded=revenueMetric(group,'revenue'),gross=revenueMetric(group,'gross'),net=revenueMetric(group,'net'),payout=revenueMetric(group,'reportedPayout');
  const sourceRows=result.current?.bySource||[],sourceIds=node('revenue-source').value==='all'?Object.keys(REVENUE_SOURCES):[node('revenue-source').value];
  const coverage=result.coverage||result.current?.coverage||{},notes=[...(Array.isArray(coverage.notes)?coverage.notes:[]),...(Array.isArray(result.current?.coverage?.notes)?result.current.coverage.notes:[])].filter(note=>typeof note==='string');
  const metric=(title,value,field,primary=false)=>'<article class="revenue-metric '+(primary?'revenue-primary':'')+'"><span>'+title+'</span><strong data-revenue-value="'+field+'">'+revenueEsc(revenueMoney(value.minor,group))+'</strong><small>'+revenueEsc(revenueMetricNote(value))+'</small>'+revenueComparison(result,currencyKey,field,group)+'</article>';
  const statusText=status=>status.status==='error'?'Lecture indisponible':status.status==='unmapped'?'Chauffeur non rapproché':status.status==='no_data'?'Aucune donnée reçue':status.status==='missing'||status.status==='unavailable'?'Données manquantes':status.status==='complete'?'Données reçues':'Couverture partielle';
  const drivers=(result.current?.byDriver||[]).map(row=>({...row,group:revenueGroup(row,currencyKey)})).filter(row=>row.group).sort((a,b)=>(revenueMetric(b.group,'revenue').minor??-Infinity)-(revenueMetric(a.group,'revenue').minor??-Infinity));
  const daily=result.current?.byDay||[],uncertain=result.current?.uncertainDay;
  const sourceErrors=(result.sourceStatus||[]).filter(row=>row.status==='error').map(row=>REVENUE_SOURCES[row.source]||row.source);
  const details=[['fare','Tarifs de course renseignés'],['tips','Pourboires'],['tolls','Péages'],['bonus','Primes'],['commission','Commissions'],['cash','Espèces déclarées']];
  const basis=result.provider?.current?.basis,openWeek=result.current?.providerOpenWeek===true&&basis?.kind==='open_week';
  const cutoff=result.comparisonWindow;const comparedWindow=!openWeek&&cutoff?'Montants arrêtés au '+revenueDate(cutoff.end)+' · comparaison du '+revenueDate(cutoff.previousStart)+' au '+revenueDate(cutoff.previousEnd)+' (fin exclue).':'';
  node('revenue-results').innerHTML=`${coverage.queryComplete===false?'<div class="revenue-warning revenue-source-warning" role="status"><strong>Lecture incomplète'+(sourceErrors.length?' : '+revenueEsc(sourceErrors.join(', ')):'')+'</strong><p>Les montants affichés sont partiels. Une source indisponible ne vaut pas zéro ; les comparaisons restent indisponibles.</p></div>':''}<div class="revenue-summary-head"><div><span class="revenue-coverage">${coverage.complete===true?'Périmètre renseigné':'Montants reçus · couverture partielle ou non confirmée'}</span><p>La lecture automatique actualise les chiffres enregistrés. Les imports financiers ne sont pas un flux de gains en direct.</p></div><label>Devise<select id="revenue-currency">${keys.length?keys.map(key=>'<option value="'+revenueEsc(key)+'" '+(key===currencyKey?'selected':'')+'>'+revenueEsc(revenueCurrencyLabel(key))+'</option>').join(''):'<option value="UNKNOWN">Devise non renseignée</option>'}</select></label></div>
   ${openWeek?'<div class="revenue-notice revenue-open-week"><strong>Semaine en cours · relevé Uber observé le '+revenueEsc(revenueDate(basis.observedAt))+'</strong><p>La source Uber couvre la semaine du '+revenueEsc(revenueDate(basis.periodStart))+' au '+revenueEsc(revenueDate(basis.periodEnd))+' (fin exclue). Les écritures individuelles restent arrêtées au '+revenueEsc(revenueDate(cutoff?.end))+'. Les relevés hebdomadaires ne sont pas répartis sur la courbe quotidienne ; la comparaison à durée égale est indisponible.</p></div>':''}
   ${currencyKey==='MAD_LEGACY'?'<div class="revenue-notice">Ces anciens imports sont présentés selon la convention MAD utilisée par la caisse. Leur devise n’est pas explicitement indiquée dans les fichiers ; ils restent séparés des montants en MAD confirmé.</div>':currencyKey==='UNKNOWN'?'<div class="revenue-notice">La devise de ces montants n’est pas renseignée. Aucun total avec une autre devise n’est calculé.</div>':''}
   <div class="revenue-metrics">${metric('Revenus déclarés',recorded,'revenue',true)}${metric('Brut disponible',gross,'gross')}${metric('Net après commissions',net,'net')}${metric('Versement déclaré',payout,'reportedPayout')}</div>
   <p class="revenue-comparison-note">${openWeek?'Comparaison à durée égale indisponible pour ce relevé de semaine en cours.':'Comparaison avec la période précédente sur le même temps écoulé, lorsque les données sont comparables.'} Le net ne représente pas un bénéfice après toutes les charges. ${revenueEsc(comparedWindow)}</p>
   ${uncertain?.records?'<div class="revenue-notice revenue-uncertain"><strong>Date sans heure : montant non répartissable</strong><p>'+uncertain.records+' écriture(s) hors des totaux précis ci-dessus. Leur date chevauche une borne horaire de la période ; aucune heure n’est inventée.</p>'+uncertain.currencies.map(item=>'<p><strong>'+revenueEsc(revenueMoney(revenueMetric(item,'revenue').minor,item))+'</strong> · '+revenueEsc(revenueCurrencyLabel(item))+'</p>').join('')+'</div>':''}
   <section class="revenue-panel revenue-secondary-details"><div class="revenue-section-head"><div><h2>Détail des montants déclarés</h2><p>${group?.records||0} écriture(s) financière(s) dans cette devise : transactions ou relevés, sans estimation du nombre de courses. Les rubriques peuvent se recouper ; elles ne sont pas additionnées entre elles.</p></div></div><dl class="revenue-breakdown">${details.map(([field,title])=>{const value=revenueMetric(group,field);return '<div><dt>'+title+'</dt><dd>'+revenueEsc(revenueMoney(value.minor,group))+'</dd><small>'+revenueEsc(revenueMetricNote(value))+'</small></div>';}).join('')}</dl></section>
   <section class="revenue-panel"><div class="revenue-section-head"><div><h2>Évolution des revenus déclarés</h2><p>Montants par date enregistrée · ${revenueEsc(revenueCurrencyLabel(currencyKey))}</p></div><button type="button" id="revenue-export" class="revenue-secondary" ${sourceIds.length?'':'disabled'}>Exporter le récapitulatif CSV</button></div>${revenueChart(daily,currencyKey)}</section>
   <section class="revenue-panel"><div class="revenue-section-head"><div><h2>Répartition par source</h2><p>Un montant absent reste indisponible ; les encaissements ne sont pas ajoutés une seconde fois aux revenus.</p></div></div><div class="revenue-source-grid">${sourceIds.map(source=>{const row=sourceRows.find(item=>item.source===source),sg=revenueGroup(row,currencyKey),status=sourceStatus(source),amount=revenueMetric(sg,'revenue'),note=status.note||status.message||'';return '<article class="revenue-source-card" data-source="'+source+'"><div><span class="revenue-source-dot '+source+'"></span><h3>'+REVENUE_SOURCES[source]+'</h3><span class="revenue-source-state">'+statusText(status)+'</span></div><strong>'+revenueEsc(revenueMoney(amount.minor,sg||group))+'</strong><p>'+revenueEsc(revenueMetricNote(amount))+'</p><dl><div><dt>Brut renseigné</dt><dd>'+revenueEsc(revenueMoney(revenueMetric(sg,'gross').minor,sg||group))+'</dd></div><div><dt>Net renseigné</dt><dd>'+revenueEsc(revenueMoney(revenueMetric(sg,'net').minor,sg||group))+'</dd></div></dl>'+sourceFreshness(status)+(note?'<p class="revenue-source-note">'+revenueEsc(note)+'</p>':'')+'</article>';}).join('')}</div></section>
   <section class="revenue-panel"><div class="revenue-section-head"><div><h2>Par chauffeur et source</h2><p>Les identités non rapprochées restent distinctes entre les applications.</p></div><span class="revenue-count">${drivers.length} ligne(s)</span></div>${drivers.length?'<div class="revenue-table-scroll"><table class="revenue-table"><thead><tr><th>Chauffeur</th><th>Source</th><th>Revenus déclarés</th><th>Brut renseigné</th><th>Net renseigné</th><th>Couverture</th></tr></thead><tbody>'+drivers.map(row=>{const amount=revenueMetric(row.group,'revenue');return '<tr><td><strong>'+revenueEsc(row.driverName||row.name||row.driverKey||'Identité non renseignée')+'</strong></td><td>'+revenueEsc(REVENUE_SOURCES[row.source]||row.source||'—')+'</td><td>'+revenueEsc(revenueMoney(amount.minor,row.group))+'</td><td>'+revenueEsc(revenueMoney(revenueMetric(row.group,'gross').minor,row.group))+'</td><td>'+revenueEsc(revenueMoney(revenueMetric(row.group,'net').minor,row.group))+'</td><td>'+revenueEsc(revenueMetricNote(amount))+'</td></tr>';}).join('')+'</tbody></table></div>':'<div class="revenue-empty">Aucun montant attribuable à un chauffeur pour cette sélection.</div>'}</section>
   ${result.provider?providerUI.renderProviderEarnings({...result.provider,requestedPeriod:result.provider.current?.requestedPeriod||period,context:'revenue'}):''}
   <details class="revenue-method"><summary>Comprendre les montants et la couverture</summary><p>« Revenus déclarés », brut, net et versements sont des informations distinctes des relevés. Les colonnes absentes ne sont calculées que lorsqu’une décomposition complète est prouvée et rapprochée. Pour Uber, le net vérifié est après Service Fee et avant le poste Taxes, dont la nature fiscale reste non précisée. Les prix de courses issus des API ne sont pas additionnés aux relevés financiers couvrant les mêmes opérations.</p><p>La semaine va du lundi à 04 h au lundi suivant à 04 h, heure du Maroc. Une date sans heure ne permet pas toujours de classer une opération autour de cette limite.</p>${[...new Set(notes)].map(note=>'<p>'+revenueEsc(note)+'</p>').join('')}</details>`;
  node('revenue-currency').onchange=()=>{currencyKey=node('revenue-currency').value;paint();};
  node('revenue-export').onclick=()=>{
   if(!current()||!result)return;
   const rows=[['Début inclus','Fin demandée exclue','Fin de lecture exclue','Lu le','Source','État de lecture','Couverture','Devise','Revenus déclarés','Brut renseigné','Net renseigné','Versement déclaré','Dates sans heure hors total','Dernière donnée financière','Dernier import','Dernière lecture fournisseur','Relevés de période fournisseur','Base fournisseur','Début période fournisseur','Fin période fournisseur exclue']];
   for(const source of sourceIds){const row=sourceRows.find(item=>item.source===source),sg=revenueGroup(row,currencyKey),status=sourceStatus(source),uncertainSource=revenueGroup(result.current?.uncertainDay?.bySource?.find(item=>item.source===source),currencyKey),uncertainAmount=revenueMetric(uncertainSource,'revenue').minor;rows.push([period.start,period.end,source==='uber'&&openWeek?'':result.comparisonWindow?.end||period.end,result.fetchedAt||'',REVENUE_SOURCES[source],status.status||'non_confirmé',coverage.complete===true?'complète':'partielle ou non confirmée',revenueCurrencyLabel(currencyKey),...['revenue','gross','net','reportedPayout'].map(field=>{const value=revenueMetric(sg,field).minor;return Number.isSafeInteger(value)?(value/100).toFixed(2):'';}),Number.isSafeInteger(uncertainAmount)?(uncertainAmount/100).toFixed(2):'',sourceLast(status)||'',status.lastImportedAt||'',status.lastProviderObservedAt||'',status.providerPeriods||'',source==='uber'&&openWeek?'Semaine en cours observée':source==='uber'&&status.providerPeriods?'Période exacte':'',source==='uber'&&openWeek?basis.periodStart:'',source==='uber'&&openWeek?basis.periodEnd:'']);}
   const blob=new Blob(['\ufeff'+rows.map(row=>row.map(revenueCSVCell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='ludy-chiffre-affaires-'+period.start.slice(0,10)+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
 }
 async function refresh({automatic=false}={}){
  if(!current()||!canEdit()||automatic&&(busy||document.hidden))return;
  const revision=++requestRevision;REVENUE_PAGE.controller?.abort();const controller=new AbortController();REVENUE_PAGE.controller=controller;busy=true;
  let request,key;
  try{request=selection();key=JSON.stringify(request);}
  catch(error){if(current()){showError(error.message||'Période invalide.');node('revenue-results').innerHTML='<div class="revenue-empty">Choisissez une période valide pour afficher les montants.</div>';node('revenue-results').setAttribute('aria-busy','false');node('revenue-read-status').textContent='Sélection à corriger';node('revenue-refresh').disabled=false;}busy=false;return;}
  const changed=key!==lastKey;if(changed){result=null;node('revenue-results').innerHTML='<div class="revenue-loading">Lecture des montants enregistrés…</div>';}
  showError('');node('revenue-results').setAttribute('aria-busy','true');node('revenue-refresh').disabled=true;node('revenue-read-status').textContent='Lecture en cours…';
  try{
   const value=await loader.load({...request,signal:controller.signal});if(!current()||revision!==requestRevision||controller.signal.aborted)return;
   result=value;lastKey=key;lastRefresh=value.fetchedAt||new Date().toISOString();
   chooseOptions('revenue-agency',value.choices?.agencies||S.agencies||[],'Toutes mes agences');chooseOptions('revenue-driver',value.choices?.drivers||[],'Tous les chauffeurs','code');
   paint();node('revenue-read-status').textContent='Dernière lecture : '+revenueDate(lastRefresh);
  }catch(error){if(!current()||revision!==requestRevision||controller.signal.aborted)return;if(['revenue_access_denied','revenue_auth_required'].includes(error.code)){revenueCleanup();host.innerHTML='<section class="revenue-panel"><h1>Chiffre d’affaires</h1><p>Votre accès à cette vue a changé. Les données financières ont été masquées.</p></section>';return;}showError(error.message||'La lecture des données financières a échoué.');node('revenue-read-status').textContent=result?'Lecture interrompue · dernière lecture conservée : '+revenueDate(lastRefresh):'Lecture indisponible';if(!result)node('revenue-results').innerHTML='<div class="revenue-empty">Aucun montant ne peut être affiché tant que la lecture a échoué.</div>';}
  finally{if(current()&&revision===requestRevision){busy=false;node('revenue-refresh').disabled=false;node('revenue-results').setAttribute('aria-busy','false');}}
 }
 node('revenue-filters').onsubmit=event=>{event.preventDefault();void refresh();};
 for(const id of ['revenue-source','revenue-agency','revenue-driver'])node(id).onchange=()=>{if(id==='revenue-agency')node('revenue-driver').value='';void refresh();};
 node('revenue-anchor').onchange=()=>{rolling=false;void refresh();};
 for(const id of ['revenue-from','revenue-to'])node(id).onchange=()=>{rolling=false;void refresh();};
 host.querySelectorAll('[data-revenue-preset]').forEach(button=>button.onclick=()=>{preset=button.dataset.revenuePreset;rolling=preset!=='custom';node('revenue-anchor').value=metrics.revenueDay(Date.now());void refresh();});
 for(const [id,direction]of [['revenue-previous',-1],['revenue-next',1]])node(id).onclick=()=>{if(!period||preset==='custom')return;const next=metrics.shiftRevenuePeriod(period,direction);rolling=false;node('revenue-anchor').value=metrics.revenueDay(next.start);void refresh();};
 await refresh();if(!current())return;
 REVENUE_PAGE.timer=setInterval(()=>void refresh({automatic:true}),30000);
 REVENUE_PAGE.visibility=()=>{if(!document.hidden)void refresh({automatic:true});};document.addEventListener('visibilitychange',REVENUE_PAGE.visibility);
 if(typeof sb?.channel==='function'){
  const changed=()=>{if(!current())return;clearTimeout(REVENUE_PAGE.refreshTimer);REVENUE_PAGE.refreshTimer=setTimeout(()=>void refresh({automatic:true}),400);};
  // Publish only the agency refresh marker. Financial rows and their identifiers
  // stay behind the authenticated loader; INSERT/UPDATE payloads are ignored.
  try{const channel=sb.channel('ludy-revenue-'+generation+'-'+my);REVENUE_PAGE.channel=channel;for(const event of ['INSERT','UPDATE'])channel.on('postgres_changes',{event,schema:'public',table:'revenue_refresh'},changed);channel.subscribe();}catch{if(REVENUE_PAGE.channel&&typeof sb.removeChannel==='function')Promise.resolve(sb.removeChannel(REVENUE_PAGE.channel)).catch(()=>{});REVENUE_PAGE.channel=null;}
 }
}
