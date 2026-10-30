// Volets externes de l'application (Uber Fleet, Clicar… réglés dans Réglages) et volets visibles par utilisateur
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
const MGR = '22222222-2222-2222-2222-222222222222';
const DEF = '[{"id":"uber","name":"Uber Fleet","url":"https://fleethub.uber.com/orgs/test/livemap?tab=4"},{"id":"clicar","name":"Clicar","url":"https://new.clicar.ma/"}]';
let srv;
test.before(async () => {
  env.psql(`insert into params (key, label, value, sort) values ('appSites', 'Volets externes', '${DEF}', 90) on conflict (key) do update set value = excluded.value;
    update profiles set role = 'manager', pages = null where user_id = '${MGR}'`);
  srv = await startSite();
});
test.after(() => { if (srv) srv.kill(); env.psql(`update profiles set role = 'pending', pages = null where user_id = '${MGR}'`); });

// application 1.2 simulée : window.LUDY_APP + commandes enregistrées dans window.__calls
async function appBrowser(extWin) {
  const o = await openBrowser();
  await o.page.context().addInitScript(w => {
    window.LUDY_APP = { version: w ? '1.6.0' : '1.2.0', uber: 'https://fleethub.uber.com/orgs/test/livemap?tab=4', embed: true, ext: true, open: !!w, extWin: !!w };
    window.__calls = []; window.__TAURI_INTERNALS__ = { invoke: (c, a) => { window.__calls.push([c, a]); return Promise.resolve(c === 'ext_status' ? { saved: false, user: '' } : null); } };
  }, !!extWin);
  return o;
}
const calls = (page, c) => page.evaluate(c => window.__calls.filter(x => x[0] === c).map(x => x[1]), c);

test('application 1.2 : Uber Fleet et Clicar dans le menu, volet posé sous sa barre, accès réservé enregistré dans l\'application', async () => {
  const { br, page, errors } = await appBrowser();
  try {
    await login(page, '#/tableau');
    await page.waitForSelector('.navext');
    assert.deepStrictEqual(await page.$$eval('.navext', as => as.map(a => a.textContent + ' ' + a.getAttribute('href'))), ['Clicar #/x-clicar', 'Uber Fleet #/x-uber']);
    await page.click('.navext[data-ext="clicar"]');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_show'));
    const s = (await calls(page, 'ext_show')).pop(), bar = await page.evaluate(() => document.querySelector('#extbar').getBoundingClientRect().bottom);
    assert.strictEqual(s.id, 'clicar'); assert.strictEqual(s.url, 'https://new.clicar.ma/');
    assert.ok(s.y >= bar && s.y + s.h === 900 && s.x > 100, JSON.stringify(s));
    // accès réservé : volet masqué pendant la saisie, identifiant enregistré puis volet rechargé et réaffiché
    await page.click('#extlog');
    await page.waitForSelector('#exu');
    assert.ok((await calls(page, 'ext_hide')).length >= 1);
    await page.fill('#exu', 'agence'); await page.fill('#exp', 'mot-de-passe');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#exsave');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_show'));
    assert.deepStrictEqual(await page.evaluate(() => window.__calls.map(c => c[0])), ['ext_login', 'ext_reload', 'ext_show']);
    assert.deepStrictEqual((await calls(page, 'ext_login'))[0], { url: 'https://new.clicar.ma/', user: 'agence', pass: 'mot-de-passe' });
    // autre volet externe puis volet Ludy
    await page.click('.navext[data-ext="uber"]');
    await page.waitForFunction(() => window.__calls.filter(c => c[0] === 'ext_show').length === 2);
    assert.strictEqual((await calls(page, 'ext_show')).pop().id, 'uber');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('.side nav a[href="#/tableau"]');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_hide'));
    // volet externe déjà masqué : pas de nouvel ext_hide d'une page Ludy à l'autre (sous Windows, le focus rendu bloque la molette)
    await page.evaluate(() => { window.__calls = []; });
    await page.click('.side nav a[href="#/alertes"]'); await page.waitForTimeout(800);
    assert.deepStrictEqual(await calls(page, 'ext_hide'), []);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('application 1.6 sous Windows : chaque volet dans sa propre fenêtre (nom transmis), jamais masqué en changeant de page', async () => {
  const { br, page, errors } = await appBrowser(true);
  try {
    await login(page, '#/tableau');
    await page.waitForSelector('.navext');
    await page.click('.navext[data-ext="uber"]');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_show'));
    const s = (await calls(page, 'ext_show')).pop();
    assert.deepStrictEqual([s.id, s.name, s.url], ['uber', 'Uber Fleet', 'https://fleethub.uber.com/orgs/test/livemap?tab=4']);
    assert.match(await page.innerText('#extzone'), /s'ouvre dans sa propre fenêtre/);
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#extwin');   // ramener la fenêtre au premier plan
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'ext_show'));
    await page.setViewportSize({ width: 1200, height: 800 }); await page.waitForTimeout(300);
    assert.strictEqual((await calls(page, 'ext_show')).length, 1, 'pas de nouveau placement au redimensionnement');
    await page.click('.side nav a[href="#/tableau"]'); await page.waitForTimeout(800);
    assert.deepStrictEqual(await calls(page, 'ext_hide'), [], 'fenêtre laissée ouverte');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('Réglages > Volets externes : ajout et retrait d\'un site sans nouvelle application, https obligatoire', async () => {
  const { br, page, errors } = await appBrowser();
  page.on('dialog', d => d.accept());
  try {
    await login(page, '#/reglages');
    await page.waitForSelector('#exadd');
    await page.fill('#exnn', 'Essai'); await page.fill('#exnu', 'http://exemple.ma/'); await page.click('#exadd');
    await page.waitForSelector('#exres .msg.err');
    await page.fill('#exnn', 'Essai'); await page.fill('#exnu', 'https://exemple.ma/'); await page.click('#exadd');
    await page.waitForFunction(() => document.querySelectorAll('#text tbody tr').length === 3);
    const v = JSON.parse(env.psql("select value from params where key = 'appSites'"));
    assert.deepStrictEqual(v.map(x => x.id + '=' + x.url), ['uber=https://fleethub.uber.com/orgs/test/livemap?tab=4', 'clicar=https://new.clicar.ma/', 'essai=https://exemple.ma/']);
    await page.waitForSelector('.navext[data-ext="essai"]');
    await page.click('[data-exdel="2"]');
    await page.click('.uidlg #uiok');   // application : confirmation dessinée par le site (WKWebView n'affiche pas confirm())
    await page.waitForFunction(() => document.querySelectorAll('#text tbody tr').length === 2);
    assert.strictEqual(JSON.parse(env.psql("select value from params where key = 'appSites'")).length, 2);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('volets visibles par utilisateur : l\'administrateur choisit, le gestionnaire ne voit que ceux-là', async () => {
  let o = await appBrowser();
  try {
    await login(o.page, '#/reglages');
    await o.page.click(`[data-upg="${MGR}"]`);
    await o.page.click('#upgnone');
    for (const k of ['direct', 'carburant', 'x-clicar']) await o.page.check(`.upgc[value="${k}"]`);
    await o.page.click('#upgsave');
    await o.page.waitForSelector('#upgbox .msg.ok');
    assert.strictEqual(env.psql(`select array_to_string(pages, ',') from profiles where user_id = '${MGR}'`), 'direct,carburant,x-clicar');
    assert.deepStrictEqual(o.errors, []);
  } finally { await o.br.close(); }
  // le gestionnaire ne peut pas changer ses propres volets
  env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${MGR}","role":"authenticated"}'; update profiles set pages = null where user_id = '${MGR}'; commit;`);
  assert.strictEqual(env.psql(`select array_to_string(pages, ',') from profiles where user_id = '${MGR}'`), 'direct,carburant,x-clicar');
  srv.kill(); srv = await startSite('pending');
  o = await appBrowser();
  try {
    await login(o.page, '#/tableau');
    await o.page.waitForFunction(() => location.hash === '#/direct', null, { timeout: 15000 });
    const nav = await o.page.$$eval('.side nav a', as => as.map(a => a.getAttribute('href')));
    assert.deepStrictEqual(nav, ['#', '#/carburant', '#/x-clicar', '#/direct', '#/menu']);   // « Toutes les pages » (#)   // ordre alphabétique : Carburant, Clicar, En direct ; puis Personnaliser le menu
    await o.page.goto('http://localhost:8080/#/x-uber');
    await o.page.waitForFunction(() => location.hash === '#/direct');
    await o.page.goto('http://localhost:8080/#/application');
    await o.page.waitForFunction(() => /Application Ludy/.test((document.querySelector('#page h1') || {}).innerText || ''));
  } finally { await o.br.close(); srv.kill(); srv = await startSite(); }
});

test('application plus ancienne que la dernière publiée : mise à jour proposée en bas du menu et sur la page Application', async () => {
  const { br, page, errors } = await appBrowser();
  try {
    await page.context().route(/storage\/v1\/object\/public\/app\/version\.json/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"version":"1.10.0"}' }));
    await login(page, '#/application');
    await page.waitForSelector('#appupd');
    assert.match(await page.innerText('#appupd'), /1\.10\.0/);
    await page.goto('http://localhost:8080/#/tableau'); await page.goto('http://localhost:8080/#/application');
    await page.waitForFunction(() => /la version 1\.10\.0 est disponible/.test(document.querySelector('#page').innerText));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('application : liens WhatsApp et e-mail ouverts par le système (1.3), message copié avec l\'application 1.2', async () => {
  for (const [ver, open] of [['1.3.0', true], ['1.2.0', false]]) {
    const o = await openBrowser();
    const { br, page, errors } = o;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.context().addInitScript(([v, op]) => {
      window.LUDY_APP = { version: v, uber: 'https://fleethub.uber.com/orgs/test/livemap?tab=4', embed: true, ext: true, open: op };
      window.__calls = []; window.__TAURI_INTERNALS__ = { invoke: (c, a) => { window.__calls.push([c, a]); return Promise.resolve(null); } };
    }, [ver, open]);
    try {
      await login(page, '#/tableau');
      await page.waitForSelector('#page h1');
      const wa = 'https://wa.me/212612345678?text=' + encodeURIComponent('📄 Ludy · Manifeste\nTrajet : A → B'), ml = 'mailto:dret@exemple.ma?subject=Manifeste&body=' + encodeURIComponent('Bonjour\nCi-joint');
      await page.evaluate(([w, m]) => { document.querySelector('#page').insertAdjacentHTML('beforeend', `<a id="lwa" href="${w}" target="_blank" rel="noopener">WA</a> <a id="lml" href="${m}">Mail</a>`); }, [wa, ml]);
      await page.click('#lwa'); await page.click('#lml');
      await page.waitForTimeout(300);
      assert.strictEqual(page.url().startsWith('http://localhost:8080/'), true, 'la page Ludy reste affichée');
      if (open) assert.deepStrictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'open_external').map(c => c[1].url)), [wa, ml]);
      else {
        assert.strictEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'open_external').length), 0);
        assert.match(await page.innerText('#toasts'), /Message copié : collez-le dans votre messagerie/);
        assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Bonjour\nCi-joint');
      }
      assert.deepStrictEqual(errors, []);
    } finally { await br.close(); }
  }
});
