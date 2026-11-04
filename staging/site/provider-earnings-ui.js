// Shared, read-only presentation of provider settlement windows. No cash move,
// driver settlement or daily allocation is produced by this module.
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const aborted=()=>new DOMException('Lecture remplacée ou session modifiée.','AbortError');
export function providerAccessError(error){return error?.status===401||error?.status===403||['AUTH_REQUIRED','FORBIDDEN','revenue_auth_required','revenue_access_denied'].includes(error?.code);}
export function providerMoney(metric,currency){
 const value=metric?.minor;if(!Number.isSafeInteger(value))return '—';
 return /^[A-Z]{3}$/.test(currency||'')?new Intl.NumberFormat('fr-FR',{style:'currency',currency,currencyDisplay:'code',minimumFractionDigits:2,maximumFractionDigits:2}).format(value/100):'Devise non confirmée';
}
export function providerDate(value){
 if(!value||!Number.isFinite(Date.parse(value)))return 'Non renseignée';
 const p=globalThis.LudyMoroccoTime?.moroccoParts(value);if(p){const z=n=>String(n).padStart(2,'0');return z(p.day)+'/'+z(p.month)+'/'+p.year+' à '+z(p.hour)+':'+z(p.minute);}
 return new Date(value).toISOString().replace('T',' ').slice(0,16)+' UTC';
}
/** The browser only obtains a public collection configuration using its own
 * session. A token/identity change invalidates the response before use. */
export function createProviderConfigReader({supabase,fetchImpl=globalThis.fetch}={}){
 let disposed=false;const pending=new Set();
 async function read({signal}={}){
  if(disposed||signal?.aborted)throw aborted();const controller=new AbortController();pending.add(controller);const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  const timeout=setTimeout(cancel,20000);
  const identity=async()=>{const {data,error}=await supabase.auth.getSession();const session=data?.session;if(error||!session?.access_token||!session?.user?.id)throw Object.assign(Error('Connexion Ludy requise.'),{status:401,code:'revenue_auth_required'});return session;};
  try{
   const before=await identity();if(disposed||controller.signal.aborted)throw aborted();
   const response=await fetchImpl('/api/provider-earnings/config',{method:'GET',headers:{Authorization:'Bearer '+before.access_token},credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
   const after=await identity();if(disposed||controller.signal.aborted||after.user.id!==before.user.id||after.access_token!==before.access_token)throw aborted();
   if(!response.ok)throw Object.assign(Error(response.status===401?'Connexion Ludy requise.':response.status===403?'Accès aux données fournisseurs refusé.':'Configuration des fournisseurs indisponible.'),{status:response.status,code:response.status===401?'revenue_auth_required':response.status===403?'revenue_access_denied':'provider_config_unavailable'});
   const value=await response.json(),final=await identity();if(disposed||controller.signal.aborted||final.user.id!==before.user.id||final.access_token!==before.access_token)throw aborted();
   if(!value||typeof value!=='object'||!value.uber||typeof value.uber!=='object'||value.uber.organization_id!=null&&!UUID.test(value.uber.organization_id)||value.uber.time_zone!=='Africa/Casablanca')throw Error('Configuration des fournisseurs non reconnue.');
   // Return only public, documented fields; provider credentials are never used.
   return {uber:{enabled:value.uber.enabled===true,organization_id:value.uber.organization_id||null,organization_label:String(value.uber.organization_label||'').slice(0,160),time_zone:'Africa/Casablanca'},bolt:{status:String(value.bolt?.status||'unavailable'),reasonCode:String(value.bolt?.reasonCode||''),canReplaceLegacyStatements:value.bolt?.canReplaceLegacyStatements===true}};
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);pending.delete(controller);}
 }
 read.dispose=()=>{disposed=true;for(const controller of pending)controller.abort();pending.clear();};return read;
}
export function providerOrganizationIds(config){const id=config?.uber?.organization_id;return UUID.test(id||'')?[id.toLowerCase()]:[];}
function scopeLabel(report){return ({fleet:'Flotte entière · contrôle administrateur',agency:'Chauffeurs rattachés à l’agence sélectionnée',driver:'Chauffeur sélectionné',visible_drivers:'Chauffeurs visibles dans votre périmètre'})[report.scope?.kind]||'Périmètre à confirmer';}
function driverDetails(report){
 const drivers=report.byDriver||[],unmatched=report.unmatched;
 const columns=[['revenue','Revenus déclarés'],['gross','Brut'],['net','Net après commissions · avant Taxes Uber'],['reportedNetEarnings','« Net earnings » Uber'],['cash','Espèces déclarées'],['reportedPayout','Versements']];
 const table=drivers.length?'<details class="provider-driver-details"><summary>Détail des chauffeurs confirmés · '+drivers.length+'</summary><div class="provider-driver-scroll"><table><thead><tr><th>Chauffeur</th><th>Devise</th>'+columns.map(([,name])=>'<th>'+name+'</th>').join('')+'</tr></thead><tbody>'+drivers.flatMap(driver=>(driver.currencies||[]).map(group=>'<tr><th>'+escapeHTML(driver.driverName||driver.driverKey||'Identité non renseignée')+'</th><td>'+escapeHTML(group.currencyCode||group.currency)+'</td>'+columns.map(([key])=>'<td>'+escapeHTML(providerMoney(group[key],group.currencyCode||group.currency))+'</td>').join('')+'</tr>')).join('')+'</tbody></table></div><p class="provider-note">Détail de la même fenêtre fournisseur ; ces montants ne s’ajoutent pas au total ci-dessus.</p></details>':'';
 const warning=unmatched?.records?'<div class="provider-warning provider-unmatched">'+Number(unmatched.records)+' ligne(s) sans rattachement confirmé à un chauffeur et une agence. Contrôle administrateur uniquement ; ces lignes ne sont pas attribuées à une agence. <a href="#/rapprochements-financiers?snapshot='+encodeURIComponent(report.id)+'">Vérifier les identités et agences</a>'+(unmatched.currencies||[]).map(group=>'<p>Revenus déclarés non rapprochés : '+escapeHTML(providerMoney(group.revenue,group.currencyCode||group.currency))+'</p>').join('')+'</div>':'';
 return table+warning;
}
function reportHTML(report){
 const full=report.coverage?.complete===true,period=report.period||{},groups=report.currencies||[];
 const metric=(group,key,label)=>'<div><dt>'+label+'</dt><dd>'+escapeHTML(providerMoney(group[key],group.currencyCode||group.currency))+'</dd>'+(!group[key]?.known?'<small>Non fourni</small>':group[key]?.missing?'<small>Montant partiel</small>':group[key]?.basis==='calculated_before_uber_fees_and_provider_taxes'?'<small>Calcul vérifié · avant frais Uber et Taxes</small>':group[key]?.basis==='calculated_after_uber_fees_before_provider_taxes'?'<small>Calcul vérifié · après frais Uber, avant Taxes Uber</small>':group[key]?.basis==='sum_complete_driver_rows'?'<small>Somme de tous les chauffeurs du relevé</small>':group[key]?.basis==='sum_selected_driver_rows'?'<small>Somme des chauffeurs sélectionnés</small>':'')+'</div>';
 return '<article class="provider-report" data-provider-report="'+escapeHTML(report.id)+'"><header><div><h3>Uber · '+escapeHTML(scopeLabel(report))+'</h3><p>'+escapeHTML(providerDate(period.start))+' → '+escapeHTML(providerDate(period.end))+' · heure du Maroc</p></div><span class="provider-badge '+(full?'':'partial')+'">'+(full?'Couverture confirmée':'Lecture partielle')+'</span></header>'+
 '<p class="provider-window">'+(report.canReplaceLegacy?'Fenêtre et périmètre exacts : ce relevé peut remplacer les anciens imports Uber de cette sélection.':report.exactWindow?'La fenêtre correspond, mais la complétude ou les rattachements restent à confirmer.':'Fenêtre fournisseur différente de la sélection : montant présenté séparément, sans prorata.')+'</p>'+
 groups.map(group=>'<dl class="provider-amounts">'+metric(group,'revenue','Revenus déclarés')+metric(group,'gross','Brut avant frais')+metric(group,'net','Net après commissions · avant Taxes Uber')+metric(group,'reportedPayout','Versements déclarés')+'</dl><dl class="provider-details">'+[['fare','Fare · courses'],['taxes','Taxes Uber · signées'],['cash','Espèces déclarées'],['refundsExpenses','Remboursements et frais'],['adjustments','Ajustements'],['commission','Commissions'],['tips','Pourboires'],['bonus','Primes']].map(([key,label])=>metric(group,key,label)).join('')+'</dl><details class="provider-balances"><summary>Soldes et valeurs de règlement · hors chiffre d’affaires</summary><dl>'+metric(group,'startBalance','Solde initial')+metric(group,'endBalance','Solde final')+metric(group,'reportedNetEarnings','« Net earnings » affiché par Uber')+'</dl><p>Ces soldes ne sont ni des revenus, ni les espèces physiquement présentes dans la caisse. Le libellé « Net earnings » de cet écran peut inclure les versements ; il reste séparé du net après commissions.</p></details>').join('')+
 driverDetails(report)+(report.notes||[]).filter(note=>typeof note==='string').map(note=>'<p class="provider-note">'+escapeHTML(note)+'</p>').join('')+'<footer><span>Dernière lecture chez Uber : '+escapeHTML(providerDate(report.observedAt))+'</span><span>'+Number(report.observedDriverRows||0)+' ligne(s) chauffeur · '+(report.coverage?.mappingComplete===true?'rattachements confirmés':'rattachements incomplets ou non confirmés')+'</span></footer></article>';
}
function latestReports(result){
 const selected=new Set((result?.selected||[]).map(report=>report.id)),ranked=[...(result?.reports||[])].sort((a,b)=>Number(selected.has(b.id))-Number(selected.has(a.id))||Date.parse(b.observedAt)-Date.parse(a.observedAt)),seen=new Set();
 return ranked.filter(report=>{const key=JSON.stringify([report.organizationId,report.currency,report.scope]);if(seen.has(key))return false;seen.add(key);return true;});
}
export function renderProviderEarnings({current=null,previous=null,config=null,error=null,requestedPeriod=null,context='revenue'}={}){
 const reports=latestReports(current),previousReports=latestReports(previous),queryFailed=current?.coverage?.queryComplete===false;
 const uber=config?.uber,unavailable=error||queryFailed;
 return '<section class="provider-earnings" aria-label="Données fournisseurs"><header class="provider-heading"><div><p class="provider-eyebrow">RELEVÉS FOURNISSEURS</p><h2>Données fournisseurs</h2><p>Montants lus dans Uber Fleet Earnings. Chaque relevé conserve sa fenêtre de règlement réelle.</p></div><a href="#/uber-rapports">Réglages de collecte</a></header>'+
 (requestedPeriod?'<p class="provider-requested">Sélection Ludy : '+escapeHTML(providerDate(requestedPeriod.start))+' → '+escapeHTML(providerDate(requestedPeriod.end))+' (fin exclue, Maroc).</p>':'')+
 (current?.basis?.kind==='open_week'?'<p class="provider-warning provider-open-week"><strong>Semaine en cours</strong> · '+escapeHTML(providerDate(current.basis.periodStart))+' → '+escapeHTML(providerDate(current.basis.periodEnd))+'. Relevé observé chez Uber le '+escapeHTML(providerDate(current.basis.observedAt))+'. La borne de période reste le lundi suivant ; elle ne désigne pas une lecture effectuée dans le futur. Comparaison à durée égale indisponible.</p>':'')+
 (current?.replacement?.message?'<p class="provider-warning">'+escapeHTML(current.replacement.message)+'</p>':'')+
 (unavailable?'<div class="provider-warning" role="status">Lecture fournisseur indisponible. Les montants absents ne valent pas zéro. '+(reports.length?'Derniers relevés conservés ci-dessous ; leur date de lecture reste affichée.':'')+'</div>':'')+
 (!config?'<p class="provider-empty">La configuration de la collecte n’a pas pu être confirmée.</p>':!uber?.enabled?'<p class="provider-empty">Collecte Uber Earnings désactivée. Les relevés déjà reçus restent datés et consultables.</p>':!providerOrganizationIds(config).length?'<p class="provider-empty">Renseignez et confirmez la flotte Uber dans les réglages de collecte.</p>':'')+
 (reports.length?reports.map(reportHTML).join(''):'<p class="provider-empty">Aucun relevé Uber Earnings reçu pour cette période et ce périmètre. Gardez le navigateur de collecte connecté à la flotte configurée.</p>')+
 ((current?.reports?.length||0)>reports.length?'<p class="provider-note">Seule la lecture retenue de chaque flotte et devise est affichée. Les fenêtres qui se chevauchent ne sont jamais additionnées.</p>':'')+
 (previousReports.length?'<details class="provider-previous"><summary>Relevés disponibles pour la période de comparaison</summary>'+previousReports.map(reportHTML).join('')+'</details>':'')+
 '<p class="provider-note">Les colonnes brut et net exigent des montants explicites ou une décomposition complète et rapprochée. Le net après commissions est présenté avant le poste Taxes déclaré par Uber ; les revenus déclarés restent distincts. Un total de flotte et le détail de ses chauffeurs représentent les mêmes revenus et ne se cumulent pas. '+(context==='cash'?'Ces relevés ne créent aucun mouvement de caisse et ne modifient pas les rapprochements par shift.':'Une fenêtre fournisseur sans détail daté n’est pas répartie sur la courbe quotidienne.')+'</p>'+
 '<aside class="provider-bolt"><strong>Bolt · '+(config?.bolt?.status==='unsupported'?'relevé financier non fourni par l’API documentée':'couverture financière API non confirmée')+'</strong><p>Les prix des courses disponibles par API restent dans la performance. Ils ne certifient pas les revenus nets, les commissions ou les espèces encaissées. Pour les finances Bolt, utilisez le relevé financier exporté.</p><a href="#/caisse?t=import">Importer un relevé Bolt</a></aside>'+
 '<aside class="provider-bolt"><strong>inDrive · non utilisé actuellement</strong><p>Cette plateforme est hors du périmètre financier actuel. Aucun montant inDrive n’est inventé ni ajouté au chiffre d’affaires.</p></aside>'+
 '<p class="provider-refresh">Lecture des données enregistrées toutes les 30 s. Le navigateur Uber attend au moins cinq minutes après chaque collecte complète ; sa fraîcheur dépend aussi du fournisseur. Aucun gain instantané n’est estimé.</p></section>';
}
/** Mount a scoped read panel. The caller owns the route guard and loader;
 * this controller owns polling, invalidation, cancellation and redaction. */
export function mountProviderEarnings({element,loader,configReader,selection,isCurrent,supabase,onAccessLost=()=>{}}={}){
 let disposed=false,busy=false,revision=0,controller=null,timer=null,channel=null,refreshTimer=null,last=null;
 const allowed=()=>{if(disposed)return false;if(!element.isConnected||!isCurrent()){element.replaceChildren();dispose();return false;}return true;};
 function dispose(){if(disposed)return;disposed=true;revision++;controller?.abort();clearInterval(timer);clearTimeout(refreshTimer);document.removeEventListener('visibilitychange',visible);loader.dispose();configReader.dispose?.();if(channel&&supabase?.removeChannel)Promise.resolve(supabase.removeChannel(channel)).catch(()=>{});channel=null;}
 async function refresh({automatic=false}={}){
  if(!allowed()||automatic&&(busy||document.hidden))return;const own=++revision;controller?.abort();controller=new AbortController();const signal=controller.signal;busy=true;
  try{const requested=selection(),config=await configReader({signal});if(!allowed()||own!==revision||signal.aborted)return;
   const current=await loader.load({...requested,organizationIds:providerOrganizationIds(config),signal});if(!allowed()||own!==revision||signal.aborted)return;
   last={current,config,requestedPeriod:requested.period,context:'cash'};element.innerHTML=renderProviderEarnings(last);
  }catch(error){if(!allowed()||own!==revision||signal.aborted)return;if(providerAccessError(error)){element.innerHTML='<div class="provider-warning">Votre accès aux données fournisseurs a changé. Les montants ont été masqués.</div>';dispose();onAccessLost();return;}element.innerHTML=renderProviderEarnings({...last,error:true,context:'cash'});}
  finally{if(own===revision)busy=false;}
 }
 function visible(){if(!document.hidden)void refresh({automatic:true});}
 element.innerHTML='<section class="provider-earnings"><h2>Données fournisseurs</h2><p>Lecture des relevés enregistrés…</p></section>';
 timer=setInterval(()=>void refresh({automatic:true}),30000);document.addEventListener('visibilitychange',visible);
 if(supabase?.channel){try{channel=supabase.channel('ludy-cash-provider-'+Math.random().toString(36).slice(2));const changed=()=>{if(!allowed())return;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>void refresh({automatic:true}),400);};for(const event of ['INSERT','UPDATE'])channel.on('postgres_changes',{event,schema:'public',table:'revenue_refresh'},changed);channel.subscribe();}catch{if(channel&&supabase.removeChannel)Promise.resolve(supabase.removeChannel(channel)).catch(()=>{});channel=null;}}
 void refresh();return {dispose,refresh};
}
