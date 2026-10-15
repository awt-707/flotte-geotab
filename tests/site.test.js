// Le site sur une base remplie par le collecteur : chaque page s'affiche sans erreur, sur ordinateur et sur téléphone
const test = require('node:test'), assert = require('node:assert'), path = require('path');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6'), { startSite, openBrowser, login } = require('./lib/browser');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
let srv, B;

test.before(async () => {
  const A = sheetV6(NOW);
  B = collector(NOW); B.run('installer()'); copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-09-29' }])");
  for (let i = 0; i < 4; i++) { B.setNow(NOW + i * 5 * 60000); B.run('collect()'); }   // 4 passages : journées finalisées, journal et alertes calculés
  srv = await startSite();
});
test.after(() => { if (srv) srv.kill(); });

const PAGES = [['direct', 'En direct', /En route|Garé|Arrêté/], ['tableau', 'Tableau de bord', /Km parcourus/], ['jour', 'Journée du', /Journées de travail actives/],
  ['chauffeurs', 'Classement des chauffeurs', /Score/], ['alertes', 'Alertes', /Gravité/], ['contrats', 'Contrats', /Contrats des 40 derniers jours/],
  ['plaques', 'Changements de plaque', /Ancienne plaque/], ['vehicules', 'Véhicules', /WW968194/], ['reglages', 'Réglages', /Journal technique/]];

for (const [viewport, size] of [['ordinateur', { width: 1440, height: 900 }], ['téléphone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  test('toutes les pages sur ' + viewport, async () => {
    const { br, page, errors } = await openBrowser({ viewport: { width: size.width, height: size.height }, isMobile: size.isMobile, hasTouch: size.hasTouch });
    await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
    try {
      await login(page);
      for (const [p, title, content] of PAGES) {
        await page.goto('http://localhost:8080/#/' + p + (p === 'jour' ? '?jour=2026-10-03' : ''));
        await page.waitForFunction(() => !document.querySelector('#page .loading'), null, { timeout: 15000 });
        const h1 = await page.innerText('#page h1'), txt = await page.innerText('#page');
        assert.ok(h1.startsWith(title), p + ' : titre « ' + h1 + ' »');
        assert.match(txt, content, p + ' : contenu attendu absent');
        assert.strictEqual(await page.locator('#page .msg.err').count(), 0, p + ' : ' + txt.slice(0, 200));
        if (viewport === 'téléphone') {
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(over <= 1, p + ' : la page déborde de ' + over + ' px en largeur');
        }
        await page.screenshot({ path: path.join(env.OUT, 'site_' + p + (viewport === 'téléphone' ? '_mobile' : '') + '.png') });
      }
      assert.deepStrictEqual(errors, []);
    } finally { await br.close(); }
  });
}

test('« En direct » : un véhicule par ligne, plaques dessinées, carte affichée', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForSelector('#tlive');
    const n = +env.psql('select count(*) from live_status');
    assert.strictEqual(await page.locator('#tlive tbody tr').count(), n);
    assert.ok(await page.locator('#tlive .plate').count() >= n);
    assert.strictEqual(await page.locator('#map.leaflet-container').count(), 1);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('compte en attente : aucune donnée visible', async () => {
  srv.kill(); srv = await startSite('pending');
  const { br, page } = await openBrowser();
  try {
    await page.goto('http://localhost:8080/');
    await page.fill('#le', 'new@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('.lbox .msg.warn');
    assert.match(await page.innerText('.lbox'), /doit être validé/);
    assert.strictEqual(await page.locator('.side').count(), 0);
  } finally { await br.close(); srv.kill(); srv = await startSite(); }
});
