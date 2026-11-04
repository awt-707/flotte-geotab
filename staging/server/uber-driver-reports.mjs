import {parseDemandTime} from './demand-analytics.mjs';
import {parseUberReportTime} from './uber-report-time.mjs';

const fail=message=>Object.assign(Error(message),{status:400});
const fold=v=>String(v??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[_’'—–-]/g,' ').replace(/\s+/g,' ').trim();
const uuid=v=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const aliases={
 driver:['driver uuid','driver id','uuid du chauffeur','identifiant du chauffeur'],first:['driver first name','prenom du chauffeur','prenom chauffeur'],last:['driver last name','driver surname','nom du chauffeur','nom chauffeur'],
 trip:['trip uuid','trip id','uuid de la course','id de la course','identifiant de la course'],requested:['trip request time','heure de demande de course','heure de la demande de course','heure de demande','date et heure de la demande','date de demande de course','date et heure de demande de course'],
 status:['trip status','statut de la course','etat de la course','statut course'],finished:['trip drop off time','trip dropoff time','heure de fin de course','heure de fin de la course','heure de depose'],started:['trip begin time','trip start time','heure de debut de course'],
 vehicle:['vehicle uuid','uuid du vehicule','identifiant du vehicule'],plate:['license plate','vehicle plate number','immatriculation','plaque d’immatriculation','plaque d immatriculation'],
 distance:['trip distance','distance de la course','distance du trajet','trip distance (km)','trip distance (kilometers)','trip distance (miles)','distance du trajet (km)','distance de la course (km)'],distanceUnit:['distance unit','unite de distance'],
 trips:['trips completed','courses effectuees','courses terminees','nombre de courses terminees'],online:['temps passe en ligne (jours : heures : minutes)','time online (days : hours: minutes)','time online (days: hours : minutes)','time online (days:hours:minutes)','time online (hours)','hours online','temps en ligne (jours:heures:minutes)','heures en ligne'],
 onTrip:['temps passe a effectuer des courses (jours : heures : minutes)','time on trip (days: hours : minutes)','time on trip (days : hours: minutes)','time on trip (days:hours:minutes)','time on trip (hours)','hours on trip','temps en course (jours:heures:minutes)','heures en course'],
 acceptance:['acceptance rate','acceptance rate (%)','taux d acceptation','taux d acceptation (%)'],cancellation:['cancellation rate','cancellation rate (%)','taux d annulation','taux d annulation (%)'],completion:['pourcentage de courses effectuees','completion rate','completion rate (%)','taux de completion'],
 accepted:['courses acceptees (hors trip radar ou similaire)','trips accepted(excluding trip radar or similar)','trips accepted (excluding trip radar or similar)','courses acceptees'],rejected:['trips rejected','courses refusees'],cancelled:['trips cancelled','courses annulees']
};
function columns(header){const out={};for(const [key,names]of Object.entries(aliases)){const matches=header.map((v,i)=>names.some(n=>fold(n)===fold(v))?i:-1).filter(i=>i>=0);if(matches.length>1)throw fail('Colonnes chauffeur Uber ambiguës : '+key);out[key]=matches[0]??null;}return out;}
const cell=(row,index)=>index==null?'':String(row[index]??'').trim();
function number(value,{integer=false,max=1e9}={}){if(value==='')return null;if(!/^\d+(?:\.\d+)?$/.test(value))throw fail('Mesure Uber non reconnue : utiliser un nombre sans séparateur de milliers.');const n=Number(value);if(!Number.isFinite(n)||n>max||integer&&!Number.isSafeInteger(n))throw fail('Mesure Uber hors limites.');return n;}
function identity(row,c){const id=cell(row,c.driver).toLowerCase();if(id&&!uuid(id))throw fail('Identifiant chauffeur Uber invalide.');const first=cell(row,c.first),last=cell(row,c.last);const name=first&&last?first+' '+last:null;if(name&&(name.length>160||/[\u0000-\u001f]/.test(name)))throw fail('Nom chauffeur Uber invalide.');return {provider_driver_id:id||null,driver_name:name};}
function date(value,config,now){return value?parseUberReportTime(value,{date_format:config.date_format,csv_timezone:config.csv_timezone,now}):null;}
function duration(value,header,max){if(!value)return null;if(/days|jours/.test(fold(header))){const m=value.match(/^(\d+)\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})$/);if(!m||+m[2]>23||+m[3]>59)throw fail('Durée Uber attendue en jours:heures:minutes.');const n=+m[1]*86400+ +m[2]*3600+ +m[3]*60;if(n>max)throw fail('Durée Uber supérieure à la période.');return n;}return number(value,{max:max/3600})*3600;}
function ratio(value,header){if(!value)return null;const percent=value.endsWith('%')||String(header).includes('%'),n=number(value.replace(/%$/,'').trim(),{max:percent?100:1});return percent?n/100:n;}
export function normalizeUberDriverReport(grid,reportType,config,{period,now=Date.now(),allowBoundaryExclusions=false}={}){
 if(!Array.isArray(grid)||grid.length<1||grid.length>20001||!['trip_activity','driver_activity','driver_quality'].includes(reportType)||!period?.start_date||!period?.end_date)throw fail('Rapport chauffeur Uber invalide.');
 const c=columns(grid[0]),rows=[],seen=new Map(),counts={driver_rows:0,driver_duplicates:0,driver_excluded_status:0,distance_without_unit:0,driver_outside_request_period:0};
 const from_at=parseDemandTime(period.start_date+' 00:00',{now}),nextDay=new Date(Date.parse(period.end_date)+86400000).toISOString().slice(0,10),to_at=parseDemandTime(nextDay+' 00:00',{now}),max=(Date.parse(to_at)-Date.parse(from_at))/1000;
 if(reportType==='trip_activity'&&[c.trip,c.requested,c.status].some(v=>v==null))throw fail('Colonnes de courses Uber manquantes.');
 if(reportType!=='trip_activity'&&(c.driver==null&&(c.first==null||c.last==null)||c.trips==null))throw fail('Identité et nombre de courses du rapport chauffeur requis.');
 if(reportType==='driver_activity'&&(c.online==null||c.onTrip==null)||reportType==='driver_quality'&&(c.acceptance==null||c.cancellation==null))throw fail('Mesures du rapport chauffeur manquantes.');
 for(const raw of grid.slice(1)){
  const own=identity(raw,c);let entry,key;
  if(reportType==='trip_activity'){
   const state=fold(cell(raw,c.status)),states={completed:'completed',complete:'completed',finished:'completed',terminee:'completed',termine:'completed',effectuee:'completed',effectue:'completed','rider cancelled':'rider_cancelled','rider canceled':'rider_cancelled','driver cancelled':'driver_cancelled','driver canceled':'driver_cancelled',cancelled:'cancelled',canceled:'cancelled',annulee:'cancelled',annule:'cancelled','annulee par le passager':'rider_cancelled','annulee par le chauffeur':'driver_cancelled'};
   if(!states[state]){if(['reserved','failed','delivery failed','payment failed','fare split','in progress','requested','accepted','en cours','reservee','echec'].includes(state)){counts.driver_excluded_status++;continue;}throw fail('Statut du rapport chauffeur inconnu.');}
   const external_id=cell(raw,c.trip).toLowerCase();if(!uuid(external_id))throw fail('Identifiant de course Uber invalide.');
   const requested_at=date(cell(raw,c.requested),config,now);if(!requested_at)throw fail('Course Uber hors période demandée.');
   const started_at=date(cell(raw,c.started),config,now),finished_at=date(cell(raw,c.finished),config,now);if(started_at&&started_at<requested_at||finished_at&&finished_at<(started_at||requested_at))throw fail('Chronologie Uber incohérente.');
   if(requested_at<from_at||requested_at>=to_at){const crossing=requested_at<from_at&&Date.parse(requested_at)>=Date.parse(from_at)-86400000&&finished_at&&finished_at>=from_at&&finished_at<to_at;if(allowBoundaryExclusions&&(crossing||requested_at===to_at)){counts.driver_outside_request_period++;continue;}throw fail('Course Uber hors période demandée.');}
   const provider_vehicle_id=cell(raw,c.vehicle).toLowerCase()||null,vehicle_label=cell(raw,c.plate)||null;if(provider_vehicle_id&&!uuid(provider_vehicle_id)||vehicle_label&&(vehicle_label.length>40||/[\u0000-\u001f]/.test(vehicle_label)))throw fail('Véhicule du rapport Uber invalide.');
   const rawDistance=cell(raw,c.distance),distance=rawDistance?number(rawDistance,{max:1000000}):null,header=fold(grid[0][c.distance]||'');let unit=fold(cell(raw,c.distanceUnit));const headerUnit=header.includes('(km)')||header.includes('(kilometers)')?'km':header.includes('(miles)')?'miles':null;
   if(headerUnit&&unit&&unit!==headerUnit)throw fail('Unités de distance Uber contradictoires.');unit=headerUnit||unit;
   const distance_km=distance==null?null:['km','kilometers','kilometres'].includes(unit)?distance:['mile','miles','mi'].includes(unit)?distance*1.609344:['m','meters','metres'].includes(unit)?distance/1000:null;if(distance!==null&&distance_km===null)counts.distance_without_unit++;
   entry={...own,external_id,status:states[state],requested_at,started_at,finished_at,distance_km,provider_vehicle_id,vehicle_label};key=external_id;
  }else{
   entry={...own,trips_completed:number(cell(raw,c.trips),{integer:true,max:100000}),online_seconds:null,trip_seconds:null,acceptance_rate:null,cancellation_rate:null,completion_rate:null,accepted_count:null,rejected_count:null,cancelled_count:null};
   if(reportType==='driver_activity'){entry.online_seconds=duration(cell(raw,c.online),grid[0][c.online],max);entry.trip_seconds=duration(cell(raw,c.onTrip),grid[0][c.onTrip],max);if(entry.online_seconds!==null&&entry.trip_seconds!==null&&entry.trip_seconds>entry.online_seconds)throw fail('Temps en course supérieur au temps en ligne.');}
   else {for(const [key,col]of [['acceptance_rate','acceptance'],['cancellation_rate','cancellation'],['completion_rate','completion']])entry[key]=ratio(cell(raw,c[col]),grid[0][c[col]]);for(const [key,col]of [['accepted_count','accepted'],['rejected_count','rejected'],['cancelled_count','cancelled']])entry[key]=number(cell(raw,c[col]),{integer:true,max:100000});}
   key=own.provider_driver_id||own.driver_name?.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()||'unknown:'+rows.length;
  }
  const signature=JSON.stringify(entry);if(seen.has(key)){if(seen.get(key)!==signature)throw fail('Lignes Uber contradictoires pour une même identité.');counts.driver_duplicates++;continue;}seen.set(key,signature);rows.push(entry);
 }
 counts.driver_rows=rows.length;return {rows,counts,period:{from_at,to_at,start_date:period.start_date,end_date:period.end_date}};
}
