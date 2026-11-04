import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeksatService, teksatAccountFingerprint} from '../server/texat-service.mjs';
const config = {TEXAT_SOCIETE: 'PRIVATE-company', TEXAT_EMAIL: 'PRIVATE@example.test', TEXAT_PASSWORD: 'PRIVATE-password'};

test('explicit verification reports scoped coverage without enabling archival, mapping or GPS fallback', async () => {
  const calls = []; let at = Date.parse('2026-11-03T12:00:00Z');
  const service = await createTeksatService({configPath: '/unused', scope: {filialeId: 42, accountFingerprint: teksatAccountFingerprint(config)}, now: () => at,
    readConfig: async () => config, clientFactory: () => ({
      async readPositions(options) {calls.push(options); return {rows: [{privateMode: true, plate: 'PRIVATE-PLATE'}]};},
      async readVehiclePage(options) {calls.push(options); return {totalCount: 12, totalPages: 2, nextPage: 2};}, close() {calls.push('close');}})});
  assert.equal(calls.length, 0); assert.equal(service.getStatus().connection, 'not_checked');
  const status = await service.refreshReadOnly();
  assert.equal(status.connection, 'verified'); assert.equal(status.coverage.catalogueComplete, false);
  assert.equal(status.coverage.catalogueTotal, 12); assert.equal(status.coverage.confirmedMappings, 0);
  assert.equal(status.capabilities.positionTimeZone, null); assert.equal(status.activeFailover, false);
  assert.equal(status.collectionEnabled, false); assert.equal(status.archiveEnabled, false);
  assert.equal(calls[0].filialeId, 42); assert.equal(calls[1].filialeId, 42);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE|42|password|token/);
  await assert.rejects(service.refreshReadOnly(), {status: 429}); assert.equal(calls.length, 2);
  at += 30000; await service.refreshReadOnly(); assert.equal(calls.length, 4);
  service.close(); assert.equal(service.getStatus().connection, 'closed');
  await assert.rejects(service.refreshReadOnly(), {code: 'teksat_closed'});
});

test('a branch observed under one account cannot be reused after an account change', async () => {
  let current = config, calls = 0;
  const service = await createTeksatService({scope: {filialeId: 42, accountFingerprint: teksatAccountFingerprint(config)},
    readConfig: async () => current, clientFactory: () => {calls++; throw new Error('must not connect');}});
  current = {...config, TEXAT_EMAIL: 'other@example.test'};
  const result = await service.refreshReadOnly();
  assert.equal(calls, 0); assert.equal(result.lastError, 'teksat_scope_account_mismatch');
  assert.ok(result.blockingReasons.includes('provider_scope_account_mismatch'));
  assert.doesNotMatch(JSON.stringify(result), /other@example|PRIVATE|42/);
});

test('incomplete credentials and provider errors remain explicit without leaking private errors', async () => {
  let factoryCalls = 0;
  const empty = await createTeksatService({readConfig: async () => null, clientFactory: () => {factoryCalls++;}});
  assert.equal((await empty.refreshReadOnly()).lastError, 'teksat_configuration'); assert.equal(factoryCalls, 0);
  const bad = await createTeksatService({readConfig: async () => config, clientFactory: () => ({
    async readVehiclePage() {return {totalCount: 0, totalPages: 0, nextPage: null};},
    async readPositions() {throw Object.assign(new Error('PRIVATE password and upstream body'), {code: 'teksat_authentication'});}, close() {}})});
  const status = await bad.refreshReadOnly(); assert.equal(status.connection, 'error'); assert.equal(status.lastError, 'teksat_authentication');
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE|upstream/); assert.equal(status.lastSuccessAt, null);
});

test('parallel verification is single-flight and configuration rotation closes the previous client', async () => {
  let release, current = config, creations = 0, closes = 0;
  const barrier = new Promise(resolve => {release = resolve;});
  const service = await createTeksatService({minimumRefreshMs: 0, readConfig: async () => current, clientFactory: () => {
    creations++; return {async readPositions() {await barrier; return {rows: []};}, async readVehiclePage() {return {totalCount: 0, totalPages: 0, nextPage: null};}, close() {closes++;}};
  }});
  const a = service.refreshReadOnly(), b = service.refreshReadOnly(); release(); await Promise.all([a, b]); assert.equal(creations, 1);
  current = {...config, TEXAT_PASSWORD: 'PRIVATE-rotated'}; await service.refreshReadOnly(); assert.equal(creations, 2); assert.equal(closes, 1);
  service.close(); assert.equal(closes, 2);
});
