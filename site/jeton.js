// Jeton de connexion refusé (signalé par Ahmed le 12/11/2026 : « erreur de token » au manifeste dans l'application Android).
// Dans une vue web de téléphone, l'application passe en arrière-plan : les minuteurs de la page s'arrêtent, le jeton (1 h) n'est pas
// renouvelé à temps, et la première demande au retour part avec un jeton expiré (dépôt du PDF refusé, manifeste sans PDF).
// Toute demande à la base, au stockage ou aux fonctions refusée pour cause de jeton est rejouée une fois avec un jeton renouvelé ;
// un seul renouvellement à la fois. Le site n'a besoin d'aucune nouvelle application.
/** Jeton refusé ? (PostgREST : 401 « JWT expired » ; Storage : 400/403 « jwt expired », « Invalid Compact JWS », « exp claim… ») */
function jwtRefused(status, txt) {
  if (status !== 401 && status !== 400 && status !== 403) return false;
  const t = String(txt || '');
  if (/row-level security|permission denied|violates/i.test(t)) return false;   // droits : rien à voir avec le jeton
  return /jwt|jws|token|exp claim|signature/i.test(t);
}
function jwtAuthOf(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get('Authorization') || headers.get('authorization') || '';
  return headers.Authorization || headers.authorization || '';
}
function jwtWithAuth(opt, token) {
  const o = Object.assign({}, opt || {}), h = o.headers;
  if (h && typeof h.set === 'function') { const n = new Headers(h); n.set('Authorization', 'Bearer ' + token); o.headers = n; }
  else { const n = Object.assign({}, h || {}); delete n.authorization; n.Authorization = 'Bearer ' + token; o.headers = n; }
  return o;
}
/**
 * fetch donné au client Supabase : o = { base (adresse Supabase), anon (clé publique), refresh() → nouveau jeton ou null, lost() }.
 * Les demandes de connexion (/auth/v1/) ne passent jamais par ici (pas de boucle) ; une demande sans jeton d'utilisateur non plus.
 */
function jwtRetryFetch(inner, o) {
  let wait = null;
  const fresh = () => wait || (wait = Promise.resolve().then(o.refresh).catch(() => null).then(t => { wait = null; return t || null; }));
  return async (url, opt) => {
    const u = String((url && url.url) || url || '');
    if (!o.base || u.indexOf(o.base) !== 0 || !/\/(rest|storage|functions)\/v1\//.test(u)) return inner(url, opt);
    const tok = jwtAuthOf(opt && opt.headers).replace(/^Bearer\s+/i, '');
    const r = await inner(url, opt);
    if (!tok || tok === o.anon || r.ok) return r;
    let txt = '';
    try { txt = await r.clone().text(); } catch (e) { return r; }
    if (!jwtRefused(r.status, txt)) return r;
    const nt = await fresh();
    if (!nt) { if (o.lost) o.lost(); return r; }
    if (nt === tok) return r;
    return inner(url, jwtWithAuth(opt, nt));
  };
}
if (typeof module !== 'undefined') module.exports = { jwtRefused, jwtRetryFetch, jwtWithAuth };
