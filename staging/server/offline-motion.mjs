// Pure reducer: no provider requests, database writes, identity guesses or engine commands.
// The caller stores one state per platform identity and persists alerts with an episode key.
const EARTH_RADIUS_M = 6371008.8;
const POSITION_MAX_AGE_MS = 60000;
const MAX_SAMPLE_GAP_MS = 60000;
const FUTURE_TOLERANCE_MS = 5000;
const MIN_SEGMENT_M = 10;
const MIN_MOVING_SPEED_KMH = 3;
const MAX_SPEED_KMH = 220;
export const OFFLINE_MOVEMENT_THRESHOLD_M = 200;

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validPoint = p => p && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && (p.lat !== 0 || p.lon !== 0);
const validSpeed = value => finite(value) && value >= 0 && value <= MAX_SPEED_KMH ? value : null;
const fresh = (at, now, maxAge) => Number.isFinite(at) && at <= now + FUTURE_TOLERANCE_MS && now - at <= maxAge;
const ttl = (value, fallback) => finite(value) && value > 0 ? value * 1000 : fallback;

export function gpsDistanceMetres(a, b) {
  if (!validPoint(a) || !validPoint(b)) return null;
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/**
 * Inputs use the local fleet_latest/fleet_sources/fleet_drivers names. `driver.vehicle_key`
 * must be an explicit, current assignment validated by the caller; names/plates never link people.
 * `position` is {at,lat,lon,speed,ign_on}; optional device_id detects a changed Geotab unit.
 * `geotab` is {status,last_success_at,stale_after_s}; both source and positions must be fresh.
 * Returns {state,alert,reason}; null state means observation cannot establish continuity.
 * A return to online/unknown or stale data resets measurement. Persisted alerts must also be
 * unique on (identity_id, vehicle_key, observed_since), including across process restarts.
 * Distance is a conservative GPS polyline, never an extrapolation or proof of a passenger ride.
 */
export function advanceOfflineMotion(previous, {row, source, driver, position, geotab, now = Date.now()} = {}) {
  const reset = reason => ({state:null, alert:null, reason});
  if (!finite(now)) return reset('invalid_time');
  if (!row || !['uber','bolt'].includes(row.source) || row.status !== 'offline') return reset('not_explicitly_offline');
  if (['deactivated','suspended'].includes(String(row.evidence?.account_status || '').toLowerCase())) return reset('account_inactive');
  if (!row.identity_id || !row.driver_id || !driver || driver.id !== row.driver_id || !driver.vehicle_key) return reset('assignment_missing');
  if (source?.id && source.id !== row.source) return reset('source_mismatch');
  const observedAt = time(row.observed_at), offlineAt = time(row.offline_since);
  if (source?.status !== 'healthy' || !fresh(observedAt, now, ttl(source?.stale_after_s, 90000))) return reset('platform_stale');
  if (!Number.isFinite(offlineAt) || offlineAt > observedAt || offlineAt > now) return reset('offline_start_missing');
  if (geotab?.status !== 'healthy' || !fresh(time(geotab?.last_success_at), now, ttl(geotab?.stale_after_s, 20000))) return reset('geotab_stale');
  const pointAt = time(position?.at);
  if (!validPoint(position) || !fresh(pointAt, now, POSITION_MAX_AGE_MS)) return reset('position_stale');
  if (pointAt < offlineAt) return reset('position_before_offline');

  // A renewal must overlap the last valid lease. A new contract or manual
  // confirmation resets measurement even when driver and vehicle stay equal.
  const automatic = ['platform_plate','myclicar_contract'].includes(driver.vehicle_link_method);
  const proof = driver.vehicle_link_evidence || {}, proofAt = time(proof.observed_at), proofExpiry = time(proof.expires_at);
  if (automatic && (!Number.isFinite(proofAt) || proofAt > now + FUTURE_TOLERANCE_MS || !Number.isFinite(proofExpiry) || proofExpiry <= now || proofExpiry <= proofAt)) return reset('assignment_stale');
  const assignment = driver.vehicle_link_method === 'myclicar_contract' ? ['myclicar_contract',proof.contract_id || null] :
    driver.vehicle_link_method === 'manual' ? ['manual',driver.link_evidence?.at || null] :
    automatic ? ['platform_plate'] : null;
  const episode = JSON.stringify([row.identity_id, row.driver_id, driver.vehicle_key, position.device_id || null, row.offline_since, assignment]);
  const point = {at:position.at, lat:position.lat, lon:position.lon, speed:validSpeed(position.speed), ign_on:typeof position.ign_on === 'boolean' ? position.ign_on : null};
  const initial = () => ({version:1, episode, identity_id:row.identity_id, driver_id:row.driver_id, source:row.source,
    vehicle_key:driver.vehicle_key, offline_since:row.offline_since, started_at:point.at,
    distance_m:0, anchor:point, last_point:point, last_observed_at:row.observed_at, alerted_at:null,
    assignment_expires_at:automatic ? proof.expires_at : null});
  if (!previous || previous.version !== 1 || previous.episode !== episode || !validPoint(previous.last_point) || !validPoint(previous.anchor) || !finite(previous.distance_m) || previous.distance_m < 0) {
    return {state:initial(), alert:null, reason:'baseline'};
  }
  if (automatic && (!Number.isFinite(time(previous.assignment_expires_at)) || proofAt > time(previous.assignment_expires_at))) {
    return {state:initial(), alert:null, reason:'assignment_gap'};
  }
  const renewed = automatic && previous.assignment_expires_at !== proof.expires_at ? {...previous,assignment_expires_at:proof.expires_at} : previous;
  const lastAt = time(previous.last_point.at);
  if (lastAt > now + FUTURE_TOLERANCE_MS || time(previous.last_observed_at) > now + FUTURE_TOLERANCE_MS) {
    return {state:initial(), alert:null, reason:'clock_regression'};
  }
  if (!Number.isFinite(lastAt) || pointAt - lastAt > MAX_SAMPLE_GAP_MS) {
    // A gap must not bridge unobserved travel; retain the already emitted episode marker.
    return {state:{...initial(), alerted_at:previous.alerted_at || null}, alert:null, reason:'position_gap'};
  }
  if (pointAt <= lastAt) return {state:renewed, alert:null, reason:'duplicate_or_older_position'};
  if (observedAt < time(previous.last_observed_at)) return {state:renewed, alert:null, reason:'older_platform_observation'};
  if (!fresh(time(previous.last_observed_at), observedAt, ttl(source?.stale_after_s, 90000))) {
    // A restart may hide the timer ticks that would normally notice an expired platform
    // observation. A fresh snapshot cannot retroactively prove continuity over that gap.
    return {state:initial(), alert:null, reason:'platform_gap'};
  }

  const segment = gpsDistanceMetres(previous.last_point, point);
  // Reject teleportation, allowing a small GPS uncertainty margin at short sampling periods.
  if (segment > MAX_SPEED_KMH / 3.6 * ((pointAt - lastAt) / 1000) + 20) {
    return {state:{...initial(), alerted_at:previous.alerted_at || null}, alert:null, reason:'implausible_jump'};
  }
  const state = {...renewed, last_point:point, last_observed_at:row.observed_at};
  const moving = point.speed !== null && point.speed >= MIN_MOVING_SPEED_KMH || previous.last_point.speed !== null && previous.last_point.speed >= MIN_MOVING_SPEED_KMH;
  if (!moving) {
    // Parked GPS drift or unknown speeds cannot earn distance. Engine off does not erase
    // earlier confirmed movement in this offline episode; a later restart continues it.
    state.anchor = point;
    return {state, alert:null, reason:point.speed === null ? 'motion_unconfirmed' : 'stationary'};
  }
  const distance = gpsDistanceMetres(previous.anchor, point);
  if (distance < MIN_SEGMENT_M) return {state, alert:null, reason:'below_gps_tolerance'};
  state.distance_m += distance;
  state.anchor = point;
  if (state.distance_m <= OFFLINE_MOVEMENT_THRESHOLD_M + 1e-6 || state.alerted_at) return {state, alert:null, reason:state.alerted_at ? 'already_alerted' : 'tracking'};

  state.alerted_at = new Date(now).toISOString();
  const alert = {kind:'offline_movement', severity:'critical', driver_id:row.driver_id, identity_id:row.identity_id,
    source:row.source, vehicle_key:driver.vehicle_key, observed_since:row.offline_since,
    opened_at:state.alerted_at, distance_m:Math.ceil(state.distance_m), threshold_m:OFFLINE_MOVEMENT_THRESHOLD_M,
    evidence:{method:'gps_segments', measurement_started_at:state.started_at, platform_observed_at:row.observed_at,
      geotab_at:point.at, ign_on:point.ign_on, speed_kmh:point.speed, engine_state:point.ign_on === true ? 'on' : point.ign_on === false ? 'off' : 'unknown',
      position_max_age_s:POSITION_MAX_AGE_MS / 1000, minimum_segment_m:MIN_SEGMENT_M,
      statement:'Déplacement observé après un statut hors ligne explicite ; motif à vérifier.'}};
  return {state, alert, reason:'threshold_exceeded'};
}
