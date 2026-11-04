// Bolt Fleet API : identifiants saisis dans Ludy (coffre lu par le collecteur seul), test de connexion (04/11/2026). Faux Bolt.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const last = s => s.split('\n').filter(Boolean).pop();

test('coffre : écrit par l\'administrateur seul, jamais relu par le site ; le secret n\'est pas renvoyé', () => {
  env.resetDb(); env.psql('truncate integration_secrets');
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'`);
  try {
    as(ADMIN, "select integration_set('bolt_client_id', 'ID-TEST'); select integration_set('bolt_client_secret', 'SECRET-TEST'); select integration_set('bolt_company_id', '392246')");
    assert.strictEqual(env.psql("select string_agg(name || '=' || value, ',' order by name) from integration_secrets"), 'bolt_client_id=ID-TEST,bolt_client_secret=SECRET-TEST,bolt_company_id=392246');
    assert.strictEqual(last(as(ADMIN, "select string_agg(name || ':' || coalesce(shown, '-'), ',' order by name) from integration_status()")), 'bolt_client_id:ID-TEST,bolt_client_secret:-,bolt_company_id:392246');
    assert.throws(() => as(ADMIN, 'select count(*) from integration_secrets'), /permission denied/, 'site : aucune lecture, même administrateur');
    assert.throws(() => as(MGR, "select integration_set('bolt_client_secret', 'x')"), /administrateur/);
    assert.throws(() => as(MGR, 'select * from integration_status()'), /administrateur/);
    assert.throws(() => as(ADMIN, "select integration_set('autre', 'x')"), /réglage inconnu/);
    assert.throws(() => as(ADMIN, "select integration_set('bolt_company_id', 'abc')"), /chiffres seulement/);
    as(ADMIN, "select integration_set('bolt_client_secret', '')");
    assert.strictEqual(env.psql("select count(*) from integration_secrets where name = 'bolt_client_secret'"), '0', 'vide = effacé');
  } finally { env.psql('truncate integration_secrets'); env.resetDb(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); }
});

test('collecteur : test de connexion Bolt (jeton, sociétés, courses de la société), administrateur seul', () => {
  const B = collector(Date.UTC(2026, 10, 4, 12, 0));
  env.psql('truncate integration_secrets');
  try {
    // faux Bolt : jeton pour le bon couple, sociétés refusées (comme au 04/11/2026), 2 courses pour la société 392246
    B.ctx.__bolt = [];
    B.run(`var __f0 = UrlFetchApp.fetch; UrlFetchApp.fetch = function (u, o) {
      if (u.indexOf('oidc.bolt.eu') >= 0 || u.indexOf('node.bolt.eu') >= 0) { __bolt.push({ u, o });
        const r = (c, b) => ({ getResponseCode: () => c, getContentText: () => JSON.stringify(b) });
        if (u.indexOf('/token') >= 0) return o.payload.client_secret === 'SECRET-TEST' ? r(200, { access_token: 'TOK', expires_in: 600 }) : r(401, { error: 'invalid_client' });
        if (u.indexOf('/getCompanies') >= 0) return r(200, { code: 503, message: 'NOT_AUTHORIZED' });
        if (u.indexOf('/getFleetOrders') >= 0) { const p = JSON.parse(o.payload); return p.company_id === 392246 ? r(200, { code: 0, data: { orders: [{}, {}] } }) : r(200, { code: 503, message: 'NOT_AUTHORIZED' }); }
      } return __f0(u, o); }`);
    assert.match(B.run(`jobBoltTest_('${MGR}')`), /réservé à l'administrateur/);
    assert.match(B.run(`jobBoltTest_('${ADMIN}')`), /identifiant ou secret manquant/);
    env.psql("insert into integration_secrets (name, value) values ('bolt_client_id', 'ID-TEST'), ('bolt_client_secret', 'FAUX')");
    assert.match(B.run(`jobBoltTest_('${ADMIN}')`), /identifiants refusés par Bolt \(HTTP 401, invalid_client\)/);
    env.psql("update integration_secrets set value = 'SECRET-TEST' where name = 'bolt_client_secret'; insert into integration_secrets (name, value) values ('bolt_company_id', '392246, 111')");
    const r = B.run(`jobBoltTest_('${ADMIN}')`);
    assert.match(r, /jeton d'accès obtenu/); assert.match(r, /liste des sociétés : la clé n'a pas accès/);
    assert.match(r, /société 392246 : 2 course\(s\) lue\(s\) sur les dernières 24 h/); assert.match(r, /société 111 : la clé n'a pas accès[^;]*NOT_AUTHORIZED/);
    const call = B.ctx.__bolt.find(x => x.u.indexOf('/getFleetOrders') >= 0);
    assert.strictEqual(call.o.headers.Authorization, 'Bearer TOK');
    assert.deepStrictEqual(Object.keys(JSON.parse(call.o.payload)).sort(), ['company_id', 'company_ids', 'end_ts', 'limit', 'offset', 'start_ts', 'time_range_filter_type']);
    assert.strictEqual(B.ctx.__bolt.filter(x => x.u.indexOf('/token') >= 0 && x.o.payload.client_secret === 'SECRET-TEST').length, 1);
    B.run(`jobBoltTest_('${ADMIN}')`);
    assert.strictEqual(B.ctx.__bolt.filter(x => x.u.indexOf('/token') >= 0 && x.o.payload.client_secret === 'SECRET-TEST').length, 1, 'jeton gardé en cache');
  } finally { env.psql('truncate integration_secrets'); }
});

test('page Réglages : identifiants Bolt enregistrés, secret jamais réaffiché, test de connexion demandé au collecteur', async () => {
  env.resetDb(); env.psql('truncate integration_secrets');
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/reglages');
    await page.waitForSelector('#bolsave');
    await page.fill('#bolid', 'ID-TEST'); await page.fill('#bolsec', 'SECRET-TEST'); await page.fill('#bolco', '392246');
    await page.click('#bolsave');
    await page.waitForFunction(() => /Identifiants Bolt enregistrés/.test((document.querySelector('#bolres') || {}).innerText || ''));
    assert.strictEqual(env.psql("select string_agg(name || '=' || value, ',' order by name) from integration_secrets"), 'bolt_client_id=ID-TEST,bolt_client_secret=SECRET-TEST,bolt_company_id=392246');
    assert.strictEqual(await page.inputValue('#bolsec'), '', 'secret jamais réaffiché');
    assert.doesNotMatch(await page.content(), /SECRET-TEST/);
    assert.match(await page.innerText('#boltbox'), /enregistré le/);
    await page.click('#boltest');
    await page.waitForFunction(() => /Test demandé/.test(document.querySelector('#bolres').innerText));
    for (let i = 0; i < 50 && !env.psql("select count(*) from jobs where kind = 'bolt_test'").startsWith('1'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(env.psql("select kind from jobs order by id desc limit 1"), /^bolt_test$/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql('truncate integration_secrets'); env.resetDb(); }
});
