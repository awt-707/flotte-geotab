// Courses Uber suspectes (22/11/2026, demande d'Ahmed, « très important ») : chauffeur « En route vers le lieu de prise en charge » (vert)
// qui passe ensuite « Disponible » (gris) ou hors ligne / disparu de l'écran sans « Course en cours » : il a pu demander au client d'annuler
// puis le prendre en cachette. La base crée le cas (table uber_suspects, déclencheur sur uber_live_log) ; ici : alerte rouge en temps réel
// sur toutes les pages (temps réel Supabase + relecture toutes les 30 s), seconde alerte quand le collecteur a mesuré que le véhicule a
// roulé sans course Uber (km Geotab dans les suspectWinMin minutes qui suivent), page #/suspects (tableau, par chauffeur, annulation Uber
// rapprochée, classement À vérifier / Justifié / Confirmé, PDF, tableur), et marque sur la fiche du véhicule d'En direct.
const PS = { rows: [], at: 0, timer: 0, toasts: {}, primed: false, me: null, busy: false };
const PS_NEXT = { available: 'Disponible', offline: 'Hors ligne', gone: 'Hors ligne (disparu de l\'écran)' };
function psCan() { return !!(S.session && S.profile && ['admin', 'manager', 'viewer'].includes(S.profile.role)) && !MOBILE; }
function psNext(st) { return PS_NEXT[st] || st || ''; }
function psDur(a, b) { const ms = new Date(b).getTime() - new Date(a).getTime(); return typeof svDur === 'function' ? svDur(ms) : Math.round(ms / 60000) + ' min'; }
/** Texte des km mesurés par le collecteur */
function psKmTxt(r) {
  if (r.km_after == null) return r.km_done ? 'non mesuré' : 'mesure en cours';
  const fr = x => String(x).replace('.', ',');
  return fr(r.km_free != null ? r.km_free : r.km_after) + ' km hors course Uber' + (r.km_free != null && r.km_after != null && r.km_after !== r.km_free ? ' (' + fr(r.km_after) + ' km en tout)' : '') + (r.km_done ? '' : ' · mesure en cours');
}
function psVerdict(r) {
  if (r.verdict === 'roulé') return '<span class="badge crit">A roulé sans course Uber</span>';
  if (r.verdict === 'course réalisée') return '<span class="badge ok">Course Uber réalisée</span>';
  if (r.verdict === 'sur place') return '<span class="badge ok">Resté sur place</span>';
  if (r.verdict === 'non mesuré') return '<span class="badge">Non mesuré</span>';
  return '<span class="badge info">Mesure en cours</span>';
}
/** Un cas affiché sur En direct : mesure en cours, ou « a roulé » corroboré par une annulation Uber ; course réalisée / sur place / non mesuré / roulé sans annulation = classé, masqué */
function psOpen(r) { return r.level === 'Suspect' && (!r.verdict || (r.verdict === 'roulé' && r.cx_status)); }
function psSeen(k) { try { return !!JSON.parse(localStorage.getItem('psSeen') || '{}')[k]; } catch (e) { return false; } }
function psMark(k) { try { const o = JSON.parse(localStorage.getItem('psSeen') || '{}'); o[k] = Date.now(); Object.keys(o).forEach(x => { if (Date.now() - o[x] > 2 * 86400000) delete o[x]; }); localStorage.setItem('psSeen', JSON.stringify(o)); } catch (e) { } }
async function psLoad(sinceMs) {
  const { data, error } = await sb.from('uber_suspects').select('*').gte('next_at', new Date(Date.now() - sinceMs).toISOString()).order('next_at', { ascending: false }).limit(300);
  if (error) throw error;
  return data || [];
}
/** Veille sur toutes les pages : temps réel (création, verdict) + relecture toutes les 30 s */
function psWatch() {
  if (!psCan()) return;
  if (PS.me !== S.session.user.id) { PS.me = S.session.user.id; PS.rows = []; PS.primed = false; Object.values(PS.toasts).forEach(t => t.remove()); PS.toasts = {}; }
  if (!S.suspCh) {
    try {
      S.suspCh = sb.channel('suspects').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'uber_suspects' }, p => psOnRow(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'uber_suspects' }, p => psOnRow(p.new)).subscribe();
    } catch (e) { S.suspCh = null; }
  }
  if (!PS.timer) { PS.timer = setInterval(psTick, 30000); psTick(); }
}
async function psTick() {
  if (PS.busy || !psCan()) return;
  PS.busy = true;
  try { const rows = await psLoad(3 * 3600000); rows.forEach(r => psOnRow(r, true)); PS.primed = true; PS.at = Date.now(); psPaintLive(); }
  catch (e) { } finally { PS.busy = false; }
}
/** Nouveau cas ou cas mis à jour (verdict) : alerte si pas encore vue ; à l'ouverture, cas de plus de 10 min pas rejoués */
function psOnRow(r, quiet) {
  if (!r || !r.id) return;
  const ok = inAgency()(r.vehicle_key) || (!r.vehicle_key && (!agFilter() || String(r.agency_id) === agFilter()));
  const i = PS.rows.findIndex(x => x.id === r.id); if (i >= 0) PS.rows[i] = r; else PS.rows.unshift(r);
  if (!ok) return;
  const old = !PS.primed && Date.now() - new Date(r.next_at).getTime() > 10 * 60000;
  // 23/11/2026 : plus de notification à la création (beaucoup de cas sont de vraies courses, « Course en cours » ratée en direct) ;
  // l'alerte part seulement au verdict « a roulé sans course Uber » confirmé par le collecteur ET corroboré par une annulation Uber
  // (le vrai motif : le client annule, le chauffeur le prend en cachette). Les « roulé » sans annulation restent au tableau, sans alerte.
  if (r.verdict === 'roulé' && r.cx_status && !psSeen('r' + r.id)) { if (old && !PS.primed) psMark('r' + r.id); else psToast(r, 'roule'); }
  if (pageOf() === 'suspects' && typeof window.__psRepaint === 'function') window.__psRepaint();
}
async function psGeo(key) {
  if (!key) return '';
  try { const { data } = await sb.from('live_status').select('state,speed').eq('vehicle_key', key).maybeSingle(); return data ? data.state + (data.state === 'En route' ? ' à ' + data.speed + ' km/h' : '') : ''; } catch (e) { return ''; }
}
function psBody(r) {
  return `<div><b>${esc(r.driver_name || 'Chauffeur Uber')}</b> ${r.plate ? plate(r.plate) : ''}</div>
    <div class="small">En route vers le client de ${esc(localHM(new Date(r.route_from)))} à ${esc(localHM(new Date(r.route_to)))} (${esc(psDur(r.route_from, r.route_to))}), puis <b>${esc(psNext(r.next_status))}</b> sans course en cours${r.lat != null ? ` · <a href="${esc(osmUrl(r.lat, r.lng))}" target="_blank" rel="noopener">lieu</a>` : ''}</div>
    <div class="small">Km Geotab après : <b>${esc(psKmTxt(r))}</b>${r.geo ? ' · GPS : ' + esc(r.geo) : ''}</div>${r.cx_status ? `<div class="small"><b>Annulation Uber par le ${esc(r.cx_status)}</b></div>` : ''}`;
}
async function psToast(r, kind) {
  const k = (kind === 'roule' ? 'r' : 'n') + r.id; psMark(k);
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const prev = PS.toasts['n' + r.id]; if (prev && kind === 'roule') prev.remove();
  r.geo = await psGeo(r.vehicle_key);
  const t = document.createElement('div'); t.className = 'toast crit pstoast'; t.dataset.k = k;
  t.innerHTML = `<button class="x" aria-label="Fermer">×</button><b>${kind === 'roule' ? '🔴 A ROULÉ SANS COURSE UBER' : '🚩 COURSE SUSPECTE'}</b><div class="psbody">${psBody(r)}</div>
    <div class="row pfact"><a class="btn small" href="#/suspects">Tableau des cas</a><button class="small ghost" data-a="ok">Vu</button></div>`;
  const close = () => { delete PS.toasts[k]; t.remove(); };
  t.querySelector('.x').onclick = close; t.querySelector('[data-a="ok"]').onclick = close;
  box.prepend(t); PS.toasts[k] = t;
  if (typeof svBeep === 'function') svBeep();
  try { if (document.hidden && window.Notification && Notification.permission === 'granted') {
    const n = new Notification('Ludy · ' + (kind === 'roule' ? 'a roulé sans course Uber' : 'course suspecte'), { body: (r.driver_name || '') + (r.plate ? ' · ' + r.plate : '') + ' · ' + psNext(r.next_status) + ' à ' + localHM(new Date(r.next_at)), tag: k, requireInteraction: true, icon: 'icon-192.png' });
    n.onclick = () => { try { window.focus(); } catch (e) { } n.close(); }; } } catch (e) { }
}
/** Fiche véhicule d'En direct : cas des 3 dernières heures */
function psVehLine(key) {
  const r = PS.rows.find(x => x.vehicle_key === key && psOpen(x) && Date.now() - new Date(x.next_at).getTime() < 3 * 3600000); if (!r) return '';
  return `<span class="vc-susp${r.verdict === 'roulé' ? ' crit' : ''}">🚩 Course suspecte ${esc(localHM(new Date(r.next_at)))} · ${esc(psNext(r.next_status))} après ${esc(psDur(r.route_from, r.route_to))} en route · ${esc(psKmTxt(r))}</span>`;
}
/** En direct : bloc des cas du moment (3 h) */
function psDirectHtml() {
  const ok = inAgency(), L = PS.rows.filter(r => psOpen(r) && Date.now() - new Date(r.next_at).getTime() < 3 * 3600000 && (ok(r.vehicle_key) || !r.vehicle_key));
  if (!L.length) return '';
  return `<details class="pfdet" open><summary>🚩 Courses suspectes (3 dernières heures) : ${L.length}</summary><div class="pslist">${L.map(r => `<div class="pscard${r.verdict === 'roulé' ? ' crit' : ''}">${psBody(r)}</div>`).join('')}
    <p class="small"><a href="#/suspects">Tableau complet, classement et PDF</a></p></div></details>`;
}
function psPaintLive() { const el = $('#livesusp'); if (el) el.innerHTML = psDirectHtml(); if (pageOf() === 'direct' && typeof liveRows === 'function' && $('#vlist')) { try { $('#vlist').innerHTML = vcardsHtml(liveRows()); } catch (e) { } } }

// ---------- Page #/suspects ----------
/** Annulation Uber rapprochée (rapport « Activité des courses » importé) : demande dans les 10 min avant le début de « en route » jusqu'à la fin */
function psCancelOf(r, trips) {
  const a = new Date(r.route_from).getTime() - 10 * 60000, b = new Date(r.route_to).getTime() + 60000;
  const c = (trips || []).filter(t => t.vehicle_key === r.vehicle_key && t.status !== 'completed' && t.requested_at && new Date(t.requested_at).getTime() >= a && new Date(t.requested_at).getTime() <= b)
    .sort((x, y) => new Date(y.requested_at) - new Date(x.requested_at))[0];
  return c ? { kind: c.status === 'rider_cancelled' ? 'client' : c.status === 'driver_cancelled' ? 'chauffeur' : c.status, t: c } : null;
}
async function pageSuspects() {
  const rid = ROUTING, q = qs(), p = period(), ok = inAgency(), lvl = q.get('l') || 'Suspect', drv = q.get('d') || '';
  const from = new Date(p.from + 'T00:00:00'), to = new Date(addDays(p.to, 2) + 'T00:00:00');
  $('#page').innerHTML = `<div class="head"><h1>Courses suspectes</h1><div class="sub">Chauffeur « En route vers le lieu de prise en charge » sur Uber, puis « Disponible » ou hors ligne sans course en cours : il a pu demander au client d'annuler et le prendre en cachette. Km Geotab mesurés par le collecteur dans les ${esc(String((S.P || {}).suspectWinMin || 20))} min qui suivent, hors course Uber.</div></div>${periodBar(() => route())}<div id="psbody"><div class="loading">Chargement…</div></div>`;
  let rows, trips = [];
  try {
    const r = await sb.from('uber_suspects').select('*').gte('next_at', from.toISOString()).lt('next_at', to.toISOString()).order('next_at', { ascending: false }).limit(2000);
    if (r.error) throw r.error; rows = r.data || [];
    try { const t = await sb.from('uber_trips').select('uuid,vehicle_key,requested_at,status,driver_name,pickup_addr').gte('requested_at', new Date(from.getTime() - 3600000).toISOString()).lt('requested_at', to.toISOString()).neq('status', 'completed').limit(5000); trips = t.data || []; } catch (e) { }
  } catch (e) { if (rid !== ROUTING) return; $('#psbody').innerHTML = msg(/42P01|PGRST205|does not exist|Could not find/.test(e.message || '') ? 'Module pas encore installé : migration <code>20261214000000_courses_suspectes.sql</code> à exécuter dans Supabase.' : 'Erreur : ' + esc(e.message), 'err'); return; }
  if (rid !== ROUTING) return;
  rows.forEach(r => { r.cx = psCancelOf(r, trips); });
  const draw = () => {
    const L = rows.filter(r => (ok(r.vehicle_key) || !r.vehicle_key) && (lvl === 'tous' || r.level === lvl) && (!drv || (r.driver_name || '') === drv));
    const names = [...new Set(rows.map(r => r.driver_name || '').filter(Boolean))].sort();
    const byDrv = {}; L.forEach(r => { const k = r.driver_name || '(inconnu)'; const d = byDrv[k] || (byDrv[k] = { name: k, n: 0, roule: 0, conf: 0, just: 0, km: 0, plates: new Set() }); d.n++; if (r.verdict === 'roulé') d.roule++; if (r.status === 'Confirmé') d.conf++; if (r.status === 'Justifié') d.just++; d.km += +r.km_free || 0; if (r.plate) d.plates.add(r.plate); });
    const drows = Object.values(byDrv).sort((a, b) => b.roule - a.roule || b.n - a.n);
    const dcols = [['Chauffeur', d => `<a href="#/suspects?d=${encodeURIComponent(d.name)}&l=${lvl}">${esc(d.name)}</a>`, d => d.name], ['Véhicules', d => esc([...d.plates].join(', '))], ['Cas', d => f0(d.n), d => d.n, 'num'],
      ['A roulé sans course Uber', d => d.roule ? `<b class="crit">${f0(d.roule)}</b>` : '0', d => d.roule, 'num'], ['km hors course Uber', d => f1(d.km), d => d.km, 'num'], ['Confirmés', d => f0(d.conf), d => d.conf, 'num'], ['Justifiés', d => f0(d.just), d => d.just, 'num']];
    const stSel = r => canEdit() ? `<select class="pssel" data-id="${r.id}"><option ${r.status === 'À vérifier' ? 'selected' : ''}>À vérifier</option><option ${r.status === 'Justifié' ? 'selected' : ''}>Justifié</option><option ${r.status === 'Confirmé' ? 'selected' : ''}>Confirmé</option></select>` : esc(r.status);
    const cols = [['Date', r => esc(fmtDay(localDay(r.next_at))), r => r.next_at], ['En route vers le client', r => `${esc(localHM(new Date(r.route_from)))} → ${esc(localHM(new Date(r.route_to)))} <span class="small">(${esc(psDur(r.route_from, r.route_to))})</span>`, r => r.route_from],
      ['Chauffeur', r => esc(r.driver_name || ''), r => r.driver_name || ''], ['Véhicule', r => plate(r.plate || r.vehicle_key || ''), r => r.plate || ''],
      ['Devenu', r => `<b>${esc(psNext(r.next_status))}</b> à ${esc(localHM(new Date(r.next_at)))}`, r => r.next_status],
      ['Lieu', r => r.lat != null ? `<a href="${esc(osmUrl(r.lat, r.lng))}" target="_blank" rel="noopener">carte</a>` : '<span class="small mute">non relevé</span>'],
      ['Annulation Uber', r => r.cx ? `<span class="badge ${r.cx.kind === 'client' ? 'warn' : 'info'}">par le ${esc(r.cx.kind)}</span> <span class="small">${esc(localHM(new Date(r.cx.t.requested_at)))}</span>` : '<span class="small mute">aucune importée</span>', r => r.cx ? r.cx.kind : ''],
      ['Km Geotab après', r => esc(psKmTxt(r)) + (r.moved_m != null ? ` <span class="small">(jusqu'à ${r.moved_m >= 1000 ? f1(r.moved_m / 1000) + ' km' : r.moved_m + ' m'} du lieu)</span>` : ''), r => r.km_free != null ? r.km_free : -1, 'num'],
      ['Verdict', r => psVerdict(r), r => r.verdict || ''], ['Niveau', r => r.level === 'Suspect' ? '<span class="badge high">Suspect</span>' : '<span class="badge">Info</span>', r => r.level],
      ['Statut', r => stSel(r), r => r.status], ['Commentaire', r => canEdit() ? `<input class="pscom" data-id="${r.id}" value="${esc(r.comment || '')}" size="18" placeholder="…">` : esc(r.comment || ''), r => r.comment || '', 'wide']];
    const n = L.length, nr = L.filter(r => r.verdict === 'roulé').length, nc = L.filter(r => r.status === 'Confirmé').length;
    $('#psbody').innerHTML = `<div class="cards">${[['Cas', f0(n)], ['A roulé sans course Uber', f0(nr)], ['Confirmés', f0(nc)], ['À vérifier', f0(L.filter(r => r.status === 'À vérifier').length)]].map(c => `<div class="card"><div class="cv">${c[1]}</div><div class="cl">${c[0]}</div></div>`).join('')}</div>
      <div class="bar"><label>Niveau <select id="pslvl"><option value="Suspect" ${lvl === 'Suspect' ? 'selected' : ''}>Suspects (en route ≥ ${esc(String((S.P || {}).suspectMinS || 60))} s)</option><option value="tous" ${lvl === 'tous' ? 'selected' : ''}>Tous (dont annulations immédiates)</option></select></label>
        <label>Chauffeur <select id="psdrv"><option value="">Tous</option>${names.map(x => `<option ${x === drv ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <button class="ghost" id="pspdf">PDF</button> <button class="ghost" id="psxls">Tableur</button></div>
      <div class="panel"><h3>Par chauffeur</h3>${table('tpsd', dcols, drows, { page: true, empty: 'Aucun cas sur la période' })}</div>
      <div class="panel"><h3>Cas un par un</h3>${table('tpsl', cols, L, { page: true, empty: 'Aucun cas sur la période' })}
      <p class="small">« A roulé sans course Uber » : le véhicule a parcouru au moins ${esc(String((S.P || {}).suspectKm || 1.5).replace('.', ','))} km (GPS Geotab) hors course Uber dans les ${esc(String((S.P || {}).suspectWinMin || 20))} min après le changement d'état. « Annulation Uber » : course annulée du rapport Uber importé pour ce véhicule, demandée juste avant. Rien n'est estimé : sans position Geotab, « non mesuré ».</p></div>`;
    $('#pslvl').onchange = e => { location.hash = '#/suspects?l=' + e.target.value + (drv ? '&d=' + encodeURIComponent(drv) : ''); };
    $('#psdrv').onchange = e => { location.hash = '#/suspects?l=' + lvl + (e.target.value ? '&d=' + encodeURIComponent(e.target.value) : ''); };
    const rep = () => rptSimple({ kind: 'uber', title: 'Courses Uber suspectes' + (drv ? ' · ' + drv : ''), period: fmtDay(p.from) + ' → ' + fmtDay(p.to), from: p.from, to: p.to,
      summary: [['Cas', f0(n)], ['A roulé sans course Uber', f0(nr)], ['Confirmés', f0(nc)]],
      tables: [colsTable('Par chauffeur', dcols.map(c => [c[0], c[1], c[2]]).map((c, i) => i === 0 ? ['Chauffeur', d => esc(d.name), d => d.name] : c), drows), colsTable('Cas un par un', cols.filter(c => !['Lieu', 'Statut', 'Commentaire'].includes(c[0])).concat([['Statut', r => esc(r.status)], ['Commentaire', r => esc(r.comment || '')]]), L)], fileName: 'courses_suspectes_' + p.from + '_' + p.to });
    $('#pspdf').onclick = () => { try { reportPdf(rep()); } catch (e) { uiNote(e.message); } };
    $('#psxls').onclick = () => { if (!window.XLSX) { uiNote('Bibliothèque tableur non chargée, réessayez dans un instant.'); return; }
      const wb = XLSX.utils.book_new(), txt = h => String(h).replace(/<[^>]+>/g, '');
      [['Par chauffeur', dcols, drows], ['Cas', cols, L]].forEach(([name, cs, rs]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cs.map(c => txt(c[0]))].concat(rs.map(r => cs.map(c => { const v = c[2] ? c[2](r) : null; return v != null && v !== '' && typeof v !== 'object' ? v : txt(c[1](r)); })))), name.slice(0, 30)));
      XLSX.writeFile(wb, 'courses_suspectes_' + p.from + '_' + p.to + '.xlsx'); };
    const save = async (id, st, com) => { try { const r = await sb.rpc('uber_suspect_set', { p_id: id, p_status: st, p_comment: com }); if (r.error) throw r.error; const x = rows.find(y => y.id === id); if (x) { x.status = st; x.comment = com; } } catch (e) { uiNote(e.message); } };
    document.querySelectorAll('.pssel').forEach(s => { s.onchange = () => { const id = +s.dataset.id, c = document.querySelector('.pscom[data-id="' + id + '"]'); save(id, s.value, c ? c.value : ''); }; });
    document.querySelectorAll('.pscom').forEach(c => { c.onchange = () => { const id = +c.dataset.id, s = document.querySelector('.pssel[data-id="' + id + '"]'); save(id, s ? s.value : 'À vérifier', c.value); }; });
  };
  draw();
  window.__rerender = draw; window.__repage = draw;
  window.__psRepaint = () => { PS.rows.forEach(r => { const i = rows.findIndex(x => x.id === r.id); if (i >= 0) rows[i] = Object.assign({}, rows[i], r, { cx: rows[i].cx }); else if (new Date(r.next_at) >= from && new Date(r.next_at) < to) { r.cx = psCancelOf(r, trips); rows.unshift(r); } }); if (ROUTING === rid && !(document.activeElement && document.activeElement.closest('#psbody'))) draw(); };
}
if (typeof module !== 'undefined') module.exports = { psCancelOf, psKmTxt, psNext };
