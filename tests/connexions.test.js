// Connexions en temps réel : signal de chaque onglet ouvert, liste des connectés réservée à l'administrateur
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser'), { sessGroup } = require('../site/connexions.js'), { sessHistory, sessDur } = require('../site/connexions.js');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const ping = (uid, id, page, active) => as(uid, `select public.session_ping('${id}', '${page}', 'Navigateur · Mac', ${active})`);

test('signal des onglets : chacun écrit seulement sa session ; l\'administrateur voit tout le monde', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager'`);
  try {
    ping(MGR, 'onglet-gestionnaire-1', 'En direct', true);
    ping(MGR, 'onglet-gestionnaire-1', 'Alertes', false);   // même onglet : mis à jour, pas dupliqué
    assert.strictEqual(env.psql("select count(*) || '|' || max(page) || '|' || bool_or(active) from user_sessions"), '1|Alertes|false');
    // un autre utilisateur ne peut pas reprendre l'onglet du gestionnaire ni écrire au nom d'un autre
    ping(ADMIN, 'onglet-gestionnaire-1', 'Réglages', true);
    assert.strictEqual(env.psql("select user_id || '|' || page from user_sessions where id = 'onglet-gestionnaire-1'"), MGR + '|Alertes');
    assert.throws(() => as(MGR, `insert into user_sessions (id, user_id, page) values ('xxxxxxxx-faux', '${ADMIN}', 'x')`), /permission denied/);
    ping(ADMIN, 'onglet-admin-1', 'Connexions', true);
    assert.strictEqual(as(MGR, 'select count(*) from user_sessions'), '1', 'le gestionnaire ne voit que sa session');
    assert.strictEqual(as(ADMIN, 'select count(*) from user_sessions'), '2', 'l\'administrateur voit tout le monde');
    assert.throws(() => env.psql("begin; set local role anon; select count(*) from user_sessions; commit;"), /permission denied/);
    // déconnexion : la session disparaît
    as(MGR, "delete from user_sessions where id = 'onglet-gestionnaire-1'");
    assert.strictEqual(env.psql('select count(*) from user_sessions'), '1');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; delete from user_sessions`); }
});

test('statut : en ligne (signal récent et onglet utilisé), inactif (ouvert sans activité), hors ligne', () => {
  const now = Date.parse('2026-10-21T20:00:00Z'), ago = m => new Date(now - m * 60000).toISOString();
  const P = [{ user_id: 'a', email: 'a@x', role: 'admin' }, { user_id: 'b', email: 'b@x', role: 'manager' }, { user_id: 'c', email: 'c@x', role: 'viewer' }, { user_id: 'd', email: 'd@x', role: 'pending' }];
  const R = [{ user_id: 'a', last_seen: ago(1), started_at: ago(50), active: true, page: 'En direct', client: 'Application 1.4.0 · Mac' },
    { user_id: 'a', last_seen: ago(2), started_at: ago(20), active: false, page: 'Alertes', client: 'Navigateur · iPhone / iPad' },
    { user_id: 'b', last_seen: ago(2), started_at: ago(90), active: false, page: 'Carburant' }, { user_id: 'c', last_seen: ago(40), started_at: ago(60), active: true }];
  const g = sessGroup(P, R, now);
  assert.deepStrictEqual(g.map(x => [x.p.email, x.st, x.live.length, x.page]), [['a@x', 'En ligne', 2, 'En direct'], ['b@x', 'Inactif', 1, 'Carburant'], ['c@x', 'Hors ligne', 0, '']]);
  assert.strictEqual(g[0].since, ago(50));
});

test('page Connexions : l\'administrateur voit qui est en ligne, sur quelle page, et la pastille du menu', async () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager'`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    ping(MGR, 'onglet-gestionnaire-2', 'Courses privées', true);
    await login(page, '#/connexions');
    await page.waitForSelector('#tsess');
    await page.waitForFunction(() => /En ligne/.test(document.querySelector('#tsess').innerText) && /admin@x[\s\S]*Connexions/.test(document.querySelector('#tsess').innerText));
    const t = await page.innerText('#tsess');
    assert.match(t, /Gestionnaire\tEn ligne\tCourses privées[\s\S]*Navigateur · Mac/);
    await page.waitForFunction(() => /2 connectés/.test((document.querySelector('#onl') || {}).textContent || ''));
    assert.strictEqual(env.psql("select count(*) from user_sessions where user_id = '" + ADMIN + "'"), '1', 'l\'onglet de l\'administrateur envoie son signal');
    // historique des connexions (30 jours)
    await page.waitForSelector('#thist');
    assert.match(await page.innerText('#thist'), /admin@x[\s\S]*en cours/);
    const mgrMail = env.psql(`select email from profiles where user_id = '${MGR}'`);
    assert.ok((await page.innerText('#thsum')).includes(mgrMail), 'le gestionnaire figure dans l\'historique');
    await page.selectOption('#shu', MGR); await page.waitForFunction(() => { const t = document.querySelector('#thist'); return t && /new@x|mgr@x|Gestionnaire/.test(t.innerText) && !/admin@x/.test(t.innerText); });
    // déconnexion : la session est close tout de suite, gardée dans l'historique
    await page.click('#logout'); await page.waitForSelector('#lf');
    assert.strictEqual(env.psql("select page || '|' || active from user_sessions where user_id = '" + ADMIN + "'"), 'Déconnecté|false');
    assert.deepStrictEqual(errors, []);
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; delete from user_sessions`); await br.close(); srv.kill(); }
});

test('historique : pages rechargées réunies, déconnexion, connexion en cours, durée', () => {
  const now = Date.parse('2026-10-22T12:00:00Z'), at = m => new Date(now - m * 60000).toISOString();
  const P = [{ user_id: 'a', email: 'a@x', role: 'admin' }, { user_id: 'b', email: 'b@x', role: 'manager' }];
  const R = [
    { user_id: 'a', client: 'Navigateur · Mac', started_at: at(300), last_seen: at(240), page: 'Alertes' },   // rechargée 1 min après : même connexion
    { user_id: 'a', client: 'Navigateur · Mac', started_at: at(239), last_seen: at(200), page: 'Déconnecté' },
    { user_id: 'a', client: 'Navigateur · Mac', started_at: at(30), last_seen: at(1), page: 'En direct' },     // en cours
    { user_id: 'b', client: 'Application 1.4.0 · Windows', started_at: at(100), last_seen: at(80), page: 'Courses privées' }];
  const h = sessHistory(P, R, now);
  assert.deepStrictEqual(h.map(x => [x.p.email, x.n, Math.round(x.dur / 60000), x.live, x.off, x.page]),
    [['a@x', 1, 29, true, false, 'En direct'], ['b@x', 1, 20, false, false, 'Courses privées'], ['a@x', 2, 100, false, true, 'Déconnecté']]);
  assert.deepStrictEqual([sessDur(20000), sessDur(29 * 60000), sessDur(100 * 60000)], ['moins d\'1 min', '29 min', '1 h 40']);
});
