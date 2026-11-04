import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTeksatService, teksatAccountFingerprint} from '../server/texat-service.mjs';
const CONFIG = {TEXAT_SOCIETE: 'synthetic', TEXAT_EMAIL: 'synthetic@example.test', TEXAT_PASSWORD: 'private-password'};
const ID = '11111111-1111-4111-8111-111111111111', NOW = Date.parse('2026-11-03T12:00:00Z');

async function fixture(t, {fail = null, full = false, archiveError = null} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'teksat-service-')); t.after(() => rm(directory, {recursive: true, force: true}));
  let time = NOW, timer = null, calls = 0, active = 'OUI', deviceId = '123456789012345';
  const scope = {filialeId: 42, accountFingerprint: teksatAccountFingerprint(CONFIG)};
  const evidence = {version: 1, accountFingerprint: scope.accountFingerprint, filialeId: 42, evidenceId: 'a'.repeat(64),
    mappings: [{vehicleKey: 'local-vehicle', providerVehicleId: ID, deviceId: '123456789012345', reason: 'registered_plate_alias'}]};
  const service = await createTeksatService({readConfig: async () => CONFIG, scope, now: () => time,
    archiveDirectory: directory, mappingEvidencePath: '/synthetic', readEvidence: async () => evidence,
    loadVehicles: async () => [{key: 'local-vehicle', plate: '12345-A-6', other_plates: 'WW123456', active}],
    schedule(callback, delay) {assert.equal(delay, 60000); timer = callback; return 1;}, cancelSchedule() {timer = null;},
    ...(full || archiveError ? {archiveFactory: async () => ({getStatus: () => ({full, maxBytes: 512 * 1024 * 1024, bytes: full ? 512 * 1024 * 1024 : 0, pending: 0}),
      async flushPending() {if (archiveError) throw Object.assign(new Error('PRIVATE disk path and internal details'), {code: archiveError});}, async close() {}})} : {}),
    clientFactory: () => ({
      async readVehiclePage() {calls++; if (fail) throw Object.assign(new Error('private upstream details'), {code: fail}); return {rows: [{providerVehicleId: ID, deviceId, plate: 'WW123456', active: true}], totalCount: 1, totalPages: 1, nextPage: null};},
      async readPositions() {calls++; return {rows: [{providerVehicleId: ID, deviceId, plate: 'not-in-journal', collectedAt: new Date(time).toISOString(),
        dateGpsRaw: '2026-11-03T13:00:00', datePositionRaw: '2026-11-03T12:59:00', privateMode: false, latitude: 33.5, longitude: -7.5, moving: true, providerStatusCode: 1}]};}, close() {}
    })});
  return {service, directory, calls: () => calls, hasTimer: () => timer !== null, setInactive() {active = 'NON';},
    replaceTracker() {deviceId = '999999999999999';},
    async tick() {assert.ok(timer); const current = timer; timer = null; time += 60000; await current();}};
}

test('collection starts explicitly, archives raw observations, and rechecks current aliases on every cycle', async t => {
  const f = await fixture(t); assert.equal(f.calls(), 0); assert.equal(f.service.getStatus().collectionEnabled, false);
  const started = await f.service.start(); assert.equal(started.collectionEnabled, true); assert.equal(started.rawArchive.entries, 1);
  assert.equal(started.activeFailover, false); assert.equal(started.rawArchive.mappingBasis, 'current_at_receipt'); assert.equal(f.hasTimer(), true);
  await f.tick(); assert.equal(f.service.getStatus().rawArchive.entries, 1, 'an identical raw provider measurement is not duplicated');
  f.setInactive(); await f.tick(); const stopped = f.service.getStatus();
  assert.equal(stopped.collectionEnabled, false); assert.equal(stopped.rawArchive.stoppedReason, 'teksat_mapping_changed'); assert.equal(f.hasTimer(), false);
  await f.service.close();
  const records = (await Promise.all((await readdir(f.directory)).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(f.directory, name), 'utf8')))).join('');
  assert.doesNotMatch(records, /not-in-journal|private-password|WW123456/);
  const row = JSON.parse(records.trim()); assert.equal(row.normalized, false); assert.equal(row.timeZone, null); assert.equal(row.dateGpsRaw, '2026-11-03T13:00:00');
});

test('three transport failures stop retries and authentication failure stops immediately', async t => {
  const f = await fixture(t, {fail: 'teksat_upstream'}); await f.service.start(); await f.tick(); await f.tick();
  assert.equal(f.calls(), 3); assert.equal(f.hasTimer(), false); assert.equal(f.service.getStatus().rawArchive.consecutiveFailures, 3); await f.service.close();
  const denied = await fixture(t, {fail: 'teksat_authentication'}); await denied.service.start();
  assert.equal(denied.calls(), 1); assert.equal(denied.hasTimer(), false); await denied.service.close();
});

test('a full archive suspends collection before another provider request and never deletes prior history', async t => {
  const f = await fixture(t, {full: true}); const status = await f.service.start();
  assert.equal(f.calls(), 0); assert.equal(status.rawArchive.stoppedReason, 'teksat_archive_full'); assert.equal(f.hasTimer(), false); await f.service.close();
});

test('journal error codes stop collection immediately without exposing their private error message', async t => {
  for (const suffix of ['full', 'permissions', 'corrupt']) {
    const f = await fixture(t, {archiveError: 'texat_archive_' + suffix});
    const status = await f.service.start();
    assert.equal(status.collectionEnabled, false); assert.equal(status.lastError, 'teksat_archive_' + suffix);
    assert.equal(status.rawArchive.stoppedReason, 'teksat_archive_' + suffix);
    assert.equal(status.rawArchive.consecutiveFailures, 1); assert.equal(f.calls(), 0); assert.equal(f.hasTimer(), false);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE|disk path|internal details/); await f.service.close();
  }
});

test('the next scheduled cycle rejects a replaced tracker before reading or archiving its positions', async t => {
  const f = await fixture(t); await f.service.start(); assert.equal(f.calls(), 2);
  assert.equal(f.service.getStatus().rawArchive.entries, 1);
  f.replaceTracker(); await f.tick(); const stopped = f.service.getStatus();
  assert.equal(f.calls(), 3, 'only the catalogue is read after remapping');
  assert.equal(stopped.rawArchive.entries, 1); assert.equal(stopped.rawArchive.stoppedReason, 'teksat_mapping_changed');
  assert.equal(stopped.collectionEnabled, false); assert.equal(f.hasTimer(), false); await f.service.close();
});
