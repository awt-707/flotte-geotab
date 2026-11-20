// Zones Uber (20/11/2026, demande d'Ahmed : zones de prise en charge par jour et heure, « nuage de zones de travail »).
// Positions des états Uber enregistrées par uber_live_push, calcul uber_zones / uber_demand (heure du Maroc), page #/zones. Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), Z = require('../site/zones_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);

test('calculs des zones : créneau (passage de minuit), moyennes mesurées, classement, paliers, demande par heure', () => {
  const s = Z.znSlot([6, 7], 22, 1);
  assert.deepStrictEqual([...s.days], [6, 7]); assert.deepStrictEqual([...s.hours], [22, 23, 0, 1]);
  const rows = [
    { kind: 'pickup', cy: 1, cx: 1, dow: 6, hour: 23, n: 6, v: 120 }, { kind: 'wait', cy: 1, cx: 1, dow: 6, hour: 23, n: 4, v: 20 }, { kind: 'idle', cy: 1, cx: 1, dow: 6, hour: 23, n: 1, v: 30 },
    { kind: 'approach', cy: 1, cx: 1, dow: 6, hour: 23, n: 5, v: 6 },
    { kind: 'pickup', cy: 2, cx: 2, dow: 6, hour: 0, n: 8, v: null }, { kind: 'wait', cy: 2, cx: 2, dow: 6, hour: 0, n: 2, v: 30 },
    { kind: 'pickup', cy: 3, cx: 3, dow: 6, hour: 0, n: 1, v: 10 },
    { kind: 'pickup', cy: 1, cx: 1, dow: 2, hour: 10, n: 50, v: 500 }, { kind: 'autre', cy: 9, cx: 9, dow: 6, hour: 23, n: 3 }];
  const cells = Z.znCells(rows, s), c1 = cells.find(c => c.key === '1:1'), c2 = cells.find(c => c.key === '2:2');
  assert.strictEqual(cells.length, 3, 'hors créneau et mesure inconnue ignorés');
  assert.deepStrictEqual([c1.pickup, c1.avgWait, c1.avgTrip, c1.avgApp, c1.hitRate], [6, 5, 20, 1.2, 0.8]);
  assert.deepStrictEqual([c2.avgTrip, c2.avgWait], [null, 15], 'durée de course non mesurée : pas de moyenne');
  const r = Z.znRank(cells, 2, 3);
  assert.deepStrictEqual(r.map(c => c.key + ':' + c.perWeek + (c.few ? ':peu' : '')), ['2:2:4', '1:1:3', '3:3:0.5:peu'], 'par prises en charge / semaine, peu de données en dernier');
  assert.strictEqual(Z.znWeeks('2026-11-01T00:00:00Z', '2026-11-29T00:00:00Z', '2026-11-15T00:00:00Z'), 2, 'depuis la première position enregistrée');
  assert.strictEqual(Z.znWeeks('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', null), 1, 'au moins une semaine');
  assert.deepStrictEqual(Z.znBounds(6326, -1603, 0.005).map(p => p.map(x => +x.toFixed(3))), [[31.63, -8.015], [31.635, -8.01]]);
  const st = Z.znSteps([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepStrictEqual(st, [3, 5, 7, 9]);
  assert.deepStrictEqual([Z.znLevel(1, st), Z.znLevel(10, st), Z.znLevel(1, st, true), Z.znLevel(null, st)], [0, 4, 4, -1]);
  const g = Z.znDemandGrid([{ dow: 1, hour: 8, done: 3, rider_cancel: 1, driver_cancel: 0, other: 0, km: 12 }, { dow: 9, hour: 1, done: 5 }]);
  assert.deepStrictEqual(g[0][8], { done: 3, rc: 1, dc: 0, other: 0, km: 12 });
});

test('positions des états Uber enregistrées, zones et demande à l\'heure du Maroc, droits par agence, page Zones Uber', async () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Marrakech');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id) values ('968211WW', 'WW968211', 'SONATA', 'OUI', 2), ('968212WW', 'WW968212', 'SONATA', 'OUI', 1);
    insert into params (key, value) values ('tzRules', '[[0,60]]') on conflict (key) do update set value = excluded.value;`);
  try {
    const push = (st, lat, lng) => as(ADMIN, `select public.uber_live_push('[{"plate":"WW968211","status":"${st}","driver":"97B48F1D-06DA-4C89-8310-FE49BFD8B16A","lat":${lat},"lng":${lng}}]'::jsonb, 'Mac', '', '', true)`);
    push('available', 31.6301, -8.0101); push('available', 31.6302, -8.0102);
    push('to_pickup', 31.6303, -8.0103); push('to_pickup', 31.6400, -8.0200);
    push('on_trip', 31.6401, -8.0201); push('on_trip', 31.6000, -8.0500);
    push('available', 31.6001, -8.0501);
    assert.strictEqual(env.psql("select string_agg(status || ':' || lat0 || ',' || lng0 || '>' || lat1 || ',' || lng1 || ':' || driver_id, ' ' order by id) from uber_live_log"),
      'available:31.6301,-8.0101>31.6302,-8.0102:97b48f1d-06da-4c89-8310-fe49bfd8b16a to_pickup:31.6303,-8.0103>31.64,-8.02:97b48f1d-06da-4c89-8310-fe49bfd8b16a on_trip:31.6401,-8.0201>31.6,-8.05:97b48f1d-06da-4c89-8310-fe49bfd8b16a available:31.6001,-8.0501>31.6001,-8.0501:97b48f1d-06da-4c89-8310-fe49bfd8b16a',
      'position au début et dernière position de chaque état, identifiant du chauffeur');
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW968211","status":"available","lat":"x","lng":200}]'::jsonb, 'Mac', '', '', true)`);
    assert.strictEqual(env.psql("select lat1 from uber_live_log where ended_at is null"), '31.6001', 'position illisible : ignorée');
    // période connue : 18/11/2026 (mercredi) 10 h UTC = 11 h au Maroc (+60 de la table)
    env.psql(`truncate uber_live_log;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, status, started_at, ended_at, lat0, lng0, lat1, lng1) values
       ('968211WW','WW968211','968211WW',2,'available','2026-11-18 10:00Z','2026-11-18 10:12Z',31.6301,-8.0101,31.631,-8.011),
       ('968211WW','WW968211','968211WW',2,'to_pickup','2026-11-18 10:12Z','2026-11-18 10:18Z',31.631,-8.011,31.6401,-8.0201),
       ('968211WW','WW968211','968211WW',2,'on_trip','2026-11-18 10:18Z','2026-11-18 10:40Z',31.6401,-8.0201,31.6001,-8.0501),
       ('968211WW','WW968211','968211WW',2,'available','2026-11-18 10:40Z','2026-11-18 11:00Z',31.6001,-8.0501,31.6001,-8.0501),
       ('968211WW','WW968211','968211WW',2,'gone','2026-11-18 11:00Z',null,null,null,null,null),
       ('968212WW','WW968212','968212WW',1,'to_pickup','2026-11-18 10:00Z','2026-11-18 10:05Z',34.0,-6.8,34.01,-6.81),
       ('968212WW','WW968212','968212WW',1,'on_trip','2026-11-18 10:05Z',null,34.01,-6.81,34.02,-6.82);
      insert into uber_trips (uuid, agency_id, vehicle_key, requested_at, status, km) values ('t1', 2, '968211WW', '2026-11-18 10:12Z', 'completed', 5.5),
        ('t2', 2, '968211WW', '2026-11-18 10:50Z', 'rider_cancelled', null), ('t3', 1, '968212WW', '2026-11-18 22:30Z', 'completed', 3);`);
    const z = (uid, a) => as(uid, `select string_agg(kind || ':' || cy || ':' || cx || ':' || dow || ':' || hour || ':' || n || ':' || coalesce(round(v::numeric, 2)::text, '-'), ' ' order by kind, cy) from uber_zones('2026-11-18', '2026-11-19'${a ? ', ' + a : ''})`);
    assert.strictEqual(z(ADMIN, 2), 'approach:6326:-1603:3:11:1:1.33 dropoff:6320:-1611:3:11:1:- idle:6320:-1611:3:11:1:20.00 pickup:6328:-1605:3:11:1:22.00 wait:6326:-1603:3:11:1:12.00',
      'prise en charge = début de la course, attente finie par une demande, disponible puis déconnecté, approche en km');
    assert.match(z(ADMIN), /pickup:6801:-1362:3:11:1:-/, 'course en cours : prise en charge sans durée');
    assert.strictEqual(z(MGR), 'approach:6800:-1360:3:11:1:1.44 pickup:6801:-1362:3:11:1:-', 'gestionnaire de Rabat : ses véhicules seulement');
    assert.strictEqual(as(ADMIN, "select string_agg(dow || ':' || hour || ':' || done || ':' || rider_cancel || ':' || coalesce(km::text, '-'), ' ' order by dow, hour) from uber_demand('2026-11-18', '2026-11-20')"),
      '3:11:1:1:5.5 3:23:1:0:3', 'demande par jour et heure du Maroc (22:30 UTC = 23 h)');
    assert.strictEqual(env.psql("select public.ma_offset_min('2026-11-18 10:00Z', '[[0,0],[1795000000000,60]]'::jsonb) || ',' || public.ma_offset_min(now(), null)"), '0,60');

    // page : créneau mercredi 11 h, classement et carte
    const srv = await startSite(), { br, page, errors } = await openBrowser();
    try {
      await page.addInitScript(() => { localStorage.setItem('zn.days', '[3]'); localStorage.setItem('zn.h1', '11'); localStorage.setItem('zn.h2', '11'); localStorage.setItem('zn.weeks', '26'); });
      await page.route('https://photon.komoot.io/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [{ properties: { name: 'Gare de Marrakech', city: 'Marrakech' } }] }) }));
      await login(page, '#/zones');
      await page.waitForSelector('#znmap');
      const t = (await page.innerText('#page')).replace(/\s+/g, ' ');
      assert.match(t, /Où envoyer les chauffeurs disponibles/);
      assert.match(t, /Créneau : mercredi, de 11 h à 12 h/);
      await page.waitForFunction(() => /Gare de Marrakech/.test(document.querySelector('#tzones') ? document.querySelector('#tzones').innerText : ''));
      assert.strictEqual(await page.locator('#tzones tbody tr').count(), 2);
      assert.ok(await page.locator('#znmap path.leaflet-interactive').count() >= 2, 'cases dessinées sur la carte');
      assert.match(t, /Demandes Uber par jour et par heure/);
      assert.strictEqual(await page.locator('.zndem td.insl').count(), 1, 'créneau encadré');
      await page.selectOption('#znl', 'wait');
      await page.waitForSelector('#znleg >> text=Attente avant une demande');
      assert.deepStrictEqual(errors, []);
    } finally { await br.close(); srv.kill(); }
  } finally { env.resetDb(); }
});
