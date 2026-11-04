import {resolveBackendTarget} from './database-target.mjs';
import {assertLocalSupabase, requestAllowed} from './fleet.mjs';
import {readLocalJson} from './local-json.mjs';
import {createProviderEarningsStore} from './provider-earnings-store.mjs';
import {boltFinancialCapabilities} from './bolt-finance.mjs';

const fail = (status, message) => Object.assign(Error(message), {status});
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function createProviderEarningsApi({supabaseUrl,databaseTarget, anonKey, serviceKey, fetchFn = fetch, now = Date.now}) {
  const base = resolveBackendTarget(supabaseUrl,databaseTarget);
  if (!anonKey || !serviceKey) throw Error('Clés locales requises.');
  const headers = token => ({apikey: token === serviceKey ? serviceKey : anonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'});
  async function db(table, {token = serviceKey, params = {}, method = 'GET', body} = {}) {
    const response = await fetchFn(base + '/rest/v1/' + table + '?' + new URLSearchParams(params), {
      method, headers: headers(token), redirect: 'error', signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : {body: JSON.stringify(body)})
    });
    if (!response.ok) throw fail(502, 'Données financières locales indisponibles.');
    return readLocalJson(response);
  }
  async function authenticate(req) {
    const token = String(req.headers.authorization || '').match(/^Bearer (\S+)$/)?.[1];
    if (!token) throw fail(401, 'Connexion Ludy requise.');
    const response = await fetchFn(base + '/auth/v1/user', {headers: headers(token), redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw fail(401, 'Session Ludy expirée.');
    const user = await readLocalJson(response);
    if (!UUID.test(user?.id || '')) throw fail(401, 'Session Ludy invalide.');
    const profile = await db('profiles', {token, params: {select: 'user_id,role', user_id: 'eq.' + user.id}});
    if (profile?.length !== 1 || !['admin', 'manager'].includes(profile[0].role)) throw fail(403, 'Accès financier réservé à la gestion.');
    return {token, role: profile[0].role};
  }
  async function settings() {
    const rows = await db('uber_report_settings', {params: {id: 'eq.1', select: 'enabled,organization_id,organization_label'}});
    if (rows?.length !== 1) throw fail(409, 'Configurer la flotte Uber dans les rapports.');
    return rows[0];
  }
  const store = createProviderEarningsStore({now, db: {rpc: async(name, args) => ({data: await db('rpc/' + name, {method: 'POST', body: args}), error: null})},
    organizationId: async() => {
      const config = await settings();
      if (!config.enabled || !UUID.test(config.organization_id || '')) throw fail(409, 'Activer et configurer la flotte Uber avant la collecte Earnings.');
      return config.organization_id;
    }});
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw fail(413, 'Relevé trop volumineux.'); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'Requête JSON invalide.'); }
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => key !== 'snapshot') || !value.snapshot) throw fail(400, 'Relevé Earnings requis.');
    return value.snapshot;
  }
  return async(req, res) => {
    const send = (status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
    try {
      if (!requestAllowed(req)) throw fail(403, 'Accès local requis.');
      const url = new URL(req.url, 'http://127.0.0.1:4173');
      const auth = await authenticate(req);
      if (url.pathname === '/api/provider-earnings/config' && req.method === 'GET') {
        const config = await settings();
        send(200, {uber: {enabled: config.enabled === true && UUID.test(config.organization_id || ''),
          organization_id: UUID.test(config.organization_id || '') ? config.organization_id : null,
          organization_label: typeof config.organization_label === 'string' ? config.organization_label : null,
          time_zone: 'Africa/Casablanca', collection: 'authenticated_browser', interval_seconds: 300, interval_basis: 'after_completion'}, bolt: boltFinancialCapabilities()});
      } else if (url.pathname === '/api/provider-earnings/uber' && req.method === 'POST') {
        if (auth.role !== 'admin') throw fail(403, 'Administrateur requis pour recevoir les relevés.');
        send(200, await store.ingest(await body(req)));
      } else send(404, {error: 'Action financière inconnue.'});
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      send(status, {error: status < 500 ? error.message : 'Lecture ou enregistrement des relevés indisponible.'});
    }
    return true;
  };
}
