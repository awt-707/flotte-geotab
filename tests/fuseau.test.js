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

test('heure réelle du Maroc (UTC+1) dans le collecteur, quelle que soit la table des fuseaux de Google', () => {
  const B = collector(NOW);
  assert.strictEqual(B.run("localDay_(new Date('2026-10-14T23:30:00Z'))"), '2026-10-15');
  assert.strictEqual(B.run("localHM_(new Date('2026-10-14T23:30:00Z'))"), '00:30');
  assert.strictEqual(B.run("dayBounds_('2026-10-16').start.toISOString()"), '2026-10-15T23:00:00.000Z');
  assert.strictEqual(B.run("localHM_(new Date('2027-02-20T12:00:00Z'))"), '12:00', 'Ramadan : UTC+0');
});

test('une seule fois : journées depuis le 20/09/2026 retéléchargées et recalculées à l\'heure réelle', () => {
  const B = collector(NOW, { TZ_FIX: '' }); B.run('installer()');
  env.psql('delete from logs');
  B.run('collect()');
  assert.match(env.psql("select detail from logs where action = 'Heure du Maroc'"), /Journées du 20\/09\/2026 au 05\/10\/2026 recalculées .* véhicule-jours à retélécharger/);
  assert.match(env.psql("select detail from logs where action = 'Collecte' order by at desc limit 1"), /véhicule-jours finalisés/);
  assert.strictEqual(env.psql("select count(distinct day) from vehicle_days where day between '2026-09-20' and '2026-10-04'"), '15', 'journées non retéléchargées');
  B.setNow(NOW + 5 * 60000); B.run('collect()');
  assert.strictEqual(env.psql("select count(*) from logs where action = 'Heure du Maroc'"), '1');
});
