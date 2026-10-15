// Le collecteur (base Supabase) doit produire exactement les mêmes résultats que le Google Sheet v6,
// sur les vraies données Geotab de la base clicar (26/09 au 06/10/2026) et les contrats du 01 au 06/10.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6'), { compareRows, fmt } = require('./lib/compare');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
let A, B, ref;

test.before(() => {
  A = sheetV6(NOW);
  A.run("queueSync_(['2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04'], false)");
  A.run("updateDerived_('2026-10-02')");
  ref = { trips: A.tab('DATA_TRAJETS'), events: A.tab('DATA_EVENEMENTS'), fuel: A.tab('DATA_CARBURANT'), idles: A.tab('DATA_RALENTI'),
    levels: A.tab('DATA_NIVEAU'), jrn: A.tab('DATA_JOURNALIER'), alerts: A.tab('ALERTES'), drv: A.tab('CHAUFFEURS') };
  B = collector(NOW);
  const msg = B.run('installer()');
  assert.match(msg, /Supabase : connexion OK/); assert.match(msg, /Geotab : connexion OK/);
  copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-09-29' }])");
  B.run('collect()');
  for (let i = 0; i < 3; i++) { B.setNow(NOW + (i + 1) * 5 * 60000); B.run('collect()'); }
});

const inDays = (A, t, d1, d2) => { const d = A.day(t); return d >= d1 && d <= d2; };
const dbRows = (table, where) => JSON.parse(env.psql(`select coalesce(json_agg(t), '[]') from (select * from ${table} where ${where}) t`));
const cols = k => JSON.parse(B.run('JSON.stringify(DB.' + k + '.cols)')), heads = k => JSON.parse(A.run('JSON.stringify(H.' + k + ')'));
const DAYS = "vday between '2026-10-01' and '2026-10-04'";

for (const [name, table, k, tcol] of [['trajets', 'trips', 'TRIP', 'Début'], ['événements', 'events', 'EVT', 'Début'], ['carburant', 'fuel', 'FUEL', 'Arrêt début'],
  ['ralentis', 'idles', 'IDL', 'Début'], ['jauge', 'levels', 'LVL', 'Horodatage']]) {
  test(name + ' identiques au Sheet v6 (journées finalisées 01-04/10)', () => {
    const R = ref[table].filter(r => inDays(A, r[tcol], '2026-10-01', '2026-10-04'));
    const c = compareRows(R, dbRows(table, DAYS), heads(k), cols(k), { dayCol: 'Date', day: a => A.day(a) });
    if (name !== 'ralentis') assert.ok(R.length > 0, 'référence vide');   // aucun ralenti prolongé ces jours-là dans les données réelles
    assert.ok(c.diff.length === 0 && c.miss === 0 && c.extra === 0, fmt(name, c));
  });
}

test('journal des journées de travail identique (01-03/10)', () => {
  const R = ref.jrn.filter(r => inDays(A, r['Date'], '2026-10-01', '2026-10-03'));
  const c = compareRows(R, dbRows('journal', "day between '2026-10-01' and '2026-10-03'"), heads('JRN'), cols('JRN'), { dayCol: 'Date', day: a => A.day(a) });
  assert.ok(R.length > 0);
  assert.ok(c.diff.length === 0 && c.miss === 0 && c.extra === 0, fmt('journal', c));
});

test('alertes identiques (01-03/10)', () => {
  const R = ref.alerts.filter(r => inDays(A, r['Date'], '2026-10-01', '2026-10-03'));
  const m = {}; dbRows('alerts', "day between '2026-10-01' and '2026-10-03'").forEach(r => { m[r.id] = r; });
  const bad = R.filter(r => !m[r['Clé']] || m[r['Clé']].detail !== r['Détail'] || m[r['Clé']].severity !== r['Gravité'] || m[r['Clé']].type !== r['Type'])
    .map(r => r['Clé'] + ' : ' + r['Détail'] + ' ≠ ' + (m[r['Clé']] ? m[r['Clé']].detail : 'absente'));
  assert.ok(R.length > 0);
  assert.deepStrictEqual(bad, []);
  assert.strictEqual(Object.keys(m).length, R.length, 'alertes en trop dans la base');
});

test('chauffeurs : même nombre que le Sheet', () => {
  assert.strictEqual(+env.psql('select count(*) from drivers'), ref.drv.length);
});

test('page « En direct » alimentée pour chaque véhicule actif', () => {
  const live = dbRows('live_status', 'true');
  assert.strictEqual(live.length, +env.psql("select count(*) from vehicles where coalesce(active, 'OUI') <> 'NON'"));
  live.forEach(v => assert.ok(v.state && v.updated_at, v.plate));
});

test('demandes du site traitées et aucune erreur dans le journal technique', () => {
  assert.strictEqual(+env.psql('select count(*) from jobs where done_at is null'), 0);
  assert.doesNotMatch(env.psql("select coalesce(string_agg(result, ' | '), '') from jobs"), /Erreur/);
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur'"), '');
});
