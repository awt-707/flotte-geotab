// Caisse : classeur Google par agence (copie vierge créée par le collecteur), rapports des encaissements, compte rendu avec graphiques,
// bordereau de dépôt en banque (30/10/2026). Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), C = require('../site/caisse_calc.js'), { ctrFrWords } = require('../site/contrat_modele.js'), { startSite, openBrowser, login } = require('./lib/browser');

test('périodes, synthèse, courbes, billetage, montant en lettres, dépôt', () => {
  // semaine du lundi au dimanche ; mois ; période précédente de même durée
  assert.deepStrictEqual(C.cshPresets('2026-10-30').map(x => [x.id, x.from, x.to]),
    [['sp', '2026-10-19', '2026-10-25'], ['sc', '2026-10-26', '2026-10-30'], ['mp', '2026-09-01', '2026-09-30'], ['mc', '2026-10-01', '2026-10-30']]);
  assert.deepStrictEqual(C.cshPresets('2026-01-12').find(x => x.id === 'mp'), { id: 'mp', label: 'Mois précédent', from: '2025-12-01', to: '2025-12-31' });
  assert.deepStrictEqual(C.cshPrev('2026-10-19', '2026-10-25'), { from: '2026-10-12', to: '2026-10-18' });
  assert.strictEqual(C.cshPct(110, 100).toFixed(2), '0.10'); assert.strictEqual(C.cshPct(5, 0), null);

  const day = p => p.at.slice(0, 10);
  const o = { from: '2026-10-20', to: '2026-10-21', uuid2code: { 'u-a': 'A' }, dayOfPayment: day, dayOfBolt: day,
    payments: [{ driver_uuid: 'u-a', cash: 300, revenue: 500, at: '2026-10-20T10:00:00Z' }, { driver_uuid: 'u-a', cash: 0, revenue: 200, at: '2026-10-21T10:00:00Z' }],
    bolt: [{ _key: 'A', cash: 100, revenue: 150, at: '2026-10-21T09:00:00Z' }],
    moves: [{ caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 280, day: '2026-10-20', driver_code: 'A' },
      { caisse: 'bolt', kind: 'encaissement', flow: 'in', amount: 100, day: '2026-10-21', driver_code: 'A' },
      { caisse: 'courses', kind: 'course', flow: 'in', amount: 450, course_amount: 500, day: '2026-10-21', driver_code: 'A' },
      { caisse: 'depenses', kind: 'depense', flow: 'out', amount: 40, day: '2026-10-21', driver_name: 'X', label: 'Péage' },
      { caisse: 'uber', kind: 'depot', flow: 'out', amount: 1000, day: '2026-10-21' },
      { caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 999, day: '2026-10-21', driver_code: 'A', cancelled_at: '2026-10-21T12:00:00Z' }] };
  const s = C.cshSummary(o);
  assert.deepStrictEqual([s.uber, s.uberNet, s.bolt, s.boltNet, s.courses, s.coursesCA, s.revenue, s.boltRevenue, s.ca, s.cash, s.depenses, s.depots, s.manquant, s.active, s.nEnc],
    [300, 280, 100, 100, 450, 500, 700, 150, 1350, 830, 40, 1000, 20, 1, 2], 'mouvement annulé ignoré ; CA = Uber + Bolt + courses privées');
  assert.strictEqual(s.taux.toFixed(4), (380 / 400).toFixed(4), 'taux de remise = encaissé / à remettre (chauffeurs reliés)');
  // courbes : chaque jour de la période, jours sans activité compris ; par semaine au-delà de 45 jours
  const b = C.cshBuckets(s.daily, '2026-10-19', '2026-10-22');
  assert.deepStrictEqual(b.list.map(x => [x.key, x.revenue, x.boltRevenue, x.courses]), [['2026-10-19', 0, 0, 0], ['2026-10-20', 500, 0, 0], ['2026-10-21', 200, 150, 450], ['2026-10-22', 0, 0, 0]]);
  const w = C.cshBuckets(s.daily, '2026-09-01', '2026-10-30');
  assert.strictEqual(w.by, 'week'); assert.deepStrictEqual(w.list.find(x => x.key === '2026-10-19').revenue, 700);
  // billetage, montant en lettres
  assert.strictEqual(C.cshBillTotal([5, 2, 1, 0, 0, 1, 0, 0, 3]), 1256.5);
  assert.strictEqual(C.cshMadWords(1256.5, ctrFrWords), 'mille deux cent cinquante-six dirhams et cinquante centimes');
  assert.strictEqual(C.cshMadWords(1, ctrFrWords), 'un dirham');
  // dépôt : solde de fin de journée, dernier dépôt, espèces entrées depuis
  const dep = C.cshDepositInfo(o.moves.concat([{ caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 70, day: '2026-10-22', driver_code: 'A' }]), '2026-10-22');
  assert.deepStrictEqual([dep.balances.uber, dep.balances.bolt, dep.balances.courses, dep.balances.depenses, dep.lastDeposit], [-650, 100, 450, -40, '2026-10-21']);
  assert.deepStrictEqual(dep.since, [{ day: '2026-10-22', uber: 70, bolt: 0, courses: 0, total: 70 }]);
});

test('classeur par agence : copie vierge du modèle créée pour chaque nouvelle agence, une seule fois, caisse recopiée dedans', () => {
  env.resetDb();
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 9, 30, 12, 0));
  // modèle = classeur de Casablanca, avec ses données et ses onglets de calcul (formules)
  const tpl = B.run(`(function () { const b = SpreadsheetApp.create('Suivi Cash Chauffeurs - Luxury-impot_ludy');
    ['Caisse - Encaissements chauffeurs Ludy', 'Caisse - Dépenses chauffeurs Ludy', 'Caisse - Avance RH Ludy', 'Caisse - Courses indep Ludy', 'Caisse - Bonus performance Ludy',
     'Export Uber - Driver Status Ludy', 'Export Uber - Opérations de paiement Ludy', 'Base gestionnaire/Chauffeur Ludy', 'Dashboard Ludy'].forEach(n => b.insertSheet(n)); return b.getId(); })()`);
  const folder = B.newFolder('Caisse'); B.driveFiles[tpl].moveTo(folder);
  const tb = B.books[tpl], T = n => tb.getSheetByName(n);
  T('Caisse - Encaissements chauffeurs Ludy').data = [['ENCAISSEMENTS'], [], [], [], [], [], ['Date', 'Chauffeur'], [46300, 'Chauffeur Casa'], [46301, 'Autre Casa']];
  T('Caisse - Dépenses chauffeurs Ludy').data = [['DÉPENSES'], [], [], ['Date'], [46300, 'Shift 1', 'Chauffeur Casa']];
  T('Export Uber - Opérations de paiement Ludy').data = [[], [], [], [], ['DATE', 'Prénom Nom'], ['=IF(L6="";"";1)', 'Chauffeur Casa', -100, 'tx-casa']];
  T('Export Uber - Driver Status Ludy').data = [['Nom'], ['Chauffeur Casa', 'ACTIVE']];
  T('Base gestionnaire/Chauffeur Ludy').data = [['Gestionnaire'], ['Gestionnaire Casa']];
  T('Dashboard Ludy').data = [['Clicar Maroc × Uber — Pilotage des Espèces'], [], ['Du', 46260], [], [], ['=SUMIFS(\'Caisse - Encaissements chauffeurs Ludy\'!$K$8:$K;1)']];
  env.psql(`insert into agencies (id, name, cash_sheet_id) overriding system value values (1, 'Casablanca', '${tpl}'), (2, 'Marrakech', null);
    insert into profiles (user_id, email, role) values ('22222222-2222-2222-2222-222222222222', 'g@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into cash_moves (caisse, kind, flow, amount, day, driver_name, label, agency_id, manager_name) values ('depenses', 'depense', 'out', 35, '2026-10-29', 'Chauffeur Marrakech', 'Péage', 2, 'Gestionnaire Kech');`);
  const out = B.run('cashSheetStep_(Date.now())');
  const nid = env.psql('select cash_sheet_id from agencies where id = 2');
  assert.ok(nid && nid !== tpl, 'classeur créé et enregistré pour Marrakech : ' + out);
  assert.match(out, /classeur créé pour Marrakech/);
  const nb = B.books[nid], N = n => nb.getSheetByName(n), rows = (n, first) => N(n).data.slice(first - 1).filter(r => r && r.some(x => x !== '' && x != null));
  assert.strictEqual(B.driveFiles[nid].name, 'Suivi Cash Chauffeurs - Marrakech - Ludy');
  assert.strictEqual(B.driveFiles[nid].folder, folder, 'rangé dans le dossier du modèle');
  // même tableau, vierge : en-têtes et formules de calcul gardés, données de Casablanca effacées
  assert.deepStrictEqual(N('Caisse - Encaissements chauffeurs Ludy').data[6], ['Date', 'Chauffeur']);
  assert.deepStrictEqual(rows('Caisse - Encaissements chauffeurs Ludy', 8), []);
  assert.deepStrictEqual(rows('Export Uber - Opérations de paiement Ludy', 6), []);
  assert.deepStrictEqual(rows('Export Uber - Driver Status Ludy', 2), []);
  assert.deepStrictEqual(N('Dashboard Ludy').data[5], T('Dashboard Ludy').data[5], 'formules des tableaux de bord gardées');
  // la caisse de Marrakech y est recopiée (seulement elle), liste des gestionnaires = ceux des saisies de l'agence
  assert.deepStrictEqual(rows('Caisse - Dépenses chauffeurs Ludy', 5).map(r => [r[2], r[5]]), [['Chauffeur Marrakech', 35]]);
  assert.deepStrictEqual(rows('Base gestionnaire/Chauffeur Ludy', 2).map(r => r[0]), ['Gestionnaire Kech']);
  assert.deepStrictEqual(T('Caisse - Dépenses chauffeurs Ludy').data[4].slice(0, 3), [46300, 'Shift 1', 'Chauffeur Casa'], 'classeur de Casablanca intact');
  assert.deepStrictEqual(T('Base gestionnaire/Chauffeur Ludy').data[1], ['Gestionnaire Casa'], 'liste des gestionnaires de Casablanca gardée');
  // une seule création : passage suivant sans nouveau classeur ; lien retiré à la main = pas recréé
  const nBooks = Object.keys(B.books).length;
  B.run('cashSheetStep_(Date.now())');
  env.psql('update agencies set cash_sheet_id = null where id = 2');
  B.run('cashSheetStep_(Date.now())');
  assert.strictEqual(Object.keys(B.books).length, nBooks);
  assert.strictEqual(env.psql('select coalesce(cash_sheet_id, \'-\') from agencies where id = 2'), '-');
  // « Créer un nouveau classeur vierge » : administrateur seulement
  assert.match(B.run(`jobCashSheetNew_(['2'], '22222222-2222-2222-2222-222222222222')`), /Refusé/);
  env.psql("insert into profiles (user_id, email, role) values ('11111111-1111-1111-1111-111111111111', 'a@x', 'admin') on conflict (user_id) do update set role = 'admin'");
  assert.match(B.run(`jobCashSheetNew_(['2'], '11111111-1111-1111-1111-111111111111')`), /Marrakech : https:\/\/docs\.google\.com\/spreadsheets\/d\//);
  assert.notStrictEqual(env.psql('select coalesce(cash_sheet_id, \'-\') from agencies where id = 2'), '-');
  env.psql("update profiles set role = 'pending' where user_id = '22222222-2222-2222-2222-222222222222'");
  env.resetDb();
});

test('page Caisse : rapports (PDF, tableur, graphiques) et bordereau de dépôt en banque enregistré dans la caisse', async () => {
  env.resetDb();
  const d1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10), d2 = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
  env.psql(`insert into drivers (code, name, uber_uuid) values ('C1', 'ALPHA Test', 'aaaaaaaa-1111-2222-3333-444444444444');
    insert into uber_payments (tx, at, driver_uuid, driver_name, cash, revenue) values ('t1', '${d1}T10:00:00Z', 'aaaaaaaa-1111-2222-3333-444444444444', 'Test Alpha', 300, 520),
      ('t0', '${d2}T10:00:00Z', 'aaaaaaaa-1111-2222-3333-444444444444', 'Test Alpha', 100, 260);
    insert into cash_moves (caisse, kind, flow, amount, day, shift, driver_code, uber_cash, given, change, manager_name) values
      ('uber', 'encaissement', 'in', 280, '${d1}', 'Jour', 'C1', 300, 300, 20, 'Gest Un'), ('uber', 'encaissement', 'in', 100, '${d2}', 'Jour', 'C1', 100, 100, 0, 'Gest Un');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, course_amount, commission_pct, prime, prime_paid, label) values ('courses', 'course', 'in', 400, '${d1}', 'C1', 450, 10, 45, 50, 'Casablanca → Rabat');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    const base = () => page.url().replace(/#.*/, '');
    await login(page, `#/caisse?t=rapports&du=${d1}&au=${d1}`);
    await page.waitForSelector('#cshrep');
    const body = await page.innerText('#cshbody');
    assert.match(body, /970 MAD[^\n]*\n[^\n]*\nChiffre d'affaires total/, 'CA = Uber 520 + courses privées 450');
    assert.match(body, /680 MAD[^\n]*\n[^\n]*\nEspèces encaissées/);
    assert.match(body, /comparée au mercredi|comparée au (lundi|mardi|jeudi|vendredi|samedi|dimanche)/);
    assert.match(body, /Manquant à retenir/);
    assert.ok(await page.$('#cshbody svg.cshchart2'), 'graphiques sur la page');
    const [pdf1] = await Promise.all([page.waitForEvent('download'), page.click('#cshrep')]);
    assert.match(pdf1.suggestedFilename(), new RegExp('^encaissements_agence_' + d1 + '_' + d1 + '\\.pdf$'));
    const [xls] = await Promise.all([page.waitForEvent('download'), page.click('#cshrepx')]);
    assert.match(xls.suggestedFilename(), /^encaissements_agence_.*\.xlsx$/);
    const [pdf2] = await Promise.all([page.waitForEvent('download'), page.click('#cshcr')]);
    assert.match(pdf2.suggestedFilename(), /^compte_rendu_caisse_agence_.*\.pdf$/);
    // contenu du PDF : graphiques dessinés et tableaux (texte du PDF lu par la page)
    const rep = await page.evaluate(([a]) => { const r = cshRepCR({ from: a, to: a }); return { charts: r.tables.filter(t => t.chart).length, rows: r.tables.find(t => t.title === 'Chauffeurs').rows }; }, [d1]);
    assert.strictEqual(rep.charts, 5);
    assert.match(rep.rows[0].join('|'), /ALPHA Test\|520 MAD\|0 MAD\|520 MAD/);

    // bordereau : solde des encaissements Uber (380) et des courses (400) ; billetage = montant déposé
    await page.goto(base() + '#/caisse?t=depot');
    await page.waitForSelector('#dpsave');
    await page.fill('#dpbank', 'Banque Test'); await page.fill('#dpacc', '000 111 222'); await page.fill('#dpwho', 'Déposant Test');
    assert.strictEqual(await page.inputValue('[data-dpam="uber"]'), '380');
    assert.strictEqual(await page.inputValue('[data-dpam="courses"]'), '400');
    await page.fill('[data-dpn="0"]', '3'); await page.fill('[data-dpn="1"]', '1');   // 3 × 200 + 100 = 700 ≠ 780
    await page.click('#dpsave');
    await page.waitForFunction(() => /ne correspond pas/.test((document.querySelector('#dpres') || {}).innerText || ''));
    assert.strictEqual(env.psql("select count(*) from cash_moves where kind = 'depot'"), '0');
    await page.fill('[data-dpn="3"]', '4');   // + 4 × 20 = 780
    assert.match(await page.innerText('#dptot'), /780 MAD[\s\S]*sept cent quatre-vingts dirhams[\s\S]*égal au montant déposé/);
    page.once('dialog', d => d.accept());
    const [dep] = await Promise.all([page.waitForEvent('download'), page.click('#dpsave')]);
    assert.match(dep.suggestedFilename(), /^bordereau_depot_agence_\d{4}-\d{2}-\d{2}_DEP-0-\d{8}-1\.pdf$/);
    await page.waitForFunction(() => /Dépôt enregistré/.test((document.querySelector('#dpres') || {}).innerText || ''));
    assert.strictEqual(env.psql("select string_agg(caisse || ':' || amount || ':' || flow, ',' order by caisse) from cash_moves where kind = 'depot'"), 'courses:400.00:out,uber:380.00:out');
    assert.match(env.psql("select min(comment) from cash_moves where kind = 'depot'"), /^Bordereau DEP-0-\d{8}-1 · Banque Test · déposé par Déposant Test$/);
    // après le dépôt : caisses à 0, banque et compte gardés pour le prochain bordereau
    assert.strictEqual(await page.inputValue('[data-dpam="courses"]'), '');
    assert.strictEqual(await page.inputValue('#dpbank'), 'Banque Test');
    assert.match(await page.innerText('#tcshdph'), /Bordereau DEP-0-/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
