// Relecture complète de la base du 14/11/2026 (migration 20261127000000_relecture_base.sql) et projet database/ : données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const { execFileSync } = require('child_process'), path = require('path');
const env = require('./lib/env');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const anon = sql => env.psql(`begin; set local role anon; set local request.jwt.claims = '{"role":"anon"}'; ${sql}; commit;`);
const base = role => env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
  insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', '${role}') on conflict (user_id) do update set role = '${role}';
  insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
  insert into vehicles (key, plate, agency_id) values ('V1', 'WW1', 1), ('V2', 'WW2', 2);`);
const reset = () => { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); };

test('planning : une agence vide n\'ouvre aucun droit à un gestionnaire', () => {
  env.resetDb(); base('manager');
  env.psql(`insert into drivers (code, name, agency_id) values ('C1', 'Ali', 1), ('C2', 'Badr', 2), ('C3', 'Driss', 2);
    insert into driver_roster (driver_code, agency_id, shift) values ('C2', 2, 'Jour'), ('C3', 2, 'Nuit');`);
  try {
    assert.strictEqual(as(MGR, 'select plan_can_edit(null)'), 'f');
    assert.strictEqual(as(MGR, "select plan_driver_in('C2', null)"), 'f');
    assert.throws(() => as(MGR, "select plan_replace_driver(null, 'C2', 'C3', '2026-11-16')"), /non autorisée|autre agence/);
    assert.strictEqual(env.psql("select active::text || coalesce(left_at::text, '-') from driver_roster where driver_code = 'C2'"), 'true-', 'chauffeur de Rabat intact');
    assert.strictEqual(as(MGR, 'select plan_can_edit(1)'), 't', 'sa propre agence : toujours permis');
    assert.strictEqual(as(ADMIN, 'select plan_can_edit(null)'), 't', 'administrateur : tout');
  } finally { reset(); }
});

test('courses : la marque « course rapide » ne sert pas à envoyer un devis sans validation', () => {
  env.resetDb(); base('manager');
  try {
    assert.throws(() => as(MGR, `insert into missions (agency_id, client_name, total_ttc, status, data, start_at, end_at) values (1, 'X', 90000, 'Devis envoyé', '{"quick": true}', '2026-11-20T08:00Z', '2026-11-22T18:00Z')`), /course rapide/);
    as(MGR, `insert into missions (agency_id, client_name, vehicle_key, total_ttc, status, data, start_at, end_at) values (1, 'Q', 'V1', 400, 'Confirmée', '{"quick": true}', '2026-11-20T08:00Z', '2026-11-20T10:00Z')`);
    as(MGR, "insert into missions (agency_id, client_name, total_ttc, status, start_at, end_at) values (1, 'D', 900, 'Demande', '2026-11-21T08:00Z', '2026-11-21T10:00Z')");
    assert.throws(() => as(MGR, `update missions set data = data || '{"quick": true}' where client_name = 'D'`), /marque non modifiable/);
    as(MGR, "update missions set status = 'En cours' where client_name = 'Q'");   // course rapide : suite normale
    assert.strictEqual(env.psql("select status from missions where client_name = 'Q'"), 'En cours');
  } finally { reset(); env.psql('truncate missions restart identity cascade'); }
});

test('connexions : la dernière activité est l\'heure de la base ; on n\'efface que ses vieux signaux', () => {
  env.resetDb(); base('manager');
  try {
    as(MGR, "select session_ping('aaaaaaaa-0000-0000-0000-000000000001', 'Caisse', 'Navigateur', true)");
    as(MGR, "update user_sessions set last_seen = '2030-01-01T23:00Z', active = false where id = 'aaaaaaaa-0000-0000-0000-000000000001'");
    assert.strictEqual(env.psql("select last_seen < '2030-01-01' and active = false from user_sessions"), 't', 'heure envoyée par le navigateur ignorée');
    as(MGR, "delete from user_sessions where id = 'aaaaaaaa-0000-0000-0000-000000000001'");
    assert.strictEqual(env.psql('select count(*) from user_sessions'), '1', 'session récente gardée');
    env.psql("update user_sessions set last_seen = now() - interval '40 days'");
    as(MGR, "delete from user_sessions where id = 'aaaaaaaa-0000-0000-0000-000000000001'");
    assert.strictEqual(env.psql('select count(*) from user_sessions'), '0', 'signal de plus de 30 jours : effaçable');
  } finally { reset(); env.psql('truncate user_sessions'); }
});

test('droits : fonctions de contrôle et séquences fermées à anon ; règles RLS sans appel par ligne', () => {
  assert.throws(() => anon('select is_admin()'), /permission denied/);
  assert.throws(() => anon('select my_vehicle_keys()'), /permission denied/);
  assert.strictEqual(env.psql("select count(*) from information_schema.role_usage_grants where grantee = 'anon' and object_schema = 'public'"), '0');
  assert.strictEqual(env.psql("select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' and table_name = 'fuel_card_tx'"), '0');
  const unwrapped = env.psql(`select string_agg(tablename || '.' || policyname, ', ') from pg_policies where schemaname = 'public'
    and (qual ~ '(?<!SELECT )(public\\.)?(is_admin|my_role|my_agency_ids|my_vehicle_keys|my_driver_codes|is_rh|rh_agency_ids|rh_staff_users|rh_driver_codes)\\(\\)'
      or with_check ~ '(?<!SELECT )(public\\.)?(is_admin|my_role|my_agency_ids|my_vehicle_keys|my_driver_codes|is_rh|rh_agency_ids|rh_staff_users|rh_driver_codes)\\(\\)')`);
  assert.strictEqual(unwrapped, '', 'fonctions de droits appelées une fois par requête');
});

test('database/schema/ et liens_droits/ : identiques aux migrations', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'database', 'outils', 'schema.js'), 'check'], { encoding: 'utf8', env: process.env });
  assert.match(out, /identique aux migrations/);
});
