import test from 'node:test';
import assert from 'node:assert/strict';
import {findTeksatMappingCandidates, teksatIdentifierKey} from '../server/texat-matching.mjs';

const local = (key = 'v1', more = {}) => ({key, plate: '12345-A-6', otherPlates: ['WW123456'], vin: 'VF1AAAAA123456789', active: true, ...more});
const remote = (id = 'p1', more = {}) => ({providerVehicleId: id, deviceId: '123456789012345', plate: 'WW-123456', active: true, ...more});

test('plate formatting preserves Arabic letters, token order and leading zeroes', () => {
  assert.equal(teksatIdentifierKey(' ٠٠١٢٣ – أ – ۶ '), '00123أ6');
  assert.equal(teksatIdentifierKey('１２３４５－a－６'), '12345A6');
  assert.notEqual(teksatIdentifierKey('12345-أ-6'), teksatIdentifierKey('12345-ب-6'));
  assert.notEqual(teksatIdentifierKey('00123-A-6'), teksatIdentifierKey('123-A-6'));
  assert.notEqual(teksatIdentifierKey('A123'), teksatIdentifierKey('123A'));
  assert.equal(teksatIdentifierKey('A/123'), null);
});

test('registered old plate can yield a unique current candidate but never creates a historical mapping', () => {
  const result = findTeksatMappingCandidates([local()], [remote()], {catalogueComplete: true});
  assert.equal(result.unambiguousCandidates, 1); assert.equal(result.confirmedMappings, 0);
  assert.deepEqual(result.candidates[0].reasons, ['registered_plate_alias']);
  assert.equal(result.candidates[0].confirmed, false);
});

test('incomplete catalogue, inactive duplicate and shared tracker prevent confirmation candidates', () => {
  assert.deepEqual(findTeksatMappingCandidates([local()], [remote()]).candidates[0].blockingReasons, ['catalogue_incomplete']);
  const duplicate = remote('p2', {active: false, deviceId: '999999999999999'});
  const result = findTeksatMappingCandidates([local()], [remote(), duplicate], {catalogueComplete: true});
  assert.equal(result.unambiguousCandidates, 0);
  assert.ok(result.candidates.every(row => row.blockingReasons.includes('ambiguous_identity')));
  const shared = findTeksatMappingCandidates([local()], [remote(), remote('p2', {plate: 'OTHER'})], {catalogueComplete: true});
  assert.equal(shared.unambiguousCandidates, 0);
});

test('VIN disagreement is never overridden by an alias; a label alone is insufficient', () => {
  const conflict = findTeksatMappingCandidates([local()], [remote('p1', {vin: 'VF1BBBBB123456789'})], {catalogueComplete: true});
  assert.ok(conflict.candidates[0].blockingReasons.includes('vin_conflict'));
  const label = findTeksatMappingCandidates([local('v1', {otherPlates: [], geotabName: 'WW123456'})], [remote()], {catalogueComplete: true});
  assert.deepEqual(label.candidates[0].blockingReasons, ['label_only']);
  const vin = findTeksatMappingCandidates([local()], [remote('p1', {plate: 'OTHER', vin: 'VF1AAAAA123456789'})], {catalogueComplete: true});
  assert.equal(vin.unambiguousCandidates, 1);
});

test('aliases shared by local vehicles remain ambiguous even when both are active', () => {
  const result = findTeksatMappingCandidates([local(), local('v2')], [remote()], {catalogueComplete: true});
  assert.equal(result.unambiguousCandidates, 0);
  assert.ok(result.candidates.every(row => row.blockingReasons.includes('ambiguous_identity')));
});

test('the local French NON flag is inactive and an absent tracker is never a usable mapping', () => {
  const inactive = findTeksatMappingCandidates([local('v1', {active: 'NON'})], [remote()], {catalogueComplete: true});
  assert.deepEqual(inactive.candidates[0].blockingReasons, ['inactive_vehicle']);
  const noTracker = findTeksatMappingCandidates([local()], [remote('p1', {deviceId: null})], {catalogueComplete: true});
  assert.deepEqual(noTracker.candidates[0].blockingReasons, ['missing_device']);
});
