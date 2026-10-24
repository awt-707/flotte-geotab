// Staff : arrivée non pointée (heure prévue + rhClockLateMin) signalée sur le site et par e-mail, une fois par salarié et par jour.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), R = require('../site/rh_calc.js'), { collector } = require('./lib/v6');
const ADMIN = '11111111-1111-1111-1111-111111111111';

test('calcul : arrivée non pointée après l\'heure prévue + 30 min, sauf jour non travaillé, férié, congé, absence', () => {
  const e = { id: 1, kind: 'staff', pointage: true, work_start: '08:30:00', work_days: '1,2,3,4,5,6', hired_on: '2026-01-01' }, P = { rhHolidays: '2026-11-06' };
  assert.strictEqual(R.rhClockMissing(e, [], [], '2026-10-26', '08:59', P), null, 'pas encore 09:00');
  assert.deepStrictEqual(R.rhClockMissing(e, [], [], '2026-10-26', '09:00', P), { due: '09:00' });
  assert.deepStrictEqual(R.rhClockMissing(e, [], [], '2026-10-26', '09:10', { rhClockLateMin: 45 }), null, 'délai réglable (09:15)');
  assert.strictEqual(R.rhClockMissing(e, [{ kind: 'in' }], [], '2026-10-26', '12:00', P), null, 'arrivée pointée');
  assert.strictEqual(R.rhClockMissing(e, [], [], '2026-10-25', '12:00', P), null, 'dimanche non travaillé');
  assert.strictEqual(R.rhClockMissing(e, [], [], '2026-11-06', '12:00', P), null, 'jour férié');
  assert.strictEqual(R.rhClockMissing(e, [], [{ employee_id: 1, kind: 'conge', status: 'Validé', day_from: '2026-10-26', day_to: '2026-10-27' }], '2026-10-26', '12:00', P), null, 'congé validé');
  assert.deepStrictEqual(R.rhClockMissing(e, [], [{ employee_id: 1, kind: 'conge', status: 'Demandé', day_from: '2026-10-26' }], '2026-10-26', '12:00', P), { due: '09:00' }, 'congé seulement demandé');
  assert.strictEqual(R.rhClockMissing(Object.assign({}, e, { work_start: null }), [], [], '2026-10-26', '12:00', P), null, 'heure non réglée');
  assert.strictEqual(R.rhClockMissing(Object.assign({}, e, { left_on: '2026-10-20' }), [], [], '2026-10-26', '12:00', P), null, 'salarié sorti');
  // alertes RH : arrivée du jour, départ de la veille non pointé
  const al = R.rhAlerts({ emps: [Object.assign({ name: 'A', cnss_no: '1', salary: 1, employer_id: 1, cin: 'x' }, e)], events: [], contracts: [], docs: [], P: { rhDocsStaff: '' }, today: '2026-10-27', nowHM: '10:00',
    clock: { 1: [{ kind: 'in', day: '2026-10-26' }, { kind: 'pause', day: '2026-10-26' }, { kind: 'resume', day: '2026-10-26' }] } }).filter(a => a.type === 'Pointage');
  assert.deepStrictEqual(al.map(a => a.level + ' · ' + a.text), ['Haute · Arrivée non pointée aujourd\'hui (prévue à 08:30, alerte à 09:00)',
    'Moyenne · Départ non pointé hier (26/10/2026) : fin de journée prise à la dernière activité sur Ludy, à vérifier']);
});

test('collecteur : e-mail aux administrateurs et aux RH dès l\'heure limite, une seule fois par jour', () => {
  const NOW = Date.UTC(2026, 9, 26, 8, 5);   // lundi 26/10/2026 09:05, heure du Maroc (UTC+1)
  const B = collector(NOW);
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into hr_employees (kind, name, pointage, work_start) values ('staff', 'Nadia TEST', true, '08:30'), ('staff', 'Rachid TEST', true, '08:30'), ('staff', 'Salma TEST', true, '08:30'), ('staff', 'Yassine TEST', true, '10:00'), ('staff', 'Sans heure', true, null);
    insert into hr_clock (employee_id, kind, at) values (2, 'in', '2026-10-26T07:20:00Z');
    insert into hr_events (employee_id, kind, day_from, day_to, status) values (3, 'conge', '2026-10-26', '2026-10-28', 'Validé');`);
  try {
    const r = B.run('rhClockStep_()');
    assert.match(r, /pointage non fait : Nadia TEST \(e-mail à 1 destinataire\)/);
    assert.deepStrictEqual(B.mails.map(m => m.to + ' · ' + m.subject), ['admin@x · Ludy RH : Nadia TEST n\'a pas pointé son arrivée']);
    assert.match(B.mails[0].htmlBody, /arrivée prévue à 08:30/);
    assert.strictEqual(B.run('rhClockStep_()'), '', 'pas de second e-mail le même jour');
    B.setNow(NOW + 2 * 3600000);   // 11:05 : Yassine (10:00) en retard
    assert.match(B.run('rhClockStep_()'), /Yassine TEST/);
    assert.strictEqual(B.mails.length, 2);
  } finally { env.resetDb(); }
});
