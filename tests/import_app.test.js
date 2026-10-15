// Reprise de l'historique de l'ancien Google Sheet quand l'API Google Sheets n'est pas activée (lecture directe du classeur) :
// chaque onglet doit arriver complet dans la base, avec les bonnes dates et les statuts saisis à la main.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6, collector } = require('./lib/v6');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
let A, B, cnt, nApi = 0;


test.before(() => {
  A = sheetV6(NOW);
  A.run("queueSync_(['2026-10-01','2026-10-02','2026-10-03','2026-10-04'], false)");
  A.run('liveRun_(Date.now(), 1e9, { all: true })');
  A.run("updateDerived_('2026-10-03')");
  const al = A.main.getSheetByName('ALERTES'); al.data[1][10] = 'Faux positif'; al.data[1][11] = 'vu avec le chauffeur';
  cnt = n => { const s = A.main.getSheetByName(n); return s ? s.data.slice(1).filter(r => r.some(v => v !== '')).length : 0; };
  B = collector(NOW, { OLD_SHEET_ID: 'OLD', IMPORT_DONE: '' });
  delete B.props.IMPORT_DONE;
  // API Google Sheets désactivée dans le projet caché du script (cas réel de production) : réponse 403
  const orig = B.ctx.UrlFetchApp.fetch;
  B.ctx.UrlFetchApp.fetch = (url, opt) => {
    if (url.indexOf('sheets.googleapis.com') < 0) return orig(url, opt);
    nApi++;
    return { getResponseCode: () => 403, getContentText: () => '{"error":{"code":403,"message":"Google Sheets API has not been used in project 61797522361 before or it is disabled.","status":"PERMISSION_DENIED"}}' };
  };
  // Lecture directe du classeur (SpreadsheetApp) : dates rendues dans le contexte du collecteur
  const conv = v => Object.prototype.toString.call(v) === '[object Date]' ? new B.ctx.Date(v.getTime()) : v;
  B.books.OLD = { getSpreadsheetTimeZone: () => 'Africa/Casablanca', getSheetByName: n => { const s = A.main.getSheetByName(n); if (!s) return null;
    return { getLastRow: () => s.getLastRow(), getLastColumn: () => s.getLastColumn(), getRange: (r, c, nr, nc) => ({ getValues: () => s.getRange(r, c, nr, nc).getValues().map(row => row.map(conv)) }) }; } };
  B.run('installer()');
  for (let i = 0; i < 10 && B.props.IMPORT_STEPS; i++) B.run('collect()');
});

test('API Sheets désactivée : lecture directe du classeur, signalée une fois', () => {
  assert.strictEqual(B.props.SHEETS_VIA_APP, '1');
  assert.ok(nApi >= 1);
  assert.strictEqual(+env.psql("select count(*) from logs where detail like 'API Google Sheets non activée%'"), 1);
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
