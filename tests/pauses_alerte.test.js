// Véhicule en pause qui bouge (14/11/2026, demande d'Ahmed : « alerte très importante ») : contrôle par le collecteur même sans Ludy ouvert
// (alerte critique, e-mail), alerte répétée sur le site tant que le véhicule n'est pas revenu, pauses sur la page En direct. Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');

test('collecteur : véhicule en pause qui bouge = pause notée, alerte critique créée une fois, gardée au recalcul, envoyée par e-mail', () => {
  env.resetDb();
  const { collector } = require('./lib/v6');
  const now = Date.now(), B = collector(now, { NOTIFY_FROM: '2026-01-01' }), iso = t => new Date(t).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active, geotab_id) values ('968199WW', 'WW968199', 'STARIA', 'OUI', 'b1'), ('968200WW', 'WW968200', 'STARIA', 'OUI', 'b2');
    insert into driver_pauses (vehicle_key, plate, driver_code, driver_name, shift_day, shift, started_at, planned_min, start_lat, start_lon)
      values ('968199WW', 'WW968199', 'C1', 'ALPHA Test', current_date, 'Jour', '${iso(now - 20 * 60000)}', 60, 33.5731, -7.5898),
             ('968200WW', 'WW968200', 'C2', 'BRAVO Test', current_date, 'Jour', '${iso(now - 2 * 60000)}', 30, null, null);
    insert into alert_recipients (email, name, min_severity, active) values ('exploitation@x', 'Exploitation', 'Haute', true);`);
  const st = (lat, drive, lat2) => JSON.stringify({ '968199WW': { dsi: { latitude: lat, longitude: -7.5898, isDriving: drive, speed: drive ? 42 : 0 } },
    '968200WW': { dsi: { latitude: lat2 || 33.40, longitude: -7.60, isDriving: false, speed: 0 } } });
  try {
    // immobile : rien ; place de la 2e pause relevée (relais indisponible à la mise en pause)
    assert.strictEqual(B.run('pauseMoveStep_(' + st(33.5733, false) + ')'), '');
    assert.strictEqual(env.psql("select count(*) from alerts"), '0');
    assert.strictEqual(env.psql("select start_lat || ',' || start_lon from driver_pauses where vehicle_key = '968200WW'"), '33.4,-7.6');
    // le véhicule roule à 1,1 km de sa place : pause notée, alerte critique
    assert.match(B.run('pauseMoveStep_(' + st(33.5831, true) + ')'), /^Pauses : 1 véhicule\(s\) en pause en mouvement, 1 alerte\(s\) créée\(s\)$/);
    assert.match(env.psql("select moved_m || '|' || moved_note from driver_pauses where vehicle_key = '968199WW'"), /^11\d\d\|à 1,1 km de sa place, 42 km\/h$/);
    const a = env.psql("select type || '|' || severity || '|' || plate || '|' || driver_name || '|' || status from alerts where id like 'PAUSE|%'");
    assert.strictEqual(a, 'Véhicule en pause en mouvement|Critique|WW968199|ALPHA Test|À traiter');
    assert.match(env.psql("select detail from alerts"), /^Chauffeur en pause depuis \d\d:\d\d : véhicule à 1,1 km de sa place, 42 km\/h \(GPS Geotab\)$/);
    // passage suivant : jamais deux fois ; statut saisi gardé
    env.psql("update alerts set status = 'En cours' where id like 'PAUSE|%'");
    B.run('pauseMoveStep_(' + st(33.59, true) + ')');
    assert.strictEqual(env.psql("select count(*) || '|' || max(status) from alerts"), '1|En cours');
    // recalcul des alertes (replace_alerts efface ce qu'il ne recalcule pas) : l'alerte de la pause est reprise
    B.run("dbRpc_('replace_alerts', { p_cut: localDay_(Date.now()), p_rows: [].concat(pauseAlertRows_(localDay_(Date.now()))) })");
    assert.strictEqual(env.psql("select count(*) || '|' || max(status) from alerts"), '1|En cours');
    // déplacement vu d'abord par le site (pause notée, pas d'alerte) : alerte créée au passage suivant
    env.psql("update driver_pauses set moved_at = now(), moved_m = 800, moved_note = 'à 800 m de sa place' where vehicle_key = '968200WW'");
    assert.match(B.run('pauseMoveStep_(' + st(33.5831, true) + ')'), /1 alerte\(s\) créée\(s\)/);
    // e-mail aux destinataires des alertes (une seule fois)
    B.run('notifyAlerts_()');
    assert.ok(B.mails.some(m => /Véhicule en pause en mouvement/.test(String(m.htmlBody || m.body || '')) && m.to === 'exploitation@x'), 'e-mail envoyé');
    assert.strictEqual(env.psql("select count(*) from alerts where notified_at is null"), '0');
  } finally { env.resetDb(); }
});

test('site, En direct : mise en pause depuis la page, alerte de déplacement répétée toutes les 2 min, déplacement autorisé', async () => {
  env.resetDb();
  const start = new Date(Date.now() - 3 * 3600000).toISOString(), end = new Date(Date.now() + 6 * 3600000).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI');
    insert into drivers (code, name, phone) values ('C1', 'ALPHA Test', '0612345678');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K1', 'C1', 'ALPHA Test', 'WW968199', '968199WW', '${start}', '${end}');
    insert into live_status (vehicle_key, plate, model, state, lat, lon, updated_at) values ('968199WW', 'WW968199', 'STARIA', 'Garé', 33.5731, -7.5898, now());`);
  let pos = { key: '968199WW', plate: 'WW968199', state: 'Garé', speed: 0, lat: 33.5731, lon: -7.5898, at: new Date().toISOString() };
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.addInitScript(() => { window.__uiDialogs = true; });
    await page.route('**/functions/v1/geotab-live**', r => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(/mode=/.test(r.request().url()) ? {} : { at: new Date().toISOString(), vehicles: [Object.assign({}, pos, { at: new Date().toISOString() })], events: [] }) }));
    await page.goto('http://localhost:8080/#/direct');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#lpveh option[value="968199WW"]', { state: 'attached' });
    await page.selectOption('#lpveh', '968199WW'); await page.selectOption('#lpdur', '30'); await page.click('#lpgo');
    await page.waitForSelector('#livepauselist .svcard');
    assert.match(await page.innerText('#livepauselist'), /ALPHA Test[\s\S]*0612345678[\s\S]*30 min prévues/);
    await page.waitForFunction(() => /En pause/.test(document.querySelector('.vcard[data-vk="968199WW"]').innerText));
    assert.strictEqual(env.psql("select driver_code || '|' || planned_min || '|' || start_lat from driver_pauses"), 'C1|30|33.5731');
    // le véhicule roule : grande alerte rouge
    pos = Object.assign({}, pos, { state: 'En route', speed: 45, lat: 33.5831 });
    await page.waitForSelector('#svov.bad', { timeout: 20000 });
    assert.match(await page.innerText('#svov'), /VÉHICULE EN PAUSE EN MOUVEMENT[\s\S]*ALPHA Test[\s\S]*WW968199[\s\S]*0612345678[\s\S]*1,1 km de sa place/);
    await page.waitForFunction(() => /EN PAUSE ET EN MOUVEMENT/.test(document.querySelector('.vcard[data-vk="968199WW"]').innerText));
    // « rappeler dans 2 min » : l'alerte revient tant que le véhicule n'est pas revenu à sa place
    await page.click('#svlater');
    await page.waitForFunction(() => !document.querySelector('#svov'));
    await page.evaluate(() => { Object.keys(SV.snooze).forEach(k => { SV.snooze[k] = 0; }); });
    await page.waitForSelector('#svov.bad', { timeout: 15000 });
    // déplacement autorisé : plus d'alerte pour cette pause
    await page.click('#svok'); await page.click('#uiok');
    await page.waitForFunction(() => !document.querySelector('#svov'));
    await page.evaluate(() => { Object.keys(SV.snooze).forEach(k => { SV.snooze[k] = 0; }); });
    await page.waitForTimeout(7000);
    assert.strictEqual(await page.locator('#svov').count(), 0, 'déplacement autorisé : plus d\'alerte');
    assert.match(env.psql('select moved_note from driver_pauses'), /^à 1,1 km de sa place, 45 km\/h$/);
    // fin de pause depuis la page En direct
    await page.click('#livepauselist [data-svend]');
    await page.waitForFunction(() => /Aucun chauffeur en pause/.test(document.querySelector('#livepauselist').innerText));
    assert.strictEqual(env.psql('select end_reason from driver_pauses'), 'Terminée par le gestionnaire');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
