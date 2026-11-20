// Zones Uber (20/11/2026, demande d'Ahmed : « analyser toutes les courses, endroit, jour, heure, pour prédire les zones de prise en charge »,
// « un nuage de zones de travail pour rentabiliser »). Page #/zones.
// Carte : cases de 300 m à 1 km colorées selon les prises en charge réelles (positions GPS d'Uber Fleet au début de chaque course,
// enregistrées par l'application Ludy, uber_zones), pour le créneau choisi (jours, heures, à l'heure du Maroc) ; classement des zones
// où envoyer les chauffeurs disponibles (prises en charge par semaine, attente avant une demande, km à vide) ; demandes Uber par jour et
// par heure d'après les rapports « Activité des courses » (uber_demand). Moyennes mesurées sur les semaines de données, rien d'estimé.

const ZN = { map: null, layer: null, rows: [], demand: [], first: null, firstTrip: null, key: '', names: {}, busy: false, err: '' };
const ZN_COLORS = ['#fde7c8', '#fbc58a', '#f59e4b', '#e4692a', '#b8360f'];
const ZN_LAYERS = { pickup: 'Prises en charge', approach: 'Demandes reçues', dropoff: 'Déposes', wait: 'Attente avant une demande' };
function znLs(k, d) { try { const v = localStorage.getItem('zn.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function znSet(k, v) { try { localStorage.setItem('zn.' + k, JSON.stringify(v)); } catch (e) { } }
try { ZN.names = JSON.parse(localStorage.getItem('zn.names') || '{}') || {}; } catch (e) { ZN.names = {}; }
/** Jour (1 = lundi) et heure maintenant, à l'heure du Maroc */
function znNow() {
  const d = new Date(), day = localDay(d), h = +localHM(d).slice(0, 2);
  const wd = new Date(day + 'T00:00:00Z').getUTCDay();
  return { dow: wd === 0 ? 7 : wd, hour: h };
}
function znState() {
  const n = znNow();
  return { weeks: znLs('weeks', 4), days: znLs('days', null) || [n.dow], h1: znLs('h1', null) ?? n.hour, h2: znLs('h2', null) ?? (n.hour + 1) % 24,
    layer: znLs('layer', 'pickup'), cell: znLs('cell', 0.005) };
}
async function znLoad(st) {
  const to = new Date(), from = new Date(to.getTime() - st.weeks * 7 * 86400000), a = agFilter() ? +agFilter() : null;
  const key = [st.weeks, st.cell, a, Math.floor(to / 300000)].join('|');
  if (key === ZN.key && !ZN.err) return;
  const [rows, demand, first, firstTrip] = await Promise.all([
    rpcAll('uber_zones', { p_from: from.toISOString(), p_to: to.toISOString(), p_agency: a, p_cell: st.cell }, ['kind', 'cy', 'cx', 'dow', 'hour']),
    rpcAll('uber_demand', { p_from: from.toISOString(), p_to: to.toISOString(), p_agency: a }, ['dow', 'hour']).catch(() => []),
    sb.from('uber_live_log').select('started_at').not('lat0', 'is', null).order('started_at', { ascending: true }).limit(1).then(r => (r.data && r.data[0] || {}).started_at || null, () => null),
    sb.from('uber_trips').select('requested_at').gte('requested_at', from.toISOString()).order('requested_at', { ascending: true }).limit(1).then(r => (r.data && r.data[0] || {}).requested_at || null, () => null)
  ]);
  Object.assign(ZN, { rows, demand, first, firstTrip, from, to, key, err: '' });
}

async function pageZones() {
  const rid = ROUTING;
  await loadRef();
  if (rid !== ROUTING) return;
  $('#page').innerHTML = '<div class="head"><h1>Zones Uber</h1></div><div class="empty">Chargement des courses et des positions…</div>';
  const st = znState();
  try { await znLoad(st); }
  catch (e) {
    if (rid !== ROUTING) return;
    $('#page').innerHTML = '<div class="head"><h1>Zones Uber</h1></div>' + msg(/uber_zones|PGRST202|does not exist/.test(e.message || '') ? 'Module pas encore installé : migration <code>20261210000000_uber_zones.sql</code> à exécuter.' : 'Erreur : ' + esc(e.message || e), 'err');
    return;
  }
  if (rid !== ROUTING) return;
  znDraw(st);
}

function znDraw(st) {
  const slot = znSlot(st.days, st.h1, st.h2), weeks = znWeeks(ZN.from, ZN.to, ZN.first), cells = znCells(ZN.rows, slot), rank = znRank(cells, weeks, 3);
  const all = znCells(ZN.rows, null), totPu = all.reduce((t, c) => t + c.pickup, 0), slotPu = cells.reduce((t, c) => t + c.pickup, 0);
  const dayOpt = [['all', 'Tous les jours', [1, 2, 3, 4, 5, 6, 7]], ['wk', 'Lundi → vendredi', [1, 2, 3, 4, 5]], ['we', 'Samedi et dimanche', [6, 7]]]
    .concat(['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].map((d, i) => [String(i + 1), d, [i + 1]]));
  const dsel = dayOpt.find(o => o[2].join() === st.days.slice().sort().join()) || dayOpt[0];
  const hopt = sel => Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${String(h).padStart(2, '0')} h</option>`).join('');
  const label = `${esc(dsel[1].toLowerCase())}, de ${String(st.h1).padStart(2, '0')} h à ${String((st.h2 + 1) % 24).padStart(2, '0')} h`;
  const since = ZN.first ? new Date(ZN.first) : null;
  const info = since ? `Positions des courses enregistrées depuis le ${esc(localDay(since).split('-').reverse().join('/'))} ${esc(localHM(since))} · ${f1(weeks)} semaine(s) de données sur la période · ${f0(totPu)} prise(s) en charge, dont ${f0(slotPu)} dans le créneau.`
    : 'Aucune position de course enregistrée pour l\'instant : elles sont relevées dans Uber Fleet par l\'application Ludy (ordinateur avec Uber Fleet connecté) et la carte se remplit au fil des jours.';
  const wk = n => n == null ? '' : (n >= 10 ? f0(n) : f1(n));
  const top = rank.slice(0, 12);
  $('#page').innerHTML = `<div class="head"><h1>Zones Uber</h1><span class="small">${esc(agFilter() ? (S.agName || {})[agFilter()] || '' : 'Toutes les agences')}</span></div>
    <div class="znbar">
      <label>Période <select id="znw">${[2, 4, 8, 12, 26].map(w => `<option value="${w}"${w === st.weeks ? ' selected' : ''}>${w} dernières semaines</option>`).join('')}</select></label>
      <label>Jours <select id="znd">${dayOpt.map(o => `<option value="${o[0]}"${o === dsel ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>
      <label>De <select id="znh1">${hopt(st.h1)}</select></label><label>à <select id="znh2">${hopt(st.h2)}</select></label>
      <button class="btn small" id="znnow">Maintenant</button>
      <label>Carte <select id="znl">${Object.entries(ZN_LAYERS).map(([k, v]) => `<option value="${k}"${k === st.layer ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>Zone <select id="znc">${[[0.003, '300 m'], [0.005, '500 m'], [0.01, '1 km']].map(([v, l]) => `<option value="${v}"${v === st.cell ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <p class="small">${info}</p>
    <div class="znwrap">
      <div><div id="znmap"></div><div class="znleg" id="znleg"></div></div>
      <div class="zntop"><h2>Où envoyer les chauffeurs disponibles</h2><p class="small">Créneau : ${label}. Classement par prises en charge réelles par semaine dans la zone, puis par attente la plus courte.</p>
        ${top.length ? `<table class="tbl" id="tzones"><thead><tr><th>#</th><th>Zone</th><th class="n">Prises en charge / sem.</th><th class="n">Attente avant demande</th><th class="n">km à vide vers le client</th><th class="n">Durée course</th></tr></thead><tbody>
        ${top.map((c, i) => `<tr data-zn="${c.key}"${c.few ? ' class="few"' : ''}><td>${i + 1}</td><td>${esc(ZN.names[znNameKey(c, st.cell)] || 'Zone ' + znCenter(c.cy, c.cx, st.cell).map(x => x.toFixed(4)).join(', '))}${c.few ? ' <span class="small">· peu de données</span>' : ''}</td>
          <td class="n"><b>${wk(c.perWeek)}</b></td><td class="n">${c.avgWait != null ? f0(c.avgWait) + ' min' : '<span class="nm">non mesuré</span>'}</td><td class="n">${c.avgApp != null ? f1(c.avgApp) + ' km' : '<span class="nm">non mesuré</span>'}</td>
          <td class="n">${c.avgTrip != null ? f0(c.avgTrip) + ' min' : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">Aucune prise en charge enregistrée dans ce créneau.</div>`}
      </div>
    </div>
    <section id="zndem">${znDemandHtml(st)}</section>
    <p class="small">Aéroport : les prises en charge réelles à l'aéroport apparaissent sur la carte. Prévoir avec les arrivées des vols demande un service de données de vols (à choisir) : pas encore branché.</p>`;
  const go = patch => { Object.entries(patch).forEach(([k, v]) => znSet(k, v)); pageZones(); };
  $('#znw').onchange = e => go({ weeks: +e.target.value });
  $('#znd').onchange = e => go({ days: (dayOpt.find(o => o[0] === e.target.value) || dayOpt[0])[2] });
  $('#znh1').onchange = e => go({ h1: +e.target.value });
  $('#znh2').onchange = e => go({ h2: +e.target.value });
  $('#znl').onchange = e => go({ layer: e.target.value });
  $('#znc').onchange = e => go({ cell: +e.target.value });
  $('#znnow').onclick = () => { const n = znNow(); go({ days: [n.dow], h1: n.hour, h2: (n.hour + 1) % 24 }); };
  znMap(cells, st, weeks);
  $('#tzones') && $('#tzones').addEventListener('click', e => { const tr = e.target.closest('[data-zn]'); if (!tr || !ZN.map) return; const c = cells.find(x => x.key === tr.getAttribute('data-zn')); if (!c) return;
    ZN.map.fitBounds(znBounds(c.cy, c.cx, st.cell), { maxZoom: 16 }); const l = ZN.byKey && ZN.byKey[c.key]; if (l) l.openPopup(); });
  znNames(top, st.cell);
}

function znNameKey(c, cell) { return cell + ':' + c.cy + ':' + c.cx; }
/** Nom des zones du classement : adresse la plus proche du centre (Photon, OpenStreetMap), gardée dans le navigateur */
async function znNames(top, cell) {
  if (ZN.busy) return; ZN.busy = true;
  try {
    for (const c of top) {
      const k = znNameKey(c, cell); if (ZN.names[k]) continue;
      const [la, lo] = znCenter(c.cy, c.cx, cell);
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${la.toFixed(5)}&lon=${lo.toFixed(5)}&lang=fr&limit=1`).then(x => x.ok ? x.json() : null, () => null);
      const p = r && r.features && r.features[0] && r.features[0].properties; if (!p) continue;
      const nm = [p.name, p.street, p.district || p.locality, p.city].filter((x, i, l) => x && l.indexOf(x) === i).slice(0, 3).join(', ');
      if (!nm) continue;
      ZN.names[k] = nm; try { localStorage.setItem('zn.names', JSON.stringify(ZN.names)); } catch (e) { }
      const tr = document.querySelector(`#tzones tr[data-zn="${c.key}"] td:nth-child(2)`); if (tr) tr.innerHTML = esc(nm) + (c.few ? ' <span class="small">· peu de données</span>' : '');
      await new Promise(res => setTimeout(res, 400));
    }
  } finally { ZN.busy = false; }
}

function znMap(cells, st, weeks) {
  const el = $('#znmap'); if (!el || typeof L === 'undefined') return;
  if (ZN.map) { try { ZN.map.remove(); } catch (e) { } ZN.map = null; }
  ZN.map = L.map(el, { scrollWheelZoom: true, zoomControl: true }); osmLayer().addTo(ZN.map);
  const low = st.layer === 'wait', vals = cells.map(c => znVal(c, st.layer, weeks)), steps = znSteps(vals);
  ZN.byKey = {};
  const shown = [];
  cells.forEach((c, i) => {
    const v = vals[i], lv = znLevel(v, steps, low); if (lv < 0) return;
    const r = L.rectangle(znBounds(c.cy, c.cx, st.cell), { stroke: true, weight: 0.5, color: ZN_COLORS[lv], fillColor: ZN_COLORS[lv], fillOpacity: 0.25 + lv * 0.12 }).addTo(ZN.map);
    const ctr = znCenter(c.cy, c.cx, st.cell);
    r.bindPopup(`<b>${esc(ZN.names[znNameKey(c, st.cell)] || 'Zone')}</b><br>Prises en charge : ${f0(c.pickup)} (${f1(c.pickup / weeks)} / sem.)<br>Demandes reçues ici : ${f0(c.approach)}<br>Déposes : ${f0(c.dropoff)}
      <br>Attente avant une demande : ${c.avgWait != null ? f0(c.avgWait) + ' min (' + f0(c.wait) + ' attentes)' : 'non mesuré'}${c.idle ? '<br>Disponible sans demande puis déconnecté : ' + f0(c.idle) + ' fois' : ''}
      <br>km à vide vers le client : ${c.avgApp != null ? f1(c.avgApp) + ' km' : 'non mesuré'}<br>Durée moyenne des courses : ${c.avgTrip != null ? f0(c.avgTrip) + ' min' : 'non mesuré'}
      <br><a href="https://www.google.com/maps?q=${ctr[0].toFixed(5)},${ctr[1].toFixed(5)}" target="_blank" rel="noopener">Google Maps</a>`);
    ZN.byKey[c.key] = r; shown.push(znBounds(c.cy, c.cx, st.cell));
  });
  if (shown.length) ZN.map.fitBounds(shown.reduce((b, x) => b.extend(x), L.latLngBounds(shown[0])), { maxZoom: 14, padding: [20, 20] });
  else ZN.map.setView([31.63, -8.0], 12);
  const unit = st.layer === 'wait' ? ' min' : ' / sem.', fmt = x => st.layer === 'wait' ? f0(x) : f1(x);
  const leg = $('#znleg');
  if (leg) leg.innerHTML = steps.length ? `<span>${esc(ZN_LAYERS[st.layer])}${low ? ' (plus court = plus foncé)' : ''} :</span>` + ZN_COLORS.map((col, i) => {
    const lo = i === 0 ? null : steps[i - 1], hi = steps[i] == null ? null : steps[i], j = low ? 4 - i : i, c2 = ZN_COLORS[j];
    return `<span class="znsw"><i style="background:${c2}"></i>${lo == null ? '≤ ' + fmt(hi) : hi == null ? '> ' + fmt(lo) : fmt(lo) + ' – ' + fmt(hi)}${unit}</span>`; }).join('') : '';
}

/** Demandes Uber par jour et par heure (rapports « Activité des courses »), moyenne par semaine ; créneau choisi encadré */
function znDemandHtml(st) {
  const g = znDemandGrid(ZN.demand), weeks = znWeeks(ZN.from, ZN.to, ZN.firstTrip), slot = znSlot(st.days, st.h1, st.h2);
  const tot = x => x.done + x.rc + x.dc + x.other, flat = [].concat(...g).map(tot);
  if (!flat.some(Boolean)) return '<div class="sechead"><h2>Demandes Uber par jour et par heure</h2></div><div class="empty">Aucune course Uber sur la période (rapport « Activité des courses » importé par Ludy ou par Contrôle Uber > Import).</div>';
  const steps = znSteps(flat.filter(Boolean).map(x => x / weeks));
  const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  let slotN = 0; g.forEach((row, d) => row.forEach((x, h) => { if (slot.days.has(d + 1) && slot.hours.has(h)) slotN += tot(x); }));
  return `<div class="sechead"><h2>Demandes Uber par jour et par heure</h2><span class="small">Moyenne par semaine (${f1(weeks)} semaine(s) de courses), heure du Maroc, toutes les demandes (terminées et annulées). Créneau choisi encadré : ${f1(slotN / weeks)} demande(s) par semaine.</span></div>
    <div class="tblwrap"><table class="tbl zndem"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>
    ${g.map((row, d) => `<tr><th>${days[d]}</th>${row.map((x, h) => { const n = tot(x), v = n / weeks, lv = n ? znLevel(v, steps, false) : -1;
      return `<td class="${slot.days.has(d + 1) && slot.hours.has(h) ? 'insl' : ''}" style="${lv >= 0 ? 'background:' + ZN_COLORS[lv] + ';color:' + (lv >= 3 ? '#fff' : '#3b2a14') : ''}" title="${days[d]} ${h} h : ${f0(x.done)} terminée(s), ${f0(x.rc)} annulée(s) par le client, ${f0(x.dc)} par le chauffeur, sur ${f1(weeks)} semaine(s)">${n ? (v >= 10 ? f0(v) : f1(v)) : ''}</td>`; }).join('')}
      <td class="n"><b>${f0(row.reduce((t, x) => t + tot(x), 0) / weeks)}</b></td></tr>`).join('')}</tbody></table></div>`;
}
