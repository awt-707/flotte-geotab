// Le site sur une base remplie par le collecteur : chaque page s'affiche sans erreur, sur ordinateur et sur téléphone
const test = require('node:test'), assert = require('node:assert'), path = require('path');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6'), { startSite, openBrowser, login } = require('./lib/browser');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
let srv, B, A;

test.before(async () => {
  A = sheetV6(NOW);
  B = collector(NOW); B.run('installer()'); copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-09-29' }])");
  for (let i = 0; i < 4; i++) { B.setNow(NOW + i * 5 * 60000); B.run('collect()'); }   // 4 passages : journées finalisées, journal et alertes calculés
  srv = await startSite();
});
test.after(() => { if (srv) srv.kill(); });

const PAGES = [['direct', 'En direct', /En route|Garé|Arrêté/], ['tableau', 'Tableau de bord', /Km parcourus/], ['jour', 'Journée du', /Journées de travail actives/],
  ['chauffeurs', 'Classement des chauffeurs', /Score/], ['alertes', 'Alertes', /Gravité/], ['contrats', 'Contrats', /Contrats des 40 derniers jours/],
  ['plaques', 'Changements de plaque', /Ancienne plaque/], ['vehicules', 'Véhicules', /WW968194/], ['reglages', 'Réglages', /Journal technique/],
  ['fiches', 'Chauffeurs', /Code/], ['rapports', 'Rapports', /Km parcourus/], ['agences', 'Agences', /Aucune agence|Accès des utilisateurs/],
  ['conduite', 'Conduite', /Excès de vitesse/], ['carburant', 'Carburant', /Jauge en ce moment/], ['ralenti', 'Ralenti', /Heures de ralenti par chauffeur/], ['arrets', 'Arrêts moteur tournant', /Détail des arrêts/],
  ['vehicule?k=968199WW', 'WW968199', /Journées de travail/], ['chauffeur?c=C038', 'Compte rendu', /Par journée de travail/]];

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
        await page.screenshot({ path: path.join(env.OUT, 'site_' + p.replace(/\W.*/, '') + (viewport === 'téléphone' ? '_mobile' : '') + '.png') });
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

test('page Carburant : mêmes totaux que « Carburant consommé entre deux dates » du Sheet v6', async () => {
  A.run("queueSync_(['2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04'], false)");
  const ref = A.run("fuelPeriod('2026-09-30T00:00','2026-10-07T00:00','',false)").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = ref.match(/([\d.]+) L consommés · (\d+) km · ([\d.]+) L\/100 km Dont moteur allumé à l'arrêt : ([\d.]+) L · Pleins détectés : (\d+) \(([\d.]+) L/);
  assert.ok(m, ref);
  const { br, page, errors } = await openBrowser();
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    await login(page, '#/carburant');
    await page.waitForSelector('#tcv');
    const card = async l => (await page.locator('.card', { hasText: l }).first().locator('.cv').innerText()).replace(/\s/g, '').replace(',', '.');
    assert.strictEqual(+await card('Carburant consommé'), +m[1]);
    assert.strictEqual(+await card('Km'), +m[2]);
    assert.strictEqual(+await card('Consommation'), +m[3]);
    assert.strictEqual(+await card('moteur allumé'), +m[4]);
    assert.strictEqual(+await card('Pleins détectés'), +m[5]);
    assert.strictEqual(+await card('Litres pleins'), +m[6]);
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

test('arrêts moteur tournant : chaque arrêt de la base affiché, litres non mesurés signalés', async () => {
  const { br, page, errors } = await openBrowser();
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    await login(page, '#/arrets');
    await page.selectOption('#psel', '30 derniers jours');
    await page.waitForFunction(() => !document.querySelector('#page .loading'), null, { timeout: 15000 });
    const n = +env.psql("select count(*) from engine_stops where day between '2026-09-07' and '2026-10-06'");
    assert.ok(n > 0, 'aucun arrêt calculé');
    assert.strictEqual(await page.locator('#tstops tbody tr').count(), n);
    const nm = +env.psql("select count(*) from engine_stops where day between '2026-09-07' and '2026-10-06' and liters is null");
    assert.strictEqual(await page.locator('#tstops tbody tr td:nth-child(7) .nm').count(), nm, 'litres non mesurés');
    assert.match(await page.innerText('.cards'), new RegExp(`${n - nm} / ${n}`));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});
