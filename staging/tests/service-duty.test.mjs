import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceDuty } from '../server/service-duty.mjs';

const NOW = Date.parse('2026-10-31T10:00:00Z');
const iso = time => new Date(time).toISOString();
function fixture({ now = NOW, start = now - 3600000, mode = 'contract' } = {}) {
  return {
    now, mode,
    drivers: [{ id: 'driver-a', name: 'Synthetic Person', ludy_driver_code: 'LUDY-A', agency_id: 1 }],
    vehicles: [{ key: 'CAR-A', plate: 'SYNTHETIC-001', agency_id: 1, active: 'OUI' }],
    sources: [{ id: 'myclicar', status: 'healthy', last_success_at: iso(now), stale_after_s: 300 }],
    contracts: [{ external_id: 'CONTRACT-A', num: '000001', client_code: 'LUDY-A', vehicle_key: 'CAR-A',
      vehicle_candidates: ['CAR-A'], current: true, eligible: true, status: 'IN_PROGRESS', deleted: false,
      effective_start_at: iso(start), start_at: iso(start), end_at: null, observed_at: iso(now) }],
    contractOverrides: [], params: [{ key: 'shiftDay', value: '7' }, { key: 'shiftNight', value: '19' },
      { key: 'shiftAdvance', value: '2' }]
  };
}
const override = contract => ({ contract_id: contract.external_id, client_code: contract.client_code,
  vehicle_key: contract.vehicle_key, effective_start_at: contract.effective_start_at });
function noDuty(input, reason) {
  const result = serviceDuty(input);
  assert.equal(result.duties.length, 0);
  if (reason) assert.equal(result.coverage.excluded_by_reason[reason], input.contracts.length);
  return result;
}

test('a fresh exact current contract establishes duty until actual return independently of vehicle leases', () => {
  const input = fixture();
  Object.assign(input.drivers[0], { vehicle_key: 'AN-OLD-VEHICLE', vehicle_link_method: 'manual',
    vehicle_link_evidence: {}, auto_link_disabled: true });
  const before = structuredClone(input), result = serviceDuty(input), duty = result.duties[0];
  assert.deepEqual(input, before, 'the pure calculation cannot change identity, assignment or contract data');
  assert.equal(result.duties.length, 1);
  assert.equal(duty.driver_id, 'driver-a');
  assert.equal(duty.ludy_driver_code, 'LUDY-A');
  assert.equal(duty.vehicle_key, 'CAR-A');
  assert.equal(duty.contract_id, 'CONTRACT-A');
  assert.equal(duty.started_at, input.contracts[0].effective_start_at);
  assert.equal(duty.ends_at, null);
  assert.match(duty.contract_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(duty.duty_key, /^[a-f0-9]{64}$/);
  assert.equal(result.coverage.source_fresh, true);
  assert.equal(result.coverage.expected_drivers, 1);
  assert.deepEqual(result.warnings, []);
});

test('contract mode is not limited to nominal shifts and ends only on actual contract closure', () => {
  const input = fixture({ now: Date.parse('2026-11-02T21:00:00Z'), start: Date.parse('2026-10-31T06:00:00Z') });
  assert.equal(serviceDuty(input).duties.length, 1, 'a confirmed open contract remains the explicit service rule');
  for (const change of [
    f => { f.contracts[0].end_at = iso(f.now); },
    f => { f.contracts[0].status = 'CLOSED'; },
    f => { f.contracts[0].current = false; },
    f => { f.contracts[0].deleted = true; }
  ]) { const f = structuredClone(input); change(f); noDuty(f, 'not_current'); }
});

test('a scheduled departure without an effective handover does not establish service', () => {
  const input = fixture(); input.contracts[0].effective_start_at = null;
  noDuty(input, 'invalid_contract');
  input.contracts[0].effective_start_at = iso(NOW + 60000);
  noDuty(input, 'not_started');
});

test('a contract requires exact unambiguous profile and vehicle references, never a matching name', () => {
  const cases = [
    ['unknown_driver', f => { f.drivers[0].ludy_driver_code = 'OTHER'; }],
    ['unknown_driver', f => { f.drivers[0].id = ''; }],
    ['ambiguous_driver', f => { f.drivers.push({ ...f.drivers[0], id: 'other-profile' }); }],
    ['unknown_vehicle', f => { f.contracts[0].vehicle_key = null; }],
    ['unknown_vehicle', f => { f.vehicles = []; }],
    ['ambiguous_vehicle', f => { f.vehicles.push({ ...f.vehicles[0] }); }],
    ['inactive_vehicle', f => { f.vehicles[0].active = 'NON'; }],
    ['missing_agency', f => { f.drivers[0].agency_id = null; }],
    ['missing_agency', f => { f.vehicles[0].agency_id = null; }],
    ['agency_mismatch', f => { f.vehicles[0].agency_id = 2; }]
  ];
  for (const [reason, change] of cases) {
    const input = fixture(); change(input);
    const result = noDuty(input, reason);
    assert.ok(result.warnings.some(warning => warning.code === reason && warning.count === 1));
  }
  const strings = fixture(); strings.drivers[0].agency_id = '1';
  assert.equal(serviceDuty(strings).duties.length, 1);
});

test('multiple current contracts for the same person or car do not produce duty from an arbitrary winner', () => {
  for (const sameDriver of [true, false]) {
    const input = fixture();
    input.drivers.push({ id: 'driver-b', ludy_driver_code: 'LUDY-B', agency_id: 1 });
    input.vehicles.push({ key: 'CAR-B', plate: 'SYNTHETIC-002', active: 'OUI', agency_id: 1 });
    input.contracts.push({ ...input.contracts[0], external_id: 'CONTRACT-B', num: '000002',
      client_code: sameDriver ? 'LUDY-A' : 'LUDY-B', vehicle_key: sameDriver ? 'CAR-B' : 'CAR-A',
      vehicle_candidates: [sameDriver ? 'CAR-B' : 'CAR-A'] });
    noDuty(input, 'contract_conflict');
  }
  const input = fixture(); input.contracts[0].eligible = false;
  noDuty(input, 'contract_conflict');
});

test('handover overrides survive contract refresh and ignore display metadata but not a new assignment fingerprint', () => {
  const initial = fixture(); initial.contractOverrides.push(override(initial.contracts[0]));
  let result = noDuty(initial, 'contract_overridden');
  assert.equal(result.coverage.contracts_overridden, 1);
  initial.contracts[0].num = 'CORRECTED-NUMBER';
  initial.contracts[0].observed_at = iso(NOW + 1000);
  initial.contractOverrides[0].effective_start_at = initial.contractOverrides[0].effective_start_at.replace('Z', '+00:00');
  noDuty(initial, 'contract_overridden');
  for (const change of [
    f => { f.contracts[0].external_id = 'NEW-CONTRACT'; },
    f => { f.contracts[0].effective_start_at = iso(NOW - 1800000); },
    f => { f.contracts[0].client_code = 'NEW-CODE'; f.drivers[0].ludy_driver_code = 'NEW-CODE'; },
    f => { f.contracts[0].vehicle_key = 'NEW-CAR'; f.contracts[0].vehicle_candidates = ['NEW-CAR']; f.vehicles[0].key = 'NEW-CAR'; }
  ]) { const input = structuredClone(initial); change(input); assert.equal(serviceDuty(input).duties.length, 1); }
});

test('source freshness is mandatory, source timestamps cannot be future, and the maximum age remains five minutes', () => {
  for (const change of [
    f => { f.sources = []; },
    f => { f.sources.push({ ...f.sources[0] }); },
    f => { f.sources[0].status = 'paused'; },
    f => { f.sources[0].status = 'error'; },
    f => { f.sources[0].last_success_at = null; },
    f => { f.sources[0].last_success_at = iso(NOW + 5001); },
    f => { f.sources[0].last_success_at = iso(NOW - 300001); },
    f => { f.sources[0].stale_after_s = 3600; f.sources[0].last_success_at = iso(NOW - 300001); },
    f => { f.sources[0].stale_after_s = 45; f.sources[0].last_success_at = iso(NOW - 46000); },
    f => { f.sources[0].stale_after_s = 0; },
    f => { f.sources[0].stale_after_s = Infinity; }
  ]) { const input = fixture(); change(input); noDuty(input, 'source_unavailable'); }
  const tolerance = fixture(); tolerance.sources[0].last_success_at = iso(NOW + 5000);
  assert.equal(serviceDuty(tolerance).duties.length, 1);
});

test('fresh source health cannot renew an old contract snapshot or an invalid date', () => {
  for (const change of [
    f => { f.contracts[0].observed_at = iso(NOW - 300001); },
    f => { f.sources[0].stale_after_s = 3600; f.contracts[0].observed_at = iso(NOW - 300001); },
    f => { f.sources[0].stale_after_s = 45; f.contracts[0].observed_at = iso(NOW - 46000); }
  ]) { const input = fixture(); change(input); noDuty(input, 'stale_contract'); }
  for (const change of [
    f => { f.contracts[0].observed_at = iso(NOW + 5001); },
    f => { f.contracts[0].observed_at = 'invalid'; },
    f => { f.contracts[0].effective_start_at = 'invalid'; },
    f => { f.contracts[0].client_code = ''; },
    f => { f.contracts[0].external_id = ''; }
  ]) { const input = fixture(); change(input); noDuty(input, 'invalid_contract'); }
});

test('duty identifiers stay stable across refreshed snapshots and different timestamp serialization', () => {
  const input = fixture(), first = serviceDuty(input).duties[0];
  input.now += 2000;
  input.sources[0].last_success_at = iso(input.now);
  input.contracts[0].observed_at = iso(input.now);
  input.contracts[0].num = 'RENAMED';
  input.contracts[0].effective_start_at = input.contracts[0].effective_start_at.replace('Z', '+00:00');
  const next = serviceDuty(input).duties[0];
  assert.equal(next.contract_fingerprint, first.contract_fingerprint);
  assert.equal(next.duty_key, first.duty_key);
  input.contracts[0].effective_start_at = iso(NOW - 30000);
  assert.notEqual(serviceDuty(input).duties[0].duty_key, first.duty_key);
});

test('shift mode classifies early departure without starting duty before either handover or nominal shift', () => {
  const early = fixture({ mode: 'shift', now: Date.parse('2026-10-31T06:00:00Z'), start: Date.parse('2026-10-31T05:00:00Z') });
  noDuty(early, 'outside_shift'); // 06:00 in Morocco; nominal day begins at 07:00.
  early.now = Date.parse('2026-10-31T07:00:00Z');
  early.sources[0].last_success_at = iso(early.now); early.contracts[0].observed_at = iso(early.now);
  const day = serviceDuty(early).duties[0];
  assert.equal(day.started_at, '2026-10-31T07:00:00.000Z');
  assert.equal(day.ends_at, '2026-10-31T19:00:00.000Z');
  assert.equal(day.evidence.shift, 'Jour');
  const late = fixture({ mode: 'shift', now: Date.parse('2026-10-31T22:00:00Z'), start: Date.parse('2026-10-31T21:00:00Z') });
  const night = serviceDuty(late).duties[0];
  assert.equal(night.started_at, '2026-10-31T21:00:00.000Z');
  assert.equal(night.ends_at, '2026-11-01T07:00:00.000Z');
  assert.equal(night.evidence.shift, 'Nuit');
});

test('night service belongs to the preceding date after midnight and stops exactly at shift end', () => {
  const input = fixture({ mode: 'shift', now: Date.parse('2026-10-31T05:00:00Z'), start: Date.parse('2026-10-31T02:00:00Z') });
  const duty = serviceDuty(input).duties[0];
  assert.equal(duty.evidence.shift_day, '2026-10-30');
  assert.equal(duty.ends_at, '2026-10-31T07:00:00.000Z');
  for (const now of ['2026-10-31T07:00:00Z', '2026-11-01T05:00:00Z']) {
    input.now = Date.parse(now); input.sources[0].last_success_at = now; input.contracts[0].observed_at = now;
    noDuty(input, 'outside_shift');
  }
});

test('shiftAdvance only changes contract classification, never the configured shift boundaries', () => {
  const input = fixture({ mode: 'shift', now: Date.parse('2026-10-31T19:30:00Z'), start: Date.parse('2026-10-31T17:30:00Z') });
  const duty = serviceDuty(input).duties[0];
  assert.equal(duty.evidence.shift, 'Nuit');
  assert.equal(duty.started_at, '2026-10-31T19:00:00.000Z');
  assert.equal(duty.ends_at, '2026-11-01T07:00:00.000Z');
  input.params = { shiftDay: '7', shiftNight: '19', shiftAdvance: '0' };
  noDuty(input, 'outside_shift');
});

test('configured hour/minute boundaries and reversed day/night intervals are handled without browser or database timezone', () => {
  const input = fixture({ mode: 'shift', now: Date.parse('2026-10-31T10:00:00Z'), start: Date.parse('2026-10-31T08:45:00Z') });
  input.params = { shiftDay: '8.5', shiftNight: '20.5', shiftAdvance: '0' };
  let duty = serviceDuty(input).duties[0];
  assert.equal(duty.started_at, '2026-10-31T08:45:00.000Z');
  assert.equal(duty.ends_at, '2026-10-31T20:30:00.000Z');
  input.params = { shiftDay: '19', shiftNight: '7', shiftAdvance: '0' };
  input.now = Date.parse('2026-11-01T02:00:00Z'); input.contracts[0].effective_start_at = '2026-10-31T21:00:00Z';
  input.contracts[0].observed_at = iso(input.now); input.sources[0].last_success_at = iso(input.now);
  duty = serviceDuty(input).duties[0];
  assert.equal(duty.evidence.shift, 'Jour'); assert.equal(duty.evidence.shift_day, '2026-10-31');
  assert.equal(duty.ends_at, '2026-11-01T07:00:00.000Z');
});

test('Moroccan time changes produce real local shift boundaries instead of a fixed twelve-hour duration', () => {
  for (const [now, start, end] of [
    ['2026-02-15T05:00:00Z', '2026-02-14T19:00:00Z', '2026-02-15T07:00:00.000Z'],
    ['2026-03-22T04:00:00Z', '2026-03-21T20:00:00Z', '2026-03-22T06:00:00.000Z']
  ]) {
    const input = fixture({ mode: 'shift', now: Date.parse(now), start: Date.parse(start) });
    assert.equal(serviceDuty(input).duties[0].ends_at, end);
  }
});

test('ambiguous or nonexistent local shift boundaries refuse inferred duty', () => {
  const ambiguous = fixture({ mode: 'shift', now: Date.parse('2026-02-15T01:00:00Z'), start: Date.parse('2026-02-14T20:00:00Z') });
  ambiguous.params = { shiftDay: '2.5', shiftNight: '19', shiftAdvance: '0' };
  noDuty(ambiguous, 'invalid_shift_boundary');
  const nonexistent = fixture({ mode: 'shift', now: Date.parse('2026-03-22T01:00:00Z'), start: Date.parse('2026-03-21T20:00:00Z') });
  nonexistent.params = { shiftDay: '2.5', shiftNight: '19', shiftAdvance: '0' };
  noDuty(nonexistent, 'invalid_shift_boundary');
});

test('invalid settings fail closed only in shift mode; contract mode does not invent a schedule', () => {
  for (const params of [
    { shiftDay: '', shiftNight: '19' }, { shiftDay: '7', shiftNight: '7' },
    { shiftDay: -1 }, { shiftDay: 24 }, { shiftAdvance: 'invalid' }, { shiftAdvance: -2 },
    [{ key: 'shiftDay', value: '7' }, { key: 'shiftDay', value: '8' }]
  ]) {
    const input = fixture({ mode: 'shift' }); input.params = params;
    noDuty(input, 'invalid_shift_settings');
    input.mode = 'contract'; assert.equal(serviceDuty(input).duties.length, 1);
  }
  const defaultParams = fixture({ mode: 'shift' }); defaultParams.params = {};
  assert.equal(serviceDuty(defaultParams).duties.length, 1);
});

test('invalid modes/time and an unavailable source return explicit diagnostic warnings', () => {
  let input = fixture(); input.mode = 'invented'; noDuty(input, 'invalid_mode');
  input = fixture(); input.now = NaN; noDuty(input, 'invalid_time');
  const empty = serviceDuty();
  assert.deepEqual(empty.duties, []); assert.equal(empty.coverage.excluded_contracts, 0);
  assert.equal(empty.warnings.length, 1); assert.equal(empty.warnings[0].code, 'source_unavailable');
  input = fixture(); input.contracts = [];
  assert.deepEqual(serviceDuty(input).warnings, []);
});
