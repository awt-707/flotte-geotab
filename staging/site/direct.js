// =============================================================================
// EN DIRECT : la flotte telle que Geotab la voit, à la seconde
// - Positions, vitesse, état : relais « geotab-live » toutes les LIVE_SEC secondes tant que la page est affichée.
// - Alertes : événements des règles Geotab dès qu'il les signale + vitesse en direct au-dessus du seuil ; un clic ouvre
//   la fiche de l'alerte (vitesse du capteur, limite de la route, positions GPS lues dans Geotab autour de l'instant).
// - Chauffeurs en ce moment : compteurs du véhicule (km, carburant, ralenti) entre le début du contrat et maintenant,
//   relus toutes les DRV_SEC secondes : rien n'attend la fin du trajet en cours.
// - Totaux du jour par véhicule : calculés par le collecteur (trajets terminés).
// Rien n'est estimé : une valeur que Geotab ne fournit pas est « non mesuré ».
// =============================================================================
let MAP = null;
const LIVE_SEC = window.FLOTTE_CONFIG?.GEOTAB_LOCAL && !window.FLOTTE_CONFIG?.DESKTOP_PRODUCTION && !window.FLOTTE_CONFIG?.WEB_PRODUCTION ? 2 : 5, DRV_SEC = 30, TRAIL_MAX = 240;
// Économie des appels (quota de l'offre Supabase) : sans souris ni clavier depuis LIVE_IDLE_MIN minutes, positions toutes les minutes
// et chauffeurs toutes les 5 minutes ; la moindre activité relance aussitôt le rythme normal.
const LIVE_IDLE_MIN = 10, LIVE_IDLE_SEC = 60, DRV_IDLE_SEC = 300;
let LIVE_ACT = Date.now();
function liveIdle() { return Date.now() - LIVE_ACT > LIVE_IDLE_MIN * MIN; }
['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => {
  const was = liveIdle(); LIVE_ACT = Date.now();
  if (was && typeof pageOf === 'function' && pageOf() === 'direct') { liveTick(ROUTING); liveDrvTick(ROUTING); }
}, { passive: true }));
const LIVE = { rows: [], pos: {}, at: 0, err: '', markers: {}, trails: {}, ctr: [], alerts: [], seen: {}, primed: false, fast: {}, over: {},
  drv: {}, drvAt: 0, drvErr: '', drvFallback: '', drvBusy: false, busy: false, motion: {}, sel: '' };
function localGeotabInterval(source) { const seconds = Number(source?.interval_s); return Number.isFinite(seconds) && seconds >= 2 ? seconds : 2; }
function localGeotabStaleMs(source) { const seconds = Number(source?.stale_after_s); return (Number.isFinite(seconds) && seconds > 0 ? seconds : Math.max(20, 3 * localGeotabInterval(source))) * 1000; }
function localMotionCoverageHtml() {
  const coverage = LIVE.motionCoverage;
  const warning = LIVE.localSource?.motion_error ? msg(esc(LIVE.localSource.motion_error), 'warn') : '';
  if (!coverage) return warning;
  const linked = Number(coverage.linked_drivers) || 0, unassigned = Number(coverage.unassigned_drivers) || 0;
  return warning + msg('<b>Surveillance des 200 m :</b> ' + linked + ' chauffeur' + (linked === 1 ? '' : 's') + ' avec un véhicule associé.'
    + (unassigned ? ' <b>' + unassigned + ' chauffeur' + (unassigned === 1 ? ' reste à associer' : 's restent à associer') + '.</b> Aucune alerte de déplacement ne peut être déclenchée pour ces chauffeurs.' : !linked ? ' Associez les chauffeurs Uber ou Bolt à leur fiche Ludy et à leur véhicule.' : ' Les sources doivent rester connectées et les observations récentes.')
    + (isAdmin() ? ' <a href="#/cockpit">Ouvrir une fiche chauffeur dans la vue d’ensemble</a>.' : ''), unassigned || !linked ? 'warn' : 'info')
    + (LIVE.motionWatches || []).map(w => msg('<b>Hors ligne, contact mis : arrêt du moteur attendu.</b> ' + esc(w.driver_name || 'Chauffeur associé') + ' · ' + esc(w.plate || w.key) + ' · ' + (w.source === 'uber' ? 'Uber Fleet' : 'Bolt') + ' · ' + Math.round(Number(w.distance_m) || 0) + ' m observés. Alerte critique au-delà de 200 m.', 'warn')).join('');
}
// Alertes en direct : événements Geotab des règles de conduite (dès que Geotab les signale) + vitesse en direct au-dessus du seuil
const LIVE_TYPE = { Collision: 'Collision', Vitesse: 'Excès de vitesse', Ceinture: 'Ceinture non bouclée', Freinage: 'Freinage brusque', 'Accélération': 'Accélération brusque', Virage: 'Virage brusque' };
const LIVE_SEV = { Collision: 'Critique', Vitesse: 'Haute', Ceinture: 'Haute', Freinage: 'Moyenne', 'Accélération': 'Moyenne', Virage: 'Moyenne' };
const LIVE_ORDER = { 'En route': 0, 'Arrêté, contact mis': 1, 'Garé': 2, 'Boîtier hors ligne': 3 };
const ST_CLS = s => STATE_CLS[s] || 'mute';

/** Appel du relais Geotab (jeton de l'utilisateur : il ne reçoit que les véhicules de ses agences) */
async function relay(params) {
  if (CFG.GEOTAB_LOCAL) {
    if (params?.mode === 'detail') return fleetApi('geotab/detail?' + new URLSearchParams({ key: params.key, from: params.from, to: params.to || params.from }));
    if (params && Object.keys(params).length) throw new Error(CFG.WEB_PRODUCTION ? 'Cette vue utilise les observations partagées par le poste collecteur.' : 'Cette vue utilise les observations enregistrées dans le staging.');
    return fleetApi('geotab/live');
  }
  if (CFG.GEOTAB_ENABLED === false) throw new Error('Geotab non connecté au staging');
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch(CFG.SUPABASE_URL + '/functions/v1/geotab-live' + qs, { headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (S.session && S.session.access_token) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || 'HTTP ' + r.status);
  return j;
}
function liveAlertOf(e) {
  const rl = S.rules[e.rule] || {}, cat = rl.category || '';
  if (!(num(rl.weight) > 0 || cat === 'Collision' || (CFG.GEOTAB_LOCAL && LIVE_TYPE[cat]))) return null;
  const c = contractAt(e.key, new Date(e.at).getTime());
  return { id: 'EV|' + e.id, ev: e.id, vehicle_key: e.key, plate: e.plate, at: e.at, end: e.end, cat, severity: LIVE_SEV[cat] || 'Moyenne', type: LIVE_TYPE[cat] || rl.name || 'Événement de conduite',
    detail: (rl.name || e.rule) + (e.dur_min != null ? ' · ' + Math.round(e.dur_min * 60) + ' s' : '') + (e.km ? ' · ' + f1(e.km) + ' km' : ''),
    driver_name: c ? c.name : 'Sans contrat', driver_code: c ? c.client_code : '', contract_num: c ? c.num : '', shift: c ? shiftOf(c.start_at, S.P) : '' };
}
function localMotionCorrection(alert) {
  return alert.evidence?.correction_reason === 'unverified_bolt_selected_vehicle' ? {
    label: 'Écarté : affectation non vérifiée',
    explanation: 'Ce signalement a été écarté : la voiture enregistrée dans Bolt ne confirmait pas le véhicule conduit par ce chauffeur au moment des faits.'
  } : null;
}
/** Local alerts come from provider events or the server's cross-source rule, never repeated cached speeds. */
function processLocalLive(j) {
  const now = Date.now(), previous = new Set(LIVE.alerts.map(a => a.id)), motion = {}, alerts = [], history = [];
  LIVE.motionWatches = (j.motion_watches || []).filter(w => S.veh[w.key]);
  for (const e of j.events || []) {
    if (!S.veh[e.key] || !Number.isFinite(Date.parse(e.at)) || e.end && now - Date.parse(e.end) > 30 * MIN) continue;
    const a = liveAlertOf(e); if (a) alerts.push(a);
  }
  for (const a of j.motion_alerts || []) {
    const key = a.key || a.vehicle_key;
    if (!S.veh[key] || !['open', 'resolved', 'suspended'].includes(a.status)) continue;
    const platforms = [...new Set((a.evidence?.platforms_offline || [a.source]).filter(p => ['uber', 'bolt'].includes(p)))];
    const platform = platforms.length ? platforms.map(p => p === 'uber' ? 'Uber Fleet' : 'Bolt').join(' et ') : 'la plateforme';
    const distance = Number(a.distance_m), distanceText = Number.isFinite(distance) ? Math.round(distance) + ' m' : 'plus de 200 m';
    const correction = localMotionCorrection(a);
    const alert = { ...a, id: 'MOTION|' + a.id, vehicle_key: key, at: a.at || a.opened_at || a.created_at,
      type: correction ? 'Signalement écarté' : 'Déplacement hors ligne', severity: 'Critique', cat: 'Hors ligne', motion: true,
      detail: correction?.explanation || platform + ' hors ligne · ' + distanceText + ' parcourus · ' + (a.ign_on === true ? 'contact mis au relevé de l’alerte' : a.ign_on === false ? 'contact coupé au relevé de l’alerte' : 'contact inconnu au relevé de l’alerte') + '. Vérifier le déplacement.',
      driver_name: a.driver_name || 'Chauffeur associé', driver_code: a.driver_code || '', contract_num: '' };
    history.push(alert);
    if (a.status === 'open') { alerts.push(alert); motion[key] = alert.id; }
  }
  LIVE.motionHistory = history.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  LIVE.motion = motion; LIVE.fast = {}; LIVE.over = {};
  LIVE.alerts = alerts.sort((a, b) => Number(b.motion === true) - Number(a.motion === true) || String(b.at).localeCompare(String(a.at)));
  const primed = LIVE.localPrimedUser === S.session?.user?.id;
  for (const a of LIVE.alerts) {
    if (!previous.has(a.id) && (primed || a.motion) && !LIVE.seen[a.id]) onNewAlert({ ...a, time: fmtHMS(a.at).slice(6), link: '#/direct' });
    LIVE.seen[a.id] = 1;
  }
  LIVE.localPrimedUser = S.session?.user?.id;
  // Keep deduplication bounded to this snapshot. A resolved episode gets a new server ID if it recurs.
  LIVE.seen = Object.fromEntries(LIVE.alerts.map(a => [a.id, 1]));
  if (typeof opsReconcileNotifications === 'function') opsReconcileNotifications(LIVE.alerts);
}
function suspendLocalMotionDisplay() {
  LIVE.motion = {}; LIVE.motionWatches = [];
  LIVE.alerts = LIVE.alerts.filter(a => !a.motion);
  LIVE.motionHistory = (LIVE.motionHistory || []).map(a => a.status === 'open' ? { ...a, status: 'suspended' } : a);
  if (typeof opsReconcileNotifications === 'function') opsReconcileNotifications(LIVE.alerts);
}
function processLive(j) {
  const now = Date.now(), lim = num(S.P.vmaxAlert, 130), fresh = [];
  (j.events || []).forEach(e => {
    const a = liveAlertOf(e); if (!a) return;
    if (!LIVE.seen[a.id]) { LIVE.seen[a.id] = 1; LIVE.alerts.push(a); fresh.push(a); }
    else { const o = LIVE.alerts.find(x => x.id === a.id); if (o) { o.end = a.end; o.detail = a.detail; } }   // événement encore en cours : fin et durée mises à jour
  });
  (j.vehicles || []).forEach(v => {
    if (v.state === 'En route' && v.speed >= lim) {
      if (LIVE.fast[v.key]) { const a = LIVE.alerts.find(x => x.id === LIVE.fast[v.key]); if (a) { a.end = v.at || a.end; if (v.speed > a.vmax) { a.vmax = v.speed; a.detail = 'Vitesse max ' + v.speed + ' km/h (seuil ' + lim + ')'; } } }
      else {   // (pas de « return » : le dépassement de la limite de la route est suivi aussi)
      const c = contractAt(v.key, now), a = { id: 'VIT|' + v.key + '|' + (v.at || now), vehicle_key: v.key, plate: v.plate, at: v.at || new Date(now).toISOString(), end: v.at || null, cat: 'Vitesse', severity: 'Haute',
        type: 'Vitesse excessive', vmax: v.speed, detail: v.speed + ' km/h (seuil ' + lim + ')', driver_name: c ? c.name : 'Sans contrat', driver_code: c ? c.client_code : '', contract_num: c ? c.num : '', shift: c ? shiftOf(c.start_at, S.P) : '' };
      LIVE.fast[v.key] = a.id; LIVE.alerts.push(a); fresh.push(a); }
    } else if (v.state !== 'En route' || v.speed < lim - 10) delete LIVE.fast[v.key];   // 10 km/h de marge : pas d'alerte à répétition autour du seuil
    // dépassement de la limite de la route (limite Geotab sous le véhicule) au-delà du seuil réglé pour cette limite (Réglages)
    if (v.state === 'En route' && v.limit) {
      const tol = rptOverTol(S.P, v.limit), thr = v.limit + tol, txt = sp => sp + ' km/h pour ' + v.limit + ' km/h autorisés (seuil +' + tol + ', soit ' + thr + ' km/h)';
      if (v.speed >= thr) {
        const o = LIVE.over[v.key] && LIVE.alerts.find(x => x.id === LIVE.over[v.key]);
        if (o) { o.end = v.at || o.end; if (v.speed > o.vmax) { o.vmax = v.speed; o.detail = txt(v.speed); } }
        else { const c = contractAt(v.key, now), a = { id: 'DEP|' + v.key + '|' + (v.at || now), vehicle_key: v.key, plate: v.plate, at: v.at || new Date(now).toISOString(), end: v.at || null, cat: 'Vitesse',
          severity: 'Haute', type: 'Dépassement limite', vmax: v.speed, detail: txt(v.speed), driver_name: c ? c.name : 'Sans contrat', driver_code: c ? c.client_code : '', contract_num: c ? c.num : '', shift: c ? shiftOf(c.start_at, S.P) : '' };
          LIVE.over[v.key] = a.id; LIVE.alerts.push(a); fresh.push(a); }
      } else if (v.speed < thr - 5) delete LIVE.over[v.key];   // 5 km/h de marge
    } else if (v.state !== 'En route') delete LIVE.over[v.key];
  });
  const cut = (Date.parse(j.at) || now) - 30 * MIN;   // 30 dernières minutes à l'heure du relais
  LIVE.alerts = LIVE.alerts.filter(a => new Date(a.at).getTime() >= cut).sort((x, y) => String(y.at).localeCompare(String(x.at)));
  // à l'ouverture de la page : les alertes des 30 dernières minutes sont listées sans notification
  if (LIVE.primed) fresh.forEach(a => onNewAlert(Object.assign({ time: fmtHMS(a.at).slice(6), link: '#/vehicule?k=' + encodeURIComponent(a.vehicle_key) }, a)));
  LIVE.primed = true;
}
/** Contrat en cours sur le véhicule à l'instant t (même règle que le collecteur : contrat qui couvre t, sinon le plus proche
 *  dans la tolérance « ctrTolMin ») ; aucun : sans contrat. strict : sans tolérance (chauffeur affiché « maintenant ») */
function contractAt(key, t, strict) {
  // contrat jamais clôturé dans l'extract : il s'arrête au début du contrat suivant du véhicule (ctrEffEnds)
  const tol = num(S.P.ctrTolMin, 20) * MIN, list = ctrEffEnds(LIVE.ctr.filter(c => c.vehicle_key === key), t)
    .map(c => ({ c, a: new Date(c.start_at).getTime(), b: c._end !== null ? c._end : t + HOUR }));
  let best = null; list.forEach(x => { if (t >= x.a && t <= x.b) best = x; });
  if (!best && !strict) { let bd = Infinity; list.forEach(x => { const d = t < x.a ? x.a - t : t > x.b ? t - x.b : 0; if (d <= tol && d < bd) { bd = d; best = x; } }); }
  return best ? best.c : null;
}
/** Contrats qui peuvent couvrir le moment présent (relus avec les totaux du collecteur, toutes les minutes) */
async function loadLiveContracts() {
  const now = Date.now(), tol = num(S.P.ctrTolMin, 20) * MIN, my = ROUTING, owner = S.session?.user?.id, sessionRevision = S.sessionRevision;
  const current = () => my === ROUTING && owner === S.session?.user?.id && sessionRevision === S.sessionRevision;
  // fenêtre des alertes en direct (30 min) comprise : une infraction d'il y a 25 min reste attribuée au bon contrat
  const contracts = await withSuccessors(await all('contracts', 'num,client_code,name,vehicle_key,start_at,end_at', q => q.lte('start_at', new Date(now + tol).toISOString())
    .or('end_at.is.null,end_at.gte.' + new Date(now - tol - 30 * MIN).toISOString())));
  if (!current()) return; LIVE.ctr = contracts;
  // dernier import de l'extract (contrat ajouté ou modifié) : « Contrat dépassé » tant que les contrats du shift en cours ne sont pas injectés
  const { data: li } = await sb.from('contracts').select('updated_at').not('updated_at', 'is', null).order('updated_at', { ascending: false }).limit(1);
  if (!current()) return;
  LIVE.lastImport = li && li[0] ? new Date(li[0].updated_at).getTime() : 0;
  // courses privées en cours : véhicule bloqué pour une mission (acompte reçu, confirmée, en cours) qui couvre maintenant
  try {
    const ms = await all('missions', 'id,number,status,client_name,client_company,driver_name,vehicle_key,start_at,end_at,kind', q => q.in('status', CRS_BLOCK).not('vehicle_key', 'is', null)
      .lte('start_at', new Date(now).toISOString()).gte('end_at', new Date(now).toISOString()));
    if (!current()) return; LIVE.mis = {}; ms.forEach(m => { LIVE.mis[m.vehicle_key] = m; });
  } catch (e) { if (current()) LIVE.mis = {}; }   // module pas encore installé (migration) : rien à afficher
}
/** Course privée en cours sur le véhicule : badge (lien vers la mission) */
function crsLiveHtml(r, full) {
  const m = r.crs; if (!m) return '';
  return `<a class="badge crs" href="#/courses?id=${m.id}" title="${esc('Course privée ' + (m.number || '') + ' · ' + (m.kind || '') + ' · jusqu\'au ' + fmtDTY(m.end_at))}">Course privée</a>`
    + (full ? ` <span class="small">${esc((m.number || '') + ' · ' + (m.client_company || m.client_name || ''))}</span>` : '');
}
/** Pas de nom de chauffeur : « Sans contrat » (extract du shift injecté, plaque absente) ou « Contrat dépassé » (extract pas encore injecté) */
function noCtrHtml(r) {
  if (r.no_ctr === 'non_confirme') return '<span class="nm">Affectation plateforme à confirmer</span>';
  return r.no_ctr === 'depasse' ? `<span class="badge warn" title="Contrats du shift en cours pas encore injectés${r.old_ctr ? ' (dernier contrat du véhicule : ' + esc(r.old_ctr) + ')' : ''} : importez l'extract (page Contrats)">Contrat dépassé</span>`
    : '<span class="nm">Sans contrat</span>';
}
function liveRows() {
  const ok = inAgency(), have = {}, now = Date.now(), cur = shiftAt(now, S.P);
  // extract injecté pendant le shift en cours, ou avant son début : 1 h 30, au moins l'avance du shift (shiftAdvance, 2 h par défaut :
  // contrats de nuit pris dès 17:00, extract injecté à 17:00-17:30)
  const fresh = (LIVE.lastImport || 0) >= shiftStart(cur, S.P).getTime() - Math.max(90 * MIN, shiftAdv(S.P) * HOUR);
  const baseRows = CFG.GEOTAB_LOCAL ? (S.vehList||[]).filter(v=>ok(v.key)).map(v=>({vehicle_key:v.key,plate:v.plate,model:v.model||'',state:v.geotab_id?'Position non reçue':'Sans suivi GPS',lat:null,lon:null,live:0})) : LIVE.rows;
  baseRows.forEach(r => { have[r.vehicle_key] = 1; });
  // véhicule vu en direct par Geotab mais pas encore par le collecteur : affiché quand même
  const extra = Object.values(LIVE.pos).filter(g => !have[g.key] && ok(g.key) && (!CFG.GEOTAB_LOCAL || S.veh[g.key])).map(g => ({ vehicle_key: g.key, plate: g.plate, model: (S.veh[g.key] || {}).model || '' }));
  return baseRows.concat(extra).map(r => {
    // chauffeur affiché maintenant : contrat qui couvre l'instant présent, sans tolérance (véhicule rendu = sans contrat) ;
    // extract pas encore injecté pour le shift en cours : « Contrat dépassé » (contrat d'un shift précédent ou aucun contrat)
    const g = LIVE.pos[r.vehicle_key], c0 = contractAt(r.vehicle_key, now, true), sc = c0 && shiftOfCtr(c0.start_at, S.P);
    // contrat à date de fin (location de plusieurs jours, réservation) : jamais « dépassé » tant qu'il couvre l'instant présent
    const c = c0 && (fresh || c0.end_at || (sc.s === cur.s && sc.day === cur.day)) ? c0 : null, nc = c ? '' : fresh ? 'sans' : 'depasse';
    const who = { driver_name: c ? c.name : nc === 'sans' ? 'Sans contrat' : 'Contrat dépassé', no_ctr: nc, old_ctr: !c && c0 ? c0.num : '', contract_num: c ? c.num : '',
      driver_code: c ? c.client_code : HORS, shift: c ? shiftOf(c.start_at, S.P) : '', ctr_start: c ? c.start_at : null };
    if (CFG.GEOTAB_LOCAL) {
      const assigned = typeof opsDriverForVehicle === 'function' ? opsDriverForVehicle(r.vehicle_key) : null;
      const observed = !assigned && typeof opsObservedDriverForVehicle === 'function' ? opsObservedDriverForVehicle(r.vehicle_key) : null;
      // Imported contracts are reference data, never evidence of who is driving now.
      who.reference_contract = c ? { name: c.name, num: c.num, driver_code: c.client_code } : null;
      Object.assign(who, { driver_name: assigned?.name || observed?.name || (typeof opsVehicleAssignmentLabel === 'function' ? opsVehicleAssignmentLabel(r.vehicle_key) : 'Affectation plateforme à confirmer'), driver_code: assigned?.ludy_driver_code || HORS,
        current_assignment: !!assigned, observed_assignment: !!observed, no_ctr: assigned ? '' : 'non_confirme', contract_num: '', shift: '', ctr_start: null });
    }
    const mi = (LIVE.mis || {})[r.vehicle_key];
    if (mi) Object.assign(who, { crs: mi, crs_driver: mi.driver_name || '' });
    if (CFG.GEOTAB_LOCAL && g) {
      const source = LIVE.localSource || {}, sourceAge = now - Date.parse(source.last_success_at), positionAge = now - Date.parse(g.at);
      const sourceRecent = source.polling && source.status === 'healthy' && Number.isFinite(sourceAge) && sourceAge >= -5000 && sourceAge <= localGeotabStaleMs(source);
      const positionRecent = g.fresh !== false && Number.isFinite(positionAge) && positionAge >= -5000 && positionAge <= 180000;
      const current = sourceRecent && positionRecent;
      return Object.assign({}, r, who, { state: current ? (g.state || 'État inconnu') : !source.polling && source.configured ? 'Suivi en pause' : 'Position ancienne',
        speed: current ? g.speed : null, since_min: current ? g.since_min : null, bearing: current ? g.bearing : null,
        ign_on: current && typeof g.ign_on === 'boolean' ? g.ign_on : null,
        last_pos_at: g.at || null, lat: g.lat, lon: g.lon, live: current ? 1 : 0, geo_position: true });
    }
    return g && g.state ? Object.assign({}, r, who, { state: g.state, speed: g.speed, since_min: g.since_min, bearing: g.bearing,
      last_pos_at: g.at || r.last_pos_at, lat: g.lat != null ? g.lat : r.lat, lon: g.lon != null ? g.lon : r.lon, live: 1 }) : Object.assign({}, r, who); })
    .sort((a, b) => SHIFTS.indexOf(a.shift || '') - SHIFTS.indexOf(b.shift || '') || (LIVE_ORDER[a.state] ?? 9) - (LIVE_ORDER[b.state] ?? 9) || String(a.plate).localeCompare(String(b.plate)));   // shift jour, puis nuit, puis hors contrat
}
function fmtHMS(d) { if (!d) return ''; const p = parts(d); return p.day + '/' + p.month + ' ' + p.hour + ':' + p.minute + ':' + p.second; }
/** « il y a 12 s », « il y a 4 min », « il y a 2 h » */
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000)); if (!t || isNaN(s)) return '';
  return s < 60 ? 'il y a ' + s + ' s' : s < 3600 ? 'il y a ' + Math.floor(s / 60) + ' min' : 'il y a ' + Math.floor(s / 3600) + ' h ' + String(Math.floor(s / 60) % 60).padStart(2, '0');
}
function liveClock() { document.querySelectorAll('#page .ago[data-t]').forEach(el => { el.textContent = ago(el.dataset.t); }); }

// ---------- Consommation en direct (cadran) ----------
/** Consommation moyenne réelle par modèle (journal des 30 derniers jours, compteur Geotab) : référence du cadran */
async function loadConsoBase() {
  const my = ROUTING, owner = S.session?.user?.id, sessionRevision = S.sessionRevision;
  const rows = await all('journal', 'id,model,fuel_l,fuel_km', q => q.gte('day', addDays(today(), -30)).not('fuel_l', 'is', null));
  if (my !== ROUTING || owner !== S.session?.user?.id || sessionRevision !== S.sessionRevision) return;
  const m = {}; rows.forEach(r => { if (!r.model || !(num(r.fuel_km) > 0)) return; const o = m[r.model] = m[r.model] || { l: 0, km: 0 }; o.l += num(r.fuel_l); o.km += num(r.fuel_km); });
  LIVE.base = {}; Object.keys(m).forEach(k => { if (m[k].km >= 200) LIVE.base[k] = m[k].l / m[k].km * 100; });
}
/** Cadran vert → rouge : consommation du contrat en cours (compteurs Geotab depuis son début, relus toutes les 30 s) comparée à la moyenne du modèle */
/** Compteurs Geotab du contrat affiché (relais ?mode=drivers) ; ceux d'un contrat précédent du véhicule ne sont jamais repris */
function liveDrv(r) {
  if (CFG.GEOTAB_LOCAL) return r && LIVE.drv[r.vehicle_key] || null;
  const d = r && r.contract_num && LIVE.drv[r.vehicle_key];
  return d && (!r.ctr_start || !d.from || Math.abs(new Date(d.from) - new Date(r.ctr_start)) < 2 * MIN) ? d : null;
}
function localTelemetryFresh(d) {
  return !!d && d.fresh !== false && LIVE.localSource?.polling && !LIVE.err &&
    LIVE.localSource?.telemetry_status !== 'error' && Number.isFinite(Date.parse(d.at)) && Date.now() - Date.parse(d.at) < 90000;
}
function consoGauge(r) {
  const d = liveDrv(r), historicalBase = (LIVE.base || {})[r.model], configuredBase = Number(S.veh[r.vehicle_key]?.ref_l100);
  if (!d && !CFG.GEOTAB_LOCAL) return '';
  const base = historicalBase || (CFG.GEOTAB_LOCAL && configuredBase > 0 ? configuredBase : null);
  const stale = CFG.GEOTAB_LOCAL && d && !localTelemetryFresh(d), km = d?.km, l = d?.fuel_l;
  const ok = !stale && km != null && l != null && km >= 10 && Number.isFinite(l / km), comparable = ok && base > 0;
  const v = ok ? l / km * 100 : null, ratio = comparable ? v / base : null;
  const zone = !comparable ? 'mute' : ratio <= 1 ? 'ok' : ratio <= 1.15 ? 'warn' : 'crit';
  const ang = comparable ? Math.max(0, Math.min(180, (ratio - 0.6) / 0.8 * 180)) : 90, rad = (180 - ang) * Math.PI / 180, nx = 28 + 20 * Math.cos(rad), ny = 28 - 20 * Math.sin(rad);
  const period = CFG.GEOTAB_LOCAL ? 'depuis ' + (d?.from ? fmtHMS(d.from) + ' (heure du Maroc)' : 'le début de la journée') : 'depuis le début du contrat';
  const tip = stale ? 'Derniers compteurs anciens : ' + fmtHMS(d.at) + '. En attente d’une nouvelle lecture Geotab.'
    : ok ? `Consommation ${period} : ${f1(v)} L/100 km sur ${f1(km)} km. ` + (historicalBase ? `Moyenne du modèle sur 30 jours : ${f1(base)} L/100.` : base ? `Référence configurée du véhicule : ${f1(base)} L/100.` : 'Aucune référence de comparaison configurée.')
    : km != null && km < 10 ? 'Moins de 10 km ' + period : 'Consommation non mesurée (compteur Geotab absent)';
  return `<span class="cgauge z-${zone}" title="${esc(tip)}"><svg viewBox="0 0 56 32" aria-hidden="true">
      <path d="M8.0 28.0A20 20 0 0 1 27.3 8.0" class="cg-ok"/><path d="M28.7 8.0A20 20 0 0 1 38.6 11.0" class="cg-warn"/><path d="M39.8 11.8A20 20 0 0 1 48.0 28.0" class="cg-crit"/>
      <line x1="28" y1="28" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="cg-needle"/><circle cx="28" cy="28" r="2.6" class="cg-hub"/></svg>
    <span class="cg-v">${ok ? f1(v) + '<small> L/100</small>' : stale ? '<small>Ancienne</small>' : km != null && km < 10 ? '<small>&lt; 10 km</small>' : '<small>' + NM + '</small>'}</span></span>`;
}

// ---------- Rendu ----------
function kpisHtml(rows) {
  const n = s => rows.filter(r => r.state === s).length, off = n('Boîtier hors ligne') + n('Pas de réponse Geotab'), ctr = rows.filter(r => r.contract_num).length;
  if (CFG.GEOTAB_LOCAL) return cards([['Véhicules suivis', rows.length], ['Positions actuelles', rows.filter(r => r.live && r.lat != null && r.lon != null).length, 'ok'],
    ['En route', n('En route'), 'ok'], ['Arrêtés contact mis', n('Arrêté, contact mis'), 'warn'], ['Garés', n('Garé')], ['Boîtiers hors ligne', off, off ? 'crit' : ''],
    ['Sans état actuel', rows.filter(r => !r.live).length, rows.some(r => !r.live) ? 'warn' : ''],
    ['Déplacements hors ligne', LIVE.alerts.filter(a => a.motion && inAgency()(a.vehicle_key)).length, 'crit'],
    ['Événements (30 min)', LIVE.alerts.filter(a => !a.motion && inAgency()(a.vehicle_key)).length, 'warn']]);
  return cards([['En route', n('En route'), 'ok'], ['Arrêtés contact mis', n('Arrêté, contact mis'), n('Arrêté, contact mis') ? 'warn' : ''], ['Garés', n('Garé')],
    ['Boîtiers hors ligne', off, off ? 'crit' : ''], ['Sous contrat', ctr + ' / ' + rows.length],
    ...(rows.some(r => r.crs) ? [['En course privée', rows.filter(r => r.crs).length, 'crs']] : []),
    ...(rows.some(r => r.no_ctr === 'depasse') ? [['Contrats dépassés (extract à injecter)', rows.filter(r => r.no_ctr === 'depasse').length, 'warn']] : []), ['Alertes (30 min)', LIVE.alerts.filter(a => inAgency()(a.vehicle_key)).length, LIVE.alerts.length ? 'high' : '']]);
}
function vcardsHtml(rows) {
  if (!rows.length) return '<div class="empty">' + (CFG.GEOTAB_LOCAL ? CFG.WEB_PRODUCTION ? 'Aucune position reçue du poste collecteur. Consultez l’état des sources dans Connecteurs.' : 'Aucune position reçue. Associez les véhicules puis démarrez le suivi dans Connecteurs.' : 'Aucun véhicule actif') + '</div>';
  return rows.map(r => `<button type="button" class="vcard st-${ST_CLS(r.state)}${r.crs ? ' crs' : ''}${LIVE.fast[r.vehicle_key] || LIVE.motion[r.vehicle_key] ? ' fast' : ''}${LIVE.sel === r.vehicle_key ? ' on' : ''}" data-vk="${esc(r.vehicle_key)}">
    <span class="vc-l1">${plate(r.plate)}<span class="vc-model">${esc(r.model || '')}</span><span class="vc-spd">${r.state === 'En route' ? f0(r.speed) + '<small> km/h</small>' : ''}</span></span>
    <span class="vc-l2"><span class="vc-st"><span class="sdot"></span>${esc(r.state || 'État inconnu')}${r.since_min != null ? ' · depuis ' + fH(r.since_min / 60) : ''}</span>${consoGauge(r)}</span>
    <span class="vc-l3">${r.crs ? crsLiveHtml(r) + ' <b>' + esc(r.crs_driver || r.driver_name || '') + '</b> <span class="small">' + esc(r.crs.client_company || r.crs.client_name || '') + '</span>'
      : r.contract_num ? `<b>${esc(r.driver_name)}</b> ${shiftBadge(r.shift)}` : noCtrHtml(r)}</span>
    <span class="vc-l4">${r.live ? 'Position Geotab ' + esc(fmtHMS(r.last_pos_at).slice(6)) + ' · <span class="ago" data-t="' + esc(r.last_pos_at || '') + '">' + ago(r.last_pos_at) + '</span>'
      : r.last_pos_at ? (r.geo_position ? 'Dernière position Geotab ' : 'Position du collecteur ') + esc(fmtDT(r.last_pos_at)) : 'Aucune position'}</span></button>`).join('');
}
function liveAlertsHtml() {
  const list = LIVE.alerts.filter(a => inAgency()(a.vehicle_key));
  const body = list.length ? `<div id="tlal" class="alist">${list.map(a => `<button type="button" class="acard ${GRAV_CLS[a.severity] || ''}" data-la="${esc(a.id)}">
      <span class="a-time">${esc(fmtHMS(a.at))}</span>
      <span class="a-main">${badge(a.severity, GRAV_CLS[a.severity])} <b>${esc(a.type)}</b> ${plate(a.plate)}</span>
      <span class="a-drv">${a.motion ? esc(a.driver_name) : a.contract_num ? esc(a.driver_name) + ' ' + shiftBadge(a.shift) + ' <span class="small">contrat ' + esc(a.contract_num) + '</span>' : '<span class="nm">Sans contrat</span>'}</span>
      <span class="a-det">${esc(a.detail)}</span><span class="a-go">Voir la fiche ›</span></button>`).join('')}</div>`
    : '<div class="empty">Aucune alerte dans les observations reçues</div>';
  if (CFG.GEOTAB_LOCAL) {
    const source = LIVE.localSource || {}, eventAge = Date.now() - Date.parse(source.events_at);
    const eventWarning = source.events_status !== 'healthy' || !Number.isFinite(eventAge) || eventAge > 90000 || !source.polling;
    return '<div class="sechead"><h2>Alertes en direct</h2><span class="small">Événements Geotab des 30 dernières minutes · déplacement hors ligne au-delà de 200 m sur la plateforme du chauffeur.</span></div>'
      + (eventWarning ? msg('Lecture des événements ' + (source.events_status === 'error' ? 'interrompue' : 'en attente ou en pause') + (source.events_at ? ' · dernier relevé ' + esc(fmtHMS(source.events_at)) : '') + '.', 'warn') : '<p class="small">Événements relus toutes les ' + (Number(source.events_interval_s) || 10) + ' s · dernier relevé ' + esc(fmtHMS(source.events_at)) + '. Le signalement de déplacement demande une vérification.</p>')
      + body;
  }
  return `<div class="sechead"><h2>Alertes en direct</h2><span class="small">30 dernières minutes, à l'instant où Geotab les signale. Cliquer sur une alerte pour sa fiche détaillée (vitesse, limite de la route, trajet sur la carte).</span></div>` + body;
}
function vehTableHtml(rows) {
  return table('tlive', [
    ['Plaque', r => `<a class="fl" href="#/vehicule?k=${encodeURIComponent(r.vehicle_key)}">${plate(r.plate, S.veh[r.vehicle_key] && S.veh[r.vehicle_key].other_plates)}</a>`, r => r.plate],
    ['Modèle', r => esc(r.model)], ['État', r => badge(r.state, (STATE_CLS[r.state] || '') + ' dot'), r => LIVE_ORDER[r.state] ?? 9],
    ['Vitesse', r => r.speed ? f0(r.speed) + ' km/h' : '', r => r.speed, 'n'], ['Depuis', r => r.since_min != null ? fH(r.since_min / 60) : '', r => r.since_min, 'n'],
    ['Dernière position', r => r.live ? fmtHMS(r.last_pos_at) : fmtDT(r.last_pos_at), r => r.last_pos_at], ['Chauffeur sous contrat (maintenant)', r => r.contract_num ? dlink(r.driver_code, r.driver_name) : noCtrHtml(r), r => r.driver_name],
    ['Shift', r => r.contract_num ? shiftBadge(r.shift) : '', r => r.shift || 'z'], ['Contrat', r => esc(r.contract_num || '')],
    ['Course privée', r => r.crs ? crsLiveHtml(r, true) + (r.crs_driver ? '<div class="small">' + esc(r.crs_driver) + '</div>' : '') : '', r => r.crs ? r.crs.number : ''],
    ['Km aujourd\'hui', r => f1(r.km_today), r => r.km_today, 'n'], ['Conduite', r => r.drive_min_today == null ? '' : fH(r.drive_min_today / 60), r => r.drive_min_today, 'n'],
    ['Ralenti', r => r.idle_min_today == null ? '' : fH(r.idle_min_today / 60), r => r.idle_min_today, 'n'], ['Carburant (L)', r => r.fuel_l_today === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l_today), r => r.fuel_l_today, 'n'],
    ['Alertes du jour', r => r.alerts_today ? `<a href="#/alertes?plaque=${encodeURIComponent(r.plate)}&jour=${today()}">${r.alerts_today}</a>` : '0', r => r.alerts_today, 'n'],
    ['Carte', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">Voir</a>` : '']], rows, { empty: 'Aucun véhicule actif' });
}
/** Chauffeurs en ce moment : compteurs Geotab entre le début du contrat et maintenant (relais), sinon totaux du collecteur */
function liveDriversHtml(rows) {
  if (CFG.GEOTAB_LOCAL) return localVehicleTelemetryHtml(rows);
  const P = S.P, list = rows.filter(r => r.contract_num), nmv = v => v === null || v === undefined ? `<span class="nm">${NM}</span>` : v;
  const head = `<div class="sechead"><h2>Chauffeurs en ce moment</h2><span class="small">Depuis le début de leur contrat, compteurs du véhicule lus dans Geotab toutes les ${DRV_SEC} s${LIVE.drvAt ? ' (dernière lecture ' + esc(fmtHMS(LIVE.drvAt).slice(6)) + ')' : ''} : le trajet en cours est compté.</span></div>`;
  if (!list.length) return head + '<div class="empty">Aucun chauffeur sous contrat en ce moment</div>';
  if (LIVE.drvErr && LIVE.drvFallback) return head + msg('Lecture Geotab indisponible (' + esc(LIVE.drvErr) + ') : totaux du collecteur (trajets terminés).', 'warn') + LIVE.drvFallback;
  const items = list.map(r => {
    const d = liveDrv(r); let pts = 0, nEv = 0;
    if (d) (d.events || []).forEach(e => { const w = num((S.rules[e.rule] || {}).weight); if (w > 0) { pts += w; nEv++; } });
    const km = d ? d.km : null, score = d && km != null ? pts / Math.max(km, num(P.kmMin, 20)) * 100 : null;
    return { r, d, km, nEv, score, level: score != null ? levelOf(score, P) : '' };
  });
  return head + shiftSections(items, o => o.r.shift, (sub, sfx) => table('tlived' + sfx, [
    ['Chauffeur', o => `<b>${dlink(o.r.driver_code, o.r.driver_name)}</b>`, o => o.r.driver_name], ['Véhicule', o => vlink(o.r.vehicle_key, o.r.plate)],
    ['État', o => badge(o.r.state, (STATE_CLS[o.r.state] || '') + ' dot') + (o.r.state === 'En route' ? ' ' + f0(o.r.speed) + ' km/h' : '')],
    ['Depuis le', o => fmtDT(o.d ? o.d.from : o.r.ctr_start), o => o.r.ctr_start],
    ['Km', o => o.d ? nmv(o.km == null ? null : f1(o.km)) : '…', o => o.km, 'n'],
    ['Carburant (L)', o => o.d ? nmv(o.d.fuel_l == null ? null : f1(o.d.fuel_l)) : '…', o => o.d && o.d.fuel_l, 'n'],
    ['L/100 km', o => o.d && o.d.fuel_l != null && o.km != null ? (o.km >= num(P.minFuelKm, 30) ? f1(o.d.fuel_l / o.km * 100) : '<span class="small">km insuffisants</span>') : '', null, 'n'],
    ['Litres au ralenti', o => o.d ? nmv(o.d.idle_l == null ? null : f1(o.d.idle_l)) : '…', o => o.d && o.d.idle_l, 'n'],
    ['Conduite', o => o.d ? fH(o.d.drive_min / 60) : '…', o => o.d && o.d.drive_min, 'n'], ['Ralenti', o => o.d ? fH(o.d.idle_min / 60) : '…', o => o.d && o.d.idle_min, 'n'],
    ['Vmax', o => o.d ? f0(o.d.vmax) + ' km/h' : '…', o => o.d && o.d.vmax, 'n'], ['Événements', o => o.d ? o.nEv : '…', o => o.nEv, 'n'],
    ['Score /100 km', o => o.score == null ? (o.d ? `<span class="nm">${NM}</span>` : '…') : o.km >= num(P.kmMin, 20) ? badge(f1(o.score), LEVEL_CLS[o.level]) : '<span class="small">trop peu de km</span>', o => o.score, 'n']], sub))
    + `<p class="small">Km, carburant et litres au ralenti : compteurs du véhicule (Geotab) au début du contrat et maintenant. Conduite, ralenti et Vmax : trajets Geotab et vitesse du trajet en cours. Événements : règles de conduite Geotab (poids des Réglages). « ${NM} » : compteur non transmis par le véhicule.</p>`;
}
function localVehicleTelemetryHtml(rows) {
  const source = LIVE.localSource || {}, items = rows.map(r => ({ r, d: liveDrv(r) }));
  const value = (d, key, unit = '') => d?.[key] == null ? '<span class="nm">' + NM + '</span>' : f1(d[key]) + unit;
  const head = '<div class="sechead"><h2>Consommation et compteurs du véhicule</h2><span class="small">Depuis le début de la journée, heure du Maroc · lecture toutes les ' + (Number(source.telemetry_interval_s) || 30) + ' s.</span></div>';
  if (!rows.length) return head + '<div class="empty">Aucun véhicule associé à Geotab.</div>';
  const warning = source.telemetry_status === 'error' ? msg('Lecture des compteurs interrompue. Les derniers relevés restent datés.', 'warn') : '';
  return head + warning + table('tlocaltelemetry', [
    ['Véhicule', o => vlink(o.r.vehicle_key, o.r.plate), o => o.r.plate],
    ['Chauffeur sous contrat', o => o.r.contract_num ? dlink(o.r.driver_code, o.r.driver_name) : noCtrHtml(o.r)],
    ['Période depuis', o => o.d?.from ? esc(fmtHMS(o.d.from)) : 'En attente'],
    ['Distance (km)', o => value(o.d, 'km'), o => o.d?.km, 'n'],
    ['Carburant (L)', o => value(o.d, 'fuel_l'), o => o.d?.fuel_l, 'n'],
    ['L/100 km', o => o.d?.fuel_l != null && o.d?.km >= 10 ? f1(o.d.fuel_l / o.d.km * 100) : '<span class="nm">' + (o.d?.km != null && o.d.km < 10 ? '&lt; 10 km' : NM) + '</span>', null, 'n'],
    ['Litres au ralenti', o => value(o.d, 'idle_l'), o => o.d?.idle_l, 'n'],
    ['Dernier relevé', o => o.d?.at ? esc(fmtHMS(o.d.at)) + (localTelemetryFresh(o.d) ? '' : ' · <span class="badge warn">Ancien</span>') : 'En attente', o => o.d?.at]
  ], items) + '<p class="small">Consommation calculée avec les différences des compteurs kilométriques et carburant Geotab. Une donnée absente reste non mesurée. Les compteurs du jour ne sont pas attribués au seul chauffeur actuellement affiché.</p>';
}
function liveStatusTxt() {
  if (CFG.WEB_PRODUCTION) {
    const source = LIVE.localSource;
    if (LIVE.err) return 'Lecture des positions partagées indisponible. Les dernières positions restent datées.';
    if (!source) return 'Lecture des positions partagées…';
    const at = Date.parse(source.last_success_at), last = Number.isFinite(at) ? ' Dernière collecte : ' + esc(fmtHMS(source.last_success_at)) + '.' : ' Aucune position reçue pour le moment.';
    if (['paused', 'stopped'].includes(source.status)) return 'Collecte Geotab centrale en pause.' + last;
    if (source.status !== 'healthy' || !Number.isFinite(at) || Date.now() - at > localGeotabStaleMs(source)) return 'Collecte Geotab centrale en attente ou à vérifier.' + last;
    return '<span class="livedot" aria-hidden="true"></span>Positions partagées · consultation toutes les ' + LIVE_SEC + ' s.' + last;
  }
  if (CFG.GEOTAB_LOCAL) {
    const source = LIVE.localSource;
    if (LIVE.err) return 'Lecture locale indisponible : ' + esc(LIVE.err) + '. Les dernières positions ne sont pas considérées comme actuelles.';
    if (!source) return 'Lecture de la connexion Geotab…';
    if (!source.configured) return 'Geotab non connecté au staging. Ouvrez Connecteurs pour saisir vos accès MyGeotab.';
    const last = source.last_success_at ? ' Dernière lecture : ' + esc(fmtHMS(source.last_success_at)) + '.' : ' Aucune lecture de position pour le moment.';
    if (!source.polling) return 'Suivi Geotab en pause.' + last;
    if (source.status !== 'healthy' || !Number.isFinite(Date.parse(source.last_success_at)) || Date.now() - Date.parse(source.last_success_at) > localGeotabStaleMs(source)) return 'Suivi Geotab interrompu ou en attente.' + last + (source.last_error ? ' ' + esc(source.last_error) : '');
    return '<span class="livedot" aria-hidden="true"></span>Positions Geotab : collecte toutes les ' + localGeotabInterval(source) + ' s · événements ' + (Number(source.events_interval_s) || 10) + ' s · compteurs ' + (Number(source.telemetry_interval_s) || 30) + ' s.' + last;
  }
  if (CFG.GEOTAB_ENABLED === false) return 'Geotab non connecté au staging. Les positions et compteurs apparaîtront après configuration.';
  if (LIVE.at) return `<span class="livedot" aria-hidden="true"></span>Temps réel Geotab : actualisé toutes les ${liveIdle() ? 'minutes (aucune activité depuis ' + LIVE_IDLE_MIN + ' min : bougez la souris pour revenir à ' + LIVE_SEC + ' s)' : LIVE_SEC + ' s'}, dernière lecture ${fmtHMS(LIVE.at).slice(6)}.`;
  if (LIVE.err) return 'Temps réel Geotab indisponible (' + esc(LIVE.err) + ') : positions du collecteur, toutes les ' + (S.P.liveMin || 5) + ' min.';
  return 'Connexion au temps réel Geotab…';
}

/** refresh = données du collecteur relues sans redessiner la carte */
async function pageDirect(refresh) {
  if (CFG.GEOTAB_LOCAL && typeof pageOperationsDirect === 'function') return pageOperationsDirect(refresh);
  const ok = inAgency(), rid = ROUTING;
  [LIVE.rows] = await Promise.all([all('live_status', '*', null, ['plate']), loadLiveContracts(), refresh && LIVE.base ? null : loadConsoBase().catch(() => { LIVE.base = {}; })]);
  LIVE.rows = LIVE.rows.filter(r => ok(r.vehicle_key));
  if (refresh) { if (($('#tlive') || CFG.GEOTAB_LOCAL) && MAP && rid === ROUTING) applyDirect(); return; }   // relecture : jamais de page redessinée (l'utilisateur a pu changer de page)
  if (rid !== ROUTING) return;   // autre page demandée pendant le chargement
  const rows = liveRows(), last = LIVE.rows.reduce((m, r) => Math.max(m, new Date(r.updated_at || 0).getTime()), 0);
  // compteurs déjà lus gardés (page rouverte, menu recliqué) : le cadran reste affiché en attendant la lecture suivante
  LIVE.drv = LIVE.drv || {}; LIVE.drvErr = ''; LIVE.drvFallback = ''; LIVE.trails = {};
  $('#page').innerHTML = `
    <div class="head"><h1>En direct</h1><div class="sub"><span id="livest">${liveStatusTxt()}</span></div>
      ${canEdit() && CFG.GEOTAB_ENABLED !== false ? '<button id="syncnow" class="ghost">Mettre à jour les totaux du jour</button>' : ''}</div>
    <div id="livecards">${kpisHtml(rows)}</div>
    ${CFG.GEOTAB_LOCAL ? '<div id="livecoverage">' + localMotionCoverageHtml() + '</div>' : ''}
    <div class="livegrid">
      <section class="mapbox"><div id="map"></div>
        <div class="maplegend"><span class="lg st-ok">En route</span><span class="lg st-warn">Arrêté, contact mis</span><span class="lg st-mute">Garé</span><span class="lg st-crit">Hors ligne / au-dessus du seuil</span>
          <span class="small">Flèche = sens de la marche · trait = trajet depuis l'ouverture de la page</span></div></section>
      <aside class="vlist" id="vlist" aria-label="Véhicules">${vcardsHtml(rows)}</aside>
    </div>
    <section id="livealerts">${liveAlertsHtml()}</section>
    <section id="livedrv">${liveDriversHtml(rows)}</section>
    ${CFG.GEOTAB_LOCAL ? '' : `<section><div class="sechead"><h2>Totaux du jour par véhicule</h2><span class="small">${last ? 'Trajets terminés (contact coupé), calculés par le collecteur, mis à jour le ' + fmtDTY(last) + '.' : 'Le collecteur n\'a pas encore tourné.'}</span></div>
      <div id="livetab">${vehTableHtml(rows)}</div></section>`}`;
  LIVE.markers = {}; LIVE.fitted = false; drawMap(rows);
  window.__rerender = () => { if (rid === ROUTING) applyDirect(); };   // tri d'un tableau : redessiné tout de suite avec les dernières lectures
  liveDrvTick(ROUTING);
  const b = $('#syncnow');
  if (b) b.onclick = async () => { b.disabled = true; try { await job('sync_now'); b.textContent = 'Demande envoyée (5 min max)'; } catch (e) { alert(e.message); b.disabled = false; } };
}
function applyDirect() {
  if (CFG.GEOTAB_LOCAL && document.querySelector('.ops-direct')) return paintOperationsDirect();
  const rows = liveRows(), set = (sel, html) => { const el = $(sel); if (el) el.innerHTML = html; };
  set('#livecards', kpisHtml(rows)); set('#vlist', vcardsHtml(rows)); set('#livetab', vehTableHtml(rows)); set('#livealerts', liveAlertsHtml()); set('#livedrv', liveDriversHtml(rows));
  if (CFG.GEOTAB_LOCAL) set('#livecoverage', localMotionCoverageHtml());
  const st = $('#livest'); if (st) st.innerHTML = liveStatusTxt();
  if (MAP) {
    const visible = new Set(rows.filter(r => r.lat != null && r.lon != null).map(r => r.vehicle_key));
    Object.keys(LIVE.markers).forEach(key => { if (!visible.has(key)) { cancelAnimationFrame(LIVE.markers[key]._anim); MAP.removeLayer(LIVE.markers[key]); delete LIVE.markers[key]; const trail = LIVE.trails[key]; if (trail?.line) MAP.removeLayer(trail.line); delete LIVE.trails[key]; } });
    rows.forEach(placeMarker);
  }
}
/** Lecture Geotab en direct par le relais ; arrêt du relais (non installé, erreur) : nouvel essai dans 1 min */
async function liveTick(my) {
  if (CFG.GEOTAB_ENABLED === false && !CFG.GEOTAB_LOCAL) return;
  const owner = S.session?.user?.id, sessionRevision = S.sessionRevision;
  if (!owner || document.hidden || my !== ROUTING || LIVE.busy && LIVE.request?.route === my && LIVE.request.owner === owner && LIVE.request.sessionRevision === sessionRevision || Date.now() < (LIVE.retryAt || 0)) return;
  if (!CFG.GEOTAB_LOCAL && liveIdle() && Date.now() - (LIVE.lastCall || 0) < LIVE_IDLE_SEC * 1000) return;
  const request = { route: my, owner, sessionRevision }; LIVE.request = request;
  const current = () => my === ROUTING && owner === S.session?.user?.id && sessionRevision === S.sessionRevision && LIVE.request === request;
  LIVE.lastCall = Date.now(); LIVE.busy = true;
  try {
    const j = await relay();
    if (!current()) return;
    const pos = {}; (j.vehicles || []).forEach(v => { pos[v.key] = v; });
    LIVE.pos = pos; LIVE.at = Date.now(); LIVE.err = ''; LIVE.retryAt = 0;
    if (CFG.GEOTAB_LOCAL) { LIVE.localSource = j.source || {}; LIVE.drv = j.telemetry || {}; LIVE.drvAt = j.source?.telemetry_at || 0; LIVE.motionCoverage = j.motion_coverage || null; processLocalLive(j); }
    else processLive(j);
  } catch (e) { if (!current() || e?.name === 'AbortError') return; LIVE.at = 0; if (CFG.GEOTAB_LOCAL) { LIVE.localSource = { ...(LIVE.localSource || {}), status: 'error' }; suspendLocalMotionDisplay(); } else LIVE.pos = {}; LIVE.err = String(e.message || e).slice(0, 120); LIVE.retryAt = Date.now() + 60000; }
  finally { if (LIVE.request === request) { LIVE.busy = false; LIVE.request = null; } }
  if (my !== ROUTING || owner !== S.session?.user?.id || sessionRevision !== S.sessionRevision) return;
  applyDirect();
  // première lecture Geotab : la carte est recadrée sur les positions réelles (la carte s'ouvre sur celles du collecteur)
  if (LIVE.at && MAP && !LIVE.fitted) { const ll = liveRows().filter(r => r.lat != null && r.lon != null && isFinite(+r.lat) && isFinite(+r.lon)).map(r => [+r.lat, +r.lon]);
    if (ll.length) { MAP.fitBounds(L.latLngBounds(ll).pad(0.2), { maxZoom: 13, animate: false }); LIVE.fitted = true; } }
}
/** Chauffeurs en ce moment : compteurs relus toutes les DRV_SEC secondes */
async function liveDrvTick(my) {
  if (CFG.GEOTAB_ENABLED === false || CFG.GEOTAB_LOCAL) return;
  if (document.hidden || my !== ROUTING || LIVE.drvBusy) return;
  if (liveIdle() && Date.now() - (LIVE.drvLast || 0) < DRV_IDLE_SEC * 1000) return;
  const rows = liveRows().filter(r => r.contract_num && r.ctr_start);
  if (!rows.length) return;
  LIVE.drvLast = Date.now();
  LIVE.drvBusy = true;
  try {
    const j = await relay({ mode: 'drivers', c: rows.map(r => r.vehicle_key + '@' + new Date(r.ctr_start).toISOString()).join(',') });
    // gardés même si la page a été redessinée entre-temps (compteurs rattachés au véhicule et au début du contrat)
    LIVE.drv = j.drivers || {}; LIVE.drvAt = Date.now(); LIVE.drvGeoAt = j.at; LIVE.drvErr = '';
  } catch (e) {
    LIVE.drvErr = String(e.message || e).slice(0, 120);
    try { LIVE.drvFallback = await liveDrivers(rows) || ''; } catch (e2) { LIVE.drvFallback = ''; }
  } finally { LIVE.drvBusy = false; }
  // cadrans de consommation (cartes des véhicules) et tableau des chauffeurs redessinés dès la lecture, sans attendre la position suivante
  if (pageOf() === 'direct') { const rs = liveRows(), el = $('#livedrv'), vl = $('#vlist'); if (el) el.innerHTML = liveDriversHtml(rs); if (vl) vl.innerHTML = vcardsHtml(rs); }
}

// ---------- Carte ----------
// Voiture vue de dessus : la carrosserie suit le cap, les badges restent lisibles.
const CAR_SVG = '<svg class="vmk-car" viewBox="0 0 40 56" aria-hidden="true"><path class="vmk-car-tires" d="M6 13h5v10H6zM29 13h5v10h-5zM6 35h5v10H6zM29 35h5v10h-5z"/><path class="vmk-car-body" d="M12 3C15 1 25 1 28 3c3 3 4 9 4 17v24c0 7-3 10-7 10H15c-4 0-7-3-7-10V20C8 12 9 6 12 3Z"/><path class="vmk-car-glass" d="m12 16 3-3h10l3 3-3 8H15l-3-8Zm3 22h10l3 8-3 3H15l-3-3 3-8Z"/><path class="vmk-car-roof" d="M15 25h10v12H15z"/><path class="vmk-car-detail" d="M11 6h5m8 0h5M12 51h4m8 0h4M11 25v13m18-13v13"/></svg>';
function vIcon(r) {
  const critical = !!(LIVE.fast[r.vehicle_key] || LIVE.over[r.vehicle_key] || LIVE.motion[r.vehicle_key]), rot = r.state === 'En route' && r.bearing != null && isFinite(+r.bearing) ? Math.round(+r.bearing) : null;
  const appearance = typeof mapVehicleAppearance === 'function' ? mapVehicleAppearance(r) : {kind:'neutral',label:'Plateforme non confirmée'}, kind = ['uber','bolt','both','parking'].includes(appearance?.kind) ? appearance.kind : 'neutral';
  const platformStatus = ['available','on_trip','to_pickup','on_break','offline','parking'].includes(appearance?.status) ? appearance.status : 'unknown';
  const lastKnown = kind === 'parking' && appearance?.lastKnown === true;
  const positionBasis = lastKnown ? 'last_known_parking' : r.live ? 'current' : 'last_known';
  const st = CFG.GEOTAB_LOCAL ? platformStatus : critical ? 'crit' : ST_CLS(r.state);
  const label = [r.plate, appearance?.label || 'Plateforme non confirmée', r.state === 'En route' ? 'En mouvement · Geotab' : r.state, critical ? 'Signalement critique à vérifier' : ''].filter(Boolean).join(' · ');
  const brands = kind === 'uber' || kind === 'both' ? '<b class="vmk-brand uber">Uber</b>' : '';
  const badges = brands + (kind === 'bolt' || kind === 'both' ? '<b class="vmk-brand bolt">Bolt</b>' : '');
  const body = kind === 'parking' ? '<b class="vmk-parking" aria-hidden="true">P</b>' : `<span class="vmk-car-direction"${rot != null ? ` style="transform:rotate(${rot}deg)"` : ''}>${CAR_SVG}</span>`;
  const html = `<span class="vmk-pin st-${st}${CFG.GEOTAB_LOCAL ? ' vmk-platform-status' : ''}${critical ? ' has-critical' : ''}${lastKnown ? ' is-last-known' : ''}${r.state === 'En route' ? ' moving' : ''}${r.crs ? ' crs' : ''}" data-kind="${kind}" data-status="${platformStatus}" data-position-basis="${positionBasis}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${rot != null ? `<span class="vmk-dir" style="transform:rotate(${rot}deg)" aria-hidden="true"><i></i></span>` : ''}${body}${critical ? '<b class="vmk-critical" aria-hidden="true">!</b>' : ''}</span>`
    + (badges ? `<span class="vmk-brands" aria-hidden="true">${badges}</span>` : '')
    + `<span class="vmk-l${r.crs ? ' crs' : ''}">${r.crs ? 'Course privée · ' : ''}${esc(r.plate || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}</span>`;
  return { html, icon: () => L.divIcon({ className: 'vmk', iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -23], tooltipAnchor: [0, -25], html }) };
}
/** Info-bulle : chauffeur, plaque, activité confirmée et mouvement Geotab. */
function tipHtml(r) {
  const appearance = typeof mapVehicleAppearance === 'function' ? mapVehicleAppearance(r) : {label:'Plateforme non confirmée'}, context = '<br><span class="vmk-context">' + esc(appearance?.label || 'Plateforme non confirmée') + '</span>';
  if (CFG.GEOTAB_LOCAL) return `<b>${esc(r.driver_name)}</b><br>${esc(r.plate || '')} · Geotab : ${esc(r.state === 'En route' ? 'en mouvement' : r.state || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${context}${LIVE.motion[r.vehicle_key] ? '<br>Signalement critique à vérifier' : ''}`;
  if (r.crs) return `<b>Course privée ${esc(r.crs.number || '')}</b><br>${esc(r.crs_driver || r.driver_name || '')}${r.crs.client_name ? ' · ' + esc(r.crs.client_company || r.crs.client_name) : ''}<br>${esc(r.plate || '')} · ${esc(r.state || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${context}`;
  return `<b>${esc(r.driver_name)}</b>${r.contract_num && r.shift ? ' · shift ' + esc(r.shift.toLowerCase()) : ''}<br>${esc(r.plate || '')} · ${esc(r.state || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${context}`;
}
function popupHtml(r) {
  const appearance = typeof mapVehicleAppearance === 'function' ? mapVehicleAppearance(r) : {label:'Plateforme non confirmée'};
  return `<div class="vpop">${plate(r.plate)} <span class="small">${esc(r.model || '')}</span><div class="vmk-context">${esc(appearance?.label || 'Plateforme non confirmée')}</div><div>${CFG.GEOTAB_LOCAL ? 'Geotab : ' : ''}<b>${esc(CFG.GEOTAB_LOCAL && r.state === 'En route' ? 'En mouvement' : r.state || '')}</b>${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${r.since_min != null ? ' · depuis ' + fH(r.since_min / 60) : ''}</div>
    ${r.crs ? `<div>${crsLiveHtml(r, true)}<br>Chauffeur : <b>${esc(r.crs_driver || '—')}</b> · jusqu'au ${esc(fmtDTY(r.crs.end_at))}</div>` : ''}
    <div>${CFG.GEOTAB_LOCAL ? esc(r.driver_name) : r.contract_num ? esc(r.driver_name) + ' · ' + esc(r.shift ? 'shift ' + r.shift.toLowerCase() : '') + ' · contrat ' + esc(r.contract_num) : noCtrHtml(r)}</div>
    <div class="small">Position ${r.live || r.geo_position ? 'Geotab ' + esc(fmtHMS(r.last_pos_at)) : 'du collecteur ' + esc(fmtDT(r.last_pos_at))}</div>
    <div><a href="#/vehicule?k=${encodeURIComponent(r.vehicle_key)}">Fiche du véhicule</a>${(r.current_assignment || r.contract_num) && r.driver_code && r.driver_code !== HORS ? ` · <a href="#/chauffeur?c=${encodeURIComponent(r.driver_code)}">Fiche du chauffeur</a>` : ''}</div></div>`;
}
/** Marqueur d'un véhicule : créé ou déplacé en glissant vers sa nouvelle position ; trace du trajet depuis l'ouverture de la page */
function placeMarker(r) {
  if (r.lat == null || r.lon == null || !isFinite(+r.lat) || !isFinite(+r.lon)) return;
  const ic = vIcon(r), k = r.vehicle_key;
  let m = LIVE.markers[k];
  if (!m) {
    m = LIVE.markers[k] = L.marker([r.lat, r.lon], { icon: ic.icon(), riseOnHover: true, keyboard: false }).bindPopup(popupHtml(r))
      .bindTooltip(tipHtml(r), { direction: 'top', className: 'vtip', opacity: 1 }).addTo(MAP);
    m.vehicleKey = k; m._ik = ic.html;
    m.on('click', () => { LIVE.sel = k; document.querySelectorAll('#vlist .vcard').forEach(el => el.classList.toggle('on', el.dataset.vk === k)); });
  } else {
    if (m._ik !== ic.html) { m.setIcon(ic.icon()); m._ik = ic.html; }
    m.setPopupContent(popupHtml(r)); m.setTooltipContent(tipHtml(r));
  }
  if (r.live) {
    const tr = LIVE.trails[k] = LIVE.trails[k] || { pts: [], line: null }, last = tr.pts[tr.pts.length - 1];
    if (!last || last[0] !== +r.lat || last[1] !== +r.lon) { tr.pts.push([+r.lat, +r.lon]); if (tr.pts.length > TRAIL_MAX) tr.pts.shift(); }
    if (tr.pts.length > 1) { if (!tr.line) tr.line = L.polyline(tr.pts, { className: 'vtrail', weight: 4, opacity: .75, interactive: false }).addTo(MAP); else tr.line.setLatLngs(tr.pts); }
  }
  const a = m.getLatLng(), b = L.latLng(r.lat, r.lon); if (a.equals(b)) return;
  const t0 = performance.now(), dur = 1500; cancelAnimationFrame(m._anim);
  const step = t => { const q = Math.min(1, (t - t0) / dur); m.setLatLng([a.lat + (b.lat - a.lat) * q, a.lng + (b.lng - a.lng) * q]); if (q < 1) m._anim = requestAnimationFrame(step); };
  m._anim = requestAnimationFrame(step);
}
function osmLayer(statusId) {
  // Browser-supplied origin only: preserve the actual Referer required by OSM,
  // normal browser identification and HTTP caching. No proxy or cache bypass.
  const status = statusId && document.getElementById(statusId), hide = statusId && document.querySelector('[data-basemap-hide="' + statusId + '"]');
  if (hide?.dataset.hidden === 'true') { if (status) { status.dataset.state = 'hidden'; status.textContent = 'Fond de carte masqué. Les positions et les contours restent visibles.'; } return L.layerGroup(); }
  const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' });
  if (status && typeof opsObserveMapTiles === 'function') opsObserveMapTiles(layer, status);
  if (hide) { hide.disabled = false; hide.onclick = () => { hide.dataset.hidden = 'true'; layer.remove(); hide.disabled = true; hide.textContent = 'Fond de carte masqué'; if (status) { status.dataset.state = 'hidden'; status.textContent = 'Fond de carte masqué. Les positions et les contours restent visibles.'; } }; }
  return layer;
}
function drawMap(rows) {
  if (!window.L) return;
  if (MAP) { MAP.remove(); MAP = null; }
  const pts = rows.filter(r => r.lat != null && r.lon != null);
  MAP = L.map('map', { scrollWheelZoom: false, zoomControl: true });
  osmLayer('ops-map-status').addTo(MAP);
  pts.forEach(placeMarker);
  if (pts.length) MAP.fitBounds(L.latLngBounds(pts.map(r => [r.lat, r.lon])).pad(0.2), { maxZoom: 13 }); else MAP.setView([31.63, -8.0], 6);
}
// Clic sur un véhicule de la liste : la carte se centre sur lui ; clic sur une alerte : sa fiche
document.addEventListener('click', e => {
  const vc = e.target.closest('#vlist .vcard');
  if (vc && MAP) { const k = vc.dataset.vk, m = LIVE.markers[k]; LIVE.sel = k; document.querySelectorAll('#vlist .vcard').forEach(el => el.classList.toggle('on', el.dataset.vk === k));
    if (m) { MAP.flyTo(m.getLatLng(), Math.max(MAP.getZoom(), 15), { duration: .8 }); m.openPopup(); } return; }
  const ac = e.target.closest('[data-la]');
  if (ac) { const a = LIVE.alerts.find(x => x.id === ac.dataset.la) || (LIVE.motionHistory || []).find(x => x.id === ac.dataset.la); if (a) openAlertDetail(a); return; }
  const ad = e.target.closest('[data-ad]');
  if (ad && S.alIdx && S.alIdx[ad.dataset.ad]) openAlertDetail(alertFromDb(S.alIdx[ad.dataset.ad]));
});

// ---------- Fiche d'une alerte ----------
/** Alerte de la base (journal du collecteur) -> même forme que les alertes en direct */
function alertFromDb(a) {
  const p = String(a.day).slice(0, 10).split('-').map(Number), h = String(a.time || '00:00').split(':').map(Number), t = localToDate(p[0], p[1], p[2], h[0] || 0, h[1] || 0);
  return { id: 'DB|' + a.id, vehicle_key: a.vehicle_key, plate: a.plate, at: Number.isFinite(t.getTime())?t.toISOString():null, end: null, severity: a.severity, type: a.type, cat: /vitesse/i.test(a.type || '') ? 'Vitesse' : '',
    detail: String(a.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=\S+/g, '').trim(), driver_name: a.driver_name || '', driver_code: a.driver_code || '', contract_num: a.contract_num || '', shift: alertShift(a), approx: true };
}
async function openAlertDetail(a) {
  let d = $('#adlg');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'adlg'; d.className = 'adlg'; document.body.appendChild(d);
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('.adclose')) d.close(); });
    d.addEventListener('close', () => { if (d._map) { d._map.remove(); d._map = null; } });
  }
  if(!a.at||!Number.isFinite(Date.parse(a.at))){
    d._tok=(d._tok||0)+1;
    d.innerHTML=`<div class="adhead"><h2>${esc(a.type||'Signalement')}</h2><button type="button" class="ghost adclose" aria-label="Fermer">Fermer</button></div><div class="panel"><p>Heure locale ambiguë ou invalide : l’instant de ce signalement doit être confirmé.</p><p>${esc(a.detail||'')}</p><p class="small">Aucune lecture Geotab n’est effectuée pour un horaire incertain.</p></div>`;
    if(!d.open)d.showModal();return;
  }
  if (CFG.GEOTAB_LOCAL && a.motion) {
    const source = LIVE.localSource || {}, vehicle = LIVE.pos[a.vehicle_key], driver = a.driver_name || 'Non associé', correction = localMotionCorrection(a);
    d.innerHTML = `<div class="adhead"><div>${correction ? badge(correction.label, 'info') : badge(a.severity, GRAV_CLS[a.severity])} <b class="adtype">${esc(a.type)}</b> ${plate(a.plate)}<div class="sub">${esc(fmtHMS(a.at))} · ${esc(driver)}</div></div><button type="button" class="ghost adclose" aria-label="Fermer">Fermer</button></div>
      <div class="panel">${correction ? '<p>' + esc(correction.explanation) + '</p><p class="small">Correction ' + esc(a.evidence.corrected_at ? fmtHMS(a.evidence.corrected_at) : 'enregistrée') + '. Historique conservé pour expliquer la correction ; aucun déplacement hors ligne n’est établi pour ce chauffeur par cet incident.</p>' : `${a.status && a.status !== 'open' ? '<p>' + badge(a.status === 'resolved' ? 'Épisode terminé' : 'Surveillance suspendue', a.status === 'resolved' ? 'info' : 'warn') + (a.resolved_at || a.suspended_at ? ' · ' + esc(fmtHMS(a.resolved_at || a.suspended_at)) : '') + '</p>' : ''}<p>${esc(a.detail)}</p><p><b>Déplacement à vérifier.</b> Le statut hors ligne et le déplacement ne permettent pas de confirmer qu’une course a eu lieu.</p><p class="small">Ce signalement repose sur le chauffeur et le véhicule associés dans Ludy.</p>`}
      ${vehicle ? `<p>Dernier état connu du véhicule : <b>${esc(vehicle.state || 'Inconnu')}</b>${vehicle.at ? ' · ' + esc(fmtHMS(vehicle.at)) : ''}. Cette position peut être postérieure à l’événement.</p>` : ''}
      <a class="button-link secondary" href="#/vehicule?k=${encodeURIComponent(a.vehicle_key)}" id="local-alert-vehicle">Voir le véhicule</a></div>`;
    d.querySelector('#local-alert-vehicle').onclick = () => d.close();
    if (!d.open) d.showModal();
    return;
  }
  const t0 = new Date(a.at).getTime(), t1 = a.end ? Math.max(t0, new Date(a.end).getTime()) : t0, tok = d._tok = (d._tok || 0) + 1;
  d.innerHTML = `<div class="adhead"><div>${badge(a.severity, GRAV_CLS[a.severity])} <b class="adtype">${esc(a.type)}</b> ${plate(a.plate)}
      <div class="sub">${esc(fmtHMS(a.at))}${a.approx ? ' (heure de l\'alerte, à la minute)' : ''} · ${a.contract_num || (a.driver_code && a.driver_code !== HORS) ? esc(a.driver_name) + ' ' + shiftBadge(a.shift) + (a.contract_num ? ' · contrat ' + esc(a.contract_num) : '') : '<span class="nm">Sans contrat</span>'}</div></div>
    <div class="adact"><a class="btn small" id="adwa" target="_blank" rel="noopener">WhatsApp</a><a class="btn small ghostb" id="admail" target="_blank" rel="noopener">E-mail</a>
      <button type="button" class="ghost small" id="adcopy">Copier</button><button type="button" class="ghost adclose" aria-label="Fermer">Fermer</button></div></div>
    <div id="adbody"><div class="loading">Lecture des données Geotab autour de l'instant…</div></div>`;
  if (!d.open) d.showModal();
  alertShare(a, null);
  try {
    const j = await relay({ mode: 'detail', key: a.vehicle_key, from: new Date(t0).toISOString(), to: new Date(a.approx ? t0 + MIN : t1).toISOString() });
    if (d._tok === tok && d.open) renderDetail(d, a, j, t0, a.approx ? t0 + MIN : t1);
  } catch (e) { const b = $('#adbody'); if (b && d._tok === tok) b.innerHTML = msg('Lecture Geotab impossible : ' + esc(e.message), 'err'); }
}
function renderDetail(d, a, j, t0, t1) {
  const gps = j.gps || [], road = (j.road || []).filter(p => p[1] !== 0), src = (j.speed || []).length ? 'capteur' : 'gps';
  const spd = src === 'capteur' ? j.speed : gps.map(p => [p[0], p[1]]);
  const ev = (j.events || []).find(e => 'EV|' + e.id === a.id) || null;
  if (ev) { t0 = new Date(ev.at).getTime(); t1 = ev.end ? new Date(ev.end).getTime() : t1; }
  // pic de vitesse pendant l'événement : relevés compris dans l'événement + le relevé juste avant et juste après (le capteur
  // n'envoie une valeur que quand la vitesse change : ces deux relevés encadrent l'événement)
  const inEv = spd.filter(p => p[0] >= t0 && p[0] <= t1), before = spd.filter(p => p[0] < t0).slice(-1), after = spd.filter(p => p[0] > t1).slice(0, 1);
  const win = before.concat(inEv, after);
  let pk = null; win.forEach(p => { if (!pk || p[1] > pk[1]) pk = p; });
  // pire dépassement pendant l'événement (vitesse moins limite de la route à chaque relevé) : la limite fournie par Geotab peut
  // changer pendant l'événement (ex. 100 puis 80, ou 120 quelques secondes), la limite à l'instant de la vitesse max ne suffit pas
  const wo = worstOver(win, road), lims = [...new Set(win.map(p => limitAt(road, p[0])).filter(Boolean))];
  const lim = wo ? wo.lim : null, over = wo ? wo.over : null, limPk = pk ? limitAt(road, pk[0]) : null;
  // temps au-dessus de la limite de la route pendant l'événement : chaque relevé vaut jusqu'au suivant, compté seulement dans [t0, t1]
  let above = 0, known = false;
  for (let i = 0; i + 1 < spd.length; i++) { const p = spd[i], q = spd[i + 1], x0 = Math.max(p[0], t0), x1 = Math.min(q[0], t1); if (x1 <= x0) continue;
    const l = limitAt(road, p[0]); if (l) { known = true; if (p[1] > l) above += x1 - x0; } }
  if (!known && lim) known = true;   // événement instantané (freinage, virage) : limite connue, 0 s au-dessus
  const near = t => { let b = null; gps.forEach(p => { if (!b || Math.abs(p[0] - t) < Math.abs(b[0] - t)) b = p; }); return b; };
  const at = pk ? near(pk[0]) : near(t0);
  const c = [['Vitesse max ' + (src === 'capteur' ? '(capteur du véhicule)' : '(GPS)'), pk ? `<b>${f0(pk[1])} km/h</b> à ${esc(fmtHMS(pk[0]).slice(6))}` : `<span class="nm">${NM}</span>`],
    ['Limite de la route', lim ? f0(lim) + ' km/h' + (wo && wo.over > 0 ? ' à ' + esc(fmtHMS(wo.t).slice(6)) : '') : '<span class="nm">non fournie par Geotab</span>'],
    ['Dépassement max', over != null ? (over > 0 ? `<b class="red">+${f0(over)} km/h</b> <span class="small">(${f0(wo.v)} km/h à ${esc(fmtHMS(wo.t).slice(6))})</span>` : 'aucun (' + f0(over) + ' km/h)') : `<span class="nm">${NM}</span>`],
    ['Au-dessus de la limite pendant l\'événement', known ? Math.round(above / 1000) + ' s' : `<span class="nm">${NM}</span>`],
    ['Durée de l\'événement (Geotab)', ev && ev.dur_min != null ? Math.round(ev.dur_min * 60) + ' s' : t1 > t0 ? Math.round((t1 - t0) / 1000) + ' s' : '—'],
    ['Distance pendant l\'événement', ev && ev.km != null ? f1(ev.km) + ' km' : '—'],
    ['Lieu', at ? `<a target="_blank" rel="noopener" href="${osmUrl(at[2], at[3])}">${(+at[2]).toFixed(5)}, ${(+at[3]).toFixed(5)}</a>` : `<span class="nm">${NM}</span>`]];
  alertShare(a, { pk, lim, over, above: known ? Math.round(above / 1000) : null, src, at,
    dur: ev && ev.dur_min != null ? Math.round(ev.dur_min * 60) : t1 > t0 ? Math.round((t1 - t0) / 1000) : null, km: ev && ev.km != null ? ev.km : null });
  $('#adbody').innerHTML = `<div class="adgrid">${c.map(x => `<div class="adkv"><span>${x[0]}</span><div>${x[1]}</div></div>`).join('')}</div>
    <h3>Vitesse autour de l'instant</h3>${speedChart(spd, road, j, t0, t1, pk)}
    ${evHistory(win, road, wo, lims)}
    <h3>Trajet sur la carte</h3><div id="admap"></div>
    <p class="small">Données lues dans Geotab pour ${esc(a.plate)} du ${esc(fmtHMS(j.from))} au ${esc(fmtHMS(j.to).slice(6))} : vitesse du ${src === 'capteur' ? 'capteur du véhicule (même source que les trajets)' : 'GPS (capteur du véhicule non transmis)'}, limite de la route fournie par Geotab, positions GPS. Rien n'est estimé.</p>
    <div class="adlinks"><a href="#/vehicule?k=${encodeURIComponent(a.vehicle_key)}">Fiche du véhicule</a>${a.driver_code && a.driver_code !== HORS ? ` · <a href="#/chauffeur?c=${encodeURIComponent(a.driver_code)}">Fiche du chauffeur</a>` : ''} · <a href="#/alertes?plaque=${encodeURIComponent(a.plate || '')}&jour=${localDay(t0)}">Alertes du jour</a></div>`;
  d.querySelectorAll('.adlinks a').forEach(x => x.addEventListener('click', () => d.close()));
  if (window.L && gps.length) {
    const m = d._map = L.map('admap', { scrollWheelZoom: false }); osmLayer().addTo(m);
    const all = gps.map(p => [p[2], p[3]]), evp = gps.filter(p => p[0] >= t0 - 30000 && p[0] <= t1 + 30000).map(p => [p[2], p[3]]);
    L.polyline(all, { className: 'adpath', weight: 4, opacity: .8 }).addTo(m);
    if (evp.length > 1) L.polyline(evp, { className: 'adpath-ev', weight: 6, opacity: .95 }).addTo(m);
    if (at) L.circleMarker([at[2], at[3]], { radius: 8, className: 'adpk', weight: 2, fillOpacity: 1 }).bindTooltip(pk ? f0(pk[1]) + ' km/h' + (limPk ? ' (limite ' + limPk + ')' : '') : esc(a.type), { permanent: true, direction: 'top' }).addTo(m);
    m.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 16 }); setTimeout(() => m.invalidateSize(), 50);
  } else { const el = $('#admap'); if (el) el.outerHTML = '<div class="empty">Aucune position GPS transmise par Geotab sur ce moment</div>'; }
}
/**
 * Partage de l'alerte : message détaillé (mêmes chiffres que la fiche, lus dans Geotab) envoyé par WhatsApp, par e-mail ou copié.
 * m = mesures de la fiche (null tant que Geotab n'a pas répondu : message avec les seules infos de l'alerte)
 */
function alertShareText(a, m) {
  const v = vehOf(a.vehicle_key), L = [];
  L.push('⚠️ Ludy · Alerte ' + (a.severity || '') + ' : ' + a.type);
  L.push('Véhicule : ' + (a.plate || '') + (v.model ? ' (' + v.model + ')' : ''));
  L.push('Chauffeur : ' + (a.contract_num || (a.driver_code && a.driver_code !== HORS) ? (a.driver_name || a.driver_code) + (a.shift ? ' · shift ' + String(a.shift).toLowerCase() : '') + (a.contract_num ? ' · contrat ' + a.contract_num : '') : 'sans contrat'));
  L.push('Heure : ' + fmtHMS(a.at) + (a.approx ? ' (à la minute)' : ''));
  if (m) {
    if (m.pk) L.push('Vitesse max : ' + f0(m.pk[1]) + ' km/h à ' + fmtHMS(m.pk[0]).slice(6) + (m.src === 'capteur' ? ' (capteur du véhicule)' : ' (GPS)'));
    if (m.lim) L.push('Limite de la route : ' + f0(m.lim) + ' km/h' + (m.over != null ? (m.over > 0 ? ' → dépassement +' + f0(m.over) + ' km/h' : ' (pas de dépassement)') : ''));
    const x = [m.above != null ? 'au-dessus de la limite ' + m.above + ' s' : '', m.dur != null ? 'durée ' + m.dur + ' s' : '', m.km != null ? f1(m.km) + ' km' : ''].filter(Boolean);
    if (x.length) L.push('Événement : ' + x.join(' · '));
    if (m.at) L.push('Lieu : https://maps.google.com/?q=' + (+m.at[2]).toFixed(5) + ',' + (+m.at[3]).toFixed(5));
  } else if (a.detail) L.push(String(a.detail));
  L.push('Source : Geotab (rien n\'est estimé).');
  return L.join('\n');
}
function alertShare(a, m) {
  const txt = alertShareText(a, m), wa = $('#adwa'), ml = $('#admail'), cp = $('#adcopy');
  if (wa) wa.href = 'https://wa.me/?text=' + encodeURIComponent(txt);
  if (ml) ml.href = 'mailto:?subject=' + encodeURIComponent('Ludy · ' + a.type + ' · ' + (a.plate || '') + ' · ' + fmtHMS(a.at)) + '&body=' + encodeURIComponent(txt);
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(txt); cp.textContent = 'Copié'; } catch (e) { await askText('Copiez le message :', txt); } };
}
/**
 * Historique des relevés de l'événement (le relevé juste avant, ceux de l'événement, le relevé juste après) : heure, vitesse,
 * limite fournie par Geotab à cet instant, écart ; changements de limite entre deux relevés ; ligne du dépassement retenu en gras
 */
function evHistory(win, road, wo, lims) {
  if (!win.length) return '';
  const a = win[0][0], b = win[win.length - 1][0], rows = win.map(p => ({ t: p[0], v: p[1], lim: limitAt(road, p[0]) }));
  (road || []).filter(r => r[0] > a && r[0] <= b && !win.some(p => p[0] === r[0])).forEach(r => rows.push({ t: r[0], lim: r[1] > 0 ? r[1] : null, chg: true }));
  rows.sort((x, y) => x.t - y.t);
  return `<h3>Historique des relevés de l'événement${lims.length > 1 ? ` <span class="small">(limite Geotab variable : ${lims.map(f0).join(', ')} km/h)</span>` : ''}</h3>
    <div class="tw"><table class="adhist"><thead><tr><th>Heure</th><th class="n">Vitesse</th><th class="n">Limite Geotab</th><th class="n">Écart</th></tr></thead><tbody>${rows.map(r => {
      const o = r.v != null && r.lim ? r.v - r.lim : null, me = wo && !r.chg && r.t === wo.t;
      return `<tr class="${me ? 'adwo' : ''}"><td>${esc(fmtHMS(r.t).slice(6))}</td><td class="n">${r.chg ? '<span class="small">changement de limite</span>' : f0(r.v) + ' km/h'}</td>
        <td class="n">${r.lim ? f0(r.lim) + ' km/h' : '<span class="nm">inconnue</span>'}</td><td class="n">${o == null ? '' : o > 0 ? `<b class="red">+${f0(o)}</b>` : f0(o)}${me ? ' <span class="small">retenu</span>' : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
/** Courbe de vitesse (SVG) : vitesse, limite de la route (pointillés), événement (zone colorée), pic */
function speedChart(spd, road, j, t0, t1, pk) {
  if (!spd.length) return '<div class="empty">Aucune vitesse transmise par Geotab sur ce moment</div>';
  const W = 760, H = 230, L0 = 44, R0 = 12, T0 = 12, B0 = 28, a = new Date(j.from).getTime(), b = new Date(j.to).getTime();
  const vmax = Math.max(60, ...spd.map(p => p[1]), ...road.filter(p => p[1] > 0).map(p => p[1]));
  const top = Math.ceil((vmax + 10) / 20) * 20, x = t => L0 + (t - a) / Math.max(1, b - a) * (W - L0 - R0), y = v => T0 + (1 - v / top) * (H - T0 - B0);
  let g = ''; for (let v = 0; v <= top; v += 20) g += `<line class="gl" x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}"/><text class="gt" x="${L0 - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const step = Math.max(MIN, Math.ceil((b - a) / 6 / MIN) * MIN);
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) g += `<text class="gt" x="${x(t)}" y="${H - 8}" text-anchor="middle">${esc(localHM(t))}</text>`;
  const ev = `<rect class="evr" x="${x(Math.max(a, t0 - 2000))}" y="${T0}" width="${Math.max(3, x(Math.min(b, t1 + 2000)) - x(Math.max(a, t0 - 2000)))}" height="${H - T0 - B0}"/>`;
  let lp = '', prev = null;   // limite : en escalier, interrompue quand Geotab ne la connaît pas
  road.forEach(p => { const t = Math.max(a, p[0]); if (t > b) return; if (prev && prev[1] > 0) lp += `L${x(t)},${y(prev[1])}`; if (p[1] > 0) lp += `M${x(t)},${y(p[1])}`; prev = [t, p[1]]; });
  if (prev && prev[1] > 0) lp += `L${x(b)},${y(prev[1])}`;
  const sp = spd.filter(p => p[0] >= a && p[0] <= b).map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join('');
  const pkm = pk ? `<circle class="pkd" cx="${x(pk[0])}" cy="${y(pk[1])}" r="5"/><text class="pkt" x="${x(pk[0])}" y="${y(pk[1]) - 10}" text-anchor="middle">${f0(pk[1])} km/h</text>` : '';
  return `<figure class="schart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vitesse en km/h autour de l'alerte">${g}${ev}<path class="lim" d="${lp}"/><path class="spd" d="${sp}"/>${pkm}</svg>
    <figcaption><span class="lg-spd">Vitesse (km/h)</span><span class="lg-lim">Limite de la route</span><span class="lg-ev">Événement</span></figcaption></figure>`;
}
