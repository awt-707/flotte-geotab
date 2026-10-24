// Lectures de la base gardées en mémoire de la page (rien n'est écrit dans le navigateur) : une page déjà visitée s'affiche
// aussitôt avec la dernière lecture, relue en arrière-plan si elle a plus de CACHE_FRESH ; jamais affichée au-delà de CACHE_MAX.
// Vidé à chaque écriture vers la base (cacheFetch) et au changement d'utilisateur (cacheUser) ; marqué à relire à chaque alerte /
// passage du collecteur reçus en temps réel (touch) ; une lecture d'un autre utilisateur n'est jamais rendue (who).
// Chaque appel reçoit sa propre copie (une page qui modifie ses lignes ne change pas celles d'une autre). Testé sous Node (tests/cache.test.js).
const CACHE_FRESH = 60000, CACHE_MAX = 10 * 60000, CACHE_SIZE = 60;
/** Empreinte d'une lecture (texte JSON) : deux lectures identiques = même empreinte */
function cacheSig(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return s.length + ':' + (h >>> 0);
}
/**
 * Cache : get(clé, lecture, opt) → promesse de { v, at, stale }.
 * - lue il y a moins de fresh (et pas marquée à relire) : rendue telle quelle ;
 * - moins de max : rendue aussitôt (stale), relue en arrière-plan ; opt.stale(at) tout de suite, opt.done(changé, erreur) à la fin ;
 * - sinon : lue ; deux appels en même temps pour la même clé partagent la même lecture.
 * drop() : tout oublier (une lecture commencée avant n'est pas gardée) ; touch() : tout à relire, encore affichable.
 */
function cacheNew(o) {
  o = o || {};
  const m = new Map(), now = o.now || (() => Date.now());
  let gen = 0, ver = 0;
  const C = { fresh: o.fresh || CACHE_FRESH, max: o.max || CACHE_MAX, size: o.size || CACHE_SIZE, who: o.who || (() => '') };
  const read = (key, e, load) => {
    if (e.p) return e.p;
    const g = gen, vr = ver, t0 = now();
    e.p = Promise.resolve().then(load).then(v => {
      const s = JSON.stringify(v === undefined ? null : v), sig = cacheSig(s), changed = !e.has || sig !== e.sig;
      e.p = null;
      if (g === gen && m.get(key) === e && C.who() === e.u) Object.assign(e, { s, sig, at: t0, ver: vr, has: true });   // écriture ou autre utilisateur entre-temps : pas gardée
      return { s, at: t0, changed, kept: g === gen };
    }, err => { e.p = null; if (!e.has && m.get(key) === e) m.delete(key); throw err; });
    return e.p;
  };
  C.get = (key, load, opt) => {
    opt = opt || {};
    const u = C.who(), t = now();
    let e = m.get(key);
    if (e && e.u !== u) { m.delete(key); e = null; }
    if (e) { m.delete(key); m.set(key, e); }   // dernière utilisée en dernier (les plus anciennes partent d'abord)
    else { e = { u, has: false, p: null }; m.set(key, e); while (m.size > C.size) m.delete(m.keys().next().value); }
    if (e.has && e.ver === ver && t - e.at < C.fresh) return Promise.resolve({ v: JSON.parse(e.s), at: e.at, stale: false });
    if (e.has && t - e.at < C.max) {
      const at = e.at, s = e.s;
      if (opt.stale) opt.stale(at);
      read(key, e, load).then(r => { if (opt.done) opt.done(r.changed && r.kept, null); }, err => { if (opt.done) opt.done(false, err); });
      return Promise.resolve({ v: JSON.parse(s), at, stale: true });
    }
    return read(key, e, load).then(r => ({ v: JSON.parse(r.s), at: r.at, stale: false }));
  };
  C.drop = () => { gen++; m.clear(); };
  C.touch = () => { ver++; };
  C.gen = () => gen;
  C.count = () => m.size;
  return C;
}
// Fonctions de lecture seule (appel POST, rien n'est modifié) ; toute autre fonction de la base vide le cache
const CACHE_RO_RPC = { alert_counts: 1, driver_rule_counts: 1, shift_plan: 1, usage_stats: 1, plan_can_edit: 1, session_ping: 1 };
/** Requête vers la base qui peut modifier une donnée gardée (insert, update, delete, fonction qui écrit) */
function cacheWrites(url, method) {
  if (/^(GET|HEAD)$/i.test(method || 'GET')) return false;
  const m = String(url).match(/\/rest\/v1\/(rpc\/)?([^?/#]+)/); if (!m) return false;   // connexion, stockage, relais : aucune lecture gardée
  return m[1] ? !CACHE_RO_RPC[m[2]] : m[2] !== 'user_sessions';   // connexions (signal de présence) : jamais gardées
}
/** fetch du client Supabase : écriture = cache vidé avant l'envoi et à la réponse (lecture faite pendant l'écriture non gardée) */
function cacheFetch(c, f) {
  return (url, opt) => {
    const fx = f || fetch;
    if (!cacheWrites(url, opt && opt.method)) return fx(url, opt);
    c().drop();
    return fx(url, opt).finally(() => c().drop());
  };
}
let CACHE_UID = '';
const CACHE = cacheNew({ who: () => CACHE_UID });
/** Utilisateur connecté (session Supabase) : autre utilisateur ou déconnexion = tout est oublié (droits par agence) */
function cacheUser(session) { const u = (session && session.user && session.user.id) || ''; if (u !== CACHE_UID) { CACHE_UID = u; CACHE.drop(); } }

if (typeof module !== 'undefined') module.exports = { cacheNew, cacheSig, cacheWrites, cacheFetch, CACHE_FRESH, CACHE_MAX };
