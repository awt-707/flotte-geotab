// Page En direct : chauffeurs Uber en ce moment (en ligne, disponibles, en route vers le client, en course), relus toutes les 15 s.
// Données : uber_live (migration 20261204000000_uber_ecran.sql), états lus sur l'écran Uber Fleet ouvert dans l'application Ludy 1.8,
// sur n'importe quel ordinateur (pfPush), sans l'application de Raphael (18/11/2026, demande d'Ahmed ; plus aucun repli sur ses données
// depuis le 19/11). Application 1.9 : liste complète lue dans les données de la carte d'Uber Fleet (site/uber_read.js, pfReaderSend). Droits de la base : administrateur
// = tout, gestionnaire / lecture seule = véhicules de ses agences. Calcul : pfSummary (plateformes_calc.js).
const PF = { latest: [], drivers: [], err: '', at: 0, busy: false, open: false };
const PF_EVERY_MS = 15000;
const PF_CLS = { to_pickup: 'warn', on_trip: 'ok', available: '', unknown: 'mute' };

async function pfLoad() {
  if (PF.busy) return; PF.busy = true;
  try {
    // lecture de l'application Ludy (une ligne par plaque lue sur Uber Fleet) ; aucune autre source (19/11/2026, demande d'Ahmed)
    const since = new Date(Date.now() - 24 * 3600000).toISOString(), fresh = Date.now() - PF_FRESH_MS;
    const l = await sb.from('uber_live').select('plate_key,plate,vehicle_key,agency_id,driver_name,status,raw,observed_at,status_since,complete,photo_url,perf').gte('observed_at', since).limit(1000);
    if (l.error) throw l.error;
    const own = l.data || [];
    PF.src = 'ludy';
    // liste complète lue dans les données de la carte d'Uber Fleet (application 1.9) : comptes, déconnexions, hors ligne ;
    // sinon (1.8, ou carte pas ouverte) : seulement les chauffeurs affichés, jamais comptés ni signalés déconnectés
    // la dernière lecture doit être complète (une lecture partielle plus récente = comptes et déconnexions suspendus)
    const newest = own.reduce((m, r) => Math.max(m, new Date(r.observed_at).getTime() || 0), 0);
    PF.full = own.some(r => r.complete && new Date(r.observed_at).getTime() >= Math.max(fresh, newest - 15000));
    PF.latest = own.map(r => ({ driver_id: r.plate_key, source: 'uber', status: r.status, observed_at: r.observed_at, since: r.status_since, vehicle_label: r.plate, full: !!r.complete, photo: r.photo_url || '', perf: r.perf || null, evidence: { raw_state: r.raw } }));
    PF.drivers = own.map(r => ({ id: r.plate_key, name: r.driver_name || '', agency_id: r.agency_id, vehicle_key: r.vehicle_key, ludy_driver_code: null }));
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
  return pfSummary(PF.latest.filter(r => r.full), PF.drivers, { keep: pfKeep(), nameOf: (d, r) => (d && d.ludy_driver_code && S.drv && S.drv[d.ludy_driver_code]) || (d && d.name) || 'Chauffeur non relié' });
}
/** Bandeau compact d'En direct : Uber (et Bolt s'il a des chauffeurs en ligne), déconnectés sous contrat ; détails repliés */
function pfHtml() {
  if (PF.err) return /permission|does not exist|relation|schema cache|not find|42P01|PGRST20/i.test(PF.err) ? '' : `<div class="pfbar small">Uber : lecture impossible (${esc(PF.err)})</div>`;
  if (!PF.at) return '<div class="pfbar small">Uber : lecture…</div>';
  const s = pfSum(), u = s.uber, b = s.bolt;
  const chip = (n, label, cls) => `<span class="kchip ${cls || ''}"><b>${n}</b> ${label}</span>`;
  const fresh = Date.now() - PF_FRESH_MS, part = PF.latest.filter(r => !r.full && r.status !== 'offline' && new Date(r.observed_at).getTime() >= fresh);
  if (!PF.latest.some(r => r.full)) return `<div class="pfbar"><span class="pfname">Uber</span><span class="small">${part.length ? f0(part.length) + ' chauffeur(s) lu(s) à l\'écran · ' : ''}comptes complets : ouvrir la « Carte en temps réel » d'Uber Fleet dans l'application Ludy 1.9 (sur un ordinateur connecté à Uber Fleet)</span></div>`;
  const src = '';
  let html = '';
  if (u.stale) html += `<div class="pfbar"><span class="pfname">Uber</span><span class="msg warn small">Lecture arrêtée${u.lastAt ? ' depuis ' + esc(localHM(new Date(u.lastAt))) : ''} : chiffres pas à jour (aucune application Ludy n'a le volet Uber Fleet ouvert et connecté)</span></div>`;
  else html += `<div class="pfbar"><span class="pfname">Uber <span class="small">lu à ${esc(localHM(new Date(u.lastAt)))}${src}</span></span>
    ${chip(f0(u.online), 'en ligne')}${chip(f0(u.available), 'Disponible', 'pf-available')}${chip(f0(u.to_pickup), 'En route vers le lieu de prise en charge', 'pf-to_pickup')}${chip(f0(u.on_trip), 'Course en cours', 'pf-on_trip')}${u.unknown ? chip(f0(u.unknown), 'état non reconnu', 'mute') : ''}
    <span id="pfoffchip"></span>${pfShiftChips()}</div>`;
  if (b.seen && !b.stale && b.online) html += `<div class="pfbar"><span class="pfname">Bolt</span>${chip(f0(b.online), 'en ligne')}${chip(f0(b.available), 'Disponible', 'pf-available')}${chip(f0(b.to_pickup), 'En route vers le lieu de prise en charge', 'pf-to_pickup')}${chip(f0(b.on_trip), 'Course en cours', 'pf-on_trip')}</div>`;
  // véhicules sous contrat (page En direct) pas connectés : ni Uber ni Bolt en ligne, lecture d'Uber Fleet à jour
  let off = [];
  if (typeof liveRows === 'function' && $('#map') && pfUberFresh()) off = liveRows().filter(r => { const v = pfVeh(r.plate, r.vehicle_key, r); return v && v.status === 'offline'; })
    .sort((x, y) => (y.state === 'En route') - (x.state === 'En route') || String(x.plate).localeCompare(String(y.plate)));
  const mv = off.filter(r => r.state === 'En route').length;
  if (!u.stale) html = html.replace('<span id="pfoffchip"></span>', chip(f0(off.length), 'déconnectés sous contrat', off.length ? 'warn' : '') + (mv ? chip(f0(mv), 'déconnectés qui roulent', 'crit') : ''));
  const det = [];
  if (!u.stale && u.list.length) det.push(`<details class="pfdet" data-pf="uber" ${PF.open && PF.open.uber ? 'open' : ''}><summary>Chauffeurs en ligne sur Uber (${f0(u.list.length)})</summary>
    <table class="tbl"><thead><tr><th>Chauffeur</th><th>Véhicule</th><th>État</th></tr></thead><tbody>${u.list.map(c => `<tr><td>${pfPhotoHtml((PF.latest.find(r => r.driver_id === c.driverId) || {}).photo, c.name)}${esc(c.name)}</td><td>${c.plate ? plate(c.plate) : ''}</td>
      <td>${badge(c.label, PF_CLS[c.status])}${c.status === 'unknown' && c.raw ? ' <span class="small">' + esc(c.raw) + '</span>' : ''}</td></tr>`).join('')}</tbody></table></details>`);
  if (off.length) det.push(`<details class="pfdet" data-pf="off" ${PF.open && PF.open.off ? 'open' : ''}><summary>Sous contrat mais déconnectés d'Uber et de Bolt (${f0(off.length)})</summary>
    <table class="tbl"><thead><tr><th>Véhicule</th><th>Chauffeur (contrat)</th><th>Geotab</th></tr></thead><tbody>${off.map(r => `<tr${r.state === 'En route' ? ' class="crit"' : ''}><td>${plate(r.plate)}</td><td>${esc(r.driver_name || '')}</td>
      <td>${esc(r.state || '')}${r.state === 'En route' ? ' · ' + f0(r.speed) + ' km/h' : ''}${r.since_min != null ? ' · depuis ' + esc(fH(r.since_min / 60)) : ''}</td></tr>`).join('')}</tbody></table></details>`);
  return html + (det.length ? `<div class="pfdets">${det.join('')}</div>` : '');
}
/** État Uber (sinon Bolt) d'un véhicule de la carte, d'après la plaque lue sur l'écran de la plateforme ; null si pas en ligne ou pas à jour */
const PF_SHORT = { available: 'Disponible', to_pickup: 'En route vers le lieu de prise en charge', on_trip: 'Course en cours', unknown: 'En ligne' };
/** Lecture complète d'Uber Fleet à jour (liste complète des chauffeurs lue il y a moins de 2 min, toutes agences) */
function pfUberFresh() { const now = Date.now(); return PF.latest.some(r => r.source === 'uber' && r.full && now - new Date(r.observed_at).getTime() <= PF_FRESH_MS); }
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
      best = { source: r.source, status: st, label: PF_ST[st], short: PF_SHORT[st], at: t, photo: r.photo || '', perf: r.perf || null,
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
/** Photo du chauffeur affichée par Uber Fleet (lue avec son nom ; adresse signée, relue à chaque lecture) ; rien sans photo */
function pfPhotoHtml(photo, name, cls) {
  return photo && /^https:\/\/[a-z0-9-]+\.cloudfront\.net\//i.test(photo) ? `<img class="${cls || 'pfphoto'}" src="${esc(photo)}" alt="${esc(name || 'Chauffeur')}" loading="lazy" referrerpolicy="no-referrer">` : '';
}
function pfVehPhoto(r) { const v = pfVeh(r.plate, r.vehicle_key, r); return v && v.photo ? pfPhotoHtml(v.photo, v.name || r.driver_name, 'vc-photo') : ''; }
// photo expirée ou refusée : retirée (pas d'image cassée)
document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && /(^| )(pfphoto|vc-photo)( |$)/.test(t.className)) t.remove(); }, true);
/**
 * Performances du jour d'Uber du chauffeur en ligne sur ce véhicule (revenus totaux, heures en ligne, taux d'acceptation, courses),
 * lues dans Uber Fleet (journée d'Uber 04:00 → 04:00) ; null si rien de lu depuis 2 h (jamais estimé)
 */
function pfVehPerf(r) {
  const v = pfVeh(r.plate, r.vehicle_key, r); if (!v || !v.perf) return null;
  const p = v.perf; return p.at && Date.now() - p.at < 2 * 3600000 ? p : null;
}
/** Pastille de la carte et des cartes véhicules : « Uber · Course en cours » */
function pfVehChip(r, compact) {
  const v = pfVeh(r.plate, r.vehicle_key, r); if (!v) return '';
  const pf = v.source === 'bolt' ? 'Bolt' : 'Uber', full = pf + ' · ' + v.short;
  // carte : pastille courte à la couleur de l'état (libellé complet d'Uber Fleet au survol, dans la bulle et la légende)
  const txt = compact ? (v.status === 'offline' ? (r.state === 'En route' ? 'Hors ligne · roule' : 'Hors ligne') : pf) : full;
  return `<span class="pfchip pf-${v.status}${v.status === 'offline' && r.state === 'En route' ? ' pf-offmove' : ''}" title="${esc(full)}">${esc(txt)}</span>`;
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
  pfShiftLoad().then(() => { if (my === ROUTING) pfShiftPaint(); });
  clearInterval(PFS.timer);
  PFS.timer = setInterval(() => { if (my !== ROUTING || !$('#liveubshift')) { clearInterval(PFS.timer); return; } if (!document.hidden) pfShiftLoad().then(() => { if (my === ROUTING) pfShiftPaint(); }); }, 60000);
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
    if (!PF.full) return;   // lecture partielle : aucune déconnexion supposée
    const list = pfDisconnects(PF.latest.filter(r => r.full), PF.drivers, { now, keep: (d, r) => {
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
function pfwReset() { PFP.login = false; pfLoginBar(); Object.values(PFW.toasts).forEach(t => t.remove()); PFW.toasts = {}; PFW.ctx = null; PFW.primed = false; PF.latest = []; PF.drivers = []; PF.at = 0; PFP.last = ''; PFP.lastAt = 0; }

// ---------- Application Ludy 1.8 : relevé du volet Uber Fleet envoyé à la base (n'importe quel compte connecté) ----------
const PFP = { timer: 0, last: '', lastAt: 0, n: 0, err: '', cat: '', perf: '', trips: new Set(), tripsNote: '' };
function pfPushCan() { return appIpc() && !!(S.profile && ['admin', 'manager', 'viewer'].includes(S.profile.role)); }
/**
 * Courses du rapport « Activité des courses » demandé par Ludy à Uber Fleet (20/11/2026) : un lot de lignes relevé une fois, importé
 * comme l'import manuel de Contrôle Uber (import_uber_trips : administrateur, gestionnaire = véhicules de ses agences ; réimport sans
 * doublon). Renvoie le résultat de l'import (noté dans le diagnostic de la lecture).
 */
async function pfTripsImport(txt) {
  let o; try { o = JSON.parse(txt); } catch (e) { return ''; }
  if (!o || !o.id || PFP.trips.has(o.id)) return '';
  PFP.trips.add(o.id);
  if (!S.profile || !['admin', 'manager'].includes(S.profile.role)) return '';
  const res = ubcParseTrips([o.h || []].concat(o.r || []));
  if (res.error) return new Date().toISOString().slice(11, 16) + ' : ' + res.error + ' · en-têtes : ' + JSON.stringify(o.h || []).slice(0, 400);
  if (!res.rows.length) return '';
  const { data, error } = await sb.rpc('import_uber_trips', { p_rows: res.rows }).then(x => x, e => ({ error: e }));
  if (error) { PFP.trips.delete(o.id); return new Date().toISOString().slice(11, 16) + ' : import refusé ' + String(error.message || error).slice(0, 160); }
  PFT.at = 0;   // courses du shift relues au prochain dessin
  return new Date().toISOString().slice(11, 16) + ' : ' + res.rows.length + ' course(s) · ' + ['added', 'updated', 'same', 'skipped', 'no_vehicle'].map(k => k + ' ' + ((data || {})[k] || 0)).join(', ');
}
/** Chiffres d'Uber par contrat (ligne « CTRP ») : une ligne uber_perf par contrat (« ctr: » / « ctrj1: »), seulement si elle a changé */
async function pfCtrPush(txt) {
  let l; try { l = JSON.parse(txt); } catch (e) { return; }
  PFP.ctrSent = PFP.ctrSent || {}; let errs = 0, done = 0;
  for (const x of l || []) {
    if (!x || !/^(ctr|ctrj1):/.test(x.p || '')) continue;
    const sig = JSON.stringify(x); if (PFP.ctrSent[x.p] === sig) continue;
    const it = Object.assign({}, x); delete it.p;
    const r = await sb.rpc('uber_perf_push', { p_period: x.p, p_from: new Date(x.f).toISOString(), p_items: [it] }).then(y => y, e => ({ error: e }));
    if (r.error) { errs++; PFS.ctrErr = 'enregistrement des chiffres par contrat refusé : ' + String(r.error.message || r.error).slice(0, 120); } else { PFP.ctrSent[x.p] = sig; done++; }
  }
  if (done) { PFS.ctrErr = errs ? PFS.ctrErr : ''; PFS.at = 0; }
  return errs ? false : true;
}
async function pfPushTick() {
  if (!S.session || !pfPushCan()) return;
  let v = null; try { v = await appInvoke('uber_rows'); } catch (e) { return; }   // application avant la 1.8 : commande absente
  if (!v || !Array.isArray(v.rows) || v.age > 30) return;
  // page de connexion d'Uber (session expirée) : plus aucune lecture possible tant que personne ne se reconnecte
  const login = /auth\.uber\.com|\/login|signin/i.test(v.url || '') || (!v.rows.length && /votre numéro de téléphone ou votre adresse courriel|phone number or email/i.test(v.diag || ''));
  if (login !== !!PFP.login) { PFP.login = login; pfLoginBar(); }
  // lignes en tête du diagnostic (site/uber_read.js) : « CAT [...] » = catalogue de ce que la page d'Uber Fleet charge,
  // « PERF {period, from, items} » = revenus du shift, « TRIPS {id, h, r} » = lot de courses du rapport « Activité des courses »
  let diag = String(v.diag || ''), note = '';
  for (let guard = 0; guard < 5 && /^(CAT|PERF|CTRP|TRIPS) /.test(diag); guard++) {
    const nl = diag.indexOf('\n'), line = nl < 0 ? diag : diag.slice(0, nl); diag = nl < 0 ? '' : diag.slice(nl + 1);
    if (line.startsWith('CAT ')) { if (line !== PFP.cat) { try { const c = await sb.rpc('uber_catalog_push', { p_items: JSON.parse(line.slice(4)) }); if (!c.error) PFP.cat = line; } catch (e) { } } }
    else if (line.startsWith('PERF ')) {
      if (line !== PFP.perf) {
        try {
          const o = JSON.parse(line.slice(5)); const c = await sb.rpc('uber_perf_push', { p_period: o.period, p_from: o.from, p_items: o.items });
          // veille au même moment (chiffres d'Uber d'hier, du début du même shift jusqu'à la même heure) : période « cmp:… »
          let c2 = { error: null }; if (o.prev && Array.isArray(o.prev.items)) c2 = await sb.rpc('uber_perf_push', { p_period: o.period.replace(/^shift:/, 'cmp:'), p_from: o.prev.from, p_items: o.prev.items });
          if (!c.error && !c2.error) { PFP.perf = line; PFS.at = 0; }
        } catch (e) { }
      }
    }
    else if (line.startsWith('CTRP ')) { if (line !== PFP.ctrp) { const r3 = await pfCtrPush(line.slice(5)); if (r3 !== false) PFP.ctrp = line; } }
    else { const r2 = await pfTripsImport(line.slice(6)); if (r2) note = r2; }
  }
  if (note || PFP.tripsNote) { PFP.tripsNote = note || PFP.tripsNote; diag = 'IMPORT ' + PFP.tripsNote + '\n' + diag; }
  v.diag = diag;
  // plaque écrite sans lettres dans Uber Fleet (« 968211 ») : rapprochée du seul véhicule de Ludy qui a exactement ces chiffres
  const vl = (S.vehList || []).concat(Object.values(S.vehParc || {}));
  v.rows = v.rows.map(x => {
    const d = String(x.plate || '').trim(); if (!/^\d{5,6}$/.test(d)) return x;
    const m = [...new Set(vl.filter(z => String(z.plate || '').replace(/\D/g, '') === d).map(z => z.plate))];
    return m.length === 1 ? Object.assign({}, x, { plate: m[0] }) : x;
  });
  PFP.got = Date.now();
  const sig = JSON.stringify(v.rows) + (v.full ? '|full' : '');
  if (sig === PFP.last && Date.now() - PFP.lastAt < 30000) return;   // rien de changé : renvoyé toutes les 30 s (chauffeurs toujours en ligne)
  const dev = 'Application ' + ((window.LUDY_APP && window.LUDY_APP.version) || '') + ' · ' + (/Win/i.test(navigator.platform || navigator.userAgent) ? 'Windows' : /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Mac' : 'autre');
  const r = await sb.rpc('uber_live_push', { p_rows: v.rows, p_device: dev, p_url: v.url || '', p_diag: v.diag || '', p_full: !!v.full }).then(x => x, e => ({ error: e }));
  if (r.error) { PFP.err = String(r.error.message || r.error); return; }
  PFP.last = sig; PFP.lastAt = Date.now(); PFP.n = r.data || 0; PFP.err = '';
}
/**
 * Application 1.9 : code de lecture (site/uber_read.js) envoyé au volet Uber Fleet toutes les minutes (il ne s'installe qu'une fois par
 * version ; volet rouvert ou rechargé = renvoyé). Application 1.8 : commande absente, la lecture de l'application reste seule (partielle).
 */
const PFR = { code: '', at: 0 };
async function pfReaderSend() {
  if (!S.session || !pfPushCan()) return;
  try {
    if (!PFR.code || Date.now() - PFR.at > 300000) { const r = await fetch('uber_read.js', { cache: 'no-cache' }); if (!r.ok) return; PFR.code = await r.text(); PFR.at = Date.now(); }
    const sh = pfShiftNow();
    if (!PFS.at || Date.now() - PFS.at > 110000) await pfShiftLoad().catch(() => { });   // contrats à faire lire (même hors page En direct)
    await appInvoke('uber_eval', { code: (sh ? 'window.__ludyShift=' + JSON.stringify({ key: sh.key, from: sh.from }) + ';\n' : '') + 'window.__ludyCtrs=' + JSON.stringify({ at: Date.now(), list: (PFS.ask || []).map(x => ({ p: x.p, d: x.d, f: x.f, t: x.t })) }) + ';\n' + PFR.code });
  } catch (e) { }
}
/**
 * Uber Fleet ouvert en arrière-plan (19/11/2026, demande d'Ahmed : « Ludy se connecte directement en arrière-plan sur la carte
 * d'Uber ») : application Mac (volets dans la fenêtre), aucune lecture reçue depuis 25 s, page d'un volet externe pas affichée : le
 * volet Uber Fleet (adresse réglée : la carte en temps réel) est ouvert puis aussitôt caché ; la lecture continue caché (uber_read.js).
 * Windows : volets dans leur propre fenêtre, ouverts par l'utilisateur. Une seule fois par minute au plus.
 */
/**
 * Robot Uber Fleet (application 2.0, 21/11/2026, demande d'Ahmed : « juste ouvrir Ludy et tout se connecte à Uber Fleet en
 * arrière-plan, 24 h/24 ») : volet Uber Fleet ouvert caché dès l'ouverture de Ludy, Mac et Windows (commande ext_bg) ; aucune
 * lecture depuis 3 min = page d'Uber Fleet rechargée (au plus toutes les 5 min) ; page de connexion d'Uber = alerte (pfLoginBar).
 */
function pfRobot() {
  if (!window.LUDY_APP || !window.LUDY_APP.bg || !pfPushCan()) return false;
  const site = extSites().find(x => x.id === 'uber') || extSites().find(x => /^https:\/\/([a-z0-9-]+\.)*uber\.com\//.test(x.url));
  if (!site) return true;
  const now = Date.now(), got = PFP.got || 0;
  if (!PFP.bgAt || (now - got > 60000 && now - PFP.bgAt > 60000)) {   // ouvert caché (sans effet s'il l'est déjà)
    PFP.bgAt = now;
    appInvoke('ext_bg', { id: site.id, url: site.url, name: site.name || 'Uber Fleet' }).then(n => { if (n) PFP.bgOpened = now; }).catch(() => { });
  }
  const since = Math.max(got, PFP.bgOpened || 0, PFP.start || 0);
  if (now - since > 180000 && now - (PFP.reloadAt || 0) > 300000 && !PFP.login) {   // lecture bloquée : page rechargée
    PFP.reloadAt = now; PFP.reloads = (PFP.reloads || 0) + 1;
    appInvoke('ext_reload', { id: site.id, url: site.url }).catch(() => { });
  }
  return true;
}
/** Uber Fleet sur sa page de connexion (session expirée) : bandeau sur toutes les pages, clic = volet Uber Fleet affiché pour se reconnecter */
function pfLoginBar() {
  let el = document.getElementById('pflogin');
  if (!PFP.login || !S.session) { if (el) el.remove(); return; }
  const site = extSites().find(x => x.id === 'uber') || { id: 'uber' };
  if (!el) { el = document.createElement('div'); el.id = 'pflogin'; el.className = 'pflogin'; document.body.appendChild(el); }
  el.innerHTML = `🔴 <b>Uber Fleet n'est plus connecté</b> : la lecture en direct est arrêtée. <a href="#/x-${esc(site.id)}">Se reconnecter à Uber Fleet</a>`;
}
function pfAutoOpen() {
  if (pfRobot()) return;
  if (appMode() !== 'ext' || appExtWin() || !pfPushCan() || /^x-/.test(pageOf())) return;
  const wait = window.__pfAutoMs || 25000;
  if (Date.now() - (PFP.got || PFP.start || 0) < wait || Date.now() - (PFP.opened || 0) < Math.max(wait, 60000)) return;
  const site = extSites().find(x => x.id === 'uber') || extSites().find(x => /^https:\/\/([a-z0-9-]+\.)*uber\.com\//.test(x.url));
  if (!site) return;
  PFP.opened = Date.now();
  appInvoke('ext_show', { id: site.id, url: site.url, x: 0, y: 0, w: 100, h: 100 }).then(() => { if (!/^x-/.test(pageOf())) return appInvoke('ext_hide'); }).catch(() => { });
}
function pfPushStart() {
  if (PFP.timer || !appIpc()) return;
  PFP.start = Date.now();
  PFP.atimer = setInterval(() => { pfAutoOpen(); }, window.__pfAutoMs ? 500 : 10000);
  PFP.timer = setInterval(() => { pfPushTick(); }, 10000);
  PFP.rtimer = setInterval(() => { pfReaderSend(); }, 60000);
  setTimeout(pfReaderSend, 3000);
  pfPushTick();
}

// ---------- Revenus Uber du shift, chauffeur par chauffeur (20/11/2026, demande d'Ahmed : en bas d'En direct, « combien ils ont gagné ») ----------
/** Shift en cours (créneau horaire : jour shiftDay → shiftNight, nuit ensuite ; une nuit appartient au jour où elle commence) */
function pfShiftNow() {
  if (typeof shiftAt !== 'function') return null;
  const cur = shiftAt(Date.now(), S.P); if (!cur) return null;
  return { key: 'shift:' + cur.day + ':' + cur.s, from: shiftStart(cur, S.P).toISOString(), label: shiftDayName(cur) };
}
const PFS = { rows: [], ctr: [], logs: [], perf: {}, at: 0, err: '', busy: false, key: '', sel: '', ask: [], ctrErr: '' };
/** Shift d'un contrat (règle des contrats : heure de prise avancée de shiftAdvance) ; clé « jour:Jour|Nuit » */
function pfShKey(x) { return x ? x.day + ':' + x.s : ''; }
function pfShOf(k) { const m = String(k || '').match(/^(\d{4}-\d{2}-\d{2}):(Jour|Nuit)$/); return m ? { day: m[1], s: m[2] } : null; }
/** Shift en cours au sens des contrats (un contrat pris maintenant appartiendrait à ce shift) */
function pfShCur() { return typeof shiftOfCtr === 'function' && S.P ? shiftOfCtr(new Date(), S.P) : null; }
/** Shift d'avant : nuit du J → jour du J ; jour du J → nuit du J-1 */
function pfShPrev(x) { return x.s === 'Nuit' ? { day: x.day, s: 'Jour' } : { day: addDays(x.day, -1), s: 'Nuit' }; }
/**
 * Totaux d'un shift de contrats (agence du menu) : revenus d'Uber de chaque contrat (ligne « ctr: » ou « ctrj1: »), contrats sans chiffres.
 * j1 : chiffres de la veille au même moment (contrats déjà commencés à maintenant − 24 h).
 */
function pfShiftTot(key, j1) {
  const ok = typeof inAgency === 'function' ? inAgency() : () => true, now = Date.now();
  let l = PFS.ctr.filter(c => c._k === key && ok(c.vehicle_key));
  if (j1) l = l.filter(c => +new Date(c.start_at) < now - DAY);
  const rows = l.map(c => PFS.perf[(j1 ? 'ctrj1:' : 'ctr:') + c.num]).filter(Boolean);
  return { n: l.length, got: rows.length, miss: l.length - rows.length, e: pfSumData(rows, 'e'), cash: pfSumData(rows, 'cash'), t: pfSumData(rows, 't'),
    at: rows.length ? Math.max(...rows.map(r => +new Date(r.updated_at))) : 0 };
}
/**
 * Total du shift en cours (contrats Ludy) comparé à la veille au même moment (21/11/2026, demande d'Ahmed) : écart en % seulement si
 * chaque contrat des deux côtés a ses chiffres (sinon le total serait incomplet : rien d'estimé).
 */
function pfShiftCmp() {
  const cur = pfShCur(); if (!cur || !PFS.at) return null;
  const k = pfShKey(cur), y = pfShKey({ day: addDays(cur.day, -1), s: cur.s }), a = pfShiftTot(k), b = pfShiftTot(y, true);
  if (!a.n) return null;
  return { label: shiftDayName(cur), a, b, pct: !a.miss && !b.miss && b.e > 0 ? (a.e - b.e) / b.e : null, at: a.at, stale: a.at && Date.now() - a.at > 10 * 60000 };
}
function pfShiftChips() {
  const c = pfShiftCmp(); if (!c) return '';
  const pct = c.pct == null ? '' : `<span class="kchip ${c.pct >= 0 ? 'pf-up' : 'pf-down'}" title="Écart avec la veille au même moment (contrats du même shift)"><b>${c.pct >= 0 ? '+' : '−'}${f0(Math.abs(c.pct) * 100)} %</b> ${c.pct >= 0 ? 'de plus que' : 'de moins que'} J-1</span>`;
  const miss = x => x.miss ? ` · ${f0(x.miss)} contrat(s) sans chiffres` : '';
  return `<span class="kchip pf-total" title="Revenus Uber des chauffeurs sous contrat du shift (${esc(c.label)}), chacun du début de son contrat à maintenant ou à la fin du contrat · ${f0(c.a.got)} contrat(s), ${f0(c.a.t)} course(s)${miss(c.a)}"><b>${f0(c.a.e)} MAD</b> total shift${c.a.cash ? ' · dont ' + f0(c.a.cash) + ' espèces' : ''}${c.a.miss ? ' · incomplet' : ''}${c.stale ? ' · chiffres de ' + esc(localHM(new Date(c.at))) : ''}</span>
    ${c.b.n ? `<span class="kchip" title="Contrats du même shift hier, chacun arrêté à la même heure qu'aujourd'hui moins 24 h${miss(c.b)}"><b>${f0(c.b.e)} MAD</b> J-1 à ${esc(localHM(new Date(Date.now() - DAY)))}${c.b.miss ? ' · incomplet' : ''}</span>${pct}` : '<span class="kchip mute">J-1 : aucun contrat</span>'}`;
}
function pfShiftLoad() {
  if (PFS.busy) return PFS.p.then(() => pfShiftLoad());   // lecture en cours : attendue, puis relue (données à jour)
  PFS.busy = true;
  return (PFS.p = pfShiftRead());
}
/**
 * Contrats des 56 dernières heures, compte Uber de chacun, chiffres d'Uber par contrat, liste des contrats à faire lire par l'application
 * (PFS.ask : shift en cours et shift d'avant tant que le contrat n'a pas sa ligne finale ; contrats d'hier du même shift, arrêtés à la même
 * heure qu'aujourd'hui ; contrats sans aucune ligne, 60 au plus).
 */
async function pfShiftRead() {
  const now = Date.now(), from = new Date(now - 56 * HOUR).toISOString();
  try {
    const cs = await all('contracts', 'num,name,phone,vehicle_key,plate,start_at,end_at', q => q.gt('start_at', from).lte('start_at', new Date(now + HOUR).toISOString()).not('vehicle_key', 'is', null));
    const byV = {}; cs.forEach(c => { (byV[c.vehicle_key] = byV[c.vehicle_key] || []).push(c); });
    const ctr = [].concat(...Object.values(byV).map(l => ctrEffEnds(l, now)));
    const [logs, pfs] = await Promise.all([
      all('uber_live_log', 'id,vehicle_key,driver_id,driver_name,status,started_at,ended_at', q => q.gt('started_at', new Date(now - 60 * HOUR).toISOString()).not('driver_id', 'is', null)).catch(() => []),
      all('uber_perf', 'driver_id,period,driver_name,vehicle_key,updated_at', q => q.like('period', 'shift:%').gte('updated_at', from)).catch(() => [])]);
    ctr.forEach(c => { c._sh = shiftOfCtr(c.start_at, S.P); c._k = pfShKey(c._sh); c._u = pfCtrDriver(c, logs, pfs, now); });
    const periods = ctr.map(c => 'ctr:' + c.num).concat(ctr.map(c => 'ctrj1:' + c.num)), perf = {};
    for (let i = 0; i < periods.length; i += 80) {
      const r = await sb.from('uber_perf').select('driver_id,driver_name,period,data,updated_at,period_from').in('period', periods.slice(i, i + 80));
      if (r.error) throw r.error;
      (r.data || []).forEach(x => { perf[x.period] = x; });
    }
    // chiffres du shift horaire (chauffeurs en ligne sur Uber sans contrat Ludy)
    const sh = pfShiftNow(); let rows = [];
    if (sh) { const r = await sb.from('uber_perf').select('driver_id,driver_name,plate,vehicle_key,data,updated_at').eq('period', sh.key).limit(500); if (!r.error) rows = r.data || []; }
    const cur = pfShCur(), ck = pfShKey(cur), pk = pfShKey(pfShPrev(cur)), yk = pfShKey({ day: addDays(cur.day, -1), s: cur.s }), ask = [];
    // rattrapage (toutes les 30 min) : contrats des 8 derniers jours sans chiffres finaux (historique des shifts)
    if (!PFS.bfAt || now - PFS.bfAt > 30 * 60000) {
      PFS.bfAt = now; PFS.backfill = [];
      try {
        const old = await all('contracts', 'num,name,vehicle_key,plate,start_at,end_at', q => q.gt('start_at', new Date(now - 8 * DAY).toISOString()).lte('start_at', from).not('vehicle_key', 'is', null));
        if (old.length) {
          const byO = {}; old.concat(cs).forEach(c => { (byO[c.vehicle_key] = byO[c.vehicle_key] || []).push(c); });
          const oc = [].concat(...Object.values(byO).map(l => ctrEffEnds(l, now))).filter(c => +new Date(c.start_at) <= +new Date(from));
          const have = {};
          for (let i = 0; i < oc.length; i += 80) { const r = await sb.from('uber_perf').select('period,data').in('period', oc.slice(i, i + 80).map(c => 'ctr:' + c.num)); (r.data || []).forEach(x => { have[x.period] = x; }); }
          const miss = oc.filter(c => c._end && !(have['ctr:' + c.num] && +(have['ctr:' + c.num].data || {}).to >= c._end));
          if (miss.length) {
            const lo = miss.map(c => c.start_at).sort()[0];
            const [ol, op] = await Promise.all([
              all('uber_live_log', 'id,vehicle_key,driver_id,driver_name,status,started_at,ended_at', q => q.gt('started_at', new Date(+new Date(lo) - 6 * HOUR).toISOString()).lte('started_at', from).not('driver_id', 'is', null)).catch(() => []),
              all('uber_perf', 'driver_id,period,driver_name,vehicle_key,updated_at', q => q.like('period', 'shift:%').gte('updated_at', lo).lte('updated_at', from)).catch(() => [])]);
            miss.forEach(c => { const u = pfCtrDriver(c, ol.concat(logs), op.concat(pfs), now); if (u) PFS.backfill.push({ p: 'ctr:' + c.num, d: u.d, f: +new Date(c.start_at), t: c._end, k: c.num }); });
          }
        }
      } catch (e) { }
    }
    ctr.forEach(c => {
      if (!c._u) return;
      const f = +new Date(c.start_at), end = c._end && c._end < now ? c._end : null, t = end || Math.floor(now / 60000) * 60000, row = perf['ctr:' + c.num];
      const final = row && end && +(row.data || {}).to >= end && +new Date(row.updated_at) > end + 3 * HOUR;
      if ((c._k === ck || c._k === pk || !row) && !final && t > f) ask.push({ p: 'ctr:' + c.num, d: c._u.d, f, t, k: c.num });
      if (c._k === yk) { const t1 = Math.min(end || Infinity, Math.floor((now - DAY) / 60000) * 60000); if (t1 > f) ask.push({ p: 'ctrj1:' + c.num, d: c._u.d, f, t: t1, k: c.num }); }
    });
    const inAsk = new Set(ask.map(x => x.p)); (PFS.backfill || []).forEach(x => { if (!inAsk.has(x.p) && !(perf[x.p] && +(perf[x.p].data || {}).to >= x.t)) ask.push(x); });
    Object.assign(PFS, { ctr, logs, perf, rows, key: sh ? sh.key : '', ask: ask.slice(0, 120), at: Date.now(), err: '' });
  } catch (e) { PFS.err = String(e.message || e); } finally { PFS.busy = false; }
  // courses une par une (rapport « Activité des courses ») depuis le plus ancien contrat affiché
  try {
    const sel = PFS.sel || pfShKey(pfShCur()), l = PFS.ctr.filter(c => c._k === sel), f = l.length ? l.map(c => c.start_at).sort()[0] : new Date(now - 14 * HOUR).toISOString();
    const t = await sb.from('uber_trips').select('uuid,driver_uuid,driver_name,plate,vehicle_key,requested_at,dropoff_at,pickup_addr,drop_addr,km,status,payment,product')
      .gte('requested_at', f).order('requested_at', { ascending: true }).limit(1500);
    if (t.error) throw t.error;
    PFT.rows = t.data || []; PFT.key = sel; PFT.at = Date.now(); PFT.err = '';
  } catch (e) { PFT.err = String(e.message || e); PFT.rows = []; }
}
const PFT = { rows: [], key: '', at: 0, err: '', open: new Set() };
const PF_TRIP_ST = { completed: 'Terminée', rider_cancelled: 'Annulée par le client', driver_cancelled: 'Annulée par le chauffeur', failed: 'Échouée', unfulfilled: 'Non servie' };
function pfTripSt(s) { const k = String(s || '').toLowerCase(); return PF_TRIP_ST[k] || s || ''; }
/** Courses d'un compte Uber pendant une période (contrat) */
function pfTripsOf(id, from, to) {
  const i = String(id || '').toLowerCase(), f = from ? +new Date(from) : 0, t = to || Infinity;
  return PFT.rows.filter(x => i && String(x.driver_uuid || '').toLowerCase() === i && +new Date(x.requested_at) >= f && +new Date(x.requested_at) < t);
}
function pfTripCounts(l) {
  const c = { done: 0, rc: 0, dc: 0, other: 0, km: 0 };
  l.forEach(t => { const s = String(t.status || '').toLowerCase(); if (s === 'completed') { c.done++; if (t.km != null) c.km += +t.km; } else if (s === 'rider_cancelled') c.rc++; else if (s === 'driver_cancelled') c.dc++; else c.other++; });
  return c;
}
function pfTripsTable(l) {
  if (!l.length) return '<div class="empty small">Aucune course de ce compte Uber pendant le contrat dans le rapport « Activité des courses ».</div>';
  const dur = t => t.dropoff_at && t.requested_at ? Math.round((new Date(t.dropoff_at) - new Date(t.requested_at)) / 60000) + ' min' : '';
  return `<table class="tbl ubtrips"><thead><tr><th>Demande</th><th>Dépose</th><th>Durée</th><th>Statut</th><th>Prise en charge</th><th>Dépose</th><th class="n">km</th><th>Paiement</th><th>Véhicule</th></tr></thead><tbody>${l.map(t => {
    const s = String(t.status || '').toLowerCase();
    return `<tr class="${s === 'completed' ? '' : s === 'driver_cancelled' ? 'ubt-dc' : 'ubt-rc'}"><td>${esc(localHM(new Date(t.requested_at)))}</td><td>${t.dropoff_at ? esc(localHM(new Date(t.dropoff_at))) : ''}</td><td class="small">${dur(t)}</td>
      <td>${esc(pfTripSt(t.status))}</td><td class="small">${esc(t.pickup_addr || '')}</td><td class="small">${esc(t.drop_addr || '')}</td><td class="n">${t.km != null && s === 'completed' ? f1(+t.km) : ''}</td>
      <td class="small">${esc(t.payment || '')}</td><td>${t.plate ? esc(t.plate) : ''}</td></tr>`; }).join('')}</tbody></table>`;
}
/**
 * Tableau en bas d'En direct (21/11/2026, demande d'Ahmed : « combien a rapporté le chauffeur selon son shift de travail, pas selon
 * Uber ») : un contrat Ludy par ligne, chiffres d'Uber du compte du chauffeur du début à la fin de son contrat ; shift = règle des
 * contrats (heure de prise) ; choix du shift ; J-1 ; chauffeurs en ligne sur Uber sans contrat Ludy à part.
 */
function pfShiftHtml() {
  if (PFS.err) return /does not exist|relation|schema cache|PGRST20|42P01/i.test(PFS.err) ? '' : `<div class="sechead"><h2>Uber · revenus par contrat</h2></div>${msg('Lecture impossible : ' + esc(PFS.err), 'warn')}`;
  if (!PFS.at) return '';
  const ok = typeof inAgency === 'function' ? inAgency() : () => true, now = Date.now(), cur = pfShCur(), ck = pfShKey(cur);
  const keys = [...new Set(PFS.ctr.map(c => c._k).concat([ck]))].filter(Boolean).sort().reverse().slice(0, 5), sel = keys.includes(PFS.sel) ? PFS.sel : ck, X = pfShOf(sel);
  const list = PFS.ctr.filter(c => c._k === sel && ok(c.vehicle_key)).sort((a, b) => ((PFS.perf['ctr:' + b.num] || {}).data || {}).e - ((PFS.perf['ctr:' + a.num] || {}).data || {}).e || new Date(a.start_at) - new Date(b.start_at));
  const D = c => (PFS.perf['ctr:' + c.num] || {}).data || null, hm = h => h == null ? '' : Math.floor(h) + ' h ' + String(Math.round((h % 1) * 60)).padStart(2, '0'), pct = v => v == null ? '' : f0(v * 100) + ' %';
  const tripsOk = !PFT.err && PFT.key === sel, dm = d => d.slice(8, 10) + '/' + d.slice(5, 7);
  const sel2 = `<select id="pfshsel">${keys.map(k => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(shiftDayName(pfShOf(k)))}${k === ck ? ' (en cours)' : ''}</option>`).join('')}</select>`;
  // veille : shift en cours = même heure hier ; autre shift = shift entier de la veille
  const yk = pfShKey({ day: addDays(X.day, -1), s: X.s }), a = pfShiftTot(sel), b = pfShiftTot(yk, sel === ck);
  const cmp = b.n ? `J-1 (${esc(shiftDayName(pfShOf(yk)))}${sel === ck ? ', chaque contrat arrêté à ' + esc(localHM(new Date(now - DAY))) : ', shift entier'}) : <b>${f0(b.e)} MAD</b>${b.miss ? ' · ' + f0(b.miss) + ' contrat(s) sans chiffres' : ''}${!a.miss && !b.miss && b.e > 0 ? ` · <b class="${a.e >= b.e ? 'ok' : 'bad'}">${a.e >= b.e ? '+' : '−'}${f0(Math.abs(a.e - b.e) / b.e * 100)} %</b>` : (a.miss || b.miss ? ' · écart non calculé (chiffres incomplets)' : '')}` : 'J-1 : aucun contrat';
  const head = `<div class="sechead"><h2>Uber · revenus par contrat · ${sel2}</h2><span class="small">Chaque chauffeur : chiffres d'Uber de son compte du début de son contrat Ludy à sa fin (ou maintenant), quelle que soit la journée d'Uber. Shift = heure de prise du contrat (de ${String((num(S.P.shiftDay, 7) - num(S.P.shiftAdvance, 2) + 24) % 24).padStart(2, '0')}:00 à ${String((num(S.P.shiftNight, 19) - num(S.P.shiftAdvance, 2) + 24) % 24).padStart(2, '0')}:00 = jour, sinon nuit). Relu toutes les 2 min par l'application Ludy.${PFS.ctrErr ? ' · ' + esc(PFS.ctrErr) : ''}</span></div>
    <div class="pfcmp small">${cmp}</div>`;
  if (!list.length) return head + `<div class="empty">Aucun contrat Ludy dans ce shift.</div>`;
  const tr = c => {
    const d = D(c), u = c._u, end = c._end && c._end < now ? c._end : null, tl = tripsOk && u ? pfTripsOf(u.d, c.start_at, end || now) : [], cc = pfTripCounts(tl), op = PFT.open.has(c.num);
    const eph = d && d.e != null && d.h > 0 ? d.e / d.h : null, name = (u && u.name) || '';
    const same = name && c.name && normPlate(name.split(' ').sort().join('')) === normPlate(String(c.name).split(' ').sort().join(''));
    const acct = !u ? '<span class="bad small">aucun compte Uber vu sur ce véhicule pendant le contrat</span>' : same ? '<span class="small ok">✓</span>' : `<span class="small" title="Compte Uber vu sur ce véhicule pendant le contrat">${esc(name || 'compte ' + u.d.slice(0, 8))}</span>`;
    const val = d ? '' : u ? '<span class="nm">lecture en attente</span>' : '<span class="nm">non mesuré</span>';
    return `<tr class="ubdrv${op ? ' open' : ''}" data-ubd="${esc(c.num)}" title="Cliquer pour voir les courses Uber du contrat"><td><span class="ubcar">${op ? '▾' : '▸'}</span> ${esc(c.name || '')}<div class="small">${esc(c.num)}</div></td><td>${acct}</td><td>${plate(c.plate || c.vehicle_key)}</td>
      <td class="small">${esc(dm(localDay(new Date(c.start_at))))} ${esc(localHM(new Date(c.start_at)))} → ${end ? esc(localHM(new Date(end))) : 'en cours'}</td>
      <td class="n"><b>${d ? f0(d.e || 0) + ' MAD' : val}</b></td><td class="n">${d && d.cash != null ? f0(d.cash) + ' MAD' : ''}</td><td class="n">${d && d.t != null ? f0(d.t) : ''}</td>
      <td class="n">${d ? hm(d.h) : ''}</td><td class="n">${d ? hm(d.hot) : ''}</td><td class="n">${d ? hm(d.hto) : ''}</td><td class="n">${eph != null ? f0(eph) + ' MAD' : ''}</td>
      <td class="n${d && d.a != null && d.a < 0.8 ? ' bad' : ''}">${d ? pct(d.a) : ''}</td><td class="n">${d ? pct(d.c) : ''}</td>
      ${tripsOk ? `<td class="n">${tl.length ? f0(cc.done) : ''}</td><td class="n${cc.rc + cc.dc ? ' bad' : ''}">${tl.length ? f0(cc.rc + cc.dc) + (cc.dc ? ' <span class="small">(' + f0(cc.dc) + ' chauffeur)</span>' : '') : ''}</td><td class="n">${cc.done ? f1(cc.km) : ''}</td>` : ''}</tr>
      ${op ? `<tr class="ubdet"><td colspan="${tripsOk ? 16 : 13}">${u ? pfTripsTable(tl) : '<div class="empty small">Aucun compte Uber relié à ce contrat.</div>'}</td></tr>` : ''}`;
  };
  const rows = list.map(c => ({ data: D(c) })).filter(r => r.data), sum = k => pfSumData(rows, k), tE = sum('e'), tH = sum('h');
  const allT = tripsOk ? pfTripCounts([].concat(...list.map(c => c._u ? pfTripsOf(c._u.d, c.start_at, c._end && c._end < now ? c._end : now) : []))) : null;
  let html = head + `<div class="tblwrap"><table class="tbl" id="tubshift"><thead><tr><th>Chauffeur (contrat)</th><th>Compte Uber</th><th>Véhicule</th><th>Contrat</th><th class="n">Revenus</th><th class="n">dont espèces</th><th class="n">Courses</th>
    <th class="n">En ligne</th><th class="n">En course</th><th class="n">Vers le client</th><th class="n">Revenus / h en ligne</th><th class="n">Acceptation</th><th class="n">Annulation</th>${tripsOk ? '<th class="n">Courses terminées</th><th class="n">Annulées</th><th class="n">km en course</th>' : ''}</tr></thead>
    <tbody>${list.map(tr).join('')}</tbody><tfoot><tr><td><b>Total (${f0(list.length)} contrats${a.miss ? ', ' + f0(a.miss) + ' sans chiffres' : ''})</b></td><td></td><td></td><td></td><td class="n"><b>${f0(tE)} MAD</b></td><td class="n">${f0(sum('cash'))} MAD</td><td class="n">${f0(sum('t'))}</td>
    <td class="n">${hm(tH)}</td><td class="n">${hm(sum('hot'))}</td><td class="n">${hm(sum('hto'))}</td><td class="n">${tH > 0 ? f0(tE / tH) + ' MAD' : ''}</td><td></td><td></td>${allT ? `<td class="n">${f0(allT.done)}</td><td class="n">${f0(allT.rc + allT.dc)}</td><td class="n">${f1(allT.km)}</td>` : ''}</tr></tfoot></table></div>`;
  // en ligne sur Uber pendant ce shift sans contrat Ludy (chiffres du shift horaire)
  if (sel === ck) {
    const mine = new Set(PFS.ctr.filter(c => c._k === ck && c._u).map(c => c._u.d)), a2 = typeof agFilter === 'function' ? agFilter() : '';
    const out = PFS.rows.filter(r => !mine.has(r.driver_id) && (r.vehicle_key ? ok(r.vehicle_key) : !a2) && (r.data || {}).e > 0);
    if (out.length) html += `<details class="pfdet"><summary>En ligne sur Uber sans contrat Ludy dans ce shift (${f0(out.length)})</summary><div class="small">Chiffres d'Uber depuis le début du shift horaire (${esc(localHM(new Date(pfShiftNow().from)))}), pas de contrat pour les rattacher.</div>
      <table class="tbl"><thead><tr><th>Compte Uber</th><th>Véhicule</th><th class="n">Revenus</th><th class="n">dont espèces</th><th class="n">Courses</th></tr></thead><tbody>${out.map(r => `<tr><td>${esc(r.driver_name || '')}</td><td>${r.plate ? plate(r.plate) : ''}</td><td class="n">${f0(r.data.e || 0)} MAD</td><td class="n">${r.data.cash != null ? f0(r.data.cash) + ' MAD' : ''}</td><td class="n">${r.data.t != null ? f0(r.data.t) : ''}</td></tr>`).join('')}</tbody></table></details>`;
  }
  return html;
}
function pfShiftPaint() {
  const el = $('#liveubshift'); if (!el) return;
  el.innerHTML = pfShiftHtml();
  if (!el.__ubd) {
    el.__ubd = 1;
    el.addEventListener('click', e => { const t = e.target.closest('[data-ubd]'); if (!t) return; const id = t.getAttribute('data-ubd'); if (PFT.open.has(id)) PFT.open.delete(id); else PFT.open.add(id); pfShiftPaint(); });
    el.addEventListener('change', e => { if (e.target && e.target.id === 'pfshsel') { PFS.sel = e.target.value; PFT.key = ''; pfShiftLoad().then(pfShiftPaint); } });
  }
}
