import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMyclicarService } from '../server/myclicar-service.mjs';
import { readMyclicarCredentials } from '../server/myclicar.mjs';

const NOW = Date.parse('2026-10-30T13:00:00Z');
const CREDS = { email: 'synthetic@example.invalid', password: 'synthetic-app-password', httpUsername: 'synthetic-http-user', httpPassword: 'synthetic-http-password' };
const contract = () => ({ id: 'synthetic-1', reference: 'CONTRACT-1', clientReference: 'DRIVER-1', contactName: 'Synthetic Driver',
  vehicleRegistration: 'TEST-A', vehicleTemporaryRegistration: '', vehicleBrand: 'Test', vehicleModel: 'Model', status: 'IN_PROGRESS',
  departureDate: '2026-10-01T12:00:00Z', departureConditionDate: '01/10/2026 à 13h00', actualReturnDate: null, checkoutDate: '', updatedAt: '2026-10-30T12:00:00Z' });
const counts = { contracts: 1, active_contracts: 1, matched_assignments: 1, unmatched_contracts: 0 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const noPrivateData = value => {
  const encoded = JSON.stringify(value);
  for (const text of [CREDS.password, CREDS.httpPassword, 'SYNTHETIC_TOKEN', 'Synthetic Driver', 'DRIVER-1', 'private upstream payload']) assert.ok(!encoded.includes(text), text);
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclicar-service-'));
  const credentialsPath = path.join(directory, 'private', 'credentials.json');
  let clock = NOW, reads = 0, tests = 0, syncs = 0, snapshotHook, testHook, rpcHook, healthHook, afterHook, receiptHook;
  const events = [], timers = [], instances = [], calls = [];
  const source = { id: 'myclicar', status: 'unconnected', coverage: {} };
  let contracts = [];
  const db = async (table, options = {}) => {
    if (table === 'fleet_sources') { assert.equal(options.params.id, 'eq.myclicar'); return [structuredClone(source)]; }
    assert.equal(table, 'rpc/fleet_sync_myclicar'); assert.equal(options.method, 'POST');
    calls.push(structuredClone(options.body));
    if (rpcHook) await rpcHook(options.body);
    contracts = structuredClone(options.body.p_contracts);
    events.push('commit');
    const receipt = { ...counts, contracts: contracts.length, active_contracts: contracts.length,
      matched_assignments: contracts.length, raw_private_diagnostic: 'Synthetic Driver' };
    return receiptHook ? receiptHook(receipt) : receipt;
  };
  const patch = async (table, params, data) => {
    assert.equal(table, 'fleet_sources'); assert.deepEqual(params, { id: 'eq.myclicar' });
    Object.assign(source, data);
  };
  const health = async (id, status, extra = {}) => {
    assert.equal(id, 'myclicar'); events.push(status); Object.assign(source, { status }, extra); healthHook?.(status);
  };
  class Client {
    constructor({ credentials }) { this.credentials = credentials; this.resets = 0; instances.push(this); }
    reset() { this.resets++; }
    async test() {
      tests++; const credentials = await this.credentials();
      if (testHook) return testHook(credentials);
      if (credentials.password === 'rejected') throw Object.assign(new Error('private upstream payload SYNTHETIC_TOKEN'), { status: 502, kind: 'authentication' });
      return { ok: true };
    }
    async snapshot() {
      reads++; const credentials = await this.credentials();
      return snapshotHook ? snapshotHook(credentials) : { at: new Date(clock).toISOString(), contracts: [contract()], complete: true };
    }
  }
  const service = createMyclicarService({ db, list: async () => { throw new Error('Status must not scan contracts'); }, patch, health, credentialsPath, Client,
    now: () => clock, setTimer: (fn, delay) => { const timer = { fn, delay, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cancelled = true; }, afterSync: async () => { syncs++; events.push('match'); await afterHook?.(); } });
  t.after(async () => { service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, source, credentialsPath, calls, events, instances, connect: () => service.connect(CREDS),
    readCount: () => reads, testCount: () => tests, syncCount: () => syncs, contracts: () => contracts, now: () => clock, advance: ms => { clock += ms; },
    snapshot: hook => { snapshotHook = hook; }, test: hook => { testHook = hook; }, rpc: hook => { rpcHook = hook; },
    health: hook => { healthHook = hook; }, after: hook => { afterHook = hook; }, receipt: hook => { receiptHook = hook; },
    pending: () => timers.filter(timer => !timer.cancelled), fire: async () => {
      let timer; do { timer = timers.shift(); } while (timer?.cancelled);
      assert.ok(timer, 'Expected an automatic retry'); clock += timer.delay; return timer.fn();
    } };
}

test('status reads only local state and exposes an explicit, redacted admin DTO', async t => {
  const f = await fixture(t);
  const empty = await f.service.status();
  assert.equal(empty.configured, false); assert.equal(empty.status, 'unconnected'); assert.equal(empty.interval_s, 60);
  assert.deepEqual(empty.coverage, { contracts: 0, active_contracts: 0, matched_assignments: 0, unmatched_contracts: 0 });
  const configured = await f.connect();
  assert.equal(configured.email, CREDS.email); assert.equal(configured.httpUsername, CREDS.httpUsername);
  assert.equal(configured.httpConfigured, true); assert.equal(configured.polling, false);
  f.source.coverage = { ...counts, name: 'Synthetic Driver', accessToken: 'SYNTHETIC_TOKEN' };
  f.source.last_error = 'private upstream payload';
  const state = await f.service.status(); noPrivateData(state);
  assert.deepEqual(state.coverage, counts); assert.equal(f.readCount(), 0); assert.equal(f.testCount(), 1);
  assert.deepEqual(Object.keys(state).sort(), ['configured', 'email', 'httpUsername', 'httpConfigured', 'status', 'polling', 'interval_s',
    'next_attempt_at', 'retrying', 'last_success_at', 'last_error', 'coverage'].sort());
});

test('connection validates and tests before a private atomic save, and omitted passwords are retained', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.connect({ email: CREDS.email, httpUsername: CREDS.httpUsername }), error => error.status === 400);
  assert.equal(f.testCount(), 0);
  await f.connect();
  assert.equal((await fs.stat(f.credentialsPath)).mode & 0o777, 0o600);
  await f.service.connect({ email: 'replacement@example.invalid', httpUsername: 'replacement-user' });
  const saved = await readMyclicarCredentials(f.credentialsPath);
  assert.equal(saved.password, CREDS.password); assert.equal(saved.httpPassword, CREDS.httpPassword);
  assert.equal(saved.email, 'replacement@example.invalid');
  const before = await fs.readFile(f.credentialsPath, 'utf8');
  await assert.rejects(f.service.connect({ ...CREDS, password: '' }), error => error.status === 400);
  await assert.rejects(f.service.connect({ ...CREDS, password: 'rejected' }), error => { noPrivateData(error.message); return error.status === 502; });
  assert.equal(await fs.readFile(f.credentialsPath, 'utf8'), before);
  assert.equal((await f.service.status()).email, saved.email);
});

test('a failed credential test preserves an already running connection and its timer', async t => {
  const f = await fixture(t); await f.connect(); await f.service.start();
  const deadline = f.service.nextAttemptAt;
  await assert.rejects(f.service.connect({ ...CREDS, password: 'rejected' }));
  assert.equal(f.service.polling, true); assert.equal(f.pending().length, 1); assert.equal(f.service.nextAttemptAt, deadline);
  await f.fire(); assert.equal(f.readCount(), 2); assert.equal(f.source.status, 'healthy');
});

test('only a complete projected snapshot commits and health becomes healthy before matching', async t => {
  const f = await fixture(t); await f.connect();
  f.snapshot(() => ({ at: new Date(f.now()).toISOString(), complete: true,
    contracts: [{ ...contract(), telephone: 'private upstream payload', accessToken: 'SYNTHETIC_TOKEN', password: CREDS.password }] }));
  f.rpc(async () => { assert.notEqual(f.source.status, 'healthy'); assert.equal(f.syncCount(), 0); });
  f.after(() => { assert.equal(f.source.status, 'healthy'); assert.equal(f.contracts().length, 1); });
  const result = await f.service.start();
  assert.deepEqual(f.events, ['paused', 'commit', 'healthy', 'match']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].p_observed_at, '2026-10-30T13:00:00.000Z');
  assert.equal(f.calls[0].p_contracts[0].client_code, 'DRIVER-1'); assert.equal(f.calls[0].p_contracts[0].plate, 'TEST-A');
  assert.equal(f.calls[0].p_contracts[0].effective_start_at, '2026-10-01T13:00:00.000Z');
  assert.equal('accessToken' in f.calls[0].p_contracts[0], false); assert.equal('telephone' in f.calls[0].p_contracts[0], false);
  assert.equal(result.last_success_at, f.calls[0].p_observed_at); assert.deepEqual(result.coverage, counts); noPrivateData(result);
  const calls = f.readCount(); await f.service.status(); await f.service.status(); assert.equal(f.readCount(), calls);
});

test('incomplete, oversized, duplicate or stale snapshots never close previous contracts', async t => {
  for (const alter of [snapshot => ({ ...snapshot, complete: false }), snapshot => ({ ...snapshot, contracts: undefined }),
    snapshot => ({ ...snapshot, contracts: Array(2001).fill(contract()) }), snapshot => ({ ...snapshot, contracts: [contract(), contract()] }),
    snapshot => ({ ...snapshot, at: 'invalid' }), snapshot => ({ ...snapshot, at: new Date(NOW - 60001).toISOString() }),
    snapshot => ({ ...snapshot, contracts: [{ ...contract(), departureConditionDate: 'invalid' }] })]) {
    const f = await fixture(t); await f.connect(); await f.service.start(); const before = structuredClone(f.contracts());
    f.snapshot(() => alter({ at: new Date(f.now()).toISOString(), complete: true, contracts: [contract()] }));
    await f.fire();
    assert.deepEqual(f.contracts(), before); assert.equal(f.calls.length, 1); assert.equal(f.source.status, 'error');
    assert.match(f.source.last_error, /incomplète/); assert.equal(f.syncCount(), 1); assert.equal(f.service.retrying, true);
  }
});

test('a complete empty snapshot reaches the transaction while an upstream failure preserves stored data', async t => {
  const f = await fixture(t); await f.connect(); await f.service.start();
  f.snapshot(() => { throw new Error('private upstream payload SYNTHETIC_TOKEN'); });
  await f.fire(); assert.equal(f.calls.length, 1); assert.equal(f.contracts().length, 1); noPrivateData(await f.service.status());
  f.snapshot(() => ({ at: new Date(f.now()).toISOString(), complete: true, contracts: [] }));
  await f.fire(); assert.equal(f.calls.length, 2); assert.equal(f.contracts().length, 0); assert.equal(f.source.status, 'healthy');
});

test('a transaction failure never marks the source healthy or runs matching', async t => {
  const f = await fixture(t); await f.connect();
  f.rpc(() => { throw new Error('private upstream payload SYNTHETIC_TOKEN'); });
  const state = await f.service.start();
  assert.equal(state.ok, false); assert.equal(state.polling, true); assert.equal(state.retrying, true);
  assert.equal(f.contracts().length, 0); assert.equal(f.syncCount(), 0); assert.equal(f.source.last_success_at, undefined);
  assert.ok(!f.events.includes('healthy')); noPrivateData(state); assert.equal(f.pending()[0].delay, 60000);
});

test('an invalid transaction receipt cannot be published as a healthy complete sync', async t => {
  for (const receipt of [null, {}, { ...counts, contracts: 2 }, { ...counts, active_contracts: 0 }, { ...counts, unmatched_contracts: 1 }]) {
    const f = await fixture(t); await f.connect(); f.receipt(() => receipt);
    const state = await f.service.start();
    assert.equal(state.status, 'error'); assert.equal(state.retrying, true); assert.equal(f.syncCount(), 0);
    assert.ok(!f.events.includes('healthy')); noPrivateData(state);
  }
});

test('a matching failure after commit is retried and its diagnostic stays private', async t => {
  const f = await fixture(t); await f.connect(); f.after(() => { throw new Error('private upstream payload SYNTHETIC_TOKEN'); });
  const state = await f.service.start(); assert.equal(state.status, 'error'); assert.equal(state.retrying, true);
  assert.equal(f.contracts().length, 1); assert.equal(f.source.last_success_at, new Date(NOW).toISOString()); noPrivateData(state);
  f.after(undefined); await f.fire(); assert.equal(f.source.status, 'healthy'); assert.equal(f.syncCount(), 2);
});

test('even a failing local error recorder cannot expose a raw database diagnostic', async t => {
  const f = await fixture(t); await f.connect();
  f.snapshot(() => { throw new Error('private upstream payload'); });
  f.health(status => { if (status === 'error') throw new Error('private upstream payload SYNTHETIC_TOKEN'); });
  await assert.rejects(f.service.refresh(), error => { noPrivateData(error.message); return error.status === 502; });
});

test('the first outage keeps retry armed; provider retry-after overrides the one minute cadence', async t => {
  const f = await fixture(t); await f.connect();
  f.snapshot(() => { throw Object.assign(new Error('private upstream payload'), { status: 429, retryAfter: 1200, kind: 'quota' }); });
  const state = await f.service.start();
  assert.equal(state.polling, true); assert.equal(state.retrying, true); assert.equal(f.pending()[0].delay, 1200000);
  assert.equal(state.next_attempt_at, new Date(NOW + 1200000).toISOString());
  const before = f.readCount(); await f.service.start(); await assert.rejects(f.service.refresh(), error => error.status === 429);
  assert.equal(f.readCount(), before); assert.equal(f.pending().length, 1);
  f.snapshot(undefined); await f.fire(); assert.equal(f.source.status, 'healthy'); assert.equal(f.service.retrying, false);
  await f.service.stop(); assert.equal(f.pending().length, 0); assert.equal(f.service.nextAttemptAt, null);
});

test('ordinary failures back off to fifteen minutes and reset after recovery', async t => {
  const f = await fixture(t); await f.connect(); f.snapshot(() => { throw new Error('upstream unavailable'); });
  await f.service.start();
  for (const delay of [60000, 120000, 240000, 480000, 900000, 900000]) {
    assert.equal(f.pending()[0].delay, delay); await f.fire();
  }
  f.snapshot(undefined); await f.fire(); assert.equal(f.pending()[0].delay, 60000); assert.equal(f.service.retrying, false);
});

test('polling uses a one minute cadence without adding request duration or overlapping reads', async t => {
  const f = await fixture(t); await f.connect(); const attempts = [];
  f.snapshot(() => { attempts.push(f.now()); f.advance(12000); return { at: new Date(f.now()).toISOString(), contracts: [contract()], complete: true }; });
  await f.service.start(); assert.equal(f.pending()[0].delay, 48000); await f.fire(); await f.fire();
  assert.deepEqual(attempts.map(at => at - NOW), [0, 60000, 120000]);
  const entered = deferred(), held = deferred();
  f.snapshot(() => { entered.resolve(); return held.promise; });
  const scheduled = f.fire(); await entered.promise;
  const reads = f.readCount(), manual = f.service.refresh(); assert.equal(f.readCount(), reads); assert.equal(f.pending().length, 0);
  held.resolve({ at: new Date(f.now()).toISOString(), contracts: [contract()], complete: true });
  await scheduled; await manual; assert.equal(f.pending().length, 1); assert.equal(f.readCount(), reads);
});

test('stop discards an in-flight snapshot and prevents its timer or health from reviving', async t => {
  const f = await fixture(t); await f.connect(); const entered = deferred(), held = deferred();
  f.snapshot(() => { entered.resolve(); return held.promise; });
  const work = f.service.start(); await entered.promise; await f.service.stop();
  held.resolve({ at: new Date(f.now()).toISOString(), complete: true, contracts: [contract()] });
  const result = await work;
  assert.equal(result.ignored, true); assert.equal(result.polling, false); assert.equal(f.calls.length, 0);
  assert.equal(f.source.status, 'paused'); assert.equal(f.syncCount(), 0); assert.equal(f.pending().length, 0);
});

test('stop requested during a commit prevents later matching and a healthy state', async t => {
  const f = await fixture(t); await f.connect(); const entered = deferred(), held = deferred();
  f.rpc(async () => { entered.resolve(); await held.promise; });
  const work = f.service.start(); await entered.promise; const stopping = f.service.stop(); held.resolve();
  const result = await work; await stopping;
  assert.equal(result.ignored, true); assert.equal(f.source.status, 'paused'); assert.equal(f.service.polling, false);
  assert.equal(f.syncCount(), 0); assert.ok(!f.events.includes('healthy')); assert.equal(f.pending().length, 0);
});

test('a stop triggered by healthy commit still prevents matching and timer installation', async t => {
  const f = await fixture(t); await f.connect(); let stopped;
  f.health(status => { if (status === 'healthy') stopped = f.service.stop(); });
  const result = await f.service.start(); await stopped;
  assert.equal(result.ignored, true); assert.equal(f.source.status, 'paused'); assert.equal(f.syncCount(), 0); assert.equal(f.pending().length, 0);
});

test('reconnecting discards old in-flight data and leaves restart intent to the caller', async t => {
  const f = await fixture(t); await f.connect(); const entered = deferred(), held = deferred();
  f.snapshot(() => { entered.resolve(); return held.promise; });
  const old = f.service.start(); await entered.promise;
  const connected = await f.service.connect({ ...CREDS, password: 'replacement-password' });
  assert.equal(connected.polling, false); assert.equal(f.pending().length, 0);
  f.snapshot(undefined); const resumed = f.service.start(); assert.equal(f.readCount(), 1, 'wait for previous request to finish');
  held.resolve({ at: new Date(f.now()).toISOString(), complete: true, contracts: [{ ...contract(), id: 'old-connection' }] });
  await old; const state = await resumed;
  assert.equal(state.polling, true); assert.equal(f.calls.length, 1); assert.equal(f.contracts()[0].external_id, 'synthetic-1');
  assert.equal((await readMyclicarCredentials(f.credentialsPath)).password, 'replacement-password');
});

test('close cancels only in-memory work and does not persist a pause', async t => {
  const f = await fixture(t); await f.connect(); await f.service.start(); const before = structuredClone(f.source);
  f.service.close(); assert.equal(f.pending().length, 0); assert.equal(f.service.polling, false); assert.deepEqual(f.source, before);
  await assert.rejects(f.service.start(), error => error.status === 409);
  assert.equal((await f.service.status()).status, 'paused');
});

test('close during a connection test prevents saving credentials or writing source health', async t => {
  const f = await fixture(t), entered = deferred(), held = deferred();
  f.test(async () => { entered.resolve(); await held.promise; return { ok: true }; });
  const work = f.connect(); await entered.promise; f.service.close(); held.resolve();
  const result = await work; assert.equal(result.ignored, true); assert.equal(result.configured, false);
  assert.equal(await readMyclicarCredentials(f.credentialsPath), null); assert.deepEqual(f.events, []);
});

test('a successful snapshot becomes stale locally after five minutes without API reads', async t => {
  const f = await fixture(t); await f.connect(); await f.service.start(); f.advance(300001);
  const before = f.readCount(); assert.equal((await f.service.status()).status, 'stale'); assert.equal(f.readCount(), before);
});
