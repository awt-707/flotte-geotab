// Chargeur du collecteur (collé une seule fois dans Apps Script) : charge depuis Supabase la dernière version publiée
// et l'exécute, sans API Google Apps Script. Une nouvelle version publiée est prise en compte au passage suivant.
const test = require('node:test'), assert = require('node:assert'), path = require('path');
const env = require('./lib/env'), { execFileSync } = require('child_process');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
const release = sha => execFileSync(process.execPath, [path.join(env.ROOT, 'scripts', 'publish-collector.js')], { env: Object.assign({}, process.env,
  { SUPABASE_URL: env.POSTGREST, SUPABASE_REST_PATH: '/', SUPABASE_SERVICE_KEY: env.svcKey(), GITHUB_SHA: sha }) }).toString();
let B;

test.before(() => {
  env.resetDb();
  release('aaa1111');
  process.env.CODE = path.join(env.ROOT, 'collector', 'loader', 'Code.gs');
  delete require.cache[require.resolve('./lib/harness_collector.js')];
  B = require('./lib/harness_collector.js');
  B.setNow(NOW);
  Object.assign(B.props, { SUPABASE_URL: env.POSTGREST, SUPABASE_REST_PATH: '/', SUPABASE_KEY: env.svcKey(), GEO_USER: 'a', GEO_PWD: 'secret', IMPORT_DONE: '1' });
});

test('installer depuis le chargeur : connexions OK, collecte programmée', () => {
  const msg = B.run('installer()');
  assert.match(msg, /Supabase : connexion OK/); assert.match(msg, /Geotab : connexion OK/);
  assert.ok(B.triggers.some(t => t.getHandlerFunction() === 'collect'));
  assert.strictEqual(B.props.CODE_VERSION, new Date().toISOString().slice(0, 10) + '.aaa1111');
  assert.match(env.psql("select string_agg(detail, ' | ') from logs"), /collecteur mis à jour : version .*aaa1111/);
});

test('collecte depuis le chargeur : véhicules en direct, aucune tentative de mise à jour par l\'API Apps Script', () => {
  B.run('collect()');
  assert.ok(+env.psql('select count(*) from live_status') > 0);
  assert.strictEqual(B.scriptApi.length, 0);
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur|impossible'"), '');
});

test('nouvelle version publiée : chargée au passage suivant, annoncée une seule fois', () => {
  release('bbb2222');
  B.setNow(NOW + 5 * 60000); B.run('collect()');
  B.setNow(NOW + 10 * 60000); B.run('collect()');
  assert.match(B.props.CODE_VERSION, /bbb2222$/);
  assert.strictEqual(+env.psql("select count(*) from logs where detail like '%version%bbb2222'"), 1);
});
