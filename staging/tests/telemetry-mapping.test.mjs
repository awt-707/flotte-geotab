import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTelemetryMapping, resolveTelemetryMapping} from '../server/telemetry-mapping.mjs';

const FROM = '2026-10-01T00:00:00Z', SWITCH = '2026-10-15T12:00:00Z', NOW = '2026-10-20T00:00:00Z';
const mapping = (extra = {}) => ({id: 'confirmed-1', source: 'geotab', sourceId: 'device-1', vehicleKey: 'vehicle-1',
  validFrom: FROM, validTo: null, confirmedAt: FROM, evidenceId: 'manual-evidence-1', ...extra});
const resolve = (records, extra = {}) => resolveTelemetryMapping(records, {source: 'geotab', sourceId: 'device-1', observedAt: '2026-10-10T00:00:00Z', knownAt: NOW, ...extra});

test('a late measurement follows the confirmed historical device assignment, not the current vehicle', () => {
  const history = [mapping({validTo: SWITCH}), mapping({id: 'confirmed-2', vehicleKey: 'vehicle-2', validFrom: SWITCH, confirmedAt: SWITCH, evidenceId: 'manual-evidence-2'})];
  assert.equal(resolve(history).mapping.vehicleKey, 'vehicle-1');
  assert.equal(resolve(history, {observedAt: SWITCH}).mapping.vehicleKey, 'vehicle-2');
  assert.equal(resolve(history, {observedAt: '2026-09-30T23:59:59Z'}).confirmed, false);
  assert.equal(resolve(history, {vehicleKey: 'vehicle-2'}).reason, 'vehicle_mapping_mismatch');
});

test('today’s assignment cannot be projected backwards, or used before its evidence was confirmed', () => {
  assert.equal(resolve([mapping({validFrom: SWITCH})]).reason, 'no_confirmed_mapping_at_observation');
  const retroactive = mapping({confirmedAt: '2026-10-19T00:00:00Z'});
  assert.equal(resolve([retroactive], {knownAt: '2026-10-18T00:00:00Z'}).confirmed, false);
  assert.equal(resolve([retroactive]).confirmed, true, 'explicit evidence may confirm the historical interval later');
});

test('conflicting assignments and two simultaneous devices for one vehicle remain unassigned', () => {
  assert.equal(resolve([mapping(), mapping({id: 'other', vehicleKey: 'vehicle-2'})]).reason, 'conflicting_device_mapping');
  assert.equal(resolve([mapping(), mapping({id: 'other', sourceId: 'device-2'})]).reason, 'multiple_devices_for_vehicle');
  assert.throws(() => resolve([mapping(), mapping({vehicleKey: 'vehicle-2'})]), /contradictoire/);
  assert.equal(resolve([mapping(), mapping()]).confirmed, true, 'an identical evidence record is idempotent');
});

test('one confirmed Geotab and one confirmed Texat device remain independent sources', () => {
  const records = [mapping(), mapping({id: 'texat-confirmed', source: 'texat', sourceId: 'texat-device'})];
  assert.equal(resolve(records).confirmed, true);
  const secondary = resolve(records, {source: 'texat', sourceId: 'texat-device'});
  assert.equal(secondary.confirmed, true); assert.equal(secondary.mapping.source, 'texat');
  assert.equal(secondary.basis, 'explicit_temporal_evidence');
});

test('an interval must fit wholly within one confirmed assignment, without prorating across a reassignment', () => {
  const history = [mapping({validTo: SWITCH}), mapping({id: 'second', vehicleKey: 'vehicle-2', validFrom: SWITCH, confirmedAt: SWITCH})];
  const query = {source: 'geotab', sourceId: 'device-1', from: FROM, to: SWITCH, knownAt: NOW};
  assert.equal(resolveTelemetryMapping(history, query).mapping.vehicleKey, 'vehicle-1', 'interval end is exclusive');
  assert.equal(resolveTelemetryMapping(history, {...query, to: NOW}).reason, 'conflicting_device_mapping');
  assert.equal(resolveTelemetryMapping([mapping({validTo: SWITCH})], {...query, to: NOW}).reason, 'mapping_does_not_cover_interval');
  assert.equal(resolveTelemetryMapping(history, {...query, from: SWITCH, to: NOW}).mapping.vehicleKey, 'vehicle-2');
});

test('evidence, timezone-explicit real dates, consistent bounds and a bounded history are required', () => {
  for (const extra of [{evidenceId: null}, {validTo: FROM}, {validFrom: '2026-02-30T00:00:00Z'}, {confirmedAt: '2026-10-01T00:00:00'}, {source: 'inferred'}]) {
    assert.throws(() => normalizeTelemetryMapping(mapping(extra)));
  }
  assert.throws(() => resolve([], {observedAt: '2026-10-21T00:00:00Z'}), /Fenêtre/);
  assert.throws(() => resolve([], {from: FROM, to: NOW}), /Choisir/);
  assert.throws(() => resolve(Array.from({length: 20001}, () => mapping())), /Historique/);
  assert.equal(normalizeTelemetryMapping(mapping({validFrom: '2026-10-01T01:00:00+01:00'})).validFrom, '2026-10-01T00:00:00.000Z');
});
