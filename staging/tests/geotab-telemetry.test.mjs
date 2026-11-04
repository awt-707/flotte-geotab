import test from 'node:test';
import assert from 'node:assert/strict';
import { GeotabClient } from '../server/geotab.mjs';

const NOW = Date.parse('2026-10-30T13:00:00Z'), FROM = '2026-10-30T00:00:00.000Z';
const CREDS = { database: 'test_database', userName: 'test@example.invalid', password: 'private-test-password' };
const DIAGS = ['DiagnosticOdometerId', 'DiagnosticDeviceTotalFuelId', 'DiagnosticDeviceTotalIdleFuelId'];
const reply = result => new Response(JSON.stringify({ result }));
const permission = () => new Response(JSON.stringify({ error: { data: { type: 'SecurityException', requestIndex: 0 }, message: CREDS.password } }));
const quota = () => new Response(JSON.stringify({ error: { data: { type: 'OverLimitException' } } }), { status: 429 });

function harness(read) {
  const state = { now: NOW, calls: [], concurrent: 0, maximum: 0 };
  const client = new GeotabClient({ credentials: async () => CREDS, now: () => state.now, fetchFn: async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    if (method === 'Authenticate') return reply({ path: 'ThisServer', credentials: { sessionId: 'SESSION' } });
    assert.equal(method, 'ExecuteMultiCall'); assert.ok(params.calls.length <= 50);
    assert.equal(options.redirect, 'error'); assert.ok(!options.body.includes(CREDS.password));
    state.calls.push(params.calls); state.concurrent++; state.maximum = Math.max(state.maximum, state.concurrent);
    try { return await read(params.calls, state); } finally { state.concurrent--; }
  } });
  return { state, client };
}

function counters(calls, overrides = {}) {
  return reply(calls.map(({ params }) => {
    assert.equal(params.typeName, 'StatusData'); assert.equal(params.search.fromDate, params.search.toDate);
    assert.ok(DIAGS.includes(params.search.diagnosticSearch.id)); assert.equal(params.resultsLimit, 100);
    const id = params.search.deviceSearch.id, diagnostic = params.search.diagnosticSearch.id;
    const index = DIAGS.indexOf(diagnostic), baseline = params.search.fromDate === FROM;
    const values = baseline ? [500000, 100, 10] : [512500, 101.25, 10.2];
    const data = overrides[diagnostic] ?? values[index];
    return [{ device: { id }, diagnostic: { id: diagnostic }, dateTime: params.search.fromDate, data }];
  }));
}

test('consumption uses cumulative counter differences with units, caches baselines and coalesces reads', async () => {
  const { client, state } = harness(async calls => { await new Promise(resolve => setImmediate(resolve)); return counters(calls); });
  const request = [{ id: 'b1', from: FROM }, { id: 'b2', from: FROM }];
  const [a, b] = await Promise.all([client.telemetry(request), client.telemetry(request)]);
  assert.deepEqual(a, b); assert.equal(state.calls.length, 3); assert.equal(state.calls.flat().length, 12); assert.equal(state.maximum, 1);
  assert.deepEqual(a.map(x => [x.km, x.fuel_l, x.idle_l, x.odometer_m, x.status]), [[12.5, 1.25, 0.2, 512500, 'healthy'], [12.5, 1.25, 0.2, 512500, 'healthy']]);
  a[0].km = -1; assert.equal((await client.telemetry(request))[0].km, 12.5, 'cache must not be mutable by callers');
  state.now += 29999; await client.telemetry(request); assert.equal(state.calls.length, 3);
  state.now++; await client.telemetry(request); assert.equal(state.calls.length, 6);
  assert.equal(state.calls.slice(3).flat().length, 6, 'only three current counters per vehicle after first collection');
  assert.ok(state.calls.slice(3).flat().every(call => call.params.search.fromDate !== FROM));
});

test('counter permissions remain independent and are retried only after cooldown', async () => {
  const { client, state } = harness(calls => calls[0].params.search.diagnosticSearch.id === DIAGS[1] ? permission() : counters(calls));
  const request = [{ id: 'b1', from: FROM }];
  const [value] = await client.telemetry(request);
  assert.equal(value.km, 12.5); assert.equal(value.fuel_l, null); assert.equal(value.idle_l, 0.2); assert.equal(value.status, 'partial');
  assert.ok(!JSON.stringify(value).includes(CREDS.password));
  state.now += 30000; await client.telemetry(request); assert.equal(state.calls.length, 5, 'denied fuel diagnostic is not retried early');
  state.now += 30000; await client.telemetry(request); assert.equal(state.calls.length, 8);
});

test('missing samples and reset counters stay unknown, never zero consumption', async () => {
  const { client } = harness(calls => reply(calls.map(({ params }) => {
    const diag = params.search.diagnosticSearch.id, date = params.search.fromDate, baseline = date === FROM;
    if (diag === DIAGS[2]) return [];
    return [{ device: { id: 'b1' }, diagnostic: { id: diag }, dateTime: date, data: baseline ? 100 : 50 }];
  })));
  const [value] = await client.telemetry([{ id: 'b1', from: FROM }]);
  assert.equal(value.km, null); assert.equal(value.fuel_l, null); assert.equal(value.idle_l, null); assert.equal(value.status, 'partial');
});

test('current or baseline readings from other devices, diagnostics or future timestamps are ignored', async () => {
  const { client } = harness(calls => reply(calls.map(({ params }) => [
    { device: { id: 'other' }, dateTime: params.search.fromDate, data: 100 },
    { device: { id: 'b1' }, diagnostic: { id: 'other' }, dateTime: params.search.fromDate, data: 100 },
    { device: { id: 'b1' }, dateTime: new Date(Date.parse(params.search.fromDate) + 1000).toISOString(), data: 100 }
  ])));
  const [value] = await client.telemetry([{ id: 'b1', from: FROM }]);
  assert.equal(value.odometer_m, null); assert.equal(value.status, 'unavailable');
});

test('a hundred vehicles use bounded sequential batches and invalid periods fail before network access', async () => {
  const { client, state } = harness(calls => counters(calls));
  const items = Array.from({ length: 100 }, (_, i) => ({ id: 'b' + i, from: FROM }));
  assert.equal((await client.telemetry(items)).length, 100); assert.equal(state.calls.length, 12); assert.equal(state.maximum, 1);
  const count = state.calls.length;
  for (const input of [items.concat(items[0]), [{ id: 'b1', from: 'invalid' }], [{ id: 'b1', from: new Date(NOW + 1).toISOString() }], [{ id: 'b1', from: new Date(NOW - 36 * 3600000 - 1).toISOString() }], [{ id: '../x', from: FROM }], [{ id: 'b1', from: FROM }, { id: 'b1', from: '2026-10-30T01:00:00.000Z' }]]) {
    await assert.rejects(client.telemetry(input), e => e.status === 400);
  }
  assert.equal(state.calls.length, count); assert.deepEqual(await client.telemetry([]), []);
});

test('events only include valid overlapping events for requested vehicles and are cached for ten seconds', async () => {
  const valid = { id: 'event1', device: { id: 'b1' }, rule: { id: 'RuleHarshBrakingId' }, activeFrom: new Date(NOW - 60000).toISOString(), activeTo: new Date(NOW - 50000).toISOString(), duration: '00:00:10', distance: 0.08 };
  const { client, state } = harness(calls => reply(calls.map(({ params }) => {
    assert.equal(params.typeName, 'ExceptionEvent'); assert.equal(Date.parse(params.search.toDate) - Date.parse(params.search.fromDate), 1800000);
    assert.equal(params.resultsLimit, 1000);
    return [valid, { ...valid, id: 'old', activeTo: new Date(NOW - 1900000).toISOString() }, { ...valid, id: 'invalid', state: 'ExceptionEventStateInvalidId' }, { ...valid, id: 'wrong', device: { id: 'other' } }, { ...valid, id: 'future', activeFrom: new Date(NOW + 1000).toISOString() }];
  })));
  const [value] = await client.events(['b1']);
  assert.equal(value.status, 'healthy'); assert.deepEqual(value.events, [{ id: 'event1', rule: 'RuleHarshBrakingId', at: valid.activeFrom, end: valid.activeTo, dur_min: 1 / 6, km: 0.08 }]);
  state.now += 9999; await client.events(['b1']); assert.equal(state.calls.length, 1);
  state.now++; await client.events(['b1']); assert.equal(state.calls.length, 2);
});

test('events permissions are explicit and neither quota nor incomplete responses become healthy empty snapshots', async () => {
  const denied = harness(() => permission());
  assert.equal((await denied.client.events(['b1']))[0].status, 'unavailable');
  denied.state.now += 10000; await denied.client.events(['b1']); assert.equal(denied.state.calls.length, 1);
  for (const result of [quota(), reply([]), reply([Array.from({ length: 1000 }, () => ({}))])]) {
    const { client } = harness(() => result);
    await assert.rejects(client.events(['b1']));
  }
  const limited = harness(() => quota()); await assert.rejects(limited.client.telemetry([{ id: 'b1', from: FROM }]), e => e.kind === 'quota');
});

test('reset invalidates enrichment caches and baselines', async () => {
  const { client, state } = harness(calls => counters(calls));
  const request = [{ id: 'b1', from: FROM }];
  await client.telemetry(request); client.reset(); await client.telemetry(request);
  assert.equal(state.calls.length, 6); assert.equal(state.calls.flat().length, 12);
});
