// Thème du site : clair par défaut même si l'appareil est en mode sombre ; Sombre / Auto au choix, mémorisé
const test = require('node:test'), assert = require('node:assert');
const { startSite, openBrowser, login } = require('./lib/browser');
let srv;
test.before(async () => { srv = await startSite(); });
test.after(() => { if (srv) srv.kill(); });

test('appareil en mode sombre : site clair par défaut, choix Sombre puis Auto mémorisés', async () => {
  const { br, page, errors } = await openBrowser({ colorScheme: 'dark' });
  try {
    await login(page, '#/reglages');
    await page.waitForSelector('#themesel');
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = c => { const m = c.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; };
    assert.ok(lum(await bg()) > 180, 'fond clair par défaut : ' + await bg());
    await page.selectOption('#themesel', 'dark');
    assert.ok(lum(await bg()) < 80, 'fond sombre : ' + await bg());
    await page.reload(); await page.waitForSelector('#themesel');
    assert.strictEqual(await page.inputValue('#themesel'), 'dark');
    assert.ok(lum(await bg()) < 80, 'choix mémorisé');
    await page.selectOption('#themesel', 'auto');
    assert.ok(lum(await bg()) < 80, 'auto = appareil (sombre)');
    await page.selectOption('#themesel', 'light');
    assert.ok(lum(await bg()) > 180);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('application Ludy : volet Uber Fleet seulement dans l\'application (window.LUDY_APP), page de téléchargement', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/application');
    await page.waitForFunction(() => /Application Ludy/.test((document.querySelector('#page h1') || {}).innerText || ''));
    assert.strictEqual(await page.locator('#navuber').count(), 0, 'pas de volet Uber dans un navigateur');
    assert.strictEqual(await page.locator('.side .foot a.dlapp').count(), 1);
    const links = await page.$$eval('.appdl a.btn', as => as.map(a => a.href));
    assert.deepStrictEqual(links.map(h => h.replace(/^.*\/public\//, '')), ['app/Ludy.dmg', 'app/Ludy-setup.exe']);
    // dans l'application : script injecté avant le site
    await page.context().addInitScript(() => { window.LUDY_APP = { version: '1.0.0', uber: 'https://fleethub.uber.com/orgs/test/livemap?tab=4' }; });
    await page.context().route(/fleethub\.uber\.com/, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Uber</title><h1>Fleet Hub</h1>' }));
    await page.reload(); await page.waitForSelector('#navuber');
    assert.strictEqual(await page.locator('.side .foot a.dlapp').count(), 0);
    assert.match(await page.innerText('#page'), /Vous êtes dans l'application Ludy \(version 1\.0\.0\)/);
    await Promise.all([page.waitForURL(/fleethub\.uber\.com/), page.click('#navuber')]);
    assert.strictEqual(await page.innerText('h1'), 'Fleet Hub');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('application 1.1 : volet Uber Fleet posé à droite du menu (uber_show), masqué en changeant de volet (uber_hide)', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await page.context().addInitScript(() => {
      window.LUDY_APP = { version: '1.1.0', uber: 'https://fleethub.uber.com/orgs/test/livemap?tab=4', embed: true };
      window.__calls = []; window.__TAURI_INTERNALS__ = { invoke: (c, a) => { window.__calls.push([c, a]); return Promise.resolve(); } };
    });
    await login(page, '#/tableau');
    await page.waitForSelector('.navext[data-ext="uber"]');
    assert.strictEqual(await page.getAttribute('.navext[data-ext="uber"]', 'href'), '#/x-uber');
    await page.click('.navext[data-ext="uber"]');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'uber_show'));
    const show = (await page.evaluate(() => window.__calls)).filter(c => c[0] === 'uber_show').pop()[1];
    const side = await page.evaluate(() => document.querySelector('.side').getBoundingClientRect().width);
    const bar = await page.evaluate(() => document.querySelector('#extbar').getBoundingClientRect().bottom);
    assert.ok(show.x >= side - 1 && show.y >= bar && show.w > 600 && show.y + show.h === 900, 'zone de contenu à droite du menu, sous la barre : ' + JSON.stringify(show) + ' menu ' + side);
    assert.match(await page.getAttribute('.navext[data-ext="uber"]', 'class'), /on/);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForFunction(() => { const c = window.__calls.filter(c => c[0] === 'uber_show').pop()[1]; return c.y + c.h === 800; });
    await page.evaluate(() => { window.__calls = []; });
    await page.click('.side nav a[href="#/tableau"]');
    await page.waitForFunction(() => window.__calls.some(c => c[0] === 'uber_hide'));
    assert.ok(!(await page.evaluate(() => window.__calls)).some(c => c[0] === 'uber_show'));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('nouvelle version du site publiée pendant que la page est ouverte : bandeau, rechargement au changement de page ; en-têtes des colonnes de chiffres alignés à droite', async () => {
  const { br, page, errors } = await openBrowser();
  let build = 'aaaaaaa';
  await page.route('**/build.txt', r => r.fulfill({ status: 200, contentType: 'text/plain', body: build + '\n' }));
  try {
    await login(page, '#/reglages');
    await page.waitForSelector('#themesel');
    await page.evaluate(() => siteBuildCheck());
    assert.strictEqual(await page.$('#siteupd'), null, 'même version : pas de bandeau');
    // colonne de chiffres d'un rapport : en-tête à droite comme les chiffres
    const al = await page.evaluate(() => { const d = document.createElement('div'); d.className = 'rpt'; d.innerHTML = '<table class="rtab"><tr><th class="n">Km</th><th>Plaque</th></tr><tr><td class="n">1</td><td>x</td></tr></table>'; document.body.appendChild(d);
      const r = [...d.querySelectorAll('th,td')].map(e => getComputedStyle(e).textAlign); d.remove(); return r; });
    assert.deepStrictEqual(al.map(x => x === 'start' ? 'left' : x), ['right', 'left', 'right', 'left']);
    build = 'bbbbbbb';
    await page.evaluate(() => { window.__avant = 1; return siteBuildCheck(); });
    await page.waitForSelector('#siteupd');
    await page.evaluate(() => { location.hash = '#/alertes'; });
    await page.waitForFunction(() => !window.__avant && location.hash === '#/alertes' && document.querySelector('.side'));
    assert.strictEqual(await page.$('#siteupd'), null, 'nouvelle version chargée : plus de bandeau');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});
