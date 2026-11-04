const ONLINE = new Set(['available', 'on_trip', 'to_pickup', 'on_break']);
export const isOnlinePlatformState = state => ONLINE.has(state);
export function currentPlatformObservation(row, source, now = Date.now()) {
  const at = Date.parse(row?.observed_at), success = Date.parse(source?.last_success_at);
  const ttl = Number(source?.stale_after_s) * 1000;
  return source?.status === 'healthy' && Number.isFinite(ttl) && ttl > 0 &&
    Number.isFinite(at) && at <= now + 5000 && now - at <= ttl &&
    Number.isFinite(success) && success <= now + 5000 && now - success <= ttl &&
    !['suspended', 'deactivated'].includes(String(row?.evidence?.account_status || '').toLowerCase());
}

// A connection must have been observed during this same service. Being absent
// from a list, initially offline, or returning after an interruption is not a
// newly observed disconnection.
export function advanceDisconnection(previous, {row, source, duty, policy = 'any', interruptions = [], now = Date.now()}) {
  if (!duty || !row?.identity_id || row.driver_id !== duty.driver_id ||
      !currentPlatformObservation(row, source, now) ||
      !ONLINE.has(row.status) && row.status !== 'offline' ||
      Date.parse(row.observed_at) < Date.parse(duty.started_at)) return {state: null, event: null};
  const at = Date.parse(row.observed_at), priorAt = Date.parse(previous?.observed_at);
  const same = previous?.version === 1 && previous.identity_id === row.identity_id && previous.driver_id === row.driver_id &&
    previous.source === row.source && previous.duty_key === duty.duty_key && previous.policy === policy;
  const interrupted = interruptions.some(event => ['myclicar', row.source].includes(event.source) && event.status !== 'healthy' &&
    Date.parse(event.at) >= priorAt && Date.parse(event.at) <= now);
  const continuous = same && !interrupted && Number.isFinite(priorAt) && priorAt <= now + 5000 && at - priorAt <= source.stale_after_s * 1000;
  if (continuous && at <= priorAt) return {state: previous, event: null};
  const online = ONLINE.has(row.status), wasOnline = continuous && ONLINE.has(previous.status);
  const state = {version: 1, identity_id: row.identity_id, driver_id: row.driver_id, source: row.source,
    duty_key: duty.duty_key, policy, status: row.status, observed_at: row.observed_at,
    online_at: online ? row.observed_at : continuous ? previous.online_at : null,
    offline_at: online ? null : wasOnline ? row.observed_at : continuous ? previous.offline_at : null};
  const event = !online && wasOnline ? {identity_id: row.identity_id, driver_id: row.driver_id, source: row.source,
    vehicle_key: duty.vehicle_key || null, contract_id: duty.contract_id || null, duty_key: duty.duty_key,
    observed_online_at: previous.observed_at, disconnected_at: row.observed_at,
    evidence: {kind: 'platform_disconnection', policy, contract_fingerprint: duty.contract_fingerprint,
      duty: {...duty.evidence, started_at:duty.started_at, ends_at:duty.ends_at || null}, previous_status: previous.status, status: 'offline'}} : null;
  return {state, event};
}
