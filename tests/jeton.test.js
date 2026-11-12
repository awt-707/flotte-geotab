// Jeton de connexion refusé (signalé par Ahmed le 12/11/2026 : « erreur de token » au manifeste dans l'application Android) :
// demande rejouée une fois avec un jeton renouvelé (site/jeton.js), PDF du manifeste joint dans WhatsApp par l'application.
const test = require('node:test'), assert = require('node:assert');
const { jwtRefused, jwtRetryFetch } = require('../site/jeton.js');

test('jeton refusé : reconnu (base, stockage), droits refusés jamais confondus', () => {
  assert.ok(jwtRefused(401, '{"code":"PGRST301","message":"JWT expired"}'));
  assert.ok(jwtRefused(400, '{"statusCode":"403","error":"Unauthorized","message":"jwt expired"}'));
  assert.ok(jwtRefused(400, '{"statusCode":"400","error":"InvalidJWT","message":"\\"exp\\" claim timestamp check failed"}'));
  assert.ok(!jwtRefused(400, '{"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}'));
  assert.ok(!jwtRefused(500, 'jwt'));
  assert.ok(!jwtRefused(409, '{"message":"duplicate key"}'));
});

test('jeton refusé : renouvelé une seule fois pour des demandes simultanées, demande rejouée avec le nouveau jeton', async () => {
  const B = 'https://x.supabase.co', calls = []; let refresh = 0;
  const inner = async (url, opt) => {
    const a = opt.headers.Authorization || opt.headers.get('Authorization'); calls.push([url, a]);
    return a === 'Bearer vieux' ? new Response('{"message":"JWT expired"}', { status: 401 }) : new Response('[]', { status: 200 });
  };
  const f = jwtRetryFetch(inner, { base: B, anon: 'anon', refresh: async () => { refresh++; await new Promise(r => setTimeout(r, 20)); return 'neuf'; } });
  const r = await Promise.all([f(B + '/rest/v1/trips', { headers: { Authorization: 'Bearer vieux' } }), f(B + '/storage/v1/object/m/a.pdf', { method: 'POST', headers: new Headers({ Authorization: 'Bearer vieux' }), body: 'x' })]);
  assert.deepStrictEqual(r.map(x => x.status), [200, 200]);
  assert.strictEqual(refresh, 1, 'un seul renouvellement');
  assert.deepStrictEqual(calls.map(c => c[1]).sort(), ['Bearer neuf', 'Bearer neuf', 'Bearer vieux', 'Bearer vieux']);
  // connexion (/auth/v1/), clé publique, autre adresse : jamais rejoué
  calls.length = 0;
  await f(B + '/auth/v1/token?grant_type=refresh_token', { headers: { Authorization: 'Bearer vieux' } });
  await f(B + '/rest/v1/x', { headers: { Authorization: 'Bearer anon' } });
  await f('https://photon.komoot.io/api', { headers: { Authorization: 'Bearer vieux' } });
  assert.strictEqual(calls.length, 3); assert.strictEqual(refresh, 1);
  // renouvellement impossible (session perdue) : réponse d'origine, avertissement
  let lost = 0;
  const g = jwtRetryFetch(inner, { base: B, anon: 'anon', refresh: async () => null, lost: () => { lost++; } });
  assert.strictEqual((await g(B + '/rest/v1/x', { headers: { Authorization: 'Bearer vieux' } })).status, 401);
  assert.strictEqual(lost, 1);
});

test('application Android : jeton expiré au dépôt du PDF du manifeste = renouvelé, PDF déposé ; WhatsApp envoie le PDF lui-même', async () => {
  const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');
  env.resetDb();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI');
    insert into parc (plate, model, seats, agrement) values ('WW968199', 'STARIA', 7, 'TT/1/2026');
    update manifest_config set stamp = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';`);
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 LudyAndroid/1.2' };
  const srv = await startSite(), { br, page, errors } = await openBrowser(PHONE);
  await page.context().addInitScript(() => { window.__shared = []; window.LudyAndroid = { share: (b64, name, mime, text, phone) => window.__shared.push({ n: b64.length, name, phone }), save: () => { } }; });
  let refused = 0, refreshed = 0;
  await page.route('**/storage/v1/object/manifestes/**', r => { if (r.request().method() === 'POST' && !refused++) return r.fulfill({ status: 400, contentType: 'application/json', body: '{"statusCode":"403","error":"Unauthorized","message":"jwt expired"}' }); return r.fallback(); });
  page.on('request', q => { if (/grant_type=refresh_token/.test(q.url())) refreshed++; });
  try {
    await page.goto('http://localhost:8080/#/manifeste');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#mfgen');
    await page.selectOption('#mfveh', '968199WW');
    await page.fill('#mfdrv', 'Chauffeur Test'); await page.fill('#mftel', '0611223344');
    await page.fill('#mfdon', 'Karim Bennani'); await page.fill('#mfcin', 'bk123456');
    await page.fill('#mfa', 'Aéroport Mohammed V, Casablanca'); await page.fill('#mfb', 'Hôtel Sofitel, Rabat');
    await page.click('#mfgen');
    await page.waitForSelector('#mfwa1');
    assert.strictEqual(refused, 2, 'premier dépôt refusé (jeton expiré), rejoué une fois');
    assert.ok(refreshed >= 1, 'jeton renouvelé');
    assert.strictEqual(await page.locator('#mfdone .warn').count(), 0, 'aucun avertissement : PDF déposé au second essai');
    assert.match(env.psql('select coalesce(file_path, \'-\') from manifests'), /^\d{4}-\d\d\/[\w-]+\.pdf$/);
    await page.click('#mfwa1');
    await page.waitForFunction(() => window.__shared.length === 1);
    const sh = await page.evaluate(() => window.__shared[0]);
    assert.deepStrictEqual([sh.phone, /^Manifeste-.*\.pdf$/.test(sh.name), sh.n > 1000], ['212611223344', true, true]);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
