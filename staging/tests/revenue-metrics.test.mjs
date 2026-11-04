import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {getRevenuePeriod, revenueDay, revenueInstant, inRevenuePeriod,
  getRevenueComparisonWindow, sumRevenueMinor, compareRevenueMinor, revenueLocalDayPeriod,
  getCustomRevenuePeriod, shiftRevenuePeriod, summarizeRevenue, compareRevenueSummaries} from '../site/revenue-metrics.js';

test('Uber week starts exactly on Monday at 04:00 in Morocco and excludes the next boundary', () => {
  const period = getRevenuePeriod({at: '2026-11-03T12:00:00Z'});
  assert.equal(period.start, '2026-11-02T04:00:00.000Z');
  assert.equal(period.end, '2026-11-09T04:00:00.000Z');
  assert.equal(period.previousStart, '2026-10-26T04:00:00.000Z');
  assert.equal(inRevenuePeriod(period.start, period), true);
  assert.equal(inRevenuePeriod('2026-11-09T03:59:59.999Z', period), true);
  assert.equal(inRevenuePeriod(period.end, period), false);
  assert.equal(getRevenuePeriod({at: '2026-11-02T03:59:59.999Z'}).start, period.previousStart);
  assert.equal(getRevenuePeriod({at: '2026-11-02T04:00:00Z'}).start, period.start);
});

test('Morocco week boundaries follow the shared historical calendar across Ramadan and September changes', () => {
  const february = getRevenuePeriod({at: '2026-02-15T15:00:00Z'});
  assert.equal(february.start, '2026-02-09T03:00:00.000Z');
  assert.equal(february.end, '2026-02-16T04:00:00.000Z');
  assert.equal(february.durationMs, 169 * 3600000);
  const march = getRevenuePeriod({at: '2026-03-22T15:00:00Z'});
  assert.equal(march.start, '2026-03-16T04:00:00.000Z');
  assert.equal(march.end, '2026-03-23T03:00:00.000Z');
  assert.equal(march.durationMs, 167 * 3600000);
  const september = getRevenuePeriod({at: '2026-09-20T15:00:00Z'});
  assert.equal(september.start, '2026-09-14T03:00:00.000Z');
  assert.equal(september.end, '2026-09-21T04:00:00.000Z');
  assert.equal(september.durationMs, 169 * 3600000);
});

test('the Morocco revenue calendar does not depend on the host Intl timezone database', () => {
  const module = new URL('../site/revenue-metrics.js', import.meta.url).href;
  const script = `Intl.DateTimeFormat = function(){throw Error('Host timezone data unavailable');}; const metrics=await import(${JSON.stringify(module)}); console.log(metrics.getRevenuePeriod({at:'2026-11-03T12:00:00Z'}).start);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2026-11-02T04:00:00.000Z');
});

test('Paris week starts at local 04:00 and changes UTC offset across daylight saving', () => {
  const winter = getRevenuePeriod({at: '2026-11-03T12:00:00Z', timeZone: 'Europe/Paris'});
  assert.equal(winter.start, '2026-11-02T03:00:00.000Z');
  const summer = getRevenuePeriod({at: '2026-06-03T12:00:00Z', timeZone: 'Europe/Paris'});
  assert.equal(summer.start, '2026-06-01T02:00:00.000Z');
  const change = getRevenuePeriod({at: '2026-03-29T15:00:00Z', timeZone: 'Europe/Paris'});
  assert.equal(change.start, '2026-03-23T03:00:00.000Z');
  assert.equal(change.end, '2026-03-30T02:00:00.000Z');
  assert.equal(change.durationMs, 167 * 3600000);
});

test('day and month use local midnight and previous calendar boundaries, including leap years', () => {
  const day = getRevenuePeriod({kind: 'day', at: '2026-09-20T15:00:00Z'});
  assert.equal(day.start, '2026-09-19T23:00:00.000Z');
  assert.equal(day.end, '2026-09-21T00:00:00.000Z');
  assert.equal(day.durationMs, 25 * 3600000);
  const month = getRevenuePeriod({kind: 'month', at: '2024-03-01T12:00:00Z', timeZone: 'UTC'});
  assert.equal(month.previousStart, '2024-02-01T00:00:00.000Z');
  assert.equal(month.previousDurationMs, 29 * 86400000);
  assert.equal(month.end, '2024-04-01T00:00:00.000Z');
  const january = getRevenuePeriod({kind: 'month', at: '2027-01-01T00:00:00Z', timeZone: 'UTC'});
  assert.equal(january.previousStart, '2026-12-01T00:00:00.000Z');
});

test('the week boundary can be configured for a source whose statement uses midnight', () => {
  const at = '2026-11-02T02:00:00Z';
  assert.equal(getRevenuePeriod({at, weekStartHour: 0}).start, '2026-11-02T00:00:00.000Z');
  assert.equal(getRevenuePeriod({at}).start, '2026-10-26T04:00:00.000Z');
});

test('daily grouping respects the selected source timezone instead of the device timezone', () => {
  assert.equal(revenueDay('2026-11-02T23:30:00Z'), '2026-11-02');
  assert.equal(revenueDay('2026-11-02T23:30:00Z', {timeZone: 'Europe/Paris'}), '2026-11-03');
  assert.equal(revenueDay('2026-08-02T23:30:00Z'), '2026-08-03');
});

test('timestamps without a timezone, impossible dates and invalid boundaries are rejected', () => {
  for (const value of [null, undefined, '', '2026-11-03', '2026-11-03T12:00:00',
    '2026-02-30T12:00:00Z', '2026-11-03T24:00:00Z', NaN, Infinity, 0.5]) {
    assert.throws(() => revenueInstant(value));
  }
  assert.equal(revenueInstant('2026-11-03T12:00:00+01:00'), Date.parse('2026-11-03T11:00:00Z'));
  assert.throws(() => getRevenuePeriod({at: '2026-11-03T12:00:00Z', timeZone: 'automatic'}));
  assert.throws(() => getRevenuePeriod({at: '2026-11-03T12:00:00Z', weekStartHour: 24}));
  assert.throws(() => inRevenuePeriod('2026-11-03T12:00:00Z', {start: '2026-11-04T00:00:00Z', end: '2026-11-03T00:00:00Z'}));
});

test('in-progress comparisons use the same elapsed duration and expose a shorter preceding period', () => {
  const week = getRevenuePeriod({at: '2026-11-03T12:00:00Z'});
  const window = getRevenueComparisonWindow(week, '2026-11-03T12:00:00Z');
  assert.equal(window.previousEnd, '2026-10-27T12:00:00.000Z');
  assert.equal(window.durationMs, 32 * 3600000);
  assert.equal(window.equalDuration, true);
  const month = getRevenuePeriod({kind: 'month', at: '2024-03-31T12:00:00Z', timeZone: 'UTC'});
  const shortened = getRevenueComparisonWindow(month, '2024-03-31T12:00:00Z');
  assert.equal(shortened.previousEnd, month.previousEnd);
  assert.equal(shortened.equalDuration, false);
  assert.throws(() => getRevenueComparisonWindow(week, '2026-11-10T12:00:00Z'));
});

test('amount sums retain missing coverage, explicit zero and explicit negative adjustments', () => {
  assert.deepEqual(sumRevenueMinor([101, 202, -3, 0]), {minor: 300, known: 4, missing: 0, complete: true});
  assert.deepEqual(sumRevenueMinor([101, null]), {minor: 101, known: 1, missing: 1, complete: false});
  assert.deepEqual(sumRevenueMinor([null]), {minor: null, known: 0, missing: 1, complete: false});
  assert.deepEqual(sumRevenueMinor([]), {minor: null, known: 0, missing: 0, complete: false});
  for (const values of [[undefined], [1.2], ['10'], [Number.MAX_SAFE_INTEGER, 1]]) assert.throws(() => sumRevenueMinor(values));
});

test('comparisons never invent a percentage for a missing or zero baseline', () => {
  assert.deepEqual(compareRevenueMinor(150, 100), {deltaMinor: 50, percent: 50, baselineZero: false});
  assert.deepEqual(compareRevenueMinor(100, 0), {deltaMinor: 100, percent: null, baselineZero: true});
  assert.deepEqual(compareRevenueMinor(null, 100), {deltaMinor: null, percent: null, baselineZero: false});
  assert.deepEqual(compareRevenueMinor(0, 0), {deltaMinor: 0, percent: null, baselineZero: true});
  assert.throws(() => compareRevenueMinor(Number.MAX_SAFE_INTEGER, -1));
});

test('inclusive custom dates become exclusive calendar bounds and shift by the same number of local days', () => {
  const range = getCustomRevenuePeriod({fromDay: '2026-09-19', toDay: '2026-09-20'});
  assert.equal(range.start, '2026-09-18T23:00:00.000Z');
  assert.equal(range.end, '2026-09-21T00:00:00.000Z');
  assert.equal(range.days, 2);
  assert.equal(range.durationMs, 49 * 3600000);
  assert.equal(range.previousStart, '2026-09-16T23:00:00.000Z');
  assert.equal(shiftRevenuePeriod(range, -1).end, range.start);
  assert.equal(shiftRevenuePeriod(range, 1).start, range.end);
  assert.equal(revenueLocalDayPeriod('2026-11-03').start, '2026-11-03T00:00:00.000Z');
  const week = getRevenuePeriod({at: '2026-11-03T12:00:00Z'});
  assert.equal(shiftRevenuePeriod(week, -1).start, week.previousStart);
  assert.equal(shiftRevenuePeriod(week, 1).start, week.end);
  assert.throws(() => getCustomRevenuePeriod({fromDay: '2026-11-04', toDay: '2026-11-03'}));
  assert.throws(() => revenueLocalDayPeriod('2026-02-30'));
});

const PERIOD = Object.freeze({start: '2026-11-02T04:00:00Z', end: '2026-11-09T04:00:00Z', timeZone: 'Africa/Casablanca'});
const financial = (overrides = {}) => ({source: 'uber', sourceKind: 'uber_payment', id: 'payment-1',
  occurredAt: '2026-11-03T12:00:00Z', currency: 'MAD', revenueMinor: 100, driverKey: 'driver-1', driverName: 'Conducteur test', ...overrides});

test('financial statement amounts aggregate by currency, source, day and source-scoped driver without deriving profit', () => {
  const records = [financial(), financial({source: 'bolt', sourceKind: 'bolt_session', revenueMinor: 200, granularity: 'session'}),
    financial({source: 'private', sourceKind: 'private_cash_course', occurredAt: null, day: '2026-11-04', revenueMinor: 150, driverKey: null})].map(Object.freeze);
  const result = summarizeRevenue(Object.freeze(records), PERIOD);
  assert.equal(result.records, 3);
  assert.deepEqual(result.currencies[0].revenue, {minor: 450, known: 3, missing: 0, complete: true});
  for (const field of ['gross', 'net', 'commission', 'reportedPayout']) assert.equal(result.currencies[0][field].minor, null);
  assert.deepEqual(result.bySource.map(group => group.source), ['bolt', 'private', 'uber']);
  assert.deepEqual(result.byDay.map(group => [group.day, group.currencies[0].revenue.minor]), [['2026-11-03', 300], ['2026-11-04', 150]]);
  assert.equal(result.byDriver.length, 3);
  assert.equal(result.byDriver.filter(group => group.driverKey === 'driver-1').length, 2);
  assert.equal(result.coverage.dayOnlyRecords, 1);
  assert.equal(result.coverage.sessionRecords, 1);
  assert.equal(result.coverage.sourceComplete, false);
  assert.equal(result.coverage.complete, false);
});

test('signed adjustments remain financial movements while void rows and ride estimates are excluded', () => {
  const result = summarizeRevenue([
    financial({revenueMinor: 1000, tipsMinor: 50, reportedPayoutMinor: 700}),
    financial({id: 'refund', status: 'refunded', revenueMinor: -250, tipsMinor: -10}),
    financial({id: 'cancelled-movement', status: 'cancelled', revenueMinor: 20}),
    financial({id: 'void', void: true, revenueMinor: 5000}),
    financial({source: 'bolt', sourceKind: 'bolt_ride_estimate', revenueMinor: 9000})
  ], PERIOD);
  assert.equal(result.records, 3);
  assert.equal(result.currencies[0].revenue.minor, 770);
  assert.equal(result.currencies[0].tips.minor, 40);
  assert.equal(result.currencies[0].tips.complete, false);
  assert.equal(result.currencies[0].reportedPayout.minor, 700);
  assert.equal(result.currencies[0].net.minor, null);
  assert.equal(result.counts.void, 1);
  assert.equal(result.counts.estimates, 1);
});

test('exact duplicates count once, conflicting IDs are excluded, and identical IDs from different sources remain distinct', () => {
  const result = summarizeRevenue([
    financial(), financial({driverName: 'Libellé actualisé'}),
    financial({source: 'bolt', sourceKind: 'bolt_session', revenueMinor: 200}),
    financial({id: 'conflict', revenueMinor: 10}), financial({id: 'conflict', revenueMinor: 20})
  ], PERIOD);
  assert.equal(result.records, 2);
  assert.equal(result.currencies[0].revenue.minor, 300);
  assert.equal(result.counts.duplicates, 1);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(result.coverage.selectionComplete, false);
});

test('legacy currency assumptions are separate from reported MAD, and unknown currencies are never added together', () => {
  const result = summarizeRevenue([
    financial(), financial({id: 'legacy', currencyBasis: 'legacy_mad_convention', revenueMinor: 200}),
    financial({id: 'assumed', assumedCurrency: true, revenueMinor: 50}),
    financial({id: 'eur', currency: 'EUR', revenueMinor: 300}),
    financial({id: 'unknown-1', currency: 'UNKNOWN', revenueMinor: 1000}),
    financial({id: 'unknown-2', currency: null, revenueMinor: 5000})
  ], {...PERIOD, sourceComplete: true});
  const buckets = Object.fromEntries(result.currencies.map(row => [row.currency, row]));
  assert.equal(buckets.MAD.revenue.minor, 100);
  assert.equal(buckets.MAD_LEGACY.revenue.minor, 250);
  assert.equal(buckets.MAD_LEGACY.currencyCode, 'MAD');
  assert.equal(buckets.MAD_LEGACY.assumedCurrencyRecords, 2);
  assert.equal(buckets.EUR.revenue.minor, 300);
  assert.equal(buckets.UNKNOWN.revenue.minor, null);
  assert.equal(buckets.UNKNOWN.records, 2);
  assert.equal(result.coverage.unknownCurrencyRecords, 2);
  assert.equal(result.coverage.assumedCurrencyRecords, 2);
  assert.equal(result.coverage.complete, false);
});

test('day-only cash cannot be attributed to either side of a Monday04 boundary without a real timestamp', () => {
  const cash = day => financial({source: 'private', sourceKind: 'private_cash_course', id: day,
    occurredAt: null, day, revenueMinor: 100});
  const result = summarizeRevenue([cash('2026-11-02'), cash('2026-11-03'), cash('2026-11-09'), cash('2026-11-10')], PERIOD);
  assert.equal(result.records, 1);
  assert.equal(result.currencies[0].revenue.minor, 100);
  assert.equal(result.counts.boundaryUncertain, 2);
  assert.equal(result.counts.outside, 1);
  assert.equal(result.coverage.selectionComplete, false);
  assert.equal(result.uncertainDay.records, 2);
  assert.equal(result.uncertainDay.currencies[0].revenue.minor, 200);
  assert.equal(result.uncertainDay.bySource[0].source, 'private');
  assert.deepEqual(result.uncertainDay.byDay.map(row => row.day), ['2026-11-02', '2026-11-09']);
  assert.equal(result.uncertainDay.byDriver[0].driverKey, 'driver-1');
  const day = summarizeRevenue([cash('2026-11-02')], revenueLocalDayPeriod('2026-11-02'));
  assert.equal(day.records, 1);
  assert.equal(day.uncertainDay.records, 0);
});

test('today’s dated cash can be displayed separately without adding it to a live partial-day total', () => {
  const records = [financial({source: 'private', sourceKind: 'private_cash_course',
    occurredAt: null, day: '2026-11-03', revenueMinor: 12500, grossMinor: 12500, assumedCurrency: true})];
  const period = {...revenueLocalDayPeriod('2026-11-03'), end: '2026-11-03T12:00:00Z'};
  const summary = summarizeRevenue(records, period);
  assert.equal(summary.records, 0);
  assert.equal(summary.currencies.length, 0);
  assert.equal(summary.uncertainDay.records, 1);
  assert.equal(summary.uncertainDay.currencies[0].currency, 'MAD_LEGACY');
  assert.equal(summary.uncertainDay.currencies[0].gross.minor, 12500);
  assert.equal(summary.uncertainDay.currencies[0].net.minor, null);
});

test('invalid or missing monetary data is reported and never silently replaced with zero', () => {
  const result = summarizeRevenue([
    financial(), financial({id: 'unknown', revenueMinor: null}), financial({id: 'fraction', revenueMinor: 1.25}),
    financial({id: 'naive', occurredAt: '2026-11-03T12:00:00'}), financial({id: 'outside', occurredAt: PERIOD.end})
  ], PERIOD);
  assert.equal(result.records, 2);
  assert.deepEqual(result.currencies[0].revenue, {minor: 100, known: 1, missing: 1, complete: false});
  assert.equal(result.counts.invalid, 2);
  assert.equal(result.counts.outside, 1);
  assert.equal(result.coverage.missingRevenueRecords, 1);
  assert.throws(() => summarizeRevenue([financial({revenueMinor: Number.MAX_SAFE_INTEGER}), financial({id: 'overflow', revenueMinor: 1})], PERIOD));
});

test('summary comparisons keep currency groups apart and hide changes when coverage or durations differ', () => {
  const current = summarizeRevenue([financial({revenueMinor: 150})], PERIOD);
  const previous = summarizeRevenue([financial({revenueMinor: 100})], PERIOD);
  const comparison = compareRevenueSummaries(current, previous);
  assert.deepEqual(comparison.currencies[0].revenue, {currentMinor: 150, previousMinor: 100,
    deltaMinor: 50, percent: 50, baselineZero: false, comparable: true});
  assert.equal(comparison.currencies[0].net.comparable, false);
  assert.equal(comparison.complete, false);
  assert.equal(compareRevenueSummaries(current, previous, {equalDuration: false}).currencies[0].revenue.percent, null);
  const different = summarizeRevenue([financial({currencyBasis: 'legacy_mad_convention'})], PERIOD);
  assert.equal(compareRevenueSummaries(current, different).currencies.every(row => !row.revenue.comparable), true);
  const invalid = summarizeRevenue([financial(), financial({id: 'invalid', revenueMinor: 1.1})], PERIOD);
  assert.equal(compareRevenueSummaries(current, invalid).currencies[0].revenue.comparable, false);
  const zero = summarizeRevenue([financial({revenueMinor: 0})], PERIOD);
  const change = compareRevenueSummaries(current, zero).currencies[0].revenue;
  assert.equal(change.deltaMinor, 150);
  assert.equal(change.percent, null);
  assert.equal(change.baselineZero, true);
});
