import {serviceDuty} from './service-duty.mjs';
import {advanceDisconnection, currentPlatformObservation} from './platform-disconnections.mjs';
import {driverPlatformActivity} from './platform-activity.mjs';

const ALERTS = 'fleet_disconnection_alerts', CHECKPOINTS = 'fleet_disconnection_checkpoints';
const LIVE_FIELDS = 'identity_id,driver_id,source,status,observed_at,offline_since,evidence';
const stamp = value => new Date(value).toISOString();

export function createDisconnectionService({list, db, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  serialize = work => work(), Duty = serviceDuty}) {
  let pending = null, timer = null, closed = false, running = false, lastError = null;
  async function context() {
    const at = now();
    const [drivers, contracts, contractOverrides, vehicles, sources, params, latest, identities, settings, checkpoints, interruptions] = await Promise.all([
      list('fleet_drivers'), list('fleet_myclicar_contracts'),
      list('fleet_contract_assignment_overrides', {select:'contract_id,client_code,vehicle_key,effective_start_at'}),
      list('vehicles', {select:'key,plate,other_plates,agency_id,active'}),
      list('fleet_sources', {select:'id,status,last_success_at,stale_after_s'}),
      list('params', {select:'key,value', key:'in.(shiftDay,shiftNight,shiftAdvance,tzRules)'}),
      list('fleet_latest', {select:LIVE_FIELDS}), list('fleet_identities', {select:'id,driver_id,source'}),
      db('fleet_settings', {params:{id:'eq.1'}}), list(CHECKPOINTS),
      list('fleet_source_events', {select:'source,status,at', status:'neq.healthy', at:'gte.'+stamp(at-360000)})
    ]);
    const config = settings?.[0] || {}, enabled = config.disconnection_enabled === true;
    const policy = config.disconnection_policy === 'all' ? 'all' : 'any', mode = config.duty_mode === 'shift' ? 'shift' : 'contract';
    const duty = Duty({drivers, contracts, contractOverrides, vehicles, sources, params, now:at, mode});
    return {at, drivers, contracts, vehicles, sources, latest, identities, enabled, policy, mode, duty, interruptions,
      checkpoints:new Map(checkpoints.map(row=>[row.identity_id,row.state])),
      duties:new Map(duty.duties.map(row=>[row.driver_id,row])), sourceMap:new Map(sources.map(row=>[row.id,row])),
      latestMap:new Map(latest.map(row=>[row.identity_id,row]))};
  }
  function activity(ctx, driverId, after = null) {
    return driverPlatformActivity({driverId, latest:after === null ? ctx.latest : ctx.latest.filter(row=>Date.parse(row.observed_at)>=after),
      identities:ctx.identities, sources:ctx.sources, now:ctx.at});
  }
  function deferredEvent(state, row, duty) {
    const onlineAt = Date.parse(state?.online_at), offlineAt = Date.parse(state?.offline_at), since = Date.parse(row.offline_since);
    // The existing checkpoint retains a proven online -> offline transition.
    // Reuse it only while that same offline episode has remained continuous.
    if (!duty || state?.status !== 'offline' || !Number.isFinite(onlineAt) || !Number.isFinite(offlineAt) ||
        offlineAt <= onlineAt || !Number.isFinite(since) || since <= onlineAt || since > offlineAt ||
        onlineAt < Date.parse(duty.started_at)) return null;
    return {identity_id:row.identity_id, driver_id:row.driver_id, source:row.source,
      vehicle_key:duty.vehicle_key || null, contract_id:duty.contract_id || null, duty_key:duty.duty_key,
      observed_online_at:state.online_at, disconnected_at:state.offline_at,
      evidence:{kind:'platform_disconnection', policy:'all', contract_fingerprint:duty.contract_fingerprint,
        duty:{...duty.evidence, started_at:duty.started_at, ends_at:duty.ends_at || null},
        status:'offline', deferred_confirmation:true}};
  }
  function alertStatus(alert, ctx) {
    if (alert.status === 'resolved') return 'resolved';
    const row = ctx.latestMap.get(alert.identity_id), source = ctx.sourceMap.get(alert.source);
    // A fresh connection on either confirmed account ends the driver's
    // disconnection incident, including a switch from Bolt to Uber or back.
    if (activity(ctx, alert.driver_id, Date.parse(alert.disconnected_at)).status === 'online') return 'resolved';
    const contract = ctx.contracts.find(c=>c.external_id===alert.contract_id);
    // The active-contract feed may omit a record without supplying a return.
    // Only an actual return date ends the incident; lost eligibility suspends it.
    const returnedAt = Date.parse(contract?.end_at);
    if (ctx.duty.coverage.source_fresh && Number.isFinite(returnedAt) && returnedAt <= ctx.at) return 'resolved';
    if (alert.evidence?.duty?.ends_at && Date.parse(alert.evidence.duty.ends_at) <= ctx.at) return 'resolved';
    const duty = ctx.duties.get(alert.driver_id);
    if (duty && duty.duty_key !== alert.duty_key) return 'resolved';
    if (!ctx.enabled || !duty || !row || row.driver_id !== alert.driver_id || row.source !== alert.source ||
        !currentPlatformObservation(row, source, ctx.at) || row.status !== 'offline' ||
        Date.parse(row.observed_at) < Date.parse(alert.disconnected_at) || alert.evidence?.policy !== ctx.policy) return 'suspended';
    const since = Date.parse(row.offline_since);
    // offline_since also restarts after a collection gap: that proves neither
    // reconnection nor continuity with the old incident. Keep it suspended.
    if (!Number.isFinite(since) || since > Date.parse(alert.disconnected_at)) return 'suspended';
    const checkpoint = ctx.checkpoints.get(alert.identity_id), disconnectedAt = Date.parse(alert.disconnected_at);
    // A pause followed by a quick recovery need not reset the ingestion counter.
    // The retained transition must still match this incident. Once invalidated,
    // the checkpoint keeps it suspended even after recent source events expire.
    if (checkpoint?.version !== 1 || checkpoint.status !== 'offline' || checkpoint.driver_id !== alert.driver_id ||
        checkpoint.source !== alert.source || checkpoint.duty_key !== alert.duty_key || checkpoint.policy !== ctx.policy ||
        Date.parse(checkpoint.offline_at) !== disconnectedAt ||
        Date.parse(row.observed_at)-Date.parse(checkpoint.observed_at) > Number(source.stale_after_s)*1000 ||
        ctx.interruptions.some(event => ['myclicar',alert.source].includes(event.source) && event.status !== 'healthy' &&
          Date.parse(event.at) >= disconnectedAt && Date.parse(event.at) <= ctx.at)) return 'suspended';
    const current = activity(ctx, alert.driver_id);
    if (current.status === 'online' || ctx.policy === 'all' && current.status !== 'offline') return 'suspended';
    return 'open';
  }
  async function perform() {
    const ctx = await context(), at = stamp(ctx.at);
    const stored = await list(ALERTS, {status:'in.(open,suspended)', order:'disconnected_at.desc,id'});
    const previous = ctx.checkpoints, states = [], alerts = [], changes = [];
    const eventKey = event => JSON.stringify([event.identity_id,Date.parse(event.disconnected_at),event.duty_key]);
    const knownEvents = new Set(stored.map(eventKey)), activities = new Map();
    if (ctx.enabled) for (const identity of ctx.identities) {
      const row = ctx.latestMap.get(identity.id);
      if (!row || row.driver_id !== identity.driver_id || row.source !== identity.source) continue;
      if (!activities.has(row.driver_id)) activities.set(row.driver_id, activity(ctx, row.driver_id));
      const current = activities.get(row.driver_id), duty = ctx.duties.get(row.driver_id);
      const next = advanceDisconnection(previous.get(identity.id), {row, source:ctx.sourceMap.get(row.source),
        duty, policy:ctx.policy, interruptions:ctx.interruptions, now:ctx.at});
      // Once another account is online, this offline transition no longer
      // describes a driver disconnection and must not be replayed later.
      if (next.state?.status === 'offline' && current.status === 'online') next.state = {...next.state, offline_at:null};
      if (next.state) states.push({identity_id:identity.id, state:next.state, updated_at:at});
      // In all-platform mode, an unknown other account delays confirmation;
      // a later explicit offline read can confirm the retained transition.
      const event = next.event || (ctx.policy === 'all' && current.status === 'offline' ? deferredEvent(next.state,row,duty) : null);
      if (event && current.status !== 'online' && (ctx.policy === 'any' || current.status === 'offline') && !knownEvents.has(eventKey(event))) {
        alerts.push({...event, status:'open', opened_at:at, last_seen_at:at});knownEvents.add(eventKey(event));
      }
    }
    ctx.checkpoints = new Map(states.map(row=>[row.identity_id,row.state]));
    for (const alert of stored) {
      const status = alertStatus(alert, ctx);
      if (status !== alert.status) changes.push({id:alert.id, status, last_seen_at:at, resolved_at:status==='resolved'?at:null});
    }
    if (closed) return {ok:false};
    await db('rpc/fleet_commit_disconnections', {method:'POST', body:{p_states:states, p_alerts:alerts, p_changes:changes}});
    lastError = null;
    return {ok:true, expected_drivers:ctx.duty.duties.length, new_events:alerts.length};
  }
  function reconcile() {
    if (closed) return Promise.resolve({ok:false});
    if (pending) return pending;
    pending = perform().catch(error=>{lastError='Surveillance des déconnexions interrompue ; nouvelle vérification automatique en attente.';throw error;}).finally(()=>{pending=null;});
    return pending;
  }
  async function read(token, {admin = false} = {}) {
    const [ctx, visibleDrivers, visibleVehicles, records] = await Promise.all([
      context(), list('fleet_drivers', {select:'id,name,ludy_driver_code'}, token), list('vehicles', {select:'key,plate'}, token),
      db(ALERTS, {params:{order:'disconnected_at.desc,id',limit:'500'}, token})
    ]);
    const permitted = new Map(visibleDrivers.map(row=>[row.id,row])), vehicles = new Map(visibleVehicles.map(row=>[row.key,row]));
    const duties = ctx.duty.duties.filter(row=>permitted.has(row.driver_id));
    return {at:stamp(ctx.at), enabled:ctx.enabled, policy:ctx.policy, duty_mode:ctx.mode,
      coverage:{...(admin?ctx.duty.coverage:{}), expected_drivers:duties.length, source_fresh:ctx.duty.coverage.source_fresh},
      warnings:[...(admin?ctx.duty.warnings:ctx.duty.coverage.source_fresh?[]:[{code:'duty_source_unavailable',message:'Les contrats actuels ne peuvent pas être confirmés.'}]),
        ...(lastError?[{code:'watch_interrupted',message:lastError}]:[])],
      alerts:(records || []).filter(row=>permitted.has(row.driver_id)).map(row=>({...row,
        driver_name:permitted.get(row.driver_id).name, vehicle_key:vehicles.has(row.vehicle_key)?row.vehicle_key:null,
        plate:vehicles.get(row.vehicle_key)?.plate || null, status:alertStatus(row,ctx)}))};
  }
  async function readPublished(token,{sources:sharedSources}={}) {
    if(typeof token!=='string'||!token)throw new Error('Session requise pour les déconnexions.');
    const at=now(),[drivers,vehicles,sources,latest,identities,settings,records]=await Promise.all([
      list('fleet_drivers',{select:'id,name,ludy_driver_code,vehicle_key'},token),list('vehicles',{select:'key,plate'},token),
      sharedSources||list('fleet_sources',{select:'id,status,last_success_at,stale_after_s'}),list('fleet_latest',{select:LIVE_FIELDS},token),
      list('fleet_identities',{select:'id,driver_id,source'},token),db('fleet_settings',{params:{id:'eq.1'},token}),
      db(ALERTS,{params:{order:'disconnected_at.desc,id',limit:'500'},token})
    ]);
    const config=settings?.[0]||{},enabled=config.disconnection_enabled===true,policy=config.disconnection_policy==='all'?'all':'any',mode=config.duty_mode==='shift'?'shift':'contract';
    const permitted=new Map(drivers.map(row=>[row.id,row])),visibleVehicles=new Map(vehicles.map(row=>[row.key,row])),sourceMap=new Map(sources.map(row=>[row.id,row]));
    const latestMap=new Map(latest.map(row=>[row.identity_id,row])),fresh=source=>source?.status==='healthy'&&Number.isFinite(Date.parse(source.last_success_at))&&at-Date.parse(source.last_success_at)>=-5000&&at-Date.parse(source.last_success_at)<=Number(source.stale_after_s)*1000;
    const alerts=(records||[]).filter(alert=>permitted.has(alert.driver_id)).map(alert=>{
      const row=latestMap.get(alert.identity_id),current=driverPlatformActivity({driverId:alert.driver_id,latest,identities,sources,now:at});
      let status=alert.status;
      if(status!=='resolved'){
        const connected=driverPlatformActivity({driverId:alert.driver_id,latest:latest.filter(item=>Date.parse(item.observed_at)>=Date.parse(alert.disconnected_at)),identities,sources,now:at});
        if(connected.status==='online'||Date.parse(alert.evidence?.duty?.ends_at)<=at)status='resolved';
        else if(status!=='open'||!enabled||alert.evidence?.policy!==policy||row?.driver_id!==alert.driver_id||row?.source!==alert.source||!currentPlatformObservation(row,sourceMap.get(alert.source),at)||row?.status!=='offline'||
          !(Date.parse(row?.observed_at)>=Date.parse(alert.disconnected_at))||Date.parse(row?.offline_since)>Date.parse(alert.disconnected_at)||!Number.isFinite(Date.parse(row?.offline_since))||current.status==='online'||policy==='all'&&current.status!=='offline'||
          mode==='contract'&&!fresh(sourceMap.get('myclicar')))status='suspended';
      }
      return {...alert,status,driver_name:permitted.get(alert.driver_id).name,vehicle_key:visibleVehicles.has(alert.vehicle_key)?alert.vehicle_key:null,plate:visibleVehicles.get(alert.vehicle_key)?.plate||null};
    });
    return {at:stamp(at),enabled,policy,duty_mode:mode,collectionRemote:true,coverage:{expected_drivers:null,source_fresh:mode!=='contract'||fresh(sourceMap.get('myclicar'))},warnings:[],alerts};
  }
  function schedule() {
    if (closed || !running) return;
    timer = setTimer(async()=>{timer=null;try{await serialize(()=>reconcile());}catch{}finally{schedule();}},5000);
    timer?.unref?.();
  }
  async function start() {
    if (running || closed) return;
    running=true;
    try{await serialize(()=>reconcile());}catch{}finally{schedule();}
  }
  function close() {closed=true;running=false;clearTimer(timer);timer=null;}
  return {reconcile,read,readPublished,start,close,get error(){return lastError;}};
}
