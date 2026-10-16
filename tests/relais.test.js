// Relais Geotab en direct (fonction Supabase geotab-live) : vraies réponses Geotab rejouées, droits de la base (agences).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), { collector } = require('./lib/v6'), geo = require('./lib/geotab_fake');
const NOW = Date.UTC(2026, 9, 3, 13, 55);
const jwt = n => fs.readFileSync(path.join(__dirname, 'lib', n + '.jwt'), 'utf8').trim();
let L, calls;
const fetchFn = async (url, opt) => {
  if (/geotab\.com\/apiv1$/.test(url)) {
    const b = JSON.parse(opt.body); calls.push(b.method);
    if (b.method === 'Authenticate') b.params.password = b.params.password === 'bon' ? 'secret' : 'faux';
    return new Response(JSON.stringify(geo.handle(b.method, b.params)));
  }
  return fetch(url, opt);
};
const ENV = { SUPABASE_REST: env.POSTGREST, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: env.svcKey(), GEO_USER: 'a', GEO_PWD: 'bon' };
const call = async (who, envOver, now, qs) => {
  const r = await L.handle(new Request('http://x/functions/v1/geotab-live' + (qs ? '?' + new URLSearchParams(qs) : ''), { headers: who ? { authorization: 'Bearer ' + jwt(who) } : {} }),
    { env: k => Object.assign({}, ENV, envOver)[k], fetch: fetchFn, now: () => now || NOW });
  return { status: r.status, body: await r.json() };
};

test.before(async () => {
  const B = collector(NOW); B.run('installer()');
  L = await import('../supabase/functions/geotab-live/live.mjs');
  global.__NOW = NOW;
});
test.beforeEach(() => { calls = []; });

test('administrateur : position, vitesse et état de chaque véhicule tels que Geotab les donne', async () => {
  L.resetMemory();
  const r = await call('admin');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.vehicles.map(v => v.key).sort(), ['968194WW', '968199WW']);
  const keys = JSON.parse(env.psql("select json_object_agg(key, geotab_id) from vehicles"));
  r.body.vehicles.forEach(v => {
    const d = geo.handle('Get', { credentials: { sessionId: 'S1' }, typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: keys[v.key] } } }).result[0];
    assert.strictEqual(v.lat, d.latitude); assert.strictEqual(v.lon, d.longitude); assert.strictEqual(v.at, d.dateTime);
    assert.strictEqual(v.speed, d.isDriving ? Math.round(d.speed) : 0);
    assert.ok(['En route', 'Arrêté, contact mis', 'Garé'].includes(v.state), v.state);
    if (d.isDriving) assert.strictEqual(v.state, 'En route');
  });
  assert.deepStrictEqual(calls, ['Authenticate', 'ExecuteMultiCall']);
});

test('compte en attente : aucun véhicule ; sans connexion : refusé', async () => {
  assert.deepStrictEqual((await call('pending')).body.vehicles, []);
  assert.strictEqual((await call(null)).status, 401);
  assert.ok(!calls.includes('ExecuteMultiCall'), 'Geotab appelé sans véhicule autorisé');
});

test('gestionnaire d\'agence : seulement les véhicules de son agence', async () => {
  env.psql(`insert into agencies (name) values ('Casa'); update parc set agency_id = (select id from agencies where name = 'Casa') where plate = 'WW968194';
    update profiles set role = 'manager' where user_id = '22222222-2222-2222-2222-222222222222';
    insert into user_agencies select '22222222-2222-2222-2222-222222222222', id from agencies where name = 'Casa'`);
  try { assert.deepStrictEqual((await call('pending')).body.vehicles.map(v => v.key), ['968194WW']); }
  finally { env.psql("update profiles set role = 'pending' where user_id = '22222222-2222-2222-2222-222222222222'; delete from user_agencies; update parc set agency_id = null; update vehicles set agency_id = null; delete from agencies"); }
});

test('session Geotab réutilisée (mémoire, puis base) ; réponse partagée 2 s entre écrans', async () => {
  L.resetMemory(); env.psql('delete from geotab_session');
  await call('admin', {}, NOW); await call('admin', {}, NOW + 1000);
  assert.deepStrictEqual(calls, ['Authenticate', 'ExecuteMultiCall'], 'deux écrans en 1 s : un seul appel Geotab');
  await call('admin', {}, NOW + 3000);
  assert.deepStrictEqual(calls, ['Authenticate', 'ExecuteMultiCall', 'ExecuteMultiCall']);
  assert.strictEqual(env.psql("select credentials->>'sessionId' from geotab_session"), 'S1');
  L.resetMemory(); calls = [];
  await call('admin', {}, NOW + 6000);
  assert.deepStrictEqual(calls, ['ExecuteMultiCall'], 'session reprise de la base après redémarrage de la fonction');
});

test('session expirée : reconnexion automatique', async () => {
  L.resetMemory(); env.psql(`update geotab_session set credentials = '{"sessionId":"périmée","database":"clicar","userName":"a"}'`);
  const r = await call('admin', {}, NOW + 9000);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.vehicles.length, 2);
  assert.deepStrictEqual(calls, ['ExecuteMultiCall', 'Authenticate', 'ExecuteMultiCall']);
});

test('secrets Geotab absents ou faux : message clair', async () => {
  L.resetMemory(); env.psql('delete from geotab_session');
  let r = await call('admin', { GEO_PWD: '' }, NOW + 20000);
  assert.strictEqual(r.status, 503); assert.match(r.body.error, /GEO_USER \/ GEO_PWD absents/);
  r = await call('admin', { GEO_PWD: 'mauvais' }, NOW + 30000);
  assert.strictEqual(r.status, 502); assert.match(r.body.error, /^Geotab : /);
});

test('événements de conduite Geotab des 30 dernières minutes, rattachés au véhicule', async () => {
  L.resetMemory();
  global.__NOW = NOW; const r = await call('admin', {}, NOW + 60000);
  const fx = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'geotab_2026-09-26_10-06.json.gz'))));
  const keyOf = {}; JSON.parse(env.psql("select json_agg(json_build_array(geotab_id, key)) from vehicles")).forEach(([g, k]) => { keyOf[g] = k; });
  const exp = {};
  fx.data.forEach(w => (w.exc || []).forEach(e => { const t = Date.parse(e.activeFrom); if (t >= NOW - 1800000 && t <= NOW && e.state !== 'ExceptionEventStateInvalidId') exp[e.id] = keyOf[w.id]; }));
  assert.ok(Object.keys(exp).length > 0, 'aucun événement de référence');
  assert.deepStrictEqual(Object.fromEntries(r.body.events.map(e => [e.id, e.key])), exp);
  r.body.events.forEach(e => { assert.ok(e.rule && e.at, e.id); });
  assert.deepStrictEqual(r.body.events.map(e => e.at), r.body.events.map(e => e.at).slice().sort().reverse(), 'du plus récent au plus ancien');
});

const G = (typeName, search, extra) => geo.handle('Get', Object.assign({ credentials: { sessionId: 'S1' }, typeName, search }, extra || {})).result;
const gid = k => env.psql("select geotab_id from vehicles where key = '" + k + "'");

test('fiche d\'une alerte : vitesse du capteur, positions et limite de la route lues dans Geotab autour de l\'instant', async () => {
  L.resetMemory(); global.__NOW = NOW;
  const ev = G('ExceptionEvent', { deviceSearch: { id: gid('968199WW') }, fromDate: '2026-10-03T06:00:00Z', toDate: '2026-10-03T13:50:00Z' })
    .find(e => e.activeTo && e.state !== 'ExceptionEventStateInvalidId');
  assert.ok(ev, 'aucun événement de référence');
  const r = await call('admin', {}, NOW, { mode: 'detail', key: '968199WW', from: ev.activeFrom, to: ev.activeTo });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const a = Date.parse(ev.activeFrom) - 180000, b = Date.parse(ev.activeTo) + 180000, iso = t => new Date(t).toISOString();
  assert.strictEqual(r.body.from, iso(a)); assert.strictEqual(r.body.to, iso(b));
  const spd = G('StatusData', { deviceSearch: { id: gid('968199WW') }, diagnosticSearch: { id: 'DiagnosticEngineRoadSpeedId' }, fromDate: iso(a), toDate: iso(b) })
    .filter(x => Date.parse(x.dateTime) !== a).map(x => [Date.parse(x.dateTime), Math.round(x.data)]);
  assert.ok(spd.length > 0); assert.deepStrictEqual(r.body.speed, spd);
  const gps = G('LogRecord', { deviceSearch: { id: gid('968199WW') }, fromDate: iso(a), toDate: iso(b) });
  assert.strictEqual(r.body.gps.length, gps.length);
  assert.deepStrictEqual(r.body.gps[0], [Date.parse(gps[0].dateTime), Math.round(gps[0].speed), gps[0].latitude, gps[0].longitude]);
  assert.ok(r.body.events.some(e => e.id === String(ev.id)), 'événement de l\'alerte renvoyé');
  assert.ok(Array.isArray(r.body.road));
});

test('fiche d\'une alerte : véhicule d\'une autre agence refusé', async () => {
  const r = await call('pending', {}, NOW, { mode: 'detail', key: '968199WW', from: '2026-10-03T12:00:00Z', to: '2026-10-03T12:01:00Z' });
  assert.strictEqual(r.status, 404);
  assert.ok(!calls.includes('ExecuteMultiCall'));
});

test('chauffeurs en ce moment : compteurs du véhicule entre le début du contrat et maintenant (trajet en cours compris)', async () => {
  L.resetMemory(); global.__NOW = NOW;
  const from = Date.UTC(2026, 9, 3, 6, 0), iso = t => new Date(t).toISOString(), id = gid('968199WW');
  const r = await call('admin', {}, NOW, { mode: 'drivers', c: '968199WW@' + iso(from) + ',968194WW@' + iso(NOW + 3600000) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(Object.keys(r.body.drivers), ['968199WW'], 'contrat pas encore commencé : ignoré');
  const d = r.body.drivers['968199WW'], at = (diag, t) => G('StatusData', { deviceSearch: { id }, diagnosticSearch: { id: diag }, fromDate: iso(t), toDate: iso(t) }).slice(-1)[0].data;
  assert.strictEqual(d.from, iso(from));
  const r3 = v => Math.round(v * 1000) / 1000;
  assert.strictEqual(d.km, r3((at('DiagnosticOdometerId', NOW) - at('DiagnosticOdometerId', from)) / 1000));
  assert.strictEqual(d.fuel_l, r3(at('DiagnosticDeviceTotalFuelId', NOW) - at('DiagnosticDeviceTotalFuelId', from)));
  assert.strictEqual(d.idle_l, r3(at('DiagnosticDeviceTotalIdleFuelId', NOW) - at('DiagnosticDeviceTotalIdleFuelId', from)));
  assert.ok(d.km > 0 && d.fuel_l > 0, JSON.stringify(d));
  const trips = G('Trip', { deviceSearch: { id }, fromDate: iso(from), toDate: iso(NOW), includeOverlappedTrips: true });
  const spd = G('StatusData', { deviceSearch: { id }, diagnosticSearch: { id: 'DiagnosticEngineRoadSpeedId' }, fromDate: iso(from), toDate: iso(NOW) });
  assert.ok(d.vmax >= Math.max(...trips.filter(t => Date.parse(t.stop) > from).map(t => t.maximumSpeed)));
  assert.ok(d.vmax <= Math.max(...trips.map(t => t.maximumSpeed), ...spd.map(x => Math.round(x.data))));
  const ev = G('ExceptionEvent', { deviceSearch: { id }, fromDate: iso(from), toDate: iso(NOW) }).filter(e => e.state !== 'ExceptionEventStateInvalidId');
  assert.deepStrictEqual(d.events.map(e => e.id).sort(), ev.map(e => String(e.id)).sort());
});

test('limite de la route sous chaque véhicule en route (alerte de dépassement en direct)', async () => {
  L.resetMemory(); global.__NOW = NOW;
  const fx = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'geotab_2026-09-26_10-06.json.gz'))));
  let seen = 0;
  for (const t of [NOW, NOW - 20 * 60000, NOW - 47 * 60000, NOW - 90 * 60000]) {
    L.resetMemory(); global.__NOW = t;
    const r = await call('admin', {}, t);
    assert.strictEqual(r.status, 200);
    r.body.vehicles.forEach(v => {
      const id = gid(v.key), m = {}; fx.data.filter(w => w.id === id).forEach(w => (w.road || []).forEach(x => { m[Date.parse(x[0])] = +x[1]; }));
      const last = Object.keys(m).map(Number).filter(x => x >= t - 180000 && x <= t).sort((a, b) => a - b).pop();
      const exp = v.state === 'En route' && last !== undefined && m[last] > 0 ? Math.round(m[last]) : null;
      assert.strictEqual(v.limit, exp, v.key + ' ' + new Date(t).toISOString());
      if (exp) seen++;
    });
  }
  assert.ok(seen > 0, 'aucune limite de route relevée sur les instants testés');
});
