// Pages des tableaux longs (site/pager.js) : bornes, découpage sans ligne perdue ni répétée, page 1 quand le tri ou les filtres
// changent, taille de page, tri de la base toujours complété par la clé, barre de pages.
const test = require('node:test'), assert = require('node:assert');
const P = require('../site/pager.js');

test('page bornée : première, dernière, au-delà, taille inconnue, tableau vide', () => {
  assert.deepStrictEqual(P.pgCalc(230, 3, 100), { page: 3, pages: 3, size: 100, total: 230, from: 200, to: 230 });
  assert.deepStrictEqual(P.pgCalc(230, 1, 50), { page: 1, pages: 5, size: 50, total: 230, from: 0, to: 50 });
  assert.strictEqual(P.pgCalc(230, 9, 50).page, 5, 'au-delà de la fin : dernière page');
  assert.strictEqual(P.pgCalc(230, 0, 50).page, 1);
  assert.strictEqual(P.pgCalc(230, 'x', 50).page, 1);
  assert.strictEqual(P.pgCalc(230, 2, 37).size, 50, 'taille hors liste : 50');
  assert.deepStrictEqual(P.pgCalc(0, 4, 100), { page: 1, pages: 1, size: 100, total: 0, from: 0, to: 0 });
  assert.deepStrictEqual(P.pgCalc(200, 2, 100), { page: 2, pages: 2, size: 100, total: 200, from: 100, to: 200 }, 'pile une page pleine');
});

test('toutes les lignes, chacune une seule fois, dans l\'ordre, quelle que soit la taille de page', () => {
  for (const n of [0, 1, 49, 50, 51, 199, 200, 201, 1234]) {
    const rows = Array.from({ length: n }, (_, i) => i);
    for (const size of P.PG_SIZES) {
      const c1 = P.pgCalc(n, 1, size), out = [];
      for (let p = 1; p <= c1.pages; p++) out.push(...P.pgSlice(rows, P.pgCalc(n, p, size)));
      assert.deepStrictEqual(out, rows, n + ' lignes, pages de ' + size);
      assert.strictEqual(c1.pages, Math.max(1, Math.ceil(n / size)));
    }
  }
});

test('état d\'un tableau : page gardée tant que tri et filtres ne changent pas, sinon page 1', () => {
  const st = {};
  const s = P.pgState(st, 'talall', 'sig-a', 100);
  assert.deepStrictEqual([s.page, s.size], [1, 100]);
  s.page = 4;
  assert.strictEqual(P.pgState(st, 'talall', 'sig-a').page, 4, 'même tri, mêmes filtres');
  assert.strictEqual(P.pgState(st, 'talall', 'sig-b').page, 1, 'filtre ou tri changé');
  assert.strictEqual(P.pgState(st, 'autre', 'sig-a').page, 1, 'chaque tableau a sa page');
  assert.strictEqual(st.talall.size, 100, 'taille gardée');
});

test('changement de taille : la première ligne affichée reste dans la nouvelle page', () => {
  assert.strictEqual(P.pgResize(P.pgCalc(500, 3, 50), 200), 1);   // lignes 101-150 -> page 1 de 200 (1-200)
  assert.strictEqual(P.pgResize(P.pgCalc(500, 5, 50), 100), 3);   // lignes 201-250 -> page 3 de 100 (201-300)
  assert.strictEqual(P.pgResize(P.pgCalc(500, 2, 200), 50), 5);   // lignes 201-400 -> page 5 de 50 (201-250)
});

test('tri de la base : ordre demandé puis la clé de la table (pagination stable)', () => {
  assert.deepStrictEqual(P.pgOrderOf([['day', false], ['time', false, false]], 'id'), [['day', false, undefined], ['time', false, false], ['id', true, undefined]]);
  assert.deepStrictEqual(P.pgOrderOf([['id', false]], 'id'), [['id', false, undefined]], 'clé déjà dans l\'ordre : pas répétée');
  assert.deepStrictEqual(P.pgOrderOf(null, 'user_id,agency_id'), [['user_id', true, undefined], ['agency_id', true, undefined]], 'clé composée');
  assert.deepStrictEqual(P.pgOrderOf([['at', true]]), [['at', true, undefined], ['id', true, undefined]], 'sans clé connue : id');
});

test('barre de pages : absente si tout tient dans 50 lignes, sinon page x / y, boutons bornés, taille choisie', () => {
  assert.strictEqual(P.pgBar('tx', P.pgCalc(50, 1, 50)), '');
  assert.strictEqual(P.pgBar('tx', P.pgCalc(0, 1, 50)), '');
  const h1 = P.pgBar('tx', P.pgCalc(230, 1, 50));
  assert.match(h1, /data-pg="tx" data-total="230"/);
  assert.match(h1, /Page <b>1<\/b> \/ 5/);
  assert.match(h1, /Lignes 1 à 50 sur 230/);
  assert.match(h1, /data-k="prev" data-to="0" disabled/, 'pas de page précédente sur la première');
  assert.match(h1, /data-k="next" data-to="2" aria-label/);
  assert.match(h1, /<option selected>50<\/option><option>100<\/option><option>200<\/option>/);
  const h5 = P.pgBar('tx', P.pgCalc(230, 5, 50));
  assert.match(h5, /Lignes 201 à 230 sur 230/);
  assert.match(h5, /data-k="next" data-to="6" disabled/, 'pas de page suivante sur la dernière');
  assert.match(h5, /data-k="last" data-to="5" disabled/);
  assert.match(P.pgBar('tx', P.pgCalc(60, 1, 200)), /Page <b>1<\/b> \/ 1[\s\S]*<option selected>200/, 'taille 200 choisie : barre gardée pour revenir à 50');
  assert.strictEqual(P.pgText(P.pgCalc(0, 1, 50)), 'Aucune ligne');
});
