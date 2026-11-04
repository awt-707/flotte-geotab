import {resolveBackendTarget} from './database-target.mjs';
import {assertLocalSupabase, requestAllowed} from './fleet.mjs';
import {readLocalJson} from './local-json.mjs';

const fail = (status, message) => Object.assign(new Error(message), {status});
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Admin-only cached health and explicit read-only verification. This endpoint
 * cannot accept credentials, provider URLs, vehicle filters or timestamps. */
export function createTeksatApi({supabaseUrl,databaseTarget, anonKey, service, fetchFn = fetch} = {}) {
  const base = resolveBackendTarget(supabaseUrl,databaseTarget);
  if (!anonKey || typeof service?.getStatus !== 'function' || typeof service?.refreshReadOnly !== 'function') throw new TypeError('Service Teksat local requis.');
  async function authenticate(req) {
    const token = String(req.headers.authorization || '').match(/^Bearer (\S+)$/)?.[1];
    if (!token) throw fail(401, 'Connexion Ludy requise.');
    const headers = {apikey: anonKey, Authorization: 'Bearer ' + token};
    const response = await fetchFn(base + '/auth/v1/user', {headers, redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw fail(401, 'Session Ludy expirée.');
    const user = await readLocalJson(response);
    if (!UUID.test(user?.id || '')) throw fail(401, 'Session Ludy invalide.');
    const profile = await fetchFn(base + '/rest/v1/profiles?' + new URLSearchParams({select: 'user_id,role', user_id: 'eq.' + user.id}),
      {headers, redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!profile.ok) throw fail(profile.status === 401 ? 401 : 403, 'Accès administrateur requis.');
    const rows = await readLocalJson(profile);
    if (rows?.length !== 1 || rows[0].role !== 'admin') throw fail(403, 'Accès administrateur requis.');
    return user.id;
  }
  async function emptyBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {size += chunk.length; if (size > 1024) throw fail(413, 'Requête trop volumineuse.'); chunks.push(chunk);}
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return;
    let data; try {data = JSON.parse(raw);} catch {throw fail(400, 'Requête JSON invalide.');}
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length) throw fail(400, 'Aucun paramètre attendu.');
  }
  return async(req, res) => {
    const send = (status, value) => {res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));};
    try {
      if (!requestAllowed(req)) throw fail(403, 'Accès local requis.');
      const url = new URL(req.url, 'http://127.0.0.1:4173');
      const identity = await authenticate(req);
      if (url.search) throw fail(400, 'Aucun paramètre attendu.');
      if (url.pathname === '/api/fleet/texat/status' && req.method === 'GET') send(200, service.getStatus());
      else if (url.pathname === '/api/fleet/texat/refresh' && req.method === 'POST') {
        await emptyBody(req); const result = await service.refreshReadOnly();
        if (await authenticate(req) !== identity) throw fail(403, 'Session modifiée pendant la vérification.');
        send(200, result);
      } else send(404, {error: 'Action Teksat inconnue.'});
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      send(status, {error: status === 429 ? 'Vérification déjà effectuée récemment. Réessaie dans quelques instants.' : status < 500 && !error.code ? error.message : 'Vérification Teksat indisponible.'});
    }
    return true;
  };
}
