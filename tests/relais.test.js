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
const call = async (who, envOver, now) => {
  const r = await L.handle(new Request('http://x/functions/v1/geotab-live', { headers: who ? { authorization: 'Bearer ' + jwt(who) } : {} }),
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
