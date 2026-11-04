import {privateModeValid,syncPrivateDirectory} from './private-files.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeTelemetryObservation, appendTelemetryArchive, deriveTelemetryIntervals, reconcileTelemetryIntervals} from './telemetry-continuity.mjs';

const DEFAULT_PENDING_PATH = fileURLToPath(new URL('../.local/telemetry/pending.json', import.meta.url));
const MAX_FILE_BYTES = 32 * 1024 * 1024, MAX_RPC_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, HASH = /^[a-f0-9]{64}$/;
const COUNTERS = {
  odometer_m: {metric: 'distance_km', diagnostic: 'DiagnosticOdometerId', meaning: 'odometer', unit: 'm', scale: 1000},
  total_fuel_l: {metric: 'fuel_l', diagnostic: 'DiagnosticDeviceTotalFuelId', meaning: 'fuel_consumed', unit: 'L', scale: 1}
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fault = code => Object.assign(new Error('Archivage télémétrique indisponible.'), {code});
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const semanticKey = event => {
  const observation = {...event.observation}; delete observation.receivedAt;
  return hash({source: event.source, source_event_id: event.source_event_id, device_id: event.device_id,
    vehicle_key: event.vehicle_key, observation, origin: event.origin});
};
const eventId = observation => hash([observation.source, observation.sourceId, observation.kind,
  observation.counterId || 'position', observation.observedAt]);

function eventOf(input, origin) {
  const observation = normalizeTelemetryObservation({...input, id: 'pending'});
  observation.id = eventId(observation);
  return {source: 'geotab', source_event_id: observation.id, device_id: observation.sourceId,
    vehicle_key: observation.vehicleKey, observed_at: observation.observedAt, collected_at: observation.receivedAt,
    observation, origin: {...origin, sample_at: observation.observedAt}};
}

/** Extract only actual provider samples. Daily derived totals, tank levels and
 * provider-request success are not independent distance/fuel/network facts. */
export function geotabArchiveEvents(rows, {kind, collectedAt} = {}) {
  if (!Array.isArray(rows) || rows.length > 20000 || !['telemetry', 'positions'].includes(kind)) throw new TypeError('Lot Geotab invalide.');
  const events = [], issues = {}, associations = new Map();
  const issue = reason => {issues[reason] = (issues[reason] || 0) + 1;};
  for (const row of rows) {
    const device = kind === 'telemetry' ? row?.id ?? row?.device_id : row?.device_id;
    const vehicle = row?.key ?? row?.vehicle_key;
    if (typeof device === 'string' && typeof vehicle === 'string') {
      if (!associations.has(device)) associations.set(device, new Set()); associations.get(device).add(vehicle);
    }
  }
  for (const row of rows) {
    const device = kind === 'telemetry' ? row?.id ?? row?.device_id : row?.device_id;
    const vehicle = row?.key ?? row?.vehicle_key;
    if (!device || !vehicle || row?.key && row?.vehicle_key && row.key !== row.vehicle_key ||
        kind === 'telemetry' && row?.id && row?.device_id && row.id !== row.device_id || associations.get(device)?.size !== 1) {
      issue('uncertain_vehicle_device'); continue;
    }
    const common = {vehicleKey: vehicle, source: 'geotab', sourceId: device, quality: 'good', receivedAt: collectedAt};
    if (kind === 'positions') {
      try {
        if (row.at && row.last_pos_at && Date.parse(row.at) !== Date.parse(row.last_pos_at)) throw new TypeError();
        events.push(eventOf({...common, kind: 'gps', observedAt: row.at || row.last_pos_at,
          latitude: row.lat, longitude: row.lon, accuracyM: null}, {field: 'position', unit: 'deg', raw_value: null}));
      } catch {issue('invalid_position_or_time');}
      continue;
    }
    for (const [field, metric] of Object.entries(COUNTERS)) {
      if (row[field] == null && row.counter_at?.[field] == null) continue;
      try {
        if (!finite(row[field]) || row[field] > Number.MAX_SAFE_INTEGER) throw new TypeError();
        events.push(eventOf({...common, kind: 'counter', observedAt: row.counter_at?.[field],
          metric: metric.metric, counterId: metric.diagnostic, counterMeaning: metric.meaning, value: row[field] / metric.scale},
        {field, unit: metric.unit, raw_value: row[field]}));
      } catch {issue('invalid_counter_or_time');}
    }
  }
  return {events, issues};
}

function checkedEvent(input) {
  const observation = normalizeTelemetryObservation(input?.observation);
  const origin = input?.origin;
  if (input.source !== 'geotab' || observation.source !== 'geotab' || !['gps', 'counter'].includes(observation.kind) ||
      observation.id !== eventId(observation) || input.source_event_id !== observation.id || input.device_id !== observation.sourceId ||
      input.vehicle_key !== observation.vehicleKey || Date.parse(input.observed_at) !== Date.parse(observation.observedAt) || Date.parse(input.collected_at) !== Date.parse(observation.receivedAt) ||
      origin?.sample_at !== observation.observedAt) throw fault('invalid_archive_event');
  if (observation.kind === 'gps') {
    if (origin.field !== 'position' || origin.unit !== 'deg' || origin.raw_value !== null) throw fault('invalid_archive_event');
  } else {
    const metric = COUNTERS[origin.field];
    if (!metric || metric.metric !== observation.metric || metric.diagnostic !== observation.counterId || origin.unit !== metric.unit ||
        !finite(origin.raw_value) || origin.raw_value / metric.scale !== observation.value) throw fault('invalid_archive_event');
  }
  return {source: 'geotab', source_event_id: observation.id, device_id: observation.sourceId,
    vehicle_key: observation.vehicleKey, observed_at: observation.observedAt, collected_at: observation.receivedAt,
    observation, origin: {field: origin.field, unit: origin.unit, raw_value: origin.raw_value, sample_at: origin.sample_at}};
}

function checkedReceipt(result, events) {
  if (result?.error) throw fault('archive_database');
  const value = result?.data ?? result;
  if (!value || value.received !== events.length || !Array.isArray(value.rows) || value.rows.length !== events.length ||
      ['inserted', 'duplicates', 'conflicts'].some(field => !Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > events.length) ||
      value.inserted + value.duplicates !== events.length || value.conflicts > value.inserted) throw fault('archive_receipt');
  const expected = new Map();
  for (const event of events) expected.set(event.source_event_id, (expected.get(event.source_event_id) || 0) + 1);
  let duplicates = 0;
  for (const row of value.rows) {
    if (!UUID.test(row?.id || '') || !HASH.test(row?.fingerprint || '') || !Number.isSafeInteger(row.version) || row.version < 1 ||
        typeof row.duplicate !== 'boolean' || !expected.get(row.source_event_id)) throw fault('archive_receipt');
    expected.set(row.source_event_id, expected.get(row.source_event_id) - 1); duplicates += Number(row.duplicate);
  }
  if (duplicates !== value.duplicates) throw fault('archive_receipt');
  return value;
}

/** Server-only service. db uses the already authorized local service client.
 * RPC is atomic and verifies the current unique device/vehicle association.
 * readObservations must apply vehicle + metric + observed-time bounds,
 * receivedBefore, stable observed_at,id ordering and the supplied offset/limit. All versions
 * are required: a revised counter is a conflict, not a replacement fact.
 *
 * Callbacks wait for a private atomic journal, never for the database. Failed
 * batches stay on disk after bounded retries; retryPending() is explicit.
 * Only this process may own pendingPath. No Texat polling or active failover.
 */
export function createTelemetryContinuityService({db, pendingPath = DEFAULT_PENDING_PATH, now = Date.now,
  maxPending = 20000, batchSize = 500, retryDelaysMs = [1000, 5000, 30000, 120000], requestTimeoutMs = 10000,
  setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  if (typeof db?.rpc !== 'function' || !isAbsolute(pendingPath) || typeof now !== 'function' ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 20000 ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500 ||
      !Array.isArray(retryDelaysMs) || retryDelaysMs.length > 10 || retryDelaysMs.some(delay => !Number.isSafeInteger(delay) || delay < 1) ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) throw new TypeError('Configuration d’archive invalide.');
  let pending = new Map(), loaded = false, queue = Promise.resolve(), draining = null, timer = null, closed = false, activeController = null;
  let storageError = null, databaseError = null, lastSuccessAt = null, rejected = 0, persisted = true;
  const issues = {}, totals = {inserted: 0, duplicates: 0, conflicts: 0};
  const serial = work => {const task = queue.then(work); queue = task.catch(() => {}); return task;};
  const time = () => {const value = now(); if (!Number.isSafeInteger(value)) throw fault('archive_clock'); return value;};
  const status = () => ({status: closed ? 'closed' : storageError || databaseError || [...pending.values()].some(entry => entry.attempts > 0) || Object.keys(issues).length || rejected ? 'warning' : pending.size ? 'pending' : loaded ? 'healthy' : 'initializing',
    pending: pending.size, persisted, exhausted: [...pending.values()].filter(entry => entry.attempts > retryDelaysMs.length).length,
    rejected, issues: {...issues}, storageError, databaseError, lastSuccessAt, ...totals,
    texat: {enabled: false, reason: 'provider_api_not_configured'}, activeFailover: false});
  const addIssues = found => {for (const [reason, count] of Object.entries(found)) issues[reason] = (issues[reason] || 0) + count;};
  async function load() {
    if (loaded) return;
    let file;
    try {
      file = await open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || !privateModeValid(stat, 0o600, pendingPath) || stat.size > MAX_FILE_BYTES) throw fault('pending_store_unavailable');
      const value = JSON.parse(await file.readFile('utf8'));
      if (value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > maxPending) throw fault('pending_store_unavailable');
      const restored = new Map();
      for (const entry of value.pending) {
        const event = checkedEvent(entry.event), key = semanticKey(event);
        if (entry.key !== key || restored.has(key) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > 11 ||
            !Number.isSafeInteger(entry.retryAt) || entry.retryAt < 0) throw fault('pending_store_unavailable');
        restored.set(key, {key, event, attempts: entry.attempts, retryAt: entry.retryAt});
      }
      pending = restored; loaded = true; storageError = null;
    } catch (error) {
      if (error.code === 'ENOENT') {loaded = true; storageError = null; return;}
      storageError = 'pending_store_unavailable'; throw fault(storageError);
    } finally {await file?.close();}
  }
  async function save() {
    const temporary = pendingPath + '.' + randomUUID() + '.tmp'; let file;
    try {
      const data = JSON.stringify({version: 1, pending: [...pending.values()]}) + '\n';
      if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw fault('pending_store_full');
      await mkdir(dirname(pendingPath), {recursive: true, mode: 0o700});
      const directory = await lstat(dirname(pendingPath));
      if (!directory.isDirectory() || directory.isSymbolicLink() || !privateModeValid(directory, 0o700, dirname(pendingPath))) throw fault('pending_store_unavailable');
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(data); await file.sync(); await file.close(); file = null;
      await rename(temporary, pendingPath);
      await syncPrivateDirectory(dirname(pendingPath));
      storageError = null; persisted = true;
    } catch (error) {storageError = error.code === 'pending_store_full' ? error.code : 'pending_store_unavailable'; persisted = false; throw fault(storageError);}
    finally {await file?.close(); await rm(temporary, {force: true}).catch(() => {});}
  }
  function schedule() {
    if (timer !== null) clearTimer(timer); timer = null;
    if (closed || !loaded) return;
    const due = [...pending.values()].filter(entry => entry.attempts <= retryDelaysMs.length).map(entry => entry.retryAt);
    if (!due.length) return;
    timer = setTimer(() => {timer = null; void drain();}, Math.max(0, Math.min(...due) - time())); timer?.unref?.();
  }
  async function rpc(events) {
    activeController = new AbortController(); const controller = activeController;
    let timeout;
    const expired = new Promise((_, reject) => {timeout = setTimer(() => {controller.abort(); reject(fault('archive_timeout'));}, requestTimeoutMs); timeout?.unref?.();});
    const stopped = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(fault(closed ? 'archive_closed' : 'archive_timeout')), {once: true}));
    try {return checkedReceipt(await Promise.race([db.rpc('telemetry_archive_ingest', {p_events: events}, {signal: controller.signal}), expired, stopped]), events);}
    finally {clearTimer(timeout); if (activeController === controller) activeController = null;}
  }
  function drain() {
    if (closed) return Promise.resolve(status());
    if (draining) return draining;
    draining = (async () => {
      try {await serial(load);} catch {return status();}
      while (!closed) {
        const batch = await serial(async () => {
          const due = [...pending.values()].filter(entry => entry.attempts <= retryDelaysMs.length && entry.retryAt <= time());
          if (!due.length) return [];
          const first = due[0], selected = []; let bytes = 32;
          for (const entry of due) {
            if (entry.event.vehicle_key !== first.event.vehicle_key || entry.event.device_id !== first.event.device_id) continue;
            const length = Buffer.byteLength(JSON.stringify(entry.event)) + 1;
            if (selected.length === batchSize || bytes + length >= MAX_RPC_BYTES) break;
            selected.push(entry); bytes += length;
          }
          return selected;
        });
        if (!batch.length) break;
        let receipt = null, failure = null;
        try {receipt = await rpc(batch.map(entry => entry.event));}
        catch (error) {failure = ['archive_timeout', 'archive_receipt'].includes(error?.code) ? error.code : 'archive_database';}
        if (closed) break;
        await serial(async () => {
          if (receipt) {
            for (const entry of batch) pending.delete(entry.key);
            for (const field of Object.keys(totals)) totals[field] += receipt[field];
            if (![...pending.values()].some(entry => entry.attempts > 0)) databaseError = null;
            lastSuccessAt = new Date(time()).toISOString();
          } else {
            databaseError = failure;
            for (const entry of batch) {
              entry.attempts += 1;
              entry.retryAt = time() + (retryDelaysMs[entry.attempts - 1] || 0);
            }
          }
          await save().catch(() => {});
        });
      }
      return status();
    })().finally(() => {draining = null; schedule();});
    return draining;
  }
  async function enqueue(rows, kind) {
    if (closed) return {accepted: 0, persisted: false, reason: 'archive_closed'};
    let extracted;
    try {extracted = geotabArchiveEvents(rows, {kind, collectedAt: new Date(time()).toISOString()});}
    catch {issues.invalid_callback = (issues.invalid_callback || 0) + 1; return {accepted: 0, persisted: false, reason: 'invalid_callback'};}
    addIssues(extracted.issues);
    const result = await serial(async () => {
      if (closed) return {accepted: 0, persisted: false, reason: 'archive_closed'};
      try {await load();} catch {rejected += extracted.events.length; return {accepted: 0, persisted: false, reason: 'pending_store_unavailable'};}
      let accepted = 0, duplicates = 0, overflow = 0;
      for (const event of extracted.events) {
        const key = semanticKey(event);
        if (pending.has(key)) {duplicates++; continue;}
        if (pending.size >= maxPending) {overflow++; continue;}
        pending.set(key, {key, event, attempts: 0, retryAt: time()}); accepted++;
      }
      rejected += overflow;
      if (overflow) issues.pending_capacity = (issues.pending_capacity || 0) + overflow;
      if (accepted || !persisted) await save().catch(() => {});
      return {accepted, duplicates, rejected: overflow, persisted};
    });
    void drain(); return result;
  }
  async function retryPending() {
    if (closed) return status();
    await serial(async () => {await load(); for (const entry of pending.values()) {entry.attempts = 0; entry.retryAt = time();} await save();});
    return drain();
  }
  async function reconcile({vehicleKey, metric, from, to, previous = null, signal} = {}) {
    if (typeof db.readObservations !== 'function') throw fault('archive_reader_unavailable');
    if (closed) throw fault('archive_closed');
    const at = new Date(time()).toISOString();
    // Let the pure engine validate identifiers, dates and physical metric first.
    const empty = reconcileTelemetryIntervals([], {vehicleKey, metric, from, to, at, previous});
    if (Date.parse(empty.to) - Date.parse(empty.from) > 31 * 86400000 || Date.parse(empty.to) > time()) throw fault('archive_window');
    const rows = [], ids = new Set();
    for (let offset = 0; ; offset += 1000) {
      signal?.throwIfAborted();
      const result = await db.readObservations({vehicleKey, metric, from: empty.from, to: empty.to, receivedBefore: at, offset, limit: 1000, signal});
      if (result?.error) throw fault('archive_read');
      const page = result?.data ?? result;
      if (!Array.isArray(page) || page.length > 1000 || rows.length + page.length > 20000) throw fault('archive_read_incomplete');
      for (const row of page) {
        if (!UUID.test(row?.id || '') || ids.has(row.id) || !HASH.test(row?.fingerprint || '') || !Number.isSafeInteger(row.version) || row.version < 1 ||
            row.vehicle_key !== vehicleKey || Date.parse(row.observed_at) < Date.parse(empty.from) || Date.parse(row.observed_at) > Date.parse(empty.to) ||
            !Number.isFinite(Date.parse(row.received_at)) || Date.parse(row.received_at) > Date.parse(at)) throw fault('archive_read_incomplete');
        const event = checkedEvent(row);
        ids.add(row.id); rows.push({...row, observation: event.observation});
      }
      if (page.length < 1000) break;
    }
    signal?.throwIfAborted();
    const archive = appendTelemetryArchive(null, rows.map(row => row.observation), {at});
    // SQL versions also include raw provenance. Never merge a database conflict
    // merely because normalization yields the same floating-point observation.
    const databaseVersions = new Map();
    for (const row of rows) {
      const observation = row.observation, key = JSON.stringify([observation.vehicleKey, observation.source, observation.sourceId, observation.channel, observation.id]);
      if (!databaseVersions.has(key)) databaseVersions.set(key, new Set()); databaseVersions.get(key).add(row.fingerprint);
    }
    for (const [recordKey, fingerprints] of databaseVersions) if (fingerprints.size > 1 && !archive.conflicts.some(conflict => conflict.recordKey === recordKey)) {
      archive.conflicts.push({recordKey, versionIds: [...fingerprints], basis: 'database_provenance_versions'});
    }
    const derived = deriveTelemetryIntervals(archive), result = reconcileTelemetryIntervals(derived.intervals, {vehicleKey, metric, from: empty.from, to: empty.to, at, previous});
    return {...result, derivationIssues: derived.issues, archiveEvidence: rows.map(row => ({id: row.id, version: row.version,
      fingerprint: row.fingerprint, sourceEventId: row.source_event_id, archiveVersionId: hash(Object.fromEntries(Object.entries(row.observation).filter(([key]) => key !== 'receivedAt'))),
      receivedAt: row.received_at, mappingBasis: row.mapping_basis || 'current_at_receipt'})),
    archiveCoverage: {complete: true, observations: rows.length, conflicts: archive.conflicts.length, pendingLocal: pending.size,
      bounds: 'observed_at inclusive at both counter endpoints', receivedBefore: at}};
  }
  async function close() {
    closed = true; if (timer !== null) clearTimer(timer); timer = null; activeController?.abort();
    await queue; await draining; return status();
  }
  return Object.freeze({onGeotabTelemetry: rows => enqueue(rows, 'telemetry'), onGeotabPositions: rows => enqueue(rows, 'positions'),
    start: () => drain(), flush: () => drain(), retryPending, reconcile, status, close});
}
