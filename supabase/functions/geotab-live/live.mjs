// Relais Geotab en direct (Supabase Edge Function « geotab-live ») : position, vitesse, contact de chaque véhicule
// tels que Geotab les a reçus, à la demande de la page « En direct » (toutes les 5 s quand elle est ouverte).
// - Accès : jeton de l'utilisateur connecté ; la liste des véhicules est lue avec SES droits (agences), donc chacun
//   ne reçoit que les véhicules qu'il a le droit de voir. Compte en attente : aucun véhicule.
// - Identifiants Geotab : secrets de la fonction (GEO_USER, GEO_PWD, GEO_DB), jamais envoyés au navigateur.
// - Session Geotab gardée en mémoire et dans la table geotab_session (évite une connexion à chaque appel).
// - Réponse Geotab gardée 2 s : plusieurs écrans ouverts ne multiplient pas les appels à Geotab.
// Fichier sans dépendance, exécuté par Deno (index.ts) et par Node dans les tests.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const CACHE_MS = 2000, EVENTS_MIN = 30;   // événements de conduite renvoyés : 30 dernières minutes
const mem = { session: null, data: null, at: 0, pending: null };

export function resetMemory() { mem.session = null; mem.data = null; mem.at = 0; mem.pending = null; }
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** "1.02:13:05" ou "02:13:05" -> minutes */
export function durMin(s) { const m = String(s || '').match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/); return m ? (+(m[1] || 0)) * 1440 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 60 : null; }

async function geoCall(deps, server, method, params) {
  const r = await deps.fetch('https://' + server + '/apiv1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const j = await r.json();
  if (j.error) { const e = new Error((j.error.message || 'Geotab') + ''); e.geo = ((j.error.errors || [])[0] || {}).name || ''; throw e; }
  return j.result;
}
async function sessionDb(deps, sess) {
  const url = deps.env('SUPABASE_REST') || (deps.env('SUPABASE_URL') + '/rest/v1'), key = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) return null;
  const h = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  try {
    if (sess === undefined) { const r = await deps.fetch(url + '/geotab_session?select=server,credentials&id=eq.1', { headers: h }); const a = r.ok ? await r.json() : []; return a[0] && a[0].credentials ? a[0] : null; }
    await deps.fetch(url + '/geotab_session?on_conflict=id', { method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ id: 1, server: sess.server, credentials: sess.credentials, updated_at: new Date().toISOString() }]) });
  } catch (e) { /* la table est un confort : sans elle, la session reste en mémoire */ }
  return null;
}
async function authenticate(deps) {
  const user = deps.env('GEO_USER'), pwd = deps.env('GEO_PWD'), db = deps.env('GEO_DB') || 'clicar';
  if (!user || !pwd) throw Object.assign(new Error('Secrets GEO_USER / GEO_PWD absents (Supabase > Edge Functions > Secrets)'), { status: 503 });
  const r = await geoCall(deps, 'my.geotab.com', 'Authenticate', { userName: user, password: pwd, database: db });
  const server = r.path && r.path !== 'ThisServer' ? r.path : 'my.geotab.com';
  const sess = { server, credentials: r.credentials };
  mem.session = sess; await sessionDb(deps, sess);
  return sess;
}
/** Appel Geotab avec la session gardée ; nouvelle connexion si elle a expiré */
async function geo(deps, method, params) {
  if (!mem.session) mem.session = await sessionDb(deps) || await authenticate(deps);
  try { return await geoCall(deps, mem.session.server, method, { ...params, credentials: mem.session.credentials }); }
  catch (e) {
    if (!/InvalidUser|DbUnavailable/.test(e.geo + ' ' + e.message)) throw e;
    const s = await authenticate(deps);
    return geoCall(deps, s.server, method, { ...params, credentials: s.credentials });
  }
}
/** État de toute la flotte (un seul appel Geotab), gardé 2 s */
async function fleet(deps, ids) {
  const now = deps.now ? deps.now() : Date.now();
  if (mem.data && now - mem.at < CACHE_MS && ids.every(id => id in mem.data)) return mem.data;
  if (mem.pending) return mem.pending;
  mem.pending = (async () => {
    const iso = new Date(now).toISOString(), calls = [{ method: 'Get', params: { typeName: 'DeviceStatusInfo' } },
      // événements des règles Geotab (excès de vitesse, freinages, accélérations, virages, ceinture, collision) de toute la flotte
      { method: 'Get', params: { typeName: 'ExceptionEvent', search: { fromDate: new Date(now - EVENTS_MIN * 60000).toISOString() } } }];
    // contact : dernière valeur connue (même date de début et de fin = valeur en vigueur à cet instant)
    ids.forEach(id => calls.push({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id }, diagnosticSearch: { id: 'DiagnosticIgnitionId' }, fromDate: iso, toDate: iso } } }));
    const res = await geo(deps, 'ExecuteMultiCall', { calls }), out = {};
    ids.forEach((id, i) => { out[id] = { dsi: null, ign: (res[2 + i] || []).slice(-1)[0] || null, evts: [] }; });
    (res[0] || []).forEach(d => { const id = d.device && d.device.id; if (id in out) out[id].dsi = d; });
    (res[1] || []).forEach(e => { const id = e.device && e.device.id; if (id in out && e.state !== 'ExceptionEventStateInvalidId' && e.state !== 1) out[id].evts.push(e); });
    mem.data = out; mem.at = now; return out;
  })();
  try { return await mem.pending; } finally { mem.pending = null; }
}
/** Réponse : vehicles (état en direct) et events (événements Geotab des 30 dernières minutes, du plus récent au plus ancien) */
export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return json(401, { error: 'Connexion requise' });
  try {
    // Véhicules visibles par l'utilisateur (droits de la base : agences)
    const rest = deps.env('SUPABASE_REST') || (deps.env('SUPABASE_URL') + '/rest/v1');
    const vr = await deps.fetch(rest + '/vehicles?select=key,plate,geotab_id,active&geotab_id=not.is.null', { headers: { apikey: deps.env('SUPABASE_ANON_KEY') || '', Authorization: auth } });
    if (vr.status === 401) return json(401, { error: 'Connexion requise' });
    if (!vr.ok) return json(502, { error: 'Base : HTTP ' + vr.status });
    const veh = (await vr.json()).filter(v => String(v.active).toUpperCase() !== 'NON' && v.active !== false);
    if (!veh.length) return json(200, { at: new Date().toISOString(), vehicles: [] });
    const f = await fleet(deps, veh.map(v => v.geotab_id));
    const vehicles = veh.map(v => {
      const x = f[v.geotab_id] || {}, d = x.dsi, ignOn = x.ign ? +x.ign.data >= 1 : null;
      if (!d) return { key: v.key, plate: v.plate, state: 'Pas de réponse Geotab' };
      const comm = d.isDeviceCommunicating !== false, driving = !!d.isDriving;
      const state = !comm ? 'Boîtier hors ligne' : driving ? 'En route' : ignOn ? 'Arrêté, contact mis' : 'Garé';
      return { key: v.key, plate: v.plate, state, lat: d.latitude, lon: d.longitude, speed: driving ? Math.round(+d.speed || 0) : 0, bearing: d.bearing,
        at: d.dateTime, since_min: durMin(d.currentStateDuration), ign_on: ignOn };
    });
    const events = [];
    veh.forEach(v => ((f[v.geotab_id] || {}).evts || []).forEach(e => events.push({ id: String(e.id), key: v.key, plate: v.plate,
      rule: e.rule && e.rule.id ? String(e.rule.id) : '', at: e.activeFrom, end: e.activeTo || null, dur_min: durMin(e.duration), km: e.distance != null ? +e.distance : null })));
    events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return json(200, { at: new Date().toISOString(), vehicles, events });
  } catch (e) {
    return json(e.status || 502, { error: 'Geotab : ' + e.message });
  }
}
