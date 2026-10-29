// Limites de l'hébergement : mesures (base, stockage, appels du mois), droits, PDF de manifestes anciens effacés chaque nuit
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6'), { startSite } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const NOW = Date.UTC(2026, 9, 17, 9, 0);
let srv;
test.before(async () => { srv = await startSite(); });
test.after(() => { if (srv) srv.kill(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); });

test('mesures : administrateur seulement ; compteur du relais réservé à la clé service', () => {
  env.psql(`truncate usage_daily; insert into usage_daily (day, kind, n) values ((now() + interval '1 hour')::date, 'live', 1200), ((now() + interval '1 hour')::date - 40, 'live', 99);
    insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';`);
  const u = JSON.parse(as(ADMIN, 'select usage_stats()'));
  assert.ok(u.db_mb > 1, JSON.stringify(u));
  assert.strictEqual(u.live_month, 1200, 'mois en cours seulement');
  assert.throws(() => as(MGR, 'select usage_stats()'), /réservé à l'administrateur/);
  assert.throws(() => as(MGR, "select bump_usage('live')"), /permission denied/);
  assert.throws(() => as(MGR, 'select * from usage_daily'), /permission denied/);
});

test('PDF de manifestes plus anciens que « manifestKeepDays » effacés du stockage, historique gardé', async () => {
  // deux PDF dans le stockage de test : un ancien (40 jours), un récent
  const put = async (k) => { const r = await fetch('http://localhost:8080/storage/v1/object/manifestes/' + k, { method: 'POST', headers: { Authorization: 'Bearer x' },
    body: Buffer.concat([Buffer.from('--b\r\n\r\n%PDF-1.3 test'), Buffer.from('\n%%EOF\r\n--b--')]) }); assert.ok(r.ok); };
  await put('2026-09/ancien.pdf'); await put('2026-10/recent.pdf');
  env.psql("delete from params where key = 'manifestKeepDays'");
  const B = collector(NOW); B.run('installer()');   // paramètre recréé avec sa valeur par défaut (30 jours)
  env.psql(`truncate manifests restart identity;
    insert into manifests (vehicle_key, plate, file_path, created_at) values ('A', 'A', '2026-09/ancien.pdf', '${new Date(NOW - 40 * 86400000).toISOString()}'), ('B', 'B', '2026-10/recent.pdf', '${new Date(NOW - 2 * 86400000).toISOString()}')`);   // âges comptés depuis l'heure du collecteur (NOW), pas la date du jour
  assert.strictEqual(B.run('pruneManifests_()'), '1 PDF de manifestes de plus de 30 jours effacés du stockage');
  assert.deepStrictEqual(await (await fetch('http://localhost:8080/storage/v1/object/__liste')).json(), ['manifestes/2026-10/recent.pdf']);
  assert.strictEqual(env.psql("select string_agg(plate || '=' || coalesce(file_path, 'effacé'), ',' order by id) from manifests"), 'A=effacé,B=2026-10/recent.pdf');
  assert.strictEqual(B.run('pruneManifests_()'), '', 'rien de plus à effacer');
  // 0 = jamais effacé
  env.psql("update params set value = '0' where key = 'manifestKeepDays'; update manifests set file_path = 'x.pdf', created_at = now() - interval '400 days'");
  B.run('memoClear_()');
  assert.strictEqual(B.run('pruneManifests_()'), '');
  env.psql("truncate manifests restart identity; update params set value = '30' where key = 'manifestKeepDays'");
});
