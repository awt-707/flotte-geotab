import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderEarningsStore} from '../server/provider-earnings-store.mjs';
import {parseUberEarningsPeriod} from '../server/uber-earnings.mjs';

const ORG = '11111111-1111-4111-8111-111111111111';
const DRIVER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-03T12:00:00Z');
function payload(extra = {}) {
  return {version: 1, source: 'uber_fleet_earnings', organizationId: ORG,
    sourceUrl: `https://fleethub.uber.com/orgs/${ORG}/earnings?ignored=private`, observedAt: new Date(NOW).toISOString(),
    providerPeriod: {...parseUberEarningsPeriod('02/11/2026 04:00 - 09/11/2026 04:00'), mode: 'custom'},
    currency: 'MAD', fleet: {revenue: '300.00 MAD', cash: '80.00 MAD', end_balance: '120.00 MAD'},
    drivers: [{providerDriverId: DRIVER, driverName: 'Synthetic Driver', driverNameComplete: true,
      metrics: {revenue: '300.00 MAD', cash: '80.00 MAD', adjustments: '-5.00 MAD'}}],
    coverage: {complete: true, driverRowsObserved: 1, driverRowsTotal: 1, pages: 1}, ...extra};
}
const receipt = extra => ({snapshot_id: ID, revision: 1, duplicate: false, ignored: false,
  rows: 1, matched: 1, unmatched: 0, coverage_complete: true, mapping_complete: true, ...extra});
function fixture({reply = receipt(), error = null, throws = false} = {}) {
  const calls = [];
  const db = {async rpc(name, args) { calls.push({name, args}); if (throws) throw Error('private connection detail'); return {data: reply, error}; }};
  return {calls, store: createProviderEarningsStore({db, organizationId: ORG, now: () => NOW})};
}

test('one atomic service RPC receives the shared normalizer output, with no client agency mapping', async () => {
  const {calls, store} = fixture(), input = payload();
  input.drivers[0].agency_id = 999;
  const result = await store.ingest(input);
  assert.deepEqual(result, receipt());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'provider_earnings_commit');
  const snapshot = calls[0].args.p_snapshot;
  assert.equal(snapshot.source, 'uber_fleet_earnings');
  assert.equal(snapshot.organization_id, ORG);
  assert.equal(snapshot.fleet.revenue_minor, 30000);
  assert.equal(snapshot.fleet.end_balance_minor, 12000);
  assert.equal(snapshot.fleet.net_minor, null);
  assert.equal(snapshot.drivers[0].adjustments_minor, -500);
  assert.equal(snapshot.drivers[0].agency_id, undefined);
  assert.equal(snapshot.source_url, `https://fleethub.uber.com/orgs/${ORG}/earnings`);
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.provider_period.start_at, '2026-11-02T04:00:00.000Z');
});

test('wrong organization, ambiguous amounts, bad periods and expired observations never reach storage', async () => {
  for (const change of [
    value => { value.organizationId = DRIVER; },
    value => { value.fleet.revenue = '1.234,567 MAD'; },
    value => { value.providerPeriod.start_at = '2026-11-02T05:02:00Z'; },
    value => { value.observedAt = new Date(NOW - 16 * 60000).toISOString(); },
    value => { value.currency = 'UNKNOWN'; },
    value => { value.drivers.push({...value.drivers[0]}); value.coverage.driverRowsObserved = 2; value.coverage.driverRowsTotal = 2; }
  ]) {
    const {calls, store} = fixture(), value = payload(); change(value);
    await assert.rejects(store.ingest(value)); assert.equal(calls.length, 0);
  }
});

test('the configured organization is resolved from trusted settings, never inferred from the payload', async () => {
  assert.throws(() => createProviderEarningsStore({db: {rpc() {}}}), /configured/);
  let org = ORG, calls = 0;
  const store = createProviderEarningsStore({db: {async rpc() {calls++;return {data: receipt()};}}, organizationId: () => org, now: () => NOW});
  await store.ingest(payload()); org = DRIVER;
  await assert.rejects(store.ingest(payload()), {code: 'organization_mismatch'});
  assert.equal(calls, 1);
  org = null; await assert.rejects(store.ingest(payload()), {code: 'earnings_configuration'});
});

test('partial or stale persistence receipts remain explicit and do not expose financial or internal payloads', async () => {
  const reply = receipt({ignored: true, reason: 'complete_snapshot_preserved', internalSecret: 'must disappear'});
  const {calls, store} = fixture({reply}), input = payload();
  input.coverage = {complete: false, driverRowsObserved: 1, driverRowsTotal: 2, pages: 1};
  const result = await store.ingest(input);
  assert.equal(result.ignored, true);
  assert.equal(result.reason, 'complete_snapshot_preserved');
  assert.equal(calls[0].args.p_snapshot.coverage.complete, false);
  assert.equal(result.internalSecret, undefined);
  assert.equal(result.fleet, undefined);
});

test('database failures and malformed acknowledgements fail without leaking backend details', async () => {
  for (const options of [{error: {message: 'private database detail'}}, {throws: true}, {reply: null}, {reply: receipt({revision: -1})}]) {
    const {store} = fixture(options);
    await assert.rejects(store.ingest(payload()), error => {
      assert.ok(['earnings_storage', 'earnings_receipt'].includes(error.code));
      assert.equal(error.status, 502); assert.doesNotMatch(error.message, /private/); return true;
    });
  }
});
