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

test('pastille : compte des utilisateurs en ligne (signal de moins de 3 min, déconnectés exclus, un par utilisateur)', () => {
  const now = Date.parse('2026-10-23T10:00:00Z'), ago = m => new Date(now - m * 60000).toISOString(), { sessOnline } = require('../site/connexions.js');
  assert.strictEqual(sessOnline([{ user_id: 'a', last_seen: ago(1) }, { user_id: 'a', last_seen: ago(2), page: 'Alertes' }, { user_id: 'b', last_seen: ago(1), page: 'Déconnecté' },
    { user_id: 'c', last_seen: ago(4) }, { user_id: 'd', last_seen: ago(0.5), page: 'En direct' }], now), 2);
  assert.strictEqual(sessOnline([], now), 0);
});

test('menu gardé d\'une page à l\'autre : pastille des connectés, collecte et alertes jamais effacées, user_sessions pas relu à chaque page ; rien gardé pour le compte suivant', async () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into alerts (id, day, time, plate, vehicle_key, type, severity, detail) values ('PASTILLE1', current_date, '10:00', 'WW1', 'V1', 'Siphonage', 'Critique', '30 L')`);
  let srv = await startSite();
  const { br, page, errors } = await openBrowser();
  let reads = 0; page.on('request', r => { if (r.method() === 'GET' && /\/rest\/v1\/user_sessions/.test(r.url())) reads++; });
  const open = async (p, h1) => {
    await page.click(`.side nav a[href="#/${p}"]`);
    await page.waitForFunction(([p, h1]) => location.hash === '#/' + p && !document.querySelector('#page .loading') && ((document.querySelector('#page h1') || {}).innerText || '').startsWith(h1), [p, h1], { timeout: 15000 });
  };
  try {
    ping(MGR, 'onglet-gestionnaire-3', 'Alertes', true);
    await login(page, '#/plaques');
    await page.waitForFunction(() => { const o = document.querySelector('#onl'), n = document.querySelector('#nbal'), h = document.querySelector('#health');
      return o && !o.hidden && /2 connectés/.test(o.textContent) && n && !n.hidden && n.textContent === '1' && h && /Collecte :/.test(h.textContent); });
    // chaque changement du bas du menu enregistré : pastille masquée ou vide, « Collecte… », pastille Alertes masquée
    await page.evaluate(() => {
      window.__side = document.querySelector('.side'); window.__bad = [];
      window.__mo = new MutationObserver(() => { const o = document.querySelector('#onl'), h = document.querySelector('#health'), n = document.querySelector('#nbal');
        if (!o || o.hidden || !/● 2 connectés/.test(o.textContent)) window.__bad.push('pastille ' + (o ? (o.hidden ? 'masquée' : '« ' + o.textContent + ' »') : 'absente'));
        if (!h || !/Collecte :/.test(h.textContent)) window.__bad.push('collecte ' + (h ? '« ' + h.textContent + ' »' : 'absente'));
        if (!n || n.hidden || n.textContent !== '1') window.__bad.push('alertes ' + (n ? (n.hidden ? 'masquée' : '« ' + n.textContent + ' »') : 'absente'));
      }); window.__mo.observe(document.querySelector('#app'), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const t0 = Date.now();
    const before = reads;
    for (const [p, h1] of [['contrats', 'Contrats'], ['vehicules', 'Véhicules'], ['alertes', 'Alertes'], ['agences', 'Agences'], ['plaques', 'Changements de plaque'], ['contrats', 'Contrats']]) {
      await open(p, h1);
      assert.match(await page.getAttribute(`.side nav a[href="#/${p}"]`, 'class'), /\bon\b/);
      assert.deepStrictEqual(await page.$$eval('.side nav a[aria-current]', a => a.map(x => x.getAttribute('href'))), ['#/' + p]);
    }
    assert.deepStrictEqual(await page.evaluate(() => window.__bad.slice(0, 5)), [], 'bas du menu effacé pendant un changement de page');
    assert.ok(await page.evaluate(() => document.querySelector('.side') === window.__side), 'menu reconstruit en changeant de page');
    // avant : une lecture par page (6) ; maintenant au plus toutes les 45 s en changeant de page, plus le signal de la minute
    const sec = (Date.now() - t0) / 1000;
    assert.ok(reads - before <= 1 + Math.ceil(sec / 45), 'user_sessions relu ' + (reads - before) + ' fois pour 6 pages en ' + Math.round(sec) + ' s');
    // page Connexions : pastille mise à jour par sa propre lecture, sans attendre
    env.psql("update user_sessions set page = 'Déconnecté' where id = 'onglet-gestionnaire-3'");
    await page.evaluate(() => window.__mo.disconnect());
    await open('connexions', 'Connexions');
    await page.waitForFunction(() => /^● 1 connecté$/.test(document.querySelector('#onl').textContent));
    // déconnexion : compte des connectés, collecte et alertes oubliés
    await page.click('#logout'); await page.waitForSelector('#lf');
    assert.deepStrictEqual(await page.evaluate(() => [SESS.badge, S.health, S.nbal, SHELL_KEY]), [null, null, null, '']);
    // même onglet, autre compte (gestionnaire sans agence) : ni pastille des connectés ni compte d'alertes de l'administrateur
    await new Promise(r => { srv.once('exit', r); srv.kill(); }); srv = await startSite('pending');
    await page.evaluate(() => { location.hash = '#/plaques'; }); await page.waitForSelector('#lf');
    await page.fill('#le', 'new@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('.side nav');
    await page.waitForFunction(mgr => S.health && S.health.uid === mgr && S.nbal && S.nbal.k.startsWith(mgr) && /Collecte :/.test(document.querySelector('#health').textContent), MGR);
    assert.strictEqual(await page.locator('#onl').count(), 0, 'pastille des connectés réservée à l\'administrateur');
    assert.strictEqual(await page.evaluate(() => SESS.badge), null);
    assert.ok(await page.evaluate(() => document.querySelector('#nbal').hidden && S.nbal.n === 0), 'alertes de l\'administrateur non montrées au gestionnaire');
    assert.match(await page.innerText('.side .who'), /new@x|mgr@x/);
    assert.deepStrictEqual(errors, []);
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; delete from user_sessions; delete from alerts where id = 'PASTILLE1'`); await br.close(); srv.kill(); }
});
