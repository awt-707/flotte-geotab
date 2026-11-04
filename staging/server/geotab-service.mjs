import {moroccoParts,moroccoWallTime} from './morocco-time.mjs';
import { GeotabClient, readGeotabCredentials, saveGeotabCredentials, validateGeotabCredentials } from './geotab.mjs';
import {historyWindow,HISTORY_DAY_MS,HISTORY_REPORT_MS,reportTotals} from './geotab-history.mjs';
import {matchGeotabVehicles} from './geotab-matching.mjs';
import {retryDeadline,retryTimerDelay} from './provider-retry.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const eq=value=>'eq.'+value;
const MIN_INTERVAL=2000;
// Leave room for fuel/odometer reads, including the first six counters per vehicle.
export const geotabIntervalMs=count=>Math.max(MIN_INTERVAL,Math.ceil(count/6)*1000);
export const telemetryIntervalMs=count=>Math.max(30000,Math.ceil(count/2)*1000);
export function telemetryDayStart(time) {
  const p=moroccoParts(time);if(!p)throw fail(400,'Heure de référence Geotab invalide.');
  const midnight=moroccoWallTime({year:p.year,month:p.month,day:p.day});
  if(midnight===null)throw fail(400,'Début de journée marocaine invalide.');
  return new Date(midnight).toISOString();
}
const staleMs=interval=>Math.max(20000,interval*3);
// Database helpers come from the explicitly selected runtime target.
export function createGeotabService({db,list,patch,upsert,health,onLiveSnapshot=null,credentialsPath,fetchFn=fetch,now=Date.now,Client=GeotabClient,setTimer=setTimeout,clearTimer=clearTimeout,onPositions=async()=>{},onTelemetry=async()=>{},readMotion=async()=>({alerts:[],coverage:{}})}) {
  const credentials=()=>credentialsPath?readGeotabCredentials(credentialsPath):Promise.resolve(null);
  let client=new Client({credentials,fetchFn,now}),timer=null,polling=false,busy=null,generation=0,nextAt=0,interval=MIN_INTERVAL,failures=0,queue=Promise.resolve(),closed=false;
  const extra={events:{rows:new Map(),nextAt:0,busy:null,status:'pending',at:null,error:null},telemetry:{rows:new Map(),nextAt:0,busy:null,status:'pending',at:null,error:null}};
  let bearings=new Map(),motionError=null,catalog=null;
  const historicalCache=new Map(),historicalPending=new Map();let historicalActive=0;
  const serial=fn=>{const pending=queue.then(fn);queue=pending.catch(()=>{});return pending;};
  const source=async(withMetadata=false)=>(await db('fleet_sources',{params:{id:'eq.geotab',select:'id,status,last_success_at,last_error,stale_after_s'+(withMetadata?',metadata':'')}}))?.[0] || {};
  const safeError=e=>e?.name==='GeotabError'?e.message:'Connexion Geotab indisponible. Vérifiez les accès ou réessayez plus tard.';
  const pause=()=>{polling=false;clearTimer(timer);timer=null;generation++;historicalCache.clear();for(const state of Object.values(extra)){state.rows.clear();state.nextAt=0;state.status='pending';state.at=null;state.error=null;}bearings.clear();};
  const assertOpen=()=>{if(closed)throw fail(409,'Service Geotab arrêté.');};
  const ignored=async()=>({ok:true,ignored:true,...await status()});
  function enrich(linked,current) {
    for(const kind of ['events','telemetry']) {
      const cache=extra[kind];if(typeof client[kind]!=='function'||cache.busy||now()<cache.nextAt)continue;
      const started=now(),period=kind==='events'?10000:telemetryIntervalMs(linked.length);
      cache.nextAt=started+period;
      cache.busy=(async()=>{
        try {
          const from=telemetryDayStart(started),items=kind==='events'?linked.map(v=>v.geotab_id):linked.map(v=>({id:v.geotab_id,from}));
          const data=await client[kind](items);if(current!==generation)return;
          const byId=new Map(data.map(r=>[r.id,r]));
          cache.rows=new Map(linked.filter(v=>byId.has(v.geotab_id)).map(v=>[v.key,{...byId.get(v.geotab_id),key:v.key,plate:v.plate,period:'day'}]));
          cache.at=new Date(now()).toISOString();cache.error=null;
          cache.status=data.every(r=>r.status==='unavailable')?'unavailable':data.some(r=>r.status&&r.status!=='healthy'&&r.status!=='ok')?'partial':'healthy';
          if(kind==='telemetry')await onTelemetry([...cache.rows.values()]).catch(()=>{});
          if(onLiveSnapshot&&current===generation)await publishSnapshot(linked);
        }catch(e){if(current!==generation)return;cache.status='error';cache.error=safeError(e);cache.nextAt=retryDeadline(now(),Math.max(60,Number(e.retryAfter)||0));}
      })().finally(()=>{cache.busy=null;});
    }
  }
  function extraStatus() {return {events_status:extra.events.status,events_at:extra.events.at,events_error:extra.events.error,events_interval_s:10,
    telemetry_status:extra.telemetry.status,telemetry_at:extra.telemetry.at,telemetry_error:extra.telemetry.error,telemetry_interval_s:telemetryIntervalMs(extra.telemetry.rows.size)/1000,motion_error:motionError};}
  async function publishSnapshot(linked){
    if(!onLiveSnapshot)return;const captured_at=new Date(now()).toISOString();
    await onLiveSnapshot(linked.map(v=>({vehicle_key:v.key,data:{device_id:v.geotab_id,captured_at,bearing:bearings.get(v.key)??null,telemetry:extra.telemetry.rows.get(v.key)||null,events:extra.events.rows.get(v.key)?.events||[],extra:extraStatus()}})));
  }
  function scheduleNext() {
    if(!polling)return;
    const current=generation;
    timer=setTimer(async()=>{
      timer=null;
      try{await refresh();}catch{ /* refresh records the error and the retry deadline */ }
      finally{if(polling&&current===generation)scheduleNext();}
    },retryTimerDelay(nextAt,now()));
    timer?.unref?.();
  }
  async function status() {
    const [creds,src,vehicles]=await Promise.all([credentials(),source(true),list('vehicles',{select:'key,plate,model,geotab_id',order:'plate'})]);
    const cadence=geotabIntervalMs(vehicles.filter(v=>v.geotab_id).length),stale=staleMs(cadence);
    const state=!creds?'unconnected':!polling?(src.status==='error'?'error':'paused'):src.status==='healthy'&&now()-Date.parse(src.last_success_at)>stale?'stale':src.status;
    return {configured:!!creds,database:creds?.database || 'clicar',userName:creds?.userName || '',polling,interval_s:cadence/1000,stale_after_s:stale/1000,status:state,
      ...extraStatus(),next_attempt_at:polling&&nextAt?new Date(Math.max(now(),nextAt)).toISOString():null,retrying:polling&&failures>0,last_success_at:src.last_success_at || null,last_error:src.last_error || null,vehicles,devices:creds&&src.metadata?.database===creds.database?src.metadata.devices || []:[]};
  }
  async function connect(input) {
    if(!credentialsPath)throw fail(409,'Configuration locale Geotab absente');
    const candidate=validateGeotabCredentials(input);
    return serial(async()=>{
      assertOpen();const current=generation;
      const previous=await credentials();
      if(closed||current!==generation)return ignored();
      if(previous&&candidate.database!==previous.database&&(await list('vehicles',{select:'geotab_id'})).some(v=>v.geotab_id))throw fail(409,'Déliez les véhicules avant de changer de base MyGeotab.');
      const tested=new Client({credentials:async()=>candidate,fetchFn,now});
      const devices=await tested.devices();
      if(closed||current!==generation){tested.reset?.();return ignored();}
      pause();const savingGeneration=generation;await saveGeotabCredentials(credentialsPath,candidate);
      if(closed||savingGeneration!==generation){tested.reset?.();return ignored();}
      // Reuse the session just tested. No password or session goes into public tables.
      client.reset?.();client=tested;nextAt=0;failures=0;catalog=null;
      await health('geotab','paused',{last_error:null,metadata:{database:candidate.database,devices},coverage:{kind:'linked_vehicles',devices:devices.length},last_attempt_at:new Date(now()).toISOString()});
      return status();
    });
  }
  async function devices() {
    return serial(async()=>{
      assertOpen();const current=generation;
      const creds=await credentials();if(!creds)throw fail(409,'Connectez d’abord MyGeotab.');
      if(closed||current!==generation)return ignored();
      const rows=await client.devices();
      if(closed||current!==generation)return ignored();
      catalog=null;
      await patch('fleet_sources',{id:'eq.geotab'},{metadata:{database:creds.database,devices:rows},last_error:null});
      return status();
    });
  }
  async function link(input) {
    if(typeof input.vehicle_key!=='string'||!input.vehicle_key||input.vehicle_key.length>120||input.device_id!==null&&(typeof input.device_id!=='string'||!input.device_id||input.device_id.length>120))throw fail(400,'Véhicule et boîtier requis.');
    return serial(async()=>{
      assertOpen();const current=generation;
      const [creds,src,vehicles]=await Promise.all([credentials(),source(true),list('vehicles',{select:'key,geotab_id'})]);
      if(closed||current!==generation)return ignored();
      if(!creds)throw fail(409,'Connectez d’abord MyGeotab.');
      const vehicle=vehicles.find(v=>v.key===input.vehicle_key);if(!vehicle)throw fail(404,'Véhicule local introuvable.');
      const device=src.metadata?.database===creds.database&&src.metadata?.devices?.find(d=>d.id===input.device_id);
      if(input.device_id&&!device)throw fail(400,'Boîtier absent du catalogue accessible : actualisez la liste.');
      if(input.device_id&&vehicles.some(v=>v.key!==vehicle.key&&v.geotab_id===input.device_id))throw fail(409,'Ce boîtier est déjà associé à un autre véhicule.');
      if(input.device_id===vehicle.geotab_id){await patch('vehicles',{key:eq(vehicle.key)},{geotab_auto_link_disabled:true});return status();}
      pause();
      await patch('vehicles',{key:eq(vehicle.key)},{geotab_id:input.device_id,geotab_name:device?.name || null,geotab_auto_link_disabled:true});
      await db('live_status',{method:'DELETE',params:{vehicle_key:eq(vehicle.key)}});
      await health('geotab','paused',{last_error:null});nextAt=0;
      return status();
    });
  }
  async function autoAssociate(){
    return serial(async()=>{
      assertOpen();const current=generation;
      const [creds,src,vehicles]=await Promise.all([credentials(),source(true),list('vehicles',{select:'key,plate,other_plates,vin,active,geotab_id,geotab_auto_link_disabled'})]);
      if(closed||current!==generation)return {ok:true,ignored:true};
      if(!creds||src.metadata?.database!==creds.database||!Array.isArray(src.metadata?.devices))return {ok:true,skipped:true,reason:'catalog_unavailable'};
      const plan=matchGeotabVehicles(vehicles,src.metadata.devices);let linked=0;
      for(const match of plan.matches){
        if(closed||current!==generation)return {ok:true,ignored:true};
        // Same queue as manual link(). The SQL predicate also preserves any
        // intervening manual choice made outside this service instance.
        await patch('vehicles',{key:eq(match.vehicle_key),geotab_id:'is.null',geotab_auto_link_disabled:'eq.false'},{geotab_id:match.device_id,geotab_name:match.device_name||null});
        const saved=(await list('vehicles',{select:'key,geotab_id',key:eq(match.vehicle_key)}))?.[0];
        if(saved?.geotab_id!==match.device_id)continue;
        await db('live_status',{method:'DELETE',params:{vehicle_key:eq(match.vehicle_key)}});linked++;
      }
      if(linked)catalog=null;
      return {ok:true,linked,existing:plan.existing.length,unmatched:plan.unmatched.length,ambiguous:plan.ambiguous.length,conflicts:plan.conflicts.length};
    });
  }
  async function refresh() {
    assertOpen();
    if(busy)return busy;
    if(now()<nextAt)throw fail(429,'Lecture Geotab déjà récente ou différée.');
    const current=generation;
    busy=(async()=>{
      const startedAt=now(),at=new Date(startedAt).toISOString();
      try {
        const creds=await credentials();if(!creds)throw fail(409,'Connectez d’abord MyGeotab.');
        const reloadCatalog=!catalog||catalog.database!==creds.database||now()-catalog.at>60000;
        const [src,vehicles]=await Promise.all([source(reloadCatalog),list('vehicles',{select:'key,plate,model,geotab_id'})]);
        const linked=vehicles.filter(v=>v.geotab_id);
        if(!linked.length)throw fail(409,'Associez au moins un véhicule à son boîtier.');
        if(linked.length>100)throw fail(400,'Le suivi local est limité à 100 véhicules associés.');
        interval=geotabIntervalMs(linked.length);
        if(reloadCatalog)catalog={database:creds.database,at:now(),ids:new Set(src.metadata?.database===creds.database?src.metadata?.devices?.map(d=>d.id):[])};
        const allowed=catalog.ids;
        if(linked.some(v=>!allowed.has(v.geotab_id)))throw fail(409,'Un boîtier associé est absent du catalogue de ce compte. Actualisez les boîtiers et vérifiez les associations.');
        await patch('fleet_sources',{id:'eq.geotab'},{last_attempt_at:at});
        const positions=await client.positions(linked.map(v=>v.geotab_id));
        return await serial(async()=>{
          if(current!==generation)return {ok:true,ignored:true,polling:false};
          const byId=new Map(positions.map(p=>[p.id,p])),received=new Date(now()).toISOString();
          const rows=linked.map(v=>{const p=byId.get(v.geotab_id);return {vehicle_key:v.key,plate:v.plate,model:v.model,state:p?.state || 'Pas de réponse Geotab',
            speed:p?.speed ?? null,since_min:p?.since_min ?? null,last_pos_at:p?.at || null,lat:p?.lat ?? null,lon:p?.lon ?? null,ign_on:p?.ign_on ?? null,updated_at:received};});
          await upsert('live_status',rows,'vehicle_key');
          await health('geotab','healthy',{last_success_at:received,last_error:null,stale_after_s:staleMs(interval)/1000,coverage:{kind:'linked_vehicles',vehicles:linked.length,positions:rows.filter(r=>r.lat!==null&&r.lon!==null).length}});
          if(current!==generation)return {ok:true,ignored:true,polling:false};
          bearings=new Map(linked.map(v=>[v.key,byId.get(v.geotab_id)?.bearing??null]));
          try{await onPositions(rows.map(r=>({...r,key:r.vehicle_key,at:r.last_pos_at,device_id:linked.find(v=>v.key===r.vehicle_key)?.geotab_id})),{status:'healthy',last_success_at:received,stale_after_s:staleMs(interval)/1000});motionError=null;}catch{motionError='Surveillance des déplacements indisponible ; vérifiez les associations et la base locale.';}
          if(current!==generation)return {ok:true,ignored:true,polling:false};
          await publishSnapshot(linked);
          if(current!==generation)return {ok:true,ignored:true,polling:false};
          enrich(linked,current);
          nextAt=startedAt+interval;failures=0;return {ok:true,vehicles:rows.length,received_at:received};
        });
      } catch(e) {
        if(current!==generation)return {ok:true,ignored:true,polling:false};
        failures++;nextAt=retryDeadline(now(),Math.max(Number(e.retryAfter)||0,Math.min(900,30*2**Math.min(failures,5))));
        const message=e.status===409||e.status===400?e.message:safeError(e);
        await serial(async()=>{if(current===generation)await health('geotab','error',{last_error:message});});
        throw fail(e.status || 502,message);
      }
    })().finally(()=>{busy=null;});return busy;
  }
  async function start() {
    assertOpen();
    if(polling)return {ok:true,...await status()};
    const current=generation;
    // Set the intent before the first read: a temporary outage must not disable retries.
    polling=true;
    let result;
    try{result=await refresh();}
    catch{result={ok:false,retrying:true};}
    finally{if(polling&&current===generation)scheduleNext();}
    if(current!==generation)return {ok:true,ignored:true,...await status()};
    return {...result,...await status()};
  }
  async function stop() {pause();await serial(()=>health('geotab','paused',{last_error:null}));return status();}
  async function live(token) {
    const [src,vehicles,rows,creds,motion]=await Promise.all([source(),list('vehicles',{select:'key,plate,geotab_id'},token),list('live_status',{select:'vehicle_key,state,speed,since_min,last_pos_at,lat,lon,ign_on,updated_at'},token),credentials(),readMotion(token)]);
    const selected=new Map(vehicles.filter(v=>v.geotab_id).map(v=>[v.key,v]));
    const stale=staleMs(interval);
    const state=!creds?'unconnected':!polling?'paused':src.status==='healthy'&&now()-Date.parse(src.last_success_at)>stale?'stale':src.status;
    const currentPositions=new Map(rows.map(r=>[r.vehicle_key,r]));
    const telemetry=Object.fromEntries([...extra.telemetry.rows].filter(([key])=>selected.has(key)).map(([key,r])=>[key,{...r,fresh:state==='healthy'&&extra.telemetry.status!=='error'&&now()-Date.parse(currentPositions.get(key)?.last_pos_at)<180000&&now()-Date.parse(r.at)<Math.max(90000,telemetryIntervalMs(selected.size)*3)}]));
    const events=[...extra.events.rows].filter(([key])=>selected.has(key)).flatMap(([key,r])=>(r.events||[]).filter(e=>!e.end||now()-Date.parse(e.end)<1800000).map(e=>({...e,key,plate:selected.get(key).plate}))).sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    return {at:src.last_success_at || null,source:{configured:!!creds,polling,interval_s:interval/1000,stale_after_s:stale/1000,status:state,last_success_at:src.last_success_at || null,last_error:src.last_error || null,...extraStatus()},events,telemetry,
      motion_alerts:motion.alerts.filter(a=>selected.has(a.key||a.vehicle_key)).map(a=>({...a,status:a.status==='open'&&(state!=='healthy'||motionError)?'suspended':a.status})),motion_coverage:motion.coverage,
      motion_watches:state==='healthy'&&!motionError?(motion.watches||[]).filter(w=>selected.has(w.key)):[],
      vehicles:rows.filter(r=>selected.has(r.vehicle_key)).map(r=>{
        const age=now()-Date.parse(r.last_pos_at);
        const fresh=state==='healthy'&&!!r.last_pos_at&&age>=-60000&&age<180000&&now()-Date.parse(r.updated_at)<stale;
        return {key:r.vehicle_key,plate:selected.get(r.vehicle_key).plate,at:r.last_pos_at,lat:r.lat,lon:r.lon,speed:fresh?r.speed:null,bearing:bearings.get(r.vehicle_key)??null,
          state:fresh?r.state:'Position ancienne',since_min:r.since_min,ign_on:fresh?r.ign_on:null,fresh};
      })};
  }
  async function historyVehicles(token,input,mode) {
    assertOpen();
    if(typeof token!=='string'||!token)throw fail(401,'Session locale requise.');
    const vehicles=await list('vehicles',{select:'key,plate,model,geotab_id,active',order:'key'},token);
    const visible=vehicles.filter(v=>v.geotab_id&&v.active!==false&&String(v.active).toUpperCase()!=='NON');
    let wanted;
    if(mode!=='report') {
      if(typeof input?.key!=='string'||!input.key||input.key.length>120)throw fail(400,'Véhicule requis.');
      wanted=visible.filter(v=>v.key===input.key);if(!wanted.length)throw fail(404,'Véhicule introuvable ou hors de votre périmètre.');
    }else {
      if(input?.keys!==undefined&&typeof input.keys!=='string')throw fail(400,'Sélection de véhicules invalide.');
      const requested=input?.keys? [...new Set(input.keys.split(',').filter(Boolean))]:null;
      if(requested?.some(k=>k.length>120||!visible.some(v=>v.key===k)))throw fail(404,'Un véhicule demandé est introuvable ou hors de votre périmètre.');
      wanted=requested?visible.filter(v=>requested.includes(v.key)):visible;
      if(wanted.length>25)throw fail(400,'Sélectionnez au maximum 25 véhicules par rapport.');
    }
    const creds=await credentials();if(!creds)throw fail(409,'Connectez MyGeotab avant de consulter son historique.');
    const src=await source(true),allowed=new Set(src.metadata?.database===creds.database?src.metadata.devices?.map(d=>d.id):[]);
    if(wanted.some(v=>!allowed.has(v.geotab_id)))throw fail(409,'Vérifiez les associations de boîtiers avant de consulter leur historique.');
    return wanted;
  }
  async function cachedHistory(key,to,work) {
    key=generation+':'+key;
    const old=historicalCache.get(key);
    if(old&&now()<old.expires)return {...structuredClone(old.data),cached:true};
    if(historicalPending.has(key))return structuredClone(await historicalPending.get(key));
    if(historicalActive>=2)throw fail(429,'Deux lectures historiques sont déjà en cours. Réessayez après leur fin.');
    const current=generation;historicalActive++;
    const pending=(async()=>{
      try {
        const data=await work();if(generation!==current)throw fail(409,'La connexion ou les associations Geotab ont changé ; relancez cette lecture.');
        historicalCache.delete(key);historicalCache.set(key,{expires:now()+(now()-Date.parse(to)>600000?300000:60000),data});
        while(historicalCache.size>12)historicalCache.delete(historicalCache.keys().next().value);
        return structuredClone(data);
      }catch(error){if(error?.name==='GeotabError')throw fail(error.status||502,safeError(error));throw error;}
      finally{historicalActive--;historicalPending.delete(key);}
    })();
    historicalPending.set(key,pending);return pending;
  }
  async function history(token,input={}) {
    const range=historyWindow(input,HISTORY_DAY_MS,now()),[vehicle]=await historyVehicles(token,input,'history');
    const key=JSON.stringify(['history',vehicle.geotab_id,range.from,range.to]);
    const data=await cachedHistory(key,range.to,()=>client.history(vehicle.geotab_id,range));
    const {id,...publicData}=data;
    return {...publicData,vehicle:{key:vehicle.key,plate:vehicle.plate,model:vehicle.model},events:data.events.map(e=>({...e,key:vehicle.key,plate:vehicle.plate}))};
  }
  async function detail(token,input={}) {
    const instant=typeof input.from==='string'&&Number.isFinite(Date.parse(input.from))&&(!input.to||Date.parse(input.to)===Date.parse(input.from));
    const requested=instant?{...input,to:new Date(Date.parse(input.from)+1).toISOString()}:input;
    const range=historyWindow(requested,84*60000,now()),[vehicle]=await historyVehicles(token,input,'detail');
    const padded={from:new Date(Date.parse(range.from)-180000).toISOString(),to:new Date(Math.min(now(),Date.parse(range.to)+180000)).toISOString()};
    const key=JSON.stringify(['detail',vehicle.geotab_id,padded.from,padded.to]);
    const data=await cachedHistory(key,padded.to,()=>client.detail(vehicle.geotab_id,padded));
    const {id,...publicData}=data;
    return {...publicData,key:vehicle.key,plate:vehicle.plate,events:data.events.map(e=>({...e,key:vehicle.key,plate:vehicle.plate}))};
  }
  async function report(token,input={}) {
    const range=historyWindow(input,HISTORY_REPORT_MS,now()),vehicles=await historyVehicles(token,input,'report');
    const key=JSON.stringify(['report',vehicles.map(v=>v.geotab_id).sort(),range.from,range.to]);
    const raw=await cachedHistory(key,range.to,async()=>({data:await client.report(vehicles.map(v=>v.geotab_id),range),at:new Date(now()).toISOString()}));
    const byId=new Map(raw.data.map(r=>[r.id,r]));
    const rows=vehicles.map(v=>{
      const row=byId.get(v.geotab_id);if(!row)throw fail(502,'Rapport Geotab incomplet.');
      return {key:v.key,plate:v.plate,model:v.model,...row.summary,status:row.status,coverage:row.coverage,warnings:row.warnings,counter_at:row.counter_at};
    });
    return {...range,at:raw.at,cached:!!raw.cached,rows,totals:reportTotals(rows),coverage:{vehicles:rows.length,complete:rows.filter(r=>r.status==='complete').length,
      partial:rows.filter(r=>r.status==='partial').length,unavailable:rows.filter(r=>r.status==='unavailable').length},warnings:[...new Set(rows.flatMap(r=>r.warnings))]};
  }
  const zones=async()=>{assertOpen();return {zones:await client.zones(),types:await client.zoneTypes()};};
  function close(){closed=true;pause();client.reset?.();}
  return {status,connect,devices,link,autoAssociate,start,stop,live,refresh,history,detail,report,zones,close,get polling(){return polling;},
    get nextAttemptAt(){return polling&&nextAt?new Date(Math.max(now(),nextAt)).toISOString():null;},get retrying(){return polling&&failures>0;}};
}
