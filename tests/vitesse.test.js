// Dépassement de vitesse : seuil d'alerte réglable par limite de route (Réglages). Calcul à côté du moteur v6 (19_speed.gs),
// vérifié sur les vraies données Geotab : plus gros dépassement par limite de chaque trajet, alertes selon les seuils.
const test = require('node:test'), assert = require('node:assert'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), { collector } = require('./lib/v6'), rpt = require('../site/report.js');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'geotab_2026-09-26_10-06.json.gz'))));
const devOf = key => fx.devices.find(d => d.name === key).id;
const ser = (key, diag) => { const id = devOf(key), m = {}; fx.data.filter(w => w.id === id).forEach(w => (w.sd[diag] || []).forEach(x => { m[Date.parse(x[0])] = +x[1]; }));
  return Object.keys(m).map(Number).sort((a, b) => a - b).map(t => ({ t, v: m[t] })); };
const roadOf = key => { const id = devOf(key), m = {}; fx.data.filter(w => w.id === id).forEach(w => (w.road || []).forEach(x => { m[Date.parse(x[0])] = +x[1]; }));
  return Object.keys(m).map(Number).sort((a, b) => a - b).map(t => ({ t, v: m[t] })); };
let B, trips;

test.before(() => {
  B = collector(NOW); B.run('installer()');
  B.run("sbReq_('post', 'jobs', [{ kind: 'resync', arg: '2026-09-29|2026-10-04' }])");
  for (let i = 0; i < 6; i++) { B.setNow(NOW + i * 5 * 60000); B.run('collect()'); }
  trips = JSON.parse(env.psql("select coalesce(json_agg(t order by start_at), '[]') from trips t where day between '2026-09-29' and '2026-10-04' and final"));
});

test('seuil par limite : ligne de la limite, sinon limite inférieure la plus proche, sinon seuil général', () => {
  const P = { overAlert: 30, overByLimit: '50:30; 80:20;120:15' };
  assert.strictEqual(rpt.rptOverTol(P, 50), 30); assert.strictEqual(rpt.rptOverTol(P, 60), 30); assert.strictEqual(rpt.rptOverTol(P, 80), 20);
  assert.strictEqual(rpt.rptOverTol(P, 100), 20); assert.strictEqual(rpt.rptOverTol(P, 120), 15); assert.strictEqual(rpt.rptOverTol(P, 40), 30);
  assert.strictEqual(rpt.rptOverTol({ overAlert: 25, overByLimit: '' }, 120), 25);
  // le dépassement qui compte est celui qui dépasse le plus SON seuil, pas le plus gros dépassement
  const t = { over_by_limit: JSON.stringify({ 50: [28, 78, 1], 120: [18, 138, 2] }) };
  assert.deepStrictEqual(rpt.rptOverWorst(t, P), { lim: 120, ex: 18, v: 138, t: 2, tol: 15 });
  assert.ok(rpt.rptOverHit(t, P)); assert.ok(!rpt.rptOverHit(t, { overAlert: 30, overByLimit: '' }), 'règle du v6 : +28 < 30');
});

test('plus gros dépassement par limite de chaque trajet, d\'après les relevés bruts Geotab (vitesse du capteur, limite de la route)', () => {
  const withL = trips.filter(t => t.over_by_limit);
  assert.ok(withL.length > 20, withL.length + ' trajets avec limites');
  let n = 0;
  withL.forEach(t => {
    const key = t.vehicle_key, a = Date.parse(t.start_at), b = Date.parse(t.end_at), spd = ser(key, 'DiagnosticEngineRoadSpeedId').filter(p => p.t >= a && p.t <= b), road = roadOf(key);
    const lim = tt => road.filter(p => p.t <= tt && p.t >= a - 60000).pop();
    const exp = {};
    for (let i = 0; i + 1 < spd.length; i++) { const s = Math.min(spd[i].v, spd[i + 1].v); if (s < 30) continue;
      const lp = lim(spd[i].t), lq = lim(spd[i + 1].t); if (!(lp && lq && lp.v > 0 && lp.v === lq.v)) continue;
      const k = String(lp.v), ex = s - lp.v; if (!exp[k] || ex > exp[k][0]) exp[k] = [Math.round(ex), Math.round(s), spd[i].t]; }
    assert.deepStrictEqual(JSON.parse(t.over_by_limit), exp, t.id);
    // cohérent avec le « pire dépassement » du v6
    assert.strictEqual(Math.max(...Object.values(exp).map(x => x[0])), t.worst_over, t.id); n++;
  });
  assert.ok(n > 20);
});

test('alertes « Dépassement limite » selon les seuils réglés, recalculées sans retélécharger', () => {
  const day = "day between '2026-09-30' and '2026-10-04'";
  const dep = () => env.psql(`select coalesce(string_agg(id, ',' order by id), '') from alerts where type = 'Dépassement limite' and ${day}`).split(',').filter(Boolean);
  const v6 = dep();
  const ref = trips.filter(t => t.day >= '2026-09-30' && t.worst_over !== null && t.worst_over >= 30).map(t => 'DEP|' + t.id).sort();
  assert.deepStrictEqual(v6, ref, 'sans seuils par limite : règle du v6 (pire dépassement ≥ 30)');
  const P = { overAlert: 30, overByLimit: '30:5;50:12;60:15;80:10;100:8;120:5' };
  env.psql(`update params set value = '${P.overByLimit}' where key = 'overByLimit'`);
  try {
    B.run("memoClear_(); jobRecompute_('2026-09-29')");
    const exp = trips.filter(t => t.day >= '2026-09-30' && rpt.rptOverHit(t, P)).map(t => 'DEP|' + t.id).sort();
    assert.ok(exp.length > v6.length, exp.length + ' alertes attendues');
    assert.deepStrictEqual(dep(), exp);
    const t = trips.find(x => 'DEP|' + x.id === exp[0]), w = rpt.rptOverWorst(t, P);
    const det = env.psql(`select detail || ' | ' || value from alerts where id = '${exp[0]}'`);
    assert.match(det, new RegExp('^' + w.v + ' km/h pour ' + w.lim + ' km/h autorisés \\(seuil d\'alerte \\+' + w.tol + ' km/h, soit ' + (w.lim + w.tol) + ' km/h\\) à \\d{2}:\\d{2} \\| \\+' + w.ex + ' km/h$'));
  } finally { env.psql("update params set value = '' where key = 'overByLimit'"); B.run("memoClear_(); jobRecompute_('2026-09-29')"); }
  assert.deepStrictEqual(dep(), v6, 'seuils vidés : retour à la règle du v6');
});

test('fiche d\'alerte : pire dépassement sur tout l\'événement, pas seulement à l\'instant de la vitesse max (cas réel 86122-T-1 du 22/10)', () => {
  const L = require('../site/lib.js'), t = Date.UTC(2026, 9, 22, 8, 52, 0);
  // limite Geotab : 100, puis 80, puis 120 quelques secondes (route voisine ?), puis 80
  const road = [[t - 120000, 100], [t, 80], [t + 7000, 120], [t + 11000, 80]];
  const spd = [[t - 5000, 100], [t + 4000, 104], [t + 8000, 106], [t + 20000, 90]];
  assert.strictEqual(L.limitAt(road, t + 8000), 120);   // à l'instant de la vitesse max : 106 sous 120
  assert.deepStrictEqual(L.worstOver(spd, road), { t: t + 4000, v: 104, lim: 80, over: 24 });
  assert.strictEqual(L.worstOver(spd, [[t - 120000, -1]]), null);   // limite inconnue : rien d'inventé
});
