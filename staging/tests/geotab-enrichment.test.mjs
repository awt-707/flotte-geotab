import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGeotabService, geotabIntervalMs, telemetryIntervalMs, telemetryDayStart } from '../server/geotab-service.mjs';
import { GeotabError } from '../server/geotab.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t,{onTelemetry=async()=>{}}={}) {
  const local = new URL('../.local/', import.meta.url); await fs.mkdir(local, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(new URL('geotab-enrichment-test-', local).pathname);
  let now = Date.parse('2026-10-30T12:00:00Z');
  const calls = { positions: [], events: [], telemetry: [] }, hooks = {}, timers = [], motionTokens = [];
  const data = {
    fleet_sources: [{ id: 'geotab', status: 'unconnected', metadata: {} }],
    vehicles: [{ key: 'a', plate: 'TEST-A', geotab_id: null }, { key: 'b', plate: 'TEST-B', geotab_id: null }], live_status: []
  };
  const matches = (row, params) => Object.entries(params).every(([key, value]) => !String(value).startsWith('eq.') || String(row[key]) === value.slice(3));
  const list = async (table, params = {}, token) => structuredClone(data[table].filter(row => matches(row, params)
    && (token !== 'agency-a' || (row.key || row.vehicle_key) === 'a')));
  const db = async (table, { params = {}, method = 'GET', token } = {}) => {
    if (method === 'DELETE') { data[table] = data[table].filter(row => !matches(row, params)); return null; }
    assert.equal(method, 'GET'); return list(table, params, token);
  };
  const patch = async (table, params, body) => data[table].filter(row => matches(row, params)).forEach(row => Object.assign(row, body));
  const upsert = async (table, rows, key) => rows.forEach(row => {
    const previous = data[table].find(value => value[key] === row[key]); if (previous) Object.assign(previous, row); else data[table].push({ ...row });
  });
  const health = async (_id, status, extra = {}) => Object.assign(data.fleet_sources[0], { status }, extra);
  class Client {
    async devices() { return [{ id: 'g1', name: 'Test A', plate: 'TEST-A' }, { id: 'g2', name: 'Test B', plate: 'TEST-B' }]; }
    async positions(ids) {
      calls.positions.push({ at: now, ids }); if (hooks.positions) return hooks.positions(ids);
      return ids.map(id => ({ id, at: new Date(now).toISOString(), lat: 33, lon: -7, speed: 20, bearing: 37, ign_on: true, state: 'En route' }));
    }
    async events(ids) {
      calls.events.push({ at: now, ids }); if (hooks.events) return hooks.events(ids);
      return ids.map(id => ({ id, at: new Date(now).toISOString(), status: 'healthy', events: [{ id: 'event-' + id, rule: 'RuleHarshBrakingId', at: new Date(now - 1000).toISOString() }] }));
    }
    async telemetry(items) {
      calls.telemetry.push({ at: now, items }); if (hooks.telemetry) return hooks.telemetry(items);
      return items.map(item => ({ ...item, at: new Date(now).toISOString(), status: 'healthy', km: 25, fuel_l: 1.5, idle_l: 0.05 }));
    }
  }
  const service = createGeotabService({ db, list, patch, upsert, health, Client, credentialsPath: directory + '/credentials.json', now: () => now,
    setTimer: (fn, delay) => { const timer = { fn, delay, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cancelled = true; },onTelemetry,
    readMotion: async token => { motionTokens.push(token); return { alerts: [{ key: 'a', status: 'open' }, { vehicle_key: 'b', status: 'open' }], coverage: {} }; }
  });
  t.after(async () => { service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await service.connect({ database: 'testdb', userName: 'test@example.invalid', password: 'private-test-value' });
  await service.link({ vehicle_key: 'a', device_id: 'g1' }); await service.link({ vehicle_key: 'b', device_id: 'g2' });
  return { service, calls, hooks, data, motionTokens, now: () => now, advance: ms => { now += ms; },
    fire: async () => { let timer; do { timer = timers.shift(); } while (timer?.cancelled); assert.ok(timer); now += timer.delay; await timer.fn(); await flush(); },
    pending: () => timers.filter(timer => !timer.cancelled)
  };
}

test('first position schedules both enrichments without waiting for history and subsequent reads respect their own cadences', async t => {
  const f = await fixture(t), gate = deferred();
  f.hooks.events = async ids => { await gate.promise; return ids.map(id => ({ id, status: 'healthy', at: new Date(f.now()).toISOString(), events: [] })); };
  const result = await f.service.start();
  assert.equal(result.interval_s, 2); assert.equal(f.calls.positions.length, 1); assert.equal(f.calls.events.length, 1); assert.equal(f.calls.telemetry.length, 1);
  assert.equal(f.calls.events[0].at, f.calls.positions[0].at); assert.equal(f.calls.telemetry[0].at, f.calls.positions[0].at);
  assert.ok(f.calls.telemetry[0].items.every(item => item.from === '2026-10-30T00:00:00.000Z'));
  await f.fire(); await f.fire(); assert.equal(f.calls.positions.length, 3); assert.equal(f.calls.events.length, 1, 'pending history is not duplicated');
  assert.equal(f.calls.telemetry.length, 1); gate.resolve(); await flush();
  for (let i = 0; i < 13; i++) await f.fire();
  assert.equal(f.calls.positions.length, 16); assert.equal(f.calls.events.length, 4); assert.equal(f.calls.telemetry.length, 2);
  assert.equal(f.calls.telemetry[1].at - f.calls.telemetry[0].at, 30000);
});

test('cache snapshots filter telemetry, events and motion by visible vehicles and perform no provider reads', async t => {
  const f = await fixture(t); await f.service.start(); await flush();
  const before = Object.fromEntries(Object.entries(f.calls).map(([key, value]) => [key, value.length]));
  const visible = await f.service.live('agency-a');
  assert.deepEqual(visible.vehicles.map(row => row.key), ['a']); assert.equal(visible.vehicles[0].bearing, 37);
  assert.deepEqual(Object.keys(visible.telemetry), ['a']); assert.equal(visible.telemetry.a.fresh, true);
  assert.deepEqual(visible.events.map(row => row.key), ['a']); assert.equal(visible.events[0].plate, 'TEST-A');
  assert.deepEqual(visible.motion_alerts.map(row => row.key), ['a']); assert.equal(f.motionTokens.at(-1), 'agency-a');
  await f.service.live('agency-a'); await f.service.status();
  assert.deepEqual(Object.fromEntries(Object.entries(f.calls).map(([key, value]) => [key, value.length])), before);
});

test('failed optional telemetry preserves the healthy position loop and marks previous counters stale', async t => {
  const f = await fixture(t); await f.service.start(); await flush();
  f.hooks.telemetry = () => { throw new GeotabError('Quota Geotab atteint : lecture différée', 429, 120, 'quota'); };
  for (let i = 0; i < 15; i++) await f.fire();
  const snapshot = await f.service.live('agency-a');
  assert.equal(snapshot.source.status, 'healthy'); assert.equal(snapshot.source.telemetry_status, 'error');
  assert.equal(snapshot.vehicles[0].fresh, true); assert.equal(snapshot.telemetry.a.fresh, false);
  assert.equal(f.calls.positions.length, 16); assert.equal(f.calls.telemetry.length, 2); assert.equal(f.pending()[0].delay, 2000);
  await f.fire(); assert.equal(f.calls.telemetry.length, 2); assert.equal(f.calls.positions.length, 17);
});

test('late enrichment after stop cannot repopulate a paused snapshot or install timers', async t => {
  const notified=[],f = await fixture(t,{onTelemetry:async rows=>notified.push(rows)}), gate = deferred();
  f.hooks.telemetry = async items => { await gate.promise; return items.map(item => ({ ...item, at: new Date(f.now()).toISOString(), status: 'healthy', km: 42 })); };
  f.hooks.events = async ids => { await gate.promise; return ids.map(id => ({ id, at: new Date(f.now()).toISOString(), status: 'healthy', events: [{ id: 'late', rule: 'RuleHarshBrakingId', at: new Date(f.now()).toISOString() }] })); };
  await f.service.start(); await f.service.stop(); gate.resolve(); await flush();
  const snapshot = await f.service.live('agency-a');
  assert.equal(snapshot.source.status, 'paused'); assert.equal(snapshot.source.telemetry_status, 'pending'); assert.equal(snapshot.source.events_status, 'pending');
  assert.deepEqual(snapshot.telemetry, {}); assert.deepEqual(snapshot.events, []); assert.equal(f.pending().length, 0); assert.equal(f.service.polling, false);
  assert.deepEqual(notified,[],'a cancelled provider read cannot notify a driver');
});

test('driver notification telemetry retains vehicle/device evidence and a consumer failure leaves Geotab collection healthy',async t=>{
  const delivered=[],f=await fixture(t,{onTelemetry:async rows=>{delivered.push(structuredClone(rows));throw Error('Local notification unavailable');}});
  await f.service.start();await flush();
  assert.deepEqual(delivered[0].map(row=>[row.key,row.id]),[['a','g1'],['b','g2']]);
  const snapshot=await f.service.live('agency-a');
  assert.equal(snapshot.source.status,'healthy');assert.equal(snapshot.source.telemetry_status,'healthy');
  await f.fire();assert.equal(delivered.length,1,'position updates do not multiply fuel notifications');
});

test('day starts follow Casablanca midnight including Ramadan offset changes and year boundaries', () => {
  const cases = [
    ['2026-10-30T12:00:00Z', '2026-10-30T00:00:00.000Z'],
    ['2026-01-01T00:00:00Z', '2025-12-31T23:00:00.000Z'],
    ['2026-01-01T23:30:00Z', '2026-01-01T23:00:00.000Z'],
    ['2026-02-16T12:00:00Z', '2026-02-16T00:00:00.000Z'],
    ['2026-03-22T03:00:00Z', '2026-03-22T00:00:00.000Z'],
    ['2026-03-23T03:00:00Z', '2026-03-22T23:00:00.000Z']
  ];
  for (const [time, expected] of cases) assert.equal(telemetryDayStart(Date.parse(time)), expected, time);
});

test('steady read cadence reserves StatusData quota for recurring counters', () => {
  assert.equal(geotabIntervalMs(11), 2000); assert.equal(telemetryIntervalMs(11), 30000);
  assert.equal(geotabIntervalMs(100), 17000); assert.equal(telemetryIntervalMs(100), 50000);
  for (let count = 1; count <= 100; count++) {
    const positionsPerMinute = count * 60000 / geotabIntervalMs(count);
    const countersPerMinute = 3 * count * 60000 / telemetryIntervalMs(count);
    assert.ok(positionsPerMinute + countersPerMinute < 1000, 'steady StatusData budget for ' + count);
  }
});
