import {privateModeValid} from './private-files.mjs';
import {readTexatConfig} from './texat-config.mjs';
import {createTeksatClient, TEKSAT_CONTRACT} from './texat.mjs';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname, isAbsolute} from 'node:path';
import {findTeksatMappingCandidates} from './texat-matching.mjs';
import {createTeksatRawArchive, rawTeksatObservation} from './texat-raw-archive.mjs';

const failure = (code, status = 503) => Object.assign(new Error('Lecture Teksat indisponible.'), {code, status});
const BLOCKERS = ['provider_time_zone_unconfirmed', 'provider_gps_quality_unconfirmed', 'vehicle_mapping_unconfirmed'];

/** Binds a privately observed branch to an account; password rotation does not
 * change the account, whereas replacing the company or login does. */
export function teksatAccountFingerprint(config) {
  if (!config || typeof config.TEXAT_SOCIETE !== 'string' || typeof config.TEXAT_EMAIL !== 'string') return null;
  return createHash('sha256').update(JSON.stringify([config.TEXAT_SOCIETE.trim(), config.TEXAT_EMAIL.trim()])).digest('hex');
}

async function readMappingEvidence(filename) {
  if (!isAbsolute(filename || '')) throw failure('teksat_mapping_configuration', 400);
  const directory = await lstat(dirname(filename));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !privateModeValid(directory, 0o700, dirname(filename))) throw failure('teksat_mapping_permissions');
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat(); if (!stat.isFile() || !privateModeValid(stat, 0o600, filename) || stat.size > 65536) throw failure('teksat_mapping_permissions');
    const data = JSON.parse(await fd.readFile('utf8'));
    if (data.version !== 1 || !/^[a-f0-9]{64}$/.test(data.accountFingerprint || '') || !/^[a-f0-9]{64}$/.test(data.evidenceId || '') ||
        !Number.isSafeInteger(data.filialeId) || !Array.isArray(data.mappings) || !data.mappings.length || data.mappings.length > 500 ||
        data.mappings.some(row => typeof row.vehicleKey !== 'string' || !row.vehicleKey || !/^[a-f0-9-]{36}$/i.test(row.providerVehicleId || '') || !/^\d{14,17}$/.test(row.deviceId || '') || row.reason !== 'registered_plate_alias') ||
        ['vehicleKey', 'providerVehicleId', 'deviceId'].some(key => new Set(data.mappings.map(row => row[key])).size !== data.mappings.length)) throw failure('teksat_mapping_configuration');
    return data;
  } catch (error) {throw failure(error.code?.startsWith('teksat_mapping_') ? error.code : 'teksat_mapping_read');}
  finally {await fd.close();}
}

/** Scope and mapping evidence are server-only and account-bound. Explicit
 * start() enables only a durable raw journal, never normalized map failover. */
export async function createTeksatService({configPath, scope = null, readConfig = readTexatConfig,
  clientFactory = createTeksatClient, now = Date.now, minimumRefreshMs = 30000,
  archiveDirectory = null, mappingEvidencePath = null, loadVehicles = null, archiveFactory = createTeksatRawArchive,
  readEvidence = readMappingEvidence, schedule = setTimeout, cancelSchedule = clearTimeout} = {}) {
  if (scope !== null && (!Number.isSafeInteger(scope.filialeId) || scope.filialeId < 0 || !/^[a-f0-9]{64}$/.test(scope.accountFingerprint || '') ||
      Object.keys(scope).some(key => !['filialeId', 'accountFingerprint'].includes(key)))) throw failure('teksat_scope_invalid', 400);
  if (!Number.isSafeInteger(minimumRefreshMs) || minimumRefreshMs < 0) throw failure('teksat_configuration', 400);
  let config = await readConfig(configPath), client = null, inFlight = null, closed = false;
  let lastAttemptAt = null, lastSuccessAt = null, lastError = null, counts = null;
  const rawConfigured = !!(archiveDirectory || mappingEvidencePath || loadVehicles);
  if (rawConfigured && (!archiveDirectory || !mappingEvidencePath || typeof loadVehicles !== 'function' || !scope)) throw failure('teksat_mapping_configuration', 400);
  const evidence = rawConfigured ? await readEvidence(mappingEvidencePath) : null;
  if (evidence && (evidence.accountFingerprint !== scope.accountFingerprint || evidence.filialeId !== scope.filialeId)) throw failure('teksat_scope_account_mismatch', 409);
  const archive = rawConfigured ? await archiveFactory({directory: archiveDirectory, now}) : null;
  let running = false, timer = null, failures = 0, stoppedReason = null;
  const configured = () => !!config && ['TEXAT_SOCIETE', 'TEXAT_EMAIL', 'TEXAT_PASSWORD'].every(key => typeof config[key] === 'string' && config[key]);
  const getStatus = () => ({provider: 'Teksat', source: 'texat', contractVersion: TEKSAT_CONTRACT.version,
    configured: configured(), connection: closed ? 'closed' : inFlight ? 'checking' : lastError ? 'error' : lastSuccessAt ? 'verified' : 'not_checked',
    lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(), lastSuccessAt,
    lastError, scope: scope ? 'configured_branch' : 'account', coverage: counts ? {...counts} : null,
    activeFailover: false, collectionEnabled: running, archiveEnabled: running && !!archive,
    rawArchive: archive ? {...archive.getStatus(), collectionRunning: running, intervalSeconds: 60, consecutiveFailures: failures, stoppedReason,
      mappingBasis: 'current_at_receipt', normalization: 'unverified', mappedVehicles: evidence.mappings.length} : null,
    capabilities: {positionsReadable: lastSuccessAt !== null, positionTimeZone: null, gpsQualityConfirmed: false,
      networkObservation: false, odometer: false, fuelConsumption: false},
    blockingReasons: [...(!configured() ? ['credentials_incomplete'] : []),
      ...(scope && scope.accountFingerprint !== teksatAccountFingerprint(config) ? ['provider_scope_account_mismatch'] : []), ...BLOCKERS]});
  async function refreshReadOnly({signal} = {}) {
    if (closed) throw failure('teksat_closed', 409);
    if (inFlight) return inFlight;
    signal?.throwIfAborted(); const attempt = now();
    if (!Number.isSafeInteger(attempt)) throw failure('teksat_clock', 500);
    if (lastAttemptAt !== null && attempt - lastAttemptAt < minimumRefreshMs) throw failure('teksat_refresh_limited', 429);
    lastAttemptAt = attempt;
    inFlight = (async() => {
      try {
        if (running && archive) {
          await archive.flushPending();
          const archiveStatus = archive.getStatus();
          if (archiveStatus.full || archiveStatus.maxBytes - archiveStatus.bytes < 128 * 1024) throw failure('teksat_archive_full');
        }
        const fresh = await readConfig(configPath);
        if (closed) throw failure('teksat_closed', 409);
        if (JSON.stringify(fresh) !== JSON.stringify(config)) {client?.close(); client = null; lastSuccessAt = null; counts = null;}
        config = fresh; if (!configured()) throw failure('teksat_configuration', 409);
        if (scope && scope.accountFingerprint !== teksatAccountFingerprint(config)) throw failure('teksat_scope_account_mismatch', 409);
        if (closed) throw failure('teksat_closed', 409);
        client ??= clientFactory({credentials: config});
        const filter = scope ? {filialeId: scope.filialeId} : {};
        const catalogue = await client.readVehiclePage({...filter, page: 1, signal});
        let verified = null;
        if (running && archive) {
          if (catalogue.nextPage !== null) throw failure('teksat_mapping_catalogue_incomplete');
          const vehicles = await loadVehicles();
          if (!Array.isArray(vehicles)) throw failure('teksat_mapping_unavailable');
          const local = vehicles.map(row => ({...row, otherPlates: Array.isArray(row.other_plates) ? row.other_plates : typeof row.other_plates === 'string' ? row.other_plates.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean) : []}));
          const matches = findTeksatMappingCandidates(local, catalogue.rows, {catalogueComplete: true});
          verified = new Map();
          for (const expected of evidence.mappings) {
            const match = matches.candidates.find(row => row.providerVehicleId === expected.providerVehicleId && row.deviceId === expected.deviceId && row.vehicleKey === expected.vehicleKey);
            if (!match?.unambiguousCandidate || !match.reasons.includes('registered_plate_alias')) throw failure('teksat_mapping_changed');
            verified.set(expected.providerVehicleId, match);
          }
        }
        const positions = await client.readPositions({...filter, signal});
        signal?.throwIfAborted(); if (closed) throw failure('teksat_closed', 409);
        counts = {positionsReturned: positions.rows.length, privatePositions: positions.rows.filter(row => row.privateMode).length,
          catalogueTotal: catalogue.totalCount, cataloguePages: catalogue.totalPages,
          cataloguePagesRead: 1, catalogueComplete: catalogue.nextPage === null,
          confirmedMappings: 0};
        if (running && archive && verified) {
          const raw = [];
          for (const position of positions.rows) {
            const mapping = verified.get(position.providerVehicleId); if (!mapping) continue;
            if (mapping.deviceId !== position.deviceId) throw failure('teksat_mapping_changed');
            raw.push(rawTeksatObservation(position, {vehicleKey: mapping.vehicleKey, evidenceId: evidence.evidenceId}));
          }
          await archive.append(raw); counts.rawMappedPositions = raw.length; counts.rawMappedVehicles = verified.size;
        }
        lastSuccessAt = new Date(now()).toISOString(); lastError = null;
        failures = 0;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || closed) throw error;
        // The private journal retains the historical `texat_*` spelling.
        // Normalize only structured archive codes, never upstream error text.
        const code = /^texat_archive_[a-z_]+$/.test(error?.code || '') ? error.code.replace(/^texat_/, 'teksat_') : error?.code;
        lastError = /^teksat_[a-z_]+$/.test(code || '') ? code : 'teksat_unavailable';
        if (running) {
          failures++;
          if (/authentication|configuration|mapping|scope|archive_full|archive_permissions|archive_corrupt/.test(lastError) || failures >= 3) {
            running = false; stoppedReason = lastError; if (timer !== null) {cancelSchedule(timer); timer = null;}
          }
        }
        // Error text and upstream response bodies must never reach admin JSON.
      } finally {inFlight = null;}
      return getStatus();
    })();
    return inFlight;
  }
  function scheduleNext() {
    if (!running || closed || timer !== null) return;
    timer = schedule(async() => {timer = null; try {await refreshReadOnly();} catch {} finally {scheduleNext();}}, 60000);
    timer?.unref?.();
  }
  return Object.freeze({getStatus, refreshReadOnly,
    async start() {
      if (closed) throw failure('teksat_closed', 409);
      if (!archive) throw failure('teksat_archive_configuration', 409);
      if (running) return getStatus();
      running = true; stoppedReason = null; failures = 0;
      try {if (inFlight) await inFlight; if (lastAttemptAt === null || now() - lastAttemptAt >= minimumRefreshMs) await refreshReadOnly();}
      finally {scheduleNext();}
      return getStatus();
    },
    async close() {closed = true; running = false; if (timer !== null) cancelSchedule(timer); timer = null; client?.close(); client = null; config = null;
      await inFlight?.catch(() => {}); await archive?.close();}
  });
}
