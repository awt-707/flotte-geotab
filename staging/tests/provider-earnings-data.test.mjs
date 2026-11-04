import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateUberEarnings} from '../site/provider-earnings-calculation.js';
import {selectProviderEarnings, createProviderEarningsLoader, combineProviderEarnings} from '../site/provider-earnings-data.js';
import {getRevenuePeriod} from '../site/revenue-metrics.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER = '55555555-5555-4555-8555-555555555555';
const PERIOD = {start: '2026-10-19T04:00:00.000Z', end: '2026-10-26T04:00:00.000Z', timeZone: 'Africa/Casablanca'};
const OBSERVED = '2026-10-27T12:00:00.000Z', NOW = Date.parse('2026-10-27T12:10:00Z');
function row(extra = {}) {
  return {snapshot_id: ID, provider_row: 0, source: 'uber', organization_id: ORG,
    period_start: PERIOD.start, period_end: PERIOD.end, time_zone: PERIOD.timeZone, currency: 'MAD',
    observed_at: OBSERVED, snapshot_revision: 1, coverage_complete: true, mapping_complete: true,
    agency_rows_total: 1, driver_rows_total: 1, provider_driver_id: DRIVER, driver_name: 'Synthetic Driver', driver_name_complete: true,
    fleet_driver_id: DRIVER, driver_code: 'A', agency_id: 1, mapping_status: 'confirmed',
    amounts: {revenue_minor: 10000, gross_minor: 15000, net_minor: null, payout_minor: 5000, cash_minor: 4000, end_balance_minor: 9000000}, ...extra};
}
function header(extra = {}) {
  return {id: ID, source: 'uber', organization_id: ORG, period_start: PERIOD.start, period_end: PERIOD.end,
    time_zone: PERIOD.timeZone, period_label: '19–26 octobre', period_mode: 'settlement', currency: 'MAD',
    observed_at: OBSERVED, received_at: OBSERVED, revision: 1,
    coverage: {complete: true, driver_rows_observed: 1, driver_rows_total: 1},
    fleet_amounts: {revenue_minor: 10000, gross_minor: 15000, net_minor: null, payout_minor: 5000, end_balance_minor: 9000000}, ...extra};
}
const select = (extra = {}) => selectProviderEarnings({period: PERIOD, organizationIds: [ORG], role: 'admin', snapshots: [header()], rows: [row()], now: NOW, ...extra});
const revenue = report => report.currencies[0].revenue.minor;
const legacy = () => [
  {source: 'uber', sourceKind: 'uber_payment', id: 'old-uber', occurredAt: '2026-10-20T12:00:00Z', currency: 'MAD', revenueMinor: 99999},
  {source: 'bolt', sourceKind: 'bolt_session', id: 'old-bolt', occurredAt: '2026-10-20T12:00:00Z', currency: 'MAD', revenueMinor: 2000},
  {source: 'private', sourceKind: 'private_cash_course', id: 'private', day: '2026-10-20', currency: 'MAD', revenueMinor: 3000}
];

test('exact fleet snapshot selects the header without adding its driver rows, or treating balance as income', () => {
  const result = select();
  assert.equal(result.replacement.allowed, true);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].scope.kind, 'fleet');
  assert.equal(revenue(result.selected[0]), 10000);
  assert.equal(result.selected[0].currencies[0].endBalance.minor, 9000000);
  assert.equal(result.selected[0].currencies[0].net.minor, null);
  assert.deepEqual(result.selected[0].byDay, []);
  assert.equal(result.selected[0].freshness.ageMs, 600000);
});

test('chooses the latest complete snapshot for an exact window, never a newer partial refresh', () => {
  const older = header({id: OTHER_ID, observed_at: '2026-10-27T11:00:00.000Z', revision: 2});
  const partial = header({coverage: {complete: false, driver_rows_observed: 1}, fleet_amounts: {revenue_minor: 80000}});
  const result = select({snapshots: [partial, older], rows: [row({coverage_complete: false}), row({snapshot_id: OTHER_ID, observed_at: older.observed_at, snapshot_revision: 2})]});
  assert.equal(result.replacement.allowed, true);
  assert.equal(result.selected[0].id, OTHER_ID);
  assert.equal(revenue(result.selected[0]), 10000);
});

test('a weekly aggregate is visible separately for a day or partial live interval, with no prorating', () => {
  for (const period of [
    {...PERIOD, start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z'},
    {...PERIOD, end: '2026-10-22T12:00:00.000Z'}
  ]) {
    const result = select({period});
    assert.equal(result.replacement.allowed, false);
    assert.equal(result.reports.length, 1);
    assert.equal(revenue(result.reports[0]), 10000);
    assert.equal(result.reports[0].period.end, PERIOD.end);
    assert.deepEqual(result.reports[0].byDay, []);
  }
});

test('exact organization population must be known and entirely present before replacing historical Uber', () => {
  assert.equal(select({organizationIds: []}).replacement.reason, 'organization_scope_unproven');
  assert.equal(select({organizationIds: [ORG, OTHER_ORG]}).replacement.allowed, false);
  const otherHeader = header({id: OTHER_ID, organization_id: OTHER_ORG, currency: 'EUR'});
  const otherRow = row({snapshot_id: OTHER_ID, organization_id: OTHER_ORG, currency: 'EUR'});
  const result = select({organizationIds: [ORG, OTHER_ORG], snapshots: [header(), otherHeader], rows: [row(), otherRow]});
  assert.equal(result.replacement.allowed, true);
  assert.deepEqual(result.selected.map(item => item.currency).sort(), ['EUR', 'MAD']);
});

test('an incomplete currency in the same organization prevents replacing all historical Uber imports', () => {
  const result = select({snapshots: [header(), header({id: OTHER_ID, currency: 'EUR', coverage: {complete: false, driver_rows_observed: 1}})],
    rows: [row(), row({snapshot_id: OTHER_ID, currency: 'EUR', coverage_complete: false})]});
  assert.equal(result.replacement.allowed, false);
  assert.equal(result.replacement.reason, 'incomplete_currency_coverage');
  assert.match(result.replacement.message, /chaque devise/);
  assert.equal(result.selected.length, 0); assert.equal(result.reports.length, 2);
});

test('manager agency and driver totals require confirmed mapping and expected population counts', () => {
  for (const filter of [{agencyId: '1'}, {agencyId: '1', driverCode: 'A'}, {driverCode: 'A'}]) {
    const result = select({snapshots: [], role: 'manager', ...filter});
    assert.equal(result.replacement.allowed, true);
    assert.equal(revenue(result.selected[0]), 10000);
  }
  assert.equal(select({snapshots: [], role: 'manager'}).replacement.allowed, false, 'an RLS-visible population is not necessarily the entire fleet');
  for (const extra of [{mapping_complete: false}, {mapping_status: 'ambiguous'}, {provider_driver_id: null}, {coverage_complete: false}, {agency_rows_total: 2}, {agency_rows_total: null}]) {
    const result = select({snapshots: [], rows: [row(extra)], role: 'manager', agencyId: '1'});
    assert.equal(result.replacement.allowed, false);
    if (extra.mapping_status || extra.provider_driver_id === null) assert.equal(result.reports.length, 0, 'an unconfirmed identity is not exposed to a manager');
    else assert.equal(revenue(result.reports[0]), 10000, 'known subtotal remains separately visible');
  }
});

test('mixed revisions, duplicate identities, invalid money and incomplete row counts never yield a replacement', () => {
  const cases = [
    {rows: [row({snapshot_revision: 2})]},
    {rows: [row(), row()]},
    {rows: [row({amounts: {revenue_minor: 0.5}})]},
    {snapshots: [header({fleet_amounts: {revenue_minor: Number.MAX_SAFE_INTEGER + 1}})]},
    {snapshots: [header({coverage: {complete: true, driver_rows_observed: 2}})]}
  ];
  for (const fixture of cases) assert.equal(select(fixture).replacement.allowed, false);
});

test('known zero and signed corrections survive while a missing direct revenue cannot erase known historical income', () => {
  for (const value of [0, -2500]) {
    const result = select({snapshots: [header({fleet_amounts: {revenue_minor: value}})]});
    assert.equal(result.replacement.allowed, true);
    assert.equal(revenue(result.selected[0]), value);
  }
  const result = select({snapshots: [header({fleet_amounts: {gross_minor: 50000, net_minor: 40000}})], rows: [row({amounts: {revenue_minor: null}})]});
  assert.equal(result.replacement.allowed, false);
  assert.equal(revenue(result.reports[0]), null);
});

test('missing fleet flows use only exhaustive known driver sums, with explicit per-field basis and no mapping requirement', () => {
  const rows = [row({mapping_complete: false, amounts: {revenue_minor: 10000, gross_minor: 15000, net_minor: 8000, commission_minor: 500, fare_minor: 9000, tips_minor: 100, tolls_minor: 200, bonus_minor: 300, cash_minor: 4000, payout_minor: 5000, refunds_expenses_minor: 700, adjustments_minor: 900, start_balance_minor: 6000, end_balance_minor: 9000000}}),
    row({provider_row: 1, mapping_status: 'unmatched', mapping_complete: false, driver_code: null, agency_id: null, fleet_driver_id: null, provider_driver_id: null,
      amounts: {revenue_minor: 2000, gross_minor: 3000, net_minor: 1000, commission_minor: 100, fare_minor: 1800, tips_minor: 20, tolls_minor: 40, bonus_minor: 60, cash_minor: 800, payout_minor: 1000, refunds_expenses_minor: 70, adjustments_minor: 90, start_balance_minor: 2000, end_balance_minor: 8000}})];
  const result = select({snapshots: [header({fleet_amounts: {}, coverage: {complete: true, driver_rows_observed: 2}})], rows});
  const report = result.reports[0], money = report.currencies[0];
  assert.equal(report.coverage.mappingComplete, false);
  assert.equal(result.replacement.allowed, true);
  for (const [field, value] of Object.entries({revenue: 12000, gross: 18000, net: 9000, commission: 600, fare: 10800, tips: 120, tolls: 240, bonus: 360, cash: 4800})) {
    assert.equal(money[field].minor, value);
    assert.equal(money[field].complete, true);
    assert.equal(money[field].known, 2);
    assert.equal(money[field].basis, 'sum_complete_driver_rows');
    assert.equal(report.fieldBasis[field], 'sum_complete_driver_rows');
  }
  for (const field of ['reportedPayout', 'refundsExpenses', 'adjustments', 'startBalance', 'endBalance']) {
    assert.equal(money[field].minor, null);
    assert.equal(report.fieldBasis[field], 'unavailable');
  }
  assert.ok(report.notes.some(note => note.startsWith('Net : somme')));
  assert.deepEqual(report.byDay, []);
});

test('known fleet values including zero remain authoritative over differing driver totals', () => {
  const result = select({snapshots: [header({fleet_amounts: {revenue_minor: 0, gross_minor: 0, net_minor: 9000, cash_minor: 1}})],
    rows: [row({amounts: {revenue_minor: 10000, gross_minor: 15000, net_minor: 8000, cash_minor: 4000}})]});
  const report = result.reports[0], group = report.currencies[0];
  for (const [field, amount] of Object.entries({revenue: 0, gross: 0, net: 9000, cash: 1})) {
    assert.equal(group[field].minor, amount);
    assert.equal(group[field].basis, 'fleet_header');
    assert.equal(report.fieldBasis[field], 'fleet_header');
  }
});

test('partial collections, incomplete counts, missing driver amounts and failed reads never synthesize a fleet total', () => {
  const financialRow = row({amounts: {revenue_minor: 10000, net_minor: 8000}});
  for (const fixture of [
    {snapshots: [header({fleet_amounts: {revenue_minor: 10000}, coverage: {complete: false, driver_rows_observed: 1}})], rows: [financialRow]},
    {snapshots: [header({fleet_amounts: {revenue_minor: 10000}, coverage: {complete: true, driver_rows_observed: 2}})], rows: [financialRow]},
    {rows: [{...financialRow, coverage_complete: false}]},
    {rows: [row({amounts: {revenue_minor: 10000, net_minor: null}})]},
    {snapshots: [header({coverage: {complete: true, driver_rows_observed: 2}})], rows: [financialRow, row({provider_row: 1, amounts: {revenue_minor: 1000, net_minor: null}})]},
    {rows: [financialRow], queryComplete: false},
    {snapshots: [header({coverage: {complete: true, driver_rows_observed: 0}})], rows: []}
  ]) {
    const result = select(fixture), report = result.reports[0];
    assert.equal(report.currencies[0].net.minor, null);
    assert.equal(report.fieldBasis.net, 'unavailable');
  }
  const wrongCurrency = select({rows: [{...financialRow, currency: 'EUR'}]});
  assert.equal(wrongCurrency.reports.length, 0);
  assert.equal(wrongCurrency.replacement.allowed, false);
});

test('driver aggregate fallback preserves explicitly reported zero and negative net without deriving it from cash or payout', () => {
  for (const value of [0, -1200]) {
    const result = select({rows: [row({amounts: {revenue_minor: 10000, net_minor: value, payout_minor: 99999, cash_minor: 88888}})]});
    assert.equal(result.reports[0].currencies[0].net.minor, value);
    assert.equal(result.reports[0].fieldBasis.net, 'sum_complete_driver_rows');
  }
  const missing = select({rows: [row({amounts: {revenue_minor: 10000, payout_minor: 99999, cash_minor: 88888, end_balance_minor: 50000}})]});
  assert.equal(missing.reports[0].currencies[0].net.minor, null);
});

test('Uber reported Net earnings remains a separate provider figure, never net after commission or consolidated income', () => {
  const provider = select({snapshots: [header({fleet_amounts: {revenue_minor: 67000, reported_net_earnings_minor: 31500, payout_minor: 38200}})],
    rows: [row({amounts: {revenue_minor: 67000, reported_net_earnings_minor: 31500, payout_minor: 38200}})]});
  const report = provider.reports[0];
  assert.equal(report.currencies[0].reportedNetEarnings.minor, 31500);
  assert.equal(report.currencies[0].net.minor, null);
  assert.equal(report.byDriver[0].currencies[0].reportedNetEarnings.minor, 31500);
  assert.equal(report.byDriver[0].currencies[0].net.minor, null);
  const combined = combineProviderEarnings({legacyRecords: legacy(), providerResult: provider, period: PERIOD});
  assert.equal(combined.summary.currencies[0].revenue.minor, 72000);
  assert.equal(combined.summary.currencies[0].net.minor, null);
  assert.equal(Object.hasOwn(combined.summary.currencies[0], 'reportedNetEarnings'), false);
  assert.equal(Object.hasOwn(combined.summary.byDriver.find(driver => driver.source === 'uber').currencies[0], 'reportedNetEarnings'), false);
  const noHeader = select({snapshots: [header({fleet_amounts: {revenue_minor: 67000}})], rows: [row({amounts: {revenue_minor: 67000, reported_net_earnings_minor: 31500}})]});
  assert.equal(noHeader.reports[0].currencies[0].reportedNetEarnings.minor, null, 'the reported settlement figure is not synthesized from drivers');
});

test('combines a verified direct Uber window exactly once with private and Bolt income, without inventing daily events', () => {
  const result = combineProviderEarnings({legacyRecords: legacy(), providerResult: select(), period: PERIOD});
  assert.equal(result.summary.currencies[0].revenue.minor, 15000);
  assert.equal(result.summary.records, 2, 'provider aggregate is not a fabricated transaction or trip');
  assert.equal(result.replacement.excludedLegacyRecords, 1);
  assert.equal(result.providerPeriods, 1);
  assert.equal(result.summary.byDay[0].currencies[0].revenue.minor, 5000, 'daily series contains only timestamped/day records, not allocated provider totals');
  assert.deepEqual(result.dailyCoverage.excludedSources, ['uber']);
  assert.equal(Object.hasOwn(result.summary.currencies[0], 'endBalance'), false);
});

test('a scope mismatch, failed read or missing exact window preserves Uber history and keeps provider figures separate', () => {
  for (const request of [
    {providerResult: select({queryComplete: false})},
    {providerResult: select({agencyId: '1'})},
    {providerResult: select({period: {...PERIOD, end: '2026-10-25T04:00:00Z'}})}
  ]) {
    const result = combineProviderEarnings({legacyRecords: legacy(), period: PERIOD, ...request});
    assert.equal(result.replacement.applied, false);
    assert.equal(result.summary.currencies[0].revenue.minor, 104999);
  }
});

test('confirmed currencies, historical conventions and missing net remain distinct after replacement', () => {
  const records = legacy().map(item => item.source === 'bolt' ? {...item, assumedCurrency: true} : item);
  records.push({source: 'private', id: 'eur', day: '2026-10-20', currency: 'EUR', revenueMinor: 7000});
  const result = combineProviderEarnings({legacyRecords: records, providerResult: select(), period: PERIOD});
  const groups = Object.fromEntries(result.summary.currencies.map(group => [group.currency, group]));
  assert.equal(groups.MAD.revenue.minor, 13000);
  assert.equal(groups.MAD_LEGACY.revenue.minor, 2000);
  assert.equal(groups.EUR.revenue.minor, 7000);
  assert.equal(groups.MAD.net.minor, null);
  assert.equal(groups.MAD.net.complete, false);
});

test('a complete MAD snapshot cannot erase EUR, unknown or assumed-currency historical Uber income', () => {
  for (const extra of [{currency: 'EUR'}, {currency: 'UNKNOWN'}, {currency: 'MAD', assumedCurrency: true}]) {
    const records = legacy().map(record => record.source === 'uber' ? {...record, ...extra} : record);
    const combined = combineProviderEarnings({legacyRecords: records, providerResult: select(), period: PERIOD});
    assert.equal(combined.replacement.applied, false);
    assert.equal(combined.replacement.reason, 'legacy_currency_scope_unproven');
    assert.match(combined.replacement.message, /devises/);
    assert.equal(combined.replacement.excludedLegacyRecords, 0);
    assert.equal(combined.providerPeriods, 0);
    assert.equal(combined.summary.bySource.find(group => group.source === 'uber').records, 1);
  }
  const outside = {...legacy()[0], id: 'outside', currency: 'EUR', occurredAt: '2026-10-01T12:00:00Z'};
  assert.equal(combineProviderEarnings({legacyRecords: [...legacy(), outside], providerResult: select(), period: PERIOD}).replacement.applied, true,
    'other periods do not create a false currency mismatch');
});

test('confirmed driver detail survives direct replacement without being added to the independent fleet total', () => {
  const provider = select({snapshots: [header({fleet_amounts: {revenue_minor: 12000}})]});
  const detail = provider.reports[0].byDriver[0];
  assert.equal(detail.driverKey, 'A');
  assert.equal(detail.driverName, 'Synthetic Driver');
  assert.equal(detail.currencies[0].revenue.minor, 10000);
  assert.equal(detail.records, 0);
  assert.equal(detail.granularity, 'provider_period');
  const combined = combineProviderEarnings({legacyRecords: legacy(), providerResult: provider, period: PERIOD});
  assert.equal(combined.summary.currencies[0].revenue.minor, 17000, '12000 fleet + 2000 Bolt + 3000 private; driver detail is not added');
  const uberDriver = combined.summary.byDriver.find(driver => driver.source === 'uber');
  assert.equal(uberDriver.driverKey, 'A');
  assert.equal(uberDriver.currencies[0].revenue.minor, 10000);
  assert.equal(uberDriver.providerPeriods, 1);
});

test('unmapped provider names stay out of driver detail; their aggregate is an explicit admin-only control', () => {
  const unmatched = row({provider_row: 1, provider_driver_id: null, fleet_driver_id: null, driver_code: null, agency_id: null,
    mapping_status: 'unmatched', mapping_complete: false, driver_name: 'Unassociated private provider name', amounts: {revenue_minor: 2000}});
  const rows = [row({mapping_complete: false}), unmatched];
  const admin = select({snapshots: [header({coverage: {complete: true, driver_rows_observed: 2}, fleet_amounts: {revenue_minor: 12000}})], rows});
  assert.equal(admin.reports[0].byDriver.length, 1);
  assert.equal(admin.reports[0].unmatched.records, 1);
  assert.equal(admin.reports[0].unmatched.currencies[0].revenue.minor, 2000);
  assert.ok(!JSON.stringify(admin).includes('Unassociated private provider name'));
  const manager = select({snapshots: [], rows, role: 'manager', agencyId: '1'});
  assert.equal(manager.reports[0].byDriver.length, 1);
  assert.equal(Object.hasOwn(manager.reports[0], 'unmatched'), false);
  assert.ok(!JSON.stringify(manager).includes('Unassociated private provider name'));
  const truncated = select({rows: [row({driver_name: 'Synthetic…', driver_name_complete: false})]});
  assert.equal(truncated.reports[0].byDriver[0].driverName, null);
});

test('driver subtotals from distinct confirmed organizations combine once with currency separation', () => {
  const provider = select({organizationIds: [ORG, OTHER_ORG], snapshots: [header(), header({id: OTHER_ID, organization_id: OTHER_ORG, currency: 'EUR'})],
    rows: [row(), row({snapshot_id: OTHER_ID, organization_id: OTHER_ORG, currency: 'EUR'})]});
  const combined = combineProviderEarnings({legacyRecords: legacy(), providerResult: provider, period: PERIOD});
  const drivers = combined.summary.byDriver.filter(driver => driver.source === 'uber');
  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].providerPeriods, 2);
  assert.deepEqual(drivers[0].currencies.map(group => [group.currency, group.revenue.minor]), [['EUR', 10000], ['MAD', 10000]]);
});

function fakeClient({role = 'manager', agencies = [{id: 1}], snapshots = [header()], rows = [row()], selectedIds, selectionResult, errorTable, errorResult = {error: {message: 'private upstream diagnostic'}, data: null}, before, transform} = {}) {
  let session = {user: {id: 'staff'}, access_token: 'authenticated-user-token'};
  const calls = [], rpcCalls = [], tables = {profiles: [{user_id: 'staff', role}], agencies, provider_earnings_snapshots: snapshots, provider_earnings_rows: rows};
  const client = {calls, rpcCalls, setSession(value) {session = value;}, auth: {getSession: async () => ({data: {session}})}, rpc(name, params) {
    const spec = {table: name, params};
    const query = {abortSignal(signal) {spec.signal = signal; return query;}, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        rpcCalls.push({...spec, token: session?.access_token}); await before?.(spec, client);
        if (spec.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (name === errorTable) return errorResult;
        if (selectionResult) return selectionResult;
        const candidates = role === 'admin' && !params.p_agency_id && !params.p_driver_code ? snapshots : rows;
        const ids = selectedIds ?? [...new Set(candidates.filter(item => item.period_start < params.p_end && item.period_end > params.p_start &&
          (!params.p_organization_ids.length || params.p_organization_ids.includes(item.organization_id)) &&
          (!params.p_agency_id || String(item.agency_id) === params.p_agency_id) && (!params.p_driver_code || item.driver_code === params.p_driver_code))
          .map(item => item.snapshot_id || item.id))];
        return {data: {version: 1, snapshot_ids: ids, selection_complete: true}, error: null};
      }).then(resolve, reject);
    }};
    return query;
  }, from(table) {
    const spec = {table, columns: '', filters: [], order: [], from: 0, to: 999};
    const query = {select(columns) {spec.columns = columns; return query;}, order(key, options) {spec.order.push(key); return query;}, range(from, to) {spec.from = from; spec.to = to; return query;}, abortSignal(signal) {spec.signal = signal; return query;}, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        calls.push({...spec, token: session?.access_token}); await before?.(spec, client);
        if (spec.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (table === errorTable) return errorResult;
        let data = [...(tables[table] || [])];
        for (const [op, key, value] of spec.filters) data = data.filter(row => op === 'eq' ? String(row[key]) === String(value) : op === 'in' ? value.includes(row[key]) : op === 'lt' ? row[key] < value : op === 'gt' ? row[key] > value : false);
        data.sort((a, b) => {for (const key of spec.order) {if (a[key] < b[key]) return -1; if (a[key] > b[key]) return 1;} return 0;});
        data = data.slice(spec.from, spec.to + 1); if (transform) data = transform(spec, data);
        return {data: data.map(row => Object.fromEntries(spec.columns.split(',').map(key => [key, row[key]]))), error: null};
      }).then(resolve, reject);
    }};
    for (const op of ['eq', 'in', 'lt', 'gt']) query[op] = (key, value) => {spec.filters.push([op, key, value]); return query;};
    return query;
  }};
  return client;
}

const request = {period: PERIOD, agencyId: '1', organizationIds: [ORG]};
test('JWT/RLS loader uses fixed columns, exact agency filters, and never asks managers for fleet headers', async () => {
  const client = fakeClient(), result = await createProviderEarningsLoader({supabase: client, now: () => NOW}).load(request);
  assert.equal(result.replacement.allowed, true);
  assert.ok(client.calls.every(call => call.token === 'authenticated-user-token'));
  assert.ok(client.calls.every(call => !call.columns.includes('*') && !call.columns.includes('source_url')));
  assert.equal(client.calls.some(call => call.table === 'provider_earnings_snapshots'), false);
  const financial = client.calls.find(call => call.table === 'provider_earnings_rows');
  assert.deepEqual(financial.order, ['snapshot_id', 'provider_row']);
  assert.ok(financial.filters.some(([op, key, value]) => op === 'eq' && key === 'agency_id' && value === '1'));
  assert.ok(financial.filters.some(([op, key, value]) => op === 'in' && key === 'snapshot_id' && value[0] === ID));
  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].token, 'authenticated-user-token');
  assert.equal(client.rpcCalls[0].table, 'provider_earnings_select_windows');
  assert.deepEqual(client.rpcCalls[0].params, {p_start: PERIOD.start, p_end: PERIOD.end, p_organization_ids: [ORG], p_agency_id: '1', p_driver_code: null});
});

test('reads all pages and rejects drift, truncation and provider table errors instead of replacing with partial totals', async () => {
  const rows = Array.from({length: 1001}, (_, provider_row) => row({provider_row, provider_driver_id: '55555555-5555-4555-8555-' + String(provider_row).padStart(12, '0'), agency_rows_total: 1001, driver_rows_total: 1001, amounts: {revenue_minor: 100}}));
  const client = fakeClient({rows});
  const result = await createProviderEarningsLoader({supabase: client, now: () => NOW}).load(request);
  assert.equal(result.replacement.allowed, true);
  assert.equal(revenue(result.selected[0]), 100100);
  assert.deepEqual(client.calls.filter(call => call.table === 'provider_earnings_rows').map(call => call.from), [0, 1000]);
  for (const [fixture, extra] of [
    [{rows, transform: (spec, page) => spec.table === 'provider_earnings_rows' && spec.from ? [rows[0]] : page}, {}],
    [{rows}, {maxRows: 1000}],
    [{errorTable: 'provider_earnings_rows'}, {}]
  ]) {
    const value = await createProviderEarningsLoader({supabase: fakeClient(fixture), now: () => NOW, ...extra}).load(request);
    assert.equal(value.replacement.allowed, false);
    assert.equal(value.replacement.reason, 'provider_read_failed');
    assert.ok(!JSON.stringify(value).includes('private upstream'));
  }
});

test('large active-period history loads only selected exact and latest windows, including an old exact window', async () => {
  const snapshots = [], rows = [];
  for (let capture = 0; capture < 1001; capture++) {
    const id = '77777777-7777-4777-8777-' + String(capture).padStart(12, '0');
    const period_end = new Date(Date.parse(PERIOD.start) + (capture + 1) * 60000).toISOString();
    snapshots.push(header({id, period_end, coverage: {complete: true, driver_rows_observed: 34}, fleet_amounts: {revenue_minor: 3400}}));
    for (let index = 0; index < 34; index++) rows.push(row({snapshot_id: id, period_end, provider_row: index,
      provider_driver_id: '55555555-5555-4555-8555-' + String(index).padStart(12, '0'), driver_code: 'D' + index,
      agency_rows_total: 34, driver_rows_total: 1, amounts: {revenue_minor: 100}}));
  }
  assert.equal(rows.length, 34034);
  const selectedIds = [snapshots[0].id, snapshots.at(-1).id];
  const period = {...PERIOD, end: snapshots[0].period_end};
  for (const role of ['admin', 'manager']) {
    const client = fakeClient({role, snapshots, rows, selectedIds});
    const result = await createProviderEarningsLoader({supabase: client, now: () => NOW, maxRows: 1000})
      .load({period, organizationIds: [ORG], agencyId: role === 'manager' ? '1' : null});
    assert.equal(result.coverage.queryComplete, true);
    assert.equal(result.replacement.allowed, true);
    assert.equal(result.reports.length, 2);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].id, selectedIds[0]);
    assert.equal(revenue(result.selected[0]), 3400, 'only the exact window enters the total');
    assert.equal(result.reports.reduce((n, report) => n + report.observedDriverRows, 0), 68);
    const reads = client.calls.filter(call => call.table.startsWith('provider_'));
    assert.equal(reads.length, role === 'admin' ? 2 : 1);
    assert.ok(reads.every(call => call.from === 0 && call.filters.some(([op, key, ids]) => op === 'in' &&
      key === (call.table === 'provider_earnings_rows' ? 'snapshot_id' : 'id') && ids.length === 2 && ids.every(id => selectedIds.includes(id)))));
  }
});

test('empty window selection skips financial reads, while missing selected rows fail closed', async () => {
  const empty = fakeClient({selectedIds: []});
  const result = await createProviderEarningsLoader({supabase: empty, now: () => NOW}).load(request);
  assert.equal(result.coverage.queryComplete, true);
  assert.equal(result.replacement.allowed, false);
  assert.deepEqual(result.reports, []);
  assert.equal(empty.calls.some(call => call.table.startsWith('provider_')), false);
  const changed = fakeClient({selectedIds: [ID], rows: []});
  const missing = await createProviderEarningsLoader({supabase: changed, now: () => NOW}).load(request);
  assert.equal(missing.coverage.queryComplete, false);
  assert.equal(missing.replacement.reason, 'provider_read_failed');
});

test('invalid, truncated, unavailable or oversized selectors never fall back to scanning financial history', async () => {
  const ids = Array.from({length: 101}, (_, index) => '77777777-7777-4777-8777-' + String(index).padStart(12, '0'));
  for (const selectionResult of [
    {error: {code: '54000', message: 'private selector diagnostic'}},
    {data: {version: 2, selection_complete: true, snapshot_ids: [ID]}},
    {data: {version: 1, selection_complete: false, snapshot_ids: [ID]}},
    {data: {version: 1, selection_complete: true, snapshot_ids: ids}},
    {data: {version: 1, selection_complete: true, snapshot_ids: [ID, ID]}},
    {data: {version: 1, selection_complete: true, snapshot_ids: ['invalid']}},
    {data: null}
  ]) {
    const client = fakeClient({selectionResult});
    const result = await createProviderEarningsLoader({supabase: client, now: () => NOW}).load(request);
    assert.equal(result.coverage.queryComplete, false);
    assert.equal(result.replacement.allowed, false);
    assert.equal(result.replacement.reason, 'provider_read_failed');
    assert.equal(client.calls.some(call => call.table.startsWith('provider_')), false);
    assert.ok(!JSON.stringify(result).includes('private selector'));
  }
});

test('window selection honors cancellation and session rotation before fetching any amounts', async () => {
  for (const type of ['abort', 'session']) {
    const client = fakeClient({before: (spec, client) => {
      if (spec.table !== 'provider_earnings_select_windows') return;
      if (type === 'abort') throw new DOMException('Cancelled selection', 'AbortError');
      client.setSession({user: {id: 'other'}, access_token: 'rotated-token'});
    }});
    await assert.rejects(createProviderEarningsLoader({supabase: client}).load(request), {name: 'AbortError'});
    assert.equal(client.calls.some(call => call.table.startsWith('provider_')), false);
  }
});

test('viewer access, session changes and explicit cancellation stop the financial read', async () => {
  const viewer = fakeClient({role: 'viewer'});
  await assert.rejects(createProviderEarningsLoader({supabase: viewer}).load(request), error => error.status === 403 && /réservé/.test(error.message));
  assert.equal(viewer.calls.length, 1);
  const switched = fakeClient({before: (spec, client) => {if (spec.table === 'provider_earnings_rows') client.setSession({user: {id: 'other'}, access_token: 'another-token'});}});
  await assert.rejects(createProviderEarningsLoader({supabase: switched}).load(request), error => error.name === 'AbortError');
  const controller = new AbortController(); controller.abort();
  const cancelled = fakeClient();
  await assert.rejects(createProviderEarningsLoader({supabase: cancelled}).load({...request, signal: controller.signal}), error => error.name === 'AbortError');
  assert.equal(cancelled.calls.length, 0);
  const signedOut = fakeClient(); signedOut.setSession(null);
  await assert.rejects(createProviderEarningsLoader({supabase: signedOut}).load(request), error => error.status === 401 && error.code === 'AUTH_REQUIRED');
  assert.equal(signedOut.calls.length, 0);
});

test('server-side authentication and permission revocations are fatal even while the cached session exists', async () => {
  const errors = [
    [401, {status: 401, error: {message: 'private diagnostic'}}],
    [403, {status: 403, error: {message: 'private diagnostic'}}],
    [401, {error: {status: 401, message: 'private diagnostic'}}],
    [403, {error: {status: 403, message: 'private diagnostic'}}],
    ...['PGRST301', 'PGRST302', 'PGRST303'].map(code => [401, {error: {code, message: 'private diagnostic'}}]),
    [403, {error: {code: '42501', message: 'private diagnostic'}}]
  ];
  for (const table of ['profiles', 'provider_earnings_select_windows', 'provider_earnings_rows', 'provider_earnings_snapshots']) for (const [status, errorResult] of errors) {
    const client = fakeClient({role: 'admin', errorTable: table, errorResult});
    const loader = createProviderEarningsLoader({supabase: client, now: () => NOW});
    await assert.rejects(loader.load({...request, agencyId: null}), error => error.status === status &&
      error.code === (status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN') && !error.message.includes('private'));
  }
});

test('a silent role revocation or downgrade invalidates already read fleet amounts before standalone publication', async () => {
  for (const role of ['viewer', 'manager', null]) {
    let revoked = false;
    const client = fakeClient({role: 'admin', transform(spec, rows) {
      if (spec.table === 'provider_earnings_rows') {revoked = true; return [];}
      if (spec.table === 'profiles' && revoked) return role ? [{user_id: 'staff', role}] : [];
      return rows;
    }});
    await assert.rejects(createProviderEarningsLoader({supabase: client, now: () => NOW}).load({...request, agencyId: null}), {status: 403, code: 'FORBIDDEN'});
    assert.equal(client.calls.filter(call => call.table === 'profiles').length, 2);
  }
});

test('removing a manager agency during a successful provider read revokes the standalone result', async () => {
  let revoked = false;
  const client = fakeClient({transform(spec, rows) {
    if (spec.table === 'provider_earnings_rows') revoked = true;
    if (spec.table === 'agencies' && revoked) return [];
    return rows;
  }});
  await assert.rejects(createProviderEarningsLoader({supabase: client, now: () => NOW}).load(request), {status: 403, code: 'FORBIDDEN'});
  assert.equal(client.calls.filter(call => call.table === 'agencies').length, 2);
  const inaccessible = fakeClient({agencies: []});
  await assert.rejects(createProviderEarningsLoader({supabase: inaccessible, now: () => NOW}).load(request), {status: 403, code: 'FORBIDDEN'});
  assert.equal(inaccessible.calls.some(call => call.table.startsWith('provider_')), false);
});

test('a provider read AbortError never becomes a partial-success result', async () => {
  const client = fakeClient({before: spec => {if (spec.table === 'provider_earnings_rows') throw new DOMException('Canceled upstream read', 'AbortError');}});
  await assert.rejects(createProviderEarningsLoader({supabase: client, now: () => NOW}).load(request), error => error.name === 'AbortError');
});

test('a newer filter or a disposed loader prevents an older provider result from being published', async () => {
  let release, entered;
  const reached = new Promise(resolve => {entered = resolve;});
  let hold = true;
  const client = fakeClient({before: async spec => {
    if (spec.table === 'provider_earnings_rows' && hold) {hold = false; entered(); await new Promise(resolve => {release = resolve;});}
  }});
  const loader = createProviderEarningsLoader({supabase: client, now: () => NOW});
  const first = loader.load(request);
  await reached;
  const second = await loader.load({...request, driverCode: 'A'});
  assert.equal(second.replacement.allowed, true);
  release();
  await assert.rejects(first, error => error.name === 'AbortError');
  loader.dispose();
  const calls = client.calls.length;
  await assert.rejects(loader.load(request), error => error.name === 'AbortError');
  assert.equal(client.calls.length, calls);
});

 test('verified breakdown exposes before-tax net and signed taxes with calculation provenance, and rejects tampering',()=>{
 const calculated=calculateUberEarnings({revenue_minor:67000,gross_minor:null,net_minor:null},{complete:true,entries:[{field:'fare',label:'Fare',minor:84700},{field:'commission',label:'Service Fee',minor:-14800},{field:'taxes',label:'Taxes',minor:-2900}]});
 const proven=header({fleet_amounts:calculated.amounts,financial_provenance:calculated.provenance}),result=select({snapshots:[proven]});const group=result.reports[0].currencies[0];assert.equal(group.gross.minor,84700);assert.equal(group.net.minor,69900);assert.equal(group.revenue.minor,67000);assert.equal(group.taxes.minor,-2900);assert.equal(group.net.basis,'calculated_after_uber_fees_before_provider_taxes');assert.match(result.reports[0].notes.join(' '),/avant Taxes Uber/);
 const reordered={...calculated.provenance,entries:calculated.provenance.entries.map(e=>({minor:e.minor,label:e.label,field:e.field}))};assert.equal(select({snapshots:[{...proven,financial_provenance:reordered}]}).reports.length,1);
 const changed=structuredClone(proven);changed.fleet_amounts.net_minor++;assert.equal(select({snapshots:[changed]}).reports.length,0);
 });

test('open-week basis starts at Monday 04 local and requires an observation within the week',()=>{
 const period=getRevenuePeriod({kind:'week',at:'2026-10-22T12:00:00Z'}),start=Date.parse(period.start),end=Date.parse(period.end);
 // Use the pinned Morocco tzdb rather than the host's older Intl rules.
 const local=globalThis.LudyMoroccoTime.moroccoParts(start);
 assert.equal(local.weekday,'Mon');assert.equal(local.hour,4);assert.equal(local.minute,0);
 const capture=(observed,now)=>select({period,now,snapshots:[header({period_start:period.start,period_end:period.end,observed_at:new Date(observed).toISOString()})],
  rows:[row({period_start:period.start,period_end:period.end,observed_at:new Date(observed).toISOString()})]});
 const atStart=capture(start,start);
 assert.equal(atStart.replacement.allowed,true);assert.deepEqual(atStart.basis,{kind:'open_week',periodStart:period.start,periodEnd:period.end,observedAt:period.start,comparisonAllowed:false});
 assert.equal(capture(start-1,start).replacement.allowed,false,'a capture before this week cannot claim its current income');
 assert.equal(capture(end-1,end-1).basis.kind,'open_week');
 assert.equal(capture(end-1,end).replacement.allowed,false,'pagination-complete pre-closing data is not a final closed-week total');
 const closed=capture(end,end);assert.equal(closed.replacement.allowed,true);assert.equal(closed.basis,undefined);
 assert.equal(capture(start-1,start-1).replacement.allowed,false,'future weeks do not use earlier observations');
});

test('week-only composition keeps the legacy cutoff and never distributes the provider observation into a day',()=>{
 const period=getRevenuePeriod({kind:'week',at:'2026-10-22T12:00:00Z'}),observed='2026-10-22T11:55:00.000Z';
 const provider=select({period,now:Date.parse('2026-10-22T12:00:00Z'),snapshots:[header({period_start:period.start,period_end:period.end,observed_at:observed})],rows:[row({period_start:period.start,period_end:period.end,observed_at:observed})]});
 const legacyPeriod={...period,end:'2026-10-22T12:00:00.000Z'};
 const result=combineProviderEarnings({legacyRecords:[...legacy(),{source:'bolt',sourceKind:'bolt_session',id:'future',occurredAt:'2026-10-24T12:00:00Z',currency:'MAD',revenueMinor:900000}],providerResult:provider,period,legacyPeriod});
 assert.equal(result.replacement.applied,true);assert.equal(result.summary.currencies[0].revenue.minor,15000);
 assert.equal(result.summary.providerOpenWeek,true);assert.equal(result.summary.providerObservedAt,observed);
 assert.equal(result.summary.byDay.length,1);assert.equal(result.summary.byDay[0].currencies[0].revenue.minor,5000);
 assert.throws(()=>combineProviderEarnings({legacyRecords:legacy(),providerResult:provider,period:{...period,kind:'custom'},legacyPeriod}),/incompatibles/);
 assert.throws(()=>combineProviderEarnings({legacyRecords:legacy(),providerResult:provider,period,legacyPeriod:{...legacyPeriod,start:'2026-10-20T00:00:00Z'}}),/incompatibles/);
 assert.throws(()=>combineProviderEarnings({legacyRecords:legacy(),providerResult:provider,period,legacyPeriod:{...legacyPeriod,end:'2026-11-01T00:00:00Z'}}),/incompatibles/);
 const atBoundary=combineProviderEarnings({legacyRecords:legacy(),providerResult:provider,period,legacyPeriod:{...period,end:period.start}});
 assert.equal(atBoundary.summary.currencies[0].revenue.minor,10000);assert.equal(atBoundary.summary.byDay.length,0);
});
