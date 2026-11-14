// ============================================================================
// UBER : API officielle des flottes (Supplier Platform), 14/11/2026, demande d'Ahmed.
// Identifiants de l'application créée par Ahmed sur le tableau de bord développeur d'Uber (developer.uber.com), saisis dans Ludy
// (Réglages > Intégrations > Uber : coffre integration_secrets, lu seulement avec la clé service).
// Jeton : OAuth 2.0 client credentials (https://auth.uber.com/oauth/v2/token, 30 jours), un droit (scope) par fonction ; chaque droit
// doit être activé par Uber sur l'application. Le test essaie chaque droit séparément et dit lesquels Uber a ouverts, puis lit
// l'organisation de la flotte et le statut des chauffeurs (en ligne, hors ligne, en course) si c'est permis.
// ============================================================================
const UBER_TOKEN_URL_ = 'https://auth.uber.com/oauth/v2/token', UBER_API_ = 'https://api.uber.com';
const UBER_SCOPES_ = [
  ['vehicle_suppliers.organizations.read', 'organisation de la flotte'],
  ['solutions.suppliers.drivers.status.read', 'statut des chauffeurs en temps réel'],
  ['supplier.fleet.drivers.live_location.read', 'position des chauffeurs en direct']];
function uberCred_() {
  let rows = []; try { rows = dbSelect_('integration_secrets', 'select=name,value', 'name'); } catch (e) { rows = []; }
  const m = {}; rows.forEach(r => { m[r.name] = r.value; });
  return { id: String(m.uber_client_id || '').trim(), secret: String(m.uber_client_secret || '').trim() };
}
/** Jeton pour un droit ; { tok } ou { err } (droit non ouvert par Uber, identifiants refusés…) */
function uberToken_(c, scope) {
  const ck = 'UBER_TOK|' + c.id.replace(/[^\w-]/g, '').slice(0, 40) + '|' + scope, cache = CacheService.getScriptCache(), hit = cache.get(ck);
  if (hit) return { tok: hit };
  const r = UrlFetchApp.fetch(UBER_TOKEN_URL_, { method: 'post', muteHttpExceptions: true, contentType: 'application/x-www-form-urlencoded',
    payload: { client_id: c.id, client_secret: c.secret, grant_type: 'client_credentials', scope } });
  let d = {}; try { d = JSON.parse(r.getContentText()); } catch (e) { }
  if (r.getResponseCode() !== 200 || !d.access_token) return { err: (d.error || 'HTTP ' + r.getResponseCode()) + (d.error_description ? ' : ' + d.error_description : ''), code: r.getResponseCode(), error: d.error || '' };
  cache.put(ck, d.access_token, Math.max(60, Math.min(21600, (+d.expires_in || 3600) - 60)));
  return { tok: d.access_token };
}
function uberGet_(tok, path) {
  const r = UrlFetchApp.fetch(UBER_API_ + path, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tok } });
  let d = null; try { d = JSON.parse(r.getContentText()); } catch (e) { }
  return { code: r.getResponseCode(), data: d };
}
/** Demande uber_test (Réglages > Intégrations, administrateur) : droits ouverts par Uber, organisation, statuts des chauffeurs */
function jobUberTest_(createdBy) {
  const adm = createdBy ? dbSelect_('profiles', 'select=user_id&role=eq.admin&user_id=eq.' + createdBy, 'user_id') : [];
  if (!adm.length) return 'Refusé : réservé à l\'administrateur';
  const c = uberCred_();
  if (!c.id || !c.secret) return 'Connexion Uber : identifiant ou secret manquant (Réglages > Intégrations > Uber)';
  const out = [], tok = {};
  for (const [s, label] of UBER_SCOPES_) {
    const t = uberToken_(c, s);
    if (t.tok) { tok[s] = t.tok; out.push(label + ' : ouvert'); }
    else if (t.error === 'invalid_client' || t.code === 401) return 'Connexion Uber : identifiants refusés par Uber (' + t.err + ')';
    else out.push(label + ' : non ouvert par Uber (' + t.err + ')');
  }
  let org = null;
  if (tok[UBER_SCOPES_[0][0]]) {
    const o = uberGet_(tok[UBER_SCOPES_[0][0]], '/v1/vehicle-suppliers/orgs');
    const list = o.data && (o.data.organizations || o.data.orgs || o.data.data || (Array.isArray(o.data) ? o.data : null));
    if (o.code === 200 && list) { org = list[0] && (list[0].id || (list[0].org_id && list[0].org_id.value)); out.push('organisations : ' + (list.map(x => (x.name || x.id || '?')).join(', ') || 'aucune')); }
    else out.push('organisations : refusé (HTTP ' + o.code + ')');
  }
  if (tok[UBER_SCOPES_[1][0]] && org) {
    const d = uberGet_(tok[UBER_SCOPES_[1][0]], '/v1/vehicle-suppliers/drivers/actions?org_id=' + encodeURIComponent(org) + '&page_size=100');
    if (d.code === 200 && d.data) {
      const n = {}; (d.data.driverStatusOverviews || []).forEach(x => { const e = (x.statusEntries || []).slice(-1)[0]; const s = e ? e.status : 'sans activité'; n[s] = (n[s] || 0) + 1; });
      out.push('chauffeurs lus : ' + (Object.keys(n).map(k => k.replace('DRIVER_STATUS_', '').toLowerCase() + ' ' + n[k]).join(', ') || 'aucun'));
    } else out.push('statuts des chauffeurs : refusé (HTTP ' + d.code + ')');
  }
  return 'Connexion Uber : ' + out.join(' ; ');
}
