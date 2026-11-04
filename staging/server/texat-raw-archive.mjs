import {constants} from 'node:fs';
import {lstat, mkdir, open, readdir, rename, rm} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {TEKSAT_CONTRACT} from './texat.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SEGMENT = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.jsonl$/;
const RECOVERY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.jsonl\.interrupted-[a-f0-9-]{36}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = code => Object.assign(new Error('Archive brute Teksat indisponible.'), {code});
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sourceDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);

/** Current receipt-time identity only. Provider dates remain verbatim and do
 * not become UTC observations. No addresses, plates, driver names or secrets. */
export function rawTeksatObservation(position, {vehicleKey, evidenceId} = {}) {
  if (!position || !UUID.test(position.providerVehicleId || '') || !/^\d{14,17}$/.test(position.deviceId || '') ||
      !label(vehicleKey) || !/^[a-f0-9]{64}$/.test(evidenceId || '') || !utc(position.collectedAt) ||
      !sourceDate(position.dateGpsRaw) || !sourceDate(position.datePositionRaw) || typeof position.privateMode !== 'boolean' ||
      typeof position.moving !== 'boolean' || !Number.isSafeInteger(position.providerStatusCode) ||
      (!position.privateMode && !(Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90 && Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180))) throw failure('texat_archive_schema');
  return {source: 'texat', contractVersion: TEKSAT_CONTRACT.version,
    providerVehicleId: position.providerVehicleId.toLowerCase(), deviceId: position.deviceId, vehicleKey,
    mappingBasis: 'current_at_receipt', mappingEvidenceId: evidenceId, receivedAt: position.collectedAt,
    dateGpsRaw: position.dateGpsRaw, datePositionRaw: position.datePositionRaw, timeZone: null, normalized: false,
    privateMode: position.privateMode, latitude: position.privateMode ? null : position.latitude,
    longitude: position.privateMode ? null : position.longitude, moving: position.moving, providerStatusCode: position.providerStatusCode};
}

function canonical(input) {
  const value = rawTeksatObservation({providerVehicleId: input?.providerVehicleId, deviceId: input?.deviceId,
    collectedAt: input?.receivedAt, dateGpsRaw: input?.dateGpsRaw, datePositionRaw: input?.datePositionRaw,
    privateMode: input?.privateMode, latitude: input?.latitude, longitude: input?.longitude,
    moving: input?.moving, providerStatusCode: input?.providerStatusCode}, {vehicleKey: input?.vehicleKey, evidenceId: input?.mappingEvidenceId});
  if (Object.keys(input).length !== Object.keys(value).length || Object.keys(value).some(key => input[key] !== value[key])) throw failure('texat_archive_schema');
  const signature = {...value}; delete signature.receivedAt;
  const sourceEventId = hash([value.source, value.providerVehicleId, value.deviceId, value.dateGpsRaw, value.datePositionRaw]);
  return {value, sourceEventId, fingerprint: hash(signature)};
}

/** Append-only, private, durable journal. No automatic deletion or pruning.
 * Interrupted tails are preserved in full under .interrupted-* before the
 * valid prefix is recovered. At the cap, collection must stop explicitly. */
export async function createTeksatRawArchive({directory, now = Date.now, segmentBytes = 8 * 1024 * 1024,
  maxBytes = 512 * 1024 * 1024} = {}) {
  if (!isAbsolute(directory || '') || !Number.isSafeInteger(segmentBytes) || segmentBytes < 1024 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < segmentBytes) throw failure('texat_archive_configuration');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const checkDirectory = async() => {const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || !privateModeValid(stat,0o700,directory)) throw failure('texat_archive_permissions');};
  await checkDirectory();
  const syncDirectory = () => syncPrivateDirectory(directory);
  let file = null, fileBytes = 0, bytes = 0, segments = 0, interruptedFiles = 0, entries = 0, duplicates = 0, lastSave = null;
  let closed = false, closing = false, queue = Promise.resolve(), lastError = null, reloadRequired = false, pending = [], pendingBytes = 0;
  const fingerprints = new Set(), versions = new Map();
  const stamp = () => {const value = now(); if (!Number.isSafeInteger(value)) throw failure('texat_archive_clock'); return new Date(value).toISOString();};
  async function load() {
    await checkDirectory(); bytes = 0; segments = 0; interruptedFiles = 0; entries = 0; lastSave = null; fingerprints.clear(); versions.clear();
    const names = (await readdir(directory)).filter(name => SEGMENT.test(name) || RECOVERY.test(name)).sort();
    if (names.length > 4096) throw failure('texat_archive_file_limit');
    for (const name of names) {
      const filename = join(directory, name), fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let buffer;
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || !privateModeValid(stat,0o600,filename) || stat.size > segmentBytes * 2) throw failure('texat_archive_permissions');
        bytes += stat.size; if (bytes > maxBytes) throw failure('texat_archive_full');
        buffer = await fd.readFile();
      } finally {await fd.close();}
      if (RECOVERY.test(name)) {
        // Also replay the valid prefix from a preserved interrupted file. A
        // crash between its rename and recovery-file creation loses no facts.
        interruptedFiles++; buffer = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
      } else segments++;
      if (!RECOVERY.test(name) && buffer.length && buffer.at(-1) !== 10) {
        const end = buffer.lastIndexOf(10) + 1, valid = buffer.subarray(0, end);
        if (bytes + valid.length > maxBytes) throw failure('texat_archive_full');
        await rename(filename, filename + '.interrupted-' + randomUUID()); await syncDirectory();
        const recovered = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {await recovered.writeFile(valid); await recovered.sync();} finally {await recovered.close();}
        await syncDirectory(); bytes += valid.length; interruptedFiles++; buffer = valid;
      }
      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line) continue;
        let record; try {record = JSON.parse(line);} catch {throw failure('texat_archive_corrupt');}
        const {schemaVersion, sourceEventId, fingerprint, version, archivedAt, ...raw} = record;
        const normalized = canonical(raw);
        if (schemaVersion !== 1 || fingerprint !== normalized.fingerprint || sourceEventId !== normalized.sourceEventId ||
            !Number.isSafeInteger(version) || version < 1 || !utc(archivedAt)) throw failure('texat_archive_corrupt');
        versions.set(sourceEventId, Math.max(versions.get(sourceEventId) || 0, version));
        if (!fingerprints.has(fingerprint)) {entries++; fingerprints.add(fingerprint);}
        if (lastSave === null || archivedAt > lastSave) lastSave = archivedAt;
      }
    }
    reloadRequired = false;
  }
  await load();
  try {
    const fd = await open(join(directory, 'pending.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat(); if (!stat.isFile() || !privateModeValid(stat,0o600,join(directory,'pending.json')) || stat.size > segmentBytes) throw failure('texat_archive_permissions');
      pendingBytes = stat.size; pending = JSON.parse(await fd.readFile('utf8'));
      if (!Array.isArray(pending) || pending.length > 500) throw failure('texat_archive_schema'); pending.forEach(canonical);
    } finally {await fd.close();}
  } catch (error) {if (error.code !== 'ENOENT') throw failure(error.code?.startsWith('texat_archive_') ? error.code : 'texat_archive_corrupt');}
  const getStatus = () => ({enabled: !closed && !closing, bytes: bytes + pendingBytes, segments, entries, duplicates, interruptedFiles, maxBytes, pending: pending.length,
    rotationBytes: segmentBytes, retention: 'no_automatic_deletion', warning: bytes >= maxBytes * 0.8 ? 'archive_near_capacity' : null,
    full: lastError === 'texat_archive_full' || bytes + pendingBytes >= maxBytes, lastSave, lastError});
  async function appendNow(observations) {
    if (closed) throw failure('texat_archive_closed');
    if (!Array.isArray(observations) || observations.length > 500) throw failure('texat_archive_schema');
    if (reloadRequired) await load();
    const at = stamp(), pendingFingerprints = new Set(), pendingVersions = new Map(versions), batch = [];
    for (const input of observations) {
      const {value, sourceEventId, fingerprint} = canonical(input);
      if (value.receivedAt > at) throw failure('texat_archive_clock');
      if (fingerprints.has(fingerprint) || pendingFingerprints.has(fingerprint)) {duplicates++; continue;}
      const version = (pendingVersions.get(sourceEventId) || 0) + 1; pendingVersions.set(sourceEventId, version); pendingFingerprints.add(fingerprint);
      batch.push({schemaVersion: 1, ...value, sourceEventId, fingerprint, version, archivedAt: at});
    }
    if (!batch.length) return {inserted: 0, ...getStatus()};
    const payload = Buffer.from(batch.map(record => JSON.stringify(record) + '\n').join(''));
    if (payload.length > segmentBytes) throw failure('texat_archive_batch_limit');
    if (bytes + pendingBytes + payload.length > maxBytes) throw failure('texat_archive_full');
    await checkDirectory();
    if (!file || fileBytes + payload.length > segmentBytes) {
      await file?.close(); file = null;
      const filename = join(directory, at.replace(/[:.]/g, '-') + '-' + randomUUID() + '.jsonl');
      file = await open(filename, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await syncDirectory(); fileBytes = 0; segments++;
    }
    try {await file.writeFile(payload); await file.sync();}
    catch {await file.close().catch(() => {}); file = null; reloadRequired = true; throw failure('texat_archive_write');}
    fileBytes += payload.length; bytes += payload.length; entries += batch.length; lastSave = at;
    for (const record of batch) {fingerprints.add(record.fingerprint); versions.set(record.sourceEventId, record.version);}
    lastError = null; return {inserted: batch.length, ...getStatus()};
  }
  async function flushPendingNow() {
    if (!pending.length) return {inserted: 0, ...getStatus()};
    const result = await appendNow(pending);
    await rm(join(directory, 'pending.json'), {force: true}); await syncDirectory(); pending = []; pendingBytes = 0; lastError = null;
    return {...result, ...getStatus()};
  }
  async function durableAppend(observations) {
    await flushPendingNow();
    if (!Array.isArray(observations) || observations.length > 500) throw failure('texat_archive_schema');
    const unique = observations.filter(value => !fingerprints.has(canonical(value).fingerprint));
    if (!unique.length) {duplicates += observations.length; return {inserted: 0, ...getStatus()};}
    const payload = Buffer.from(JSON.stringify(unique));
    if (payload.length > segmentBytes || bytes + payload.length * 3 > maxBytes) throw failure('texat_archive_full');
    await checkDirectory();
    const temporary = join(directory, '.pending-' + randomUUID() + '.tmp');
    const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {await fd.writeFile(payload); await fd.sync();} finally {await fd.close();}
    await rename(temporary, join(directory, 'pending.json')); await syncDirectory(); pending = unique; pendingBytes = payload.length;
    return flushPendingNow();
  }
  const enqueue = action => {
    if (closed || closing) return Promise.reject(failure('texat_archive_closed'));
    const task = queue.then(action).catch(error => {lastError = error.code?.startsWith('texat_archive_') ? error.code : 'texat_archive_write'; throw failure(lastError);});
    queue = task.catch(() => {}); return task;
  };
  return Object.freeze({getStatus,
    append(observations) {return enqueue(() => durableAppend(observations));},
    flushPending() {return enqueue(flushPendingNow);},
    async close() {closing = true; await queue; closed = true; await file?.close(); file = null;}
  });
}
import {privateModeValid,syncPrivateDirectory} from './private-files.mjs';
