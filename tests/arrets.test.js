// Arrêts moteur tournant (3 min et plus) : calculés à côté du moteur v6, sur les vraies données Geotab.
// Litres = compteur ralenti Geotab encadrant l'arrêt, sinon vide ; ceinture conducteur ; rien d'estimé.
const test = require('node:test'), assert = require('node:assert'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), { collector } = require('./lib/v6');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'geotab_2026-09-26_10-06.json.gz'))));
const ser = (name, diag) => { const id = fx.devices.find(d => d.name === name).id, m = {};
  fx.data.filter(w => w.id === id).forEach(w => (w.sd[diag] || []).forEach(x => { m[Date.parse(x[0])] = +x[1]; }));
  return Object.keys(m).map(Number).sort((a, b) => a - b).map(t => ({ t, v: m[t] })); };
let B, rows;

test.before(() => {
  B = collector(NOW); B.run('installer()');
  B.run("sbReq_('post', 'jobs', [{ kind: 'resync', arg: '2026-09-27|2026-10-04' }])");
  for (let i = 0; i < 6; i++) { B.setNow(NOW + i * 5 * 60000); B.run('collect()'); }
  rows = JSON.parse(env.psql("select coalesce(json_agg(t order by start_at), '[]') from engine_stops t"));
});

test('arrêts de 3 min et plus : véhicule immobile, moteur tournant, d\'après les données brutes Geotab', () => {
  assert.ok(rows.length >= 10, rows.length + ' arrêts');
  rows.forEach(r => {
    const a = Date.parse(r.start_at), b = Date.parse(r.end_at), name = r.plate.replace(/^WW(\d+)$/, '$1WW');
    assert.ok(r.dur_min >= 3 && Math.abs(r.dur_min - (b - a) / 60000) < 0.06, r.id);
    assert.ok(r.final, 'journée finalisée');
    const rpm = ser(name, 'DiagnosticEngineSpeedId'), spd = ser(name, 'DiagnosticEngineRoadSpeedId');
    const at = (s, t) => s.filter(p => p.t <= t).pop();
    for (const t of [a, ...rpm.concat(spd).map(p => p.t).filter(t => t > a && t < b)]) {
      assert.ok(at(spd, t).v < 2, r.id + ' : véhicule en mouvement à ' + new Date(t).toISOString());
      assert.ok(at(rpm, t).v > 300, r.id + ' : moteur arrêté à ' + new Date(t).toISOString());
    }
  });
});

test('litres : différence réelle du compteur ralenti Geotab, sinon non mesuré', () => {
  const m = rows.filter(r => r.liters !== null);
  assert.ok(m.length >= 1 && m.length < rows.length, m.length + ' mesurés sur ' + rows.length);
  m.forEach(r => {
    const s = ser(r.plate.replace(/^WW(\d+)$/, '$1WW'), 'DiagnosticDeviceTotalIdleFuelId'), a = Date.parse(r.start_at), b = Date.parse(r.end_at);
    const v1 = s.filter(p => p.t <= a + 30000).pop(), v2 = s.find(p => p.t >= b - 30000);
    assert.strictEqual(Math.round(r.liters * 100), Math.round((v2.v - v1.v) * 100), r.id);
    assert.strictEqual(r.liters_source, 'Compteur ralenti Geotab');
  });
  rows.filter(r => r.liters === null).forEach(r => { assert.match(r.liters_source, /^Non mesuré : /); assert.strictEqual(r.lph, null); });
});

test('chauffeur et contrat rattachés comme les autres données', () => {
  rows.forEach(r => assert.ok(r.driver_code, r.id));
});

test('compteur encadrant l\'arrêt, ceinture conducteur, autre ralenti entre les relevés', () => {
  const res = JSON.parse(B.run(`(function () {
    const T = 1759300000000, M = 60000, P = { engStopMin: 3 };
    const S = { idleFuel: [{ t: T - 20 * M, v: 10 }, { t: T + 15 * M, v: 10.25 }], belt: [{ t: T - 30 * M, v: 0 }, { t: T + 6 * M, v: 1 }] };
    const c = { a: T - 30 * M, b: T + 15 * M, open: false }, self = { a: T, b: T + 10 * M };
    const ok = cEngStops_(S, [], c, { segs: [{ a: T - 15 * M, b: T - 14.5 * M }, self] }, null, null, P)[0];
    const far = cEngStops_(S, [], c, { segs: [{ a: T - 15 * M, b: T - 12.5 * M }, self] }, null, null, P)[0];
    const short = cEngStops_(S, [], c, { segs: [{ a: T, b: T + 2.9 * M }] }, null, null, P);
    return JSON.stringify({ ok, far, short });
  })()`));
  assert.strictEqual(res.ok.liters, 0.25); assert.strictEqual(res.ok.extra, 0.5); assert.strictEqual(Math.round(res.ok.lph * 1000), Math.round(0.25 / (10.5 / 60) * 1000));
  assert.strictEqual(res.ok.beltOn, 6); assert.strictEqual(res.ok.beltOff, 4);
  assert.strictEqual(res.far.liters, null); assert.match(res.far.src, /2.5 min d'autre ralenti/);
  assert.deepStrictEqual(res.short, []);
});

test('moteur v6 inchangé : aucune erreur, ralentis prolongés toujours séparés', () => {
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur'"), '');
  assert.strictEqual(+env.psql('select count(*) from idles'), rows.filter(r => r.dur_min >= 10).length);
});

test('migration des arrêts pas encore exécutée : la collecte continue, consigne affichée une fois', () => {
  const mig = fs.readFileSync(path.join(env.ROOT, 'supabase', 'migrations', '20261017000000_arrets_moteur.sql'), 'utf8');
  env.psql("drop function public.finalize_vdays(text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb); drop table public.engine_stops; notify pgrst, 'reload schema'");
  try {
    execSleep(1500);
    env.psql("delete from logs; delete from vehicle_days where day = '2026-10-04'; delete from trips where vday = '2026-10-04'");
    B.run("sbReq_('post', 'jobs', [{ kind: 'resync', arg: '2026-10-04|2026-10-04' }])");
    for (let i = 0; i < 3; i++) { B.setNow(NOW + (10 + i) * 5 * 60000); B.run('collect()'); }
    assert.ok(+env.psql("select count(*) from trips where vday = '2026-10-04' and final") > 0, 'journée non finalisée');
    assert.strictEqual(env.psql("select count(*) from logs where detail ~ 'exécuter supabase/migrations/20261017000000'"), '1');
    assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur'"), '');
  } finally {
    // migration rejouée, puis les suivantes (rejouables) : elles redéfinissent certaines de ses fonctions (rekey_vehicle…)
    const dir = path.join(env.ROOT, 'supabase', 'migrations'), later = fs.readdirSync(dir).filter(f => f > '20261017000000_arrets_moteur.sql' && f.endsWith('.sql')).sort();
    env.psql([mig].concat(later.map(f => fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n') + "\nnotify pgrst, 'reload schema';"); execSleep(1500);
  }
});
function execSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
