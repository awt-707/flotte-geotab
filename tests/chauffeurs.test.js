// Nouveaux chauffeurs détectés depuis les contrats : fiche créée à l'import (sans attendre le collecteur), agence du véhicule,
// compte Uber relié (même téléphone, sinon même nom), jamais un compte déjà pris ni un candidat ambigu. Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const imp = (uid, rows) => JSON.parse(as(uid, `select import_contracts('${JSON.stringify(rows).replace(/'/g, "''")}'::jsonb)`).split('\n').pop());
const ctr = (num, code, name, phone, start) => ({ num, client_code: code, name, phone, plate: 'WW968199', vehicle_key: '968199WW', start_at: start || '2026-10-20T08:00:00Z' });

test('import des contrats : nouveaux chauffeurs enregistrés tout de suite, avec l\'agence du véhicule et leur compte Uber', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id) values ('968199WW', 'WW968199', 'STARIA', 'OUI', 1), ('968194WW', 'WW968194', 'SONATA', 'OUI', 2);
    insert into uber_drivers (uuid, name, phone, agency_id) values ('u-tel', 'Autre Nom', '+212 6 11 22 33 44', 1), ('u-nom', 'Beta Essai', null, 1),
      ('u-pris', 'Gamma Trois', '+212622222222', 1), ('u-dbl1', 'Delta Quatre', null, 1), ('u-dbl2', 'Quatre Delta', null, 1);
    insert into drivers (code, name, phone, uber_uuid, source, agency_id, status) values ('OLD', 'Ancien', '0622222222', 'u-pris', 'manuel', 2, 'ACTIF');`);
  try {
    const r = imp(MGR, [ctr('K1', 'C1', 'ALPHA Test', '0611223344'), ctr('K2', 'C2', 'Essai BETA', ''), ctr('K3', 'C3', 'Gamma Trois', '0622222222'), ctr('K4', 'C4', 'Delta Quatre', '')]);
    assert.deepStrictEqual([r.added, r.new_drivers], [4, ['ALPHA Test (C1)', 'Delta Quatre (C4)', 'Essai BETA (C2)', 'Gamma Trois (C3)']]);
    const d = env.psql("select string_agg(code || '|' || status || '|' || coalesce(agency_id::text, '-') || '|' || coalesce(uber_uuid, '-'), ' ' order by code) from drivers");
    // C1 : même téléphone ; C2 : même nom dans l'autre ordre ; C3 : compte déjà relié à OLD ; C4 : deux comptes possibles (ambigu)
    assert.strictEqual(d, 'C1|NOUVEAU|1|u-tel C2|NOUVEAU|1|u-nom C3|NOUVEAU|1|- C4|NOUVEAU|1|- OLD|ACTIF|2|u-pris');
    assert.match(as(MGR, "select string_agg(code, ',' order by code) from drivers"), /^C1,C2,C3,C4/, 'le gestionnaire voit tout de suite ses nouveaux chauffeurs');
    // réimport identique : rien de nouveau ; chauffeur déjà rattaché : jamais déplacé
    assert.deepStrictEqual(imp(ADMIN, [ctr('K1', 'C1', 'ALPHA Test', '0611223344')]).new_drivers, []);
    imp(ADMIN, [Object.assign(ctr('K5', 'C1', 'ALPHA Test', '0611223344', '2026-10-21T08:00:00Z'), { plate: 'WW968194', vehicle_key: '968194WW' })]);
    assert.strictEqual(env.psql("select agency_id from drivers where code = 'C1'"), '1');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); }
});
