// L'import des contrats dans le site (lib.js, dans le navigateur) doit lire l'extraction exactement comme le Google Sheet v6
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6 } = require('./lib/v6'), L = require('../site/lib.js');

test('contrats identiques à l\'injection du Sheet v6', () => {
  const A = sheetV6(Date.UTC(2026, 9, 6, 9));
  const ref = A.main.getSheetByName('CONTRATS').data.slice(1).filter(r => r[0] !== '');
  const veh = [{ key: '968194WW', plate: 'WW968194' }, { key: '968199WW', plate: 'WW968199' }];
  const res = L.parseContracts(env.contrats(), L.buildCanonMap(veh, []));
  const m = {}; res.rows.forEach(r => { m[r.num] = r; });
  const cols = [['client_code', 1], ['name', 2], ['plate', 3], ['vehicle_key', 4], ['model', 5], ['start_at', 6], ['end_at', 7], ['status', 8], ['origin', 9], ['phone', 10], ['email', 11], ['comment', 12]];
  const diff = [];
  ref.forEach(r => {
    const o = m[r[0]]; if (!o) return diff.push(r[0] + ' absent');
    cols.forEach(([k, i]) => { let a = r[i], b = o[k]; if (a instanceof Date) a = a.toISOString(); if (a === '') a = null; if (b === '') b = null;
      if (String(a) !== String(b)) diff.push(r[0] + ' ' + k + ' ' + a + ' ≠ ' + b); });
  });
  assert.ok(ref.length > 0);
  assert.strictEqual(res.rows.length, ref.length);
  assert.deepStrictEqual(diff, []);
});
