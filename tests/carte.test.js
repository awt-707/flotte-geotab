// Anomalies carburant : achats de la carte carburant (extract Afriquia) croisés avec les pleins Geotab et la jauge (données synthétiques)
const test = require('node:test'), assert = require('node:assert');
const lib = require('../site/lib.js'), rpt = require('../site/report.js'), env = require('./lib/env');
lib.setTzRules(env.MA_TZ);
const H = 3600000, MIN = 60000, T0 = Date.UTC(2026, 8, 1, 8, 0);
const V = { '111111WW': { plate: '11111-A-1', model: 'STARIA', fuel: 'GO', tank_l: 75 }, '222222WW': { plate: '22222-A-1', model: 'SONATA', fuel: 'EH', tank_l: 50 } };
// 12 pleins « normaux » du Staria : 85 L pour 100 % de jauge, ticket 5 min après le plein Geotab
function base() {
  const tx = [], fills = [];
  for (let i = 0; i < 12; i++) {
    const t = T0 + i * 24 * H, lb = 10 + (i % 5) * 8;
    fills.push({ id: 'F' + i, vehicle_key: '111111WW', plate: '11111-A-1', stop_start: new Date(t).toISOString(), lvl_before: lb, lvl_after: 100 });
    tx.push({ id: 'T' + i, vehicle_key: '111111WW', plate: 'WW111111', at: t + 5 * MIN, liters: +(85 * (100 - lb) / 100 + (i % 3) - 1).toFixed(2), product: 'GASOIL', amount_ttc: 700 });
  }
  return { tx, fills, levels: [] };
}
const run = d => rpt.rptFuelCard({ tx: d.tx, fills: d.fills, levels: d.levels, trips: d.trips, vehicles: V, who: () => 'Chauffeur test' });
const anOf = (res, id) => { const r = res.rows.find(r => r.tx.some(x => x.id === id)); assert.ok(r, 'ticket ' + id + ' absent'); return r.anomalies.map(a => a.t); };

test('achats normaux : rapprochés de leur plein Geotab, relation litres / jauge mesurée, aucune anomalie', () => {
  const res = run(base());
  assert.strictEqual(res.rows.length, 12);
  assert.ok(res.rows.every(r => r.fill && !r.anomalies.length), JSON.stringify(res.rows.map(r => r.anomalies)));
  assert.ok(Math.abs(res.fit.STARIA.b - 85) < 3, 'relation mesurée ' + JSON.stringify(res.fit));
  assert.strictEqual(res.fit.SONATA, undefined, 'moins de 10 pleins : non mesuré');
  assert.deepStrictEqual(res.orphans, []);
});

test('achat sans plein : aucun plein Geotab et jauge qui ne monte pas = Critique ; jauge non relevée = à vérifier', () => {
  const d = base(), t = T0 + 13 * 24 * H;
  d.tx.push({ id: 'X1', vehicle_key: '111111WW', at: t, liters: 60, product: 'GASOIL' });
  d.levels.push({ vehicle_key: '111111WW', at: new Date(t - 40 * MIN).toISOString(), pct: 82 }, { vehicle_key: '111111WW', at: new Date(t + 20 * MIN).toISOString(), pct: 81 },
    { vehicle_key: '111111WW', at: new Date(t + 90 * MIN).toISOString(), pct: 79 });
  d.tx.push({ id: 'X2', vehicle_key: '111111WW', at: t + 30 * 24 * H, liters: 40, product: 'GASOIL' });
  const res = run(d);
  assert.deepStrictEqual(anOf(res, 'X1'), ['Achat sans plein dans le véhicule']);
  assert.strictEqual(res.rows.find(r => r.tx[0].id === 'X1').sev, 'Critique');
  assert.deepStrictEqual(anOf(res, 'X2'), ['Aucun plein détecté par Geotab']);
});

test('plein payé en deux tickets : regroupé ; deux tickets pour un seul plein = plus que la capacité du réservoir', () => {
  const d = base(), t = T0 + 13 * 24 * H;
  d.fills.push({ id: 'G1', vehicle_key: '111111WW', stop_start: new Date(t).toISOString(), lvl_before: 20, lvl_after: 100 });
  d.tx.push({ id: 'S1', vehicle_key: '111111WW', at: t + 4 * MIN, liters: 8, product: 'GASOIL' }, { id: 'S2', vehicle_key: '111111WW', at: t + 9 * MIN, liters: 60, product: 'GASOIL' });
  const t2 = t + 3 * 24 * H;
  d.fills.push({ id: 'G2', vehicle_key: '111111WW', stop_start: new Date(t2).toISOString(), lvl_before: 30, lvl_after: 100 });
  d.tx.push({ id: 'S3', vehicle_key: '111111WW', at: t2 + 2 * MIN, liters: 59, product: 'GASOIL' }, { id: 'S4', vehicle_key: '111111WW', at: t2 + 25 * MIN, liters: 55, product: 'GASOIL' });
  const res = run(d), r1 = res.rows.find(r => r.tx[0].id === 'S1'), r2 = res.rows.find(r => r.tx[0].id === 'S3');
  assert.strictEqual(r1.tx.length, 2); assert.strictEqual(r1.liters, 68); assert.deepStrictEqual(r1.anomalies, []);
  assert.strictEqual(r2.tx.length, 2);
  assert.deepStrictEqual(r2.anomalies.map(a => a.t), ['Plus que la capacité du réservoir'], '114 L pour un réservoir de 75 L');
  assert.ok(Math.abs(r2.expected - 0.7 * res.fit.STARIA.b - res.fit.STARIA.a) < 0.01);
});

test('transaction transmise en différé par la station : rapprochée du plein Geotab libre des 48 h précédentes', () => {
  const d = base(), t = T0 + 13 * 24 * H;
  d.fills.push({ id: 'L1', vehicle_key: '111111WW', stop_start: new Date(t).toISOString(), lvl_before: 25, lvl_after: 100 });
  d.tx.push({ id: 'D1', vehicle_key: '111111WW', at: t + 20 * H, liters: 64, product: 'GASOIL' });
  const res = run(d), r = res.rows.find(x => x.tx[0].id === 'D1');
  assert.ok(r.fill && r.late, 'rapproché en différé'); assert.deepStrictEqual(r.anomalies, []);
  assert.deepStrictEqual(res.orphans, []);
});

test('carburant non conforme, deux pleins rapprochés, plein Geotab sans achat', () => {
  const d = base(), t = T0 + 13 * 24 * H, iso = x => new Date(x).toISOString();
  d.fills.push({ id: 'P1', vehicle_key: '111111WW', stop_start: iso(t), lvl_before: 30, lvl_after: 100 },
    { id: 'P2', vehicle_key: '111111WW', stop_start: iso(t + 2 * H), lvl_before: 60, lvl_after: 100 },
    { id: 'P3', vehicle_key: '111111WW', stop_start: iso(t + 5 * 24 * H), lvl_before: 20, lvl_after: 100 },
    { id: 'P4', vehicle_key: '111111WW', stop_start: iso(t + 7 * 24 * H), lvl_before: 20, lvl_after: 100 },
    { id: 'P5', vehicle_key: '111111WW', stop_start: iso(t + 10 * 24 * H), lvl_before: 20, lvl_after: 100 });
  d.tx.push({ id: 'N1', vehicle_key: '111111WW', at: t + 3 * MIN, liters: 59, product: 'SUPER SP' }, { id: 'N2', vehicle_key: '111111WW', at: t + 2 * H + 3 * MIN, liters: 34, product: 'GASOIL' },
    { id: 'N3', vehicle_key: '111111WW', at: t + 6 * 24 * H, liters: 68, product: 'GASOIL' }, { id: 'N4', vehicle_key: '111111WW', at: t + 10 * 24 * H + 5 * MIN, liters: 68, product: 'GASOIL' });
  const res = run(d);
  assert.deepStrictEqual(anOf(res, 'N1'), ['Carburant non conforme']);
  assert.deepStrictEqual(anOf(res, 'N2'), ['Deux pleins rapprochés']);
  assert.deepStrictEqual(anOf(res, 'N3'), [], 'plein P3 de la veille, après le ticket précédent : transaction transmise en différé');
  assert.ok(res.rows.find(r => r.tx[0].id === 'N3').late);
  assert.deepStrictEqual(anOf(res, 'N4'), []);
  assert.deepStrictEqual(res.orphans.map(f => f.id), ['P4'], 'P4 : plus de 48 h avant N4, aucun ticket');
});

test('heure Afriquia décalée d\'1 h (dans un sens ou dans l\'autre) : ticket toujours rapproché de son plein', () => {
  const d = base(), t = T0 + 13 * 24 * H;
  d.fills.push({ id: 'H1', vehicle_key: '111111WW', stop_start: new Date(t).toISOString(), lvl_before: 20, lvl_after: 100 },
    { id: 'H2', vehicle_key: '111111WW', stop_start: new Date(t + 2 * 24 * H).toISOString(), lvl_before: 20, lvl_after: 100 });
  d.tx.push({ id: 'A1', vehicle_key: '111111WW', at: t + 65 * MIN, liters: 68, product: 'GASOIL' }, { id: 'A2', vehicle_key: '111111WW', at: t + 2 * 24 * H - 55 * MIN, liters: 68, product: 'GASOIL' });
  const res = run(d);
  ['A1', 'A2'].forEach(id => { const r = res.rows.find(x => x.tx[0].id === id); assert.ok(r.fill && !r.late, id); assert.deepStrictEqual(r.anomalies, []); });
  assert.deepStrictEqual(res.orphans, []);
});

test('plein à plein : facturé comparé au carburant consommé par le moteur ; plus que la capacité du réservoir', () => {
  // Sonata : moins de 10 pleins, pas de relation de jauge : seul le moteur mesure
  const iso = x => new Date(x).toISOString(), t = T0, d = { tx: [], fills: [], levels: [], trips: [] };
  [0, 1, 2, 3].forEach(i => d.fills.push({ id: 'S' + i, vehicle_key: '222222WW', stop_start: iso(t + i * 48 * H), lvl_before: 20, lvl_after: 100 }));
  [[0, 40], [1, 41], [2, 54], [3, 70]].forEach(([i, q]) => d.tx.push({ id: 'Q' + i, vehicle_key: '222222WW', at: t + i * 48 * H + 5 * MIN, liters: q, product: 'SUPER SP' }));
  [1, 2, 3].forEach(i => { d.trips.push({ vehicle_key: '222222WW', start_at: iso(t + (i - 1) * 48 * H + 3 * H), km: 300, fuel_l: 20 }, { vehicle_key: '222222WW', start_at: iso(t + (i - 1) * 48 * H + 20 * H), km: 300, fuel_l: 20 }); });
  const res = run(d), r = id => res.rows.find(x => x.tx[0].id === id);
  assert.strictEqual(r('Q0').engine, null, 'premier plein : pas de plein précédent');
  assert.strictEqual(r('Q1').engine, 40); assert.deepStrictEqual(r('Q1').anomalies, []);
  assert.deepStrictEqual(r('Q2').anomalies.map(a => a.t), ['Litres facturés supérieurs au plein mesuré']);
  assert.match(r('Q2').anomalies[0].d, /moteur : 40,0 L consommés/);
  assert.deepStrictEqual(r('Q3').anomalies.map(a => a.t), ['Plus que la capacité du réservoir'], '70 L dans un réservoir de 50 L');
  // un trajet sans mesure de carburant entre les deux pleins : moteur non mesuré
  d.trips.push({ vehicle_key: '222222WW', start_at: iso(t + 48 * H + 30 * H), km: 50, fuel_l: null });
  assert.strictEqual(run(d).rows.find(x => x.tx[0].id === 'Q2').engine, null);
});

test('Staria : un plein de 77 L après 77 L consommés par le moteur n\'est pas une anomalie (réservoir 75 L + goulot)', () => {
  const d = base(), t = T0 + 13 * 24 * H, iso = x => new Date(x).toISOString();
  d.trips = [{ vehicle_key: '111111WW', start_at: iso(t - 10 * H), km: 700, fuel_l: 77.5 }];
  d.fills.push({ id: 'R1', vehicle_key: '111111WW', stop_start: iso(t), lvl_before: 9.5, lvl_after: 100 });
  d.tx.push({ id: 'R1t', vehicle_key: '111111WW', at: t + 5 * MIN, liters: 77.1, product: 'GASOIL' });
  const r = run(d).rows.find(x => x.tx[0].id === 'R1t');
  assert.ok(Math.abs(r.engine - 77.5) < 1e-9); assert.deepStrictEqual(r.anomalies, []);
});

test('lecture de l\'extract Afriquia : plaque WW, date au Maroc, nombres, produit, doublons', () => {
  const head = ['Carte', 'Code Carte', 'Station de service', 'Date Transaction', 'Libellé 1', 'Libellé 2', 'Produit', 'Quantité', 'Prix Public', 'Montant Transaction TTC', 'Matricule', 'Ticket', 'Mode Fueling'];
  const row = (d, pl, q, ttc, tk) => ['7000000000000001', 'X', '25:OASIS', d, 'SOCIETE TEST', pl, 'GASOIL                    ', q, '14,93', ttc, 'A', tk, 'VID'];
  const rows = [head, row('2026-10-08 10:44:22', 'WW111111', '52.18', '1 077,27', '001648'), row('08/10/2026 12:49', 'WW111111', '9,01', '134.52', '001688'),
    row('2026-10-08 10:44:22', 'WW111111', '52.18', '1 077,27', '001648'), row('', 'WW111111', '3', '', '1'), row('2026-10-09 01:00', 'LUXURY', '3', '', '2')];
  const cm = lib.buildCanonMap([{ key: '111111WW', plate: '11111-A-1', other_plates: 'WW111111' }], []);
  const res = lib.parseFuelCard(rows, cm);
  assert.strictEqual(res.read, 5); assert.strictEqual(res.dup, 1); assert.strictEqual(res.invalid, 2);
  const [a, b] = res.rows;
  assert.strictEqual(a.vehicle_key, '111111WW'); assert.strictEqual(a.plate, 'WW111111'); assert.strictEqual(a.product, 'GASOIL');
  assert.strictEqual(a.liters, 52.18); assert.strictEqual(a.amount_ttc, 1077.27); assert.strictEqual(a.unit_price, 14.93); assert.strictEqual(b.liters, 9.01);
  assert.strictEqual(lib.localHM(a.at), '10:44'); assert.strictEqual(a.day, '2026-10-08');
  assert.strictEqual(new Date(a.at).toISOString(), '2026-10-08T09:44:00.000Z', 'heure du Maroc = UTC+1');
  assert.strictEqual(lib.numAny('1,077.27'), 1077.27); assert.strictEqual(lib.numAny('1.077,27'), 1077.27);
  assert.throws(() => lib.parseFuelCard([['Nom', 'Prénom'], ['a', 'b']], cm), /Quantité/);
});

test('litres d\'un plein : volume Geotab entre deux pleins complets, sinon jauge (plein partiel, après un plein partiel, premier plein)', () => {
  const R = require('../site/report.js');
  const f = (t, before, after, gauge, geo) => ({ type: 'PLEIN', vehicle_key: 'V', stop_start: t, lvl_before: before, lvl_after: after, liters_gauge: gauge, liters_geotab: geo });
  const l = [f('2026-10-01T08:00:00Z', 20, 100, 60, 70), f('2026-10-03T08:00:00Z', 15, 100, 64, 74.5), f('2026-10-05T08:00:00Z', 30, 60, 22.5, 41), f('2026-10-07T08:00:00Z', 25, 100, 56, 30)];
  R.rptFillMark(l.slice().reverse());   // ordre quelconque
  assert.deepStrictEqual(l.map(x => [R.rptFillL(x), R.rptFillSrc(x)]), [[60, 'jauge (plein précédent inconnu)'], [74.5, 'Geotab (plein à plein)'], [22.5, 'jauge'], [56, 'jauge']]);
  // jauge absente : volume Geotab
  const g = [f('2026-10-01T08:00:00Z', 20, 100, null, 70)]; R.rptFillMark(g); assert.strictEqual(R.rptFillL(g[0]), 70);
});

test('relecture 18/10 : 2e ticket d\'un plein regroupé avant le « transmis en différé » ; tickets transmis ensemble dans l\'ordre de leurs pleins', () => {
  // plein F1 la veille payé autrement, plein F2 payé en deux tickets (50 L + 45 L) : 95 L pour un réservoir de 75 L
  let d = base(); const t = T0 + 14 * 24 * H;
  d.fills.push({ id: 'G1', vehicle_key: '111111WW', stop_start: new Date(t - 16 * H).toISOString(), lvl_before: 60, lvl_after: 99 },
    { id: 'G2', vehicle_key: '111111WW', stop_start: new Date(t - 5 * MIN).toISOString(), lvl_before: 5, lvl_after: 100 });
  d.tx.push({ id: 'S1', vehicle_key: '111111WW', at: t, liters: 50, product: 'GASOIL' }, { id: 'S2', vehicle_key: '111111WW', at: t + 20 * MIN, liters: 45, product: 'GASOIL' });
  let res = run(d);
  const r = res.rows.find(x => x.tx.some(y => y.id === 'S1'));
  assert.deepStrictEqual(r.tx.map(x => x.id), ['S1', 'S2']); assert.strictEqual(r.fill.id, 'G2');
  assert.ok(r.anomalies.some(a => a.t === 'Plus que la capacité du réservoir'), JSON.stringify(r.anomalies));
  assert.ok(res.orphans.some(f => f.id === 'G1'), 'plein de la veille sans achat');
  // deux tickets transmis à la même minute 2 jours plus tard : le premier ticket va au premier plein
  d = base(); const u = T0 + 15 * 24 * H;
  d.fills.push({ id: 'P1', vehicle_key: '111111WW', stop_start: new Date(u - 30 * H).toISOString(), lvl_before: 10, lvl_after: 100 },
    { id: 'P2', vehicle_key: '111111WW', stop_start: new Date(u - 6 * H).toISOString(), lvl_before: 60, lvl_after: 99 });
  d.tx.push({ id: 'L1', vehicle_key: '111111WW', at: u, liters: 70, product: 'GASOIL' }, { id: 'L2', vehicle_key: '111111WW', at: u, liters: 30, product: 'GASOIL' });
  res = run(d);
  assert.strictEqual(res.rows.find(x => x.tx[0].id === 'L1').fill.id, 'P1');
  assert.strictEqual(res.rows.find(x => x.tx[0].id === 'L2').fill.id, 'P2');
});
