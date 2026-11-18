// Page En direct : chauffeurs Uber / Bolt en ce moment (en ligne, disponibles, en route vers le client, en course), relus toutes les 15 s.
// Données : fleet_latest + fleet_drivers (droits de la base : administrateur = tout, gestionnaire / lecture seule = ses agences).
// Calcul : pfSummary (plateformes_calc.js).
const PF = { latest: [], drivers: [], err: '', at: 0, busy: false, open: false };
const PF_EVERY_MS = 15000;
const PF_CLS = { to_pickup: 'warn', on_trip: 'ok', available: '', unknown: 'mute' };

async function pfLoad() {
  if (PF.busy) return; PF.busy = true;
  try {
    const [l, d] = await Promise.all([
      sb.from('fleet_latest').select('driver_id,source,status,observed_at,vehicle_label,evidence').gte('observed_at', new Date(Date.now() - 24 * 3600000).toISOString()).limit(1000),
      PF.drivers.length && Date.now() - PF.dAt < 10 * 60000 ? { data: PF.drivers } : sb.from('fleet_drivers').select('id,name,agency_id,vehicle_key,ludy_driver_code').limit(1000)]);
    if (l.error) throw l.error; if (d.error) throw d.error;
    PF.latest = l.data || []; if (d.data !== PF.drivers) { PF.drivers = d.data || []; PF.dAt = Date.now(); }
    PF.err = ''; PF.at = Date.now();
  } catch (e) { PF.err = String(e.message || e); }
  finally { PF.busy = false; }
}
/** Chauffeur dans l'agence choisie (menu) : agence de sa fiche, sinon agence du véhicule lu sur l'écran d'Uber */
function pfKeep() {
  const a = agFilter(); if (!a) return () => true;
  const vAg = {}; (S.vehList || []).forEach(v => { vAg[normPlate(v.plate)] = String(v.agency_id); vAg[normPlate(v.key)] = String(v.agency_id); });
  return (d, r) => d && d.agency_id != null ? String(d.agency_id) === a : vAg[normPlate(r.vehicle_label)] === a;
}
function pfSum() {
  return pfSummary(PF.latest, PF.drivers, { keep: pfKeep(), nameOf: (d, r) => (d && d.ludy_driver_code && S.drv && S.drv[d.ludy_driver_code]) || (d && d.name) || 'Chauffeur non relié' });
}
function pfHtml() {
  if (PF.err) return /permission|does not exist|relation|schema cache|not find|42P01|PGRST20/i.test(PF.err) ? '' : `<div class="panel small">Chauffeurs Uber / Bolt en ce moment : lecture impossible (${esc(PF.err)}).</div>`;
  if (!PF.at) return '<div class="panel small">Chauffeurs Uber / Bolt en ce moment : lecture…</div>';
  const s = pfSum(), blk = (x, name) => {
    if (!x.seen) return '';
    const n = v => x.stale ? '—' : f0(v);
    const late = x.stale ? `<div class="msg warn small">Lecture de ${name} arrêtée${x.lastAt ? ' depuis le ' + esc(fmtDTY(new Date(x.lastAt).toISOString())) : ''} : chiffres pas à jour (l'écran ${name === 'Uber' ? 'Uber Fleet' : 'Bolt'} n'est plus relu par l'application de bureau).</div>` : '';
    return `<div class="pfblk"><h3>${name} en ce moment <span class="small">${x.lastAt && !x.stale ? 'lu à ' + esc(localHM(new Date(x.lastAt))) : ''}</span></h3>${late}
      ${cards([['En ligne', n(x.online), x.stale ? 'mute' : ''], ['En route vers le client', n(x.to_pickup), x.stale ? 'mute' : x.to_pickup ? 'warn' : ''], ['En course', n(x.on_trip), x.stale ? 'mute' : 'ok'],
        ['Disponibles (en attente)', n(x.available)]].concat(x.unknown && !x.stale ? [['État non reconnu', f0(x.unknown), 'mute']] : []))}
      ${!x.stale && x.list.length ? `<details class="pfdet" data-pf="${x.source}" ${PF.open && PF.open[x.source] ? 'open' : ''}><summary>Voir les ${f0(x.list.length)} chauffeurs en ligne</summary>
        <table class="tbl"><thead><tr><th>Chauffeur</th><th>Véhicule</th><th>État</th></tr></thead><tbody>${x.list.map(c => `<tr><td>${esc(c.name)}</td><td>${c.plate ? plate(c.plate) : ''}</td>
          <td>${badge(c.label, PF_CLS[c.status])}${c.status === 'unknown' && c.raw ? ' <span class="small">' + esc(c.raw) + '</span>' : ''}</td></tr>`).join('')}</tbody></table></details>` : ''}</div>`;
  };
  // véhicules sous contrat (page En direct) pas connectés : ni Uber ni Bolt en ligne, lecture d'Uber Fleet à jour
  let offH = '';
  if (typeof liveRows === 'function' && $('#map') && pfUberFresh()) {
    const off = liveRows().filter(r => { const v = pfVeh(r.plate, r.vehicle_key, r); return v && v.status === 'offline'; })
      .sort((a, b) => (b.state === 'En route') - (a.state === 'En route') || String(a.plate).localeCompare(String(b.plate)));
    const mv = off.filter(r => r.state === 'En route').length;
    offH = `<div class="pfblk"><h3>Sous contrat mais déconnectés d'Uber et de Bolt</h3>
      ${cards([['Déconnectés (sous contrat)', f0(off.length), off.length ? 'warn' : 'ok'], ['Déconnectés et qui roulent', f0(mv), mv ? 'crit' : 'ok']])}
      ${off.length ? `<table class="tbl"><thead><tr><th>Véhicule</th><th>Chauffeur (contrat)</th><th>Geotab</th></tr></thead><tbody>${off.map(r => `<tr${r.state === 'En route' ? ' class="crit"' : ''}><td>${plate(r.plate)}</td><td>${esc(r.driver_name || '')}</td>
        <td>${esc(r.state || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${r.since_min != null ? ' · depuis ' + esc(fH(r.since_min / 60)) : ''}</td></tr>`).join('')}</tbody></table>` : ''}</div>`;
  }
  const html = blk(s.uber, 'Uber') + blk(s.bolt, 'Bolt') + offH;
  return html ? `<div class="panel pfbox">${html}<div class="small">États lus en direct sur l'écran Uber Fleet (et Bolt) par l'application de bureau, toutes les quelques secondes ; un chauffeur qui n'est plus vu depuis 2 min n'est plus compté en ligne.</div></div>` : '';
}
/** État Uber (sinon Bolt) d'un véhicule de la carte, d'après la plaque lue sur l'écran de la plateforme ; null si pas en ligne ou pas à jour */
const PF_SHORT = { available: 'Disponible', to_pickup: 'Vers le client', on_trip: 'En course', unknown: 'En ligne' };
/** Lecture de l'écran Uber Fleet à jour (un relevé de moins de 2 min, toutes agences) */
function pfUberFresh() { const now = Date.now(); return PF.latest.some(r => r.source === 'uber' && now - new Date(r.observed_at).getTime() <= PF_FRESH_MS); }
/**
 * État du véhicule sur Uber (sinon Bolt). Véhicule sous contrat que la lecture d'Uber Fleet, à jour, ne voit pas et qui n'est pas en
 * ligne sur Bolt : « Hors ligne » (Uber Fleet ne montre que les chauffeurs connectés : rien n'est supposé au-delà). Lecture arrêtée : null.
 */
function pfVeh(plateTxt, key, row) {
  if (!PF.at || !PF.latest.length) return null;
  const off = () => row && row.contract_num && !row.crs && pfUberFresh() ? { source: 'uber', status: 'offline', label: 'Hors ligne (pas connecté sur Uber ni Bolt)', short: row.state === 'En route' ? 'Hors ligne · roule' : 'Hors ligne', at: Date.now(), name: '' } : null;
  const ks = [normPlate(plateTxt), normPlate(key)].filter(Boolean), now = Date.now();
  let best = null;
  PF.latest.forEach(r => {
    if (!r.vehicle_label || !ks.includes(normPlate(r.vehicle_label)) || r.status === 'offline') return;
    const t = new Date(r.observed_at).getTime(); if (!(now - t <= PF_FRESH_MS)) return;
    const st = PF_ST[r.status] ? r.status : 'unknown';
    if (!best || (r.source === 'uber' && best.source !== 'uber') || (r.source === best.source && t > best.at)) {
      const d = PF.drivers.find(x => x.id === r.driver_id);
      best = { source: r.source, status: st, label: PF_ST[st], short: PF_SHORT[st], at: t,
        name: (d && d.ludy_driver_code && S.drv && S.drv[d.ludy_driver_code]) || (d && d.name) || '' };
    }
  });
  if (best) return best;
  // chauffeur du contrat en ligne avec un autre véhicule déclaré sur la plateforme : jamais compté « hors ligne »
  if (row && row.driver_code) {
    const ids = new Set(PF.drivers.filter(d => d.ludy_driver_code === row.driver_code).map(d => d.id));
    const o = PF.latest.find(r => ids.has(r.driver_id) && r.status !== 'offline' && now - new Date(r.observed_at).getTime() <= PF_FRESH_MS);
    if (o) { const st = PF_ST[o.status] ? o.status : 'unknown';
      return { source: o.source, status: st, label: PF_ST[st] + ' avec un autre véhicule (' + (o.vehicle_label || '?') + ')', short: PF_SHORT[st] + ' · autre véhicule', at: new Date(o.observed_at).getTime(), name: row.driver_name || '' }; }
  }
  return off();
}
/** Pastille de la carte et des cartes véhicules : « Uber · En course » */
function pfVehChip(r) {
  const v = pfVeh(r.plate, r.vehicle_key, r); if (!v) return '';
  return `<span class="pfchip pf-${v.status}${v.status === 'offline' && r.state === 'En route' ? ' pf-offmove' : ''}">${v.source === 'bolt' ? 'Bolt' : 'Uber'} · ${esc(v.short)}</span>`;
}
function pfVehLine(r) {
  const v = pfVeh(r.plate, r.vehicle_key, r); if (!v) return '';
  if (v.status === 'offline') return `Uber / Bolt : <b>${esc(v.label)}</b>${r.state === 'En route' ? ' · <b class="crit">le véhicule roule</b>' : ''}`;
  return `${v.source === 'bolt' ? 'Bolt' : 'Uber'} : <b>${esc(v.label)}</b>${v.name ? ' · ' + esc(v.name) : ''} <span class="small">(lu à ${esc(localHM(new Date(v.at)))})</span>`;
}
function pfPaint() {
  // carte et cartes véhicules d'En direct : pastilles Uber mises à jour avec la lecture
  if (typeof MAP !== 'undefined' && MAP && typeof liveRows === 'function' && $('#map')) { try { liveRows().forEach(placeMarker); const vl = $('#vlist'); if (vl) vl.innerHTML = vcardsHtml(liveRows()); } catch (e) { } }
  const el = $('#liveplat'); if (!el) return;
  el.querySelectorAll('details.pfdet').forEach(d => { PF.open = PF.open || {}; PF.open[d.dataset.pf] = d.open; });
  el.innerHTML = pfHtml();
}
/** Lancé par la page En direct : lecture tout de suite puis toutes les 15 s tant que la page est affichée et visible */
function pfStart(my) {
  pfLoad().then(() => { if (my === ROUTING) pfPaint(); });
  clearInterval(PF.timer);
  PF.timer = setInterval(() => {
    if (my !== ROUTING || !$('#liveplat')) { clearInterval(PF.timer); return; }
    if (document.hidden) return;
    pfLoad().then(() => { if (my === ROUTING) pfPaint(); });
  }, PF_EVERY_MS);
}

// ---------- Alerte « chauffeur déconnecté d'Uber », sur toutes les pages (18/11/2026, demande d'Ahmed) ----------
// Toutes les 30 s : chauffeurs vus en ligne sur Uber Fleet et plus vus depuis 2 min (lecture à jour), dont le contrat est en cours,
// pas en pause, pas rappelé à l'agence (Retours). Bandeau rouge qui reste affiché, bip, notification du système si Ludy est caché,
// WhatsApp au chauffeur (français + darija) et message à partager. Une alerte par déconnexion ; reconnecté = bandeau vert.
const PFW = { timer: 0, busy: false, primed: false, ctx: null, ctxAt: 0, toasts: {} };
const PFW_SEEN = 'pfOffSeen';
function pfwCan() { return !!(S.profile && ['admin', 'manager', 'viewer'].includes(S.profile.role)) && (typeof canSee !== 'function' || canSee('direct')); }
function pfwSeen(k) { try { return !!(JSON.parse(localStorage.getItem(PFW_SEEN) || '{}'))[k]; } catch (e) { return false; } }
function pfwMark(k) { try { const o = JSON.parse(localStorage.getItem(PFW_SEEN) || '{}'), cut = Date.now() - 2 * 86400000; o[k] = Date.now(); Object.keys(o).forEach(x => { if (o[x] < cut) delete o[x]; }); localStorage.setItem(PFW_SEEN, JSON.stringify(o)); } catch (e) { } }
/** Contrats en cours (par véhicule et par chauffeur), retours demandés, pauses ouvertes ; relus toutes les 2 min */
async function pfwContext() {
  if (PFW.ctx && Date.now() - PFW.ctxAt < 120000) return PFW.ctx;
  const since = new Date(Date.now() - 36 * 3600000).toISOString(), opt = p => p.then(r => r.error ? [] : r.data || [], () => []);
  const [ctr, rc, pz, drv] = await Promise.all([
    opt(sb.from('contracts').select('num,client_code,name,phone,vehicle_key,start_at,end_at').gte('start_at', since).limit(2000)),
    opt(sb.from('return_calls').select('contract_num').not('sent_at', 'is', null).is('done_at', null).is('cancelled_at', null).gte('created_at', since)),
    opt(sb.from('driver_pauses').select('vehicle_key').is('ended_at', null)),
    opt(sb.from('drivers').select('code,phone'))]);
  const byVeh = {}, cur = {}, curDrv = {}, now = Date.now();
  ctr.forEach(c => { (byVeh[c.vehicle_key] = byVeh[c.vehicle_key] || []).push(c); });
  Object.values(byVeh).forEach(l => ctrEffEnds(l, now).forEach(c => { const s = new Date(c.start_at).getTime(); if (s <= now && (c._end == null || c._end > now)) { cur[c.vehicle_key] = c; if (c.client_code) curDrv[c.client_code] = c; } }));
  const phone = {}; drv.forEach(d => { if (d.phone) phone[d.code] = d.phone; });
  PFW.ctx = { cur, curDrv, ret: new Set(rc.map(x => x.contract_num)), paused: new Set(pz.map(x => x.vehicle_key)), phone };
  PFW.ctxAt = Date.now(); return PFW.ctx;
}
function pfwVehKey(label) { const n = normPlate(label); const v = (S.vehList || []).find(x => normPlate(x.plate) === n || normPlate(x.key) === n); return v ? v.key : ''; }
async function pfwTick() {
  if (PFW.busy || !S.session || !pfwCan()) return;
  PFW.busy = true;
  try {
    await pfLoad(); if (PF.err) return;
    const ctx = await pfwContext(), a = agFilter(), now = Date.now();
    const ctrOf = (d, r) => { const k = pfwVehKey(r.vehicle_label); return (k && ctx.cur[k]) || (d && d.ludy_driver_code && ctx.curDrv[d.ludy_driver_code]) || null; };
    const list = pfDisconnects(PF.latest, PF.drivers, { now, keep: (d, r) => {
      const c = ctrOf(d, r); if (!c) return false;                                   // pas de contrat en cours : fin de shift, rien à signaler
      if (new Date(c.start_at).getTime() > new Date(r.observed_at).getTime()) return false;
      if (ctx.ret.has(c.num) || ctx.paused.has(c.vehicle_key)) return false;          // rappelé à l'agence, ou en pause
      if (a) { const v = (S.vehList || []).find(x => x.key === c.vehicle_key); if (v && String(v.agency_id) !== a) return false; }
      return true; } });
    const live = new Set(list.map(x => x.key));
    // reconnecté (ou plus concerné) : bandeau passé au vert puis retiré
    Object.keys(PFW.toasts).forEach(k => { if (!live.has(k)) { const t = PFW.toasts[k]; delete PFW.toasts[k]; pfwBack(t, k); } });
    for (const x of list) {
      if (PFW.toasts[x.key]) { pfwUpdate(x, ctx); continue; }
      if (pfwSeen(x.key)) continue;
      if (!PFW.primed && now - x.lastAt > 10 * 60000) { pfwMark(x.key); continue; }   // à l'ouverture : vieilles déconnexions pas rejouées
      await pfwShow(x, ctx, ctrOf(x.d, x.r));
    }
    PFW.primed = true;
  } catch (e) { } finally { PFW.busy = false; }
}
function pfwInfo(x, ctx, c) {
  c = c || x.c;
  const key = c ? c.vehicle_key : pfwVehKey(x.plate), v = key && typeof vehOf === 'function' ? vehOf(key) : null;
  return Object.assign(x, { now: Date.now(), c, ctr: c ? c.num : '', name: (c && c.name) || x.name, plate: (v && v.plate) || x.plate, key,
    phone: (c && (c.phone || (c.client_code && ctx.phone[c.client_code]))) || '' });
}
async function pfwGeo(x) {
  if (!x.key) return '';
  try { const { data } = await sb.from('live_status').select('state,speed').eq('vehicle_key', x.key).maybeSingle(); return data ? data.state + (data.state === 'En route' ? ' à ' + data.speed + ' km/h' : '') : ''; } catch (e) { return ''; }
}
function pfwBody(x) {
  return `<div><b>${esc(x.name || 'Chauffeur')}</b> ${x.plate ? plate(x.plate) : ''}</div>
    <div class="small">Plus connecté à Uber depuis ${esc(localHM(new Date(x.lastAt)))} (<span class="svel" data-t="${x.lastAt}">${esc(svDur(Date.now() - x.lastAt))}</span>)${x.ctr ? ' · contrat ' + esc(x.ctr) : ''}</div>
    <div class="small">${x.geo ? 'GPS Geotab : <b>' + esc(x.geo) + '</b>' : ''}${x.phone ? (x.geo ? ' · ' : '') + '📞 ' + esc(x.phone) : ''}</div>`;
}
async function pfwShow(x, ctx, c) {
  pfwInfo(x, ctx, c); x.geo = await pfwGeo(x);
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast crit pftoast'; t.dataset.k = x.key;
  t.innerHTML = `<button class="x" aria-label="Fermer">×</button><b>🔴 CHAUFFEUR DÉCONNECTÉ D'UBER</b><div class="pfbody">${pfwBody(x)}</div>
    <div class="row pfact"><button class="small" data-a="wa">WhatsApp au chauffeur</button><button class="small ghost" data-a="share">Partager sur WhatsApp</button><button class="small ghost" data-a="ok">Vu</button></div>`;
  const close = () => { pfwMark(x.key); delete PFW.toasts[x.key]; t.remove(); };
  t.querySelector('.x').onclick = close; t.querySelector('[data-a="ok"]').onclick = close;
  t.querySelector('[data-a="wa"]').onclick = () => { const txt = pfWaOff(Object.assign({}, x, { now: Date.now() }), ms => localHM(new Date(ms)), svDur, typeof svDurAr === 'function' ? svDurAr : null);
    if (x.phone) svWa(x.phone, txt); else { const u = 'https://wa.me/?text=' + encodeURIComponent(txt); if (!openOut(u)) window.open(u, '_blank', 'noopener'); } };
  t.querySelector('[data-a="share"]').onclick = () => { const u = 'https://wa.me/?text=' + encodeURIComponent(pfShareOff(Object.assign({}, x, { now: Date.now() }), ms => localHM(new Date(ms)), svDur)); if (!openOut(u)) window.open(u, '_blank', 'noopener'); };
  box.prepend(t); PFW.toasts[x.key] = t; t._x = x;
  if (typeof svBeep === 'function') svBeep();
  try { if (document.hidden && window.Notification && Notification.permission === 'granted') {
    const n = new Notification('Ludy · chauffeur déconnecté d\'Uber', { body: (x.name || '') + (x.plate ? ' · ' + x.plate : '') + ' · depuis ' + localHM(new Date(x.lastAt)), tag: x.key, requireInteraction: true, icon: 'icon-192.png' });
    n.onclick = () => { try { window.focus(); } catch (e) { } n.close(); }; } } catch (e) { }
}
function pfwUpdate(x, ctx) { const t = PFW.toasts[x.key]; if (!t || !t._x) return; const b = t.querySelector('.pfbody'); if (b) b.innerHTML = pfwBody(Object.assign(t._x, { now: Date.now() })); }
function pfwBack(t, k) {
  if (!t || !t.isConnected) return;
  const x = t._x || {}, back = PF.latest.find(r => r.source === 'uber' && r.driver_id === x.driverId && Date.now() - new Date(r.observed_at).getTime() <= PF_FRESH_MS);
  if (!back) { t.remove(); return; }   // contrat terminé, pause, retour demandé : retiré
  pfwMark(k); t.className = 'toast ok pftoast';
  t.innerHTML = `<button class="x" aria-label="Fermer">×</button><b>✅ Reconnecté à Uber</b> ${x.plate ? plate(x.plate) : ''}<div>${esc(x.name || '')}</div><div class="small">déconnecté de ${esc(localHM(new Date(x.lastAt)))} à ${esc(localHM(new Date()))}</div>`;
  t.querySelector('.x').onclick = () => t.remove(); setTimeout(() => t.remove(), 60000);
}
function pfwStart() {
  if (PFW.timer) return;
  PFW.timer = setInterval(() => { pfwTick(); }, 30000);
  pfwTick();
}
/** Changement d'utilisateur : alertes, contexte et lectures oubliés (jamais montrés à un autre compte) */
function pfwReset() { Object.values(PFW.toasts).forEach(t => t.remove()); PFW.toasts = {}; PFW.ctx = null; PFW.primed = false; PF.latest = []; PF.drivers = []; PF.at = 0; }
