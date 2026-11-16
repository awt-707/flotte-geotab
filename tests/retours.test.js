// Retours des véhicules à l'agence (16/11/2026, demande d'Ahmed) : calculs, droits de la base, page. Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');
const C = require('../site/retours_calc.js');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const MIN = 60000;

test('calculs : coordonnées saisies, ordre par distance ou par départ, heures de retour, message', () => {
  assert.deepStrictEqual(C.rtParseCoords('31.6295, -7.9811'), { lat: 31.6295, lon: -7.9811 });
  assert.deepStrictEqual(C.rtParseCoords('31,6295 -7,9811'), { lat: 31.6295, lon: -7.9811 });
  assert.deepStrictEqual(C.rtParseCoords('https://www.google.com/maps/place/Agence/@31.6342,-8.0101,17z/data=!3d31.6341!4d-8.0099'), { lat: 31.6341, lon: -8.0099 });
  assert.deepStrictEqual(C.rtParseCoords('https://maps.google.com/?q=33.5731,-7.5898'), { lat: 33.5731, lon: -7.5898 });
  assert.strictEqual(C.rtParseCoords('Marrakech'), null);
  assert.strictEqual(C.rtParseCoords('120, 10'), null);
  const ag = { lat: 31.63, lon: -8.0 };
  const r = (num, km, start, call) => ({ num, plate: 'P' + num, driver_name: 'D' + num, start_at: start, dist: km == null ? null : km * 1000, call: call || null });
  const rows = [r('A', 5, '2026-11-16T06:00:00Z'), r('B', 1, '2026-11-16T08:00:00Z'), r('C', null, '2026-11-16T05:00:00Z'), r('D', 0.1, '2026-11-16T07:00:00Z'),
    r('E', 3, '2026-11-16T04:00:00Z', { done_at: '2026-11-16T10:00:00Z' })];
  assert.deepStrictEqual(C.rtOrder(rows, 'dist', [], 300).map(x => x.num), ['B', 'A', 'C', 'D', 'E'], 'plus proche d\'abord, position inconnue à la fin, à l\'agence puis faits après');
  assert.deepStrictEqual(C.rtOrder(rows, 'depart', [], 300).map(x => x.num), ['C', 'A', 'B', 'D', 'E'], 'départ du contrat le plus ancien d\'abord');
  assert.deepStrictEqual(C.rtOrder(rows, 'manuel', ['A', 'C'], 300).map(x => x.num), ['A', 'C', 'B', 'D', 'E']);
  // heures : B prévenu pour 12:10 garde son heure, les autres prennent les créneaux libres toutes les 10 min à partir de 12:00
  const t0 = Date.parse('2026-11-16T11:00:00Z');
  rows[1].call = { sent_at: '2026-11-16T10:55:00Z', slot_at: new Date(t0 + 10 * MIN).toISOString() };
  const s = C.rtSlots(C.rtOrder(rows, 'dist', [], 300), t0, 10, 300);
  assert.deepStrictEqual(Object.keys(s).sort(), ['A', 'B', 'C']);
  assert.deepStrictEqual([s.A, s.B, s.C].map(x => (x - t0) / MIN), [0, 10, 20]);
  assert.strictEqual(C.rtState(rows[3], 300), 'arrive');
  assert.strictEqual(C.rtState(rows[1], 300), 'envoye');
  const m = C.rtMsg({ driver_name: 'Ali Test', plate: 'WW968201' }, { name: 'Marrakech', lat: 31.63, lng: -8.0, address: 'Rue Test, Guéliz' }, '12:10');
  assert.match(m, /Bonjour Ali Test[\s\S]*déconnecter d'Uber et de Bolt[\s\S]*agence Marrakech[\s\S]*WW968201[\s\S]*\*12:10\*[\s\S]*Rue Test, Guéliz[\s\S]*maps\/search\/\?api=1&query=31\.63,-8[\s\S]*Uber و Bolt[\s\S]*12:10/);
  assert.ok(Math.abs(C.rtDist(ag, { lat: 31.64, lon: -8.0 }) - 1112) < 5);
});

test('base : gestionnaire = véhicules de ses agences, un appel ouvert par contrat, auteur et heure posés par la base', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, agency_id) values ('V1', 'WW1', 1), ('V2', 'WW2', 2);`);
  try {
    as(MGR, "insert into return_calls (contract_num, vehicle_key, driver_name, sent_at, slot_at) values ('K1', 'V1', 'Ali', now(), now() + interval '10 minutes')");
    assert.strictEqual(env.psql('select agency_id || \'|\' || created_by from return_calls'), '1|' + MGR, 'agence du véhicule, auteur');
    assert.throws(() => as(MGR, "insert into return_calls (contract_num, vehicle_key) values ('K1', 'V1')"), /return_calls_open|duplicate/, 'un appel ouvert par contrat');
    assert.throws(() => as(MGR, "insert into return_calls (contract_num, vehicle_key) values ('K2', 'V2')"), /row-level security/, 'autre agence');
    as(MGR, `update return_calls set done_at = now(), created_by = '${ADMIN}', vehicle_key = 'V2'`);
    assert.strictEqual(env.psql("select vehicle_key || '|' || created_by || '|' || (done_at is not null) from return_calls"), 'V1|' + MGR + '|true', 'auteur et véhicule non modifiables');
    as(MGR, "insert into return_calls (contract_num, vehicle_key) values ('K1', 'V1')");   // le précédent est fait : nouvel appel possible
    as(MGR, 'delete from return_calls');
    assert.strictEqual(env.psql('select count(*) from return_calls'), '2', 'seul l\'administrateur efface');
    // position de l'agence : administrateur seulement
    as(MGR, "update agencies set lat = 1, lng = 1 where id = 1");
    assert.strictEqual(env.psql('select coalesce(lat::text, \'vide\') from agencies where id = 1'), 'vide');
    as(ADMIN, "update agencies set lat = 31.63, lng = -8.0, return_radius_m = 250 where id = 1");
    assert.strictEqual(env.psql('select lat || \'|\' || lng || \'|\' || return_radius_m from agencies where id = 1'), '31.63|-8|250');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('site : véhicules classés du plus proche au plus loin, prévenir le suivant sur WhatsApp, arrivée vue par le GPS, retour fait', async () => {
  env.resetDb();
  const start = t => new Date(Date.now() - t * 3600000).toISOString(), end = new Date(Date.now() + 6 * 3600000).toISOString();
  env.psql(`insert into agencies (id, name, lat, lng, address) overriding system value values (1, 'Marrakech', 31.63, -8.0, 'Rue Test');
    insert into vehicles (key, plate, model, active, agency_id) values ('V1', 'WW968201', 'SONATA', 'OUI', 1), ('V2', 'WW968202', 'SONATA', 'OUI', 1), ('V3', 'WW968203', 'SONATA', 'OUI', 1);
    insert into contracts (num, client_code, name, phone, plate, vehicle_key, start_at, end_at) values
      ('K1', 'C1', 'ALPHA Test', '0612345678', 'WW968201', 'V1', '${start(9)}', '${end}'),
      ('K2', 'C2', 'BRAVO Test', '0698765432', 'WW968202', 'V2', '${start(3)}', '${end}'),
      ('K3', 'C3', 'CHARLIE Test', '0611111111', 'WW968203', 'V3', '${start(6)}', null);`);
  // V1 à 11 km, V2 à 2,2 km, V3 à 5,6 km de l'agence
  const pos = { V1: { key: 'V1', state: 'En route', speed: 40, lat: 31.73, lon: -8.0, at: new Date().toISOString() },
    V2: { key: 'V2', state: 'Garé', speed: 0, lat: 31.65, lon: -8.0, at: new Date().toISOString() },
    V3: { key: 'V3', state: 'En route', speed: 30, lat: 31.68, lon: -8.0, at: new Date().toISOString() } };
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => { window.__uiDialogs = true; });
    await page.route('**/functions/v1/geotab-live**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ at: new Date().toISOString(), vehicles: Object.values(pos), events: [] }) }));
    await page.goto('http://localhost:8080/#/retours');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#trt');
    const order = async () => (await page.$$eval('#trt tbody tr', trs => trs.map(t => t.children[1].innerText.split('\n')[0])));
    assert.deepStrictEqual(await order(), ['WW968202', 'WW968203', 'WW968201'], 'du plus proche au plus loin');
    assert.match(await page.innerText('#trt'), /2,2 km[\s\S]*5,6 km[\s\S]*11,1 km/);
    // carte comme En direct : agence, cercle du rayon d'arrivée, véhicules numérotés dans l'ordre ; gardée d'un dessin à l'autre
    assert.strictEqual(await page.locator('#rtmap .vmk-pin').count(), 3);
    assert.strictEqual(await page.locator('#rtmap path.rtcircle').count(), 1);
    assert.match(await page.innerText('#rtmap'), /Agence Marrakech[\s\S]*#1 WW968202/);
    await page.evaluate(() => { window.__mapEl = document.getElementById('rtmap'); rtDraw(); });
    assert.ok(await page.evaluate(() => document.getElementById('rtmap') === window.__mapEl), 'carte gardée');
    await page.click('[data-rtmode="depart"]');
    assert.deepStrictEqual(await order(), ['WW968201', 'WW968203', 'WW968202'], 'départ du contrat le plus ancien d\'abord');
    await page.click('[data-rtmode="dist"]');
    // prévenir le suivant : WhatsApp du plus proche, message avec l'heure de retour ; appel enregistré
    const wa = await page.evaluate(() => { let u = ''; window.open = x => { u = x; }; document.querySelector('#rtnext').click(); return u; });
    assert.match(decodeURIComponent(wa), /^https:\/\/wa\.me\/212698765432\?text=🚗 \*RETOUR DU VÉHICULE\*[\s\S]*BRAVO Test[\s\S]*WW968202[\s\S]*Heure de retour à l'agence : \*\d\d:\d\d\*/);
    await page.waitForFunction(() => /Prévenu à/.test(document.querySelector('#trt').innerText));
    assert.match(env.psql("select contract_num || '|' || phone || '|' || rank || '|' || dist_at_send_m || '|' || (slot_at is not null) from return_calls"), /^K2\|0698765432\|1\|22\d\d\|true$/);
    // le suivant est le 2e plus proche
    assert.match(await page.innerText('#rtnext'), /CHARLIE Test \(WW968203\)/);
    // le véhicule prévenu arrive à l'agence : relevé par le GPS
    pos.V2 = Object.assign({}, pos.V2, { lat: 31.6305, lon: -8.0005 });
    await page.evaluate(() => { RT.posAt = 0; });
    await page.waitForFunction(() => /À l'agence/.test(document.querySelector('#trt').innerText), null, { timeout: 20000 });
    for (let i = 0; i < 20 && env.psql('select arrived_at is not null from return_calls') !== 't'; i++) await page.waitForTimeout(500);
    assert.strictEqual(env.psql('select arrived_at is not null from return_calls'), 't');
    await page.click('[data-rtdone="K2"]');
    await page.waitForFunction(() => /Retour fait \d\d:\d\d/.test(document.querySelector('#trt').innerText));
    assert.strictEqual(env.psql('select done_at is not null from return_calls'), 't');
    // position de l'agence : lien Google Maps collé par l'administrateur
    await page.fill('#rtco', 'https://www.google.com/maps/place/X/@31.6342,-8.0101,17z');
    await page.click('#rtcosave');
    await page.waitForFunction(() => /31\.6342, -8\.0101/.test(document.querySelector('#rtco').value));
    assert.strictEqual(env.psql('select lat || \',\' || lng from agencies where id = 1'), '31.6342,-8.0101');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});

test('collecteur : arrivée à l\'agence notée à chaque passage (positions Geotab du passage), même sans Ludy ouvert', () => {
  const { collector } = require('./lib/v6');
  env.resetDb();
  const B = collector(Date.now());   // le harnais remet la base à zéro : données insérées après
  env.psql(`insert into agencies (id, name, lat, lng, return_radius_m) overriding system value values (1, 'Marrakech', 31.63, -8.0, 250);
    insert into vehicles (key, plate, agency_id) values ('V1', 'WW1', 1), ('V2', 'WW2', 1), ('V3', 'WW3', 1);
    insert into return_calls (contract_num, vehicle_key, sent_at) values ('K1', 'V1', now()), ('K2', 'V2', now()), ('K3', 'V3', null);`);
  try {
    const st = { V1: { dsi: { latitude: 31.6301, longitude: -8.0002, isDriving: false } }, V2: { dsi: { latitude: 31.70, longitude: -8.0, isDriving: true, speed: 50 } },
      V3: { dsi: { latitude: 31.63, longitude: -8.0, isDriving: false } } };
    B.ctx.__st = st;
    assert.match(B.run('returnArriveStep_(__st)'), /1 véhicule\(s\) arrivé\(s\)/);
    assert.strictEqual(env.psql("select string_agg(contract_num, ',') from return_calls where arrived_at is not null"), 'K1', 'prévenu et à l\'agence ; pas prévenu : rien');
    st.V2.dsi = { latitude: 31.6302, longitude: -8.0, isDriving: true, speed: 40 };
    assert.strictEqual(B.run('returnArriveStep_(__st)'), '', 'passe devant l\'agence en roulant : pas arrivé');
  } finally { env.resetDb(); }
});

test('site : bandeau « arrivé à l\'agence » sur toutes les pages ; écran Retours du téléphone (cartes, prévenir le suivant)', async () => {
  env.resetDb();
  const start = new Date(Date.now() - 3 * 3600000).toISOString(), end = new Date(Date.now() + 6 * 3600000).toISOString();
  env.psql(`insert into agencies (id, name, lat, lng) overriding system value values (1, 'Marrakech', 31.63, -8.0);
    insert into vehicles (key, plate, model, active, agency_id) values ('V1', 'WW968201', 'SONATA', 'OUI', 1), ('V2', 'WW968202', 'SONATA', 'OUI', 1);
    insert into contracts (num, client_code, name, phone, plate, vehicle_key, start_at, end_at) values
      ('K1', 'C1', 'ALPHA Test', '0612345678', 'WW968201', 'V1', '${start}', '${end}'), ('K2', 'C2', 'BRAVO Test', '0698765432', 'WW968202', 'V2', '${start}', '${end}');
    insert into return_calls (contract_num, vehicle_key, driver_name, sent_at, slot_at) values ('K1', 'V1', 'ALPHA Test', now() - interval '20 minutes', now());`);
  const pos = { V1: { key: 'V1', state: 'En route', speed: 30, lat: 31.70, lon: -8.0, at: new Date().toISOString() }, V2: { key: 'V2', state: 'Garé', speed: 0, lat: 31.66, lon: -8.0, at: new Date().toISOString() } };
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => { window.__uiDialogs = true; });
    await page.route('**/functions/v1/geotab-live**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ at: new Date().toISOString(), vehicles: Object.values(pos), events: [] }) }));
    await page.goto('http://localhost:8080/#/alertes');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#page h1');
    // arrivée notée par le collecteur ou un téléphone pendant que la page Alertes est ouverte : bandeau vert
    env.psql("update return_calls set arrived_at = now()");
    await page.evaluate(() => rtwTick());
    await page.waitForSelector('.toast.rttoast', { timeout: 15000 });
    assert.match(await page.innerText('.toast.rttoast'), /Arrivé à l'agence Marrakech[\s\S]*WW968201[\s\S]*ALPHA Test/);
    await page.evaluate(() => rtwTick());
    assert.strictEqual(await page.locator('.toast.rttoast').count(), 1, 'une seule fois');
    // écran Retours du mode téléphone
    await page.goto('http://localhost:8080/?mobile=1#/retours');
    await page.waitForSelector('.rtcard');
    assert.match(await page.innerText('.mtabs'), /Retours/);
    assert.match(await page.innerText('#trt'), /#1 WW968202[\s\S]*3,3 km[\s\S]*BRAVO Test[\s\S]*#2 WW968201[\s\S]*À l'agence/);
    const wa = await page.evaluate(() => { let u = ''; window.open = x => { u = x; }; document.querySelector('#rtnext').click(); return u; });
    assert.match(decodeURIComponent(wa), /^https:\/\/wa\.me\/212698765432\?text=🚗 \*RETOUR DU VÉHICULE\*[\s\S]*BRAVO Test/);
    await page.waitForFunction(() => /Prévenu à/.test(document.querySelector('#trt').innerText));
    assert.strictEqual(env.psql("select count(*) from return_calls where contract_num = 'K2' and sent_at is not null"), '1');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
