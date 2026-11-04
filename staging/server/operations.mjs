import {resolveBackendTarget} from './database-target.mjs';
import {readLocalJson} from './local-json.mjs';
import {assertLocalSupabase,requestAllowed} from './fleet.mjs';
import {normalizeDemandImport,analyzeDemand,normalizeRushRule,pauseSnapshot} from './demand-analytics.mjs';
import {rotationReport,rotationLocalDay} from './vehicle-rotations.mjs';
import {createEventCatalog} from './event-catalog.mjs';
import {createFuelCoach} from './fuel-coach.mjs';
import {createFuelReferenceService} from './fuel-reference.mjs';
import {pickupReferenceForScope} from './pickup-reference.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
const city=value=>['Casablanca','Marrakech'].includes(value);
export function createOperationsApi({supabaseUrl,databaseTarget,anonKey,serviceKey,fetchFn=fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,notify=async()=>({sent:false}),readFuelReport,demandCityReview}){
 const base=resolveBackendTarget(supabaseUrl,databaseTarget);
 const headers=token=>({apikey:token===serviceKey?serviceKey:anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json'});
 async function db(table,{params={},token=serviceKey,method='GET',body,prefer,timeout=15000}={}){
  const response=await fetchFn(base+'/rest/v1/'+table+'?'+new URLSearchParams(params),{method,headers:{...headers(token),...(prefer?{Prefer:prefer}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw fail(502,'Données locales momentanément indisponibles.');
  return readLocalJson(response);
 }
 async function list(table,params={},token=serviceKey,max=50000){const rows=[];for(let offset=0;offset<=max;offset+=1000){const part=await db(table,{params:{...params,limit:'1000',offset:String(offset)},token});if(!Array.isArray(part))throw fail(502,'Réponse locale invalide');rows.push(...part);if(rows.length>max)throw fail(413,'Période trop grande : réduisez les dates.');if(part.length<1000)return rows;}}
 async function auth(req){
  const token=String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];if(!token)throw fail(401,'Connexion Ludy requise');
  const response=await fetchFn(base+'/auth/v1/user',{headers:headers(token),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw fail(401,'Session expirée');const user=await response.json();
  if(!user.id)throw fail(401,'Session invalide');
  const profile=(await db('profiles',{token,params:{select:'role',user_id:'eq.'+user.id}}))?.[0];
  if(!['admin','manager','viewer'].includes(profile?.role))throw fail(403,'Accès exploitation refusé');return {token,user,role:profile.role};
 }
 const admin=a=>{if(a.role!=='admin')throw fail(403,'Administrateur requis');};
 const edit=a=>{if(!['admin','manager'].includes(a.role))throw fail(403,'Modification non autorisée');};
 async function agency(a,id){if(!Number.isSafeInteger(Number(id))||Number(id)<=0)throw fail(400,'Agence requise');const rows=await db('agencies',{token:a.token,params:{id:'eq.'+id,select:'id,name,city'}});if(!rows.length)throw fail(403,'Agence non autorisée');return rows[0];}
 async function body(req,max=65536){let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>max)throw fail(413,'Fichier trop volumineux');chunks.push(chunk);}try{const b=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b;}catch{throw fail(400,'Formulaire invalide');}}
 const events=createEventCatalog({db}),fuel=createFuelCoach({db,list,notify,now});
 const references=readFuelReport?createFuelReferenceService({db,list,readReport:readFuelReport,now,setTimer,clearTimer}):null;
 async function rotationObservations(report,contracts,drivers,from,to,token){
  const missing=new Set(report.rows.filter(row=>row.status==='unknown'&&row.next_contract_id).flatMap(row=>[row.previous_contract_id,row.next_contract_id]));
  const codes=new Set(contracts.filter(row=>missing.has(row.external_id)).map(row=>row.client_code).filter(Boolean));
  const ids=[...new Set(drivers.filter(row=>codes.has(row.ludy_driver_code)).map(row=>row.id))];
  if(!ids.length)return {observations:[],sourceEvents:[],complete:true};
  let complete=ids.length<=50;const tasks=ids.slice(0,50).flatMap(driver=>['uber','bolt'].map(source=>({driver,source}))),observations=[],deadline=Date.now()+3000;
  const bounds='(observed_at.gte.'+new Date(Date.parse(from)-21600000).toISOString()+',observed_at.lt.'+new Date(Date.parse(to)+86400000).toISOString()+')';
  // The existing (driver_id,source,observed_at) index bounds every read. A
  // global time sort with row-level checks times out on a populated history.
  await Promise.all(Array.from({length:Math.min(4,tasks.length)},async()=>{while(tasks.length){if(Date.now()>deadline){complete=false;return;}const {driver,source}=tasks.shift();try{
   const part=await db('fleet_observations',{token,timeout:3000,params:{select:'identity_id,driver_id,source,status,observed_at,vehicle_label,evidence',driver_id:'eq.'+driver,source:'eq.'+source,and:bounds,order:'observed_at.desc',limit:'200'}});
   if(!Array.isArray(part))throw Error('Invalid observations');if(part.length>=200)complete=false;observations.push(...part);
  }catch{complete=false;}}}));
  if(!observations.length)return {observations:[],sourceEvents:[],complete};
  try{
   const sourceEvents=await db('fleet_source_events',{token,timeout:3000,params:{select:'source,status,at',and:'(at.gte.'+new Date(Date.parse(from)-21600000).toISOString()+',at.lt.'+new Date(Date.parse(to)+86400000).toISOString()+')',order:'at.desc',limit:'2000'}});
   // A missing outage history cannot certify uninterrupted transitions.
   if(!Array.isArray(sourceEvents)||sourceEvents.length>=2000)return {observations:[],sourceEvents:[],complete:false};
   return {observations,sourceEvents,complete};
  }catch{return {observations:[],sourceEvents:[],complete:false};}
 }
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const handler=async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1:4173');if(!u.pathname.startsWith('/api/operations/')||u.pathname.startsWith('/api/operations/driver-'))return false;
  try{
   if(!requestAllowed(req))throw fail(403,'Origine refusée');const a=await auth(req),path=u.pathname.slice('/api/operations/'.length);
   if(req.method!=='GET')edit(a);
   if(path==='demand'&&req.method==='GET'){
    const params={};if(u.searchParams.has('agency_id')){await agency(a,u.searchParams.get('agency_id'));params.agency_id='eq.'+u.searchParams.get('agency_id');}
    if(u.searchParams.has('city')){if(!city(u.searchParams.get('city')))throw fail(400,'Ville invalide');params.city='eq.'+u.searchParams.get('city');}
    const [imports,rows,agencies]=await Promise.all([list('ops_demand_imports',{...params,order:'created_at.desc,id'},a.token),list('ops_demand_rides',{...params,order:'started_at,ride_key'},a.token),list('agencies',{select:'id,name,city'},a.token)]);
    send(res,200,{imports,summary:analyzeDemand(rows,{now:now(),cityReview:demandCityReview}),agencies,
     pickup_reference:pickupReferenceForScope({rides:rows,agencies,agencyId:u.searchParams.get('agency_id'),city:u.searchParams.get('city'),cityReview:demandCityReview})});return true;
   }
   if(path==='demand/import'&&req.method==='POST'){
    const input=await body(req,8000000);await agency(a,input.agency_id);const data=normalizeDemandImport(input,{now:now()});
    const result=await db('rpc/ops_import_demand',{method:'POST',body:{p_import:data,p_rows:data.rows}});send(res,200,{...result,counts:data.counts});return true;
   }
   if(path==='rush'&&req.method==='GET'){
    const [rules,agencies]=await Promise.all([list('ops_rush_rules',{order:'created_at,id'},a.token),list('agencies',{select:'id,name,city'},a.token)]);send(res,200,{rules,agencies});return true;
   }
   if(path==='rush'&&req.method==='POST'){
    const input=await body(req);let rule;
    if(input.id){if(!uuid(input.id))throw fail(400,'Règle invalide');const old=(await db('ops_rush_rules',{params:{id:'eq.'+input.id},token:a.token}))?.[0];if(!old)throw fail(404,'Règle introuvable');await agency(a,old.agency_id);rule=normalizeRushRule({...old,...input});await agency(a,rule.agency_id);await db('ops_rush_rules',{method:'PATCH',params:{id:'eq.'+input.id},body:rule});}
    else{rule=normalizeRushRule(input);await agency(a,rule.agency_id);await db('ops_rush_rules',{method:'POST',body:rule});}
    send(res,200,{ok:true});return true;
   }
   if(path==='pauses'&&req.method==='GET'){
    const [rules,latest,sources,drivers,agencies]=await Promise.all([list('ops_rush_rules',{},a.token),list('fleet_latest',{},a.token),list('fleet_sources',{select:'id,status,last_success_at,stale_after_s'}),list('fleet_drivers',{},a.token),list('agencies',{select:'id,name,city'},a.token)]);
    send(res,200,{at:new Date(now()).toISOString(),...pauseSnapshot({rules,latest,sources,drivers,agencies,now:now()})});return true;
   }
   if(path==='events'&&req.method==='GET'){
    const rows=await list('ops_events',{source_id:'eq.manual',order:'starts_at.desc,id'},a.token,5000);
    send(res,200,{events:rows,at:new Date(now()).toISOString(),manual_only:true});return true;
   }
   if(path==='events/refresh'&&req.method==='POST'){admin(a);throw fail(410,'La collecte automatique est arrêtée. Ajoutez les événements manuellement.');}
   if(path==='events/manual'&&req.method==='POST'){
    admin(a);send(res,200,await events.create(await body(req),a.user.id));return true;
   }
   const eventAction=path.match(/^events\/([0-9a-f-]{36})\/(update|delete)$/i);
   if(eventAction&&req.method==='POST'){
    admin(a);const input=await body(req);
    send(res,200,await events[eventAction[2]==='delete'?'remove':'update'](eventAction[1],input,a.user.id));return true;
   }
   if(path==='rotations'&&req.method==='GET'){
    const to=u.searchParams.get('to')||rotationLocalDay(now());if(!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(to)))throw fail(400,'Date de fin invalide');
    const from=u.searchParams.get('from')||new Date(Date.parse(to)-6*86400000).toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(to)<Date.parse(from)||Date.parse(to)-Date.parse(from)>30*86400000)throw fail(400,'Choisissez une période de 31 jours maximum');
    const scope={};if(u.searchParams.has('agency_id')){await agency(a,u.searchParams.get('agency_id'));scope.agency_id='eq.'+u.searchParams.get('agency_id');}
    const [history,active,vehicles,agencies,drivers,params,status]=await Promise.all([
     list('fleet_rotation_contracts',{...scope,order:'external_id'},a.token),list('fleet_myclicar_contracts',{...scope,order:'external_id'},a.token),list('vehicles',{...scope,select:'key,plate,other_plates,agency_id,active'},a.token),list('agencies',{select:'id,name,city'},a.token),
     list('fleet_drivers',{select:'id,ludy_driver_code,name,agency_id'},a.token),list('params',{key:'in.(shiftDay,shiftNight,shiftAdvance)'},a.token),list('fleet_rotation_sync',{},a.token)
    ]);
    const input={contracts:[...history,...active],vehicles,agencies,drivers,params,historyStatus:status?.[0],from,to,now:now()},measured=rotationReport(input);
    const historyReads=await rotationObservations(measured,input.contracts,drivers,from,to,a.token);
    send(res,200,rotationReport({...input,observations:historyReads.observations,sourceEvents:historyReads.sourceEvents,observationCoverageComplete:historyReads.complete}));return true;
   }
   if(path==='fuel'&&req.method==='GET'){
    const [settings,vehicles,reference_status]=await Promise.all([db('ops_fuel_settings',{token:a.token,params:{id:'eq.1'}}),list('vehicles',{select:'key,plate,agency_id,ref_l100,fuel_reference_evidence'},a.token),a.role==='admin'&&references?references.status():null]);const state=fuel.status();send(res,200,{settings:settings[0],vehicles,reference_status,status:a.role==='admin'?state:{at:state.at,error:state.error,missing_reference:vehicles.filter(v=>!v.ref_l100).length}});return true;
   }
   if(path==='fuel/settings'&&req.method==='POST'){
    admin(a);const b=await body(req);if(typeof b.enabled!=='boolean'||!Number.isFinite(b.excess_pct)||b.excess_pct<5||b.excess_pct>200||!Number.isFinite(b.min_distance_km)||b.min_distance_km<5||b.min_distance_km>100||!Number.isInteger(b.cooldown_minutes)||b.cooldown_minutes<15||b.cooldown_minutes>1440)throw fail(400,'Seuils de consommation invalides');
    await db('ops_fuel_settings',{method:'PATCH',params:{id:'eq.1'},body:{enabled:b.enabled,excess_pct:b.excess_pct,min_distance_km:b.min_distance_km,cooldown_minutes:b.cooldown_minutes}});send(res,200,{ok:true});return true;
   }
   if(path==='fuel/reference'&&req.method==='POST'){
    admin(a);const b=await body(req);if(typeof b.vehicle_key!=='string'||!Number.isFinite(b.ref_l100)||b.ref_l100<=0||b.ref_l100>100)throw fail(400,'Référence en L/100 km invalide');
    const saved=await db('vehicles',{method:'PATCH',params:{key:'eq.'+b.vehicle_key},body:{ref_l100:b.ref_l100,fuel_reference_evidence:{method:'manual',value:b.ref_l100,calculated_at:new Date(now()).toISOString()}},prefer:'return=representation'});if(!saved?.length)throw fail(404,'Véhicule introuvable');send(res,200,{ok:true});return true;
   }
   if(path==='fuel/calibrate'&&req.method==='POST'){
    admin(a);await body(req);if(!references)throw fail(503,'Calcul des références indisponible');
    void references.refresh().catch(()=>{});send(res,202,{ok:true});return true;
   }
   send(res,404,{error:'Route exploitation inconnue'});
  }catch(error){send(res,Number.isInteger(error.status)?error.status:500,{error:error.status&&error.status<500?error.message:'Exploitation momentanément indisponible. Réessayez.'});}
  return true;
 };
 handler.resume=async()=>{await references?.start();};handler.close=()=>references?.close();handler.onTelemetry=rows=>fuel.update(rows);return handler;
}
