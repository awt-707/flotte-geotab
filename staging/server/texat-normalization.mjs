import {createHash} from 'node:crypto';
import {TEKSAT_CONTRACT} from './texat.mjs';
import {rawTeksatObservation} from './texat-raw-archive.mjs';
import {normalizeTelemetryMapping, resolveTelemetryMapping} from './telemetry-mapping.mjs';
import {normalizeTelemetryObservation, appendTelemetryArchive, advanceTelemetryContinuity,
  deriveTelemetryIntervals, reconcileTelemetryIntervals} from './telemetry-continuity.mjs';

const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error('Préparation de normalisation Teksat indisponible.'), {code});
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw fail('teksat_contract_schema');
}
function utc(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fail('teksat_contract_time');
  return value;
}

/** Mechanical schema validation is not verification of a supplier document.
 * No default timezone, status-code meaning or approval is supplied here. */
export function validateTeksatNormalizationContract(input) {
  keys(input, ['version', 'id', 'accountFingerprint', 'apiContractVersion', 'validFrom', 'validTo', 'evidenceRefs', 'receiptEvidenceIds', 'gps', 'offsets']);
  if (input.version !== 1 || !bounded(input.id) || !HASH.test(input.accountFingerprint || '') || input.apiContractVersion !== TEKSAT_CONTRACT.version ||
      !Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.length > 20 || input.evidenceRefs.some(value => !bounded(value)) ||
      !Array.isArray(input.receiptEvidenceIds) || !input.receiptEvidenceIds.length || input.receiptEvidenceIds.length > 100 || input.receiptEvidenceIds.some(value => !HASH.test(value))) throw fail('teksat_contract_schema');
  const validFrom = utc(input.validFrom), validTo = utc(input.validTo);
  if (validTo <= validFrom) throw fail('teksat_contract_time');
  keys(input.gps, ['timestampField', 'timestampMeaning', 'coordinateReference', 'qualityCodes']);
  if (!['dateGpsRaw', 'datePositionRaw'].includes(input.gps.timestampField) || input.gps.timestampMeaning !== 'coordinate_measurement' || input.gps.coordinateReference !== 'WGS84') throw fail('teksat_contract_gps_semantics');
  keys(input.gps.qualityCodes, ['good', 'degraded', 'invalid']);
  const codes = new Set(), qualityCodes = {};
  for (const quality of ['good', 'degraded', 'invalid']) {
    const values = input.gps.qualityCodes[quality];
    if (!Array.isArray(values) || values.length > 100 || quality === 'good' && !values.length) throw fail('teksat_contract_quality');
    qualityCodes[quality] = [...values].sort((a, b) => a - b);
    for (const code of values) {if (!Number.isSafeInteger(code) || codes.has(code)) throw fail('teksat_contract_quality'); codes.add(code);}
  }
  if (!Array.isArray(input.offsets) || !input.offsets.length || input.offsets.length > 256) throw fail('teksat_contract_offsets');
  let cursor = validFrom;
  const offsets = input.offsets.map(row => {
    keys(row, ['from', 'to', 'offsetMinutes']);
    const from = utc(row.from), to = utc(row.to);
    if (from !== cursor || to <= from || !Number.isSafeInteger(row.offsetMinutes) || Math.abs(row.offsetMinutes) > 840) throw fail('teksat_contract_offsets');
    cursor = to; return {from, to, offsetMinutes: row.offsetMinutes};
  });
  if (cursor !== validTo) throw fail('teksat_contract_offsets');
  const contract = {version: 1, id: input.id, accountFingerprint: input.accountFingerprint, apiContractVersion: input.apiContractVersion,
    validFrom, validTo, evidenceRefs: [...new Set(input.evidenceRefs)].sort(), receiptEvidenceIds: [...new Set(input.receiptEvidenceIds)].sort(), gps: {timestampField: input.gps.timestampField,
      timestampMeaning: 'coordinate_measurement', coordinateReference: 'WGS84', qualityCodes}, offsets};
  return {contract, fingerprint: hash(contract)};
}

const capabilities = () => ({mode: 'preparatory_preview', effectiveActivation: false, providerProofAutomaticallyVerified: false,
  supportedMeasurements: ['gps'], distance: false, fuelConsumption: false, networkObservation: false, hardwareIndependenceConfirmed: false});

/** The caller must obtain an explicit operator review separately from the
 * candidate contract. A supplier payload or evidence reference is not approval. */
export function checkTeksatNormalizationContract(input, {accountFingerprint, approval = null, at} = {}) {
  let validated;
  try {validated = validateTeksatNormalizationContract(input); utc(at);} catch (error) {
    return {ready: false, schemaValid: false, reasons: [error.code || 'teksat_contract_schema'], capabilities: capabilities()};
  }
  const reasons = [];
  if (!HASH.test(accountFingerprint || '') || accountFingerprint !== validated.contract.accountFingerprint) reasons.push('teksat_contract_account_mismatch');
  if (!approval || !bounded(approval.operatorId) || approval.evidenceReviewed !== true || approval.contractFingerprint !== validated.fingerprint) reasons.push('teksat_operator_review_required');
  else {try {if (utc(approval.approvedAt) > at) reasons.push('teksat_operator_review_not_yet_known');} catch {reasons.push('teksat_operator_review_required');}}
  return {ready: reasons.length === 0, schemaValid: true, reasons, contractId: validated.contract.id,
    contractFingerprint: validated.fingerprint, basis: 'explicit_operator_review', capabilities: capabilities()};
}

/** Explicit bounded offset schedule. DST folds are ambiguous, gaps are
 * invalid, and sub-millisecond precision is never silently rounded. */
export function resolveTeksatSourceTime(value, contractInput) {
  const {contract} = validateTeksatNormalizationContract(contractInput);
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw fail('teksat_source_time_invalid');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number), fraction = match[7] || '', zone = match[8];
  if (year < 1900 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || /[1-9]/.test(fraction.slice(3))) throw fail('teksat_source_time_invalid');
  const local = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3)));
  if (new Date(local).getUTCDate() !== day || new Date(local).getUTCMonth() + 1 !== month) throw fail('teksat_source_time_invalid');
  let explicitOffset = null;
  if (zone) {
    explicitOffset = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4)));
    if (Math.abs(explicitOffset) > 840 || zone !== 'Z' && Number(zone.slice(4)) > 59) throw fail('teksat_source_time_invalid');
  }
  const candidates = [];
  for (const window of contract.offsets) {
    if (explicitOffset !== null && explicitOffset !== window.offsetMinutes) continue;
    const candidate = local - window.offsetMinutes * 60000;
    if (candidate >= Date.parse(window.from) && candidate < Date.parse(window.to)) candidates.push(new Date(candidate).toISOString());
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw fail(unique.length > 1 ? 'teksat_source_time_ambiguous' : 'teksat_source_time_not_covered');
  return unique[0];
}

function checkRawRecord(record) {
  const raw = rawTeksatObservation({providerVehicleId: record?.providerVehicleId, deviceId: record?.deviceId,
    collectedAt: record?.receivedAt, dateGpsRaw: record?.dateGpsRaw, datePositionRaw: record?.datePositionRaw,
    privateMode: record?.privateMode, latitude: record?.latitude, longitude: record?.longitude,
    moving: record?.moving, providerStatusCode: record?.providerStatusCode}, {vehicleKey: record?.vehicleKey, evidenceId: record?.mappingEvidenceId});
  const signature = {...raw}; delete signature.receivedAt;
  const expected = [...Object.keys(raw), 'schemaVersion', 'sourceEventId', 'fingerprint', 'version', 'archivedAt'];
  if (Object.keys(record).length !== expected.length || expected.some(key => !Object.hasOwn(record, key)) || Object.keys(raw).some(key => raw[key] !== record[key]) ||
      record.schemaVersion !== 1 || record.source !== 'texat' || record.contractVersion !== TEKSAT_CONTRACT.version || record.normalized !== false || record.timeZone !== null ||
      record.mappingBasis !== 'current_at_receipt' || record.fingerprint !== hash(signature) ||
      record.sourceEventId !== hash(['texat', raw.providerVehicleId, raw.deviceId, raw.dateGpsRaw, raw.datePositionRaw]) || !Number.isSafeInteger(record.version) || record.version < 1) throw fail('teksat_raw_archive_invalid');
  if (utc(record.archivedAt) < raw.receivedAt) throw fail('teksat_raw_archive_invalid');
  return raw;
}

/** Only confirmed historical mappings can attach a measurement to a vehicle.
 * Receipt-time vehicleKey is kept as lineage, never used as temporal proof. */
export function normalizeTeksatRawBatch(records, {contract: input, accountFingerprint, approval, mappings = [], at} = {}) {
  if (!Array.isArray(records) || records.length > 20000) throw fail('teksat_raw_batch_limit');
  const check = checkTeksatNormalizationContract(input, {accountFingerprint, approval, at}), issues = {}, observations = [], lineage = [];
  const issue = reason => {issues[reason] = (issues[reason] || 0) + 1;};
  if (!check.ready) return {blocked: true, check, observations, lineage, issues: Object.fromEntries(check.reasons.map(reason => [reason, records.length]))};
  const {contract} = validateTeksatNormalizationContract(input), accepted = [], latestPrivacy = new Map();
  for (const record of records) {
    try {
      const raw = checkRawRecord(record);
      if (!contract.receiptEvidenceIds.includes(raw.mappingEvidenceId)) {issue('teksat_receipt_evidence_not_approved'); continue;}
      if (raw.receivedAt > at || record.archivedAt > at) {issue('teksat_raw_not_yet_received'); continue;}
      accepted.push({record, raw}); const previous = latestPrivacy.get(raw.deviceId);
      if (!previous || raw.receivedAt > previous.at) latestPrivacy.set(raw.deviceId, {at: raw.receivedAt, privateMode: raw.privateMode});
      else if (raw.receivedAt === previous.at && raw.privateMode) previous.privateMode = true;
    } catch {issue('teksat_raw_archive_invalid');}
  }
  for (const {record, raw} of accepted) {
    try {
      if (raw.privateMode || latestPrivacy.get(raw.deviceId)?.privateMode) {issue('teksat_provider_private_mode'); continue;}
      const observedAt = resolveTeksatSourceTime(raw[contract.gps.timestampField], contract);
      const result = resolveTelemetryMapping(mappings, {source: 'texat', sourceId: raw.deviceId, observedAt, knownAt: at});
      if (!result.confirmed) {issue(result.reason); continue;}
      const quality = ['good', 'degraded', 'invalid'].find(value => contract.gps.qualityCodes[value].includes(raw.providerStatusCode)) || 'unknown';
      const observation = normalizeTelemetryObservation({id: hash(['teksat-gps', record.sourceEventId]), source: 'texat', sourceId: raw.deviceId,
        vehicleKey: result.mapping.vehicleKey, kind: 'gps', observedAt, receivedAt: raw.receivedAt,
        quality, latitude: raw.latitude, longitude: raw.longitude, accuracyM: null});
      observations.push(observation);
      lineage.push({observationId: observation.id, rawFingerprint: record.fingerprint, rawVersion: record.version,
        contractFingerprint: check.contractFingerprint, mappingId: result.mapping.id,
        receiptVehicleKey: raw.vehicleKey, mappingBasis: result.basis});
      if (quality !== 'good') issue('teksat_quality_' + quality);
    } catch (error) {issue(/^teksat_[a-z_]+$/.test(error?.code || '') ? error.code : 'teksat_normalization_rejected');}
  }
  return {blocked: false, check, observations, lineage, issues};
}

/** Read-only materialization through the actual continuity engine. It never
 * updates the live map, raw journal, database or metric totals. */
export function previewTeksatContinuity({rawRecords = [], contract, accountFingerprint, approval, mappings = [],
  geotabObservations = [], vehicleKey, at, policy, previous = null, metricWindows = []} = {}) {
  if (!bounded(vehicleKey)) throw fail('teksat_preview_vehicle');
  utc(at);
  if (!Array.isArray(rawRecords) || rawRecords.length > 20000 || !Array.isArray(mappings) || mappings.length > 20000 ||
      !Array.isArray(geotabObservations) || geotabObservations.length > 20000 || !Array.isArray(metricWindows) || metricWindows.length > 10) throw fail('teksat_preview_limit');
  // Scope diagnostics as well as coordinates. Receipt-time membership can
  // admit a row for inspection, but never establishes its historical mapping.
  const devices = new Set(mappings.map(normalizeTelemetryMapping).filter(row => row.source === 'texat' && row.vehicleKey === vehicleKey && row.confirmedAt <= at).map(row => row.sourceId));
  const rawForVehicle = rawRecords.filter(row => row?.vehicleKey === vehicleKey || devices.has(row?.deviceId));
  const normalized = normalizeTeksatRawBatch(rawForVehicle, {contract, accountFingerprint, approval, mappings, at});
  if (previous && previous.contractFingerprint !== (normalized.check.contractFingerprint || null)) throw fail('teksat_preview_contract_changed');
  const primary = geotabObservations.map(input => {
    const row = normalizeTelemetryObservation(input); if (row.source !== 'geotab') throw fail('teksat_preview_primary_source'); return row;
  });
  normalized.observations = normalized.observations.filter(row => row.vehicleKey === vehicleKey);
  const scopedIds = new Set(normalized.observations.map(row => row.id));
  normalized.lineage = normalized.lineage.filter(row => scopedIds.has(row.observationId));
  const scoped = [...primary, ...normalized.observations].filter(row => row.vehicleKey === vehicleKey);
  if (scoped.length > 20000) throw fail('teksat_preview_limit');
  const archive = appendTelemetryArchive(null, scoped, {at});
  const continuity = advanceTelemetryContinuity(previous?.state || null, {archive, vehicleKey, now: at, policy});
  const derived = deriveTelemetryIntervals(archive);
  const reconciliations = metricWindows.map(window => reconcileTelemetryIntervals(derived.intervals, {vehicleKey, metric: window.metric,
    from: window.from, to: window.to, at, previous: previous?.reconciliations?.find(row => row.metric === window.metric && row.from === window.from && row.to === window.to) || null}));
  return {mode: 'preparatory_preview', effectiveActivation: false, contractFingerprint: normalized.check.contractFingerprint || null,
    normalization: normalized, state: continuity.state, events: continuity.events, ignored: continuity.ignored,
    archive, reconciliations, intervalIssues: derived.issues, capabilities: capabilities()};
}
