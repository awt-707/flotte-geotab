// Caisse : encaissements Bolt en espèces, même logique que Uber (export Bolt Fleet « Journal d'activité des services »,
// encaissement du shift, rapprochement, paie, chiffre d'affaires, copie dans le classeur de la caisse). Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), C = require('../site/caisse_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const HEAD = ['Date', 'Chauffeur ', 'Véhicule', 'Détails', 'Durée totale du service (min)', 'Plage horaire', 'Temps en ligne (min)', 'Temps de pause (min)', 'Total de trajets', 'Terminé',
  'Annulation passager', 'Annulation chauffeur', 'Total des paiements|DH', 'Espèce|DH', 'Terminal de paiement|DH', 'Dans l\'app|DH', 'Entreprise|DH'];
const line = (at, name, plate, total, cash, app) => [at, name, 'Hyundai Staria (2026)', plate + ' • Noir', '60.5', '10:00 - 11:00', '60.5', '', '2', '2', '0', '0', String(total), String(cash), '0.00', String(app || 0), '0.00'];
const csv = rows => [HEAD].concat(rows).map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');

test('lecture de l\'export Bolt : sessions (heure du Maroc, plaque, espèces, total), doublons ignorés', () => {
  const rows = [HEAD, line('2026-10-30 03:57', 'Test ALPHA', '968199WW', '50.00', '50.00'), line('2026-10-30 03:57', 'Test ALPHA', '968199WW', '50.00', '50.00'),
    line('2026-10-30 01:00', 'Beta ESSAI', '968194WW', '80.00', '0.00', '80.00'), ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']];
  const r = C.cshParseBolt(rows, (y, m, d, h, mi) => new Date(Date.UTC(y, m - 1, d, h - 1, mi)));   // heure du Maroc = UTC+1
  assert.deepStrictEqual(r.rows.map(x => [x.key, x.at, x.plate, x.total, x.cash, x.app, x.trips]), [
    ['2026-10-30 03:57|alpha test|968199WW', '2026-10-30T02:57:00.000Z', '968199WW', 50, 50, 0, 2], ['2026-10-30 01:00|beta essai|968194WW', '2026-10-30T00:00:00.000Z', '968194WW', 80, 0, 80, 2]]);
  assert.strictEqual(r.rows[0].raw['Chauffeur'], 'Test ALPHA');
  assert.match(C.cshParseBolt([['Date', 'Montant']]).error, /Espèce\|DH/);
});

test('rapprochement Bolt et paie : espèces Bolt − frais « Course Bolt » justifiés = théorique ; manquant Uber + Bolt retenu une fois', () => {
  const bolt = [{ _key: 'A', driver_name: 'Chauffeur A', cash: 300, revenue: 420, at: '2026-10-20T10:00:00Z' }, { _key: 'A', cash: 50, revenue: 50, at: '2026-10-20T12:00:00Z' },
    { _key: 'N:inconnu bolt', driver_name: 'Inconnu Bolt', cash: 90, revenue: 90, at: '2026-10-20T12:00:00Z' }];
  const moves = [{ caisse: 'bolt', kind: 'encaissement', flow: 'in', amount: 300, day: '2026-10-20', driver_code: 'A' },
    { caisse: 'depenses', kind: 'depense', flow: 'out', amount: 20, day: '2026-10-20', driver_code: 'A', ride_type: 'Course Bolt', justif: 'OK', label: 'Péage' },
    { caisse: 'depenses', kind: 'depense', flow: 'out', amount: 15, day: '2026-10-20', driver_code: 'A', ride_type: 'Course Bolt', justif: 'KO', label: 'Parking' },
    { caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 100, day: '2026-10-20', driver_code: 'A' },
    { caisse: 'bolt', kind: 'encaissement', flow: 'in', amount: 40, day: '2026-10-20', driver_code: 'B' }];
  const o = { payments: [{ driver_uuid: 'u-a', cash: 110, at: '2026-10-20T10:00:00Z' }], uuid2code: { 'u-a': 'A' }, moves, from: '2026-10-20', to: '2026-10-20', dayOfPayment: p => p.at.slice(0, 10),
    bolt, dayOfBolt: p => p.at.slice(0, 10) };
  const rb = C.cshRappro(Object.assign({}, o, { payments: bolt, dayOfPayment: o.dayOfBolt, pf: C.CSH_PF.bolt }));
  const a = rb.find(x => x.key === 'A'), n = rb.find(x => x.key === 'N:inconnu bolt'), b = rb.find(x => x.key === 'B');
  // 350 espèces Bolt − 20 de frais justifiés = 330 à remettre ; 300 remis (encaissement Uber ignoré) → manquant 30
  assert.deepStrictEqual([a.uber, a.frais, a.theo, a.net, a.ecart, a.statut, a.effet], [350, 20, 330, 300, 30, 'Manquant', 'Retenir 30 MAD']);
  assert.deepStrictEqual([n.unlinked, n.statut], [true, 'Chauffeur Bolt non relié']);
  assert.deepStrictEqual([b.unlinked, b.statut, b.effet], [true, 'Sans session Bolt', 'Aucun (export Bolt à importer)']);
  // paie : manquant Uber (110 − 100 = 10) + Bolt (30) ; « Course Bolt » sans justificatif déjà dans le manquant Bolt : pas retenue deux fois
  const pay = C.cshPayroll(o).find(x => x.key === 'A');
  assert.deepStrictEqual([pay.manquant, pay.depKo, pay.impact], [40, 0, -40]);
  // chiffre d'affaires Bolt par chauffeur et évolution par jour
  assert.deepStrictEqual(C.cshCA({ payments: bolt, from: '2026-10-20', to: '2026-10-20', by: 'day', dayOfPayment: p => p.at.slice(0, 10) }).rows.map(r => [r.key, r.total]), [['A', 470], ['N:inconnu bolt', 90]]);
  const d = C.cshDaily(o)[0];
  assert.deepStrictEqual([d.bolt, d.boltRevenue, d.boltNet, d.net], [440, 560, 340, 100]);
  assert.strictEqual(C.cshBalances(moves).bolt, 340);
});

test('base : sessions Bolt de l\'agence du véhicule, ajout seulement, doublon ignoré ; caisse « bolt »', () => {
  env.resetDb(); env.psql('truncate bolt_sessions');
  env.psql(`insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Marrakech'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 2);
    insert into vehicles (key, plate, model, active, agency_id) values ('968199WW', 'WW968199', 'STARIA', 'OUI', 2), ('968194WW', 'WW968194', 'SONATA', 'OUI', 1);`);
  try {
    as(MGR, "insert into bolt_sessions (key, at, driver_name, plate, vehicle_key, cash, total) values ('k1', now(), 'Test ALPHA', '968199WW', '968199WW', 50, 50)");
    assert.strictEqual(env.psql("select agency_id from bolt_sessions where key = 'k1'"), '2', 'agence du véhicule');
    as(MGR, "insert into bolt_sessions (key, at, driver_name, vehicle_key, cash) values ('k1', now(), 'Autre', '968199WW', 999) on conflict (key) do nothing");
    assert.strictEqual(env.psql("select cash from bolt_sessions where key = 'k1'"), '50.00');
    assert.throws(() => as(MGR, "update bolt_sessions set cash = 0"), /permission denied/);
    assert.throws(() => as(MGR, "insert into bolt_sessions (key, at, vehicle_key, cash) values ('k2', now(), '968194WW', 10)"), /row-level security/, 'véhicule d\'une autre agence');
    as(MGR, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id) values ('bolt', 'encaissement', 'in', 50, current_date, 2)");
    assert.strictEqual(env.psql("select count(*) from cash_moves where caisse = 'bolt'"), '1');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; truncate bolt_sessions`); env.resetDb(); }
});

test('page Caisse : import Bolt, encaissement Bolt du shift, rapprochement Bolt, paie et chiffre d\'affaires', async () => {
  env.resetDb(); env.psql('truncate bolt_sessions');
  const start = new Date(Date.now() - 2 * 3600000).toISOString(), end = new Date(Date.now() - 20 * 60000).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI');
    insert into drivers (code, name, phone, status) values ('C1', 'ALPHA Test', '0600000001', 'Actif');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K1', 'C1', 'ALPHA Test', 'WW968199', '968199WW', '${start}', '${end}');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/caisse?t=import');
    await page.waitForSelector('#cshfb');
    const at = ms => page.evaluate(t => localDay(t) + ' ' + localHM(t), ms);
    // pendant le contrat : session au nom du chauffeur (100 en espèces), session d'un autre nom sur le véhicule (contrat → même chauffeur, 30) ; après : export à jour
    const rows = [line(await at(Date.now() - 100 * 60000), 'Test ALPHA', '968199WW', '150.00', '100.00', '50.00'), line(await at(Date.now() - 50 * 60000), 'Nom Different', '968199WW', '30.00', '30.00'),
      line(await at(Date.now() - 5 * 60000), 'Test ALPHA', '968199WW', '0.00', '0.00')];
    const file = { name: 'Shift_activity_log.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(rows)) };
    await page.setInputFiles('#cshfb', file);
    await page.waitForFunction(() => /3 sessions Bolt lues[\s\S]*3 ajoutées/.test((document.querySelector('#cshfbr') || {}).innerText || ''));
    assert.match(await page.innerText('#cshfbr'), /Nom Different/, 'chauffeur Bolt sans chauffeur Ludy du même nom signalé');
    await page.setInputFiles('#cshfb', file);   // réimport : pas de doublon
    await page.waitForFunction(() => /0 ajoutées, 3 déjà présentes|Erreur/.test((document.querySelector('#cshfbr') || {}).innerText || ''));
    assert.match(await page.innerText('#cshfbr'), /0 ajoutées, 3 déjà présentes/);
    assert.strictEqual(env.psql("select count(*) || '|' || sum(cash) || '|' || min(vehicle_key) from bolt_sessions"), '3|130.00|968199WW');

    // encaissement Bolt du shift : 130 d'espèces Bolt, remis 150 − monnaie 30 = 120 → manquant 10
    await page.goto(page.url().replace(/#.*/, '') + '#/caisse?t=shift&pf=bolt');
    await page.waitForFunction(() => /ALPHA Test[\s\S]*130/.test((document.querySelector('.cshshift') || {}).innerText || ''));
    assert.match(await page.innerText('.cshshift thead'), /Espèces Bolt/);
    await page.fill('.cshshift .cgv', '150'); await page.fill('.cshshift .cch', '30');
    page.once('dialog', d => d.accept());
    await page.click('[data-csav="0"]');
    await page.waitForSelector('.cshshift tr.done');
    assert.strictEqual(env.psql("select caisse || '|' || amount || '|' || uber_cash || '|' || driver_code || '|' || contract_num || '|' || coalesce(uber_uuid, '-') from cash_moves"), 'bolt|120.00|130.00|C1|K1|-');
    // l'onglet Uber du même shift ne montre pas l'encaissement Bolt
    await page.goto(page.url().replace(/#.*/, '') + '#/caisse?t=shift');
    await page.waitForSelector('.cshshift'); assert.strictEqual(await page.$('.cshshift tr.done'), null);

    const day = env.psql('select day from cash_moves');
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=rapbolt&du=${day}&au=${day}`);
    await page.waitForSelector('#tcshrapb');
    assert.match(await page.innerText('#tcshrapb'), /ALPHA Test\t130[\s\S]*130[\s\S]*120[\s\S]*Retenir 10 MAD\tManquant/);
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=paie&du=${day}&au=${day}`);
    await page.waitForSelector('#tcshpay');
    assert.match(await page.innerText('#tcshpay'), /ALPHA Test[\s\S]*10/);
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=ca&par=jour&du=${day}&au=${day}`);
    await page.waitForSelector('#tcshcab');
    assert.match(await page.innerText('#tcshcab'), /ALPHA Test[\s\S]*180/);
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=bord&du=${day}&au=${day}`);
    await page.waitForSelector('.cshchart');
    assert.match(await page.innerText('#cshbody'), /120 MAD\s*Encaissements Bolt[\s\S]*130 MAD\s*Espèces déclarées par Bolt[\s\S]*120 MAD\s*Espèces Bolt encaissées/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate bolt_sessions'); }
});

test('classeur de sauvegarde : onglets Bolt créés et remplis (encaissements, sessions de l\'export)', () => {
  const { collector } = require('./lib/v6');
  env.resetDb(); env.psql('truncate bolt_sessions');
  const B = collector(Date.UTC(2026, 9, 30, 12, 0));
  const id = B.run(`SpreadsheetApp.create('Sauvegarde caisse').getId()`), book = B.books[id];
  env.psql(`insert into params (key, label, value) values ('cashSheetId', 'x', '${id}') on conflict (key) do update set value = excluded.value;
    insert into drivers (code, name) values ('C1', 'ALPHA Test');
    insert into bolt_sessions (key, at, driver_name, vehicle, plate, minutes, span, trips, done, total, cash, app) values
      ('k1', '2026-10-30T02:57:00Z', 'Test ALPHA', 'Hyundai Staria (2026)', '968199WW', 233.05, '03:57 - 07:50', 1, 1, 50, 50, 0);
    insert into cash_moves (caisse, kind, flow, amount, day, shift, driver_code, contract_num, uber_cash, given, change, source, manager_name) values
      ('bolt', 'encaissement', 'in', 45, '2026-10-29', 'Nuit', 'C1', 'K1', 50, 50, 5, 'Chauffeur', 'Gest Un');`);
  try {
    assert.match(B.run('cashSheetStep_(Date.now())'), /1 encaissements Bolt.*1 sessions Bolt/);
    const enc = book.getSheetByName('Caisse - Encaissements Bolt Ludy'), ses = book.getSheetByName('Export Bolt - Activité des services Ludy');
    assert.deepStrictEqual(enc.data[0].slice(0, 3), ['Date', 'Shift', 'Chauffeur']);
    assert.deepStrictEqual(enc.data[1], [(Date.UTC(2026, 9, 29) - Date.UTC(1899, 11, 30)) / 86400000, 'Nuit', 'ALPHA Test', 'K1', 'Gest Un', 'Encaissement chauffeur', 'Entrée de cash', 'Chauffeur', 50, 50, 5, '=J2-K2', '=IF(I2="","",I2-L2)', '']);
    assert.deepStrictEqual(ses.data[1].slice(0, 6).concat(ses.data[1].slice(12, 14)), ['2026-10-30 03:57', 'Test ALPHA', 'Hyundai Staria (2026)', '968199WW', 233.05, '03:57 - 07:50', 50, 50], 'heure du Maroc');
    assert.strictEqual(B.run('cashSheetStep_(Date.now())'), 'Classeur de la caisse : onglet « Caisse - Encaissements chauffeurs Ludy » absent, onglet « Caisse - Dépenses chauffeurs Ludy » absent, onglet « Caisse - Avance RH Ludy » absent, onglet « Caisse - Courses indep Ludy » absent, onglet « Caisse - Bonus performance Ludy » absent', 'rien de changé : onglets Bolt pas réécrits');
  } finally { env.psql("delete from params where key = 'cashSheetId'; truncate bolt_sessions"); env.resetDb(); }
});
