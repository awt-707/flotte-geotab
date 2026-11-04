import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeksatClient, normalizeTeksatPositions, normalizeTeksatVehiclePage, TEKSAT_CONTRACT} from '../server/texat.mjs';

const config = {TEXAT_SOCIETE: 'synthetic-company', TEXAT_EMAIL: 'synthetic@example.test', TEXAT_PASSWORD: 'synthetic-secret'};
const NOW = Date.parse('2026-11-03T12:00:00Z'), ID = '11111111-1111-4111-8111-111111111111';
const row = extra => ({sid: ID, imei: '123456789012345', immatriculation: 'SYNTHETIC-1', latitude: 33.5, longitude: -7.5,
  dateGps: '2026-11-03T11:59:00', datePosition: '2026-11-03T11:58:00', isViePrivee: false, isEnRoute: true, statutBalise: 1,
  distance: 999999, compteurKm: 888888, adresse: 'must not be retained', conducteur: {name: 'must not be retained'}, ...extra});
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
const vehicle = extra => ({sid: ID, imei: '123456789012345', immatriculation: 'SYNTHETIC-1', numeroSerie: 'SYNTHETICVIN000001', isActif: true, compteurKm: 9999, ...extra});

test('preserves provider datetimes verbatim without inventing timezone, network or distance observations', () => {
  const value = normalizeTeksatPositions([row()], {collectedAt: new Date(NOW).toISOString()});
  assert.equal(value.rows[0].dateGpsRaw, '2026-11-03T11:59:00');
  assert.equal(value.rows[0].datePositionRaw, '2026-11-03T11:58:00');
  assert.equal(value.rows[0].collectedAt, new Date(NOW).toISOString());
  assert.equal(value.rows[0].providerVehicleId, ID); assert.equal(value.rows[0].deviceId, '123456789012345');
  assert.equal(value.rows[0].usableAsObservation, false); assert.equal(value.activeFailover, false);
  assert.equal(value.coverage.populationComplete, false);
  assert.equal(TEKSAT_CONTRACT.positionTimeZone, null);
  for (const key of ['distance', 'compteurKm', 'adresse', 'conducteur', 'network', 'fuel']) assert.equal(Object.hasOwn(value.rows[0], key), false);
});

test('private mode suppresses coordinates and malformed or ambiguous identity data fails closed', () => {
  const value = normalizeTeksatPositions([row({isViePrivee: true})], {collectedAt: new Date(NOW).toISOString()});
  assert.equal(value.rows[0].latitude, null); assert.equal(value.rows[0].longitude, null);
  assert.equal(value.rows[0].reason, 'provider_private_mode');
  for (const rows of [[row(), row()], [row(), row({sid: '22222222-2222-4222-8222-222222222222'})],
    [row({latitude: 91})], [row({dateGps: 'yesterday'})], [row({imei: 'not-proven'})], [row({isViePrivee: null})]]) {
    assert.throws(() => normalizeTeksatPositions(rows, {collectedAt: new Date(NOW).toISOString()}), {code: 'teksat_schema'});
  }
});

test('inventory pages preserve vehicle/device separation and prove their page counts without claiming a dated odometer', () => {
  const value = normalizeTeksatVehiclePage({totalCount: 1, totalPages: 1, currentPage: 1, results: [vehicle()]});
  assert.equal(value.rows[0].providerVehicleId, ID); assert.equal(value.rows[0].vin, 'SYNTHETICVIN000001');
  assert.equal(value.nextPage, null); assert.equal(Object.hasOwn(value.rows[0], 'compteurKm'), false);
  for (const change of [{totalCount: 2}, {totalPages: 2}, {currentPage: 2}, {results: []}]) {
    assert.throws(() => normalizeTeksatVehiclePage({totalCount: 1, totalPages: 1, currentPage: 1, results: [vehicle()], ...change}), {code: 'teksat_pagination'});
  }
});

test('uses only the normally observed login and GET contracts, with credentials confined to login', async () => {
  const calls = [];
  const client = createTeksatClient({credentials: config, now: () => NOW, fetchFn: async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/auth/login')) return json({token: 'synthetic-token', email: 'not-retained@example.test'});
    if (new URL(url).pathname.endsWith('/positions-fuseau')) return json([row()]);
    return json({totalCount: 1, totalPages: 1, currentPage: 1, results: [vehicle()]});
  }});
  await client.readPositions(); await client.readVehiclePage({keyword: 'SYNTHETIC-1'});
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[0].options.body), {identifiantSociete: config.TEXAT_SOCIETE, email: config.TEXAT_EMAIL, password: config.TEXAT_PASSWORD});
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.headers.Authorization, undefined);
  for (const call of calls.slice(1)) {
    assert.equal(new URL(call.url).origin, 'https://api.teksat.fr'); assert.equal(call.options.method, 'GET');
    assert.equal(call.options.body, undefined); assert.equal(call.options.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit');
  }
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url).searchParams), {keyword: '', filialeId: '-2', categorieId: '-2', groupeId: '-2', sousGroupeId: '-2'});
  assert.equal(new URL(calls[2].url).searchParams.get('itemsPerPage'), '10');
  const status = JSON.stringify(client.status());
  for (const secret of [...Object.values(config), 'synthetic-token', 'not-retained@example.test']) assert.ok(!status.includes(secret));
  assert.equal(client.status().session, 'authenticated'); assert.equal(client.status().activeFailover, false);
  client.close(); assert.equal(client.status().session, 'not_authenticated');
});

test('authentication revocation and rate limiting do not trigger retries or expose upstream errors', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const client = createTeksatClient({credentials: config, fetchFn: async url => {calls++; return url.endsWith('/auth/login') ? json({token: 'private-token'}) : json({error: 'private upstream details'}, status);}});
    await assert.rejects(client.readPositions(), error => error.name === 'TeksatError' && !error.message.includes('private'));
    assert.equal(calls, 2);
    if ([401, 403].includes(status)) assert.equal(client.status().session, 'not_authenticated');
    client.close();
  }
});

test('malformed/oversized responses and unsupported filters never publish values or leak payloads', async () => {
  for (const response of [new Response('private raw HTML', {headers: {'content-type': 'text/html'}}),
    new Response('{private-invalid-json', {headers: {'content-type': 'application/json'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024)}})]) {
    const client = createTeksatClient({credentials: config, fetchFn: async () => response});
    await assert.rejects(client.readPositions(), error => error.name === 'TeksatError' && !error.message.includes('private'));
  }
  let calls = 0; const client = createTeksatClient({credentials: config, fetchFn: async () => {calls++; return json({});}});
  await assert.rejects(client.readPositions({filialeId: '../other'}), {code: 'teksat_filter'});
  await assert.rejects(client.readVehiclePage({page: 0}), {code: 'teksat_filter'}); assert.equal(calls, 0);
});

test('explicit cancellation and closure stop pending reads without reusing a closed session', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const client = createTeksatClient({credentials: config, fetchFn: async () => {calls++; return json({token: 'private-token'});}});
  await assert.rejects(client.readPositions({signal: controller.signal}), {name: 'AbortError'}); assert.equal(calls, 0);
  client.close(); await assert.rejects(client.readPositions(), {code: 'teksat_closed'}); assert.equal(calls, 0);
});
