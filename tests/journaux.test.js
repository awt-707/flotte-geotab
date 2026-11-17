// Journaux à présenter (17/11/2026, demandes d'Ahmed) : journal des encaissements des courses privées (Courses privées > Journal des
// encaissements) et journal de la caisse Dépenses (toutes les opérations, solde après chaque opération). Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), C = require('../site/caisse_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const J = x => JSON.parse(JSON.stringify(x));

test('journal des courses privées : prix, encaissé, part gardée dans la limite de la prime, reste, dépôt', () => {
  const mis = [
    { id: 1, number: 'DEV-2026-0001', status: 'Terminée', client_name: 'Client A', driver_name: 'ALPHA', vehicle_key: 'V1', start_at: '2026-11-10T08:00:00Z', total_ttc: 500, data: { f: { startCity: 'Marrakech', endAddr: 'Aéroport' } } },
    { id: 2, number: 'DEV-2026-0002', status: 'Confirmée', client_name: 'Client B', driver_name: 'BETA', vehicle_key: 'V2', start_at: '2026-11-11T08:00:00Z', total_ttc: 300, data: {} },
    { id: 3, number: 'DEV-2026-0003', status: 'Annulée', client_name: 'Client C', start_at: '2026-11-11T09:00:00Z', total_ttc: 900, data: {} },
    { id: 4, number: 'DEV-2026-0004', status: 'Demande', client_name: 'Client D', start_at: '2026-11-11T09:00:00Z', total_ttc: 900, data: {} },
    { id: 5, number: 'DEV-2026-0005', status: 'Terminée', client_name: 'Client E', driver_name: 'GAMMA', start_at: '2026-11-12T08:00:00Z', total_ttc: 400, data: {} }];
  const mv = [
    // course 1 : prix convenu 450 (≠ devis 500), prime 10 % = 45, remis 405 → part gardée 45, rien à encaisser ; déposée le 13/11
    { id: 10, caisse: 'courses', kind: 'course', flow: 'in', amount: 405, course_amount: 450, prime: 45, prime_paid: 45, day: '2026-11-10', mission_id: 1, driver_name: 'ALPHA' },
    // course 5 : sans prime, remis 300 sur 400, puis 60 rapportés le lendemain → reste 40 (le chauffeur n'a pas de prime à garder)
    { id: 11, caisse: 'courses', kind: 'course', flow: 'in', amount: 300, course_amount: 400, prime: 0, prime_paid: 100, day: '2026-11-12', mission_id: 5, driver_name: 'GAMMA' },
    { id: 12, caisse: 'courses', kind: 'course', flow: 'in', amount: 60, course_amount: 400, prime: 0, prime_paid: 40, day: '2026-11-13', mission_id: 5, driver_name: 'GAMMA' },
    // encaissement sans course Ludy, et un annulé (ignoré)
    { id: 13, caisse: 'courses', kind: 'course', flow: 'in', amount: 200, course_amount: 200, prime: 20, prime_paid: 0, day: '2026-11-11', driver_name: 'DELTA', label: 'Gueliz → Palmeraie', comment: 'Course DEV-2026-0099' },
    { id: 14, caisse: 'courses', kind: 'course', flow: 'in', amount: 999, course_amount: 999, day: '2026-11-11', driver_name: 'X', cancelled_at: '2026-11-11T12:00:00Z' },
    { id: 20, caisse: 'courses', kind: 'depot', flow: 'out', amount: 405, day: '2026-11-13', comment: 'Bordereau DEP-2-20261113-1 · jours 2026-11-10,2026-11-11' }];
  const j = C.cshCourseJournal(mis, mv, '2026-11-10', '2026-11-12', { plateOf: k => k ? 'P-' + k : '' });
  assert.deepStrictEqual(j.rows.map(r => [r.number, r.state, r.price, r.amount, r.prime, r.kept, r.reste, r.primeDue, r.dep]), [
    ['DEV-2026-0001', 'Encaissée', 450, 405, 45, 45, 0, 0, 'DEP-2-20261113-1'],
    ['DEV-2026-0002', 'À encaisser', 300, 0, 0, 0, 300, 0, ''],
    ['DEV-2026-0099', 'Encaissée', 200, 200, 20, 0, 0, 20, 'DEP-2-20261113-1'],
    ['DEV-2026-0005', 'Partielle', 400, 360, 0, 0, 40, 0, '']], 'annulée et simple demande exclues ; reste rapporté compté, prix jamais doublé');
  const r1 = j.rows[0];
  assert.deepStrictEqual([r1.quoted, r1.route, r1.plate, r1.day], [500, 'Marrakech → Aéroport', 'P-V1', '2026-11-10']);
  assert.deepStrictEqual(J(j.rows[3].encDays), ['2026-11-12', '2026-11-13']);
  assert.deepStrictEqual([j.n, j.nTodo, j.nPart, j.price, j.amount, j.prime, j.kept, j.primeDue, j.reste, j.deposited, j.inCash],
    [4, 1, 1, 1350, 965, 65, 45, 20, 340, 605, 360]);
  assert.deepStrictEqual(j.drivers.map(d => [d.name, d.n, d.amount]), [['ALPHA', 1, 405], ['GAMMA', 1, 360], ['DELTA', 1, 200]]);
  // chauffeur qui garde plus que sa prime : la différence reste à encaisser
  const k = C.cshCourseJournal([{ id: 9, status: 'Terminée', start_at: '2026-11-10T08:00:00Z', total_ttc: 500 }],
    [{ id: 30, caisse: 'courses', kind: 'course', flow: 'in', amount: 400, course_amount: 500, prime: 50, day: '2026-11-10', mission_id: 9 }], '2026-11-10', '2026-11-10');
  assert.deepStrictEqual([k.rows[0].kept, k.rows[0].reste, k.rows[0].state], [50, 50, 'Partielle']);
});

test('journal d\'une caisse : solde de début, solde après chaque opération, hors caisse sans effet, annulées à part', () => {
  const mv = [
    { id: 1, caisse: 'depenses', kind: 'recharge', flow: 'in', amount: 1000, day: '2026-11-01' },
    { id: 2, caisse: 'depenses', kind: 'depense', flow: 'out', amount: 150, day: '2026-11-02', label: 'Carburant', justif: 'OK' },
    { id: 3, caisse: 'depenses', kind: 'depense', flow: 'out', amount: 80, day: '2026-11-05', label: 'Péage', justif: 'En attente' },
    { id: 4, caisse: 'depenses', kind: 'depense', flow: 'virement', amount: 300, day: '2026-11-05', label: 'Amende', justif: 'N.A' },
    { id: 5, caisse: 'depenses', kind: 'recharge', flow: 'in', amount: 500, day: '2026-11-06' },
    { id: 6, caisse: 'depenses', kind: 'depense', flow: 'out', amount: 40, day: '2026-11-06', label: 'Carburant', justif: 'KO' },
    { id: 7, caisse: 'depenses', kind: 'depense', flow: 'out', amount: 999, day: '2026-11-06', label: 'Péage', cancelled_at: '2026-11-06T10:00:00Z' },
    { id: 8, caisse: 'uber', kind: 'encaissement', flow: 'in', amount: 777, day: '2026-11-05' },
    { id: 9, caisse: 'depenses', kind: 'depense', flow: 'out', amount: 10, day: '2026-11-08', label: 'Péage' }];
  const b = C.cshCashBook(mv, 'depenses', '2026-11-05', '2026-11-07');
  assert.strictEqual(b.open, 850, 'recharge 1000 − carburant 150 avant la période');
  assert.deepStrictEqual(b.rows.map(r => [r.m.id, r.inn, r.out, r.hors, r.bal]), [[3, 0, 80, 0, 770], [4, 0, 0, 300, 770], [5, 500, 0, 0, 1270], [6, 0, 40, 0, 1230]]);
  assert.deepStrictEqual([b.totalIn, b.totalOut, b.totalHors, b.close, b.n, b.cancelled.map(m => m.id)], [500, 120, 300, 1230, 4, [7]]);
  assert.strictEqual(b.close, C.cshBalances(mv.filter(m => m.day <= '2026-11-07')).depenses, 'solde de fin = solde de la caisse au dernier jour');
  assert.deepStrictEqual(b.cats.map(c => [c.label, c.n, c.out, c.hors]), [['Amende', 1, 0, 300], ['Péage', 1, 80, 0], ['Carburant', 1, 40, 0]]);
  assert.deepStrictEqual(b.justifs.map(x => [x.label, x.n, x.amount]), [['N.A', 1, 300], ['En attente', 1, 80], ['KO', 1, 40]]);
});

test('pages : journal des courses privées et journal de la caisse Dépenses (PDF, tableur)', async () => {
  env.resetDb();
  const d1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  env.psql(`insert into drivers (code, name) values ('C1', 'ALPHA Test');
    insert into missions (id, client_name, kind, total_ttc, needs_validation, level, status, vehicle_key, start_at, number, driver_name, data)
      overriding system value values (7, 'Client Test', 'Transfert aéroport', 450, false, 'Standard', 'Terminée', '968199WW', '${d1}T09:00:00Z', 'DEV-2026-0007', 'ALPHA Test', '{"f": {"startCity": "Casablanca", "endAddr": "Aéroport"}}'),
        (8, 'Client Deux', 'Transfert', 300, false, 'Standard', 'Confirmée', '968199WW', '${d1}T15:00:00Z', 'DEV-2026-0008', 'ALPHA Test', '{}');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, course_amount, commission_pct, prime, prime_paid, mission_id, label) values
      ('courses', 'course', 'in', 405, '${d1}', 'C1', 450, 10, 45, 45, 7, 'Casablanca → Aéroport');
    insert into cash_moves (caisse, kind, flow, amount, day, label, justif, driver_name) values
      ('depenses', 'recharge', 'in', 1000, '${d1}', null, null, null), ('depenses', 'depense', 'out', 120, '${d1}', 'Péage', 'En attente', 'ALPHA Test');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    const base = () => page.url().replace(/#.*/, '');
    await page.addInitScript(([a]) => { try { localStorage.setItem('periode', JSON.stringify({ sel: 'Personnalisé', from: a, to: a })); } catch (e) { } }, [d1]);
    await login(page, '#/courses?t=journal');
    await page.waitForSelector('#crjpdf');
    const t = await page.innerText('#tcrj');
    assert.match(t, /DEV-2026-0007[\s\S]*Client Test[\s\S]*Casablanca → Aéroport[\s\S]*450 MAD[\s\S]*405 MAD[\s\S]*Encaissée/);
    assert.match(t, /DEV-2026-0008[\s\S]*300 MAD[\s\S]*À encaisser/);
    assert.match(await page.innerText('#page'), /300 MAD\s*1 à encaisser\s*Reste à encaisser/);
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('#crjpdf')]);
    assert.match(pdf.suggestedFilename(), /^journal_courses_privees_.*\.pdf$/);
    const [xls] = await Promise.all([page.waitForEvent('download'), page.click('#crjxls')]);
    assert.match(xls.suggestedFilename(), /^journal_courses_privees_.*\.xlsx$/);
    await page.selectOption('#crjf', 'todo');
    await page.waitForFunction(() => !/DEV-2026-0007/.test((document.querySelector('#tcrj') || {}).innerText || 'DEV-2026-0007'));
    assert.match(await page.innerText('#tcrj'), /DEV-2026-0008/);

    // caisse Dépenses : journal de toutes les opérations de la période
    await page.goto(base() + `#/caisse?t=depenses&du=${d1}&au=${d1}`);
    await page.waitForSelector('[data-cshbook="depenses"]');
    const rep = await page.evaluate(([a]) => { const r = cshRepBook('depenses', { from: a, to: a }); return { title: r.title, rows: r.tables[0].rows.map(x => x.join('|')), sum: r.summary.map(s => s.join('=')) }; }, [d1]);
    assert.strictEqual(rep.title, 'Journal de la caisse Dépenses chauffeurs');
    assert.match(rep.rows[0], /^Solde au .*\|0 MAD\|/);
    assert.match(rep.rows[1], /Recharge.*\|1 000 MAD\|\|\|1 000 MAD\|/);
    assert.match(rep.rows[2], /Péage\|ALPHA Test\|.*\|En attente\|\|120 MAD\|\|880 MAD\|/);
    assert.match(rep.rows[3], /^Total\|\|2 opérations\|.*\|1 000 MAD\|120 MAD\|0 MAD\|880 MAD\|/);
    assert.ok(rep.sum.some(s => /Dépenses sans justificatif OK=1 · 120 MAD/.test(s)));
    const [pdf2] = await Promise.all([page.waitForEvent('download'), page.click('[data-cshbook="depenses"]')]);
    assert.match(pdf2.suggestedFilename(), new RegExp('^journal_caisse_depenses_.*_' + d1 + '_' + d1 + '\\.pdf$'));
    const [xls2] = await Promise.all([page.waitForEvent('download'), page.click('[data-cshbookx="depenses"]')]);
    assert.match(xls2.suggestedFilename(), /^journal_caisse_depenses_.*\.xlsx$/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
