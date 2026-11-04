import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTelemetryObservation, appendTelemetryArchive, deriveTelemetryIntervals,
  advanceTelemetryContinuity, reconcileTelemetryIntervals} from '../server/telemetry-continuity.mjs';

const BASE = Date.parse('2026-11-03T12:00:00Z');
const time = seconds => new Date(BASE + seconds * 1000).toISOString();
const common = (id, source, observed = 0, extra = {}) => ({id, vehicleKey: 'car-a', source, sourceId: source + '-device', quality: 'good', observedAt: time(observed), receivedAt: time(observed), ...extra});
const gps = (id, source = 'geotab', observed = 0, extra = {}) => ({...common(id, source, observed), kind: 'gps', latitude: 33.5, longitude: -7.5, accuracyM: 8, ...extra});
const counter = (id, source = 'geotab', observed = 0, value = 100, extra = {}) => ({...common(id, source, observed), kind: 'counter', metric: 'distance_km', counterId: 'odometer', counterMeaning: 'odometer', value, ...extra});
const interval = (id, source, from, to, value, extra = {}) => ({...common(id, source, to), kind: 'interval', metric: 'distance_km', from: time(from), to: time(to), value, method: 'provider_interval', coverage: 'complete', ...extra});
const archive = (rows, at = 10000) => appendTelemetryArchive(null, rows, {at: time(at)});
const reconcile = (rows, extra = {}) => reconcileTelemetryIntervals(rows, {vehicleKey: 'car-a', metric: 'distance_km', from: time(0), to: time(20), at: time(100), ...extra});
const policy = {staleAfterMs: {gps: 10000, network: 10000, distance: 10000, fuel: 10000}, failoverAfterMs: 5000, recoverAfterMs: 10000, recoverySamples: 2};
const advance = (previous, observations, seconds, extra = {}) => advanceTelemetryContinuity(previous, {archive: archive(observations), vehicleKey: 'car-a', now: time(seconds), policy, ...extra});

test('normalization requires explicit times, physical metric semantics and an actual interval', () => {
  assert.equal(normalizeTelemetryObservation(counter('one')).unit, 'km');
  assert.equal(normalizeTelemetryObservation(counter('fuel', 'geotab', 0, 500, {metric: 'fuel_l', counterMeaning: 'fuel_consumed'})).unit, 'L');
  for (const bad of [
    counter('tank', 'texat', 0, 30, {metric: 'fuel_l', counterMeaning: 'tank_level'}),
    counter('missing', 'texat', 0, null),
    counter('naive', 'geotab', 0, 100, {observedAt: '2026-11-03T12:00:00'}),
    counter('impossible', 'geotab', 0, 100, {observedAt: '2026-02-30T12:00:00Z'}),
    interval('zero', 'geotab', 0, 0, 100),
    interval('future', 'geotab', 0, 20, 100, {observedAt: time(10)}),
    interval('gps-fuel', 'texat', 0, 20, 1, {metric: 'fuel_l', method: 'gps_estimate'}),
    gps('bad', 'texat', 0, {latitude: 100})
  ]) assert.throws(() => normalizeTelemetryObservation(bad));
});

test('archive deduplicates replayed observations while retaining conflicting versions and original ingestion dates', () => {
  const first = archive([counter('one')]);
  const replay = appendTelemetryArchive(first, [counter('one', 'geotab', 0, 100, {receivedAt: time(10)})], {at: time(10)});
  assert.equal(replay.records.length, 1);
  assert.equal(replay.records[0].observation.receivedAt, time(0));
  assert.equal(replay.revision, first.revision);
  const revised = appendTelemetryArchive(first, [counter('one', 'geotab', 0, 101, {receivedAt: time(20)})], {at: time(20)});
  assert.equal(revised.records.length, 2);
  assert.equal(revised.conflicts.length, 1);
  assert.equal(first.records.length, 1, 'previous archive stays unchanged');
  assert.equal(revised.audit.length, 2);
});

test('out-of-order delayed counters derive the same chronological intervals without comparing devices or providers', () => {
  const rows = [counter('g0', 'geotab', 0, 100), counter('g1', 'geotab', 10, 104), counter('g2', 'geotab', 20, 110),
    counter('t0', 'texat', 0, 10000), counter('t2', 'texat', 20, 10009),
    counter('other-device', 'geotab', 15, 50000, {sourceId: 'new-device'})];
  const late = [rows[2], rows[0], {...rows[1], receivedAt: time(40)}, ...rows.slice(3)];
  const result = deriveTelemetryIntervals(archive(late));
  assert.deepEqual(result.intervals.map(row => [row.source, row.from, row.to, row.value]).sort(), [
    ['geotab', time(0), time(10), 4], ['geotab', time(10), time(20), 6], ['texat', time(0), time(20), 9]
  ].sort());
  assert.equal(result.intervals.find(row => row.to === time(10)).receivedAt, time(40));
  assert.ok(result.intervals.every(row => row.history.length === 2));
});

test('counter resets and epoch changes create unknown spans instead of negative or bridged consumption', () => {
  const result = deriveTelemetryIntervals(archive([
    counter('a', 'geotab', 0, 100), counter('b', 'geotab', 10, 2), counter('c', 'geotab', 20, 5),
    counter('d', 'geotab', 30, 500, {counterEpoch: 'replacement'}), counter('e', 'geotab', 40, 504, {counterEpoch: 'replacement'})
  ]));
  assert.deepEqual(result.intervals.map(row => row.value), [3, 4]);
  assert.equal(result.issues[0].reason, 'counter_reset');
  assert.ok(!result.intervals.some(row => row.from === time(20) && row.to === time(30)));
});

test('contradictory counter points and invalid observations interrupt the baseline', () => {
  for (const middle of [
    [counter('b', 'geotab', 10, 104), counter('c', 'geotab', 10, 108)],
    [counter('b', 'geotab', 10, 104, {quality: 'invalid'})],
    [counter('b', 'geotab', 10, 104), counter('b', 'geotab', 10, 108)]
  ]) {
    const result = deriveTelemetryIntervals(archive([counter('a', 'geotab', 0, 100), ...middle, counter('d', 'geotab', 20, 110), counter('e', 'geotab', 30, 112)]));
    assert.deepEqual(result.intervals.map(row => [row.from, row.to, row.value]), [[time(20), time(30), 2]]);
    assert.ok(result.issues.some(issue => issue.reason === 'counter_conflict_or_quality'));
  }
});

test('an explicit rate limit rejects an implausible counter jump without inventing a corrected value', () => {
  const result = deriveTelemetryIntervals(archive([counter('a', 'geotab', 0, 100), counter('b', 'geotab', 10, 200), counter('c', 'geotab', 20, 200.1)]), {maxRatePerHour: {distance_km: 200}});
  assert.equal(result.issues[0].reason, 'counter_rate_conflict');
  assert.equal(result.intervals.length, 1);
  assert.ok(Math.abs(result.intervals[0].value - 0.1) < 1e-10);
});

test('GPS, network and fuel freshness are independent; receiving an old sample cannot freshen it', () => {
  const observations = [gps('g', 'geotab', 10), gps('t', 'texat', 10),
    {...common('gn', 'geotab', 10), kind: 'network', connected: false},
    {...common('tn', 'texat', 10), kind: 'network', connected: true},
    counter('gf', 'geotab', 0, 1000, {metric: 'fuel_l', counterMeaning: 'fuel_consumed', receivedAt: time(20)}),
    counter('tf', 'texat', 20, 9000, {metric: 'fuel_l', counterMeaning: 'fuel_consumed'})];
  const result = advance(null, observations, 20);
  assert.equal(result.state.channels.gps.activeSource, 'geotab');
  assert.equal(result.state.channels.network.activeSource, 'texat');
  assert.equal(result.state.channels.fuel.activeSource, 'texat');
  assert.equal(result.state.channels.fuel.primary.reason, 'stale');
});

test('failover waits for hysteresis but never presents a stale primary value as usable', () => {
  const first = advance(null, [gps('g'), gps('t')], 0);
  const second = advance(first.state, [gps('g'), gps('t1', 'texat', 11)], 11);
  assert.equal(second.state.channels.gps.activeSource, 'geotab');
  assert.equal(second.state.channels.gps.usable, false);
  assert.equal(second.state.channels.gps.selected, null);
  assert.equal(second.state.channels.gps.reason, 'failover_pending');
  const third = advance(second.state, [gps('g'), gps('t2', 'texat', 16)], 16);
  assert.equal(third.state.channels.gps.activeSource, 'texat');
  assert.equal(third.state.channels.gps.usable, true);
  assert.ok(third.events.some(event => event.channel === 'gps' && event.from === 'geotab' && event.to === 'texat'));
});

test('return to primary requires a stable interval and distinct measurement timestamps, not duplicate polls', () => {
  let result = advance(null, [gps('t', 'texat', 0)], 0);
  result = advance(result.state, [gps('g1', 'geotab', 1), gps('t1', 'texat', 1)], 1);
  assert.equal(result.state.channels.gps.reason, 'recovery_pending');
  result = advance(result.state, [gps('g1', 'geotab', 1), gps('same-measurement', 'geotab', 1), gps('t2', 'texat', 11)], 11);
  assert.equal(result.state.channels.gps.activeSource, 'texat');
  result = advance(result.state, [gps('g2', 'geotab', 12), gps('t3', 'texat', 12)], 12);
  assert.equal(result.state.channels.gps.activeSource, 'geotab');
  assert.equal(result.state.channels.gps.reason, 'primary_recovered');
});

test('both sources lost means unknown, and a backwards clock cannot alter source history', () => {
  const initial = advance(null, [gps('g'), gps('t')], 0);
  const lost = advance(initial.state, [gps('g'), gps('t')], 30);
  assert.equal(lost.state.channels.gps.usable, false);
  assert.equal(lost.state.channels.gps.selected, null);
  assert.equal(lost.state.channels.gps.reason, 'both_unavailable');
  const backwards = advance(lost.state, [gps('g'), gps('t')], 20);
  assert.equal(backwards.ignored, 'clock_rollback');
  assert.equal(backwards.state, lost.state);
  assert.deepEqual(backwards.events, []);
});

test('poor GPS accuracy, contradictory counters and ambiguous devices do not win a live selection', () => {
  for (const primary of [
    [gps('g', 'geotab', 0, {accuracyM: 500})],
    [gps('g'), gps('second', 'geotab', 0, {sourceId: 'second-device'})],
    [gps('g'), gps('contradictory', 'geotab', 0, {latitude: 34.5})],
    [gps('g'), gps('invalid-fix', 'geotab', 0, {quality: 'invalid'})]
  ]) assert.equal(advance(null, [...primary, gps('t', 'texat')], 0).state.channels.gps.activeSource, 'texat');
  const counters = advance(null, [counter('a'), counter('b', 'geotab', 0, 120), counter('t', 'texat', 0, 900)], 0);
  assert.equal(counters.state.channels.distance.activeSource, 'texat');
  assert.equal(counters.state.channels.distance.primary.reason, 'counter_conflict');
  const scoped = advance(null, [gps('g'), gps('other', 'geotab', 0, {sourceId: 'second-device'})], 0, {sourceIds: {geotab: 'geotab-device'}});
  assert.equal(scoped.state.channels.gps.activeSource, 'geotab');
});

test('reconciliation replaces exact backup coverage with reliable primary coverage and keeps its audit/history', () => {
  const backup = interval('t', 'texat', 0, 20, 9);
  const before = reconcile([backup]);
  assert.equal(before.totals.total, 9);
  const after = reconcile([backup, interval('g1', 'geotab', 0, 10, 4), interval('g2', 'geotab', 10, 20, 6)], {previous: before, at: time(120)});
  assert.equal(after.totals.total, 10);
  assert.equal(after.retained.length, 3);
  assert.deepEqual(after.selected.map(row => row.id), ['g1', 'g2']);
  assert.equal(after.revision, 2);
  assert.equal(after.audit.length, 2);
  assert.deepEqual(after.audit[1].previousSelectedIds, ['t']);
  assert.equal(after.audit[1].previousTotals.total, 9);
  assert.equal(after.audit[1].totals.total, 10);
  assert.ok(after.decisions[0].retainedAlternativeIds.includes('t'));
  assert.equal(before.totals.total, 9, 'the earlier materialized version is unchanged');
  const replay = reconcile([backup, interval('g1', 'geotab', 0, 10, 4), interval('g2', 'geotab', 10, 20, 6)], {previous: after, at: time(130)});
  assert.equal(replay.revision, 2);
  assert.equal(replay.audit.length, 2);
});

test('one primary interval can replace several adjacent backup intervals without double counting endpoints', () => {
  const result = reconcile([interval('t1', 'texat', 0, 10, 4), interval('t2', 'texat', 10, 20, 5), interval('g', 'geotab', 0, 20, 10)]);
  assert.equal(result.totals.total, 10);
  assert.deepEqual(result.selected.map(row => row.id), ['g']);
  assert.equal(result.coverage.complete, true);
});

test('a primary interval covering only part of a complete backup interval cannot silently replace or prorate it', () => {
  const result = reconcile([interval('t', 'texat', 0, 20, 9), interval('g', 'geotab', 0, 10, 6)]);
  assert.equal(result.totals.total, 9);
  assert.deepEqual(result.selected.map(row => row.id), ['t']);
  assert.equal(result.coverage.reconciledToPrimary, false);
  assert.ok(result.issues.some(issue => issue.reason === 'primary_coverage_not_reconciled'));
});

test('partial overlaps without a complete source stay unknown instead of inventing an apportioned remainder', () => {
  const result = reconcile([interval('g', 'geotab', 0, 12, 6), interval('t', 'texat', 8, 20, 7)]);
  assert.equal(result.totals.total, null);
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.gaps, [{from: time(0), to: time(20)}]);
  assert.ok(result.issues.some(issue => issue.reason === 'partial_overlap_not_apportioned'));
});

test('half-open endpoints permit disjoint source intervals, while selection boundaries never prorate a larger interval', () => {
  const adjacent = reconcile([interval('g', 'geotab', 0, 10, 4), interval('t', 'texat', 10, 20, 5)]);
  assert.equal(adjacent.totals.total, 9);
  assert.equal(adjacent.gaps.length, 0);
  const clipped = reconcile([interval('g', 'geotab', -10, 10, 8), interval('t', 'texat', 0, 20, 9)]);
  assert.equal(clipped.totals.total, 9);
  assert.ok(clipped.issues.some(issue => issue.reason === 'boundary_overlap_not_apportioned'));
});

test('contradictory primary interval totals are flagged and cannot overwrite a reliable backup', () => {
  const result = reconcile([interval('g-total', 'geotab', 0, 20, 10), interval('g1', 'geotab', 0, 10, 7), interval('g2', 'geotab', 10, 20, 8), interval('t', 'texat', 0, 20, 9)]);
  assert.equal(result.totals.total, 9);
  assert.ok(result.issues.some(issue => issue.reason === 'contradictory_interval_totals' && issue.source === 'geotab'));
});

test('identical interval replays do not double a total, and GPS estimates never become measured odometer distance', () => {
  const row = interval('g', 'geotab', 0, 20, 10);
  assert.equal(reconcile([row, row]).totals.total, 10);
  const estimated = reconcile([interval('gps', 'texat', 0, 20, 8, {method: 'gps_estimate'})]);
  assert.equal(estimated.totals.total, null);
  assert.equal(estimated.totals.estimatedTotal, 8);
  assert.equal(estimated.selected[0].estimated, true);
  const measured = reconcile([interval('gps', 'geotab', 0, 20, 8, {method: 'gps_estimate'}), interval('t', 'texat', 0, 20, 9)]);
  assert.equal(measured.totals.total, 9, 'a measured backup is preferable to a primary GPS estimate');
});

test('fuel consumed intervals stay independent of distance, and missing coverage is never zero consumption', () => {
  const fuel = interval('fuel', 'texat', 0, 20, 1.5, {metric: 'fuel_l'});
  const result = reconcile([fuel, interval('distance', 'geotab', 0, 20, 10)], {metric: 'fuel_l'});
  assert.equal(result.totals.total, 1.5);
  assert.equal(result.unit, 'L');
  const missing = reconcile([interval('part', 'geotab', 0, 10, 0.5, {metric: 'fuel_l'})], {metric: 'fuel_l'});
  assert.equal(missing.totals.knownMeasuredValue, 0.5);
  assert.equal(missing.totals.total, null);
  assert.deepEqual(missing.gaps, [{from: time(10), to: time(20)}]);
  assert.equal(reconcile([], {metric: 'fuel_l'}).totals.total, null);
});

test('low quality, future ingestion and cross-vehicle intervals cannot complete a reconciliation', () => {
  for (const row of [
    interval('quality', 'geotab', 0, 20, 10, {quality: 'degraded'}),
    interval('partial', 'geotab', 0, 20, 10, {coverage: 'partial'}),
    interval('late', 'geotab', 0, 20, 10, {receivedAt: time(200)}),
    interval('other', 'geotab', 0, 20, 10, {vehicleKey: 'car-b'})
  ]) assert.equal(reconcile([row]).totals.total, null);
});

test('input order does not create spurious reconciliation revisions, and an audit cannot move backwards in time', () => {
  const rows = [interval('g', 'geotab', 0, 20, 10), interval('bad', 'texat', 0, 20, 9, {quality: 'invalid'}), interval('partial', 'texat', -10, 10, 8)];
  const first = reconcile(rows);
  const reordered = reconcile([...rows].reverse(), {previous: first, at: time(110)});
  assert.equal(reordered.revision, first.revision);
  assert.equal(reordered.audit.length, first.audit.length);
  assert.throws(() => reconcile(rows, {previous: first, at: time(90)}), /antérieure/);
});
