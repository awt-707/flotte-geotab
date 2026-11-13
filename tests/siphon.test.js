// Contrôle des siphonages suspects (13/11/2026, doute d'Ahmed) : véhicule déplacé pendant l'arrêt (GPS Geotab) = trajet non enregistré ;
// jauge remontée après le redémarrage = véhicule garé en pente ; sinon à vérifier. Cas repris des vraies alertes du 01 au 13/11 (valeurs, pas de noms).
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');

const T = s => Date.parse(s), row = (start, end, before, after, extra) => Object.assign({ id: 'K|' + start + '|SIPHONAGE_SUSPECT', vehicle_key: 'K', stop_start: start, stop_end: end,
  lvl_before: before, lvl_after: after, source: 'Jauge (L)', lat: 31.6, lon: -8.0, status: 'À vérifier' }, extra);
const still = (a, b) => [{ t: T(a) - 60000, lat: 31.6, lon: -8.0, speed: 0 }, { t: T(a) + 20 * 60000, lat: 31.60001, lon: -8.00001, speed: 0 }, { t: T(b) + 60000, lat: 31.6, lon: -8.0, speed: 0 }];

test('verdict : déplacé (GPS), jauge remontée (pente), immobile et jauge restée basse, non mesuré', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 10, 13, 12, 0));
  const V = (s, gps, lv, thr) => JSON.parse(B.run('JSON.stringify(siphVerdict_(' + JSON.stringify(s) + ',' + JSON.stringify(gps) + ',' + JSON.stringify(lv) + ',' + thr + ', "L"))'));
  // 968206 le 12/11 : 49 → 43,8 L, la jauge revient à 49 L dès que le véhicule roule
  const a = '2026-11-12T16:15:00Z', b = '2026-11-12T16:28:00Z';
  let r = V(row(a, b, 49, 43.8), still(a, b), [{ t: T(b) + 2 * 60000, v: 44 }, { t: T(b) + 12 * 60000, v: 49 }, { t: T(b) + 30 * 60000, v: 48.5 }], 3);
  assert.strictEqual(r.status, 'Faux positif'); assert.match(r.note, /^Jauge remontée à 49 L 12 min après le redémarrage \(49 L avant l'arrêt\) : véhicule garé en pente/);
  // 968206 le 01/11 : 7 h d'arrêt, véhicule déplacé de 1,9 km à 8-25 km/h : trajet non enregistré
  const a2 = '2026-11-01T03:41:00Z', b2 = '2026-11-01T11:01:00Z';
  r = V(row(a2, b2, 59.5, 50.8), still(a2, b2).concat([{ t: T(a2) + 80 * 60000, lat: 31.6168, lon: -8.0, speed: 25 }]), [{ t: T(b2) + 60000, v: 50.5 }, { t: T(b2) + 600000, v: 50 }], 3);
  assert.strictEqual(r.status, 'Faux positif'); assert.match(r.note, /^Véhicule déplacé pendant l'arrêt \(GPS Geotab : jusqu'à 1,9 km de sa place, vitesse 25 km\/h\) : trajet non enregistré/);
  // perte GPS : aucun point pendant l'arrêt, repart 1,3 km plus loin (premier point après le redémarrage)
  const a3 = '2026-11-10T02:43:00Z', b3 = '2026-11-10T02:51:00Z';
  r = V(row(a3, b3, 55, 50.5), [{ t: T(a3) - 60000, lat: 31.6, lon: -8.0, speed: 0 }, { t: T(b3) + 2 * 60000, lat: 31.612, lon: -8.0, speed: 30 }], [{ t: T(b3) + 60000, v: 50.5 }, { t: T(b3) + 300000, v: 50.5 }], 3);
  assert.strictEqual(r.status, 'Faux positif'); assert.match(r.note, /jusqu'à 1,3 km de sa place/);
  // 968206 nuit du 08/11 : 5 h immobile, 54 → 44 L, la jauge reste à 43 L : à vérifier
  const a4 = '2026-11-07T23:43:00Z', b4 = '2026-11-08T04:41:00Z';
  r = V(row(a4, b4, 54, 44), still(a4, b4), [{ t: T(b4) + 60000, v: 44 }, { t: T(b4) + 20 * 60000, v: 43 }], 3);
  assert.strictEqual(r.status, 'À vérifier'); assert.match(r.note, /^Véhicule immobile pendant l'arrêt \(GPS Geotab\) et jauge restée basse 90 min après le redémarrage \(au plus 44 L, 54 L avant l'arrêt\)/);
  // aucun relevé de jauge après le redémarrage : non mesuré, jamais classé faux positif
  r = V(row(a4, b4, 54, 44), still(a4, b4), [], 3);
  assert.deepStrictEqual(r.status, 'À vérifier'); assert.match(r.note, /jauge non relevée après le redémarrage : non mesuré/);
  // petite dérive GPS sur place (< 300 m, vitesse < 10) : immobile
  r = V(row(a4, b4, 54, 44), still(a4, b4).concat([{ t: T(a4) + 3600000, lat: 31.6012, lon: -8.0, speed: 4 }]), [{ t: T(b4) + 60000, v: 44 }, { t: T(b4) + 600000, v: 44 }], 3);
  assert.strictEqual(r.status, 'À vérifier');
});

test('collecteur : siphonages contrôlés une fois, faux positifs marqués avec la raison, statut saisi jamais écrasé', () => {
  env.resetDb();
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 10, 13, 12, 0));
  const ins = (key, a, b, before, after, st) => `('${key}|${a}|SIPHONAGE_SUSPECT', '${key}', 'W${key}', '${a.slice(0, 10)}', '${a.slice(0, 10)}', 'SIPHONAGE_SUSPECT', '${a}', '${b}', ${before}, ${after}, 'Jauge (L)', 31.6, -8.0, '${st}', true)`;
  env.psql(`insert into vehicles (key, plate, model, active, geotab_id) values ('968206WW', 'WW968206', 'SANTA FE', 'OUI', 'bS6');
    insert into fuel (id, vehicle_key, plate, day, vday, type, stop_start, stop_end, lvl_before, lvl_after, source, lat, lon, status, final) values
      ${ins('968206WW', '2026-11-12T16:15:00Z', '2026-11-12T16:28:00Z', 49, 43.8, 'À vérifier')},
      ${ins('968206WW', '2026-11-12T08:00:00Z', '2026-11-12T13:00:00Z', 54, 44, 'À vérifier')},
      ${ins('968206WW', '2026-11-11T16:15:00Z', '2026-11-11T16:28:00Z', 49, 43.8, 'Vérifié')},
      ${ins('968206WW', '2026-11-13T11:30:00Z', '2026-11-13T11:45:00Z', 49, 43.8, 'À vérifier')};
    insert into levels (id, vehicle_key, at, pct, vday) values
      ('a1', '968206WW', '2026-11-12T16:40:00Z', 49, '2026-11-12'), ('a2', '968206WW', '2026-11-12T16:55:00Z', 48.5, '2026-11-12'),
      ('b1', '968206WW', '2026-11-12T13:05:00Z', 44, '2026-11-12'), ('b2', '968206WW', '2026-11-12T13:30:00Z', 43, '2026-11-12'),
      ('c1', '968206WW', '2026-11-11T16:40:00Z', 49, '2026-11-11'), ('c2', '968206WW', '2026-11-11T16:55:00Z', 48.5, '2026-11-11');
    insert into params (key, value) values ('siphonL', '3'), ('siphonPct', '5') on conflict (key) do update set value = excluded.value;`);
  // positions Geotab : immobile partout
  B.run(`var __calls = 0; geoCall_ = function (m, p) { if (p && p.typeName === 'LogRecord') { __calls++; const a = Date.parse(p.search.fromDate) + 30 * 60000;
    return [{ dateTime: new Date(a - 60000).toISOString(), latitude: 31.6, longitude: -8.0, speed: 0 }, { dateTime: new Date(a + 60000).toISOString(), latitude: 31.6, longitude: -8.0, speed: 0 }]; } return []; }`);
  try {
    assert.match(B.run('siphonCheckStep_()'), /^Siphonages contrôlés : 3, dont 1 faux positif \(/);
    const r = Object.fromEntries(env.psql("select stop_start::text || '=' || status || '|' || coalesce(check_note, '-') from fuel order by stop_start").split('\n').map(l => l.split('=')));
    assert.match(r['2026-11-12 16:15:00+00'], /^Faux positif\|Jauge remontée à 49 L/);
    assert.match(r['2026-11-12 08:00:00+00'], /^À vérifier\|Véhicule immobile pendant l'arrêt \(GPS Geotab\) et jauge restée basse/);
    assert.match(r['2026-11-11 16:15:00+00'], /^Vérifié\|Jauge remontée/, 'statut saisi sur le site gardé, note ajoutée');
    assert.strictEqual(r['2026-11-13 11:30:00+00'], 'À vérifier|-', 'redémarrage trop récent : contrôlé au passage suivant');
    // ligne réécrite par la finalisation (note perdue) : remise depuis la mémoire, sans rappeler Geotab
    const calls = B.run('__calls');
    env.psql("update fuel set check_note = null where stop_start = '2026-11-12T16:15:00Z'");
    B.run('siphonCheckStep_()');
    assert.strictEqual(B.run('__calls'), calls);
    assert.match(env.psql("select check_note from fuel where stop_start = '2026-11-12T16:15:00Z'"), /^Jauge remontée/);
  } finally { env.resetDb(); }
});
