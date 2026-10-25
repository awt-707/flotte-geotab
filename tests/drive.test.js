// Ressources humaines : copie dans Google Drive (contrats, paie, pointage et absences). Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), R = require('../site/rh_calc.js'), { collector } = require('./lib/v6'), { startSite } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', RHU = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const F = { ctr: 'DRIVE_CONTRATS_MARRAKECH_01', pay: 'DRIVE_PAIE_MARRAKECH_000001', clk: 'DRIVE_POINTAGE_MARRAKECH_01', def: 'DRIVE_DOSSIER_PAR_DEFAUT_01' };
const put = (p, txt) => fetch('http://localhost:8080/storage/v1/object/' + p, { method: 'POST', body: '%PDF-1.4 ' + txt + '\n%%EOF' }).then(r => assert.strictEqual(r.status, 200, p));

test('calcul partagé : shift d\'un contrat (avance 2 h, une nuit appartient au jour où elle commence)', () => {
  const off = () => 60, P = {};   // UTC+1
  assert.deepStrictEqual(R.rhShiftOfCtr('2026-10-20T15:30:00Z', P, off), { s: 'Jour', day: '2026-10-20' });   // 16:30
  assert.deepStrictEqual(R.rhShiftOfCtr('2026-10-20T16:30:00Z', P, off), { s: 'Nuit', day: '2026-10-20' });   // 17:30
  assert.deepStrictEqual(R.rhShiftOfCtr('2026-10-21T02:00:00Z', P, off), { s: 'Nuit', day: '2026-10-20' });   // 03:00
  assert.deepStrictEqual(R.rhShiftOfCtr('2026-10-21T04:00:00Z', P, off), { s: 'Jour', day: '2026-10-21' });   // 05:00
  const pres = R.rhPresenceCalc({ emps: [{ id: 1, kind: 'chauffeur', driver_code: 'C1', weekly_hours: 44 }], from: '2026-10-01', to: '2026-10-31', today: '2026-10-25', now: Date.UTC(2026, 9, 25),
    contracts: [{ num: 'K1', client_code: 'C1', vehicle_key: 'V1', start_at: '2026-10-20T06:00:00Z', end_at: '2026-10-20T16:00:00Z' }], plan: [{ day: '2026-10-21', shift: 'Jour', driver_code: 'C1' }],
    shiftOfCtr: st => R.rhShiftOfCtr(st, {}, off), dayOf: t => new Date(t + 3600000).toISOString().slice(0, 10), off });
  assert.deepStrictEqual([pres[0].nDays, pres[0].hours, pres[0].gaps], [1, 10, ['2026-10-21']]);
});

test('collecteur : contrats, copies légalisées et avenants copiés une fois ; paie et pointage du mois dans le Drive', async () => {
  const NOW = Date.UTC(2026, 9, 25, 9, 0);   // 25/10/2026 10:00 au Maroc
  const srv = await startSite(), B = collector(NOW);
  try {
    env.psql(`insert into agencies (id, name) overriding system value values (1, 'Marrakech');
      insert into hr_employees (id, kind, name, agency_id, driver_code, salary, hired_on, cin) overriding system value values (1, 'chauffeur', 'Karim TEST', 1, 'C1', 4000, '2026-01-01', 'X1');
      insert into hr_employees (id, kind, name, agency_id, pointage, salary, hired_on) overriding system value values (2, 'staff', 'Nadia TEST', 1, true, 6000, '2026-01-01'), (3, 'staff', 'Sans agence', null, true, 5000, '2026-01-01');
      insert into work_contracts (id, employee_id, agency_id, name, effective_on, pdf_path) overriding system value values (1, 1, 1, 'Karim TEST', '2026-10-01', '1/a.pdf'),
        (2, 3, null, 'Sans agence', '2026-10-01', '0/b.pdf');
      insert into hr_events (employee_id, kind, day_from, new_salary, label, doc_path) values (1, 'avenant', '2026-10-15', 4500, 'Hausse', '1/avenant.pdf');
      insert into hr_events (employee_id, kind, day_from, day_to, days, status) values (1, 'conge', '2026-10-12', '2026-10-13', 2, 'Validé');
      insert into contracts (num, client_code, vehicle_key, start_at, end_at) values ('K1', 'C1', 'V1', '2026-10-20T06:00:00Z', '2026-10-20T16:00:00Z');
      insert into hr_clock (employee_id, kind, at) values (2, 'in', '2026-10-20T07:30:00Z'), (2, 'out', '2026-10-20T16:30:00Z');`);
    await put('contrats/1/a.pdf', 'contrat'); await put('contrats/0/b.pdf', 'contrat staff'); await put('rh/1/avenant.pdf', 'avenant'); await put('contrats/1/legal.pdf', 'légalisé');
    assert.strictEqual(B.run('rhDriveFilesStep_(Date.now())'), '', 'aucun dossier réglé : rien');
    const fc = B.newFolder('Contrats Marrakech', F.ctr), fp = B.newFolder('Paie Marrakech', F.pay), fk = B.newFolder('Pointage Marrakech', F.clk), fd = B.newFolder('Défaut', F.def);
    env.psql(`update agencies set rh_drive = '{"contracts":"${F.ctr}","payroll":"${F.pay}","clock":"${F.clk}"}' where id = 1;
      insert into params (key, value) values ('rhDriveContracts', 'https://drive.google.com/drive/folders/${F.def}?usp=sharing');`);
    assert.match(B.run('rhDriveFilesStep_(Date.now())'), /^3 documents RH copiés dans le Drive$/);
    const gen = env.psql("select to_char(created_at at time zone 'UTC' + interval '1 hour', 'YYYY-MM-DD') from work_contracts where id = 1");   // date de création posée par la base
    assert.deepStrictEqual(fc.files.map(f => f.name).sort(), ['Karim TEST - Avenant du 2026-10-15 - Hausse.pdf', 'Karim TEST - Contrat de travail généré le ' + gen + ' (effet 2026-10-01).pdf']);
    assert.deepStrictEqual(fd.files.map(f => f.name), ['Sans agence - Contrat de travail généré le ' + gen + ' (effet 2026-10-01).pdf'], 'salarié sans agence : dossier par défaut');
    assert.match(String(fc.files[0].content), /%PDF-1.4/);
    assert.strictEqual(env.psql('select count(*) from work_contracts where drive_pdf_id is not null'), '2');
    assert.strictEqual(B.run('rhDriveFilesStep_(Date.now())'), '', 'jamais copié deux fois');
    // copie signée / légalisée ajoutée : copiée au passage suivant ; remplacée : nouvelle copie
    env.psql("update work_contracts set signed_on = '2026-10-03', legalized_on = '2026-10-05', legal_path = '1/legal.pdf' where id = 1");
    assert.match(B.run('rhDriveFilesStep_(Date.now())'), /^1 document RH copié/);
    assert.ok(fc.files.some(f => f.name === 'Karim TEST - Contrat signé et légalisé le 2026-10-05.pdf'));
    await put('contrats/1/legal2.pdf', 'légalisé v2'); env.psql("update work_contracts set legal_path = '1/legal2.pdf' where id = 1");
    assert.strictEqual(env.psql('select drive_legal_id is null from work_contracts where id = 1'), 't', 'fichier remplacé : copie à refaire');
    assert.match(B.run('rhDriveFilesStep_(Date.now())'), /^1 document RH copié/);
    // fichier absent du stockage : signalé, réessayé ensuite
    env.psql("insert into work_contracts (id, employee_id, agency_id, name, pdf_path) overriding system value values (3, 1, 1, 'Karim TEST', '1/absent.pdf')");
    assert.match(B.run('rhDriveFilesStep_(Date.now())'), /Drive RH : Karim TEST - Contrat de travail .* fichier illisible/);
    assert.strictEqual(env.psql("select count(*) from work_contracts where drive_pdf_id is null"), '1');

    // paie et pointage : un classeur par mois et par agence, réécrit sans en créer un autre
    const r = B.run('rhDriveSheetsStep_()');
    assert.match(r, /paie 2026-10 Marrakech/); assert.match(r, /pointage 2026-10 Marrakech/);
    assert.deepStrictEqual(fp.files.map(f => f.name), ['État RH octobre 2026 - Marrakech']);
    const pay = fp.files[0].book.getSheetByName('État mensuel').data;
    const karim = pay.find(x => x[0] === 'Karim TEST'), nadia = pay.find(x => x[0] === 'Nadia TEST');
    assert.deepStrictEqual([karim[1], karim[4], karim[5], karim[6], karim[10]], ['Chauffeur', 4500, 1, 10, 2], 'salaire de l\'avenant, 1 shift de 10 h, 2 jours de congé');
    assert.deepStrictEqual([nadia[1], nadia[5], nadia[6]], ['Staff', 1, 9]);
    assert.ok(!pay.some(x => x[0] === 'Sans agence'), 'salarié sans agence : pas dans le classeur de l\'agence');
    const bk = fk.files[0].book;
    assert.deepStrictEqual(bk.sheets.map(s => s.name), ['Pointage du staff', 'Absences et congés', 'Présence des chauffeurs']);
    assert.deepStrictEqual(bk.getSheetByName('Pointage du staff').data[1].slice(0, 5), ['Nadia TEST', '2026-10-20', '08:30', '17:30', 'pointé']);
    assert.deepStrictEqual(bk.getSheetByName('Absences et congés').data[1].slice(0, 6), ['Karim TEST', 'Congé', '2026-10-12', '2026-10-13', 2, 'Validé']);
    B.run('rhDriveSheetsStep_()');
    assert.strictEqual(fp.files.length, 1, 'même classeur réécrit');
    assert.strictEqual(fk.files.length, 1);
  } finally { srv.kill(); env.resetDb(); env.psql('truncate hr_employees, work_contracts restart identity cascade'); }
});

test('base : dossiers Drive réglés par l\'administrateur ou les RH de l\'agence, jamais par un gestionnaire', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${RHU}', 'new@x', 'rh') on conflict (user_id) do update set role = 'rh';
    insert into agencies (id, name) overriding system value values (1, 'Marrakech'), (2, 'Casa'); insert into user_agencies (user_id, agency_id) values ('${RHU}', 1);`);
  try {
    as(ADMIN, `select rh_drive_set(null, '{"contracts":"https://drive.google.com/drive/folders/${F.def}","payroll":"bidon"}')`);
    assert.strictEqual(env.psql("select string_agg(key || '=' || value, ',' order by key) from params where key like 'rhDrive%'"), `rhDriveClock=,rhDriveContracts=${F.def},rhDrivePayroll=`, 'identifiant tiré du lien, valeur invalide vidée');
    as(RHU, `select rh_drive_set(1, '{"contracts":"${F.ctr}","autre":"x"}')`);
    assert.strictEqual(env.psql('select rh_drive::text from agencies where id = 1'), `{"contracts": "${F.ctr}"}`);
    assert.throws(() => as(RHU, `select rh_drive_set(2, '{"contracts":"${F.ctr}"}')`), /Réservé/, 'agence d\'un autre RH');
    assert.throws(() => as(RHU, `select rh_drive_set(null, '{}')`), /Réservé/, 'RH limité à ses agences : pas les dossiers par défaut');
    env.psql(`update profiles set role = 'manager' where user_id = '${RHU}'`);
    assert.throws(() => as(RHU, `select rh_drive_set(1, '{}')`), /Réservé/);
    try { as(RHU, "update agencies set rh_drive = '{}' where id = 1"); } catch (e) { assert.match(e.message, /permission|denied/); }
    assert.strictEqual(env.psql('select rh_drive::text from agencies where id = 1'), `{"contracts": "${F.ctr}"}`, 'gestionnaire : écriture directe sans effet');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${RHU}'`); env.resetDb(); }
});
