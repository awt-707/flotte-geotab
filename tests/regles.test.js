// Règles Geotab : une flotte réelle en a des dizaines ; la synchronisation ne doit pas dépasser la longueur d'URL de Google (2 Ko)
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6');

test('synchronisation des règles avec beaucoup de règles en base : pas d\'erreur, anciennes règles conservées', () => {
  const B = collector(Date.UTC(2026, 9, 6, 9, 0)); B.run('installer()');
  const ids = Array.from({ length: 120 }, (_, i) => 'aAncienneRegleGeotabTresLongue' + i);
  env.psql('insert into rules (id, name, weight, category) values ' + ids.map(id => `('${id}', 'Ancienne', 0, 'Autre')`).join(','));
  B.run('syncRules_()');
  assert.strictEqual(env.psql("select count(*) from rules where id like 'aAncienneRegle%'"), '120', 'anciennes règles conservées (comme le v6 : des événements y renvoient)');
  assert.ok(+env.psql('select count(*) from rules') > 0);
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'Longueur d''URL|erreur'"), '');
});
