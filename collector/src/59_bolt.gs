// ============================================================================
// BOLT FLEET : API de gestion de flotte (04/11/2026, demande d'Ahmed)
// Identifiants saisis dans Ludy (Réglages > Intégrations > Bolt : table integration_secrets, lue seulement avec la clé service),
// sinon propriétés du script BOLT_CLIENT_ID / BOLT_CLIENT_SECRET. OAuth 2.0 client credentials (jeton de 10 min, gardé 9 min
// en cache), appels POST JSON sur la passerelle « fleet-integration-gateway ».
// Pour l'instant : test de connexion (demande bolt_test, administrateur). La lecture des courses en espèces sera branchée une fois
// l'accès de la clé à la société activé par Bolt (réponse NOT_AUTHORIZED au 04/11/2026).
// ============================================================================
const BOLT_TOKEN_URL_ = 'https://oidc.bolt.eu/token';
const BOLT_API_ = 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1';
function boltCred_() {
  let rows = []; try { rows = dbSelect_('integration_secrets', 'select=name,value', 'name'); } catch (e) { rows = []; }
  const m = {}; rows.forEach(r => { m[r.name] = r.value; });
  const p = PropertiesService.getScriptProperties();
  return { id: String(m.bolt_client_id || p.getProperty('BOLT_CLIENT_ID') || '').trim(), secret: String(m.bolt_client_secret || p.getProperty('BOLT_CLIENT_SECRET') || '').trim(),
    companies: String(m.bolt_company_id || p.getProperty('BOLT_COMPANY_ID') || '').split(/\s*,\s*/).filter(x => /^\d+$/.test(x)).map(Number) };
}
function boltToken_(c) {
  const ck = 'BOLT_TOK|' + c.id.replace(/[^\w-]/g, '').slice(0, 60), cache = CacheService.getScriptCache(), hit = cache.get(ck);
  if (hit) return hit;
  const r = UrlFetchApp.fetch(BOLT_TOKEN_URL_, { method: 'post', muteHttpExceptions: true, contentType: 'application/x-www-form-urlencoded',
    payload: { client_id: c.id, client_secret: c.secret, grant_type: 'client_credentials', scope: 'fleet-integration:api' } });
  let d = {}; try { d = JSON.parse(r.getContentText()); } catch (e) { }
  if (r.getResponseCode() !== 200 || !d.access_token) throw new Error('identifiants refusés par Bolt (HTTP ' + r.getResponseCode() + (d.error ? ', ' + d.error : '') + ')');
  cache.put(ck, d.access_token, Math.max(60, Math.min(540, (+d.expires_in || 600) - 60)));
  return d.access_token;
}
/** Appel de l'API : body null = GET ; réponse { code, message, data } de Bolt (code 0 = réussite) */
function boltCall_(tok, path, body) {
  const o = { method: body == null ? 'get' : 'post', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tok } };
  if (body != null) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(BOLT_API_ + path, o);
  let d; try { d = JSON.parse(r.getContentText()); } catch (e) { d = { code: r.getResponseCode(), message: 'réponse illisible (HTTP ' + r.getResponseCode() + ')' }; }
  return d;
}
const BOLT_ERR_ = { NOT_AUTHORIZED: 'la clé n\'a pas accès aux données de la société (accès à activer par Bolt, ou clé créée depuis une autre société)', INVALID_REQUEST: 'requête refusée' };
function boltErr_(d) { return (BOLT_ERR_[d.message] || d.message || 'erreur') + ' [' + d.code + (d.message ? ' ' + d.message : '') + ']'; }
/** Demande bolt_test (Réglages > Intégrations, administrateur) : jeton, sociétés visibles, courses des dernières 24 h de chaque société */
function jobBoltTest_(createdBy) {
  const adm = createdBy ? dbSelect_('profiles', 'select=user_id&role=eq.admin&user_id=eq.' + createdBy, 'user_id') : [];
  if (!adm.length) return 'Refusé : réservé à l\'administrateur';
  const c = boltCred_();
  if (!c.id || !c.secret) return 'Connexion Bolt : identifiant ou secret manquant (Réglages > Intégrations > Bolt)';
  let tok; try { tok = boltToken_(c); } catch (e) { return 'Connexion Bolt : ' + e.message; }
  const out = ['jeton d\'accès obtenu'];
  const comp = boltCall_(tok, '/getCompanies', null);
  const seen = comp.code === 0 && comp.data && Array.isArray(comp.data.companies) ? comp.data.companies : null;
  out.push(seen ? 'sociétés visibles : ' + (seen.map(x => x.name + ' (n° ' + x.id + ')').join(', ') || 'aucune') : 'liste des sociétés : ' + boltErr_(comp));
  const ids = c.companies.length ? c.companies : (seen || []).map(x => +x.id);
  if (!ids.length) out.push('numéro de société Bolt à saisir (adresse du portail : fleets.bolt.eu/<numéro>/…)');
  const now = Math.floor(Date.now() / 1000);
  ids.forEach(id => {
    const d = boltCall_(tok, '/getFleetOrders', { offset: 0, limit: 1000, company_ids: [id], company_id: id, start_ts: now - 86400, end_ts: now, time_range_filter_type: 'created' });
    out.push('société ' + id + ' : ' + (d.code === 0 ? ((d.data && d.data.orders) || []).length + ' course(s) lue(s) sur les dernières 24 h' : boltErr_(d)));
  });
  return 'Connexion Bolt : ' + out.join(' ; ');
}
