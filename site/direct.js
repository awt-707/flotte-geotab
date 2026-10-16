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
const LIVE_SEC = 5, DRV_SEC = 30, TRAIL_MAX = 240;
const LIVE = { rows: [], pos: {}, at: 0, err: '', markers: {}, trails: {}, ctr: [], alerts: [], seen: {}, primed: false, fast: {}, over: {},
  drv: {}, drvAt: 0, drvErr: '', drvFallback: '', drvBusy: false, sel: '' };
// Alertes en direct : événements Geotab des règles de conduite (dès que Geotab les signale) + vitesse en direct au-dessus du seuil
const LIVE_TYPE = { Collision: 'Collision', Vitesse: 'Excès de vitesse', Ceinture: 'Ceinture non bouclée', Freinage: 'Freinage brusque', 'Accélération': 'Accélération brusque', Virage: 'Virage brusque' };
const LIVE_SEV = { Collision: 'Critique', Vitesse: 'Haute', Ceinture: 'Haute', Freinage: 'Moyenne', 'Accélération': 'Moyenne', Virage: 'Moyenne' };
const LIVE_ORDER = { 'En route': 0, 'Arrêté, contact mis': 1, 'Garé': 2, 'Boîtier hors ligne': 3 };
const ST_CLS = s => STATE_CLS[s] || 'mute';

/** Appel du relais Geotab (jeton de l'utilisateur : il ne reçoit que les véhicules de ses agences) */
async function relay(params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch(CFG.SUPABASE_URL + '/functions/v1/geotab-live' + qs, { headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (S.session && S.session.access_token) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || 'HTTP ' + r.status);
  return j;
}
function liveAlertOf(e) {
  const rl = S.rules[e.rule] || {}, cat = rl.category || '';
  if (!(num(rl.weight) > 0 || cat === 'Collision')) return null;   // mêmes règles que le score de danger
  const c = contractAt(e.key, new Date(e.at).getTime());
  return { id: 'EV|' + e.id, ev: e.id, vehicle_key: e.key, plate: e.plate, at: e.at, end: e.end, cat, severity: LIVE_SEV[cat] || 'Moyenne', type: LIVE_TYPE[cat] || rl.name || 'Événement de conduite',
    detail: (rl.name || e.rule) + (e.dur_min != null ? ' · ' + Math.round(e.dur_min * 60) + ' s' : '') + (e.km ? ' · ' + f1(e.km) + ' km' : ''),
    driver_name: c ? c.name : 'Hors contrat', driver_code: c ? c.client_code : '', contract_num: c ? c.num : '', shift: c ? shiftOf(c.start_at, S.P) : '' };
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
      if (LIVE.fast[v.key]) { const a = LIVE.alerts.find(x => x.id === LIVE.fast[v.key]); if (a) { a.end = v.at || a.end; if (v.speed > a.vmax) { a.vmax = v.speed; a.detail = 'Vitesse max ' + v.speed + ' km/h (seuil ' + lim + ')'; } } return; }
      const c = contractAt(v.key, now), a = { id: 'VIT|' + v.key + '|' + (v.at || now), vehicle_key: v.key, plate: v.plate, at: v.at || new Date(now).toISOString(), end: v.at || null, cat: 'Vitesse', severity: 'Haute',
        type: 'Vitesse excessive', vmax: v.speed, detail: v.speed + ' km/h (seuil ' + lim + ')', driver_name: c ? c.name : 'Hors contrat', driver_code: c ? c.client_code : '', contract_num: c ? c.num : '', shift: c ? shiftOf(c.start_at, S.P) : '' };
      LIVE.fast[v.key] = a.id; LIVE.alerts.push(a); fresh.push(a);
    } else if (v.state !== 'En route' || v.speed < lim - 10) delete LIVE.fast[v.key];   // 10 km/h de marge : pas d'alerte à répétition autour du seuil
    // dépassement de la limite de la route (limite Geotab sous le véhicule) au-delà du seuil réglé pour cette limite (Réglages)
    if (v.state === 'En route' && v.limit) {
      const tol = rptOverTol(S.P, v.limit), thr = v.limit + tol, txt = sp => sp + ' km/h pour ' + v.limit + ' km/h autorisés (seuil +' + tol + ', soit ' + thr + ' km/h)';
      if (v.speed >= thr) {
        const o = LIVE.over[v.key] && LIVE.alerts.find(x => x.id === LIVE.over[v.key]);
        if (o) { o.end = v.at || o.end; if (v.speed > o.vmax) { o.vmax = v.speed; o.detail = txt(v.speed); } }
        else { const c = contractAt(v.key, now), a = { id: 'DEP|' + v.key + '|' + (v.at || now), vehicle_key: v.key, plate: v.plate, at: v.at || new Date(now).toISOString(), end: v.at || null, cat: 'Vitesse',
          severity: 'Haute', type: 'Dépassement limite', vmax: v.speed, detail: txt(v.speed), driver_name: c ? c.name : 'Hors contrat', driver_code: c ? c.client_code : '', contract_num: c ? c.num : '', shift: c ? shiftOf(c.start_at, S.P) : '' };
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
 *  dans la tolérance « ctrTolMin ») ; aucun : hors contrat */
function contractAt(key, t) {
  const tol = num(S.P.ctrTolMin, 20) * MIN, list = LIVE.ctr.filter(c => c.vehicle_key === key)
    .map(c => ({ c, a: new Date(c.start_at).getTime(), b: c.end_at ? new Date(c.end_at).getTime() : t + HOUR })).sort((x, y) => x.a - y.a);
  let best = null; list.forEach(x => { if (t >= x.a && t <= x.b) best = x; });
  if (!best) { let bd = Infinity; list.forEach(x => { const d = t < x.a ? x.a - t : t > x.b ? t - x.b : 0; if (d <= tol && d < bd) { bd = d; best = x; } }); }
  return best ? best.c : null;
}
/** Contrats qui peuvent couvrir le moment présent (relus avec les totaux du collecteur, toutes les minutes) */
async function loadLiveContracts() {
  const now = Date.now(), tol = num(S.P.ctrTolMin, 20) * MIN;
  // fenêtre des alertes en direct (30 min) comprise : une infraction d'il y a 25 min reste attribuée au bon contrat
  LIVE.ctr = await all('contracts', 'num,client_code,name,vehicle_key,start_at,end_at', q => q.lte('start_at', new Date(now + tol).toISOString())
    .or('end_at.is.null,end_at.gte.' + new Date(now - tol - 30 * MIN).toISOString()));
}
function liveRows() {
  const ok = inAgency(), have = {}, now = Date.now();
  LIVE.rows.forEach(r => { have[r.vehicle_key] = 1; });
  // véhicule vu en direct par Geotab mais pas encore par le collecteur : affiché quand même
  const extra = Object.values(LIVE.pos).filter(g => !have[g.key] && ok(g.key)).map(g => ({ vehicle_key: g.key, plate: g.plate, model: (S.veh[g.key] || {}).model || '' }));
  return LIVE.rows.concat(extra).map(r => {
    const g = LIVE.pos[r.vehicle_key], c = contractAt(r.vehicle_key, now);
    const who = { driver_name: c ? c.name : 'Hors contrat', contract_num: c ? c.num : '', driver_code: c ? c.client_code : HORS, shift: c ? shiftOf(c.start_at, S.P) : '', ctr_start: c ? c.start_at : null };
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

// ---------- Rendu ----------
function kpisHtml(rows) {
  const n = s => rows.filter(r => r.state === s).length, off = n('Boîtier hors ligne') + n('Pas de réponse Geotab'), ctr = rows.filter(r => r.contract_num).length;
  return cards([['En route', n('En route'), 'ok'], ['Arrêtés contact mis', n('Arrêté, contact mis'), n('Arrêté, contact mis') ? 'warn' : ''], ['Garés', n('Garé')],
    ['Boîtiers hors ligne', off, off ? 'crit' : ''], ['Sous contrat', ctr + ' / ' + rows.length], ['Alertes (30 min)', LIVE.alerts.filter(a => inAgency()(a.vehicle_key)).length, LIVE.alerts.length ? 'high' : '']]);
}
function vcardsHtml(rows) {
  if (!rows.length) return '<div class="empty">Aucun véhicule actif</div>';
  return rows.map(r => `<button type="button" class="vcard st-${ST_CLS(r.state)}${LIVE.fast[r.vehicle_key] ? ' fast' : ''}${LIVE.sel === r.vehicle_key ? ' on' : ''}" data-vk="${esc(r.vehicle_key)}">
    <span class="vc-l1">${plate(r.plate)}<span class="vc-model">${esc(r.model || '')}</span><span class="vc-spd">${r.state === 'En route' ? f0(r.speed) + '<small> km/h</small>' : ''}</span></span>
    <span class="vc-l2"><span class="sdot"></span>${esc(r.state || 'État inconnu')}${r.since_min != null ? ' · depuis ' + fH(r.since_min / 60) : ''}</span>
    <span class="vc-l3">${r.contract_num ? `<b>${esc(r.driver_name)}</b> ${shiftBadge(r.shift)}` : '<span class="nm">Hors contrat</span>'}</span>
    <span class="vc-l4">${r.live ? 'Position Geotab ' + esc(fmtHMS(r.last_pos_at).slice(6)) + ' · <span class="ago" data-t="' + esc(r.last_pos_at || '') + '">' + ago(r.last_pos_at) + '</span>'
      : r.last_pos_at ? 'Position du collecteur ' + esc(fmtDT(r.last_pos_at)) : 'Aucune position'}</span></button>`).join('');
}
function liveAlertsHtml() {
  const list = LIVE.alerts.filter(a => inAgency()(a.vehicle_key));
  const body = list.length ? `<div id="tlal" class="alist">${list.map(a => `<button type="button" class="acard ${GRAV_CLS[a.severity] || ''}" data-la="${esc(a.id)}">
      <span class="a-time">${esc(fmtHMS(a.at))}</span>
      <span class="a-main">${badge(a.severity, GRAV_CLS[a.severity])} <b>${esc(a.type)}</b> ${plate(a.plate)}</span>
      <span class="a-drv">${a.contract_num ? esc(a.driver_name) + ' ' + shiftBadge(a.shift) + ' <span class="small">contrat ' + esc(a.contract_num) + '</span>' : '<span class="nm">Hors contrat</span>'}</span>
      <span class="a-det">${esc(a.detail)}</span><span class="a-go">Voir la fiche ›</span></button>`).join('')}</div>`
    : '<div class="empty">Aucune infraction ces 30 dernières minutes</div>';
  return `<div class="sechead"><h2>Alertes en direct</h2><span class="small">30 dernières minutes, à l'instant où Geotab les signale. Cliquer sur une alerte pour sa fiche détaillée (vitesse, limite de la route, trajet sur la carte).</span></div>` + body;
}
function vehTableHtml(rows) {
  return table('tlive', [
    ['Plaque', r => `<a class="fl" href="#/vehicule?k=${encodeURIComponent(r.vehicle_key)}">${plate(r.plate, S.veh[r.vehicle_key] && S.veh[r.vehicle_key].other_plates)}</a>`, r => r.plate],
    ['Modèle', r => esc(r.model)], ['État', r => badge(r.state, (STATE_CLS[r.state] || '') + ' dot'), r => LIVE_ORDER[r.state] ?? 9],
    ['Vitesse', r => r.speed ? f0(r.speed) + ' km/h' : '', r => r.speed, 'n'], ['Depuis', r => r.since_min != null ? fH(r.since_min / 60) : '', r => r.since_min, 'n'],
    ['Dernière position', r => r.live ? fmtHMS(r.last_pos_at) : fmtDT(r.last_pos_at), r => r.last_pos_at], ['Chauffeur sous contrat (maintenant)', r => r.contract_num ? dlink(r.driver_code, r.driver_name) : '<span class="nm">Hors contrat</span>', r => r.driver_name],
    ['Shift', r => r.contract_num ? shiftBadge(r.shift) : '', r => r.shift || 'z'], ['Contrat', r => esc(r.contract_num || '')],
    ['Km aujourd\'hui', r => f1(r.km_today), r => r.km_today, 'n'], ['Conduite', r => r.drive_min_today == null ? '' : fH(r.drive_min_today / 60), r => r.drive_min_today, 'n'],
    ['Ralenti', r => r.idle_min_today == null ? '' : fH(r.idle_min_today / 60), r => r.idle_min_today, 'n'], ['Carburant (L)', r => r.fuel_l_today === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l_today), r => r.fuel_l_today, 'n'],
    ['Alertes du jour', r => r.alerts_today ? `<a href="#/alertes?plaque=${encodeURIComponent(r.plate)}&jour=${today()}">${r.alerts_today}</a>` : '0', r => r.alerts_today, 'n'],
    ['Carte', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">Voir</a>` : '']], rows, { empty: 'Aucun véhicule actif' });
}
/** Chauffeurs en ce moment : compteurs Geotab entre le début du contrat et maintenant (relais), sinon totaux du collecteur */
function liveDriversHtml(rows) {
  const P = S.P, list = rows.filter(r => r.contract_num), nmv = v => v === null || v === undefined ? `<span class="nm">${NM}</span>` : v;
  const head = `<div class="sechead"><h2>Chauffeurs en ce moment</h2><span class="small">Depuis le début de leur contrat, compteurs du véhicule lus dans Geotab toutes les ${DRV_SEC} s${LIVE.drvAt ? ' (dernière lecture ' + esc(fmtHMS(LIVE.drvAt).slice(6)) + ')' : ''} : le trajet en cours est compté.</span></div>`;
  if (!list.length) return head + '<div class="empty">Aucun chauffeur sous contrat en ce moment</div>';
  if (LIVE.drvErr && LIVE.drvFallback) return head + msg('Lecture Geotab indisponible (' + esc(LIVE.drvErr) + ') : totaux du collecteur (trajets terminés).', 'warn') + LIVE.drvFallback;
  const items = list.map(r => {
    const d = LIVE.drv[r.vehicle_key]; let pts = 0, nEv = 0;
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
function liveStatusTxt() {
  if (LIVE.at) return `<span class="livedot" aria-hidden="true"></span>Temps réel Geotab : actualisé toutes les ${LIVE_SEC} s, dernière lecture ${fmtHMS(LIVE.at).slice(6)}.`;
  if (LIVE.err) return 'Temps réel Geotab indisponible (' + esc(LIVE.err) + ') : positions du collecteur, toutes les ' + (S.P.liveMin || 5) + ' min.';
  return 'Connexion au temps réel Geotab…';
}

/** refresh = données du collecteur relues sans redessiner la carte */
async function pageDirect(refresh) {
  const ok = inAgency();
  [LIVE.rows] = await Promise.all([all('live_status', '*', null, ['plate']), loadLiveContracts()]);
  LIVE.rows = LIVE.rows.filter(r => ok(r.vehicle_key));
  if (refresh) { if ($('#tlive') && MAP) applyDirect(); return; }   // relecture : jamais de page redessinée (l'utilisateur a pu changer de page)
  const rows = liveRows(), last = LIVE.rows.reduce((m, r) => Math.max(m, new Date(r.updated_at || 0).getTime()), 0);
  LIVE.drv = {}; LIVE.drvAt = 0; LIVE.drvErr = ''; LIVE.drvFallback = ''; LIVE.trails = {};
  $('#page').innerHTML = `
    <div class="head"><h1>En direct</h1><div class="sub"><span id="livest">${liveStatusTxt()}</span></div>
      ${canEdit() ? '<button id="syncnow" class="ghost">Mettre à jour les totaux du jour</button>' : ''}</div>
    <div id="livecards">${kpisHtml(rows)}</div>
    <div class="livegrid">
      <section class="mapbox"><div id="map"></div>
        <div class="maplegend"><span class="lg st-ok">En route</span><span class="lg st-warn">Arrêté, contact mis</span><span class="lg st-mute">Garé</span><span class="lg st-crit">Hors ligne / au-dessus du seuil</span>
          <span class="small">Flèche = sens de la marche · trait = trajet depuis l'ouverture de la page</span></div></section>
      <aside class="vlist" id="vlist" aria-label="Véhicules">${vcardsHtml(rows)}</aside>
    </div>
    <section id="livealerts">${liveAlertsHtml()}</section>
    <section id="livedrv">${liveDriversHtml(rows)}</section>
    <section><div class="sechead"><h2>Totaux du jour par véhicule</h2><span class="small">${last ? 'Trajets terminés (contact coupé), calculés par le collecteur, mis à jour le ' + fmtDTY(last) + '.' : 'Le collecteur n\'a pas encore tourné.'}</span></div>
      <div id="livetab">${vehTableHtml(rows)}</div></section>`;
  LIVE.markers = {}; LIVE.fitted = false; drawMap(rows);
  liveDrvTick(ROUTING);
  const b = $('#syncnow');
  if (b) b.onclick = async () => { b.disabled = true; try { await job('sync_now'); b.textContent = 'Demande envoyée (5 min max)'; } catch (e) { alert(e.message); b.disabled = false; } };
}
function applyDirect() {
  const rows = liveRows(), set = (sel, html) => { const el = $(sel); if (el) el.innerHTML = html; };
  set('#livecards', kpisHtml(rows)); set('#vlist', vcardsHtml(rows)); set('#livetab', vehTableHtml(rows)); set('#livealerts', liveAlertsHtml()); set('#livedrv', liveDriversHtml(rows));
  const st = $('#livest'); if (st) st.innerHTML = liveStatusTxt();
  if (MAP) rows.forEach(placeMarker);
}
/** Lecture Geotab en direct par le relais ; arrêt du relais (non installé, erreur) : nouvel essai dans 1 min */
async function liveTick(my) {
  if (document.hidden || my !== ROUTING || Date.now() < (LIVE.retryAt || 0)) return;
  try {
    const j = await relay();
    if (my !== ROUTING) return;
    const pos = {}; (j.vehicles || []).forEach(v => { pos[v.key] = v; });
    LIVE.pos = pos; LIVE.at = Date.now(); LIVE.err = ''; LIVE.retryAt = 0;
    processLive(j);
  } catch (e) { LIVE.at = 0; LIVE.pos = {}; LIVE.err = String(e.message || e).slice(0, 120); LIVE.retryAt = Date.now() + 60000; }
  if (my !== ROUTING) return;
  applyDirect();
  // première lecture Geotab : la carte est recadrée sur les positions réelles (la carte s'ouvre sur celles du collecteur)
  if (LIVE.at && MAP && !LIVE.fitted) { const ll = liveRows().filter(r => r.lat != null && r.lon != null && isFinite(+r.lat) && isFinite(+r.lon)).map(r => [+r.lat, +r.lon]); LIVE.fitted = true;
    if (ll.length) MAP.fitBounds(L.latLngBounds(ll).pad(0.2), { maxZoom: 13, animate: false }); }
}
/** Chauffeurs en ce moment : compteurs relus toutes les DRV_SEC secondes */
async function liveDrvTick(my) {
  if (document.hidden || my !== ROUTING || LIVE.drvBusy) return;
  const rows = liveRows().filter(r => r.contract_num && r.ctr_start);
  if (!rows.length) return;
  LIVE.drvBusy = true;
  try {
    const j = await relay({ mode: 'drivers', c: rows.map(r => r.vehicle_key + '@' + new Date(r.ctr_start).toISOString()).join(',') });
    if (my !== ROUTING) return;
    LIVE.drv = j.drivers || {}; LIVE.drvAt = Date.now(); LIVE.drvGeoAt = j.at; LIVE.drvErr = '';
  } catch (e) {
    LIVE.drvErr = String(e.message || e).slice(0, 120);
    try { LIVE.drvFallback = await liveDrivers(rows) || ''; } catch (e2) { LIVE.drvFallback = ''; }
  } finally { LIVE.drvBusy = false; }
  if (my === ROUTING) { const el = $('#livedrv'); if (el) el.innerHTML = liveDriversHtml(liveRows()); }
}

// ---------- Carte ----------
// silhouette de fourgon (Staria) vue de côté, blanche, au centre du marqueur
const VAN_SVG = '<svg class="vmk-van" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 15.5V9.2C2 7.4 3.4 6 5.2 6h9.6c1 0 1.9.5 2.5 1.2l3.2 4c.3.4.5.9.5 1.4v2.9c0 .8-.6 1.5-1.4 1.5h-.9a2.7 2.7 0 0 1-5.3 0H8.8a2.7 2.7 0 0 1-5.3 0h-.1c-.8 0-1.4-.7-1.4-1.5ZM14 8v3.6h5.1L16.4 8.4A1 1 0 0 0 15.6 8H14Zm-4.5 0v3.6h3V8h-3ZM4 8.9v2.7h4V8H4.9c-.5 0-.9.4-.9.9Z"/><circle cx="6.2" cy="17.2" r="1.5"/><circle cx="16.4" cy="17.2" r="1.5"/></svg>';
function vIcon(r) {
  const st = LIVE.fast[r.vehicle_key] || LIVE.over[r.vehicle_key] ? 'crit' : ST_CLS(r.state), rot = r.state === 'En route' && r.bearing != null && isFinite(+r.bearing) ? +r.bearing : null;
  const html = `<span class="vmk-pin st-${st}${r.state === 'En route' ? ' moving' : ''}">${rot != null ? `<span class="vmk-dir" style="transform:rotate(${Math.round(rot)}deg)"><i></i></span>` : ''}${VAN_SVG}</span>`
    + `<span class="vmk-l">${esc(r.plate || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}</span>`;
  return { html, icon: () => L.divIcon({ className: 'vmk', iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -20], tooltipAnchor: [0, -22], html }) };
}
/** Info-bulle au survol : chauffeur sous contrat, plaque, état, vitesse */
function tipHtml(r) {
  return `<b>${r.contract_num ? esc(r.driver_name) : 'Hors contrat'}</b>${r.contract_num && r.shift ? ' · shift ' + esc(r.shift.toLowerCase()) : ''}<br>${esc(r.plate || '')} · ${esc(r.state || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}`;
}
function popupHtml(r) {
  return `<div class="vpop">${plate(r.plate)} <span class="small">${esc(r.model || '')}</span><div><b>${esc(r.state || '')}</b>${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${r.since_min != null ? ' · depuis ' + fH(r.since_min / 60) : ''}</div>
    <div>${r.contract_num ? esc(r.driver_name) + ' · ' + esc(r.shift ? 'shift ' + r.shift.toLowerCase() : '') + ' · contrat ' + esc(r.contract_num) : 'Hors contrat'}</div>
    <div class="small">Position ${r.live ? 'Geotab ' + esc(fmtHMS(r.last_pos_at)) : 'du collecteur ' + esc(fmtDT(r.last_pos_at))}</div>
    <div><a href="#/vehicule?k=${encodeURIComponent(r.vehicle_key)}">Fiche du véhicule</a>${r.contract_num && r.driver_code ? ` · <a href="#/chauffeur?c=${encodeURIComponent(r.driver_code)}">Fiche du chauffeur</a>` : ''}</div></div>`;
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
function osmLayer() {
  // OpenStreetMap refuse les tuiles demandées sans l'adresse du site (Referer) : on l'envoie (origine seule) pour la carte
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' });
}
function drawMap(rows) {
  if (!window.L) return;
  if (MAP) { MAP.remove(); MAP = null; }
  const pts = rows.filter(r => r.lat != null && r.lon != null);
  MAP = L.map('map', { scrollWheelZoom: false, zoomControl: true });
  osmLayer().addTo(MAP);
  pts.forEach(placeMarker);
  if (pts.length) MAP.fitBounds(L.latLngBounds(pts.map(r => [r.lat, r.lon])).pad(0.2), { maxZoom: 13 }); else MAP.setView([31.63, -8.0], 6);
}
// Clic sur un véhicule de la liste : la carte se centre sur lui ; clic sur une alerte : sa fiche
document.addEventListener('click', e => {
  const vc = e.target.closest('#vlist .vcard');
  if (vc && MAP) { const k = vc.dataset.vk, m = LIVE.markers[k]; LIVE.sel = k; document.querySelectorAll('#vlist .vcard').forEach(el => el.classList.toggle('on', el.dataset.vk === k));
    if (m) { MAP.flyTo(m.getLatLng(), Math.max(MAP.getZoom(), 15), { duration: .8 }); m.openPopup(); } return; }
  const ac = e.target.closest('[data-la]');
  if (ac) { const a = LIVE.alerts.find(x => x.id === ac.dataset.la); if (a) openAlertDetail(a); return; }
  const ad = e.target.closest('[data-ad]');
  if (ad && S.alIdx && S.alIdx[ad.dataset.ad]) openAlertDetail(alertFromDb(S.alIdx[ad.dataset.ad]));
});

// ---------- Fiche d'une alerte ----------
/** Alerte de la base (journal du collecteur) -> même forme que les alertes en direct */
function alertFromDb(a) {
  const p = String(a.day).slice(0, 10).split('-').map(Number), h = String(a.time || '00:00').split(':').map(Number), t = localToDate(p[0], p[1], p[2], h[0] || 0, h[1] || 0);
  return { id: 'DB|' + a.id, vehicle_key: a.vehicle_key, plate: a.plate, at: t.toISOString(), end: null, severity: a.severity, type: a.type, cat: /vitesse/i.test(a.type || '') ? 'Vitesse' : '',
    detail: String(a.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=\S+/g, '').trim(), driver_name: a.driver_name || '', driver_code: a.driver_code || '', contract_num: a.contract_num || '', shift: alertShift(a), approx: true };
}
/** Dernière limite de la route connue à l'instant t (Geotab : -1 ou 0 = limite inconnue) */
function limitAt(road, t) { let v = null; for (const p of road || []) { if (p[0] > t) break; v = p[1] > 0 ? p[1] : null; } return v; }
async function openAlertDetail(a) {
  let d = $('#adlg');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'adlg'; d.className = 'adlg'; document.body.appendChild(d);
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('.adclose')) d.close(); });
    d.addEventListener('close', () => { if (d._map) { d._map.remove(); d._map = null; } });
  }
  const t0 = new Date(a.at).getTime(), t1 = a.end ? Math.max(t0, new Date(a.end).getTime()) : t0, tok = d._tok = (d._tok || 0) + 1;
  d.innerHTML = `<div class="adhead"><div>${badge(a.severity, GRAV_CLS[a.severity])} <b class="adtype">${esc(a.type)}</b> ${plate(a.plate)}
      <div class="sub">${esc(fmtHMS(a.at))}${a.approx ? ' (heure de l\'alerte, à la minute)' : ''} · ${a.contract_num || (a.driver_code && a.driver_code !== HORS) ? esc(a.driver_name) + ' ' + shiftBadge(a.shift) + (a.contract_num ? ' · contrat ' + esc(a.contract_num) : '') : '<span class="nm">Hors contrat</span>'}</div></div>
    <button type="button" class="ghost adclose" aria-label="Fermer">Fermer</button></div>
    <div id="adbody"><div class="loading">Lecture des données Geotab autour de l'instant…</div></div>`;
  if (!d.open) d.showModal();
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
  let pk = null; before.concat(inEv, after).forEach(p => { if (!pk || p[1] > pk[1]) pk = p; });
  const lim = pk ? limitAt(road, pk[0]) : null, over = pk && lim ? pk[1] - lim : null;
  // temps au-dessus de la limite de la route pendant l'événement : chaque relevé vaut jusqu'au suivant, compté seulement dans [t0, t1]
  let above = 0, known = false;
  for (let i = 0; i + 1 < spd.length; i++) { const p = spd[i], q = spd[i + 1], x0 = Math.max(p[0], t0), x1 = Math.min(q[0], t1); if (x1 <= x0) continue;
    const l = limitAt(road, p[0]); if (l) { known = true; if (p[1] > l) above += x1 - x0; } }
  if (!known && lim) known = true;   // événement instantané (freinage, virage) : limite connue, 0 s au-dessus
  const near = t => { let b = null; gps.forEach(p => { if (!b || Math.abs(p[0] - t) < Math.abs(b[0] - t)) b = p; }); return b; };
  const at = pk ? near(pk[0]) : near(t0);
  const c = [['Vitesse max ' + (src === 'capteur' ? '(capteur du véhicule)' : '(GPS)'), pk ? `<b>${f0(pk[1])} km/h</b> à ${esc(fmtHMS(pk[0]).slice(6))}` : `<span class="nm">${NM}</span>`],
    ['Limite de la route à cet instant', lim ? f0(lim) + ' km/h' : '<span class="nm">non fournie par Geotab</span>'],
    ['Dépassement', over != null ? (over > 0 ? `<b class="red">+${f0(over)} km/h</b>` : 'aucun (' + f0(over) + ' km/h)') : `<span class="nm">${NM}</span>`],
    ['Au-dessus de la limite pendant l\'événement', known ? Math.round(above / 1000) + ' s' : `<span class="nm">${NM}</span>`],
    ['Durée de l\'événement (Geotab)', ev && ev.dur_min != null ? Math.round(ev.dur_min * 60) + ' s' : t1 > t0 ? Math.round((t1 - t0) / 1000) + ' s' : '—'],
    ['Distance pendant l\'événement', ev && ev.km != null ? f1(ev.km) + ' km' : '—'],
    ['Lieu', at ? `<a target="_blank" rel="noopener" href="${osmUrl(at[2], at[3])}">${(+at[2]).toFixed(5)}, ${(+at[3]).toFixed(5)}</a>` : `<span class="nm">${NM}</span>`]];
  $('#adbody').innerHTML = `<div class="adgrid">${c.map(x => `<div class="adkv"><span>${x[0]}</span><div>${x[1]}</div></div>`).join('')}</div>
    <h3>Vitesse autour de l'instant</h3>${speedChart(spd, road, j, t0, t1, pk)}
    <h3>Trajet sur la carte</h3><div id="admap"></div>
    <p class="small">Données lues dans Geotab pour ${esc(a.plate)} du ${esc(fmtHMS(j.from))} au ${esc(fmtHMS(j.to).slice(6))} : vitesse du ${src === 'capteur' ? 'capteur du véhicule (même source que les trajets)' : 'GPS (capteur du véhicule non transmis)'}, limite de la route fournie par Geotab, positions GPS. Rien n'est estimé.</p>
    <div class="adlinks"><a href="#/vehicule?k=${encodeURIComponent(a.vehicle_key)}">Fiche du véhicule</a>${a.driver_code && a.driver_code !== HORS ? ` · <a href="#/chauffeur?c=${encodeURIComponent(a.driver_code)}">Fiche du chauffeur</a>` : ''} · <a href="#/alertes?plaque=${encodeURIComponent(a.plate || '')}&jour=${localDay(t0)}">Alertes du jour</a></div>`;
  d.querySelectorAll('.adlinks a').forEach(x => x.addEventListener('click', () => d.close()));
  if (window.L && gps.length) {
    const m = d._map = L.map('admap', { scrollWheelZoom: false }); osmLayer().addTo(m);
    const all = gps.map(p => [p[2], p[3]]), evp = gps.filter(p => p[0] >= t0 - 30000 && p[0] <= t1 + 30000).map(p => [p[2], p[3]]);
    L.polyline(all, { className: 'adpath', weight: 4, opacity: .8 }).addTo(m);
    if (evp.length > 1) L.polyline(evp, { className: 'adpath-ev', weight: 6, opacity: .95 }).addTo(m);
    if (at) L.circleMarker([at[2], at[3]], { radius: 8, className: 'adpk', weight: 2, fillOpacity: 1 }).bindTooltip(pk ? f0(pk[1]) + ' km/h' + (lim ? ' (limite ' + lim + ')' : '') : esc(a.type), { permanent: true, direction: 'top' }).addTo(m);
    m.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 16 }); setTimeout(() => m.invalidateSize(), 50);
  } else { const el = $('#admap'); if (el) el.outerHTML = '<div class="empty">Aucune position GPS transmise par Geotab sur ce moment</div>'; }
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
