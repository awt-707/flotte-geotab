// Flotte Geotab — site web (lecture de la base Supabase alimentée par le collecteur Apps Script)
const CFG = window.FLOTTE_CONFIG || {};
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const S = { session: null, profile: null, P: null, veh: null, vehList: [], rules: null, drv: null, timers: [], channel: null };
const $ = sel => document.querySelector(sel);
const ROLE_TXT = { admin: 'Administrateur', manager: 'Gestionnaire', viewer: 'Lecture seule', pending: 'En attente' };
const canEdit = () => S.profile && ['admin', 'manager'].includes(S.profile.role);
const isAdmin = () => S.profile && S.profile.role === 'admin';
const PARAM_DEFAULTS = { minFuelKm: 30, kmMin: 20, scoreY: 29, scoreO: 36, scoreR: 74, idleLongMin: 10, liveMin: 5 };

// ---------- Accès aux données ----------
async function all(table, cols, build, order) {
  const out = []; const page = 1000;
  for (let i = 0; ; i += page) {
    let q = sb.from(table).select(cols || '*');
    if (build) q = build(q);
    if (order) q = q.order(order[0], { ascending: order[1] !== false });
    const { data, error } = await q.range(i, i + page - 1);
    if (error) throw new Error(table + ' : ' + error.message);
    out.push(...data); if (data.length < page) break;
  }
  return out;
}
async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(fn + ' : ' + error.message); return data; }
async function job(kind, arg) {
  const { data, error } = await sb.from('jobs').insert({ kind, arg: arg || null }).select('id').single();
  if (error) throw new Error(error.message); return data.id;
}
async function loadRef(force) {
  if (S.P && !force) return;
  const [params, veh, rules, drv] = await Promise.all([all('params', 'key,value'), all('vehicles', '*', null, ['plate']), all('rules', 'id,name,weight,category'), all('drivers', 'code,name,status')]);
  S.P = Object.assign({}, PARAM_DEFAULTS); params.forEach(p => { if (p.value !== null && p.value !== '') S.P[p.key] = isNaN(+p.value) ? p.value : +p.value; });
  S.vehList = veh; S.veh = {}; veh.forEach(v => { S.veh[v.key] = v; });
  S.rules = {}; rules.forEach(r => { S.rules[r.id] = r; });
  S.drv = { [HORS]: 'Hors contrat' }; drv.forEach(d => { S.drv[d.code] = d.name; });
}

// ---------- Mise en page ----------
const NAV = [['direct', 'En direct'], ['tableau', 'Tableau de bord'], ['jour', 'Du jour'], ['chauffeurs', 'Chauffeurs'], ['alertes', 'Alertes'],
  ['contrats', 'Contrats'], ['plaques', 'Plaques'], ['vehicules', 'Véhicules'], ['reglages', 'Réglages']];
function shell() {
  const page = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'direct';
  $('#app').innerHTML = `<div class="layout">
  <aside class="side">
    ${BRAND}
    <nav aria-label="Pages">${NAV.filter(n => n[0] !== 'reglages' || isAdmin()).map(n => `<a href="#/${n[0]}" class="${n[0] === page ? 'on' : ''}"${n[0] === page ? ' aria-current="page"' : ''}>${n[1]}${n[0] === 'alertes' ? '<span class="nb" id="nbal" hidden></span>' : ''}</a>`).join('')}</nav>
    <div class="foot"><span id="health" class="health">Collecte…</span><span class="who" title="${esc(S.profile.email || '')}">${esc(S.profile.email || '')}</span><span class="role">${ROLE_TXT[S.profile.role]}</span><button class="ghost" id="logout">Déconnexion</button></div>
  </aside>
  <main id="page"><div class="loading">Chargement…</div></main></div>`;
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.hash = ''; };
  health(); openAlerts();
  const on = $('.side nav a.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  return page;
}
const BRAND = '<div class="brand"><span class="mark" aria-hidden="true"></span><div>Flotte Geotab<small>Supervision des véhicules</small></div></div>';
/** Plaque d'immatriculation dessinée comme une vraie plaque (provisoire WW / W18 en jaune) */
function plate(p, others) {
  if (!p) return '';
  const temp = /WW$|^W\d|W18/i.test(String(p).replace(/[\s-]/g, ''));
  return `<span class="plate${temp ? ' temp' : ''}">${esc(p)}</span>${others ? `<span class="alias">aussi ${esc(others)}</span>` : ''}`;
}
/** Nombre d'alertes critiques encore à traiter (pastille du menu) */
async function openAlerts() {
  try {
    const { count } = await sb.from('alerts').select('id', { count: 'exact', head: true }).eq('severity', 'Critique').eq('status', 'À traiter');
    const el = $('#nbal'); if (el && count) { el.textContent = count; el.hidden = false; el.title = count + ' alertes critiques à traiter'; }
  } catch (e) { }
}
function msg(text, kind) { return `<div class="msg ${kind || ''}">${text}</div>`; }
function badge(t, cls) { return t ? `<span class="badge ${cls || ''}">${esc(t)}</span>` : ''; }
const LEVEL_CLS = { 'Faible': 'ok', 'Modéré': 'warn', 'Élevé': 'high', 'Dangereux': 'crit' };
const GRAV_CLS = { 'Critique': 'crit', 'Haute': 'high', 'Moyenne': 'warn', 'Info': 'info' };
const STATE_CLS = { 'En route': 'ok', 'Arrêté, contact mis': 'warn', 'Garé': '', 'Boîtier hors ligne': 'crit', 'Pas de réponse Geotab': 'crit', 'Non relié à Geotab': 'info' };
/** Tableau triable : cols = [[titre, fonction(ligne) -> html, valeur de tri (facultatif), classe]] */
function table(id, cols, rows, opt) {
  opt = opt || {};
  if (!rows.length) return `<div class="empty">${opt.empty || 'Aucune donnée sur la période'}</div>`;
  const st = (window.__sort || {})[id] || {};
  let list = rows.slice();
  if (st.c !== undefined && cols[st.c]) { const f = cols[st.c][2] || cols[st.c][1]; list.sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * (st.d ? -1 : 1); }); }
  return `<div class="tw"><table id="${id}"><thead><tr>${cols.map((c, i) => `<th data-t="${id}" data-c="${i}" class="${c[3] || ''}">${c[0]}${st.c === i ? (st.d ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
    <tbody>${list.map(r => `<tr>${cols.map(c => `<td class="${c[3] || ''}">${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
document.addEventListener('click', e => {
  const th = e.target.closest('th[data-t]'); if (!th) return;
  const id = th.dataset.t, c = +th.dataset.c; window.__sort = window.__sort || {};
  const cur = window.__sort[id] || {}; window.__sort[id] = { c, d: cur.c === c ? !cur.d : true };
  if (window.__rerender) window.__rerender();
});
function cards(items) { return `<div class="cards">${items.map(i => `<div class="card ${i[2] || ''}"><div class="cv">${i[1]}</div><div class="cl">${i[0]}</div></div>`).join('')}</div>`; }
/** Sélecteur de période (comme le tableau de bord du Sheet) */
const PERIODS = ['Aujourd\'hui', 'Hier', '7 derniers jours', 'Semaine en cours', '30 derniers jours', 'Mois en cours', 'Personnalisé'];
function period() {
  const p = JSON.parse(localStorage.getItem('periode') || 'null') || { sel: '7 derniers jours' }, t = today();
  let from = addDays(t, -6), to = t;
  switch (p.sel) {
    case 'Aujourd\'hui': from = t; break;
    case 'Hier': from = to = addDays(t, -1); break;
    case '30 derniers jours': from = addDays(t, -29); break;
    case 'Semaine en cours': from = mondayOf(t); break;
    case 'Mois en cours': from = t.slice(0, 8) + '01'; break;
    case 'Personnalisé': from = p.from || from; to = p.to || to; break;
  }
  return { sel: p.sel, from, to };
}
function periodBar(onchange) {
  const p = period();
  setTimeout(() => {
    const go = () => { const v = { sel: $('#psel').value, from: $('#pfrom').value, to: $('#pto').value }; localStorage.setItem('periode', JSON.stringify(v)); onchange(); };
    $('#psel').onchange = go; $('#pfrom').onchange = () => { $('#psel').value = 'Personnalisé'; go(); }; $('#pto').onchange = () => { $('#psel').value = 'Personnalisé'; go(); };
  });
  return `<div class="bar"><label>Période <select id="psel">${PERIODS.map(x => `<option ${x === p.sel ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>du <input type="date" id="pfrom" value="${p.from}"></label><label>au <input type="date" id="pto" value="${p.to}"></label>
    <span class="hint">Journées de travail (horaires des contrats)</span></div>`;
}
async function health() {
  try {
    const { data } = await sb.from('live_status').select('updated_at').order('updated_at', { ascending: false }).limit(1);
    const t = data && data[0] ? new Date(data[0].updated_at).getTime() : 0, m = t ? Math.round((Date.now() - t) / MIN) : null;
    const el = $('#health'); if (!el) return;
    el.className = 'health ' + (m === null ? 'crit' : m <= 2 * (S.P ? S.P.liveMin : 5) + 2 ? 'ok' : m <= 30 ? 'warn' : 'crit');
    el.title = 'Dernière collecte Geotab'; el.textContent = m === null ? 'Collecte : jamais' : 'Collecte : il y a ' + (m < 1 ? 'moins d\'1 min' : m < 120 ? m + ' min' : Math.round(m / 60) + ' h');
  } catch (e) { }
}

// ---------- EN DIRECT ----------
let MAP = null;
async function pageDirect() {
  const rows = await all('live_status', '*', null, ['plate']);
  const n = s => rows.filter(r => r.state === s).length, last = rows.reduce((m, r) => Math.max(m, new Date(r.updated_at || 0).getTime()), 0);
  const order = { 'En route': 0, 'Arrêté, contact mis': 1, 'Garé': 2, 'Boîtier hors ligne': 3 };
  rows.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || String(a.plate).localeCompare(String(b.plate)));
  $('#page').innerHTML = `
    <div class="head"><h1>En direct</h1><div class="sub">${last ? 'Mis à jour le ' + fmtDTY(last) + ', automatiquement toutes les ' + (S.P.liveMin || 5) + ' min.' : 'Aucune donnée pour l\'instant : le collecteur n\'a pas encore tourné.'}
      Les totaux du jour comptent les trajets terminés (contact coupé).</div>
      ${canEdit() ? '<button id="syncnow">Mettre à jour maintenant</button>' : ''}</div>
    ${cards([['En route', n('En route'), 'ok'], ['Arrêtés contact mis', n('Arrêté, contact mis'), n('Arrêté, contact mis') ? 'warn' : ''], ['Garés', n('Garé')],
      ['Boîtiers hors ligne', n('Boîtier hors ligne') + n('Pas de réponse Geotab'), n('Boîtier hors ligne') ? 'crit' : '']])}
    <div id="map"></div>
    ${table('tlive', [
      ['Plaque', r => plate(r.plate, S.veh[r.vehicle_key] && S.veh[r.vehicle_key].other_plates), r => r.plate],
      ['Modèle', r => esc(r.model)], ['État', r => badge(r.state, (STATE_CLS[r.state] || '') + ' dot'), r => order[r.state] ?? 9],
      ['Vitesse', r => r.speed ? f0(r.speed) + ' km/h' : '', r => r.speed, 'n'], ['Depuis', r => r.since_min != null ? fH(r.since_min / 60) : '', r => r.since_min, 'n'],
      ['Dernière position', r => fmtDT(r.last_pos_at), r => r.last_pos_at], ['Chauffeur sous contrat', r => esc(r.driver_name)], ['Contrat', r => esc(r.contract_num || '')],
      ['Km aujourd\'hui', r => f1(r.km_today), r => r.km_today, 'n'], ['Conduite', r => fH(r.drive_min_today / 60), r => r.drive_min_today, 'n'],
      ['Ralenti', r => fH(r.idle_min_today / 60), r => r.idle_min_today, 'n'], ['Carburant (L)', r => r.fuel_l_today === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l_today), r => r.fuel_l_today, 'n'],
      ['Alertes du jour', r => r.alerts_today ? `<a href="#/alertes?plaque=${encodeURIComponent(r.plate)}&jour=${today()}">${r.alerts_today}</a>` : '0', r => r.alerts_today, 'n'],
      ['Carte', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">Voir</a>` : '']], rows, { empty: 'Aucun véhicule actif' })}`;
  drawMap(rows);
  const b = $('#syncnow');
  if (b) b.onclick = async () => { b.disabled = true; try { await job('sync_now'); b.textContent = 'Demande envoyée (5 min max)'; } catch (e) { alert(e.message); b.disabled = false; } };
}
function drawMap(rows) {
  if (!window.L) return;
  if (MAP) { MAP.remove(); MAP = null; }
  const pts = rows.filter(r => r.lat != null && r.lon != null);
  MAP = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(MAP);
  const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
  const col = { 'En route': v('--ok'), 'Arrêté, contact mis': v('--warn'), 'Garé': v('--mute'), 'Boîtier hors ligne': v('--crit'), 'Pas de réponse Geotab': v('--crit') };
  pts.forEach(r => L.circleMarker([r.lat, r.lon], { radius: 8, color: '#fff', weight: 2, fillColor: col[r.state] || v('--mute'), fillOpacity: 1 })
    .bindPopup(`<b>${esc(r.plate)}</b><br>${esc(r.state)}${r.speed ? ' · ' + f0(r.speed) + ' km/h' : ''}<br>${esc(r.driver_name || '')}<br><small>${fmtDT(r.last_pos_at)}</small>`).addTo(MAP));
  if (pts.length) MAP.fitBounds(L.latLngBounds(pts.map(r => [r.lat, r.lon])).pad(0.2), { maxZoom: 13 }); else MAP.setView([31.63, -8.0], 6);
}

// ---------- TABLEAU DE BORD ----------
async function pageTableau() {
  const p = period(), P = S.P;
  const [jrn, ac, tne, top] = await Promise.all([
    all('journal', '*', q => q.gte('day', p.from).lte('day', p.to)),
    rpc('alert_counts', { p_from: p.from, p_to: p.to }),
    sb.from('fuel').select('id', { count: 'exact', head: true }).eq('type', 'TRAJET_NON_ENREGISTRE').gte('day', p.from).lte('day', p.to),
    sb.from('alerts').select('*').in('severity', ['Critique', 'Haute']).gte('day', p.from).lte('day', p.to).order('day', { ascending: false }).order('time', { ascending: false }).limit(25)]);
  const t = aggJournal(jrn, () => 'ALL', P).ALL || emptyAgg();
  const cnt = f => ac.filter(f).reduce((s, x) => s + x.n, 0);
  const crit = cnt(x => x.severity === 'Critique'), high = cnt(x => x.severity === 'Haute'), ntne = tne.count || 0;
  const byV = aggJournal(jrn, r => r.vehicle_key, P);
  const vrows = S.vehList.filter(v => v.active !== 'NON').map(v => ({ v, a: byV[v.key] || emptyAgg(), al: cnt(x => x.vehicle_key === v.key) }));
  const byD = aggJournal(jrn.filter(r => r.driver_code !== HORS), r => r.driver_code, P);
  const drows = Object.values(byD).map(a => { const sc = scoreOf(a, P); return { a, code: a.k, nom: S.drv[a.k] || Object.keys(a.names)[0] || a.k, score: sc, level: levelOf(sc, P) }; })
    .sort((x, y) => y.score - x.score || y.a.pts - x.a.pts).slice(0, 15);
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Tableau de bord</h1><div class="sub">Données mesurées par Geotab uniquement, « ${NM} » quand Geotab ne fournit pas la valeur.</div></div>
    ${periodBar(go)}
    ${cards([['Km parcourus', f0(t.km)], ['Carburant mesuré (L)', fuelVal(t)], ['Conso moyenne (L/100)', l100Val(t)], ['Heures de ralenti', fH(t.idle)],
      ['dont ralenti prolongé', fH(t.idleLong), t.idleLong ? 'crit' : ''], ['Arrêts moteur allumé prolongés', f0(t.nLong)], ['Carburant au ralenti (L)', t.idleFuelN ? f1(t.idleFuel) : NM]])}
    ${cards([['Pleins détectés', f0(t.fills)], ['Siphonages suspects', f0(t.siph), t.siph ? 'crit' : ''], ['Trajets non enregistrés (boîtier coupé)', f0(ntne), ntne ? 'crit' : ''],
      ['Km hors contrat', f1(t.kmHors), t.kmHors ? 'crit' : ''], ['Vmax flotte (km/h)', f0(t.vmax)], ['Coût carburant (MAD)', t.costN ? f0(t.cost) : '<span class="nm">prix non saisi</span>'],
      ['Alertes critiques', f0(crit), crit ? 'crit' : ''], ['Alertes hautes', f0(high)]])}
    <h2>Véhicules</h2>
    ${table('tveh', [
      ['Plaque', x => plate(x.v.plate), x => x.v.plate], ['Modèle', x => esc(x.v.model)], ['Contrats', x => Object.keys(x.a.ctr).length, null, 'n'],
      ['Heures sous contrat', x => fH(x.a.ctrH), x => x.a.ctrH, 'n'], ['Km', x => f1(x.a.km), x => x.a.km, 'n'], ['Conduite', x => fH(x.a.drive), x => x.a.drive, 'n'],
      ['Ralenti total', x => fH(x.a.idle), x => x.a.idle, 'n'], ['dont prolongé', x => fH(x.a.idleLong), x => x.a.idleLong, 'n'], ['Arrêts prolongés', x => x.a.nLong, null, 'n'],
      ['Carburant (L)', x => nmv(fuelVal(x.a)), x => x.a.fuel, 'n'], ['L/100 km', x => nmv(l100Val(x.a)), x => x.a.l100 || 0, 'n'], ['Source carburant', x => esc(srcTxt(x.a))],
      ['Coût carburant (MAD)', x => x.a.costN ? f0(x.a.cost) : '', x => x.a.cost, 'n'], ['Pleins', x => x.a.fills, null, 'n'], ['Vmax', x => f0(x.a.vmax), x => x.a.vmax, 'n'],
      ['Pire dépassement', x => x.a.worst === null ? '' : '+' + f0(x.a.worst), x => x.a.worst || 0, 'n'], ['Événements', x => x.a.evts, null, 'n'],
      ['Score /100 km', x => f1(scoreOf(x.a, P)), x => scoreOf(x.a, P), 'n'], ['Siphonages suspects', x => x.a.siph ? `<b class="red">${x.a.siph}</b>` : '0', x => x.a.siph, 'n'],
      ['Km hors contrat', x => x.a.kmHors ? `<b class="red">${f1(x.a.kmHors)}</b>` : '0', x => x.a.kmHors, 'n'], ['Alertes', x => x.al, null, 'n']], vrows)}
    <h2>Chauffeurs les plus dangereux <a class="more" href="#/chauffeurs">Voir le classement complet</a></h2>
    ${table('tdrv', [['Rang', (d) => drows.indexOf(d) + 1, null, 'n'], ['Chauffeur', d => `<b>${esc(d.nom)}</b>`, d => d.nom], ['Code', d => esc(d.code)],
      ['Niveau', d => badge(d.level, LEVEL_CLS[d.level]), d => d.score], ['Score /100 km', d => f1(d.score), d => d.score, 'n'], ['Événements', d => d.a.evts, null, 'n'],
      ['Km', d => f1(d.a.km), d => d.a.km, 'n'], ['Ralenti total', d => fH(d.a.idle), d => d.a.idle, 'n'], ['dont prolongé', d => fH(d.a.idleLong), d => d.a.idleLong, 'n'],
      ['Carburant (L)', d => nmv(fuelVal(d.a)), d => d.a.fuel, 'n'], ['L/100 km', d => nmv(l100Val(d.a)), d => d.a.l100 || 0, 'n'], ['Vmax', d => f0(d.a.vmax), d => d.a.vmax, 'n'],
      ['Siphonages suspects', d => d.a.siph, null, 'n']], drows)}
    <h2>Alertes critiques et hautes <a class="more" href="#/alertes">Voir toutes les alertes</a></h2>
    ${alertTable('tal', top.data || [], false)}`;
  };
  window.__rerender = render; render();
}
function go() { route(); }
function nmv(v) { return v === NM || v === 'km insuffisants' ? `<span class="nm">${v}</span>` : v; }
function alertTable(id, rows, editable) {
  return table(id, [['Date', a => fmtDay(a.day), a => a.day + (a.time || '')], ['Heure', a => esc(a.time || '')], ['Plaque', a => plate(a.plate), a => a.plate], ['Chauffeur', a => esc(a.driver_name || '')],
    ['Type', a => esc(a.type)], ['Gravité', a => badge(a.severity, GRAV_CLS[a.severity]), a => ({ Critique: 0, Haute: 1, Moyenne: 2, Info: 3 }[a.severity])],
    ['Valeur', a => esc(a.value || '')], ['Détail', a => linkify(a.detail), null, 'wide'],
    ['Statut', a => editable ? `<select data-al="${esc(a.id)}" class="alst">${['À traiter', 'En cours', 'Traité', 'Faux positif'].map(s => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : esc(a.status), a => a.status],
    ['Commentaire', a => editable ? `<input data-alc="${esc(a.id)}" class="alc" value="${esc(a.comment || '')}" placeholder="…">` : esc(a.comment || '')]], rows, { empty: 'Aucune alerte' });
}
function linkify(t) { return esc(t).replace(/(https:\/\/maps\.google\.com\/\?q=[0-9.,\-]+)/g, '<a target="_blank" rel="noopener" href="$1">carte</a>'); }

// ---------- DU JOUR ----------
async function pageJour() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''), day = qs.get('jour') || today(), P = S.P;
  const b = dayBounds(day), b0 = b.start.getTime(), b1 = b.end.getTime(), now = Date.now();
  const [jrn, al, idl] = await Promise.all([
    all('journal', '*', q => q.gte('day', addDays(day, -2)).lte('day', addDays(day, 1))),
    all('alerts', '*', q => q.eq('day', day), ['time']),
    all('idles', '*', q => q.gte('start_at', b.start.toISOString()).lt('start_at', b.end.toISOString()), ['start_at'])]);
  const rows = jrn.filter(r => { const st = r.contract_start ? new Date(r.contract_start).getTime() : 0; if (!st) return r.day === day;
    const en = r.contract_end ? new Date(r.contract_end).getTime() : now; return st < b1 && en > b0; });
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Journée du ${fmtDay(day)}</h1><div class="sub">Chaque ligne de contrat couvre toute la journée de travail, selon les horaires du contrat.</div></div>
    <div class="bar"><label>Date <input type="date" id="jday" value="${day}"></label><button class="ghost" id="jprev">Veille</button><button class="ghost" id="jnext">Lendemain</button></div>
    <h2>Journées de travail actives (de la plus dangereuse à la moins dangereuse)</h2>
    ${table('tjour', [['Plaque', r => plate(r.plate), r => r.plate], ['Chauffeur', r => esc(S.drv[r.driver_code] || r.driver_name)], ['Contrat', r => esc(r.contract_num || 'Hors contrat')],
      ['Début', r => fmtDT(r.contract_start), r => r.contract_start], ['Fin', r => r.contract_end ? fmtDT(r.contract_end) : (r.contract_num ? 'en cours' : '')],
      ['Km', r => f1(r.km), r => r.km, 'n'], ['Conduite', r => fH(r.drive_h), r => r.drive_h, 'n'], ['Ralenti', r => fH(r.idle_h), r => r.idle_h, 'n'],
      ['dont prolongé', r => fH(r.long_idle_h), r => r.long_idle_h, 'n'], ['Carburant (L)', r => r.fuel_l === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l), r => r.fuel_l, 'n'],
      ['L/100', r => r.l100 === null ? `<span class="nm">${r.fuel_l === null ? NM : 'km insuffisants'}</span>` : f1(r.l100), r => r.l100, 'n'], ['Vmax', r => f0(r.vmax), r => r.vmax, 'n'],
      ['Pire dépassement', r => r.worst_over === null ? '' : '+' + f0(r.worst_over), r => r.worst_over, 'n'], ['Événements', r => r.n_events, null, 'n'],
      ['Score', r => f1(r.score), r => r.score, 'n'], ['Niveau', r => r.driver_code === HORS ? '' : badge(levelOf(r.score, P), LEVEL_CLS[levelOf(r.score, P)]), r => r.score],
      ['Pleins', r => r.n_fills, null, 'n'], ['Siphonages', r => r.n_siphon ? `<b class="red">${r.n_siphon}</b>` : '0', r => r.n_siphon, 'n']],
      rows.sort((x, y) => y.score - x.score), { empty: 'Aucune journée de travail ce jour-là' })}
    <h2>Arrêts moteur allumé ≥ ${P.idleLongMin} min</h2>
    ${table('tidl', [['Début', r => fmtDT(r.start_at), r => r.start_at], ['Fin', r => fmtDT(r.end_at)], ['Durée arrêt', r => fH(r.stop_min / 60), r => r.stop_min, 'n'],
      ['Moteur tournant', r => r.engine_check === 'Régime moteur' ? fH(r.engine_min / 60) : 'non vérifiable', r => r.engine_min, 'n'], ['Plaque', r => plate(r.plate), r => r.plate],
      ['Chauffeur', r => esc(S.drv[r.driver_code] || r.driver_name || '')], ['Lieu', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">carte</a>` : '']], idl, { empty: 'Aucun arrêt prolongé' })}
    <h2>Alertes du jour</h2>${alertTable('tjal', al, false)}`;
    $('#jday').onchange = e => { location.hash = '#/jour?jour=' + e.target.value; };
    $('#jprev').onclick = () => { location.hash = '#/jour?jour=' + addDays(day, -1); };
    $('#jnext').onclick = () => { location.hash = '#/jour?jour=' + addDays(day, 1); };
  };
  window.__rerender = render; render();
}

// ---------- CHAUFFEURS ----------
async function pageChauffeurs() {
  const p = period(), P = S.P;
  const [jrn, rc] = await Promise.all([all('journal', '*', q => q.gte('day', p.from).lte('day', p.to).neq('driver_code', HORS)), rpc('driver_rule_counts', { p_from: p.from, p_to: p.to })]);
  const agg = aggJournal(jrn, r => r.driver_code, P), used = {}, byD = {};
  rc.forEach(x => { if (!agg[x.driver_code]) return; used[x.rule_id] = (used[x.rule_id] || 0) + x.n; (byD[x.driver_code] = byD[x.driver_code] || {})[x.rule_id] = x.n; });
  const ruleIds = Object.keys(used).sort((a, b) => used[b] - used[a]);
  const list = Object.values(agg).map(a => { const sc = scoreOf(a, P); return { a, code: a.k, nom: S.drv[a.k] || Object.keys(a.names)[0] || a.k, score: sc, level: levelOf(sc, P), rules: byD[a.k] || {} }; })
    .sort((x, y) => y.score - x.score || y.a.pts - x.a.pts);
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Classement des chauffeurs</h1><div class="sub">Score = points danger pour 100 km (poids des règles dans Réglages). Seuils : Modéré ${P.scoreY}, Élevé ${P.scoreO}, Dangereux ${P.scoreR}.</div></div>
    ${periodBar(go)}
    ${table('trank', [['Rang', d => list.indexOf(d) + 1, null, 'n'], ['Chauffeur', d => `<b>${esc(d.nom)}</b>`, d => d.nom], ['Code', d => esc(d.code)],
      ['Niveau', d => badge(d.level, LEVEL_CLS[d.level]), d => d.score], ['Score /100 km', d => f1(d.score), d => d.score, 'n'], ['Points danger', d => f1(d.a.pts), d => d.a.pts, 'n'],
      ['Événements', d => d.a.evts, null, 'n'], ['Journées', d => Object.keys(d.a.ctr).length || Object.keys(d.a.days).length, null, 'n'], ['Heures sous contrat', d => fH(d.a.ctrH), d => d.a.ctrH, 'n'],
      ['Km', d => f1(d.a.km), d => d.a.km, 'n'], ['Conduite', d => fH(d.a.drive), d => d.a.drive, 'n'], ['Ralenti total', d => fH(d.a.idle), d => d.a.idle, 'n'],
      ['dont prolongé', d => fH(d.a.idleLong), d => d.a.idleLong, 'n'], ['Carburant (L)', d => nmv(fuelVal(d.a)), d => d.a.fuel, 'n'], ['L/100 km', d => nmv(l100Val(d.a)), d => d.a.l100 || 0, 'n'],
      ['Vmax', d => f0(d.a.vmax), d => d.a.vmax, 'n'], ['Pire dépassement', d => d.a.worst === null ? '' : '+' + f0(d.a.worst), d => d.a.worst || 0, 'n']]
      .concat(ruleIds.map(id => [esc((S.rules[id] || {}).name || id) + ` <span class="small">×${(S.rules[id] || {}).weight || ''}</span>`, d => d.rules[id] || 0, d => d.rules[id] || 0, 'n']))
      .concat([['Pleins', d => d.a.fills, null, 'n'], ['Siphonages suspects', d => d.a.siph, null, 'n'], ['Véhicules', d => esc(Object.keys(d.a.plates).join(', '))]]), list)}`;
  };
  window.__rerender = render; render();
}

// ---------- ALERTES ----------
async function pageAlertes() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''), p = period();
  const from = qs.get('jour') || p.from, to = qs.get('jour') || p.to;
  const rows = await all('alerts', '*', q => q.gte('day', from).lte('day', to), ['day', false]);
  const f = JSON.parse(localStorage.getItem('fal') || '{}'); if (qs.get('plaque')) f.plate = qs.get('plaque');
  const types = [...new Set(rows.map(r => r.type))].sort();
  const render = () => {
    const list = rows.filter(r => (!f.sev || r.severity === f.sev) && (!f.st || r.status === f.st) && (!f.type || r.type === f.type) && (!f.plate || normPlate(r.plate) === normPlate(f.plate)));
    $('#page').innerHTML = `<div class="head"><h1>Alertes</h1><div class="sub">${list.length} alertes sur ${rows.length}${qs.get('jour') ? ' le ' + fmtDay(qs.get('jour')) : ''}. ${canEdit() ? 'Statut et commentaire enregistrés automatiquement.' : ''}</div></div>
    ${qs.get('jour') ? '' : periodBar(go)}
    <div class="bar"><label>Gravité <select id="fsev"><option value="">Toutes</option>${['Critique', 'Haute', 'Moyenne', 'Info'].map(x => `<option ${f.sev === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Statut <select id="fst"><option value="">Tous</option>${['À traiter', 'En cours', 'Traité', 'Faux positif'].map(x => `<option ${f.st === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Type <select id="ftype"><option value="">Tous</option>${types.map(x => `<option ${f.type === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>Plaque <input id="fplate" value="${esc(f.plate || '')}" size="10"></label></div>
    ${alertTable('talall', list, canEdit())}`;
    const set = (k, v) => { f[k] = v; const s = Object.assign({}, f); delete s.plate; localStorage.setItem('fal', JSON.stringify(s)); render(); };
    $('#fsev').onchange = e => set('sev', e.target.value); $('#fst').onchange = e => set('st', e.target.value); $('#ftype').onchange = e => set('type', e.target.value);
    $('#fplate').onchange = e => set('plate', e.target.value);
    document.querySelectorAll('.alst').forEach(s => { s.onchange = () => saveAlert(s.dataset.al, { status: s.value }, rows); });
    document.querySelectorAll('.alc').forEach(s => { s.onchange = () => saveAlert(s.dataset.alc, { comment: s.value }, rows); });
  };
  window.__rerender = render; render();
}
async function saveAlert(id, patch, rows) {
  const { error } = await sb.from('alerts').update(patch).eq('id', id);
  if (error) { alert('Non enregistré : ' + error.message); return; }
  const r = rows.find(x => x.id === id); if (r) Object.assign(r, patch);
  // Siphonage marqué faux positif : la ligne carburant aussi (retiré des journées de travail au prochain calcul)
  if (patch.status && /^SIPH\|/.test(id)) {
    await sb.from('fuel').update({ status: patch.status === 'Faux positif' ? 'Faux positif' : 'À vérifier' }).eq('id', id.slice(5));
    await job('recompute', addDays(today(), -31)).catch(() => { });
  }
}

// ---------- CONTRATS ----------
async function pageContrats() {
  const recent = await all('contracts', '*', q => q.gte('start_at', new Date(Date.now() - 40 * DAY).toISOString()), ['start_at', false]);
  const jobs = (await sb.from('jobs').select('*').eq('kind', 'after_inject').order('id', { ascending: false }).limit(5)).data || [];
  let search = '';
  const render = () => {
    const s = normTxt(search), list = recent.filter(c => !s || normTxt([c.num, c.name, c.plate, c.client_code].join(' ')).includes(s));
    $('#page').innerHTML = `<div class="head"><h1>Contrats</h1><div class="sub">Importez l'extract du jour : chauffeurs, données Geotab, journal et alertes se mettent à jour tout seuls (5 min max).</div></div>
    ${canEdit() ? `<div class="panel"><label class="file">Extract des contrats (.xlsx, .xls, .csv) <input type="file" id="cfile" accept=".xlsx,.xls,.csv"></label><div id="cres"></div></div>` : ''}
    ${jobs.length ? `<h2>Derniers calculs après import</h2>${table('tjobs', [['Demandé le', j => fmtDTY(j.created_at)], ['Terminé le', j => j.done_at ? fmtDTY(j.done_at) : '<span class="badge warn">en attente du collecteur</span>'],
      ['Résultat', j => esc(j.result || ''), null, 'wide']], jobs)}` : ''}
    <h2>Contrats des 40 derniers jours <input id="csearch" placeholder="Rechercher (nom, plaque, n°…)" value="${esc(search)}"></h2>
    ${table('tctr', [['N° contrat', c => esc(c.num)], ['Chauffeur', c => `<b>${esc(c.name)}</b>`, c => c.name], ['Code', c => esc(c.client_code)], ['Plaque', c => plate(c.plate), c => c.plate],
      ['Véhicule', c => S.veh[c.vehicle_key] ? plate(S.veh[c.vehicle_key].plate) : `<span class="badge high">inconnu</span>`, c => c.vehicle_key], ['Début', c => fmtDTY(c.start_at), c => c.start_at],
      ['Fin', c => c.end_at ? fmtDTY(c.end_at) : 'en cours', c => c.end_at || 'z'], ['Statut', c => esc(c.status || '')], ['Téléphone', c => esc(c.phone || '')]], list.slice(0, 500))}`;
    const fi = $('#cfile'); if (fi) fi.onchange = () => importFile(fi.files[0]);
    const cs = $('#csearch'); cs.oninput = () => { search = cs.value; const pos = cs.selectionStart; render(); const n = $('#csearch'); n.focus(); n.setSelectionRange(pos, pos); };
  };
  window.__rerender = render; render();
}
async function importFile(file) {
  const out = $('#cres'); if (!file) return;
  out.innerHTML = msg('Lecture du fichier…');
  try {
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '', dateNF: 'dd/mm/yyyy hh:mm' });
    const pc = await all('plate_changes', 'old_plate,new_plate'), cm = buildCanonMap(S.vehList, pc);
    const res = parseContracts(rows, cm);
    out.innerHTML = msg('Comparaison avec les contrats déjà importés…');
    const old = {}, nums = res.rows.map(r => r.num);
    for (let i = 0; i < nums.length; i += 150) {
      const { data, error } = await sb.from('contracts').select('*').in('num', nums.slice(i, i + 150)); if (error) throw error;
      data.forEach(c => { old[c.num] = c; });
    }
    const now = new Date().toISOString(), up = [];
    let added = 0, updated = 0, same = 0, minStart = null;
    res.rows.forEach(r => {
      const o = old[r.num];
      if (o && ctrSig(o) === ctrSig(r)) { same++; return; }
      if (o) { updated++; if (!minStart || o.start_at < minStart) minStart = o.start_at; } else added++;
      if (!minStart || r.start_at < minStart) minStart = r.start_at;
      up.push(Object.assign(r, { imported_at: o ? (o.imported_at || now) : now, updated_at: now }));
    });
    for (let i = 0; i < up.length; i += 500) { const { error } = await sb.from('contracts').upsert(up.slice(i, i + 500), { onConflict: 'num' }); if (error) throw error; }
    const unknown = [...new Set(res.rows.filter(r => !S.veh[r.vehicle_key]).map(r => r.plate))];
    let j = null;
    if (up.length) j = await job('after_inject', localDay(minStart));
    out.innerHTML = msg(`<b>Contrats lus : ${res.read}</b>, dont ${added} nouveaux, ${updated} mis à jour, ${same + res.dup} déjà à jour${res.invalid ? ', ' + res.invalid + ' lignes invalides' : ''}.<br>` +
      (j ? 'Calcul automatique demandé : chauffeurs, trajets, journal et alertes à jour dans 5 minutes maximum. Rien d\'autre à faire.' : 'Aucun changement.') +
      (unknown.length ? `<br><b>Plaques non reconnues (${unknown.length}) :</b> ${unknown.map(esc).join(', ')}<br>Si c'est une nouvelle plaque d'un véhicule existant, ajoutez-la dans <a href="#/plaques">Plaques</a> : les contrats seront rattachés automatiquement.` : ''), unknown.length ? 'warn' : 'ok');
  } catch (e) { out.innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); }
}

// ---------- PLAQUES ----------
async function pagePlaques() {
  const rows = await all('plate_changes', '*', null, ['id', false]);
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Changements de plaque</h1><div class="sub">Ancienne plaque (WW / W18) et plaque définitive : l'historique reste rattaché au même véhicule et les contrats saisis avec l'une ou l'autre plaque sont reconnus.</div></div>
    ${canEdit() ? `<div class="panel row"><label>Ancienne plaque <input id="pold" placeholder="WW968199"></label><label>Plaque définitive <input id="pnew" placeholder="86121-T-1"></label>
      <label>Date du changement <input type="date" id="pdate"></label><label>Note <input id="pnote"></label><button id="padd">Ajouter</button></div>` : ''}
    ${table('tpl', [['Ancienne plaque', r => plate(r.old_plate), r => r.old_plate], ['Plaque définitive', r => plate(r.new_plate), r => r.new_plate],
      ['Date', r => fmtDay(r.changed_on), r => r.changed_on], ['Véhicule', r => esc(r.vehicle || '')], ['État', r => esc(r.status || 'Pris en compte au prochain passage du collecteur (5 min max)'), null, 'wide'],
      ['Note', r => esc(r.note || '')], ['', r => canEdit() ? `<button class="ghost small" data-del="${r.id}">Supprimer</button>` : '']], rows, { empty: 'Aucun changement de plaque saisi' })}`;
    const add = $('#padd');
    if (add) add.onclick = async () => {
      const o = $('#pold').value.trim().toUpperCase(), n = $('#pnew').value.trim().toUpperCase();
      if (normPlate(o).length < 4 || normPlate(n).length < 4) { alert('Saisissez l\'ancienne ET la nouvelle plaque.'); return; }
      const { data, error } = await sb.from('plate_changes').insert({ old_plate: o, new_plate: n, changed_on: $('#pdate').value || null, note: $('#pnote').value || null }).select().single();
      if (error) { alert(error.message); return; }
      rows.unshift(data); await job('apply_plates').catch(e => alert(e.message)); render();
    };
    document.querySelectorAll('[data-del]').forEach(b => { b.onclick = async () => {
      if (!confirm('Supprimer ce changement de plaque ?')) return;
      const { error } = await sb.from('plate_changes').delete().eq('id', b.dataset.del); if (error) { alert(error.message); return; }
      rows.splice(rows.findIndex(r => String(r.id) === b.dataset.del), 1); await job('apply_plates').catch(() => { }); render(); }; });
  };
  window.__rerender = render; render();
}

// ---------- VÉHICULES ----------
async function pageVehicules() {
  await loadRef(true);
  const rows = S.vehList;
  const ed = (v, c, w) => isAdmin() ? `<input class="ved" data-k="${esc(v.key)}" data-c="${c}" value="${esc(v[c] == null ? '' : v[c])}" size="${w || 6}">` : esc(v[c] == null ? '' : v[c]);
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Véhicules</h1><div class="sub">Liste importée chaque jour du Sheet « ETAT PARC » et associée aux boîtiers Geotab. ${isAdmin() ? 'Réservoir, conso de référence, recette et Actif modifiables ici.' : ''}</div></div>
    ${table('tvh', [['Plaque', v => plate(v.plate), v => v.plate], ['Autres plaques', v => esc(v.other_plates || '')], ['Marque', v => esc(v.brand || '')], ['Modèle', v => esc(v.model || '')],
      ['Carburant', v => esc(v.fuel || '')], ['VIN', v => esc(v.vin || '')], ['Boîtier Geotab', v => v.geotab_id ? esc(v.geotab_name || v.geotab_id) : '<span class="badge high">non associé</span>'],
      ['Réservoir (L)', v => ed(v, 'tank_l', 4)], ['Conso réf (L/100)', v => ed(v, 'ref_l100', 4)], ['Recette/contrat (MAD)', v => ed(v, 'revenue', 6)], ['Actif', v => ed(v, 'active', 3)],
      ['Dernière finalisation', v => fmtDTY(v.last_sync), v => v.last_sync]], rows)}`;
    document.querySelectorAll('.ved').forEach(i => { i.onchange = async () => {
      const c = i.dataset.c, val = c === 'active' ? (i.value.toUpperCase() === 'NON' ? 'NON' : 'OUI') : (i.value === '' ? null : num(i.value, null));
      const { error } = await sb.from('vehicles').update({ [c]: val }).eq('key', i.dataset.k); if (error) alert(error.message); else i.classList.add('saved'); }; });
  };
  window.__rerender = render; render();
}

// ---------- RÉGLAGES (admin) ----------
async function pageReglages() {
  const [params, rules, users, logs, jobs] = await Promise.all([all('params', '*', null, ['sort']), all('rules', '*', null, ['weight', false]), all('profiles', '*', null, ['created_at']),
    sb.from('logs').select('*').order('id', { ascending: false }).limit(150), sb.from('jobs').select('*').order('id', { ascending: false }).limit(30)]);
  const hidden = { geoServer: 1, geoUser: 1, geoDb: 1 };
  $('#page').innerHTML = `<div class="head"><h1>Réglages</h1></div>
    <h2>Utilisateurs</h2><div class="sub">Les nouveaux comptes attendent votre validation (rôle « En attente »). Gestionnaire = import des contrats, plaques, statut des alertes. Lecture seule = consultation.</div>
    ${table('tusr', [['Email', u => esc(u.email)], ['Créé le', u => fmtDTY(u.created_at)], ['Rôle', u => u.user_id === S.session.user.id ? ROLE_TXT[u.role] :
      `<select class="urole" data-u="${u.user_id}">${Object.keys(ROLE_TXT).map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_TXT[r]}</option>`).join('')}</select>`]], users)}
    <h2>Actions</h2><div class="panel row">
      <label>Recalculer chauffeurs, journal et alertes depuis le <input type="date" id="rcfrom" value="${addDays(today(), -7)}"></label><button id="rcgo">Recalculer</button>
      <label>Retélécharger depuis Geotab du <input type="date" id="rsfrom" value="${addDays(today(), -2)}"></label><label>au <input type="date" id="rsto" value="${addDays(today(), -1)}"></label><button id="rsgo">Retélécharger</button>
      <button id="vhgo" class="ghost">Réimporter les véhicules du Parc</button></div><div id="actres"></div>
    <h2>Paramètres</h2>
    ${table('tpar', [['Paramètre', p => esc(p.label)], ['Valeur', p => `<input class="ped" data-k="${esc(p.key)}" value="${esc(p.value == null ? '' : p.value)}" size="22">`], ['Note', p => esc(p.note || ''), null, 'wide']], params.filter(p => !hidden[p.key]))}
    <h2>Règles Geotab (poids dans le score de danger)</h2>
    ${table('trul', [['Règle', r => esc(r.name)], ['Catégorie', r => esc(r.category || '')], ['Poids', r => `<input class="red_" data-k="${esc(r.id)}" value="${esc(r.weight)}" size="4">`, r => r.weight], ['Note', r => esc(r.note || ''), null, 'wide']], rules)}
    <h2>Demandes au collecteur</h2>
    ${table('tjob', [['Demande', j => esc(j.kind) + (j.arg ? ' (' + esc(j.arg) + ')' : '')], ['Le', j => fmtDTY(j.created_at)], ['Terminée', j => j.done_at ? fmtDTY(j.done_at) : '<span class="badge warn">en attente</span>'], ['Résultat', j => esc(j.result || ''), null, 'wide']], jobs.data || [])}
    <h2>Journal technique</h2>
    ${table('tlog', [['Le', l => fmtDTY(l.at)], ['Action', l => esc(l.action)], ['Détail', l => esc(l.detail), null, 'wide'], ['Durée (s)', l => l.dur_s == null ? '' : f1(l.dur_s), null, 'n']], logs.data || [])}`;
  document.querySelectorAll('.urole').forEach(s => { s.onchange = async () => { const { error } = await sb.from('profiles').update({ role: s.value }).eq('user_id', s.dataset.u); if (error) alert(error.message); else s.classList.add('saved'); }; });
  document.querySelectorAll('.ped').forEach(i => { i.onchange = async () => { const { error } = await sb.from('params').update({ value: i.value }).eq('key', i.dataset.k); if (error) alert(error.message); else { i.classList.add('saved'); S.P = null; await loadRef(); } }; });
  document.querySelectorAll('.red_').forEach(i => { i.onchange = async () => { const { error } = await sb.from('rules').update({ weight: num(i.value) }).eq('id', i.dataset.k); if (error) alert(error.message); else { i.classList.add('saved'); await job('recompute', addDays(today(), -31)); } }; });
  const done = t => { $('#actres').innerHTML = msg(t + ' Le collecteur s\'en charge dans 5 minutes maximum (suivi ci-dessous).', 'ok'); };
  $('#rcgo').onclick = async () => { await job('recompute', $('#rcfrom').value); done('Recalcul demandé.'); };
  $('#rsgo').onclick = async () => { await job('resync', $('#rsfrom').value + '|' + $('#rsto').value); done('Retéléchargement demandé.'); };
  $('#vhgo').onclick = async () => { await job('import_vehicles'); done('Import des véhicules demandé.'); };
}

// ---------- Connexion ----------
function loginView(info) {
  $('#app').innerHTML = `<div class="login"><div class="lbox">${BRAND}
    <form id="lf"><label>Email<input type="email" id="le" required autocomplete="username"></label>
    <label>Mot de passe<input type="password" id="lp" required autocomplete="current-password" minlength="6"></label>
    <button type="submit">Se connecter</button>
    <div class="lrow"><a href="#" id="lsignup">Créer un compte</a><a href="#" id="lforgot">Mot de passe oublié</a></div></form><div id="lmsg">${info || ''}</div></div></div>`;
  const out = t => { $('#lmsg').innerHTML = t; };
  $('#lf').onsubmit = async e => { e.preventDefault(); out(''); const { error } = await sb.auth.signInWithPassword({ email: $('#le').value, password: $('#lp').value });
    if (error) out(msg(/Invalid login/.test(error.message) ? 'Email ou mot de passe incorrect.' : /confirm/i.test(error.message) ? 'Confirmez d\'abord votre email (lien reçu par mail).' : esc(error.message), 'err')); };
  $('#lsignup').onclick = async e => { e.preventDefault(); if (!$('#le').value || $('#lp').value.length < 6) { out(msg('Saisissez un email et un mot de passe (6 caractères minimum), puis cliquez « Créer un compte ».', 'warn')); return; }
    const { data, error } = await sb.auth.signUp({ email: $('#le').value, password: $('#lp').value, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) out(msg(esc(error.message), 'err')); else out(msg(data.session ? 'Compte créé.' : 'Compte créé : cliquez sur le lien reçu par email pour le confirmer, puis connectez-vous.', 'ok')); };
  $('#lforgot').onclick = async e => { e.preventDefault(); if (!$('#le').value) { out(msg('Saisissez votre email puis cliquez « Mot de passe oublié ».', 'warn')); return; }
    const { error } = await sb.auth.resetPasswordForEmail($('#le').value, { redirectTo: location.origin + location.pathname });
    out(error ? msg(esc(error.message), 'err') : msg('Email envoyé : suivez le lien pour choisir un nouveau mot de passe.', 'ok')); };
}
function pendingView() {
  $('#app').innerHTML = `<div class="login"><div class="lbox">${BRAND}
    ${msg('Votre compte (' + esc(S.profile ? S.profile.email : '') + ') est créé. Il doit être validé par l\'administrateur avant de voir les données.', 'warn')}
    <button id="lout" class="ghost">Déconnexion</button></div></div>`;
  $('#lout').onclick = () => sb.auth.signOut();
}

// ---------- Navigation ----------
const PAGES = { direct: pageDirect, tableau: pageTableau, jour: pageJour, chauffeurs: pageChauffeurs, alertes: pageAlertes, contrats: pageContrats, plaques: pagePlaques, vehicules: pageVehicules, reglages: pageReglages };
let ROUTING = 0;
async function route() {
  const my = ++ROUTING;
  S.timers.forEach(clearInterval); S.timers = [];
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
  if (!S.session) { loginView(); return; }
  if (!S.profile) { const { data } = await sb.from('profiles').select('*').eq('user_id', S.session.user.id).maybeSingle(); S.profile = data || { email: S.session.user.email, role: 'pending' }; }
  if (S.profile.role === 'pending') { pendingView(); return; }
  try { await loadRef(); } catch (e) { $('#app').innerHTML = msg('Base inaccessible : ' + esc(e.message), 'err'); return; }
  let page = shell(); if (!PAGES[page] || (page === 'reglages' && !isAdmin())) page = 'direct';
  window.__rerender = null;
  try { await PAGES[page](); } catch (e) { if (my === ROUTING) $('#page').innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); }
  if (my !== ROUTING) return;
  S.timers.push(setInterval(health, 60000));
  if (page === 'direct') {
    S.timers.push(setInterval(() => { if (!document.hidden && my === ROUTING) pageDirect().catch(() => { }); }, 60000));
    S.channel = sb.channel('live').on('postgres_changes', { event: '*', schema: 'public', table: 'live_status' }, () => { clearTimeout(window.__lt); window.__lt = setTimeout(() => { if (my === ROUTING) pageDirect().catch(() => { }); }, 3000); }).subscribe();
  }
}
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange(async (ev, session) => {
  if (ev === 'PASSWORD_RECOVERY') {
    const p = prompt('Nouveau mot de passe (6 caractères minimum) :');
    if (p) { const { error } = await sb.auth.updateUser({ password: p }); alert(error ? error.message : 'Mot de passe changé.'); }
  }
  const changed = (S.session && S.session.user.id) !== (session && session.user.id);
  S.session = session; if (changed) { S.profile = null; S.P = null; route(); }
});
sb.auth.getSession().then(({ data }) => { S.session = data.session; route(); });
