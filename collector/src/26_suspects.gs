// ============================================================================
// Courses Uber suspectes (22/11/2026, demande d'Ahmed) : chauffeur « en route vers le client » qui passe disponible / hors ligne sans course.
// Le cas est créé par la base (déclencheur sur uber_live_log) et le site alerte à l'instant. Ici, à chaque passage : km Geotab parcourus
// dans les suspectWinMin minutes qui suivent le changement d'état (positions LogRecord), dont les km hors course Uber (périodes on_trip /
// to_pickup de la plaque retirées), éloignement maximal du lieu ; verdict une fois la fenêtre écoulée : « roulé » (km hors course Uber
// ≥ suspectKm : course cachée probable), « sur place », ou « non mesuré » (aucune position, pas de boîtier). Rien d'estimé.
// ============================================================================
const SUSP_MAX_ = 15, SUSP_WAIT_ = 3 * MIN;

/**
 * Calcul pur (testé) : logs = [{ t, lat, lon }] positions Geotab dans la fenêtre, busy = [{ a, b }] (ms) périodes en course Uber,
 * origin = { lat, lon } lieu du changement (sinon première position). Renvoie { km, kmFree, movedM, n }.
 */
function suspKm_(logs, busy, origin) {
  const pts = (logs || []).filter(p => isFinite(+p.lat) && isFinite(+p.lon) && (+p.lat || +p.lon)).sort((x, y) => x.t - y.t);
  const inBusy = t => (busy || []).some(s => t >= s.a && t <= s.b);
  let km = 0, kmFree = 0, movedM = 0;
  const o = origin && isFinite(+origin.lat) && isFinite(+origin.lon) ? { lat: +origin.lat, lon: +origin.lon } : pts[0];
  for (let i = 1; i < pts.length; i++) {
    const d = siphDistM_(pts[i - 1], pts[i]);
    if (d > 20000) continue;   // saut GPS aberrant (> 20 km entre deux relevés)
    km += d / 1000;
    if (!inBusy(pts[i].t) && !inBusy(pts[i - 1].t)) kmFree += d / 1000;
  }
  if (o) pts.forEach(p => { movedM = Math.max(movedM, siphDistM_(o, p)); });
  return { km: Math.round(km * 10) / 10, kmFree: Math.round(kmFree * 10) / 10, movedM: Math.round(movedM), n: pts.length };
}
/** Texte du verdict */
function suspNote_(r, m, win, done, thr) {
  const st = { available: 'Disponible', offline: 'Hors ligne', gone: 'disparu de l\'écran' }[r.next_status] || r.next_status;
  const fr = x => String(x).replace('.', ',');
  if (!m.n) return done ? 'Aucune position Geotab dans les ' + win + ' min après le passage en ' + st + ' : non mesuré' : '';
  const base = fr(m.km) + ' km parcourus en ' + win + ' min après le passage en ' + st + ', dont ' + fr(m.kmFree) + ' km hors course Uber (jusqu\'à ' + (m.movedM >= 1000 ? fr(Math.round(m.movedM / 100) / 10) + ' km' : m.movedM + ' m') + ' du lieu)';
  if (!done) return base + ' · mesure en cours';
  return base + (m.kmFree >= thr ? ' : le véhicule a roulé sans course Uber (course cachée probable)' : ' : resté sur place ou presque');
}
/** À chaque passage : cas pas encore mesurés (changement d'état vieux de 3 min au moins) */
function suspectKmStep_() {
  let rows;
  try { rows = dbSelect_('uber_suspects', 'select=id,vehicle_key,plate_key,lat,lng,next_status,route_from,route_to,next_at,win_until&km_done=eq.false&next_at=lt.' + enc_(new Date(Date.now() - SUSP_WAIT_).toISOString()) + '&limit=' + SUSP_MAX_, 'next_at,id'); }
  catch (e) { if (/uber_suspects|42P01|PGRST2/.test(e.message)) return ''; throw e; }   // migration 20261214000000_courses_suspectes.sql pas encore exécutée
  if (!rows.length) return '';
  const P = params_(), win = +P.suspectWinMin > 0 ? +P.suspectWinMin : 20, thr = +P.suspectKm > 0 ? +P.suspectKm : 1.5, veh = vehicles_(), now = Date.now();
  let n = 0, roule = 0;
  rows.forEach(r => {
    const a = new Date(r.next_at).getTime(), winEnd = new Date(r.win_until).getTime(), until = Math.min(winEnd, now), done = now >= winEnd;
    const rf = r.route_from ? new Date(r.route_from).getTime() : a, iso = t => new Date(t).toISOString();
    const v = veh[r.vehicle_key], MIN = 60000;
    // Rapport Uber (« Activité des courses ») du véhicule autour de la prise en charge : une course réalisée = pas suspect
    // (l'état « Course en cours » a pu être raté en direct : rechargement de la page, course courte). Annulation = cohérent avec le motif.
    let trips = [];
    try { trips = dbSelect_('uber_trips', 'select=requested_at,dropoff_at,status&vehicle_key=eq.' + enc_(r.vehicle_key) + '&requested_at=gte.' + enc_(iso(rf - 30 * MIN)) + '&requested_at=lte.' + enc_(iso(winEnd + 5 * MIN)), 'requested_at'); }
    catch (e) { if (!/uber_trips|42P01|PGRST2/.test(e.message)) throw e; }
    const tripWin = t => { const q = new Date(t.requested_at).getTime(), d = t.dropoff_at ? new Date(t.dropoff_at).getTime() : q + 30 * MIN; return { q, d }; };
    const overlap = t => { const w = tripWin(t); return w.q <= winEnd && w.d >= rf - MIN; };   // course qui recoupe la période en route → fenêtre
    const doneTrip = trips.some(t => t.status === 'completed' && overlap(t));
    // annulation Uber qui chevauche la période (client = le vrai motif : le chauffeur fait annuler puis prend la course en cachette)
    const cancels = trips.filter(t => (t.status === 'rider_cancelled' || t.status === 'driver_cancelled') && overlap(t));
    const cx = cancels.some(t => t.status === 'rider_cancelled') ? 'client' : cancels.length ? 'chauffeur' : null;
    // verdict figé : dès qu'une course réalisée est trouvée (même avant la fin de la fenêtre), ou quand la fenêtre est passée
    const fixed = doneTrip || done;
    let m = { km: 0, kmFree: 0, movedM: 0, n: 0 }, note;
    if (doneTrip) { note = 'Course Uber réalisée pendant la période (« Course en cours » non vue en direct) : pas suspect'; }
    else if (!v || !v.geoId) { if (!fixed) return; note = 'Véhicule sans boîtier Geotab : non mesuré'; }
    else if (fixed) {
      const logs = geoCall_('Get', { typeName: 'LogRecord', search: { deviceSearch: { id: v.geoId }, fromDate: iso(a), toDate: iso(until) }, resultsLimit: 5000 }) || [];
      // périodes en course Uber : leurs km ne comptent pas (uber_live_log on_trip/to_pickup, et les courses réelles du rapport Uber)
      const busy = dbSelect_('uber_live_log', 'select=started_at,ended_at,status&plate_key=eq.' + enc_(r.plate_key) + '&status=in.(on_trip,to_pickup)&started_at=lte.' + enc_(iso(until))
        + '&or=' + enc_('(ended_at.is.null,ended_at.gt.' + iso(a) + ')'), 'started_at')
        .map(s => ({ a: new Date(s.started_at).getTime(), b: s.ended_at ? new Date(s.ended_at).getTime() : now + DAY }));
      trips.filter(t => t.status === 'completed').forEach(t => { const w = tripWin(t); busy.push({ a: w.q, b: w.d }); });
      m = suspKm_(logs.map(l => ({ t: new Date(l.dateTime).getTime(), lat: +l.latitude, lon: +l.longitude })), busy, r.lat != null ? { lat: r.lat, lon: r.lng } : null);
      note = suspNote_(r, m, win, fixed, thr);
    } else { return; }   // fenêtre pas finie et pas de course réalisée : rien à figer encore
    const verdict = !fixed ? null : doneTrip ? 'course réalisée' : !m.n ? 'non mesuré' : m.kmFree >= thr ? 'roulé' : 'sur place';
    if (verdict === 'roulé') roule++;
    sbReq_('patch', 'uber_suspects?id=eq.' + r.id, { km_after: m.n ? m.km : null, km_free: m.n ? m.kmFree : null, moved_m: m.n ? m.movedM : null, km_done: fixed, km_note: note || null, verdict, cx_status: doneTrip ? null : cx, updated_at: new Date(now).toISOString() }, { Prefer: 'return=minimal' });
    n++;
  });
  return n ? 'Courses suspectes : ' + n + ' mesurée(s)' + (roule ? ', dont ' + roule + ' avec déplacement sans course Uber' : '') : '';
}
