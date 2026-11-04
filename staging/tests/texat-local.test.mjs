import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, writeFile, chmod, symlink, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalTeksat, readLocalTeksatScope} from '../server/texat-local.mjs';
import {createTeksatService, teksatAccountFingerprint} from '../server/texat-service.mjs';
import {listenLocalStaging} from '../scripts/listen.mjs';

const CONFIG = {TEXAT_SOCIETE: 'synthetic-company', TEXAT_EMAIL: 'synthetic@example.test', TEXAT_PASSWORD: 'private-password'};
const SCOPE = {filialeId: 42, accountFingerprint: teksatAccountFingerprint(CONFIG)};
const STATUS = {provider: 'Teksat', configured: true, connection: 'verified', activeFailover: false,
  collectionEnabled: true, archiveEnabled: true, rawArchive: {entries: 3, collectionRunning: true}};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const vehicle = n => ({key: 'vehicle-' + String(n).padStart(6, '0'), plate: 'synthetic-' + n,
  other_plates: null, vin: null, geotab_id: null, active: 'OUI'});

function fixture(options = {}) {
  const calls = [], counters = {config: 0, scope: 0, factory: 0, start: 0, close: 0, refresh: 0};
  let construction;
  const service = {getStatus: () => STATUS, start: async () => {counters.start++; return STATUS;},
    close: async () => {counters.close++;}, refreshReadOnly: async () => {counters.refresh++; return STATUS;}, ...options.service};
  const local = createLocalTeksat({supabaseUrl: 'http://127.0.0.1:57421', serviceKey: 'local-service-key', localDirectory: '/synthetic-private',
    readConfig: async path => {counters.config++; assert.equal(path, '/synthetic-private/texat.json'); return CONFIG;},
    readScope: async path => {counters.scope++; assert.equal(path, '/synthetic-private/texat-scope.json'); return SCOPE;},
    fetchFn: async (url, init) => {calls.push({url: new URL(url), init}); return Response.json([{value: 'staging'}]);},
    serviceFactory: async input => {counters.factory++; construction = input; return service;}, ...options});
  return {local, calls, counters, service, construction: () => construction};
}

test('construction and cached status perform no reads, provider calls or journal recovery before socket ownership', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) assert.equal(f.local.getStatus().lifecycle, 'not_started');
  await assert.rejects(f.local.refreshReadOnly(), {code: 'teksat_local_not_ready', status: 503});
  assert.deepEqual(f.counters, {config: 0, scope: 0, factory: 0, start: 0, close: 0, refresh: 0});
  assert.equal(f.calls.length, 0); await f.local.close();
  assert.equal(f.counters.factory, 0); assert.equal(f.local.getStatus().lifecycle, 'closed');
  await assert.rejects(f.local.start(), {code: 'teksat_closed'});
});

test('the successful owner starts once, and duplicate-server detection never constructs the second journal', async t => {
  const owner = http.createServer((_req, res) => {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({environment: 'staging', project: 'ludy-staging'}));});
  const first = fixture(), second = fixture();
  t.after(async () => {await first.local.close(); await second.local.close(); await new Promise(resolve => owner.close(resolve));});
  const state = await listenLocalStaging(owner, 0); assert.equal(state, 'started');
  await Promise.all([first.local.start(), first.local.start()]);
  assert.equal(first.counters.factory, 1); assert.equal(first.counters.start, 1);
  const duplicate = http.createServer(), duplicateState = await listenLocalStaging(duplicate, owner.address().port);
  assert.equal(duplicateState, 'existing'); await second.local.close();
  assert.equal(second.counters.config, 0); assert.equal(second.counters.factory, 0); assert.equal(second.calls.length, 0);
  assert.deepEqual(first.construction().scope, SCOPE);
  assert.equal(first.construction().archiveDirectory, '/synthetic-private/texat/raw');
  assert.equal(first.construction().mappingEvidencePath, '/synthetic-private/texat-mapping-evidence.json');
  assert.equal(first.local.getStatus().lifecycle, 'ready'); await first.local.refreshReadOnly(); assert.equal(first.counters.refresh, 1);
});

test('a failed bind leaves Teksat unconstructed and does not stop the existing listener', async t => {
  const occupied = http.createServer((_req, res) => {res.statusCode = 404; res.end();});
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = fixture();
  await assert.rejects(listenLocalStaging(http.createServer(), occupied.address().port), /occupe/);
  await f.local.close(); assert.equal(occupied.listening, true); assert.equal(f.counters.factory, 0);
});

test('missing credentials or branch scope stays inactive without preventing the web server from starting', async () => {
  for (const options of [{readConfig: async () => null}, {readConfig: async () => ({...CONFIG, TEXAT_PASSWORD: ''})}, {readScope: async () => null}]) {
    const f = fixture(options), status = await f.local.start();
    assert.equal(status.lifecycle, 'not_configured'); assert.equal(status.collectionEnabled, false);
    assert.equal(f.counters.factory, 0); assert.equal(f.calls.length, 0);
    await assert.rejects(f.local.refreshReadOnly(), {status: 503}); await f.local.close();
  }
});

test('local URL, environment and account scope are checked before service construction', async () => {
  for (const supabaseUrl of ['https://example.invalid', 'http://127.0.0.1:54321', 'http://name:secret@127.0.0.1:57421', 'http://127.0.0.1:57421/rest/v1']) assert.throws(() => fixture({supabaseUrl}));
  for (const options of [{readScope: async () => ({...SCOPE, accountFingerprint: 'b'.repeat(64)})},
    {fetchFn: async () => Response.json([{value: 'production'}])}, {fetchFn: async () => new Response('private upstream diagnostic', {status: 503})}]) {
    const f = fixture(options); await assert.rejects(f.local.start(), /Service Teksat local indisponible/);
    assert.equal(f.counters.factory, 0); assert.equal(f.local.getStatus().lifecycle, 'error');
    assert.doesNotMatch(JSON.stringify(f.local.getStatus()), /private-password|private upstream|synthetic-company|synthetic@example/); await f.local.close();
  }
});

test('shutdown during configuration prevents late construction and refresh is unavailable throughout initialization', async () => {
  const gate = deferred(), f = fixture({readConfig: () => gate.promise}), starting = f.local.start();
  assert.equal(f.local.getStatus().lifecycle, 'initializing'); await assert.rejects(f.local.refreshReadOnly(), {status: 503});
  const closing = f.local.close(); gate.resolve(CONFIG); await Promise.all([starting, closing]);
  assert.equal(f.counters.factory, 0); assert.equal(f.local.getStatus().lifecycle, 'closed');
});

test('shutdown awaits an in-flight constructor, closes its journal and never starts collection afterward', async () => {
  const entered = deferred(), gate = deferred(); let starts = 0, closes = 0;
  const f = fixture({serviceFactory: async () => {entered.resolve(); return gate.promise;}}), starting = f.local.start();
  await entered.promise; const closing = f.local.close(); let finished = false; closing.then(() => {finished = true;});
  await Promise.resolve(); assert.equal(finished, false);
  gate.resolve({getStatus: () => STATUS, start: async () => {starts++;}, close: async () => {closes++;}});
  await Promise.all([starting, closing]); await f.local.close();
  assert.equal(starts, 0); assert.equal(closes, 1); assert.equal(f.local.getStatus().collectionEnabled, false);
});

test('shutdown closes an already constructed service immediately and waits for its start or refresh to finish', async () => {
  for (const operation of ['start', 'refresh']) {
    const entered = deferred(), gate = deferred(), closed = deferred(); let closes = 0;
    const service = {getStatus: () => STATUS, start: async () => {if (operation === 'start') {entered.resolve(); await gate.promise;} return STATUS;},
      refreshReadOnly: async () => {entered.resolve(); await gate.promise; return STATUS;},
      close: async () => {closes++; gate.resolve(); await closed.promise;}};
    const f = fixture({service});
    let running = f.local.start(); if (operation === 'refresh') {await running; running = f.local.refreshReadOnly();}
    const observed = running.catch(error => error); await entered.promise;
    const closing = f.local.close(); await Promise.resolve(); assert.equal(closes, 1);
    closed.resolve(); await closing; const result = await observed;
    if (operation === 'refresh') assert.equal(result.code, 'teksat_closed');
    assert.equal(f.local.getStatus().connection, 'closed'); assert.equal(f.local.getStatus().rawArchive.collectionRunning, false);
  }
});

test('service startup failure closes its resources once and exposes only a normalized diagnostic', async () => {
  let closes = 0;
  const f = fixture({service: {start: async () => {throw Error('private-password and full upstream response');}, close: async () => {closes++;}}});
  await assert.rejects(f.local.start(), {code: 'teksat_local_unavailable'});
  assert.equal(closes, 1); assert.equal(f.local.getStatus().lifecycle, 'error');
  assert.doesNotMatch(JSON.stringify(f.local.getStatus()), /private-password|upstream/);
  await f.local.close(); assert.equal(closes, 1);
});

test('vehicle mapping reads every local REST page with fixed columns, exact count and no agency filter', async () => {
  const calls = [], vehicles = Array.from({length: 2001}, (_, i) => vehicle(i)); let received;
  const f = fixture({fetchFn: async (url, init) => {
    const parsed = new URL(url); calls.push({parsed, init});
    assert.equal(parsed.origin, 'http://127.0.0.1:57421'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer local-service-key'); assert.ok(init.signal instanceof AbortSignal);
    if (parsed.pathname.endsWith('/params')) return Response.json([{value: 'staging'}]);
    assert.equal(parsed.pathname, '/rest/v1/vehicles'); assert.equal(parsed.searchParams.get('select'), 'key,plate,other_plates,vin,geotab_id,active');
    assert.equal(parsed.searchParams.get('order'), 'key.asc'); assert.equal(parsed.searchParams.has('agency_id'), false); assert.equal(init.headers.Prefer, 'count=exact');
    const offset = Number(parsed.searchParams.get('offset')), page = vehicles.slice(offset, offset + 1000);
    return Response.json(page, {headers: {'content-range': offset + '-' + (offset + page.length - 1) + '/' + vehicles.length}});
  }, serviceFactory: async input => ({getStatus: () => STATUS, start: async () => {received = await input.loadVehicles();}, close: async () => {}})});
  await f.local.start(); assert.equal(received.length, 2001); assert.equal(calls.length, 4);
  assert.deepEqual(received[2000], vehicles[2000]); await f.local.close();
});

test('mapping pagination rejects missing counts, oversized inventories, partial pages and changed identity sets', async () => {
  for (const issue of ['missing-count', 'too-many', 'short-page', 'changed-count', 'duplicate-key']) {
    const f = fixture({fetchFn: async url => {
      const parsed = new URL(url); if (parsed.pathname.endsWith('/params')) return Response.json([{value: 'staging'}]);
      const offset = Number(parsed.searchParams.get('offset')), total = issue === 'too-many' ? 20001 : issue === 'changed-count' && offset ? 1002 : 1001;
      const page = Array.from({length: offset ? 1 : issue === 'short-page' ? 999 : 1000}, (_, i) => vehicle(offset + i));
      if (issue === 'duplicate-key' && offset) page[0] = vehicle(0);
      return Response.json(page, {headers: issue === 'missing-count' ? {} : {'content-range': offset + '-' + (offset + page.length - 1) + '/' + total}});
    }, serviceFactory: async input => ({getStatus: () => STATUS, start: () => input.loadVehicles(), close: async () => {}})});
    await assert.rejects(f.local.start(), /Service Teksat local indisponible/, issue);
    assert.equal(f.local.getStatus().lifecycle, 'error'); await f.local.close();
  }
});

test('scope accepts only its private account-bound fields, with 0600 files and a 0700 directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teksat-scope-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = join(directory, 'scope.json');
  assert.equal(await readLocalTeksatScope(filename), null);
  await writeFile(filename, JSON.stringify({version: 1, scope: SCOPE, observedAt: 'private-review', evidence: 'private-evidence'}), {mode: 0o600});
  assert.deepEqual(await readLocalTeksatScope(filename), SCOPE);
  await chmod(filename, 0o644); await assert.rejects(readLocalTeksatScope(filename), {code: 'teksat_scope_permissions'});
  await chmod(filename, 0o600); await chmod(directory, 0o755); await assert.rejects(readLocalTeksatScope(filename), {code: 'teksat_scope_permissions'});
  await chmod(directory, 0o700); const linked = join(directory, 'linked.json'); await symlink(filename, linked); await assert.rejects(readLocalTeksatScope(linked));
  for (const scope of [{...SCOPE, url: 'https://outside.invalid'}, {...SCOPE, filialeId: -1}, {...SCOPE, accountFingerprint: 'invalid'}]) {
    await writeFile(filename, JSON.stringify({scope})); await assert.rejects(readLocalTeksatScope(filename), {code: 'teksat_scope_invalid'});
  }
});

test('real service and archive initialize from private local files only after start, with synthetic provider reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teksat-local-service-')), providerId = '11111111-1111-4111-8111-111111111111';
  const mapping = {version: 1, ...SCOPE, evidenceId: 'a'.repeat(64), mappings: [{vehicleKey: 'vehicle-a', providerVehicleId: providerId, deviceId: '123456789012345', reason: 'registered_plate_alias'}]};
  for (const [name, data] of [['texat.json', CONFIG], ['texat-scope.json', {version: 1, scope: SCOPE, observedAt: 'private-review'}], ['texat-mapping-evidence.json', mapping]]) {
    await writeFile(join(directory, name), JSON.stringify(data), {mode: 0o600});
  }
  let providerReads = 0;
  const local = createLocalTeksat({supabaseUrl: 'http://127.0.0.1:57421', serviceKey: 'synthetic-local-key', localDirectory: directory,
    fetchFn: async url => new URL(url).pathname.endsWith('/params') ? Response.json([{value: 'staging'}])
      : Response.json([{key: 'vehicle-a', plate: '12345-A-6', other_plates: 'WW123456', vin: null, geotab_id: null, active: 'OUI'}], {headers: {'content-range': '0-0/1'}}),
    serviceFactory: options => createTeksatService({...options, clientFactory: () => ({
      async readVehiclePage(filter) {providerReads++; assert.equal(filter.filialeId, SCOPE.filialeId);
        return {rows: [{providerVehicleId: providerId, deviceId: '123456789012345', plate: 'WW123456', active: true}], totalCount: 1, totalPages: 1, nextPage: null};},
      async readPositions() {providerReads++; return {rows: [{providerVehicleId: providerId, deviceId: '123456789012345', collectedAt: '2026-11-03T12:00:00.000Z',
        dateGpsRaw: '2026-11-03T13:00:00', datePositionRaw: '2026-11-03T12:59:00', privateMode: false, latitude: 33.5, longitude: -7.5, moving: true, providerStatusCode: 1}]};}, close() {}
    })})});
  t.after(async () => {await local.close(); await rm(directory, {recursive: true, force: true});});
  await assert.rejects(stat(join(directory, 'texat', 'raw')), {code: 'ENOENT'}); assert.equal(providerReads, 0);
  const status = await local.start(); assert.equal(status.lifecycle, 'ready'); assert.equal(status.rawArchive.entries, 1, JSON.stringify(status));
  assert.equal(status.activeFailover, false); assert.equal(status.rawArchive.normalization, 'unverified'); assert.equal(providerReads, 2);
  assert.doesNotMatch(JSON.stringify(status), /private-password|synthetic-company|synthetic@example|WW123456|123456789012345/);
  await local.close(); assert.equal(local.getStatus().rawArchive.collectionRunning, false);
});

test('serve wires the specific admin API before fleet routes and starts only after successful listen', async () => {
  const source = await readFile(new URL('../scripts/serve.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf("startsWith('/api/fleet/texat/')") < source.indexOf("startsWith('/api/fleet/')"));
  assert.ok(source.indexOf('await listenLocalStaging(server)') < source.indexOf('teksatLocal.start()'));
  assert.match(source, /if\(state==='existing'\)\{await closeLocalServices\(\);\}\s*else\s*\{[^]*?teksatLocal\.start\(\)/);
  assert.match(source, /Promise\.allSettled\(\[fleetApi,operationsApi,parkingApi,performanceApi,telemetryArchive,teksatLocal\]\s*\.map\(service=>Promise\.resolve\(\)\.then\(\(\)=>service\.close\(\)\)\)\)/);
  assert.match(source, /server\.close\(\(\)=>\{void servicesClosed\.then/);
  assert.match(source, /catch \(error\) \{\s*await closeLocalServices\(\);/);
});
