// ============================================================================
// Retours véhicules (16/11/2026, demande d'Ahmed : « les chauffeurs viennent tous en même temps, ça engendre du retard ») : page #/retours.
// Véhicules sous contrat de l'agence classés du plus proche au plus loin de l'agence (position Geotab toutes les 20 s, distance à vol
// d'oiseau) ou par heure de départ du contrat, ou à la main (↑ ↓) ; une heure de retour par chauffeur (première heure + rang × intervalle) ;
// message WhatsApp individuel (se déconnecter d'Uber / Bolt et rentrer à l'agence à l'heure donnée), « Prévenir le suivant » ; arrivée
// à l'agence vue par le GPS (rayon returnRadiusM) ; « Retour fait ». Position de l'agence réglée par l'administrateur (ici ou page Agences).
// Calculs : site/retours_calc.js. Appels gardés dans la base (return_calls) : vus par tous les gestionnaires de l'agence.
// ============================================================================
const RT = { ag: null, pos: {}, posAt: 0, loadAt: 0, posErr: '', timer: null, rows: [], ags: [], calls: [], off: false };
const RT_POS_MS = 20000;

function rtLs(k, d) { const v = lsJSON('rt_' + k); return v == null ? d : v.v; }
function rtLsSet(k, v) { lsSet('rt_' + k, { v }); }
function rtAgPos(a) { return a && a.lat != null && a.lng != null ? { lat: +a.lat, lon: +a.lng } : null; }
function rtKm(m) { return m == null ? '<span class="small">non mesuré</span>' : m < 1000 ? f0(m) + ' m' : f1(m / 1000) + ' km'; }
function rtAgo(t) { const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); }
function rtNextStart() { const t = Date.now() + 5 * 60000; return t - t % (5 * 60000); }

/** Positions Geotab : relais en direct (toutes les 20 s), sinon dernières positions du collecteur (live_status) */
async function rtPositions(force) {
  if (!force && Date.now() - RT.posAt < RT_POS_MS) return;
  RT.posAt = Date.now();
  try { const j = await relay(); const p = {}; (j.vehicles || []).forEach(v => { if (v.lat != null) p[v.key] = v; }); RT.pos = p; RT.posErr = ''; return; }
  catch (e) { RT.posErr = String(e.message || e); }
  try { const l = await all('live_status', 'vehicle_key,lat,lon,state,speed,last_pos_at'); const p = {}; l.forEach(v => { if (v.lat != null) p[v.vehicle_key] = { key: v.vehicle_key, lat: v.lat, lon: v.lon, state: v.state, speed: v.speed, at: v.last_pos_at }; }); RT.pos = p; } catch (e) { }
}

/** Contrats en cours (qui couvrent maintenant) des véhicules de l'agence, un par véhicule, et appels de retour récents */
async function rtLoad() {
  const now = Date.now(), ok = inAgency();
  const vehs = S.vehList.filter(v => String(v.agency_id) === String(RT.ag) && v.active !== 'NON' && ok(v.key)), keys = vehs.map(v => v.key);
  let ctr = [], calls = [];
  if (keys.length) {
    ctr = await withSuccessors(await all('contracts', 'num,client_code,name,phone,vehicle_key,start_at,end_at', q => q.in('vehicle_key', keys).lte('start_at', new Date(now).toISOString())
      .or('end_at.is.null,end_at.gte.' + new Date(now).toISOString())));
    try { calls = await all('return_calls', '*', q => q.in('vehicle_key', keys).gte('created_at', new Date(now - 36 * HOUR).toISOString())); RT.off = false; }
    catch (e) { if (/return_calls|does not exist|schema cache|404/i.test(e.message)) { RT.off = true; calls = []; } else throw e; }
  }
  RT.calls = calls;
  const rows = [];
  vehs.forEach(v => {
    const l = ctrEffEnds(ctr.filter(c => c.vehicle_key === v.key), now).filter(c => new Date(c.start_at).getTime() <= now && (c._end === null || c._end > now));
    const c = l[l.length - 1]; if (!c) return;
    const call = calls.find(x => x.contract_num === c.num && !x.cancelled_at) || null;
    rows.push({ num: c.num, key: v.key, plate: v.plate, model: v.model, driver_name: c.name || '', phone: c.phone || (call && call.phone) || '', start_at: c.start_at, end_at: c.end_at, call });
  });
  RT.rows = rows; RT.loadAt = Date.now();
}

function rtRowsNow(ag) {
  const ap = rtAgPos(ag);
  return RT.rows.map(r => { const p = RT.pos[r.key] || null; return Object.assign(r, { p, dist: ap && p ? rtDist(ap, { lat: p.lat, lon: p.lon }) : null }); });
}

/** Appel de retour du contrat (créé au besoin), mis à jour avec les champs donnés */
async function rtSave(r, ch) {
  if (r.call && r.call.id) {
    const { data, error } = await sb.from('return_calls').update(ch).eq('id', r.call.id).select('*').single();
    if (error) throw new Error(error.message); r.call = data; return data;
  }
  const { data, error } = await sb.from('return_calls').insert(Object.assign({ contract_num: r.num, vehicle_key: r.key, driver_name: r.driver_name || null, phone: r.phone || null, agency_id: +RT.ag || null }, ch)).select('*').single();
  if (error) throw new Error(/duplicate|unique/.test(error.message) ? 'Un autre gestionnaire vient de prévenir ce chauffeur : la page est relue.' : error.message);
  r.call = data; RT.calls.push(data); return data;
}

async function pageRetours() {
  const rid = ROUTING;
  await loadRef(true);
  RT.ags = await all('agencies', '*', null, ['name']);
  if (rid !== ROUTING) return;
  if (!RT.ag || !RT.ags.some(a => String(a.id) === String(RT.ag))) {
    const saved = rtLs('ag', null), cnt = a => S.vehList.filter(v => String(v.agency_id) === String(a.id) && inAgency()(v.key)).length;
    RT.ag = saved && RT.ags.some(a => String(a.id) === String(saved)) ? saved : ((RT.ags.slice().sort((a, b) => cnt(b) - cnt(a))[0] || {}).id || null);
  }
  if (!RT.ag) { $('#page').innerHTML = '<div class="head"><h1>Retours véhicules</h1></div>' + msg('Aucune agence : créez les agences et rattachez-y les véhicules (page Agences).', 'warn'); return; }
  $('#page').innerHTML = '<div class="head"><h1>Retours véhicules</h1></div><div class="empty">Chargement des contrats et des positions…</div>';
  await Promise.all([rtLoad(), rtPositions(true)]);
  if (rid !== ROUTING) return;
  rtDraw();
  clearInterval(RT.timer);
  RT.timer = setInterval(async () => {
    if (!location.hash.startsWith('#/retours')) { clearInterval(RT.timer); RT.timer = null; return; }
    if (document.hidden || document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    try { if (Date.now() - RT.loadAt > 60000) await rtLoad(); await rtPositions(); await rtAuto(); rtDraw(); } catch (e) { }
  }, 5000);
}

/** Arrivée vue par le GPS : appel noté « à l'agence » (une fois) */
async function rtAuto() {
  const ag = RT.ags.find(a => String(a.id) === String(RT.ag)), radius = (ag && ag.return_radius_m) || rtP(S.P, 'returnRadiusM');
  for (const r of rtRowsNow(ag)) {
    if (r.call && r.call.sent_at && !r.call.arrived_at && !r.call.done_at && r.dist != null && r.dist <= radius) {
      try { await rtSave(r, { arrived_at: new Date().toISOString() }); } catch (e) { }
    }
  }
}

function rtDraw() {
  const ag = RT.ags.find(a => String(a.id) === String(RT.ag)), ap = rtAgPos(ag), admin = isAdmin(), canEdit = ['admin', 'manager'].includes((S.profile || {}).role);
  const radius = (ag && ag.return_radius_m) || rtP(S.P, 'returnRadiusM'), step = num(rtLs('step', null), 0) || rtP(S.P, 'returnSlotMin');
  const mode = rtLs('mode', 'dist'), manual = rtLs('order|' + RT.ag + '|' + today(), []);
  let startHM = rtLs('start|' + today(), '');
  const start = (() => { if (!/^\d\d:\d\d$/.test(startHM)) return rtNextStart(); const p = today().split('-').map(Number), h = startHM.split(':').map(Number); return localToDate(p[0], p[1], p[2], h[0], h[1]).getTime(); })();
  if (!/^\d\d:\d\d$/.test(startHM)) startHM = localHM(new Date(start));
  const rows = rtOrder(rtRowsNow(ag), mode, manual, radius), slots = rtSlots(rows, start, step, radius);
  const st = r => rtState(r, radius), next = rows.find(r => st(r) === 'aprevenir' && manifWa(r.phone));
  const n = { tot: rows.length, sent: rows.filter(r => st(r) === 'envoye').length, arr: rows.filter(r => st(r) === 'arrive').length, done: rows.filter(r => st(r) === 'fait').length };
  const posTxt = RT.posErr ? '<span class="badge warn">positions du collecteur (relais indisponible)</span>' : '<span class="small">positions Geotab relues toutes les 20 s</span>';
  const stBadge = r => { const s = st(r), c = r.call || {};
    if (s === 'fait') return '<span class="badge ok">Retour fait' + (c.done_at ? ' ' + localHM(c.done_at) : '') + '</span>';
    if (s === 'arrive') return '<span class="badge ok">À l\'agence' + (c.arrived_at ? ' depuis ' + localHM(c.arrived_at) : '') + '</span>';
    if (s === 'envoye') { const d0 = c.dist_at_send_m, d = r.dist, trend = d0 != null && d != null ? (d < d0 - 200 ? ' · se rapproche (−' + rtKm(d0 - d) + ')' : d > d0 + 200 ? ' · <b>s\'éloigne</b>' : ' · pas encore parti') : '';
      return '<span class="badge warn">Prévenu à ' + localHM(c.sent_at) + '</span><span class="small">' + trend + '</span>'; }
    return '<span class="badge">À prévenir</span>'; };
  const posCell = r => { if (!r.p) return '<span class="small">position non mesurée</span>'; const s = r.p.state || ''; return esc(s) + (s === 'En route' && r.p.speed ? ' · ' + f0(r.p.speed) + ' km/h' : '') + (r.p.at ? '<div class="small">' + fmtDT(r.p.at) + '</div>' : ''); };
  const act = (r, i) => { const s = st(r); if (!canEdit) return '';
    return (s === 'aprevenir' || s === 'envoye' ? `<button class="small" data-rtwa="${esc(r.num)}"${manifWa(r.phone) ? '' : ' disabled title="Téléphone du chauffeur absent du contrat"'}>${s === 'envoye' ? 'Renvoyer' : 'WhatsApp'}</button>` : '') +
      (s !== 'fait' ? `<button class="ghost small" data-rtdone="${esc(r.num)}">Retour fait</button>` : '') +
      (s === 'aprevenir' ? `<button class="ghost small" data-rtup="${i}" title="Monter">↑</button><button class="ghost small" data-rtdn="${i}" title="Descendre">↓</button>` : '') +
      (r.call && !r.call.cancelled_at && s !== 'fait' ? `<button class="ghost small" data-rtcancel="${esc(r.num)}" title="Annuler l'appel de retour">✕</button>` : ''); };
  const cols = [['#', (r, i) => String(rows.indexOf(r) + 1), r => rows.indexOf(r), 'n'], ['Véhicule', r => plate(r.plate) + '<div class="small">' + esc(r.model || '') + '</div>', r => r.plate],
    ['Chauffeur', r => esc(r.driver_name || '') + (r.phone ? '<div class="small">' + esc(r.phone) + '</div>' : '<div class="small">téléphone absent</div>'), r => r.driver_name],
    ['Départ du contrat', r => localHM(r.start_at) + ' <span class="small">' + fmtDT(r.start_at).slice(0, 5) + ' · il y a ' + rtAgo(r.start_at) + '</span><div class="small">' + esc(r.num) + '</div>', r => r.start_at],
    ['Position', posCell, r => r.p ? r.p.state : ''], ['Distance à l\'agence', r => rtKm(r.dist), r => r.dist == null ? 1e12 : r.dist, 'n'],
    ['Heure de retour', r => slots[r.num] ? '<b>' + localHM(new Date(slots[r.num])) + '</b>' : '', r => slots[r.num] || 0],
    ['État', stBadge, r => RT_ST_ORD[st(r)]], ['', (r) => act(r, rows.indexOf(r))]];
  const notifBtn = !MOBILE && window.Notification && Notification.permission === 'default' ? '<div class="panel row"><button class="ghost" id="rtnotif">🔔 Activer les notifications du navigateur</button><span class="small">pour être prévenu de l\'arrivée d\'un chauffeur même quand Ludy est en arrière-plan</span></div>' : '';
  const coordsBox = admin && !MOBILE ? `<div class="panel row"><label>Position GPS de l'agence <input id="rtco" size="34" placeholder="31.6295, -7.9811 ou lien Google Maps" value="${ap ? ap.lat + ', ' + ap.lon : ''}"></label>
      <label>Adresse (dans le message) <input id="rtadr" size="30" value="${esc((ag && ag.address) || '')}"></label><label>Rayon d'arrivée (m) <input id="rtrad" size="4" value="${(ag && ag.return_radius_m) || ''}" placeholder="${rtP(S.P, 'returnRadiusM')}"></label>
      <button id="rtcosave">Enregistrer</button>${ap ? `<a class="small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${ap.lat},${ap.lon}">voir sur la carte ↗</a>` : ''}</div>` : '';
  $('#page').innerHTML = `<div class="head">${MOBILE ? '' : '<h1>Retours véhicules</h1>'}<div class="sub">Faites rentrer les chauffeurs un par un : classez les véhicules sous contrat (plus proche de l'agence, ou départ du contrat le plus ancien), donnez à chacun son heure de retour et prévenez-le sur WhatsApp. Distance à vol d'oiseau ; arrivée à l'agence vue par le GPS (${f0(radius)} m).</div></div>
    ${RT.off ? msg('Migration <b>20261202000000_retours.sql</b> à exécuter dans Supabase : les messages envoyés ne sont pas encore enregistrés.', 'warn') : ''}
    <div class="panel row"><label>Agence <select id="rtag">${RT.ags.map(a => `<option value="${a.id}" ${String(a.id) === String(RT.ag) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <span>Ordre :</span><button class="${mode === 'dist' ? '' : 'ghost'}" data-rtmode="dist">📍 Plus proche de l'agence</button><button class="${mode === 'depart' ? '' : 'ghost'}" data-rtmode="depart">⏱ Départ du contrat le plus ancien</button>${mode === 'manuel' ? '<span class="badge">ordre modifié à la main</span>' : ''}
      <label>Premier retour à <input id="rtstart" type="time" value="${startHM}"></label><label>puis toutes les <input id="rtstep" size="3" value="${step}"> min</label> ${posTxt}</div>
    ${coordsBox}
    ${!ap ? msg(admin ? 'Saisissez la position GPS de l\'agence ci-dessus (coordonnées ou lien Google Maps) pour classer les véhicules par distance.' : 'Position GPS de l\'agence pas encore réglée par l\'administrateur : véhicules classés par départ du contrat.', 'warn') : ''}
    ${cards([['Véhicules sous contrat', f0(n.tot)], ['À prévenir', f0(n.tot - n.sent - n.arr - n.done), 'warn'], ['Prévenus, en route', f0(n.sent)], ['À l\'agence', f0(n.arr), 'ok'], ['Retours faits', f0(n.done)]])}
    ${canEdit ? `<div class="panel row">${next ? `<button id="rtnext">▶ Prévenir le suivant : ${esc(next.driver_name || next.plate)} (${esc(next.plate)}) · retour ${localHM(new Date(slots[next.num]))}</button>` : '<span class="small">Tous les chauffeurs joignables sont prévenus.</span>'}<span class="small">Chaque clic ouvre WhatsApp du chauffeur avec son message (français et darija) ; il reste à appuyer sur Envoyer.</span></div>` : ''}
    ${notifBtn}${rtAppHtml()}
    ${MOBILE ? `<div id="trt">${rtCardsHtml(rows, slots, st, stBadge, act, posCell)}</div>` : table('trt', cols.map(c => [c[0], r => c[1](r), c[2], c[3]]), rows, { empty: 'Aucun véhicule sous contrat dans cette agence en ce moment.' })}`;
  if ($('#rtnotif')) $('#rtnotif').onclick = async () => { try { await Notification.requestPermission(); } catch (e) { } redraw(); };
  const redraw = () => rtDraw();
  $('#rtag').onchange = async () => { RT.ag = $('#rtag').value; rtLsSet('ag', RT.ag); $('#page').innerHTML = '<div class="empty">Chargement…</div>'; await rtLoad(); rtDraw(); };
  document.querySelectorAll('[data-rtmode]').forEach(b => { b.onclick = () => { rtLsSet('mode', b.dataset.rtmode); rtLsSet('order|' + RT.ag + '|' + today(), []); redraw(); }; });
  $('#rtstart').onchange = () => { rtLsSet('start|' + today(), $('#rtstart').value); redraw(); };
  $('#rtstep').onchange = () => { const v = num($('#rtstep').value, 0); rtLsSet('step', v > 0 && v <= 120 ? v : null); redraw(); };
  const move = (i, d) => { const ord = rows.map(r => r.num), j = i + d; if (j < 0 || j >= ord.length) return; [ord[i], ord[j]] = [ord[j], ord[i]]; rtLsSet('order|' + RT.ag + '|' + today(), ord); rtLsSet('mode', 'manuel'); redraw(); };
  document.querySelectorAll('[data-rtup]').forEach(b => { b.onclick = () => move(+b.dataset.rtup, -1); });
  document.querySelectorAll('[data-rtdn]').forEach(b => { b.onclick = () => move(+b.dataset.rtdn, 1); });
  const byNum = k => rows.find(r => r.num === k);
  const send = async r => {
    const slot = slots[r.num] || (r.call && r.call.slot_at ? new Date(r.call.slot_at).getTime() : start), txt = rtMsg(r, ag, localHM(new Date(slot)));
    svWa(r.phone, txt);
    try { await rtSave(r, { sent_at: new Date().toISOString(), sent_by: (S.profile && S.profile.email) || null, slot_at: new Date(slot).toISOString(), rank: rows.indexOf(r) + 1, dist_at_send_m: r.dist == null ? null : Math.round(r.dist), phone: r.phone || null, driver_name: r.driver_name || null }); }
    catch (e) { alert(e.message); await rtLoad(); }
    redraw();
  };
  document.querySelectorAll('[data-rtwa]').forEach(b => { b.onclick = () => { const r = byNum(b.dataset.rtwa); if (r) send(r); }; });
  if ($('#rtnext')) $('#rtnext').onclick = () => { if (next) send(next); };
  document.querySelectorAll('[data-rtdone]').forEach(b => { b.onclick = async () => { const r = byNum(b.dataset.rtdone); if (!r) return;
    try { await rtSave(r, { done_at: new Date().toISOString(), arrived_at: (r.call && r.call.arrived_at) || new Date().toISOString() }); } catch (e) { alert(e.message); } redraw(); }; });
  document.querySelectorAll('[data-rtcancel]').forEach(b => { b.onclick = async () => { const r = byNum(b.dataset.rtcancel); if (!r || !r.call) return;
    if (!await ask('Annuler l\'appel de retour de ' + (r.driver_name || r.plate) + ' ? Il repasse « à prévenir ».')) return;
    try { await rtSave(r, { cancelled_at: new Date().toISOString() }); r.call = null; } catch (e) { alert(e.message); } redraw(); }; });
  if ($('#rtcosave')) $('#rtcosave').onclick = async () => {
    const raw = $('#rtco').value.trim(), c = rtParseCoords(raw); if (raw && !c) { alert('Coordonnées illisibles : saisissez « latitude, longitude » (ex. 31.6295, -7.9811) ou collez un lien Google Maps.'); return; }
    const rad = num($('#rtrad').value, 0);
    const { error } = await sb.from('agencies').update({ lat: c ? c.lat : null, lng: c ? c.lon : null, address: $('#rtadr').value.trim() || null, return_radius_m: rad > 0 ? Math.round(rad) : null }).eq('id', RT.ag);
    if (error) { alert(/lat|lng|column/.test(error.message) ? 'Migration 20261202000000_retours.sql à exécuter dans Supabase.' : error.message); return; }
    RT.ags = await all('agencies', '*', null, ['name']); redraw();
  };
  window.__repage = redraw; window.__rerender = redraw;
}

// ---------- Notification d'arrivée à l'agence, sur toutes les pages (16/11/2026, demande d'Ahmed) ----------
// Toutes les 20 s : appels de retour arrivés dans les 3 dernières heures et pas encore faits (arrivée notée par la page Retours, le relais
// des téléphones ou le collecteur). Arrivée nouvelle = bandeau vert + bip ; onglet en arrière-plan = notification du navigateur (si permise).
// À la première lecture, les arrivées de plus de 10 min sont marquées vues sans bandeau (pas de rafale à l'ouverture de Ludy).
const RTW = { timer: null, primed: false, seen: null, uid: null };
const RTW_KEY = 'rtSeen';
function rtwCan() { return !!(S.profile && ['admin', 'manager'].includes(S.profile.role)) && canSee('retours'); }
function rtwSeen() {
  if (RTW.seen && RTW.uid === (S.profile && S.profile.user_id)) return RTW.seen;
  RTW.uid = S.profile && S.profile.user_id; RTW.primed = false;
  try { RTW.seen = JSON.parse(localStorage.getItem(RTW_KEY) || '{}') || {}; } catch (e) { RTW.seen = {}; }
  return RTW.seen;
}
function rtwMark(id) {
  const o = rtwSeen(); o[id] = Date.now();
  const cut = Date.now() - 2 * DAY; Object.keys(o).forEach(k => { if (o[k] < cut) delete o[k]; });
  try { localStorage.setItem(RTW_KEY, JSON.stringify(o)); } catch (e) { }
}
function rtwNotify(c) {
  const v = (S.veh && S.veh[c.vehicle_key]) || {}, pl = v.plate || c.vehicle_key, ag = S.agName ? S.agName[c.agency_id] || '' : '', at = localHM(c.arrived_at);
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast ok rttoast';
  t.innerHTML = `<button class="x" aria-label="Fermer">×</button><b>✅ Arrivé à l'agence${ag ? ' ' + esc(ag) : ''}</b> ${plate(pl)}<div>${esc(c.driver_name || '')}</div>
    <div class="small">à ${esc(at)}${c.slot_at ? ' · retour prévu à ' + esc(localHM(c.slot_at)) : ''}</div><a href="#/retours">Voir les retours</a>`;
  t.querySelector('.x').onclick = () => t.remove();
  box.prepend(t); setTimeout(() => t.remove(), 120000);
  if (typeof svBeep === 'function') svBeep();
  try {
    if (document.hidden && window.Notification && Notification.permission === 'granted')
      new Notification('Ludy · arrivé à l\'agence', { body: (c.driver_name ? c.driver_name + ' · ' : '') + pl + (ag ? ' · ' + ag : '') + ' à ' + at, tag: 'rt' + c.id, icon: 'icon-192.png' });
  } catch (e) { }
}
async function rtwTick() {
  if (!S.session || !S.profile || !rtwCan() || RTW.busy) return;
  RTW.busy = true;
  try {
    const { data, error } = await sb.from('return_calls').select('id,vehicle_key,driver_name,agency_id,slot_at,arrived_at')
      .gte('arrived_at', new Date(Date.now() - 3 * HOUR).toISOString()).is('done_at', null).is('cancelled_at', null).order('arrived_at').limit(200);
    if (error) return;
    const seen = rtwSeen(), now = Date.now();
    (data || []).forEach(c => {
      if (seen[c.id]) return;
      rtwMark(c.id);
      if (!RTW.primed && now - new Date(c.arrived_at).getTime() > 10 * MIN) return;
      rtwNotify(c);
    });
    RTW.primed = true;
  } catch (e) { } finally { RTW.busy = false; }
}
function rtwStart() {
  if (RTW.timer) return;
  RTW.timer = setInterval(() => { rtwTick(); }, 20000);
  rtwTick();
}

// ---------- Mode téléphone : cartes au lieu du tableau ----------
function rtCardsHtml(rows, slots, st, stBadge, act, posCell) {
  if (!rows.length) return '<div class="mempty"><b>Aucun véhicule sous contrat</b><p>Aucun contrat en cours dans cette agence.</p></div>';
  return rows.map((r, i) => `<div class="mcard rtcard ${st(r)}"><div class="mcard-h"><b>#${i + 1} ${esc(r.plate)}</b><span>${rtKm(r.dist)}</span></div>
    <div>${esc(r.driver_name || '')} ${r.phone ? '<span class="small">' + esc(r.phone) + '</span>' : '<span class="small">téléphone absent</span>'}</div>
    <div class="small">Départ ${localHM(r.start_at)} · il y a ${rtAgo(r.start_at)} · ${posCell(r)}</div>
    <div>${slots[r.num] ? 'Retour à <b>' + localHM(new Date(slots[r.num])) + '</b> · ' : ''}${stBadge(r)}</div>
    <div class="row">${act(r, i)}</div></div>`).join('');
}

/** Application Android : notification de l'arrivée à l'agence même écran éteint (1.4 et alertes du téléphone activées) */
function rtAppHtml() {
  if (!window.LudyAndroid) return '';
  const m = navigator.userAgent.match(/LudyAndroid\/(\d+)\.(\d+)/), old = !m || +m[1] < 1 || (+m[1] === 1 && +m[2] < 4);
  if (old) return msg(`Pour être prévenu sur ce téléphone quand un chauffeur arrive à l'agence, même écran éteint, installez Ludy 1.4. <a href="${esc(CFG.SUPABASE_URL + '/storage/v1/object/public/app/Ludy.apk')}">Télécharger Ludy 1.4</a>`, 'warn');
  const st = typeof svWatchStatus === 'function' ? svWatchStatus() || {} : {};
  return st.on ? '' : msg('Activez les alertes sur ce téléphone (écran <a href="#/suivi">Pauses</a>) pour être prévenu de l\'arrivée des chauffeurs, même écran éteint.', 'warn');
}
