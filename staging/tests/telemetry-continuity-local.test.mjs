import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalTelemetryContinuity, geotabArchiveCallbacks} from '../server/telemetry-continuity-local.mjs';

const BASE = Date.parse('2026-11-03T12:00:00Z'), time = seconds => new Date(BASE + seconds * 1000).toISOString();
const telemetry = (seconds = 0, amount = 100000) => ({id: 'g-a', key: 'v-a', odometer_m: amount,
  total_fuel_l: 500, counter_at: {odometer_m: time(seconds), total_fuel_l: time(seconds + 1)}, at: time(90), status: 'partial'});
const position = () => ({device_id: 'g-a', key: 'v-a', vehicle_key: 'v-a', at: time(5), last_pos_at: time(5), lat: 33.5, lon: -7.5});
async function fixture(t, callbacks = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-local-')), calls = [], rows = [];
  let failed = false;
  const fetchFn = async (url, options) => {
    const parsed = new URL(url); calls.push({url: parsed, options});
    assert.equal(parsed.origin, 'http://127.0.0.1:57421');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.apikey, 'local-service-test'); assert.equal(options.headers.Authorization, 'Bearer local-service-test');
    if (failed) return new Response('private server detail', {status: 503});
    if (parsed.pathname === '/rest/v1/rpc/telemetry_archive_ingest') {
      assert.equal(options.method, 'POST'); const events = JSON.parse(options.body).p_events;
      for (const event of events) rows.push({...event, id: randomUUID(), fingerprint: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
        version: 1, received_at: time(100), mapping_basis: 'current_at_receipt'});
      return Response.json({received: events.length, inserted: events.length, duplicates: 0, conflicts: 0,
        rows: rows.slice(-events.length).map(row => ({id: row.id, source_event_id: row.source_event_id, fingerprint: row.fingerprint, version: 1, duplicate: false}))});
    }
    assert.equal(parsed.pathname, '/rest/v1/telemetry_observations'); assert.equal(options.method, 'GET');
    const metric = parsed.searchParams.get('observation->>metric').slice(3);
    return Response.json(rows.filter(row => row.observation.metric === metric));
  };
  const service = createLocalTelemetryContinuity({supabaseUrl: 'http://127.0.0.1:57421', serviceKey: 'local-service-test',
    pendingPath: join(directory, 'pending.json'), fetchFn, now: () => BASE + 100000, ...callbacks});
  t.after(async () => {await service.close(); await rm(directory, {recursive: true, force: true});});
  return {service, calls, rows, fail: value => {failed = value;}};
}

test('the telemetry adapter refuses remote, credentialed or unexpected local databases before any request', () => {
  for (const supabaseUrl of ['https://example.invalid', 'http://127.0.0.1:54321', 'http://user:pass@127.0.0.1:57421', 'http://127.0.0.1:57421/rest/v1']) {
    assert.throws(() => createLocalTelemetryContinuity({supabaseUrl, serviceKey: 'test', fetchFn: () => assert.fail('no request expected')}));
  }
  assert.throws(() => createLocalTelemetryContinuity({supabaseUrl: 'http://127.0.0.1:57421', serviceKey: ''}));
});

test('the real local adapter preserves fuel callbacks while archiving original counters before consumer mutation', async t => {
  const delivered = [], f = await fixture(t, {onTelemetry: rows => {delivered.push(rows); rows[0].odometer_m = 999999; return 'fuel-ok';}});
  await f.service.start(); assert.equal(f.calls.length, 0, 'starting an empty journal does not poll Geotab or Supabase');
  const rows = [telemetry()]; assert.equal(await f.service.onGeotabTelemetry(rows), 'fuel-ok'); await f.service.flush();
  assert.equal(delivered[0], rows); assert.equal(f.rows.length, 2);
  const distance = f.rows.find(row => row.observation.metric === 'distance_km');
  assert.equal(distance.origin.raw_value, 100000); assert.equal(distance.observation.value, 100);
  assert.equal(distance.observed_at, time(0)); assert.equal(f.rows.find(row => row.observation.metric === 'fuel_l').observed_at, time(1));
  assert.equal(f.service.status().pending, 0); assert.equal(f.service.status().activeFailover, false);
});

test('the real local adapter forwards the unchanged parking source and archives GPS independently', async t => {
  const delivered = [], f = await fixture(t, {onPositions: (rows, source) => {delivered.push({rows, source}); return 'parking-ok';}});
  const rows = [position()], source = {status: 'healthy', last_success_at: time(100), stale_after_s: 20};
  assert.equal(await f.service.onGeotabPositions(rows, source), 'parking-ok'); await f.service.flush();
  assert.equal(delivered[0].rows, rows); assert.equal(delivered[0].source, source);
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].observation.kind, 'gps'); assert.equal(f.rows[0].observed_at, time(5));
  assert.equal(f.service.status().texat.enabled, false);
});

test('archive failures cannot prevent either existing consumer, and consumer failures cannot prevent archive delivery', async () => {
  for (const kind of ['onGeotabTelemetry', 'onGeotabPositions']) {
    for (const failing of ['archive-sync', 'archive-async', 'consumer']) {
      const delivered = [], rows = [position()], source = {status: 'healthy'};
      const archive = {onGeotabTelemetry: () => {}, onGeotabPositions: () => {}};
      archive[kind] = (...args) => {delivered.push(['archive', args]); if (failing === 'archive-sync') throw Error('archive unavailable');
        if (failing === 'archive-async') return Promise.reject(Error('archive unavailable'));};
      const consumer = (...args) => {delivered.push(['consumer', args]); if (failing === 'consumer') throw Error('consumer unavailable'); return 42;};
      const callbacks = geotabArchiveCallbacks({archive, onTelemetry: consumer, onPositions: consumer});
      const promise = callbacks[kind](rows, source);
      if (failing === 'consumer') await assert.rejects(promise, /consumer unavailable/);
      else assert.equal(await promise, 42);
      assert.deepEqual(delivered.map(item => item[0]), ['archive', 'consumer']);
      assert.equal(delivered[0][1][0], rows); assert.equal(delivered[1][1][0], rows);
      if (kind === 'onGeotabPositions') assert.equal(delivered[1][1][1], source);
    }
  }
});

test('database archive failure leaves fuel processing successful and exposes only aggregate warning state', async t => {
  let fuelCalls = 0; const f = await fixture(t, {onTelemetry: () => ++fuelCalls}); f.fail(true);
  assert.equal(await f.service.onGeotabTelemetry([telemetry()]), 1); await f.service.flush();
  assert.equal(fuelCalls, 1); assert.equal(f.service.status().status, 'warning'); assert.equal(f.service.status().pending, 2);
  for (const secret of ['private server detail', 'local-service-test', 'g-a', 'v-a', 'odometer']) assert.ok(!JSON.stringify(f.service.status()).includes(secret));
});

test('private reconciliation requests only the chosen vehicle and metric, every version, and both exact counter endpoints', async t => {
  const f = await fixture(t);
  await f.service.onGeotabTelemetry([telemetry(0), telemetry(20, 110000)]); await f.service.flush();
  const result = await f.service.reconcile({vehicleKey: 'v-a', metric: 'distance_km', from: time(0), to: time(20)});
  assert.equal(result.totals.total, 10); const read = f.calls.find(call => call.options.method === 'GET'), query = read.url.searchParams;
  assert.equal(query.get('vehicle_key'), 'eq.v-a'); assert.equal(query.get('source'), 'eq.geotab');
  assert.equal(query.get('observation->>metric'), 'eq.distance_km'); assert.deepEqual(query.getAll('observed_at'), ['gte.' + time(0), 'lte.' + time(20)]);
  assert.equal(query.get('received_at'), 'lte.' + time(100)); assert.equal(query.get('order'), 'observed_at.asc,id.asc');
  assert.equal(query.get('limit'), '1000'); assert.equal(query.get('offset'), '0');
  assert.ok(query.get('select').includes('fingerprint')); assert.equal(query.has('version'), false, 'competing versions stay visible');
  const controller = new AbortController(); controller.abort(); const before = f.calls.length;
  await assert.rejects(f.service.reconcile({vehicleKey: 'v-a', metric: 'distance_km', from: time(0), to: time(20), signal: controller.signal}), {name: 'AbortError'});
  assert.equal(f.calls.length, before);
});
