import {createHash} from 'node:crypto';
import {readUberCsv} from './uber-reports.mjs';
import {uberLegacyPickupCity as uberPickupCity,uberPickupCitySuffix} from './uber-pickup-city.mjs';
import olc from './pickup-reference-olc.mjs';
import {ALGORITHM_SOURCE,CHECKED_AT,LOCALITY_CONTEXTS,metersBetween} from './pickup-reference-evidence.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fold=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
// These are audit candidates, not new import/geocoding rules. A street mentioning
// a city is not sufficient evidence to silently change an agency assignment.
const ALIASES={
 Casablanca:['الدار البيضاء','الدارالبيضاء','casablanka','kasablanka','kazablanka','dar-el-beida','казабланка','касабланка','卡萨布兰卡','卡薩布蘭卡','카사블랑카','カサブランカ','καζαμπλανκα','קזבלנקה','คาซาบลังกา'],
 Marrakech:['مراكش','марракеш','马拉喀什','馬拉喀什','마라케시','マラケシュ','marakes','μαρακες']
};
const MUNICIPALITIES={Bouskoura:['bouskoura','بوسكورة'],Nouaceur:['nouaceur','nouaseur','النواصر','нуасер','нуасёр'],Mohammedia:['mohammedia','المحمدية'],Rabat:['rabat','الرباط'],Sale:['sale','سلا'],Tanger:['tanger','طنجة'],DarBouazza:['dar bouazza','دار بوعزة'],Berrechid:['berrechid','berrchid','برشيد'],Temara:['temara','تمارة']};
const mentions=(address,aliases)=>Object.entries(aliases).filter(([,values])=>values.some(value=>{
 const word=fold(value),at=address.indexOf(word);if(at<0)return false;
 if(/^[a-z '-]+$/.test(word))return (at===0||!/[a-z]/.test(address[at-1]))&&(at+word.length===address.length||!/[a-z]/.test(address[at+word.length]));
 return true;
})).map(([city])=>city);
const supported=status=>['completed','rider_cancelled','driver_cancelled'].includes(status);
const increment=(object,key)=>{object[key]=(object[key]||0)+1;};
const range=values=>values.length?{from:values.slice().sort()[0],to:values.slice().sort().at(-1)}:null;
const ratio=(numerator,denominator)=>({numerator,denominator,percent:denominator?Math.round(numerator/denominator*10000)/100:null});
export function explicitPlusCodeCity(address){
 const suffixes=String(address).split(',').map(part=>part.trim()).filter(Boolean).slice(-2);
 const cities=suffixes.filter(part=>/^(?:casablanca|marrakech|marrakesh)(?:\s+\d{4,6})?$/i.test(part)).map(uberPickupCity);
 return cities.length===1?cities[0]:null;
}
export function extractAddressPlusCodes(address){
 return [...String(address).matchAll(/(?<![a-z0-9])[23456789CFGHJMPQRVWX0]{2,8}\+[23456789CFGHJMPQRVWX]{2,7}(?![a-z0-9])/gi)]
  .map(match=>match[0].toUpperCase()).filter(code=>olc.isValid(code));
}
export function decodeAddressPlusCode(code,{city=null}={}){
 if(olc.isFull(code))return {code,fullCode:code,method:'full_code',area:olc.decode(code),context:null,represents:'address_code_area_not_trip_gps'};
 if(!olc.isShort(code))throw Error('Invalid Plus Code.');
 const context=LOCALITY_CONTEXTS[city];
 if(!context)return {code,method:'short_code_unresolved',fullCode:null,area:null,context:null,represents:'address_code_area_not_trip_gps'};
 const fullCode=olc.recoverNearest(code,context.latitude,context.longitude);
 return {code,fullCode,method:'short_code_with_explicit_locality',area:olc.decode(fullCode),context:{city,...context},represents:'address_code_area_not_trip_gps'};
}

export function auditPickupReferenceFile(csv,catalog,{filename='Uber trip activity.csv'}={}){
 if(typeof csv!=='string'||Buffer.byteLength(csv)>32*1024*1024)throw Error('CSV size invalid.');
 const grid=readUberCsv(csv),headers=grid.shift(),required=['UUID de la course','Heure de la demande de course','Adresse de prise en charge','Statut de la course'];
 if(!headers||grid.length>20000||required.some(name=>headers.filter(value=>value===name).length!==1))throw Error('Uber activity columns invalid.');
 const [idAt,timeAt,addressAt,statusAt]=required.map(name=>headers.indexOf(name)),seen=new Set(),duplicates=[];
 const records=grid.map((row,index)=>{
  if(row.length!==headers.length||!row[idAt]||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[timeAt]))throw Error('Uber activity row invalid.');
  const id=row[idAt].toLowerCase();if(seen.has(id))duplicates.push(index+2);seen.add(id);
  return {line:index+2,address:row[addressAt],status:row[statusAt],time:row[timeAt],city:uberPickupCity(row[addressAt])};
 });
 const statuses={},outside={rows:0,statuses:{},ambiguousTwoCities:0,aliasCandidates:{Casablanca:0,Marrakech:0},otherMunicipalityCandidates:{},unresolved:0};
 const codes=[],codeRows=new Set();
 for(const record of records){
  increment(statuses,record.status);
  if(!record.city){
   outside.rows++;increment(outside.statuses,record.status);const address=fold(record.address);
   if(/\b(?:casablanca|casa)\b/.test(address)&&/\b(?:marrakech|marrakesh)\b/.test(address))outside.ambiguousTwoCities++;
   const aliases=mentions(address,ALIASES),municipalities=mentions(address,MUNICIPALITIES);
   if(aliases.length===1&&!municipalities.length)outside.aliasCandidates[aliases[0]]++;
   else if(!aliases.length&&municipalities.length)increment(outside.otherMunicipalityCandidates,municipalities.sort().join(' / '));
   else outside.unresolved++;
  }
  for(const code of extractAddressPlusCodes(record.address)){
   codeRows.add(record.line);codes.push({csvRow:record.line,importCity:record.city,...decodeAddressPlusCode(code,{city:explicitPlusCodeCity(record.address)})});
  }
 }
 const cities=Object.fromEntries(Object.entries(catalog.declarations).map(([city,declared])=>{
  const all=records.filter(row=>row.city===city),eligible=all.filter(row=>supported(row.status)),period=declared.period;
  const reviewed=records.filter(row=>!row.city&&supported(row.status)&&uberPickupCitySuffix(row.address)===city);
  const inDeclared=eligible.filter(row=>period&&row.time.slice(0,10)>=period.from&&row.time.slice(0,10)<=period.to);
  // An intentionally narrow, reproducible category. It is not the user's much
  // broader, undefined "unlocalisable" denominator and never replaces that rate.
  const simpleLabel=row=>/^(?:Casablanca|Marrakech|Marrakesh)(?:\s+\d{4,6})?(?:\s*,?\s*(?:Maroc|Morocco))?$/i.test(row.address.trim());
  const relevantCodes=codes.filter(row=>row.importCity===city),recovered=relevantCodes.filter(row=>row.area);
  return [city,{sourceRows:all.length,eligibleRows:eligible.length,completed:eligible.filter(row=>row.status==='completed').length,cancelled:eligible.filter(row=>row.status!=='completed').length,
   excludedStatuses:all.length-eligible.length,observedLocalTime:range(all.map(row=>row.time)),declaredPeriod:period,
   eligibleInDeclaredPeriod:period?inDeclared.length:null,outsideDeclaredPeriod:period?eligible.length-inDeclared.length:null,
   declaredRequests:declared.requests,declaredCountReproduced:declared.requests!==null&&declared.requests===inDeclared.length,
   differenceAgainstFullImport:declared.requests===null?null:declared.requests-eligible.length,
   differenceWithinDeclaredPeriod:declared.requests===null||!period?null:declared.requests-inDeclared.length,
   unimportedAliasCandidates:outside.aliasCandidates[city]||0,
   confirmedLocalitySuffixRows:reviewed.length,eligibleAfterLocalityReview:eligible.length+reviewed.length,
   confirmedSuffixStatuses:{completed:reviewed.filter(row=>row.status==='completed').length,rider_cancelled:reviewed.filter(row=>row.status==='rider_cancelled').length,driver_cancelled:reviewed.filter(row=>row.status==='driver_cancelled').length},
   simpleCityLabel:{...ratio(eligible.filter(simpleLabel).length,eligible.length),definition:'Libellé intégral : ville seule, code postal facultatif et suffixe Maroc/Morocco facultatif ; statuts terminés ou annulés.',sameDefinitionAsDeclared:false},
   simpleCityLabelInDeclaredPeriod:period?ratio(inDeclared.filter(simpleLabel).length,inDeclared.length):null,
   plusCodes:{rows:new Set(relevantCodes.map(row=>row.csvRow)).size,recoveredRows:new Set(recovered.map(row=>row.csvRow)).size,uniqueRecovered:new Set(recovered.map(row=>row.fullCode)).size,unresolvedRows:new Set(relevantCodes.filter(row=>!row.area).map(row=>row.csvRow)).size,
    coverage:ratio(new Set(relevantCodes.filter(row=>supported(records[row.csvRow-2].status)).map(row=>row.csvRow)).size,eligible.length)},
   scope:'Ce fichier source seulement ; aucune affectation de ville/agence et aucune coordonnée de course modifiée.'}];
 }));
 const codeChecks=catalog.entries.filter(entry=>entry.coordinates.basis==='provided_plus_code').map(entry=>{
  if(entry.kind==='zone'||!Number.isFinite(entry.latitude)||!Number.isFinite(entry.longitude))return {entryId:entry.id,status:'indicative_center_not_a_raw_code'};
  const candidates=codes.filter(code=>code.area&&(code.method==='full_code'||code.context?.city===entry.city)).map(code=>({code,meters:metersBetween(entry,{latitude:code.area.latitudeCenter,longitude:code.area.longitudeCenter})})).sort((a,b)=>a.meters-b.meters);
  const nearest=candidates[0],matches=candidates.filter(item=>item.meters<=10);
  return {entryId:entry.id,status:matches.length?'coordinate_consistent_with_contextual_code':'not_reproduced_in_this_export',thresholdMeters:10,nearestMeters:nearest?Math.round(nearest.meters):null,
   matchingCodes:new Set(matches.map(item=>item.code.fullCode)).size,venueIdentityVerified:false,pickupVerified:false,
   note:'Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés.'};
 });
 const report={version:1,checkedAt:CHECKED_AT,source:{filename,sha256:hash(csv),rows:records.length,uniqueTripIds:seen.size,duplicateRows:duplicates.length,localTimeZone:'Africa/Casablanca',timezoneEvidence:'Confirmation utilisateur pour cet export'},referenceSha256:catalog.source.sha256,
  statuses,outside,cities,plusCodes:{rows:codeRows.size,uniqueRawCodes:new Set(codes.map(row=>row.code)).size,fullCodes:codes.filter(row=>row.method==='full_code').length,shortCodes:codes.filter(row=>row.method!=='full_code').length,
   recoveredRows:new Set(codes.filter(row=>row.area).map(row=>row.csvRow)).size,unresolvedRows:new Set(codes.filter(row=>!row.area).map(row=>row.csvRow)).size,algorithm:ALGORITHM_SOURCE},codeChecks,
  conclusions:['Le total annoncé n’est pas forcé par une réaffectation des lignes sans ville reconnue.','Les pourcentages par zone ne sont pas recalculés : leurs périmètres et dénominateurs localisables ne sont pas fournis.','Les codes courts sont rétablis uniquement avec une localité explicite et une référence publique documentée ; la cellule encodée n’est pas une mesure GPS du trajet.']};
 return {report,privateCodeEvidence:codes,duplicateCsvRows:duplicates};
}
