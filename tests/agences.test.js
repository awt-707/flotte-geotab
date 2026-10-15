// Agences : chaque utilisateur ne voit que les véhicules de ses agences (et leurs trajets, contrats, alertes, chauffeurs) ; l'admin voit tout.
// Parc injecté depuis le site : l'agence du véhicule suit le parc. Chauffeurs ajoutés à la main conservés au recalcul.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
// Requête exécutée avec les droits d'un utilisateur du site (rôle authenticated + identifiant dans le jeton)
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const count = (uid, table) => +as(uid, `select count(*) from ${table}`).split('\n').filter(Boolean).pop();

test.before(() => {
  env.resetDb();
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}';
    insert into agencies (name) values ('Casablanca'), ('Marrakech');
    insert into vehicles (key, plate, model) values ('968194WW', 'WW968194', 'SONATA'), ('968199WW', 'WW968199', 'STARIA'), ('12345AB', '12345-A-B', 'STARIA');
    insert into parc (plate, model, agency_id) values ('WW968194', 'SONATA', 1), ('968199-WW', 'STARIA', 2);
    insert into user_agencies values ('${MGR}', 1);
    insert into alerts (id, day, plate, vehicle_key, type, severity) values ('a1', '2026-10-05', 'WW968194', '968194WW', 'Vitesse', 'Haute'),
      ('a2', '2026-10-05', 'WW968199', '968199WW', 'Vitesse', 'Critique'), ('a3', '2026-10-05', '12345-A-B', '12345AB', 'Vitesse', 'Info');
    insert into journal (id, day, plate, vehicle_key, driver_code, km) values ('j1', '2026-10-05', 'WW968194', '968194WW', 'C1', 10), ('j2', '2026-10-05', 'WW968199', '968199WW', 'C2', 20);
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('K1', 'C1', 'Chauffeur Un', 'WW968194', '968194WW', '2026-10-05 08:00+00'),
      ('K2', 'C2', 'Chauffeur Deux', 'WW968199', '968199WW', '2026-10-05 08:00+00');
    select refresh_drivers();`);
});

// Le 2e compte redevient « en attente » (utilisé ainsi par les tests du site)
test.after(() => { env.resetDb(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); });

test('agence du véhicule reprise du parc (plaque écrite autrement comprise)', () => {
  assert.strictEqual(env.psql("select string_agg(key || '=' || coalesce(agency_id::text, '-'), ' ' order by key) from vehicles"), '12345AB=- 968194WW=1 968199WW=2');
  env.psql("insert into vehicles (key, plate) values ('777WW', 'WW777'); insert into parc (plate, agency_id) values ('WW-777', 1)");
  assert.strictEqual(env.psql("select agency_id from vehicles where key = '777WW'"), '1');
  env.psql("delete from vehicles where key = '777WW'; delete from parc where plate = 'WW-777'");
});

test('gestionnaire : seulement les véhicules et données de son agence', () => {
  assert.strictEqual(count(MGR, 'vehicles'), 1);
  assert.strictEqual(count(MGR, 'alerts'), 1);
  assert.strictEqual(count(MGR, 'journal'), 1);
  assert.strictEqual(count(MGR, 'contracts'), 1);
  assert.strictEqual(as(MGR, 'select string_agg(code, \',\') from drivers').split('\n').pop(), 'C1');
  assert.strictEqual(as(MGR, 'select string_agg(name, \',\') from agencies').split('\n').pop(), 'Casablanca');
});

test('admin : tout', () => {
  assert.strictEqual(count(ADMIN, 'vehicles'), 3);
  assert.strictEqual(count(ADMIN, 'alerts'), 3);
  assert.strictEqual(count(ADMIN, 'agencies'), 2);
});

test('gestionnaire : ne modifie pas les alertes d\'une autre agence', () => {
  as(MGR, "update alerts set status = 'Traité' where id in ('a1', 'a2')");
  assert.strictEqual(env.psql("select string_agg(id || '=' || status, ' ' order by id) from alerts"), 'a1=Traité a2=À traiter a3=À traiter');
});

test('chauffeur ajouté à la main : conservé au recalcul, agence obligatoire pour un gestionnaire', () => {
  as(MGR, "insert into drivers (code, name, phone, source, agency_id) values ('M1', 'Chauffeur Manuel', '0600', 'manuel', 1)");
  assert.throws(() => as(MGR, "insert into drivers (code, name, source, agency_id) values ('M2', 'Autre', 'manuel', 2)"), /row-level security/);
  as(ADMIN, "update drivers set phone = '0611', agency_id = 1 where code = 'C1'");
  env.psql("insert into contracts (num, client_code, name, plate, vehicle_key, start_at, phone) values ('K3', 'M1', 'NOM CONTRAT', 'WW968194', '968194WW', '2026-10-06 08:00+00', '0700'); select refresh_drivers();");
  assert.strictEqual(env.psql("select name || '|' || phone || '|' || n_contracts || '|' || source from drivers where code = 'M1'"), 'Chauffeur Manuel|0600|1|manuel');
  env.psql("delete from contracts where num = 'K3'; select refresh_drivers();");
  assert.strictEqual(env.psql("select count(*) from drivers where code = 'M1'"), '1');
  assert.strictEqual(env.psql("select agency_id from drivers where code = 'C1'"), '1');
});

test('import des contrats par un gestionnaire : extract complet enregistré, rien d\'autre visible', () => {
  const rows = JSON.stringify([{ num: 'K2', client_code: 'C2', name: 'Chauffeur Deux', plate: 'WW968199', vehicle_key: '968199WW', start_at: '2026-10-05T08:00:00Z' },
    { num: 'K9', client_code: 'C9', name: 'Neuf', plate: 'WW968199', vehicle_key: '968199WW', start_at: '2026-10-04T08:00:00Z' }]);
  const r = JSON.parse(as(MGR, `select import_contracts('${rows}'::jsonb)`).split('\n').pop());
  assert.deepStrictEqual([r.added, r.updated, r.same], [1, 0, 1]);
  assert.match(r.min_start, /^2026-10-04/);
  assert.strictEqual(env.psql("select count(*) from contracts where num = 'K9'"), '1');
  assert.strictEqual(count(MGR, 'contracts'), 1);
  assert.throws(() => as(MGR, "insert into contracts (num) values ('X')"), /permission denied/);
});

test('destinataires et rapports : réservés à l\'admin', () => {
  as(ADMIN, "insert into alert_recipients (email, min_severity) values ('chef@x', 'Critique'); insert into report_schedules (frequency, recipients) values ('jour', 'chef@x')");
  assert.strictEqual(count(MGR, 'alert_recipients'), 0);
  assert.throws(() => as(MGR, "insert into report_schedules (frequency, recipients) values ('jour', 'moi@x')"), /row-level security/);
});
