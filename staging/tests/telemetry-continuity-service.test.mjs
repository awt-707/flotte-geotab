import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, writeFile, stat, rm, symlink, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTelemetryContinuityService, geotabArchiveEvents} from '../server/telemetry-continuity-service.mjs';

const BASE = Date.parse('2026-11-03T12:00:00Z');
const time = seconds => new Date(BASE + seconds * 1000).toISOString();
const sample = (seconds, value = 100000, extra = {}) => ({id: 'device-a', key: 'car-a', at: time(90), status: 'partial',
  odometer_m: value, counter_at: {odometer_m: time(seconds)}, ...extra});
const position = (seconds, extra = {}) => ({key: 'car-a', vehicle_key: 'car-a', device_id: 'device-a',
  lat: 33.5, lon: -7.5, at: time(seconds), last_pos_at: time(seconds), state: 'moving', speed: 30, ...extra});
const semantic = event => {
  const observation = {...event.observation}; delete observation.receivedAt;
  return createHash('sha256').update(JSON.stringify({observation, origin: event.origin})).digest('hex');
};
function database() {
  const stored = [], calls = [], reads = [];
  let fail = null, malformed = false;
  return {
    stored, calls, reads,
    set fail(value) {fail = value;}, set malformed(value) {malformed = value;},
    async rpc(name, {p_events: events}, options) {
      assert.equal(name, 'telemetry_archive_ingest'); assert.ok(options.signal instanceof AbortSignal);
      calls.push(structuredClone(events));
      if (typeof fail === 'function') await fail(events);
      else if (fail) throw new Error('private database diagnostic: secret-token car-a');
      const receipts = []; let inserted = 0, duplicates = 0, conflicts = 0;
      for (const event of events) {
        const fingerprint = semantic(event), versions = stored.filter(row => row.source_event_id === event.source_event_id);
        let row = versions.find(row => row.fingerprint === fingerprint), duplicate = !!row;
        if (row) duplicates++;
        else {
          row = {...structuredClone(event), id: randomUUID(), version: versions.length + 1, fingerprint,
            received_at: time(100), mapping_basis: 'current_at_receipt', agency_id_at_receipt: 1};
          stored.push(row); inserted++; if (versions.length) conflicts++;
        }
        receipts.push({id: row.id, source_event_id: row.source_event_id, fingerprint, version: row.version, duplicate});
      }
      return {data: malformed ? {received: events.length, rows: []} : {received: events.length, inserted, duplicates, conflicts, rows: receipts.reverse()}};
    },
    async readObservations(options) {
      reads.push(options);
      return stored.filter(row => row.vehicle_key === options.vehicleKey && row.observation.metric === options.metric && Date.parse(row.observed_at) >= Date.parse(options.from) &&
        Date.parse(row.observed_at) <= Date.parse(options.to) && Date.parse(row.received_at) <= Date.parse(options.receivedBefore))
        .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id.localeCompare(b.id))
        .slice(options.offset, options.offset + options.limit);
    }
  };
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-test-')), pendingPath = join(directory, 'pending.json');
  const db = options.db || database(), clock = {value: BASE + 100000};
  const service = createTelemetryContinuityService({db, pendingPath, now: () => clock.value, retryDelaysMs: [60000], ...options});
  t.after(async () => {await service.close(); await rm(directory, {recursive: true, force: true});});
  return {service, db, pendingPath, directory, clock};
}

test('extracts each Geotab counter at its own sample time, preserves original units, and ignores daily totals', () => {
  const result = geotabArchiveEvents([sample(1, 100123, {total_fuel_l: 500.75, total_idle_fuel_l: 80,
    counter_at: {odometer_m: time(1), total_fuel_l: time(2), total_idle_fuel_l: time(3)}, km: 200, fuel_l: 16,
    error: 'provider private text', token: 'never stored'})], {kind: 'telemetry', collectedAt: time(100)});
  assert.equal(result.events.length, 2);
  const [distance, fuel] = result.events;
  assert.equal(distance.observation.value, 100.123); assert.equal(distance.observed_at, time(1));
  assert.equal(distance.observation.unit, 'km'); assert.equal(distance.observation.counterEpoch, null);
  assert.deepEqual(distance.origin, {field: 'odometer_m', unit: 'm', raw_value: 100123, sample_at: time(1)});
  assert.equal(fuel.observation.value, 500.75); assert.equal(fuel.observed_at, time(2));
  assert.equal(fuel.observation.counterMeaning, 'fuel_consumed');
  assert.equal(fuel.collected_at, time(100)); assert.equal(fuel.observation.quality, 'good');
  assert.ok(!JSON.stringify(result).includes('never stored')); assert.ok(!JSON.stringify(result).includes('private text'));
});

test('missing, naive or invalid counter dates never borrow the snapshot time; valid partial counters survive', () => {
  const result = geotabArchiveEvents([sample(1, 1000, {counter_at: {}, total_fuel_l: 0}),
    sample(2, NaN, {total_fuel_l: 600, counter_at: {odometer_m: time(2), total_fuel_l: time(3)}}),
    sample(4, 1000, {counter_at: {odometer_m: '2026-11-03T12:00:04'}}), sample(5, '1000')], {kind: 'telemetry', collectedAt: time(100)});
  assert.equal(result.events.length, 1); assert.equal(result.events[0].observation.metric, 'fuel_l');
  assert.equal(result.issues.invalid_counter_or_time, 5);
});

test('GPS preserves an old measurement date and never fabricates network availability or distance', () => {
  const result = geotabArchiveEvents([position(-3600)], {kind: 'positions', collectedAt: time(100)});
  assert.equal(result.events.length, 1); assert.equal(result.events[0].observed_at, time(-3600));
  assert.equal(result.events[0].observation.kind, 'gps'); assert.equal(result.events[0].observation.accuracyM, null);
  assert.deepEqual(result.events[0].origin, {field: 'position', unit: 'deg', raw_value: null, sample_at: time(-3600)});
  assert.ok(!Object.hasOwn(result.events[0].observation, 'connected'));
  assert.equal(geotabArchiveEvents([position(1, {at: time(2)})], {kind: 'positions', collectedAt: time(100)}).events.length, 0);
});

test('conflicting device/vehicle assignments and invalid coordinates are rejected without plate-based inference', () => {
  const ambiguous = geotabArchiveEvents([sample(0), sample(1, 100100, {key: 'car-b', plate: 'car-a'})], {kind: 'telemetry', collectedAt: time(100)});
  assert.equal(ambiguous.events.length, 0); assert.equal(ambiguous.issues.uncertain_vehicle_device, 2);
  const invalid = geotabArchiveEvents([position(0, {key: 'car-b'}), position(1, {lat: null}), position(2, {device_id: undefined})], {kind: 'positions', collectedAt: time(100)});
  assert.equal(invalid.events.length, 0);
});

test('callbacks persist a private atomic journal without waiting for an unavailable database', async t => {
  let release; const blocked = new Promise(resolve => {release = resolve;});
  const db = database(), rpc = db.rpc; db.rpc = async (...args) => {await blocked; return rpc(...args);};
  const {service, pendingPath} = await setup(t, {db});
  const result = await service.onGeotabTelemetry([sample(0)]);
  assert.equal(result.accepted, 1); assert.equal(result.persisted, true);
  const saved = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert.equal(saved.pending.length, 1); assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  assert.equal(service.status().pending, 1);
  release(); await service.flush();
  assert.equal(service.status().pending, 0); assert.equal(db.stored.length, 1);
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).pending.length, 0);
});

test('repeated polls deduplicate independently of collection time while changed values keep competing versions', async t => {
  const {service, db, clock} = await setup(t);
  await service.onGeotabTelemetry([sample(0)]); await service.flush();
  clock.value += 1000;
  await service.onGeotabTelemetry([sample(0)]); await service.flush();
  await service.onGeotabTelemetry([sample(0, 100050)]); await service.flush();
  assert.equal(db.stored.length, 2); assert.equal(db.stored[0].source_event_id, db.stored[1].source_event_id);
  assert.notEqual(db.stored[0].fingerprint, db.stored[1].fingerprint);
  assert.equal(service.status().duplicates, 1); assert.equal(service.status().conflicts, 1);
  assert.equal(db.calls.length, 2, 'the acknowledged exact duplicate needs no new RPC');
  await service.onGeotabTelemetry([sample(0)]); await service.flush();
  assert.equal(db.calls.length, 2, 'a previously archived competing version remains an exact duplicate');
});

test('sixteen unchanged GPS samples generate no archive RPC after durable acknowledgement', async t => {
  const {service, db, clock, pendingPath} = await setup(t);
  const rows = Array.from({length: 16}, (_, index) => position(0, {key: 'car-' + index, vehicle_key: 'car-' + index, device_id: 'device-' + index}));
  await service.onGeotabPositions(rows); await service.flush();
  assert.equal(db.calls.length, 16); const journal = await readFile(pendingPath, 'utf8');
  clock.value += 3000;
  const repeated = await service.onGeotabPositions(rows); await service.flush();
  assert.equal(repeated.accepted, 0); assert.equal(repeated.duplicates, 16); assert.equal(db.calls.length, 16);
  assert.equal(await readFile(pendingPath, 'utf8'), journal, 'the cache never enters the durable journal');
  await service.onGeotabPositions([{...rows[0], lat: 33.6}]); await service.flush();
  assert.equal(db.calls.length, 17); assert.equal(db.stored.length, 17);
  assert.equal(db.stored.at(-1).version, 2, 'changed coordinates at the same provider time stay a competing version');
});

test('acknowledged keys are bounded per service and evicted observations are safely reconfirmed', async t => {
  const {service, db} = await setup(t, {maxPending: 2});
  for (const second of [0, 1, 0, 2]) {await service.onGeotabTelemetry([sample(second)]); await service.flush();}
  assert.equal(db.calls.length, 3);
  await service.onGeotabTelemetry([sample(0)]); await service.flush();
  assert.equal(db.calls.length, 3, 'recent duplicate refreshed its LRU position');
  await service.onGeotabTelemetry([sample(1)]); await service.flush();
  assert.equal(db.calls.length, 4, 'the oldest acknowledged key was evicted');
  assert.equal(db.stored.length, 3, 'database idempotence still prevents a second archived fact');
});

test('a replacement service starts with no acknowledgement cache', async t => {
  const first = await setup(t); await first.service.onGeotabPositions([position(0)]); await first.service.flush();
  await first.service.close();
  const replacement = createTelemetryContinuityService({db: first.db, pendingPath: first.pendingPath, now: () => first.clock.value});
  t.after(() => replacement.close()); await replacement.start();
  const result = await replacement.onGeotabPositions([position(0)]); await replacement.flush();
  assert.equal(result.accepted, 1); assert.equal(first.db.calls.length, 2); assert.equal(first.db.stored.length, 1);
  assert.equal(replacement.status().duplicates, 1);
});

test('a database acknowledgement is not cached before its journal cleanup is durable', async t => {
  const {service, db, directory, pendingPath} = await setup(t);
  const original = db.rpc;
  db.rpc = async (...args) => {const receipt = await original(...args); await chmod(directory, 0o755); return receipt;};
  await service.onGeotabPositions([position(0)]); await service.flush();
  assert.equal(db.stored.length, 1); assert.equal(service.status().persisted, false);
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).pending.length, 1);
  await chmod(directory, 0o700); db.rpc = original;
  const repeated = await service.onGeotabPositions([position(0)]); await service.flush();
  assert.equal(repeated.accepted, 1, 'an acknowledgement with failed journal cleanup cannot suppress the next sample');
  assert.equal(db.calls.length, 2); assert.equal(db.stored.length, 1); assert.equal(service.status().persisted, true);
  await service.onGeotabPositions([position(0)]); await service.flush();assert.equal(db.calls.length, 2);
});

test('bounded database retries retain exhausted batches across restarts until explicit retry', async t => {
  const first = await setup(t); first.db.fail = true;
  await first.service.onGeotabTelemetry([sample(0)]); await first.service.flush();
  assert.equal(first.db.calls.length, 1); assert.equal(first.service.status().status, 'warning');
  const repeated = await first.service.onGeotabTelemetry([sample(0)]);
  assert.equal(repeated.accepted, 0); assert.equal(repeated.duplicates, 1); assert.equal(first.service.status().pending, 1, 'failed acknowledgements remain pending, never cached');
  await first.service.flush(); assert.equal(first.db.calls.length, 1, 'backoff respected');
  first.clock.value += 60000; await first.service.flush();
  assert.equal(first.db.calls.length, 2); assert.equal(first.service.status().exhausted, 1);
  first.clock.value += 60000; await first.service.flush(); assert.equal(first.db.calls.length, 2);
  await first.service.close();
  const replacement = createTelemetryContinuityService({db: first.db, pendingPath: first.pendingPath, now: () => first.clock.value, retryDelaysMs: [60000]});
  t.after(() => replacement.close()); first.db.fail = false;
  await replacement.start(); assert.equal(replacement.status().pending, 1); assert.equal(first.db.calls.length, 2);
  await replacement.retryPending(); assert.equal(first.db.stored.length, 1); assert.equal(replacement.status().pending, 0);
  assert.equal(replacement.status().status, 'healthy');
});

test('a failed vehicle batch does not block other vehicles and errors never expose provider or database payloads', async t => {
  const {service, db} = await setup(t, {retryDelaysMs: []});
  db.fail = events => {if (events[0].vehicle_key === 'car-a') throw new Error('secret-token device-a car-a');};
  await service.onGeotabTelemetry([sample(0), sample(0, 200000, {id: 'device-b', key: 'car-b'})]); await service.flush();
  assert.equal(db.calls.length, 2); assert.equal(db.stored.length, 1); assert.equal(db.stored[0].vehicle_key, 'car-b');
  assert.equal(service.status().pending, 1); assert.equal(service.status().status, 'warning');
  const state = JSON.stringify(service.status());
  for (const privateText of ['secret-token', 'device-a', 'car-a', 'car-b']) assert.ok(!state.includes(privateText));
});

test('an untrusted receipt after a committed write keeps the journal and retries idempotently', async t => {
  const {service, db} = await setup(t, {retryDelaysMs: []}); db.malformed = true;
  await service.onGeotabTelemetry([sample(0)]); await service.flush();
  assert.equal(db.stored.length, 1); assert.equal(service.status().pending, 1); assert.equal(service.status().databaseError, 'archive_receipt');
  await service.onGeotabTelemetry([sample(0)]); assert.equal(service.status().pending, 1, 'malformed receipts never create acknowledged cache entries');
  db.malformed = false; await service.retryPending();
  assert.equal(db.stored.length, 1); assert.equal(service.status().duplicates, 1); assert.equal(service.status().pending, 0);
});

test('a timed-out request leaves durable evidence and a late server commit is safe to replay', async t => {
  const db = database(), original = db.rpc; let release, entered;
  const pending = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  db.rpc = async (...args) => {entered(); await pending; return original(...args);};
  const {service, pendingPath} = await setup(t, {db, requestTimeoutMs: 10, retryDelaysMs: []});
  await service.onGeotabTelemetry([sample(0)]); await started;
  // The production retry timer is unref'ed; keep this isolated test alive.
  await Promise.all([service.flush(), new Promise(resolve => setTimeout(resolve, 30))]);
  assert.equal(service.status().databaseError, 'archive_timeout'); assert.equal(service.status().pending, 1);
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).pending.length, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.stored.length, 1, 'the timed-out remote operation may still have committed');
  db.rpc = original; await service.retryPending();
  assert.equal(db.stored.length, 1); assert.equal(service.status().duplicates, 1); assert.equal(service.status().pending, 0);
});

test('closing during an in-flight write retains the journal and does not wait indefinitely', async t => {
  const db = database(); let entered;
  const started = new Promise(resolve => {entered = resolve;});
  db.rpc = async () => {entered(); return new Promise(() => {});};
  const {service, pendingPath} = await setup(t, {db});
  await service.onGeotabTelemetry([sample(0)]); await started; await service.close();
  assert.equal(service.status().status, 'closed'); assert.equal(service.status().pending, 1);
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).pending.length, 1);
});

test('queue limits report new rejected samples and preserve every previously pending sample', async t => {
  const {service, db, pendingPath} = await setup(t, {maxPending: 1, retryDelaysMs: []}); db.fail = true;
  const result = await service.onGeotabTelemetry([sample(0), sample(1)]); await service.flush();
  assert.equal(result.accepted, 1); assert.equal(result.rejected, 1);
  assert.equal(service.status().rejected, 1); assert.equal(service.status().pending, 1);
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).pending[0].event.observed_at, time(0));
});

test('unsafe or corrupt journals are not overwritten, and closing rejects late callbacks', async t => {
  const {service, db, pendingPath, directory} = await setup(t);
  const target = join(directory, 'external.json'); await writeFile(target, 'keep me', {mode: 0o600}); await symlink(target, pendingPath);
  const result = await service.onGeotabTelemetry([sample(0)]); await service.flush();
  assert.equal(result.accepted, 0); assert.equal(service.status().storageError, 'pending_store_unavailable');
  assert.equal(db.calls.length, 0); assert.equal(await readFile(target, 'utf8'), 'keep me');
  await service.close();
  assert.equal((await service.onGeotabPositions([position(1)])).reason, 'archive_closed');
});

test('a journal directory with broad permissions is reported and never mistaken for private durable storage', async t => {
  const {service, db, directory} = await setup(t, {retryDelaysMs: []}); db.fail = true;
  await chmod(directory, 0o755);
  const result = await service.onGeotabTelemetry([sample(0)]); await service.flush();
  assert.equal(result.persisted, false); assert.equal(service.status().storageError, 'pending_store_unavailable');
  assert.equal(service.status().pending, 1, 'the in-process sample remains available while storage is repaired');
  await chmod(directory, 0o700); db.fail = false; await service.retryPending();
  assert.equal(service.status().persisted, true); assert.equal(db.stored.length, 1);
});

test('reconciliation derives ordered exact intervals from late samples and links every archived version', async t => {
  const {service, db} = await setup(t);
  for (const row of [sample(20, 110000), sample(0, 100000), sample(10, 104000)]) {await service.onGeotabTelemetry([row]); await service.flush();}
  db.stored[0].observed_at = db.stored[0].observed_at.replace('Z', '+00:00');
  db.stored[0].collected_at = db.stored[0].collected_at.replace('Z', '+00:00');
  const result = await service.reconcile({vehicleKey: 'car-a', metric: 'distance_km', from: time(0), to: time(20)});
  assert.equal(result.totals.total, 10); assert.equal(result.coverage.complete, true); assert.equal(result.selected.length, 2);
  assert.equal(result.archiveEvidence.length, 3); assert.equal(result.archiveCoverage.conflicts, 0);
  const referenced = new Set(result.selected.flatMap(row => row.history));
  assert.ok(result.archiveEvidence.every(row => referenced.has(row.archiveVersionId) && row.id && row.fingerprint && row.mappingBasis === 'current_at_receipt'));
  assert.equal(db.reads[0].from, time(0)); assert.equal(db.reads[0].to, time(20)); assert.equal(db.reads[0].receivedBefore, time(100));
  assert.equal(db.reads[0].metric, 'distance_km');
});

test('reconciliation keeps competing counter versions as unknown instead of silently overwriting or prorating', async t => {
  const {service} = await setup(t);
  await service.onGeotabTelemetry([sample(0, 100000), sample(10, 104000), sample(10, 105000), sample(20, 110000)]); await service.flush();
  const result = await service.reconcile({vehicleKey: 'car-a', metric: 'distance_km', from: time(0), to: time(20)});
  assert.equal(result.archiveCoverage.conflicts, 1); assert.equal(result.archiveEvidence.length, 4);
  assert.equal(result.totals.total, null); assert.equal(result.coverage.complete, false);
  assert.ok(result.derivationIssues.some(issue => issue.reason === 'counter_conflict_or_quality'));
});

test('distinct authoritative database fingerprints stay conflicted even when normalized observations match', async t => {
  const {service, db} = await setup(t);
  await service.onGeotabTelemetry([sample(0), sample(20, 110000)]); await service.flush();
  db.stored.push({...structuredClone(db.stored[0]), id: randomUUID(), version: 2, fingerprint: 'a'.repeat(64)});
  const result = await service.reconcile({vehicleKey: 'car-a', metric: 'distance_km', from: time(0), to: time(20)});
  assert.equal(result.archiveEvidence.length, 3); assert.equal(result.archiveCoverage.conflicts, 1);
  assert.equal(result.totals.total, null); assert.ok(result.derivationIssues.some(issue => issue.reason === 'counter_conflict_or_quality'));
});

test('read failures, repeated pagination rows, cancellation and overly broad windows never yield final totals', async t => {
  const {service, db} = await setup(t);
  await service.onGeotabTelemetry([sample(0), sample(20, 110000)]); await service.flush();
  const input = {vehicleKey: 'car-a', metric: 'distance_km', from: time(0), to: time(20)};
  db.readObservations = async () => ({error: {message: 'private diagnostics'}});
  await assert.rejects(service.reconcile(input), {code: 'archive_read'});
  db.readObservations = async () => [db.stored[0], db.stored[0]];
  await assert.rejects(service.reconcile(input), {code: 'archive_read_incomplete'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.reconcile({...input, signal: controller.signal}), {name: 'AbortError'});
  await assert.rejects(service.reconcile({...input, from: time(-32 * 86400)}), {code: 'archive_window'});
});

test('archive reads follow bounded pages through the final counter endpoint and retain the full observation history', async t => {
  const {service, db} = await setup(t, {now: () => BASE + 2000000});
  const records = geotabArchiveEvents(Array.from({length: 1001}, (_, index) => sample(index, 100000 + index * 10)),
    {kind: 'telemetry', collectedAt: time(1100)}).events;
  db.stored.push(...records.map(event => ({...event, id: randomUUID(), version: 1, fingerprint: semantic(event), received_at: time(1200)})));
  const result = await service.reconcile({vehicleKey: 'car-a', metric: 'distance_km', from: time(0), to: time(1000)});
  assert.equal(db.reads.length, 2); assert.equal(db.reads[1].offset, 1000);
  assert.equal(result.archiveEvidence.length, 1001); assert.equal(result.selected.length, 1000);
  assert.ok(Math.abs(result.totals.total - 10) < 1e-8);
});
