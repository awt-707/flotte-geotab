import {moroccoParts,moroccoWallTime} from './morocco-time.mjs';
import {createHash} from 'node:crypto';
import {createDemandCityReview} from './demand-city-review.mjs';

const DAY=86400000, HOUR=3600000, MAX_ROWS=20000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fault=message=>Object.assign(new Error(message),{status:400});
const clean=(value,max,required=false)=>{
  if(typeof value!=='string'||value.length>max*2)throw fault('Texte invalide dans le rapport.');
  const text=value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(text.length>max||required&&!text)throw fault('Champ manquant ou trop long dans le rapport.');return text;
};
const parts=moroccoParts;
const epoch=p=>Date.UTC(p.year,p.month-1,p.day,p.hour||0,p.minute||0,p.second||0);
function wallTime(p){
  const wall=epoch(p),check=new Date(wall);
  if(check.getUTCFullYear()!==p.year||check.getUTCMonth()+1!==p.month||check.getUTCDate()!==p.day||p.year<2000||p.year>2100||p.hour>23||p.minute>59||p.second>59)throw fault('Date ou heure invalide.');
  const at=moroccoWallTime(p);
  if(at===null)throw fault('Heure marocaine ambiguë ou inexistante : utiliser une date ISO avec son décalage UTC.');
  return new Date(at).toISOString();
}

/** Numeric Excel cells are wall times, never JavaScript milliseconds. Plain
 * local strings require an explicitly selected day/month/year convention. */
export function parseDemandTime(value,{date_format='ymd',date_system='1900',now=Date.now()}={}){
  if(!['ymd','dmy','mdy'].includes(date_format)||!['1900','1904'].includes(date_system))throw fault('Format de date non reconnu.');
  let result;
  if(typeof value==='number'){
    if(!Number.isFinite(value)||value<1||value>80000||date_system==='1900'&&Math.floor(value)===60)throw fault('Date Excel invalide.');
    const base=date_system==='1904'?Date.UTC(1904,0,1):Date.UTC(1899,11,30);
    const at=base+Math.round(value*86400)*1000,d=new Date(at);
    result=wallTime({year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:d.getUTCHours(),minute:d.getUTCMinutes(),second:d.getUTCSeconds()});
  }else{
    if(typeof value!=='string'||value.length>80)throw fault('Horodatage manquant ou invalide.');
    const text=value.trim();
    const explicit=text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i);
    if(explicit){
      const [,year,month,day,hour,minute,second='0']=explicit,p={year:+year,month:+month,day:+day,hour:+hour,minute:+minute,second:+second};
      const d=new Date(epoch(p));
      if(d.getUTCFullYear()!==p.year||d.getUTCMonth()+1!==p.month||d.getUTCDate()!==p.day||p.hour>23||p.minute>59||p.second>59)throw fault('Date ISO invalide.');
      const at=Date.parse(text.replace(' ','T'));if(!Number.isFinite(at))throw fault('Date ISO invalide.');result=new Date(at).toISOString();
    }else{
      const match=text.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if(!match)throw fault('Une date et une heure sont requises ; choisir le format des dates du fichier.');
      // A four-digit leading year is unambiguous, even when other rows use
      // the explicitly selected day/month convention. Never infer dmy vs mdy.
      const [,a,b,c,h,m,s='0']=match,p=a.length===4||date_format==='ymd'?{year:+a,month:+b,day:+c}:date_format==='dmy'?{year:+c,month:+b,day:+a}:{year:+c,month:+a,day:+b};
      result=wallTime({...p,hour:+h,minute:+m,second:+s});
    }
  }
  const at=Date.parse(result);if(at<Date.UTC(2000,0,1)||at>now+300000)throw fault('Le rapport contient une course future ou une date hors période admise.');return result;
}
const normalText=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();
export function demandCity(value){const text=normalText(value);if(['casablanca','casa'].includes(text))return 'Casablanca';if(['marrakech','marrakesh'].includes(text))return 'Marrakech';throw fault('Choisir Casablanca ou Marrakech.');}
function tripStatus(value){const status=normalText(value).replaceAll('_',' ').replaceAll('-',' ');if(['completed','complete','finished','terminee','termine','achevee','acheve','effectuee','effectue'].includes(status))return 'completed';if(['cancelled','canceled','annulee','annule'].includes(status))return 'cancelled';throw fault('État de course non reconnu : seules les courses terminées ou annulées sont importables.');}

export function normalizeDemandImport(input,{now=Date.now()}={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.rows)||!input.rows.length||input.rows.length>MAX_ROWS)throw fault('Le rapport doit contenir entre 1 et 20 000 lignes.');
  const agency_id=Number(input.agency_id);if(!Number.isSafeInteger(agency_id)||agency_id<=0)throw fault('Agence obligatoire.');
  const city=demandCity(input.city),file_name=clean(input.file_name,180,true);
  if(input.default_status!==undefined&&input.default_status!=='completed')throw fault('Confirmation du statut du rapport invalide.');
  const rows=[],seen=new Map(),counts={received:input.rows.length,imported:0,duplicates:0,completed:0,cancelled:0,derived_identifiers:0};
  const errors=[];
  input.rows.forEach((row,index)=>{
    try{
      if(!row||typeof row!=='object'||Array.isArray(row))throw fault('Ligne invalide.');
      const started_at=parseDemandTime(row.started_at,{date_format:input.date_format,date_system:input.date_system,now});
      const pickup_zone=clean(row.pickup_zone,160,true),status=tripStatus(row.status||input.default_status);
      if(row.external_id!=null&&row.external_id!==''&&typeof row.external_id!=='string'&&!(typeof row.external_id==='number'&&Number.isSafeInteger(row.external_id)))throw fault('L’identifiant de course doit être conservé en texte, sans arrondi Excel.');
      const supplied=row.external_id==null||row.external_id===''?'':clean(String(row.external_id),180,true);
      const external_id=supplied||'derived:'+hash([started_at,normalText(pickup_zone),status]);
      const ride_key=hash([agency_id,'uber',external_id]);
      const normalized={external_id,ride_key,started_at,pickup_zone,status};
      const signature=hash([city,started_at,normalText(pickup_zone),status]);
      if(seen.has(ride_key)){if(seen.get(ride_key)!==signature)throw fault('Un même identifiant de course porte des informations contradictoires.');counts.duplicates++;return;}
      seen.set(ride_key,signature);rows.push(normalized);counts[status]++;if(!supplied)counts.derived_identifiers++;
    }catch(error){if(errors.length<5)errors.push('Ligne '+(index+2)+' : '+error.message);}
  });
  if(errors.length)throw fault('Import refusé. '+errors.join(' '));
  counts.imported=rows.length;
  return {agency_id,city,file_name,rows,counts,fingerprint:hash([agency_id,city,rows.map(r=>[r.ride_key,r.started_at,r.pickup_zone,r.status]).sort((a,b)=>a[0].localeCompare(b[0]))])};
}

/** Describes the observed report, not market-wide demand or future earnings. */
export function analyzeDemand(input=[],{now=Date.now(),city,agency_id,cityReview=createDemandCityReview(null)}={}){
  const unique=new Map();let rejected=0,duplicates=0;
  for(const row of input){
    if(city&&row.city!==city||agency_id&&String(row.agency_id)!==String(agency_id))continue;
    const at=Date.parse(row.started_at),key=row.ride_key||hash([row.agency_id,row.city,row.external_id||[row.started_at,row.pickup_zone,row.status]]);
    if(!Number.isFinite(at)||at>now+300000||!['completed','cancelled'].includes(row.status)||typeof row.pickup_zone!=='string'||!row.pickup_zone.trim()){rejected++;continue;}
    if(unique.has(key)){duplicates++;continue;}unique.set(key,{...row,at});
  }
  const reviewed=cityReview.partition([...unique.values()]),rows=reviewed.included,completed=rows.filter(r=>r.status==='completed'),hours=Array.from({length:24},(_,hour)=>({hour,count:0,dates:new Set()})),weekdays=Array.from({length:7},(_,n)=>({weekday:n+1,count:0,dates:new Set()}));
  const dates=new Set(),zoneMap=new Map(),slots=new Map(),cityHours=new Map();
  for(const row of completed){
    const p=parts(row.at),date=[p.year,String(p.month).padStart(2,'0'),String(p.day).padStart(2,'0')].join('-'),weekday=(new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay()+6)%7+1;
    dates.add(date);hours[p.hour].count++;hours[p.hour].dates.add(date);weekdays[weekday-1].count++;weekdays[weekday-1].dates.add(date);
    const city=row.city||'Ville non renseignée',zoneKey=JSON.stringify([city,normalText(row.pickup_zone)]),slotKey=JSON.stringify([city,normalText(row.pickup_zone),p.hour]);
    if(!zoneMap.has(zoneKey))zoneMap.set(zoneKey,{city,zone:row.pickup_zone,count:0,dates:new Set()});const zone=zoneMap.get(zoneKey);zone.count++;zone.dates.add(date);
    if(!slots.has(slotKey))slots.set(slotKey,{city,zone:row.pickup_zone,hour:p.hour,count:0,dates:new Set()});const slot=slots.get(slotKey);slot.count++;slot.dates.add(date);
    if(!cityHours.has(city))cityHours.set(city,{dates:new Set(),hours:Array.from({length:24},(_,hour)=>({hour,count:0,dates:new Set()}))});const activity=cityHours.get(city);activity.dates.add(date);activity.hours[p.hour].count++;activity.hours[p.hour].dates.add(date);
  }
  const recommendations=[...slots.values()].filter(slot=>slot.count>=5&&slot.dates.size>=3).sort((a,b)=>b.count-a.count||a.hour-b.hour).slice(0,12).map(slot=>({city:slot.city,zone:slot.zone,hour:slot.hour,count:slot.count,observed_days:slot.dates.size,kind:'historical_activity',label:'Créneau fréquent dans les courses observées'}));
  const pause_windows=[];
  for(const [city,activity] of cityHours){
    const count=activity.hours.reduce((sum,h)=>sum+h.count,0);if(activity.dates.size<3||count<30)continue;
    // A zero-hour could be missing data. Only compare hours observed on >=3 days.
    const eligible=activity.hours.filter(h=>h.dates.size>=3).map(h=>({...h,average:h.count/h.dates.size}));if(eligible.length<3)continue;
    const sorted=eligible.sort((a,b)=>a.average-b.average||a.hour-b.hour),peak=sorted.at(-1).average;
    for(const h of sorted.slice(0,2)){if(h.average>=peak)continue;pause_windows.push({city,hour:h.hour,count:h.count,observed_days:h.dates.size,kind:'historical_quiet_window',label:'Moins de courses observées ; pause à organiser selon le service'});}
  }
  const warnings=['Ces résultats décrivent les courses importées, pas toute la demande de la ville. Une heure sans course peut correspondre à des données manquantes.'];
  if(dates.size<3||completed.length<30)warnings.push('Échantillon limité : importer plusieurs journées avant de retenir des créneaux opérationnels.');
  if(!recommendations.length)warnings.push('Pas encore de zone et créneau observés sur au moins 3 journées et 5 courses.');
  if(rejected)warnings.push(rejected+' ligne(s) incohérente(s) exclue(s) de l’analyse.');
  if(reviewed.coverage.quarantined)warnings.push(reviewed.coverage.quarantined+' course(s) conservée(s), mais exclue(s) des totaux, horaires et recommandations : ville à confirmer.');
  if(reviewed.coverage.changed)warnings.push('Des courses précédemment examinées ont changé ; un nouveau contrôle de leur ville est requis.');
  if(reviewed.coverage.status!=='loaded')warnings.push('Contrôle local des villes non chargé : les totaux décrivent les attributions importées, sans validation de leur ville.');
  const range=rows.reduce((range,row)=>[Math.min(range[0],row.at),Math.max(range[1],row.at)],[Infinity,-Infinity]);
  return {total:rows.length,completed:completed.length,cancelled:rows.length-completed.length,period:rows.length?{from:new Date(range[0]).toISOString(),to:new Date(range[1]).toISOString()}:null,
    coverage:{observed_days:dates.size,report_rows:unique.size,analyzed_rows:rows.length,city_review:reviewed.coverage,duplicates,rejected,sample_complete:false,timezone:'Africa/Casablanca'},
    by_hour:hours.map(h=>({hour:h.hour,count:h.count,observed_days:h.dates.size})),by_weekday:weekdays.map(d=>({weekday:d.weekday,count:d.count,observed_days:d.dates.size})),
    zones:[...zoneMap.values()].sort((a,b)=>b.count-a.count).slice(0,100).map(z=>({city:z.city,zone:z.zone,count:z.count,observed_days:z.dates.size})),recommendations,pause_windows,warnings};
}

export function normalizeRushRule(rule){
  if(!rule||typeof rule!=='object'||Array.isArray(rule))throw fault('Créneau invalide.');
  const agency_id=Number(rule.agency_id);if(!Number.isSafeInteger(agency_id)||agency_id<=0)throw fault('Agence obligatoire.');
  const city=demandCity(rule.city),validTime=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if(!validTime(rule.start)||!validTime(rule.end)||rule.start===rule.end)throw fault('Choisir des heures de début et de fin distinctes.');
  if(!Array.isArray(rule.days)||!rule.days.length||rule.days.length>7||rule.days.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(rule.days).size!==rule.days.length)throw fault('Choisir les jours du créneau.');
  if(typeof rule.enabled!=='boolean')throw fault('Activation du créneau invalide.');
  return {agency_id,city,days:[...rule.days].sort((a,b)=>a-b),start:rule.start,end:rule.end,enabled:rule.enabled,label:rule.label==null?'':clean(rule.label,100)};
}
export function rushActive(rule,now=Date.now()){
  if(!rule?.enabled)return false;let r;try{r=normalizeRushRule(rule);}catch{return false;}
  const p=parts(now),day=(new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay()+6)%7+1,previous=day===1?7:day-1,minute=p.hour*60+p.minute;
  const minutes=text=>Number(text.slice(0,2))*60+Number(text.slice(3)),start=minutes(r.start),end=minutes(r.end);
  return start<end?r.days.includes(day)&&minute>=start&&minute<end:r.days.includes(day)&&minute>=start||r.days.includes(previous)&&minute<end;
}
export function pauseSnapshot({rules=[],latest=[],sources=[],drivers=[],agencies=[],now=Date.now()}={}){
  const fresh=row=>{const source=sources.find(s=>s.id===row.source),at=Date.parse(row.observed_at),success=Date.parse(source?.last_success_at),ttl=Number(source?.stale_after_s)*1000;return source?.status==='healthy'&&ttl>0&&Number.isFinite(at)&&Number.isFinite(success)&&at<=now+5000&&success<=now+5000&&now-at<=ttl&&now-success<=ttl;};
  const active=rules.filter(rule=>rushActive(rule,now)),pauses=[];
  for(const row of latest){
    if(row.status!=='on_break'||!['bolt','uber'].includes(row.source)||!fresh(row))continue;
    const driver=drivers.find(d=>d.id===row.driver_id);if(!driver)continue;const agency=agencies.find(a=>String(a.id)===String(driver.agency_id));
    let city=null;try{city=demandCity(agency?.city);}catch{}
    const matching=city?active.filter(rule=>String(rule.agency_id)===String(driver.agency_id)&&rule.city===city):[];
    const other=latest.filter(other=>other.driver_id===row.driver_id&&other.source!==row.source&&fresh(other)&&['on_trip','to_pickup'].includes(other.status));
    pauses.push({identity_id:row.identity_id,driver_id:row.driver_id,driver_name:driver.name||'Chauffeur',agency_id:driver.agency_id,agency_name:agency?.name||'Agence',city,source:row.source,observed_at:row.observed_at,status:'on_break',rush:matching.length>0,cross_platform_activity:other.length>0,rules:matching.map(r=>({id:r.id,label:r.label||'',start:r.start,end:r.end,city:r.city})),message:other.length?'Pause déclarée sur cette plateforme ; activité observée sur une autre.':matching.length?'Pause plateforme observée pendant un rush : vérifier l’organisation du service.':'Pause déclarée par la plateforme.'});
  }
  return {at:new Date(now).toISOString(),active_rules:active,pauses,warnings:['Une pause plateforme ne prouve pas une pause du chauffeur. Un arrêt du véhicule ou une absence de données ne sont jamais assimilés à une pause.',...sources.filter(s=>['uber','bolt'].includes(s.id)&&(s.status!=='healthy'||now-Date.parse(s.last_success_at)>Number(s.stale_after_s)*1000)).map(s=>'Lecture '+(s.id==='uber'?'Uber':'Bolt')+' indisponible ou ancienne : pauses non confirmées.') ]};
}
