// Pauses chauffeurs et suivi des courses privées (14/11/2026, demande d'Ahmed) : calculs, droits de la base, page et alertes plein écran.
// Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');
const C = require('../site/suivi_calc.js');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const MIN = 60000;

test('calculs : 2 h par shift, rappels toutes les 30 min, véhicule qui bouge, arrivée, km GPS', () => {
  const now = Date.parse('2026-11-14T12:00:00Z'), iso = t => new Date(t).toISOString();
  const ps = [{ id: 1, driver_code: 'C1', shift_day: '2026-11-14', shift: 'Jour', started_at: iso(now - 200 * MIN), ended_at: iso(now - 170 * MIN), planned_min: 30 },
    { id: 2, driver_code: 'C1', shift_day: '2026-11-14', shift: 'Jour', started_at: iso(now - 50 * MIN), planned_min: 60 },
    { id: 3, driver_code: 'C1', shift_day: '2026-11-13', shift: 'Nuit', started_at: iso(now - 900 * MIN), ended_at: iso(now - 800 * MIN), planned_min: 100 },
    { id: 4, driver_code: 'C1', shift_day: '2026-11-14', shift: 'Jour', started_at: iso(now - 100 * MIN), ended_at: iso(now - 90 * MIN), planned_min: 30, end_reason: 'Annulée' }];
  assert.strictEqual(Math.round(C.svUsedMin(ps, 'C1', '2026-11-14', 'Jour', now)), 80, '30 min finies + 50 min en cours ; nuit d\'hier et pause annulée hors compte');
  assert.strictEqual(Math.round(C.svLeftMin(ps, 'C1', '2026-11-14', 'Jour', now, {})), 40);
  assert.strictEqual(C.svLeftMin(ps, 'C1', '2026-11-13', 'Nuit', now, { pauseShiftMin: '90' }), 0, 'jamais négatif');
  assert.deepStrictEqual(C.svReminders({ started_at: iso(now - 95 * MIN), planned_min: 120 }, now, {}), [30, 60, 90]);
  assert.deepStrictEqual(C.svReminders({ started_at: iso(now - 95 * MIN), planned_min: 60 }, now, {}), [30], 'pas de rappel à la fin : c\'est l\'alerte de fin');
  assert.strictEqual(C.svPauseState({ started_at: iso(now - 61 * MIN), planned_min: 60 }, now).over, true);
  const p = { started_at: iso(now - 10 * MIN), planned_min: 30, start_lat: 33.5731, start_lon: -7.5898 };
  assert.strictEqual(C.svMoved(p, { lat: 33.5735, lon: -7.5900, state: 'Garé', speed: 0 }, {}), null, '50 m : GPS qui flotte, pas d\'alerte');
  assert.match(C.svMoved(p, { lat: 33.5831, lon: -7.5898, state: 'En route', speed: 42 }, {}).why, /1,1 km de sa place, 42 km\/h/);
  assert.match(C.svMoved(Object.assign({}, p, { start_lat: null }), { lat: 1, lon: 1, state: 'En route', speed: 25 }, {}).why, /en route à 25 km\/h/);
  const tr = { started_at: iso(now - 30 * MIN), dest_lat: 33.3675, dest_lon: -7.5898 };
  assert.strictEqual(C.svArrived(tr, { lat: 33.3690, lon: -7.5898, state: 'Arrêté, contact mis', speed: 0 }, now, {}), 167);
  assert.strictEqual(C.svArrived(tr, { lat: 33.40, lon: -7.5898, state: 'En route', speed: 80 }, now, {}), null);
  assert.strictEqual(C.svArrived(Object.assign({}, tr, { started_at: iso(now - MIN) }), { lat: 33.3675, lon: -7.5898 }, now, {}), null, 'tout juste parti');
  let pts = C.svAddPoint([], { lat: 33.5731, lon: -7.5898 }, 'a'); pts = C.svAddPoint(pts, { lat: 33.5732, lon: -7.5898 }, 'b'); pts = C.svAddPoint(pts, { lat: 33.5821, lon: -7.5898 }, 'c');
  assert.strictEqual(pts.length, 2, 'point à moins de 30 m ignoré'); assert.strictEqual(C.svKm(pts), 1);
  assert.strictEqual(C.svClock(65 * 1000), '01:05'); assert.strictEqual(C.svClock(-90 * 1000), '+01:30'); assert.strictEqual(C.svClock(3723 * 1000), '1:02:03');
  const st = C.svStats(ps.concat([{ id: 5, driver_code: 'C1', shift_day: '2026-11-14', shift: 'Jour', started_at: iso(now - 300 * MIN), ended_at: iso(now - 210 * MIN), planned_min: 60, moved_at: iso(now - 250 * MIN) }]), now, {});
  const day = st.find(g => g.shift_day === '2026-11-14');
  assert.deepStrictEqual([day.n, day.min, day.over, day.moved, day.late], [3, 170, 50, 1, 1]);
  assert.match(C.svWaPauseEnd({ driver_name: 'ALPHA', plate: 'WW1', started_at: iso(now - 70 * MIN), planned_min: 60 }, now), /FIN DE PAUSE[\s\S]*ALPHA[\s\S]*depuis 10 min[\s\S]*WW1/);
});

test('base : gestionnaire = véhicules de ses agences, une pause ouverte par véhicule, heure de la base', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, agency_id) values ('V1', 'WW1', 1), ('V2', 'WW2', 2);`);
  try {
    as(MGR, "insert into driver_pauses (agency_id, vehicle_key, plate, driver_name, shift_day, shift, planned_min) values (1, 'V1', 'WW1', 'Ali', '2026-11-14', 'Jour', 30)");
    assert.strictEqual(env.psql("select (abs(extract(epoch from now() - started_at)) < 60)::text || '|' || created_by::text from driver_pauses"), 'true|' + MGR, 'heure et auteur posés par la base');
    assert.throws(() => as(MGR, "insert into driver_pauses (vehicle_key, shift_day, shift, planned_min) values ('V1', '2026-11-14', 'Jour', 30)"), /one_open|duplicate/, 'déjà en pause');
    assert.throws(() => as(MGR, "insert into driver_pauses (agency_id, vehicle_key, shift_day, shift, planned_min) values (2, 'V2', '2026-11-14', 'Jour', 30)"), /row-level security/, 'autre agence');
    assert.throws(() => as(MGR, "update driver_pauses set started_at = now() - interval '3 hours'"), /permission denied/, 'début non modifiable');
    as(MGR, "update driver_pauses set ended_at = now() + interval '2 hours', end_reason = 'Terminée par le gestionnaire'");
    assert.strictEqual(env.psql('select ended_at <= now() and ended_by is not null from driver_pauses'), 't', 'fin jamais dans le futur');
    assert.throws(() => as(MGR, "update driver_pauses set ended_at = now() - interval '1 hour'"), /déjà terminé/);
    as(MGR, 'delete from driver_pauses');   // règle : seul l'administrateur efface (aucune ligne visible à effacer pour le gestionnaire)
    assert.strictEqual(env.psql('select count(*) from driver_pauses'), '1');
    // suivi de course : course de son agence seulement
    env.psql("insert into missions (id, agency_id, client_name, vehicle_key, status, start_at, end_at) values (1, 1, 'Client A', 'V1', 'Confirmée', now(), now() + interval '2 hours'), (2, 2, 'Client B', 'V2', 'Confirmée', now(), now() + interval '2 hours')");
    as(MGR, "insert into mission_tracks (mission_id, agency_id, vehicle_key, plate, dest_label) values (1, 1, 'V1', 'WW1', 'Aéroport')");
    assert.throws(() => as(MGR, "insert into mission_tracks (mission_id, agency_id, vehicle_key) values (2, 2, 'V2')"), /row-level security/);
    assert.throws(() => as(MGR, "insert into mission_tracks (mission_id, agency_id, vehicle_key) values (1, 1, 'V1')"), /one_open|duplicate/, 'course déjà suivie');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); env.psql('truncate missions restart identity cascade'); }
});

test('site : pause déclenchée, alerte rouge de fin de pause, véhicule en pause qui bouge, course suivie jusqu\'à l\'arrivée', async () => {
  env.resetDb();
  const start = new Date(Date.now() - 3 * 3600000).toISOString(), end = new Date(Date.now() + 6 * 3600000).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI'), ('968200WW', 'WW968200', 'STARIA', 'OUI');
    insert into drivers (code, name, phone) values ('C1', 'ALPHA Test', '0612345678'), ('C2', 'BRAVO Test', '0698765432');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K1', 'C1', 'ALPHA Test', 'WW968199', '968199WW', '${start}', '${end}'), ('K2', 'C2', 'BRAVO Test', 'WW968200', '968200WW', '${start}', '${end}');
    insert into missions (id, client_name, client_phone, vehicle_key, driver_name, status, start_at, end_at, data) values
      (7, 'Client Test', '0611111111', '968200WW', 'BRAVO Test', 'Confirmée', now() - interval '10 minutes', now() + interval '2 hours', '{"f": {"startAddr": "Gare Casa Port", "endAddr": "Aéroport Mohammed V", "driverPhone": "0698765432"}}');`);
  // positions Geotab simulées : WW968199 garé place A ; WW968200 en route
  let pos = { '968199WW': { key: '968199WW', plate: 'WW968199', state: 'Garé', speed: 0, lat: 33.5731, lon: -7.5898, at: new Date().toISOString() },
    '968200WW': { key: '968200WW', plate: 'WW968200', state: 'En route', speed: 60, lat: 33.5, lon: -7.6, at: new Date().toISOString() } };
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => { window.__uiDialogs = true; });
    await page.route('**/functions/v1/geotab-live**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ at: new Date().toISOString(), vehicles: Object.values(pos), events: [] }) }));
    await page.route('https://photon.komoot.io/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { coordinates: [-7.5898, 33.3675] }, properties: { name: 'Aéroport Mohammed V', city: 'Nouaceur' } }] }) }));
    await page.goto('http://localhost:8080/#/suivi');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('[data-go="968199WW"]');
    assert.match(await page.innerText('.svlist'), /WW968199[\s\S]*ALPHA Test[\s\S]*reste 120 min/);
    // pause de 30 min
    await page.selectOption('#svdur', '30');
    await page.click('[data-go="968199WW"]');
    await page.waitForSelector('.svcard');
    assert.match(await page.innerText('.svcard'), /ALPHA Test[\s\S]*0612345678[\s\S]*30 min prévues/);
    assert.match(env.psql("select driver_code || '|' || contract_num || '|' || planned_min || '|' || start_lat || '|' || shift from driver_pauses"), /^C1\|K1\|30\|33\.5731\|(Jour|Nuit)$/);
    await page.waitForSelector('#svbar .svcd');
    // compte à rebours écoulé (pause commencée il y a 31 min) : grande alerte rouge, nom, téléphone, plaque, WhatsApp
    env.psql("update driver_pauses set started_at = now() - interval '31 minutes'");
    await page.evaluate(() => { SV.loadAt = 0; });
    await page.waitForSelector('#svov.bad .svname', { timeout: 15000 });
    assert.match(await page.innerText('#svov'), /FIN DE PAUSE[\s\S]*ALPHA Test[\s\S]*WW968199[\s\S]*0612345678[\s\S]*dépassée de/);
    const wa = await page.evaluate(() => { let u = ''; window.open = x => { u = x; }; document.querySelector('#svwa').click(); return u; });
    assert.match(decodeURIComponent(wa), /^https:\/\/wa\.me\/212612345678\?text=🔴 \*FIN DE PAUSE\*/);
    await page.click('#svend');
    await page.waitForFunction(() => !document.querySelector('#svov'));
    assert.strictEqual(env.psql("select end_reason from driver_pauses"), 'Fin du compte à rebours');
    // nouvelle pause, puis le véhicule roule : alerte « véhicule en pause en mouvement »
    await page.goto('http://localhost:8080/#/suivi?t=pauses'); await page.waitForSelector('[data-go="968199WW"]');
    await page.selectOption('#svdur', '15'); await page.click('[data-go="968199WW"]'); await page.waitForSelector('.svcard');
    pos['968199WW'] = Object.assign({}, pos['968199WW'], { state: 'En route', speed: 45, lat: 33.5831 });
    await page.evaluate(() => { SV.posAt = 0; });
    await page.waitForSelector('#svov.bad', { timeout: 20000 });
    assert.match(await page.innerText('#svov'), /VÉHICULE EN PAUSE EN MOUVEMENT[\s\S]*ALPHA Test[\s\S]*1,1 km de sa place/);
    await page.click('#svlater');
    assert.match(env.psql("select moved_m || '|' || moved_note from driver_pauses where ended_at is null"), /^11\d\d\|à 1,1 km de sa place, 45 km\/h$/);
    // course privée réservée : suivi démarré (course « En cours »), arrivée détectée, suivi levé (course « Terminée »)
    await page.goto('http://localhost:8080/#/suivi?t=courses'); await page.waitForSelector('[data-tgo="7"]');
    await page.click('[data-tgo="7"]'); await page.waitForSelector('.svcard.trk');
    assert.strictEqual(env.psql("select m.status || '|' || t.dest_lat || '|' || t.driver_phone from missions m join mission_tracks t on t.mission_id = m.id"), 'En cours|33.3675|0698765432');
    env.psql("update mission_tracks set started_at = now() - interval '40 minutes'");
    pos['968200WW'] = Object.assign({}, pos['968200WW'], { state: 'Arrêté, contact mis', speed: 0, lat: 33.3680, lon: -7.5898 });
    await page.evaluate(() => { SV.loadAt = 0; SV.posAt = 0; });
    await page.waitForSelector('#svov.ok', { timeout: 20000 });
    assert.match(await page.innerText('#svov'), /COURSE ARRIVÉE À DESTINATION[\s\S]*Client Test[\s\S]*WW968200[\s\S]*BRAVO Test/);
    const wc = await page.evaluate(() => { let u = ''; window.open = x => { u = x; }; document.querySelector('#svwac').click(); return u; });
    assert.match(decodeURIComponent(wc), /^https:\/\/wa\.me\/212611111111\?text=✅ \*Course terminée\*[\s\S]*Client : Client Test[\s\S]*Destination : Aéroport Mohammed V/);
    await page.click('#svdone');
    await page.waitForFunction(() => !document.querySelector('#svov.ok'));
    assert.strictEqual(env.psql("select m.status || '|' || (t.ended_at is not null) || '|' || t.end_reason from missions m join mission_tracks t on t.mission_id = m.id"), 'Terminée|true|Arrivée à destination');
    // historique : par chauffeur et par shift, export
    await page.goto('http://localhost:8080/#/suivi?t=historique'); await page.waitForSelector('#tsva');
    assert.match(await page.innerText('#tsva'), /ALPHA Test[\s\S]*WW968199[\s\S]*2/);
    assert.match(await page.innerText('#tsvc'), /Client Test/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); env.psql('truncate missions restart identity cascade'); }
});
