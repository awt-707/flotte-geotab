// Module de réservation par QR : prix « façon Uber » (calcul pur), RPC publiques (reservation_tariff, create_reservation,
// create_feedback) côté anon, avis rattaché à la plaque et au chauffeur du moment, traduction en français par le collecteur.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6'), { startSite, openBrowser, login } = require('./lib/browser');
const { resvPrice, resvNight } = require('../site/reserve_calc.js');
const NOW = Date.UTC(2026, 10, 10, 12, 0);

function rpc(fn, body, token) {
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
  return fetch(env.POSTGREST + '/rpc/' + fn, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
}

test('prix façon Uber : prise en charge + km + min, course minimum, nuit, majoration, arrondi à 5 MAD', () => {
  const t = { base: 7, perKm: 3, perMin: 0.6, minFare: 20, markupPct: 10, nightPct: 15, nightFrom: 22, nightTo: 6 };
  // 7 + 3×10 + 0,6×20 = 49 ; ×1,10 = 53,9 ; arrondi 5 = 55
  assert.strictEqual(resvPrice(10, 20, t, 14).total, 55);
  // course minimum : 7 + 3×0,5 = 8,5 < 20 → 20 ; ×1,10 = 22 → 20
  assert.strictEqual(resvPrice(0.5, 2, t, 14).total, 20);
  // nuit (23 h) : 49 ×1,15 ×1,10 = 61,9 → 60
  const n = resvPrice(10, 20, t, 23); assert.ok(n.night); assert.strictEqual(n.total, 60);
  // plage de nuit 22→6 (passe minuit)
  assert.ok(resvNight(23, t) && resvNight(5, t) && !resvNight(12, t));
  // pas de majoration de nuit si nightPct = 0
  assert.ok(!resvPrice(10, 20, Object.assign({}, t, { nightPct: 0 }), 23).night);
});

test('RPC publiques (anon) : tarif + chauffeur du moment, réservation enregistrée, avis rattaché et traduit', async () => {
  const B = collector(NOW);   // réinitialise la base, charge le collecteur ; on sème ensuite
  env.psql(`insert into agencies (id, name) overriding system value values (7, 'Casablanca');
    insert into vehicles (key, plate, model, active, agency_id) values ('968199WW', 'WW968199', 'STARIA', 'OUI', 7);
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K9', 'C9', 'Karim Test', 'WW968199', '968199WW', now() - interval '2 hours', now() + interval '6 hours');
    insert into params (key, value) values ('resvEnabled','oui'),('resvBase','7'),('resvPerKm','3'),('resvPerMin','0.6'),('resvMinFare','20'),('resvMarkupPct','10'),('resvNightPct','0'),('resvNightFrom','22'),('resvNightTo','6');
    insert into profiles (user_id, email, role) values ('11111111-1111-1111-1111-111111111111','a@x','admin') on conflict (user_id) do update set role='admin';`);

  // tarif + véhicule + chauffeur présent dans la voiture en ce moment
  const tar = await rpc('reservation_tariff', { v: 'WW968199' });
  assert.strictEqual(tar.status, 200);
  assert.strictEqual(tar.data.enabled, true);
  assert.strictEqual(tar.data.driver, 'Karim Test');
  assert.strictEqual(tar.data.vehicle.plate, 'WW968199');

  // réservation (anon) : mission « Demande », prix recalculé côté base, chauffeur du moment gardé
  const res = await rpc('create_reservation', { p: { v: '968199WW', client: 'Jean Client', phone: '0612000000',
    when: new Date(NOW).toISOString(), hour: 14, pax: 2, originLabel: 'Hôtel', destLabel: 'Aéroport', km: 10, min: 20, note: 'bagages' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.ok, true); assert.strictEqual(res.data.estimate, 55);
  assert.match(res.data.number, /^DEV-\d{4}-\d{4}$/);
  assert.strictEqual(env.psql(`select status||'|'||client_name||'|'||total_ttc||'|'||agency_id||'|'||(data->'f'->>'driverNow')||'|'||(data->'f'->>'plate')||'|'||needs_validation from missions`),
    'Demande|Jean Client|55|7|Karim Test|WW968199|true');

  // avis (anon) : étoiles + message + photo ; plaque, agence et chauffeur du moment rattachés ; comment_fr vide (langue étrangère)
  const fb = await rpc('create_feedback', { p: { v: 'WW968199', rating: 2, lang: 'en', comment: 'Driver was late', photo: 'data:image/jpeg;base64,abcd' } });
  assert.strictEqual(fb.status, 200); assert.strictEqual(fb.data.ok, true);
  assert.strictEqual(env.psql(`select rating||'|'||lang||'|'||coalesce(comment_fr,'-')||'|'||plate||'|'||driver_name||'|'||agency_id||'|'||status from client_feedback`),
    '2|en|-|WW968199|Karim Test|7|Nouveau');
  assert.strictEqual(env.psql(`select left(photo,11) from client_feedback`), 'data:image/');

  // avis en français : traduit tout de suite (comment_fr = comment)
  const fr = await rpc('create_feedback', { p: { v: 'WW968199', rating: 5, lang: 'fr', comment: 'Parfait' } });
  assert.strictEqual(fr.data.ok, true);
  assert.strictEqual(env.psql(`select comment_fr from client_feedback where lang='fr'`), 'Parfait');

  // avis vide refusé
  assert.strictEqual((await rpc('create_feedback', { p: { v: 'WW968199', rating: 0 } })).status >= 400, true);

  // classement d'un avis : anon refusé, administrateur accepté
  const anon = await rpc('feedback_set', { p_id: 1, p_status: 'Traité' });
  assert.ok(anon.status >= 400, 'anon ne classe pas');
  const adm = await rpc('feedback_set', { p_id: 1, p_status: 'Traité' }, require('fs').readFileSync(__dirname + '/lib/admin.jwt', 'utf8').trim());
  assert.ok(adm.status === 200 || adm.status === 204, 'administrateur classe l\'avis (' + adm.status + ')');
  assert.strictEqual(env.psql(`select status from client_feedback where id=1`), 'Traité');

  // collecteur : message étranger traduit en français (LanguageApp)
  const out = B.run('feedbackStep_()');
  assert.match(out, /Avis clients : 1 message/);
  assert.strictEqual(env.psql(`select comment_fr from client_feedback where lang='en'`), '[fr] Driver was late');

  env.psql("update profiles set role='pending' where user_id='11111111-1111-1111-1111-111111111111'");
  env.resetDb();
});

test('volet Avis clients (administrateur) : avis affiché avec plaque, chauffeur, note et message traduit ; marquer traité', async () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('11111111-1111-1111-1111-111111111111','a@x','admin') on conflict (user_id) do update set role='admin';
    insert into agencies (id, name) overriding system value values (7, 'Casablanca');
    insert into client_feedback (vehicle_key, plate, driver_name, contract_num, agency_id, rating, lang, comment, comment_fr, status)
      values ('968199WW','WW968199','Karim Test','K9',7,2,'en','driver was late','le chauffeur était en retard','Nouveau');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/avis');
    await page.waitForSelector('.avcard');
    const c = await page.innerText('.avcard');
    assert.match(c, /WW968199/); assert.match(c, /Karim Test/); assert.match(c, /le chauffeur était en retard/); assert.match(c, /traduit de EN/);
    assert.strictEqual(await page.locator('.avcard.crit').count(), 1, 'note basse signalée');
    await page.click('.avcard [data-done]');
    await page.waitForFunction(() => { const l = document.querySelector('#avlist'); return l && /Aucun avis/.test(l.innerText); });
    assert.strictEqual(env.psql('select status from client_feedback'), 'Traité');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql("update profiles set role='pending' where user_id='11111111-1111-1111-1111-111111111111'"); env.resetDb(); }
});
