// Consolidate only accounts already attached to the same canonical Ludy driver.
// Vehicle movement, names and a missing provider row never prove a driver is offline.
const PROVIDERS = new Set(['uber','bolt']);
const ONLINE = new Set(['available','on_trip','to_pickup','on_break']);
const INACTIVE = new Set(['deactivated','suspended']);
const FUTURE_TOLERANCE_MS = 5000;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const validId = value => typeof value === 'string' && value.length > 0;
const accountState = row => String(row?.evidence?.account_status || '').toLowerCase();
const sourceTtl = source => typeof source?.stale_after_s === 'number' && Number.isFinite(source.stale_after_s) && source.stale_after_s > 0 ? source.stale_after_s * 1000 : 90000;
const fresh = (at, now, ttl) => Number.isFinite(at) && at <= now + FUTURE_TOLERANCE_MS && now - at <= ttl;
const result = (status, reason, active = [], offline = [], since = null) => ({status, offline_since:since,
  active_sources:[...new Set(active)].sort(), offline_sources:[...new Set(offline)].sort(), reason});

/**
 * Online evidence takes priority over another account's offline state. An offline
 * verdict requires every known, non-disabled Uber/Bolt account to have a fresh,
 * explicit offline observation. Its start is when the last account went offline.
 * Inactive accounts are excluded only while their inactive evidence remains fresh.
 * This function is stateless; callers must pass the latest snapshot and source health.
 */
export function driverPlatformActivity({driverId, latest = [], identities, sources = [], now = Date.now()} = {}) {
  if (!Number.isFinite(now)) return result('unknown','invalid_time');
  if (!validId(driverId) || !Array.isArray(latest) || !Array.isArray(sources) || identities !== undefined && !Array.isArray(identities)) return result('unknown','invalid_input');
  const accounts = new Map(), declared = identities || [];
  const ensure = (id, source) => {
    let account = accounts.get(id);
    if (!account) { account = {source, rows:[], conflict:false}; accounts.set(id,account); }
    else if (account.source !== source) account.conflict = true;
    return account;
  };
  let malformedAccount = false;
  for (const identity of declared) {
    if (identity?.driver_id !== driverId || !PROVIDERS.has(identity.source)) continue;
    if (!validId(identity.id)) { malformedAccount = true; continue; }
    ensure(identity.id,identity.source);
  }
  for (const row of latest) {
    if (row?.driver_id !== driverId || !PROVIDERS.has(row.source)) continue;
    if (!validId(row.identity_id)) { malformedAccount = true; continue; }
    ensure(row.identity_id,row.source).rows.push(row);
  }
  // Concurrent identity/observation reads may add an account, but may not assign
  // another driver's account or a differently sourced identity to this driver.
  for (const identity of declared) {
    const account = accounts.get(identity?.id);
    if (account && (identity.driver_id !== driverId || identity.source !== account.source)) account.conflict = true;
  }
  for (const row of latest) {
    const account = accounts.get(row?.identity_id);
    if (account && (row.driver_id !== driverId || row.source !== account.source)) account.conflict = true;
  }
  if (!accounts.size && !malformedAccount) return result('unknown','no_known_platform');

  const active = [], offline = [], starts = [];
  let unknown = malformedAccount, usable = 0;
  for (const account of accounts.values()) {
    const sourceRows = sources.filter(source => source?.id === account.source);
    // A canonical source row is unique in the local database. Conflicting copies
    // or invalid observations fail closed instead of selecting an arbitrary value.
    const signatures = new Set(sourceRows.map(source => JSON.stringify([source.status,source.last_success_at,source.stale_after_s])));
    const source = sourceRows[0], ttl = sourceTtl(source);
    if (account.conflict || signatures.size !== 1 || source?.status !== 'healthy' || !fresh(stamp(source.last_success_at),now,ttl) || !account.rows.length || account.rows.some(row => !Number.isFinite(stamp(row.observed_at)))) {
      usable++; unknown = true; continue;
    }
    const latestAt = Math.max(...account.rows.map(row => stamp(row.observed_at)));
    const current = account.rows.filter(row => stamp(row.observed_at) === latestAt);
    const currentStates = new Set(current.map(row => JSON.stringify([row.status,row.offline_since || null,accountState(row)])));
    if (currentStates.size !== 1 || !fresh(latestAt,now,ttl)) { usable++; unknown = true; continue; }
    const row = current[0];
    if (INACTIVE.has(accountState(row))) continue;
    usable++;
    if (ONLINE.has(row.status)) { active.push(account.source); continue; }
    const since = stamp(row.offline_since);
    if (row.status !== 'offline' || !Number.isFinite(since) || since > latestAt || since > now) { unknown = true; continue; }
    offline.push(account.source); starts.push(since);
  }
  if (active.length) return result('online','platform_online',active,offline);
  if (unknown) return result('unknown','platform_state_unknown',active,offline);
  if (!usable) return result('unknown','no_active_platform');
  return result('offline','all_known_platforms_offline',active,offline,new Date(Math.max(...starts)).toISOString());
}
