// Relais Geotab en direct (Supabase Edge Function « geotab-live ») : position, vitesse, contact de chaque véhicule
// tels que Geotab les a reçus, à la demande de la page « En direct » (toutes les 5 s quand elle est ouverte).
// - Accès : jeton de l'utilisateur connecté ; la liste des véhicules est lue avec SES droits (agences), donc chacun
//   ne reçoit que les véhicules qu'il a le droit de voir. Compte en attente : aucun véhicule.
// - Identifiants Geotab : secrets de la fonction (GEO_USER, GEO_PWD, GEO_DB), jamais envoyés au navigateur.
// - Session Geotab gardée en mémoire et dans la table geotab_session (évite une connexion à chaque appel).
// - Réponse Geotab gardée 2 s : plusieurs écrans ouverts ne multiplient pas les appels à Geotab.
// Fichier sans dépendance, exécuté par Deno (index.ts) et par Node dans les tests.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const CACHE_MS = 2000, EVENTS_MIN = 30, ROAD_EVERY = 20000;   // événements de conduite renvoyés : 30 dernières minutes
const mem = { session: null, data: null, at: 0, pending: null, ids: {} };

export function resetMemory() { mem.session = null; mem.data = null; mem.at = 0; mem.pending = null; mem.ids = {}; mem.noRoad = false; mem.road = {}; }
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
  // appel déjà en cours pour un autre écran : réutilisé s'il couvre ces véhicules (sinon nouvel appel)
  if (mem.pending) { const r = await mem.pending.catch(() => null); if (r && ids.every(id => id in r)) return r; }
  // véhicules demandés par tous les écrans (toutes agences) : un seul appel les couvre tous, le cache sert à chacun
  ids.forEach(id => { mem.ids[id] = 1; }); ids = Object.keys(mem.ids);
  const p = mem.pending = (async () => {
    // une demande par véhicule (état, événements des 30 dernières minutes, contact) : la base Geotab contient d'autres
    // boîtiers que les nôtres, une demande « toute la base » était lente (plus de 20 s)
    const iso = new Date(now).toISOString(), from = new Date(now - EVENTS_MIN * 60000).toISOString();
    // limite de la route : seulement pour les véhicules qui roulaient à la lecture précédente, au plus toutes les ROAD_EVERY ms
    // (GetRoadMaxSpeeds est coûteux chez Geotab : demandé pour toute la flotte à chaque lecture, il ralentissait tout)
    mem.road = mem.road || {};
    // (première lecture du relais : tous les véhicules, l'état précédent n'étant pas connu)
    const wantRoad = mem.noRoad ? [] : ids.filter(id => { const prev = mem.data && (id in mem.data) ? mem.data[id] : undefined, r = mem.road[id];
      return (prev === undefined || (prev.dsi && prev.dsi.isDriving)) && (!r || now - r.at >= ROAD_EVERY); });
    const calls = [];
    ids.forEach(id => calls.push(
      { method: 'Get', params: { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id } } } },
      // événements des règles Geotab (excès de vitesse, freinages, accélérations, virages, ceinture, collision)
      { method: 'Get', params: { typeName: 'ExceptionEvent', search: { deviceSearch: { id }, fromDate: from, toDate: iso } } },
      // contact : dernière valeur connue (même date de début et de fin = valeur en vigueur à cet instant)
      { method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id }, diagnosticSearch: { id: 'DiagnosticIgnitionId' }, fromDate: iso, toDate: iso } } }));
    const roadCalls = wantRoad.map(id => ({ method: 'GetRoadMaxSpeeds', params: { deviceSearch: { id }, fromDate: new Date(now - 3 * 60000).toISOString(), toDate: iso } }));
    const t0 = Date.now(), out = {};
    let res;
    try { res = await geo(deps, 'ExecuteMultiCall', { calls: calls.concat(roadCalls) }); }
    catch (e) { if (!roadCalls.length) throw e; mem.noRoad = true; res = await geo(deps, 'ExecuteMultiCall', { calls }); }   // limites refusées : positions quand même
    mem.geoMs = Date.now() - t0;
    if (res.length > calls.length) wantRoad.forEach((id, i) => { mem.road[id] = { at: now, road: roadList(res[calls.length + i]).filter(p => p.t <= now).slice(-1)[0] || null }; });
    ids.forEach((id, i) => { const r = mem.road[id];
      out[id] = { dsi: (res[3 * i] || [])[0] || null, ign: (res[3 * i + 2] || []).slice(-1)[0] || null, road: r && now - r.at < 3 * ROAD_EVERY ? r.road : null,
        evts: (res[3 * i + 1] || []).filter(e => e.state !== 'ExceptionEventStateInvalidId' && e.state !== 1) }; });
    mem.data = out; mem.at = now; return out;
  })();
  try { return await p; } finally { if (mem.pending === p) mem.pending = null; }
}
const DET_PAD = 3 * 60000, DET_MAX = 90 * 60000, DRV_CACHE_MS = 15000, DRV_MAX_H = 36;
const SPD = 'DiagnosticEngineRoadSpeedId', ODO = 'DiagnosticOdometerId', FUEL = 'DiagnosticDeviceTotalFuelId', IDLE = 'DiagnosticDeviceTotalIdleFuelId';
const ms = t => new Date(t).getTime();
/** Valeurs StatusData triées, sans le point de borne que Geotab ajoute au début de la fenêtre */
const series = (a, from) => (a || []).map(x => ({ t: ms(x.dateTime), v: +x.data })).filter(x => !isNaN(x.t) && isFinite(x.v) && x.t !== from).sort((x, y) => x.t - y.t);
/** Limites de vitesse de la route (GetRoadMaxSpeeds : objet { date: km/h } ou liste) */
function roadList(res) {
  let a = res || []; if (!Array.isArray(a) && typeof a === 'object') a = Object.keys(a).map(k => ({ k, v: a[k] }));
  return a.map(x => ({ t: ms(x.k || x.key || x.dateTime), v: +(x.v != null ? x.v : x.value) })).filter(x => !isNaN(x.t) && isFinite(x.v)).sort((x, y) => x.t - y.t);
}
/**
 * Fiche d'une alerte : ce que Geotab a enregistré autour de l'instant (3 min avant / après) pour un véhicule :
 * vitesse du capteur du véhicule (même source que les trajets), positions GPS, limite de la route, événements des règles.
 */
async function detail(deps, v, from, to) {
  const ds = { id: v.geotab_id }, a = from - DET_PAD, b = Math.min(to + DET_PAD, a + DET_MAX), iso = t => new Date(t).toISOString();
  const res = await geo(deps, 'ExecuteMultiCall', { calls: [
    { method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: ds, diagnosticSearch: { id: SPD }, fromDate: iso(a), toDate: iso(b) }, resultsLimit: 5000 } },
    { method: 'Get', params: { typeName: 'LogRecord', search: { deviceSearch: ds, fromDate: iso(a), toDate: iso(b) }, resultsLimit: 5000 } },
    { method: 'Get', params: { typeName: 'ExceptionEvent', search: { deviceSearch: ds, fromDate: iso(a - 30 * 60000), toDate: iso(b) } } }] });
  let road = [];
  try { road = roadList(await geo(deps, 'GetRoadMaxSpeeds', { deviceSearch: ds, fromDate: iso(a), toDate: iso(b) })); } catch (e) { road = null; }
  return {
    key: v.key, plate: v.plate, from: iso(a), to: iso(b),
    speed: series(res[0], a).filter(p => p.t >= a && p.t <= b).map(p => [p.t, Math.round(p.v)]),
    gps: (res[1] || []).map(l => [ms(l.dateTime), Math.round(+l.speed || 0), +l.latitude, +l.longitude]).filter(p => !isNaN(p[0]) && isFinite(p[2]) && isFinite(p[3]) && (p[2] || p[3])).sort((x, y) => x[0] - y[0]),
    road: road ? road.map(p => [p.t, Math.round(p.v)]) : null,
    events: (res[2] || []).filter(e => e.state !== 'ExceptionEventStateInvalidId' && e.state !== 1 && ms(e.activeTo || e.activeFrom) >= a && ms(e.activeFrom) <= b)
      .map(e => ({ id: String(e.id), rule: e.rule && e.rule.id ? String(e.rule.id) : '', at: e.activeFrom, end: e.activeTo || null, dur_min: durMin(e.duration), km: e.distance != null ? +e.distance : null }))
  };
}
/**
 * Chauffeurs en ce moment, depuis le début de leur contrat, sans attendre la fin du trajet en cours :
 * compteurs du véhicule (kilométrage, carburant total, carburant au ralenti) au début du contrat et maintenant,
 * trajets Geotab terminés (durées de conduite / ralenti, vitesse max), vitesse du trajet en cours, événements des règles.
 */
const drvMem = {};
async function drivers(deps, items, now) {
  const qk = items.map(x => x.v.key + '@' + x.from).sort().join(',');
  if (drvMem[qk] && now - drvMem[qk].at < DRV_CACHE_MS) return drvMem[qk].data;
  const iso = t => new Date(t).toISOString(), calls = [];
  items.forEach(x => {
    const ds = { id: x.v.geotab_id }, at = (diag, t) => ({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: ds, diagnosticSearch: { id: diag }, fromDate: iso(t), toDate: iso(t) } } });
    calls.push(at(ODO, x.from), at(ODO, now), at(FUEL, x.from), at(FUEL, now), at(IDLE, x.from), at(IDLE, now),
      { method: 'Get', params: { typeName: 'Trip', search: { deviceSearch: ds, fromDate: iso(x.from), toDate: iso(now), includeOverlappedTrips: true } } },
      { method: 'Get', params: { typeName: 'ExceptionEvent', search: { deviceSearch: ds, fromDate: iso(x.from), toDate: iso(now) } } });
  });
  const res = await geo(deps, 'ExecuteMultiCall', { calls }), out = {}, cur = [];
  const val = r => { const p = (r || []).slice(-1)[0]; return p && isFinite(+p.data) ? +p.data : null; };
  const diff = (a, b, k) => a != null && b != null && b - a >= 0 ? Math.round((b - a) / k * 1000) / 1000 : null;   // km au mètre, litres au millilitre
  items.forEach((x, i) => {
    const r = res.slice(i * 8, i * 8 + 8), trips = (r[6] || []).filter(t => ms(t.stop) > x.from);
    let drive = 0, idle = 0, vmax = 0, lastStop = x.from;
    trips.forEach(t => { const k = Math.max(0, Math.min(1, (ms(t.stop) - Math.max(ms(t.start), x.from)) / Math.max(1, ms(t.stop) - ms(t.start))));   // trajet commencé avant le contrat : au prorata
      drive += (durMin(t.drivingDuration) || 0) * k; idle += (durMin(t.idlingDuration) || 0) * k; vmax = Math.max(vmax, +t.maximumSpeed || 0); lastStop = Math.max(lastStop, ms(t.stop)); });
    const evts = (r[7] || []).filter(e => e.state !== 'ExceptionEventStateInvalidId' && e.state !== 1)
      .map(e => ({ id: String(e.id), rule: e.rule && e.rule.id ? String(e.rule.id) : '', at: e.activeFrom, dur_min: durMin(e.duration) }));
    out[x.v.key] = { key: x.v.key, from: iso(x.from), km: diff(val(r[0]), val(r[1]), 1000), fuel_l: diff(val(r[2]), val(r[3]), 1), idle_l: diff(val(r[4]), val(r[5]), 1),
      drive_min: drive, idle_min: idle, trips: trips.length, vmax: Math.round(vmax), events: evts, cur_from: lastStop };
    cur.push(x);
  });
  // trajet en cours (depuis la fin du dernier trajet terminé) : vitesse maximale du capteur du véhicule
  if (cur.length) {
    const r2 = await geo(deps, 'ExecuteMultiCall', { calls: cur.map(x => ({ method: 'Get', params: { typeName: 'StatusData',
      search: { deviceSearch: { id: x.v.geotab_id }, diagnosticSearch: { id: SPD }, fromDate: iso(out[x.v.key].cur_from), toDate: iso(now) }, resultsLimit: 20000 } })) });
    cur.forEach((x, i) => { const o = out[x.v.key]; series(r2[i], o.cur_from).forEach(p => { if (p.t > o.cur_from && p.v > o.vmax) o.vmax = Math.round(p.v); }); });
  }
  drvMem[qk] = { at: now, data: out };
  Object.keys(drvMem).forEach(k => { if (now - drvMem[k].at > 5 * DRV_CACHE_MS) delete drvMem[k]; });
  return out;
}
/** Réponse : vehicles (état en direct) et events (événements Geotab des 30 dernières minutes, du plus récent au plus ancien) ;
 *  ?mode=detail&key=…&from=…&to=… : fiche d'une alerte ; ?mode=drivers&c=clé@début,… : chauffeurs depuis le début de leur contrat */
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
    // appel compté par jour (quota de l'offre Supabase, suivi dans Réglages) ; sans effet sur la réponse s'il échoue
    const svc = deps.env('SUPABASE_SERVICE_ROLE_KEY');
    if (svc) await deps.fetch(rest + '/rpc/bump_usage', { method: 'POST', headers: { apikey: svc, Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_kind: 'live' }) }).catch(() => null);
    const now = deps.now ? deps.now() : Date.now(), nowIso = new Date(now).toISOString(), q = new URL(req.url).searchParams, mode = q.get('mode') || '';
    if (mode === 'detail') {
      const v = veh.find(x => x.key === q.get('key')), from = ms(q.get('from')), to = ms(q.get('to') || q.get('from'));
      if (!v) return json(404, { error: 'Véhicule inconnu ou d\'une autre agence' });
      if (isNaN(from) || isNaN(to) || to < from) return json(400, { error: 'Dates invalides' });
      return json(200, Object.assign({ at: nowIso }, await detail(deps, v, from, Math.min(to, now))));
    }
    if (mode === 'drivers') {
      // un seul chauffeur par véhicule (le dernier demandé), début arrondi à la minute : la demande reste bornée à la flotte
      // de l'utilisateur et le cache sert les demandes voisines (sinon une liste répétée multiplierait les appels Geotab)
      const one = {};
      String(q.get('c') || '').split(',').forEach(x => { const i = x.lastIndexOf('@'), v = veh.find(y => y.key === x.slice(0, i)), f = ms(x.slice(i + 1));
        if (v && !isNaN(f) && f < now) one[v.key] = { v, from: Math.max(Math.floor(f / 60000) * 60000, now - DRV_MAX_H * 3600000) }; });
      const items = Object.values(one);
      return json(200, { at: nowIso, drivers: items.length ? await drivers(deps, items, now) : {} });
    }
    if (!veh.length) return json(200, { at: nowIso, vehicles: [], events: [] });
    const f = await fleet(deps, veh.map(v => v.geotab_id));
    const vehicles = veh.map(v => {
      const x = f[v.geotab_id] || {}, d = x.dsi, ignOn = x.ign ? +x.ign.data >= 1 : null;
      if (!d) return { key: v.key, plate: v.plate, state: 'Pas de réponse Geotab' };
      const comm = d.isDeviceCommunicating !== false, driving = !!d.isDriving;
      const state = !comm ? 'Boîtier hors ligne' : driving ? 'En route' : ignOn ? 'Arrêté, contact mis' : 'Garé';
      return { key: v.key, plate: v.plate, state, lat: d.latitude, lon: d.longitude, speed: driving ? Math.round(+d.speed || 0) : 0, bearing: d.bearing,
        at: d.dateTime, since_min: durMin(d.currentStateDuration), ign_on: ignOn,
        limit: driving && x.road && x.road.v > 0 ? Math.round(x.road.v) : null, limit_at: driving && x.road && x.road.v > 0 ? new Date(x.road.t).toISOString() : null };
    });
    const events = [];
    veh.forEach(v => ((f[v.geotab_id] || {}).evts || []).forEach(e => events.push({ id: String(e.id), key: v.key, plate: v.plate,
      rule: e.rule && e.rule.id ? String(e.rule.id) : '', at: e.activeFrom, end: e.activeTo || null, dur_min: durMin(e.duration), km: e.distance != null ? +e.distance : null })));
    events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return json(200, { at: nowIso, vehicles, events, geo_ms: mem.geoMs });
  } catch (e) {
    return json(e.status || 502, { error: 'Geotab : ' + e.message });
  }
}
