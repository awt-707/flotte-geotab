// Ressources humaines, suite : rôle « Ressources humaines » (accès séparé), alertes (essai, contrats, légalisation, CDD, CNSS,
// dossiers, maladie, absences, ancienneté), dossiers des salariés, compte rendu semaine / mois. Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), R = require('../site/rh_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);

test('ancienneté (article 350) et majoration des congés tous les 5 ans', () => {
  assert.deepStrictEqual(R.rhSeniority('2020-03-15', '2026-10-24'), { years: 6, pct: 10, next: { pct: 15, on: '2032-03-15' } });
  assert.deepStrictEqual(R.rhSeniority('2025-01-01', '2026-12-30'), { years: 1, pct: 0, next: { pct: 5, on: '2027-01-01' } });
  assert.strictEqual(R.rhSeniority('2026-11-01', '2026-10-24'), null);
  // 11 ans : 5 × 18 j + 5 × 19,5 j + 21 j
  assert.strictEqual(R.rhLeave({ hired_on: '2015-01-01', leave_per_month: 1.5 }, [], '2026-01-01').acquired, 208.5);
  assert.strictEqual(R.rhLeave({ hired_on: '2026-01-10', leave_per_month: 1.5 }, [], '2026-10-24').acquired, 13.5);
});

test('alertes RH : période d\'essai, contrat, légalisation, CDD, CNSS, dossier, maladie, absences, ancienneté', () => {
  const d0 = '2026-10-24', P = { rhAlertDays: 7, rhLegalDays: 7, rhSignDays: 7, rhDocDays: 30, rhContractEndDays: 30, rhDocsChauffeur: 'cin,permis', rhDocsStaff: 'cin' };
  const base = { kind: 'chauffeur', employer_id: 1, salary: 3000, cin: 'X1', cnss_no: '123', contract_type: 'CDI' };
  const emps = [
    Object.assign({ id: 1, name: 'Essai', hired_on: '2026-09-15', trial_months: 1.5 }, base),                                      // fin de la 1re période le 29/10
    Object.assign({}, base, { id: 2, name: 'Sans contrat', hired_on: '2025-01-01', cnss_no: null }),
    Object.assign({ id: 3, name: 'A légaliser', hired_on: '2025-01-01' }, base),
    Object.assign({}, base, { id: 4, name: 'CDD', hired_on: '2025-01-01', contract_type: 'CDD', contract_end: '2026-11-10' }),
    Object.assign({ id: 5, name: 'Dossier', hired_on: '2024-11-10' }, base),                                                        // 2 ans le 10/11 : prime 5 %
    Object.assign({ id: 6, name: 'Sorti', hired_on: '2025-01-01', left_on: '2026-09-01' }, base)];
  const contracts = [{ id: 1, employee_id: 1, created_at: '2026-09-10T10:00:00Z', signed_on: '2026-09-12', legalized_on: '2026-09-14', legal_path: 'x' },
    { id: 2, employee_id: 3, created_at: '2026-10-01T10:00:00Z', signed_on: '2026-10-05' }, { id: 3, employee_id: 4, created_at: '2026-10-20T10:00:00Z' },
    { id: 4, employee_id: 5, created_at: '2025-01-01T10:00:00Z', signed_on: '2025-01-02', legalized_on: '2025-01-03', legal_path: 'y' }, { id: 5, employee_id: 2, created_at: '2025-01-01T10:00:00Z', ended_on: '2025-06-01' }];
  const docs = [1, 2, 3, 4].map(i => ({ employee_id: i, category: 'cin' })).concat([1, 2, 3, 4].map(i => ({ employee_id: i, category: 'permis', expires_on: '2030-01-01' })),
    [{ employee_id: 5, category: 'cin', expires_on: '2026-10-01' }, { employee_id: 5, category: 'permis', expires_on: '2026-11-05' }]);
  const events = [{ employee_id: 5, kind: 'maladie', day_from: '2026-10-20', day_to: '2026-10-22' }, { employee_id: 5, kind: 'absence', justified: false, day_from: '2026-03-02', days: 3 },
    { employee_id: 5, kind: 'absence', justified: false, day_from: '2026-09-07', days: 2 }, { employee_id: 5, kind: 'absence', justified: false, day_from: '2025-09-01', days: 5 },
    { employee_id: 1, kind: 'conge', status: 'Demandé', day_from: '2026-11-02', day_to: '2026-11-04' }];
  const al = R.rhAlerts({ emps, events, contracts, docs, today: d0, P }), of = id => al.filter(a => a.emp.id === id).map(a => a.level + ' · ' + a.type + ' · ' + a.text);
  assert.deepStrictEqual(of(1), ['Haute · Période d\'essai · Fin de la période d\'essai le 29/10/2026 (dans 5 j) : confirmer, renouveler ou rompre', 'Moyenne · Congés · Congé demandé du 02/11/2026 au 04/11/2026 : à valider ou refuser']);
  assert.deepStrictEqual(of(2), ['Haute · Contrat de travail · Aucun contrat de travail enregistré (générer le contrat ou enregistrer le contrat signé)', 'Haute · CNSS · N° CNSS non renseigné : immatriculation du salarié à la CNSS à vérifier'], 'contrat clos : plus suivi');
  assert.deepStrictEqual(of(3), ['Haute · Légalisation · Contrat signé le 05/10/2026, pas encore légalisé (19 j)']);
  assert.deepStrictEqual(of(4), ['Haute · Fin de contrat · CDD se termine le 10/11/2026 (dans 17 j) : renouveler ou préparer la sortie'], 'contrat généré il y a 4 jours : pas encore d\'alerte de signature');
  assert.deepStrictEqual(of(5), ['Critique · Dossier · CIN expiré depuis le 01/10/2026', 'Haute · Arrêt maladie · Arrêt maladie du 20/10/2026 sans certificat médical',
    'Haute · Dossier · Permis de conduire expire le 05/11/2026 (dans 12 j)', 'Haute · Absences · 5 jours d\'absence non justifiée sur 12 mois (plus de 4 jours : faute grave possible, article 39)',
    'Moyenne · Ancienneté · Prime d\'ancienneté de 5 % à partir du 10/11/2026 (article 350)']);
  assert.deepStrictEqual(of(6), [], 'salarié sorti : plus d\'alerte');
  assert.strictEqual(al[0].level, 'Critique', 'alertes triées par gravité');
  // fin de CDD dépassée, pièce manquante, pointage sans date de naissance
  const a2 = R.rhAlerts({ emps: [Object.assign({}, base, { id: 9, name: 'Z', hired_on: '2025-01-01', contract_type: 'CDD', contract_end: '2026-10-01', kind: 'staff', pointage: true })], contracts: [{ employee_id: 9, created_at: '2025-01-01', signed_on: '2025-01-01', legalized_on: '2025-01-02' }], docs: [], events: [], today: d0, P });
  assert.deepStrictEqual(a2.map(a => a.level + ' · ' + a.text), ['Critique · CDD terminé le 01/10/2026 : salarié toujours en poste, à régulariser (renouvellement, nouveau contrat ou sortie)',
    'Haute · Date de naissance absente : pointage impossible', 'Moyenne · Contrat légalisé le 02/01/2025 : copie légalisée à ranger dans le dossier', 'Moyenne · Pièces manquantes : CIN']);
});

test('compte rendu : effectif, entrées / sorties, masse salariale au prorata, absentéisme, comparaison', () => {
  const emps = [{ id: 1, kind: 'chauffeur', name: 'A', hired_on: '2026-01-01', salary: 3000, weekly_hours: 44, driver_code: 'C1' },
    { id: 2, kind: 'staff', name: 'B', hired_on: '2026-10-16', salary: 6200, weekly_hours: 44 },                                 // entré le 16/10 : 16 jours sur 31
    { id: 3, kind: 'chauffeur', name: 'C', hired_on: '2026-01-01', left_on: '2026-10-10', left_reason: 'Démission', salary: 3100, weekly_hours: 44 }];
  const events = [{ employee_id: 1, kind: 'avenant', day_from: '2026-10-01', new_salary: 3100 }, { employee_id: 1, kind: 'maladie', day_from: '2026-10-05', day_to: '2026-10-06' },
    { employee_id: 1, kind: 'prime', day_from: '2026-10-20', amount: 200 }, { employee_id: 1, kind: 'conge', status: 'Validé', day_from: '2026-10-12', day_to: '2026-10-13', days: 2 }];
  const pres = [{ e: emps[0], nDays: 20, hours: 220, overDay: 10, overNight: 0, gaps: ['2026-10-21'] }];
  const r = R.rhReport({ emps, events, contracts: [], today: '2026-10-31', cur: { from: '2026-10-01', to: '2026-10-31', pres, cash: [{ driver_code: 'C1', kind: 'bonus', amount: 100 }, { driver_code: 'C1', kind: 'avance', amount: 500 }] },
    prev: { from: '2026-09-01', to: '2026-09-30', pres: [], cash: [] } });
  const c = r.cur;
  assert.deepStrictEqual([c.start, c.end, c.entries.map(e => e.name), c.exits.map(e => e.name)], [2, 2, ['B'], ['C']]);
  assert.strictEqual(R.rhBasePay(emps[1], [], '2026-10-01', '2026-10-31'), 3200, '6 200 × 16 / 31');
  assert.strictEqual(R.rhBasePay(emps[2], [], '2026-10-01', '2026-10-31'), 1000, '3 100 × 10 / 31');
  const a = c.rows.find(x => x.e.id === 1), hs = Math.round(3100 / (44 * 52 / 12) * 1.25 * 10 * 100) / 100;
  assert.deepStrictEqual([a.base, a.hsAmt, a.prime, a.avance, a.total], [3100, hs, 300, 500, Math.round((3100 + hs + 300) * 100) / 100]);
  assert.deepStrictEqual([c.maladie, c.conge, c.absNJ], [2, 2, 1]);
  assert.strictEqual(c.total, Math.round((3100 + hs + 300 + 3200 + 1000) * 100) / 100);
  assert.strictEqual(r.prev.total, 6100, 'septembre : 3 000 (avenant d\'octobre pas encore en vigueur) + 3 100');
  assert.strictEqual(r.cur.absRate, Math.round((2 + 1) / c.theo * 1000) / 10);
  assert.strictEqual(R.rhBasePay({ hired_on: '2026-01-01', salary: null }, [], '2026-10-01', '2026-10-31'), null, 'salaire non renseigné : non mesuré');
});

test('droits : compte Ressources humaines séparé, périmètre par agence, gestionnaires désactivables', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'rh') on conflict (user_id) do update set role = 'rh';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Casa');
    insert into vehicles (key, plate, agency_id) values ('V1', 'WW1', 1);
    insert into drivers (code, name, agency_id) values ('C1', 'Ali A', 1), ('C2', 'Badr B', 2);
    insert into contracts (num, client_code, name, vehicle_key, start_at) values ('K1', 'C1', 'Ali A', 'V1', now()), ('K2', 'C2', 'Badr B', 'V1', now()), ('K3', null, 'Client', 'V1', now());
    insert into alerts (id, day, time, plate, vehicle_key, type, severity) values ('A1', current_date, '10:00', 'WW1', 'V1', 'Siphonage', 'Critique');
    insert into cash_moves (caisse, kind, flow, amount, day, driver_code, agency_id) values ('rh', 'avance', 'out', 500, current_date, 'C1', 1), ('uber', 'encaissement', 'in', 900, current_date, 'C1', 1);
    insert into hr_employees (kind, name, agency_id, driver_code) values ('chauffeur', 'Ali A', 1, 'C1'), ('chauffeur', 'Badr B', 2, 'C2');
    insert into hr_employees (kind, name, salary) values ('staff', 'Sara S', 6000);`);
  try {
    // RH sans agence : toutes les ressources humaines, rien d'autre de Ludy
    assert.strictEqual(as(MGR, 'select count(*) from hr_employees'), '3');
    assert.strictEqual(as(MGR, "select string_agg(num, ',' order by num) from contracts"), 'K1,K2', 'contrats des chauffeurs suivis seulement');
    assert.strictEqual(as(MGR, 'select count(*) from alerts') + as(MGR, 'select count(*) from live_status'), '00', 'ni alertes ni flotte');
    assert.strictEqual(as(MGR, "select string_agg(kind, ',') from cash_moves"), 'avance', 'caisse : avances / remboursements / bonus seulement');
    // dossier et suivi du contrat
    as(MGR, "insert into hr_documents (employee_id, category, path, expires_on) values (3, 'cin', '3/docs/a.pdf', '2030-01-01')");
    as(MGR, "insert into work_contracts (employee_id, name, external, signed_on, legalized_on, legal_place) values (3, 'Sara S', true, '2026-10-01', '2026-10-03', 'Agdal')");
    assert.strictEqual(env.psql('select created_by from hr_documents'), MGR);
    as(MGR, 'update hr_employees set cnss_no = \'111\', contract_type = \'CDD\', contract_end = \'2027-01-01\' where id = 3');
    assert.throws(() => as(MGR, "update hr_employees set contract_type = 'Intérim' where id = 3"), /check constraint/);
    as(MGR, `insert into hr_clock (employee_id, kind, at, note) values (3, 'in', now(), 'Correction')`);
    // RH rattaché à Rabat : salariés de Rabat et sans agence
    env.psql(`insert into user_agencies (user_id, agency_id) values ('${MGR}', 1)`);
    assert.strictEqual(as(MGR, "select string_agg(name, ',' order by name) from hr_employees"), 'Ali A,Sara S');
    assert.strictEqual(as(MGR, "select string_agg(num, ',' order by num) from contracts"), 'K1');
    assert.throws(() => as(MGR, "insert into hr_documents (employee_id, category, path) values (2, 'cin', '2/docs/b.pdf')"), /row-level security/);
    as(MGR, 'delete from hr_documents'); assert.strictEqual(env.psql('select count(*) from hr_documents'), '0', 'RH : suppression possible');
    // gestionnaire : chauffeurs de ses agences, sauf si les RH lui sont retirées (rhManagers = non)
    env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, "select string_agg(name, ',' order by name) from hr_employees"), 'Ali A');
    as(MGR, "insert into hr_documents (employee_id, category, path) values (1, 'cin', '1/docs/c.pdf')");   // gestionnaire : dossier de ses chauffeurs
    as(MGR, 'delete from hr_documents'); assert.strictEqual(env.psql('select count(*) from hr_documents'), '1', 'gestionnaire : pas de suppression');
    env.psql("insert into params (key, value) values ('rhManagers', 'non') on conflict (key) do update set value = 'non'");
    assert.strictEqual(as(MGR, 'select count(*) from hr_employees') + as(MGR, 'select count(*) from work_contracts'), '00', 'RH retirées aux gestionnaires');
    assert.strictEqual(as(ADMIN, 'select count(*) from hr_employees'), '3');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('site : compte Ressources humaines limité au dossier RH, alertes, dossier, légalisation, compte rendu', async () => {
  env.resetDb();
  const m = new Date().toISOString().slice(0, 7);
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'rh') on conflict (user_id) do update set role = 'rh';
    insert into agencies (id, name) overriding system value values (1, 'Rabat');
    insert into employers (id, name) overriding system value values (1, 'Société Test');
    insert into hr_employees (kind, name, agency_id, employer_id, hired_on, trial_months, salary, cin) values ('staff', 'Nadia TEST', 1, 1, current_date - 40, 1.5, 6000, 'AB1');
    insert into work_contracts (employee_id, agency_id, name, created_at, signed_on) values (1, 1, 'Nadia TEST', now() - interval '20 days', current_date - 15);`);
  const srv = await startSite('pending'), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => /^#\/rh/.test(location.hash) && document.querySelector('#rhbody') && !document.querySelector('#rhbody .loading'));
    const nav = await page.$$eval('.side nav a', a => a.map(x => x.getAttribute('href')));
    assert.ok(nav.every(h => h === '#' || /^#\/(rh|travail)/.test(h)), 'menu : dossier Ressources humaines seulement (' + nav.join(', ') + ')');
    assert.strictEqual(await page.$('#health'), null, 'pas d\'état de la collecte pour les RH');
    assert.match(await page.innerText('#rhbody'), /À traiter pour rester en règle/);
    await page.waitForFunction(() => { const n = document.querySelector('#nbrh'); return n && !n.hidden && +n.textContent >= 2; });
    // volet hors RH : renvoyé vers les RH
    await page.goto('http://localhost:8080/#/caisse');
    await page.waitForFunction(() => /^#\/rh/.test(location.hash));
    // alertes : légalisation en retard, CNSS, période d'essai
    await page.goto('http://localhost:8080/#/rh?t=alertes'); await page.waitForSelector('#rhal');
    const at = await page.innerText('#rhal');
    assert.match(at, /pas encore légalisé/); assert.match(at, /N° CNSS non renseigné/); assert.match(at, /Pièces manquantes : CIN, RIB/);
    // fiche : légalisation enregistrée avec la copie, pièce ajoutée au dossier
    await page.goto('http://localhost:8080/#/rh?t=fiche&id=1'); await page.waitForSelector('[data-rhwcup]');
    await page.click('[data-rhwcup]');
    await page.fill('#rhw_leg', new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10).split('-').reverse().join('/')); await page.fill('#rhw_place', 'Agdal');
    await page.setInputFiles('#rhw_file', { name: 'contrat.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test\n%%EOF') });
    await page.click('#rhwsave');
    await page.waitForFunction(() => /Légalisé/.test((document.querySelector('#rhwc') || {}).innerText || '') && !document.querySelector('#rhwcform input'));
    assert.strictEqual(env.psql("select legal_place || '|' || (legal_path like '1/%')::text from work_contracts"), 'Agdal|true');
    await page.click('#rhdoc summary'); await page.selectOption('#rhd_cat', 'cin'); await page.fill('#rhd_exp', '01/01/2031');
    await page.setInputFiles('#rhd_file', { name: 'cin.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 cin\n%%EOF') });
    await page.click('#rhdsave');
    await page.waitForFunction(() => /CIN/.test((document.querySelector('#rhdocs') || {}).innerText || ''));
    assert.strictEqual(env.psql("select category || '|' || expires_on || '|' || (path like '1/docs/%')::text from hr_documents"), 'cin|2031-01-01|true');
    // compte rendu du mois : masse salariale, PDF
    await page.goto(`http://localhost:8080/#/rh?t=rapport&p=mois&d=${m}-01`); await page.waitForSelector('#rhrpdf');
    assert.match(await page.innerText('#rhbody'), /Masse salariale/);
    assert.match(await page.innerText('#rhrdet'), /Nadia TEST/);
    const dl = page.waitForEvent('download'); await page.click('#rhrpdf'); assert.match((await dl).suggestedFilename(), /^Compte-rendu-RH-\d{4}-\d{2}\.pdf$/);
    await page.selectOption('#rhrp', 'semaine'); await page.waitForFunction(() => /semaine du/.test((document.querySelector('#rhbody') || {}).innerText || '') && document.querySelector('#rhrpdf'));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});
