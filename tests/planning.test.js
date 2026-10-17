// Planning des gestionnaires : répartition automatique des véhicules d'une agence entre les gestionnaires de service,
// droits (administrateur seul modifie), « Mes véhicules » dans le menu du gestionnaire et filtre des pages
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), lib = require('../site/lib.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222', M3 = '33333333-3333-3333-3333-333333333333';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
lib.setTzRules(env.MA_TZ);
const cur = lib.shiftAt(new Date(), { shiftDay: 7, shiftNight: 19 });
let srv;
test.before(async () => {
  env.resetDb();
  env.psql(`insert into auth.users (id, email) values ('${M3}', 'b-gest@x') on conflict do nothing;
    insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin'), ('${MGR}', 'new@x', 'manager'), ('${M3}', 'b-gest@x', 'manager')
      on conflict (user_id) do update set role = excluded.role, email = excluded.email;
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Casa');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1), ('${M3}', 1);
    insert into vehicles (key, plate, model, agency_id, active) values ('V1', '11111-A-1', 'STARIA', 1, 'OUI'), ('V2', '22222-A-1', 'STARIA', 1, 'OUI'),
      ('V3', '33333-A-1', 'SONATA', 1, 'OUI'), ('V4', '44444-A-1', 'SONATA', 1, 'OUI'), ('V5', '55555-A-1', 'SONATA', 1, 'OUI'),
      ('V6', '66666-A-1', 'STARIA', 1, 'NON'), ('C1', '77777-A-6', 'STARIA', 2, 'OUI');`);
  srv = await startSite();
});
test.after(() => { if (srv) srv.kill(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; delete from profiles where user_id = '${M3}'; truncate manager_shifts`); });

test('répartition : véhicules actifs de l\'agence partagés à tour de rôle entre les gestionnaires de service', () => {
  env.psql(`truncate manager_shifts; insert into manager_shifts (agency_id, user_id, day, shift) values (1, '${MGR}', '2026-10-18', 'Jour'), (1, '${M3}', '2026-10-18', 'Jour'), (1, '${MGR}', '2026-10-18', 'Nuit')`);
  const plan = (uid, d, s) => JSON.parse(as(uid, `select coalesce(json_agg(json_build_object('e', email, 'v', vehicle_key) order by email, vehicle_key), '[]') from shift_plan('${d}', '${s}')`));
  // 5 véhicules actifs (V6 inactif), 2 gestionnaires : 3 + 2, dans l'ordre des plaques et des e-mails
  assert.deepStrictEqual(plan(ADMIN, '2026-10-18', 'Jour'), [{ e: 'b-gest@x', v: 'V1' }, { e: 'b-gest@x', v: 'V3' }, { e: 'b-gest@x', v: 'V5' }, { e: 'new@x', v: 'V2' }, { e: 'new@x', v: 'V4' }]);
  assert.strictEqual(plan(ADMIN, '2026-10-18', 'Nuit').length, 5, 'seul de service : toute l\'agence');
  assert.deepStrictEqual(plan(ADMIN, '2026-10-19', 'Jour'), [], 'personne de service');
  // gestionnaire : voit la répartition de ses agences, ne peut pas modifier le planning
  assert.strictEqual(plan(MGR, '2026-10-18', 'Jour').length, 5);
  assert.throws(() => as(MGR, `insert into manager_shifts (agency_id, user_id, day, shift) values (1, '${MGR}', '2026-10-20', 'Jour')`), /row-level security/);
  as(MGR, `delete from manager_shifts where day = '2026-10-18'`);
  assert.strictEqual(env.psql(`select count(*) from manager_shifts`), '3', 'suppression sans effet pour un gestionnaire');
  assert.throws(() => as(MGR, `insert into manager_shifts (agency_id, user_id, day, shift) values (1, '${MGR}', '2026-10-20', 'Soir')`), /check|row-level/);
});

test('page Planning (administrateur) : cases du planning, répartition affichée, semaine reprise', async () => {
  env.psql('truncate manager_shifts');
  const { br, page, errors } = await openBrowser();
  page.on('dialog', d => d.accept());
  try {
    await login(page, '#/planning?a=1');
    await page.waitForSelector('table.plan');
    assert.deepStrictEqual(await page.$$eval('table.plan tbody td:first-child', t => t.map(x => x.innerText).filter(x => /@/.test(x))), ['b-gest@x', 'new@x']);
    await page.click(`.plc[data-u="${MGR}"][data-d="${cur.day}"][data-s="${cur.s}"]`);
    await page.waitForFunction(() => /new@x/.test((document.querySelector('.plsplit') || {}).innerText || ''));
    await page.click(`.plc[data-u="${M3}"][data-d="${cur.day}"][data-s="${cur.s}"]`);
    await page.waitForFunction(() => document.querySelectorAll('.plsplit .panel').length === 2);
    assert.match(await page.innerText('.plsplit'), /b-gest@x 3 véhicules[\s\S]*new@x 2 véhicules/);
    assert.strictEqual(env.psql(`select count(*) from manager_shifts where day = '${cur.day}' and shift = '${cur.s}'`), '2');
    // semaine suivante : reprise de la semaine affichée
    const p = cur.day.split('-').map(Number), wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(), next = lib.addDays(cur.day, 7 - ((wd + 6) % 7));
    await page.goto(`http://localhost:8080/#/planning?a=1&w=${next}`);
    await page.waitForFunction(w => document.querySelector('table.plan') && location.hash.includes(w), next);
    await page.click('#plcopy');
    await page.waitForFunction(() => document.querySelectorAll('.plc:checked').length === 2);
    assert.strictEqual(env.psql(`select count(*) from manager_shifts where day = '${lib.addDays(cur.day, 7)}'`), '2');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('gestionnaire de service : « Mes véhicules » dans le menu, pages limitées à sa part (désactivable)', async () => {
  env.psql(`truncate manager_shifts; insert into manager_shifts (agency_id, user_id, day, shift) values (1, '${MGR}', '${cur.day}', '${cur.s}'), (1, '${M3}', '${cur.day}', '${cur.s}')`);
  srv.kill(); srv = await startSite('pending');   // jeton du 2e compte (new@x), gestionnaire ici
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/vehicules');
    await page.waitForSelector('#mineon');
    assert.match(await page.innerText('.agsel.mine'), /Mes véhicules \(2\) · shift (jour|nuit) du/);
    assert.deepStrictEqual(await page.evaluate(() => ['V1', 'V2', 'V3', 'V4', 'V5', 'C1'].filter(inAgency())), ['V2', 'V4']);
    assert.strictEqual(await page.locator('.side nav a[href="#/planning"]').count(), 0, 'planning réservé à l\'administrateur');
    await page.click('#mineon');
    await page.waitForFunction(() => document.querySelector('#mineon') && !document.querySelector('#mineon').checked);
    assert.deepStrictEqual(await page.evaluate(() => ['V1', 'V2', 'V3', 'V4', 'V5'].filter(inAgency())), ['V1', 'V2', 'V3', 'V4', 'V5']);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); srv = await startSite(); }
});
