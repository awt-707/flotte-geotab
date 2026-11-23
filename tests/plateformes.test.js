// Chauffeurs Uber en ce moment (18/11/2026, demandes d'Ahmed : en ligne, en route vers le client, en course, déconnectés), lus sur
// l'écran Uber Fleet ouvert dans l'application Ludy 1.8 (lecture uber_reader.js, envoi uber_live_push, table uber_live). Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), P = require('../site/plateformes_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
/** Lignes d'uber_live (plaque, état, il y a s secondes, état depuis s2 secondes) */
const ul = rows => rows.map(r => `insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, observed_at, status_since, complete) values ('${r[0].replace(/[^0-9]/g, '') + r[0].replace(/[^A-Z]/g, '')}', '${r[0]}', ${r[1] ? `'${r[1]}'` : 'null'}, null, ${r[2] ? `'${r[2]}'` : 'null'}, '${r[3]}', now() - interval '${r[4]} seconds', now() - interval '${r[5] == null ? r[4] : r[5]} seconds', true);`).join('\n');

test('comptes par plateforme : en ligne, vers le client, en course, disponibles ; chauffeur plus vu = pas compté ; lecture arrêtée = pas à jour', () => {
  const now = Date.parse('2026-11-18T18:20:00Z'), ago = s => new Date(now - s * 1000).toISOString();
  const drivers = [{ id: 'a', name: 'ALPHA', agency_id: 2 }, { id: 'b', name: 'BETA', agency_id: 2 }, { id: 'c', name: 'GAMMA', agency_id: 1 }, { id: 'd', name: 'DELTA', agency_id: 2 }, { id: 'e', name: 'EPS', agency_id: 2 }];
  const latest = [
    { driver_id: 'a', source: 'uber', status: 'on_trip', observed_at: ago(5), vehicle_label: '030070WW' },
    { driver_id: 'b', source: 'uber', status: 'to_pickup', observed_at: ago(10), vehicle_label: '030071WW' },
    { driver_id: 'c', source: 'uber', status: 'available', observed_at: ago(3), vehicle_label: '968205WW' },
    { driver_id: 'd', source: 'uber', status: 'available', observed_at: ago(600), vehicle_label: '030072WW' },   // plus vu depuis 10 min
    { driver_id: 'e', source: 'uber', status: 'unknown', observed_at: ago(20), vehicle_label: '030073WW', evidence: { raw_state: 'Pastille #545454' } },
    { driver_id: 'a', source: 'bolt', status: 'offline', observed_at: ago(5) }];
  const s = P.pfSummary(latest, drivers, { now });
  assert.deepStrictEqual([s.uber.online, s.uber.to_pickup, s.uber.on_trip, s.uber.available, s.uber.unknown, s.uber.stale], [4, 1, 1, 1, 1, false]);
  assert.deepStrictEqual(s.uber.list.map(x => x.name + ':' + x.status), ['BETA:to_pickup', 'ALPHA:on_trip', 'GAMMA:available', 'EPS:unknown']);
  assert.deepStrictEqual([s.bolt.online, s.bolt.stale, s.bolt.seen], [0, false, true], 'Bolt : tous hors ligne, lecture à jour');
  const m = P.pfSummary(latest, drivers, { now, keep: d => d && d.agency_id === 2 });
  assert.deepStrictEqual([m.uber.online, m.uber.available], [3, 0], 'agence de Marrakech seulement');
  const old = P.pfSummary(latest, drivers, { now: now + 10 * 60000 });
  assert.deepStrictEqual([old.uber.online, old.uber.stale], [0, true], 'aucune lecture depuis 10 min : rien compté, chiffres pas à jour');
});

test('page En direct : bloc « Uber en ce moment » (chiffres et liste des chauffeurs), lecture arrêtée signalée', async () => {
  env.resetDb();
  // tables de l'application de bureau (absentes des migrations de Ludy) : créées pour le test
  env.psql(`insert into vehicles (key, plate, model, active) values ('030070WW', 'WW030070', 'RAV4', 'OUI'), ('030071WW', 'WW030071', 'RAV4', 'OUI'), ('030072WW', 'WW030072', 'RAV4', 'OUI'), ('030075WW', 'WW030075', 'RAV4', 'OUI'),
      ('030076WW', 'WW030076', 'RAV4', 'OUI'), ('030077WW', 'WW030077', 'RAV4', 'OUI');
    insert into live_status (vehicle_key, plate, model, state, speed, lat, lon, updated_at) values ('030070WW', 'WW030070', 'RAV4', 'En route', 42, 31.62, -8.01, now()),
      ('030071WW', 'WW030071', 'RAV4', 'En route', 30, 31.63, -8.02, now()), ('030075WW', 'WW030075', 'RAV4', 'Garé', 0, 31.64, -8.03, now()),
      ('030076WW', 'WW030076', 'RAV4', 'En route', 55, 31.65, -8.04, now()), ('030077WW', 'WW030077', 'RAV4', 'Garé', 0, 31.66, -8.05, now());
    insert into drivers (code, name) values ('D6', 'DELTA Test'), ('D7', 'EPSILON Test');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('K6', 'D6', 'DELTA Test', 'WW030076', '030076WW', now() - interval '2 hours'),
      ('K7', 'D7', 'EPSILON Test', 'WW030077', '030077WW', now() - interval '2 hours');
    ${ul([['WW030070', '030070WW', 'ALPHA Test', 'on_trip', 5], ['WW030071', '030071WW', 'BETA Test', 'to_pickup', 8], ['WW030072', '030072WW', 'GAMMA Test', 'available', 10],
      ['WW030077', '030077WW', 'EPSILON T.', 'available', 6]])}`);
    const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForSelector('#liveplat .pfbar .kchip');
    const t = await page.innerText('#liveplat');
    assert.match(t, /Uber lu à \d\d:\d\d\s*4\s*en ligne\s*2\s*Disponible\s*1\s*En route vers le lieu de prise en charge\s*1\s*Course en cours/);
    await page.click('#liveplat details[data-pf="uber"] summary');
    assert.match(await page.innerText('#liveplat table'), /BETA Test[\s\S]*WW030071[\s\S]*En route vers le lieu de prise en charge[\s\S]*ALPHA Test[\s\S]*Course en cours[\s\S]*GAMMA Test[\s\S]*Disponible/);
    // carte et cartes véhicules : état Uber du véhicule (plaque lue sur l'écran Uber Fleet)
    await page.waitForFunction(() => /Uber · Course en cours/.test((document.querySelector('.vcard[data-vk="030070WW"]') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030071WW"]'), /Uber · En route vers le lieu de prise en charge/);
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030075WW"]'), /Uber ·/, 'véhicule pas en ligne sur Uber : rien');
    const lbl = await page.evaluate(() => LIVE.markers['030070WW'].getElement().innerText);
    assert.match(lbl, /WW030070 · 42 km\/h\s*Uber$/, 'carte : pastille courte');
    assert.strictEqual(await page.evaluate(() => LIVE.markers['030070WW'].getElement().querySelector('.pfchip').className), 'pfchip pf-on_trip', 'couleur de l\'état');
    assert.strictEqual(await page.evaluate(() => LIVE.markers['030070WW'].getElement().querySelector('.pfchip').title), 'Uber · Course en cours');
    // colonne de droite : aucune fiche plus large que la colonne
    assert.strictEqual(await page.evaluate(() => { const l = document.querySelector('#vlist'); return l.scrollWidth <= l.clientWidth + 1; }), true, 'pas de défilement horizontal');
    assert.match(await page.evaluate(() => LIVE.markers['030071WW'].getTooltip().getContent()), /Uber : <b>En route vers le lieu de prise en charge<\/b> · BETA Test/);
    // sous contrat, pas en ligne : « Hors ligne », en rouge s'il roule ; chauffeur en ligne avec un autre véhicule : jamais « hors ligne »
    await page.waitForFunction(() => /Hors ligne · roule/.test((document.querySelector('.vcard[data-vk="030076WW"]') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030077WW"]'), /Uber · Disponible/);
    assert.match(await page.innerText('#liveplat'), /1\s*déconnectés sous contrat\s*1\s*déconnectés qui roulent/);
    await page.click('#liveplat details[data-pf="off"] summary');
    assert.match(await page.innerText('#liveplat details[data-pf="off"]'), /Sous contrat mais déconnectés d'Uber et de Bolt \(1\)[\s\S]*WW030076[\s\S]*DELTA Test[\s\S]*En route · 55 km\/h/);
    // lecture arrêtée : plus aucun relevé depuis 10 min
    env.psql("update uber_live set observed_at = now() - interval '10 minutes'");
    await page.evaluate(async () => { await pfLoad(); pfPaint(); });
    assert.match(await page.innerText('#liveplat'), /Lecture arrêtée depuis \d\d:\d\d : chiffres pas à jour/);
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030070WW"]'), /Uber ·/, 'lecture arrêtée : plus de pastille sur la carte');
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030076WW"]'), /Hors ligne/, 'lecture arrêtée : jamais « hors ligne » supposé');
    // photo du chauffeur lue sur Uber Fleet, à droite de la fiche du véhicule
    await page.route('https://*.cloudfront.net/**', r => r.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }));
    env.psql("update uber_live set photo_url = 'https://d1w2poirtb3as9.cloudfront.net/a.jpeg', observed_at = now() where plate = 'WW030070'");
    await page.evaluate(async () => { await pfLoad(); pfPaint(); });
    await page.waitForSelector('.vcard[data-vk="030070WW"] img.vc-photo');
    // chiffres d'Uber sur la fiche : depuis le début du contrat (jamais la journée d'Uber, 05:00 → 05:00)
    env.psql(`update uber_live set perf = '{"e":999,"h":9,"t":9,"a":1,"at":${Date.now()}}' where plate = 'WW030070';
      insert into uber_perf (driver_id, period, period_from, vehicle_key, data, updated_at) values ('97b48f1d-06da-4c89-8310-fe49bfd8b16a', 'ctr:K6', now() - interval '2 hours', '030076WW', '{"e":1242,"cash":205,"h":7.84,"t":6,"a":0.7,"c":0}', now())`);
    await page.evaluate(async () => { await pfLoad(); PFS.at = 0; await pfShiftLoad(); pfPaint(); });
    await page.waitForFunction(() => /revenus Uber/.test((document.querySelector('.vcard[data-vk="030076WW"] .vc-kpis') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030076WW"] .vc-kpis'), /1[\s\u202f\u00a0]?242 MAD\s*revenus Uber\s*7 h 50\s*en ligne\s*70 %\s*acceptation\s*6\s*courses/);
    assert.strictEqual(await page.locator('.vcard[data-vk="030076WW"] .vk.uber.bad').count(), 1, 'acceptation sous 80 % en rouge');
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030070WW"]'), /999 MAD/, 'chiffres de la journée d\'Uber jamais affichés');
    assert.strictEqual(await page.locator('.vcard[data-vk="030071WW"] img.vc-photo').count(), 0, 'sans photo : rien');
    // lecture partielle seulement (application 1.8 : chauffeur ouvert à l'écran) : pas de comptes, jamais « hors ligne » supposé
    env.psql("update uber_live set observed_at = now(), complete = false");
    await page.evaluate(async () => { await pfLoad(); pfPaint(); });
    assert.match(await page.innerText('#liveplat'), /chauffeur\(s\) lu\(s\) à l'écran · comptes complets : ouvrir la « Carte en temps réel » d'Uber Fleet dans l'application Ludy 1\.9/);
    assert.match(await page.innerText('.vcard[data-vk="030070WW"]'), /Uber · Course en cours/, 'état lu : affiché');
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030076WW"]'), /Hors ligne/, 'lecture partielle : jamais « hors ligne » supposé');
    assert.doesNotMatch(await page.innerText('#liveplat'), /Raphael/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_live, uber_live_readers, uber_catalog'); env.resetDb(); }
});

test('déconnexion d\'Uber : chauffeur vu puis plus vu (lecture à jour), contrat en cours ; lecture arrêtée = personne ; messages WhatsApp', () => {
  const now = Date.parse('2026-11-18T18:30:00Z'), ago = s => new Date(now - s * 1000).toISOString();
  const drivers = [{ id: 'a', name: 'ALPHA' }, { id: 'b', name: 'BETA' }, { id: 'c', name: 'GAMMA' }];
  const latest = [
    { driver_id: 'a', source: 'uber', status: 'available', observed_at: ago(4 * 60), vehicle_label: '030070WW' },   // plus vu depuis 4 min
    { driver_id: 'b', source: 'uber', status: 'on_trip', observed_at: ago(5), vehicle_label: '030071WW' },          // lecture à jour
    { driver_id: 'c', source: 'uber', status: 'available', observed_at: ago(3 * 3600), vehicle_label: '030072WW' } ];  // trop ancien
  const l = P.pfDisconnects(latest, drivers, { now });
  assert.deepStrictEqual(l.map(x => [x.name, x.plate, x.key]), [['ALPHA', '030070WW', 'UOFF|a|' + ago(240)]]);
  assert.deepStrictEqual(P.pfDisconnects(latest, drivers, { now, keep: d => d.name !== 'ALPHA' }), [], 'contrat terminé, pause ou retour : pas d\'alerte');
  assert.deepStrictEqual(P.pfDisconnects(latest.filter(r => r.driver_id !== 'b'), drivers, { now }), [], 'lecture d\'Uber arrêtée : personne n\'est déclaré déconnecté');
  // 20/11/2026 : 15 chauffeurs « plus affichés » à la même seconde = lecture d'Uber qui a sauté, pas de déconnexions
  const t0 = now - 8 * 60000, mass = ['m1', 'm2', 'm3'].map((id, i) => ({ driver_id: id, source: 'uber', status: 'on_trip', observed_at: new Date(t0 + i * 1000).toISOString(), vehicle_label: '03007' + i + 'WW' }));
  const all3 = latest.concat(mass), lm = P.pfDisconnects(all3, drivers.concat(mass.map(m => ({ id: m.driver_id, name: m.driver_id }))), { now });
  assert.ok(!lm.some(x => /^m/.test(x.driverId)), 'déconnexions en masse à la même lecture : aucune alerte');
  assert.deepStrictEqual(lm.map(x => x.driverId), l.map(x => x.driverId), 'les autres alertes restent');
  const hm = ms => new Date(ms).toISOString().slice(11, 16), dur = ms => Math.round(ms / 60000) + ' min';
  const x = { name: 'ALPHA', plate: 'WW030070', lastAt: now - 240000, now, ctr: 'K1', geo: 'En route à 40 km/h', phone: '0612345678' };
  assert.match(P.pfWaOff(x, hm, dur), /DÉCONNECTÉ D'UBER\*\nBonjour ALPHA,\nVous n'êtes plus connecté à Uber depuis 18:26 \(4 min\) avec le véhicule WW030070[\s\S]*خرجتي من Uber/);
  assert.strictEqual(P.pfShareOff(x, hm, dur), '🔴 Chauffeur déconnecté d\'Uber : ALPHA · WW030070 · plus connecté depuis 18:26 (4 min) · contrat K1 · GPS : En route à 40 km/h · tél. 0612345678');
});

test('page : bandeau rouge « chauffeur déconnecté d\'Uber » (WhatsApp, partage), pas pour un chauffeur en fin de contrat, vert à la reconnexion', async () => {
  env.resetDb();
  env.psql(`insert into vehicles (key, plate, model, active) values ('030070WW', 'WW030070', 'RAV4', 'OUI'), ('030071WW', 'WW030071', 'RAV4', 'OUI'), ('030072WW', 'WW030072', 'RAV4', 'OUI');
    insert into live_status (vehicle_key, plate, model, state, speed, lat, lon, updated_at) values ('030070WW', 'WW030070', 'RAV4', 'En route', 40, 31.62, -8.01, now());
    insert into drivers (code, name, phone) values ('C1', 'ALPHA Test', '0612345678'), ('C3', 'GAMMA Test', null);
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('K1', 'C1', 'ALPHA Test', 'WW030070', '030070WW', now() - interval '3 hours');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K3', 'C3', 'GAMMA Test', 'WW030072', '030072WW', now() - interval '10 hours', now() - interval '10 minutes');
    ${ul([['WW030070', '030070WW', 'ALPHA T.', 'available', 240], ['WW030071', '030071WW', 'BETA T.', 'on_trip', 5], ['WW030072', '030072WW', 'GAMMA T.', 'available', 300]])}`);
    const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => { window.__opened = []; window.open = u => { window.__opened.push(String(u)); return null; }; });
    await login(page, '#/dashboard');
    await page.waitForSelector('.pftoast.crit', { timeout: 20000 });
    const t = await page.innerText('.pftoast');
    assert.match(t, /CHAUFFEUR DÉCONNECTÉ D'UBER[\s\S]*ALPHA Test[\s\S]*WW030070[\s\S]*Plus connecté à Uber depuis[\s\S]*contrat K1[\s\S]*GPS Geotab : En route à 40 km\/h[\s\S]*0612345678/);
    assert.strictEqual(await page.locator('.pftoast').count(), 1, 'GAMMA : contrat terminé, pas d\'alerte');
    await page.click('.pftoast [data-a="wa"]');
    await page.click('.pftoast [data-a="share"]');
    const urls = await page.evaluate(() => window.__opened);
    assert.match(decodeURIComponent(urls[0]), /^https:\/\/wa\.me\/212612345678\?text=🔴 \*DÉCONNECTÉ D'UBER\*\nBonjour ALPHA Test/);
    assert.match(decodeURIComponent(urls[1]), /^https:\/\/wa\.me\/\?text=🔴 Chauffeur déconnecté d'Uber : ALPHA Test · WW030070 · plus connecté depuis/);
    // reconnecté : bandeau vert
    env.psql("update uber_live set observed_at = now() where plate = 'WW030070'");
    await page.evaluate(() => pfwTick());
    await page.waitForSelector('.pftoast.ok');
    assert.match(await page.innerText('.pftoast.ok'), /Reconnecté à Uber[\s\S]*ALPHA Test/);
    // « Stopper l'alerte » : coupe les alertes « déconnecté d'Uber » de ce chauffeur, aucune nouvelle alerte même s'il reste hors ligne
    await page.evaluate(() => { Object.values(PFW.toasts).forEach(t => t.remove()); PFW.toasts = {}; try { localStorage.removeItem('pfOffSeen'); localStorage.removeItem('pfOffMute'); } catch (e) {} });
    env.psql("update uber_live set observed_at = now() - interval '3 minutes' where plate = 'WW030070'");
    await page.evaluate(() => pfwTick());
    await page.waitForSelector('.pftoast.crit');
    await page.click('.pftoast [data-a="mute"]');
    await page.waitForSelector('.pftoast.ok');
    assert.match(await page.innerText('.pftoast.ok'), /Alerte coupée[\s\S]*ALPHA Test/);
    await page.evaluate(() => { document.querySelectorAll('.pftoast').forEach(t => t.remove()); return pfwTick(); });
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.pftoast.crit').count(), 0, 'chauffeur coupé : plus d\'alerte de déconnexion');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_live, uber_live_readers, uber_catalog'); env.resetDb(); }
});

test('lecture de l\'écran Uber Fleet (application 1.8) : libellés d\'état et plaques de chaque ligne, rien sans plaque ni état reconnu', async () => {
  const R = require('../desktop/src-tauri/src/uber_reader.js');
  assert.deepStrictEqual(['Disponible', 'En route vers le lieu de prise en charge', 'Course en cours', 'Hors ligne', 'Pastille #545454', 'Disponible depuis 3 min'].map(R.urState),
    ['available', 'to_pickup', 'on_trip', 'offline', null, null]);
  assert.deepStrictEqual(['86120-T-1', '86120 | ت | 1', 'WW 968205', '968205WW', 'W18-12345', 'Toyota RAV4 2026'].map(R.urPlate), ['86120-T-1', '86120-ت-1', 'WW968205', 'WW968205', 'W18-12345', '']);
  const { br, page } = await openBrowser();
  try {
    await page.setContent(`<div class="list">
      <div class="row"><div><span>ALPHA Test</span><span>2026 Toyota RAV4</span><span>030070 WW</span></div><div><i style="background:#05944f"></i><span>Course en cours</span></div></div>
      <div class="row"><div><span>BETA Test</span><span>86120-T-1</span></div><div>En route vers le lieu de prise en charge</div></div>
      <div class="row"><div><span>GAMMA Test</span><span>2026 Hyundai Staria</span></div><div><span>Disponible</span></div></div>
      <div class="row"><div><span>DELTA Test</span><span>WW 968205</span></div><div><span>Hors ligne</span></div></div></div>`);
    const rows = await page.evaluate(src => { const module = { exports: {} }; new Function('module', src)(module); return module.exports.urRead(document); },
      fs.readFileSync(path.join(__dirname, '../desktop/src-tauri/src/uber_reader.js'), 'utf8'));
    assert.deepStrictEqual(rows.map(r => [r.plate, r.status, r.name]).sort(), [['86120-T-1', 'to_pickup', 'BETA Test'], ['WW030070', 'on_trip', 'ALPHA Test'], ['WW968205', 'offline', 'DELTA Test']],
      'GAMMA : pas de plaque lisible, rien envoyé');
  } finally { await br.close(); }
  // l'application injecte ce script dans les volets externes et autorise l'envoi seulement depuis *.uber.com
  const rs = fs.readFileSync(path.join(__dirname, '../desktop/src-tauri/src/main.rs'), 'utf8');
  assert.match(rs, /CapabilityBuilder::new\("uber-reader"\)\.window\("ext-\*"\)\.webview\("ext-\*"\)\.remote\("https:\/\/\*\.uber\.com\/\*"\.to_string\(\)\)\.permission\("allow-uber-push"\)/);
  assert.strictEqual((rs.match(/\.initialization_script\(UBER_READER\)/g) || []).length, 2, 'volet Mac et fenêtre Windows');
  assert.match(fs.readFileSync(path.join(__dirname, '../desktop/src-tauri/build.rs'), 'utf8'), /"uber_push", "uber_rows"/);
});

test('lecture 1.9 (site/uber_read.js) : carte en temps réel d\'Uber Fleet (GetDriverLiveLocation), plaques retrouvées, noms des fiches ; sinon partielle', () => {
  const U = require('../site/uber_read.js');
  const id = n => n + '97b48f1d-06da-4c89-8310-fe49bfd8b16a'.slice(1);
  const vid = n => n + '317d21e1-79fb-4a0a-8e30-f5582739ac91'.slice(1);
  const loc = (n, st) => ({ waypointsLocation: [], driverId: { value: id(n) }, latitude: 31.62, longitude: -8.0, course: 67, driverStatus: 'MONITORING_SUPPLY_STATUS_ONLINE', vehicleId: { value: vid(n) }, supplyActivityState: st });
  const live = { status: 'success', data: { driverLocations: [loc('1', 'SUPPLY_ACTIVITY_STATE_ONLINE_DISPATCHABLE'), loc('2', 'SUPPLY_ACTIVITY_STATE_ON_TRIP'), loc('3', 'SUPPLY_ACTIVITY_STATE_EN_ROUTE_TO_PICKUP')],
    driverStats: { onlineDrivers: 3, totalDriversInScope: 70 } } };
  const net = [{ url: 'https://fleethub.uber.com/api/GetDriverLiveLocation', op: '', at: Date.now(), text: JSON.stringify(live) }];
  // fiches de la liste (nom, téléphone) simulées
  const card = (n, name) => ({ getAttribute: () => JSON.stringify({ driverUUID: id(n), vehicleUUID: vid(n), driverStatus: 'ONLINE' }), textContent: name + '+212 600000000',
    querySelector: q => q.includes('labelsmall') ? { textContent: name } : q.includes('img') ? { getAttribute: a => a === 'src' ? 'https://d1w2poirtb3as9.cloudfront.net/p' + n + '.jpeg' : name } : null });
  const doc = { querySelectorAll: q => q.includes('driver-card') ? [card('1', 'ALPHA Test'), card('2', 'BETA Test')] : [] };
  // plaques : réponse d'Uber Fleet qui relie les véhicules à leur plaque (deux sur trois)
  const map = { p: {}, n: {} };
  U.indexJson({ data: { vehicles: [{ vehicleUUID: vid('1'), licensePlate: 'WW 030070' }, { uuid: { value: vid('2') }, plate: '86120-T-1' }] } }, map);
  let r = U.read(doc, net, map);
  assert.strictEqual(r.full, false, 'un chauffeur en ligne sans plaque : liste pas complète (personne supposé hors ligne)');
  assert.deepStrictEqual(r.rows.map(x => x.plate + '|' + x.status + '|' + x.name + '|' + x.phone), ['WW030070|available|ALPHA Test|+212 600000000', '86120-T-1|on_trip|BETA Test|+212 600000000']);
  assert.strictEqual(r.rows[0].photo, 'https://d1w2poirtb3as9.cloudfront.net/p1.jpeg', 'photo de la fiche');
  assert.match(r.diag, /en ligne \(Uber\) : 3 · plaques trouvées : 2 · sans plaque : 1/);
  U.indexJson({ vehicle: { id: vid('3'), licensePlate: '030071WW' } }, map);
  r = U.read(doc, net, map);
  assert.strictEqual(r.full, true);
  assert.deepStrictEqual(r.rows.map(x => x.plate + '|' + x.status), ['WW030070|available', '86120-T-1|on_trip', 'WW030071|to_pickup']);
  // réponse trop vieille (plus de 90 s) : plus de liste complète
  assert.strictEqual(U.read(doc, [Object.assign({}, net[0], { at: Date.now() - 120000 })], map).full, false);
  const m2 = { p: {}, n: {} }; U.indexJson({ getLivemapSupply: { uuid: id('4'), driver: { uuid: id('4'), firstName: 'DELTA', lastName: 'Test', pictureUrl: 'https://d1w2poirtb3as9.cloudfront.net/d.jpeg' }, vehicle: { uuid: vid('4'), licensePlate: '968211' } } }, m2);
  assert.strictEqual(U.perfIndex({ data: { getPerformanceReport: [{ uuid: id('1'), totalEarnings: 1242, cashEarnings: 205, hoursOnline: 7.84, totalTrips: 6, driverAcceptanceRate: 1, driverCancellationRate: 0, __typename: 'DriverPerformanceDetail' },
    { uuid: vid('1'), totalEarnings: 9, __typename: 'VehiclePerformanceDetail' }] } }), 1, 'performances des chauffeurs seulement');
  assert.strictEqual(U.read(doc, net, map).rows[0].perf.e, 1242, 'revenus du jour joints au chauffeur en ligne');
  assert.strictEqual(U.uberDay(Date.UTC(2026, 10, 19, 2, 30)), U.uberDay(Date.UTC(2026, 10, 18, 4, 0)), 'journée d\'Uber de 04:00 à 04:00 UTC');
  assert.strictEqual(U.uberDay(1795147200000) * 86400000 + 4 * 3600000, 1795147200000, 'début de journée = celui de la page Performances (20/11 04:00 UTC)');
  assert.notStrictEqual(U.uberDay(Date.UTC(2026, 10, 20, 3, 59)), U.uberDay(Date.UTC(2026, 10, 20, 4, 0)));
  assert.strictEqual(m2.p[vid('4')], '968211', 'plaque écrite sans lettres dans Uber Fleet : gardée (Ludy la rapproche par les chiffres)');
  assert.strictEqual(m2.ph[id('4')], 'https://d1w2poirtb3as9.cloudfront.net/d.jpeg', 'photo de la fiche');
  assert.deepStrictEqual(['SUPPLY_ACTIVITY_STATE_ONLINE_DISPATCHABLE', 'SUPPLY_ACTIVITY_STATE_OFFLINE', 'SUPPLY_ACTIVITY_STATE_ON_TRIP', 'SUPPLY_ACTIVITY_STATE_EN_ROUTE', 'X'].map(U.uberSt), ['available', 'offline', 'on_trip', 'to_pickup', null]);
  // autre format : structure jointe pour régler la lecture
  const r2 = U.read({ querySelectorAll: () => [] }, [{ url: 'https://fleethub.uber.com/api/x', op: '', at: Date.now(), text: JSON.stringify({ items: [{ id: 1, colour: 'green' }] }) }]);
  assert.strictEqual(r2.full, false); assert.deepStrictEqual(r2.rows, []);
  assert.match(r2.diag, /^LUDY \S+ · réponses captées : 1/); assert.match(r2.diag, /\{items:\[1: \{id:1,colour:"green"\}\]\}/);
  assert.deepStrictEqual(['ONLINE', 'OFFLINE', 'ON_TRIP', 'Disponible', 'unavailable'].map(U.stOf), ['available', 'offline', 'on_trip', 'available', null]);
});

test('base : relevé envoyé par un compte connecté (plaque → véhicule de Ludy, état depuis…), lu selon les agences, refusé sans compte Ludy', () => {
  env.resetDb();
  try {
    env.psql(`truncate uber_live, uber_live_readers;
      insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
      insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
      insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Marrakech');
      insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
      insert into vehicles (key, plate, model, active, agency_id) values ('030070WW', 'WW030070', 'RAV4', 'OUI', 1), ('86120T1', '86120-T-1', 'STARIA', 'OUI', 2);`);
    const rows = JSON.stringify([{ plate: 'WW030070', status: 'on_trip', name: 'ALPHA Test', raw: 'Course en cours' }, { plate: '86120-T-1', status: 'available' },
      { plate: '99999-A-9', status: 'to_pickup' }, { plate: 'X', status: 'available' }, { plate: '12345-B-6', status: 'bizarre' }]);
    assert.strictEqual(as(MGR, `select public.uber_live_push('${rows}'::jsonb, 'Application 1.8.0 · Windows', 'https://fleethub.uber.com/orgs/x/livemap', '', true)`), '3', 'plaque illisible et état inconnu ignorés');
    assert.strictEqual(env.psql("select string_agg(plate || '|' || coalesce(vehicle_key, '-') || '|' || coalesce(agency_id::text, '-') || '|' || status, ',' order by plate) from uber_live"),
      '86120-T-1|86120T1|2|available,99999-A-9|-|-|to_pickup,WW030070|030070WW|1|on_trip');
    assert.strictEqual(as(MGR, 'select count(*) from uber_live'), '1', 'gestionnaire de Rabat : ses véhicules seulement');
    assert.strictEqual(as(ADMIN, 'select count(*) from uber_live'), '3');
    // même état relu : « depuis » gardé ; autre état : remis à maintenant
    env.psql("update uber_live set status_since = now() - interval '20 minutes'");
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW030070","status":"on_trip"},{"plate":"86120-T-1","status":"offline"}]'::jsonb, 'Application 1.8.0 · Mac', '', '', true)`);
    assert.strictEqual(env.psql("select string_agg(plate || '|' || (status_since < now() - interval '10 minutes'), ',' order by plate) from uber_live where plate <> '99999-A-9'"), '86120-T-1|false,WW030070|true');
    assert.strictEqual(env.psql("select count(*) from uber_live_readers"), '2', 'un relevé par compte et par appareil');
    // historique : même état = même période ; changement d'état = période fermée, nouvelle ouverte
    assert.strictEqual(env.psql("select string_agg(plate || '|' || status || '|' || (ended_at is null), ',' order by plate, id) from uber_live_log where plate <> '99999-A-9'"),
      '86120-T-1|available|false,86120-T-1|offline|true,WW030070|on_trip|true');
    // plaque plus affichée depuis 2 min (lecture à jour d'une autre plaque) : déconnexion notée à la dernière lecture
    env.psql("update uber_live set observed_at = now() - interval '4 minutes' where plate = 'WW030070'");
    as(ADMIN, `select public.uber_live_push('[{"plate":"86120-T-1","status":"offline"}]'::jsonb, 'Application 1.8.0 · Mac', '', '', true)`);
    assert.strictEqual(env.psql("select string_agg(status || '|' || (ended_at is null) || '|' || (started_at < now() - interval '3 minutes'), ',' order by id) from uber_live_log where plate = 'WW030070'"),
      'on_trip|false|false,gone|true|true', 'déconnecté depuis la dernière lecture (il y a 4 min)');
    assert.strictEqual(as(MGR, 'select count(*) from uber_live_log'), '2', 'historique lu selon les agences');
    // lecture partielle (chauffeur ouvert à l'écran) : état noté, jamais de « gone » (une plaque qui disparaît de l'écran n'est pas déconnectée)
    env.psql("truncate uber_live, uber_live_log");
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW030070","status":"available"}]'::jsonb, 'Application 1.8.0 · Mac', '', '')`);
    env.psql("update uber_live set observed_at = now() - interval '4 minutes'");
    as(ADMIN, `select public.uber_live_push('[{"plate":"86120-T-1","status":"on_trip"}]'::jsonb, 'Application 1.8.0 · Mac', '', '')`);
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW030070","status":"available"}]'::jsonb, 'Application 1.8.0 · Mac', '', '')`);
    assert.strictEqual(env.psql("select count(*) from uber_live_log where status = 'gone'"), '0');
    assert.strictEqual(env.psql("select string_agg(plate || '|' || complete, ',' order by plate) from uber_live"), '86120-T-1|false,WW030070|false');
    // photo du chauffeur (adresse cloudfront seulement) et catalogue d'exploration (lu par l'administrateur seulement)
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW030070","status":"available","photo":"https://d1w2poirtb3as9.cloudfront.net/a.jpeg?Expires=1"},{"plate":"86120-T-1","status":"on_trip","photo":"https://evil.example/x.jpg"}]'::jsonb, 'Application 1.9.0 · Mac', '', '', true)`);
    assert.strictEqual(env.psql("select string_agg(plate || '|' || coalesce(photo_url, '-'), ',' order by plate) from uber_live"), '86120-T-1|-,WW030070|https://d1w2poirtb3as9.cloudfront.net/a.jpeg?Expires=1');
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW030070","status":"available","perf":{"e":1242,"h":7.8,"a":1,"x":"<script>","t":"6"}}]'::jsonb, 'Application 1.9.0 · Mac', '', '', true)`);
    assert.strictEqual(env.psql("select perf::text from uber_live where plate = 'WW030070'"), '{"a": 1, "e": 1242, "h": 7.8}', 'seules les clés numériques connues sont gardées');
    assert.strictEqual(as(MGR, `select public.uber_catalog_push('[{"k":"GET /api/GetDriverLiveLocation","url":"/api/GetDriverLiveLocation","m":"GET","n":3,"first":1795000000000,"at":1795000001000,"size":12000,"res":"{status:\\"success\\"}"}]'::jsonb)`), '1');
    as(MGR, `select public.uber_catalog_push('[{"k":"GET /api/GetDriverLiveLocation","n":9,"res":""}]'::jsonb)`);
    assert.strictEqual(env.psql("select n || '|' || res from uber_catalog"), '9|{status:"success"}', 'réponse gardée, compteur mis à jour');
    assert.strictEqual(as(MGR, 'select count(*) from uber_catalog'), '0', 'catalogue : administrateur seulement');
    assert.strictEqual(as(ADMIN, 'select count(*) from uber_catalog'), '1');
    assert.throws(() => env.psql(`begin; set local role anon; select public.uber_live_push('[]'::jsonb, '', '', ''); commit;`), /permission denied|refus/);
    env.psql(`insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'rh@x') on conflict do nothing;
      insert into profiles (user_id, email, role) values ('33333333-3333-3333-3333-333333333333', 'rh@x', 'rh') on conflict (user_id) do update set role = 'rh'`);
    assert.throws(() => as('33333333-3333-3333-3333-333333333333', `select public.uber_live_push('[]'::jsonb, '', '', '')`), /Envoi refusé/);
  } finally { env.psql("truncate uber_live, uber_live_readers, uber_live_log, uber_catalog; delete from profiles where user_id = '33333333-3333-3333-3333-333333333333'; delete from auth.users where id = '33333333-3333-3333-3333-333333333333'"); env.resetDb(); }
});

test('site dans l\'application 1.8 : relevé du volet Uber Fleet envoyé à la base', async () => {
  env.resetDb();
  env.psql(`truncate uber_live, uber_live_readers; insert into vehicles (key, plate, model, active) values ('030070WW', 'WW030070', 'RAV4', 'OUI');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    // application simulée : commandes de l'application (uber_rows renvoie le dernier relevé de la page Uber Fleet)
    await page.addInitScript(() => {
      window.LUDY_APP = { version: '1.8.0', embed: true, ext: true, open: true };
      window.__evals = [];
      window.__TAURI_INTERNALS__ = { invoke: (cmd, a) => { if (cmd === 'uber_eval') window.__evals.push(a.code); return Promise.resolve(cmd === 'uber_rows' ? { rows: [{ plate: '030070', status: 'to_pickup', name: 'ALPHA Test', raw: 'En route vers le lieu de prise en charge' }], url: 'https://fleethub.uber.com/x',
        diag: 'CAT ' + JSON.stringify([{ k: 'PAGE /orgs/:id/drivers', url: '/orgs/:id/drivers', m: 'PAGE', n: 1, res: 'COLONNES Chauffeur | Statut' }]) + '\nLUDY test', age: 3, full: true } : cmd === 'uber_eval' ? 1 : null); } };
    });
    await login(page, '#/dashboard');
    for (let i = 0; i < 40 && env.psql('select count(*) from uber_live') !== '1'; i++) await page.waitForTimeout(250);
    assert.strictEqual(env.psql("select plate || '|' || vehicle_key || '|' || status || '|' || driver_name from uber_live"), 'WW030070|030070WW|to_pickup|ALPHA Test');
    assert.match(env.psql('select device from uber_live_readers'), /^Application 1\.8\.0 · /);
    assert.strictEqual(env.psql("select complete::text from uber_live_readers"), 'true', 'liste complète notée');
    for (let i = 0; i < 40 && env.psql('select count(*) from uber_catalog') !== '1'; i++) await page.waitForTimeout(250);
    assert.strictEqual(env.psql("select k || '|' || res from uber_catalog"), 'PAGE /orgs/:id/drivers|COLONNES Chauffeur | Statut', 'exploration d\'Uber Fleet enregistrée');
    assert.strictEqual(env.psql('select diag from uber_live_readers'), 'LUDY test', 'catalogue retiré du diagnostic');
    // 1.9 : code de lecture (site/uber_read.js) envoyé au volet Uber Fleet
    await page.waitForFunction(() => window.__evals.length > 0, null, { timeout: 15000 });
    assert.match(await page.evaluate(() => window.__evals[0]), /__ludyURv/);
    assert.deepStrictEqual(errors.filter(e => !/LUDY_APP|__TAURI/.test(e)), []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_live, uber_live_readers, uber_catalog'); env.resetDb(); }
});

test('application Mac : Uber Fleet ouvert caché en arrière-plan quand aucune lecture n\'arrive', async () => {
  env.resetDb();
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => {
      window.LUDY_APP = { version: '1.9.0', uber: 'https://fleethub.uber.com/orgs/x/livemap', embed: true, ext: true, open: true }; window.__pfAutoMs = 1500; window.__calls = [];
      window.__TAURI_INTERNALS__ = { invoke: (cmd, a) => { window.__calls.push([cmd, a]); return Promise.resolve(cmd === 'uber_rows' ? null : cmd === 'uber_eval' ? 0 : null); } };
    });
    await login(page, '#/dashboard');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_hide'), null, { timeout: 15000 });
    const calls = await page.evaluate(() => window.__calls.filter(c => /^ext_/.test(c[0])));
    assert.strictEqual(calls[0][0], 'ext_show'); assert.strictEqual(calls[0][1].id, 'uber'); assert.match(calls[0][1].url, /^https:\/\/([a-z0-9-]+\.)*uber\.com\//);
    assert.strictEqual(calls[1][0], 'ext_hide', 'aussitôt caché');
    // lecture reçue : plus d'ouverture
    await page.evaluate(() => { PFP.got = Date.now(); PFP.opened = 0; window.__calls = []; });
    await page.waitForTimeout(1200);
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_show').length), 0);
    assert.deepStrictEqual(errors.filter(e => !/LUDY_APP|__TAURI/.test(e)), []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});

test('lecture 1.9 : réponse de la carte filtrée par la page (2 chauffeurs sur 21 en ligne) = lecture partielle, la dernière réponse complète est préférée', () => {
  const U = require('../site/uber_read.js');
  const id = n => n + '97b48f1d-06da-4c89-8310-fe49bfd8b16a'.slice(1), vid = n => n + '317d21e1-79fb-4a0a-8e30-f5582739ac91'.slice(1);
  const loc = n => ({ driverId: { value: id(n) }, vehicleId: { value: vid(n) }, latitude: 31.6, longitude: -8, supplyActivityState: 'SUPPLY_ACTIVITY_STATE_ON_TRIP', driverStatus: 'MONITORING_SUPPLY_STATUS_ONLINE' });
  const resp = (ns, online) => JSON.stringify({ status: 'success', data: { driverLocations: ns.map(loc), driverStats: { matchedDrivers: ns.length, onlineDrivers: online } } });
  const map = { p: {}, n: {}, ph: {} }; ['1', '2', '3'].forEach(n => { map.p[vid(n)] = 'WW96820' + n; map.ph[id(n)] = 'https://x.cloudfront.net/p.jpg'; });
  const doc = { querySelectorAll: () => [] }, now = Date.now();
  const part = { url: 'https://fleethub.uber.com/api/GetDriverLiveLocation', op: '', at: now, text: resp(['1'], 3) };
  let r = U.read(doc, [part], map);
  assert.strictEqual(r.full, false, 'seule réponse filtrée : partielle');
  assert.match(r.diag, /LISTE PARTIELLE .* 1 chauffeur\(s\) .* sur 3 en ligne/);
  const comp = { url: 'https://fleethub.uber.com/api/GetDriverLiveLocation', op: '', at: now - 5000, text: resp(['1', '2', '3'], 3) };
  r = U.read(doc, [comp, part], map);
  assert.strictEqual(r.full, true); assert.strictEqual(r.rows.length, 3, 'réponse complète d\'il y a 5 s préférée à la réponse filtrée plus récente');
});

test('application 2.0 : robot Uber Fleet (ouvert caché, page rechargée si la lecture s\'arrête, alerte de connexion), démarrage automatique', async () => {
  env.resetDb();
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => {
      window.LUDY_APP = { version: '2.0.0', uber: 'https://fleethub.uber.com/orgs/x/livemap', embed: true, ext: true, open: true, extWin: true, bg: true }; window.__pfAutoMs = 500; window.__calls = []; window.__rows = null; window.__auto = false;
      window.__TAURI_INTERNALS__ = { invoke: (cmd, a) => { window.__calls.push([cmd, a]);
        if (cmd === 'autostart') { if (a && typeof a.on === 'boolean') window.__auto = a.on; return Promise.resolve(window.__auto); }
        return Promise.resolve(cmd === 'uber_rows' ? window.__rows : cmd === 'uber_eval' ? 0 : cmd === 'ext_bg' ? true : null); } };
    });
    await login(page, '#/dashboard');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_bg'), null, { timeout: 15000 });
    const bg = await page.evaluate(() => window.__calls.find(c => c[0] === 'ext_bg')[1]);
    assert.strictEqual(bg.id, 'uber'); assert.match(bg.url, /uber\.com/);
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_show').length), 0, 'Windows aussi : jamais affiché, ouvert caché');
    // aucune lecture depuis plus de 3 min : page d'Uber Fleet rechargée
    await page.evaluate(() => { PFP.got = Date.now() - 200000; PFP.bgOpened = Date.now() - 200000; PFP.start = Date.now() - 200000; PFP.bgAt = Date.now(); PFP.reloadAt = 0; pfAutoOpen(); });
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_reload').length), 1);
    // rechargement toutes les uberReloadMin minutes (1 par défaut) même si la lecture marche, sauf volet Uber affiché ou page de connexion
    await page.evaluate(() => { PFP.got = Date.now() - 5000; PFP.reloadAt = Date.now() - 61000; pfAutoOpen(); });
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_reload').length), 2, 'rechargé après 1 min');
    await page.evaluate(() => { PFP.reloadAt = Date.now() - 30000; pfAutoOpen(); });
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_reload').length), 2, 'pas avant la minute');
    await page.evaluate(() => { PFP.reloadAt = Date.now() - 61000; PFP.login = true; pfAutoOpen(); PFP.login = false; });
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_reload').length), 2, 'jamais sur la page de connexion');
    await page.evaluate(() => { S.P.uberReloadMin = 5; PFP.reloadAt = Date.now() - 120000; pfAutoOpen(); });
    assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'ext_reload').length), 2, 'réglage uberReloadMin respecté');
    await page.evaluate(() => { delete S.P.uberReloadMin; });
    // page de connexion d'Uber : bandeau sur toutes les pages
    await page.evaluate(async () => { window.__rows = { rows: [], url: 'https://auth.uber.com/v2/', diag: 'Quel est votre numéro de téléphone ou votre adresse courriel?', full: false, age: 1 }; await pfPushTick(); });
    await page.waitForSelector('#pflogin');
    assert.match(await page.innerText('#pflogin'), /Uber Fleet n'est plus connecté/);
    await page.evaluate(async () => { window.__rows = { rows: [], url: 'https://fleethub.uber.com/orgs/x/livemap', diag: '', full: true, age: 1 }; await pfPushTick(); });
    assert.strictEqual(await page.locator('#pflogin').count(), 0, 'reconnecté : bandeau retiré');
    // page Application : démarrage avec l'ordinateur, quitter
    await page.evaluate(() => { location.hash = '#/application'; });
    await page.waitForSelector('#appauto');
    await page.check('#appauto');
    await page.waitForFunction(() => window.__auto === true);
    assert.match(await page.innerText('#page'), /Robot Uber Fleet/);
    assert.deepStrictEqual(errors.filter(e => !/LUDY_APP|__TAURI/.test(e)), []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});

test('compte Uber d\'un contrat : le plus longtemps vu sur le véhicule pendant le contrat, sinon seul compte des chiffres du shift, sinon rien', () => {
  const now = Date.parse('2026-11-21T20:00:00Z'), c = { vehicle_key: 'V1', start_at: '2026-11-21T07:00:00Z', _end: Date.parse('2026-11-21T18:00:00Z') };
  const logs = [{ vehicle_key: 'V1', driver_id: 'a', driver_name: 'ALPHA', status: 'on_trip', started_at: '2026-11-21T06:00:00Z', ended_at: '2026-11-21T08:00:00Z' },
    { vehicle_key: 'V1', driver_id: 'b', driver_name: 'BETA', status: 'available', started_at: '2026-11-21T08:00:00Z', ended_at: '2026-11-21T17:00:00Z' },
    { vehicle_key: 'V1', driver_id: 'c', status: 'gone', started_at: '2026-11-21T08:00:00Z', ended_at: '2026-11-21T19:00:00Z' },
    { vehicle_key: 'V2', driver_id: 'd', status: 'on_trip', started_at: '2026-11-21T08:00:00Z', ended_at: '2026-11-21T19:00:00Z' }];
  assert.deepStrictEqual(P.pfCtrDriver(c, logs, [], now), { d: 'b', name: 'BETA', src: 'carte', others: 1 });
  const perfs = [{ vehicle_key: 'V1', driver_id: 'e', driver_name: 'EPS', updated_at: '2026-11-21T10:00:00Z' }];
  assert.deepStrictEqual(P.pfCtrDriver(c, [], perfs, now), { d: 'e', name: 'EPS', src: 'shift', others: 0 });
  assert.strictEqual(P.pfCtrDriver(c, [], perfs.concat([{ vehicle_key: 'V1', driver_id: 'f', updated_at: '2026-11-21T11:00:00Z' }]), now), null, 'deux comptes possibles : rien deviné');
  assert.strictEqual(P.pfCtrDriver(c, [], [], now), null);
  assert.strictEqual(P.pfSumData([{ data: { e: 10 } }, { data: {} }, null, { data: { e: 5.5 } }], 'e'), 15.5);
});

test('revenus Uber par contrat : contrats à lire (en cours, J-1 au même moment), chiffres enregistrés selon les agences, tableau et J-1 d\'En direct, courses du contrat', async () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Marrakech');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id) values ('968211WW', 'WW968211', 'SONATA', 'OUI', 1), ('86120T1', '86120-T-1', 'STARIA', 'OUI', 2);`);
  const A = '97b48f1d-06da-4c89-8310-fe49bfd8b16a', B = 'a3dcb299-8a4d-438a-97f7-8d5df6c657b4';
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForSelector('#liveubshift');
    // début des contrats dans le shift en cours (règle des contrats), jusqu'à 60 min avant maintenant
    const st = await page.evaluate(() => { const cur = pfShKey(pfShCur()); for (let k = 60; k > 0; k--) { const t = new Date(Date.now() - k * 60000); if (pfShKey(shiftOfCtr(t, S.P)) === cur) return t.toISOString(); } return new Date().toISOString(); });
    const y = new Date(+new Date(st) - 86400000).toISOString(), y2 = new Date(Date.now() - 86400000 + 3 * 3600000).toISOString(), e2 = new Date(Date.now() - 60000).toISOString();
    env.psql(`insert into contracts (num, name, plate, vehicle_key, start_at, end_at, status) values ('CT1', 'ALPHA Test', 'WW968211', '968211WW', '${st}', null, 'IN_PROGRESS'),
        ('CT2', 'BETA Test', '86120-T-1', '86120T1', '${st}', '${e2}', 'Terminé'), ('CT0', 'ALPHA Test', 'WW968211', '968211WW', '${y}', '${y2}', 'Terminé');
      insert into uber_live_log (plate_key, plate, vehicle_key, driver_id, driver_name, status, started_at, ended_at) values
        ('968211WW', 'WW968211', '968211WW', '${A}', 'ALPHA Test', 'on_trip', '${st}', null),
        ('86120T1', '86120-T-1', '86120T1', '${B}', 'BETA Uber', 'available', '${st}', '${e2}'),
        ('968211WW', 'WW968211', '968211WW', '${A}', 'ALPHA Test', 'on_trip', '${y}', '${y2}');`);
    await page.evaluate(async () => { PFS.at = 0; await pfShiftLoad(); });
    const ask = await page.evaluate(() => PFS.ask);
    const byP = Object.fromEntries(ask.map(x => [x.p, x]));
    assert.strictEqual(byP['ctr:CT1'].d, A); assert.strictEqual(byP['ctr:CT1'].f, +new Date(st));
    assert.strictEqual(byP['ctr:CT2'].d, B); assert.strictEqual(byP['ctr:CT2'].t, +new Date(e2), 'contrat terminé : jusqu\'à sa fin');
    assert.ok(Math.abs(byP['ctrj1:CT0'].t - (Date.now() - 86400000)) < 120000, 'contrat d\'hier arrêté à la même heure moins 24 h');
    // chiffres lus par l'application (ligne « CTRP »)
    const items = [{ p: 'ctr:CT1', d: A, f: +new Date(st), to: Date.now(), e: 600, cash: 200, t: 5, h: 2, a: 0.7 }, { p: 'ctr:CT2', d: B, f: +new Date(st), to: +new Date(e2), e: 300, t: 2, h: 1 },
      { p: 'ctrj1:CT0', d: A, f: +new Date(y), to: Date.now() - 86400000, e: 500, t: 4 }];
    assert.strictEqual(await page.evaluate(t => pfCtrPush(t), JSON.stringify(items)), true);
    assert.strictEqual(env.psql("select string_agg(period || '|' || vehicle_key || '|' || (data->>'e'), ',' order by period) from uber_perf"), 'ctr:CT1|968211WW|600,ctr:CT2|86120T1|300,ctrj1:CT0|968211WW|500', 'véhicule du contrat');
    // deux lecteurs : celui qui renvoie une période plus courte (liste figée) n'écrase pas les chiffres frais
    assert.strictEqual(await page.evaluate(t => pfCtrPush(t), JSON.stringify([{ p: 'ctr:CT1', d: A, f: +new Date(st), to: Date.now() - 3600000, e: 100, t: 1 }])), true);
    assert.strictEqual(env.psql("select data->>'e' from uber_perf where period = 'ctr:CT1'"), '600', 'période plus courte ignorée');
    // liste figée depuis 2 h : heures recalculées à l'envoi (en cours = maintenant, terminé = sa fin, J-1 = même heure hier)
    const tb = Object.fromEntries(await page.evaluate(() => { const n = Date.now(); return PFS.ask.map(x => [x.p, { t: pfAskT(Object.assign({}, x, { t: n - 7200000 }), n), n }]); }));
    assert.ok(Math.abs(tb['ctr:CT1'].t - tb['ctr:CT1'].n) < 61000, 'contrat en cours : jusqu\'à maintenant');
    assert.strictEqual(tb['ctr:CT2'].t, +new Date(e2), 'contrat terminé : sa fin');
    assert.ok(Math.abs(tb['ctrj1:CT0'].t - (tb['ctrj1:CT0'].n - 86400000)) < 61000, 'J-1 : même heure hier');
    assert.strictEqual(as(MGR, "select string_agg(period, ',' order by period) from uber_perf"), 'ctr:CT1,ctrj1:CT0', 'gestionnaire de Rabat : contrats de ses véhicules seulement');
    assert.throws(() => as(ADMIN, `select public.uber_perf_push('ctr:INCONNU', now(), '[{"d":"${A}","e":1}]'::jsonb)`), /Contrat inconnu/);
    // trois courses Uber pendant le contrat CT1
    const at = m => new Date(+new Date(st) + m * 60000).toISOString();
    env.psql(`insert into uber_trips (uuid, driver_uuid, driver_name, vehicle_key, plate, requested_at, dropoff_at, pickup_addr, drop_addr, km, status, payment) values
      ('t1', '${A}', 'ALPHA Test', '968211WW', 'WW968211', '${at(1)}', '${at(20)}', 'Gare, Marrakech', 'Menara', 7.4, 'completed', 'cash'),
      ('t2', '${A}', 'ALPHA Test', '968211WW', 'WW968211', '${at(2)}', null, 'Guéliz', null, null, 'driver_cancelled', 'card')`);
    await page.evaluate(async () => { PFS.at = 0; await pfShiftLoad(); pfShiftPaint(); });
    let t = (await page.innerText('#liveubshift')).replace(/\s+/g, ' ');
    assert.match(t, /Uber · revenus par contrat/);
    assert.match(t, /ALPHA Test CT1 ✓ WW968211/);
    assert.match(t, /BETA Test CT2 BETA Uber 86120-T-1/, 'nom du compte Uber affiché quand il diffère du contrat');
    assert.match(t, /Total \(2 contrats\) 900 MAD/);
    const c = await page.evaluate(() => pfShiftCmp());
    assert.deepStrictEqual([c.a.e, c.b.e, Math.round(c.pct * 1000) / 10], [900, 500, 80], 'J-1 : contrats d\'hier au même moment');
    assert.match(await page.evaluate(() => pfShiftChips()), /\+80 %<\/b> de plus que J-1/);
    await page.click('#tubshift tr.ubdrv[data-ubd="CT1"]');
    t = (await page.innerText('#liveubshift')).replace(/\s+/g, ' ');
    assert.match(t, /Terminée Gare, Marrakech Menara 7,4 cash/); assert.match(t, /Annulée par le chauffeur/);
    // historique des shifts
    await page.evaluate(() => { location.hash = '#/ubrev'; });
    await page.waitForSelector('#tubrev');
    t = (await page.innerText('#page')).replace(/\s+/g, ' ');
    assert.match(t, /Revenus Uber par shift/); assert.match(t, /Évolution jour après jour/);
    assert.ok(await page.locator('svg.cshchart2 rect').count() >= 1, 'barre du graphique');
    assert.match(t, /900 MAD/, 'total du shift des contrats');
    await page.click('#tubrev tr.ubdrv');
    assert.ok(await page.locator('#tubrev tr.ubdet').count() === 1, 'détail du jour déplié');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_perf, uber_live_log'); env.resetDb(); }
});
