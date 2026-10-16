// Pages reprises du Google Sheet v6 (mêmes calculs que tests/reference/Code_v6.gs) : carburant, ralenti, conduite,
// fiche véhicule, fiche chauffeur (compte rendu imprimable), chauffeurs en direct.
// Chargé avant app.js : utilise ses outils (sb, S, all, table, cards, period…) au moment de l'appel.

// ---------- Outils ----------
const DRIVE_CATS = ['Vitesse', 'Freinage', 'Accélération', 'Virage', 'Ceinture', 'Collision'];
const CAT_TXT = { Vitesse: 'Excès de vitesse', Freinage: 'Freinages brusques', 'Accélération': 'Accélérations brusques', Virage: 'Virages brusques', Ceinture: 'Ceinture non bouclée', Collision: 'Collisions' };
function qs() { return new URLSearchParams(location.hash.split('?')[1] || ''); }
function drvName(code, fallback) { return code === HORS ? 'Hors contrat' : (S.drv[code] || fallback || code); }
function vehOf(key) { return S.veh[key] || { key, plate: key, model: '' }; }
/** Lien vers la fiche d'un véhicule / d'un chauffeur */
function vlink(key, label) { return `<a class="fl" href="#/vehicule?k=${encodeURIComponent(key)}">${plate(label || vehOf(key).plate)}</a>`; }
function dlink(code, name) { return code && code !== HORS ? `<a class="fl" href="#/chauffeur?c=${encodeURIComponent(code)}">${esc(name || drvName(code))}</a>` : esc(name || 'Hors contrat'); }
/** Prix du litre selon le carburant du véhicule (paramètres) ; 0 = prix non saisi */
function priceOf(v) { const diesel = /GO|GAS ?OIL|GASOIL|DIESEL|GAZOIL/.test(String((v && v.fuel) || '').toUpperCase()); return num(diesel ? S.P.priceDiesel : S.P.priceGas, 0); }
/** Lignes des tables de données entre deux jours (inclus), filtrées par agence et éventuellement par véhicule */
async function dataRows(table, cols, from, to, opt) {
  opt = opt || {};
  const ok = inAgency(), dcol = opt.dayCol || 'day';
  const rows = await all(table, cols, q => { q = q.gte(dcol, from).lte(dcol, to); if (opt.key) q = q.eq('vehicle_key', opt.key); if (opt.code) q = q.eq('driver_code', opt.code); return q; });
  return rows.filter(r => ok(r.vehicle_key));
}
/** Petit graphique en barres (SVG) : items [{label, value, color, text}] */
function svgBars(items, opt) {
  opt = opt || {};
  if (!items.length) return `<div class="empty">${opt.empty || 'Pas de données mesurées'}</div>`;
  const max = opt.max || Math.max(...items.map(i => i.value), 1e-9), rh = 22, w = 620, lw = 190, bw = w - lw - 90;
  return `<svg class="chart" viewBox="0 0 ${w} ${items.length * rh + 6}" role="img" aria-label="${esc(opt.title || '')}">` + items.map((it, i) => {
    const y = i * rh + 3, bwi = Math.max(1, Math.round(Math.min(1, it.value / max) * bw));
    return `<text x="${lw - 6}" y="${y + 15}" text-anchor="end" class="cl">${esc(String(it.label).slice(0, 28))}</text>
      <rect x="${lw}" y="${y + 3}" width="${bwi}" height="${rh - 7}" rx="3" fill="${it.color || 'var(--acc)'}"><title>${esc(it.label + ' : ' + it.text)}</title></rect>
      <text x="${lw + bwi + 6}" y="${y + 15}" class="cv">${esc(it.text)}</text>`;
  }).join('') + '</svg>';
}
/** Courbe (SVG) : pts [{t, v}] */
function svgLine(pts, opt) {
  opt = opt || {};
  if (pts.length < 2) return `<div class="empty">${opt.empty || 'Pas assez de lectures'}</div>`;
  const w = 620, h = 170, p = 30, t0 = pts[0].t, t1 = pts[pts.length - 1].t, lo = opt.min !== undefined ? opt.min : Math.min(...pts.map(x => x.v)), hi = opt.max !== undefined ? opt.max : Math.max(...pts.map(x => x.v), lo + 1);
  const X = t => p + (t - t0) / Math.max(1, t1 - t0) * (w - p - 8), Y = v => h - 20 - (v - lo) / Math.max(1e-9, hi - lo) * (h - 34);
  const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="${p - 4}" y="${Y(v) + 4}" text-anchor="end" class="cl">${Math.round(v)}</text><line x1="${p}" x2="${w - 8}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opt.title || '')}">${ticks}
    <polyline fill="none" stroke="var(--acc)" stroke-width="2" points="${pts.map(x => X(x.t).toFixed(1) + ',' + Y(x.v).toFixed(1)).join(' ')}"/>
    <text x="${p}" y="${h - 4}" class="cl">${fmtDT(t0)}</text><text x="${w - 8}" y="${h - 4}" text-anchor="end" class="cl">${fmtDT(t1)}</text></svg>`;
}
/** Échelle vert -> jaune -> rouge (t de 0 à 1), comme les rapports du Sheet */
function grad(t) {
  const c = [[99, 190, 123], [255, 217, 102], [248, 105, 107]], k = t <= 0.5 ? 0 : 1, u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  return 'rgb(' + c[k].map((v, i) => Math.round(v + (c[k + 1][i] - v) * u)).join(',') + ')';
}
const LVL_COLOR = { 'Faible': '#63BE7B', 'Modéré': '#FFD966', 'Élevé': '#F4B183', 'Dangereux': '#C00000' };
function vehSelect(sel) { return `<label>Véhicule <select id="vsel"><option value="">Tous</option>${S.vehList.filter(v => inAgency()(v.key)).map(v => `<option value="${esc(v.key)}" ${v.key === sel ? 'selected' : ''}>${esc(v.plate + ' ' + (v.model || ''))}</option>`).join('')}</select></label>`; }
/** Jour de la journée de travail d'une ligne (jour du contrat s'il est connu) */
function ctrDayMap(jrn) { const m = {}; jrn.forEach(j => { if (j.contract_num) m[j.contract_num] = j.day; }); return m; }

/** Consommation plein à plein (fullToFull_ du Sheet) : entre deux pleins complets, litres remis / km roulés */
function fullToFull(fills, trips) {
  const P = S.P, full = f => f.lvl_after !== null && num(f.lvl_after) >= num(P.fullPct, 90);
  const litresOf = f => f.liters_geotab !== null ? num(f.liters_geotab) : (f.liters_gauge !== null ? num(f.liters_gauge) : null);
  const byV = {}, tBy = {}, out = [];
  fills.forEach(f => { (byV[f.vehicle_key] = byV[f.vehicle_key] || []).push(f); });
  trips.forEach(t => { (tBy[t.vehicle_key] = tBy[t.vehicle_key] || []).push(t); });
  Object.keys(byV).forEach(k => {
    const f = byV[k].sort((a, b) => new Date(a.stop_start) - new Date(b.stop_start));
    for (let i = 0; i < f.length; i++) {
      if (!full(f[i])) continue;
      let added = 0, okk = true, j = i + 1;
      for (; j < f.length; j++) { const l = litresOf(f[j]); if (l === null) { okk = false; break; } added += l; if (full(f[j])) break; }
      if (!okk || j >= f.length) continue;
      const a = new Date(f[i].stop_start).getTime(), b = new Date(f[j].stop_start).getTime();
      const tr = (tBy[k] || []).filter(x => { const t = new Date(x.start_at).getTime(); return t > a && t < b; });
      const km = tr.reduce((s, x) => s + num(x.km), 0), codes = [...new Set(tr.map(x => x.driver_code || HORS))];
      const allM = tr.length && tr.every(x => x.fuel_l !== null && x.fuel_source !== 'Non mesuré');
      const measured = allM ? tr.reduce((s, x) => s + num(x.fuel_l), 0) : null;
      out.push({ key: k, from: a, to: b, km, litres: added, l100: km >= 50 ? added / km * 100 : null, codes,
        single: codes.length === 1 && codes[0] !== HORS ? drvName(codes[0]) : '', measured, gap: measured !== null && added > 0 ? (measured / added - 1) * 100 : null });
      i = j - 1;
    }
  });
  return out.sort((a, b) => b.to - a.to);
}

// ---------- CARBURANT (Carburant période, Pleins, plein à plein, siphonages, jauge) ----------
async function pageCarburant() {
  const p = period(), key = qs().get('k') || '', P = S.P, retFrom = addDays(today(), -Math.max(7, num(P.retentionDays, 62)));
  const TC = 'id,vehicle_key,plate,day,start_at,km,drive_min,idle_min,fuel_l,fuel_source,idle_fuel_l,driver_code,driver_name';
  const [trips, fuel, lvls, allTrips] = await Promise.all([
    dataRows('trips', TC, p.from, p.to, { key }),
    dataRows('fuel', '*', retFrom, today(), { key }),
    dataRows('levels', 'vehicle_key,at,pct', addDays(today(), -3), today(), { key, dayCol: 'vday' }),
    dataRows('trips', 'vehicle_key,start_at,km,fuel_l,fuel_source,driver_code', retFrom, today(), { key })]);
  const inP = d => d >= p.from && d <= p.to;
  const vk = key ? [key] : S.vehList.filter(v => v.active !== 'NON' && inAgency()(v.key)).map(v => v.key);
  const mk = () => ({ trips: 0, km: 0, drive: 0, fuel: 0, fuelKm: 0, fuelN: 0, idleL: 0, idleMin: 0, pleins: 0, pleinsL: 0, pleinsEst: 0, cost: 0 });
  const byV = {}, byD = {}, byDay = {}, tot = mk();
  const add = (o, r, v) => { const km = num(r.km); o.trips++; o.km += km; o.drive += num(r.drive_min) / 60; o.idleMin += num(r.idle_min);
    if (r.fuel_l !== null) { o.fuel += num(r.fuel_l); o.fuelKm += km; o.fuelN++; o.cost += num(r.fuel_l) * priceOf(v); }
    if (r.idle_fuel_l !== null) o.idleL += num(r.idle_fuel_l); };
  trips.forEach(r => {
    const v = vehOf(r.vehicle_key), code = r.driver_code || HORS;
    add(byV[r.vehicle_key] = byV[r.vehicle_key] || mk(), r, v); add(tot, r, v); add(byD[code] = byD[code] || Object.assign(mk(), { name: r.driver_name }), r, v);
    if (r.fuel_l !== null) { const d = byDay[r.day] = byDay[r.day] || {}; d[r.vehicle_key] = (d[r.vehicle_key] || 0) + num(r.fuel_l); }
  });
  const fills = fuel.filter(f => f.type === 'PLEIN'), fillsP = fills.filter(f => inP(f.day));
  fillsP.forEach(f => [byV[f.vehicle_key] = byV[f.vehicle_key] || mk(), tot].forEach(o => { o.pleins++; o.pleinsL += num(f.liters_gauge); o.pleinsEst += num(f.liters_geotab); }));
  const l100 = o => o.fuelKm >= num(P.minFuelKm, 30) ? f1(o.fuel / o.fuelKm * 100) : (o.fuelN ? 'km insuffisants' : NM);
  const cov = o => o.trips ? Math.round(o.fuelN / o.trips * 100) + ' %' : '-';
  const cost = o => num(P.priceDiesel) || num(P.priceGas) ? f0(o.cost) : '<span class="nm">prix non saisi</span>';
  // Jauge actuelle (dernière lecture) et courbe 72 h
  const lv = {}; lvls.forEach(x => { (lv[x.vehicle_key] = lv[x.vehicle_key] || []).push({ t: new Date(x.at).getTime(), v: num(x.pct) }); });
  Object.values(lv).forEach(a => a.sort((x, y) => x.t - y.t));
  const ff = fullToFull(fills, allTrips);
  const siph = fuel.filter(f => f.type === 'SIPHONAGE_SUSPECT').sort((a, b) => new Date(b.stop_start) - new Date(a.stop_start));
  const tne = fuel.filter(f => f.type === 'TRAJET_NON_ENREGISTRE').sort((a, b) => new Date(b.stop_start) - new Date(a.stop_start));
  const rec = {}; fills.forEach(f => { const k = f.day.slice(0, 7) + '|' + f.vehicle_key, o = rec[k] || (rec[k] = { m: f.day.slice(0, 7), key: f.vehicle_key, n: 0, lj: 0, lg: 0, ng: 0 });
    o.n++; o.lj += num(f.liters_gauge); if (f.liters_geotab !== null) { o.lg += num(f.liters_geotab); o.ng++; } });
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Carburant</h1><div class="sub">Litres = compteur carburant du véhicule, trajet par trajet (aucune estimation). Pleins détectés par Geotab : à comparer aux tickets. Un trajet compte dans la période s'il y démarre.</div></div>
    ${periodBar(go)}<div class="bar">${vehSelect(key)}</div>
    ${cards([['Carburant consommé (L)', tot.fuelN ? f1(tot.fuel) : NM], ['Km', f0(tot.km)], ['Consommation (L/100 km)', l100(tot)], ['dont moteur allumé à l\'arrêt (L)', f1(tot.idleL)],
      ['Pleins détectés', f0(tot.pleins)], ['Litres pleins (jauge)', f1(tot.pleinsL)], ['Coût (MAD)', cost(tot)], ['Trajets mesurés', cov(tot)],
      ['Siphonages suspects', f0(siph.filter(f => inP(f.day)).length), siph.some(f => inP(f.day)) ? 'crit' : '']])}
    <h2>Jauge en ce moment</h2>
    ${table('tjauge', [['Véhicule', k => vlink(k), k => vehOf(k).plate], ['Modèle', k => esc(vehOf(k).model || '')],
      ['Jauge (%)', k => { const a = lv[k]; return a && a.length ? `<b>${f0(a[a.length - 1].v)} %</b>` : `<span class="nm">${NM}</span>`; }, k => (lv[k] || []).slice(-1).map(x => x.v)[0] || -1, 'n'],
      ['Relevée le', k => { const a = lv[k]; return a && a.length ? fmtDT(a[a.length - 1].t) : ''; }],
      ['Litres estimés au réservoir', k => { const a = lv[k], t = num(vehOf(k).tank_l); return a && a.length && t ? f0(a[a.length - 1].v / 100 * t) + ' L' : ''; }, null, 'n']], vk, { empty: 'Aucun véhicule' })}
    ${key && lv[key] ? '<h2>Jauge, 72 dernières heures (%)</h2>' + svgLine(lv[key], { min: 0, max: 100, title: 'Jauge' }) : ''}
    <h2>Par véhicule</h2>
    ${table('tcv', [['Véhicule', k => vlink(k), k => vehOf(k).plate], ['Modèle', k => esc(vehOf(k).model || '')], ['Trajets', k => f0((byV[k] || mk()).trips), k => (byV[k] || mk()).trips, 'n'],
      ['Km', k => f1((byV[k] || mk()).km), k => (byV[k] || mk()).km, 'n'], ['Carburant (L)', k => (byV[k] || mk()).fuelN ? f1(byV[k].fuel) : `<span class="nm">${NM}</span>`, k => (byV[k] || mk()).fuel, 'n'],
      ['L/100 km', k => nmv(l100(byV[k] || mk())), null, 'n'], ['Litres moteur à l\'arrêt', k => f1((byV[k] || mk()).idleL), k => (byV[k] || mk()).idleL, 'n'],
      ['Temps moteur à l\'arrêt', k => fH((byV[k] || mk()).idleMin / 60), k => (byV[k] || mk()).idleMin, 'n'], ['Pleins', k => f0((byV[k] || mk()).pleins), null, 'n'],
      ['Litres pleins (jauge)', k => f1((byV[k] || mk()).pleinsL), null, 'n'], ['Estimation Geotab (depuis plein précédent)', k => f1((byV[k] || mk()).pleinsEst), null, 'n'],
      ['Coût (MAD)', k => priceOf(vehOf(k)) ? f0((byV[k] || mk()).cost) : '', null, 'n'], ['Trajets mesurés', k => cov(byV[k] || mk()), null, 'n']], vk)}
    <h2>Par chauffeur</h2>
    ${table('tcd', [['Chauffeur', c => dlink(c, drvName(c, byD[c].name)), c => drvName(c, byD[c].name)], ['Code', c => c === HORS ? '' : esc(c)], ['Trajets', c => byD[c].trips, null, 'n'],
      ['Km', c => f1(byD[c].km), c => byD[c].km, 'n'], ['Carburant (L)', c => byD[c].fuelN ? f1(byD[c].fuel) : `<span class="nm">${NM}</span>`, c => byD[c].fuel, 'n'],
      ['L/100 km', c => nmv(l100(byD[c])), null, 'n'], ['Litres moteur à l\'arrêt', c => f1(byD[c].idleL), c => byD[c].idleL, 'n'], ['Trajets mesurés', c => cov(byD[c]), null, 'n']],
      Object.keys(byD).sort((a, b) => byD[b].fuel - byD[a].fuel))}
    <h2>Par jour (litres)</h2>
    ${table('tcj', [['Jour', d => fmtDay(d), d => d]].concat(vk.map(k => [esc(vehOf(k).plate), d => byDay[d][k] ? f1(byDay[d][k]) : '', d => byDay[d][k] || 0, 'n']))
      .concat([['Total', d => `<b>${f1(Object.values(byDay[d]).reduce((s, x) => s + x, 0))}</b>`, null, 'n']]), Object.keys(byDay).sort())}
    <h2>Pleins détectés, un par un (${fillsP.length})</h2>
    ${table('tpl', [['Date / heure', f => fmtDTY(f.stop_start), f => f.stop_start], ['Véhicule', f => vlink(f.vehicle_key, f.plate), f => f.plate], ['Chauffeur', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))],
      ['Jauge avant (%)', f => f0(f.lvl_before), null, 'n'], ['Jauge après (%)', f => f0(f.lvl_after), null, 'n'], ['Litres (jauge)', f => f1(f.liters_gauge), f => num(f.liters_gauge), 'n'],
      ['Litres Geotab', f => f1(f.liters_geotab), f => num(f.liters_geotab), 'n'], ['Lieu', f => mapLink(f.lat, f.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(f.lat, f.lon)}">carte</a>` : '']],
      fillsP.sort((a, b) => new Date(b.stop_start) - new Date(a.stop_start)), { empty: 'Aucun plein sur la période' })}
    <h2>Consommation plein à plein</h2><div class="sub">Entre deux pleins complets (jauge ≥ ${esc(P.fullPct || 90)} % après le plein) : litres remis à la pompe / km roulés. Écart = litres mesurés trajet par trajet comparés aux litres remis.</div>
    ${table('tff', [['Véhicule', x => vlink(x.key), x => vehOf(x.key).plate], ['Plein de départ', x => fmtDTY(x.from), x => x.from], ['Plein d\'arrivée', x => fmtDTY(x.to), x => x.to],
      ['Km roulés', x => f1(x.km), x => x.km, 'n'], ['Litres remis', x => f1(x.litres), x => x.litres, 'n'], ['L/100 km', x => x.l100 !== null ? `<b>${f1(x.l100)}</b>` : '<span class="nm">km insuffisants</span>', x => x.l100 || 0, 'n'],
      ['Chauffeur(s)', x => x.codes.map(c => dlink(c)).join(', ')], ['Attribuable à', x => x.single ? esc(x.single) : 'Plusieurs chauffeurs'],
      ['Litres mesurés par trajet', x => x.measured !== null ? f1(x.measured) : `<span class="nm">${NM}</span>`, null, 'n'],
      ['Écart (%)', x => x.gap === null ? '' : `<span class="${Math.abs(x.gap) > 15 ? 'red' : ''}">${f1(x.gap)}</span>`, x => x.gap || 0, 'n']], ff, { empty: 'Aucun intervalle entre deux pleins complets sur les données conservées' })}
    <h2>Récapitulatif des pleins par mois et par véhicule</h2>
    ${table('trec', [['Mois', o => o.m.slice(5) + '/' + o.m.slice(0, 4), o => o.m], ['Véhicule', o => vlink(o.key)], ['Pleins', o => o.n, null, 'n'], ['Litres (jauge)', o => f1(o.lj), null, 'n'],
      ['Litres Geotab', o => o.ng ? f1(o.lg) : '', null, 'n']], Object.values(rec).sort((a, b) => b.m.localeCompare(a.m)), { empty: 'Aucun plein' })}
    <h2>Siphonages suspects (baisse de jauge moteur coupé, sans trajet)</h2>
    ${table('tsi', [['Arrêt', f => fmtDTY(f.stop_start), f => f.stop_start], ['Redémarrage', f => fmtDTY(f.stop_end)], ['Véhicule', f => vlink(f.vehicle_key, f.plate)],
      ['Chauffeur à l\'arrêt', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))], ['Chauffeur au redémarrage', f => esc(f.next_driver || '')], ['Durée arrêt (min)', f => f0(f.stop_min), null, 'n'],
      ['Jauge avant → après (%)', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after)], ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n'],
      ['Statut', f => canEdit() ? `<select class="fst" data-f="${esc(f.id)}">${['À vérifier', 'Vérifié', 'Faux positif'].map(s => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : esc(f.status || '')],
      ['Lieu', f => mapLink(f.lat, f.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(f.lat, f.lon)}">carte</a>` : '']], siph, { empty: 'Aucun siphonage suspect' })}
    <h2>Trajets non enregistrés (boîtier coupé, le compteur km du véhicule a avancé)</h2>
    ${table('ttne', [['De', f => fmtDTY(f.stop_start), f => f.stop_start], ['À', f => fmtDTY(f.stop_end)], ['Véhicule', f => vlink(f.vehicle_key, f.plate)], ['Chauffeur', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))],
      ['Km non enregistrés', f => esc(String(f.engine || '').split(' ')[0]), null, 'n'], ['Statut', f => esc(f.status || '')]], tne, { empty: 'Aucun' })}`;
    $('#vsel').onchange = e => { location.hash = '#/carburant' + (e.target.value ? '?k=' + encodeURIComponent(e.target.value) : ''); };
    document.querySelectorAll('.fst').forEach(s => { s.onchange = async () => {
      const { error } = await sb.from('fuel').update({ status: s.value }).eq('id', s.dataset.f); if (error) { alert(error.message); return; }
      s.classList.add('saved'); await job('recompute', addDays(today(), -31)).catch(() => { }); }; });
  };
  window.__rerender = render; render();
}

// ---------- RALENTI (moteur allumé à l'arrêt) ----------
async function pageRalenti() {
  const P = S.P, td = today(), retFrom = addDays(td, -Math.max(7, num(P.retentionDays, 62)));
  const [jrn, idl] = await Promise.all([dataRows('journal', '*', retFrom, td), dataRows('idles', '*', addDays(td, -30), td)]);
  const per = [['Aujourd\'hui', td, td], ['Hier', addDays(td, -1), addDays(td, -1)], ['Semaine', mondayOf(td), td], ['Mois', td.slice(0, 8) + '01', td], ['Données conservées', '0000', '9999']];
  const build = keyFn => { const aggs = per.map(x => aggJournal(jrn.filter(r => r.day >= x[1] && r.day <= x[2]), keyFn, P)), allA = aggs[4];
    return { aggs, keys: Object.keys(allA).sort((a, b) => allA[b].idle - allA[a].idle) }; };
  const bd = build(r => r.driver_code), bv = build(r => r.vehicle_key);
  const cols = (b, first, label, link) => {
    const g = (i, k, f) => (b.aggs[i][k] || emptyAgg())[f];
    return [[first, k => link(k), k => label(k)]]
      .concat(per.map((x, i) => ['Ralenti ' + x[0].toLowerCase(), k => fH(g(i, k, 'idle')), k => g(i, k, 'idle'), 'n']))
      .concat(per.map((x, i) => ['Prolongé ' + x[0].toLowerCase(), k => fH(g(i, k, 'idleLong')), k => g(i, k, 'idleLong'), 'n']))
      .concat([['Arrêts prolongés (mois)', k => f0(g(3, k, 'nLong')), null, 'n'],
        ['Litres ralenti (mois)', k => g(3, k, 'idleFuelN') ? f1(g(3, k, 'idleFuel')) : `<span class="nm">${NM}</span>`, null, 'n']]);
  };
  const days = []; for (let i = 13; i >= 0; i--) days.push(addDays(td, -i));
  const heat = (id, valFn, fmt) => {
    const m = {}; jrn.forEach(r => { if (r.day < days[0] || r.driver_code === HORS) return; const v = valFn(r); if (v === null) return; (m[r.driver_code] = m[r.driver_code] || {})[r.day] = ((m[r.driver_code] || {})[r.day] || 0) + v; });
    const keys = Object.keys(m).filter(k => days.some(d => m[k][d])), max = Math.max(1e-9, ...keys.flatMap(k => days.map(d => m[k][d] || 0)));
    const tot = k => days.reduce((s, d) => s + (m[k][d] || 0), 0);
    return table(id, [['Chauffeur', k => dlink(k), k => drvName(k)]].concat(days.map(d => [d.slice(8) + '/' + d.slice(5, 7),
      k => m[k][d] !== undefined ? `<span class="heat" style="background:${grad(m[k][d] / max)}">${fmt(m[k][d])}</span>` : '', k => m[k][d] || 0, 'n']))
      .concat([['Total', k => `<b>${fmt(tot(k))}</b>`, k => tot(k), 'n']]), keys.sort((a, b) => tot(b) - tot(a)), { empty: 'Aucune donnée sur 14 jours' });
  };
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Ralenti</h1><div class="sub">Ralenti = véhicule immobile, moteur thermique tournant (régime moteur). Ralenti prolongé = arrêts de ${esc(P.idleLongMin)} min et plus (feux et bouchons exclus). Journée = horaires du contrat.</div></div>
    <h2>Heures de ralenti par chauffeur</h2>${table('trd', cols(bd, 'Chauffeur', k => drvName(k), k => dlink(k)), bd.keys)}
    <h2>Heures de ralenti par véhicule</h2>${table('trv', cols(bv, 'Véhicule', k => vehOf(k).plate, k => vlink(k)), bv.keys)}
    <h2>Litres consommés par chauffeur et par journée (14 jours, mesurés)</h2>${heat('thl', r => r.fuel_l === null ? null : num(r.fuel_l), f1)}
    <h2>Heures de ralenti par chauffeur et par journée (14 jours)</h2>${heat('thi', r => num(r.idle_h), fH)}
    <h2>Ralenti prolongé par chauffeur et par journée (14 jours)</h2>${heat('thp', r => num(r.long_idle_h), fH)}
    <h2>Arrêts moteur allumé, 30 derniers jours (preuves)</h2>
    ${table('tidl30', [['Début', r => fmtDTY(r.start_at), r => r.start_at], ['Fin', r => fmtDT(r.end_at)], ['Durée arrêt', r => fH(num(r.stop_min) / 60), r => num(r.stop_min), 'n'],
      ['Moteur tournant', r => r.engine_check === 'Régime moteur' ? fH(num(r.engine_min) / 60) : 'non vérifiable', r => num(r.engine_min), 'n'], ['Véhicule', r => vlink(r.vehicle_key, r.plate)],
      ['Chauffeur', r => dlink(r.driver_code, drvName(r.driver_code, r.driver_name))], ['Contrat', r => esc(r.contract_num || '')],
      ['Litres', r => r.liters === null ? `<span class="nm">${NM}</span>` : f1(r.liters), null, 'n'], ['Lieu', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">carte</a>` : '']],
      idl.sort((a, b) => new Date(b.start_at) - new Date(a.start_at)), { empty: 'Aucun arrêt prolongé' })}`;
  };
  window.__rerender = render; render();
}

// ---------- CONSOMMATION ENTRE DEUX DATES (toute la flotte ou un véhicule, à la minute près) + rapport PDF ----------
function consoInputs() {
  let c = null; try { c = JSON.parse(localStorage.getItem('conso') || 'null'); } catch (e) { }
  const now = Date.now(), t = today();
  return { a: (c && c.a) || t.slice(0, 8) + '01T00:00', z: (c && c.z) || t + 'T' + localHM(now), k: c && c.k !== undefined ? c.k : '' };
}
async function pageConso() {
  const inp = consoInputs(), P = S.P, ok = inAgency();
  const a = parseLocalDT(inp.a), z0 = parseLocalDT(inp.z), now = Date.now();
  const head = `<div class="head"><h1>Consommation</h1><div class="sub">Carburant consommé entre deux instants (heure du Maroc), toute la flotte ou un véhicule. Litres = compteur carburant du véhicule, trajet par trajet : aucune estimation, « ${NM} » quand Geotab ne donne pas la valeur. Un trajet compte s'il démarre dans la période. Agence : menu de gauche.</div>
    <button id="cpdf" disabled>Télécharger le PDF</button></div>
    <div class="bar"><label>Du <input type="datetime-local" id="ca" value="${esc(inp.a)}"></label><label>au <input type="datetime-local" id="cz" value="${esc(inp.z)}"></label>${vehSelect(inp.k)}<button id="cgo">Calculer</button></div>`;
  const bind = () => {
    const save = () => { try { localStorage.setItem('conso', JSON.stringify({ a: $('#ca').value, z: $('#cz').value, k: $('#vsel').value })); } catch (e) { } go(); };
    $('#cgo').onclick = save; $('#vsel').onchange = save;
  };
  if (!a || !z0 || !(Math.min(z0.getTime(), now) > a.getTime())) { $('#page').innerHTML = head + msg('Période invalide : la fin doit être après le début (et pas dans le futur).', 'warn'); bind(); return; }
  const A = a.getTime(), Z = Math.min(z0.getTime(), now), aI = new Date(A).toISOString(), zI = new Date(Z).toISOString(), d0 = localDay(A), d1 = localDay(Z - 1);
  const vlist = S.vehList.filter(v => ok(v.key) && (!inp.k || v.key === inp.k));
  const keys = new Set(vlist.map(v => v.key)), mine = r => keys.has(r.vehicle_key);
  const [trips, fuel, stops, vd] = await Promise.all([
    all('trips', 'vehicle_key,plate,start_at,km,drive_min,idle_min,fuel_l,fuel_source,idle_fuel_l,driver_code,driver_name,contract_num', q => q.gte('start_at', aI).lt('start_at', zI)),
    all('fuel', 'vehicle_key,plate,type,stop_start,stop_end,lvl_before,lvl_after,liters_gauge,liters_geotab,engine,status,driver_code,driver_name', q => q.gte('stop_start', aI).lt('stop_start', zI)),
    all('engine_stops', 'vehicle_key,start_at,dur_min,liters,driver_code', q => q.gte('start_at', aI).lt('start_at', zI)).catch(() => null),
    all('vehicle_days', 'vehicle_key,day', q => q.gte('day', d0).lte('day', d1))]);
  // Journées passées (avant-hier et plus) ni finalisées ni téléchargées : totaux incomplets, signalé
  const have = new Set(vd.map(x => x.vehicle_key + '|' + x.day)), missing = [];
  for (let d = d0; d <= d1 && d <= addDays(today(), -2); d = addDays(d, 1)) vlist.filter(v => v.geotab_id && v.active !== 'NON').forEach(v => { if (!have.has(v.key + '|' + d)) missing.push({ plate: v.plate, day: d }); });
  const rep = rptConso({ trips: trips.filter(mine), fuel: fuel.filter(mine), stops: stops ? stops.filter(mine) : null, vehicles: vlist, drivers: S.drv, P, a: A, z: Z, missing,
    agency: inp.k ? vehOf(inp.k).plate : (agFilter() ? S.agName[agFilter()] : ''), dayOf: localDay, hmOf: localHM, generatedAt: new Date() });
  $('#page').innerHTML = head + `<div class="panel rptview">${rptHtml(rep)}</div>`;
  bind();
  const b = $('#cpdf'); b.disabled = false; b.onclick = () => { try { reportPdf(rep); } catch (e) { alert('PDF impossible : ' + e.message); } };
}

// ---------- ARRÊTS MOTEUR TOURNANT (chaque arrêt de engStopMin min et plus, litres réels quand Geotab les mesure) ----------
function beltTxt(r) {
  if (r.belt_on_min === null && r.belt_off_min === null) return `<span class="nm">${NM}</span>`;
  const on = num(r.belt_on_min), off = num(r.belt_off_min);
  return on && !off ? 'bouclée' : off && !on ? 'débouclée' : `bouclée ${f0(on)} min, débouclée ${f0(off)} min`;
}
async function pageArrets() {
  const p = period(), P = S.P, sel = qs().get('k') || '', minS = num(P.engStopMin, 3);
  const [rows, trips] = await Promise.all([dataRows('engine_stops', '*', p.from, p.to, { key: sel || undefined }),
    dataRows('trips', 'id,vehicle_key,idle_fuel_l,idle_min', addDays(p.from, -1), addDays(p.to, 1), { key: sel || undefined })]);
  const trip = {}; trips.forEach(t => { trip[t.id] = t; });
  const measured = rows.filter(r => r.liters !== null), litres = measured.reduce((t, r) => t + num(r.liters), 0), minT = rows.reduce((t, r) => t + num(r.dur_min), 0);
  const cost = r => { const pr = priceOf(vehOf(r.vehicle_key)); return r.liters !== null && pr ? num(r.liters) * pr : null; };
  const beltKnown = rows.filter(r => r.belt_on_min !== null || r.belt_off_min !== null);
  const group = keyFn => { const o = {}; rows.forEach(r => { const k = keyFn(r), a = o[k] || (o[k] = { k, n: 0, min: 0, max: 0, nL: 0, L: 0, minL: 0, cost: 0, nCost: 0, on: 0, off: 0, nBelt: 0 });
    a.n++; a.min += num(r.dur_min); a.max = Math.max(a.max, num(r.dur_min));
    if (r.liters !== null) { a.nL++; a.L += num(r.liters); a.minL += num(r.dur_min); const c = cost(r); if (c !== null) { a.cost += c; a.nCost++; } }
    if (r.belt_on_min !== null || r.belt_off_min !== null) { a.nBelt++; a.on += num(r.belt_on_min); a.off += num(r.belt_off_min); } });
    return Object.values(o).sort((x, y) => y.min - x.min); };
  const gcols = (first, label, link) => [[first, a => link(a.k), a => label(a.k)], ['Arrêts', a => f0(a.n), a => a.n, 'n'], ['Durée totale', a => fH(a.min / 60), a => a.min, 'n'],
    ['Plus long arrêt (min)', a => f0(a.max), a => a.max, 'n'], ['Arrêts mesurés', a => a.nL + ' / ' + a.n, a => a.nL, 'n'],
    ['Litres mesurés', a => a.nL ? `<b>${f1(a.L)}</b>` : `<span class="nm">${NM}</span>`, a => a.L, 'n'],
    ['L/h (arrêts mesurés)', a => a.nL && a.minL ? f1(a.L / (a.minL / 60)) : '', a => a.minL ? a.L / a.minL : 0, 'n'],
    ['Coût mesuré (MAD)', a => a.nCost ? f0(a.cost) : '', a => a.cost, 'n'],
    ['Ceinture conducteur pendant les arrêts', a => a.nBelt ? `bouclée ${fH(a.on / 60)}, débouclée ${fH(a.off / 60)}` : `<span class="nm">${NM}</span>`]];
  const det = rows.slice().sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
  $('#page').innerHTML = `<div class="head"><h1>Arrêts moteur tournant</h1><div class="sub">Chaque arrêt de ${esc(minS)} min et plus, véhicule immobile (moins de 2 km/h) et moteur thermique tournant (plus de ${esc(P.rpmMin || 300)} tr/min).
    <b>Litres</b> = compteur Geotab du carburant brûlé au ralenti, relevé juste avant et juste après l'arrêt : valeur réelle. Le boîtier ne relève ce compteur qu'à certains moments (surtout au contact mis ou coupé) :
    quand aucun relevé n'encadre l'arrêt, les litres de l'arrêt sont « non mesuré » et la colonne « Ralenti du trajet » donne le total réel du trajet, qui inclut cet arrêt (plafond).
    <b>Ceinture conducteur</b> : état transmis par le véhicule pendant l'arrêt (Staria) ; la présence d'un passager et la climatisation ne sont transmises par aucun boîtier : non mesurées.</div></div>
    ${periodBar(go)}<div class="bar">${vehSelect(sel)}${isAdmin() ? '<button class="ghost" id="stopsback">Calculer les 14 derniers jours</button><span id="stopsres" class="hint"></span>' : ''}</div>
    ${cards([['Arrêts moteur tournant', f0(rows.length)], ['Durée totale', fH(minT / 60)], ['Arrêts avec litres mesurés', measured.length + ' / ' + rows.length],
      ['Litres mesurés', measured.length ? f1(litres) : NM], ['L/h mesuré', measured.length ? f1(litres / (measured.reduce((t, r) => t + num(r.dur_min), 0) / 60 || 1)) : NM],
      ['Ceinture connue', beltKnown.length + ' / ' + rows.length]])}
    <h2>Par chauffeur</h2>${table('tstd', gcols('Chauffeur', k => drvName(k), k => dlink(k)), group(r => r.driver_code || HORS), { empty: 'Aucun arrêt moteur tournant sur la période' })}
    <h2>Par véhicule</h2>${table('tstv', gcols('Véhicule', k => vehOf(k).plate, k => vlink(k)), group(r => r.vehicle_key), { empty: 'Aucun arrêt moteur tournant sur la période' })}
    <h2>Détail des arrêts</h2>
    ${table('tstops', [['Début', r => fmtDTY(r.start_at), r => r.start_at], ['Fin', r => fmtDT(r.end_at)], ['Durée (min)', r => f1(r.dur_min), r => num(r.dur_min), 'n'],
      ['Véhicule', r => vlink(r.vehicle_key, r.plate)], ['Chauffeur', r => dlink(r.driver_code, drvName(r.driver_code, r.driver_name))], ['Contrat', r => esc(r.contract_num || '')],
      ['Litres de l\'arrêt', r => r.liters !== null ? `<b>${f1(r.liters)}</b>` : `<span class="nm" title="${esc(r.liters_source || '')}">${NM}</span>`, r => r.liters === null ? -1 : num(r.liters), 'n'],
      ['L/h', r => r.lph !== null ? f1(r.lph) : '', r => num(r.lph), 'n'], ['Coût (MAD)', r => { const c = cost(r); return c !== null ? f1(c) : ''; }, r => cost(r) || 0, 'n'],
      ['Ralenti du trajet (réel)', r => { const t = trip[r.trip_id]; return t && t.idle_fuel_l !== null ? f1(t.idle_fuel_l) + ' L en ' + f0(t.idle_min) + ' min' : ''; }],
      ['Ceinture conducteur', r => beltTxt(r)], ['Lieu', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">carte</a>` : '']],
      det, { empty: 'Aucun arrêt moteur tournant sur la période' })}`;
  $('#vsel').onchange = e => { location.hash = '#/arrets' + (e.target.value ? '?k=' + encodeURIComponent(e.target.value) : ''); };
  const bk = $('#stopsback');
  if (bk) bk.onclick = async () => {
    if (!confirm('Retélécharger les 14 derniers jours depuis Geotab pour calculer leurs arrêts moteur tournant ? (les autres chiffres sont recalculés à l\'identique)')) return;
    try { await job('resync', addDays(today(), -14) + '|' + addDays(today(), -1)); $('#stopsres').textContent = 'Demandé : calcul en arrière-plan (Journal technique).'; bk.disabled = true; }
    catch (e) { $('#stopsres').textContent = 'Erreur : ' + e.message; } };
}

// ---------- CONDUITE (classement conduite du Sheet : événements par type, vitesses, dépassements) ----------
async function drivingStats(from, to, opt) {
  opt = opt || {};
  const P = S.P, ok = inAgency();
  const [jrn, evts, trips] = await Promise.all([
    all('journal', '*', q => { q = q.gte('day', addDays(from, -1)).lte('day', addDays(to, 1)); if (opt.code) q = q.eq('driver_code', opt.code); return q; }),
    all('events', 'id,vehicle_key,day,start_at,dur_s,rule_id,driver_code,contract_num', q => { q = q.gte('day', addDays(from, -2)).lte('day', addDays(to, 1)); if (opt.code) q = q.eq('driver_code', opt.code); return q; }),
    all('trips', 'vehicle_key,plate,day,start_at,km,vmax,lim_at_vmax,worst_over,speed_at_worst,lim_at_worst,worst_time,driver_code,contract_num', q => { q = q.gte('day', addDays(from, -1)).lte('day', addDays(to, 1)); if (opt.code) q = q.eq('driver_code', opt.code); return q; })]);
  const cd = ctrDayMap(jrn), dayOf = r => r.contract_num && cd[r.contract_num] ? cd[r.contract_num] : r.day, inP = d => d >= from && d <= to;
  const agg = aggJournal(jrn.filter(r => ok(r.vehicle_key) && r.driver_code !== HORS && inP(r.day)), r => r.driver_code, P), by = {};
  Object.values(agg).forEach(a => { const sc = scoreOf(a, P); by[a.k] = { a, code: a.k, nom: drvName(a.k, Object.keys(a.names)[0]), score: sc, level: levelOf(sc, P), cat: {}, speedS: 0, vmax: 0, vmaxAt: null, worst: null, nOver: 0, trips: 0 };
    DRIVE_CATS.forEach(c => { by[a.k].cat[c] = 0; }); });
  evts.forEach(e => { const o = by[e.driver_code]; if (!o || !ok(e.vehicle_key) || !inP(dayOf(e))) return; const rl = S.rules[e.rule_id]; if (!rl || num(rl.weight) <= 0) return;
    if (o.cat[rl.category] === undefined) return; o.cat[rl.category]++; if (rl.category === 'Vitesse') o.speedS += num(e.dur_s); });
  trips.forEach(r => { const o = by[r.driver_code]; if (!o || !ok(r.vehicle_key) || !inP(dayOf(r))) return; o.trips++;
    if (num(r.vmax) > o.vmax) { o.vmax = num(r.vmax); o.vmaxAt = { t: r.start_at, plate: r.plate, lim: r.lim_at_vmax }; }
    if (r.worst_over !== null) { if (num(r.worst_over) >= num(P.overAlert, 30)) o.nOver++;
      if (!o.worst || num(r.worst_over) > o.worst.ex) o.worst = { ex: num(r.worst_over), v: r.speed_at_worst, lim: r.lim_at_worst, hm: r.worst_time || '', t: r.start_at, plate: r.plate }; } });
  return Object.values(by);
}
async function pageConduite() {
  const p = period(), P = S.P, list = await drivingStats(p.from, p.to);
  const ranked = list.filter(o => o.a.km >= num(P.kmMin, 20)).sort((x, y) => y.score - x.score || y.a.pts - x.a.pts), small = list.filter(o => o.a.km < num(P.kmMin, 20));
  const nEv = o => DRIVE_CATS.reduce((t, c) => t + o.cat[c], 0), kmT = list.reduce((t, o) => t + o.a.km, 0), evT = list.reduce((t, o) => t + nEv(o), 0);
  const cols = rank => [['Rang', o => rank ? ranked.indexOf(o) + 1 : '', null, 'n'], ['Chauffeur', o => `<b>${dlink(o.code, o.nom)}</b>`, o => o.nom], ['Niveau', o => rank ? badge(o.level, LEVEL_CLS[o.level]) : 'Non classé', o => o.score],
    ['Score /100 km', o => f1(o.score), o => o.score, 'n'], ['Km', o => f0(o.a.km), o => o.a.km, 'n'], ['Conduite', o => fH(o.a.drive), o => o.a.drive, 'n'], ['Événements /100 km', o => o.a.km > 0 ? f1(nEv(o) / o.a.km * 100) : '0', o => o.a.km > 0 ? nEv(o) / o.a.km : 0, 'n']]
    .concat(DRIVE_CATS.map(c => [CAT_TXT[c], o => o.cat[c] ? `<b>${o.cat[c]}</b>` : '0', o => o.cat[c], 'n']))
    .concat([['Temps en excès de vitesse', o => fH(o.speedS / 3600), o => o.speedS, 'n'], ['Vmax (km/h)', o => f0(o.vmax), o => o.vmax, 'n'],
      ['Vmax : véhicule et heure', o => o.vmaxAt ? esc(o.vmaxAt.plate) + ' le ' + fmtDT(o.vmaxAt.t) + (o.vmaxAt.lim ? ' (limite ' + o.vmaxAt.lim + ')' : '') : ''],
      ['Pire dépassement', o => o.worst ? `<b class="${o.worst.ex >= num(P.overAlert, 30) ? 'red' : ''}">+${f0(o.worst.ex)}</b> (${esc(o.worst.v)} / ${esc(o.worst.lim)})` : '', o => o.worst ? o.worst.ex : 0, 'n'],
      ['Pire dépassement : où et quand', o => o.worst ? esc(o.worst.plate) + ' le ' + fmtDay(localDay(o.worst.t)).slice(0, 5) + ' ' + esc(o.worst.hm) : ''],
      ['Trajets dépassant de ' + esc(P.overAlert || 30) + ' km/h ou plus', o => f0(o.nOver), o => o.nOver, 'n'], ['Trajets', o => f0(o.trips), null, 'n']]);
  $('#page').innerHTML = `<div class="head"><h1>Conduite</h1><div class="sub">Du plus dangereux au plus sûr. Chiffres bruts : événements détectés par le boîtier Geotab (règles de conduite, une seule version par règle), vitesse du capteur du véhicule, limite de la route fournie par Geotab. Classés : au moins ${esc(P.kmMin || 20)} km.</div></div>
    ${periodBar(go)}
    ${cards([['Le plus dangereux', ranked[0] ? esc(ranked[0].nom) : '—', 'crit'], ['Son score /100 km', ranked[0] ? f1(ranked[0].score) : ''], ['Le plus sûr', ranked.length ? esc(ranked[ranked.length - 1].nom) : '—', 'ok'],
      ['Son score /100 km', ranked.length ? f1(ranked[ranked.length - 1].score) : ''], ['Chauffeurs classés', ranked.length + ' / ' + list.length], ['Km analysés', f0(kmT)], ['Événements de conduite', f0(evT)]])}
    ${svgBars(ranked.map(o => ({ label: o.nom, value: Math.max(o.score, 0.5), color: LVL_COLOR[o.level], text: f1(o.score) + ' pts' })), { title: 'Score par chauffeur' })}
    <h2>Classement (1 = le plus dangereux)</h2>${table('tcond', cols(true), ranked)}
    ${small.length ? `<h2>Non classés : moins de ${esc(P.kmMin || 20)} km (pour information)</h2>${table('tcond2', cols(false), small)}` : ''}`;
}

// ---------- FICHE VÉHICULE ----------
async function pageFicheVehicule() {
  const key = qs().get('k') || '', v = S.veh[key];
  if (!v) { $('#page').innerHTML = msg('Véhicule inconnu ou d\'une autre agence. <a href="#/vehicules">Liste des véhicules</a>', 'warn'); return; }
  const P = S.P, p = period(), from31 = addDays(today(), -30);
  const [jrn, evts, idl, fuel, lvls, al, ctr] = await Promise.all([
    all('journal', '*', q => q.eq('vehicle_key', key).gte('day', [from31, p.from].sort()[0])),
    all('events', 'day,start_at,dur_s,rule_id,driver_code,contract_num', q => q.eq('vehicle_key', key).gte('day', addDays(p.from, -2)).lte('day', addDays(p.to, 1))),
    all('idles', '*', q => q.eq('vehicle_key', key).gte('day', from31)),
    all('fuel', '*', q => q.eq('vehicle_key', key).gte('day', from31)),
    all('levels', 'at,pct', q => q.eq('vehicle_key', key).gte('vday', addDays(today(), -3))),
    sb.from('alerts').select('*').eq('vehicle_key', key).order('day', { ascending: false }).order('time', { ascending: false }).limit(30),
    sb.from('contracts').select('num,name,client_code,start_at,end_at').eq('vehicle_key', key).order('start_at', { ascending: false }).limit(1)]);
  const a = aggJournal(jrn.filter(r => r.day >= p.from && r.day <= p.to), () => 'A', P).A || emptyAgg();
  const lv = lvls.map(x => ({ t: new Date(x.at).getTime(), v: num(x.pct) })).sort((x, y) => x.t - y.t), last = lv[lv.length - 1];
  const c0 = (ctr.data || [])[0], cur = c0 && new Date(c0.start_at) <= new Date() && (!c0.end_at || new Date(c0.end_at) >= new Date()) ? c0 : null;
  const cd = ctrDayMap(jrn), er = {};
  evts.filter(e => { const d = e.contract_num && cd[e.contract_num] ? cd[e.contract_num] : e.day; return d >= p.from && d <= p.to; }).forEach(e => {
    const rl = S.rules[e.rule_id] || { name: e.rule_id, weight: 0 }, k = e.rule_id + '|' + e.driver_code;
    const o = er[k] || (er[k] = { rule: rl.name, code: e.driver_code, n: 0, dur: 0, w: num(rl.weight) }); o.n++; o.dur += num(e.dur_s); });
  const byDay = aggJournal(jrn.filter(r => r.day >= from31), r => r.day, P), dkeys = Object.keys(byDay).sort();
  $('#page').innerHTML = `<div class="head"><h1>${plate(v.plate, v.other_plates)} <span class="small">${esc((v.brand || '') + ' ' + (v.model || ''))}</span></h1>
      <div class="sub">${esc(v.fuel || '')} · réservoir ${esc(v.tank_l || '?')} L · Geotab ${esc(v.geotab_name || 'non associé')} · ${v.agency_id ? 'agence ' + agTxt(v.agency_id) : 'sans agence'}</div></div>
    ${periodBar(go)}
    ${cards([['Km', f0(a.km)], ['Carburant (L)', fuelVal(a)], ['L/100 km', l100Val(a)], ['Ralenti total', fH(a.idle)], ['dont prolongé', fH(a.idleLong), a.idleLong ? 'crit' : ''], ['Arrêts prolongés', f0(a.nLong)],
      ['Pleins', f0(a.fills)], ['Siphonages suspects', f0(a.siph), a.siph ? 'crit' : ''], ['Événements', f0(a.evts)], ['Score /100 km', f1(scoreOf(a, P))], ['Vmax (km/h)', f0(a.vmax)]])}
    <div class="panel">Contrat en cours : <b>${cur ? dlink(cur.client_code, cur.name) + ' (' + esc(cur.num) + ') depuis ' + fmtDTY(cur.start_at) : (c0 ? 'aucun. Dernier : ' + dlink(c0.client_code, c0.name) + ' le ' + fmtDTY(c0.start_at) : 'aucun')}</b>
      · Dernière jauge : <b>${last ? f0(last.v) + ' %' : NM}</b>${last ? ' (relevée le ' + fmtDT(last.t) + ')' : ''}</div>
    <h2>Jauge carburant, 72 dernières heures (%)</h2>${svgLine(lv, { min: 0, max: 100, title: 'Jauge' })}
    <h2>Heures de ralenti par journée (31 jours)</h2>${svgBars(dkeys.map(d => ({ label: fmtDay(d), value: byDay[d].idle, color: byDay[d].idleLong > 0.5 ? '#C00000' : '#9DC3E6', text: fH(byDay[d].idle) + (byDay[d].idleLong ? ' (prolongé ' + fH(byDay[d].idleLong) + ')' : '') })))}
    <h2>Journées de travail (31 jours)</h2>
    ${table('tfvj', [['Date', r => fmtDay(r.day), r => r.day], ['Chauffeur', r => dlink(r.driver_code, drvName(r.driver_code, r.driver_name))], ['Contrat', r => esc(r.contract_num || 'Hors contrat')],
      ['Début', r => fmtDT(r.contract_start)], ['Fin', r => r.contract_end ? fmtDT(r.contract_end) : (r.contract_num ? 'en cours' : '')], ['Km', r => f1(r.km), r => r.km, 'n'], ['Conduite', r => fH(r.drive_h), r => r.drive_h, 'n'],
      ['Ralenti', r => fH(r.idle_h), r => r.idle_h, 'n'], ['dont prolongé', r => fH(r.long_idle_h), r => r.long_idle_h, 'n'], ['Carburant (L)', r => r.fuel_l === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l), r => r.fuel_l, 'n'],
      ['L/100', r => r.l100 === null ? '' : f1(r.l100), r => r.l100, 'n'], ['Vmax', r => f0(r.vmax), r => r.vmax, 'n'], ['Pire dépassement', r => r.worst_over === null ? '' : '+' + f0(r.worst_over), r => r.worst_over, 'n'],
      ['Événements', r => r.n_events, null, 'n'], ['Score', r => f1(r.score), r => r.score, 'n'], ['Pleins', r => r.n_fills, null, 'n'], ['Siphonages', r => r.n_siphon ? `<b class="red">${r.n_siphon}</b>` : '0', r => r.n_siphon, 'n']],
      jrn.filter(r => r.day >= from31).sort((x, y) => String(y.contract_start || y.day).localeCompare(String(x.contract_start || x.day))), { empty: 'Aucune journée' })}
    <h2>Événements Geotab par règle et chauffeur (période)</h2>
    ${table('tfve', [['Règle', o => esc(o.rule)], ['Chauffeur', o => dlink(o.code)], ['Nombre', o => o.n, null, 'n'], ['Durée cumulée', o => fH(o.dur / 3600), o => o.dur, 'n'], ['Poids', o => f1(o.w), null, 'n'], ['Points', o => f1(o.n * o.w), o => o.n * o.w, 'n']],
      Object.values(er).sort((x, y) => y.n * y.w - x.n * x.w || y.n - x.n), { empty: 'Aucun événement' })}
    <h2>Arrêts moteur allumé (31 jours)</h2>
    ${table('tfvi', [['Début', r => fmtDTY(r.start_at), r => r.start_at], ['Durée', r => fH(num(r.stop_min) / 60), r => num(r.stop_min), 'n'], ['Moteur tournant', r => r.engine_check === 'Régime moteur' ? fH(num(r.engine_min) / 60) : 'non vérifiable'],
      ['Chauffeur', r => dlink(r.driver_code, drvName(r.driver_code, r.driver_name))], ['Lieu', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">carte</a>` : '']],
      idl.sort((x, y) => new Date(y.start_at) - new Date(x.start_at)), { empty: 'Aucun arrêt prolongé' })}
    <h2>Pleins et siphonages suspects (31 jours)</h2>
    ${table('tfvf', [['Date / heure', f => fmtDTY(f.stop_start), f => f.stop_start], ['Type', f => f.type === 'PLEIN' ? badge('Plein', 'ok') : f.type === 'SIPHONAGE_SUSPECT' ? badge('Siphonage suspect', 'crit') : badge('Boîtier coupé', 'crit')],
      ['Jauge avant → après (%)', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after)], ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n'], ['Litres Geotab', f => f1(f.liters_geotab), null, 'n'],
      ['Chauffeur', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))], ['Chauffeur au redémarrage', f => esc(f.next_driver || '')], ['Statut', f => esc(f.status || '')]],
      fuel.sort((x, y) => new Date(y.stop_start) - new Date(x.stop_start)), { empty: 'Aucun' })}
    <h2>Alertes (30 plus récentes)</h2>${alertTable('tfva', al.data || [], false)}`;
}

// ---------- FICHE CHAUFFEUR (compte rendu chauffeur du Sheet, imprimable en PDF) ----------
async function pageFicheChauffeur() {
  const code = qs().get('c') || '', P = S.P, retFrom = addDays(today(), -Math.max(7, num(P.retentionDays, 62)));
  const [jrn, evts, idl, fuel, trips, al, drvRow, list] = await Promise.all([
    all('journal', '*', q => q.eq('driver_code', code).gte('day', retFrom)),
    all('events', 'vehicle_key,plate,day,start_at,dur_s,rule_id,contract_num', q => q.eq('driver_code', code).gte('day', retFrom)),
    all('idles', '*', q => q.eq('driver_code', code).gte('day', retFrom)),
    all('fuel', '*', q => q.gte('day', retFrom).in('type', ['PLEIN', 'SIPHONAGE_SUSPECT'])),
    all('trips', 'vehicle_key,plate,day,start_at,km,vmax,lim_at_vmax,worst_over,speed_at_worst,lim_at_worst,worst_time,lim_source', q => q.eq('driver_code', code).gte('day', retFrom)),
    all('alerts', '*', q => q.eq('driver_code', code), ['day', false]),
    sb.from('drivers').select('*').eq('code', code).maybeSingle(),
    drivingStats(retFrom, today())]);
  const ok = inAgency(), mine = jrn.filter(r => ok(r.vehicle_key)).sort((x, y) => String(x.contract_start || x.day).localeCompare(String(y.contract_start || y.day)));
  const d = drvRow.data || {}, nom = d.name || drvName(code);
  if (!mine.length && !d.code) { $('#page').innerHTML = msg('Chauffeur inconnu ou d\'une autre agence.', 'warn'); return; }
  const A = rows => aggJournal(rows, () => 'A', P).A || emptyAgg(), all0 = A(mine);
  const rk = list.filter(o => o.a.km >= num(P.kmMin, 20)).sort((x, y) => y.score - x.score), pos = rk.findIndex(o => o.code === code);
  const group = f => { const g = {}; mine.forEach(r => { (g[f(r)] = g[f(r)] || []).push(r); }); return g; };
  const LINE = [['Période', x => esc(x.label)], ['Journées', x => Object.keys(x.a.ctr).length || Object.keys(x.a.days).length, null, 'n'], ['Heures contrat', x => fH(x.a.ctrH), null, 'n'], ['Km', x => f1(x.a.km), null, 'n'],
    ['Conduite', x => fH(x.a.drive), null, 'n'], ['Ralenti', x => fH(x.a.idle), null, 'n'], ['dont prolongé', x => fH(x.a.idleLong), null, 'n'], ['Carburant (L)', x => nmv(fuelVal(x.a)), null, 'n'],
    ['L/100 km', x => nmv(l100Val(x.a)), null, 'n'], ['Vmax', x => f0(x.a.vmax), null, 'n'], ['Pire dépassement', x => x.a.worst === null ? '' : '+' + f0(x.a.worst), null, 'n'],
    ['Événements', x => x.a.evts, null, 'n'], ['Score /100 km', x => f1(scoreOf(x.a, P)), null, 'n'], ['Pleins', x => x.a.fills, null, 'n'], ['Siphonages', x => x.a.siph, null, 'n']];
  const gm = group(r => r.day.slice(0, 7)), gw = group(r => mondayOf(r.day));
  const mRows = Object.keys(gm).sort().map(k => ({ label: k.slice(5) + '/' + k.slice(0, 4), a: A(gm[k]) })).concat([{ label: 'Total', a: all0 }]);
  const wRows = Object.keys(gw).sort().map(k => ({ label: 'Sem. du ' + fmtDay(k).slice(0, 5) + ' au ' + fmtDay(addDays(k, 6)), a: A(gw[k]) })).concat([{ label: 'Total', a: all0 }]);
  const byR = {}; evts.forEach(e => { const rl = S.rules[e.rule_id] || { name: e.rule_id, weight: 0 }, o = byR[e.rule_id] || (byR[e.rule_id] = { n: rl.name, w: num(rl.weight), c: 0, d: 0 }); o.c++; o.d += num(e.dur_s); });
  const speed = trips.filter(r => num(r.worst_over) >= 10 || num(r.vmax) >= num(P.vmaxAlert, 130)).sort((x, y) => new Date(x.start_at) - new Date(y.start_at));
  const pleins = fuel.filter(f => f.type === 'PLEIN' && f.driver_code === code), siph = fuel.filter(f => f.type === 'SIPHONAGE_SUSPECT' && (f.driver_code === code || f.next_driver === nom));
  $('#page').innerHTML = `<div class="head"><h1>Compte rendu : ${esc(nom)}</h1><div class="sub">Code client ${esc(code)}${d.phone ? ' · Tél. ' + esc(d.phone) : ''}${d.agency_id ? ' · agence ' + agTxt(d.agency_id) : ''} ·
      ${mine.length ? 'du ' + fmtDay(mine[0].day) + ' au ' + fmtDay(mine[mine.length - 1].day) + ' (données conservées)' : 'aucune journée de travail'} · ${Object.keys(all0.ctr).length} contrats · véhicules ${esc(Object.keys(all0.plates).join(', '))}</div>
      <button id="cprint" class="ghost">Imprimer / PDF</button></div>
    ${cards([['Classement danger', pos >= 0 ? (pos + 1) + ' / ' + rk.length + ' (' + esc(rk[pos].level) + ')' : '—'], ['Score /100 km', f1(scoreOf(all0, P))], ['Km', f0(all0.km)], ['Heures sous contrat', fH(all0.ctrH)],
      ['Conduite', fH(all0.drive)], ['Ralenti', fH(all0.idle)], ['dont prolongé', fH(all0.idleLong) + ' (' + all0.nLong + ')', all0.idleLong ? 'crit' : ''], ['Carburant mesuré', all0.fuelN ? f1(all0.fuel) + ' L' : NM],
      ['Consommation', all0.l100 !== null ? f1(all0.l100) + ' L/100' : NM], ['Vmax', f0(all0.vmax) + ' km/h'], ['Événements', f0(all0.evts)], ['Siphonages suspects', f0(all0.siph), all0.siph ? 'crit' : ''], ['Alertes', f0(al.length)]])}
    <h2>Par mois</h2>${table('tccm', LINE, mRows)}
    <h2>Par semaine</h2>${table('tccw', LINE, wRows)}
    <h2>Par journée de travail (horaires du contrat)</h2>
    ${table('tccj', [['Date', r => fmtDay(r.day), r => r.day], ['Contrat', r => esc(r.contract_num || 'Hors contrat')], ['Véhicule', r => vlink(r.vehicle_key, r.plate)], ['Début', r => fmtDT(r.contract_start)],
      ['Fin', r => r.contract_end ? fmtDT(r.contract_end) : (r.contract_num ? 'en cours' : '')], ['Km', r => f1(r.km), r => r.km, 'n'], ['Conduite', r => fH(r.drive_h), null, 'n'], ['Ralenti', r => fH(r.idle_h), null, 'n'],
      ['Carburant (L)', r => r.fuel_l === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l), null, 'n'], ['L/100', r => r.l100 === null ? '' : f1(r.l100), null, 'n'], ['Vmax', r => f0(r.vmax), null, 'n'],
      ['Pire dépassement', r => r.worst_over === null ? '' : '+' + f0(r.worst_over), null, 'n'], ['Événements', r => r.n_events, null, 'n'], ['Score', r => f1(r.score), r => r.score, 'n']], mine.slice().reverse())}
    <h2>Arrêts moteur allumé (≥ ${esc(P.idleLongMin || 10)} min)</h2>
    ${table('tcci', [['Début', r => fmtDTY(r.start_at), r => r.start_at], ['Durée', r => fH(num(r.stop_min) / 60), null, 'n'], ['Moteur tournant', r => r.engine_check === 'Régime moteur' ? fH(num(r.engine_min) / 60) : 'non vérifiable'],
      ['Véhicule', r => vlink(r.vehicle_key, r.plate)], ['Litres', r => r.liters === null ? `<span class="nm">${NM}</span>` : f1(r.liters), null, 'n'], ['Lieu', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">carte</a>` : '']],
      idl.sort((x, y) => new Date(y.start_at) - new Date(x.start_at)), { empty: 'Aucun arrêt prolongé' })}
    <h2>Vitesse : dépassements de 10 km/h et plus, ou Vmax ≥ ${esc(P.vmaxAlert || 130)} km/h</h2>
    ${table('tccs', [['Trajet du', r => fmtDTY(r.start_at), r => r.start_at], ['Véhicule', r => vlink(r.vehicle_key, r.plate)], ['Km', r => f1(r.km), null, 'n'], ['Vmax', r => f0(r.vmax), null, 'n'], ['Limite à Vmax', r => esc(r.lim_at_vmax || ''), null, 'n'],
      ['Vitesse / limite au pire', r => esc((r.speed_at_worst || '') + ' / ' + (r.lim_at_worst || ''))], ['Dépassement', r => r.worst_over === null ? '' : `<b>+${f0(r.worst_over)}</b>`, r => num(r.worst_over), 'n'], ['Heure', r => esc(r.worst_time || '')]],
      speed, { empty: 'Aucun dépassement relevé (ou limites de route non fournies par Geotab)' })}
    <h2>Événements de conduite Geotab</h2>
    ${table('tccr', [['Règle', o => esc(o.n)], ['Nombre', o => o.c, null, 'n'], ['Poids', o => f1(o.w), null, 'n'], ['Points', o => f1(o.c * o.w), o => o.c * o.w, 'n'], ['Durée cumulée', o => fH(o.d / 3600), null, 'n']],
      Object.values(byR).sort((x, y) => y.c - x.c), { empty: 'Aucun événement' })}
    <h2>Carburant : pleins et siphonages</h2>
    ${table('tccp', [['Date / heure', f => fmtDTY(f.stop_start), f => f.stop_start], ['Véhicule', f => vlink(f.vehicle_key, f.plate)], ['Jauge avant → après (%)', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after)],
      ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n'], ['Litres Geotab', f => f1(f.liters_geotab), null, 'n']], pleins, { empty: 'Aucun plein pendant ses contrats' })}
    ${siph.length ? table('tccsi', [['Arrêt', f => fmtDTY(f.stop_start)], ['Redémarrage', f => fmtDTY(f.stop_end)], ['Véhicule', f => vlink(f.vehicle_key, f.plate)], ['Jauge', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after) + ' %'],
      ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n'], ['Rôle', f => f.driver_code === code ? 'Véhicule garé par lui' : 'Redémarré par lui'], ['Statut', f => esc(f.status || '')]], siph) : ''}
    <h2>Alertes</h2>${alertTable('tcca', al.filter(x => x.status !== 'Faux positif'), false)}
    <p class="small">Toutes les valeurs proviennent du boîtier Geotab. Journée de travail = horaires du contrat (tolérance ${esc(P.ctrTolMin || 20)} min). « ${NM} » quand Geotab ne fournit pas la valeur : rien n'est estimé.</p>`;
  $('#cprint').onclick = () => window.print();
}

// ---------- CHAUFFEURS EN DIRECT (depuis le début de leur contrat) ----------
async function liveDrivers(live) {
  const nums = live.map(r => r.contract_num).filter(Boolean);
  if (!nums.length) return '';
  const { data: ctrs } = await sb.from('contracts').select('num,client_code,name,start_at').in('num', nums);
  const since = (ctrs || []).reduce((m, c) => (!m || c.start_at < m ? c.start_at : m), null);
  if (!since) return '';
  const day0 = localDay(since);
  const [trips, evts] = await Promise.all([
    all('trips', 'vehicle_key,contract_num,km,drive_min,idle_min,fuel_l,vmax,worst_over', q => q.in('contract_num', nums).gte('day', addDays(day0, -1))),
    all('events', 'contract_num,rule_id', q => q.in('contract_num', nums).gte('day', addDays(day0, -1)))]);
  const by = {}; (ctrs || []).forEach(c => { by[c.num] = { c, km: 0, drive: 0, idle: 0, fuel: 0, fuelN: 0, vmax: 0, worst: null, evts: 0, pts: 0 }; });
  trips.forEach(t => { const o = by[t.contract_num]; if (!o) return; o.km += num(t.km); o.drive += num(t.drive_min); o.idle += num(t.idle_min); if (t.fuel_l !== null) { o.fuel += num(t.fuel_l); o.fuelN++; }
    o.vmax = Math.max(o.vmax, num(t.vmax)); if (t.worst_over !== null && (o.worst === null || num(t.worst_over) > o.worst)) o.worst = num(t.worst_over); });
  evts.forEach(e => { const o = by[e.contract_num], rl = S.rules[e.rule_id]; if (!o || !rl || num(rl.weight) <= 0) return; o.evts++; o.pts += num(rl.weight); });
  const P = S.P, rows = live.filter(r => by[r.contract_num]).map(r => Object.assign({ live: r }, by[r.contract_num]));
  rows.forEach(o => { o.score = o.pts / Math.max(o.km, num(P.kmMin, 20)) * 100; o.level = levelOf(o.score, P); });
  return `<h2>Chauffeurs en ce moment (depuis le début de leur contrat)</h2>
    ${table('tlived', [['Chauffeur', o => `<b>${dlink(o.c.client_code, o.c.name)}</b>`, o => o.c.name], ['Véhicule', o => vlink(o.live.vehicle_key, o.live.plate)],
      ['État', o => badge(o.live.state, (STATE_CLS[o.live.state] || '') + ' dot')], ['Depuis le', o => fmtDT(o.c.start_at), o => o.c.start_at], ['Km', o => f1(o.km), o => o.km, 'n'],
      ['Conduite', o => fH(o.drive / 60), o => o.drive, 'n'], ['Ralenti', o => fH(o.idle / 60), o => o.idle, 'n'], ['Carburant (L)', o => o.fuelN ? f1(o.fuel) : `<span class="nm">${NM}</span>`, o => o.fuel, 'n'],
      ['L/100 km', o => o.fuelN && o.km >= num(P.minFuelKm, 30) ? f1(o.fuel / o.km * 100) : '', null, 'n'], ['Vmax', o => f0(o.vmax), o => o.vmax, 'n'],
      ['Pire dépassement', o => o.worst === null ? '' : '+' + f0(o.worst), o => o.worst || 0, 'n'], ['Événements', o => o.evts, null, 'n'],
      ['Score /100 km', o => o.km >= num(P.kmMin, 20) ? badge(f1(o.score), LEVEL_CLS[o.level]) : '<span class="small">trop peu de km</span>', o => o.score, 'n']], rows, { empty: 'Aucun chauffeur sous contrat en ce moment' })}
    <div class="sub">Trajets terminés (contact coupé) : mis à jour toutes les ${esc(P.liveMin || 5)} min ; le trajet en cours est ajouté à la coupure du contact.</div>`;
}
