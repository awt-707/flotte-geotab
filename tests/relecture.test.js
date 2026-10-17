// Relecture du 17/10/2026 : contrats jamais clôturés, changement de plaque (alertes), import des contrats (champs mis à jour, gestionnaire)
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6'), lib = require('../site/lib.js');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const NOW = Date.UTC(2026, 9, 17, 9, 0);

test('contrat jamais clôturé dans l\'extract : il s\'arrête au début du contrat suivant du véhicule (collecteur et site)', () => {
  const B = collector(NOW);
  env.psql(`insert into vehicles (key, plate) values ('968193WW', 'WW968193');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at, status) values
      ('O1', 'C1', 'Ouvert Ancien', 'WW968193', '968193WW', '2026-10-15T18:30:00Z', null, 'En cours'),
      ('J2', 'C2', 'Jour Suivant', 'WW968193', '968193WW', '2026-10-16T06:25:00Z', '2026-10-16T16:46:00Z', 'Terminé'),
      ('N3', 'C3', 'Nuit En Cours', 'WW968193', '968193WW', '2026-10-16T16:57:00Z', null, 'En cours'),
      ('F4', 'C4', 'Futur', 'WW968193', '968193WW', '2026-10-20T06:00:00Z', null, 'Réservé')`);
  const idx = JSON.parse(B.run("JSON.stringify(contractIndex_()['968193WW'].map(c => [c.num, new Date(c.end).toISOString(), c.replacedBy || '']))"));
  assert.deepStrictEqual(idx.slice(0, 2), [['O1', '2026-10-16T06:25:00.000Z', 'J2'], ['J2', '2026-10-16T16:46:00.000Z', '']]);
  assert.strictEqual(idx[2][2], '', 'contrat en cours le plus récent : toujours ouvert (une réservation future ne le ferme pas)');
  // trajet entre la fin du contrat de jour et le début de la nuit : hors contrat (avant : chauffeur du contrat jamais clôturé)
  const who = t => B.run(`(findContract_(contractIndex_(), '968193WW', ${Date.parse(t)}, 0) || {}).num || 'HORS'`);
  assert.strictEqual(who('2026-10-16T16:50:00Z'), 'HORS');
  assert.strictEqual(who('2026-10-15T22:00:00Z'), 'O1');
  assert.strictEqual(who('2026-10-16T20:00:00Z'), 'N3');
  const info = JSON.parse(B.run("JSON.stringify(Object.entries(contractInfoFor_([{ I: { 'Contrat': 0 }, rows: [['O1'], ['N3']] }])).map(([n, c]) => [n, c.end ? c.end.toISOString() : null]))"));
  assert.deepStrictEqual(info.sort(), [['N3', null], ['O1', '2026-10-16T06:25:00.000Z']]);
  // site : même règle
  const l = lib.ctrEffEnds(JSON.parse(env.psql("select json_agg(c) from (select num, start_at, end_at from contracts where vehicle_key = '968193WW') c")), NOW);
  assert.deepStrictEqual(l.map(c => [c.num, c._end === null ? null : new Date(c._end).toISOString(), c._next]),
    [['O1', '2026-10-16T06:25:00.000Z', 'J2'], ['J2', '2026-10-16T16:46:00.000Z', ''], ['N3', null, ''], ['F4', null, '']]);
});

test('changement de plaque : les alertes gardent leur statut, leur commentaire et leur envoi', () => {
  env.resetDb();
  env.psql(`insert into alerts (id, day, time, plate, vehicle_key, type, severity, status, comment, notified_at) values
      ('DEP|968193WW|2026-10-16T13:06:45.300Z', '2026-10-16', '14:06', 'WW968193', '968193WW', 'Dépassement limite', 'Haute', 'Traité', 'vu avec le chauffeur', now()),
      ('MOT|2026-10-16|968193WW', '2026-10-16', '', 'WW968193', '968193WW', 'Défaut moteur', 'Moyenne', 'Faux positif', '', now()),
      ('COL|b123', '2026-10-16', '10:00', 'WW968193', '968193WW', 'Collision', 'Critique', 'En cours', '', now()),
      ('MOT|2026-10-15|968193WW', '2026-10-15', '', 'WW968193', '968193WW', 'Défaut moteur', 'Moyenne', 'À traiter', '', now()),
      ('MOT|2026-10-15|12345AB', '2026-10-15', '', '12345-A-B', '12345AB', 'Défaut moteur', 'Moyenne', 'Traité', 'déjà sous la nouvelle plaque', now());
    select rekey_vehicle('968193WW', '12345AB');`);
  const r = JSON.parse(env.psql("select json_agg(a order by a.id) from (select id, vehicle_key, status, comment, notified_at is not null as sent from alerts) a"));
  assert.deepStrictEqual(r.map(a => [a.id, a.vehicle_key, a.status, a.comment, a.sent]), [
    ['COL|b123', '12345AB', 'En cours', '', true],
    ['DEP|12345AB|2026-10-16T13:06:45.300Z', '12345AB', 'Traité', 'vu avec le chauffeur', true],
    ['MOT|2026-10-15|12345AB', '12345AB', 'Traité', 'déjà sous la nouvelle plaque', true],
    ['MOT|2026-10-16|12345AB', '12345AB', 'Faux positif', '', true]]);
});

test('import des contrats : téléphone et e-mail corrigés enregistrés ; un gestionnaire ne peut pas importer de contrat sans véhicule', () => {
  env.resetDb();
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'; insert into agencies (name) values ('Casablanca');
    insert into vehicles (key, plate) values ('968194WW', 'WW968194'); insert into parc (plate, agency_id) values ('WW968194', 1) on conflict (plate) do update set agency_id = 1; insert into user_agencies values ('${MGR}', 1);
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, phone) values ('K1', 'C1', 'Chauffeur Un', 'WW968194', '968194WW', '2026-10-05T08:00:00Z', '0600')`);
  try {
    const row = { num: 'K1', client_code: 'C1', name: 'Chauffeur Un', plate: 'WW968194', vehicle_key: '968194WW', start_at: '2026-10-05T08:00:00+00:00', phone: '0611', email: 'un@exemple.ma' };
    const r = JSON.parse(as(ADMIN, `select import_contracts('${JSON.stringify([row])}'::jsonb)`).split('\n').pop());
    assert.deepStrictEqual([r.added, r.updated, r.same], [0, 1, 0]);
    assert.strictEqual(env.psql("select phone || ' ' || email from contracts where num = 'K1'"), '0611 un@exemple.ma');
    const r2 = JSON.parse(as(MGR, `select import_contracts('${JSON.stringify([{ num: 'X1', client_code: 'Z', name: 'Sans Vehicule', start_at: '2026-10-05T08:00:00Z' }])}'::jsonb)`).split('\n').pop());
    assert.deepStrictEqual([r2.added, r2.skipped], [0, 1]);
    assert.strictEqual(env.psql("select count(*) from contracts where num = 'X1'"), '0');
  } finally { env.resetDb(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); }
});
