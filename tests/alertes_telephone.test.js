// Alertes des pauses sur le téléphone, même écran éteint (application Android 1.3, 14/11/2026, demande d'Ahmed).
// Base : secret par téléphone, watch_poll limité aux droits de l'utilisateur. Relais ?mode=watch : véhicule en pause qui bouge et
// course arrivée relevés avec les positions Geotab (mêmes règles que site/suivi_calc.js). Site : panneau d'activation. Données synthétiques.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const anon = sql => env.psql(`begin; set local role anon; ${sql}; commit;`);
const iso = t => new Date(t).toISOString();

function seed() {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Marrakech');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id, geotab_id) values ('968199WW', 'WW968199', 'STARIA', 'OUI', 1, 'b1'), ('968200WW', 'WW968200', 'STARIA', 'OUI', 2, 'b2');
    insert into driver_pauses (vehicle_key, plate, agency_id, driver_name, driver_phone, shift_day, shift, started_at, planned_min, start_lat, start_lon)
      values ('968199WW', 'WW968199', 1, 'ALPHA Test', '0612345678', current_date, 'Jour', '${iso(Date.now() - 20 * 60000)}', 30, 33.5731, -7.5898),
             ('968200WW', 'WW968200', 2, 'BRAVO Test', '', current_date, 'Jour', '${iso(Date.now() - 5 * 60000)}', 60, 31.63, -8.0);`);
}

test('base : secret par téléphone (empreinte seule gardée), pauses visibles selon les droits, téléphone retiré', () => {
  seed();
  try {
    const sec = as(MGR, "select public.watch_register('Application Android')");
    assert.match(sec, /^[0-9a-f]{64}$/);
    assert.strictEqual(env.psql(`select count(*) from watch_devices where secret_hash = encode(sha256(convert_to('${sec}', 'UTF8')), 'hex')`), '1');
    assert.strictEqual(env.psql(`select count(*) from watch_devices where secret_hash like '%${sec.slice(0, 16)}%'`), '0', 'secret jamais gardé en clair');
    // clé publique + secret : pauses de ses agences seulement
    const w = JSON.parse(anon(`select public.watch_poll('${sec}')`));
    assert.deepStrictEqual(w.pauses.map(p => p.plate), ['WW968199']);
    assert.strictEqual(w.pauses[0].driver_phone, '0612345678');
    assert.strictEqual(w.params.pauseShiftMin || '120', '120');
    const wa = JSON.parse(anon(`select public.watch_poll('${as(ADMIN, "select public.watch_register('A')")}')`));
    assert.deepStrictEqual(wa.pauses.map(p => p.plate).sort(), ['WW968199', 'WW968200'], 'administrateur : tout');
    // jamais lisible sans le bon secret ; anon ne lit pas la table ; un compte en attente ne s'inscrit pas
    assert.throws(() => anon(`select public.watch_poll('${'0'.repeat(64)}')`), /watch_unknown/);
    assert.throws(() => anon('select count(*) from watch_devices'), /permission denied/);
    assert.throws(() => anon("select public.watch_register('x')"), /permission denied/);
    env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`);
    assert.throws(() => anon(`select public.watch_poll('${sec}')`), /watch_unknown/, 'compte suspendu : plus rien');
    env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, 'select count(*) from watch_devices'), '1', 'chacun voit ses téléphones');
    anon(`select public.watch_unregister('${sec}')`);
    assert.throws(() => anon(`select public.watch_poll('${sec}')`), /watch_unknown/);
  } finally { env.resetDb(); }
});

test('relais ?mode=watch : véhicule en pause qui bouge noté, course arrivée notée, mêmes règles que le site', async () => {
  seed();
  const L = await import('../supabase/functions/geotab-live/live.mjs');
  // règles du relais = règles du site (suivi_calc.js)
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(env.ROOT, 'site', 'suivi_calc.js'), 'utf8') + ';this.svMoved=svMoved;this.svArrived=svArrived;', ctx);
  const p0 = { start_lat: 33.5731, start_lon: -7.5898, started_at: iso(Date.now() - 600000) };
  [[33.5733, 'Garé', 0], [33.5831, 'En route', 42], [33.5740, 'En route', 25], [33.5760, 'Garé', 0], [33.58, 'Garé', 0]].forEach(([lat, state, speed]) => {
    const pos = { lat, lon: -7.5898, state, speed };
    const J = x => JSON.stringify(x);
    assert.strictEqual(J(L.wMoved(p0, pos, {})), J(ctx.svMoved(p0, pos, {})), J(pos));
    assert.strictEqual(L.wArrived({ dest_lat: 33.5831, dest_lon: -7.5898, started_at: p0.started_at }, pos, Date.now(), {}), ctx.svArrived({ dest_lat: 33.5831, dest_lon: -7.5898, started_at: p0.started_at }, pos, Date.now(), {}));
  });
  env.psql(`insert into missions (id, client_name, kind, total_ttc, needs_validation, level, status, vehicle_key, start_at, number)
      overriding system value values (7, 'Client Test', 'Transfert aéroport', 450, false, 'Standard', 'En cours', '968199WW', now() - interval '1 hour', 'DEV-2026-0007');
    insert into mission_tracks (mission_id, vehicle_key, plate, agency_id, driver_name, started_at, dest_label, dest_lat, dest_lon)
      values (7, '968199WW', 'WW968199', 1, 'ALPHA Test', now() - interval '30 minutes', 'Aéroport', 33.5831, -7.5898)`);
  const sec = as(MGR, "select public.watch_register('Application Android')");
  let lat = 33.5733, driving = false, geoCalls = 0;
  const fetchFn = async (url, opt) => {
    if (/geotab\.com\/apiv1$/.test(url)) {
      const b = JSON.parse(opt.body); geoCalls++;
      if (b.method === 'Authenticate') return new Response(JSON.stringify({ result: { path: 'ThisServer', credentials: { sessionId: 'S' } } }));
      return new Response(JSON.stringify({ result: b.params.calls.map(c => c.params.typeName === 'DeviceStatusInfo'
        ? [{ latitude: c.params.search.deviceSearch.id === 'b1' ? lat : 31.63, longitude: c.params.search.deviceSearch.id === 'b1' ? -7.5898 : -8.0, isDriving: driving, speed: driving ? 42 : 0, dateTime: iso(Date.now()), isDeviceCommunicating: true }] : []) }));
    }
    return fetch(url, opt);
  };
  const ENV = { SUPABASE_REST: env.POSTGREST, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: env.svcKey(), GEO_USER: 'a', GEO_PWD: 'b' };
  const call = async s => { L.resetMemory(); const r = await L.handle(new Request('http://x/functions/v1/geotab-live?mode=watch', { headers: { authorization: 'Bearer anon', 'x-ludy-watch': s } }), { env: k => ENV[k], fetch: fetchFn });
    return { status: r.status, body: await r.json() }; };
  try {
    assert.strictEqual((await call('0'.repeat(64))).status, 401);
    assert.strictEqual((await call('pas-un-secret')).status, 401);
    // immobile : rien
    let r = await call(sec);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.pauses.map(p => [p.plate, p.away, p.moved_at]), [['WW968199', false, null]], 'seulement les véhicules de ses agences');
    assert.ok(geoCalls > 0);
    // le véhicule roule : pause notée dans la base (le collecteur crée l'alerte et l'e-mail au passage suivant)
    lat = 33.5831; driving = true;
    r = await call(sec);
    assert.strictEqual(r.body.pauses[0].away, true); assert.ok(r.body.pauses[0].moved_at);
    assert.match(env.psql("select moved_m || '|' || moved_note from driver_pauses where vehicle_key = '968199WW'"), /^11\d\d\|à 1,1 km de sa place, 42 km\/h$/);
    assert.strictEqual(env.psql("select count(*) from driver_pauses where moved_at is not null"), '1', 'pause d\'une autre agence jamais touchée');
    assert.ok(!r.body.tracks[0].arrived_at, 'encore en route (42 km/h) : pas arrivée');
    // à l'arrêt près de la destination : course arrivée
    driving = false;
    r = await call(sec);
    assert.ok(r.body.tracks[0].arrived_at, 'course arrivée');
    assert.strictEqual(env.psql('select count(*) from mission_tracks where arrived_at is not null'), '1');
    // aucune pause ni course suivie : Geotab jamais appelé
    env.psql('update driver_pauses set ended_at = now(); update mission_tracks set ended_at = now()');
    geoCalls = 0; r = await call(sec);
    assert.deepStrictEqual([r.status, r.body.geo, geoCalls], [200, false, 0]);
  } finally { env.resetDb(); }
});

test('application Android 1.3 : service au premier plan, notifications, relance au démarrage, page Pauses', async () => {
  const a = p => fs.readFileSync(path.join(env.ROOT, 'android', p), 'utf8');
  const svc = a('app/src/main/java/com/ludy/flotte/WatchService.java'), main = a('app/src/main/java/com/ludy/flotte/MainActivity.java'), man = a('app/src/main/AndroidManifest.xml'), g = a('app/build.gradle');
  assert.match(man, /android:name="\.WatchService" android:exported="false" android:foregroundServiceType="dataSync"/);
  ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'POST_NOTIFICATIONS', 'WAKE_LOCK', 'RECEIVE_BOOT_COMPLETED'].forEach(x => assert.match(man, new RegExp('android\\.permission\\.' + x + '"')));
  assert.match(man, /\.BootReceiver[\s\S]*BOOT_COMPLETED/);
  assert.match(svc, /FOREGROUND_SERVICE_TYPE_DATA_SYNC/); assert.match(svc, /rpc\/watch_poll/); assert.match(svc, /geotab-live\?mode=watch/);
  assert.match(svc, /x-ludy-watch/); assert.match(svc, /IMPORTANCE_HIGH/); assert.match(svc, /Déplacement autorisé/);
  assert.match(main, /@JavascriptInterface public void watchStart\(String url, String anon, String secret\)/);
  assert.match(main, /@JavascriptInterface public String watchStop\(\)/); assert.match(main, /@JavascriptInterface public String watchStatus\(\)/);
  assert.match(main, /LudyAndroid\/1\.3/); assert.match(main, /onNewIntent/);
  assert.match(g, /versionName '1\.3'/); assert.ok(+g.match(/versionCode (\d+)/)[1] >= 4);
  // date de la base lue par le service : fraction de 0 à 6 chiffres
  const re = /Pattern\.compile\("(.*)"\)\.matcher/.exec(svc)[1].replace(/\\\\/g, '\\');
  ['2026-11-14T17:35:12+00:00', '2026-11-14T17:35:12.1+00:00', '2026-11-14T17:35:12.123456+01:00', '2026-11-14 17:35:12Z'].forEach(s => assert.match(s, new RegExp(re), s));

  // site : panneau d'activation dans Pauses (application Android), secret donné au téléphone, retiré à l'arrêt
  env.resetDb();
  const srv = await startSite(), { br, page, errors } = await openBrowser({ viewport: { width: 400, height: 860 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 LudyAndroid/1.3' });
  try {
    await page.context().addInitScript(() => { window.__uiDialogs = true; window.__w = { on: false };
      window.LudyAndroid = { share() { }, save() { }, watchStart(u, k, s) { window.__w = { on: true, u, k, s, last: Date.now() }; },
        watchStop() { const s = window.__w.s; window.__w = { on: false }; return s; }, watchStatus() { return JSON.stringify({ on: window.__w.on, notif: true, battery: false, last: window.__w.last || 0 }); },
        watchBattery() { window.__bat = 1; }, watchNotifSettings() { } }; });
    await page.goto('http://localhost:8080/#/suivi');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#svwon');
    await page.click('#svwon');
    await page.waitForSelector('.svwatch.on');
    const w = await page.evaluate(() => window.__w);
    assert.match(w.s, /^[0-9a-f]{64}$/); assert.match(w.u, /^https?:\/\//); assert.ok(w.k);
    assert.strictEqual(env.psql('select count(*) from watch_devices'), '1');
    assert.match(await page.innerText('.svwatch'), /Économie de batterie active/);
    await page.click('#svwbat'); assert.strictEqual(await page.evaluate(() => window.__bat), 1);
    await page.click('#svwoff'); await page.click('#uiok');
    await page.waitForSelector('#svwon');
    for (let i = 0; i < 20 && env.psql('select count(*) from watch_devices') !== '0'; i++) await page.waitForTimeout(200);
    assert.strictEqual(env.psql('select count(*) from watch_devices'), '0', 'secret retiré de la base');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
