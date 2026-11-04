import test from 'node:test';
import assert from 'node:assert/strict';
import {createRevenueDataLoader} from '../site/revenue-data.js';
import {getCustomRevenuePeriod, getRevenuePeriod} from '../site/revenue-metrics.js';

const PERIOD = getCustomRevenuePeriod({fromDay: '2026-10-20', toDay: '2026-10-20'});
const NOW = Date.parse('2026-10-22T12:00:00Z');
const AT = '2026-10-20T12:00:00Z';
const IMPORTED = '2026-10-21T15:00:00Z';
const USER = 'test-user';
const HEADER = 'Montant vous étant versé : Vos revenus';
function payment(id = 'tx1', extra = {}) {
  return {tx: id, at: AT, imported_at: IMPORTED, agency_id: 1, driver_uuid: 'uber-a', driver_name: 'Chauffeur A',
    revenue: 100, payout: 60, fare: 90, tip: 5, toll: 2, bonus: 3, cash: 40, raw: {[HEADER]: 100, Devise: 'MAD'}, ...extra};
}
function fixtures(extra = {}) {
  return {
    profiles: [{user_id: USER, role: 'manager'}], agencies: [{id: 1, name: 'Casa'}, {id: 2, name: 'Rabat'}],
    drivers: [{code: 'A', name: 'Chauffeur A', agency_id: 1, uber_uuid: 'uber-a'}, {code: 'B', name: 'Chauffeur B', agency_id: 2, uber_uuid: 'uber-b'}],
    uber_payments: [], bolt_sessions: [], cash_moves: [], ...extra
  };
}
function fakeClient(tables, {errors = {}, before = null, transform = null, selectedIds = null} = {}) {
  const calls = [], rpcCalls = [];
  let session = {user: {id: USER}, access_token: 'current-user-token'};
  const client = {
    auth: {getSession: async () => ({data: {session}, error: null})},
    setSession(value) { session = value; }, calls, rpcCalls,
    rpc(name, params) {
      const spec = {table: name, params};
      const query = {abortSignal(signal) {spec.signal = signal; return query;}, then(resolve, reject) {
        return Promise.resolve().then(async () => {
          rpcCalls.push({...spec, token: session?.access_token}); await before?.(spec, client);
          if (spec.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (errors[name]) return {data: null, error: {message: 'private selector diagnostic', ...errors[name]}, status: errors[name]?.status};
          const candidates = tables.profiles[0]?.role === 'admin' && !params.p_agency_id && !params.p_driver_code ? tables.provider_earnings_snapshots || [] : tables.provider_earnings_rows || [];
          const ids = selectedIds ?? [...new Set(candidates.filter(item => item.period_start < params.p_end && item.period_end > params.p_start &&
            (!params.p_organization_ids.length || params.p_organization_ids.includes(item.organization_id)) &&
            (!params.p_agency_id || String(item.agency_id) === params.p_agency_id) && (!params.p_driver_code || item.driver_code === params.p_driver_code))
            .map(item => item.snapshot_id || item.id))];
          return {data: {version: 1, snapshot_ids: ids, selection_complete: true}, error: null};
        }).then(resolve, reject);
      }};
      return query;
    },
    from(table) {
      const spec = {table, columns: null, filters: [], order: [], from: 0, to: 999};
      const query = {
        select(columns) { spec.columns = columns; return query; },
        order(field, options) { spec.order.push([field, options]); return query; },
        range(from, to) { spec.from = from; spec.to = to; return query; },
        abortSignal(signal) { spec.signal = signal; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(async () => {
            calls.push({...spec, identity: session?.user?.id, token: session?.access_token});
            await before?.(spec, client);
            if (spec.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (errors[table]) return {data: null, error: {message: 'provider secret must not surface', ...(typeof errors[table] === 'object' ? errors[table] : {})}, status: errors[table]?.status};
            let rows = [...(tables[table] || [])];
            for (const [op, field, value] of spec.filters) rows = rows.filter(row => {
              if (op === 'eq') return String(row[field]) === String(value);
              if (op === 'is') return value === null ? row[field] == null : row[field] === value;
              if (op === 'gte') return row[field] >= value;
              if (op === 'lte') return row[field] <= value;
              if (op === 'lt') return row[field] < value;
              if (op === 'gt') return row[field] > value;
              if (op === 'in') return value.some(item => String(item) === String(row[field]));
              throw new Error('Unexpected filter');
            });
            rows.sort((a, b) => {
              for (const [field] of spec.order) { if (a[field] < b[field]) return -1; if (a[field] > b[field]) return 1; }
              return 0;
            });
            rows = rows.slice(spec.from, spec.to + 1);
            rows = transform ? transform(spec, rows) : rows;
            return {data: rows.map(row => Object.fromEntries(spec.columns.split(',').map(key => [key, row[key]]))), error: null};
          }).then(resolve, reject);
        }
      };
      for (const op of ['eq', 'gte', 'lte', 'lt', 'gt', 'in', 'is']) query[op] = (field, value) => { spec.filters.push([op, field, value]); return query; };
      return query;
    }
  };
  return client;
}
function loader(client, extra = {}) { return createRevenueDataLoader({supabase: client, now: () => NOW, ...extra}); }
const currency = (result, code = 'MAD') => result.current.currencies.find(row => row.currency === code);

test('reads with the current user client, fixed columns and bounded financial queries', async () => {
  const client = fakeClient(fixtures({uber_payments: [payment()]}));
  const result = await loader(client).load({period: PERIOD, source: 'uber'});
  assert.equal(currency(result).revenue.minor, 10000);
  assert.ok(client.calls.every(call => call.identity === USER && call.token === 'current-user-token'));
  assert.ok(client.calls.every(call => call.columns !== '*' && !call.columns.includes('email')));
  const finance = client.calls.find(call => call.table === 'uber_payments');
  assert.deepEqual(finance.order.map(item => item[0]), ['at', 'tx']);
  assert.ok(finance.filters.some(([op, field]) => op === 'gte' && field === 'at'));
  assert.ok(finance.filters.some(([op, field]) => op === 'lt' && field === 'at'));
  assert.equal(result.sourceStatus[0].lastRecordAt, AT);
  assert.equal(result.sourceStatus[0].lastImportedAt, IMPORTED);
  assert.equal(result.coverage.complete, false);
});

test('paginates more than 1000 records without silently truncating', async () => {
  const records = Array.from({length: 1005}, (_, i) => payment(String(i).padStart(5, '0'), {revenue: 1, raw: {[HEADER]: 1, Devise: 'MAD'}}));
  const client = fakeClient(fixtures({uber_payments: records}));
  const result = await loader(client).load({period: PERIOD, source: 'uber'});
  assert.equal(result.current.records, 1005);
  assert.equal(currency(result).revenue.minor, 100500);
  assert.deepEqual(client.calls.filter(call => call.table === 'uber_payments').map(call => call.from), [0, 1000]);
});

test('pagination drift and limits make the source unavailable, never inflate a total', async () => {
  const records = Array.from({length: 1001}, (_, i) => payment(String(i).padStart(5, '0')));
  const client = fakeClient(fixtures({uber_payments: records}), {transform: (spec, rows) => spec.table === 'uber_payments' && spec.from === 1000 ? [records[0]] : rows});
  const drift = await loader(client).load({period: PERIOD, source: 'uber'});
  assert.equal(drift.current.records, 0);
  assert.equal(drift.sourceStatus[0].status, 'error');
  const limited = await loader(fakeClient(fixtures({uber_payments: records})), {maxRows: 1000}).load({period: PERIOD, source: 'uber'});
  assert.equal(limited.coverage.queryComplete, false);
  assert.equal(limited.current.currencies.length, 0);
});

test('source errors are distinct from an empty source and do not reveal database error details', async () => {
  const result = await loader(fakeClient(fixtures({uber_payments: [payment()]}), {errors: {bolt_sessions: true}})).load({period: PERIOD});
  assert.deepEqual(result.coverage.failedSources, ['bolt']);
  assert.equal(result.sourceStatus.find(row => row.source === 'bolt').status, 'error');
  assert.equal(result.sourceStatus.find(row => row.source === 'private').status, 'no_data');
  assert.equal(currency(result).revenue.minor, 10000);
  assert.ok(!JSON.stringify(result).includes('provider secret'));
});

test('a failed selected source disables comparisons even when another source has both periods', async () => {
  const rows = [payment(), payment('previous', {at: '2026-10-19T12:00:00Z'})];
  const result = await loader(fakeClient(fixtures({uber_payments: rows}), {errors: {bolt_sessions: true}})).load({period: PERIOD});
  assert.equal(currency(result).revenue.minor, 10000);
  assert.equal(result.previous.currencies[0].revenue.minor, 10000);
  assert.equal(result.comparison.available, false);
  assert.match(result.comparison.reason, /source/);
  assert.equal(result.comparison.currencies[0].revenue.comparable, false);
  assert.equal(result.comparison.currencies[0].revenue.deltaMinor, null);
  assert.equal(result.comparison.currencies[0].revenue.percent, null);
});

test('agency and driver filters stay scoped and use only an unambiguous Bolt identity', async () => {
  const client = fakeClient(fixtures({uber_payments: [payment(), payment('other', {agency_id: 2, driver_uuid: 'uber-b'})],
    bolt_sessions: [{key: 'b1', at: AT, agency_id: 1, driver_name: 'A Chauffeur', total: 40, raw: {'Total des paiements|DH': '40'}}],
    cash_moves: [{id: 1, day: '2026-10-20', agency_id: 1, driver_code: 'A', kind: 'course', caisse: 'courses', course_amount: 30, amount: 30, cancelled_at: null}]
  }));
  const result = await loader(client).load({period: PERIOD, agencyId: '1', driverCode: 'A'});
  assert.equal(currency(result).revenue.minor, 14000);
  assert.equal(currency(result, 'MAD_LEGACY').revenue.minor, 3000);
  assert.ok(client.calls.filter(call => ['uber_payments', 'bolt_sessions', 'cash_moves'].includes(call.table)).every(call => call.filters.some(([op, field, value]) => op === 'eq' && field === 'agency_id' && value === '1')));
  assert.ok(client.calls.find(call => call.table === 'uber_payments').filters.some(([, field, value]) => field === 'driver_uuid' && value === 'uber-a'));
  assert.equal(result.drivers.length, 1);
  assert.equal(result.drivers[0].code, 'A');
  assert.equal(result.choices.drivers.length, 1);
  await assert.rejects(loader(client).load({period: PERIOD, agencyId: '1', driverCode: 'B'}), /inaccessible/);
});

test('ambiguous Bolt names cannot be attributed to a selected driver', async () => {
  const tables = fixtures({bolt_sessions: [{key: 'b1', at: AT, agency_id: 1, driver_name: 'Chauffeur A', total: 40}]});
  tables.drivers.push({code: 'C', name: 'Chauffeur A', agency_id: 1});
  const result = await loader(fakeClient(tables)).load({period: PERIOD, source: 'bolt', driverCode: 'A'});
  assert.equal(result.current.records, 0);
  assert.equal(result.sourceStatus[0].unmatchedDrivers, 1);
  assert.equal(result.comparison.available, false);
});

test('separates known currencies, legacy MAD and conflicting currencies without exposing raw data', async () => {
  const records = [
    payment('mad'), payment('eur', {raw: {[HEADER]: '100 EUR', Devise: 'EUR'}}),
    payment('legacy', {raw: {}}), payment('conflict', {raw: {[HEADER]: '100 EUR', Devise: 'MAD', 'Email chauffeur': 'private@example.invalid'}})
  ];
  const result = await loader(fakeClient(fixtures({uber_payments: records}))).load({period: PERIOD, source: 'uber'});
  assert.deepEqual(result.current.currencies.map(row => row.currency), ['EUR', 'MAD', 'MAD_LEGACY', 'UNKNOWN']);
  assert.equal(currency(result, 'UNKNOWN').revenue.minor, null);
  assert.equal(currency(result, 'MAD_LEGACY').assumedCurrencyRecords, 1);
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
  assert.ok(!JSON.stringify(result).includes(HEADER));
});

test('missing legacy cells remain unknown; explicit zero, gross and net are handled separately', async () => {
  const absent = payment('absent', {revenue: 0, payout: 0, fare: 0, tip: 0, toll: 0, bonus: 0, cash: 0, raw: {Devise: 'MAD'}});
  const explicit = payment('explicit', {revenue: 0, raw: {[HEADER]: 0, Devise: 'MAD', 'Revenus bruts': '120,50', 'Revenus nets après commissions': '85,25', Commission: '-20,00'}});
  const result = await loader(fakeClient(fixtures({uber_payments: [absent, explicit]}))).load({period: PERIOD, source: 'uber'});
  const amounts = currency(result);
  assert.deepEqual(amounts.revenue, {minor: 0, known: 1, missing: 1, complete: false});
  assert.equal(amounts.gross.minor, 12050);
  assert.equal(amounts.net.minor, 8525);
  assert.equal(amounts.commission.minor, -2000);
  assert.equal(amounts.reportedPayout.minor, 6000);
  assert.notEqual(amounts.reportedPayout.minor, amounts.net.minor);
});

test('generic Uber Net earnings stays separate from net after commission without changing explicit Bolt net labels', async () => {
  for (const label of ['Net earnings', 'Revenus nets']) {
    const input = payment('settlement', {revenue: 670, payout: 382, raw: {[HEADER]: 670, Devise: 'MAD', [label]: 315}});
    const result = await loader(fakeClient(fixtures({uber_payments: [input]}))).load({period: PERIOD, source: 'uber', includeRecords: true});
    assert.equal(currency(result).revenue.minor, 67000); assert.equal(currency(result).reportedPayout.minor, 38200);
    assert.equal(currency(result).net.minor, null); assert.equal(result.records[0].reportedNetEarningsMinor, 31500);
    assert.equal(Object.hasOwn(currency(result), 'reportedNetEarnings'), false);
  }
  const explicit = payment('explicit-net', {raw: {[HEADER]: 100, Devise: 'MAD', 'Net earnings': 315, 'Net earnings after commission': 85}});
  const uber = await loader(fakeClient(fixtures({uber_payments: [explicit]}))).load({period: PERIOD, source: 'uber', includeRecords: true});
  assert.equal(currency(uber).net.minor, 8500); assert.equal(uber.records[0].reportedNetEarningsMinor, 31500);
  const bolt = await loader(fakeClient(fixtures({bolt_sessions: [{key: 'bolt-net', at: AT, agency_id: 1, driver_name: 'Chauffeur A', total: 100,
    raw: {Devise: 'MAD', 'Total des paiements': 100, 'Revenus nets': 80}}]}))).load({period: PERIOD, source: 'bolt'});
  assert.equal(currency(bolt).net.minor, 8000);
});

test('preserves signed adjustments and never adds components or duplicate API/missions revenue', async () => {
  const client = fakeClient(fixtures({uber_payments: [payment(), payment('adjustment', {revenue: -10, raw: {[HEADER]: -10, Devise: 'MAD'}})]}));
  const result = await loader(client).load({period: PERIOD});
  assert.equal(currency(result).revenue.minor, 9000);
  assert.ok(!client.calls.some(call => ['fleet_rides', 'missions'].includes(call.table)));
});

test('explicit nested service-fee columns are read without matching ambiguous header fragments', async () => {
  const row = payment('fees', {raw: {[HEADER]: 100, Devise: 'MAD',
    'Montant vous étant versé : Vos revenus : Prix de la course : Frais de service': '-15 MAD',
    'Montant inconnu net': 800, 'Commission chauffeur (%)': 10}});
  const result = await loader(fakeClient(fixtures({uber_payments: [row]}))).load({period: PERIOD, source: 'uber'});
  assert.equal(currency(result).commission.minor, -1500);
  assert.equal(currency(result).net.minor, null);
  assert.equal(currency(result).gross.minor, null);
});

test('private gross is the entered TTC course price, while driver prime and remitted cash do not imply net', async () => {
  const row = {id: 1, day: '2026-10-20', agency_id: 1, driver_code: 'A', kind: 'course', caisse: 'courses',
    course_amount: 300, amount: 260, commission_pct: 10, prime: 30, prime_paid: 40, cancelled_at: null};
  const result = await loader(fakeClient(fixtures({cash_moves: [row]}))).load({period: PERIOD, source: 'private'});
  const amounts = currency(result, 'MAD_LEGACY');
  assert.equal(amounts.revenue.minor, 30000);
  assert.equal(amounts.gross.minor, 30000);
  assert.equal(amounts.cash.minor, 26000);
  assert.equal(amounts.net.minor, null);
  assert.equal(amounts.commission.minor, null);
});

test('day-only private entries at a Monday 04:00 boundary remain uncertain and canceled rows are excluded', async () => {
  const period = getRevenuePeriod({kind: 'week', at: '2026-10-22T12:00:00Z'});
  const rows = [19, 20].map(day => ({id: day, day: '2026-10-' + day, agency_id: 1, driver_code: 'A', kind: 'course', caisse: 'courses', course_amount: 20, amount: 20, cancelled_at: null}));
  rows.push({...rows[1], id: 30, cancelled_at: AT});
  const result = await loader(fakeClient(fixtures({cash_moves: rows}))).load({period, source: 'private'});
  assert.equal(result.current.records, 1);
  assert.equal(result.current.counts.boundaryUncertain, 1);
  assert.equal(result.current.coverage.dayOnlyRecords, 1);
  assert.equal(currency(result, 'MAD_LEGACY').revenue.minor, 2000);
  assert.equal(result.sourceStatus[0].lastRecordAt, null);
  assert.equal(result.sourceStatus[0].lastRecordDay, '2026-10-20');
});

test('today’s date-only private revenue remains visible as an unallocated subtotal with its driver', async () => {
  const row = {id: 1, day: '2026-10-20', agency_id: 1, driver_code: 'A', kind: 'course', caisse: 'courses',
    course_amount: 300, amount: 260, cancelled_at: null};
  const result = await loader(fakeClient(fixtures({cash_moves: [row]})), {now: () => Date.parse('2026-10-20T11:00:00Z')})
    .load({period: PERIOD, source: 'private'});
  assert.equal(result.current.records, 0);
  assert.equal(result.current.uncertainDay.records, 1);
  const subtotal = result.current.uncertainDay.currencies.find(group => group.currency === 'MAD_LEGACY');
  assert.equal(subtotal.revenue.minor, 30000);
  assert.equal(subtotal.gross.minor, 30000);
  assert.equal(subtotal.net.minor, null);
  assert.equal(result.drivers[0].code, 'A');
  assert.equal(result.drivers[0].summary.uncertainDay.records, 1);
});

test('compares an active period with the same elapsed portion of the previous period', async () => {
  const now = Date.parse('2026-10-20T11:00:00Z');
  const rows = [payment('current', {at: '2026-10-20T10:00:00Z'}), payment('previous', {at: '2026-10-19T10:00:00Z'}), payment('previous-late', {at: '2026-10-19T20:00:00Z'})];
  const result = await loader(fakeClient(fixtures({uber_payments: rows})), {now: () => now}).load({period: PERIOD, source: 'uber'});
  assert.equal(result.current.records, 1);
  assert.equal(result.previous.records, 1);
  assert.equal(result.comparisonWindow.durationMs, result.comparisonWindow.previousDurationMs);
  assert.equal(result.comparison.currencies[0].revenue.deltaMinor, 0);
});

test('rejects a session change during a paginated read', async () => {
  const client = fakeClient(fixtures({uber_payments: [payment()]}), {before(spec, current) {
    if (spec.table === 'uber_payments') current.setSession({user: {id: 'different-user'}, access_token: 'different-token'});
  }});
  await assert.rejects(loader(client).load({period: PERIOD, source: 'uber'}), {name: 'AbortError'});
});

test('missing or expired authentication is identified so the UI can erase previous financial data', async () => {
  const client = fakeClient(fixtures());
  client.setSession(null);
  await assert.rejects(loader(client).load({period: PERIOD}), {code: 'revenue_auth_required'});
  assert.equal(client.calls.length, 0);
});

test('a newer scope aborts an older load and explicit cancellation prevents stale results', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  let first = true;
  const client = fakeClient(fixtures({uber_payments: [payment()]}), {async before(spec) {
    if (spec.table === 'uber_payments' && first) { first = false; started(); await pending; }
  }});
  const data = loader(client), older = data.load({period: PERIOD, source: 'uber'});
  const rejected = assert.rejects(older, {name: 'AbortError'});
  await reached;
  const newer = await data.load({period: PERIOD, source: 'private'});
  release(); await rejected;
  assert.equal(newer.current.records, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(data.load({period: PERIOD, signal: controller.signal}), {name: 'AbortError'});
  data.dispose();
  await assert.rejects(data.load({period: PERIOD}), {name: 'AbortError'});
});

test('refuses viewers, unsupported source, excessive periods and non-Morocco calendars before finance reads', async () => {
  const client = fakeClient(fixtures({profiles: [{user_id: USER, role: 'viewer'}]}));
  await assert.rejects(loader(client).load({period: PERIOD}), {code: 'revenue_access_denied'});
  assert.ok(!client.calls.some(call => call.table === 'uber_payments'));
  await assert.rejects(loader(client).load({period: PERIOD, source: 'sql'}), /invalide/);
  await assert.rejects(loader(client).load({period: {...PERIOD, timeZone: 'UTC'}}), /Maroc/);
  await assert.rejects(loader(client).load({period: {...PERIOD, previousStart: '2020-01-01T00:00:00Z'}}), /longue/);
});

const EARNINGS_ORG='11111111-1111-4111-8111-111111111111';
const EARNINGS_DRIVER='22222222-2222-4222-8222-222222222222';
const earningsConfig=async()=>({uber:{enabled:true,organization_id:EARNINGS_ORG,time_zone:'Africa/Casablanca'}});
function earningsWindow(previous=false,{revenue=30000,gross=40000,net=25000,start,end,revision=1}={}){
 const id=previous?'44444444-4444-4444-8444-444444444444':'33333333-3333-4333-8333-333333333333';
 const common={source:'uber',organization_id:EARNINGS_ORG,period_start:start??(previous?PERIOD.previousStart:PERIOD.start),period_end:end??(previous?PERIOD.previousEnd:PERIOD.end),time_zone:'Africa/Casablanca',currency:'MAD',observed_at:IMPORTED};
 return {header:{...common,id,revision,received_at:IMPORTED,period_label:'Synthetic exact window',period_mode:'custom',coverage:{complete:true,filtered:false,driver_rows_observed:1,driver_rows_total:1},fleet_amounts:{revenue_minor:revenue,gross_minor:gross,net_minor:net,end_balance_minor:99999999}},
  row:{...common,snapshot_id:id,provider_row:0,snapshot_revision:revision,coverage_complete:true,mapping_complete:true,agency_rows_total:1,driver_rows_total:1,provider_driver_id:EARNINGS_DRIVER,fleet_driver_id:EARNINGS_DRIVER,driver_name:'Chauffeur A',driver_name_complete:true,driver_code:'A',agency_id:1,mapping_status:'confirmed',amounts:{revenue_minor:11111,gross_minor:15000,net_minor:9000}}};
}
function earningsTables({current=earningsWindow(),previous=earningsWindow(true,{revenue:20000,gross:30000,net:15000}),role='admin',extra={}}={}){
 return fixtures({profiles:[{user_id:USER,role}],uber_payments:[payment('current'),payment('previous',{at:'2026-10-19T12:00:00Z',revenue:50,raw:{[HEADER]:50,Devise:'MAD'}})],
  provider_earnings_snapshots:[current?.header,previous?.header].filter(Boolean),provider_earnings_rows:[current?.row,previous?.row].filter(Boolean),...extra});
}

test('exact provider windows replace Uber imports once while retaining Bolt and keeping fleet separate from driver money',async()=>{
 const client=fakeClient(earningsTables({extra:{bolt_sessions:[{key:'bolt-current',at:AT,agency_id:1,driver_name:'Chauffeur A',total:20,raw:{Devise:'MAD'}},{key:'bolt-previous',at:'2026-10-19T12:00:00Z',agency_id:1,driver_name:'Chauffeur A',total:10,raw:{Devise:'MAD'}}]}}));
 const result=await loader(client,{providerConfig:earningsConfig}).load({period:PERIOD});
 assert.equal(result.provider.current.replacement.allowed,true);assert.equal(result.provider.previous.replacement.allowed,true);
 assert.equal(currency(result).revenue.minor,32000);assert.equal(result.previous.currencies[0].revenue.minor,21000);
 assert.equal(currency(result).gross.minor,40000);assert.equal(currency(result).net.minor,25000);
 assert.equal(result.current.bySource.find(s=>s.source==='uber').currencies[0].revenue.minor,30000);
 assert.equal(result.current.byDriver.find(d=>d.source==='uber').currencies[0].revenue.minor,11111,'fleet total is not replaced by or added to a driver subtotal');
 assert.equal(result.current.byDay[0].currencies[0].revenue.minor,2000,'no synthetic daily allocation of a period aggregate');
 assert.equal(result.comparison.available,true);assert.equal(result.comparison.currencies[0].revenue.deltaMinor,11000);
 assert.ok(client.calls.every(call=>call.token==='current-user-token'));
 assert.ok(client.calls.filter(c=>c.table.startsWith('provider_')).every(c=>c.filters.some(([op,key,ids])=>op==='in'&&key==='organization_id'&&ids[0]===EARNINGS_ORG)));
});
test('provider versus CSV bases cannot be compared, even if both return known money',async()=>{
 const result=await loader(fakeClient(earningsTables({previous:null})),{providerConfig:earningsConfig}).load({period:PERIOD,source:'uber'});
 assert.equal(currency(result).revenue.minor,30000);assert.equal(result.previous.currencies[0].revenue.minor,5000);
 assert.equal(result.comparison.available,false);assert.match(result.comparison.reason,/même source/);
 assert.equal(result.comparison.currencies[0].revenue.comparable,false);assert.equal(result.comparison.currencies[0].revenue.deltaMinor,null);
});

test('a provider currency mismatch preserves imports and keeps the source status and comparison on the actual basis',async()=>{
 const tables=earningsTables({previous:null});
 tables.uber_payments=tables.uber_payments.map(row=>row.at===AT?{...row,raw:{[HEADER]:row.revenue,Devise:'EUR'}}:row);
 const result=await loader(fakeClient(tables),{providerConfig:earningsConfig}).load({period:PERIOD,source:'uber'});
 assert.equal(result.provider.current.replacement.allowed,false);
 assert.equal(result.provider.current.replacement.reason,'legacy_currency_scope_unproven');
 assert.equal(result.provider.current.selected.length,0);assert.equal(result.provider.current.reports.length,1);
 assert.equal(currency(result,'EUR').revenue.minor,10000);assert.equal(result.current.currencies.some(group=>group.currency==='MAD'),false);
 assert.equal(result.sourceStatus[0].status,'partial');assert.equal(result.sourceStatus[0].providerPeriods,undefined);
 assert.ok(result.coverage.notes.some(note=>/devises/.test(note)));
});
test('overlapping provider windows remain separate and never prorate or replace daily CSV entries',async()=>{
 const current=earningsWindow(false,{start:'2026-10-19T05:02:00.000Z',end:'2026-10-26T05:02:00.000Z'});
 const result=await loader(fakeClient(earningsTables({current,previous:null})),{providerConfig:earningsConfig}).load({period:PERIOD,source:'uber'});
 assert.equal(result.provider.current.replacement.allowed,false);assert.equal(result.provider.current.reports.length,1);assert.equal(currency(result).revenue.minor,10000);
 assert.equal(result.current.records,1);assert.equal(result.comparison.available,true);
});
test('manager agency selection reads only confirmed provider rows, never fleet headers',async()=>{
 const client=fakeClient(earningsTables({role:'manager'})),result=await loader(client,{providerConfig:earningsConfig}).load({period:PERIOD,source:'uber',agencyId:'1'});
 assert.equal(currency(result).revenue.minor,11111);assert.equal(result.current.bySource[0].granularity,'provider_period');
 assert.equal(client.calls.some(c=>c.table==='provider_earnings_snapshots'),false);
 assert.ok(client.calls.filter(c=>c.table==='provider_earnings_rows').every(c=>c.filters.some(([op,key,value])=>op==='eq'&&key==='agency_id'&&value==='1')));
});
test('an exact provider snapshot is reported as available even when no legacy Uber import exists',async()=>{
 const result=await loader(fakeClient(earningsTables({extra:{uber_payments:[]}})),{providerConfig:earningsConfig}).load({period:PERIOD,source:'uber'});
 const status=result.sourceStatus[0];assert.equal(status.status,'complete');assert.equal(status.providerPeriods,1);
 assert.equal(status.lastProviderObservedAt,new Date(IMPORTED).toISOString());assert.equal(status.lastRecordAt,null);assert.equal(status.lastImportedAt,null);
 assert.equal(status.records,0,'a provider period is not an invented number of trip or transaction rows');
 assert.match(status.note,/ne sont pas additionnés/);assert.equal(currency(result).revenue.minor,30000);
});
test('provider configuration, selection or database failures preserve imports and mark comparisons unavailable',async()=>{
 for(const type of ['configuration','selection','database']){
  const client=fakeClient(earningsTables(),type==='database'?{errors:{provider_earnings_rows:true}}:type==='selection'?{errors:{provider_earnings_select_windows:{code:'54000'}}}:{});
  const providerConfig=type==='configuration'?async()=>{throw Error('private provider credential');}:earningsConfig;
  const result=await loader(client,{providerConfig}).load({period:PERIOD,source:'uber'});
  assert.equal(currency(result).revenue.minor,10000);assert.equal(result.previous.currencies[0].revenue.minor,5000);
  assert.equal(result.coverage.queryComplete,false);assert.equal(result.comparison.available,false);assert.match(result.provider.error,/indisponible/);
  assert.doesNotMatch(JSON.stringify(result),/private provider credential|provider secret must not surface/);
  if(type==='selection')assert.equal(client.calls.some(call=>call.table.startsWith('provider_')),false);
 }
});
test('server-side 401 and 403 revocations remain fatal for configuration, provider reads and imports',async()=>{
 for(const [status,code] of [[401,'revenue_auth_required'],[403,'revenue_access_denied']]){
  await assert.rejects(loader(fakeClient(earningsTables()),{providerConfig:async()=>{throw Object.assign(Error('private detail'),{status});}}).load({period:PERIOD}),{code});
  for(const table of ['provider_earnings_select_windows','provider_earnings_rows','uber_payments']){
   const client=fakeClient(earningsTables(),{errors:{[table]:{status,code:status===401?'PGRST301':'42501'}}});
   await assert.rejects(loader(client,{providerConfig:earningsConfig}).load({period:PERIOD,source:'uber'}),{code});
  }
 }
});
test('role or agency access removed during a successful read invalidates already collected values',async()=>{
 for(const change of ['viewer','manager','agency']){
  const tables=earningsTables({role:change==='agency'?'manager':'admin'});
  const client=fakeClient(tables,{before(spec){if(spec.table==='uber_payments'){if(change==='agency')tables.agencies=tables.agencies.filter(a=>a.id!==1);else tables.profiles=[{user_id:USER,role:change}];}}});
  await assert.rejects(loader(client).load({period:PERIOD,source:'uber'}),{code:'revenue_access_denied'});
 }
});

function weeklyTables({role='admin', extra={}}={}) {
 const period=getRevenuePeriod({kind:'week',at:NOW});
 const current=earningsWindow(false,{start:period.start,end:period.end});
 const previous=earningsWindow(true,{start:period.previousStart,end:period.previousEnd,revenue:20000});
 const tables=earningsTables({current,previous,role,extra:{uber_payments:[payment(),payment('previous',{at:'2026-10-13T12:00:00Z'})],...extra}});
 return {period,tables};
}

test('open week uses complete Monday 04 provider windows while legacy sources keep their real cutoff',async()=>{
 const {period,tables}=weeklyTables({extra:{
  bolt_sessions:[{key:'current',at:AT,agency_id:1,total:20,driver_name:'Chauffeur A',raw:{Devise:'MAD'}},
   {key:'future',at:'2026-10-24T12:00:00Z',agency_id:1,total:999,raw:{Devise:'MAD'}},
   {key:'previous',at:'2026-10-13T12:00:00Z',agency_id:1,total:10,raw:{Devise:'MAD'}},
   {key:'previous-later',at:'2026-10-17T12:00:00Z',agency_id:1,total:999,raw:{Devise:'MAD'}}],
  cash_moves:[{id:1,day:'2026-10-20',agency_id:1,kind:'course',caisse:'courses',course_amount:10,cancelled_at:null,driver_code:'A'}]
 }});
 const client=fakeClient(tables),result=await loader(client,{providerConfig:earningsConfig}).load({period});
 assert.equal(result.provider.current.replacement.allowed,true);assert.equal(result.provider.previous.replacement.allowed,true);
 assert.deepEqual(result.provider.current.basis,{kind:'open_week',periodStart:period.start,periodEnd:period.end,observedAt:new Date(IMPORTED).toISOString(),comparisonAllowed:false});
 assert.equal(result.current.providerOpenWeek,true);assert.equal(result.current.providerObservedAt,new Date(IMPORTED).toISOString());
 assert.equal(currency(result).revenue.minor,32000,'confirmed MAD contains only Uber and the already occurred Bolt record');
 assert.equal(currency(result,'MAD_LEGACY').revenue.minor,1000,'date-only private currency convention remains separate');
 assert.equal(result.previous.currencies.find(group=>group.currency==='MAD').revenue.minor,21000);
 assert.ok(result.current.byDay.every(day=>day.currencies.every(group=>group.revenue.minor<30000)),'no provider total is assigned to a synthetic day');
 assert.equal(result.comparison.available,false);assert.equal(result.comparison.equalDuration,false);assert.match(result.comparison.reason,/semaine entière/);
 for(const group of result.comparison.currencies)assert.equal(group.revenue.comparable,false);
 assert.equal(result.comparison.currencies.find(group=>group.currency==='MAD').revenue.deltaMinor,null);
 assert.deepEqual(client.rpcCalls.map(call=>[call.params.p_start,call.params.p_end]).sort(),[[period.start,period.end],[period.previousStart,period.previousEnd]].sort());
 assert.ok(client.calls.filter(call=>['uber_payments','bolt_sessions'].includes(call.table)).every(call=>call.filters.some(([op,key,value])=>op==='lt'&&key==='at'&&value===new Date(NOW).toISOString())));
 assert.equal(result.comparisonWindow.end,new Date(NOW).toISOString());
 assert.match(result.sourceStatus.find(item=>item.source==='uber').note,/semaine ouverte/);
});

test('open-week replacement retains manager, driver, currency and completeness proofs',async()=>{
 for(const scenario of ['manager-agency','manager-driver','manager-unscoped','incomplete-mapping','uncovered-currency','wrong-boundary']){
  const {period,tables}=weeklyTables({role:scenario.startsWith('manager')||scenario==='incomplete-mapping'?'manager':'admin'});
  const agencyId=scenario==='manager-agency'||scenario==='manager-driver'||scenario==='incomplete-mapping'?'1':null;
  const driverCode=scenario==='manager-driver'?'A':null;
  if(scenario==='incomplete-mapping')for(const row of tables.provider_earnings_rows)row.mapping_complete=false;
  if(scenario==='uncovered-currency')tables.uber_payments[0].raw.Devise='EUR';
  if(scenario==='wrong-boundary')for(const row of [...tables.provider_earnings_rows,...tables.provider_earnings_snapshots])row.period_start=new Date(Date.parse(row.period_start)+60000).toISOString();
  const client=fakeClient(tables),result=await loader(client,{providerConfig:earningsConfig}).load({period,source:'uber',agencyId,driverCode});
  const replaces=['manager-agency','manager-driver'].includes(scenario);
  assert.equal(result.provider.current.replacement.allowed,replaces,scenario);
  assert.equal(result.current.providerOpenWeek===true,replaces,scenario);
  if(replaces){assert.equal(currency(result).revenue.minor,11111);assert.equal(result.comparison.available,false);}
  else assert.equal(currency(result,scenario==='uncovered-currency'?'EUR':'MAD').revenue.minor,10000,scenario);
  if(tables.profiles[0].role==='manager')assert.equal(client.calls.some(call=>call.table==='provider_earnings_snapshots'),false);
  if(driverCode)assert.ok(client.calls.filter(call=>call.table==='provider_earnings_rows').every(call=>call.filters.some(([op,key,value])=>op==='eq'&&key==='driver_code'&&value==='A')));
 }
});

test('day, month and custom views never widen their live request to the provider week',async()=>{
 const {tables}=weeklyTables();tables.uber_payments=[payment('today',{at:'2026-10-22T11:00:00Z'})];
 for(const period of [getRevenuePeriod({kind:'day',at:NOW}),getRevenuePeriod({kind:'month',at:NOW}),getCustomRevenuePeriod({fromDay:'2026-10-19',toDay:'2026-10-25'})]){
  const client=fakeClient(tables),result=await loader(client,{providerConfig:earningsConfig}).load({period,source:'uber'});
  assert.equal(result.provider.current.replacement.allowed,false,period.kind);assert.equal(result.current.providerOpenWeek,undefined);
  assert.equal(currency(result).revenue.minor,10000);assert.equal(client.rpcCalls[0].params.p_end,new Date(NOW).toISOString());
 }
 const malformed=getRevenuePeriod({kind:'week',at:NOW,weekStartHour:5});
 await assert.rejects(loader(fakeClient(tables),{providerConfig:earningsConfig}).load({period:malformed}),/lundi à 04/);
});

test('an open-week provider read failure keeps legacy money and does not publish an open-week total',async()=>{
 const {period,tables}=weeklyTables();
 const result=await loader(fakeClient(tables,{errors:{provider_earnings_select_windows:{code:'54000'}}}),{providerConfig:earningsConfig}).load({period,source:'uber'});
 assert.equal(currency(result).revenue.minor,10000);assert.equal(result.current.providerOpenWeek,undefined);
 assert.equal(result.comparison.available,false);assert.equal(result.coverage.queryComplete,false);
});
