// Shift jour / nuit : un chauffeur est classé d'après l'heure de début de son contrat (heure du Maroc),
// de shiftDay h (inclus) à shiftNight h (exclu) = shift jour, sinon nuit. Même règle sur le site et dans les rapports PDF.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), lib = require('../site/lib.js'), rpt = require('../site/report.js');
const P = { shiftDay: 7, shiftNight: 19, shiftAdvance: 0, kmMin: 20, minFuelKm: 30, scoreY: 5, scoreO: 10, scoreR: 20 };
// heure du Maroc 'hh:mm' le 14/10/2026 (UTC+1) -> instant UTC
const at = hm => new Date(Date.UTC(2026, 9, 14, +hm.slice(0, 2) - 1, +hm.slice(3, 5))).toISOString();

test('shift d\'un contrat : pris de 07:00 à 18:59 = jour (avance 0), de 05:00 à 16:59 (avance 2 h), heure du Maroc', () => {
  lib.setTzRules(env.MA_TZ);
  const cases = { '07:00': 'Jour', '06:59': 'Nuit', '06:00': 'Nuit', '12:59': 'Jour', '15:30': 'Jour', '18:59': 'Jour', '19:00': 'Nuit', '23:30': 'Nuit', '00:59': 'Nuit', '01:01': 'Nuit' };
  Object.entries(cases).forEach(([hm, s]) => {
    assert.strictEqual(lib.shiftOf(at(hm), P), s, 'site ' + hm);
    assert.strictEqual(rpt.rptShift(lib.localHM(at(hm)), P), s, 'rapport ' + hm);
  });
  assert.strictEqual(lib.shiftOf(at('13:00'), { shiftDay: 8, shiftNight: 20, shiftAdvance: 0 }), 'Jour');
  assert.strictEqual(lib.shiftOf(at('07:30'), { shiftDay: 8, shiftNight: 20, shiftAdvance: 0 }), 'Nuit');
  assert.strictEqual(lib.shiftOf(at('19:30'), { shiftDay: 8, shiftNight: 20, shiftAdvance: 0 }), 'Jour');
  assert.strictEqual(lib.shiftOf(null, P), '');
  // avance de 2 h (réglage par défaut) : pris de 05:00 à 16:59 = jour, de 17:00 à 04:59 = nuit
  const P2 = Object.assign({}, P, { shiftAdvance: 2 }), c2 = { '04:59': 'Nuit', '05:00': 'Jour', '06:50': 'Jour', '15:30': 'Jour', '16:59': 'Jour', '17:00': 'Nuit', '23:30': 'Nuit' };
  Object.entries(c2).forEach(([hm, s]) => {
    assert.strictEqual(lib.shiftOf(at(hm), P2), s, 'site +2 h ' + hm);
    assert.strictEqual(rpt.rptShift(lib.localHM(at(hm)), P2), s, 'rapport +2 h ' + hm);
  });
  assert.strictEqual(lib.shiftOf(at('05:30'), { shiftDay: 7, shiftNight: 19 }), 'Jour', 'sans réglage : 2 h d\'avance');
  assert.strictEqual(lib.shiftName('Nuit', P), 'Shift nuit (19:00 → 07:00)');
  lib.setTzRules(null);
});

test('rapport de la flotte : chauffeurs séparés en shift jour et shift nuit', () => {
  lib.setTzRules(env.MA_TZ);
  const row = (code, num, hm, km) => ({ day: '2026-10-14', vehicle_key: 'V1', driver_code: code, driver_name: 'Nom ' + code, contract_num: num, contract_start: at(hm), km, drive_h: 1, idle_h: 0, n_events: 0, danger_pts: 0 });
  const rep = rpt.rptBuild({ journal: [row('A', 'C1', '07:05', 50), row('B', 'C2', '19:10', 60), row('A', 'C3', '06:50', 40)], alerts: [],
    vehicles: [{ key: 'V1', plate: 'V1' }], P, from: '2026-10-14', to: '2026-10-14', hmOf: lib.localHM });
  const t = rpt.rptTables(rep).filter(x => /^Chauffeurs/.test(x.title));
  assert.deepStrictEqual(t.map(x => x.title.split(' : ')[1]), ['Shift jour (07:00 → 19:00)', 'Shift nuit (19:00 → 07:00)']);
  assert.deepStrictEqual(t[0].rows.map(r => r[2]), ['A']);
  assert.deepStrictEqual(t[1].rows.map(r => r[2]).sort(), ['A', 'B']);
  assert.ok(t.every(x => x.rows.every((r, i) => r[0] === String(i + 1))), 'rang dans le shift');
  // sans heure (ancien appel) : un seul tableau
  assert.strictEqual(rpt.rptTables(rpt.rptBuild({ journal: [row('A', 'C1', '07:05', 50)], alerts: [], vehicles: [{ key: 'V1', plate: 'V1' }], P, from: '2026-10-14', to: '2026-10-14' }))
    .filter(x => /^Chauffeurs/.test(x.title)).length, 1);
  lib.setTzRules(null);
});

test('rapport de consommation : par chauffeur et par shift, hors contrat à part', () => {
  const trip = (code, num, l) => ({ vehicle_key: 'V1', start_at: at('10:00'), km: 50, drive_min: 60, idle_min: 5, fuel_l: l, idle_fuel_l: null, driver_code: code, driver_name: 'Nom ' + code, contract_num: num });
  const sh = { C1: 'Jour', C2: 'Nuit' };
  const rep = rpt.rptConso({ trips: [trip('A', 'C1', 4), trip('B', 'C2', 5), trip('HORS_CONTRAT', '', 1)], fuel: [], stops: [], vehicles: [{ key: 'V1', plate: 'V1' }], P,
    a: Date.parse(at('00:00')), z: Date.parse(at('23:59')), dayOf: () => '2026-10-14', hmOf: () => '10:00', ctrShift: n => sh[n] || '' });
  const t = rep.tables.filter(x => /^Par chauffeur/.test(x.title));
  assert.deepStrictEqual(t.map(x => x.title), ['Par chauffeur : Shift jour (07:00 → 19:00)', 'Par chauffeur : Shift nuit (19:00 → 07:00)', 'Par chauffeur : Hors contrat ou contrat introuvable']);
  assert.deepStrictEqual(t.map(x => x.rows.map(r => r[0])), [['Nom A'], ['Nom B'], ['Hors contrat']]);
});

test('shift d\'un instant (alerte) : jour de 07:00 à 19:00, sinon nuit ; la nuit appartient au jour où elle commence', () => {
  lib.setTzRules(env.MA_TZ);
  const at2 = (d, hm) => new Date(Date.UTC(2026, 9, d, +hm.slice(0, 2) - 1, +hm.slice(3, 5)));
  const cases = [[16, '14:06', 'Jour du 16/10'], [16, '07:00', 'Jour du 16/10'], [16, '18:59', 'Jour du 16/10'], [16, '06:59', 'Nuit du 15/10 → 16/10'],
    [16, '19:00', 'Nuit du 16/10 → 17/10'], [17, '00:00', 'Nuit du 16/10 → 17/10'], [17, '02:30', 'Nuit du 16/10 → 17/10']];
  cases.forEach(([d, hm, txt]) => assert.strictEqual(lib.shiftDayName(lib.shiftAt(at2(d, hm), P)), txt, d + ' ' + hm));
  // contrat : heure de début (07:00 → 18:59 jour) ; nuit prise après minuit = nuit de la veille
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(16, '06:31'), P)), 'Nuit du 15/10 → 16/10');
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(16, '18:58'), P)), 'Jour du 16/10');
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(16, '15:20'), P)), 'Jour du 16/10');
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(17, '00:08'), P)), 'Nuit du 16/10 → 17/10');
  // avance de 2 h : la nuit prise à 23:30 reste la nuit du jour même, celle prise à 04:00 est la nuit de la veille, 05:30 = jour
  const P2 = Object.assign({}, P, { shiftAdvance: 2 });
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(16, '23:30'), P2)), 'Nuit du 16/10 → 17/10');
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(17, '04:00'), P2)), 'Nuit du 16/10 → 17/10');
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(17, '05:30'), P2)), 'Jour du 17/10');
  assert.strictEqual(lib.shiftDayName(lib.shiftOfCtr(at2(16, '17:10'), P2)), 'Nuit du 16/10 → 17/10');
  assert.strictEqual(lib.shiftAt(null, P), null);
  lib.setTzRules(null);
});
