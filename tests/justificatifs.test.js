// Caisse : justificatifs des dépenses et reçus de dépôt (Ludy + Google Drive de l'agence), historique des dépôts groupé (04/11/2026).
// Données synthétiques.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), C = require('../site/caisse_calc.js'), { collector } = require('./lib/v6'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const put = (p, txt) => fetch('http://localhost:8080/storage/v1/object/' + p, { method: 'POST', body: '%PDF-1.4 ' + txt + '\n%%EOF' }).then(r => assert.strictEqual(r.status, 200, p));

test('historique des dépôts : un bordereau = une ligne (Uber + Bolt + courses en un montant), banque, déposant, jours', () => {
  const c = 'Bordereau DEP-2-20261103-1 · BMCE · déposé par Gest Un · jours 2026-10-27,2026-10-28';
  const g = C.cshDepGroups([{ id: 1, kind: 'depot', caisse: 'uber', amount: 300, day: '2026-11-03', comment: c }, { id: 2, kind: 'depot', caisse: 'bolt', amount: 50, day: '2026-11-03', comment: c },
    { id: 3, kind: 'depot', caisse: 'courses', amount: 200, day: '2026-11-03', comment: c }, { id: 4, kind: 'depot', caisse: 'depenses', amount: 100, day: '2026-10-20', comment: 'versement' },
    { id: 5, kind: 'depot', caisse: 'uber', amount: 999, day: '2026-11-03', comment: c, cancelled_at: '2026-11-03T12:00:00Z' }, { id: 6, kind: 'depense', caisse: 'depenses', amount: 10, day: '2026-11-03' }]);
  assert.deepStrictEqual(g.map(r => [r.key, r.day, r.uber, r.bolt, r.courses, r.other, r.total, r.bank, r.who, r.days.join(',')]), [
    ['DEP-2-20261103-1', '2026-11-03', 300, 50, 200, 0, 550, 'BMCE', 'Gest Un', '2026-10-27,2026-10-28'], ['M4', '2026-10-20', 0, 0, 0, 100, 100, '', '', '']]);
});

test('collecteur : mêmes catégories de dépense que la Caisse', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'collector', 'src', '58_cashdrive.gs'), 'utf8');
  assert.deepStrictEqual(JSON.parse(src.match(/const CSH_DRIVE_CATS_ = (\[[^\]]+\])/)[1].replace(/'/g, '"')), C.CASH_DEP_CATS);
});

test('droits : justificatif d\'une dépense de son agence seulement, retiré par l\'administrateur seul', () => {
  env.resetDb();
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'; insert into agencies (id, name) overriding system value values (1, 'Marrakech'), (2, 'Casablanca');
    insert into user_agencies values ('${MGR}', 1);
    insert into cash_moves (id, caisse, kind, flow, amount, day, agency_id, label) overriding system value values (10, 'depenses', 'depense', 'out', 50, '2026-11-03', 1, 'Péage'), (11, 'depenses', 'depense', 'out', 70, '2026-11-03', 2, 'Péage')`);
  try {
    as(MGR, `insert into cash_files (agency_id, kind, move_id, path) values (1, 'justif', 10, '1/justificatifs/m10_1.pdf')`);
    assert.throws(() => as(MGR, `insert into cash_files (agency_id, kind, move_id, path) values (1, 'justif', 11, '1/justificatifs/m11_1.pdf')`), /row-level security/, 'dépense d\'une autre agence');
    assert.throws(() => as(MGR, `insert into cash_files (agency_id, kind, move_id, path) values (2, 'justif', 11, '2/justificatifs/m11_1.pdf')`), /row-level security/);
    assert.throws(() => as(MGR, `insert into cash_files (agency_id, kind, path) values (1, 'depot', '1/depots/x.pdf')`), /check constraint/, 'reçu sans bordereau');
    assert.throws(() => as(MGR, `update cash_files set drive_id = 'x'`), /permission denied/, 'copie Drive : collecteur seul');
    as(MGR, 'delete from cash_files'); assert.strictEqual(env.psql('select count(*) from cash_files'), '1', 'gestionnaire : pas de retrait');
    as(ADMIN, 'delete from cash_files'); assert.strictEqual(env.psql('select count(*) from cash_files'), '0');
  } finally { env.resetDb(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); }
});

test('collecteur : dossiers « Justificatifs agence … » (un sous-dossier par catégorie) et « Dépôts banque agence … », fichiers copiés une fois', async () => {
  const srv = await startSite(), B = collector(Date.UTC(2026, 10, 4, 9, 0));
  try {
    env.psql(`insert into agencies (id, name) overriding system value values (1, 'Marrakech');
      insert into cash_moves (id, caisse, kind, flow, amount, day, agency_id, label) overriding system value values (10, 'depenses', 'depense', 'out', 50, '2026-11-03', 1, 'Péage');
      insert into cash_files (agency_id, kind, move_id, dep_ref, day, category, title, path, file_name) values (1, 'justif', 10, null, '2026-11-03', 'Péage', '2026-11-03 - Karim - 50 MAD - Péage - n°10', '1/justificatifs/m10_1.pdf', 'ticket.pdf'),
        (1, 'depot', null, 'DEP-1-20261103-1', '2026-11-03', null, '2026-11-03 - DEP-1-20261103-1 - 550 MAD - BMCE', '1/depots/DEP-1-20261103-1_1.pdf', 'recu.pdf');
      insert into cash_files (agency_id, kind, move_id, day, category, path, file_name) values (1, 'justif', 10, '2026-11-03', 'Péage', '1/justificatifs/absent.pdf', 'absent.pdf');`);
    await put('caisse/1/justificatifs/m10_1.pdf', 'ticket'); await put('caisse/1/depots/DEP-1-20261103-1_1.pdf', 'reçu');
    const m = B.run('cashDriveStep_(Date.now())');
    assert.match(m, /dossiers Drive de la caisse créés \(Marrakech\)/); assert.match(m, /2 justificatifs \/ reçus copiés dans le Drive/); assert.match(m, /absent\.pdf/);
    const F = B.run('JSON.stringify(DriveApp.getRootFolder().getFoldersByName("Justificatifs agence Marrakech").hasNext())');
    assert.strictEqual(F, 'true');
    const kids = JSON.parse(B.run(`(function () { const f = DriveApp.getRootFolder().getFoldersByName('Justificatifs agence Marrakech').next(); return JSON.stringify(${JSON.stringify(C.CASH_DEP_CATS)}.map(c => f.getFoldersByName(c).hasNext())); })()`));
    assert.ok(kids.every(Boolean), 'un sous-dossier par catégorie');
    const inPeage = B.run(`(function () { const f = DriveApp.getRootFolder().getFoldersByName('Justificatifs agence Marrakech').next().getFoldersByName('Péage').next(); const l = []; const it = f.getFiles(); while (it.hasNext()) l.push(it.next().getName()); return l.join('|'); })()`);
    assert.strictEqual(inPeage, '2026-11-03 - Karim - 50 MAD - Péage - n°10.pdf');
    const inDep = B.run(`(function () { const f = DriveApp.getRootFolder().getFoldersByName('Dépôts banque agence Marrakech').next(); const l = []; const it = f.getFiles(); while (it.hasNext()) l.push(it.next().getName()); return l.join('|'); })()`);
    assert.strictEqual(inDep, '2026-11-03 - DEP-1-20261103-1 - 550 MAD - BMCE.pdf');
    assert.strictEqual(env.psql("select count(*) from cash_files where drive_id is not null"), '2');
    const pub = JSON.parse(env.psql("select value from params where key = 'cashDrive'"));
    assert.ok(pub['1'].justif && pub['1'].depot);
    // passage suivant : rien recopié ; fichier illisible signalé après 3 essais, plus réessayé
    B.run('cashDriveStep_(Date.now())'); B.run('cashDriveStep_(Date.now())');
    assert.match(env.psql("select drive_error from cash_files where file_name = 'absent.pdf'"), /illisible/);
    assert.strictEqual(B.run('cashDriveStep_(Date.now())'), '');
    assert.strictEqual(B.run(`(function () { const f = DriveApp.getRootFolder().getFoldersByName('Justificatifs agence Marrakech').next().getFoldersByName('Péage').next(); let n = 0; const it = f.getFiles(); while (it.hasNext()) { it.next(); n++; } return n; })()`), 1);
  } finally { srv.kill(); env.resetDb(); }
});

test('page Caisse : justificatif déposé avec la dépense ou depuis la liste, reçu de la banque sur l\'historique groupé', async () => {
  env.resetDb();
  const d1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  env.psql(`insert into drivers (code, name) values ('C1', 'ALPHA Test');
    insert into cash_moves (caisse, kind, flow, amount, day, shift, driver_code, uber_cash, given, change) values ('uber', 'encaissement', 'in', 300, '${d1}', 'Jour', 'C1', 300, 300, 0);
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, course_amount, label) values ('courses', 'course', 'in', 200, '${d1}', 'C1', 200, 'Course');
    insert into cash_moves (caisse, kind, flow, amount, day, label, comment) values ('uber', 'depot', 'out', 300, '${d1}', 'Dépôt en banque', 'Bordereau DEP-0-20261103-1 · BMCE · déposé par Gest Un · jours ${d1}'),
      ('courses', 'depot', 'out', 200, '${d1}', 'Dépôt en banque', 'Bordereau DEP-0-20261103-1 · BMCE · déposé par Gest Un · jours ${d1}');`);
  const pdf = path.join(env.OUT, 'justif.pdf'); fs.writeFileSync(pdf, '%PDF-1.4 justificatif\n%%EOF');
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    const base = () => page.url().replace(/#.*/, '');
    await login(page, `#/caisse?t=depenses&du=${d1}&au=${d1}`);
    await page.waitForSelector('#cdsave');
    await page.fill('#cdd', d1); await page.selectOption('#cdc', 'Péage'); await page.fill('#cda', '45'); await page.setInputFiles('#cdf', pdf);
    await page.click('#cdsave');
    await page.waitForFunction(() => /justif\.pdf/.test((document.querySelector('#tcshdep') || {}).innerText || ''), null, { timeout: 15000 });
    assert.strictEqual(env.psql("select justif || '|' || label from cash_moves where kind = 'depense'"), 'OK|Péage', 'justificatif fourni = OK');
    assert.match(env.psql("select kind || '|' || category || '|' || path || '|' || title from cash_files"), new RegExp(`^justif\\|Péage\\|0/justificatifs/m\\d+_\\d+\\.pdf\\|${d1} - sans chauffeur - 45 MAD - Péage - n°\\d+$`));
    // dépense sans justificatif : déposé ensuite depuis la liste
    env.psql(`insert into cash_moves (caisse, kind, flow, amount, day, label, justif) values ('depenses', 'depense', 'out', 20, '${d1}', 'Parking', 'En attente')`);
    await page.reload(); await page.waitForSelector('#tcshdep');
    const id = env.psql("select id from cash_moves where label = 'Parking'");
    await page.setInputFiles(`[data-cshup="justif|${id}"]`, pdf);
    await page.waitForFunction(i => document.querySelectorAll(`[data-cshup="justif|${i}"]`).length && /\+ fichier/.test(document.querySelector(`[data-cshup="justif|${i}"]`).parentElement.innerText), id, { timeout: 15000 });
    assert.strictEqual(env.psql(`select justif from cash_moves where id = ${id}`), 'OK');
    // dépôt en banque : historique groupé (Uber + courses = un montant), reçu de la banque déposé
    await page.goto(base() + '#/caisse?t=depot'); await page.waitForSelector('#tcshdph');
    const h = await page.innerText('#tcshdph tbody');
    assert.match(h, /DEP-0-20261103-1[\s\S]*300 MAD[\s\S]*200 MAD[\s\S]*500 MAD[\s\S]*BMCE[\s\S]*Gest Un[\s\S]*à déposer/);
    assert.strictEqual(await page.locator('#tcshdph tbody tr').count(), 1, 'un seul dépôt groupé');
    await page.setInputFiles('[data-cshup="depot|DEP-0-20261103-1"]', pdf);
    await page.waitForFunction(() => /justif\.pdf/.test((document.querySelector('#tcshdph tbody') || {}).innerText || ''), null, { timeout: 15000 });
    assert.match(env.psql("select kind || '|' || dep_ref || '|' || title from cash_files where kind = 'depot'"), new RegExp(`^depot\\|DEP-0-20261103-1\\|${d1} - DEP-0-20261103-1 - 500 MAD - BMCE$`));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
