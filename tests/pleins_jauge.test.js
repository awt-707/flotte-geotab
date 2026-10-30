// Pleins vus par la jauge (18_fills.gs, gaugeFills_) : Geotab ne publie jamais son FillUp (968200WW le 19/10/2026 : jauge 8 % → 98 %, aucun FillUp).
// Jeu réel (deux pleins le 03/10 vers 20:00 et 20:30, heure du Maroc), FillUp cachés : le plein doit rester visible, y compris après la finalisation.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6');
const L = (d, h, m) => Date.UTC(2026, 9, d, h, m || 0) - env.maOff(Date.UTC(2026, 9, d, h, m || 0)) * 60000;   // heure du Maroc -> UTC
const rows = () => JSON.parse(env.psql("select coalesce(json_agg(t order by t.id), '[]') from (select id, vehicle_key, stop_start, lvl_before, lvl_after, liters_gauge, liters_geotab, source, driver_code, final, status from fuel where type = 'PLEIN' and day = '2026-10-03') t"));
let night, final, again;

test.before(() => {
  global.__FILL_DELAY_MS = 1000 * 3600000;   // FillUp jamais publiés
  const A = sheetV6(L(4, 13, 30));
  const B = collector(L(3, 19, 0));
  B.run('installer()');
  copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-10-01' }])");
  for (let t = L(3, 19, 0); t <= L(4, 14, 0); t += 5 * 60000) {
    B.setNow(t); B.run('collect()');
    if (t === L(4, 4, 0)) night = rows();
  }
  final = rows();
  // statut saisi sur le site : jamais écrasé par le passage suivant
  env.psql("update fuel set status = 'Vérifié' where id like '%|PLEIN_JAUGE'");
  B.setNow(L(4, 14, 5)); B.run('collect()');
  again = rows();
  global.__FILL_DELAY_MS = 0;
});

test('sans FillUp Geotab : pleins vus par la jauge, litres non mesurés, chauffeur rattaché', () => {
  assert.ok(night.length >= 1, 'pleins du 03/10 à 04:00 : ' + JSON.stringify(night));
  night.forEach(f => {
    assert.ok(/\|PLEIN_JAUGE$/.test(f.id) && /Jauge/.test(f.source) && !f.final, JSON.stringify(f));
    assert.strictEqual(f.liters_gauge, null); assert.strictEqual(f.liters_geotab, null);
    assert.ok(f.lvl_after - f.lvl_before >= 20 && f.driver_code, JSON.stringify(f));
  });
  assert.strictEqual(new Set(night.map(f => f.vehicle_key)).size, night.length, 'un plein par montée de jauge');
});

test('après la finalisation : les pleins de la jauge restent (lignes finalisées), statut gardé', () => {
  assert.ok(+env.psql("select count(*) from vehicle_days where day = '2026-10-03'") > 0, 'journée du 03/10 finalisée');
  assert.deepStrictEqual(final.map(f => f.id), night.map(f => f.id));
  final.forEach(f => assert.ok(f.final, 'finalisé ' + f.id));
  assert.ok(again.length === final.length && again.every(f => f.status === 'Vérifié'), JSON.stringify(again));
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur|Pleins'"), '');
  // le journal compte les pleins vus par la jauge
  assert.ok(+env.psql("select coalesce(sum(n_fills), 0) from journal where day = '2026-10-03'") >= night.length);
});
