// Temps réel : passages toutes les 5 min du 04/10 10:05 au 05/10 12:40. Les trajets provisoires de la journée
// doivent déjà être identiques au Sheet v6 le soir même, puis être finalisés le lendemain midi sans changer.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6'), { compareRows, fmt } = require('./lib/compare');
const L = (d, h, m) => Date.UTC(2026, 9, d, h - 1, m || 0);   // heure du Maroc (UTC+1)
let A, B, ref, refE, at2355, final, worstMs = 0;

const snapshot = (refRows) => {
  const rows = JSON.parse(env.psql("select coalesce(json_agg(t), '[]') from (select * from trips where vday = '2026-10-04') t"));
  const c = compareRows(refRows || ref, rows, JSON.parse(A.run('JSON.stringify(H.TRIP)')), JSON.parse(B.run('JSON.stringify(DB.TRIP.cols)')), { skip: h => h === 'Date' });
  return { c, finals: rows.filter(r => r.final).length, events: +env.psql("select count(*) from events where vday = '2026-10-04'") };
};

test.before(() => {
  A = sheetV6(L(5, 12, 40));   // même moment que la finalisation par le collecteur
  A.run("queueSync_(['2026-10-03','2026-10-04'], false)");
  ref = A.tab('DATA_TRAJETS').filter(r => A.day(r['Début']) === '2026-10-04');
  refE = A.tab('DATA_EVENEMENTS').filter(r => A.day(r['Début']) === '2026-10-04');
  B = collector(L(4, 10, 5));
  B.run('installer()');
  copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-10-01' }])");
  for (let t = L(4, 10, 5); t <= L(5, 12, 40); t += 5 * 60000) {
    B.setNow(t); const w = Date.now(); B.run('collect()'); worstMs = Math.max(worstMs, Date.now() - w);
    if (t === L(4, 23, 55)) at2355 = snapshot(ref.filter(r => new Date(r['Fin']).getTime() <= L(4, 23, 50)));   // trajets terminés depuis 5 min
  }
  final = snapshot();
});

test('le soir même (23:55), trajets terminés déjà présents et identiques au Sheet v6', () => {
  assert.ok(ref.length > 0);
  const c = at2355.c;
  assert.ok(c.diff.length === 0 && c.miss === 0 && c.extra === 0, fmt('trajets 23:55', c));
  assert.strictEqual(at2355.finals, 0, 'rien ne doit être finalisé avant le lendemain midi');
});

test('le lendemain midi, journée finalisée et toujours identique', () => {
  const c = final.c;
  assert.ok(c.diff.length === 0 && c.miss === 0 && c.extra === 0, fmt('trajets finalisés', c));
  assert.strictEqual(final.finals, ref.length);
  assert.strictEqual(final.events, refE.length);
});

test('pas de ligne provisoire restante pour la journée finalisée', () => {
  assert.strictEqual(+env.psql("select count(*) from trips where vday = '2026-10-04' and not final"), 0);
  assert.strictEqual(+env.psql("select count(*) from events where vday = '2026-10-04' and not final"), 0);
});

test('chaque passage reste sous la limite Apps Script (6 min)', () => {
  assert.ok(worstMs < 60000, 'passage le plus long : ' + worstMs + ' ms (test local)');
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur'"), '');
});
