// Caisse : calculs repris du classeur « Suivi Cash Chauffeurs » (rapprochement Uber, paie, CA), lecture des exports Uber et de
// l'historique du classeur, droits et garde de la base, page du site. Données synthétiques uniquement (aucun vrai chauffeur).
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), C = require('../site/caisse_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);

test('rapprochement Uber : même résultat que le classeur (théorique, écart, effet paie, statut, taux)', () => {
  const pay = [{ driver_uuid: 'u-a', driver_name: 'Chauffeur A', cash: 500, at: '2026-10-20T10:00:00Z' }, { driver_uuid: 'u-a', cash: 413, at: '2026-10-20T15:00:00Z' },
    { driver_uuid: 'u-b', driver_name: 'Chauffeur B', cash: 300, at: '2026-10-20T11:00:00Z' }, { driver_uuid: 'u-c', driver_name: 'Chauffeur C', cash: 200, at: '2026-10-20T11:00:00Z' },
    { driver_uuid: 'u-a', cash: 999, at: '2026-10-25T11:00:00Z' }];
  const moves = [{ caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 723, day: '2026-10-20', driver_code: 'A' },
    { caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 250, day: '2026-10-20', driver_code: 'B' },
    { caisse: 'depenses', kind: 'depense', flow: 'out', amount: 50, day: '2026-10-20', driver_code: 'B', ride_type: 'Course Uber', justif: 'OK', label: 'Péage' },
    { caisse: 'depenses', kind: 'depense', flow: 'out', amount: 40, day: '2026-10-20', driver_code: 'B', ride_type: 'Course Uber', justif: 'KO', label: 'Parking' },
    { caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 260, day: '2026-10-20', driver_code: 'C' },
    { caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 999, day: '2026-10-20', driver_code: 'C', cancelled_at: '2026-10-21T00:00:00Z' }];
  const r = C.cshRappro({ payments: pay, moves, from: '2026-10-20', to: '2026-10-20', uuid2code: { 'u-a': 'A', 'u-b': 'B', 'u-c': 'C' }, dayOfPayment: p => p.at.slice(0, 10), names: { A: 'Chauffeur A' } });
  const a = r.find(x => x.key === 'A'), b = r.find(x => x.key === 'B'), c = r.find(x => x.key === 'C');
  // exemple réel du classeur (montants) : espèces Uber 913, encaissé 723 → manquant 190, « Retenir 190 MAD », 79 %
  assert.deepStrictEqual([a.uber, a.frais, a.theo, a.net, a.ecart, a.effet, a.statut, Math.round(a.taux * 10000) / 100], [913, 0, 913, 723, 190, 'Retenir 190 MAD', 'Manquant', 79.19]);
  assert.deepStrictEqual([b.uber, b.frais, b.theo, b.ecart, b.statut], [300, 50, 250, 0, 'Cadré'], 'frais Uber justifiés OK seulement');
  assert.deepStrictEqual([c.ecart, c.effet, c.statut], [-60, 'Ajouter 60 MAD', 'Excédent'], 'encaissement annulé ignoré');
  assert.strictEqual(r[0].key, 'A', 'plus gros manquant en premier');

  // paie : manquant retenu, dépense sans justificatif retenue, avance retenue, prime restante et bonus à payer ajoutés
  const extra = moves.concat([{ caisse: 'rh', kind: 'avance', flow: 'out', amount: 200, day: '2026-10-20', driver_code: 'A' },
    { caisse: 'courses', kind: 'course', flow: 'in', amount: 450, day: '2026-10-20', driver_code: 'A', course_amount: 500, prime: 50, prime_paid: 50 },
    { caisse: 'courses', kind: 'course', flow: 'in', amount: 1000, day: '2026-10-20', driver_code: 'B', course_amount: 1000, prime: 100, prime_paid: 0 },
    { caisse: 'bonus', kind: 'bonus', flow: 'virement', amount: 300, day: '2026-10-20', driver_code: 'B', status: 'A payer' },
    { caisse: 'bonus', kind: 'bonus', flow: 'out', amount: 100, day: '2026-10-20', driver_code: 'C', status: 'Payé' }]);
  const p = C.cshPayroll({ payments: pay, moves: extra, from: '2026-10-20', to: '2026-10-20', uuid2code: { 'u-a': 'A', 'u-b': 'B', 'u-c': 'C' }, dayOfPayment: x => x.at.slice(0, 10) });
  const pa = p.find(x => x.key === 'A'), pb = p.find(x => x.key === 'B'), pc = p.find(x => x.key === 'C');
  assert.deepStrictEqual([pa.manquant, pa.avances, pa.primes, pa.primeReste, pa.impact, pa.declarer], [190, 200, 50, 0, -390, 250]);
  assert.deepStrictEqual([pb.depKo, pb.nDepKo, pb.primeReste, pb.bonusToPay, pb.impact], [40, 1, 100, 300, 360]);
  assert.deepStrictEqual([pc.excedent, pc.bonusPaid, pc.impact], [60, 100, 60]);

  // soldes des caisses : entrées − sorties, virements et annulations hors caisse
  const bal = C.cshBalances(extra);
  assert.deepStrictEqual([bal.uber, bal.depenses, bal.rh, bal.courses, bal.bonus], [1233, -90, -200, 1450, -100]);
  // course privée : prime 10 %, part gardée par le chauffeur = course − remis
  assert.deepStrictEqual(C.cshCourse(800, 10, 720), { prime: 80, paid: 80, reste: 0 });
  assert.deepStrictEqual(C.cshCourse(800, 10, 800), { prime: 80, paid: 0, reste: 80 });
});

test('chiffre d\'affaires et évolution : par jour de shift et par semaine', () => {
  const pay = [{ driver_uuid: 'u-a', revenue: 400, cash: 100, at: '2026-10-19' }, { driver_uuid: 'u-a', revenue: 100, cash: 0, at: '2026-10-21' }, { driver_uuid: 'u-b', revenue: 250, cash: 50, at: '2026-10-26' }];
  const ca = C.cshCA({ payments: pay, from: '2026-10-19', to: '2026-10-31', by: 'week', uuid2code: { 'u-a': 'A' }, dayOfPayment: p => p.at });
  assert.deepStrictEqual(ca.cols, ['2026-10-19', '2026-10-26']);
  assert.deepStrictEqual(ca.rows.map(r => [r.key, r.total]), [['A', 500], ['U:u-b', 250]]);
  assert.deepStrictEqual([ca.total['2026-10-19'], ca.active['2026-10-19'], ca.sum], [500, 1, 750]);
  assert.strictEqual(C.cshWeek('2026-10-25'), '2026-10-19', 'dimanche → lundi de la semaine');
  const d = C.cshDaily({ payments: pay, moves: [{ kind: 'encaissement', amount: 90, day: '2026-10-19' }, { kind: 'depense', amount: 20, day: '2026-10-19' }], from: '2026-10-19', to: '2026-10-19', dayOfPayment: p => p.at });
  assert.deepStrictEqual(d, [{ day: '2026-10-19', uber: 100, net: 90, depenses: 20, avances: 0, courses: 0, bonus: 0, depots: 0, revenue: 400 }]);
});

// export Uber « Opérations de paiement » synthétique (mêmes en-têtes que le portail)
const UBER_HEAD = ['UUID de la transaction', 'UUID du chauffeur', 'Prénom du chauffeur', 'Nom du chauffeur', 'UUID de la course', 'Description', 'Nom de l\'organisation',
  'par rapport à la création de rapport', 'Montant vous étant versé', 'Montant vous étant versé : Vos revenus', 'Montant vous étant versé : Vos revenus : Prix de la course',
  'Montant vous étant versé : Vos revenus : Pourboire', 'Montant vous étant versé : Solde des courses : Versements : Espèces collectées', 'Montant vous étant versé : Vos revenus : Bonus : Quête'];
const UBER_ROWS = [['Rapport Uber'], [], UBER_HEAD,
  ['tx-0001-aaaa-bbbb-cccc', 'aaaaaaaa-1111-2222-3333-444444444444', 'Test', 'Alpha', 'trip-1', 'trip completed order', 'Org', '2026-10-20 09:15:00.232 +0100 +01', '-35,5', '64,5', '60', '4,5', '-100', ''],
  ['tx-0002-aaaa-bbbb-cccc', 'aaaaaaaa-1111-2222-3333-444444444444', 'Test', 'Alpha', 'trip-2', 'trip completed order', 'Org', '2026-10-20 23:40:00.000 +0100 +01', '45', '45', '45', '', '0', '20'],
  ['tx-0003-aaaa-bbbb-cccc', 'bbbbbbbb-1111-2222-3333-444444444444', 'Essai', 'Beta', 'trip-3', 'trip completed order', 'Org', '', '10', '10', '10', '', '0', '']];
const UBER_CSV = UBER_ROWS.map(r => r.map(c => /[",;]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\n');
const DRV_ROWS = [['Nom du chauffeur', 'Statut', 'En temps réel', 'Téléphone portable', 'Dernière connexion', 'Adresse e-mail', 'UUID du chauffeur', 'Nom de l\'organisation'],
  ['Test Alpha', 'Actif', 'Hors ligne', '+212 6 00 00 00 01', '', 'a@exemple.ma', 'aaaaaaaa-1111-2222-3333-444444444444', 'Org'],
  ['BETA Essai', 'Actif', 'En ligne', '', '', '', 'bbbbbbbb-1111-2222-3333-444444444444', 'Org'], ['Sans UUID', 'Actif', '', '', '', '', '#N/A', 'Org']];

test('lecture des exports Uber : transactions (heure avec décalage, espèces positives), chauffeurs, rapprochement par téléphone ou nom', () => {
  const r = C.cshParseUberPayments(UBER_ROWS, null);
  assert.deepStrictEqual(r.bad, [6], 'ligne sans heure signalée');
  assert.deepStrictEqual(r.rows.map(x => [x.tx, x.at, x.cash, x.revenue, x.payout, x.fare, x.tip, x.bonus, x.driver_name]), [
    ['tx-0001-aaaa-bbbb-cccc', '2026-10-20T08:15:00.232Z', 100, 64.5, -35.5, 60, 4.5, 0, 'Test Alpha'],
    ['tx-0002-aaaa-bbbb-cccc', '2026-10-20T22:40:00.000Z', 0, 45, 45, 45, 0, 20, 'Test Alpha']]);
  assert.match(C.cshParseUberPayments([['a', 'b']]).error, /UUID de la transaction/);
  const d = C.cshParseUberDrivers(DRV_ROWS).rows;
  assert.deepStrictEqual(d.map(x => [x.uuid.slice(0, 8), x.name, x.phone, x.status]), [['aaaaaaaa', 'Test Alpha', '+212 6 00 00 00 01', 'Actif'], ['bbbbbbbb', 'BETA Essai', null, 'Actif']]);
  const ludy = [{ code: 'C1', name: 'Alpha Test', phone: '0600000001' }, { code: 'C2', name: 'Essai Beta', phone: '' }];
  assert.strictEqual(C.cshMatchDriver(d[0], ludy).code, 'C1', 'même téléphone (06… = +212 6…)');
  assert.strictEqual(C.cshMatchDriver(d[1], ludy).code, 'C2', 'même nom, mots dans un autre ordre, sans majuscules');
  assert.strictEqual(C.cshMatchDriver({ name: 'Inconnu' }, ludy), null);
});

const SHEETS = {
  'Caisse - Encaissements chauffeurs': [['Total Uber', '', '1000'], [],
    ['Date début du shift', 'Chauffeur', 'UUID Chauffeur', 'Gestionnaire', 'Opération', 'Entrée / Sortie', 'Source', 'Montant espèces affiché sur Uber', 'Montant donné par chauffeur', 'Monnaie rendue', 'Montant encaissé net', 'Manquant', 'Commentaires'],
    ['20/10/2026', 'Test Alpha', 'aaaaaaaa-1111-2222-3333-444444444444', 'Gest Un', 'Chauffeur', 'Entrée de cash', 'Chauffeur', '913', '800', '77', '723', '190', 'manque'],
    ['20/10/2026', 'Test Alpha', 'aaaaaaaa-1111-2222-3333-444444444444', 'Gest Un', 'Chauffeur', 'Entrée de cash', 'Chauffeur', '913', '800', '77', '723', '190', 'manque'],
    ['21/10/2026', '', '', 'Gest Un', 'Dépôt en banque', 'Sortie de cash', 'Banque', '', '5 000', '', '5 000', '', '']],
  'Caisse - Dépenses chauffeurs': [['Date', 'Shift', 'Chauffeur', 'UUID Chauffeur', 'Gestionnaire', 'Montant décaissé', 'Type de courses', 'Opération', 'Entrée / Sortie', 'Source', 'Justif', 'Commentaires'],
    ['20/10/2026', 'Shift 2', 'Essai Beta', '#N/A', 'Gest Un', '50', 'Course Uber', 'Péage', 'Sortie de cash', 'Chauffeur / Uber', 'OK', ''],
    ['', 'Shift 2', 'Essai Beta', '', 'Gest Un', '30', 'Course Uber', 'Parking', 'Sortie de cash', 'Chauffeur / Uber', 'KO', ''],
    ['21/10/2026', '', '', '', 'Gest Un', '0', '', 'Carburant', 'Sortie de cash', '', '', ''],
    ['21/10/2026', '', '', '', 'Gest Un', '2000', '', 'Recharge de caisse', 'Entrée de cash', 'Banque', 'N.A', '']],
  'Caisse - Avance RH': [['Date', 'Chauffeur', 'UUI Chauffeur', 'Gestionnaire', 'Montant', 'Entrée / Sortie', 'Source', 'Motif', 'Commentaires', 'AVANCE SIGNEE', ''],
    ['19/10/2026', 'Test Alpha', '', 'Gest Un', '300', 'Sortie de cash', 'Caisse RH', 'Avance sur Salaire', '', 'OK', 'médicaments']],
  'Caisse - Courses indep': [['Date d\'opération', 'Gestionnaire', 'Entrée / Sortie', 'Montant', 'Motif', 'Depart', 'Arrivé', 'Driver', 'Date de la course', 'Montant de la course', 'Commission chauffeur', 'Prime chauffeur', 'Encaissé', 'Commentaires', 'Montant pour RH', 'Montant déjà payé', 'Reste'],
    ['22/10/2026', 'Gest Un', 'Entrée de cash', '720', 'Encaissement chauffeur', 'Casablanca', 'Rabat', 'Test Alpha', '21/10/2026', '800', '10%', '80', 'OK', '', '80', '80', '0']],
  'Caisse - Bonus performance': [['Date de saisie', 'Chauffeur', 'UUI Chauffeur', 'Gestionnaire', 'Montant', 'Entrée / Sortie', 'Motif', 'Statut', 'Source'],
    ['20/10/2026', 'Essai Beta', '', 'Gest Un', '150', 'Sortie de cash', 'Challenge Shift', 'A payer', 'Caisse']],
  'Dashboard': [['Rien', 'à', 'reprendre']]
};

test('historique du classeur : chaque onglet repris, lignes à 0 ignorées, date absente reprise, pas de doublon à la réimportation', () => {
  const resolve = (n, u) => ({ driver_code: /alpha/i.test(n) ? 'C1' : null, driver_name: n || null, uber_uuid: u || null });
  const h = C.cshParseHistory(SHEETS, { resolve });
  assert.deepStrictEqual(h.counts, { uber: 3, depenses: 3, rh: 1, courses: 1, bonus: 1 });
  assert.strictEqual(h.skipped, 1, 'ligne à 0 MAD ignorée');
  const enc = h.moves.filter(m => m.kind === 'encaissement');
  assert.deepStrictEqual(enc.map(m => [m.day, m.driver_code, m.amount, m.uber_cash, m.given, m.change, m.manager_name]), [['2026-10-20', 'C1', 723, 913, 800, 77, 'Gest Un'], ['2026-10-20', 'C1', 723, 913, 800, 77, 'Gest Un']]);
  assert.notStrictEqual(enc[0].import_key, enc[1].import_key, 'deux lignes identiques = deux mouvements');
  const dp = h.moves.find(m => m.kind === 'depot');
  assert.deepStrictEqual([dp.caisse, dp.flow, dp.amount, dp.day], ['uber', 'out', 5000, '2026-10-21']);
  const dep = h.moves.filter(m => m.caisse === 'depenses');
  assert.deepStrictEqual(dep.map(m => [m.kind, m.day, m.shift, m.justif, m.amount, m.flow]), [['depense', '2026-10-20', 'Nuit', 'OK', 50, 'out'], ['depense', '2026-10-20', 'Nuit', 'KO', 30, 'out'], ['recharge', '2026-10-21', null, 'N.A', 2000, 'in']]);
  assert.match(dep[1].comment, /date absente/);
  const rh = h.moves.find(m => m.caisse === 'rh'), crs = h.moves.find(m => m.caisse === 'courses'), bon = h.moves.find(m => m.caisse === 'bonus');
  assert.deepStrictEqual([rh.kind, rh.signed, rh.amount, rh.comment], ['avance', true, 300, 'médicaments']);
  assert.deepStrictEqual([crs.kind, crs.amount, crs.course_amount, crs.commission_pct, crs.prime, crs.prime_paid, crs.label], ['course', 720, 800, 10, 80, 80, 'Casablanca → Rabat']);
  assert.match(crs.comment, /course du 21\/10\/2026/);
  assert.deepStrictEqual([bon.status, bon.label, bon.flow], ['A payer', 'Challenge Shift', 'out']);
  // même classeur relu : mêmes clés (pas de doublon dans la base)
  assert.deepStrictEqual(C.cshParseHistory(SHEETS, { resolve }).moves.map(m => m.import_key), h.moves.map(m => m.import_key));
});

test('base : gestionnaire limité à ses agences, ses saisies modifiables 24 h, historique de chaque changement, lecture seule exclue', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);`);
  try {
    const id = as(MGR, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id, driver_name, justif) values ('depenses', 'depense', 'out', 50, '2026-10-20', 1, 'Test Alpha', 'En attente') returning id");
    assert.match(id, /^\d+$/);
    assert.strictEqual(env.psql(`select created_by from cash_moves where id = ${id}`), MGR, 'auteur imposé par la base');
    assert.throws(() => as(MGR, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id) values ('depenses', 'depense', 'out', 10, '2026-10-20', 2)"), /row-level security/);
    assert.throws(() => as(MGR, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id) values ('depenses', 'depense', 'out', -5, '2026-10-20', 1)"), /check constraint/);
    // plusieurs agences : chaque caisse est séparée, une saisie sans agence est refusée
    assert.throws(() => as(MGR, "insert into cash_moves (caisse, kind, flow, amount, day) values ('depenses', 'depense', 'out', 5, '2026-10-20')"), /agence obligatoire/);
    as(MGR, `update cash_moves set amount = 55 where id = ${id}`);   // sa saisie de moins de 24 h : modifiable
    env.psql(`update cash_moves set created_at = now() - interval '2 days' where id = ${id}`);
    assert.throws(() => as(MGR, `update cash_moves set amount = 60 where id = ${id}`), /seuls le justificatif/);
    as(MGR, `update cash_moves set justif = 'OK', comment = 'ticket rangé' where id = ${id}`);
    assert.throws(() => as(MGR, `update cash_moves set created_by = '${ADMIN}' where id = ${id}`), /seuls le justificatif|non modifiables/);
    as(MGR, `delete from cash_moves where id = ${id}`);   // effacement : administrateur seul (aucune ligne touchée)
    assert.strictEqual(env.psql('select count(*) from cash_moves'), '1');
    // saisie d'un autre (administrateur) dans l'agence de Rabat : invisible ; dans Casa : visible, seul le justificatif se change
    const r2 = as(ADMIN, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id) values ('rh', 'avance', 'out', 300, '2026-10-20', 2) returning id");
    const c2 = as(ADMIN, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id) values ('uber', 'encaissement', 'in', 700, '2026-10-20', 1) returning id");
    assert.strictEqual(as(MGR, 'select count(*) from cash_moves'), '2');
    assert.throws(() => as(MGR, `update cash_moves set amount = 1 where id = ${c2}`), /seuls le justificatif/);
    // bonus payé plus tard : statut changé = sortie de caisse mise à jour par la base
    const b = as(ADMIN, "insert into cash_moves (caisse, kind, flow, amount, day, agency_id, status, source) values ('bonus', 'bonus', 'virement', 150, '2026-10-20', 1, 'A payer', 'Caisse') returning id");
    env.psql(`update cash_moves set created_at = now() - interval '3 days' where id = ${b}`);
    as(MGR, `update cash_moves set status = 'Payé' where id = ${b}`);
    assert.strictEqual(env.psql(`select flow from cash_moves where id = ${b}`), 'out');
    // historique : création, modifications (lu par l'administrateur seul)
    assert.strictEqual(as(ADMIN, `select string_agg(op, ',' order by id) from cash_log where move_id = ${id}`), 'insert,update,update,update');
    assert.strictEqual(as(MGR, 'select count(*) from cash_log'), '0');
    as(ADMIN, `delete from cash_moves where id = ${r2}`);
    assert.strictEqual(env.psql(`select op from cash_log where move_id = ${r2} order by id desc limit 1`), 'delete');
    // lecture seule et anonyme : rien
    env.psql(`update profiles set role = 'viewer' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, 'select count(*) from cash_moves'), '0');
    assert.throws(() => as(MGR, "insert into uber_payments (tx, at, agency_id) values ('x', now(), 1)"), /row-level security/);
    assert.throws(() => env.psql('begin; set local role anon; select count(*) from cash_moves; commit;'), /permission denied/);
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); }
});

test('page Caisse : imports Uber, chauffeur relié, encaissement du shift, rapprochement et paie', async () => {
  env.resetDb();
  // contrat du shift jour en cours (heure du Maroc), chauffeur Ludy au même téléphone que le chauffeur Uber
  const start = new Date(Date.now() - 2 * 3600000).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI');
    insert into drivers (code, name, phone, status) values ('C1', 'ALPHA Test', '0600000001', 'Actif'), ('C2', 'Gamma Trois', '0611111111', 'Actif');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('K1', 'C1', 'ALPHA Test', 'WW968199', '968199WW', '${start}');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser({ acceptDownloads: true });
  try {
    await login(page, '#/caisse?t=import');
    await page.waitForSelector('#cshfd');
    await page.setInputFiles('#cshfd', { name: 'driver_status.csv', mimeType: 'text/csv', buffer: Buffer.from(DRV_ROWS.map(r => r.join(',')).join('\n')) });
    await page.waitForFunction(() => /2 chauffeurs Uber[\s\S]*1 reliés/.test((document.querySelector('#cshfdr') || {}).innerText || ''));
    assert.strictEqual(env.psql("select uber_uuid from drivers where code = 'C1'"), 'aaaaaaaa-1111-2222-3333-444444444444');
    // transactions du shift en cours (synthétiques) : espèces 100 + 80
    const t1 = new Date(Date.now() - 3600000), t2 = new Date(Date.now() - 1800000), fmt = d => d.toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');
    const rows = [UBER_HEAD, ['tx-a1', 'aaaaaaaa-1111-2222-3333-444444444444', 'Test', 'Alpha', 't1', 'x', 'Org', fmt(t1), '0', '120', '120', '', '-100', ''],
      ['tx-a2', 'aaaaaaaa-1111-2222-3333-444444444444', 'Test', 'Alpha', 't2', 'x', 'Org', fmt(t2), '0', '90', '90', '', '-80', '']];
    const csv = rows.map(r => r.map(c => /[",]/.test(c) ? '"' + c + '"' : c).join(',')).join('\n');
    await page.waitForSelector('#cshfp');
    await page.setInputFiles('#cshfp', { name: 'paiements.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForFunction(() => /2 transactions lues/.test((document.querySelector('#cshfpr') || {}).innerText || ''));
    await page.setInputFiles('#cshfp', { name: 'paiements.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });   // réimport : pas de doublon
    await page.waitForFunction(() => /2 transactions lues/.test((document.querySelector('#cshfpr') || {}).innerText || ''));
    assert.strictEqual(env.psql('select count(*) || \'|\' || sum(cash) from uber_payments'), '2|180.00');

    // encaissement du shift : espèces Uber du contrat, remis 200 − monnaie 40 = 160 → manquant 20
    await page.goto(page.url().replace(/#.*/, '') + '#/caisse?t=shift');
    await page.waitForSelector('.cshshift');
    await page.waitForFunction(() => /ALPHA Test[\s\S]*180/.test(document.querySelector('.cshshift').innerText));
    await page.fill('.cshshift .cgv', '200'); await page.fill('.cshshift .cch', '40');
    assert.match(await page.innerText('.cshshift .cman'), /−\s*20|-20/);
    page.once('dialog', d => d.accept());
    await page.click('[data-csav="0"]');
    await page.waitForFunction(() => /enregistré|Annuler/.test(document.querySelector('.cshshift tr.done') ? document.querySelector('.cshshift tr.done').innerText : ''));
    assert.strictEqual(env.psql("select kind || '|' || amount || '|' || uber_cash || '|' || given || '|' || change || '|' || driver_code || '|' || contract_num from cash_moves"),
      'encaissement|160.00|180.00|200.00|40.00|C1|K1');
    assert.match(env.psql('select shift from cash_moves'), /^(Jour|Nuit)$/);
    // total du shift : espèces Uber, remis, monnaie, net, manquant
    assert.match(await page.innerText('.cshshift tfoot'), /Total · 1 \/ 1 encaissé\t\t180[\s\S]*200[\s\S]*40[\s\S]*160[\s\S]*20/);

    // dépense « Course Uber » justifiée : réduit le théorique ; rapprochement et paie
    await page.goto(page.url().replace(/#.*/, '') + '#/caisse?t=depenses');
    await page.waitForSelector('#cdsave');
    await page.fill('#cdw', 'ALPHA Test'); await page.fill('#cda', '15'); await page.selectOption('#cdj', 'OK');
    await page.click('#cdsave');
    await page.waitForFunction(() => /15/.test((document.querySelector('#tcshdep') || {}).innerText || ''));
    assert.strictEqual(env.psql("select driver_code || '|' || label || '|' || ride_type || '|' || justif from cash_moves where kind = 'depense'"), 'C1|Carburant|Course Uber|OK');
    assert.match(await page.innerText('#tcshdep tfoot'), /Total · 1 ligne[\s\S]*15/);
    const day = env.psql('select day from cash_moves where kind = \'encaissement\'');
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=rappro&du=${day}&au=${day}`);
    await page.waitForSelector('#tcshrap');
    assert.match(await page.innerText('#tcshrap'), /ALPHA Test\t180[\s\S]*15[\s\S]*165[\s\S]*160[\s\S]*Retenir 5 MAD\tManquant/);
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=paie&du=${day}&au=${day}`);
    await page.waitForSelector('#tcshpay');
    assert.match(await page.innerText('#tcshpay'), /ALPHA Test[\s\S]*5/);
    await page.goto(page.url().replace(/#.*/, '') + `#/caisse?t=bord&du=${day}&au=${day}`);
    await page.waitForSelector('.cshchart');
    assert.match(await page.innerText('#cshbody'), /Total espèces/);
    // reprise de l'historique du classeur (.xlsx) : une fois, sans doublon à la réimportation
    const XLSX = require('xlsx'), wb = XLSX.utils.book_new();
    Object.keys(SHEETS).forEach(n => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(SHEETS[n]), n.slice(0, 31)));
    const xl = { name: 'Suivi Cash.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
    await page.goto(page.url().replace(/#.*/, '') + '#/caisse?t=import');
    await page.waitForSelector('#cshfh');
    await page.setInputFiles('#cshfh', xl);
    await page.waitForFunction(() => /Historique repris|Erreur/.test((document.querySelector('#cshfhr') || {}).innerText || ''));
    assert.match(await page.innerText('#cshfhr'), /Historique repris : 9 mouvements/);
    const n = env.psql("select count(*) from cash_moves where import_key like 'xl:%'");
    await page.setInputFiles('#cshfh', xl);
    await page.waitForFunction(() => /Historique repris/.test((document.querySelector('#cshfhr') || {}).innerText || ''));
    assert.strictEqual(env.psql("select count(*) from cash_moves where import_key like 'xl:%'"), n);
    assert.strictEqual(n, '9');
    assert.strictEqual(env.psql("select count(*) from cash_moves where import_key like 'xl:%' and driver_code = 'C1'"), '4', 'chauffeur reconnu par son UUID Uber ou son nom');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); }
});

test('classeur de sauvegarde : caisse recopiée dans les onglets « … Ludy » (format et formules du classeur), transactions Uber ajoutées à la suite', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 9, 22, 12, 0));
  const id = B.run(`(function () { const b = SpreadsheetApp.create('Sauvegarde caisse');
    ['Caisse - Encaissements chauffeurs Ludy', 'Caisse - Dépenses chauffeurs Ludy', 'Caisse - Avance RH Ludy', 'Caisse - Courses indep Ludy', 'Caisse - Bonus performance Ludy',
     'Export Uber - Driver Status Ludy', 'Export Uber - Opérations de paiement Ludy'].forEach(n => b.insertSheet(n)); return b.getId(); })()`);
  const book = B.books[id], tab = n => book.getSheetByName(n), PAY = 'Export Uber - Opérations de paiement Ludy';
  // en-têtes de l'onglet du classeur d'origine (ligne 5) : colonnes d'aide A-C, export Uber de D à AJ, contrôle des doublons en AK
  const M = 'Montant vous étant versé';
  tab(PAY).maxC = 40; tab(PAY).data[4] = ['DATE', 'Prénom Nom', 'Espèces collectées', 'UUID de la transaction', 'UUID du chauffeur', 'Prénom du chauffeur', 'Nom du chauffeur', 'UUID de la course',
    'Description', 'Nom de l\'organisation', 'Alias de l\'organisation', 'par rapport à la création de rapport', M, M + ' : Vos revenus', M + ' : Solde des courses : Versements : Espèces collectées',
    M + ' : Vos revenus : Prix de la course', M + ' : Vos revenus : Taxes'].concat(Array.from({ length: 18 }, (x, i) => M + ':Vos revenus:Autre ' + i), ['', 'check doublons']);
  const pay = C.cshParseUberPayments(UBER_ROWS, null).rows[0];
  env.psql(`insert into params (key, label, value) values ('cashSheetId', 'x', '${id}');
    insert into drivers (code, name, uber_uuid) values ('C1', 'ALPHA Test', 'aaaaaaaa-1111-2222-3333-444444444444');
    insert into uber_drivers (uuid, name, phone, status) values ('aaaaaaaa-1111-2222-3333-444444444444', 'Test Alpha', '+212600000001', 'ACTIVE');
    insert into uber_payments (tx, at, driver_uuid, driver_name, first_name, last_name, raw, cash, revenue) values ('${pay.tx}', '${pay.at}', '${pay.driver_uuid}', 'Test Alpha', 'Test', 'Alpha', '${JSON.stringify(pay.raw).replace(/'/g, "''")}', 100, 64.5);
    insert into cash_moves (caisse, kind, flow, amount, day, shift, driver_code, uber_cash, given, change, source, manager_name, comment) values
      ('uber', 'encaissement', 'in', 723, '2026-10-20', 'Jour', 'C1', 913, 800, 77, 'Chauffeur', 'Gest Un', '+ à contrôler'),
      ('uber', 'depot', 'out', 5000, '2026-10-21', null, null, null, null, null, 'Banque', 'Gest Un', null);
    insert into cash_moves (caisse, kind, flow, amount, day, shift, driver_name, label, ride_type, justif, source) values
      ('depenses', 'depense', 'out', 50, '2026-10-20', 'Nuit', 'Essai Beta', 'Péage', 'Course Uber', 'En attente', 'Chauffeur / Uber');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, course_amount, commission_pct, prime, prime_paid, label, source) values
      ('courses', 'course', 'in', 720, '2026-10-22', 'C1', 800, 10, 80, 80, 'Casablanca → Rabat', 'Chauffeur');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, signed, source) values ('rh', 'avance', 'out', 300, '2026-10-19', 'C1', true, 'Caisse RH');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, label, status, source) values ('bonus', 'bonus', 'virement', 150, '2026-10-20', 'C1', 'Challenge Shift', 'A payer', 'Caisse');`);
  const serial = d => (Date.parse(d) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.match(B.run('cashSheetStep_(Date.now())'), /Encaissements chauffeurs 2.*Dépenses chauffeurs 1.*1 transactions Uber/);
  const enc = tab('Caisse - Encaissements chauffeurs Ludy').data;
  assert.deepStrictEqual(enc[7].slice(0, 13), [serial('2026-10-20'), 'Test Alpha',
    '=IF(B8="","",XLOOKUP(B8,\'Export Uber - Driver Status Ludy\'!$A:$A,\'Export Uber - Driver Status Ludy\'!$G:$G))', 'Gest Un', 'Chauffeur', 'Entrée de cash', 'Chauffeur', 913, 800, 77, '=I8-J8', '=H8-K8', '\'+ à contrôler']);
  assert.match(enc[7][13], /^=SUMIFS\('Export Uber - Opérations de paiement Ludy'!\$C\$6:\$C,.*\$B8,.*\$A8\)$/);
  assert.deepStrictEqual(enc[8].slice(4, 11), ['Dépôt en banque', 'Sortie de cash', 'Banque', '', 5000, '', '=I9-J9']);
  assert.deepStrictEqual(tab('Caisse - Dépenses chauffeurs Ludy').data[4], [serial('2026-10-20'), 'Shift 2', 'Essai Beta', '=IF(C5="","",XLOOKUP(C5,\'Export Uber - Driver Status Ludy\'!$A:$A,\'Export Uber - Driver Status Ludy\'!$G:$G))',
    '', 50, 'Course Uber', 'Péage', 'Sortie de cash', 'Chauffeur / Uber', '', '']);
  assert.deepStrictEqual(tab('Caisse - Courses indep Ludy').data[7].slice(0, 17), [serial('2026-10-22'), '', 'Entrée de cash', 720, 'Encaissement chauffeur', 'Casablanca', 'Rabat', 'Test Alpha', serial('2026-10-22'), 800, 0.1, '=J8*K8', 'Oui', '',
    '=IF($E8="Encaissement chauffeur",L8,0)', '=IF($E8="Encaissement chauffeur",J8-D8,0)', '=IF($E8="Encaissement chauffeur",O8-P8,0)']);
  assert.deepStrictEqual(tab('Caisse - Avance RH Ludy').data[4].slice(4, 10), [300, 'Sortie de cash', 'Caisse RH', 'Avance sur Salaire', '', 'OK']);
  assert.deepStrictEqual(tab('Caisse - Bonus performance Ludy').data[4].slice(4, 9), [150, 'Virement', 'Challenge Shift', 'A payer', 'Caisse']);
  assert.deepStrictEqual(tab('Export Uber - Driver Status Ludy').data[1], ['Test Alpha', 'ACTIVE', '', '+212600000001', '', '', 'aaaaaaaa-1111-2222-3333-444444444444', '']);
  const p = tab(PAY).data[5];
  assert.deepStrictEqual([p[0].slice(0, 8), p[1], p[2], p[3], p[5], p[6], p[11], p[12], p[13], p[14], p[15], p[20], p[35], p[36]],
    ['=IF(L6="', '=IF(F6="","",F6&" "&G6)', '=-O6', 'tx-0001-aaaa-bbbb-cccc', 'Test', 'Alpha', '2026-10-20 09:15:00.232 +0100 +01', -35.5, 64.5, -100, 60, 0, '', '=COUNTIFS($D:$D,D6)']);

  // rien de changé : rien d'écrit ; mouvement annulé : retiré et ligne effacée ; nouvelle transaction : ajoutée à la suite
  assert.strictEqual(B.run('cashSheetStep_(Date.now())'), '');
  env.psql("update cash_moves set cancelled_at = now() where kind = 'depot'");
  const p2 = Object.assign({}, pay, { tx: 'tx-0009' });
  env.psql(`insert into uber_payments (tx, at, first_name, last_name, raw) values ('tx-0009', '${pay.at}', 'Test', 'Alpha', '${JSON.stringify(Object.assign({}, p2.raw, { 'UUID de la transaction': 'tx-0009' })).replace(/'/g, "''")}')`);
  assert.match(B.run('cashSheetStep_(Date.now())'), /Encaissements chauffeurs 1.*1 transactions Uber/);
  assert.deepStrictEqual(enc[8].filter(x => x !== ''), []);
  assert.strictEqual(tab(PAY).data[6][3], 'tx-0009');
  assert.strictEqual(tab(PAY).data[6][0].slice(0, 8), '=IF(L7="');
});

test('deux agences : chaque agence a sa caisse (page, saisies) et son classeur de sauvegarde', async () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 9, 22, 12, 0));
  const mk = () => B.run(`(function () { const b = SpreadsheetApp.create('x'); ['Caisse - Encaissements chauffeurs Ludy', 'Caisse - Dépenses chauffeurs Ludy', 'Caisse - Avance RH Ludy', 'Caisse - Courses indep Ludy',
    'Caisse - Bonus performance Ludy', 'Export Uber - Driver Status Ludy', 'Export Uber - Opérations de paiement Ludy'].forEach(n => b.insertSheet(n)); return b.getId(); })()`);
  const s1 = mk(), s2 = mk();
  env.psql(`insert into agencies (id, name, cash_sheet_id) overriding system value values (1, 'Casa', '${s1}'), (2, 'Rabat', '${s2}');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_name, label, agency_id) values ('depenses', 'depense', 'out', 11, '2026-10-20', 'Un', 'Péage', 1), ('depenses', 'depense', 'out', 22, '2026-10-20', 'Deux', 'Parking', 2);`);
  B.run('cashSheetStep_(Date.now())');
  const dep = id => B.books[id].getSheetByName('Caisse - Dépenses chauffeurs Ludy').data.slice(4).filter(r => r.some(x => x !== '')).map(r => r[5]);
  assert.deepStrictEqual([dep(s1), dep(s2)], [[11], [22]]);

  // page : l'administrateur choisit l'agence ; la saisie va dans la caisse de cette agence, les soldes ne mélangent pas les agences
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/caisse?t=depenses');
    await page.waitForSelector('#cshag');
    assert.match(await page.innerText('#page'), /Choisir l'agence/);
    await page.selectOption('#cshag', '2');
    await page.waitForSelector('#cdsave');
    assert.match(await page.innerText('#cshbody'), /−22|-22/);
    assert.doesNotMatch(await page.innerText('#tcshdep'), /Péage/);
    await page.fill('#cdw', 'Trois'); await page.fill('#cda', '33'); await page.click('#cdsave');
    await page.waitForFunction(() => /33/.test((document.querySelector('#tcshdep') || {}).innerText || ''));
    assert.strictEqual(env.psql("select agency_id from cash_moves where amount = 33"), '2');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); }
});

test('historique des encaissements : solde identique au classeur (chauffeur non renseigné gardé, ligne sans entrée / sortie hors caisse, sens du classeur respecté)', () => {
  const H = ['Date début du shift', 'Chauffeur', 'UUID Chauffeur', 'Gestionnaire', 'Opération', 'Entrée / Sortie', 'Source', 'Montant espèces affiché sur Uber', 'Montant donné par chauffeur', 'Monnaie rendue', 'Montant encaissé net', 'Manquant', 'Commentaires'];
  const sheet = { 'Caisse - Encaissements chauffeu': [H,
    ['20/09/2026', 'Test Alpha', '', 'G', 'Chauffeur', 'Entrée de cash', 'Chauffeur', '500', '500', '', '500', '0', ''],
    ['20/09/2026', '', '', 'G', 'Chauffeur', 'Entrée de cash', 'Chauffeur', '300', '300', '', '300', '0', ''],
    ['20/09/2026', 'Test Alpha', '', 'G', 'Dépôt en banque', 'Entrée de cash', 'Chauffeur', '100', '100', '', '100', '0', ''],
    ['', '', '', '', 'Dépôt en banque', 'Sortie de cash', 'Banque', '', '', '', '700', '', ''],
    ['', '', '', '', '', '', 'Banque', '', '', '', '2 078', '', '']] };
  // solde du classeur = SOMME.SI.ENS(net ; Entrée) − SOMME.SI.ENS(net ; Sortie) = 500 + 300 + 100 − 700 = 200
  const h = C.cshParseHistory(sheet, {});
  assert.deepStrictEqual([h.moves.length, h.skipped, C.cshBalances(h.moves).uber], [5, 0, 200]);
  assert.match(h.moves[1].comment, /chauffeur non renseigné/);
  assert.deepStrictEqual([h.moves[2].kind, h.moves[2].flow], ['depot', 'in']); assert.match(h.moves[2].comment, /à vérifier/);
  assert.deepStrictEqual([h.moves[3].flow, h.moves[3].day], ['out', '2026-09-20']); assert.match(h.moves[3].comment, /date absente/);
  assert.deepStrictEqual([h.moves[4].kind, h.moves[4].flow, h.moves[4].amount], ['autre', 'virement', 2078]);
});
