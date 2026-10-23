// Étude ponctuelle de consommation dans Geotab, hors parc Ludy (collector/src/56_study.gs) : véhicules trouvés par modèle / nom,
// km et litres = compteurs Geotab au début et à la fin de la période, moyenne pondérée (litres / km) et moyenne simple
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');

test('étude Geotab : L/100 des véhicules trouvés sur la période, une seule fois, résultat dans le param geoStudy', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 9, 4, 12, 0));
  B.run(`GEO_STUDY_ = { id: 'essai', label: 'Staria 968199', match: /968199/, days: 1, max: 20 }`);
  assert.match(B.run('geoStudyStep_(Date.now())'), /Étude Staria 968199 : 1 véhicules/);
  const r = JSON.parse(env.psql("select value from params where key = 'geoStudy'"));
  assert.strictEqual(r.found, 1); assert.strictEqual(r.vehicles.length, 1);
  // mêmes compteurs que Geotab : début = 03/10 00:00, fin = 04/10 00:00 (heure du Maroc, UTC+1)
  const id = B.run(`(geoCall_('Get', { typeName: 'Device' }) || []).filter(d => /968199/.test(d.name))[0].id`);
  const G = (diag, t) => B.run(`(function () { const p = (geoCall_('Get', { typeName: 'StatusData', search: { deviceSearch: { id: '${id}' }, diagnosticSearch: { id: '${diag}' }, fromDate: '${t}', toDate: '${t}' } }) || []).slice(-1)[0]; return p ? +p.data : null; })()`);
  const a = '2026-10-02T23:00:00.000Z', b = '2026-10-03T23:00:00.000Z';
  assert.strictEqual(r.from, a); assert.strictEqual(r.to, b);
  assert.ok(G('DiagnosticOdometerId', a) != null && G('DiagnosticDeviceTotalFuelId', b) != null, 'compteurs présents dans le faux Geotab');
  const km = Math.round((G('DiagnosticOdometerId', b) - G('DiagnosticOdometerId', a)) / 100) / 10, l = Math.round((G('DiagnosticDeviceTotalFuelId', b) - G('DiagnosticDeviceTotalFuelId', a)) * 10) / 10;
  const v = r.vehicles[0];
  assert.strictEqual(v.km, km); assert.strictEqual(v.l, l);
  if (km >= 10) { assert.strictEqual(v.l100, Math.round(l / km * 1000) / 10); assert.strictEqual(r.avg_weighted, v.l100); assert.strictEqual(r.avg_simple, v.l100); }
  else assert.strictEqual(v.l100, null);
  // une seule fois
  assert.strictEqual(B.run('geoStudyStep_(Date.now())'), '');
});
