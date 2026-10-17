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
