// Import d'un extract de contrats (.xlsx) depuis le site : contrats enregistrés, plaque inconnue signalée, calcul demandé au collecteur
const test = require('node:test'), assert = require('node:assert'), path = require('path'), XLSX = require('xlsx');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');

test('import d\'un extract depuis la page Contrats', async () => {
  const rows = env.contrats();
  rows[1][2] = rows[1][2] + ' MODIFIÉ';
  rows.push(rows[1].slice()); rows[rows.length - 1][0] = 'CT999999'; rows[rows.length - 1][4] = 'WW123456';
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'x');
  const file = path.join(env.OUT, 'extract.xlsx'); XLSX.writeFile(wb, file);
  env.psql('delete from jobs'); env.psql("delete from contracts where num = 'CT999999'");
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/contrats');
    await page.waitForSelector('#cfile'); await page.setInputFiles('#cfile', file);
    await page.waitForFunction(() => /Contrats lus|Erreur/.test(document.querySelector('#cres').innerText), null, { timeout: 20000 });
    const out = await page.innerText('#cres');
    assert.match(out, /Contrats lus : 63/);
    assert.match(out, /WW123456/);
    assert.match(env.psql("select name from contracts where num = '" + rows[1][0] + "'"), /MODIFIÉ$/);
    assert.strictEqual(env.psql("select plate from contracts where num = 'CT999999'"), 'WW123456');
    assert.match(env.psql('select kind from jobs'), /after_inject/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql("delete from contracts where num = 'CT999999'"); }
});
