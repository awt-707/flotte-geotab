// Relecture A → Z du 24/10/2026 : règles corrigées dans la base (migration 20261113000000_relecture2.sql). Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const base = role => env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
  insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', '${role}') on conflict (user_id) do update set role = '${role}';
  insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
  insert into vehicles (key, plate, agency_id) values ('V1', 'WW1', 1), ('V2', 'WW2', 2);`);

test('courses : validation jamais retirée par un gestionnaire, véhicule jamais réservé deux fois', () => {
  env.resetDb(); base('manager');
  try {
    as(MGR, "insert into missions (agency_id, client_name, total_ttc, needs_validation, level, start_at, end_at) values (1, 'A', 9000, true, 'Intensive', '2026-11-01T08:00Z', '2026-11-03T18:00Z')");
    assert.throws(() => as(MGR, "update missions set needs_validation = false, status = 'Devis envoyé'"), /validation de l'exploitation requise/);
    as(MGR, "update missions set needs_validation = false"); assert.strictEqual(env.psql('select needs_validation from missions'), 't', 'besoin de validation gardé');
    as(MGR, "insert into missions (agency_id, client_name, total_ttc, needs_validation, level, start_at, end_at) values (1, 'VIP', 500, false, '24h / VIP', '2026-11-05T08:00Z', '2026-11-05T18:00Z')");
    assert.strictEqual(env.psql("select needs_validation from missions where client_name = 'VIP'"), 't', '24 h / VIP : validation recalculée par la base');
    // validé puis véhicule changé : validation à refaire
    as(ADMIN, `update missions set validated_at = now(), validated_by = '${ADMIN}' where client_name = 'A'`);
    as(ADMIN, "update missions set vehicle_key = 'V1' where client_name = 'A'");
    assert.strictEqual(env.psql("select validated_at is null from missions where client_name = 'A'"), 't');
    // double réservation refusée (même véhicule, périodes qui se chevauchent)
    as(ADMIN, "insert into missions (agency_id, client_name, vehicle_key, status, start_at, end_at) values (1, 'C1', 'V1', 'Confirmée', '2026-11-10T08:00Z', '2026-11-10T18:00Z')");
    assert.throws(() => as(ADMIN, "insert into missions (agency_id, client_name, vehicle_key, status, start_at, end_at) values (1, 'C2', 'V1', 'Acompte reçu', '2026-11-10T17:00Z', '2026-11-10T20:00Z')"), /déjà bloqué/);
    as(ADMIN, "insert into missions (agency_id, client_name, vehicle_key, status, start_at, end_at) values (1, 'C3', 'V1', 'Confirmée', '2026-11-10T18:00Z', '2026-11-10T20:00Z')");   // à la suite : accepté
    as(ADMIN, "insert into missions (agency_id, client_name, vehicle_key, status, start_at, end_at) values (1, 'C4', 'V1', 'Devis envoyé', '2026-11-10T09:00Z', '2026-11-10T10:00Z')");   // devis : pas bloqué
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); env.psql('truncate missions restart identity cascade'); }
});

test('planning : jamais les cases ni les chauffeurs d\'une autre agence ; absence refusée dans une semaine verrouillée', () => {
  env.resetDb(); base('manager');
  env.psql(`insert into drivers (code, name, agency_id) values ('C1', 'Ali', 1), ('C2', 'Badr', 2);
    insert into driver_roster (driver_code, agency_id, shift) values ('C1', 1, 'Jour'), ('C2', 2, 'Jour');
    insert into driver_plan (agency_id, day, shift, vehicle_key, driver_code) values (2, '2026-11-02', 'Jour', 'V2', 'C2');`);
  try {
    assert.throws(() => as(MGR, `select plan_save(1, '2026-11-02', '2026-11-08', '[{"day":"2026-11-02","shift":"Jour","vehicle_key":"V2","driver_code":"C1"}]')`), /autre agence|hors de l'agence/);
    assert.strictEqual(env.psql("select agency_id || driver_code from driver_plan where vehicle_key = 'V2'"), '2C2', 'case de Rabat intacte');
    as(MGR, `select plan_save(1, '2026-11-02', '2026-11-08', '[{"day":"2026-11-02","shift":"Jour","vehicle_key":"V1","driver_code":"C1"}]')`);
    assert.throws(() => as(MGR, "select plan_replace_driver(1, 'C2', 'C1', '2026-11-02')"), /autre agence/);
    assert.strictEqual(env.psql("select active from driver_roster where driver_code = 'C2'"), 't');
    as(ADMIN, "select plan_week_set(1, '2026-11-02', 'verrouiller')");
    assert.throws(() => as(MGR, "insert into driver_absences (agency_id, driver_code, day_from, day_to) values (1, 'C1', '2026-11-04', '2026-11-04')"), /verrouillée/);
    as(ADMIN, "insert into driver_absences (agency_id, driver_code, day_from, day_to) values (1, 'C1', '2026-11-04', '2026-11-04')");
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('RH : pointage du lendemain = nouvelle arrivée ; compte RH borné à son agence ; contrats du staff hors des gestionnaires', () => {
  env.resetDb(); base('rh');
  env.psql(`insert into drivers (code, name, agency_id) values ('C2', 'Badr', 2);
    insert into contracts (num, client_code, name, vehicle_key, start_at) values ('K2', 'C2', 'Badr', 'V2', now());
    insert into hr_employees (kind, name, agency_id, user_id, birth_date, pointage) values ('staff', 'Sara', 1, '${MGR}', '1990-01-01', true);
    insert into hr_clock (employee_id, user_id, kind, at) values (1, '${MGR}', 'in', now() - interval '23 hours'), (1, '${MGR}', 'pause', now() - interval '18 hours'), (1, '${MGR}', 'resume', now() - interval '17 hours');`);
  try {
    // journée de la veille jamais fermée : l'ouverture du jour pointe une arrivée (et non une simple reprise de session)
    assert.strictEqual(JSON.parse(as(MGR, 'select public.hr_me()')).state, 'off');
    assert.strictEqual(JSON.parse(as(MGR, "select public.hr_clock_do('in', '1990-01-01', 't')")).state, 'on');
    assert.strictEqual(env.psql('select kind from hr_clock order by id desc limit 1'), 'in');
    // RH de Casa : une fiche sans agence avec le code d'un chauffeur de Rabat n'ouvre pas ses contrats ; jamais un administrateur rattaché
    as(MGR, "insert into hr_employees (kind, name, driver_code) values ('chauffeur', 'Badr', 'C2')");
    assert.strictEqual(as(MGR, 'select count(*) from contracts'), '0');
    assert.throws(() => as(MGR, `insert into hr_employees (kind, name, user_id) values ('staff', 'X', '${ADMIN}')`), /administrateur/);
    assert.strictEqual(as(MGR, 'select count(*) from vehicles'), '0', 'RH : pas de lecture de la flotte');
    // contrat du staff : lu par l'administrateur et les RH, jamais par un gestionnaire de l'agence
    env.psql("insert into work_contracts (employee_id, agency_id, name) values (1, 1, 'Sara')");
    assert.strictEqual(as(MGR, 'select count(*) from work_contracts'), '1');
    env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, 'select count(*) from work_contracts'), '0');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});
