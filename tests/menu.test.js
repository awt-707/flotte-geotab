// Menu personnalisé : recherche (touche /), favoris (☆ du menu ou page Personnaliser le menu), ordre et volets masqués,
// enregistrés pour l'utilisateur dans la base (profiles.menu, menu_set) et retrouvés après rechargement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111';
let srv;
test.before(async () => { srv = await startSite(); env.psql(`update profiles set menu = null where user_id = '${ADMIN}'`); });
test.after(() => { env.psql(`update profiles set menu = null where user_id = '${ADMIN}'`); if (srv) srv.kill(); });

test('menu : recherche, favoris, ordre, volets masqués, enregistrés pour l\'utilisateur', async () => {
  const { br, page, errors } = await openBrowser();
  const top = () => page.$$eval('.side nav .navmain > a:not(.navcfg):not(.navallhd), .side nav .navmain > .navfold > a.navgrp', a => a.map(x => x.textContent.trim()));
  try {
    await login(page, '#/tableau');
    await page.waitForSelector('#navq');
    const t0 = await top();
    assert.deepStrictEqual(t0, [...t0].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })), 'sans réglage : ordre alphabétique');
    // recherche : « / » puis mots sans accents, Entrée = premier résultat (volet d'un dossier fermé compris)
    await page.keyboard.press('/');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'navq');
    await page.keyboard.type('arret');
    assert.deepStrictEqual(await page.$$eval('#navres a', a => a.map(x => x.getAttribute('href'))), ['#/arrets']);
    assert.strictEqual(await page.isVisible('#navmain'), false);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#/arrets');
    assert.strictEqual(await page.inputValue('#navq'), '');
    assert.strictEqual(await page.isVisible('#navmain'), true);
    // ☆ d'un volet du menu : favori, sans changer de page
    await page.hover('.side nav a.navsub[href="#/carburant"]');
    await page.click('.side nav a.navsub[href="#/carburant"] .navstar');
    assert.strictEqual(await page.evaluate(() => location.hash), '#/arrets');
    assert.deepStrictEqual(await page.$$eval('.side nav .navfavs a', a => a.map(x => x.textContent)), ['Carburant']);
    // page Personnaliser le menu : favori ajouté, ordre changé, volet masqué
    await page.click('.side nav a.navcfg');
    await page.waitForSelector('#mnadd');
    await page.selectOption('#mnadd', 'alertes');
    await page.waitForFunction(() => document.querySelectorAll('.side nav .navfavs a').length === 2);
    await page.click('[data-list="fav"] li:nth-child(2) [data-mn="fav"][data-d="-1"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.side nav .navfavs a')].map(x => x.textContent).join() === 'Alertes,Carburant');
    const first = await page.$eval('[data-list="order"] li', li => li.dataset.id);
    await page.click('[data-list="order"] li:first-child [data-mn="order"][data-d="1"]');
    await page.waitForFunction(f => document.querySelector('[data-list="order"] li:nth-child(2)').dataset.id === f, first);
    await page.uncheck('[data-mnh="connexions"]');
    await page.waitForFunction(() => !document.querySelector('.side nav .navmain > a[href="#/connexions"]') && document.querySelector('[data-list="order"] li[data-id="connexions"].off'));   // page redessinée après l'enregistrement
    assert.match(await page.innerText('#mnout'), /Enregistré\./);
    const cfg = JSON.parse(env.psql(`select menu::text from profiles where user_id = '${ADMIN}'`));
    assert.deepStrictEqual([cfg.fav, cfg.hide, cfg.order[1]], [['alertes', 'carburant'], ['connexions'], first]);
    // volet masqué : toujours trouvé par la recherche ; réglage retrouvé après rechargement
    await page.fill('#navq', 'connex');
    assert.deepStrictEqual(await page.$$eval('#navres a', a => a.map(x => x.getAttribute('href'))), ['#/connexions']);
    await page.reload(); await page.waitForSelector('#navq');
    assert.deepStrictEqual(await page.$$eval('.side nav .navfavs a', a => a.map(x => x.textContent)), ['Alertes', 'Carburant']);
    assert.strictEqual((await top())[1], t0[0], 'ordre gardé');
    // « Toutes les pages » fermé d'un clic : seuls les favoris restent ; choix gardé après rechargement, rouvert d'un clic
    await page.click('.side nav a.navallhd');
    await page.waitForFunction(() => document.querySelector('#navmain.allclosed'));
    assert.strictEqual(await page.isVisible('.side nav .navmain > a[href="#/tableau"]'), false);
    assert.strictEqual(await page.isVisible('.side nav a.navfav[href="#/alertes"]'), true);
    await page.reload(); await page.waitForSelector('#navq');
    assert.ok(await page.$('#navmain.allclosed'), 'fermé après rechargement');
    await page.click('.side nav a.navallhd');
    await page.waitForFunction(() => !document.querySelector('#navmain.allclosed') && document.querySelector('.side nav .navmain > a[href="#/tableau"]'));
    // retour au menu d'origine
    await page.goto('http://localhost:8080/#/menu'); await page.waitForSelector('#mnreset');
    page.once('dialog', d => d.accept());
    await page.click('#mnreset');
    await page.waitForFunction(() => !document.querySelector('.side nav .navfavs'));
    assert.deepStrictEqual(await top(), t0);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});
