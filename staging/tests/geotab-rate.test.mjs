import test from 'node:test';
import assert from 'node:assert/strict';
import { GeotabClient } from '../server/geotab.mjs';

const NOW = Date.parse('2026-10-30T13:00:00Z'), FROM = '2026-10-30T00:00:00.000Z';
const reply = result => new Response(JSON.stringify({ result }));
const ids = (count, prefix = 'b') => Array.from({ length: count }, (_, i) => prefix + i);

function harness() {
  const state = { now: NOW, auth: 0, requests: 0, failAuthentication: false, reads: [] };
  const client = new GeotabClient({ credentials: async () => ({ database: 'test', userName: 'test@example.invalid', password: 'private-test' }), now: () => state.now,
    fetchFn: async (_url, options) => {
      const { method, params } = JSON.parse(options.body); state.requests++;
      if (method === 'Authenticate') { state.auth++; return reply({ path: 'ThisServer', credentials: { sessionId: 'TEST-SESSION-' + state.auth } }); }
      const calls = method === 'Get' ? [{ method, params }] : params.calls;
      assert.ok(calls.length <= 50);
      for (const call of calls) state.reads.push({ at: state.now, kind: call.params.typeName });
      if (state.failAuthentication) {
        state.failAuthentication = false;
        return new Response(JSON.stringify({ error: { data: { type: 'InvalidUserException' } } }));
      }
      const rows = calls.map(({ params: call }) => {
        const id = call.search.deviceSearch?.id;
        if (call.typeName === 'DeviceStatusInfo') return [{ device: { id }, dateTime: new Date(state.now).toISOString(), latitude: 33, longitude: -7, speed: 0, isDriving: false }];
        if (call.typeName === 'StatusData') return [{ device: { id }, diagnostic: call.search.diagnosticSearch, dateTime: call.search.fromDate, data: 1000 }];
        return [];
      });
      return reply(method === 'Get' ? rows[0] : rows);
    }
  });
  return { client, state, count: kind => state.reads.filter(row => row.kind === kind).length };
}

test('cold enrichment and fast positions share the StatusData budget and stop before 850 reads', async () => {
  const f = harness(), fleet = ids(100);
  await f.client.positions(fleet); await f.client.telemetry(fleet.map(id => ({ id, from: FROM })));
  assert.equal(f.count('StatusData'), 700);
  f.state.now += 17000; await f.client.positions(fleet); assert.equal(f.count('StatusData'), 800);
  f.state.now += 17000;
  await assert.rejects(f.client.positions(fleet), error => error.status === 429 && error.kind === 'quota' && error.retryAfter === 26);
  assert.equal(f.count('StatusData'), 850, 'no request above the shared allowance reached the provider');
  const before = f.state.requests;
  await assert.rejects(f.client.telemetry(fleet.map(id => ({ id, from: FROM }))), error => error.kind === 'quota');
  assert.equal(f.state.requests, before, 'counter retry is rejected before HTTP');
  f.state.now = NOW + 60000; await f.client.positions(fleet);
  const recent = f.state.reads.filter(row => row.kind === 'StatusData' && row.at > f.state.now - 60000);
  assert.ok(recent.length <= 850);
});

test('a rejected mixed multi-call does not consume its other entity allowance', async () => {
  const f = harness(), fleet = ids(25);
  for (let i = 0; i < 30; i++) await f.client.positions(fleet);
  assert.equal(f.count('DeviceStatusInfo'), 750); assert.equal(f.count('StatusData'), 750);
  const before = f.state.requests;
  await assert.rejects(f.client.positions(fleet), error => error.kind === 'quota' && error.retryAfter === 60);
  assert.equal(f.state.requests, before);
  assert.equal((await f.client.telemetry(ids(16).map(id => ({ id, from: FROM })))).length, 16);
  assert.equal(f.count('StatusData'), 846, 'all 96 remaining valid counter requests fit after atomic rejection');
});

test('all real authentication retry attempts reserve subcalls and cannot exceed the device-status limit', async () => {
  const f = harness(), fleet = ids(25);
  for (let i = 0; i < 29; i++) await f.client.positions(fleet);
  f.state.failAuthentication = true;
  await assert.rejects(f.client.positions(fleet), error => error.kind === 'quota');
  assert.equal(f.state.auth, 2, 'session was renewed after the provider rejected the old one');
  assert.equal(f.count('DeviceStatusInfo'), 750, 'the retry was stopped before a 775th device-status read');
  assert.equal(f.count('StatusData'), 750);
});

test('clock rollback and session reset do not replenish a rolling allowance; exact expiry does', async () => {
  const f = harness(), fleet = ids(25);
  for (let i = 0; i < 30; i++) await f.client.positions(fleet);
  f.client.reset(); f.state.now = NOW - 60000;
  await assert.rejects(f.client.positions(fleet), error => error.kind === 'quota' && error.retryAfter === 60);
  assert.equal(f.count('DeviceStatusInfo'), 750);
  f.state.now = NOW + 59999;
  await assert.rejects(f.client.positions(fleet), error => error.kind === 'quota' && error.retryAfter === 1);
  f.state.now = NOW + 60000; await f.client.positions(fleet);
  assert.equal(f.count('DeviceStatusInfo'), 775);
});

test('events use their own 1500-read budget even when each request is a batch', async () => {
  const f = harness();
  for (let i = 0; i < 15; i++) await f.client.events(ids(100, 'group' + i + '_'));
  assert.equal(f.count('ExceptionEvent'), 1500);
  const before = f.state.requests;
  await assert.rejects(f.client.events(ids(100, 'over_')), error => error.kind === 'quota');
  assert.equal(f.state.requests, before);
  assert.equal((await f.client.positions(['b1'])).length, 1, 'events do not exhaust the independent position allowance');
});

test('catalogue reads are counted and limited independently', async () => {
  const f = harness();
  for (let i = 0; i < 500; i++) await f.client.devices();
  assert.equal(f.count('Device'), 500);
  const before = f.state.requests;
  await assert.rejects(f.client.devices(), error => error.kind === 'quota');
  assert.equal(f.state.requests, before);
});
