import {createHash} from 'node:crypto';
import {readUberCsv} from './uber-reports.mjs';
import {moroccoDay} from './morocco-time.mjs';
import suppliedCatalog from './pickup-reference-data.mjs';
import {applyPickupReferenceEvidence} from './pickup-reference-evidence.mjs';
import validation from './pickup-reference-validation-data.mjs';
import {createDemandCityReview} from './demand-city-review.mjs';

const FIELDS=['ville','zone','point','type','part_zone_pct_ou_part_du_point','latitude','longitude','rayon_km','creneau_dominant','source_coordonnees','lien_google_maps'];
const SOURCES={'plus code export (exact)':'provided_plus_code',Wikipedia:'provided_wikipedia','estimation (±200 m)':'provided_estimate'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const fold=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toLowerCase();
const text=(value,max=500)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw Error('Texte du référentiel invalide.');return value.trim();};
const number=(value,{min=-Infinity,max=Infinity}={})=>{if(value==='')return null;if(!/^-?\d+(?:\.\d+)?$/.test(value))throw Error('Nombre du référentiel invalide.');const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)throw Error('Coordonnée ou rayon du référentiel invalide.');return n;};
const DECLARATIONS={
 Casablanca:{period:{from:'2026-10-03',to:'2026-11-02'},requests:5945,unlocatedAddressPercent:22},
 Marrakech:{period:{from:'2026-10-28',to:'2026-11-02'},requests:null,unlocatedAddressPercent:21}
};
const DECLARED_SOURCE_SHA='27479317e095b9a253c14d8af49b20549f6e5e332486e813e5e968e235807c54';

/** User-supplied reference coordinates and claims. No trip association,
 * geocoder, plus-code decoding or external verification is performed. */
export function parsePickupReferenceCsv(csv,{filename='zones_pickup_gps (1).csv'}={}){
 const grid=readUberCsv(csv);if(grid.length<2||grid.length>501||JSON.stringify(grid[0])!==JSON.stringify(FIELDS))throw Error('Colonnes du référentiel de repères inattendues.');
 const entries=[],ids=new Set(),zones=new Set();
 for(const values of grid.slice(1)){
  const row=Object.fromEntries(FIELDS.map((key,index)=>[key,text(values[index])]));
  if(!Object.hasOwn(DECLARATIONS,row.ville)||!['zone','point'].includes(row.type)||!row.zone||row.type==='point'&&!row.point||row.type==='zone'&&row.point)throw Error('Ville, zone ou point incohérent.');
  const latitude=number(row.latitude,{min:-85,max:85}),longitude=number(row.longitude,{min:-180,max:180}),radiusKm=number(row.rayon_km,{min:0.04,max:50});
  if((latitude===null)!==(longitude===null)||latitude===null&&radiusKm!==null||row.type==='point'&&radiusKm!==null)throw Error('Coordonnées et rayon incohérents.');
  if(!Object.hasOwn(SOURCES,row.source_coordonnees))throw Error('Provenance de coordonnées non reconnue.');
  if(row.lien_google_maps){const link=new URL(row.lien_google_maps);if(latitude===null||link.origin!=='https://www.google.com'||link.pathname!=='/maps'||link.username||link.password||link.hash||[...link.searchParams.keys()].some(key=>key!=='q')||link.searchParams.getAll('q').length!==1||link.searchParams.get('q')!==row.latitude+','+row.longitude)throw Error('Lien cartographique non conforme aux coordonnées fournies.');}
  const id=hash(JSON.stringify([row.ville,row.zone,row.point,row.type])).slice(0,24);if(ids.has(id))throw Error('Repère dupliqué.');ids.add(id);
  if(row.type==='zone'){number(row.part_zone_pct_ou_part_du_point,{min:0,max:100});zones.add(row.ville+'\0'+row.zone);}
  entries.push({id,city:row.ville,zone:row.zone,point:row.point||null,kind:row.type,latitude,longitude,radiusKm,
   reportedShare:row.part_zone_pct_ou_part_du_point||null,reportedShareBasis:row.type==='zone'?'localisable_pickups_in_declared_city':'subzone_as_described',reportedPeak:row.creneau_dominant||null,
   coordinates:{basis:SOURCES[row.source_coordonnees],sourceLabel:row.source_coordonnees,verified:false,uncertaintyMeters:SOURCES[row.source_coordonnees]==='provided_estimate'?200:null,rawPlusCode:null},
   mapsUrl:row.lien_google_maps||null});
 }
 // A standalone airport point is allowed. Do not invent its parent zone,
 // boundary, percentage, or a geographic association absent from the file.
 for(const entry of entries)entry.parentZoneId=entry.kind==='point'&&zones.has(entry.city+'\0'+entry.zone)?hash(JSON.stringify([entry.city,entry.zone,'','zone'])).slice(0,24):null;
 const sha256=hash(csv),known=sha256===DECLARED_SOURCE_SHA;
 const declarations=Object.fromEntries([...new Set(entries.map(row=>row.city))].map(city=>[city,known?DECLARATIONS[city]:{period:null,requests:null,unlocatedAddressPercent:null}]));
 return {format:'ludy-pickup-reference-v1',source:{filename:text(filename,180),sha256,providedAt:known?'2026-11-03':null,verified:false},declarations,entries};
}

let loaded;
export function loadPickupReference(){
 if(!loaded){const value=suppliedCatalog;
  if(value.format!=='ludy-pickup-reference-v1'||!Array.isArray(value.entries)||value.entries.length>500||!/^[a-f0-9]{64}$/.test(value.source?.sha256))throw Error('Référentiel de repères indisponible.');
  loaded=applyPickupReferenceEvidence(value);
  if(validation.version===1&&validation.referenceSha256===value.source.sha256){
   loaded.validation=validation;
   for(const entry of loaded.entries){const review=validation.codeChecks.find(check=>check.entryId===entry.id);if(review)entry.codeReview=structuredClone(review);}
  }
 }
 return loaded;
}

export function pickupReferenceForScope({rides=[],agencies=[],agencyId=null,city=null,catalog=loadPickupReference(),cityReview=createDemandCityReview(null)}={}){
 const authorized=agencies.filter(agency=>agencyId===null||String(agency.id)===String(agencyId));
 const permitted=new Set(authorized.map(agency=>fold(agency.city)));
 const selected=Object.keys(catalog.declarations).filter(name=>permitted.has(fold(name))&&(!city||name===city));
 return {version:1,source:{...catalog.source},cities:selected.map(name=>{
  const ids=new Set(authorized.filter(agency=>fold(agency.city)===fold(name)).map(agency=>String(agency.id))),seen=new Set();
  const rows=rides.filter(row=>{const key=String(row.agency_id)+':'+(row.ride_key||row.external_id);if(!ids.has(String(row.agency_id))||row.city!==name||!['completed','cancelled'].includes(row.status)||!Number.isFinite(Date.parse(row.started_at))||seen.has(key))return false;seen.add(key);return true;});
  const reviewed=cityReview.partition(rows),included=reviewed.included;
  const times=included.map(row=>Date.parse(row.started_at)).sort((a,b)=>a-b),declared={...catalog.declarations[name],verified:false,shareDenominator:'Prises en charge localisables selon le résumé fourni ; nombre de base non fourni.',statusScope:'not_confirmed'};
  return {name,entries:catalog.entries.filter(row=>row.city===name),declared,
   validation:catalog.validation?.cities?.[name]&&ids.has(String(catalog.validation.agencyIds?.[name]))?{...structuredClone(catalog.validation.cities[name]),checkedAt:catalog.validation.checkedAt,source:{filename:catalog.validation.source.filename,localTimeZone:catalog.validation.source.localTimeZone}}:null,
   imported:{requests:included.length,storedRequests:rows.length,cityReview:reviewed.coverage,completed:included.filter(row=>row.status==='completed').length,cancelled:included.filter(row=>row.status==='cancelled').length,period:times.length?{from:new Date(times[0]).toISOString(),to:new Date(times.at(-1)).toISOString(),fromDay:moroccoDay(times[0]),toDay:moroccoDay(times.at(-1))}:null,scope:'Imports visibles du filtre courant, après exclusion des villes mises en attente ; périmètre distinct du résumé fourni.'},
   comparison:{sameScopeConfirmed:false,requestCountDifference:declared.requests===null?null:declared.requests-included.length}};
 }),notes:[
  'Repères indicatifs fournis : aucune coordonnée GPS de course ni attribution des courses à ces centres.',
  'Les pourcentages et créneaux ci-dessous sont fournis, non recalculés ni vérifiés. Parts de ville, parts de sous-zone et adresses non localisées ont des dénominateurs différents.',
  'Les contrôles de codes et les sources officielles sont détaillés par repère ; ils ne certifient ni le nom associé à une adresse de course ni une entrée de prise en charge.',
  'Les rayons sont indicatifs et distincts de l’incertitude de position annoncée ±200 m. Ils ne créent aucune zone autorisée ni alerte.'
 ]};
}
