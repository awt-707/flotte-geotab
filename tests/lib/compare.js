// Comparaison ligne à ligne : onglet du Sheet v6 (en-têtes français) contre table de la base (colonnes DB)
function compareRows(refRows, dbRows, refCols, dbCols, opt) {
  opt = opt || {};
  const key = opt.refKey || (r => String(Object.values(r)[0])), m = {};
  dbRows.forEach(r => { m[r.id] = r; });
  let same = 0, miss = 0; const diff = [];
  refRows.forEach(r => {
    const id = key(r), d = m[id];
    if (!d) { miss++; return; }
    const bad = refCols.map((h, i) => {
      if (opt.skip && opt.skip(h)) return null;
      let a = r[h], b = d[dbCols[i]];
      if (opt.dayCol === h) { a = opt.day(a); b = b && String(b).slice(0, 10); }
      else {
        if (a instanceof Date) a = a.getTime();
        if (b !== null && b !== undefined && typeof a === 'number' && /_at$|^at$|stop_start|stop_end|contract_start|contract_end/.test(dbCols[i])) b = new Date(b).getTime();
      }
      if (a === '') a = null;
      if (typeof a === 'number' && b !== null && b !== undefined) b = +b;
      return String(a) === String(b) ? null : h + ' ' + a + ' ≠ ' + b;
    }).filter(Boolean);
    if (bad.length) diff.push(id + ' : ' + bad.join(', ')); else same++;
  });
  return { ref: refRows.length, db: dbRows.length, same, diff, miss, extra: dbRows.length - same - diff.length };
}
const fmt = (name, c) => name + ' : référence ' + c.ref + ', base ' + c.db + ', identiques ' + c.same + ', différents ' + c.diff.length + ', manquants ' + c.miss + ', en trop ' + c.extra +
  (c.diff.length ? '\n  ≠ ' + c.diff.slice(0, 5).map(x => x.slice(0, 300)).join('\n  ≠ ') : '');
module.exports = { compareRows, fmt };
