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
