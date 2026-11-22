// Courses Uber suspectes (22/11/2026, demande d'Ahmed) : « en route vers le client » puis disponible / hors ligne sans course = cas enregistré
// par la base (déclencheur sur uber_live_log), km Geotab mesurés par le collecteur, alerte rouge sur le site, page #/suspects. Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const asErr = (uid, sql) => { try { as(uid, sql); return ''; } catch (e) { return String(e.stderr || e.message || e); } };
const push = (uid, rows) => as(uid, `select public.uber_live_push('${JSON.stringify(rows)}'::jsonb, 'Mac', '', '', true)`);
const back = (min) => env.psql(`update uber_live_log set started_at = started_at - interval '${min} minutes', ended_at = ended_at - interval '${min} minutes';
  update uber_live set observed_at = observed_at - interval '${min} minutes', status_since = status_since - interval '${min} minutes'`);
function setup() {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, name, role) values ('${ADMIN}', 'admin@x', 'Ahmed', 'admin'), ('${MGR}', 'new@x', 'Karim', 'manager') on conflict (user_id) do update set role = excluded.role;
    insert into agencies (id, name) overriding system value values (1, 'Casablanca'), (2, 'Marrakech');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id, geotab_id) values ('968211WW', 'WW968211', 'SONATA', 'OUI', 1, 'b1'), ('968212WW', 'WW968212', 'SONATA', 'OUI', 2, 'b2');`);
}

test('base : en route puis disponible = cas (Suspect ≥ 60 s, Info sinon), en route puis course = rien, disparitions en masse ignorées, droits', () => {
  setup();
  try {
    // 968211 : en route 3 min puis disponible (position Uber gardée)
    push(ADMIN, [{ plate: 'WW968211', status: 'to_pickup', driver: '97b48f1d-06da-4c89-8310-fe49bfd8b16a', name: 'Aymane', lat: 31.63, lng: -8.01 }]); back(3);
    push(ADMIN, [{ plate: 'WW968211', status: 'available', name: 'Aymane', lat: 31.6305, lng: -8.0102 }]);
    assert.strictEqual(env.psql("select plate || '|' || driver_name || '|' || level || '|' || next_status || '|' || round(extract(epoch from route_to - route_from)) || '|' || lat || '|' || agency_id || '|' || (win_until - next_at) from uber_suspects"),
      'WW968211|Aymane|Suspect|available|180|31.63|1|00:20:00');
    // en route 20 s puis hors ligne = Info (annulation immédiate) ; en route puis course en cours = rien
    env.psql("truncate uber_suspects; delete from uber_live_log; delete from uber_live");
    push(ADMIN, [{ plate: 'WW968211', status: 'to_pickup' }]); env.psql("update uber_live_log set started_at = started_at - interval '20 seconds'; update uber_live set status_since = status_since - interval '20 seconds'");
    push(ADMIN, [{ plate: 'WW968211', status: 'offline' }]);
    assert.strictEqual(env.psql('select level || next_status from uber_suspects'), 'Infooffline');
    push(ADMIN, [{ plate: 'WW968212', status: 'to_pickup' }]); back(2); push(ADMIN, [{ plate: 'WW968212', status: 'on_trip' }]);
    assert.strictEqual(env.psql('select count(*) from uber_suspects'), '1');
    // lecture d'Uber Fleet interrompue : toutes les plaques « gone » en même temps = aucun cas
    env.psql("truncate uber_suspects; delete from uber_live_log; delete from uber_live");
    push(ADMIN, [{ plate: 'WW968211', status: 'to_pickup' }, { plate: 'WW968212', status: 'to_pickup' }, { plate: 'WW968213', status: 'to_pickup' }]); back(3);
    push(ADMIN, [{ plate: 'WW968299', status: 'available' }]);
    assert.strictEqual(env.psql("select count(*) from uber_live_log where status = 'gone'"), '3');
    assert.strictEqual(env.psql('select count(*) from uber_suspects'), '0', 'disparitions en masse ignorées');
    // une seule plaque disparue (plus affichée depuis 2 min) = cas
    env.psql("delete from uber_live_log; delete from uber_live");
    push(ADMIN, [{ plate: 'WW968211', status: 'to_pickup', name: 'Aymane' }, { plate: 'WW968212', status: 'available' }]); back(5);
    env.psql("update uber_live set observed_at = observed_at + interval '2 minutes'");   // vue en route pendant 2 min, puis plus affichée depuis 3 min
    push(ADMIN, [{ plate: 'WW968212', status: 'available' }]);
    assert.strictEqual(env.psql("select next_status || '|' || level from uber_suspects"), 'gone|Suspect');
    // droits : gestionnaire = ses agences ; classement par l'administrateur et le gestionnaire concerné
    push(ADMIN, [{ plate: 'WW968212', status: 'to_pickup' }]); back(3); push(ADMIN, [{ plate: 'WW968212', status: 'available' }]);
    assert.strictEqual(env.psql('select count(*) from uber_suspects'), '2');
    assert.strictEqual(as(MGR, 'select string_agg(plate, \',\') from uber_suspects'), 'WW968211', 'gestionnaire de Casablanca : son véhicule seulement');
    const id1 = env.psql("select id from uber_suspects where plate = 'WW968211'"), id2 = env.psql("select id from uber_suspects where plate = 'WW968212'");
    as(MGR, `select uber_suspect_set(${id1}, 'Confirmé', 'Client repris en cachette')`);
    assert.strictEqual(env.psql(`select status || '|' || comment || '|' || (checked_by = '${MGR}') from uber_suspects where id = ${id1}`), 'Confirmé|Client repris en cachette|true');
    assert.match(asErr(MGR, `select uber_suspect_set(${id2}, 'Justifié', '')`), /refusé/);
    assert.match(asErr(ADMIN, `select uber_suspect_set(${id2}, 'Bidon', '')`), /inconnu/);
    as(ADMIN, `select uber_suspect_set(${id2}, 'Justifié', 'Client absent')`);
    assert.strictEqual(env.psql(`select status from uber_suspects where id = ${id2}`), 'Justifié');
  } finally { env.resetDb(); }
});

test('collecteur : km Geotab après le changement (hors course Uber), verdict roulé / sur place / non mesuré, fenêtre en cours', () => {
  const { collector } = require('./lib/v6');
  const NOW = Date.UTC(2026, 10, 22, 12, 0), B = collector(NOW), iso = t => new Date(t).toISOString();   // collector() vide la base : données après
  setup();
  // calcul pur
  const K = (logs, busy, o) => JSON.parse(B.run('JSON.stringify(suspKm_(' + JSON.stringify(logs) + ',' + JSON.stringify(busy) + ',' + JSON.stringify(o) + '))'));
  let r = K([{ t: 0, lat: 31.6, lon: -8.0 }, { t: 60000, lat: 31.609, lon: -8.0 }, { t: 120000, lat: 31.618, lon: -8.0 }, { t: 180000, lat: 31.618, lon: -8.0 }], [{ a: 100000, b: 200000 }], { lat: 31.6, lon: -8.0 });
  assert.deepStrictEqual([r.km, r.kmFree, r.n], [2, 1, 4], '2 km en tout, 1 km hors course Uber'); assert.ok(r.movedM > 1900 && r.movedM < 2100);
  r = K([{ t: 0, lat: 31.6, lon: -8.0 }, { t: 60000, lat: 32.6, lon: -8.0 }], [], null); assert.strictEqual(r.km, 0, 'saut GPS aberrant ignoré');
  assert.deepStrictEqual(K([], [], null), { km: 0, kmFree: 0, movedM: 0, n: 0 });
  // trois cas : 968211 a roulé 2,5 km (fenêtre écoulée) ; 968212 resté sur place ; un cas trop récent (3 min) : attendu
  env.psql(`insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, ended_at, lat1, lng1) values
      ('968211WW', 'WW968211', '968211WW', 1, 'Aymane', 'to_pickup', '${iso(NOW - 35 * 60000)}', '${iso(NOW - 30 * 60000)}', 31.6, -8.0),
      ('968212WW', 'WW968212', '968212WW', 2, 'Saber', 'to_pickup', '${iso(NOW - 35 * 60000)}', '${iso(NOW - 30 * 60000)}', 31.7, -8.1);
    insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at) values
      ('968211WW', 'WW968211', '968211WW', 1, 'Aymane', 'available', '${iso(NOW - 30 * 60000)}'), ('968212WW', 'WW968212', '968212WW', 2, 'Saber', 'available', '${iso(NOW - 30 * 60000)}');`);
  env.psql(`update uber_suspects set km_done = false;
    insert into uber_suspects (plate_key, plate, vehicle_key, agency_id, driver_name, route_from, route_to, lat, lng, next_status, next_at, level, win_until) values
      ('968211WW', 'WW968211', '968211WW', 1, 'Aymane', '${iso(NOW - 10 * 60000)}', '${iso(NOW - 2 * 60000)}', 31.6, -8.0, 'available', '${iso(NOW - 2 * 60000)}', 'Suspect', '${iso(NOW + 18 * 60000)}');`);
  assert.strictEqual(env.psql('select count(*) from uber_suspects'), '3', 'deux cas créés par le déclencheur, un inséré');
  // positions Geotab : 968211 roule 2,5 km vers le nord en 10 min, 968212 ne bouge pas (dérive de 40 m)
  B.run(`geoCall_ = function (m, p) { if (!p || p.typeName !== 'LogRecord') return []; const a = Date.parse(p.search.fromDate), id = p.search.deviceSearch.id, out = [];
    for (let i = 0; i <= 10; i++) out.push({ dateTime: new Date(a + i * 60000).toISOString(), latitude: id === 'b1' ? 31.6 + i * 0.00225 : 31.7 + (i % 2) * 0.00036, longitude: id === 'b1' ? -8.0 : -8.1, speed: id === 'b1' ? 40 : 0 }); return out; }`);
  try {
    assert.strictEqual(B.run('suspectKmStep_()'), 'Courses suspectes : 2 mesurée(s), dont 1 avec déplacement sans course Uber');
    const rows = Object.fromEntries(env.psql("select plate || '=' || coalesce(km_after::text, '-') || '|' || coalesce(km_free::text, '-') || '|' || coalesce(moved_m::text, '-') || '|' || km_done || '|' || coalesce(verdict, '-') || '|' || coalesce(km_note, '-') from uber_suspects order by plate").split('\n').map(l => l.split('=')));
    assert.match(rows.WW968211, /^2\.5\|2\.5\|25\d\d\|true\|roulé\|2,5 km parcourus en 20 min après le passage en Disponible, dont 2,5 km hors course Uber \(jusqu'à 2,5 km du lieu\) : le véhicule a roulé sans course Uber/);
    assert.match(rows.WW968212, /^0\.?\d*\|0\.?\d*\|40\|true\|sur place\|.*resté sur place/);
    assert.strictEqual(env.psql(`select km_done || '|' || coalesce(verdict, '-') from uber_suspects where route_to = '${iso(NOW - 2 * 60000)}'`), 'false|-', 'cas trop récent : au passage suivant');
    // course Uber acceptée pendant la fenêtre : ses km ne comptent pas
    env.psql(`update uber_suspects set km_done = false, verdict = null where plate = 'WW968211';
      insert into uber_live_log (plate_key, plate, vehicle_key, status, started_at, ended_at) values ('968211WW', 'WW968211', '968211WW', 'on_trip', '${iso(NOW - 28 * 60000)}', '${iso(NOW - 20 * 60000)}')`);
    B.run('suspectKmStep_()');
    assert.match(env.psql("select km_after || '|' || km_free || '|' || verdict from uber_suspects where plate = 'WW968211'"), /^2\.5\|0\.[0-9]|sur place$/);
    // véhicule sans boîtier : non mesuré une fois la fenêtre écoulée
    env.psql("update vehicles set geotab_id = null where key = '968212WW'; update uber_suspects set km_done = false, verdict = null, km_after = null where plate = 'WW968212'");
    B.run('memoClear_(); suspectKmStep_()');
    assert.strictEqual(env.psql("select verdict || '|' || km_note from uber_suspects where plate = 'WW968212'"), 'non mesuré|Véhicule sans boîtier Geotab : non mesuré');
  } finally { env.resetDb(); }
});

test('site : alerte rouge à l\'instant sur toutes les pages, seconde alerte « a roulé », fiche En direct, page des cas (classement, PDF)', async () => {
  setup();
  const srv = await startSite('admin'), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => typeof PS !== 'undefined' && PS.primed);
    // nouveau cas pendant que Ludy est ouvert : bandeau rouge (relecture toutes les 30 s : forcée)
    push(ADMIN, [{ plate: 'WW968211', status: 'to_pickup', name: 'Aymane', lat: 31.63, lng: -8.01 }]); back(4);
    push(ADMIN, [{ plate: 'WW968211', status: 'available', name: 'Aymane' }]);
    await page.evaluate(() => psTick());
    await page.waitForSelector('.toast.pstoast');
    const t = (await page.innerText('.toast.pstoast')).replace(/\s+/g, ' ');
    assert.match(t, /COURSE SUSPECTE[\s\S]*Aymane[\s\S]*WW968211/); assert.match(t, /En route vers le client de \d\d:\d\d à \d\d:\d\d \(4 min[^)]*\), puis Disponible sans course en cours/); assert.match(t, /mesure en cours/);
    // fiche du véhicule et bloc d'En direct
    await page.waitForFunction(() => /Course suspecte/.test(document.querySelector('#vlist') ? document.querySelector('#vlist').innerText : ''));
    assert.match(await page.innerText('#livesusp'), /Courses suspectes \(3 dernières heures\) : 1/);
    // le collecteur mesure : a roulé = seconde alerte rouge
    env.psql("update uber_suspects set km_after = 3.1, km_free = 3.1, moved_m = 2200, km_done = true, verdict = 'roulé', km_note = '3,1 km parcourus en 20 min après le passage en Disponible, dont 3,1 km hors course Uber (jusqu''à 2,2 km du lieu) : le véhicule a roulé sans course Uber (course cachée probable)'");
    await page.evaluate(() => psTick());
    await page.waitForFunction(() => /A ROULÉ SANS COURSE UBER/.test(document.querySelector('#toasts') ? document.querySelector('#toasts').innerText : ''));
    assert.match((await page.innerText('#toasts')).replace(/\s+/g, ' '), /3,1 km hors course Uber/);
    await page.waitForFunction(() => /A roulé sans course Uber|3,1 km/.test(document.querySelector('#vlist').innerText));
    // page des cas : annulation Uber rapprochée, classement, PDF
    env.psql(`insert into uber_trips (uuid, agency_id, vehicle_key, plate, driver_name, requested_at, status, km) values ('t1', 1, '968211WW', 'WW968211', 'Aymane', now() - interval '5 minutes', 'rider_cancelled', null)`);
    await page.click('.toast.pstoast a.btn');
    await page.waitForSelector('#tpsl');
    const b = (await page.innerText('#psbody')).replace(/\s+/g, ' ');
    assert.match(b, /1 Cas 1 A roulé sans course Uber 0 Confirmés 1 À vérifier/); assert.match(b, /Aymane[\s\S]*WW968211/); assert.match(b, /par le client/); assert.match(b, /3,1 km hors course Uber \(jusqu'à 2,2 km du lieu\)/);
    await page.selectOption('.pssel', 'Confirmé'); await page.fill('.pscom', 'Client repris hors application'); await page.press('.pscom', 'Enter'); await page.dispatchEvent('.pscom', 'change');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(500);
    assert.strictEqual(env.psql("select status || '|' || comment from uber_suspects"), 'Confirmé|Client repris hors application');
    const dl = page.waitForEvent('download'); await page.click('#pspdf'); assert.match((await dl).suggestedFilename(), /^courses_suspectes_.*\.pdf$/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
