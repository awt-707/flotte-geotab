import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TEKSAT_CONTRACT} from '../server/texat.mjs';
import {rawTeksatObservation, createTeksatRawArchive} from '../server/texat-raw-archive.mjs';
import {validateTeksatNormalizationContract, checkTeksatNormalizationContract, resolveTeksatSourceTime,
  normalizeTeksatRawBatch, previewTeksatContinuity} from '../server/texat-normalization.mjs';
import {reconcileTelemetryIntervals} from '../server/telemetry-continuity.mjs';

// All offsets, status meanings, identities and approvals below are synthetic
// test fixtures. They assert no timezone/GPS/fuel contract for the real account.
const BASE = Date.parse('2026-11-03T12:00:00Z');
const time = seconds => new Date(BASE + seconds * 1000).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accountFingerprint = 'a'.repeat(64), deviceId = '123456789012345';
const providerVehicleId = '11111111-1111-4111-8111-111111111111';
const contract = {version: 1, id: 'SYNTHETIC-CONTRACT-NOT-PROVIDER-EVIDENCE', accountFingerprint,
  apiContractVersion: TEKSAT_CONTRACT.version, validFrom: time(-3600), validTo: time(86400),
  evidenceRefs: ['SYNTHETIC-TEST-FIXTURE'], receiptEvidenceIds: ['b'.repeat(64)], gps: {timestampField: 'dateGpsRaw', timestampMeaning: 'coordinate_measurement',
    coordinateReference: 'WGS84', qualityCodes: {good: [7], degraded: [8], invalid: [9]}},
  offsets: [{from: time(-3600), to: time(86400), offsetMinutes: 60}]};
const approvalFor = value => ({operatorId: 'SYNTHETIC-OPERATOR', evidenceReviewed: true,
  contractFingerprint: validateTeksatNormalizationContract(value).fingerprint, approvedAt: time(-300)});
const approval = approvalFor(contract);
const mappings = [{id: 'SYNTHETIC-HISTORICAL-MAPPING', source: 'texat', sourceId: deviceId, vehicleKey: 'car-a',
  validFrom: time(-100), validTo: time(1000), confirmedAt: time(-200), evidenceId: 'SYNTHETIC-ASSIGNMENT-EVIDENCE'}];
const options = extra => ({contract, accountFingerprint, approval, mappings, at: time(100), ...extra});
const sourceTime = seconds => new Date(BASE + (seconds + 3600) * 1000).toISOString().replace(/Z$/, '');
const raw = (seconds = 0, extra = {}) => rawTeksatObservation({providerVehicleId, deviceId, collectedAt: time(seconds),
  dateGpsRaw: sourceTime(seconds), datePositionRaw: sourceTime(seconds), privateMode: false,
  latitude: 33.5, longitude: -7.5, moving: true, providerStatusCode: 7, ...extra},
  {vehicleKey: 'receipt-only-car', evidenceId: 'b'.repeat(64)});
const archived = (seconds = 0, extra = {}, archiveExtra = {}) => {
  const value = raw(seconds, extra), signature = {...value}; delete signature.receivedAt;
  return {schemaVersion: 1, ...value, sourceEventId: hash(['texat', value.providerVehicleId, value.deviceId, value.dateGpsRaw, value.datePositionRaw]),
    fingerprint: hash(signature), version: 1, archivedAt: value.receivedAt, ...archiveExtra};
};
const gps = (id, seconds, extra = {}) => ({id, vehicleKey: 'car-a', source: 'geotab', sourceId: 'geotab-device', kind: 'gps',
  quality: 'good', observedAt: time(seconds), receivedAt: time(seconds), latitude: 33.6, longitude: -7.6, accuracyM: 5, ...extra});
const policy = {staleAfterMs: {gps: 10000, network: 10000, distance: 10000, fuel: 10000}, failoverAfterMs: 5000, recoverAfterMs: 10000, recoverySamples: 2};
const preview = extra => previewTeksatContinuity({...options(), vehicleKey: 'car-a', policy, ...extra});

test('preparatory contract requires separate reviewed evidence, account binding and exact approved version', () => {
  for (const extra of [{contract: undefined}, {approval: null}, {accountFingerprint: 'c'.repeat(64)},
    {approval: {...approval, evidenceReviewed: false}}, {approval: {...approval, approvedAt: time(101)}},
    {contract: {...contract, id: 'CHANGED-CONTRACT'}}]) {
    const result = normalizeTeksatRawBatch([archived()], options(extra));
    assert.equal(result.blocked, true); assert.equal(result.observations.length, 0);
  }
  const checked = checkTeksatNormalizationContract(contract, options());
  assert.equal(checked.ready, true);
  assert.equal(checked.basis, 'explicit_operator_review');
  assert.equal(checked.capabilities.effectiveActivation, false);
  assert.equal(checked.capabilities.providerProofAutomaticallyVerified, false);
  assert.equal(checked.capabilities.hardwareIndependenceConfirmed, false);
  assert.throws(() => validateTeksatNormalizationContract({...contract, guessedTimezone: 'Europe/Paris'}));
  assert.throws(() => validateTeksatNormalizationContract({...contract, gps: {...contract.gps, qualityCodes: {good: [7], degraded: [7], invalid: []}}}));
  const wrongReceipt = {...contract, receiptEvidenceIds: ['c'.repeat(64)]};
  const foreignJournal = normalizeTeksatRawBatch([archived()], options({contract: wrongReceipt, approval: approvalFor(wrongReceipt)}));
  assert.equal(foreignJournal.observations.length, 0);
  assert.equal(foreignJournal.issues.teksat_receipt_evidence_not_approved, 1);
});

test('explicit offset schedule preserves the measurement time and refuses civil folds, gaps and silent rounding', () => {
  assert.equal(resolveTeksatSourceTime(sourceTime(0), contract), time(0));
  assert.equal(resolveTeksatSourceTime('2026-11-03T13:00:00.0000000+01:00', contract), time(0));
  for (const value of ['2026-11-03T12:00:00Z', '2026-02-30T13:00:00', '2026-11-03T24:00:00',
    '2026-11-03T13:00:00.0001', '2026-11-03T13:00:00+01:99']) assert.throws(() => resolveTeksatSourceTime(value, contract));
  assert.throws(() => resolveTeksatSourceTime(sourceTime(86400), contract), {code: 'teksat_source_time_not_covered'});
  const scheduled = offsets => ({...contract, validFrom: '2026-10-25T00:00:00.000Z', validTo: '2026-10-25T03:00:00.000Z', offsets});
  const fold = scheduled([{from: '2026-10-25T00:00:00.000Z', to: '2026-10-25T01:00:00.000Z', offsetMinutes: 120},
    {from: '2026-10-25T01:00:00.000Z', to: '2026-10-25T03:00:00.000Z', offsetMinutes: 60}]);
  assert.throws(() => resolveTeksatSourceTime('2026-10-25T02:30:00', fold), {code: 'teksat_source_time_ambiguous'});
  assert.equal(resolveTeksatSourceTime('2026-10-25T02:30:00+02:00', fold), '2026-10-25T00:30:00.000Z');
  const gap = scheduled([{from: '2026-10-25T00:00:00.000Z', to: '2026-10-25T01:00:00.000Z', offsetMinutes: 60},
    {from: '2026-10-25T01:00:00.000Z', to: '2026-10-25T03:00:00.000Z', offsetMinutes: 120}]);
  assert.throws(() => resolveTeksatSourceTime('2026-10-25T02:30:00', gap), {code: 'teksat_source_time_not_covered'});
});

test('receipt-time aliases cannot establish historical assignment or freshen an old measurement', () => {
  const delayed = archived(0, {collectedAt: time(80)});
  const good = normalizeTeksatRawBatch([delayed], options());
  assert.equal(good.observations[0].vehicleKey, 'car-a');
  assert.equal(good.observations[0].observedAt, time(0));
  assert.equal(good.observations[0].receivedAt, time(80));
  assert.equal(good.lineage[0].receiptVehicleKey, 'receipt-only-car');
  for (const badMappings of [[], [{...mappings[0], validFrom: time(1)}], [{...mappings[0], validTo: time(0)}],
    [{...mappings[0], confirmedAt: time(101)}], [...mappings, {...mappings[0], id: 'conflict', vehicleKey: 'car-b'}]]) {
    assert.equal(normalizeTeksatRawBatch([delayed], options({mappings: badMappings})).observations.length, 0);
  }
  const result = preview({rawRecords: [delayed]});
  assert.equal(result.state.channels.gps.usable, false);
  assert.equal(result.state.channels.gps.fallback.reason, 'stale');
});

test('raw archive integrity, future receipt and private mode fail closed without recreating historical coordinates', () => {
  const privateRow = archived(10, {privateMode: true});
  for (const altered of [{...archived(), latitude: 34}, {...archived(), unexpectedField: true},
    {...privateRow, latitude: 33}, {...archived(), archivedAt: time(-1)}, {...archived(), fingerprint: '0'.repeat(64)}]) {
    const result = normalizeTeksatRawBatch([altered], options());
    assert.equal(result.observations.length, 0); assert.equal(result.issues.teksat_raw_archive_invalid, 1);
  }
  const future = normalizeTeksatRawBatch([archived(110)], options());
  assert.equal(future.issues.teksat_raw_not_yet_received, 1);
  const privateResult = normalizeTeksatRawBatch([privateRow, archived(0)], options());
  assert.equal(privateResult.observations.length, 0);
  assert.equal(privateResult.issues.teksat_provider_private_mode, 2);
  const resumed = normalizeTeksatRawBatch([privateRow, archived(0), archived(20)], options());
  assert.equal(resumed.observations.length, 2);
  assert.ok(resumed.observations.every(row => row.observedAt !== time(10)));
});

test('unknown or invalid quality never becomes a usable GPS fix; no network, distance or fuel is manufactured', () => {
  for (const providerStatusCode of [99, 8, 9]) {
    const result = preview({rawRecords: [archived(0, {providerStatusCode})], at: time(0)});
    assert.equal(result.state.channels.gps.usable, false);
  }
  const result = preview({rawRecords: [archived()], at: time(0)});
  assert.deepEqual(result.archive.records.map(row => row.observation.kind), ['gps']);
  assert.equal(result.state.channels.gps.usable, true);
  for (const channel of ['network', 'distance', 'fuel']) assert.equal(result.state.channels[channel].usable, false);
  assert.equal(result.normalization.observations[0].accuracyM, null);
  assert.equal(result.capabilities.fuelConsumption, false);
});

test('real journal → normalized GPS → continuity preview supports outage and stable primary recovery with no live activation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teksat-preview-fixture-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let clock = BASE;
  const journal = await createTeksatRawArchive({directory, now: () => clock});
  const rows = async() => (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(directory, name), 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  await journal.append([raw()]);
  let result = preview({rawRecords: await rows(), geotabObservations: [gps('g0', 0)], at: time(0)});
  assert.equal(result.state.channels.gps.activeSource, 'geotab');
  for (const seconds of [11, 16]) {
    clock = BASE + seconds * 1000; await journal.append([raw(seconds)]);
    result = preview({rawRecords: await rows(), geotabObservations: [gps('g0', 0)], at: time(seconds), previous: result});
    assert.equal(result.state.channels.gps.activeSource, seconds === 11 ? 'geotab' : 'texat');
    assert.equal(result.state.channels.gps.usable, seconds !== 11);
  }
  clock = BASE + 17000; await journal.append([raw(17)]);
  result = preview({rawRecords: await rows(), geotabObservations: [gps('g17', 17)], at: time(17), previous: result});
  assert.equal(result.state.channels.gps.reason, 'recovery_pending');
  clock = BASE + 27000; await journal.append([raw(27)]);
  result = preview({rawRecords: await rows(), geotabObservations: [gps('g17', 17), gps('same-measurement', 17)], at: time(27), previous: result});
  assert.equal(result.state.channels.gps.activeSource, 'texat', 'polling an unchanged primary measurement does not meet recovery count');
  clock = BASE + 28000; await journal.append([raw(28)]);
  result = preview({rawRecords: await rows(), geotabObservations: [gps('g28', 28)], at: time(28), previous: result});
  assert.equal(result.state.channels.gps.activeSource, 'geotab');
  assert.equal(result.state.channels.gps.reason, 'primary_recovered');
  assert.equal(result.effectiveActivation, false);
  const diskBefore = await rows();
  result = preview({rawRecords: diskBefore, geotabObservations: [gps('g28', 28)], at: time(50), previous: result});
  assert.equal(result.state.channels.gps.selected, null);
  assert.equal(result.state.channels.gps.reason, 'both_unavailable');
  assert.deepEqual(await rows(), diskBefore, 'preview never changes the source journal');
  await journal.close();
});

test('replayed and corrected raw versions stay auditable; conflicting coordinates cannot win selection', () => {
  const first = archived(0), corrected = archived(0, {latitude: 34, collectedAt: time(10)}, {version: 2});
  const duplicate = preview({rawRecords: [first, first], at: time(0)});
  assert.equal(duplicate.archive.records.length, 1);
  const conflict = preview({rawRecords: [corrected, first], at: time(10)});
  assert.equal(conflict.archive.records.length, 2);
  assert.equal(conflict.archive.conflicts.length, 1);
  assert.equal(conflict.state.channels.gps.usable, false);
  assert.deepEqual(conflict.normalization.lineage.map(row => row.rawVersion), [2, 1]);
});

test('late primary counters reconcile exact windows once, while the Teksat GPS pipeline leaves fuel unknown', () => {
  const metricWindows = ['distance_km', 'fuel_l'].map(metric => ({metric, from: time(0), to: time(20)}));
  const before = preview({rawRecords: [archived(), archived(20)], metricWindows});
  assert.deepEqual(before.reconciliations.map(row => row.totals.total), [null, null]);
  const counter = (id, seconds, value) => ({id, vehicleKey: 'car-a', source: 'geotab', sourceId: 'geotab-device', kind: 'counter',
    metric: 'distance_km', counterId: 'odometer', counterMeaning: 'odometer', quality: 'good',
    observedAt: time(seconds), receivedAt: time(80), value});
  const geotabObservations = [counter('end', 20, 110), counter('begin', 0, 100)];
  const after = preview({rawRecords: [archived(), archived(20)], geotabObservations, metricWindows, previous: before});
  assert.deepEqual(after.reconciliations.map(row => row.totals.total), [10, null]);
  const replay = preview({rawRecords: [archived(), archived(20)], geotabObservations: [...geotabObservations, ...geotabObservations], metricWindows, previous: after});
  assert.equal(replay.reconciliations[0].totals.total, 10);
  assert.equal(replay.reconciliations[0].revision, after.reconciliations[0].revision);
});

test('SYNTHETIC ONLY: future proven fuel intervals would be replaced by complete Geotab coverage, never added', () => {
  // These direct engine fixtures are NOT accepted by the Teksat GPS adapter.
  const interval = (id, source, from, to, value) => ({id, source, sourceId: source + '-fixture', vehicleKey: 'car-a', kind: 'interval',
    metric: 'fuel_l', quality: 'good', observedAt: time(to), receivedAt: time(80), from: time(from), to: time(to),
    value, method: 'provider_interval', coverage: 'complete'});
  const request = {vehicleKey: 'car-a', metric: 'fuel_l', from: time(0), to: time(20), at: time(100)};
  const backup = interval('SYNTHETIC-TEXAT-FUEL-NOT-CONNECTED', 'texat', 0, 20, 2);
  const before = reconcileTelemetryIntervals([backup], request);
  const after = reconcileTelemetryIntervals([backup, interval('g0', 'geotab', 0, 10, 0.9), interval('g1', 'geotab', 10, 20, 1)], {...request, previous: before});
  assert.equal(after.totals.total, 1.9);
  assert.equal(after.retained.length, 3);
  assert.equal(after.audit.at(-1).previousTotals.total, 2);
  assert.equal(after.coverage.reconciledToPrimary, true);
  assert.throws(() => preview({geotabObservations: [backup]}), {code: 'teksat_preview_primary_source'});
});

test('blocked preparation preserves primary service, scopes the preview and rejects incompatible previous contract', () => {
  let blocked = preview({contract: undefined, geotabObservations: [gps('g', 0)], at: time(0)});
  assert.equal(blocked.normalization.blocked, true);
  assert.equal(blocked.state.channels.gps.activeSource, 'geotab');
  blocked = preview({contract: undefined, geotabObservations: [gps('g', 0)], at: time(1), previous: blocked});
  assert.equal(blocked.state.channels.gps.usable, true);
  const current = preview({rawRecords: [archived()], geotabObservations: [gps('other', 0, {vehicleKey: 'car-b'})], at: time(0)});
  assert.ok(current.archive.records.every(row => row.observation.vehicleKey === 'car-a'));
  const unrelated = archived(0, {deviceId: '999999999999999', providerStatusCode: 9});
  const scope = preview({rawRecords: [archived(), unrelated], at: time(0)});
  assert.equal(scope.normalization.observations.length, 1);
  assert.equal(scope.normalization.lineage.length, 1);
  assert.deepEqual(scope.normalization.issues, {});
  const changed = {...contract, id: 'SYNTHETIC-REVISED'};
  assert.throws(() => preview({contract: changed, approval: approvalFor(changed), previous: current}), {code: 'teksat_preview_contract_changed'});
});
