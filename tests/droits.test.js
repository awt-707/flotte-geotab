// Droits (relecture du 18/10/2026) : colonnes réellement limitées, auteur des demandes non falsifiable, demandes lues par leur auteur
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);

test('gestionnaire : seulement les colonnes prévues ; demandes à son nom, lues par lui seul ; collecteur : demande sans auteur refusée', () => {
  const B = collector(Date.UTC(2026, 9, 17, 9, 0));   // base vidée
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, agency_id) values ('86433T1', '86433-T-1', 'STARIA', 1);
    insert into alerts (id, day, vehicle_key, plate, type, severity, detail) values ('A1', '2026-10-17', '86433T1', '86433-T-1', 'Siphonage', 'Critique', '30 L');
    insert into fuel_card_tx (id, vehicle_key, plate, at, liters) values ('T1', '86433T1', '86433-T-1', now(), 60);
    insert into drivers (code, name, agency_id, source) values ('C1', 'Chauffeur Un', 1, 'manuel')`);
  try {
    // statut et commentaire : oui ; le reste de la ligne : non
    as(MGR, "update alerts set status = 'Traité', comment = 'vu' where id = 'A1'");
    assert.strictEqual(env.psql("select status || '|' || comment from alerts"), 'Traité|vu');
    assert.throws(() => as(MGR, "update alerts set detail = '0 L', severity = 'Info' where id = 'A1'"), /permission denied/);
    as(MGR, "update fuel_card_tx set status = 'Justifié' where id = 'T1'");
    assert.throws(() => as(MGR, "update fuel_card_tx set liters = 20 where id = 'T1'"), /permission denied/);
    assert.strictEqual(env.psql("select liters || '|' || status from fuel_card_tx"), '60|Justifié');
    assert.throws(() => as(MGR, "update drivers set code = 'C9' where code = 'C1'"), /permission denied/);
    as(MGR, "update drivers set phone = '0600000000' where code = 'C1'");
    assert.throws(() => as(MGR, "update vehicles set geotab_id = 'b1' where key = '86433T1'"), /permission denied/);
    // demandes : l'auteur est l'utilisateur connecté
    as(MGR, "insert into jobs (kind) values ('sync_now')");
    assert.throws(() => as(MGR, `insert into jobs (kind, created_by) values ('sync_now', null)`), /permission denied/);
    assert.throws(() => as(MGR, `insert into jobs (kind, created_by) values ('sync_now', '${ADMIN}')`), /permission denied/);
    as(ADMIN, "insert into jobs (kind) values ('recompute')");
    assert.strictEqual(env.psql("select string_agg(kind || '=' || (created_by = '" + ADMIN + "'), ',' order by id) from jobs"), 'sync_now=false,recompute=true');
    assert.strictEqual(as(MGR, 'select string_agg(kind, \',\') from jobs'), 'sync_now', 'le gestionnaire ne lit que ses demandes');
    assert.strictEqual(as(ADMIN, 'select count(*) from jobs'), '2');
    // anon : aucune écriture
    assert.throws(() => env.psql("begin; set local role anon; insert into jobs (kind) values ('sync_now'); commit;"), /permission denied/);
    // collecteur : demande sans auteur (insérée avec la clé service) refusée, comme un chemin de PDF hors du dossier des manifestes
    env.psql(`delete from jobs; insert into jobs (kind, arg) values ('driver_report', '{"code":"C1","from":"2026-10-01","to":"2026-10-17","email":"x@y.ma"}');
      insert into manifests (vehicle_key, plate, file_path) values ('86433T1', '86433-T-1', '../app/version.json');
      insert into jobs (kind, arg, created_by) values ('manifest_mail', '{"id":1,"to":"x@y.ma"}', '${ADMIN}')`);
    B.run('processJobs_(Date.now())');
    assert.strictEqual(B.mails.length, 0);
    assert.strictEqual(env.psql("select string_agg(kind || '=' || result, ',' order by id) from jobs"),
      'driver_report=Erreur : demande sans auteur,manifest_mail=Erreur : chemin du PDF invalide');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; truncate manifests restart identity; delete from jobs`); }
});
