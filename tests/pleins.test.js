// Pleins : Geotab calcule ses FillUp après coup (ici 6 h après le plein, au-delà des 3 h que la collecte en direct relit). La collecte en direct doit les relire
// à chaque passage, sans attendre la finalisation de la journée (le lendemain vers 13 h).
// Jeu réel : deux pleins le 03/10 vers 20:00 et 20:30 (heure du Maroc).
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6');
const L = (d, h, m) => Date.UTC(2026, 9, d, h, m || 0) - env.maOff(Date.UTC(2026, 9, d, h, m || 0)) * 60000;   // heure du Maroc -> UTC
const fillsOf = () => JSON.parse(env.psql("select coalesce(json_agg(t order by t.id), '[]') from (select id, stop_start, lvl_before, lvl_after, liters_gauge, liters_geotab, driver_code, final from fuel where type = 'PLEIN' and day = '2026-10-03') t"));
let refN, night, final;

test.before(() => {
  global.__FILL_DELAY_MS = 6 * 3600000;
  const A = sheetV6(L(4, 13, 30));
  A.run("queueSync_(['2026-10-03'], false)");
  refN = A.tab('DATA_CARBURANT').filter(r => r['Type'] === 'PLEIN' && A.day(r['Arrêt début']) === '2026-10-03').length;
  const B = collector(L(3, 19, 0));
  B.run('installer()');
  copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-10-01' }])");
  for (let t = L(3, 19, 0); t <= L(4, 13, 30); t += 5 * 60000) {
    B.setNow(t); B.run('collect()');
    if (t === L(4, 4, 0)) night = fillsOf();
  }
  final = fillsOf();
  global.__FILL_DELAY_MS = 0;
});

test('pleins calculés par Geotab après coup : visibles dans la nuit, sans attendre la finalisation', () => {
  assert.ok(refN >= 2, 'pleins de référence du 03/10 : ' + refN);
  assert.strictEqual(night.length, refN, 'pleins du 03/10 présents à 04:00');
  assert.ok(night.every(f => !f.final), 'lignes provisoires avant la finalisation');
});

test('après la finalisation : mêmes pleins, mêmes valeurs', () => {
  assert.strictEqual(final.length, refN);
  const fin = Object.fromEntries(final.map(f => [f.id, f]));
  night.forEach(f => { const g = fin[f.id]; assert.ok(g && g.final, 'plein finalisé ' + f.id);
    ['lvl_before', 'lvl_after', 'liters_gauge', 'liters_geotab', 'driver_code'].forEach(k => assert.strictEqual(g[k], f[k], k + ' ' + f.id)); });
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur|Pleins :'"), '');
});
