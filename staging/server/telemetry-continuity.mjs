import {createHash} from 'node:crypto';

const SOURCES = ['geotab', 'texat'];
const CHANNELS = ['gps', 'network', 'distance', 'fuel'];
const QUALITIES = ['good', 'degraded', 'unknown', 'invalid'];
const METRICS = {distance_km: {channel: 'distance', unit: 'km', meaning: 'odometer'}, fuel_l: {channel: 'fuel', unit: 'L', meaning: 'fuel_consumed'}};
const MAX_RECORDS = 20000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Identité télémétrique invalide.');
  return value;
};
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function stamp(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000) return value;
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError('Horodatage avec fuseau requis.');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number), date = new Date(Date.UTC(year, month - 1, day));
  const at = Date.parse(value);
  if (year < 1900 || month < 1 || month > 12 || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || !Number.isSafeInteger(at)) throw new TypeError('Horodatage invalide.');
  return at;
}
const iso = value => new Date(stamp(value)).toISOString();
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const recordKey = row => JSON.stringify([row.vehicleKey, row.source, row.sourceId, row.channel, row.id]);

/** Adapter contract: cumulative fuel means consumed fuel, never tank level.
 * receivedAt is ingestion time; observedAt is the provider measurement time. */
export function normalizeTelemetryObservation(input) {
  if (!input || !SOURCES.includes(input.source) || !QUALITIES.includes(input.quality) || !['gps', 'network', 'counter', 'interval'].includes(input.kind)) throw new TypeError('Observation télémétrique invalide.');
  const row = {id: identifier(input.id), vehicleKey: identifier(input.vehicleKey), source: input.source,
    sourceId: identifier(input.sourceId), kind: input.kind, quality: input.quality,
    observedAt: iso(input.observedAt), receivedAt: iso(input.receivedAt)};
  if (stamp(row.observedAt) > stamp(row.receivedAt) + 60000) throw new TypeError('Date de mesure incohérente.');
  if (input.kind === 'gps') {
    if (typeof input.latitude !== 'number' || !Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90 || typeof input.longitude !== 'number' || !Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180 || input.accuracyM != null && !finite(input.accuracyM)) throw new TypeError('Position télémétrique invalide.');
    return {...row, channel: 'gps', latitude: input.latitude, longitude: input.longitude, accuracyM: input.accuracyM ?? null};
  }
  if (input.kind === 'network') {
    if (input.connected !== null && typeof input.connected !== 'boolean') throw new TypeError('État réseau explicite requis.');
    return {...row, channel: 'network', connected: input.connected};
  }
  const metric = METRICS[input.metric];
  if (!metric || !finite(input.value)) throw new TypeError('Mesure télémétrique invalide.');
  if (input.kind === 'counter') {
    if (input.counterMeaning !== metric.meaning) throw new TypeError('Compteur cumulatif de distance ou carburant consommé requis.');
    return {...row, channel: metric.channel, metric: input.metric, unit: metric.unit, value: input.value,
      counterId: identifier(input.counterId), counterEpoch: input.counterEpoch == null ? null : identifier(input.counterEpoch), counterMeaning: input.counterMeaning};
  }
  const from = iso(input.from), to = iso(input.to);
  if (stamp(to) <= stamp(from) || stamp(to) > stamp(row.observedAt) || !['complete', 'partial', 'unknown'].includes(input.coverage) || !['provider_interval', 'counter_delta', 'gps_estimate'].includes(input.method) || input.method === 'gps_estimate' && input.metric !== 'distance_km') throw new TypeError('Intervalle télémétrique invalide.');
  return {...row, channel: metric.channel, metric: input.metric, unit: metric.unit, from, to, value: input.value,
    coverage: input.coverage, method: input.method, estimated: input.method === 'gps_estimate',
    history: Array.isArray(input.history) ? [...new Set(input.history.map(identifier))] : []};
}

/** Append-only facts. A changed payload under an existing provider id creates
 * a conflict, not a silent correction. Both versions remain in the archive. */
export function appendTelemetryArchive(previous, observations, {at} = {}) {
  const archivedAt = iso(at);
  if (!Array.isArray(observations) || observations.length > MAX_RECORDS || previous && previous.version !== 1) throw new TypeError('Archive télémétrique invalide.');
  const records = [...(previous?.records || [])], audit = [...(previous?.audit || [])];
  if (records.length + observations.length > MAX_RECORDS) throw new RangeError('Archive trop volumineuse ; charger une fenêtre bornée.');
  const versions = new Map(records.map(record => [record.versionId, record]));
  for (const input of observations) {
    const observation = normalizeTelemetryObservation(input);
    if (stamp(observation.receivedAt) > stamp(archivedAt)) throw new TypeError('Réception postérieure à l’archivage.');
    const signature = {...observation}; delete signature.receivedAt;
    const key = recordKey(observation), versionId = hash(signature);
    if (versions.has(versionId)) continue;
    const record = {recordKey: key, versionId, observation, archivedAt};
    records.push(record); versions.set(versionId, record);
    audit.push({id: hash(['archive', versionId]), type: 'observation_archived', at: archivedAt, versionId, recordKey: key});
  }
  const keys = new Map();
  for (const record of records) {if (!keys.has(record.recordKey)) keys.set(record.recordKey, []); keys.get(record.recordKey).push(record.versionId);}
  const conflicts = [...keys].filter(([, ids]) => ids.length > 1).map(([key, versionIds]) => ({recordKey: key, versionIds}));
  return {version: 1, revision: (previous?.revision || 0) + Number(records.length !== (previous?.records?.length || 0)), records, conflicts, audit};
}

function archiveRecords(archive) {
  if (archive?.version !== 1 || !Array.isArray(archive.records)) throw new TypeError('Archive télémétrique requise.');
  const conflicts = new Set((archive.conflicts || []).map(item => item.recordKey));
  return archive.records.map(record => ({...record, conflicted: conflicts.has(record.recordKey)}));
}

/** Counter differences never cross a provider, device, diagnostic or explicit
 * counter epoch. A reset/conflict is a gap; the next valid point is a new base. */
export function deriveTelemetryIntervals(archive, {maxRatePerHour = {}} = {}) {
  const groups = new Map(), intervals = [], issues = [];
  for (const record of archiveRecords(archive)) {
    const row = record.observation;
    if (row.kind === 'interval') {
      if (record.conflicted) issues.push({reason: 'conflicting_observation', history: [record.versionId]});
      else intervals.push({...row, id: record.versionId, history: [...new Set([record.versionId, ...row.history])]});
    }
    if (row.kind !== 'counter') continue;
    const key = JSON.stringify([row.vehicleKey, row.source, row.sourceId, row.metric, row.counterId, row.counterEpoch]);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record);
  }
  for (const records of groups.values()) {
    const times = new Map();
    for (const record of records) {const at = record.observation.observedAt; if (!times.has(at)) times.set(at, []); times.get(at).push(record);}
    let before = null;
    for (const [, points] of [...times].sort(([a], [b]) => stamp(a) - stamp(b))) {
      const candidate = points[0], current = candidate.observation;
      if (points.some(point => point.conflicted || point.observation.quality !== 'good') || new Set(points.map(point => point.observation.value)).size > 1) {
        issues.push({reason: 'counter_conflict_or_quality', at: current.observedAt, history: points.map(point => point.versionId)}); before = null; continue;
      }
      if (before) {
        const prior = before.observation, delta = current.value - prior.value, elapsed = stamp(current.observedAt) - stamp(prior.observedAt), rate = maxRatePerHour[current.metric];
        if (rate !== undefined && (!finite(rate) || rate === 0)) throw new TypeError('Limite de variation invalide.');
        const reason = delta < 0 ? 'counter_reset' : rate && delta > rate * elapsed / 3600000 ? 'counter_rate_conflict' : null;
        if (reason) issues.push({reason, from: prior.observedAt, to: current.observedAt, history: [before.versionId, candidate.versionId]});
        else intervals.push({id: hash(['delta', before.versionId, candidate.versionId]), vehicleKey: current.vehicleKey, source: current.source, sourceId: current.sourceId,
          kind: 'interval', channel: current.channel, metric: current.metric, unit: current.unit, quality: 'good',
          from: prior.observedAt, to: current.observedAt, observedAt: current.observedAt,
          receivedAt: stamp(prior.receivedAt) > stamp(current.receivedAt) ? prior.receivedAt : current.receivedAt,
          value: delta, coverage: 'complete', method: 'counter_delta', estimated: false, history: [before.versionId, candidate.versionId]});
      }
      before = candidate;
    }
  }
  return {intervals: intervals.sort((a, b) => stamp(a.from) - stamp(b.from) || a.id.localeCompare(b.id)), issues};
}

function policyOf(input = {}) {
  const policy = {staleAfterMs: {gps: 180000, network: 90000, distance: 120000, fuel: 120000, ...input.staleAfterMs},
    failoverAfterMs: input.failoverAfterMs ?? 30000, recoverAfterMs: input.recoverAfterMs ?? 60000,
    recoverySamples: input.recoverySamples ?? 2, maxGpsAccuracyM: input.maxGpsAccuracyM ?? 150, futureToleranceMs: input.futureToleranceMs ?? 5000};
  if (Object.values(policy.staleAfterMs).some(value => !Number.isSafeInteger(value) || value < 1) || ['failoverAfterMs', 'recoverAfterMs', 'futureToleranceMs'].some(key => !Number.isSafeInteger(policy[key]) || policy[key] < 0) || !Number.isSafeInteger(policy.recoverySamples) || policy.recoverySamples < 1 || policy.recoverySamples > 100 || !finite(policy.maxGpsAccuracyM)) throw new TypeError('Politique de continuité invalide.');
  return policy;
}

function health(records, source, channel, now, policy, sourceId) {
  const candidates = records.filter(record => record.observation.source === source && record.observation.channel === channel && (!sourceId || record.observation.sourceId === sourceId) && stamp(record.observation.receivedAt) <= now);
  if (!candidates.length) return {usable: false, reason: 'missing', observation: null};
  candidates.sort((a, b) => stamp(b.observation.observedAt) - stamp(a.observation.observedAt) || a.versionId.localeCompare(b.versionId));
  const record = candidates[0], row = record.observation, ageMs = now - stamp(row.observedAt);
  const fresh = candidates.filter(item => now - stamp(item.observation.observedAt) <= policy.staleAfterMs[channel]);
  const sameInstant = candidates.filter(item => item.observation.observedAt === row.observedAt && item.observation.sourceId === row.sourceId);
  const counterConflict = row.kind === 'counter' && sameInstant.some(item => item.observation.kind === 'counter' && (item.observation.value !== row.value || item.observation.counterId !== row.counterId || item.observation.counterEpoch !== row.counterEpoch));
  const sampleConflict = sameInstant.some(({observation: other}) => other.kind === row.kind && (other.quality !== row.quality ||
    row.kind === 'gps' && (other.latitude !== row.latitude || other.longitude !== row.longitude) || row.kind === 'network' && other.connected !== row.connected));
  let reason = new Set(fresh.map(item => item.observation.sourceId)).size > 1 ? 'ambiguous_device' : record.conflicted ? 'conflicting_observation'
    : counterConflict ? 'counter_conflict'
    : sampleConflict ? 'conflicting_measurement'
    : ageMs < -policy.futureToleranceMs ? 'future_measurement' : ageMs > policy.staleAfterMs[channel] ? 'stale'
    : row.quality !== 'good' ? 'quality' : row.kind === 'gps' && row.accuracyM !== null && row.accuracyM > policy.maxGpsAccuracyM ? 'gps_accuracy'
    : row.kind === 'network' && row.connected !== true ? 'network_unavailable'
    : row.kind === 'interval' && (row.coverage !== 'complete' || row.estimated) ? 'not_measured_complete' : null;
  return {usable: reason === null, reason, ageMs, sourceId: row.sourceId, evidenceId: record.versionId, observation: row};
}

/** Pure live source state: GPS, network, distance and fuel fail independently.
 * A source awaiting failover is never presented as a fresh usable position. */
export function advanceTelemetryContinuity(previous, {archive, vehicleKey, now, policy: inputPolicy, sourceIds = {}} = {}) {
  identifier(vehicleKey); const at = stamp(now), policy = policyOf(inputPolicy);
  if (previous && previous.version !== 1) throw new TypeError('Version de continuité inconnue.');
  if (previous && previous.vehicleKey !== vehicleKey) throw new TypeError('État d’un autre véhicule.');
  if (previous && at < stamp(previous.at)) return {state: previous, events: [], ignored: 'clock_rollback'};
  const records = archiveRecords(archive).filter(record => record.observation.vehicleKey === vehicleKey), channels = {}, events = [];
  for (const channel of CHANNELS) {
    const primary = health(records, 'geotab', channel, at, policy, sourceIds.geotab), fallback = health(records, 'texat', channel, at, policy, sourceIds.texat);
    const old = previous?.channels?.[channel];
    let active = old?.activeSource || null, missingSince = old?.missingSince ?? null,
      recoverySince = old?.recoverySince ?? null, recoveryEvidence = [...(old?.recoveryEvidence || [])], recoverySourceId = old?.recoverySourceId ?? null, reason;
    if (!active) {active = primary.usable ? 'geotab' : fallback.usable ? 'texat' : null; reason = active ? 'initial_healthy_source' : 'both_unavailable';}
    else if (active === 'geotab') {
      recoverySince = null; recoveryEvidence = []; recoverySourceId = null;
      if (primary.usable) {missingSince = null; reason = 'primary_healthy';}
      else {
        missingSince ??= at;
        if (fallback.usable && at - missingSince >= policy.failoverAfterMs) {active = 'texat'; missingSince = null; reason = 'primary_unavailable';}
        else reason = fallback.usable ? 'failover_pending' : 'both_unavailable';
      }
    } else {
      missingSince = null;
      if (primary.usable) {
        if (recoverySourceId !== primary.sourceId) {recoverySince = null; recoveryEvidence = []; recoverySourceId = primary.sourceId;}
        recoverySince ??= at;
        const evidence = primary.observation.observedAt;
        if (!recoveryEvidence.includes(evidence)) recoveryEvidence.push(evidence);
        recoveryEvidence = recoveryEvidence.slice(-policy.recoverySamples);
        if (!fallback.usable || at - recoverySince >= policy.recoverAfterMs && recoveryEvidence.length >= policy.recoverySamples) {
          active = 'geotab'; recoverySince = null; recoveryEvidence = []; recoverySourceId = null; reason = fallback.usable ? 'primary_recovered' : 'primary_only_healthy';
        } else reason = 'recovery_pending';
      } else {recoverySince = null; recoveryEvidence = []; recoverySourceId = null; reason = fallback.usable ? 'fallback_healthy' : 'both_unavailable';}
    }
    const selected = active === 'geotab' ? primary : active === 'texat' ? fallback : null;
    channels[channel] = {activeSource: active, sourceId: selected?.sourceId || null, usable: selected?.usable === true,
      selected: selected?.usable ? selected.observation : null, reason, missingSince, recoverySince, recoveryEvidence, recoverySourceId,
      primary: {usable: primary.usable, reason: primary.reason}, fallback: {usable: fallback.usable, reason: fallback.reason}};
    if (active !== (old?.activeSource || null) || channels[channel].sourceId !== (old?.sourceId || null)) events.push({
      id: hash([vehicleKey, channel, at, old?.activeSource || null, active, channels[channel].sourceId]), type: 'source_changed',
      at: iso(at), vehicleKey, channel, from: old?.activeSource || null, to: active, sourceId: channels[channel].sourceId, reason});
  }
  return {state: {version: 1, vehicleKey, at: iso(at), channels}, events, ignored: null};
}

function completePath(intervals, from, to) {
  const starts = new Map();
  for (const interval of intervals) {if (!starts.has(interval.from)) starts.set(interval.from, []); starts.get(interval.from).push(interval);}
  const states = new Map([[from, {min: 0, max: 0, pieces: 0, path: null}]]);
  for (const point of [...new Set([from, to, ...intervals.flatMap(row => [row.from, row.to])])].sort((a, b) => stamp(a) - stamp(b))) {
    const state = states.get(point); if (!state) continue;
    for (const interval of starts.get(point) || []) {
      const min = state.min + interval.value, max = state.max + interval.value;
      if (!Number.isFinite(min) || !Number.isFinite(max)) throw new RangeError('Somme télémétrique hors limite.');
      const existing = states.get(interval.to), candidate = {min, max, pieces: state.pieces + 1, path: {interval, previous: state.path}};
      if (!existing) states.set(interval.to, candidate);
      else {existing.min = Math.min(existing.min, min); existing.max = Math.max(existing.max, max); if (candidate.pieces < existing.pieces) {existing.pieces = candidate.pieces; existing.path = candidate.path;}}
    }
  }
  const result = states.get(to); if (!result) return null;
  if (!close(result.min, result.max)) return {conflict: true, rows: []};
  const rows = []; for (let link = result.path; link; link = link.previous) rows.push(link.interval);
  return {conflict: false, rows: rows.reverse()};
}

/** Reconcile complete intervals. Exact adjacent primary intervals may replace
 * one backup interval; partial overlaps are never silently prorated. */
export function reconcileTelemetryIntervals(intervals, {vehicleKey, metric, from, to, at, previous = null} = {}) {
  identifier(vehicleKey); if (!METRICS[metric] || !Array.isArray(intervals) || intervals.length > MAX_RECORDS) throw new TypeError('Intervalles télémétriques invalides.');
  const first = iso(from), last = iso(to), reconciledAt = iso(at);
  if (stamp(last) <= stamp(first)) throw new RangeError('Fenêtre télémétrique invalide.');
  if (previous && (previous.vehicleKey !== vehicleKey || previous.metric !== metric || previous.from !== first || previous.to !== last)) throw new TypeError('Réconciliation d’un autre périmètre.');
  if (previous && stamp(reconciledAt) < stamp(previous.at)) throw new RangeError('Réconciliation antérieure à la dernière version.');
  const candidates = [], issues = [], retained = [];
  for (const input of intervals) {
    const row = normalizeTelemetryObservation({...input, kind: 'interval'});
    if (row.vehicleKey !== vehicleKey || row.metric !== metric || stamp(row.to) <= stamp(first) || stamp(row.from) >= stamp(last)) continue;
    retained.push(row);
    if (stamp(row.receivedAt) > stamp(reconciledAt)) {issues.push({reason: 'observation_not_received_yet', ids: [row.id]}); continue;}
    if (stamp(row.from) < stamp(first) || stamp(row.to) > stamp(last)) {issues.push({reason: 'boundary_overlap_not_apportioned', ids: [row.id]}); continue;}
    if (row.quality !== 'good' || row.coverage !== 'complete') {issues.push({reason: 'unreliable_or_partial_interval', ids: [row.id]}); continue;}
    candidates.push(row);
  }
  candidates.sort((a, b) => stamp(a.from) - stamp(b.from) || stamp(a.to) - stamp(b.to) || a.id.localeCompare(b.id));
  const components = [];
  for (const row of candidates) {
    const lastComponent = components.at(-1);
    if (!lastComponent || stamp(row.from) >= stamp(lastComponent.to)) components.push({from: row.from, to: row.to, rows: [row]});
    else {lastComponent.rows.push(row); if (stamp(row.to) > stamp(lastComponent.to)) lastComponent.to = row.to;}
  }
  const selected = [], decisions = [];
  for (const component of components) {
    let chosen = null, chosenSource = null;
    for (const estimated of [false, true]) {
      for (const source of SOURCES) {
        const pool = component.rows.filter(row => row.source === source && row.estimated === estimated);
        const path = completePath(pool, component.from, component.to);
        if (path?.conflict) issues.push({reason: 'contradictory_interval_totals', source, from: component.from, to: component.to, ids: pool.map(row => row.id)});
        else if (path) {chosen = path.rows; chosenSource = source; break;}
      }
      if (chosen) break;
    }
    if (!chosen) {issues.push({reason: 'partial_overlap_not_apportioned', from: component.from, to: component.to, ids: component.rows.map(row => row.id)}); continue;}
    const ids = new Set(chosen.map(row => row.id));
    if (chosenSource === 'texat' && component.rows.some(row => row.source === 'geotab')) issues.push({reason: 'primary_coverage_not_reconciled', from: component.from, to: component.to});
    selected.push(...chosen);
    decisions.push({from: component.from, to: component.to, source: chosenSource, selectedIds: [...ids], retainedAlternativeIds: component.rows.filter(row => !ids.has(row.id)).map(row => row.id)});
  }
  const gaps = []; let cursor = first;
  for (const row of selected) {if (stamp(row.from) > stamp(cursor)) gaps.push({from: cursor, to: row.from}); cursor = row.to;}
  if (stamp(cursor) < stamp(last)) gaps.push({from: cursor, to: last});
  const measured = selected.filter(row => !row.estimated), estimates = selected.filter(row => row.estimated);
  const sum = rows => {
    if (!rows.length) return null;
    const value = rows.reduce((total, row) => total + row.value, 0);
    if (!Number.isFinite(value)) throw new RangeError('Somme télémétrique hors limite.');
    return value;
  };
  const complete = gaps.length === 0;
  issues.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const totals = {knownMeasuredValue: sum(measured), knownEstimatedValue: sum(estimates),
    total: complete && estimates.length === 0 ? sum(selected) : null, estimatedTotal: complete && estimates.length > 0 ? sum(selected) : null};
  const content = {selected: selected.map(row => ({id: row.id, source: row.source, value: row.value, from: row.from, to: row.to})), decisions, gaps, issues};
  const fingerprint = hash(content), changed = previous?.fingerprint !== fingerprint, revision = (previous?.revision || 0) + Number(changed);
  const audit = [...(previous?.audit || [])];
  if (changed) audit.push({id: hash(['reconciliation', vehicleKey, metric, first, last, revision, fingerprint]), type: 'reconciliation_changed', at: reconciledAt,
    revision, previousRevision: previous?.revision || null, previousSelectedIds: previous?.selected?.map(row => row.id) || [], selectedIds: selected.map(row => row.id),
    previousTotals: previous?.totals ? {...previous.totals} : null, totals: {...totals}});
  return {version: 1, vehicleKey, metric, unit: METRICS[metric].unit, from: first, to: last, at: reconciledAt, revision, fingerprint,
    selected, retained, decisions, issues, gaps, audit, coverage: {complete, reconciledToPrimary: complete && selected.every(row => row.source === 'geotab' && !row.estimated)},
    totals};
}
