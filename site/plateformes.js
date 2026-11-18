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
