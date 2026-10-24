// Ressources humaines : calculs (période d'essai, congés, présence par contrats, heures sup., pointage), droits, pointage du staff, pages
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), R = require('../site/rh_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const T = s => Date.parse(s), off = () => 60;   // heure du Maroc des tests : UTC+1

test('dates : mois ajoutés (1,5 mois = 1 mois et 15 jours), mois de service, jours ouvrables', () => {
  assert.deepStrictEqual([R.rhAddMonths('2026-08-31', 1), R.rhAddMonths('2026-08-31', 1.5), R.rhAddMonths('2026-01-31', 1), R.rhAddMonths('2026-11-15', 2)], ['2026-09-30', '2026-10-15', '2026-02-28', '2027-01-15']);
  assert.deepStrictEqual([R.rhMonths('2026-08-31', '2026-09-28'), R.rhMonths('2026-08-31', '2026-09-29'), R.rhMonths('2026-01-10', '2026-07-09'), R.rhMonths('2026-05-01', '2026-04-01')], [0, 1, 6, 0]);
  assert.strictEqual(R.rhWorkingDays('2026-10-19', '2026-10-25'), 6, 'dimanche exclu');
  assert.deepStrictEqual(R.rhMonthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
});

test('période d\'essai : 1re période, renouvellement tacite, confirmation tacite, décisions', () => {
  const e = { hired_on: '2026-08-31', trial_months: 1.5 };
  const s = d => { const t = R.rhTrial(e, d, 7); return [t.state, t.end, t.daysLeft, t.alert]; };
  assert.deepStrictEqual(s('2026-09-01'), ['en cours', '2026-10-14', 43, false]);
  assert.deepStrictEqual(s('2026-10-10'), ['en cours', '2026-10-14', 4, true]);
  assert.deepStrictEqual(s('2026-10-15'), ['renouvelée (tacite)', '2026-11-29', 45, false]);
  assert.deepStrictEqual(s('2026-11-30'), ['confirmée (tacite)', '2026-11-29', -1, false]);
  assert.strictEqual(R.rhTrial(Object.assign({}, e, { trial_renewable: false }), '2026-10-15').state, 'confirmée (tacite)');
  assert.strictEqual(R.rhTrial(Object.assign({}, e, { trial_decision: 'renouvelée' }), '2026-09-20').state, 'renouvelée');
  assert.strictEqual(R.rhTrial(Object.assign({}, e, { trial_decision: 'renouvelée' }), '2026-09-20').end, '2026-11-29');
  assert.deepStrictEqual([R.rhTrial(Object.assign({}, e, { trial_decision: 'confirmée', trial_decided_on: '2026-09-15' }), '2026-09-20')].map(t => [t.state, t.open]), [['confirmée', false]]);
  assert.strictEqual(R.rhTrial({ hired_on: null, trial_months: 1.5 }, '2026-09-20').state, '—');
});

test('congés (1,5 j par mois de service, droit ouvert après 6 mois), salaire à une date (avenants)', () => {
  const e = { hired_on: '2026-01-10', leave_per_month: 1.5, salary: 3200 };
  const ev = [{ kind: 'conge', status: 'Validé', days: 4 }, { kind: 'conge', status: 'Demandé', days: 3 }, { kind: 'conge', status: 'Validé', days: 2, cancelled_at: 'x' },
    { kind: 'avenant', day_from: '2026-06-01', new_salary: 3500 }, { kind: 'avenant', day_from: '2026-09-01', new_salary: 3800 }, { kind: 'avenant', day_from: '2026-10-01', label: 'changement de poste' }];
  assert.deepStrictEqual(R.rhLeave(e, ev, '2026-07-09'), { months: 6, acquired: 9, taken: 4, balance: 5, open: true });
  assert.deepStrictEqual(R.rhLeave(e, ev, '2026-03-15').open, false);
  assert.strictEqual(R.rhLeave(Object.assign({}, e, { left_on: '2026-03-09' }), ev, '2026-10-01').months, 2, 'arrêté à la sortie (10/01 -> 09/03 inclus = 2 mois)');
  assert.deepStrictEqual(['2026-05-31', '2026-06-01', '2026-10-15'].map(d => R.rhSalaryAt(e, ev, d)), [3200, 3500, 3800]);
});

test('chauffeurs : présence par contrats, heures de nuit, heures supplémentaires par semaine (jour / nuit), contrats à vérifier', () => {
  assert.strictEqual(R.rhNight(T('2026-10-05T18:00:00Z'), T('2026-10-06T06:00:00Z'), off), 9, '19:00 -> 07:00 : 9 h de nuit (21 h -> 6 h)');
  assert.strictEqual(R.rhNight(T('2026-10-05T06:00:00Z'), T('2026-10-05T18:00:00Z'), off), 0);
  // 6 shifts de nuit de 12 h (19:00 -> 07:00) du lundi 05/10 au samedi 10/10, puis lundi 12/10 ; contrat de 10 jours ; contrat sans fin
  const items = [];
  for (let d = 5; d <= 10; d++) { const day = '2026-10-' + String(d).padStart(2, '0'), s = T(day + 'T18:00:00Z'); items.push({ code: 'C1', num: 'N' + d, start: s, end: s + 12 * 3600e3, day, shift: 'Nuit' }); }
  items.push({ code: 'C1', num: 'L', start: T('2026-10-12T06:00:00Z'), end: T('2026-10-22T06:00:00Z'), day: '2026-10-12', shift: 'Jour' });
  items.push({ code: 'C1', num: 'O', start: T('2026-10-13T06:00:00Z'), end: null, day: '2026-10-13', shift: 'Jour' });
  items.push({ code: 'C2', num: 'J', start: T('2026-10-05T06:00:00Z'), end: T('2026-10-05T18:00:00Z'), day: '2026-10-05', shift: 'Jour' });
  const w = R.rhDriverWork(items, { off, maxH: 16, weekH: { C1: 44 } }), s = R.rhDriverSum(w.C1, '2026-10-01', '2026-10-31');
  assert.deepStrictEqual([s.nDays, s.hours, s.night, s.over, s.overNight, s.overDay], [8, 72, 54, 28, 21, 7]);
  assert.deepStrictEqual(s.flagged.map(f => f.num + ' ' + f.flag), ['L durée de 240 h (au-delà de 16 h)', 'O fin du contrat inconnue']);
  // heures sup. : 44 h atteintes au milieu du 4e shift (36 h + 8 h) : les 4 dernières heures de ce shift (03:00 -> 07:00 : 3 h de nuit, 1 h de jour)
  const n8 = w.C1.items.find(r => r.num === 'N8');
  assert.deepStrictEqual([n8.over, n8.overNight], [4, 3]);
  assert.deepStrictEqual(R.rhDriverSum(w.C1, '2026-10-06', '2026-10-06').over, 0, 'semaine entière comptée, heures sup. rattachées à leur shift');
  assert.deepStrictEqual(R.rhOvertimePay(3200, 44, 6, 22), { rate: 16.78, amount: 679.72 });
  assert.strictEqual(R.rhOvertimePay(null, 44, 1, 1), null, 'salaire inconnu : pas de montant');
  assert.deepStrictEqual(R.rhPlanGaps([{ day: '2026-10-05' }, { day: '2026-10-11' }, { day: '2026-10-12' }, { day: '2026-10-14' }], s.days, ['2026-10-14']), ['2026-10-11']);
  assert.deepStrictEqual(R.rhEventDays([{ kind: 'conge', status: 'Validé', day_from: '2026-09-29', day_to: '2026-10-02' }, { kind: 'conge', status: 'Demandé', day_from: '2026-10-05', day_to: '2026-10-06' },
    { kind: 'maladie', day_from: '2026-10-30', day_to: '2026-11-03' }, { kind: 'absence', day_from: '2026-10-20', cancelled_at: 'x' }], ['conge', 'maladie', 'absence'], '2026-10-01', '2026-10-31'),
    ['2026-10-01', '2026-10-02', '2026-10-30', '2026-10-31']);
});

test('staff : journées pointées, pauses, départ non pointé (dernière activité), dates de naissance erronées, connexions', () => {
  const dayOf = t => new Date(t + 3600e3).toISOString().slice(0, 10);
  const ck = [{ kind: 'in', at: T('2026-10-05T07:30:00Z') }, { kind: 'session', at: T('2026-10-05T09:00:00Z') }, { kind: 'pause', at: T('2026-10-05T11:00:00Z') }, { kind: 'resume', at: T('2026-10-05T11:45:00Z') },
    { kind: 'pause', at: T('2026-10-05T14:00:00Z') }, { kind: 'resume', at: T('2026-10-05T14:10:00Z') }, { kind: 'out', at: T('2026-10-05T16:30:00Z') },
    { kind: 'fail', at: T('2026-10-06T07:00:00Z') }, { kind: 'in', at: T('2026-10-06T07:05:00Z') }, { kind: 'pause', at: T('2026-10-06T12:00:00Z') }, { kind: 'resume', at: T('2026-10-06T12:30:00Z') }];
  const ses = [{ started_at: T('2026-10-06T07:05:00Z'), last_seen: T('2026-10-06T12:00:00Z') }, { started_at: T('2026-10-06T11:00:00Z'), last_seen: T('2026-10-06T15:20:00Z') }];
  const d = R.rhStaffDays(ck, ses, { dayOf, now: T('2026-10-08T10:00:00Z') });
  assert.deepStrictEqual(d.map(x => [x.day, x.workMin, x.pauseMin, x.nPauses, x.outAuto, x.fails]), [['2026-10-05', 485, 55, 2, false, 0], ['2026-10-06', 465, 30, 1, true, 1]]);
  assert.strictEqual(R.rhMin(d[1].conn.min), '8 h 15', 'connexions réunies (07:05 -> 15:20)');
  assert.strictEqual(new Date(d[1].out).toISOString(), '2026-10-06T15:20:00.000Z', 'départ non pointé = dernière activité');
  const cur = R.rhStaffDays([{ kind: 'in', at: T('2026-10-08T07:00:00Z') }, { kind: 'pause', at: T('2026-10-08T09:30:00Z') }], [], { dayOf, now: T('2026-10-08T10:00:00Z') });
  assert.deepStrictEqual(cur.map(x => [x.ongoing, x.workMin, x.pauseMin]), [[true, 150, 30]], 'journée en cours, pause en cours');
  assert.deepStrictEqual(R.rhStaffOver([{ day: '2026-10-05', workMin: 46 * 60 }, { day: '2026-10-12', workMin: 30 * 60 }], 44), { '2026-10-05': 2, '2026-10-12': 0 });
  assert.deepStrictEqual(['on', 'pause', 'off'], [R.rhClockState([{ kind: 'in', at: 1 }, { kind: 'resume', at: 3 }], 10), R.rhClockState([{ kind: 'in', at: 1 }, { kind: 'pause', at: 2 }], 10), R.rhClockState([{ kind: 'in', at: 1 }, { kind: 'out', at: 2 }], 10)]);
});

test('droits : chauffeurs par agence pour le gestionnaire, staff réservé à l\'administrateur, pointage contrôlé par la base', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Casa');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into hr_employees (kind, name, agency_id, driver_code) values ('chauffeur', 'Ali A', 1, 'C1'), ('chauffeur', 'Badr B', 2, 'C2');
    insert into hr_employees (kind, name, agency_id, user_id, birth_date, pointage, salary) values ('staff', 'Sara S', 1, '${MGR}', '1992-04-17', true, 6000);`);
  try {
    assert.strictEqual(as(MGR, 'select string_agg(name, \',\' order by name) from hr_employees'), 'Ali A', 'gestionnaire : chauffeurs de son agence, ni staff ni autre agence');
    assert.strictEqual(as(ADMIN, 'select count(*) from hr_employees'), '3');
    assert.throws(() => as(MGR, "insert into hr_employees (kind, name, agency_id) values ('staff', 'X', 1)"), /row-level security/);
    assert.throws(() => as(MGR, "insert into hr_employees (kind, name, agency_id) values ('chauffeur', 'X', 2)"), /row-level security/);
    as(MGR, "insert into hr_employees (kind, name, agency_id) values ('chauffeur', 'Chams C', 1)");
    assert.throws(() => as(MGR, "update hr_employees set kind = 'staff' where name = 'Chams C'"), /row-level security|violates check/);
    assert.throws(() => env.psql("insert into hr_employees (kind, name, user_id) values ('chauffeur', 'Y', '" + ADMIN + "')"), /check constraint/, 'compte Ludy seulement pour le staff');
    as(MGR, "insert into hr_events (employee_id, kind, day_from, amount) values (1, 'avance', '2026-10-05', 500)");
    assert.throws(() => as(MGR, "insert into hr_events (employee_id, kind, day_from, amount) values (2, 'avance', '2026-10-05', 500)"), /row-level security/);
    assert.throws(() => as(MGR, "insert into hr_events (employee_id, kind, day_from, amount) values (3, 'prime', '2026-10-05', 500)"), /row-level security/, 'staff : pas de saisie par un gestionnaire');
    assert.strictEqual(env.psql('select created_by from hr_events'), MGR);
    as(MGR, 'delete from hr_events'); assert.strictEqual(env.psql('select count(*) from hr_events'), '1', 'suppression : administrateur seulement');
    // pointage : date de naissance contrôlée par la base, essais manqués comptés, transitions
    const clock = (k, b) => JSON.parse(as(MGR, `select public.hr_clock_do('${k}', ${b ? "'" + b + "'" : 'null'}, 'Test')`));
    assert.deepStrictEqual(JSON.parse(as(MGR, 'select public.hr_me()')).state, 'off');
    assert.deepStrictEqual(clock('in', '1992-04-18'), { ok: false, error: 'Date de naissance incorrecte' });
    assert.strictEqual(env.psql("select count(*) from hr_clock where kind = 'fail'"), '1', 'essai manqué gardé');
    assert.strictEqual(clock('pause').error, 'Pause possible seulement en service');
    const ok = clock('in', '1992-04-17');
    assert.deepStrictEqual([ok.ok, ok.state, ok.name], [true, 'on', 'Sara S']);
    assert.deepStrictEqual([clock('in', '1992-04-17').state, env.psql("select string_agg(kind, ',' order by id) from hr_clock")], ['on', 'fail,in,session'], 'nouvelle ouverture de Ludy : pas de 2e arrivée');
    assert.strictEqual(clock('pause').state, 'pause');
    assert.strictEqual(clock('pause').error, 'Pause possible seulement en service');
    assert.strictEqual(clock('resume').state, 'on');
    assert.strictEqual(clock('out').state, 'off');
    assert.strictEqual(clock('out').error, 'Aucune journée en cours');
    for (let i = 0; i < 4; i++) clock('in', '2000-01-01');
    assert.strictEqual(clock('in', '1992-04-17').error, 'Trop d\'essais : réessayez dans 15 minutes', '5 essais manqués : bloqué 15 minutes, même avec la bonne date');
    // le salarié lit son pointage, ne l'écrit pas directement ; la date de naissance ne sort jamais de la base
    assert.throws(() => as(MGR, `insert into hr_clock (employee_id, user_id, kind) values (3, '${MGR}', 'in')`), /row-level security/);
    assert.strictEqual(as(MGR, 'select count(*) from hr_clock'), env.psql('select count(*) from hr_clock'));
    assert.ok(!/1992/.test(as(MGR, 'select public.hr_me()::text')));
    assert.throws(() => as(MGR, 'select public.hr_state(3)'), /permission denied/);
    assert.strictEqual(JSON.parse(as(ADMIN, "select public.hr_clock_do('in', '1992-04-17', 'x')")).error, 'Pointage non activé pour ce compte');
    env.psql(`update profiles set role = 'viewer' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, 'select count(*) from hr_employees') + as(MGR, 'select count(*) from hr_events'), '00', 'lecture seule : aucune fiche');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('page Ressources humaines : fiche, congé posé dans le planning, présences et état mensuel d\'après les contrats', async () => {
  env.resetDb();
  const m = new Date().toISOString().slice(0, 7), d1 = m + '-02', d2 = m + '-03';
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into agencies (id, name) overriding system value values (1, 'Rabat');
    insert into drivers (code, name, phone, agency_id) values ('C9', 'Ali TEST', '0611223344', 1), ('C8', 'Badr TEST', '0611223355', 1);
    insert into contracts (num, client_code, name, vehicle_key, start_at, end_at, status) values
      ('K1', 'C9', 'Ali TEST', 'V1', '${d1}T06:00:00Z', '${d1}T18:00:00Z', 'Terminé'), ('K2', 'C9', 'Ali TEST', 'V1', '${d2}T06:00:00Z', '${d2}T18:30:00Z', 'Terminé');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/rh?t=salaries');
    await page.waitForSelector('#rhdrv');
    assert.strictEqual(await page.locator('.side nav .navsubs[data-grp="rh"] a.navsub').count() >= 9, true, 'dossier Ressources humaines dans le menu');
    // menu allégé : conduite et consommation dans un seul dossier, refermé hors de ses pages
    assert.deepStrictEqual(await page.$$eval('.side nav .navsubs[data-grp="cc"] a', a => a.map(x => x.textContent)), ['Arrêts moteur', 'Carburant', 'Classement', 'Comportement chauffeur', 'Conduite', 'Consommation', 'Fin de shift', 'Ralenti']);
    assert.strictEqual(await page.$eval('.side nav .navsubs[data-grp="cc"]', d => d.classList.contains('closed')), true);
    assert.strictEqual(await page.$eval('.side nav a[href="#/rh?t=salaries"]', a => a.classList.contains('on')), true);
    page.once('dialog', d => d.accept());
    await page.click('#rhdrv');
    await page.waitForFunction(() => document.querySelectorAll('#rhemp tbody tr').length === 2);
    assert.strictEqual(env.psql("select string_agg(name || '|' || driver_code || '|' || agency_id, ',' order by name) from hr_employees"), 'Ali TEST|C9|1,Badr TEST|C8|1');
    const id = env.psql("select id from hr_employees where driver_code = 'C9'");
    await page.goto('http://localhost:8080/#/rh?t=fiche&id=' + id);
    await page.waitForSelector('#rhfed');
    await page.click('#rhfed');
    await page.fill('[data-rhe="hired_on"]', '01/09/2026'); await page.fill('[data-rhe="salary"]', '3200'); await page.fill('[data-rhe="birth_date"]', '31/02/1990');
    await page.click('#rhesave');
    await page.waitForFunction(() => /À corriger : Date de naissance/.test(document.querySelector('#rheres').textContent));
    await page.fill('[data-rhe="birth_date"]', '31/01/1990'); await page.click('#rhesave');
    await page.waitForFunction(() => /Période d'essai/.test(document.body.innerText) && !document.querySelector('#rheres'));
    assert.strictEqual(env.psql(`select hired_on || '|' || salary || '|' || birth_date from hr_employees where id = ${id}`), '2026-09-01|3200.00|1990-01-31');
    // congé validé : posé dans le planning des chauffeurs
    await page.click('.rhadd summary');
    await page.selectOption('#rhv_kind', 'conge'); await page.fill('#rhv_from', '20/' + m.slice(5, 7) + '/' + m.slice(0, 4)); await page.fill('#rhv_to', '22/' + m.slice(5, 7) + '/' + m.slice(0, 4));
    await page.dispatchEvent('#rhv_to', 'input');
    await page.click('#rhvsave');
    await page.waitForFunction(() => /Congé/.test((document.querySelector('#rhfev table') || {}).innerText || ''));
    assert.strictEqual(env.psql("select status || '|' || days || '|' || (plan_absence_id is not null) from hr_events"), 'Validé|' + env.psql(`select count(*) from generate_series('${m}-20'::date, '${m}-22'::date, '1 day') g where extract(isodow from g) <> 7`) + '.00|true');
    assert.strictEqual(env.psql("select driver_code || '|' || day_from || '|' || day_to || '|' || reason from driver_absences"), `C9|${m}-20|${m}-22|RH : Congé`);
    // menu : titre de dossier = ouvrir / fermer (sans changer de page), ordre alphabétique, Flotte = Plaques + Véhicules
    const closed = g => page.$eval(`.side nav .navsubs[data-grp="${g}"]`, d => d.classList.contains('closed'));
    const h0 = await page.evaluate(() => location.hash);
    await page.click('.side nav a.navgrp[data-grp="cc"]');
    assert.strictEqual(await closed('cc'), false); assert.strictEqual(await page.evaluate(() => location.hash), h0);
    await page.click('.side nav a.navgrp[data-grp="cc"]');
    assert.strictEqual(await closed('cc'), true);
    await page.click('.side nav a.navgrp[data-grp="rh"]');
    assert.strictEqual(await closed('rh'), true);
    await page.click('.side nav a.navgrp[data-grp="cc"]'); await page.click('.side nav a.navsub[href="#/chauffeurs"]');
    await page.waitForFunction(() => location.hash === '#/chauffeurs' && document.querySelector('.side nav a[href="#/chauffeurs"].on') && !document.querySelector('.side nav .navsubs[data-grp="cc"]').classList.contains('closed') && document.querySelector('.side nav .navsubs[data-grp="rh"]').classList.contains('closed'));
    assert.deepStrictEqual(await page.$$eval('.side nav a[aria-current]', a => a.map(x => x.getAttribute('href'))), ['#/chauffeurs']);
    const top = await page.$$eval('.side nav > a, .side nav > .navfold > a.navgrp', a => a.map(x => x.textContent.trim()));
    assert.deepStrictEqual(top, [...top].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })));
    assert.ok(top.includes('Flotte') && !top.includes('Plaques') && !top.includes('Véhicules'), top.join(', '));
    assert.deepStrictEqual(await page.$$eval('.side nav .navsubs[data-grp="flotte"] a', a => a.map(x => x.textContent)), ['Plaques', 'Véhicules']);
    // présences du mois : 2 contrats = 2 jours, 24 h 30
    await page.goto('http://localhost:8080/#/rh?t=presences');
    await page.waitForSelector('#rhpres');
    assert.match(await page.innerText('#rhpres'), /Ali TEST\tChauffeur\t2\t24 h 30/);
    await page.goto('http://localhost:8080/#/rh?t=mois');
    await page.waitForSelector('#rhmo');
    assert.match(await page.innerText('#rhmo'), /Ali TEST\tChauffeur\t3\s?200\t2\t24 h 30/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});

test('pointage du staff : date de naissance à l\'ouverture de Ludy, pause, fin de journée', async () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into hr_employees (kind, name, agency_id, user_id, birth_date, pointage) values ('staff', 'Sara S', 1, '${MGR}', '1992-04-17', true);`);
  const srv = await startSite('pending'), { br, page, errors } = await openBrowser();
  try {
    await page.goto('http://localhost:8080/#/vehicules');
    await page.fill('#le', 'new@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#rhgf');
    assert.match(await page.innerText('.lbox'), /Bonjour Sara S/);
    await page.click('#rhgb'); await page.keyboard.type('18041992'); await page.click('#rhgf button[type=submit]');
    await page.waitForFunction(() => /Date de naissance incorrecte/.test(document.querySelector('#rhgr').textContent));
    await page.click('#rhgb'); await page.keyboard.type('17041992'); await page.click('#rhgf button[type=submit]');
    await page.waitForSelector('.side nav');
    assert.match(await page.innerText('.rhfoot'), /En service/);
    assert.strictEqual(env.psql("select string_agg(kind, ',' order by id) from hr_clock"), 'fail,in');
    // rechargement de la page dans le même onglet : pas de nouvelle demande le même jour
    await page.reload(); await page.waitForSelector('.side nav');
    await page.click('#rhfp');
    await page.waitForSelector('#rhpres');
    assert.match(await page.innerText('.lbox'), /En pause/);
    await page.click('#rhpres'); await page.waitForSelector('.rhfoot');
    page.once('dialog', d => d.accept());
    await page.click('#rhfo');
    await page.waitForSelector('#rhgf');
    assert.match(await page.innerText('.lbox'), /Commencer ma journée/);
    assert.strictEqual(env.psql("select string_agg(kind, ',' order by id) from hr_clock"), 'fail,in,pause,resume,out');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});
