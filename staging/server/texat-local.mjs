import {privateModeValid} from './private-files.mjs';
import {resolveBackendTarget} from './database-target.mjs';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {assertLocalSupabase} from './fleet.mjs';
import {readTexatConfig} from './texat-config.mjs';
import {createTeksatService, teksatAccountFingerprint} from './texat-service.mjs';

const PAGE = 1000, MAX_VEHICLES = 20000;
const VEHICLE_COLUMNS = 'key,plate,other_plates,vin,geotab_id,active';
const BLOCKERS = ['provider_time_zone_unconfirmed', 'provider_gps_quality_unconfirmed', 'vehicle_mapping_unconfirmed'];
const failure = (code, status = 503) => Object.assign(new Error('Service Teksat local indisponible.'), {code, status});
const safeCode = error => /^teksat_[a-z_]+$/.test(error?.code || '') ? error.code
  : /^texat_config_[a-z_]+$/.test(error?.code || '') ? error.code.replace(/^texat_/, 'teksat_') : 'teksat_local_unavailable';

/** The envelope may contain private review metadata; only the two validated
 * account-bound scope fields are passed to the provider service. */
export async function readLocalTeksatScope(filename) {
  if (!isAbsolute(filename || '')) throw failure('teksat_scope_path');
  let file;
  try {
    const parent = await lstat(dirname(filename));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !privateModeValid(parent, 0o700, dirname(filename))) throw failure('teksat_scope_permissions');
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || !privateModeValid(stat, 0o600, filename) || stat.size > 8192) throw failure('teksat_scope_permissions');
    const buffer = Buffer.alloc(8193), {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw failure('teksat_scope_size');
    const envelope = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), scope = envelope?.scope;
    if (!envelope || Array.isArray(envelope) || envelope.version !== undefined && envelope.version !== 1 ||
        !scope || Array.isArray(scope) || !Number.isSafeInteger(scope.filialeId) || scope.filialeId < 0 ||
        !/^[a-f0-9]{64}$/.test(scope.accountFingerprint || '') ||
        Object.keys(scope).some(key => !['filialeId', 'accountFingerprint'].includes(key))) throw failure('teksat_scope_invalid');
    return Object.freeze({filialeId: scope.filialeId, accountFingerprint: scope.accountFingerprint});
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure(/^teksat_scope_[a-z_]+$/.test(error?.code || '') ? error.code : 'teksat_scope_read');
  } finally {await file?.close();}
}

/** Side-effect-free construction. start() belongs exclusively to the server
 * which has acquired its listening socket: the service constructor can recover
 * and write its journal, so even constructing it before listen is forbidden. */
export function createLocalTeksat({supabaseUrl,databaseTarget, serviceKey, localDirectory, fetchFn = fetch,
  readConfig = readTexatConfig, readScope = readLocalTeksatScope, serviceFactory = createTeksatService} = {}) {
  const base = resolveBackendTarget(supabaseUrl,databaseTarget);
  if (typeof serviceKey !== 'string' || !serviceKey || /[\r\n]/.test(serviceKey) ||
      !isAbsolute(localDirectory || '') || [fetchFn, readConfig, readScope, serviceFactory].some(value => typeof value !== 'function')) {
    throw new TypeError('Configuration Teksat locale requise.');
  }
  const configPath = join(localDirectory, 'texat.json'), scopePath = join(localDirectory, 'texat-scope.json');
  const lifetime = new AbortController();
  let service = null, initializing = null, serviceClosing = null, closing = null, closed = false, phase = 'not_started';
  let cached = {provider: 'Teksat', source: 'texat', configured: false, connection: 'not_checked',
    lastAttemptAt: null, lastSuccessAt: null, lastError: null, scope: 'unconfigured', coverage: null,
    activeFailover: false, collectionEnabled: false, archiveEnabled: false, rawArchive: null,
    capabilities: {positionsReadable: false, positionTimeZone: null, gpsQualityConfirmed: false,
      networkObservation: false, odometer: false, fuelConsumption: false},
    blockingReasons: ['teksat_local_not_started', ...BLOCKERS]};
  function getStatus() {
    if (!closed && phase === 'ready' && service) cached = service.getStatus();
    return structuredClone({...cached, lifecycle: phase, ...(closed ? {connection: 'closed', collectionEnabled: false,
      archiveEnabled: false, ...(cached.rawArchive ? {rawArchive: {...cached.rawArchive, collectionRunning: false}} : {})} : {})});
  }
  const check = () => {if (closed) throw failure('teksat_closed', 409);};
  async function request(resource, params, {count = false} = {}) {
    check();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]);
    try {
      const response = await fetchFn(base + '/rest/v1/' + resource + '?' + params, {method: 'GET',
        headers: {apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, ...(count ? {Prefer: 'count=exact'} : {})},
        redirect: 'error', signal});
      check();
      if (!response.ok) throw failure('teksat_local_database');
      const data = await response.json(); check();
      return {data, range: response.headers.get('content-range')};
    } catch {check(); throw failure('teksat_local_database');}
  }
  async function loadVehicles() {
    const rows = [], seen = new Set(); let expected = null;
    for (let offset = 0; offset <= MAX_VEHICLES; offset += PAGE) {
      const {data, range} = await request('vehicles', new URLSearchParams({select: VEHICLE_COLUMNS,
        order: 'key.asc', offset: String(offset), limit: String(PAGE)}), {count: true});
      const match = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(range || ''), total = match ? Number(match[3]) : NaN;
      if (!Array.isArray(data) || !Number.isSafeInteger(total) || total > MAX_VEHICLES ||
          expected !== null && total !== expected || data.length !== Math.min(PAGE, Math.max(0, total - offset)) ||
          data.length && (Number(match[1]) !== offset || Number(match[2]) !== offset + data.length - 1)) throw failure('teksat_mapping_inventory_incomplete');
      expected = total;
      for (const row of data) {
        if (!row || typeof row.key !== 'string' || !row.key || seen.has(row.key) ||
            Object.keys(row).some(key => !VEHICLE_COLUMNS.split(',').includes(key))) throw failure('teksat_mapping_inventory_changed');
        seen.add(row.key); rows.push(row);
      }
      if (rows.length === expected) return rows;
    }
    throw failure('teksat_mapping_inventory_incomplete');
  }
  function closeService() {
    if (service && !serviceClosing) serviceClosing = Promise.resolve().then(() => service.close());
    return serviceClosing;
  }
  function start() {
    if (closed) return Promise.reject(failure('teksat_closed', 409));
    if (initializing) return initializing;
    phase = 'initializing'; cached = {...cached, blockingReasons: ['teksat_local_initializing', ...BLOCKERS]};
    initializing = (async () => {
      try {
        const config = await readConfig(configPath); check();
        if (!config || !['TEXAT_SOCIETE', 'TEXAT_EMAIL', 'TEXAT_PASSWORD'].every(key => typeof config[key] === 'string' && config[key])) {
          phase = 'not_configured'; cached = {...cached, blockingReasons: ['credentials_incomplete', ...BLOCKERS]}; return getStatus();
        }
        cached = {...cached, configured: true};
        const scope = await readScope(scopePath); check();
        if (!scope) {phase = 'not_configured'; cached = {...cached, blockingReasons: ['teksat_scope_unconfigured', ...BLOCKERS]}; return getStatus();}
        if (scope.accountFingerprint !== teksatAccountFingerprint(config)) throw failure('teksat_scope_account_mismatch');
        const {data: marker} = await request('params', new URLSearchParams({select: 'value', key: 'eq.environment'}));
        if (!Array.isArray(marker) || marker.length !== 1 || marker[0]?.value !== (databaseTarget ? 'production' : 'staging')) throw failure('teksat_local_environment');
        check();
        service = await serviceFactory({configPath, scope, readConfig, archiveDirectory: join(localDirectory, 'texat', 'raw'),
          mappingEvidencePath: join(localDirectory, 'texat-mapping-evidence.json'), loadVehicles});
        if (closed) {await closeService(); return getStatus();}
        cached = service.getStatus();
        await service.start(); check();
        phase = 'ready'; return getStatus();
      } catch (error) {
        await closeService()?.catch(() => {});
        if (closed) return getStatus();
        phase = 'error'; cached = {...cached, connection: 'error', collectionEnabled: false, archiveEnabled: false,
          lastError: safeCode(error), blockingReasons: [safeCode(error), ...BLOCKERS]};
        throw failure(safeCode(error));
      }
    })();
    return initializing;
  }
  async function refreshReadOnly(options) {
    check();
    if (phase !== 'ready' || !service) throw failure('teksat_local_not_ready');
    const result = await service.refreshReadOnly(options); check(); cached = result;
    return getStatus();
  }
  function close() {
    if (closing) return closing;
    closed = true; phase = 'closed'; lifetime.abort();
    closing = (async () => {
      // Close an already constructed service immediately to abort its current
      // provider read, then await a constructor which may still be recovering.
      await Promise.allSettled([closeService(), initializing]);
      try {await closeService();} catch {throw failure('teksat_local_close');}
    })();
    return closing;
  }
  return Object.freeze({getStatus, refreshReadOnly, start, close});
}
