// Supplied geographic references only. This module never assigns ride
// coordinates, computes demand shares or performs a network request.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const integer=value=>Number.isSafeInteger(value)?value.toLocaleString('fr-FR'):'Non fournie';
const date=value=>/^\d{4}-\d{2}-\d{2}/.test(value||'')?value.slice(0,10).split('-').reverse().join('/'):'Non renseignée';
const coordinate=row=>Number.isFinite(row.latitude)&&Number.isFinite(row.longitude)&&Math.abs(row.latitude)<=85&&Math.abs(row.longitude)<=180;
function provenance(row){return row.coordinates?.basis==='official_venue_location'?'Localisation publiée par l’établissement · entrée de prise en charge non vérifiée':row.coordinates?.basis==='provided_estimate'?'Estimation fournie · ±200 m annoncés, non vérifiés':row.coordinates?.basis==='provided_wikipedia'?'Wikipedia déclarée · référence précise et exactitude non vérifiées':'Plus code déclaré · code brut absent du fichier de repères';}
function evidenceLink(source){
 try{const u=new URL(source.url);if(u.protocol!=='https:'||u.username||u.password||!['all.accor.com','www.menaramall.com','m-avenue.ma','www.royalmansour.com','www.jardinmajorelle.com','www.essaadi.com','mamounia.com'].includes(u.hostname))return '';
  return '<a href="'+esc(u.href)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">'+esc(source.title)+'</a>';
 }catch{return '';}
}
function evidence(row){
 const original=row.coordinates?.original,review=row.review,check=row.codeReview;
 return (original?'<small>Point initial conservé : '+esc(original.latitude+', '+original.longitude)+' · estimation ±200 m annoncée.</small>':'')+
  (review?'<small>'+esc(review.note)+'</small>'+review.sources.map(source=>'<small>'+evidenceLink(source)+(Number.isFinite(source.latitude)?' : '+esc(source.latitude+', '+source.longitude)+(Number.isFinite(source.distanceFromProvidedMeters)?' · '+integer(source.distanceFromProvidedMeters)+' m du point initial':''):'')+'</small>').join(''):'')+
  (check?'<small>'+esc(check.status==='coordinate_consistent_with_contextual_code'?'Coordonnée compatible à '+check.nearestMeters+' m avec un code court du fichier, rétabli avec sa ville explicite. Le nom du lieu reste non vérifié.':check.status==='indicative_center_not_a_raw_code'?'Centre de zone indicatif ; aucun code brut ne lui est attribué.':'Mention « plus code exact » non reproduite à moins de 10 m dans cet export ; coordonnées conservées comme déclarées.')+'</small>':'');
}
function validationHtml(value){
 if(!value)return '';
 const plus=value.plusCodes||{},simple=value.simpleCityLabel||{};
 return '<section class="pickup-reference-audit"><h4>Contrôle du fichier source</h4><p>'+esc(value.source?.filename)+' · heures du Maroc. Ce contrôle porte uniquement sur ce fichier.</p>'+
  '<p><b>'+integer(value.sourceRows)+' demandes</b> reconnues dans cette ville par le filtre initial, dont '+integer(value.excludedStatuses)+' au statut exclu : <b>'+integer(value.eligibleRows)+' terminées ou annulées</b>.'+(value.declaredPeriod?' Dans la période annoncée du '+date(value.declaredPeriod.from)+' au '+date(value.declaredPeriod.to)+' : '+integer(value.eligibleInDeclaredPeriod)+' ; '+integer(value.outsideDeclaredPeriod)+' hors de cette période.':'')+'</p>'+
  (value.declaredRequests!==null?'<p>Le total annoncé de '+integer(value.declaredRequests)+(value.declaredCountReproduced?' est reproduit pour cette période.':' n’est pas reproduit pour cette période.')+'</p>':'')+
  '<p>'+integer(value.unimportedAliasCandidates)+' autres lignes contiennent une variante du nom de cette ville. Le contrôle strict du suffixe de localité retient '+integer(value.confirmedLocalitySuffixRows)+' lignes supplémentaires, soit '+integer(value.eligibleAfterLocalityReview)+' attributions avant la revue individuelle des adresses ambiguës. Le compteur des imports analysés ci-dessus tient compte des mises à part ; ce contrôle du fichier ne déclenche pas d’import.</p>'+
  '<p>'+integer(plus.rows)+' demandes comportent un plus code : '+integer(plus.recoveredRows)+' sont décodables avec une ville explicite et une référence publique ; '+integer(plus.unresolvedRows)+' restent sans contexte suffisant. Ce sont des cellules d’adresse, pas des positions GPS de courses.</p>'+
  '<details><summary>Base vérifiable des taux et limites</summary><p>'+integer(simple.numerator)+' / '+integer(simple.denominator)+' ('+(Number.isFinite(simple.percent)?esc(String(simple.percent).replace('.',','))+' %':'Non fourni')+') : '+esc(simple.definition)+'</p><p>Cette catégorie précise n’est pas équivalente aux « adresses non localisables » du résumé fourni. Les parts par zone restent déclarées : leur base et leurs frontières ne sont pas définies.</p></details></section>';
}
function mapsLink(row){
 if(!coordinate(row)||!row.mapsUrl)return '';
 try{const link=new URL(row.mapsUrl);if(link.origin!=='https://www.google.com'||link.pathname!=='/maps'||link.username||link.password||link.hash||link.searchParams.size!==1)return '';const parts=link.searchParams.get('q')?.split(',').map(Number);if(parts?.length!==2||parts[0]!==row.latitude||parts[1]!==row.longitude)return '';
  return '<a href="'+esc(link.href)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Ouvrir dans Maps</a>';
 }catch{return '';}
}
function coordinates(row){return coordinate(row)?String(row.latitude)+', '+String(row.longitude):'Coordonnées non fournies';}
function rowsTable(rows){return '<div class="demand-table-scroll"><table class="demand-table pickup-reference-table"><thead><tr><th>Repère fourni</th><th>Coordonnées et provenance</th><th>Part / créneau fourni</th><th>Carte externe</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+esc(row.point||row.zone)+'<small>'+esc(row.kind==='zone'?'Centre indicatif de zone'+(row.radiusKm!==null?' · rayon fourni '+row.radiusKm+' km':' · rayon non fourni'):'Point indicatif')+'</small></td><td>'+esc(coordinates(row))+'<small>'+esc(provenance(row))+'</small>'+evidence(row)+'</td><td>'+(row.reportedShare?esc(row.reportedShare)+(row.kind==='zone'?' %':'')+'<small>Valeur fournie, non recalculée'+(row.kind==='point'?' · base de sous-zone indiquée dans le texte':' · base localisable non fournie')+'</small>':'—')+(row.reportedPeak?'<small>Créneau annoncé : '+esc(row.reportedPeak)+'</small>':'')+'</td><td>'+mapsLink(row)+'</td></tr>').join('')+'</tbody></table></div>';}

export function renderPickupReferenceMap(entries,city){
 const points=entries.filter(coordinate);if(!points.length)return '';
 const latitude=points.reduce((sum,row)=>sum+row.latitude,0)/points.length,scaleLon=111.32*Math.cos(latitude*Math.PI/180),scaleLat=110.57;
 const projected=points.map(row=>({row,x:row.longitude*scaleLon,y:-row.latitude*scaleLat,r:row.kind==='zone'&&Number.isFinite(row.radiusKm)?row.radiusKm:0}));
 const xs=projected.flatMap(p=>[p.x-p.r,p.x+p.r]),ys=projected.flatMap(p=>[p.y-p.r,p.y+p.r]);
 let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 if(maxX-minX<1){minX-=.5;maxX+=.5;}if(maxY-minY<1){minY-=.5;maxY+=.5;}
 const width=900,height=420,pad=35,scale=Math.min((width-pad*2)/(maxX-minX),(height-pad*2)/(maxY-minY));
 const offsetX=(width-(maxX-minX)*scale)/2,offsetY=(height-(maxY-minY)*scale)/2,x=value=>offsetX+(value-minX)*scale,y=value=>offsetY+(value-minY)*scale;
 const zoneNumbers=new Map(entries.filter(row=>row.kind==='zone').map((row,i)=>[row.id,i+1]));
 const shapes=projected.sort((a,b)=>Number(b.row.kind==='zone')-Number(a.row.kind==='zone')).map(p=>{
  const title=esc((p.row.point||p.row.zone)+' · '+provenance(p.row)),cx=x(p.x).toFixed(2),cy=y(p.y).toFixed(2),estimate=p.row.coordinates?.basis==='provided_estimate';
  return (p.r?'<circle class="pickup-reference-radius" cx="'+cx+'" cy="'+cy+'" r="'+(p.r*scale).toFixed(2)+'"><title>'+title+' · rayon indicatif fourni</title></circle>':'')+
   '<circle class="pickup-reference-dot '+(p.row.kind==='zone'?'zone':'point')+(estimate?' estimated':'')+'" cx="'+cx+'" cy="'+cy+'" r="'+(p.row.kind==='zone'?5:3)+'"><title>'+title+'</title></circle>'+
   (zoneNumbers.has(p.row.id)?'<text class="pickup-reference-number" x="'+(x(p.x)+8).toFixed(2)+'" y="'+(y(p.y)-7).toFixed(2)+'">'+zoneNumbers.get(p.row.id)+'</text>':'');
 }).join('');
 return '<figure class="pickup-reference-map"><svg viewBox="0 0 900 420" role="img" aria-label="'+esc(city+' : repères fournis, vue schématique hors ligne ; aucun point ne représente une course.')+'"><rect width="900" height="420" rx="12" fill="#f5f8fb"/><path d="M35 35V385H865" fill="none" stroke="#c5ccd7"/>'+shapes+'<text x="40" y="405">Ouest → Est · longitude</text><text x="40" y="22">Nord en haut · latitude</text></svg><figcaption>Vue schématique hors ligne, sans fond de plan. Numéros : zones ci-dessous. Cercles : rayons indicatifs fournis. Points à contour orange : estimations ±200 m annoncées. Aucune densité de courses n’est représentée.</figcaption></figure>';
}

export function renderPickupReference(reference){
 if(reference?.version!==1||!Array.isArray(reference.cities)||!reference.cities.length)return '';
 return '<section class="demand-panel pickup-reference"><header><span class="pickup-reference-eyebrow">RÉFÉRENTIEL FOURNI</span><h2>Repères de prise en charge</h2><p>Coordonnées indicatives à consulter avec leur provenance. Elles ne géolocalisent aucune course et ne modifient ni les statistiques ci-dessus ni les zones autorisées.</p></header><div class="demand-warnings">'+(reference.notes||[]).map(note=>'<p>'+esc(note)+'</p>').join('')+'</div>'+reference.cities.map(city=>{
  const zones=city.entries.filter(row=>row.kind==='zone'),points=city.entries.filter(row=>row.kind==='point'),declared=city.declared||{},observed=city.imported||{},difference=city.comparison?.requestCountDifference;
  return '<article class="pickup-reference-city"><h3>'+esc(city.name)+' <small>'+zones.length+' zones · '+points.length+' points fournis</small></h3><div class="pickup-reference-scope"><div><strong>Périmètre annoncé, non vérifié</strong><p>'+(declared.requests===null?'Nombre de demandes non fourni':integer(declared.requests)+' demandes')+' · du '+date(declared.period?.from)+' au '+date(declared.period?.to)+'.</p><p>'+esc(declared.shareDenominator||'Base des pourcentages non fournie.')+'</p><p>Adresses sans précision annoncées : '+(Number.isFinite(declared.unlocatedAddressPercent)?esc(declared.unlocatedAddressPercent)+' % · valeur fournie, base distincte des parts par zone.':'Non fourni.')+'</p></div><div><strong>Imports visibles dans Ludy</strong><p>'+integer(observed.requests)+' demandes : '+integer(observed.completed)+' terminées, '+integer(observed.cancelled)+' annulées.</p><p>'+(observed.period?'Dates observées : du '+date(observed.period.fromDay||observed.period.from)+' au '+date(observed.period.toDay||observed.period.to)+'.':'Aucune course importée pour ce filtre.')+'</p><p>'+esc(observed.scope||'')+'</p></div></div>'+
   (observed.cityReview?.quarantined?'<p class="pickup-reference-denominator">'+integer(observed.cityReview.quarantined)+' autres demandes conservées, ville à confirmer : exclues de ce total et des analyses. La confirmation d’une ville ne certifie aucune position GPS.</p>':'')+
   '<p class="pickup-reference-denominator">Les périodes, statuts et prises en charge localisables ne sont pas rapprochés entre ces deux bases.'+(Number.isSafeInteger(difference)?' Écart de comptes : '+integer(Math.abs(difference))+' demandes.':'')+' Aucun pourcentage fourni n’est présenté comme un calcul Ludy.</p>'+
   validationHtml(city.validation)+renderPickupReferenceMap(city.entries,city.name)+zones.map((zone,index)=>'<details class="pickup-reference-group"><summary><span><b>'+(index+1)+'. '+esc(zone.zone)+'</b><small>'+esc(zone.reportedShare||'—')+' % annoncés · non recalculés</small></span></summary>'+rowsTable([zone,...points.filter(point=>point.parentZoneId===zone.id)])+'</details>').join('')+
   (points.some(point=>!point.parentZoneId)?'<details class="pickup-reference-group"><summary>Autres points fournis, sans zone parente définie</summary>'+rowsTable(points.filter(point=>!point.parentZoneId))+'</details>':'')+'</article>';
 }).join('')+'<footer class="pickup-reference-footnote">Source : '+esc(reference.source?.filename)+'. Les liens Maps ne s’ouvrent que sur votre clic ; aucune adresse n’est envoyée automatiquement.</footer></section>';
}
