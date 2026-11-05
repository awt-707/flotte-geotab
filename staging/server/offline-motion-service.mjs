import { advanceOfflineMotion, OFFLINE_MOVEMENT_THRESHOLD_M } from './offline-motion.mjs';
import {trustedVehicleLease,conflictingVehicleAssignments} from './vehicle-evidence.mjs';
import {driverPlatformActivity} from './platform-activity.mjs';

const TABLE = 'fleet_motion_alerts';
const CHECKPOINTS = 'fleet_motion_checkpoints';
const CONFLICT = 'identity_id,vehicle_key,observed_since';
const SOURCE_FIELDS = 'id,status,last_success_at,stale_after_s';
const LATEST_FIELDS = 'identity_id,driver_id,source,status,observed_at,offline_since,vehicle_label,evidence';
const DRIVER_FIELDS = 'id,name,vehicle_key,ludy_driver_code,agency_id,vehicle_link_method,vehicle_link_evidence,link_evidence';
const ALERT_FIELDS = 'id,driver_id,identity_id,vehicle_key,source,kind,severity,status,observed_since,opened_at,last_seen_at,resolved_at,distance_m,threshold_m,evidence';
const eq = value => 'eq.' + value;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const episodeKey = row => JSON.stringify([row.identity_id, row.vehicle_key, stamp(row.observed_since)]);
const accountAllowed = row => !['deactivated','suspended'].includes(String(row?.evidence?.account_status || '').toLowerCase());
const assignmentCurrent = (driver, now, sources) => {
  if(driver?.vehicle_link_evidence?.assignment_conflict?.requires_confirmation===true)return false;
  if (!['platform_plate','myclicar_contract'].includes(driver?.vehicle_link_method)) return true;
  const proof=driver.vehicle_link_evidence;
  if (!trustedVehicleLease(proof) || !Number.isFinite(stamp(proof?.observed_at)) || stamp(proof.observed_at)>now+5000 || !Number.isFinite(stamp(proof?.expires_at)) || stamp(proof.expires_at)<=now || stamp(proof.expires_at)<=stamp(proof.observed_at) || !sourceFresh(sources.get(proof?.source),now)) return false;
  if (proof.method && proof.method!==driver.vehicle_link_method || driver.vehicle_link_method==='platform_plate'&&!['uber','bolt'].includes(proof.source)) return false;
  return driver.vehicle_link_method!=='myclicar_contract' || proof.source==='myclicar' && proof.vehicle_key===driver.vehicle_key && proof.client_code===driver.ludy_driver_code;
};
const sourceFresh = (source, now) => source?.status === 'healthy' && Number.isFinite(stamp(source.last_success_at)) && stamp(source.last_success_at) <= now + 5000 && now - stamp(source.last_success_at) <= (source.stale_after_s || 90) * 1000;
const normalizedSource = (source, now) => sourceFresh(source, now) ? source : {...source, status:'stale'};

function assignmentProof(driver) {
  const evidence=driver?.vehicle_link_evidence || {};
  return {method:driver?.vehicle_link_method || 'legacy_explicit',vehicle_key:driver?.vehicle_key,
    ...(driver?.vehicle_link_method==='manual'?{confirmed_at:driver.link_evidence?.at || null}:{}),
    ...Object.fromEntries(['source','contract_id','observed_at','expires_at'].filter(key=>typeof evidence[key]==='string').map(key=>[key,evidence[key]]))};
}
const observationProof = (latest,driverId) => latest.filter(row=>row.driver_id===driverId&&['uber','bolt'].includes(row.source)).map(row=>({
  source:row.source,identity_id:row.identity_id,status:row.status,observed_at:row.observed_at,offline_since:row.offline_since,
  account_status:typeof row.evidence?.account_status==='string'?row.evidence.account_status:null
}));
const sourceProof = sources => sources.filter(row=>['uber','bolt','geotab','myclicar'].includes(row.id)).map(row=>({
  id:row.id,status:row.status,last_success_at:row.last_success_at,stale_after_s:row.stale_after_s
}));


function assignmentCounts(drivers) {
  const counts = new Map();
  for (const driver of drivers) if (driver.vehicle_key) counts.set(driver.vehicle_key, (counts.get(driver.vehicle_key) || 0) + 1);
  return counts;
}
function uniquePositions(positions) {
  const counts = new Map(), out = new Map();
  for (const p of positions) if (p?.key) {counts.set(p.key, (counts.get(p.key) || 0) + 1); out.set(p.key, p);}
  for (const [key,count] of counts) if (count !== 1) out.delete(key);
  return out;
}
function observationInterrupted(previous,driver,latest,identities,events,at) {
  if(!previous||!driver)return false;
  const providers=new Set(['geotab',...identities.filter(identity=>identity.driver_id===driver.id).map(identity=>identity.source),
    ...latest.filter(sample=>sample.driver_id===driver.id).map(sample=>sample.source),driver.vehicle_link_evidence?.source].filter(Boolean));
  return events.some(event=>providers.has(event.source)&&event.status!=='healthy'&&Number.isFinite(stamp(event.at))&&
    stamp(event.at)>=stamp(previous.last_point?.at)&&stamp(event.at)<=at);
}

/** Local adapters are supplied by fleet.mjs; this service has no network/provider client. */
export function createOfflineMotionService({db, list, upsert, patch, now = Date.now}) {
  let states = new Map(), lastPositions = new Map(), lastGeotab = null, queue = Promise.resolve(), restored = false;
  const serialize = fn => {const task = queue.then(fn); queue = task.catch(() => {}); return task;};
  function activitiesFor(latest,identities,sources,at){return new Map([...new Set(latest.map(r=>r.driver_id))].map(driverId=>{
    const activity=driverPlatformActivity({driverId,latest,identities,sources,now:at});
    const identity=activity.status==='offline'?latest.filter(r=>r.driver_id===driverId&&r.status==='offline'&&accountAllowed(r)).map(r=>r.identity_id).sort()[0]:null;
    return [driverId,{...activity,identity_id:identity}];
  }));}
  function inputs(row, sources, drivers, counts, positions, geotab, at, activities) {
    const driver = drivers.get(row?.driver_id), activity=activities.get(row?.driver_id);
    if(activity?.status!=='offline'||activity.identity_id!==row.identity_id)return null;
    if (!row || !accountAllowed(row) || !driver?.vehicle_key || !assignmentCurrent(driver,at,sources) || counts.get(driver.vehicle_key) !== 1) return null;
    return {row:{...row,offline_since:activity.offline_since}, source:normalizedSource(sources.get(row.source),at), driver, position:positions.get(driver.vehicle_key), geotab, now:at};
  }
  function effectiveStatus(alert, latest, sources, drivers, counts, positions, geotab, at, activities, progress = states) {
    if (alert.status === 'resolved') return 'resolved';
    const row = latest.get(alert.identity_id);
    if (row?.driver_id === alert.driver_id && activities.get(row.driver_id)?.status==='online') return 'resolved';
    const input = inputs(row,sources,drivers,counts,positions,geotab,at,activities);
    if (!input || input.driver.id !== alert.driver_id || input.driver.vehicle_key !== alert.vehicle_key || stamp(input.row.offline_since) !== stamp(alert.observed_since) || !advanceOfflineMotion(null,input).state) return 'suspended';
    const state = progress.get(alert.identity_id);
    if (!state || state.episode !== advanceOfflineMotion(null,input).state.episode || state.distance_m <= OFFLINE_MOVEMENT_THRESHOLD_M + 1e-6) return 'suspended';
    return 'open';
  }
  function restoreCheckpoints(rows, at) {
    const restoredStates = new Map();
    for (const row of rows) {
      const saved = stamp(row.updated_at), state = row.state;
      if (!Number.isFinite(saved) || saved > at + 5000 || at - saved > 60000 || !state || state.version !== 1 ||
        state.identity_id !== row.identity_id || state.vehicle_key !== row.vehicle_key || state.source !== row.source ||
        !Number.isFinite(state.distance_m) || state.distance_m < 0) continue;
      restoredStates.set(row.identity_id,state);
    }
    return restoredStates;
  }
  async function performUpdate(positions, geotab) {
    const at = now(), received = new Date(at).toISOString();
    const [sourceRows, latestRows, driverRows, existing, checkpoints, identityRows, vehicleRows, interruptions] = await Promise.all([
      list('fleet_sources',{select:SOURCE_FIELDS}),
      list('fleet_latest',{select:LATEST_FIELDS}),
      list('fleet_drivers',{select:DRIVER_FIELDS}),
      list(TABLE,{select:ALERT_FIELDS,status:'in.(open,suspended)',order:'opened_at.desc,id'}),
      restored ? Promise.resolve(null) : list(CHECKPOINTS,{select:'identity_id,vehicle_key,source,state,updated_at'}),
      list('fleet_identities',{select:'id,driver_id,source'}),
      list('vehicles',{select:'key,plate,other_plates'}),
      list('fleet_source_events',{select:'source,status,at',status:'neq.healthy',at:'gte.'+new Date(at-360000).toISOString()})
    ]);
    const activities=activitiesFor(latestRows,identityRows,sourceRows,at);
    const sources = new Map(sourceRows.map(s=>[s.id,s])), latest = new Map(latestRows.map(r=>[r.identity_id,r]));
    const drivers = new Map(driverRows.map(d=>[d.id,d])), counts = assignmentCounts(driverRows), points = uniquePositions(positions);
    const conflicts=conflictingVehicleAssignments({drivers:driverRows,latest:latestRows,sources:sourceRows,vehicles:vehicleRows,now:at});
    for(const key of conflicts)counts.set(key,2);
    for(const driver of driverRows.filter(d=>conflicts.has(d.vehicle_key)&&(!d.vehicle_link_method||d.vehicle_link_method==='manual')&&!d.vehicle_link_evidence?.assignment_conflict?.requires_confirmation)){
      const proof={...driver.vehicle_link_evidence,assignment_conflict:{at:received,reason:'another_live_driver',requires_confirmation:true}};
      // Keep the operator's choice, but require a new explicit confirmation.
      // CAS prevents a concurrent manual confirmation from being overwritten.
      await patch('fleet_drivers',{id:eq(driver.id),vehicle_key:eq(driver.vehicle_key),vehicle_link_method:driver.vehicle_link_method?eq(driver.vehicle_link_method):'is.null',link_evidence:eq(JSON.stringify(driver.link_evidence||{})),vehicle_link_evidence:eq(JSON.stringify(driver.vehicle_link_evidence||{}))},{vehicle_link_evidence:proof});
      driver.vehicle_link_evidence=proof;
    }
    // A caller-provided healthy sample cannot override an explicit pause in the local source.
    const geoSource = sources.get('geotab');
    const currentGeotab = geoSource && geoSource.status !== 'healthy' ? {...geotab,status:geoSource.status} : geotab;
    const previousStates = restored ? states : restoreCheckpoints(checkpoints,at);
    const nextStates = new Map(), candidates = [];
    for (const row of latestRows) {
      const input = inputs(row,sources,drivers,counts,points,currentGeotab,at,activities);
      if (!input) continue;
      const previous=previousStates.get(row.identity_id);
      // A pause may occur while no GPS callback is running. Its later resume
      // must not bridge unobserved movement, even during a short server restart.
      const interrupted=observationInterrupted(previous,input.driver,latestRows,identityRows,interruptions,at);
      const result = advanceOfflineMotion(interrupted?null:previous,input);
      if (result.state) nextStates.set(row.identity_id,result.state);
      if (result.alert) candidates.push({...result.alert,evidence:{...result.alert.evidence,platforms_offline:activities.get(row.driver_id).offline_sources,
        platform_observations:observationProof(latestRows,row.driver_id),assignment:assignmentProof(input.driver),source_health:sourceProof(sourceRows),policy:'all_known_platforms_offline'}});
    }
    let resumed = 0;
    for (const alert of existing) {
      const status = effectiveStatus(alert,latest,sources,drivers,counts,points,currentGeotab,at,activities,nextStates);
      if (status !== alert.status) {
        const state = nextStates.get(alert.identity_id);
        const resumedEvidence = status === 'open' ? {distance_m:Math.max(alert.distance_m,state.distance_m),
          evidence:{...alert.evidence,resumed_at:received,resumption_measurement_started_at:state.started_at,
            latest_geotab_at:state.last_point.at,latest_platform_observed_at:state.last_observed_at,
            latest_assignment:assignmentProof(drivers.get(alert.driver_id)),latest_platform_observations:observationProof(latestRows,alert.driver_id),latest_source_health:sourceProof(sourceRows),
            ign_on:state.last_point.ign_on}} : {};
        await patch(TABLE,{id:eq(alert.id)},{status,last_seen_at:received,...resumedEvidence,...(status==='resolved'?{resolved_at:received}:{})});
        if(status==='open')resumed++;
      } else if (status === 'open') {
        const state=nextStates.get(alert.identity_id), point=points.get(alert.vehicle_key), row=latest.get(alert.identity_id);
        await patch(TABLE,{id:eq(alert.id)},{last_seen_at:received,distance_m:Math.max(alert.distance_m,state?.distance_m || 0),
          evidence:{...alert.evidence,latest_geotab_at:point.at,latest_platform_observed_at:row.observed_at,
            latest_assignment:assignmentProof(drivers.get(alert.driver_id)),latest_platform_observations:observationProof(latestRows,alert.driver_id),latest_source_health:sourceProof(sourceRows),ign_on:typeof point.ign_on==='boolean'?point.ign_on:null}});
      }
    }
    let created = 0;
    const existingByEpisode = new Map(existing.map(a=>[episodeKey(a),a]));
    for (const alert of candidates) {
      const old = existingByEpisode.get(episodeKey(alert)) || (await db(TABLE,{params:{select:ALERT_FIELDS,identity_id:eq(alert.identity_id),vehicle_key:eq(alert.vehicle_key),observed_since:eq(alert.observed_since),limit:'1'}}))?.[0];
      if (old) {
        nextStates.get(alert.identity_id).alerted_at = old.opened_at;
        // An existing episode is reused. Its original timestamp/evidence remains intact;
        // a suspension only returns to open after a fresh confirmed 200 m segment above.
        continue;
      }
      await upsert(TABLE,[{...alert,status:'open',last_seen_at:received,resolved_at:null}],CONFLICT);
      created++;
    }
    // One local transaction replaces the active checkpoints, including removals. Saving
    // after alert writes means a retry can only reuse an incident, never invent another.
    await db('rpc/fleet_save_motion_checkpoints',{method:'POST',body:{p_states:[...nextStates.values()].map(state=>({
      identity_id:state.identity_id,vehicle_key:state.vehicle_key,source:state.source,state,updated_at:received
    }))}});
    // Commit in-memory progress only after persistence succeeds, allowing failed writes to retry.
    states=nextStates; lastPositions=points; lastGeotab=currentGeotab; restored=true;
    return {tracking:new Set([...states.values()].map(s=>s.driver_id)).size,alerts_created:created,alerts_resumed:resumed};
  }
  function update(positions = [], geotab = {}) {
    if (!Array.isArray(positions)) return Promise.reject(new TypeError('Positions locales invalides'));
    const copy=positions.map(p=>p&&({...p})), geo={...geotab};
    return serialize(()=>performUpdate(copy,geo));
  }
  async function read(token,{vehicles:sharedVehicles}={}) {
    if (typeof token !== 'string' || !token) throw new Error('Session locale requise pour les alertes de déplacement.');
    const at=now();
    const [sourceRows,driverRows,vehicleRows,latestRows,alertRows,identityRows,interruptions,contracts,disconnections] = await Promise.all([
      list('fleet_sources',{select:SOURCE_FIELDS}),
      list('fleet_drivers',{select:DRIVER_FIELDS},token),
      sharedVehicles||list('vehicles',{select:'key,plate,other_plates,geotab_id'},token),
      list('fleet_latest',{select:LATEST_FIELDS},token),
      db(TABLE,{params:{select:ALERT_FIELDS,order:'opened_at.desc,id',limit:'500'},token}),
      list('fleet_identities',{select:'id,driver_id,source'},token),
      list('fleet_source_events',{select:'source,status,at',status:'neq.healthy',at:'gte.'+new Date(at-360000).toISOString()}),
      // Contracts are admin-only in the database. These minimal internal facts
      // only establish membership of an already RLS-visible driver; no contract
      // or person identifier is returned through the coverage counters.
      list('fleet_myclicar_contracts',{select:'client_code,status,current,deleted,effective_start_at,end_at,observed_at',current:'eq.true',status:'eq.IN_PROGRESS'}),
      list('fleet_disconnection_alerts',{select:'driver_id,status',status:'in.(open,suspended)'},token)
    ]);
    const activities=activitiesFor(latestRows,identityRows,sourceRows,at);
    const sources=new Map(sourceRows.map(s=>[s.id,s])), drivers=new Map(driverRows.map(d=>[d.id,d])), vehicles=new Map(vehicleRows.map(v=>[v.key,v]));
    const latest=new Map(latestRows.map(r=>[r.identity_id,r])), counts=assignmentCounts(driverRows);
    const conflicts=conflictingVehicleAssignments({drivers:driverRows,latest:latestRows,sources:sourceRows,vehicles:vehicleRows,now:at});
    for(const driver of driverRows)if(driver.vehicle_key&&driver.vehicle_link_evidence?.assignment_conflict?.requires_confirmation===true)conflicts.add(driver.vehicle_key);
    for(const key of conflicts)counts.set(key,2);
    const geoSource=sources.get('geotab');
    const geotab=lastGeotab && sourceFresh(geoSource,at)?lastGeotab:{...lastGeotab,status:'stale'};
    const progress=new Map([...states].filter(([,state])=>!observationInterrupted(state,drivers.get(state.driver_id),latestRows,identityRows,interruptions,at)));
    const alerts=(alertRows || []).filter(a=>drivers.has(a.driver_id)&&vehicles.has(a.vehicle_key)).map(a=>({
      ...a,status:effectiveStatus(a,latest,sources,drivers,counts,lastPositions,geotab,at,activities,progress),key:a.vehicle_key,
      plate:vehicles.get(a.vehicle_key).plate,driver_name:drivers.get(a.driver_id).name,at:a.opened_at,ign_on:a.evidence?.ign_on ?? null
    }));
    const linked=driverRows.filter(d=>d.vehicle_key&&vehicles.has(d.vehicle_key)&&assignmentCurrent(d,at,sources)&&counts.get(d.vehicle_key)===1);
    const tracking=new Set(), watches=[];
    for(const row of latestRows) {
      const state=progress.get(row.identity_id), input=inputs(row,sources,drivers,counts,lastPositions,geotab,at,activities);
      if(state&&input&&vehicles.has(input.driver.vehicle_key)&&advanceOfflineMotion(null,input).state?.episode===state.episode) {
        tracking.add(row.driver_id);
        if(state.last_point.ign_on===true)watches.push({key:state.vehicle_key,driver_name:input.driver.name,source:row.source,
          distance_m:Math.floor(state.distance_m),ign_on:true,at:state.last_point.at});
      }
    }
    // Coverage describes current work that needs an assignment, not every
    // historical platform profile ever discovered. This does not restrict the
    // motion detector: inputs/update/alerts still use their full original set.
    const eligible=new Set(driverRows.filter(driver=>driver.vehicle_key&&vehicles.has(driver.vehicle_key)&&(assignmentCurrent(driver,at,sources)||conflicts.has(driver.vehicle_key))).map(driver=>driver.id));
    for(const row of latestRows){
      const source=sources.get(row.source),ttl=Number(source?.stale_after_s||90)*1000,observed=stamp(row.observed_at);
      // Retain a recent positive observation during a temporary source outage.
      // This flags an assignment to review; it does not declare the driver live.
      if(drivers.has(row.driver_id)&&accountAllowed(row)&&['available','on_trip','to_pickup','on_break'].includes(row.status)&&Number.isFinite(ttl)&&ttl>0&&Number.isFinite(observed)&&observed<=at+5000&&at-observed<=ttl)eligible.add(row.driver_id);
    }
    const serviceCodes=new Set(contracts.filter(contract=>{
      const start=stamp(contract.effective_start_at),returned=stamp(contract.end_at),observed=stamp(contract.observed_at);
      return contract.current===true&&contract.status==='IN_PROGRESS'&&contract.deleted===false&&typeof contract.client_code==='string'&&contract.client_code&&Number.isFinite(start)&&start<=at&&Number.isFinite(observed)&&observed<=at+5000&&!(Number.isFinite(returned)&&returned<=at);
    }).map(contract=>contract.client_code));
    for(const driver of driverRows)if(serviceCodes.has(driver.ludy_driver_code))eligible.add(driver.id);
    for(const alert of [...alerts,...disconnections])if(drivers.has(alert.driver_id)&&['open','suspended'].includes(alert.status))eligible.add(alert.driver_id);
    for(const id of tracking)eligible.add(id);
    return {alerts,watches,coverage:{linked_drivers:linked.length,unassigned_drivers:eligible.size-linked.length,tracking:tracking.size,conflicting_vehicles:conflicts.size,total_drivers:driverRows.length,eligible_drivers:eligible.size,ignored_profiles:driverRows.length-eligible.size}};
  }
  async function readPublished(token,{vehicles:sharedVehicles,sources:sharedSources}={}) {
    if(typeof token!=='string'||!token)throw new Error('Session locale requise pour les alertes de déplacement.');
    const at=now(),[sourceRows,driverRows,vehicleRows,latestRows,identityRows,alertRows]=await Promise.all([
      sharedSources||list('fleet_sources',{select:SOURCE_FIELDS}),list('fleet_drivers',{select:DRIVER_FIELDS},token),
      sharedVehicles||list('vehicles',{select:'key,plate,other_plates,geotab_id'},token),list('fleet_latest',{select:LATEST_FIELDS},token),
      list('fleet_identities',{select:'id,driver_id,source'},token),db(TABLE,{params:{select:ALERT_FIELDS,order:'opened_at.desc,id',limit:'500'},token})
    ]);
    const sources=new Map(sourceRows.map(row=>[row.id,row])),drivers=new Map(driverRows.map(row=>[row.id,row])),vehicles=new Map(vehicleRows.map(row=>[row.key,row]));
    const latest=new Map(latestRows.map(row=>[row.identity_id,row])),activities=activitiesFor(latestRows,identityRows,sourceRows,at),counts=assignmentCounts(driverRows);
    for(const key of conflictingVehicleAssignments({drivers:driverRows,latest:latestRows,sources:sourceRows,vehicles:vehicleRows,now:at}))counts.set(key,2);
    const alerts=(alertRows||[]).filter(alert=>drivers.has(alert.driver_id)&&vehicles.has(alert.vehicle_key)).map(alert=>{
      const driver=drivers.get(alert.driver_id),row=latest.get(alert.identity_id),activity=activities.get(alert.driver_id);
      let status=alert.status;
      if(status!=='resolved'){
        if(activity?.status==='online')status='resolved';
        else if(status!=='open'||activity?.status!=='offline'||!sourceFresh(sources.get('geotab'),at)||!sourceFresh(sources.get(alert.source),at)||
          !row||row.driver_id!==alert.driver_id||row.source!==alert.source||row.status!=='offline'||stamp(row.offline_since)!==stamp(alert.observed_since)||
          driver.vehicle_key!==alert.vehicle_key||!assignmentCurrent(driver,at,sources)||counts.get(alert.vehicle_key)!==1)status='suspended';
      }
      return {...alert,status,key:alert.vehicle_key,plate:vehicles.get(alert.vehicle_key).plate,driver_name:driver.name,at:alert.opened_at,ign_on:alert.evidence?.ign_on??null};
    });
    // Private checkpoints belong to the collector. Observer desktops display
    // persisted incidents and never reconstruct its in-memory distance state.
    return {alerts,watches:[],coverage:null};
  }
  return {update,read,readPublished};
}
