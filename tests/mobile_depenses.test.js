// Dépenses dans l'application Android (13/11/2026, demande d'Ahmed) : nouvelle dépense au doigt, justificatif scanné avec l'appareil photo
// (photo réduite avant le dépôt), justificatif ajouté plus tard depuis la liste. Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert'), http = require('http');
const env = require('./lib/env'), { startSite, openBrowser } = require('./lib/browser');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 LudyAndroid/1.2' };
const get = (path) => new Promise((ok, ko) => http.get({ host: 'localhost', port: 8080, path, headers: { Authorization: 'Bearer x' } }, r => { const c = []; r.on('data', x => c.push(x)); r.on('end', () => ok(Buffer.concat(c))); }).on('error', ko));
/** Largeur et hauteur d'une image JPEG (marqueur SOF) */
function jpegSize(b) { let i = 2; while (i < b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; } return null; }

test('application Android : dépense saisie, justificatif scanné (photo réduite), justificatif ajouté ensuite', async () => {
  env.resetDb();
  env.psql("insert into drivers (code, name) values ('C1', 'ALPHA Test')");
  const srv = await startSite(), { br, page, errors } = await openBrowser(PHONE);
  try {
    await page.goto('http://localhost:8080/#/caisse?t=depenses');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#mdsave');
    assert.deepStrictEqual(await page.$$eval('.mtabs a', as => as.map(a => a.innerText.trim())), ['Encaissement', 'Courses', 'Dépenses', 'Pauses', 'Manifeste']);
    assert.strictEqual(await page.innerText('#mtitle'), 'Dépenses');
    assert.strictEqual(await page.getAttribute('#mdcam', 'capture'), 'environment', 'appareil photo du téléphone');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'pas de défilement horizontal');
    // photo du ticket : 3000 × 2000 px, plusieurs Mo (appareil photo du téléphone)
    const b64 = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const x = c.getContext('2d'), d = x.createImageData(3000, 2000);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i] = (i * 7) % 256; d.data[i + 1] = (i * 13) % 251; d.data[i + 2] = (i * 3) % 199; d.data[i + 3] = 255; } x.putImageData(d, 0, 0);
      const bl = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.97)); return await new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result).split(',')[1]); f.readAsDataURL(bl); }); });
    const photo = Buffer.from(b64 || '', 'base64');
    assert.ok(photo.length > 1000000, 'photo de test de plus d\'1 Mo : ' + photo.length);
    await page.fill('#mdw', 'ALPHA Test'); await page.fill('#mda', '120'); await page.selectOption('#mdc', 'Carburant'); await page.fill('#mdm', 'Station Afriquia');
    await page.setInputFiles('#mdcam', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: photo });
    await page.waitForSelector('#mdprev img');
    await page.click('#mdsave');
    await page.waitForSelector('.mcard.mdep');
    assert.match(await page.innerText('.mcard.mdep'), /Carburant · 120 MAD[\s\S]*ALPHA Test[\s\S]*Justificatif OK[\s\S]*Station Afriquia[\s\S]*IMG_0001\.jpg/);
    assert.strictEqual(env.psql("select caisse || '|' || flow || '|' || amount || '|' || justif || '|' || driver_code || '|' || source from cash_moves"), 'depenses|out|120.00|OK|C1|Chauffeur / Uber');
    const path = env.psql("select path from cash_files where kind = 'justif'");
    assert.match(path, /^0\/justificatifs\/m\d+_\d+\.jpg$/);
    const stored = await get('/storage/v1/object/caisse/' + path);
    assert.deepStrictEqual(jpegSize(stored), [2000, 1333], 'photo réduite à 2000 px');
    assert.ok(stored.length < photo.length, 'photo allégée : ' + stored.length + ' < ' + photo.length);
    // dépense sans justificatif, puis ticket scanné depuis la liste
    await page.selectOption('#mdc', 'Parking'); await page.fill('#mda', '20');
    await page.click('#mdsave');
    await page.waitForFunction(() => /1 justificatif à fournir/i.test(document.querySelector('#page').innerText));
    const id = env.psql("select id from cash_moves where label = 'Parking'");
    assert.strictEqual(env.psql(`select justif from cash_moves where id = ${id}`), 'En attente');
    await page.setInputFiles(`[data-cshup="justif|${id}"]`, { name: 'ticket.jpg', mimeType: 'image/jpeg', buffer: photo.slice(0) });
    await page.waitForFunction(() => !/justificatif à fournir/i.test(document.querySelector('#page').innerText));
    assert.strictEqual(env.psql(`select justif from cash_moves where id = ${id}`), 'OK');
    // amende : payée par, chauffeur obligatoire
    await page.selectOption('#mdc', 'Amende');
    assert.strictEqual(await page.isVisible('#mdp'), true); assert.strictEqual(await page.isVisible('#mdo'), false);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
