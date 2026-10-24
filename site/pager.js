// Pages des tableaux longs : 50 / 100 / 200 lignes par page, « Page x / y », nombre total de lignes, page remise à 1 quand
// le tri, les filtres, la recherche ou la période changent. Deux façons :
// - à l'affichage (table(…, { page: true })) : toutes les lignes sont lues, triées et totalisées, seule la page est dessinée
//   (totaux, rangs, PDF et tableurs restent calculés sur toutes les lignes) ;
// - par la base (pgQuery + pgLoad, table(…, { server })) : seule la page est lue (PostgREST range + count exact, tri fixe
//   complété par la clé), pour les listes qui ne font qu'afficher des lignes (alertes, journal technique…).
// Calculs purs (pgCalc, pgState, pgResize, pgOrderOf, pgBar) testés sous Node : tests/pager.test.js.

const PG_SIZES = [50, 100, 200], PG_DEF = 50;
const PG = { st: null, cb: {} };   // st : { id: { page, size, sig } } (gardé pour la session de l'onglet) ; cb : relecture d'un tableau lu par la base

/** Page demandée bornée : { page, pages, size, total, from, to } (from inclus, to exclu, à partir de 0) */
function pgCalc(total, page, size) {
  size = PG_SIZES.indexOf(+size) >= 0 ? +size : PG_DEF;
  total = Math.max(0, Math.floor(+total) || 0);
  const pages = Math.max(1, Math.ceil(total / size)), p = Math.min(Math.max(1, Math.floor(+page) || 1), pages);
  return { page: p, pages, size, total, from: (p - 1) * size, to: Math.min(total, p * size) };
}
/** Lignes de la page */
function pgSlice(rows, c) { return rows.slice(c.from, c.to); }
/** État d'un tableau dans store : page remise à 1 quand la signature (tri, filtres, recherche, période) change */
function pgState(store, id, sig, size) {
  const s = store[id] || (store[id] = { page: 1, size: size || PG_DEF, sig });
  if (s.sig !== sig) { s.sig = sig; s.page = 1; }
  return s;
}
/** Nouvelle taille de page : la première ligne affichée reste dans la page */
function pgResize(c, size) { return Math.floor(c.from / size) + 1; }
/** Tri de la base toujours complété par la clé (sinon les pages peuvent répéter ou sauter des lignes) : [[colonne, croissant, nulls en premier]] */
function pgOrderOf(order, pk) {
  const out = (order || []).map(o => [o[0], o[1] !== false, o[2]]), seen = {};
  out.forEach(o => { seen[o[0]] = 1; });
  String(pk || 'id').split(',').forEach(k => { if (!seen[k]) out.push([k, true, undefined]); });
  return out;
}
function pgText(c) { return c.total ? 'Lignes ' + (c.from + 1) + ' à ' + c.to + ' sur ' + c.total : 'Aucune ligne'; }
/** Barre de pages sous le tableau (rien si toutes les lignes tiennent dans la plus petite page) */
function pgBar(id, c) {
  if (c.total <= PG_SIZES[0]) return '';
  const b = (k, to, txt, lbl, cls) => `<button type="button" class="ghost small${cls ? ' ' + cls : ''}" data-pgp="${id}" data-k="${k}" data-to="${to}"${to < 1 || to > c.pages || to === c.page ? ' disabled' : ''} aria-label="${lbl}">${txt}</button>`;
  return `<nav class="pager" data-pg="${id}" data-total="${c.total}" aria-label="Pages du tableau">${b('first', 1, '«', 'Première page', 'pgx')}${b('prev', c.page - 1, '‹ Précédente', 'Page précédente')}` +
    `<span class="pgi">Page <b>${c.page}</b> / ${c.pages}</span>${b('next', c.page + 1, 'Suivante ›', 'Page suivante')}${b('last', c.pages, '»', 'Dernière page', 'pgx')}` +
    `<span class="pgn">${pgText(c)}</span><label class="pgs">Lignes par page <select data-pgs="${id}">${PG_SIZES.map(n => `<option${n === c.size ? ' selected' : ''}>${n}</option>`).join('')}</select></label></nav>`;
}

// ---------- Navigateur : état gardé pour la session, taille de page mémorisée, clics ----------
function pgLs(store, k, v) { try { const s = store === 's' ? sessionStorage : localStorage; if (v === undefined) return JSON.parse(s.getItem(k) || 'null'); s.setItem(k, JSON.stringify(v)); } catch (e) { } return null; }
function pgStore() { if (!PG.st) { const s = pgLs('s', 'pg'); PG.st = s && typeof s === 'object' ? s : {}; } return PG.st; }
function pgSave() { pgLs('s', 'pg', PG.st || {}); }
/** Taille choisie pour ce tableau (mémorisée dans ce navigateur) */
function pgSizeOf(id) { const m = pgLs('l', 'pgsize') || {}; return PG_SIZES.indexOf(+m[id]) >= 0 ? +m[id] : PG_DEF; }
/** État du tableau id pour la signature sig */
function pgGet(id, sig) { const s = pgState(pgStore(), id, sig, pgSizeOf(id)); pgSave(); return s; }
/** Contexte de la page affichée : adresse, période, agence, « Mes véhicules » (changés = page 1) */
function pgCtx() { let a = ''; try { a = [location.hash, localStorage.getItem('periode'), localStorage.getItem('agence'), localStorage.getItem('mesveh')].join('|'); } catch (e) { a = String(location.hash); } return a; }
/** Signature d'un tableau paginé à l'affichage : tri, filtres de la page (sig), contexte */
function pgSigOf(sort, sig) { return JSON.stringify([sort.c === undefined ? null : sort.c, !!sort.d, sig === undefined ? '' : sig, pgCtx()]); }
/** Redessine le tableau : sa relecture dans la base, sinon la page (window.__repage, plus légère, ou window.__rerender) */
function pgRun(id, k) {
  const fn = PG.cb[id] || window.__repage || window.__rerender; if (!fn) return;
  Promise.resolve(fn()).then(() => {
    const t = document.getElementById(id) || document.querySelector('[data-pg="' + id + '"]');
    if (t && t.getBoundingClientRect().top < 0) t.scrollIntoView({ block: 'start' });
    const b = k && document.querySelector('[data-pg="' + id + '"] [data-k="' + k + '"]:not([disabled])'); if (b) b.focus({ preventScroll: true });
  }).catch(e => { if (window.alert) alert('Lecture impossible : ' + (e.message || e)); });
}
function pgGo(id, page, k) { const s = pgStore()[id]; if (!s) return; s.page = page; pgSave(); pgRun(id, k); }
function pgSize(id, size) {
  const s = pgStore()[id]; if (!s || PG_SIZES.indexOf(size) < 0) return;
  s.page = pgResize({ from: (s.page - 1) * s.size }, size); s.size = size; pgSave();
  const m = pgLs('l', 'pgsize') || {}; m[id] = size; pgLs('l', 'pgsize', m);
  pgRun(id);
}
/**
 * Lecture d'une page dans la base : fonction (from, size) -> { rows, total } ; total = count exact de PostgREST (mêmes filtres).
 * Page au-delà de la fin (lignes retirées entre deux lectures) : total relu, pgLoad redemande la dernière page.
 */
function pgQuery(table, cols, build, order) {
  const mk = head => { let q = sb.from(table).select(cols || '*', { count: 'exact', head: !!head }); return build ? build(q) : q; };
  return async (from, size) => {
    let q = mk();
    pgOrderOf(order, PK[table]).forEach(o => { const opt = { ascending: o[1] }; if (o[2] !== undefined) opt.nullsFirst = o[2]; q = q.order(o[0], opt); });
    const { data, error, count } = await q.range(from, from + size - 1);
    if (error && (error.code === 'PGRST103' || /range/i.test(error.message || ''))) {
      const h = await mk(true); if (h.error) throw new Error(table + ' : ' + h.error.message);
      return { rows: [], total: h.count || 0 };
    }
    if (error) throw new Error(table + ' : ' + error.message);
    return { rows: data || [], total: count === null || count === undefined ? (data || []).length : count };
  };
}
/** Page courante du tableau id lue par fetch : { rows, c } (c = pgCalc, à passer à table(…, { server: c })) */
async function pgLoad(id, sig, fetch) {
  const s = pgGet(id, sig);
  let r = await fetch((s.page - 1) * s.size, s.size), c = pgCalc(r.total, s.page, s.size);
  if (c.page !== s.page) { s.page = c.page; pgSave(); r = await fetch(c.from, s.size); c = pgCalc(r.total, c.page, s.size); }
  return { rows: r.rows, c };
}
/** Tri d'un tableau lu par la base : colonne cliquée (window.__sort) -> ordre de la base (map : { index: [[colonne]] }), sinon def */
function pgSortOrder(id, map, def) {
  const st = (window.__sort || {})[id] || {}, m = st.c !== undefined && map[st.c];
  return { order: m ? m.map(x => [x[0], !st.d, x[1]]) : def, sig: m ? st.c + (st.d ? 'd' : 'a') : '' };
}
/**
 * Tableau lu par la base dans le bloc boxId (le reste de la page n'est pas redessiné) : relu à chaque page ou tri.
 * opt = { select (colonnes lues), build (filtres), order (tri par défaut), sort ({ index de colonne: [[colonne de la base]] }), sig, empty }
 */
async function pgBox(boxId, id, tbl, cols, opt) {
  const load = async () => {
    const o = pgSortOrder(id, opt.sort || {}, opt.order);
    const r = await pgLoad(id, JSON.stringify([opt.sig || '', o.sig]), pgQuery(tbl, opt.select, opt.build, o.order));
    const b = document.getElementById(boxId); if (!b) return;
    b.innerHTML = table(id, cols, r.rows, { server: r.c, sortable: Object.keys(opt.sort || {}).map(Number), empty: opt.empty });
  };
  PG.cb[id] = load;
  try { await load(); } catch (e) { const b = document.getElementById(boxId); if (b) b.innerHTML = msg('Lecture impossible : ' + esc(e.message || e), 'err'); }
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button[data-pgp]'); if (!b || b.disabled) return; pgGo(b.dataset.pgp, +b.dataset.to, b.dataset.k); });
  document.addEventListener('change', e => { const s = e.target.closest && e.target.closest('select[data-pgs]'); if (s) pgSize(s.dataset.pgs, +s.value); });
  // autre page : relectures et redessin léger de la page précédente oubliés (avant route(), pager.js est chargé avant app.js)
  window.addEventListener('hashchange', () => { PG.cb = {}; window.__repage = null; });
}
if (typeof module !== 'undefined') module.exports = { PG_SIZES, PG_DEF, pgCalc, pgSlice, pgState, pgResize, pgOrderOf, pgText, pgBar };
