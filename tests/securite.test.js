// Droits par agence renforcés (migration 20261019000000_securite.sql) : compte remis en attente, import de contrats,
// changements de plaque, chauffeurs, agence retirée d'un véhicule, journal technique, demandes au collecteur.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`).split('\n').filter(Boolean).pop();
const fails = (uid, sql) => { try { as(uid, sql); return false; } catch (e) { return true; } };

test.before(() => {
  env.resetDb();
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}';
    insert into agencies (name) values ('Casablanca'), ('Marrakech');
    insert into vehicles (key, plate, model) values ('968194WW', 'WW968194', 'SONATA'), ('968199WW', 'WW968199', 'STARIA');
    insert into parc (plate, model, agency_id) values ('WW968194', 'SONATA', 1), ('WW968199', 'STARIA', 2);
    insert into user_agencies values ('${MGR}', 1);
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('K1', 'C1', 'Chauffeur Un', 'WW968194', '968194WW', '2026-10-05 08:00+00'),
      ('K2', 'C2', 'Chauffeur Deux', 'WW968199', '968199WW', '2026-10-05 08:00+00');
    select refresh_drivers();
    update drivers set agency_id = 2 where code = 'C2';
    insert into plate_changes (old_plate, new_plate) values ('WW968194', '11111-A-1'), ('WW968199', '22222-B-2');
    insert into logs (action, detail) values ('Test', 'journal technique')`);
});
test.after(() => { env.resetDb(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); });

test('import de contrats par un gestionnaire : seulement les véhicules de son agence', () => {
  const r = JSON.parse(as(MGR, `select import_contracts('[{"num":"K2","client_code":"PIRATE","name":"Pirate","plate":"WW968199","vehicle_key":"968199WW","start_at":"2026-10-05T08:00:00Z"},
    {"num":"K3","client_code":"C9","name":"Nouveau","plate":"WW968199","vehicle_key":"968199WW","start_at":"2026-10-06T08:00:00Z"},
    {"num":"K4","client_code":"C1","name":"Chauffeur Un","plate":"WW968194","vehicle_key":"968194WW","start_at":"2026-10-06T08:00:00Z"}]'::jsonb)`));
  assert.deepStrictEqual([r.added, r.updated, r.skipped], [1, 0, 2]);
  assert.strictEqual(env.psql("select name from contracts where num = 'K2'"), 'Chauffeur Deux', 'contrat d\'une autre agence modifié');
  assert.strictEqual(env.psql("select count(*) from contracts where num = 'K3'"), '0');
  assert.strictEqual(env.psql("select vehicle_key from contracts where num = 'K4'"), '968194WW');
  const a = JSON.parse(as(ADMIN, `select import_contracts('[{"num":"K3","client_code":"C9","name":"Nouveau","plate":"WW968199","vehicle_key":"968199WW","start_at":"2026-10-06T08:00:00Z"}]'::jsonb)`));
  assert.strictEqual(a.added, 1, 'l\'administrateur importe tout');
});

test('changements de plaque : lus et modifiés seulement pour ses véhicules', () => {
  assert.strictEqual(as(MGR, 'select string_agg(new_plate, \',\') from plate_changes'), '11111-A-1');
  as(MGR, "update plate_changes set note = 'x' where old_plate = 'WW968199'");
  assert.strictEqual(env.psql("select coalesce(note, '') from plate_changes where old_plate = 'WW968199'"), '');
  assert.ok(fails(MGR, "insert into plate_changes (old_plate, new_plate) values ('WW968199', '99999-Z-9')"), 'plaque d\'une autre agence ajoutée');
  as(MGR, "insert into plate_changes (old_plate, new_plate) values ('WW968194', '33333-C-3')");
});

test('chauffeurs : un gestionnaire ne modifie pas ceux d\'une autre agence et ne retire pas un chauffeur de son agence', () => {
  as(MGR, "update drivers set phone = '0600' where code = 'C2'");
  assert.strictEqual(env.psql("select coalesce(phone, '') from drivers where code = 'C2'"), '');
  env.psql("update drivers set agency_id = 1 where code = 'C1'");
  assert.ok(fails(MGR, "update drivers set agency_id = null where code = 'C1'"), 'chauffeur retiré de son agence');
  as(MGR, "update drivers set phone = '0611' where code = 'C1'");
  assert.strictEqual(env.psql("select phone from drivers where code = 'C1'"), '0611');
});

test('journal technique et liste des comptes : administrateur seulement ; demandes limitées pour un gestionnaire', () => {
  assert.strictEqual(as(MGR, 'select count(*) from logs'), '0');
  assert.strictEqual(as(ADMIN, 'select count(*) from logs'), '1');
  assert.strictEqual(as(MGR, 'select count(*) from profiles'), '1', 'seulement son profil');
  as(MGR, "insert into jobs (kind) values ('sync_now')");
  assert.ok(fails(MGR, "insert into jobs (kind, arg) values ('resync', '2026-08-01|2026-10-01')"));
  assert.ok(fails(MGR, "insert into jobs (kind, arg) values ('send_report', '1')"));
  as(ADMIN, "insert into jobs (kind, arg) values ('resync', '2026-10-01|2026-10-01')");
});

test('agence retirée dans le parc ou ligne du parc supprimée : le véhicule quitte l\'agence', () => {
  env.psql("update parc set agency_id = null where plate = 'WW968194'");
  assert.strictEqual(env.psql("select coalesce(agency_id::text, '-') from vehicles where key = '968194WW'"), '-');
  env.psql("update vehicles set tank_l = 50 where key = '968194WW'");
  assert.strictEqual(env.psql("select coalesce(agency_id::text, '-') from vehicles where key = '968194WW'"), '-', 'agence remise à la modification suivante');
  env.psql("delete from parc where plate = 'WW968199'");
  assert.strictEqual(env.psql("select coalesce(agency_id::text, '-') from vehicles where key = '968199WW'"), '-');
});

test('compte remis en attente : ne voit plus rien, même rattaché à une agence', () => {
  env.psql(`update parc set agency_id = 1 where plate = 'WW968194'; update profiles set role = 'pending' where user_id = '${MGR}'`);
  for (const t of ['vehicles', 'drivers', 'parc', 'agencies', 'contracts', 'plate_changes', 'jobs']) assert.strictEqual(as(MGR, 'select count(*) from ' + t), '0', t);
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'`);
});

test('classement : événements par chauffeur et par véhicule', () => {
  env.psql(`insert into rules (id, name, weight, category) values ('R1', 'Freinage', 2, 'Freinage');
    insert into events (id, vehicle_key, day, rule_id, driver_code, vday) values ('e1', '968194WW', '2026-10-05', 'R1', 'C1', '2026-10-05'), ('e2', '968199WW', '2026-10-05', 'R1', 'C1', '2026-10-05')`);
  assert.strictEqual(as(ADMIN, "select string_agg(vehicle_key || ':' || n, ',' order by vehicle_key) from driver_rule_counts('2026-10-01', '2026-10-10')"), '968194WW:1,968199WW:1');
});
