// Chauffeurs Uber en ce moment (18/11/2026, demandes d'Ahmed : en ligne, en route vers le client, en course, déconnectés), lus sur
// l'écran Uber Fleet ouvert dans l'application Ludy 1.8 (lecture uber_reader.js, envoi uber_live_push, table uber_live). Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), P = require('../site/plateformes_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
/** Lignes d'uber_live (plaque, état, il y a s secondes, état depuis s2 secondes) */
const ul = rows => rows.map(r => `insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, observed_at, status_since) values ('${r[0].replace(/[^0-9]/g, '') + r[0].replace(/[^A-Z]/g, '')}', '${r[0]}', ${r[1] ? `'${r[1]}'` : 'null'}, null, ${r[2] ? `'${r[2]}'` : 'null'}, '${r[3]}', now() - interval '${r[4]} seconds', now() - interval '${r[5] == null ? r[4] : r[5]} seconds');`).join('\n');

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
    await page.waitForSelector('#liveplat .pfblk');
    const t = await page.innerText('#liveplat');
    assert.match(t, /Uber en ce moment[\s\S]*4\s*En ligne\s*1\s*En route vers le client\s*1\s*En course\s*2\s*Disponibles/);
    await page.click('#liveplat details summary');
    assert.match(await page.innerText('#liveplat table'), /BETA Test[\s\S]*WW030071[\s\S]*En route vers le client[\s\S]*ALPHA Test[\s\S]*En course[\s\S]*GAMMA Test[\s\S]*Disponible/);
    // carte et cartes véhicules : état Uber du véhicule (plaque lue sur l'écran Uber Fleet)
    await page.waitForFunction(() => /Uber · En course/.test((document.querySelector('.vcard[data-vk="030070WW"]') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030071WW"]'), /Uber · Vers le client/);
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030075WW"]'), /Uber ·/, 'véhicule pas en ligne sur Uber : rien');
    const lbl = await page.evaluate(() => LIVE.markers['030070WW'].getElement().innerText);
    assert.match(lbl, /WW030070 · 42 km\/h\s*Uber · En course/);
    assert.match(await page.evaluate(() => LIVE.markers['030071WW'].getTooltip().getContent()), /Uber : <b>En route vers le client<\/b> · BETA Test/);
    // sous contrat, pas en ligne : « Hors ligne », en rouge s'il roule ; chauffeur en ligne avec un autre véhicule : jamais « hors ligne »
    await page.waitForFunction(() => /Hors ligne · roule/.test((document.querySelector('.vcard[data-vk="030076WW"]') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030077WW"]'), /Uber · Disponible/);
    assert.match(await page.innerText('#liveplat'), /Sous contrat mais déconnectés d'Uber et de Bolt\s*1\s*Déconnectés \(sous contrat\)\s*1\s*Déconnectés et qui roulent[\s\S]*WW030076[\s\S]*DELTA Test[\s\S]*En route · 55 km\/h/);
    // lecture arrêtée : plus aucun relevé depuis 10 min
    env.psql("update uber_live set observed_at = now() - interval '10 minutes'");
    await page.evaluate(async () => { await pfLoad(); pfPaint(); });
    assert.match(await page.innerText('#liveplat'), /Lecture de Uber arrêtée depuis le [\s\S]*chiffres pas à jour[\s\S]*—\s*En ligne/);
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030070WW"]'), /Uber ·/, 'lecture arrêtée : plus de pastille sur la carte');
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030076WW"]'), /Hors ligne/, 'lecture arrêtée : jamais « hors ligne » supposé');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_live, uber_live_readers'); env.resetDb(); }
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
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_live, uber_live_readers'); env.resetDb(); }
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
    assert.strictEqual(as(MGR, `select public.uber_live_push('${rows}'::jsonb, 'Application 1.8.0 · Windows', 'https://fleethub.uber.com/orgs/x/livemap', '')`), '3', 'plaque illisible et état inconnu ignorés');
    assert.strictEqual(env.psql("select string_agg(plate || '|' || coalesce(vehicle_key, '-') || '|' || coalesce(agency_id::text, '-') || '|' || status, ',' order by plate) from uber_live"),
      '86120-T-1|86120T1|2|available,99999-A-9|-|-|to_pickup,WW030070|030070WW|1|on_trip');
    assert.strictEqual(as(MGR, 'select count(*) from uber_live'), '1', 'gestionnaire de Rabat : ses véhicules seulement');
    assert.strictEqual(as(ADMIN, 'select count(*) from uber_live'), '3');
    // même état relu : « depuis » gardé ; autre état : remis à maintenant
    env.psql("update uber_live set status_since = now() - interval '20 minutes'");
    as(ADMIN, `select public.uber_live_push('[{"plate":"WW030070","status":"on_trip"},{"plate":"86120-T-1","status":"offline"}]'::jsonb, 'Application 1.8.0 · Mac', '', '')`);
    assert.strictEqual(env.psql("select string_agg(plate || '|' || (status_since < now() - interval '10 minutes'), ',' order by plate) from uber_live where plate <> '99999-A-9'"), '86120-T-1|false,WW030070|true');
    assert.strictEqual(env.psql("select count(*) from uber_live_readers"), '2', 'un relevé par compte et par appareil');
    assert.throws(() => env.psql(`begin; set local role anon; select public.uber_live_push('[]'::jsonb, '', '', ''); commit;`), /permission denied|refus/);
    env.psql(`insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'rh@x') on conflict do nothing;
      insert into profiles (user_id, email, role) values ('33333333-3333-3333-3333-333333333333', 'rh@x', 'rh') on conflict (user_id) do update set role = 'rh'`);
    assert.throws(() => as('33333333-3333-3333-3333-333333333333', `select public.uber_live_push('[]'::jsonb, '', '', '')`), /Envoi refusé/);
  } finally { env.psql('truncate uber_live, uber_live_readers'); env.resetDb(); }
});

test('site dans l\'application 1.8 : relevé du volet Uber Fleet envoyé à la base', async () => {
  env.resetDb();
  env.psql(`truncate uber_live, uber_live_readers; insert into vehicles (key, plate, model, active) values ('030070WW', 'WW030070', 'RAV4', 'OUI');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    // application simulée : commandes de l'application (uber_rows renvoie le dernier relevé de la page Uber Fleet)
    await page.addInitScript(() => {
      window.LUDY_APP = { version: '1.8.0', embed: true, ext: true, open: true };
      window.__TAURI_INTERNALS__ = { invoke: (cmd) => Promise.resolve(cmd === 'uber_rows' ? { rows: [{ plate: 'WW030070', status: 'to_pickup', name: 'ALPHA Test', raw: 'En route vers le lieu de prise en charge' }], url: 'https://fleethub.uber.com/x', diag: '', age: 3 } : null) };
    });
    await login(page, '#/dashboard');
    for (let i = 0; i < 40 && env.psql('select count(*) from uber_live') !== '1'; i++) await page.waitForTimeout(250);
    assert.strictEqual(env.psql("select plate || '|' || vehicle_key || '|' || status || '|' || driver_name from uber_live"), 'WW030070|030070WW|to_pickup|ALPHA Test');
    assert.match(env.psql('select device from uber_live_readers'), /^Application 1\.8\.0 · /);
    assert.deepStrictEqual(errors.filter(e => !/LUDY_APP|__TAURI/.test(e)), []);
  } finally { await br.close(); srv.kill(); env.psql('truncate uber_live, uber_live_readers'); env.resetDb(); }
});
