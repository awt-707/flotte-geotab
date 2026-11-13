// Promotions Uber / Bolt à l'encaissement du shift (13/11/2026, demande d'Ahmed) : le client paie moins que le montant affiché par la
// plateforme (promotion) ; la différence n'est pas un manque du chauffeur, elle est suivie jusqu'à son paiement par la plateforme.
// Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), C = require('../site/caisse_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const MGR = '22222222-2222-2222-2222-222222222222';

test('promotion : jamais un manque du chauffeur (shift, rapprochement, paie), suivie par statut', () => {
  const d = '2026-11-12';
  const mv = [{ id: 1, caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 260, uber_cash: 300, promo: 40, promo_status: 'À vérifier', day: d, shift: 'Jour', driver_code: 'A', contract_num: 'K1', created_at: d + 'T10:00:00Z' },
    { id: 2, caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 250, uber_cash: 300, promo: 20, promo_status: 'Payée', day: d, shift: 'Nuit', driver_code: 'B', contract_num: 'K2', created_at: d + 'T22:00:00Z' },
    { id: 3, caisse: 'bolt', kind: 'encaissement', flow: 'in', amount: 90, uber_cash: 100, promo: 10, promo_status: 'Non payée', day: d, shift: 'Jour', driver_code: 'A', contract_num: 'K1', created_at: d + 'T11:00:00Z' },
    { id: 4, caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 500, uber_cash: null, promo: 30, day: d, shift: 'Jour', driver_code: 'A', contract_num: 'K1', created_at: d + 'T12:00:00Z', cancelled_at: d + 'T13:00:00Z' }];
  // shift : 300 affichés, 260 remis, 40 de promotion = cadré ; 300 − 250 − 20 = 30 de manque
  assert.deepStrictEqual(C.cshShortfalls(mv).map(x => [x.caisse, x.contract_num, x.promo, x.dueAtShift, x.status]),
    [['uber', 'K1', 40, 0, 'Cadré'], ['bolt', 'K1', 10, 0, 'Cadré'], ['uber', 'K2', 20, 30, 'Manquant']]);
  // rapprochement : espèces de l'export − promotion = à remettre
  const pay = [{ driver_uuid: 'ua', cash: 300, at: d + 'T09:00:00Z' }, { driver_uuid: 'ub', cash: 300, at: d + 'T21:00:00Z' }];
  const o = { payments: pay, moves: mv, from: d, to: d, uuid2code: { ua: 'A', ub: 'B' }, dayOfPayment: p => p.at.slice(0, 10) };
  const rap = C.cshRappro(o);
  assert.deepStrictEqual(rap.map(r => [r.key, r.uber, r.promo, r.theo, r.net, r.ecart, r.statut]), [['B', 300, 20, 280, 250, 30, 'Manquant'], ['A', 300, 40, 260, 260, 0, 'Cadré']]);
  // paie : seul le vrai manque (30) est retenu
  assert.deepStrictEqual(C.cshPayroll(Object.assign({}, o, { rappro: rap })).map(r => [r.key, r.manquant]), [['B', 30]]);
  // suivi : statuts, totaux, annulé ignoré
  const P = C.cshPromos(mv, d, d);
  assert.deepStrictEqual(P.rows.map(r => [r.caisse, r.driver_code, r.promo, r.status]), [['uber', 'A', 40, 'À vérifier'], ['uber', 'B', 20, 'Payée'], ['bolt', 'A', 10, 'Non payée']]);
  assert.deepStrictEqual([P.total, P.check, P.paid, P.unpaid], [70, 40, 20, 10]);
});

test('classeur de sauvegarde : espèces du shift sans la promotion, promotion notée dans le commentaire', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 10, 12, 12, 0));
  const m = { kind: 'encaissement', flow: 'in', amount: 260, given: 260, change: 0, uber_cash: 300, promo: 40, promo_status: 'Payée', day: '2026-11-12', source: 'Chauffeur', comment: 'client pressé' };
  const u = JSON.parse(B.run('JSON.stringify(cshSheetRow_("uber", ' + JSON.stringify(m) + ', 8, "ALPHA Test"))'));
  assert.deepStrictEqual([u[7], u[12]], [260, 'client pressé · Promotion Uber 40 MAD (Payée)']);
  const b = JSON.parse(B.run('JSON.stringify(cshBoltEncRow_(' + JSON.stringify(Object.assign({}, m, { comment: null, promo_status: null })) + ', 8, "ALPHA Test"))'));
  assert.deepStrictEqual([b[8], b[13]], [260, 'Promotion Bolt 40 MAD (À vérifier)']);
  const n = JSON.parse(B.run('JSON.stringify(cshSheetRow_("uber", ' + JSON.stringify(Object.assign({}, m, { promo: null })) + ', 8, "ALPHA Test"))'));
  assert.deepStrictEqual([n[7], n[12]], [300, 'client pressé'], 'sans promotion : inchangé');
});

test('base : promotion enregistrée ; statut modifiable par le gestionnaire même après 24 h, pas le montant', () => {
  env.resetDb();
  env.psql(`insert into agencies (id, name) overriding system value values (1, 'Casablanca');
    insert into profiles (user_id, email, role) values ('${MGR}', 'g@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);`);
  try {
    as(MGR, `insert into cash_moves (caisse, kind, flow, amount, day, driver_name, agency_id, uber_cash, promo, promo_status) values ('uber', 'encaissement', 'in', 260, current_date, 'ALPHA Test', 1, 300, 40, 'À vérifier')`);
    assert.throws(() => as(MGR, `insert into cash_moves (caisse, kind, flow, amount, day, driver_name, agency_id, promo, promo_status) values ('uber', 'encaissement', 'in', 1, current_date, 'X', 1, 1, 'Peut-être')`), /promo_status_check/);
    env.psql(`update cash_moves set created_at = now() - interval '3 days'`);   // saisie de plus de 24 h
    as(MGR, "update cash_moves set promo_status = 'Payée'");
    assert.strictEqual(env.psql('select promo || \'|\' || promo_status from cash_moves'), '40.00|Payée');
    assert.throws(() => as(MGR, 'update cash_moves set promo = 10'), /24 h/);
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('encaissement du shift : promotion saisie (pas de manque), onglet Promotions, statut « Payée »', async () => {
  env.resetDb();
  const start = new Date(Date.now() - 3 * 3600000).toISOString(), end = new Date(Date.now() - 3600000).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI');
    insert into drivers (code, name) values ('C1', 'ALPHA Test');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K1', 'C1', 'ALPHA Test', 'WW968199', '968199WW', '${start}', '${end}');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    const base = () => page.url().replace(/#.*/, '');
    await login(page, '#/caisse?t=shift');
    await page.waitForSelector('.cshshift');
    const sel = await page.evaluate(() => { const c = CS.ctr.find(x => x.num === 'K1'); return { day: c._day, s: c._shift }; });
    await page.goto(base() + `#/caisse?t=shift&jour=${sel.day}&s=${sel.s}`); await page.waitForSelector('.cshshift .cpr');
    assert.match(await page.innerText('.cshshift thead'), /Promotion Uber/);
    // export pas importé : le chauffeur remet 260, la promotion Uber fait 40 (300 affichés) ; aucun manque
    await page.fill('.cshshift .cgv', '260'); await page.fill('.cshshift .cpr', '40');
    await page.click('[data-csav="0"]');
    await page.waitForSelector('.cshshift tr.done');
    assert.strictEqual(await page.locator('.cshshift tr.done.short').count(), 0, 'pas de ligne rouge');
    assert.match(await page.innerText('.cshshift tr.done'), /300 MAD[\s\S]*260 MAD[\s\S]*40 MAD\s*À vérifier/);
    assert.strictEqual(env.psql("select amount || '|' || uber_cash || '|' || promo || '|' || promo_status from cash_moves"), '260.00|300.00|40.00|À vérifier');
    // onglet Promotions : à vérifier, puis marquée payée par Uber
    await page.goto(base() + `#/caisse?t=promos&du=${sel.day}&au=${sel.day}`); await page.waitForSelector('table.cshpr');
    assert.match(await page.innerText('#cshbody .cards'), /40 MAD[\s\S]*Promotions de la période[\s\S]*40 MAD\s*À vérifier/);
    assert.match(await page.innerText('table.cshpr tbody'), /ALPHA Test[\s\S]*Uber[\s\S]*300 MAD[\s\S]*260 MAD[\s\S]*40 MAD[\s\S]*compte Uber non relié/);
    await page.selectOption('[data-prst="0"]', 'Payée');
    await page.waitForFunction(() => /40 MAD\s*Payées par la plateforme/.test((document.querySelector('#cshbody .cards') || {}).innerText || ''));
    assert.strictEqual(env.psql('select promo_status from cash_moves'), 'Payée');
    // manques à encaisser : rien
    await page.goto(base() + `#/caisse?t=manques&du=${sel.day}&au=${sel.day}`); await page.waitForSelector('table.cshmq');
    assert.match(await page.innerText('table.cshmq'), /Aucun manque à encaisser/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
