import {moroccoParts,moroccoDay} from './morocco-time.mjs';
import {createHash} from 'node:crypto';
import {trustedVehicleObservation,vehicleObservationWindow} from './vehicle-evidence.mjs';

const DAY=86400000, HOUR=3600000, ONLINE=new Set(['available','on_trip','to_pickup','on_break']);
const numberTime=value=>typeof value==='string'&&value?Date.parse(value):NaN;
const iso=value=>Number.isFinite(value)?new Date(value).toISOString():null;
const round=value=>Math.round(value*10)/10;
const id=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parts=moroccoParts;
export const rotationLocalDay=moroccoDay;
const dateValid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const normalizedPlate=s=>String(s||'').toUpperCase().replace(/[^0-9]/g,'')+String(s||'').toUpperCase().replace(/[^A-Z]/g,'');
function inPeriod(at,from,to){return Number.isFinite(at)&&rotationLocalDay(at)>=from&&rotationLocalDay(at)<=to;}
function shiftAt(at,params){
 const values=Array.isArray(params)?Object.fromEntries(params.map(p=>[p.key,p.value])):params;
 const value=(key,fallback)=>{const n=Number(values?.[key]??fallback);return Number.isFinite(n)&&n>=0&&n<24?n:fallback;};
 const day=value('shiftDay',7),night=value('shiftNight',19),advance=value('shiftAdvance',2),p=parts(at+advance*HOUR),minutes=Number(p.hour)*60+Number(p.minute);
 const isDay=day<night?minutes>=day*60&&minutes<night*60:minutes>=day*60||minutes<night*60,begin=(isDay?day:night)*60;
 const wall=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day))-(minutes<begin?DAY:0);
 return {shift:isDay?'Jour':'Nuit',shift_day:new Date(wall).toISOString().slice(0,10)};
}
function metric(rows){
 const measured=rows.filter(r=>r.status==='measured').map(r=>r.minutes).sort((a,b)=>a-b);
 const mean=measured.length?round(measured.reduce((a,b)=>a+b,0)/measured.length):null;
 return {total:rows.length,measured_count:measured.length,estimated_count:rows.filter(r=>r.status==='estimated').length,
  pending_count:rows.filter(r=>r.status==='waiting').length,unknown_count:rows.filter(r=>['unknown','conflict'].includes(r.status)).length,
  mean_minutes:mean,median_minutes:measured.length?round((measured[Math.floor((measured.length-1)/2)]+measured[Math.floor(measured.length/2)])/2):null,
  p90_minutes:measured.length?measured[Math.ceil(measured.length*.9)-1]:null};
}

// A platform transition is only an estimate of a handover. Two identities and
// both explicit offline/online transitions are required, tied to the same car.
function platformTransitions(observations,drivers,vehicles,now,sourceEvents){
 const driverMap=new Map(drivers.map(d=>[d.id,d])), groups=new Map(), aliases=new Map();
 for(const v of vehicles)for(const text of [v.key,v.plate,...String(v.other_plates||'').split(/[,;]/)]){
  const key=normalizedPlate(text);if(!key)continue;const set=aliases.get(key)||new Set();set.add(v.key);aliases.set(key,set);
 }
 const carFor=row=>{const window=vehicleObservationWindow(row,{stale_after_s:row.source==='uber'?45:150});
  if(!trustedVehicleObservation(row)||!Number.isFinite(window.observed)||window.observed>row.at||window.expires<=row.at)return null;
  const set=aliases.get(normalizedPlate(row.vehicle_label));return set?.size===1?[...set][0]:null;};
 for(const row of observations){
  const at=numberTime(row.observed_at),driver=driverMap.get(row.driver_id);
  if(!row.identity_id||!driver?.ludy_driver_code||!['uber','bolt'].includes(row.source)||!Number.isFinite(at)||at>now)continue;
  const inactive=['suspended','deactivated'].includes(row.evidence?.account_status);
  const rows=groups.get(row.identity_id)||[];rows.push({...row,status:inactive?'unknown':row.status,at,driver});groups.set(row.identity_id,rows);
 }
 const disconnects=[],connects=[];
 for(const rows of groups.values()){
  rows.sort((a,b)=>a.at-b.at);let previous=null;
  for(const row of rows){
   const gap=row.at-(previous?.at??-Infinity),ttl=row.source==='uber'?45000:150000;
   const interrupted=previous&&sourceEvents.some(e=>e.source===row.source&&e.status!=='healthy'&&numberTime(e.at)>=previous.at&&numberTime(e.at)<=row.at);
   if(previous&&!interrupted&&gap>0&&gap<=ttl&&previous.source===row.source&&previous.driver_id===row.driver_id){
    if(ONLINE.has(previous.status)&&row.status==='offline'){
     const car=carFor(previous);if(car)disconnects.push({vehicle_key:car,at:row.at,source:row.source,driver:row.driver,identity_id:row.identity_id});
    }else if(previous.status==='offline'&&ONLINE.has(row.status)){
     const car=carFor(row);if(car)connects.push({vehicle_key:car,at:row.at,source:row.source,driver:row.driver,identity_id:row.identity_id});
    }
   }
   if(!previous||row.at>previous.at)previous=row;
  }
 }
 return {disconnects,connects};
}

/** Pure reporting from authorized local records. Missing returns are not zeros. */
export function rotationReport({contracts=[],vehicles=[],agencies=[],drivers=[],observations=[],sourceEvents=[],from,to,params={},historyStatus=null,
 observationCoverageComplete=true,now=Date.now()}={}){
 if(!Number.isFinite(now))throw Object.assign(Error('Heure invalide'),{status:400});
 to=to||rotationLocalDay(now);from=from||new Date(Date.parse(to)-6*DAY).toISOString().slice(0,10);
 if(!dateValid(from)||!dateValid(to)||from>to||Date.parse(to)-Date.parse(from)>30*DAY||to>rotationLocalDay(now))throw Object.assign(Error('Période de rotation invalide : 31 jours maximum, sans date future.'),{status:400});
 const agencyMap=new Map(agencies.map(a=>[String(a.id),a])),vehicleMap=new Map(vehicles.map(v=>[v.key,v])),people=new Map();
 for(const d of drivers)if(d.ludy_driver_code){const rows=people.get(d.ludy_driver_code)||[];rows.push(d);people.set(d.ludy_driver_code,rows);}
 const driverName=code=>people.get(code)?.length===1?people.get(code)[0].name||code:code||'Chauffeur non identifié';
 const selected=new Map(),warnings=[],coverage={contracts_seen:contracts.length,contracts_usable:0,unknown_vehicles:0,invalid_contracts:0,conflicts:0,observation_coverage_complete:observationCoverageComplete};
 for(const c of contracts){
  if(!c.external_id||c.deleted)continue;
  const previous=selected.get(c.external_id),updated=numberTime(c.provider_updated_at)||numberTime(c.observed_at)||0,priorUpdated=numberTime(previous?.provider_updated_at)||numberTime(previous?.observed_at)||0;
  if(!previous||updated>priorUpdated||updated===priorUpdated&&c.end_at&&!previous.end_at)selected.set(c.external_id,c);
 }
 const byVehicle=new Map();
 for(const c of selected.values()){
  const start=numberTime(c.effective_start_at),end=numberTime(c.end_at),vehicle=vehicleMap.get(c.vehicle_key);
  if(!vehicle){coverage.unknown_vehicles++;continue;}
  if(!Number.isFinite(start)||start>now||c.end_at&&(!Number.isFinite(end)||end<start||end>now)){coverage.invalid_contracts++;continue;}
  const list=byVehicle.get(c.vehicle_key)||[];list.push({...c,start,end});byVehicle.set(c.vehicle_key,list);coverage.contracts_usable++;
 }
 const transitions=platformTransitions(observations,drivers,vehicles,now,sourceEvents),rows=[];
 for(const [vehicleKey,list] of byVehicle){
  const vehicle=vehicleMap.get(vehicleKey),agency=agencyMap.get(String(vehicle.agency_id)),city=agency?.city?.trim()||'Ville non renseignée';
  list.sort((a,b)=>a.start-b.start||String(a.external_id).localeCompare(String(b.external_id)));
  for(let index=0;index<list.length;index++){
   const old=list[index],next=list[index+1],hasReturn=Number.isFinite(old.end),reference=hasReturn?old.end:next?.start;
   if(!inPeriod(reference,from,to))continue;
   let status=hasReturn?'waiting':'unknown',returned=hasReturn?old.end:NaN,departed=NaN,reason=hasReturn?'Départ suivant non observé.':'Retour effectif non renseigné.',returnSource=hasReturn?'myclicar_actual_return':null,departureSource=null;
   if(next){
    if(next.start===old.start||hasReturn&&next.start<old.end){status='conflict';reason='Contrats simultanés ou départ suivant antérieur au retour.';coverage.conflicts++;}
    else if(hasReturn){status='measured';departed=next.start;departureSource='myclicar_actual_departure';reason=null;}
    else if(old.client_code&&next.client_code&&old.client_code!==next.client_code){
     const departures=transitions.connects.filter(t=>t.vehicle_key===vehicleKey&&t.driver.ludy_driver_code===next.client_code&&Math.abs(t.at-next.start)<=6*HOUR);
     const candidates=departures.flatMap(n=>transitions.disconnects.filter(p=>p.vehicle_key===vehicleKey&&p.driver.ludy_driver_code===old.client_code&&p.at>=old.start&&n.at>=p.at&&n.at-p.at<=6*HOUR).map(p=>({p,n})));
     if(candidates.length===1){returned=candidates[0].p.at;departed=candidates[0].n.at;status='estimated';returnSource='platform_disconnect';departureSource='platform_connect';reason='Estimation entre deux changements explicites de connexion ; présence à l’agence non confirmée.';}
     else if(candidates.length>1){reason='Plusieurs changements de connexion possibles : estimation refusée.';}
    }
   }
   if(Number.isFinite(returned)&&!inPeriod(returned,from,to))continue;
   const shift=shiftAt(Number.isFinite(returned)?returned:reference,params);
   rows.push({id:id([old.external_id,next?.external_id||null]),vehicle_key:vehicleKey,plate:vehicle.plate,agency_id:vehicle.agency_id??null,
    agency_name:agency?.name||'Agence non renseignée',city,...shift,previous_contract_id:old.external_id,next_contract_id:next?.external_id||null,
    previous_driver:driverName(old.client_code),next_driver:next?driverName(next.client_code):null,
    returned_at:iso(returned),departed_at:iso(departed),minutes:Number.isFinite(returned)&&Number.isFinite(departed)?round((departed-returned)/60000):null,
    waiting_minutes:status==='waiting'?round((now-returned)/60000):null,status,reason,return_source:returnSource,departure_source:departureSource});
  }
 }
 rows.sort((a,b)=>(numberTime(b.returned_at)||0)-(numberTime(a.returned_at)||0)||a.plate.localeCompare(b.plate));
 const groupMetrics=new Map(),batchMap=new Map();
 for(const row of rows){
  const key=String(row.agency_id);if(!groupMetrics.has(key))groupMetrics.set(key,{agency_id:row.agency_id,agency_name:row.agency_name,city:row.city,rows:[]});groupMetrics.get(key).rows.push(row);
  const batchKey=[row.agency_id,row.shift_day,row.shift].join('|');if(!batchMap.has(batchKey))batchMap.set(batchKey,{agency_id:row.agency_id,agency_name:row.agency_name,city:row.city,shift_day:row.shift_day,shift:row.shift,rows:[]});batchMap.get(batchKey).rows.push(row);
 }
 const batches=[...batchMap.values()].map(({rows:items,...batch})=>{
  const perVehicle=new Map();for(const row of items){const entries=perVehicle.get(row.vehicle_key)||[];entries.push(row);perVehicle.set(row.vehicle_key,entries);}
  const unique=new Set(perVehicle.keys()),complete=unique.size===items.length&&items.every(r=>r.status==='measured');
  // Repeated returns in one shift make the batch ambiguous. Count cars, not
  // successive handovers, so progress can never display more than its fleet.
  const certain=[...perVehicle.values()].filter(entries=>entries.length===1).map(entries=>entries[0]);
  const repeated=[...perVehicle.values()].filter(entries=>entries.length>1).length;
  const returns=items.filter(r=>r.return_source==='myclicar_actual_return').map(r=>numberTime(r.returned_at)).filter(Number.isFinite),departures=items.filter(r=>r.status==='measured').map(r=>numberTime(r.departed_at));
  const first=returns.length?Math.min(...returns):NaN,last=departures.length?Math.max(...departures):NaN;
  return {...batch,total_vehicles:unique.size,returned:new Set(items.filter(r=>r.return_source==='myclicar_actual_return').map(r=>r.vehicle_key)).size,
   departed:certain.filter(r=>r.status==='measured').length,pending:certain.filter(r=>r.status==='waiting').length,
   uncertain:repeated+certain.filter(r=>!['measured','waiting'].includes(r.status)).length,complete,first_return_at:iso(first),last_departure_at:iso(last),
   rotation_minutes:complete?round((last-first)/60000):null,mean_vehicle_minutes:metric(items).mean_minutes,
   coverage_note:repeated?'Plusieurs retours du même véhicule dans ce shift : lot à vérifier, sans rotation complète confirmée.':'Lot constitué des retours et changements de contrat observés ; les véhicules sans preuve de retour ne sont pas supposés rentrés.'};
 }).sort((a,b)=>b.shift_day.localeCompare(a.shift_day)||a.agency_name.localeCompare(b.agency_name));
 if(coverage.unknown_vehicles)warnings.push(`${coverage.unknown_vehicles} contrat(s) sans véhicule reconnu exclus des calculs.`);
 if(coverage.invalid_contracts)warnings.push(`${coverage.invalid_contracts} contrat(s) sans horaires effectifs cohérents exclus des calculs.`);
 if(coverage.conflicts)warnings.push(`${coverage.conflicts} rotation(s) contradictoire(s) à vérifier.`);
 if(batches.some(batch=>batch.coverage_note.startsWith('Plusieurs retours')))warnings.push('Plusieurs retours d’un même véhicule dans un shift : les lots concernés restent à vérifier.');
 if(!observationCoverageComplete)warnings.push('Historique des connexions partiel : certaines estimations ne sont pas disponibles.');
 if(rows.some(r=>r.city==='Ville non renseignée'))warnings.push('Complétez la ville des agences pour comparer les villes.');
 if(!historyStatus?.last_success_at)warnings.push('Historique des retours MyClicar pas encore synchronisé.');
 else if(historyStatus.status!=='healthy')warnings.push('Dernière synchronisation des retours indisponible ; résultats issus de la dernière lecture réussie.');
 return {at:iso(now),period:{from,to,timezone:'Africa/Casablanca'},summary:metric(rows),rows,
  agencies:[...groupMetrics.values()].map(({rows:items,...agency})=>({...agency,...metric(items),shifts:['Jour','Nuit'].map(shift=>({shift,...metric(items.filter(row=>row.shift===shift))}))})),batches,coverage,
  history:historyStatus?{status:historyStatus.status,last_success_at:historyStatus.last_success_at,from:historyStatus.from_at,to:historyStatus.to_at}:null,warnings};
}
