// Reprise de l'historique de l'ancien Google Sheet v6 (API Sheets simulée à partir du classeur v6) :
// chaque onglet doit arriver complet dans la base, avec les bonnes dates et les statuts saisis à la main.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6, collector } = require('./lib/v6');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
let A, B, cnt, nSheets = 0;

const serial = d => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) + d.getMilliseconds()) / 86400000 + 25569; };

test.before(() => {
  A = sheetV6(NOW);
  A.run("queueSync_(['2026-10-01','2026-10-02','2026-10-03','2026-10-04'], false)");
  A.run('liveRun_(Date.now(), 1e9, { all: true })');   // lignes provisoires (LIVE_*) du 05/10
  A.run("updateDerived_('2026-10-03')");
  const al = A.main.getSheetByName('ALERTES'); al.data[1][10] = 'Faux positif'; al.data[1][11] = 'vu avec le chauffeur';
  cnt = n => { const s = A.main.getSheetByName(n); return s ? s.data.slice(1).filter(r => r.some(v => v !== '')).length : 0; };
  B = collector(NOW, { OLD_SHEET_ID: 'OLD', IMPORT_DONE: '' });
  delete B.props.IMPORT_DONE;
  const orig = B.ctx.UrlFetchApp.fetch;
  B.ctx.UrlFetchApp.fetch = (url, opt) => {
    if (url.indexOf('sheets.googleapis.com') < 0) return orig(url, opt);
    nSheets++;
    if (/fields=properties.timeZone/.test(url)) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ properties: { timeZone: 'Africa/Casablanca' } }) };
    const range = decodeURIComponent(url.split('/values/')[1].split('?')[0]), [name, rg] = range.split('!'), s = A.main.getSheetByName(name);
    if (!s) return { getResponseCode: () => 400, getContentText: () => '{"error":{"message":"Unable to parse range: ' + range + '"}}' };
    let r0, r1; const m = rg.match(/^A?(\d+):[A-Z]*(\d+)$/); if (m) { r0 = +m[1]; r1 = +m[2]; }
    const vals = s.data.slice(r0 - 1, r1).map(r => r.map(v => v instanceof Date ? serial(v) : v));
    while (vals.length && !vals[vals.length - 1].some(v => v !== '')) vals.pop();
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ values: vals }) };
  };
  B.run('installer()');
  for (let i = 0; i < 10 && B.props.IMPORT_STEPS; i++) B.run('collect()');
});

test('reprise terminée', () => {
  assert.ok(!B.props.IMPORT_STEPS, 'étapes restantes');
  assert.strictEqual(B.props.IMPORT_DONE, '1');
  assert.match(env.psql("select detail from logs where action like 'Reprise%' order by id desc limit 1"), /TERMINÉE/);
});

const PAIRS = [['VEHICULES', 'vehicles'], ['CONTRATS', 'contracts'], ['DATA_SYNC', 'vehicle_days'], ['DATA_TRAJETS', 'trips where final'],
  ['LIVE_TRAJETS', 'trips where not final'], ['DATA_EVENEMENTS', 'events where final'], ['LIVE_EVENEMENTS', 'events where not final'], ['DATA_CARBURANT', 'fuel'],
  ['DATA_NIVEAU', 'levels where final'], ['LIVE_NIVEAU', 'levels where not final'], ['DATA_JOURNALIER', 'journal'], ['ALERTES', 'alerts']];
for (const [sheet, table] of PAIRS) {
  test(sheet + ' : toutes les lignes reprises', () => { assert.strictEqual(+env.psql('select count(*) from ' + table), cnt(sheet)); });
}

test('REGLES : toutes les règles reprises (plus celles vues dans les événements)', () => {
  const ids = A.tab('REGLES').map(r => String(r['Règle ID'])), db = env.psql('select id from rules').split('\n');
  assert.deepStrictEqual(ids.filter(id => db.indexOf(id) < 0), []);
});

test('chauffeurs repris', () => { assert.ok(+env.psql('select count(*) from drivers') >= cnt('CHAUFFEURS')); });

test('dates exactes (heure du Maroc) et statut d\'alerte saisi conservé', () => {
  const r = A.main.getSheetByName('DATA_TRAJETS').data[5];
  assert.strictEqual(new Date(env.psql("select start_at from trips where id = '" + r[0] + "'")).getTime(), r[4].getTime());
  assert.strictEqual(env.psql("select status || ' / ' || comment from alerts where status <> 'À traiter'"), 'Faux positif / vu avec le chauffeur');
});

test('la collecte normale reprend ensuite', () => {
  B.run('collect()');
  assert.doesNotMatch(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where action = 'Collecte'"), /Erreur/);
});
