import {sharedGeotabLive} from './shared-geotab.mjs';
import {resolveBackendTarget} from './database-target.mjs';
import { createUberPairing } from './uber-pairing.mjs';
import { createConnectorState } from './connector-state.mjs';
import { BoltClient, readBoltCredentials, saveBoltCredentials } from './bolt.mjs';
import {retryDeadline,retryTimerDelay} from './provider-retry.mjs';
import { createGeotabService } from './geotab-service.mjs';
import { createMyclicarService } from './myclicar-service.mjs';
import { readMyclicarCredentials } from './myclicar.mjs';
import { createValidationMonitor } from './validation.mjs';
import { createOfflineMotionService } from './offline-motion-service.mjs';
import { createDisconnectionService } from './platform-disconnection-service.mjs';
import { createDriverMatcher } from './driver-matching.mjs';
import { driverPlatformActivity } from './platform-activity.mjs';
import { conflictingVehicleAssignments } from './vehicle-evidence.mjs';
import { observedVehicleDrivers } from './observed-vehicle-drivers.mjs';
import { readGeotabCredentials } from './geotab.mjs';
import { effectiveState, historyIntervals, inSchedule, nextCounters, sourceKey, validTime, validateUberBatch } from './fleet-domain.mjs';

const PORT='4173', LOCAL_ORIGINS=new Set(['http://127.0.0.1:4173','http://localhost:4173']);
const eq=v=>'eq.'+v;
const query=o=>new URLSearchParams(o).toString();
function httpError(status,message){return Object.assign(new Error(message),{status});}
const DURATION_FIELDS='identity_id,driver_id,source,status,observed_at,offline_since,offline_samples,evidence';
function durationStates(latest,identities,sources,settings,at){
  const states=new Map(),allowed=settings?.enabled===true&&inSchedule(settings.schedule,at);
  for(const driverId of new Set([...latest,...identities].map(row=>row.driver_id))){
    const activity=driverPlatformActivity({driverId,latest,identities,sources,now:at});
    const rows=latest.filter(row=>row.driver_id===driverId&&activity.offline_sources.includes(row.source)&&row.status==='offline'&&!['deactivated','suspended'].includes(String(row.evidence?.account_status||'').toLowerCase()));
    // Each known account must actually have been observed across the threshold;
    // elapsed wall time alone cannot fill an unobserved interval.
    const ready=allowed&&activity.status==='offline'&&rows.length>0&&rows.every(row=>row.offline_samples>=2)&&
      Math.min(...rows.map(row=>Date.parse(row.observed_at)))-Date.parse(activity.offline_since)>=settings.offline_threshold_s*1000;
    states.set(driverId,{activity,rows,ready});
  }
  return states;
}
function durationAlertStatus(alert,state){
  if(alert.status==='resolved')return 'resolved';
  if(state?.activity.status==='online')return 'resolved';
  if(!state?.ready||Date.parse(alert.observed_since)!==Date.parse(state.activity.offline_since)||!state.rows.some(row=>row.identity_id===alert.identity_id))return 'suspended';
  return 'open';
}
export function assertLocalSupabase(value){const u=new URL(value);if(u.protocol!=='http:' || !['127.0.0.1','localhost'].includes(u.hostname) || u.port!=='57421' || u.username || u.password || u.pathname!=='/' || u.search || u.hash)throw new Error('Backend refusé : Supabase local :57421 obligatoire');return u.origin;}
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function bodyJson(req,max=65536){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>max)throw httpError(413,'Requête trop grande');parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString() || '{}');}catch{throw httpError(400,'JSON invalide');}}
export function requestAllowed(req,extension=false){
  const host=String(req.headers.host||'').toLowerCase();
  if(!['127.0.0.1:'+PORT,'localhost:'+PORT].includes(host))return false;
  const addr=req.socket?.remoteAddress;if(addr && !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(addr))return false;
  const origin=req.headers.origin;
  return !origin || LOCAL_ORIGINS.has(origin) || extension && /^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin);
}
export function createFleetApi({supabaseUrl,databaseTarget,sharedCollection=false,isCollectionActive=()=>true,serviceKey,anonKey,boltEnvPath,geotabCredentialsPath,myclicarCredentialsPath,uberPairingPath,connectorStatePath,validationPath,fetchFn=fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,Bolt=BoltClient,Geotab=createGeotabService,Myclicar=createMyclicarService,onGeotabTelemetry=async()=>{},onGeotabPositions=async()=>{},onGeotabState=()=>{},getTelemetryArchiveStatus=()=>null}){
  const base=resolveBackendTarget(supabaseUrl,databaseTarget);
  if(!serviceKey || !anonKey)throw new Error('Clés Supabase locales manquantes');
  const automation=createConnectorState({path:connectorStatePath});
  const tokenHeader=token=>({apikey:token===serviceKey?serviceKey:anonKey,Authorization:'Bearer '+token});
  async function db(table,{params={},method='GET',body,token=serviceKey,prefer}={}){
    const res=await fetchFn(base+'/rest/v1/'+table+'?'+query(params),{method,redirect:'error',headers:{...tokenHeader(token),'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw httpError(502,'Base locale indisponible ('+table+', HTTP '+res.status+')');
    if(res.status===204)return null;return res.json().catch(()=>null);
  }
  async function list(table,params={},token=serviceKey){const rows=[];for(let offset=0;offset<100000;offset+=1000){const part=await db(table,{params:{...params,limit:'1000',offset:String(offset)},token});if(!Array.isArray(part))throw httpError(502,'Réponse locale invalide');rows.push(...part);if(part.length<1000)return rows;}throw httpError(413,'Période trop grande');}
  const insert=(table,row)=>db(table,{method:'POST',body:row,prefer:'return=representation'});
  const upsert=(table,rows,onConflict)=>rows.length?db(table,{method:'POST',params:{on_conflict:onConflict},body:rows,prefer:'resolution=merge-duplicates,return=representation'}):Promise.resolve([]);
  const patch=(table,params,body)=>db(table,{method:'PATCH',params,body,prefer:'return=representation'});
  const validation=createValidationMonitor({filename:validationPath,list,now,setTimer,clearTimer});
  async function authenticate(req,admin=false){
    const m=String(req.headers.authorization||'').match(/^Bearer (\S+)$/);if(!m)throw httpError(401,'Connexion à Ludy staging requise');
    const token=m[1],res=await fetchFn(base+'/auth/v1/user',{headers:tokenHeader(token),redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!res.ok)throw httpError(401,'Session locale expirée');
    const user=await res.json();if(!user.id)throw httpError(401,'Session invalide');
    const profiles=await db('profiles',{params:{select:'user_id,role',user_id:eq(user.id)},token});const profile=profiles?.[0];
    if(!profile || !['admin','manager','viewer'].includes(profile.role))throw httpError(403,'Accès flotte non autorisé');
    if(admin && profile.role!=='admin')throw httpError(403,'Administrateur local requis');
    return {token,user,profile};
  }
  async function health(source,status,extra={}){
    if(source==='geotab'&&status!=='healthy')onGeotabState(status);
    const old=(await db('fleet_sources',{params:{id:eq(source),select:'status'}}))?.[0];
    await patch('fleet_sources',{id:eq(source)},{status,...extra});
    if(old?.status!==status)await insert('fleet_source_events',{source,status,at:new Date(now()).toISOString(),detail:extra.last_error || null});
    if(status!=='healthy'){
      await patch('fleet_alerts',{source:eq(source),status:'eq.open'},{status:'suspended',last_seen_at:new Date(now()).toISOString()});
      await patch('fleet_latest',{source:eq(source)},{offline_since:null,offline_samples:0,recovery_samples:0});
    }
  }
  const motion=createOfflineMotionService({db,list,patch,upsert,now});
  const matcher=createDriverMatcher({db,list,now});
  const disconnections=createDisconnectionService({db,list,now,setTimer,clearTimer,serialize:work=>serial(work)});
  const geotab=Geotab({db,list,patch,upsert,health,onLiveSnapshot:databaseTarget&&!sharedCollection?rows=>upsert('desktop_vehicle_live',rows,'vehicle_key'):null,credentialsPath:geotabCredentialsPath,fetchFn,now,
    onPositions:async(rows,source)=>{await onGeotabPositions(rows,source).catch(()=>{});if(matcher.error)throw new Error('Associations automatiques indisponibles');return motion.update(rows,source);},onTelemetry:onGeotabTelemetry,readMotion:motion.read});
  const myclicar=Myclicar({db,list,patch,health,credentialsPath:myclicarCredentialsPath,fetchFn,now,setTimer,clearTimer,
    afterInventorySync:()=>geotab.autoAssociate(),
    afterSync:()=>serial(async()=>{const result=await matcher.run({force:true});await disconnections.reconcile().catch(()=>{});return result;})});
  async function identity(source,row){
    const key=sourceKey(row.organizationId,row.sourceId,row.name);
    let id=(await db('fleet_identities',{params:{source:eq(source),source_key:eq(key)}}))?.[0];
    if(id)return id;
    const driver=(await insert('fleet_drivers',{name:row.name}))?.[0];
    if(!driver)throw httpError(502,'Création locale du chauffeur impossible');
    id=(await insert('fleet_identities',{driver_id:driver.id,source,source_key:key,external_id:row.sourceId || null,organization_id:row.organizationId || null,provisional:!row.sourceId}))?.[0];
    return id;
  }
  async function writeRows(source,rows){
    const src=(await db('fleet_sources',{params:{id:eq(source)}}))[0];
    const received=new Date(now()).toISOString();let added=0;
    for(const row of rows){
      const id=await identity(source,row),previous=(await db('fleet_latest',{params:{identity_id:eq(id.id)}}))?.[0];
      if(previous && Date.parse(previous.observed_at)>=Date.parse(row.readAt))continue;
      const evidence={...(row.evidence || {method:'visible_dom',raw_state:row.rawState || null,source_time_known:false}),
        ...(row.vehicleLabel&&row.vehicleModel?{vehicle_model:String(row.vehicleModel).slice(0,160)}:{}),
        ...(source==='uber'&&row.vehicleLabel?{vehicle_observed_at:row.vehicleReadAt||row.readAt,vehicle_status:row.vehicleState||row.state}:{})};
      const data={identity_id:id.id,driver_id:id.driver_id,source,status:row.state,observed_at:row.readAt,received_at:received,source_at:row.sourceAt || null,event_at:row.eventAt || null,vehicle_label:row.vehicleLabel || null,evidence};
      const continuity=src.status==='healthy'?previous:null;
      const counters=nextCounters(continuity,data,src.stale_after_s);
      await db('fleet_observations',{method:'POST',params:{on_conflict:'identity_id,observed_at'},body:data,prefer:'resolution=ignore-duplicates'});
      await upsert('fleet_latest',[{...data,...counters}],'identity_id');added++;
    }
    return added;
  }
  async function reconcileDurationAlerts(){
    // Run once after a complete, healthy batch and canonical identity reconciliation.
    const [latest,identities,sources,settingsRows,stored]=await Promise.all([
      list('fleet_latest',{select:DURATION_FIELDS}),list('fleet_identities',{select:'id,driver_id,source'}),
      list('fleet_sources',{select:'id,status,last_success_at,stale_after_s'}),db('fleet_settings',{params:{id:'eq.1'}}),
      list('fleet_alerts',{status:'in.(open,suspended)',order:'opened_at,id'})
    ]);
    const at=now(),received=new Date(at).toISOString(),settings=settingsRows?.[0],states=durationStates(latest,identities,sources,settings,at);
    const existing=stored.filter(alert=>alert.status==='open'||alert.status==='suspended'),chosen=new Map();
    for(const alert of existing){
      if(durationAlertStatus(alert,states.get(alert.driver_id))==='open'&&!chosen.has(alert.driver_id))chosen.set(alert.driver_id,alert);
    }
    // Retire old/duplicate episodes before reopening or inserting a current one,
    // preserving the database's one-open-alert-per-identity constraint.
    const changes=[];
    for(const alert of existing){
      let status=durationAlertStatus(alert,states.get(alert.driver_id));
      if(status==='open'&&chosen.get(alert.driver_id)!==alert)status='suspended';
      if(status===alert.status&&status!=='open')continue;
      changes.push({alert,status});
    }
    for(const {alert,status} of [...changes.filter(change=>change.status!=='open'),...changes.filter(change=>change.status==='open')])
      await patch('fleet_alerts',{id:eq(alert.id)},{status,last_seen_at:received,...(status==='resolved'?{resolved_at:received}:{})});
    for(const [driverId,state] of states){
      if(!state.ready||chosen.has(driverId))continue;
      const row=[...state.rows].sort((a,b)=>a.source.localeCompare(b.source)||a.identity_id.localeCompare(b.identity_id))[0];
      await db('fleet_alerts',{method:'POST',params:{on_conflict:'identity_id,observed_since'},prefer:'resolution=ignore-duplicates',body:{
        driver_id:driverId,identity_id:row.identity_id,source:row.source,observed_since:state.activity.offline_since,last_seen_at:received,threshold_s:settings.offline_threshold_s,
        rule:'Hors ligne sur toutes les plateformes connues ('+state.activity.offline_sources.map(source=>source==='uber'?'Uber':'Bolt').join(' et ')+') pendant au moins '+Math.round(settings.offline_threshold_s/60)+' min'+(settings.schedule?' dans le créneau configuré':' · aucun planning de service configuré')+'. Durée observée approximative ; aucune cause supposée.'
      }});
    }
  }
  // Serialized writes prevent duplicate provisional identities and out-of-order snapshots.
  let writeQueue=Promise.resolve();const serial=fn=>{const next=writeQueue.then(fn);writeQueue=next.catch(()=>{});return next;};
  const bolt=new Bolt({credentials:()=>readBoltCredentials(boltEnvPath),fetchFn,now});
  let boltBusy=null,boltNext=0,boltFailures=0,boltTimer=null,boltPolling=false,lastRides=0,boltGeneration=0,closed=false;
  async function refreshBolt(){
    if(boltBusy)return boltBusy;
    if(now()<boltNext)throw httpError(429,'Lecture Bolt déjà récente ou en attente ; réessayez dans '+Math.ceil((boltNext-now())/1000)+' s');
    boltBusy=(async()=>{
      const at=new Date(now()).toISOString(),generation=boltGeneration;
      try{
        if(!await readBoltCredentials(boltEnvPath))throw httpError(409,'Identifiants Bolt non configurés');
        await patch('fleet_sources',{id:'eq.bolt'},{last_attempt_at:at});
        const snap=await bolt.snapshot();
        const result=await serial(async()=>{
          if(generation!==boltGeneration)return {ok:true,ignored:true,polling:false};
          const count=await writeRows('bolt',snap.rows);
          if(generation!==boltGeneration)return {ok:true,ignored:true,polling:false};
          for(let i=0;i<snap.vehicles.length;i+=500)await upsert('fleet_provider_vehicles',snap.vehicles.slice(i,i+500),'source,organization_id,external_id');
          if(generation!==boltGeneration)return {ok:true,ignored:true,polling:false};
          await health('bolt','healthy',{last_success_at:snap.at,last_error:null,coverage:snap.coverage||{kind:'company_roster',drivers:snap.rows.length,vehicles:snap.vehicles.length,companies:snap.companies.length},metadata:{companies:snap.companies}});
          if(count)await matcher.run({force:true}).catch(()=>{});
          await reconcileDurationAlerts();
          await disconnections.reconcile().catch(()=>{});
          return {ok:true,source:'bolt',received_at:snap.at,observations:count,drivers:snap.rows.length,vehicles:snap.vehicles.length,companies:snap.companies.length};
        });
        if(generation!==boltGeneration)return {ok:true,ignored:true,polling:false};
        boltFailures=0;boltNext=now()+60000;return result;
      }catch(e){
        if(generation!==boltGeneration)return {ok:true,ignored:true,polling:false};
        boltFailures++;boltNext=retryDeadline(now(),Math.max(Number(e.retryAfter)||0,Math.min(900,30*2**Math.min(boltFailures,5))));
        const message=e.status===409?'Identifiants Bolt non configurés':e.name==='TimeoutError'?'Délai Bolt dépassé':/^Bolt |^Authentification Bolt|^Liste |^Réponse Bolt|^Quota Bolt|^Pagination Bolt|^Lecture Bolt|^Délai de lecture Bolt/.test(e.message)?e.message:'Connexion Bolt indisponible';
        await serial(async()=>{if(generation===boltGeneration)await health('bolt',e.status===409?'unconnected':'error',{last_error:message});});throw httpError(e.status || 502,message);
      }
    })().finally(()=>{boltBusy=null;});return boltBusy;
  }
  const boltState=()=>({polling:boltPolling,interval_s:60,next_attempt_at:boltPolling&&boltNext?new Date(Math.max(now(),boltNext)).toISOString():null,retrying:boltPolling&&boltFailures>0});
  function scheduleBolt(){
    if(!boltPolling||closed)return;
    clearTimer(boltTimer);const generation=boltGeneration;
    boltTimer=setTimer(async()=>{boltTimer=null;try{await refreshBolt();}catch{}finally{if(boltPolling&&generation===boltGeneration)scheduleBolt();}},retryTimerDelay(boltNext,now()));boltTimer?.unref?.();
  }
  async function startBolt(){
    if(boltPolling)return {ok:true,...boltState()};
    boltPolling=true;const generation=boltGeneration;let result;
    try{result=await refreshBolt();}catch{result={ok:false,retrying:true};}
    finally{if(boltPolling&&generation===boltGeneration)scheduleBolt();}
    return {...result,...boltState()};
  }
  async function stopBolt(){boltPolling=false;clearTimer(boltTimer);boltTimer=null;boltGeneration++;await serial(()=>health('bolt','paused',{last_error:null}));return {ok:true,...boltState()};}
  async function connectorIntent(id,enabled){
    const service=id==='bolt'?{start:startBolt,stop:stopBolt}:id==='myclicar'?myclicar:geotab;
    try{await automation.set(id,enabled);}catch(e){if(!enabled)await service.stop();throw e;}
    return enabled?service.start():service.stop();
  }
  const automationState=id=>({auto_resume:automation.enabled(id),automation_error:automation.error});
  async function refreshRides(body){
    if(now()-lastRides<60000)throw httpError(429,'Historique Bolt déjà demandé récemment');
    const companies=(await db('fleet_sources',{params:{id:'eq.bolt'}}))[0]?.metadata?.companies || [];
    const companyId=Number(body.company_id);if(!companies.some(c=>c.id===companyId))throw httpError(400,'Société Bolt non synchronisée');
    lastRides=now();const rides=await bolt.rides(companyId,body.from,body.to),saved=[];
    for(const r of rides){
      if(!r.order_reference)continue;
      const id=r.driver?.uuid?(await db('fleet_identities',{params:{source:'eq.bolt',source_key:eq(sourceKey(companyId,r.driver.uuid,''))}}))[0]:null;
      saved.push({source:'bolt',organization_id:String(companyId),external_id:r.order_reference,driver_id:id?.driver_id || null,status:r.status || null,started_at:validTime(r.pickup_datetime),finished_at:validTime(r.finished_datetime),distance_km:r.total_ride_distance_km ?? null,duration_s:r.ride_duration_seconds ?? null,amount:r.price?.total ?? null,currency:r.price?.currency || null,received_at:new Date(now()).toISOString()});
    }
    for(let i=0;i<saved.length;i+=500)await upsert('fleet_rides',saved.slice(i,i+500),'source,organization_id,external_id');
    return {ok:true,rides:saved.length};
  }
  const pairs=createUberPairing({path:uberPairingPath,now});
  async function verifyIngest(req){
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!token.startsWith('ludy_uber_'))return authenticate(req,true);
    const entry=await pairs.verify(token);if(!entry)throw httpError(401,'Code de liaison expiré ou invalide');
    // Revocation of the issuing local administrator also revokes the pair token.
    const profile=(await db('profiles',{params:{user_id:eq(entry.user),select:'role'}}))?.[0];if(profile?.role!=='admin'){await pairs.revokeUser(entry.user);throw httpError(403,'Liaison révoquée');}
    return entry;
  }
  async function overview(token,admin){
    const [sourceRows,drivers,latest,alerts,settings,identities,vehicleRows]=await Promise.all([list('fleet_sources',{order:'id'}),list('fleet_drivers',{order:'name,id'},token),list('fleet_latest',{order:'identity_id'},token),db('fleet_alerts',{params:{order:'opened_at.desc',limit:'500'},token}),db('fleet_settings',{params:{id:'eq.1'},token}),list('fleet_identities',{select:'id,driver_id,source'},token),list('vehicles',{select:'key,plate,other_plates,brand,model,agency_id,geotab_id,active'},token)]);
    const sourceById=Object.fromEntries(sourceRows.map(s=>[s.id,s]));
    const byDriver=new Map(),names=new Map(drivers.map(d=>[d.id,d.name]));
    for(const x of latest){const d=byDriver.get(x.driver_id)||{},state=effectiveState(x,sourceById[x.source],now());if(!d[x.source]||Date.parse(d[x.source].observed_at)<Date.parse(x.observed_at))d[x.source]=state;byDriver.set(x.driver_id,d);}
    const boltConfigured=!!await readBoltCredentials(boltEnvPath);
    const geotabConfigured=!!(geotabCredentialsPath&&await readGeotabCredentials(geotabCredentialsPath));
    const myclicarConfigured=!!(myclicarCredentialsPath&&await readMyclicarCredentials(myclicarCredentialsPath));
    const configured={bolt:boltConfigured,geotab:geotabConfigured,myclicar:myclicarConfigured};
    const running={bolt:boltPolling,geotab:geotab.polling,myclicar:myclicar.polling};
    const services={geotab,myclicar};
    const sources=sourceRows.map(s=>{
      const automated=['bolt','geotab','myclicar'].includes(s.id);
      const status=sharedCollection?(s.status==='healthy'&&(!s.last_success_at||now()-Date.parse(s.last_success_at)>s.stale_after_s*1000)?'stale':s.status):automated&&!configured[s.id]?'unconnected':automated&&!running[s.id]&&s.status!=='error'?'paused':s.status==='healthy'&&(!s.last_success_at||now()-Date.parse(s.last_success_at)>s.stale_after_s*1000)?'stale':s.status;
      return {...s,metadata:admin?(s.id==='geotab'?{database:s.metadata?.database}:s.metadata):{},coverage:admin?s.coverage:{kind:s.coverage?.kind,drivers:latest.filter(x=>x.source===s.id).length},status,
        configured:sharedCollection?s.status!=='unconnected':automated?configured[s.id]:s.status!=='unconnected',polling:sharedCollection?s.status==='healthy':automated?running[s.id]:false,collectionRemote:sharedCollection,
        ...(automated&&!sharedCollection?{...automationState(s.id),next_attempt_at:s.id==='bolt'?boltState().next_attempt_at:services[s.id].nextAttemptAt,retrying:s.id==='bolt'?boltState().retrying:services[s.id].retrying}:{})};
    });
    const duration=durationStates(latest,identities,sources,settings?.[0],now()),shown=new Set();
    const conflicts=conflictingVehicleAssignments({drivers,latest,sources:sourceRows,vehicles:vehicleRows,now:now()});
    return {at:new Date(now()).toISOString(),sources,vehicles:vehicleRows,drivers:drivers.map(d=>{const states=byDriver.get(d.id)||{},vehicle=Object.values(states).sort((a,b)=>Date.parse(b.evidence?.vehicle_observed_at||b.observed_at)-Date.parse(a.evidence?.vehicle_observed_at||a.observed_at)).find(x=>x.vehicle_label);return {...d,vehicle_label:vehicle?.vehicle_label||null,vehicle_model:vehicle?.evidence?.vehicle_model||null,vehicle_conflict:conflicts.has(d.vehicle_key)||d.vehicle_link_evidence?.assignment_conflict?.requires_confirmation===true,platform_activity:duration.get(d.id)?.activity||null,sources:states};}),
      vehicle_observations:observedVehicleDrivers({drivers,latest,vehicles:vehicleRows,sources,now:now()}),
      alerts:alerts.map(a=>{let status=durationAlertStatus(a,duration.get(a.driver_id));if(status==='open'){if(shown.has(a.driver_id))status='suspended';else shown.add(a.driver_id);}return {...a,driver_name:names.get(a.driver_id)||'Chauffeur',status};}),settings:settings?.[0] || null};
  }
  const handler=async(req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1:4173');if(!u.pathname.startsWith('/api/fleet/'))return false;
    const isIngest=u.pathname==='/api/fleet/uber/ingest',isCollectionStatus=u.pathname==='/api/fleet/uber/collection-status',isBridge=isIngest||isCollectionStatus;
    if(!requestAllowed(req,isBridge)){reply(res,403,{error:'Origine locale non autorisée'});return true;}
    if(isBridge && req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods',isCollectionStatus?'GET, OPTIONS':'POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Max-Age','300');}
    if(req.method==='OPTIONS'){if(isBridge){res.writeHead(204);res.end();}else reply(res,405,{error:'Méthode non autorisée'});return true;}
    try{
      if(isCollectionStatus){
        if(req.method!=='GET')throw httpError(405,'Méthode non autorisée');
        if(!/^Bearer ludy_uber_[A-Za-z0-9_-]{43}$/.test(String(req.headers.authorization||'')))throw httpError(401,'Liaison Uber requise');
        await verifyIngest(req);
        reply(res,200,{active:!closed&&isCollectionActive()===true});return true;
      }
      if(isIngest && req.method==='POST'){
        await verifyIngest(req);let batch;try{batch=validateUberBatch(await bodyJson(req),now());}catch(e){throw httpError(e.status || 400,e.message);}
        const result=await serial(async()=>{
          const at=new Date(now()).toISOString(),old=(await db('fleet_sources',{params:{id:'eq.uber'}}))[0];
          const other=old.metadata?.collector_id&&old.metadata.collector_id!==batch.collectorId;
          if(batch.status!=='observing'&&other)return {ok:true,ignored:true,reason:'collector_replaced'};
          const observed=Date.parse(batch.observedAt),previousObserved=Date.parse(old.metadata?.last_observed_at);
          // Browser clocks may be rounded: an explicit stop wins a same-timestamp reading.
          if(observed<previousObserved||observed===previousObserved&&(batch.status==='observing'||old.metadata?.last_batch_status==='stopped'))return {ok:true,ignored:true,reason:'stale_batch'};
          if(batch.status==='observing'&&other&&old.status==='healthy'&&now()-Date.parse(old.last_success_at)<=old.stale_after_s*1000)throw httpError(409,'Une autre fenêtre Uber assure déjà la collecte. Arrêtez-la avant de changer.');
          if(batch.status!=='observing'){
            await health('uber',batch.status==='stopped'?'paused':'error',{last_attempt_at:at,last_error:batch.status==='error'?'Lecture de l’écran interrompue':null,metadata:{...old.metadata,collector_id:batch.collectorId,last_observed_at:batch.observedAt,last_batch_status:batch.status}});return {ok:true,observations:0};
          }
          if(other||old.metadata?.organization_id&&old.metadata.organization_id!==batch.organizationId)await health('uber','paused',{last_error:null});
          try{
            const count=await writeRows('uber',batch.rows.map(r=>({...r,organizationId:batch.organizationId})));
            await health('uber','healthy',{last_success_at:at,last_attempt_at:at,last_error:null,coverage:{kind:batch.coverage?'list_sweep':'visible_rows_only',drivers:batch.rows.length,ambiguous:batch.ambiguous,...(batch.coverage?{complete:batch.coverage.complete&&batch.ambiguous===0,reason:batch.ambiguous?'ambiguous_identity':batch.coverage.reason,...(batch.coverage.vehicleObserved!==undefined?{vehicleObserved:batch.rows.filter(r=>r.vehicleLabel).length,vehicleComplete:batch.coverage.vehicleComplete===true&&batch.rows.every(r=>r.vehicleLabel)&&batch.ambiguous===0}:{})}:{})},metadata:{collector_id:batch.collectorId,organization_id:batch.organizationId,last_observed_at:batch.observedAt,last_batch_status:batch.status,source_time_known:false}});
            if(count)await matcher.run({force:true}).catch(()=>{});
            await reconcileDurationAlerts();
            await disconnections.reconcile().catch(()=>{});
            return {ok:true,observations:count,ambiguous:batch.ambiguous,received_at:at};
          }catch(error){await health('uber','error',{last_error:'Observations Uber non enregistrées ; reprise en attente.'});throw error;}
        });reply(res,200,result);return true;
      }
      const mutation=req.method!=='GET',auth=await authenticate(req,mutation);
      if(u.pathname==='/api/fleet/disconnections'&&req.method==='GET'){
        reply(res,200,await disconnections.read(auth.token,{admin:auth.profile.role==='admin'}));return true;
      }
      if(u.pathname==='/api/fleet/disconnections/settings'&&req.method==='POST'){
        const b=await bodyJson(req);
        if(!b||Array.isArray(b)||typeof b.enabled!=='boolean'||!['any','all'].includes(b.policy)||!['contract','shift'].includes(b.duty_mode))throw httpError(400,'Règle de déconnexion invalide');
        await serial(async()=>{await patch('fleet_settings',{id:'eq.1'},{disconnection_enabled:b.enabled,disconnection_policy:b.policy,duty_mode:b.duty_mode});await disconnections.reconcile().catch(()=>{});});
        reply(res,200,{enabled:b.enabled,policy:b.policy,duty_mode:b.duty_mode,...(disconnections.error?{warning:disconnections.error}:{})});return true;
      }
      if(u.pathname==='/api/fleet/validation/status'||u.pathname==='/api/fleet/validation/start'){
        if(auth.profile.role!=='admin')throw httpError(403,'Administrateur local requis');
        if(u.pathname.endsWith('/status')&&req.method==='GET'){reply(res,200,await validation.status());return true;}
        if(u.pathname.endsWith('/start')&&req.method==='POST'){await bodyJson(req);reply(res,200,await validation.start());return true;}
        reply(res,405,{error:'Méthode non autorisée'});return true;
      }
      if(u.pathname.startsWith('/api/fleet/myclicar/')){
        if(auth.profile.role!=='admin')throw httpError(403,'Administrateur local requis');
        const action=u.pathname.slice('/api/fleet/myclicar/'.length);
        if(action==='status'&&req.method==='GET'){reply(res,200,{...await myclicar.status(),...automationState('myclicar')});return true;}
        if(req.method==='POST'&&['connect','start','stop'].includes(action)){
          const data=await bodyJson(req);let result;
          if(action==='start'||action==='stop')result=await connectorIntent('myclicar',action==='start');
          else{
            let resumed;
            try{result=await myclicar.connect(data);}
            finally{if(automation.enabled('myclicar')&&!myclicar.polling){try{resumed=await myclicar.start();}catch{}}}
            if(resumed)result=resumed;
          }
          reply(res,200,{...result,...automationState('myclicar')});return true;
        }
        reply(res,404,{error:'Route MyClicar inconnue'});return true;
      }
      if(u.pathname.startsWith('/api/fleet/geotab/')){
        const action=u.pathname.slice('/api/fleet/geotab/'.length);
        if(action==='live'&&req.method==='GET'){
          if(sharedCollection){
            const [sources,vehicles,positions,snapshots,alerts]=await Promise.all([db('fleet_sources',{params:{id:'eq.geotab'}}),list('vehicles',{select:'key,plate,geotab_id'},auth.token),list('live_status',{select:'vehicle_key,state,speed,since_min,last_pos_at,lat,lon,ign_on,updated_at'},auth.token),list('desktop_vehicle_live',{select:'vehicle_key,data,observed_at'},auth.token),motion.read(auth.token)]);
            reply(res,200,sharedGeotabLive({source:sources[0],vehicles,positions,snapshots,motion:alerts,now:now()}));
          }else reply(res,200,await geotab.live(auth.token));return true;
        }
        if(['history','detail','report'].includes(action)&&req.method==='GET'){
          if(sharedCollection)throw httpError(409,'Ouvrez cette vue sur le poste qui collecte Geotab.');
          reply(res,200,await geotab[action](auth.token,Object.fromEntries(u.searchParams)));return true;
        }
        if(auth.profile.role!=='admin')throw httpError(403,'Administrateur local requis');
        if(action==='status'&&req.method==='GET'){reply(res,200,{...await geotab.status(),...automationState('geotab'),telemetry_archive:getTelemetryArchiveStatus()});return true;}
        if(req.method==='POST'&&['connect','devices','link','start','stop'].includes(action)){
          const data=await bodyJson(req);let result;
          if(action==='start'||action==='stop')result=await connectorIntent('geotab',action==='start');
          else {
            let resumed;
            try{result=await geotab[action](data);if(action==='devices'){await geotab.autoAssociate();result=await geotab.status();}}
            finally{
              if(['connect','link'].includes(action)&&automation.enabled('geotab')&&!geotab.polling){
                // A local write may fail after pausing; keep recovery armed while preserving that error.
                try{resumed=await geotab.start();}catch{}
              }
            }
            if(resumed)result=resumed;
          }
          reply(res,200,{...result,...automationState('geotab')});return true;
        }
        reply(res,404,{error:'Route Geotab inconnue'});return true;
      }
      if(u.pathname==='/api/fleet/overview' && req.method==='GET'){reply(res,200,await overview(auth.token,auth.profile.role==='admin'));return true;}
      if(u.pathname==='/api/fleet/drivers/matches'&&req.method==='GET'){
        if(auth.profile.role!=='admin')throw httpError(403,'Administrateur local requis');
        reply(res,200,await matcher.review());return true;
      }
      if(u.pathname==='/api/fleet/drivers/match'&&req.method==='POST'){
        reply(res,200,await serial(()=>matcher.run({force:true})));return true;
      }
      if(u.pathname==='/api/fleet/history' && req.method==='GET'){
        const id=u.searchParams.get('driver_id'),from=validTime(u.searchParams.get('from')) || new Date(now()-86400000).toISOString(),to=validTime(u.searchParams.get('to')) || new Date(now()).toISOString();
        if(!id || !/^[0-9a-f-]{36}$/i.test(id) || Date.parse(to)<=Date.parse(from) || Date.parse(to)-Date.parse(from)>31*86400000 || Date.parse(to)>now()+60000)throw httpError(400,'Chauffeur et période de 31 jours maximum requis');
        const drivers=await db('fleet_drivers',{params:{id:eq(id)},token:auth.token});if(!drivers?.length)throw httpError(404,'Chauffeur introuvable');
        const [sources,observations,events]=await Promise.all([list('fleet_sources',{order:'id'}),list('fleet_observations',{driver_id:eq(id),observed_at:'gte.'+new Date(Date.parse(from)-3600000).toISOString(),and:'(observed_at.lte.'+to+')',order:'observed_at,id'},auth.token),list('fleet_source_events',{at:'gte.'+new Date(Date.parse(from)-3600000).toISOString(),order:'at,id'},auth.token)]);
        const present=new Set(observations.map(x=>x.source));reply(res,200,{driver:drivers[0],from,to,observations,intervals:historyIntervals(observations,sources.filter(s=>present.has(s.id)),events,from,to),approximate:true});return true;
      }
      if(u.pathname==='/api/fleet/pair' && req.method==='POST'){reply(res,200,await pairs.issue(auth.user.id));return true;}
      if(u.pathname==='/api/fleet/pair/revoke'&&req.method==='POST'){await pairs.revokeUser(auth.user.id);await serial(()=>health('uber','paused',{last_error:'Liaison révoquée par un administrateur.'}));reply(res,200,{ok:true});return true;}
      if(u.pathname==='/api/fleet/bolt/config'){
        if(auth.profile.role!=='admin')throw httpError(403,'Administrateur local requis');
        if(req.method==='GET'){reply(res,200,{configured:!!await readBoltCredentials(boltEnvPath)});return true;}
        if(req.method==='POST'){
          if(boltPolling||boltBusy||!sharedCollection&&automation.enabled('bolt'))throw httpError(409,'Arrêtez le suivi Bolt sur ce poste avant de modifier ses accès.');
          await saveBoltCredentials(boltEnvPath,await bodyJson(req));bolt.resetCredentials?.();boltNext=0;boltFailures=0;
          reply(res,200,{configured:true});return true;
        }
        throw httpError(405,'Méthode non autorisée');
      }
      if(u.pathname==='/api/fleet/bolt/refresh' && req.method==='POST'){reply(res,200,await refreshBolt());return true;}
      if(u.pathname==='/api/fleet/bolt/start' && req.method==='POST'){
        reply(res,200,{...await connectorIntent('bolt',true),...automationState('bolt')});return true;
      }
      if(u.pathname==='/api/fleet/bolt/stop' && req.method==='POST'){reply(res,200,{...await connectorIntent('bolt',false),...automationState('bolt')});return true;}
      if(u.pathname==='/api/fleet/bolt/rides' && req.method==='POST'){reply(res,200,await refreshRides(await bodyJson(req)));return true;}
      if(u.pathname==='/api/fleet/rides' && req.method==='GET'){reply(res,200,{rides:await list('fleet_rides',{order:'started_at.desc.nullslast,external_id'},auth.token)});return true;}
      if(u.pathname==='/api/fleet/settings' && req.method==='POST'){
        const b=await bodyJson(req);if(!Number.isInteger(b.offline_threshold_s)||b.offline_threshold_s<60||b.offline_threshold_s>86400)throw httpError(400,'Seuil : 60 à 86400 secondes');
        if(b.schedule){if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.schedule.start||'')||! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.schedule.end||'')||!Array.isArray(b.schedule.days)||b.schedule.days.some(x=>!Number.isInteger(x)||x<0||x>6))throw httpError(400,'Créneau invalide');try{inSchedule(b.schedule,now());}catch{throw httpError(400,'Fuseau invalide');}}
        await patch('fleet_settings',{id:'eq.1'},{offline_threshold_s:b.offline_threshold_s,schedule:b.schedule || null,enabled:b.enabled!==false});reply(res,200,{ok:true});return true;
      }
      if(u.pathname==='/api/fleet/drivers/link' && req.method==='POST'){
        const b=await bodyJson(req);if(!/^[0-9a-f-]{36}$/i.test(b.driver_id||''))throw httpError(400,'Chauffeur invalide');
        if(b.vehicle_mode!==undefined&&!['automatic','manual'].includes(b.vehicle_mode))throw httpError(400,'Mode d’affectation invalide');
        const automatic=b.vehicle_mode==='automatic';
        if(!('ludy_driver_code' in b) || b.ludy_driver_code!==null && (typeof b.ludy_driver_code!=='string'||!b.ludy_driver_code.trim()||b.ludy_driver_code.length>120))throw httpError(400,'Code du chauffeur Ludy requis (null pour délier)');
        if(automatic&&(!b.ludy_driver_code||b.vehicle_key!=null))throw httpError(400,'Le mode automatique demande une fiche Ludy et détermine lui-même le véhicule');
        if(b.ludy_driver_code){const baseDriver=await db('drivers',{params:{code:eq(b.ludy_driver_code),select:'code,agency_id'}});if(!baseDriver?.length)throw httpError(400,'Chauffeur Ludy introuvable');}
        if('vehicle_key' in b&&b.vehicle_key!==null&&(typeof b.vehicle_key!=='string'||!b.vehicle_key||b.vehicle_key.length>120))throw httpError(400,'Véhicule invalide');
        const canonical=await serial(async()=>{
          const current=(await db('fleet_drivers',{params:{id:eq(b.driver_id)}}))?.[0];if(!current)throw httpError(404,'Chauffeur introuvable');
          if(automatic){
            const canonical=await db('rpc/fleet_link_driver_automatic',{method:'POST',body:{p_driver:b.driver_id,p_ludy_code:b.ludy_driver_code,p_agency_id:b.agency_id||null}});
            await matcher.run({force:true}).catch(()=>{});
            return canonical;
          }
          const target=b.ludy_driver_code?(await db('fleet_drivers',{params:{ludy_driver_code:eq(b.ludy_driver_code)}}))?.[0]:null;
          const vehicle='vehicle_key' in b?b.vehicle_key:target?.vehicle_key||current.vehicle_key||null;
          if(vehicle){
            const row=(await db('vehicles',{params:{key:eq(vehicle),select:'key,agency_id'}}))?.[0];if(!row)throw httpError(400,'Véhicule introuvable');
            const agency=b.ludy_driver_code?(await db('drivers',{params:{code:eq(b.ludy_driver_code),select:'agency_id'}}))?.[0]?.agency_id:current.agency_id;
            if(agency!=null&&String(agency)!==String(row.agency_id))throw httpError(400,'Choisissez un véhicule de la même agence que le chauffeur.');
            const assigned=await db('fleet_drivers',{params:{vehicle_key:eq(vehicle),select:'id'}});
            if(assigned.some(d=>d.id!==current.id&&d.id!==target?.id))throw httpError(409,'Ce véhicule est déjà affecté à un autre chauffeur. Retirez d’abord cette affectation.');
          }
          return db('rpc/fleet_link_driver',{method:'POST',body:{p_driver:b.driver_id,p_ludy_code:b.ludy_driver_code,p_vehicle_key:vehicle,p_agency_id:b.agency_id||null}});
        });
        const rows=await db('fleet_drivers',{params:{id:eq(canonical)}});reply(res,200,{ok:true,driver_id:canonical,drivers:rows,...(automatic?{automatic:true,association_pending:!!matcher.error}: {})});return true;
      }
      reply(res,404,{error:'Route inconnue'});
    }catch(e){reply(res,e.status || 500,{error:e.status?e.message:'Traitement local impossible'});}
    return true;
  };
  // Share the existing pairing verifier: one private token store and the same
  // administrator revocation checks for live observations and report imports.
  handler.authorizeUberReport=verifyIngest;
  handler.boltClient=bolt;
  handler.geotabZones=()=>geotab.zones();
  handler.geotabFuelReport=async input=>{
    if(!geotab.polling||closed)throw httpError(409,'Suivi Geotab en pause');
    return geotab.report(serviceKey,input);
  };
  handler.resume=async()=>{
    const enabled=await automation.read();if(closed)return;
    return Promise.allSettled([...['bolt','geotab','myclicar'].filter(id=>enabled[id]).map(id=>id==='bolt'?startBolt():id==='myclicar'?myclicar.start():geotab.start()),validation.resume(),disconnections.start()]);
  };
  handler.close=()=>{closed=true;boltPolling=false;boltGeneration++;clearTimer(boltTimer);geotab.close();myclicar.close();pairs.close();validation.close();disconnections.close();};
  return handler;
}
