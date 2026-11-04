import {resolveBackendTarget} from './database-target.mjs';
import {assertLocalSupabase} from './fleet.mjs';
import {createTelemetryContinuityService} from './telemetry-continuity-service.mjs';

const COLUMNS = 'id,source,source_event_id,device_id,vehicle_key,observed_at,collected_at,received_at,version,fingerprint,observation,origin,mapping_basis';
const unavailable = () => Object.assign(new Error('Archive Geotab locale indisponible.'), {code: 'telemetry_local_storage'});

/** Each consumer still receives the original Geotab callback independently.
 * Start archive extraction before consumers can mutate their input. Archive
 * callbacks await the local journal only, not the background database RPC. */
export function geotabArchiveCallbacks({archive, onTelemetry = async () => {}, onPositions = async () => {}}) {
  if (typeof archive?.onGeotabTelemetry !== 'function' || typeof archive?.onGeotabPositions !== 'function' ||
      typeof onTelemetry !== 'function' || typeof onPositions !== 'function') throw new TypeError('Callbacks Geotab requis.');
  const deliver = (save, consume, args) => Promise.allSettled([
    Promise.resolve().then(() => save(...args)), Promise.resolve().then(() => consume(...args))
  ]).then(([, result]) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  return Object.freeze({onGeotabTelemetry: rows => deliver(archive.onGeotabTelemetry, onTelemetry, [rows]),
    onGeotabPositions: (rows, source) => deliver(archive.onGeotabPositions, onPositions, [rows, source])});
}

/** This adapter is server-only. No HTTP route exposes observation reads or
 * reconciliation; authenticated admin status receives aggregate health only. */
export function createLocalTelemetryContinuity({supabaseUrl,databaseTarget, serviceKey, pendingPath, fetchFn = fetch, now = Date.now,
  onTelemetry = async () => {}, onPositions = async () => {}} = {}) {
  const base = resolveBackendTarget(supabaseUrl,databaseTarget);
  if (typeof serviceKey !== 'string' || !serviceKey || /[\r\n]/.test(serviceKey) || typeof fetchFn !== 'function') throw new TypeError('Client Supabase local requis.');
  async function request(resource, {method = 'GET', params, body, signal} = {}) {
    const timeout = AbortSignal.timeout(10000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchFn(base + '/rest/v1/' + resource + (params ? '?' + params.toString() : ''), {
        method, headers: {apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json'},
        redirect: 'error', signal: requestSignal, ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      if (!response.ok) throw unavailable();
      return await response.json();
    } catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason;
      throw unavailable();
    }
  }
  const db = {
    rpc(name, args, {signal} = {}) {
      if (name !== 'telemetry_archive_ingest') throw unavailable();
      return request('rpc/telemetry_archive_ingest', {method: 'POST', body: args, signal});
    },
    readObservations({vehicleKey, metric, from, to, receivedBefore, offset, limit, signal}) {
      const dates = [from, to, receivedBefore];
      if (typeof vehicleKey !== 'string' || !vehicleKey.trim() || vehicleKey.length > 200 || /[\u0000-\u001f\u007f]/.test(vehicleKey) ||
          !['distance_km', 'fuel_l'].includes(metric) || dates.some(date => typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) ||
          Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 31 * 86400000 ||
          !Number.isSafeInteger(offset) || offset < 0 || offset > 20000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw unavailable();
      const params = new URLSearchParams({select: COLUMNS, vehicle_key: 'eq.' + vehicleKey, source: 'eq.geotab',
        'observation->>metric': 'eq.' + metric, received_at: 'lte.' + receivedBefore, order: 'observed_at.asc,id.asc',
        offset: String(offset), limit: String(limit)});
      params.append('observed_at', 'gte.' + from); params.append('observed_at', 'lte.' + to);
      return request('telemetry_observations', {params, signal});
    }
  };
  const archive = createTelemetryContinuityService({db, pendingPath, now});
  return Object.freeze({...archive, ...geotabArchiveCallbacks({archive, onTelemetry, onPositions})});
}
