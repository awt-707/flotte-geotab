// Mise à jour automatique du collecteur à partir de la dernière version publiée (table releases)
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), { collector } = require('./lib/v6');
const NOW = Date.UTC(2026, 9, 6, 9, 0), TODAY = new Date().toISOString().slice(0, 10);
const { execFileSync } = require('child_process');
// Publication avec le vrai script de GitHub Actions
const release = sha => execFileSync(process.execPath, [path.join(env.ROOT, 'scripts', 'publish-collector.js')], { env: Object.assign({}, process.env,
  { SUPABASE_URL: env.POSTGREST, SUPABASE_REST_PATH: '/', SUPABASE_SERVICE_KEY: env.svcKey(), GITHUB_SHA: sha }) }).toString();
const files = () => fs.readdirSync(path.join(env.ROOT, 'collector', 'src')).map(f => ({ name: f.replace(/\.(gs|json)$/, ''), type: f.endsWith('.json') ? 'JSON' : 'SERVER_JS',
  source: fs.readFileSync(path.join(env.ROOT, 'collector', 'src', f), 'utf8') }));
const publish = (sha, fl) => env.psql("insert into releases (version, sha, files) values ('2026-10-15." + sha + "', '" + sha + "', '" + JSON.stringify(fl).replace(/'/g, "''") + "'::jsonb)");
let B;
test.before(() => { B = collector(NOW); B.run('installer()'); env.psql('truncate releases restart identity'); });

test('sans nouvelle version : rien ne change', () => {
  B.run('collect()');
  assert.strictEqual(B.scriptApi.length, 0);
});

test('nouvelle version publiée : le collecteur remplace son code, une seule fois', () => {
  assert.match(release('abc1234'), /Collecteur publié : version .*\.abc1234 \(11 fichiers\)/);
  B.setNow(NOW + 5 * 60000); B.run('collect()');
  assert.strictEqual(B.scriptApi.length, 1);
  const call = B.scriptApi[0], body = JSON.parse(call.opt.payload);
  assert.match(call.url, /projects\/SCRIPT_ID\/content$/);
  assert.strictEqual(call.opt.method, 'put');
  assert.ok(body.files.some(f => f.name === 'appsscript' && f.type === 'JSON'));
  assert.ok(body.files.some(f => f.name === '30_run' && /function collect\(\)/.test(f.source)));
  assert.ok(body.files.some(f => f.name === '60_report' && /function rptBuild/.test(f.source)), 'calcul des rapports (site/report.js) publié avec le collecteur');
  assert.strictEqual(B.props.CODE_SHA, 'abc1234');
  assert.match(env.psql("select detail from logs where action = 'Collecte' order by id desc limit 1"), new RegExp('collecteur mis à jour : version ' + TODAY + '\\.abc1234'));
  B.setNow(NOW + 10 * 60000); B.run('collect()');
  assert.strictEqual(B.scriptApi.length, 1, 'pas de deuxième mise à jour pour la même version');
});

test('version incomplète : ignorée, signalée une seule fois par jour, la collecte continue', () => {
  publish('bad0001', [{ name: 'x', type: 'SERVER_JS', source: '// vide' }]);
  B.setNow(NOW + 15 * 60000); B.run('collect()'); B.setNow(NOW + 20 * 60000); B.run('collect()');
  assert.strictEqual(B.scriptApi.length, 1);
  assert.strictEqual(B.props.CODE_SHA, 'abc1234');
  assert.strictEqual(+env.psql("select count(*) from logs where detail like '%incomplète%'"), 1);
  assert.strictEqual(+env.psql("select count(*) from live_status"), 2, 'la collecte a continué');
});

test('API Apps Script désactivée : message clair pour l\'activer', () => {
  release('def5678');
  B.props.UPDATE_ERR_DAY = '';
  B.setScriptApiReply(() => ({ getResponseCode: () => 403, getContentText: () => '{"error":{"message":"User has not enabled the Apps Script API."}}' }));
  B.setNow(NOW + 25 * 60000); B.run('collect()');
  assert.match(env.psql("select detail from logs where action = 'Collecte' order by id desc limit 1"), /activez « API Google Apps Script »/);
  assert.strictEqual(B.props.CODE_SHA, 'abc1234');
});
