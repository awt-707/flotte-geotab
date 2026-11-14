// Suivi des pauses chauffeurs et des courses privées (demande d'Ahmed, 14/11/2026) : page #/suivi et alertes sur tout Ludy.
// Le gestionnaire déclenche la pause d'un véhicule (chauffeur du contrat en cours) : compte à rebours du temps de pause qui reste
// au chauffeur dans son shift (2 h par défaut), rappel toutes les 30 min, grande alerte rouge à la fin (nom, téléphone, plaque,
// WhatsApp « fin de pause »), alerte si le véhicule bouge pendant la pause (GPS Geotab du relais en direct).
// Course privée réservée : suivi démarré à la prise en charge, alerte à l'arrivée (véhicule près de la destination), suivi levé
// = course terminée, détail partagé sur WhatsApp. Calculs dans suivi_calc.js. Alertes : tant qu'un onglet Ludy est ouvert.
const SV = { snooze: {}, pauses: [], hist: [], tracks: [], mis: {}, pos: {}, posAt: 0, loadAt: 0, ptsAt: {}, shown: {}, queue: [], cur: null, tick: 0, err: '', off: false, busy: false };
const SV_LOAD_MS = 20000, SV_POS_MS = 15000, SV_PTS_MS = 60000;
const SV_PREF = 'svShown';

function svCan() { return !!(S.profile && ['admin', 'manager'].includes(S.profile.role)) && canSee('suivi'); }
function svWa(phone, text) {
  const n = typeof manifWa === 'function' ? manifWa(phone) : '';
  const u = 'https://wa.me/' + n + '?text=' + encodeURIComponent(text);
  if (!openOut(u)) window.open(u, '_blank', 'noopener');
}
function svMark(k) { SV.shown[k] = Date.now(); try { const o = JSON.parse(localStorage.getItem(SV_PREF) || '{}'); o[k] = Date.now(); const cut = Date.now() - 2 * 86400000; Object.keys(o).forEach(x => { if (o[x] < cut) delete o[x]; }); localStorage.setItem(SV_PREF, JSON.stringify(o)); } catch (e) { } }
function svSeen(k) { if (SV.shown[k]) return true; try { const o = JSON.parse(localStorage.getItem(SV_PREF) || '{}'); if (o[k]) { SV.shown[k] = o[k]; return true; } } catch (e) { } return false; }

// ---------- données ----------
async function svLoad(force) {
  if (!force && Date.now() - SV.loadAt < SV_LOAD_MS) return;
  SV.loadAt = Date.now();
  try {
    const since = addDays(today(), -1);
    const [ps, ts] = await Promise.all([
      all('driver_pauses', '*', q => q.or('ended_at.is.null,shift_day.gte.' + since)),
      all('mission_tracks', 'id,mission_id,agency_id,vehicle_key,plate,driver_name,driver_phone,started_at,dest_label,dest_lat,dest_lon,arrived_at,ended_at,end_reason,points', q => q.is('ended_at', null))]);
    SV.pauses = ps; SV.tracks = ts; SV.err = ''; SV.off = false;
    const ids = [...new Set(ts.map(t => t.mission_id))];
    if (ids.length) { const { data } = await sb.from('missions').select('id,number,status,client_name,client_company,client_phone,driver_name,vehicle_key,start_at,end_at,kind,data').in('id', ids); SV.mis = {}; (data || []).forEach(m => { SV.mis[m.id] = m; }); }
  } catch (e) { SV.err = String(e.message || e); if (/driver_pauses|mission_tracks|does not exist|schema cache/i.test(SV.err)) SV.off = true; }
}
const svOpen = () => SV.pauses.filter(p => !p.ended_at && inAgency()(p.vehicle_key));
const svOpenTracks = () => SV.tracks.filter(t => !t.ended_at && inAgency()(t.vehicle_key));
/** Positions Geotab : celles de la page En direct si elles sont fraîches, sinon le relais (toutes les 15 s, seulement s'il y a un suivi en cours) */
async function svPositions() {
  if (typeof LIVE !== 'undefined' && LIVE.at && Date.now() - LIVE.at < 12000 && LIVE.pos && Object.keys(LIVE.pos).length) { SV.pos = LIVE.pos; SV.posAt = LIVE.at; return; }
  if (Date.now() - SV.posAt < SV_POS_MS || typeof relay !== 'function') return;
  SV.posAt = Date.now();
  try { const j = await relay(); const pos = {}; (j.vehicles || []).forEach(v => { pos[v.key] = v; }); SV.pos = pos; } catch (e) { SV.posErr = String(e.message || e); }
}

// ---------- moteur (toutes les 5 s, sur toutes les pages) ----------
function svStart() {
  if (SV.tick) return;
  SV.tick = setInterval(() => { svEngine().catch(() => { }); }, 5000);
  setInterval(svClockTick, 1000);
  svEngine().catch(() => { });
}
function svReset() { SV.snooze = {}; SV.pauses = []; SV.tracks = []; SV.mis = {}; SV.pos = {}; SV.loadAt = 0; SV.posAt = 0; SV.queue = []; SV.cur = null; SV.shown = {}; const o = $('#svov'); if (o) o.remove(); svBar(); }
async function svEngine() {
  if (!S.session || !S.profile || !svCan() || SV.busy) { svBar(); return; }
  SV.busy = true;
  try {
    await svLoad();
    if (SV.off) return;
    const ps = svOpen(), ts = svOpenTracks(), now = Date.now();
    // alerte affichée d'une pause ou d'un suivi terminé ailleurs (autre gestionnaire, autre onglet) : fermée
    if (SV.cur && ((SV.cur.p && !ps.some(x => x.id === SV.cur.p.id)) || (SV.cur.t && !ts.some(x => x.id === SV.cur.t.id)))) svClose(false);
    if (ps.length || ts.length) await svPositions();
    for (const p of ps) {
      const st = svPauseState(p, now), pos = SV.pos[p.vehicle_key];
      svReminders(p, now, S.P).forEach(m => { const k = 'R|' + p.id + '|' + m; if (!svSeen(k)) { svMark(k); svToast(p, m); } });
      if (st.over && !svSeen('END|' + p.id) && !(SV.snooze['END|' + p.id] > now)) svPush({ k: 'END|' + p.id, kind: 'end', p });
      // place du véhicule inconnue au début de la pause (relais indisponible) : première position à l'arrêt dans les 10 min
      if (p.start_lat == null && pos && isFinite(+pos.lat) && pos.state !== 'En route' && now - new Date(p.started_at).getTime() < 10 * 60000) {
        p.start_lat = +pos.lat; p.start_lon = +pos.lon;
        sb.from('driver_pauses').update({ start_lat: p.start_lat, start_lon: p.start_lon }).eq('id', p.id).then(() => { }, () => { });
      }
      const mv = svMoved(p, pos, S.P);
      if (mv) {
        if (!p.moved_at) { p.moved_at = new Date().toISOString(); p.moved_m = mv.m; p.moved_note = mv.why;
          sb.from('driver_pauses').update({ moved_at: p.moved_at, moved_m: mv.m, moved_note: mv.why }).eq('id', p.id).is('moved_at', null).then(() => { }, () => { }); }
        // alerte très importante : redemandée toutes les 2 min tant que le véhicule n'est pas revenu à sa place (sauf « déplacement autorisé »)
        const k = 'MOV|' + p.id;
        if (!svSeen(k) && !(SV.snooze[k] > now)) svPush({ k, kind: 'move', p, why: mv.why });
        else if (SV.cur && SV.cur.k === k) SV.cur.why = mv.why;
      }
    }
    for (const t of ts) {
      const pos = SV.pos[t.vehicle_key];
      if (pos && now - (SV.ptsAt[t.id] || 0) >= SV_PTS_MS) {
        const pts = svAddPoint(t.points, pos, new Date().toISOString());
        if (pts.length !== (t.points || []).length) { t.points = pts; SV.ptsAt[t.id] = now; sb.from('mission_tracks').update({ points: pts }).eq('id', t.id).then(() => { }, () => { }); }
        else SV.ptsAt[t.id] = now;
      }
      const d = svArrived(t, pos, now, S.P);
      if (d != null) {
        t.arrived_at = new Date().toISOString();
        sb.from('mission_tracks').update({ arrived_at: t.arrived_at }).eq('id', t.id).is('arrived_at', null).then(() => { }, () => { });
      }
      if (t.arrived_at && !svSeen('ARR|' + t.id)) svPush({ k: 'ARR|' + t.id, kind: 'arrive', t, d });
    }
  } finally { SV.busy = false; svBar(); }
}

// ---------- alertes : bandeau de rappel, grande alerte plein écran (une à la fois), barre des suivis en cours ----------
function svBeep() {
  try { const C = window.AudioContext || window.webkitAudioContext; if (!C) return; const a = SV.ac || (SV.ac = new C()), o = a.createOscillator(), g = a.createGain();
    o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.35); } catch (e) { }
}
function svToast(p, m) {
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const left = svPauseEndAt(p) - Date.now(), t = document.createElement('div'); t.className = 'toast warn svtoast';
  t.innerHTML = `<button class="x" aria-label="Fermer">×</button><b>⏸ Pause : ${m} min écoulées</b> ${plate(p.plate)}<div>${esc(p.driver_name || '')}</div>
    <div class="small">Reste ${esc(svDur(left))} (fin à ${esc(fmtDT(new Date(svPauseEndAt(p))).slice(6))})</div><a href="#/suivi">Voir les pauses</a>`;
  t.querySelector('.x').onclick = () => t.remove();
  box.prepend(t); setTimeout(() => t.remove(), 60000); svBeep();
}
function svPush(a) { if (SV.queue.some(x => x.k === a.k) || (SV.cur && SV.cur.k === a.k)) return; SV.queue.push(a); svNext(); }
function svNext() {
  if (SV.cur || !SV.queue.length) return;
  SV.cur = SV.queue.shift(); svShow(SV.cur);
}
function svClose(mark) { if (SV.cur && mark !== false) svMark(SV.cur.k); SV.cur = null; const o = $('#svov'); if (o) o.remove(); setTimeout(svNext, 300); }
function svShow(a) {
  const o = document.createElement('div'); o.id = 'svov'; o.className = 'svov ' + (a.kind === 'arrive' ? 'ok' : 'bad'); o.setAttribute('role', 'alertdialog');
  if (a.kind === 'end' || a.kind === 'move') {
    const p = a.p, late = Date.now() - svPauseEndAt(p);
    o.innerHTML = `<div class="svbox"><div class="svtag">${a.kind === 'end' ? 'FIN DE PAUSE' : 'VÉHICULE EN PAUSE EN MOUVEMENT'}</div>
      <div class="svname">${esc(p.driver_name || 'Chauffeur inconnu')}</div>
      <div class="svplate">${esc(p.plate || p.vehicle_key)}</div>
      <div class="svphone">${p.driver_phone ? '📞 ' + esc(p.driver_phone) : 'téléphone non renseigné'}</div>
      <div class="svinfo">${a.kind === 'end' ? 'Pause commencée à ' + esc(fmtDT(p.started_at).slice(6)) + ' · ' + esc(String(p.planned_min)) + ' min' + (late > 60000 ? ' · <b>dépassée de <span class="svlate" data-t="' + svPauseEndAt(p) + '">' + esc(svDur(late)) + '</span></b>' : '')
        : 'Le véhicule ' + esc(a.why) + ' (GPS Geotab), alors que le chauffeur est en pause depuis ' + esc(svDur(Date.now() - new Date(p.started_at).getTime())) + '.'}</div>
      <div class="svact"><button class="svwa" id="svwa">WhatsApp ${a.kind === 'end' ? '« fin de pause »' : '« alerte pause »'} au chauffeur</button>
        ${!p.ended_at ? `<button class="svend" id="svend">${a.kind === 'end' ? 'Pause terminée (le chauffeur reprend)' : 'Terminer la pause'}</button>` : ''}
        ${a.kind === 'end' && svLeftMin(SV.pauses, svDrvKey(p), p.shift_day, p.shift, Date.now(), S.P, p.id) - (+p.planned_min) >= 5 ? '<button class="ghost" id="svplus">+5 min</button>' : ''}
        <button class="ghost" id="svlater">Rappeler dans 2 min</button>${a.kind === 'move' ? '<button class="ghost" id="svok">Déplacement autorisé</button>' : ''}</div>
      ${a.kind === 'move' ? '<div class="svinfo small">Tant que le véhicule n\'est pas revenu à sa place, l\'alerte revient toutes les 2 min. Le collecteur envoie aussi l\'alerte par e-mail aux destinataires des alertes.</div>' : ''}</div>`;
    document.body.appendChild(o);
    $('#svwa').onclick = () => svWa(p.driver_phone, a.kind === 'end' ? svWaPauseEnd(p, Date.now()) : svWaMoved(p, a.why));
    if ($('#svend')) $('#svend').onclick = async () => { await svEndPause(p, a.kind === 'end' ? 'Fin du compte à rebours' : 'Véhicule en mouvement'); svClose(); };
    if ($('#svplus')) $('#svplus').onclick = async () => { await svExtend(p, 5); svClose(false); delete SV.shown[a.k]; };
    $('#svlater').onclick = () => { SV.snooze[a.k] = Date.now() + 120000; svClose(false); };   // fin de pause ou véhicule qui roule encore : redemandé dans 2 min
    if ($('#svok')) $('#svok').onclick = async () => { if (await ask('Déplacement autorisé : ne plus alerter pour cette pause ?')) svClose(); };
  } else {
    const t = a.t, m = SV.mis[t.mission_id] || {};
    o.innerHTML = `<div class="svbox"><div class="svtag">COURSE ARRIVÉE À DESTINATION</div>
      <div class="svname">${esc(m.client_company || m.client_name || 'Course privée')}${m.number ? ' · ' + esc(m.number) : ''}</div>
      <div class="svplate">${esc(t.plate || t.vehicle_key)}</div>
      <div class="svphone">${esc(t.driver_name || m.driver_name || '')}${t.driver_phone ? ' · 📞 ' + esc(t.driver_phone) : ''}</div>
      <div class="svinfo">Destination : ${esc(t.dest_label || '—')}${a.d != null ? ' · véhicule à ' + esc(String(a.d)) + ' m' : ''} · prise en charge à ${esc(fmtDT(t.started_at).slice(6))}</div>
      <div class="svact"><button class="svend" id="svdone">Course terminée : lever le suivi</button>
        <button class="svwa" id="svwac">WhatsApp au client</button><button class="svwa" id="svwad">WhatsApp au chauffeur</button>
        <button class="ghost" id="svlater">Continuer le suivi</button></div></div>`;
    document.body.appendChild(o);
    $('#svdone').onclick = async () => { await svEndTrack(t, 'Arrivée à destination'); svClose(); };
    $('#svwac').onclick = () => svWa(m.client_phone, svWaTrack(t, m, fmtDTY));
    $('#svwad').onclick = () => svWa(t.driver_phone, svWaTrack(t, m, fmtDTY));
    $('#svlater').onclick = () => svClose();
  }
  svBeep();
}
/** Barre des suivis en cours (bas de l'écran, toutes les pages) */
function svBar() {
  let b = $('#svbar');
  const ps = SV.off || !svCan() ? [] : svOpen(), ts = SV.off || !svCan() ? [] : svOpenTracks();
  if (!ps.length && !ts.length) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('a'); b.id = 'svbar'; b.href = '#/suivi'; document.body.appendChild(b); }
  b.innerHTML = ps.slice(0, 6).map(p => `<span class="svb ${svPauseState(p, Date.now()).over ? 'over' : ''}${p.moved_at ? ' moved' : ''}">⏸ ${esc(p.plate || '')} <b class="svcd" data-end="${svPauseEndAt(p)}"></b></span>`).join('') +
    (ps.length > 6 ? `<span class="svb">+${ps.length - 6}</span>` : '') + ts.map(t => `<span class="svb trk${t.arrived_at ? ' ok' : ''}">🚘 ${esc(t.plate || '')}${t.arrived_at ? ' arrivé' : ''}</span>`).join('');
  svClockTick();
}
function svClockTick() {
  const now = Date.now();
  document.querySelectorAll('.svcd[data-end]').forEach(el => { const l = +el.dataset.end - now; el.textContent = svClock(l); el.classList.toggle('over', l <= 0); });
  document.querySelectorAll('.svlate[data-t]').forEach(el => { el.textContent = svDur(now - +el.dataset.t); });
  document.querySelectorAll('.svel[data-t]').forEach(el => { el.textContent = svDur(now - +el.dataset.t); });
}

// ---------- actions ----------
async function svDriverPhone(code, num) {
  try {
    if (code) { const { data } = await sb.from('drivers').select('phone').eq('code', code).maybeSingle(); if (data && data.phone) return data.phone; }
    if (num) { const { data } = await sb.from('contracts').select('phone').eq('num', num).maybeSingle(); if (data && data.phone) return data.phone; }
  } catch (e) { }
  return '';
}
async function svStartPause(key, minutes, who) {
  const v = vehOf(key) || {}, now = Date.now(), c = who.ctr, sh = c ? shiftOfCtr(c.start_at, S.P) : shiftAt(now, S.P);
  const drv = c ? c.client_code : '', name = c ? c.name : who.name, drvKey = svDrvKey({ driver_code: drv, driver_name: name });
  const left = Math.floor(svLeftMin(SV.pauses, drvKey, sh.day, sh.s, now, S.P));
  if (left < 1) throw new Error((name || 'Ce chauffeur') + ' a déjà pris ses ' + svP(S.P, 'pauseShiftMin') + ' min de pause dans ce shift');
  const mins = Math.max(1, Math.min(left, Math.round(minutes || left)));
  await svPositions();
  let pos = SV.pos[key];
  if (!pos) { try { const { data } = await sb.from('live_status').select('lat,lon').eq('vehicle_key', key).maybeSingle(); if (data) pos = data; } catch (e) { } }
  const phone = who.phone || await svDriverPhone(drv, c ? c.num : '');
  const row = { agency_id: v.agency_id || null, vehicle_key: key, plate: v.plate || key, driver_code: drv || null, driver_name: name || null, driver_phone: phone || null,
    contract_num: c ? c.num : null, shift_day: sh.day, shift: sh.s, planned_min: mins, start_lat: pos && pos.lat != null ? +pos.lat : null, start_lon: pos && pos.lon != null ? +pos.lon : null };
  const { data, error } = await sb.from('driver_pauses').insert(row).select('*').single();
  if (error) throw new Error(/one_open|duplicate/.test(error.message) ? 'Ce véhicule est déjà en pause' : error.message);
  SV.pauses.push(data); svBar(); return data;
}
async function svEndPause(p, why) {
  const { data, error } = await sb.from('driver_pauses').update({ ended_at: new Date().toISOString(), end_reason: why || 'Terminée par le gestionnaire' }).eq('id', p.id).select('*').single();
  if (error) { uiNote('Fin de pause impossible : ' + error.message); return; }
  Object.assign(p, data); SV.loadAt = 0; svBar();
  if (pageOf() === 'suivi') pageSuivi(true).catch(() => { });
}
async function svExtend(p, n) {
  const left = svLeftMin(SV.pauses, svDrvKey(p), p.shift_day, p.shift, Date.now(), S.P, p.id), el = (Date.now() - new Date(p.started_at).getTime()) / 60000;
  const nm = Math.min(Math.floor(left), Math.ceil(Math.max(+p.planned_min, el)) + n);
  const { data, error } = await sb.from('driver_pauses').update({ planned_min: nm }).eq('id', p.id).select('*').single();
  if (error) { uiNote(error.message); return; }
  Object.assign(p, data); svBar(); if (pageOf() === 'suivi') pageSuivi(true).catch(() => { });
}
/** Adresse → coordonnées (Photon, données OpenStreetMap, Maroc) ; null si introuvable */
async function svGeocode(label) {
  if (!String(label || '').trim()) return null;
  try {
    const r = await fetch(ADDR_API + '?q=' + encodeURIComponent(label) + '&limit=1&bbox=' + ADDR_BBOX + '&lat=33.57&lon=-7.59');
    const j = await r.json(), f = j && j.features && j.features[0];
    return f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: addrLabel(f.properties) } : null;
  } catch (e) { return null; }
}
function svDest(m) { const f = (m.data && m.data.f) || {}; return String(f.endAddr || f.dest || '').trim(); }
async function svMisStatus(m, status) {
  if (!m || m.status === status) return;
  const d = Object.assign({}, m.data || {}); d.history = (d.history || []).concat([{ at: new Date().toISOString(), status: status + ' (suivi)', by: S.profile.email || '' }]);
  const { error } = await sb.from('missions').update({ status, data: d }).eq('id', m.id);
  if (!error) { m.status = status; m.data = d; }
}
async function svStartTrack(m) {
  const label = svDest(m), g = await svGeocode(label), v = vehOf(m.vehicle_key) || {};
  let phone = (m.data && m.data.f && m.data.f.driverPhone) || '';
  const row = { mission_id: m.id, agency_id: m.agency_id || v.agency_id || null, vehicle_key: m.vehicle_key, plate: v.plate || m.vehicle_key, driver_name: m.driver_name || null,
    driver_phone: phone || null, dest_label: label || null, dest_lat: g ? g.lat : null, dest_lon: g ? g.lon : null, points: [] };
  const { data, error } = await sb.from('mission_tracks').insert(row).select('*').single();
  if (error) throw new Error(/one_open|duplicate/.test(error.message) ? 'Cette course est déjà suivie' : error.message);
  SV.tracks.push(data); SV.mis[m.id] = m;
  if (['Acompte reçu', 'Confirmée'].includes(m.status)) await svMisStatus(m, 'En cours');
  svBar(); return { t: data, geo: !!g };
}
async function svEndTrack(t, why) {
  const pos = SV.pos[t.vehicle_key], pts = svAddPoint(t.points, pos, new Date().toISOString());
  const { data, error } = await sb.from('mission_tracks').update({ ended_at: new Date().toISOString(), end_reason: why || 'Suivi levé', points: pts, arrived_at: t.arrived_at || new Date().toISOString() }).eq('id', t.id).select('*').single();
  if (error) { uiNote('Fin du suivi impossible : ' + error.message); return; }
  Object.assign(t, data);
  const m = SV.mis[t.mission_id]; if (m && m.status === 'En cours') await svMisStatus(m, 'Terminée');
  SV.loadAt = 0; svBar(); if (pageOf() === 'suivi') pageSuivi(true).catch(() => { });
}

// ---------- page ----------
async function pageSuivi(refresh) {
  const my = ROUTING, tab = qs().get('t') || 'pauses';
  if (!refresh) $('#page').innerHTML = '<div class="loading">Chargement…</div>';
  await svLoad(true);
  if (my !== ROUTING) return;
  if (SV.off) { $('#page').innerHTML = `<h1>Pauses et suivi des courses</h1>${msg('Module pas encore installé : migration <code>20261128000000_suivi_pauses.sql</code> à exécuter (Supabase > SQL Editor).', 'warn')}`; return; }
  const tabs = [['pauses', 'Pauses chauffeurs'], ['courses', 'Suivi des courses privées'], ['historique', 'Historique et analyse']];
  const head = `<h1>Pauses et suivi des courses</h1><div class="tabs">${tabs.map(t => `<a class="tab ${t[0] === tab ? 'on' : ''}" href="#/suivi?t=${t[0]}">${t[1]}</a>`).join('')}</div>${SV.err ? msg(esc(SV.err), 'err') : ''}`;
  if (tab === 'historique') return svHistory(my, head);
  if (typeof loadLiveContracts === 'function') { try { await loadLiveContracts(); } catch (e) { } }
  await svPositions();
  if (my !== ROUTING) return;
  if (tab === 'courses') return svCoursesTab(my, head);
  svPausesTab(head);
}
function svPausesTab(head) {
  const ok = inAgency(), now = Date.now(), can = svCan(), open = svOpen();
  const onPause = new Set(open.map(p => p.vehicle_key));
  const list = vehPick().filter(v => ok(v.key) && !v._parc).map(v => {
    const c = typeof contractAt === 'function' ? contractAt(v.key, now, true) : null, sh = c ? shiftOfCtr(c.start_at, S.P) : shiftAt(now, S.P);
    const dk = svDrvKey({ driver_code: c ? c.client_code : '', driver_name: c ? c.name : '' }), used = c ? svUsedMin(SV.pauses, dk, sh.day, sh.s, now) : 0;
    return { v, c, sh, used, left: Math.max(0, svP(S.P, 'pauseShiftMin') - used), g: SV.pos[v.key] };
  }).sort((a, b) => (b.c ? 1 : 0) - (a.c ? 1 : 0) || String(a.v.plate).localeCompare(String(b.v.plate)));
  const card = p => svPauseCard(p, can, now);
  $('#page').innerHTML = head + `
    <div class="panel"><h3>En pause (${open.length})</h3>${open.length ? '<div class="svcards">' + open.sort((a, b) => svPauseEndAt(a) - svPauseEndAt(b)).map(card).join('') + '</div>' : '<div class="empty">Aucun chauffeur en pause</div>'}</div>
    <div class="panel"><h3>Mettre un chauffeur en pause</h3>
      <div class="small">${esc(svP(S.P, 'pauseShiftMin'))} min de pause par chauffeur et par shift · rappel toutes les ${esc(svP(S.P, 'pauseRemindMin'))} min · alerte si le véhicule bouge de plus de ${esc(svP(S.P, 'pauseMoveM'))} m (GPS Geotab)</div>
      <div class="svq"><input id="svsearch" placeholder="Plaque ou chauffeur…" size="22" autocomplete="off"> <label>Durée <select id="svdur"><option value="">tout le temps qui reste</option>${[15, 30, 45, 60, 90].map(x => `<option value="${x}">${x} min</option>`).join('')}</select></label></div>
      <div class="svlist">${list.map(x => `<div class="svrow" data-q="${esc((x.v.plate + ' ' + (x.c ? x.c.name : '')).toLowerCase())}">
        <div>${plate(x.v.plate)} <b>${esc(x.c ? x.c.name : 'Sans contrat')}</b><div class="small">${x.g ? esc(x.g.state || '') + (x.g.state === 'En route' ? ' · ' + esc(String(Math.round(x.g.speed || 0))) + ' km/h' : '') : 'position non relevée'}${x.c ? ' · shift ' + esc(x.sh.s) + ' · pause prise ' + esc(String(Math.round(x.used))) + ' min, reste ' + esc(String(Math.floor(x.left))) + ' min' : ''}</div></div>
        <div>${onPause.has(x.v.key) ? '<span class="badge warn">en pause</span>' : can ? `<button class="svgo" data-go="${esc(x.v.key)}" ${x.c && x.left < 1 ? 'disabled title="2 h de pause déjà prises dans ce shift"' : ''}>⏸ Pause</button>` : ''}</div></div>`).join('') || '<div class="empty">Aucun véhicule</div>'}</div></div>`;
  $('#svsearch').oninput = e => { const q = e.target.value.trim().toLowerCase(); document.querySelectorAll('.svrow').forEach(r => { r.hidden = q && r.dataset.q.indexOf(q) < 0; }); };
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = async () => {
    const x = list.find(y => y.v.key === b.dataset.go); if (!x) return;
    let who = { ctr: x.c };
    if (!x.c) { const n = await askText('Véhicule sans contrat en cours : nom du chauffeur en pause ?', ''); if (!n) return; const t = await askText('Téléphone du chauffeur (WhatsApp) ?', ''); who = { ctr: null, name: n, phone: t || '' }; }
    b.disabled = true;
    try { await svStartPause(x.v.key, +$('#svdur').value || 0, who); pageSuivi(true); } catch (e) { b.disabled = false; uiNote(e.message); }
  });
  window.__repage = () => pageSuivi(true);
  svClockTick();
}
async function svCoursesTab(my, head) {
  const now = Date.now(), can = svCan(), ok = inAgency();
  let ms = [];
  try { ms = await all('missions', 'id,number,status,agency_id,client_name,client_company,client_phone,driver_name,vehicle_key,start_at,end_at,kind,data', q => q.in('status', ['Acompte reçu', 'Confirmée', 'En cours'])
    .not('vehicle_key', 'is', null).gte('start_at', new Date(now - 36 * 3600000).toISOString()).lte('start_at', new Date(now + 24 * 3600000).toISOString()), ['start_at']); } catch (e) { ms = []; }
  if (my !== ROUTING) return;
  ms.forEach(m => { SV.mis[m.id] = Object.assign(SV.mis[m.id] || {}, m); });
  const tracked = new Set(svOpenTracks().map(t => t.mission_id)), ts = svOpenTracks();
  const tcard = t => { const m = SV.mis[t.mission_id] || {}, pos = SV.pos[t.vehicle_key], d = t.dest_lat != null && pos ? svDist({ lat: t.dest_lat, lon: t.dest_lon }, pos) : null;
    return `<div class="svcard trk ${t.arrived_at ? 'ok' : ''}"><div class="svct"><span class="big">${t.arrived_at ? 'Arrivé' : d != null ? (d >= 1000 ? (Math.round(d / 100) / 10).toString().replace('.', ',') + ' km' : Math.round(d) + ' m') : '—'}</span><span class="small">${t.arrived_at ? esc(fmtDT(t.arrived_at).slice(6)) : d != null ? 'de la destination (vol d\'oiseau)' : t.dest_lat == null ? 'destination non localisée' : 'position non relevée'}</span></div>
      <div class="svcm"><b>${esc(m.client_company || m.client_name || 'Course')}</b> ${esc(m.number || '')} ${plate(t.plate)}<div class="small">${esc(t.driver_name || m.driver_name || '')}${t.driver_phone ? ' · ' + esc(t.driver_phone) : ''} · prise en charge ${esc(fmtDT(t.started_at).slice(6))} (depuis <span class="svel" data-t="${new Date(t.started_at).getTime()}"></span>)</div>
        <div class="small">→ ${esc(t.dest_label || 'destination non renseignée : lever le suivi à l\'arrivée')}${pos ? ' · ' + esc(pos.state || '') + (pos.state === 'En route' ? ' ' + Math.round(pos.speed || 0) + ' km/h' : '') : ''}${(t.points || []).length > 1 ? ' · ' + String(svKm(t.points)).replace('.', ',') + ' km GPS' : ''}</div></div>
      <div class="svca">${can ? `<button class="small" data-tend="${t.id}">Course terminée : lever le suivi</button><button class="ghost small" data-tdest="${t.id}">Corriger la destination</button>` : ''}<button class="ghost small" data-twc="${t.id}">WhatsApp client</button><button class="ghost small" data-twd="${t.id}">WhatsApp chauffeur</button></div></div>`; };
  const todo = ms.filter(m => !tracked.has(m.id) && ok(m.vehicle_key));
  $('#page').innerHTML = head + `
    <div class="panel"><h3>Courses suivies (${ts.length})</h3>${ts.length ? '<div class="svcards">' + ts.map(tcard).join('') + '</div>' : '<div class="empty">Aucune course suivie en ce moment</div>'}</div>
    <div class="panel"><h3>Courses réservées à suivre</h3><div class="small">Courses confirmées (acompte reçu, confirmée, en cours) d'hier à demain, avec un véhicule affecté. Le suivi passe la course « En cours » ; le lever la passe « Terminée ».</div>
      <div class="svlist">${todo.map(m => `<div class="svrow"><div><b>${esc(m.client_company || m.client_name || '')}</b> ${esc(m.number || '')} ${plate((vehOf(m.vehicle_key) || {}).plate || m.vehicle_key)} ${badge(m.status, m.status === 'En cours' ? 'ok' : '')}
        <div class="small">${esc(fmtDT(m.start_at))} → ${esc(fmtDT(m.end_at))} · ${esc(m.driver_name || 'chauffeur non renseigné')} · ${esc(((m.data && m.data.f && m.data.f.startAddr) || '—') + ' → ' + (svDest(m) || '—'))}</div></div>
        <div>${can ? `<button class="svgo" data-tgo="${m.id}">▶ Démarrer le suivi</button>` : ''}</div></div>`).join('') || '<div class="empty">Aucune course réservée à suivre</div>'}</div></div>`;
  document.querySelectorAll('[data-tgo]').forEach(b => b.onclick = async () => { const m = SV.mis[b.dataset.tgo]; if (!m) return; b.disabled = true;
    try { const r = await svStartTrack(m); if (!r.geo) uiNote('Suivi démarré. Destination introuvable sur la carte' + (svDest(m) ? ' (« ' + svDest(m) + ' »)' : '') + ' : pas d\'alerte d\'arrivée automatique, levez le suivi à l\'arrivée ou corrigez la destination.'); pageSuivi(true); }
    catch (e) { b.disabled = false; uiNote(e.message); } });
  const T = id => SV.tracks.find(x => String(x.id) === String(id));
  document.querySelectorAll('[data-tend]').forEach(b => b.onclick = async () => { const t = T(b.dataset.tend); if (t && await ask('Course terminée : lever le suivi ?')) await svEndTrack(t, 'Suivi levé par le gestionnaire'); });
  document.querySelectorAll('[data-tdest]').forEach(b => b.onclick = async () => { const t = T(b.dataset.tdest); if (!t) return; const l = await askText('Adresse de destination', t.dest_label || ''); if (!l) return;
    const g = await svGeocode(l); if (!g) { uiNote('Adresse introuvable sur la carte : essayez avec la ville (ex. « Aéroport Mohammed V, Nouaceur »).'); return; }
    const { error } = await sb.from('mission_tracks').update({ dest_label: l, dest_lat: g.lat, dest_lon: g.lon }).eq('id', t.id); if (error) uiNote(error.message); else { Object.assign(t, { dest_label: l, dest_lat: g.lat, dest_lon: g.lon }); pageSuivi(true); } });
  document.querySelectorAll('[data-twc]').forEach(b => b.onclick = () => { const t = T(b.dataset.twc), m = t && SV.mis[t.mission_id]; if (t) svWa(m && m.client_phone, svWaTrack(t, m, fmtDTY)); });
  document.querySelectorAll('[data-twd]').forEach(b => b.onclick = () => { const t = T(b.dataset.twd), m = t && SV.mis[t.mission_id]; if (t) svWa(t.driver_phone, svWaTrack(t, m, fmtDTY)); });
  window.__repage = () => pageSuivi(true);
  svClockTick();
}
async function svHistory(my, head) {
  const q = qs(), from = q.get('du') || addDays(today(), -6), to = q.get('au') || today(), ok = inAgency(), now = Date.now();
  let ps = [], ts = [];
  try {
    [ps, ts] = await Promise.all([all('driver_pauses', '*', x => x.gte('shift_day', from).lte('shift_day', to), ['started_at']),
      all('mission_tracks', 'id,mission_id,vehicle_key,plate,driver_name,driver_phone,started_at,dest_label,arrived_at,ended_at,end_reason,points', x => x.gte('started_at', from + 'T00:00:00Z').lte('started_at', addDays(to, 1) + 'T12:00:00Z'), ['started_at'])]);
  } catch (e) { $('#page').innerHTML = head + msg(esc(e.message), 'err'); return; }
  if (my !== ROUTING) return;
  ps = ps.filter(p => ok(p.vehicle_key)); ts = ts.filter(t => ok(t.vehicle_key));
  const ids = [...new Set(ts.map(t => t.mission_id))], mis = {};
  if (ids.length) { const { data } = await sb.from('missions').select('id,number,client_name,client_company,client_phone,driver_name,data').in('id', ids); (data || []).forEach(m => { mis[m.id] = m; }); }
  const st = svStats(ps, now, S.P), lim = svP(S.P, 'pauseShiftMin');
  const cA = [['Jour', g => fmtDay(g.shift_day), g => g.shift_day], ['Shift', g => esc(g.shift)], ['Chauffeur', g => esc(g.driver_name || g.driver_code || '')], ['Véhicule(s)', g => esc(g.plates.join(', '))],
    ['Pauses', g => f0(g.n), g => g.n, 'n'], ['Minutes de pause', g => f0(g.min), g => g.min, 'n'], ['Au-delà de ' + lim + ' min', g => g.over ? `<b class="bad">${f0(g.over)}</b>` : '0', g => g.over, 'n'],
    ['Fins dépassées (> 5 min)', g => f0(g.late), g => g.late, 'n'], ['Véhicule a bougé', g => g.moved ? `<b class="bad">${f0(g.moved)}</b>` : '0', g => g.moved, 'n']];
  const cB = [['Début', p => fmtDTY(p.started_at), p => p.started_at], ['Fin', p => p.ended_at ? fmtDTY(p.ended_at) : '<span class="badge warn">en cours</span>', p => p.ended_at || ''], ['Durée (min)', p => f0(svPauseMin(p, now)), p => svPauseMin(p, now), 'n'],
    ['Prévue (min)', p => f0(p.planned_min), p => +p.planned_min, 'n'], ['Chauffeur', p => esc(p.driver_name || '')], ['Téléphone', p => esc(p.driver_phone || '')], ['Véhicule', p => plate(p.plate)], ['Shift', p => esc(p.shift + ' ' + fmtDay(p.shift_day))],
    ['Fin de la pause', p => esc(p.end_reason || '')], ['Véhicule en mouvement', p => p.moved_at ? `<b class="bad">${esc(p.moved_note || 'oui')}</b>` : '']];
  const cC = [['Prise en charge', t => fmtDTY(t.started_at), t => t.started_at], ['Arrivée', t => t.arrived_at ? fmtDTY(t.arrived_at) : '', t => t.arrived_at || ''], ['Durée', t => t.arrived_at || t.ended_at ? svDur(new Date(t.arrived_at || t.ended_at) - new Date(t.started_at)) : 'en cours'],
    ['Course', t => esc(((mis[t.mission_id] || {}).number || '') + ' ' + ((mis[t.mission_id] || {}).client_company || (mis[t.mission_id] || {}).client_name || ''))], ['Véhicule', t => plate(t.plate)], ['Chauffeur', t => esc(t.driver_name || '')],
    ['Destination', t => esc(t.dest_label || '')], ['Km GPS', t => (t.points || []).length > 1 ? f1(svKm(t.points)) : 'non mesuré', t => svKm(t.points), 'n'], ['Fin du suivi', t => esc(t.end_reason || (t.ended_at ? '' : 'en cours'))], ['', t => `<button class="ghost small" data-hwa="${t.id}">WhatsApp</button>`]];
  const tot = st.reduce((s, g) => s + g.min, 0), over = st.filter(g => g.over > 0).length, mv = ps.filter(p => p.moved_at).length;
  $('#page').innerHTML = head + `<div class="panel"><form class="svf" id="svf"><label>Du <input type="date" name="du" value="${from}"></label><label>au <input type="date" name="au" value="${to}"></label><button>Afficher</button>
      <button type="button" class="ghost" id="svpdf">PDF</button><button type="button" class="ghost" id="svxls">Tableur</button></form>
    <div class="kpis"><div class="kpi"><span>Pauses</span><b>${f0(ps.length)}</b></div><div class="kpi"><span>Minutes de pause</span><b>${f0(tot)}</b></div><div class="kpi"><span>Shifts au-delà de ${lim} min</span><b class="${over ? 'bad' : ''}">${f0(over)}</b></div>
      <div class="kpi"><span>Véhicules en mouvement en pause</span><b class="${mv ? 'bad' : ''}">${f0(mv)}</b></div><div class="kpi"><span>Courses suivies</span><b>${f0(ts.length)}</b></div></div></div>
    <div class="panel"><h3>Par chauffeur et par shift</h3>${table('tsva', cA, st, { page: true, empty: 'Aucune pause sur la période' })}</div>
    <div class="panel"><h3>Détail des pauses</h3>${table('tsvb', cB, ps.slice().reverse(), { page: true, empty: 'Aucune pause sur la période' })}</div>
    <div class="panel"><h3>Courses suivies</h3>${table('tsvc', cC, ts.slice().reverse(), { page: true, empty: 'Aucune course suivie sur la période' })}</div>`;
  $('#svf').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); location.hash = '#/suivi?t=historique&du=' + f.get('du') + '&au=' + f.get('au'); };
  const per = fmtDay(from) + ' → ' + fmtDay(to), name = 'pauses_' + from + '_' + to;
  $('#svpdf').onclick = () => { try { reportPdf(rptSimple({ kind: 'pauses', title: 'Pauses chauffeurs et courses suivies', period: per, from, to,
    summary: [['Pauses', f0(ps.length)], ['Minutes de pause', f0(tot)], ['Shifts au-delà de ' + lim + ' min', f0(over)], ['Véhicule en mouvement', f0(mv)], ['Courses suivies', f0(ts.length)]],
    tables: [colsTable('Par chauffeur et par shift', cA, st), colsTable('Détail des pauses', cB, ps), colsTable('Courses suivies', cC.slice(0, -1), ts)], fileName: name })); } catch (e) { uiNote(e.message); } };
  $('#svxls').onclick = () => { if (!window.XLSX) { uiNote('Bibliothèque tableur non chargée, réessayez dans un instant.'); return; }
    const wb = XLSX.utils.book_new(), sh = (cols, rows) => XLSX.utils.aoa_to_sheet([cols.filter(c => c[0]).map(c => txtOf(c[0]))].concat(rows.map(r => cols.filter(c => c[0]).map(c => { const v = c[2] ? c[2](r) : txtOf(c[1](r)); return c[3] === 'n' && typeof v === 'number' ? Math.round(v * 10) / 10 : txtOf(c[1](r)); }))));
    XLSX.utils.book_append_sheet(wb, sh(cA, st), 'Par chauffeur et shift'); XLSX.utils.book_append_sheet(wb, sh(cB, ps), 'Pauses'); XLSX.utils.book_append_sheet(wb, sh(cC.slice(0, -1), ts), 'Courses suivies'); XLSX.writeFile(wb, name + '.xlsx'); };
  document.querySelectorAll('[data-hwa]').forEach(b => b.onclick = () => { const t = ts.find(x => String(x.id) === b.dataset.hwa); if (t) svWa((mis[t.mission_id] || {}).client_phone, svWaTrack(t, mis[t.mission_id], fmtDTY)); });
  window.__repage = () => pageSuivi(true);
}

// ---------- page En direct : pauses en cours, mise en pause depuis la carte et la liste ----------
/** Carte d'une pause en cours (compte à rebours, chauffeur, téléphone, véhicule qui bouge) */
function svPauseCard(p, can, now) {
  const st = svPauseState(p, now || Date.now());
  return `<div class="svcard ${st.over ? 'over' : ''}${p.moved_at ? ' moved' : ''}"><div class="svct"><span class="svcd big" data-end="${svPauseEndAt(p)}"></span><span class="small">${st.over ? 'pause dépassée' : 'reste'}</span></div>
    <div class="svcm"><b>${esc(p.driver_name || 'Chauffeur inconnu')}</b> ${plate(p.plate)}<div class="small">${esc(p.driver_phone || 'téléphone non renseigné')} · shift ${esc(p.shift)} du ${esc(fmtDay(p.shift_day))}</div>
      <div class="small">Début ${esc(fmtDT(p.started_at).slice(6))} · ${esc(String(p.planned_min))} min prévues · en pause depuis <span class="svel" data-t="${new Date(p.started_at).getTime()}"></span></div>
      ${p.moved_at ? `<div class="svmv">⚠ Véhicule en mouvement pendant la pause : ${esc(p.moved_note || '')} (${esc(fmtDT(p.moved_at).slice(6))})</div>` : ''}</div>
    <div class="svca">${can ? `<button class="small" data-svend="${p.id}">Fin de pause</button><button class="ghost small" data-svplus="${p.id}">+5 min</button>` : ''}<button class="ghost small" data-svwa="${p.id}">WhatsApp</button></div></div>`;
}
function svPauseOf(key) { return SV.off ? null : SV.pauses.find(p => !p.ended_at && p.vehicle_key === key) || null; }
/** Ligne « pause » d'une carte véhicule de la page En direct */
function svVehLine(key) {
  const p = svPauseOf(key); if (!p) return '';
  return `<span class="vc-pause${p.moved_at ? ' moved' : svPauseState(p, Date.now()).over ? ' over' : ''}">⏸ ${p.moved_at ? 'EN PAUSE ET EN MOUVEMENT' : 'En pause'} · <b class="svcd" data-end="${svPauseEndAt(p)}"></b></span>`;
}
/** Section « Pauses » de la page En direct : pauses en cours (redessinées toutes les 5 s) + mise en pause rapide */
function svDirectHtml(rows) {
  if (SV.off || !canSee('suivi')) return '';
  const can = svCan(), open = svOpen().sort((a, b) => svPauseEndAt(a) - svPauseEndAt(b));
  return `<div class="sechead"><h2>Pauses chauffeurs</h2><span class="small">${esc(svP(S.P, 'pauseShiftMin'))} min par chauffeur et par shift · rappel toutes les ${esc(svP(S.P, 'pauseRemindMin'))} min · alerte si le véhicule en pause bouge de plus de ${esc(svP(S.P, 'pauseMoveM'))} m · <a href="#/suivi">Pauses et suivi des courses ›</a></span></div>
    <div id="livepauselist">${svDirectList(open, can)}</div>
    ${can ? `<div class="svq" id="livepauseform"><label>Véhicule <select id="lpveh"><option value="">— Choisir —</option>${rows.filter(r => !svPauseOf(r.vehicle_key)).map(r => `<option value="${esc(r.vehicle_key)}">${esc(r.plate || r.vehicle_key)} · ${esc(r.contract_num ? r.driver_name : 'sans contrat')}</option>`).join('')}</select></label>
      <label>Durée <select id="lpdur"><option value="">tout le temps qui reste</option>${[15, 30, 45, 60, 90].map(x => `<option value="${x}">${x} min</option>`).join('')}</select></label>
      <button class="svgo" id="lpgo">⏸ Mettre en pause</button></div>` : ''}`;
}
function svDirectList(open, can) { return open.length ? '<div class="svcards">' + open.map(p => svPauseCard(p, can)).join('') + '</div>' : '<div class="empty">Aucun chauffeur en pause</div>'; }
/** Pause déclenchée depuis En direct (liste, carte, bulle du véhicule) : chauffeur du contrat en cours, sinon nom saisi */
async function svGoFromLive(key, minutes) {
  if (!svCan()) return;
  if (svPauseOf(key)) { uiNote('Ce véhicule est déjà en pause.'); return; }
  const c = typeof contractAt === 'function' ? contractAt(key, Date.now(), true) : null;
  let who = { ctr: c };
  if (!c) { const n = await askText('Véhicule sans contrat en cours : nom du chauffeur en pause ?', ''); if (!n) return; const t = await askText('Téléphone du chauffeur (WhatsApp) ?', ''); who = { ctr: null, name: n, phone: t || '' }; }
  try { const p = await svStartPause(key, minutes || 0, who); onNewAlert({ id: 'PAUSEGO|' + p.id, vehicle_key: key, plate: p.plate, severity: 'Info', type: 'Pause commencée', driver_name: p.driver_name, detail: p.planned_min + ' min · fin à ' + fmtDT(new Date(svPauseEndAt(p))).slice(6), link: '#/suivi' }); }
  catch (e) { uiNote(e.message); }
  if (pageOf() === 'direct' && typeof applyDirect === 'function') applyDirect();
}
// actions des pauses par délégation (page En direct, bulles de la carte) : les éléments sont redessinés toutes les 5 s
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('[data-svgo],[data-svend],[data-svplus],[data-svwa],#lpgo');
  if (!t) return;
  const P = id => SV.pauses.find(x => String(x.id) === String(id));
  if (t.id === 'lpgo') { const k = $('#lpveh') && $('#lpveh').value; if (!k) { uiNote('Choisir le véhicule à mettre en pause.'); return; } t.disabled = true; await svGoFromLive(k, +($('#lpdur') || {}).value || 0); t.disabled = false; return; }
  if (t.dataset.svgo) { e.preventDefault(); await svGoFromLive(t.dataset.svgo, 0); return; }
  if (t.dataset.svend) { const p = P(t.dataset.svend); if (p) { await svEndPause(p, 'Terminée par le gestionnaire'); if (pageOf() === 'direct' && typeof applyDirect === 'function') applyDirect(); } return; }
  if (t.dataset.svplus) { const p = P(t.dataset.svplus); if (p) { await svExtend(p, 5); if (pageOf() === 'direct' && typeof applyDirect === 'function') applyDirect(); } return; }
  if (t.dataset.svwa) { const p = P(t.dataset.svwa); if (!p) return; const st = svPauseState(p, Date.now());
    svWa(p.driver_phone, p.moved_at ? svWaMoved(p, p.moved_note || 'en mouvement') : st.over ? svWaPauseEnd(p, Date.now()) : '⏸ Pause en cours : reste ' + svDur(st.left) + ' (fin à ' + fmtDT(new Date(svPauseEndAt(p))).slice(6) + '). Véhicule ' + (p.plate || '') + '.'); }
});
