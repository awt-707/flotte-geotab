import {resolveBackendTarget} from './database-target.mjs';
import {moroccoDay} from './morocco-time.mjs';
import {readLocalJson} from './local-json.mjs';
import {retryDeadline,retryTimerDelay} from './provider-retry.mjs';
import {BoltClient,readBoltCredentials} from './bolt.mjs';
import {assertLocalSupabase,requestAllowed} from './fleet.mjs';
import {parseMyClicarLocalTime} from './myclicar-contracts.mjs';

const DAY=86400000,INTERVAL=15*60000,MAX_ROWS=20000,MAX_OBSERVATIONS=5000;
const STATES=new Set(['rider_cancelled','driver_did_not_respond','driver_rejected','rider_did_not_show','finished','driver_cancelled_after_accept']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail=(status,message)=>Object.assign(Error(message),{status});
const iso=value=>new Date(value).toISOString();
const valueOrNull=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return null;const day=value.slice(0,10);return iso(Date.parse(day)).slice(0,10)===day?iso(Date.parse(value)):null;};
const text=(value,max=160)=>typeof value==='string'&&value.trim().length<=max&&!/[\u0000-\u001f]/.test(value)?value.trim()||null:null;
const finite=(value,nonnegative=false)=>{if(value==null)return null;if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e9||nonnegative&&value<0)throw fail(502,'Une mesure Bolt est invalide. Lecture ignorée.');return value;};
export function performanceDay(at=Date.now()){return moroccoDay(at);}
function midnight(day){if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||iso(Date.parse(day)).slice(0,10)!==day)throw fail(400,'Dates invalides');const [y,m,d]=day.split('-');return Date.parse(parseMyClicarLocalTime(`${d}/${m}/${y} 00:00`));}
export function performancePeriod(from,to,now=Date.now()){
 const start=midnight(from),last=midnight(to),next=iso(Date.parse(to)+DAY).slice(0,10),end=Math.min(midnight(next),now);
 if(to>performanceDay(now)||last<start||end<=start||Date.parse(to)-Date.parse(from)>30*DAY)throw fail(400,'Choisir une période passée de 31 jours maximum.');
 return {from,to,from_at:iso(start),to_at:iso(end),timezone:'Africa/Casablanca'};
}
export function availableUberReportPeriods(rows,{now=Date.now()}={}){
 const periods=new Map();
 for(const row of rows){
  if(row.source!=='uber'||!['driver_activity','driver_quality'].includes(row.report_type))continue;
  const start=Date.parse(row.period_from),end=Date.parse(row.period_to);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end>now)continue;
  const from=performanceDay(start),to=performanceDay(end-1);let period;try{period=performancePeriod(from,to,now);}catch{continue;}
  if(Date.parse(period.from_at)!==start||Date.parse(period.to_at)!==end)continue;
  const key=from+'/'+to;if(!periods.has(key))periods.set(key,{from,to,organizations:new Set(),types:new Set()});const item=periods.get(key);
  item.organizations.add(row.organization_id);item.types.add(row.report_type);
 }
 return [...periods.values()].filter(p=>p.organizations.size===1&&[...p.organizations][0]).sort((a,b)=>b.to.localeCompare(a.to)||b.from.localeCompare(a.from))
  .map(p=>({from:p.from,to:p.to,report_types:[...p.types].sort()}));
}

/** Only documented financial/ride fields. Names, contacts, addresses, VINs and
 * cancellation free text never leave this normalization boundary. */
export function normalizeBoltPerformance(orders,{organizationId,identities,from,to,now=Date.now()}){
 if(!Array.isArray(orders)||orders.length>MAX_ROWS)throw fail(413,'Historique Bolt trop volumineux : réduire la période.');
 const known=new Map();for(const i of identities){if(i.source!=='bolt'||i.provisional||String(i.organization_id)!==String(organizationId)||!uuid(i.external_id)||!uuid(i.driver_id))continue;const key=i.external_id.toLowerCase(),prior=known.get(key);known.set(key,known.has(key)&&prior?.driver_id!==i.driver_id?null:{driver_id:i.driver_id,external_id:i.external_id});}
 const rows=[],seen=new Set(),counts={received:orders.length,imported:0,unmatched:0,outside_period:0};
 for(const order of orders){
  const external_id=text(order?.order_reference),identity=typeof order?.driver?.uuid==='string'?known.get(order.driver.uuid.toLowerCase()):null,driverId=identity?.driver_id;if(!external_id||seen.has(external_id)||!STATES.has(order?.status))throw fail(502,'Historique Bolt incohérent : aucune modification enregistrée.');seen.add(external_id);
  if(!driverId){counts.unmatched++;continue;}
  const requested_at=date(order.request_created_datetime);if(!requested_at)throw fail(502,'Date de demande Bolt manquante. Lecture ignorée.');
  if(Date.parse(requested_at)<Date.parse(from)||Date.parse(requested_at)>=Date.parse(to)){counts.outside_period++;continue;}
  const times={requested_at,accepted_at:date(order.driver_accepted_datetime),started_at:date(order.pickup_datetime),finished_at:date(order.finished_datetime)};
  for(const [raw,key] of [['driver_accepted_datetime','accepted_at'],['pickup_datetime','started_at'],['finished_datetime','finished_at']])if(order[raw]!=null&&!times[key])throw fail(502,'Horodatage Bolt invalide.');
  const chronology=Object.values(times).filter(Boolean).map(Date.parse);
  if(chronology.some((v,i)=>v>now+300000||i>0&&v<chronology[i-1]))throw fail(502,'Chronologie Bolt invalide.');
  const price=order.price??{},currencyValue=price.currency==null?null:text(price.currency,3);
  if(price.currency!=null&&(!currencyValue||!/^[A-Za-z]{3}$/.test(currencyValue))||price.total!=null&&!currencyValue)throw fail(502,'Devise Bolt non reconnue.');
  const currency=currencyValue?.toUpperCase()??null;
  if(order.stops!=null&&(!Array.isArray(order.stops)||order.stops.length>30))throw fail(502,'Arrêts Bolt invalides.');
  const stops=(order.stops||[]).filter(s=>['pickup','dropoff','waypoint'].includes(s?.type)&&typeof s.location?.lat==='number'&&Math.abs(s.location.lat)<=90&&typeof s.location?.lng==='number'&&Math.abs(s.location.lng)<=180).map(s=>({type:s.type,lat:s.location.lat,lng:s.location.lng,arrived_at:date(s.arrived_at_datetime),departed_at:date(s.departed_at_datetime)}));
  rows.push({source:'bolt',organization_id:String(organizationId),external_id,driver_id:driverId,provider_driver_id:identity.external_id,status:order.status,...times,
   distance_km:finite(order.total_ride_distance_km,true),passenger_distance_km:finite(order.pickup_to_dropoff_distance_km,true),duration_s:finite(order.ride_duration_seconds,true),pickup_duration_s:finite(order.pickup_duration_seconds,true),
   amount:finite(price.total),currency,tip_amount:finite(price.tip),booking_fee:finite(price.booking_fee),toll_fee:finite(price.toll_fee),cancellation_fee:finite(price.cancellation_fee),
   stops,is_optional:typeof order.is_optional==='boolean'?order.is_optional:null,detail_origin:'bolt_api',received_at:iso(now)});
 }
 counts.imported=rows.length;return {rows,counts};
}

function observationSummary(observations,{from,to,sourceEvents=[],maxGap=90000,truncated=false}){
 const bins={available:0,on_trip:0,to_pickup:0,on_break:0,offline:0},identities=new Map(),segments=[];
 for(const row of observations){if(!identities.has(row.identity_id))identities.set(row.identity_id,[]);identities.get(row.identity_id).push(row);}
 // Multiple identities may overlap. Only non-overlapping, consistently observed
 // intervals count; contradictory states are kept unknown instead of doubled.
 const candidates=[];for(const rows of identities.values()){rows.sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i],start=Math.max(Date.parse(a.observed_at),Date.parse(from)),end=Math.min(Date.parse(b.observed_at),Date.parse(to));
  if(end>start&&end-start<=maxGap&&a.status===b.status&&Object.hasOwn(bins,a.status)&&!sourceEvents.some(e=>e.status!=='healthy'&&Date.parse(e.at)>=start&&Date.parse(e.at)<=end))candidates.push({start,end,status:a.status});
 }}
 const marks=[...new Set(candidates.flatMap(i=>[i.start,i.end]))].sort((a,b)=>a-b);let pos=0,active=[];candidates.sort((a,b)=>a.start-b.start);
 for(let i=1;i<marks.length;i++){const start=marks[i-1],end=marks[i];while(pos<candidates.length&&candidates[pos].start<=start)active.push(candidates[pos++]);active=active.filter(x=>x.end>start);const states=new Set(active.filter(x=>x.end>=end).map(x=>x.status));if(states.size!==1)continue;const status=[...states][0];bins[status]+=(end-start)/1000;const last=segments.at(-1);if(last&&last.status===status&&last.to_at===iso(start))last.to_at=iso(end);else segments.push({status,from_at:iso(start),to_at:iso(end)});}
 const observed=Object.values(bins).reduce((a,b)=>a+b,0),working=bins.available+bins.on_trip+bins.to_pickup,online=working+bins.on_break;
 return {seconds:bins,observed_seconds:observed,period_seconds:(Date.parse(to)-Date.parse(from))/1000,online_observed_seconds:online,working_observed_seconds:working,utilization_observed:working>0?bins.on_trip/working:null,coverage_ratio:observed/((Date.parse(to)-Date.parse(from))/1000),segments:segments.slice(-600),segments_truncated:segments.length>600,truncated,kind:'sampled_observations'};
}
export function summarizeDriverPerformance({rides=[],observations=[],sourceEvents=[],period,source,coverage=[],officialSummaries=[],observationsTruncated=false}){
 const rows=rides.filter(r=>{const at=Date.parse(r.requested_at||r.started_at);return r.source===source&&at>=Date.parse(period.from_at)&&at<Date.parse(period.to_at);});
 const counts={total:rows.length,accepted:0,completed:0,rider_cancelled:0,driver_cancelled:0,cancelled_unspecified:0,rejected:0,unanswered:0,no_show:0,unknown:0};
 const currencies=new Map(),completed=rows.filter(r=>['finished','completed'].includes(r.status));
 for(const row of rows){if(row.accepted_at)counts.accepted++;if(['finished','completed'].includes(row.status))counts.completed++;else if(row.status==='rider_cancelled')counts.rider_cancelled++;else if(['driver_cancelled_after_accept','driver_cancelled'].includes(row.status))counts.driver_cancelled++;else if(row.status==='cancelled')counts.cancelled_unspecified++;else if(row.status==='driver_rejected')counts.rejected++;else if(row.status==='driver_did_not_respond')counts.unanswered++;else if(row.status==='rider_did_not_show')counts.no_show++;else counts.unknown++;
  if(/^[A-Z]{3}$/.test(row.currency||'')){if(!currencies.has(row.currency))currencies.set(row.currency,{currency:row.currency,total:0,known:0,missing:0,tips:0,tip_known:0,booking_fees:0,tolls:0,cancellation_fees:0,booking_fees_known:0,tolls_known:0,cancellation_fees_known:0});const c=currencies.get(row.currency);if(valueOrNull(row.amount)!==null){c.total+=row.amount;c.known++;}else c.missing++;if(valueOrNull(row.tip_amount)!==null){c.tips+=row.tip_amount;c.tip_known++;}for(const [key,target] of [['booking_fee','booking_fees'],['toll_fee','tolls'],['cancellation_fee','cancellation_fees']])if(valueOrNull(row[key])!==null){c[target]+=row[key];c[target+'_known']++;}}
 }
 const field=(key,list=completed)=>{const values=list.map(r=>valueOrNull(r[key])).filter(v=>v!==null);return {value:values.length?values.reduce((a,b)=>a+b,0):null,known:values.length,total:list.length,complete:values.length===list.length&&list.length>0};};
 const eligible=rows.filter(r=>r.is_optional===false&&(r.accepted_at||['driver_rejected','driver_did_not_respond'].includes(r.status))),accepted=eligible.filter(r=>r.accepted_at).length;
 const activity=observationSummary(observations,{from:period.from_at,to:period.to_at,sourceEvents,maxGap:source==='bolt'?150000:45000,truncated:observationsTruncated});
 const synced=coverage.length>0&&coverage.every(c=>c.covered_from&&Date.parse(c.covered_from)<=Date.parse(period.from_at)&&Date.parse(c.covered_to)>=Date.parse(period.to_at));
 const warnings=[];if(!synced)warnings.push('Historique partiel pour cette période. Les compteurs portent sur les courses reçues.');
 if(source==='uber')warnings.push('Uber : seules les données effectivement associées à cette fiche dans les rapports sont présentées.');
 warnings.push('Les heures de connexion, d’attente et de pause ci-dessous sont des durées observées par Ludy ; les interruptions de collecte restent inconnues.');
 if(observationsTruncated)warnings.push('Observation limitée aux 5 000 relevés les plus récents de la période.');
 const exactOfficial=officialSummaries.filter(r=>r.source===source&&Date.parse(r.period_from)===Date.parse(period.from_at)&&Date.parse(r.period_to)===Date.parse(period.to_at));
 const official=Object.fromEntries(['driver_activity','driver_quality'].map(type=>{const candidates=exactOfficial.filter(r=>r.report_type===type).sort((a,b)=>Date.parse(b.reported_at)-Date.parse(a.reported_at));return [type,new Set(candidates.map(r=>r.organization_id)).size===1?candidates[0]||null:null];}));
 const safeOfficial=row=>row?Object.fromEntries(['report_type','period_from','period_to','reported_at','trips_completed','online_seconds','trip_seconds','acceptance_rate','cancellation_rate','completion_rate','accepted_count','rejected_count','cancelled_count'].map(k=>[k,row[k]??null])):null;
 const points=rows.flatMap(r=>(r.stops||[]).map(s=>({lat:s.lat,lng:s.lng,type:s.type,at:s.arrived_at||r.started_at||r.requested_at,ride_id:r.external_id}))).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng));
 return {counts,money:[...currencies.values()],distance:field('distance_km'),passenger_distance:field('passenger_distance_km'),ride_seconds:field('duration_s'),pickup_seconds:field('pickup_duration_s'),
  acceptance:{value:eligible.length?accepted/eligible.length:null,accepted,denominator:eligible.length,kind:'calculated_nonoptional_requests',excluded:rows.length-eligible.length},activity,
  unavailable:{net_earnings:'Commissions, bonus et versement net non fournis par cet historique.',gross_earnings:'Le prix total des courses ne constitue pas un bilan de gains bruts.',earnings_per_hour:'Un revenu horaire nécessite les gains et les heures de connexion certifiés.',official_utilization:'L’API publique ne fournit pas cet indicateur officiel.',gps_track:'Les arrêts ne sont pas une trace GPS du trajet.'},
  official:{activity:safeOfficial(official.driver_activity),quality:safeOfficial(official.driver_quality),other_periods:officialSummaries.length-exactOfficial.length},
  coverage:{complete:synced,sync:coverage.map(c=>({organization_id:c.organization_id,status:c.status,covered_from:c.covered_from,covered_to:c.covered_to,last_success_at:c.last_success_at,last_error:c.last_error})),rows:rows.length,observations:observations.length},
  timeline:rows.sort((a,b)=>Date.parse(b.requested_at||b.started_at)-Date.parse(a.requested_at||a.started_at)).slice(0,300).map(r=>({id:r.external_id,status:r.status,requested_at:r.requested_at,accepted_at:r.accepted_at,started_at:r.started_at,finished_at:r.finished_at,amount:r.amount,currency:r.currency,distance_km:r.distance_km,duration_s:r.duration_s,stops:r.stops||[]})),timeline_truncated:rows.length>300,map_points:points.slice(0,1000),map_truncated:points.length>1000,warnings};
}

export function createDriverPerformanceApi({supabaseUrl,databaseTarget,serviceKey,anonKey,boltEnvPath,boltClient,fetchFn=fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 const base=resolveBackendTarget(supabaseUrl,databaseTarget),bolt=boltClient||new BoltClient({credentials:()=>readBoltCredentials(boltEnvPath),fetchFn,now});
 let timer=null,closed=false,generation=0,running=null,nextAt=0,backoff=INTERVAL,cooldownUntil=0;const lastRequested=new Map(),companyLastRead=new Map();
 const headers=token=>({apikey:token===serviceKey?serviceKey:anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json'});
 async function db(table,{params={},token=serviceKey,method='GET',body,prefer}={}){const r=await fetchFn(base+'/rest/v1/'+table+'?'+new URLSearchParams(params),{method,headers:{...headers(token),...(prefer?{Prefer:prefer}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw fail(502,'Historique local indisponible');return readLocalJson(r);}
 const pageKeys={fleet_drivers:['id'],fleet_identities:['id'],fleet_rides:['source','organization_id','external_id'],fleet_observations:['id'],fleet_source_events:['id'],fleet_driver_performance_sync:['source','organization_id','driver_id'],fleet_driver_report_summaries:['source','organization_id','driver_id','report_type','period_from','period_to']};
 async function list(table,params={},token=serviceKey,max=MAX_ROWS){
  const all=[],seen=new Set(),keys=pageKeys[table];if(!keys)throw fail(502,'Lecture locale non reconnue');
  const ordered=(params.order||'').split(',').filter(Boolean),fields={...params,order:[...ordered,...keys.filter(key=>!ordered.some(term=>term.split('.')[0]===key))].join(',')};if(params.select&&params.select!=='*')fields.select=[...new Set([...params.select.split(','),...keys])].join(',');
  for(let offset=0;offset<max;offset+=1000){const limit=Math.min(1000,max-offset),chunk=await db(table,{params:{...fields,limit:String(limit),offset:String(offset)},token});if(!Array.isArray(chunk)||chunk.length>limit)throw fail(502,'Lecture locale invalide');
   for(const row of chunk){if(keys.some(key=>row?.[key]==null))throw fail(502,'Identité de lecture manquante');const key=JSON.stringify(keys.map(k=>row[k]));if(seen.has(key))throw fail(502,'Historique modifié pendant la lecture. Actualisez la page.');seen.add(key);}
   all.push(...chunk);if(chunk.length<limit)return {rows:all,truncated:false};
  }return {rows:all,truncated:true};
 }
 async function auth(req){const token=String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];if(!token)throw fail(401,'Connexion Ludy requise');const response=await fetchFn(base+'/auth/v1/user',{headers:headers(token),redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw fail(401,'Session expirée');const user=await response.json();if(!uuid(user.id))throw fail(401,'Session invalide');const p=(await db('profiles',{token,params:{user_id:'eq.'+user.id,select:'role'}}))?.[0];if(!['admin','manager','viewer'].includes(p?.role))throw fail(403,'Accès flotte requis');return {token,role:p.role};}
 async function driver(a,id){if(!uuid(id))throw fail(400,'Choisir une fiche chauffeur');const rows=await db('fleet_drivers',{token:a.token,params:{id:'eq.'+id,select:'id,name,ludy_driver_code,vehicle_key,agency_id'}});if(rows.length!==1)throw fail(404,'Fiche chauffeur introuvable');return rows[0];}
 const serial=work=>{if(running)throw fail(409,'Une lecture Bolt est déjà en cours.');running=Promise.resolve().then(work).finally(()=>{running=null;});return running;};
 async function collect(company,identities,from,to){
  const own=generation;if(closed)throw fail(409,'Collecte de performance arrêtée.');
  const selected=identities.filter(i=>i.source==='bolt'&&!i.provisional&&String(i.organization_id)===String(company)&&uuid(i.external_id)&&uuid(i.driver_id));
  const byDriver=new Map();for(const i of selected){if(byDriver.has(i.driver_id)&&byDriver.get(i.driver_id).external_id!==i.external_id)throw fail(409,'Plusieurs identités Bolt pour une fiche : vérifier l’association.');byDriver.set(i.driver_id,i);}
  const unique=[...byDriver.values()];if(!unique.length)return {skipped:true};if(unique.length>1000)throw fail(413,'Trop de chauffeurs Bolt dans cette société.');
  if(now()<cooldownUntil||now()-(companyLastRead.get(String(company))||0)<60000)throw fail(429,'Lecture Bolt déjà demandée : prochain essai différé.');
  const at=iso(now());companyLastRead.set(String(company),now());try{
   const orders=await bolt.rides(Number(company),from,to,{driverUuids:unique.map(i=>i.external_id),maxRows:MAX_ROWS});
   if(closed||generation!==own)throw fail(409,'Collecte de performance arrêtée.');
   const normalized=normalizeBoltPerformance(orders,{organizationId:company,identities:unique,from,to,now:now()});
   const coverage=unique.map(i=>({driver_id:i.driver_id,provider_driver_id:i.external_id,from_at:from,to_at:to}));
   const result=await db('rpc/fleet_import_bolt_performance',{method:'POST',body:{p_org:String(company),p_rows:normalized.rows,p_coverage:coverage,p_at:iso(now())}});return {...result,counts:normalized.counts};
  }catch(e){if(closed||generation!==own)throw e;if(e.status===429)cooldownUntil=Math.max(cooldownUntil,retryDeadline(now(),Math.max(60,Number(e.retryAfter)||120),120));const safe=e.status&&e.status<500?e.message:e.message?.startsWith('Bolt ')?e.message:'Lecture de l’historique Bolt interrompue ; réessai automatique.';await db('fleet_driver_performance_sync',{method:'POST',params:{on_conflict:'source,organization_id,driver_id'},body:unique.map(i=>({source:'bolt',organization_id:String(company),driver_id:i.driver_id,status:'error',last_attempt_at:at,last_error:safe})),prefer:'resolution=merge-duplicates'}).catch(()=>{});throw e;}
 }
 async function automated(){
  const source=(await db('fleet_sources',{params:{id:'eq.bolt',select:'status'}}))?.[0];if(!source||source.status!=='healthy')return {skipped:true};
  const identityRead=await list('fleet_identities',{source:'eq.bolt',provisional:'eq.false',select:'driver_id,source,external_id,organization_id,provisional'});if(identityRead.truncated)throw fail(413,'Trop d’identités Bolt pour une lecture complète.');const identities=identityRead.rows;
  const companies=[...new Set(identities.map(i=>i.organization_id).filter(id=>/^[1-9][0-9]*$/.test(id||'')))];if(companies.length>20)throw fail(413,'Collecte Bolt limitée à vingt sociétés.');
  const syncRead=await list('fleet_driver_performance_sync',{source:'eq.bolt'});if(syncRead.truncated)throw fail(413,'Suivi de performance trop volumineux.');const sync=syncRead.rows;let imported=0,succeeded=0;const failures=[];
  for(const company of companies){if(closed)break;const until=now(),known=sync.filter(s=>s.organization_id===company&&s.last_success_at),newDriver=identities.some(i=>i.organization_id===company&&!known.some(s=>s.driver_id===i.driver_id)),cutoffs=known.map(s=>Date.parse(s.covered_to)).filter(Number.isFinite),start=!newDriver&&cutoffs.length?Math.max(until-31*DAY,Math.min(...cutoffs)-2*DAY):until-7*DAY;
   try{const result=await collect(company,identities,iso(start),iso(until));imported+=result.imported||0;succeeded++;}catch(error){failures.push(error);if(error.status===429||closed)break;}
  }if(failures.length&&(!succeeded||failures.at(-1).status===429))throw failures.at(-1);return {imported,failed_companies:failures.length};
 }
 function schedule(delay){if(closed)return;clearTimer(timer);nextAt=retryDeadline(now(),delay/1000,INTERVAL/1000);const arm=()=>{if(closed)return;timer=setTimer(()=>{timer=null;if(now()<nextAt){arm();return;}return tick();},retryTimerDelay(nextAt,now()));timer?.unref?.();};arm();}
 async function tick(){if(closed)return;if(running){schedule(60000);return;}try{await serial(automated);backoff=INTERVAL;}catch(e){const requested=Number.isFinite(e.retryAfter)&&e.retryAfter>0?e.retryAfter*1000:0;backoff=Math.max(INTERVAL,requested,Math.min(3600000,backoff*2));}finally{schedule(Math.max(backoff,cooldownUntil-now()));}}
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 async function handler(req,res){const u=new URL(req.url,'http://127.0.0.1:4173');if(!u.pathname.startsWith('/api/driver-performance/'))return false;
  try{if(!requestAllowed(req))throw fail(403,'Origine refusée');const a=await auth(req),path=u.pathname.slice('/api/driver-performance/'.length);
   if(path==='drivers'&&req.method==='GET'){const [drivers,identities]=await Promise.all([list('fleet_drivers',{select:'id,name,ludy_driver_code,agency_id,vehicle_key',order:'name,id'},a.token),list('fleet_identities',{select:'driver_id,source,provisional',source:'in.(uber,bolt)'},a.token)]);if(drivers.truncated||identities.truncated)throw fail(413,'Liste de chauffeurs trop volumineuse pour une lecture complète.');send(res,200,{drivers:drivers.rows.map(d=>({...d,sources:[...new Set(identities.rows.filter(i=>i.driver_id===d.id).map(i=>i.source))]})),can_sync:a.role==='admin'});return true;}
   if(path==='report-periods'&&req.method==='GET'){
    const d=await driver(a,u.searchParams.get('driver_id'));
    const reports=await list('fleet_driver_report_summaries',{driver_id:'eq.'+d.id,source:'eq.uber',select:'source,organization_id,period_from,period_to,report_type',order:'period_to.desc,period_from.desc'},a.token,1000);
    if(reports.truncated)throw fail(413,'Trop de périodes Uber pour une lecture complète. Choisissez les dates manuellement.');
    send(res,200,{driver_id:d.id,source:'uber',periods:availableUberReportPeriods(reports.rows,{now:now()})});return true;
   }
   if(path==='detail'&&req.method==='GET'){
    const d=await driver(a,u.searchParams.get('driver_id')),source=u.searchParams.get('source');if(!['bolt','uber'].includes(source))throw fail(400,'Plateforme invalide');const period=performancePeriod(u.searchParams.get('from'),u.searchParams.get('to'),now());
    const bounds=`(observed_at.gte.${period.from_at},observed_at.lt.${period.to_at})`,rideBounds=`(and(requested_at.gte.${period.from_at},requested_at.lt.${period.to_at}),and(requested_at.is.null,started_at.gte.${period.from_at},started_at.lt.${period.to_at}))`;
    const [rides,observations,events,coverage,identities,official]=await Promise.all([
     list('fleet_rides',{driver_id:'eq.'+d.id,source:'eq.'+source,or:rideBounds,order:'requested_at.desc.nullslast,external_id'},a.token),
     list('fleet_observations',{driver_id:'eq.'+d.id,source:'eq.'+source,and:bounds,select:'identity_id,status,observed_at',order:'observed_at.desc'},a.token,MAX_OBSERVATIONS),
     list('fleet_source_events',{source:'eq.'+source,and:`(at.gte.${period.from_at},at.lt.${period.to_at})`,select:'status,at',order:'at'},a.token,2000),
     list('fleet_driver_performance_sync',{driver_id:'eq.'+d.id,source:'eq.'+source},a.token),
     list('fleet_identities',{driver_id:'eq.'+d.id,source:'eq.'+source,select:'id,organization_id,provisional'},a.token),
     source==='uber'?list('fleet_driver_report_summaries',{driver_id:'eq.'+d.id,source:'eq.uber',order:'reported_at.desc'},a.token,1000).catch(()=>({rows:[],unavailable:true})):Promise.resolve({rows:[]})
    ]);if(rides.truncated)throw fail(413,'Trop de courses : réduire la période.');
    const summary=summarizeDriverPerformance({rides:rides.rows,observations:events.truncated?[]:observations.rows,sourceEvents:events.rows,period,source,coverage:coverage.rows,officialSummaries:official.rows,observationsTruncated:observations.truncated||events.truncated});
    if(official.truncated)summary.warnings.push('Les résumés officiels sont limités aux 1 000 dernières périodes reçues.');
    if(official.unavailable)summary.warnings.push('Résumés officiels Uber momentanément indisponibles.');
    if(identities.truncated||coverage.truncated||identities.rows.some(i=>!coverage.rows.some(c=>c.organization_id===i.organization_id))){summary.coverage.complete=false;if(!summary.warnings.some(w=>w.startsWith('Historique partiel')))summary.warnings.push('Historique partiel : une identité de plateforme reste sans couverture complète.');}
    send(res,200,{driver:d,source,period,...summary,can_sync:a.role==='admin'&&source==='bolt',automation:{interval_seconds:INTERVAL/1000,next_at:nextAt?iso(nextAt):null,running:!!running},documentation:'https://developer.bolt.eu/fleet-integration/main/'});return true;
   }
   if(path==='sync'&&req.method==='POST'){
    if(a.role!=='admin')throw fail(403,'Administrateur requis');let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>4096)throw fail(413,'Requête trop grande');chunks.push(chunk);}let input;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail(400,'Formulaire invalide');}if(!input||Array.isArray(input)||typeof input!=='object')throw fail(400,'Formulaire invalide');
    const d=await driver(a,input.driver_id),period=performancePeriod(input.from,input.to,now()),key=d.id;
    if(now()-(lastRequested.get(key)||0)<60000)throw fail(429,'Lecture déjà demandée. Patientez une minute.');
    const identities=(await list('fleet_identities',{driver_id:'eq.'+d.id,source:'eq.bolt',provisional:'eq.false',select:'driver_id,source,external_id,organization_id,provisional'},a.token)).rows;if(!identities.length)throw fail(409,'Aucune identité Bolt confirmée pour cette fiche');
    const results=await serial(async()=>{lastRequested.set(key,now());const out=[];for(const company of new Set(identities.map(i=>i.organization_id)))out.push(await collect(company,identities,period.from_at,period.to_at));return out;});send(res,200,{ok:true,results});return true;
   }throw fail(404,'Page introuvable');
  }catch(e){send(res,Number.isInteger(e.status)?e.status:500,{error:e.status&&e.status<500?e.message:e.message?.startsWith('Bolt ')?e.message:'Performance momentanément indisponible. Réessayez.'});}return true;
 }
 handler.resume=async()=>{closed=false;schedule(3000);return {scheduled:true};};handler.close=()=>{closed=true;generation++;clearTimer(timer);timer=null;nextAt=0;};handler.collect=()=>serial(automated);
 return handler;
}
