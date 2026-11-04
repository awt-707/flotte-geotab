// Mode téléphone (demande d'Ahmed, 04/11/2026) : dans l'application Android (user agent « LudyAndroid/ »), seulement l'encaissement
// du shift, l'encaissement des courses privées et le manifeste, en grand, sans défilement horizontal. Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 LudyAndroid/1.1' };

async function loginPhone(page, hash) {
  await page.goto('http://localhost:8080/' + (hash || ''));
  await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
  await page.waitForSelector('.mtabs');
}
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('application Android : trois écrans seulement, encaissement du shift et d\'une course privée au doigt, manifeste', async () => {
  env.resetDb();
  const start = new Date(Date.now() - 3 * 3600000).toISOString(), end = new Date(Date.now() - 3600000).toISOString();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI');
    insert into drivers (code, name) values ('C1', 'ALPHA Test');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at) values ('K1', 'C1', 'ALPHA Test', 'WW968199', '968199WW', '${start}', '${end}');
    insert into missions (client_name, kind, total_ttc, needs_validation, level, status, driver_name, vehicle_key, start_at, number)
      values ('Client Test', 'Transfert aéroport', 450, false, 'Standard', 'Terminée', 'ALPHA Test', '968199WW', now() - interval '1 day', 'DEV-2026-0001');`);
  const srv = await startSite(), { br, page, errors } = await openBrowser(PHONE);
  try {
    // ouverture : premier écran, trois boutons en bas, aucun menu du site complet
    await loginPhone(page, '#/tableau');
    await page.waitForURL(/#\/caisse\?t=shift/);
    assert.deepStrictEqual(await page.$$eval('.mtabs a', as => as.map(a => a.innerText.trim())), ['Encaissement', 'Courses', 'Manifeste']);
    assert.strictEqual(await page.locator('.side').count(), 0);
    // toute autre page renvoie au premier écran
    await page.evaluate(() => { location.hash = '#/reglages'; });
    await page.waitForURL(/#\/caisse\?t=shift/);
    // encaissement du shift du contrat : carte, remis 260, manque 40 (export pas importé)
    const sel = await page.evaluate(async () => { for (let i = 0; i < 50 && !(CS.ctr || []).some(x => x.num === 'K1'); i++) await new Promise(r => setTimeout(r, 100));
      const c = CS.ctr.find(x => x.num === 'K1'); return { day: c._day, s: c._shift }; });
    await page.evaluate(x => { location.hash = `#/caisse?t=shift&jour=${x.day}&s=${x.s}`; }, sel);
    await page.waitForSelector('.mcard[data-row] .cgv');
    assert.match(await page.innerText('.mcard[data-row]'), /ALPHA Test[\s\S]*Contrat K1[\s\S]*WW968199/);
    assert.strictEqual(await page.innerText('#mtitle'), 'Encaissement du shift');
    assert.ok(await noHScroll(page), 'pas de défilement horizontal');
    await page.fill('.mcard .cgv', '300'); await page.fill('.mcard .cch', '40'); await page.click('.mcard .mmore summary'); await page.fill('.mcard .cmq', '40');
    assert.match(await page.innerText('.mcard .mcalc'), /Encaissé 260 MAD · manque 40 MAD/);
    await page.click('[data-csav="0"]');
    await page.click('#uiok');   // manque sans commentaire : confirmation dessinée par le site
    await page.waitForSelector('.mcard.done.short');
    assert.strictEqual(env.psql("select amount || '|' || uber_cash || '|' || contract_num || '|' || shift from cash_moves"), `260.00|300.00|K1|${sel.s}`);
    // le chauffeur remet les 40 : complément, carte verte
    await page.click('[data-cshcp="0"]');
    await page.fill('#uiin', '40'); await page.click('#uiok');
    await page.waitForSelector('.mcard.done.paid');
    assert.match(await page.innerText('.mcard.done'), /Encaissé\s*300 MAD/);
    // courses privées : course Ludy à encaisser
    await page.click('.mtabs a[data-mt="courses"]');
    await page.waitForSelector('[data-cshms]');
    assert.match(await page.innerText('#page'), /1\s*course à encaisser[\s\S]*Client Test[\s\S]*450 MAD/);
    await page.click('[data-cshms]');
    await page.waitForFunction(() => /Encaisser la course DEV-2026-0001/.test((document.querySelector('#cshcform') || {}).innerText || ''));
    assert.strictEqual(await page.inputValue('#ccw'), 'ALPHA Test');
    assert.strictEqual(await page.inputValue('#cca'), '450');
    await page.fill('#ccr', '405');
    assert.match(await page.innerText('#cccalc'), /Prime 45 MAD · gardée par le chauffeur 45 MAD/);
    await page.click('#ccsave');
    await page.waitForFunction(() => /0\s*course à encaisser/.test(document.querySelector('#page').innerText));
    assert.strictEqual(env.psql("select amount || '|' || course_amount || '|' || prime || '|' || prime_paid from cash_moves where caisse = 'courses'"), '405.00|450.00|45.00|45.00');
    assert.ok(await noHScroll(page));
    // manifeste : formulaire sur une colonne, sans défilement horizontal, sans les réglages
    await page.click('.mtabs a[data-mt="manifeste"]');
    await page.waitForSelector('#mfgen');
    assert.strictEqual(await page.innerText('#mtitle'), 'Manifeste');
    assert.strictEqual(await page.locator('#mfset').isVisible(), false);
    assert.ok(await noHScroll(page), 'manifeste sans défilement horizontal');
    const w = await page.evaluate(() => document.querySelector('#mfdon').getBoundingClientRect().width);
    assert.ok(w > 300, 'champ pleine largeur : ' + w);
    // compte : déconnexion depuis le bouton en haut
    await page.click('#mmenu'); await page.waitForSelector('#logout', { state: 'visible' });
    await page.click('#logout'); await page.waitForSelector('#lf');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});

test('navigateur d\'ordinateur : site complet inchangé (menu, pas de mode téléphone)', async () => {
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await page.goto('http://localhost:8080/#/caisse?t=shift');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('.side nav');
    await page.waitForSelector('.cshshift');
    assert.strictEqual(await page.locator('.mtabs').count(), 0);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); }
});
