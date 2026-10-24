// Cache des lectures du site (site/cache.js) : relecture en arrière-plan, lecture partagée, vidé à chaque écriture, par utilisateur
const test = require('node:test'), assert = require('node:assert');
const { cacheNew, cacheWrites, cacheFetch } = require('../site/cache.js');
const tick = () => new Promise(r => setImmediate(r));
const mk = () => { const o = { t: 1000, u: 'A' }; o.c = cacheNew({ now: () => o.t, who: () => o.u, fresh: 60000, max: 600000 }); return o; };
const loader = rows => { const l = () => { l.n++; return Promise.resolve(rows.v); }; l.n = 0; return l; };

test('lecture récente rendue sans relire ; ancienne rendue aussitôt puis relue, changement signalé', async () => {
  const o = mk(), src = { v: [{ id: 1, km: 10 }] }, l = loader(src);
  let r = await o.c.get('k', l); assert.deepStrictEqual([r.v, r.stale, l.n], [src.v, false, 1]);
  o.t += 30000; r = await o.c.get('k', l); assert.deepStrictEqual([r.stale, l.n], [false, 1], 'moins d\'1 min : pas relue');
  // plus d'1 min : la dernière lecture est rendue tout de suite, relue en arrière-plan ; identique : pas de changement
  o.t += 40000; const ev = [];
  r = await o.c.get('k', l, { stale: at => ev.push(['stale', at]), done: (ch, e) => ev.push(['done', ch, e]) });
  assert.strictEqual(r.stale, true); assert.strictEqual(r.at, 1000);
  await tick(); assert.deepStrictEqual(ev, [['stale', 1000], ['done', false, null]]); assert.strictEqual(l.n, 2);
  // donnée changée dans la base : ancienne valeur rendue, puis « changé », la lecture suivante rend la nouvelle
  o.t += 70000; src.v = [{ id: 1, km: 12 }]; const ev2 = [];
  r = await o.c.get('k', l, { done: ch => ev2.push(ch) }); assert.strictEqual(r.v[0].km, 10); assert.strictEqual(r.stale, true);
  await tick(); assert.deepStrictEqual(ev2, [true]);
  r = await o.c.get('k', l); assert.deepStrictEqual([r.v[0].km, r.stale], [12, false]);
  // plus de 10 min : jamais affichée, lue avant de rendre
  o.t += 700000; src.v = [{ id: 1, km: 15 }]; r = await o.c.get('k', l); assert.deepStrictEqual([r.v[0].km, r.stale], [15, false]);
});

test('deux pages qui demandent la même chose en même temps : une seule lecture ; erreur jamais gardée', async () => {
  const o = mk(); let n = 0, ok;
  const l = () => { n++; return new Promise(r => { ok = r; }); };
  const a = o.c.get('k', l), b = o.c.get('k', l); await tick(); ok([1, 2]);
  assert.deepStrictEqual(await a, { v: [1, 2], at: 1000, stale: false }); assert.deepStrictEqual((await b).v, [1, 2]); assert.strictEqual(n, 1);
  let fail = 0; const bad = () => { fail++; return Promise.reject(new Error('base injoignable')); };
  await assert.rejects(o.c.get('e', bad), /injoignable/); await assert.rejects(o.c.get('e', bad), /injoignable/);
  assert.strictEqual(fail, 2, 'erreur : relue à l\'appel suivant');
  // relecture en arrière-plan en échec : la dernière lecture reste, erreur signalée
  o.t += 70000; const src = { v: 1 }, l2 = loader(src); await o.c.get('x', l2); o.t += 70000; let err = null;
  await o.c.get('x', () => Promise.reject(new Error('coupure')), { done: (ch, e) => { err = e; } }); await tick();
  assert.match(String(err), /coupure/); assert.strictEqual((await o.c.get('x', l2)).stale, true);
});

test('vidé par une écriture : une lecture commencée avant n\'est pas gardée', async () => {
  const o = mk(); let ok; const l = () => new Promise(r => { ok = r; });
  const p = o.c.get('k', l); await tick(); o.c.drop(); ok(['avant écriture']);
  assert.deepStrictEqual((await p).v, ['avant écriture']);
  const l2 = loader({ v: ['après'] }); assert.deepStrictEqual((await o.c.get('k', l2)).v, ['après']); assert.strictEqual(l2.n, 1);
});

test('autre utilisateur : jamais la lecture du précédent, même commencée avant le changement', async () => {
  const o = mk(), la = loader({ v: ['agence A'] }), lb = loader({ v: ['agence B'] });
  await o.c.get('k', la); o.u = 'B';
  assert.deepStrictEqual((await o.c.get('k', lb)).v, ['agence B']); assert.strictEqual(lb.n, 1);
  // lecture lancée par A, terminée après le passage à B : pas gardée pour B
  o.u = 'A'; o.t += 700000; let ok; const p = o.c.get('j', () => new Promise(r => { ok = r; })); await tick(); o.u = 'B'; ok(['données de A']); await p;
  const lb2 = loader({ v: ['données de B'] }); assert.deepStrictEqual((await o.c.get('j', lb2)).v, ['données de B']); assert.strictEqual(lb2.n, 1);
});

test('marqué à relire (alerte, passage du collecteur reçus en temps réel) : rendu aussitôt puis relu ; chaque appel a sa propre copie', async () => {
  const o = mk(), src = { v: [{ id: 1, st: 'À traiter' }] }, l = loader(src);
  await o.c.get('k', l); o.t += 5000; o.c.touch(); let ch = null;
  const r = await o.c.get('k', l, { done: c => { ch = c; } });
  assert.strictEqual(r.stale, true, 'moins d\'1 min mais marquée : relue'); await tick(); assert.strictEqual(l.n, 2); assert.strictEqual(ch, false);
  assert.strictEqual((await o.c.get('k', l)).stale, false, 'relue : plus marquée');
  // une page modifie ses lignes (statut, champs calculés) : la lecture gardée et les autres pages ne changent pas
  const a = (await o.c.get('k', l)).v; a[0].st = 'Traité'; a[0]._sh = 'Jour';
  assert.deepStrictEqual((await o.c.get('k', l)).v, [{ id: 1, st: 'À traiter' }]);
});

test('taille bornée : les clés les moins récemment utilisées partent', async () => {
  const c = cacheNew({ size: 3 }), l = loader({ v: 1 });
  for (const k of ['a', 'b', 'c']) await c.get(k, l);
  await c.get('a', l); await c.get('d', l);
  assert.strictEqual(c.count(), 3); assert.strictEqual(l.n, 4);
  await c.get('a', l); assert.strictEqual(l.n, 4, 'a gardée'); await c.get('b', l); assert.strictEqual(l.n, 5, 'b retirée');
});

test('écritures reconnues : insert / update / delete / fonctions qui écrivent ; lectures, signal de présence et stockage ignorés', async () => {
  const U = 'https://x.supabase.co/rest/v1/';
  assert.strictEqual(cacheWrites(U + 'journal?select=*&day=gte.2026-10-01', 'GET'), false);
  assert.strictEqual(cacheWrites(U + 'alerts?select=id&severity=eq.Critique', 'HEAD'), false);
  assert.strictEqual(cacheWrites(U + 'alerts?id=eq.A%7C1', 'PATCH'), true);
  assert.strictEqual(cacheWrites(U + 'jobs?select=id', 'POST'), true);
  assert.strictEqual(cacheWrites(U + 'parc?plate=eq.X', 'DELETE'), true);
  assert.strictEqual(cacheWrites(U + 'rpc/alert_counts?order=vehicle_key.asc&offset=0&limit=1000', 'POST'), false);
  assert.strictEqual(cacheWrites(U + 'rpc/session_ping', 'POST'), false);
  assert.strictEqual(cacheWrites(U + 'rpc/import_contracts', 'POST'), true);
  assert.strictEqual(cacheWrites(U + 'rpc/fonction_inconnue', 'POST'), true, 'fonction inconnue : supposée écrire');
  assert.strictEqual(cacheWrites(U + 'user_sessions?id=eq.x', 'PATCH'), false);
  assert.strictEqual(cacheWrites('https://x.supabase.co/storage/v1/object/manifestes/a.pdf', 'POST'), false);
  assert.strictEqual(cacheWrites('https://x.supabase.co/auth/v1/token?grant_type=password', 'POST'), false);
  // fetch du client : vidé avant l'envoi et à la réponse
  const c = cacheNew(); let drops = 0; const d = c.drop; c.drop = () => { drops++; d(); };
  const seen = [], f = cacheFetch(() => c, (u, o) => { seen.push([o.method, drops]); return Promise.resolve('ok'); });
  await f(U + 'journal?select=*', { method: 'GET' }); assert.strictEqual(drops, 0);
  assert.strictEqual(await f(U + 'alerts?id=eq.1', { method: 'PATCH' }), 'ok');
  assert.deepStrictEqual(seen, [['GET', 0], ['PATCH', 1]]); assert.strictEqual(drops, 2);
  await assert.rejects(cacheFetch(() => c, () => Promise.reject(new Error('refusé')))(U + 'alerts', { method: 'POST' }), /refusé/);
  assert.strictEqual(drops, 4, 'écriture refusée : vidé quand même');
});
