// Heure du Maroc : le site affiche les heures avec les règles du collecteur (Google), pas avec la table des fuseaux du navigateur
// (certains navigateurs mettent encore le Maroc à UTC+1 alors que le collecteur compte en UTC+0 : décalage d'une heure).
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6'), lib = require('../site/lib.js');
const NOW = Date.UTC(2026, 9, 6, 9, 0);

test('règles horaires publiées par le collecteur, identiques à son propre fuseau, à la minute près', () => {
  const B = collector(NOW); B.run('installer()');
  const rules = JSON.parse(env.psql("select value from params where key = 'tzRules'"));
  assert.ok(rules.length >= 1 && rules[0][0] <= NOW - 1000 * 86400000);
  const off = t => +B.run('tzOffsetMin_(new Date(' + t + '))');
  lib.setTzRules(rules);
  for (let t = rules[0][0]; t < NOW + 300 * 86400000; t += 3 * 86400000 + 3600000) {
    assert.strictEqual(lib.tzOffsetMin(new Date(t)), off(t), new Date(t).toISOString());
  }
  rules.slice(1).forEach(([t, o]) => { assert.strictEqual(off(t), o); assert.notStrictEqual(off(t - 60000), o, 'changement d\'heure à la minute'); });
});

test('le site suit les règles du collecteur, quel que soit le navigateur', () => {
  const t = '2026-10-14T23:07:00Z';
  lib.setTzRules(JSON.stringify([[0, 0]]));
  assert.strictEqual(lib.localHM(t), '23:07'); assert.strictEqual(lib.localDay(t), '2026-10-14');
  assert.strictEqual(lib.dayBounds('2026-10-14').start.toISOString(), '2026-10-14T00:00:00.000Z');
  lib.setTzRules([[0, 60]]);
  assert.strictEqual(lib.localHM(t), '00:07'); assert.strictEqual(lib.localDay(t), '2026-10-15');
  assert.strictEqual(lib.dayBounds('2026-10-15').start.toISOString(), '2026-10-14T23:00:00.000Z');
  lib.setTzRules('pas du json'); lib.setTzRules(null);
  const intl = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Casablanca', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  assert.strictEqual(lib.localHM(t), intl, 'sans règles : table du navigateur');
});
