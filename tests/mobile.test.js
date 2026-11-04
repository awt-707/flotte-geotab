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
      values ('Client Test', 'Transfert aéroport', 450, false, 'Standard', 'Terminée', 'ALPHA Test', '968199WW', now() - interval '1 day', 'DEV-2026-0001');
    insert into parc (plate, model, seats, agrement) values ('WW968199', 'STARIA', 7, 'TT/1/2026');
    update manifest_config set stamp = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';`);
  const srv = await startSite(), { br, page, errors } = await openBrowser(PHONE);
  // application Android 1.2 : PDF envoyés dans WhatsApp par l'application (LudyAndroid.share)
  await page.context().addInitScript(() => { window.__shared = []; window.LudyAndroid = { share: (b64, name, mime, text, phone) => window.__shared.push({ n: b64.length, name, mime, text, phone }), save: () => { } }; });
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
    await page.waitForSelector('.mcard[data-card] .mpf[data-pf="uber"] .cgv');
    // une fiche par chauffeur : ligne Uber et ligne Bolt (plus de choix Uber / Bolt)
    assert.strictEqual(await page.locator('.mseg a:has-text("Bolt")').count(), 0, 'plus d\'onglets Uber / Bolt');
    assert.match(await page.innerText('.mcard[data-card]'), /ALPHA Test[\s\S]*Contrat K1[\s\S]*WW968199[\s\S]*Uber[\s\S]*Bolt/);
    assert.strictEqual(await page.innerText('#mtitle'), 'Encaissement du shift');
    assert.ok(await noHScroll(page), 'pas de défilement horizontal');
    const U = '.mcard .mpf[data-pf="uber"] ', Bo = '.mcard .mpf[data-pf="bolt"] ';
    await page.fill(U + '.cgv', '300'); await page.fill(U + '.cch', '40'); await page.click(U + '.mmore summary'); await page.fill(U + '.cmq', '40');
    assert.match(await page.innerText(U + '.mcalc'), /Encaissé 260 MAD · manque 40 MAD/);
    await page.fill(Bo + '.cgv', '100');
    await page.click('[data-csav="0"]');
    await page.click('#uiok');   // manque Uber sans commentaire : confirmation dessinée par le site
    await page.waitForSelector('.mpfd.short');
    assert.strictEqual(env.psql("select string_agg(caisse || '|' || amount || '|' || coalesce(uber_cash::text, '-') || '|' || contract_num || '|' || shift, ',' order by caisse) from cash_moves"),
      `bolt|100.00|-|K1|${sel.s},uber|260.00|300.00|K1|${sel.s}`, 'Uber et Bolt enregistrés en une fois');
    assert.strictEqual(await page.locator('.mpfd').count(), 2);
    // le chauffeur remet les 40 Uber : complément, ligne verte
    await page.click('[data-cshcp="0|uber"]');
    await page.fill('#uiin', '40'); await page.click('#uiok');
    await page.waitForFunction(() => document.querySelectorAll('.mpfd.paid').length === 2);
    assert.match(await page.innerText('.mpfd'), /Uber[\s\S]*Encaissé\s*300 MAD/);
    // courses privées : d'abord créer la course (manifeste et devis faits tout de suite), encaissement à l'arrivée du chauffeur
    await page.click('.mtabs a[data-mt="courses"]');
    await page.waitForSelector('#qkgo');
    assert.ok(await noHScroll(page), 'formulaire de course sans défilement horizontal');
    await page.selectOption('#qkveh', '968199WW');
    const loc = d => new Date(d.getTime() + 3600000).toISOString().slice(0, 16), dep = new Date(Date.now() + 26 * 3600000);   // heure du Maroc (UTC+1) ; course du lendemain : à encaisser dès sa création
    await page.fill('#qkdep', loc(dep)); await page.dispatchEvent('#qkdep', 'change');
    await page.fill('#qkend', loc(new Date(dep.getTime() + 2 * 3600000)));
    await page.fill('#qkfrom', 'Hôtel Test, Casablanca'); await page.fill('#qkto', 'Aéroport Mohammed V, Casablanca');
    await page.fill('#qkdrv', 'ALPHA Test'); await page.fill('#qktel', '0611223344');
    await page.fill('#qkprice', '550'); await page.fill('#qkcli', 'John Smith'); await page.fill('#qkcph', '+33 6 12 34 56 78');
    await page.click('#qkgo');
    await page.waitForSelector('#mobdone, #qkres .err', { timeout: 60000 });
    assert.strictEqual(await page.locator('#qkres .err').count(), 0, await page.innerText('#qkres').catch(() => ''));
    assert.match(await page.innerText('#mobdone'), /Course DEV-\d{4}-\d{4} créée[\s\S]*Confirmée[\s\S]*John Smith[\s\S]*TVA 10 %[\s\S]*550 MAD/);
    const m = JSON.parse(env.psql("select row_to_json(x) from (select id, status, total_ttc, data from missions where client_name = 'John Smith') x"));
    assert.deepStrictEqual([m.status, m.total_ttc, !!(m.data.manifest && m.data.manifest.id), !!(m.data.quote && m.data.quote.path)], ['Confirmée', 550, true, true], 'course, manifeste et devis enregistrés');
    assert.strictEqual(env.psql('select count(*) from cash_moves where mission_id = ' + m.id), '0', 'pas encaissée à la création');
    // manifeste au chauffeur, devis au client : fichiers PDF envoyés dans WhatsApp
    await page.click('#mobmfwa'); await page.click('#mobqwa');
    await page.waitForFunction(() => window.__shared.length === 2);
    const sh = await page.evaluate(() => window.__shared);
    assert.deepStrictEqual(sh.map(x => [x.mime, x.phone, /\.pdf$/.test(x.name), x.n > 1000]), [['application/pdf', '212611223344', true, true], ['application/pdf', '33612345678', true, true]]);
    assert.match(sh[0].name, /^Manifeste/); assert.match(sh[1].name, /^Devis-DEV-/);
    assert.match(sh[1].text, /Bonjour John Smith[\s\S]*Total : 550 MAD TTC/);
    // à l'arrivée du chauffeur : onglet À encaisser (la course créée et l'ancienne)
    await page.click('#mobnew'); await page.waitForSelector('#qkgo');
    await page.click('.mseg a[href*="c=enc"]');
    await page.waitForSelector('[data-cshms]');
    assert.match(await page.innerText('#page'), /2\s*courses à encaisser[\s\S]*John Smith[\s\S]*Client Test[\s\S]*450 MAD/);
    await page.click('.mcrs:has-text("Client Test") [data-cshms]');
    await page.waitForFunction(() => /Encaisser la course DEV-2026-0001/.test((document.querySelector('#cshcform') || {}).innerText || ''));
    assert.strictEqual(await page.inputValue('#ccw'), 'ALPHA Test');
    assert.strictEqual(await page.inputValue('#cca'), '450');
    await page.fill('#ccr', '405');
    assert.match(await page.innerText('#cccalc'), /Prime 45 MAD · gardée par le chauffeur 45 MAD/);
    await page.click('#ccsave');
    await page.waitForFunction(() => /1\s*course à encaisser/.test(document.querySelector('#page').innerText));
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
