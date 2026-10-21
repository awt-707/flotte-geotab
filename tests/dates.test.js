// Import de fichiers (relecture du 18/10/2026) : jour / mois jamais inversés, heure gardée, en CSV comme en Excel
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const XLSX = require('xlsx'), lib = require('../site/lib.js'), env = require('./lib/env');
lib.setTzRules(env.MA_TZ);
// readBook (site/app.js) chargé seul, avec la bibliothèque XLSX du site
const src = fs.readFileSync(path.join(env.ROOT, 'site', 'app.js'), 'utf8'), m = src.match(/function readBook\(buf, name\) \{[\s\S]*?\n\}/);
const readBook = new Function('XLSX', m[0] + '; return readBook;')(XLSX);
const rows = wb => XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });

test('CSV : « 05/10/2026 13:30 » reste le 5 octobre à 13:30 (SheetJS le lisait comme le 10 mai, sans l\'heure)', () => {
  const r = rows(readBook(new TextEncoder().encode('Début;Fin\n05/10/2026 13:30;06/10/2026 02:15\n17/10/2026 08:00;\n'), 'extract.csv'));
  assert.deepStrictEqual(r.slice(1, 3), [['05/10/2026 13:30', '06/10/2026 02:15'], ['17/10/2026 08:00', '']]);
  assert.strictEqual(lib.parseLocalDT(r[1][0]).toISOString(), '2026-10-05T12:30:00.000Z');   // 13:30 au Maroc (UTC+1)
});

test('Excel : vraie date (format court m/d/yy) réécrite jj/mm/aaaa hh:mm ; date impossible refusée', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Début', 'Km'], [46300.5625, 12.5]]); ws.A2.z = 'm/d/yy'; ws.A2.t = 'n';
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'a');
  const r = rows(readBook(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), 'extract.xlsx'));
  assert.deepStrictEqual(r[1], ['05/10/2026 13:30', '12.5']);
  assert.strictEqual(lib.parseLocalDT('10/17/26'), null, 'mois 17 : refusé (jamais lu comme le 10 mai 2027)');
  assert.strictEqual(lib.parseLocalDT('2026-13-01'), null);
});
