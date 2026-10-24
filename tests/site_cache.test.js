// Pages déjà vues (site/cache.js) : affichées sans relire la base, relues en arrière-plan après 1 min et redessinées si la base a
// changé, relues après une écriture faite depuis le site, oubliées à la déconnexion. S'appuie sur la base remplie par tests/site.test.js.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
let srv;
test.before(async () => { srv = await startSite(); });
test.after(() => { if (srv) srv.kill(); });

test('tableau de bord déjà vu : affiché sans relire, relu après 1 min et redessiné si la base a changé, relu après une écriture', async () => {
  const id = env.psql("select id from journal where day between '2026-09-30' and '2026-10-06' order by id limit 1");
  assert.ok(id, 'journal rempli par tests/site.test.js');
  const { br, page, errors } = await openBrowser();
  const t0 = Date.parse('2026-10-06T09:18:00Z'); await page.clock.setFixedTime(new Date(t0));
  let nj = 0; page.on('request', r => { if (/\/rest\/v1\/journal\?/.test(r.url())) nj++; });
  const ready = t => page.waitForFunction(t => { const e = document.querySelector('#page h1'); return e && e.innerText.startsWith(t) && !document.querySelector('#page .loading'); }, t, { timeout: 15000 });
  const go = async (h, t) => { await page.evaluate(x => { location.hash = x; }, h); await ready(t); };
  const km = async () => +(await page.locator('.card', { hasText: 'Km parcourus' }).first().locator('.cv').innerText()).replace(/\D/g, '');
  let moved = false;
  try {
    await login(page, '#/tableau'); await ready('Tableau de bord');
    const km0 = await km(), n1 = nj;
    assert.ok(n1 > 0 && km0 > 0);
    // revenu moins d'1 min après : rien n'est relu
    await go('#/alertes', 'Alertes'); await go('#/tableau', 'Tableau de bord');
    assert.strictEqual(nj, n1, 'journal pas relu'); assert.strictEqual(await km(), km0);
    // la base change (passage du collecteur), revenu 2 min 30 après : dernière lecture affichée, relue, page redessinée
    env.psql(`update journal set km = km + 1000 where id = $$${id}$$`); moved = true;
    await page.clock.setFixedTime(new Date(t0 + 150000));
    await go('#/alertes', 'Alertes'); await go('#/tableau', 'Tableau de bord');
    await page.waitForFunction(v => +(document.querySelector('.card .cv') || {}).innerText.replace(/\D/g, '') === v, km0 + 1000, { timeout: 15000 });
    assert.ok(nj > n1, 'relu en arrière-plan');
    // écriture depuis le site (même sans ligne modifiée) : tout est relu, même moins d'1 min après
    const n2 = nj;
    await page.evaluate(() => sb.from('alerts').update({ comment: 'test cache' }).eq('id', '__aucune__'));
    await go('#/alertes', 'Alertes'); await go('#/tableau', 'Tableau de bord');
    assert.ok(nj > n2, 'relu après une écriture'); assert.strictEqual(await km(), km0 + 1000);
    // déconnexion : plus rien de gardé
    await page.click('#logout'); await page.waitForSelector('#lf');
    assert.strictEqual(await page.evaluate(() => CACHE.count()), 0);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); if (moved) env.psql(`update journal set km = km - 1000 where id = $$${id}$$`); }
});
