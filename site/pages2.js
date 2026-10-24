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
  if (qs().get('t') === 'carte') return pageCarteCarburant();
  const p = period(), key = qs().get('k') || '', P = S.P, retFrom = addDays(today(), -Math.max(7, num(P.retentionDays, 62)));
  const TC = 'id,vehicle_key,plate,day,start_at,km,drive_min,idle_min,fuel_l,fuel_source,idle_fuel_l,driver_code,driver_name,contract_num';
  const [trips, fuel, lvls, allTrips] = await Promise.all([
    dataRows('trips', TC, p.from, p.to, { key }),
    dataRows('fuel', '*', retFrom, today(), { key }),
    dataRows('levels', 'vehicle_key,at,pct', addDays(today(), -3), today(), { key, dayCol: 'vday' }),
    dataRows('trips', 'vehicle_key,start_at,km,fuel_l,fuel_source,driver_code', retFrom, today(), { key })]);
  const inP = d => d >= p.from && d <= p.to;
  // véhicules : actifs, ou ayant roulé dans la période (véhicule rendu en cours de période : ses litres comptent, sa ligne aussi)
  const rolled = new Set(trips.map(r => r.vehicle_key));
  const vk = key ? [key] : S.vehList.filter(v => (v.active !== 'NON' || rolled.has(v.key)) && inAgency()(v.key)).map(v => v.key);
  const mk = () => ({ trips: 0, km: 0, drive: 0, fuel: 0, fuelKm: 0, fuelN: 0, idleL: 0, idleN: 0, idleMin: 0, pleins: 0, pleinsL: 0, pleinsEst: 0, pleinsEstN: 0, cost: 0, noPrice: 0 });
  const byV = {}, byD = {}, byDay = {}, tot = mk();
  const add = (o, r, v) => { const km = num(r.km); o.trips++; o.km += km; o.drive += num(r.drive_min) / 60; o.idleMin += num(r.idle_min);
    if (r.fuel_l !== null) { o.fuel += num(r.fuel_l); o.fuelKm += km; o.fuelN++; if (priceOf(v)) o.cost += num(r.fuel_l) * priceOf(v); else o.noPrice++; }
    if (r.idle_fuel_l !== null) { o.idleL += num(r.idle_fuel_l); o.idleN++; } };
  const shOf = await contractShifts(trips.map(r => r.contract_num));
  trips.forEach(r => {
    const v = vehOf(r.vehicle_key), code = r.driver_code || HORS;
    const dk = (code === HORS ? '' : shOf(r.contract_num)) + '|' + code;
    add(byV[r.vehicle_key] = byV[r.vehicle_key] || mk(), r, v); add(tot, r, v); add(byD[dk] = byD[dk] || Object.assign(mk(), { name: r.driver_name, code, shift: dk.split('|')[0] }), r, v);
    if (r.fuel_l !== null) { const d = byDay[r.day] = byDay[r.day] || {}; d[r.vehicle_key] = (d[r.vehicle_key] || 0) + num(r.fuel_l); }
  });
  const fills = rptFillMark(fuel.filter(f => f.type === 'PLEIN')), fillsP = fills.filter(f => inP(f.day));   // litres d'un plein : mesure retenue selon le plein précédent
  fillsP.forEach(f => [byV[f.vehicle_key] = byV[f.vehicle_key] || mk(), tot].forEach(o => { o.pleins++; o.pleinsL += rptFillL(f); }));   // mesure retenue plein par plein (rptFillL)
  const l100 = o => o.fuelKm >= num(P.minFuelKm, 30) ? f1(o.fuel / o.fuelKm * 100) : (o.fuelN ? 'km insuffisants' : NM);
  const cov = o => o.trips ? Math.round(o.fuelN / o.trips * 100) + ' %' : '-';
  const cost = o => !o.fuelN ? '' : o.noPrice === o.fuelN ? '<span class="nm">prix non saisi</span>' : f0(o.cost) + (o.noPrice ? ' <span class="nm">(partiel : prix non saisi pour une partie)</span>' : '');
  const idleL = o => o.idleN ? f1(o.idleL) : (o.trips ? `<span class="nm">${NM}</span>` : '');
  // Jauge actuelle (dernière lecture) et courbe 72 h
  const lv = {}; lvls.forEach(x => { (lv[x.vehicle_key] = lv[x.vehicle_key] || []).push({ t: new Date(x.at).getTime(), v: num(x.pct) }); });
  Object.values(lv).forEach(a => a.sort((x, y) => x.t - y.t));
  const ff = fullToFull(fills, allTrips);
  // siphonages et trajets non enregistrés de la période (comme les cartes du haut)
  const siph = fuel.filter(f => f.type === 'SIPHONAGE_SUSPECT' && inP(f.day)).sort((a, b) => new Date(b.stop_start) - new Date(a.stop_start));
  const tne = fuel.filter(f => f.type === 'TRAJET_NON_ENREGISTRE' && inP(f.day)).sort((a, b) => new Date(b.stop_start) - new Date(a.stop_start));
  const rec = {}; fills.forEach(f => { const k = f.day.slice(0, 7) + '|' + f.vehicle_key, o = rec[k] || (rec[k] = { m: f.day.slice(0, 7), key: f.vehicle_key, n: 0, l: 0 });
    o.n++; o.l += rptFillL(f); });
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Carburant</h1><div class="sub">Litres = compteur carburant du véhicule, trajet par trajet (aucune estimation). Pleins détectés par Geotab : à comparer aux tickets. Un trajet compte dans la période s'il y démarre.</div></div>
    ${fuelTabs('')}
    ${periodBar(go)}<div class="bar">${vehSelect(key)}</div>
    ${cards([['Carburant consommé (L)', tot.fuelN ? f1(tot.fuel) : NM], ['Km', f0(tot.km)], ['Consommation (L/100 km)', l100(tot)], ['dont moteur allumé à l\'arrêt (L)', idleL(tot)],
      ['Pleins détectés', f0(tot.pleins)], ['Litres des pleins', f1(tot.pleinsL)], ['Coût (MAD)', cost(tot)], ['Trajets mesurés', cov(tot)],
      ['Siphonages suspects', f0(siph.filter(f => inP(f.day) && f.status !== 'Faux positif').length), siph.some(f => inP(f.day) && f.status !== 'Faux positif') ? 'crit' : '']])}
    <h2>Jauge en ce moment</h2>
    ${table('tjauge', [['Véhicule', k => vlink(k), k => vehOf(k).plate], ['Modèle', k => esc(vehOf(k).model || '')],
      ['Jauge (%)', k => { const a = lv[k]; return a && a.length ? `<b>${f0(a[a.length - 1].v)} %</b>` : `<span class="nm">${NM}</span>`; }, k => (lv[k] || []).slice(-1).map(x => x.v)[0] || -1, 'n'],
      ['Relevée le', k => { const a = lv[k]; return a && a.length ? fmtDT(a[a.length - 1].t) : ''; }]], vk, { empty: 'Aucun véhicule' })}
    ${key && lv[key] ? '<h2>Jauge, 72 dernières heures (%)</h2>' + svgLine(lv[key], { min: 0, max: 100, title: 'Jauge' }) : ''}
    <h2>Par véhicule</h2>
    ${table('tcv', [['Véhicule', k => vlink(k), k => vehOf(k).plate], ['Modèle', k => esc(vehOf(k).model || '')], ['Trajets', k => f0((byV[k] || mk()).trips), k => (byV[k] || mk()).trips, 'n'],
      ['Km', k => f1((byV[k] || mk()).km), k => (byV[k] || mk()).km, 'n'], ['Carburant (L)', k => (byV[k] || mk()).fuelN ? f1(byV[k].fuel) : `<span class="nm">${NM}</span>`, k => (byV[k] || mk()).fuel, 'n'],
      ['L/100 km', k => nmv(l100(byV[k] || mk())), null, 'n'], ['Litres moteur à l\'arrêt', k => idleL(byV[k] || mk()), k => (byV[k] || mk()).idleL, 'n'],
      ['Temps moteur à l\'arrêt', k => fH((byV[k] || mk()).idleMin / 60), k => (byV[k] || mk()).idleMin, 'n'], ['Pleins', k => f0((byV[k] || mk()).pleins), null, 'n'],
      ['Litres des pleins', k => f1((byV[k] || mk()).pleinsL), null, 'n'],
      ['Coût (MAD)', k => cost(byV[k] || mk()), null, 'n'], ['Trajets mesurés', k => cov(byV[k] || mk()), null, 'n']], vk)}
    <h2>Par chauffeur</h2>
    ${shiftSections(Object.keys(byD).sort((a, b) => byD[b].fuel - byD[a].fuel), k => byD[k].shift, (ks, sfx) => table('tcd' + sfx, [['Chauffeur', k => dlink(byD[k].code, drvName(byD[k].code, byD[k].name)), k => drvName(byD[k].code, byD[k].name)], ['Code', k => byD[k].code === HORS ? '' : esc(byD[k].code)], ['Trajets', k => byD[k].trips, null, 'n'],
      ['Km', k => f1(byD[k].km), k => byD[k].km, 'n'], ['Carburant (L)', k => byD[k].fuelN ? f1(byD[k].fuel) : `<span class="nm">${NM}</span>`, k => byD[k].fuel, 'n'],
      ['L/100 km', k => nmv(l100(byD[k])), null, 'n'], ['Litres moteur à l\'arrêt', k => idleL(byD[k]), k => byD[k].idleL, 'n'], ['Trajets mesurés', k => cov(byD[k]), null, 'n']], ks))}
    <h2>Par jour (litres)</h2>
    ${table('tcj', [['Jour', d => fmtDay(d), d => d]].concat(vk.map(k => [esc(vehOf(k).plate), d => byDay[d][k] ? f1(byDay[d][k]) : '', d => byDay[d][k] || 0, 'n']))
      .concat([['Total', d => `<b>${f1(Object.values(byDay[d]).reduce((s, x) => s + x, 0))}</b>`, null, 'n']]), Object.keys(byDay).sort())}
    <h2>Pleins détectés, un par un (${fillsP.length})</h2>
    ${table('tpl', [['Date / heure', f => fmtDTY(f.stop_start), f => f.stop_start], ['Véhicule', f => vlink(f.vehicle_key, f.plate), f => f.plate], ['Chauffeur', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))],
      ['Jauge avant (%)', f => f0(f.lvl_before), null, 'n'], ['Jauge après (%)', f => f0(f.lvl_after), null, 'n'], ['Litres', f => f1(rptFillL(f)), f => rptFillL(f), 'n'], ['Mesure retenue', f => esc(rptFillSrc(f))],
      ['Volume Geotab (L)', f => f.liters_geotab === null ? `<span class="nm">${NM}</span>` : f1(f.liters_geotab), f => num(f.liters_geotab), 'n'], ['Jauge × réservoir (L)', f => f1(f.liters_gauge), f => num(f.liters_gauge), 'n'], ['Lieu', f => mapLink(f.lat, f.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(f.lat, f.lon)}">carte</a>` : '']],
      fillsP.sort((a, b) => new Date(b.stop_start) - new Date(a.stop_start)), { empty: 'Aucun plein sur la période', page: true })}
    <h2>Consommation plein à plein</h2><div class="sub">Entre deux pleins complets (jauge ≥ ${esc(P.fullPct || 90)} % après le plein) : litres des pleins (volume calculé par Geotab) / km roulés. Écart = litres mesurés trajet par trajet comparés à ce volume : les deux viennent du compteur du véhicule, l'écart contrôle seulement qu'aucun trajet ne manque. Litres réellement facturés : onglet « Anomalies carburant ».</div>
    ${table('tff', [['Véhicule', x => vlink(x.key), x => vehOf(x.key).plate], ['Plein de départ', x => fmtDTY(x.from), x => x.from], ['Plein d\'arrivée', x => fmtDTY(x.to), x => x.to],
      ['Km roulés', x => f1(x.km), x => x.km, 'n'], ['Litres remis', x => f1(x.litres), x => x.litres, 'n'], ['L/100 km', x => x.l100 !== null ? `<b>${f1(x.l100)}</b>` : '<span class="nm">km insuffisants</span>', x => x.l100 || 0, 'n'],
      ['Chauffeur(s)', x => x.codes.map(c => dlink(c)).join(', ')], ['Attribuable à', x => x.single ? esc(x.single) : 'Plusieurs chauffeurs'],
      ['Litres mesurés par trajet', x => x.measured !== null ? f1(x.measured) : `<span class="nm">${NM}</span>`, null, 'n'],
      ['Écart (%)', x => x.gap === null ? '' : `<span class="${Math.abs(x.gap) > 15 ? 'red' : ''}">${f1(x.gap)}</span>`, x => x.gap || 0, 'n']], ff, { empty: 'Aucun intervalle entre deux pleins complets sur les données conservées', page: true })}
    <h2>Récapitulatif des pleins par mois et par véhicule</h2>
    ${table('trec', [['Mois', o => o.m.slice(5) + '/' + o.m.slice(0, 4), o => o.m], ['Véhicule', o => vlink(o.key)], ['Pleins', o => o.n, null, 'n'], ['Litres', o => f1(o.l), null, 'n']], Object.values(rec).sort((a, b) => b.m.localeCompare(a.m)), { empty: 'Aucun plein', page: true })}
    <h2>Siphonages suspects (baisse de jauge moteur coupé, sans trajet)</h2>
    ${table('tsi', [['Arrêt', f => fmtDTY(f.stop_start), f => f.stop_start], ['Redémarrage', f => fmtDTY(f.stop_end)], ['Véhicule', f => vlink(f.vehicle_key, f.plate)],
      ['Chauffeur à l\'arrêt', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))], ['Chauffeur au redémarrage', f => esc(f.next_driver || '')], ['Durée arrêt (min)', f => f0(f.stop_min), null, 'n'],
      ['Jauge avant → après (%)', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after)], ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n'],
      ['Statut', f => canEdit() ? `<select class="fst" data-f="${esc(f.id)}">${['À vérifier', 'Vérifié', 'Faux positif'].map(s => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : esc(f.status || '')],
      ['Lieu', f => mapLink(f.lat, f.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(f.lat, f.lon)}">carte</a>` : '']], siph, { empty: 'Aucun siphonage suspect', page: true })}
    <h2>Trajets non enregistrés (boîtier coupé, le compteur km du véhicule a avancé)</h2>
    ${table('ttne', [['De', f => fmtDTY(f.stop_start), f => f.stop_start], ['À', f => fmtDTY(f.stop_end)], ['Véhicule', f => vlink(f.vehicle_key, f.plate)], ['Chauffeur', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))],
      ['Km non enregistrés', f => esc(String(f.engine || '').split(' ')[0]), null, 'n'], ['Statut', f => esc(f.status || '')]], tne, { empty: 'Aucun', page: true })}`;
    $('#vsel').onchange = e => { location.hash = '#/carburant' + (e.target.value ? '?k=' + encodeURIComponent(e.target.value) : ''); };
    document.querySelectorAll('.fst').forEach(s => { s.onchange = async () => {
      const { error } = await sb.from('fuel').update({ status: s.value }).eq('id', s.dataset.f); if (error) { alert(error.message); return; }
      s.classList.add('saved'); await job('recompute', addDays(today(), -31)).catch(() => { }); }; });
  };
  window.__rerender = render; render();
}

/** Onglets du volet Carburant */
function fuelTabs(t) {
  return `<nav class="tabs" aria-label="Carburant"><a href="#/carburant" class="${t ? '' : 'on'}">Consommation et pleins</a><a href="#/carburant?t=carte" class="${t === 'carte' ? 'on' : ''}">Anomalies carburant (carte Afriquia)</a></nav>`;
}

// ---------- ANOMALIES CARBURANT : achats de la carte carburant (Afriquia) croisés avec les pleins Geotab ----------
const FC_STATUS = ['À vérifier', 'Justifié', 'Anomalie confirmée'];
async function pageCarteCarburant() {
  const p = period(), P = S.P, ok = inAgency(), MINS = 60000;
  const go = () => { pageCarteCarburant().catch(e => { $('#page').innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); }); };
  // achats : 60 jours avant la période en plus (relation litres / jauge par modèle, ticket précédent) et 2 jours après (plein de la
  // période payé après minuit ou transmis en différé) ; trajets : depuis 60 jours avant (moteur depuis le plein complet précédent)
  const tripsFrom = addDays(p.from, -60);
  const [tx, fills, lvls, trips] = await Promise.all([
    dataRows('fuel_card_tx', '*', addDays(p.from, -60), addDays(p.to, 2)),
    all('fuel', 'id,vehicle_key,plate,day,stop_start,lvl_before,lvl_after,liters_gauge,liters_geotab,driver_code,driver_name', q => q.eq('type', 'PLEIN').gte('day', addDays(p.from, -63)).lte('day', addDays(p.to, 1))).then(r => r.filter(x => ok(x.vehicle_key))),
    dataRows('levels', 'vehicle_key,at,pct', addDays(p.from, -1), addDays(p.to, 1), { dayCol: 'vday' }),
    dataRows('trips', 'vehicle_key,start_at,km,fuel_l', tripsFrom, addDays(p.to, 1))]);
  // chauffeur au moment du plein : contrat en cours sur le véhicule (contrat jamais clôturé : fin au début du suivant)
  const keys = [...new Set(tx.map(x => x.vehicle_key).filter(Boolean))], ctr = {};
  for (let i = 0; i < keys.length; i += 100) (await all('contracts', 'num,client_code,name,vehicle_key,start_at,end_at', q => q.in('vehicle_key', keys.slice(i, i + 100))
    .lte('start_at', dayBounds(addDays(p.to, 1)).end.toISOString()).or('end_at.is.null,end_at.gte.' + dayBounds(addDays(p.from, -3)).start.toISOString())))
    .forEach(c => { (ctr[c.vehicle_key] = ctr[c.vehicle_key] || []).push(c); });
  Object.values(ctr).forEach(l => ctrEffEnds(l));
  const who = (k, t) => { const c = (ctr[k] || []).filter(c => new Date(c.start_at).getTime() <= t && (c._end === null || t < c._end)).pop(); return c ? c.name || c.client_code : 'Sans contrat'; };
  const V = {}; S.vehList.forEach(v => { V[v.key] = v; });
  const res = rptFuelCard({ tx: tx.map(x => Object.assign({}, x, { at: new Date(x.at).getTime() })), fills, levels: lvls, trips, tripsFrom: dayBounds(tripsFrom).start.getTime(), vehicles: V, who });
  const inP = t => { const d = localDay(t); return d >= p.from && d <= p.to; };
  const rows = res.rows.filter(r => inP(r.at)), anom = rows.filter(r => r.anomalies.some(a => a.sev !== 'Info'));
  const orphans = res.orphans.filter(f => inP(new Date(f.stop_start).getTime()));
  const stOf = r => r.tx[0].status || 'À vérifier';
  // litres et montant à justifier : achat sans plein = tout le ticket ; litres en trop = facturé - attendu (au prix du ticket)
  const just = r => { if (stOf(r) === 'Justifié') return { l: 0, m: 0 };
    if (r.anomalies.some(a => a.t === 'Achat sans plein dans le véhicule')) return { l: r.liters, m: r.amount };
    // litres en trop : au-delà de la plus haute des mesures (jauge, moteur, capacité du réservoir)
    if (r.anomalies.some(a => a.t === 'Litres facturés supérieurs au plein mesuré' || a.t === 'Plus que la capacité du réservoir')) {
      const ref = Math.max(...[r.expected, r.engine, r.anomalies.some(a => a.t === 'Plus que la capacité du réservoir') ? r.tank : null].filter(x => x !== null && x !== undefined));
      const l = Math.max(0, r.liters - ref); return { l, m: r.liters ? r.amount * l / r.liters : 0 }; }
    return { l: 0, m: 0 }; };
  const sumL = rows.reduce((s, r) => s + r.liters, 0), sumM = rows.reduce((s, r) => s + r.amount, 0), nTk = rows.reduce((s, r) => s + r.tx.length, 0);
  const jL = anom.reduce((s, r) => s + just(r).l, 0), jM = anom.reduce((s, r) => s + just(r).m, 0);
  const nCrit = anom.filter(r => r.sev === 'Critique' && stOf(r) !== 'Justifié').length;
  const lastImp = tx.reduce((m, x) => x.imported_at > m ? x.imported_at : m, '');
  const fitTxt = Object.keys(res.fit).length ? 'Litres attendus pour une montée de jauge calés sur les pleins mesurés de chaque modèle (' + Object.keys(res.fit).map(m => m + ' : ' + res.fit[m].n).join(', ') + ') : la jauge Geotab n\'est pas proportionnelle.' : '';
  const eng = rows.filter(r => r.engine !== null && r.engine > 0 && !r.anomalies.some(a => a.sev !== 'Info')), engR = eng.length ? eng.reduce((s, r) => s + r.liters, 0) / eng.reduce((s, r) => s + r.engine, 0) : null;
  const hm = t => fmtDTY(new Date(t).toISOString());
  const lvTxt = r => r.lvlBefore === null ? `<span class="nm">${NM}</span>` : f0(r.lvlBefore) + ' % → ' + f0(r.lvlAfter) + ' %';
  const fillTxt = r => r.fill ? hm(r.fillAt) + (r.late ? ' <span class="badge warn" title="La station a transmis la transaction plus tard que le plein">transmis ' + Math.round((r.at - r.fillAt) / 3600000) + ' h après</span>' : '') : '<span class="badge crit">aucun</span>';
  const tkTxt = r => r.tx.map(x => esc(String(x.station || '').replace(/^\d+:/, '')) + (x.ticket ? ' · ticket ' + esc(x.ticket) : '')).join('<br>');
  const cols = [['Achat (heure Afriquia)', r => hm(r.at) + `<div class="small">${tkTxt(r)}</div>`, r => r.at], ['Véhicule', r => vlink(r.key, r.plate), r => r.plate], ['Chauffeur', r => esc(r.driver)],
    ['Litres facturés', r => `<b>${rptFmt(r.liters, 2)}</b>` + (r.tx.length > 1 ? ` <span class="small">(${r.tx.length} tickets)</span>` : ''), r => r.liters, 'n'],
    ['Montant TTC (MAD)', r => rptFmt(r.amount, 2), r => r.amount, 'n'], ['Plein Geotab', fillTxt, r => r.fillAt || 0], ['Jauge', lvTxt],
    ['Litres attendus (jauge)', r => r.expected === null ? `<span class="nm">${NM}</span>` : '≈ ' + f0(r.expected), r => r.expected || 0, 'n'],
    ['Consommé moteur depuis le plein précédent', r => r.engine === null ? `<span class="nm">${NM}</span>` : f1(r.engine), r => r.engine || 0, 'n']];
  const sevCol = ['Gravité', r => badge(r.sev, GRAV_CLS[r.sev]), r => RPT_SEV.indexOf(r.sev)];
  const anCol = ['Anomalie', r => r.anomalies.filter(a => a.sev !== 'Info').map(a => `<b>${esc(a.t)}</b><div class="small">${esc(a.d)}</div>`).join(''), null, 'wide'];
  const stCol = ['Statut', r => canEdit() ? `<select class="fcst" data-ids="${esc(r.tx.map(x => x.id).join('\n'))}">${FC_STATUS.map(s => `<option ${s === stOf(r) ? 'selected' : ''}>${s}</option>`).join('')}</select>` : esc(stOf(r)), stOf];
  const render = info => {
    $('#page').innerHTML = `<div class="head"><h1>Carburant</h1><div class="sub">Chaque achat de la carte carburant est comparé au plein détecté par Geotab (de 2 h 30 avant à 1 h 30 après l'achat : l'heure Afriquia est parfois décalée d'1 h), à la jauge du véhicule et au carburant consommé par le moteur depuis le plein précédent. Rien n'est estimé : chaque anomalie s'appuie sur une mesure Geotab.</div></div>
    ${fuelTabs('carte')}
    ${canEdit() ? `<div class="panel row"><label class="file">Extract des transactions Afriquia (.xlsx, .xls, .csv) <input type="file" id="fcfile" accept=".xlsx,.xls,.csv"></label>
      <span class="small">${lastImp ? 'Dernier import : ' + fmtDTY(lastImp) + '. ' : ''}Un même ticket importé deux fois n'est compté qu'une fois.</span></div>` : ''}
    <div id="fcres">${info || ''}</div>
    ${periodBar(go)}
    ${!tx.length ? msg('Aucun achat importé : importez l\'extract des transactions Afriquia ci-dessus.') : `
    ${cards([['Achats (tickets)', f0(nTk)], ['Litres facturés', f1(sumL)], ['Montant TTC (MAD)', f0(sumM)], ['Pleins Geotab rapprochés', f0(rows.filter(r => r.fill).length) + ' / ' + f0(rows.length)],
      ['Anomalies à vérifier', f0(anom.filter(r => stOf(r) === 'À vérifier').length), anom.some(r => stOf(r) === 'À vérifier') ? 'crit' : ''], ['dont critiques', f0(nCrit), nCrit ? 'crit' : ''],
      ['Litres à justifier', f1(jL), jL > 0 ? 'crit' : ''], ['Montant à justifier (MAD)', f0(jM), jM > 0 ? 'crit' : ''],
      ['Facturé / consommé moteur (pleins conformes, plein à plein)', engR === null ? `<span class="nm">${NM}</span>` : f0(engR * 100) + ' %']])}
    <div class="bar"><button id="fcpdf">PDF des anomalies</button><span class="hint">${esc(fitTxt || 'Litres attendus non mesurés : moins de 10 pleins rapprochés par modèle')}</span></div>
    <h2>Anomalies relevées <span class="small">· ${anom.length}</span></h2>
    ${table('tfca', [sevCol].concat(cols.slice(0, 3), [anCol], cols.slice(3, 7), [stCol]), anom.sort((a, b) => RPT_SEV.indexOf(a.sev) - RPT_SEV.indexOf(b.sev) || b.at - a.at), { empty: 'Aucune anomalie sur la période : chaque achat correspond à un plein mesuré par Geotab.' })}
    <h2>Pleins détectés par Geotab sans achat sur la carte <span class="small">· ${orphans.length}</span></h2>
    <div class="sub">Pleins mesurés par la jauge, sans ticket Afriquia du véhicule autour : payés autrement (espèces, autre carte) ou ticket absent de l'extract.</div>
    ${table('tfco', [['Plein Geotab', f => fmtDTY(f.stop_start), f => f.stop_start], ['Véhicule', f => vlink(f.vehicle_key, f.plate), f => f.plate], ['Chauffeur', f => esc(f.driver_name || '')],
      ['Jauge', f => f0(f.lvl_before) + ' % → ' + f0(f.lvl_after) + ' %'], ['Litres (jauge)', f => f1(f.liters_gauge), f => num(f.liters_gauge), 'n']], orphans, { empty: 'Aucun' })}
    <details><summary><h2>Tous les achats de la période <span class="small">· ${rows.length}</span></h2></summary>
    ${table('tfct', cols.concat([['Contrôle', r => r.anomalies.some(a => a.sev !== 'Info') ? badge(r.sev, GRAV_CLS[r.sev]) : '<span class="badge ok">conforme</span>', r => RPT_SEV.indexOf(r.sev)]]),
      rows.slice().sort((a, b) => b.at - a.at))}</details>`}`;
    const fi = $('#fcfile'); if (fi) fi.onchange = () => importFuelCard(fi.files[0]).then(t => { if (t) pageCarteCarburant().then(() => { const o = $('#fcres'); if (o) o.innerHTML = t; }); });
    document.querySelectorAll('.fcst').forEach(sel => { sel.onchange = async () => {
      const ids = sel.dataset.ids.split('\n'), { error } = await sb.from('fuel_card_tx').update({ status: sel.value }).in('id', ids);
      if (error) { alert(error.message); return; } tx.filter(x => ids.includes(x.id)).forEach(x => { x.status = sel.value; }); sel.classList.add('saved'); }; });
    const pb = $('#fcpdf'); if (pb) pb.onclick = () => { try {
      const pc = [['Gravité', r => r.sev], ['Achat', r => hm(r.at)], ['Véhicule', r => r.plate], ['Chauffeur', r => r.driver], ['Anomalie', r => r.anomalies.filter(a => a.sev !== 'Info').map(a => a.t + ' : ' + a.d).join(' / ')],
        ['Litres facturés', r => rptFmt(r.liters, 2), null, 'n'], ['Montant TTC', r => rptFmt(r.amount, 2), null, 'n'], ['Plein Geotab', r => r.fill ? hm(r.fillAt) + (r.late ? ' (transmis en différé)' : '') : 'aucun'],
        ['Jauge', r => r.lvlBefore === null ? NM : f0(r.lvlBefore) + ' % → ' + f0(r.lvlAfter) + ' %'], ['Litres attendus (jauge)', r => r.expected === null ? NM : f0(r.expected), null, 'n'], ['Consommé moteur', r => r.engine === null ? NM : f1(r.engine), null, 'n'], ['Statut', stOf]];
      reportPdf(rptSimple({ kind: 'carte', title: 'Anomalies carburant (carte Afriquia)', fileName: 'anomalies_carburant_' + p.from + (p.to !== p.from ? '_' + p.to : ''), period: p.from === p.to ? 'du ' + fmtDay(p.from) : 'du ' + fmtDay(p.from) + ' au ' + fmtDay(p.to), from: p.from, to: p.to,
        agency: agFilter() ? S.agName[agFilter()] : 'Toutes les agences',
        summary: [['Achats (tickets)', f0(nTk)], ['Litres facturés', f1(sumL)], ['Montant TTC (MAD)', f0(sumM)], ['Anomalies', f0(anom.length)], ['dont critiques', f0(nCrit)],
          ['Litres à justifier', f1(jL)], ['Montant à justifier (MAD)', f0(jM)], ['Facturé / consommé moteur', engR === null ? NM : f0(engR * 100) + ' %'],
          ['Méthode', 'plein Geotab de 2 h 30 avant à 1 h 30 après l\'achat (heure Afriquia parfois décalée d\'1 h) ; jauge du véhicule ; carburant consommé par le moteur depuis le plein complet précédent']],
        tables: [colsTable('Anomalies relevées', pc, anom, 'Aucune anomalie sur la période'),
          colsTable('Pleins détectés par Geotab sans achat sur la carte', [['Plein Geotab', f => fmtDTY(f.stop_start)], ['Véhicule', f => f.plate], ['Chauffeur', f => f.driver_name || ''],
            ['Jauge', f => f0(f.lvl_before) + ' % → ' + f0(f.lvl_after) + ' %'], ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n']], orphans, 'Aucun')] }));
      } catch (e) { alert('PDF impossible : ' + e.message); } };
  };
  window.__rerender = render; render();
}
/** Import de l'extract Afriquia : lecture, rattachement des plaques, enregistrement (un ticket déjà importé n'est pas compté deux fois) */
async function importFuelCard(file) {
  const out = $('#fcres'); if (!file) return '';
  out.innerHTML = msg('Lecture du fichier…');
  try {
    const rows = await readSheet(file), pc = await all('plate_changes', 'old_plate,new_plate'), res = parseFuelCard(rows, buildCanonMap(S.vehList, pc));
    if (!res.rows.length) throw new Error('aucune transaction lue (' + res.invalid + ' lignes sans date, quantité ou plaque).');
    out.innerHTML = msg('Enregistrement de ' + res.rows.length + ' transactions…');
    let r = { added: 0, updated: 0, same: 0, skipped: 0 };
    for (let i = 0; i < res.rows.length; i += 500) { const x = await rpc('import_fuel_card', { p_rows: res.rows.slice(i, i + 500) }); Object.keys(r).forEach(k => { r[k] += x[k] || 0; }); }
    const unknown = [...new Set(res.rows.filter(x => !S.veh[x.vehicle_key]).map(x => x.plate))];
    const days = res.rows.map(x => x.day).sort();
    return msg(`<b>Transactions lues : ${res.read}</b> (du ${fmtDay(days[0])} au ${fmtDay(days[days.length - 1])}) : ${r.added} nouvelles, ${r.updated} mises à jour, ${r.same + res.dup} déjà importées` +
      (res.invalid ? `, ${res.invalid} lignes ignorées (sans date, quantité ou plaque)` : '') + (r.skipped ? `, ${r.skipped} ignorées (véhicules d'une autre agence)` : '') + '.' +
      (unknown.length ? `<br><b>Plaques non reconnues (${unknown.length}) :</b> ${unknown.map(esc).join(', ')} : ajoutez-les dans <a href="#/plaques">Plaques</a> puis réimportez le fichier.` : '') +
      '<br>Choisissez la période ci-dessous pour voir les anomalies.', unknown.length ? 'warn' : 'ok');
  } catch (e) { out.innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); return ''; }
}

// ---------- RALENTI (moteur allumé à l'arrêt) ----------
async function pageRalenti() {
  const P = S.P, td = today(), retFrom = addDays(td, -Math.max(7, num(P.retentionDays, 62)));
  const [jrn, idl] = await Promise.all([dataRows('journal', '*', retFrom, td), dataRows('idles', '*', addDays(td, -30), td)]);
  const per = [['Aujourd\'hui', td, td], ['Hier', addDays(td, -1), addDays(td, -1)], ['Semaine', mondayOf(td), td], ['Mois', td.slice(0, 8) + '01', td], ['Données conservées', '0000', '9999']];
  const build = keyFn => { const aggs = per.map(x => aggJournal(jrn.filter(r => r.day >= x[1] && r.day <= x[2]), keyFn, P)), allA = aggs[4];
    return { aggs, keys: Object.keys(allA).sort((a, b) => allA[b].idle - allA[a].idle) }; };
  const jk = r => (r.driver_code && r.driver_code !== HORS ? shiftOf(r.contract_start, P) : '') + '|' + r.driver_code, kc = k => k.slice(k.indexOf('|') + 1), ks = k => k.slice(0, k.indexOf('|'));
  const bd = build(jk), bv = build(r => r.vehicle_key);
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
    const m = {}; jrn.forEach(r => { if (r.day < days[0] || r.driver_code === HORS) return; const v = valFn(r); if (v === null) return; const k = jk(r); (m[k] = m[k] || {})[r.day] = ((m[k] || {})[r.day] || 0) + v; });
    const keys = Object.keys(m).filter(k => days.some(d => m[k][d])), max = Math.max(1e-9, ...keys.flatMap(k => days.map(d => m[k][d] || 0)));
    const tot = k => days.reduce((s, d) => s + (m[k][d] || 0), 0);
    return shiftSections(keys.sort((a, b) => tot(b) - tot(a)), ks, (sub, sfx) => table(id + sfx, [['Chauffeur', k => dlink(kc(k)), k => drvName(kc(k))]].concat(days.map(d => [d.slice(8) + '/' + d.slice(5, 7),
      k => m[k][d] !== undefined ? `<span class="heat" style="background:${grad(m[k][d] / max)}">${fmt(m[k][d])}</span>` : '', k => m[k][d] || 0, 'n']))
      .concat([['Total', k => `<b>${fmt(tot(k))}</b>`, k => tot(k), 'n']]), sub), { empty: 'Aucune donnée sur 14 jours' });
  };
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Ralenti</h1><div class="sub">Ralenti = véhicule immobile, moteur thermique tournant (régime moteur). Ralenti prolongé = arrêts de ${esc(P.idleLongMin)} min et plus (feux et bouchons exclus). Journée = horaires du contrat.</div></div>
    <h2>Heures de ralenti par chauffeur</h2>${shiftSections(bd.keys, ks, (sub, sfx) => table('trd' + sfx, cols(bd, 'Chauffeur', k => drvName(kc(k)), k => dlink(kc(k))), sub))}
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
    all('fuel', 'vehicle_key,plate,type,stop_start,stop_end,lvl_before,lvl_after,liters_gauge,liters_geotab,engine,status,driver_code,driver_name', q => q.gte('stop_start', new Date(A - 45 * DAY).toISOString()).lt('stop_start', zI)),   // 45 j avant : plein précédent (litres d'un plein)
    all('engine_stops', 'vehicle_key,start_at,dur_min,liters,driver_code,contract_num', q => q.gte('start_at', aI).lt('start_at', zI)).catch(() => null),
    all('vehicle_days', 'vehicle_key,day', q => q.gte('day', d0).lte('day', d1))]);
  // Journées passées (avant-hier et plus) ni finalisées ni téléchargées : totaux incomplets, signalé
  const have = new Set(vd.map(x => x.vehicle_key + '|' + x.day)), missing = [];
  for (let d = d0; d <= d1 && d <= addDays(today(), -2); d = addDays(d, 1)) vlist.filter(v => v.geotab_id && v.active !== 'NON').forEach(v => { if (!have.has(v.key + '|' + d)) missing.push({ plate: v.plate, day: d }); });
  const ctrShift = await contractShifts(trips.map(r => r.contract_num).concat((stops || []).map(r => r.contract_num)));
  const rep = rptConso({ trips: trips.filter(mine), fuel: fuel.filter(mine), stops: stops ? stops.filter(mine) : null, vehicles: vlist, drivers: S.drv, P, a: A, z: Z, missing, ctrShift,
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
  const det = rows.slice().sort((a, b) => new Date(b.start_at) - new Date(a.start_at)), shOf = await contractShifts(rows.map(r => r.contract_num));
  const sk = r => (r.driver_code && r.driver_code !== HORS ? shOf(r.contract_num) : '') + '|' + (r.driver_code || HORS), kc = k => k.slice(k.indexOf('|') + 1);
  $('#page').innerHTML = `<div class="head"><h1>Arrêts moteur tournant</h1><div class="sub">Chaque arrêt de ${esc(minS)} min et plus, véhicule immobile (moins de 2 km/h) et moteur thermique tournant (plus de ${esc(P.rpmMin || 300)} tr/min).
    <b>Litres</b> = compteur Geotab du carburant brûlé au ralenti, relevé juste avant et juste après l'arrêt : valeur réelle. Le boîtier ne relève ce compteur qu'à certains moments (surtout au contact mis ou coupé) :
    quand aucun relevé n'encadre l'arrêt, les litres de l'arrêt sont « non mesuré » et la colonne « Ralenti du trajet » donne le total réel du trajet, qui inclut cet arrêt (plafond).
    <b>Ceinture conducteur</b> : état transmis par le véhicule pendant l'arrêt (Staria) ; la présence d'un passager et la climatisation ne sont transmises par aucun boîtier : non mesurées.</div></div>
    ${periodBar(go)}<div class="bar">${vehSelect(sel)}${isAdmin() ? '<button class="ghost" id="stopsback">Calculer les 14 derniers jours</button><span id="stopsres" class="hint"></span>' : ''}</div>
    ${cards([['Arrêts moteur tournant', f0(rows.length)], ['Durée totale', fH(minT / 60)], ['Arrêts avec litres mesurés', measured.length + ' / ' + rows.length],
      ['Litres mesurés', measured.length ? f1(litres) : NM], ['L/h mesuré', measured.length ? f1(litres / (measured.reduce((t, r) => t + num(r.dur_min), 0) / 60 || 1)) : NM],
      ['Ceinture connue', beltKnown.length + ' / ' + rows.length]])}
    <h2>Par chauffeur</h2>${shiftSections(group(sk), a => a.k.slice(0, a.k.indexOf('|')), (sub, sfx) => table('tstd' + sfx, gcols('Chauffeur', k => drvName(kc(k)), k => dlink(kc(k))), sub), { empty: 'Aucun arrêt moteur tournant sur la période' })}
    <h2>Par véhicule</h2>${table('tstv', gcols('Véhicule', k => vehOf(k).plate, k => vlink(k)), group(r => r.vehicle_key), { empty: 'Aucun arrêt moteur tournant sur la période' })}
    <h2>Détail des arrêts</h2>
    ${table('tstops', [['Début', r => fmtDTY(r.start_at), r => r.start_at], ['Fin', r => fmtDT(r.end_at)], ['Durée (min)', r => f1(r.dur_min), r => num(r.dur_min), 'n'],
      ['Véhicule', r => vlink(r.vehicle_key, r.plate)], ['Chauffeur', r => dlink(r.driver_code, drvName(r.driver_code, r.driver_name))], ['Shift', r => shiftBadge(sk(r).split('|')[0]), r => sk(r)], ['Contrat', r => esc(r.contract_num || '')],
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
    all('trips', '*', q => { q = q.gte('day', addDays(from, -1)).lte('day', addDays(to, 1)); if (opt.code) q = q.eq('driver_code', opt.code); return q; })]);   // * : dépassements par limite (over_by_limit) quand la colonne existe
  const cd = ctrDayMap(jrn), dayOf = r => r.contract_num && cd[r.contract_num] ? cd[r.contract_num] : r.day, inP = d => d >= from && d <= to;
  // opt.split : un chauffeur par shift (jour / nuit, début du contrat) ; événements et trajets rattachés par leur contrat
  const cs = {}; jrn.forEach(r => { if (r.contract_num) cs[r.contract_num] = shiftOf(r.contract_start, P); });
  const kOf = r => opt.split ? shiftOf(r.contract_start, P) + '|' + r.driver_code : r.driver_code;
  const agg = aggJournal(jrn.filter(r => ok(r.vehicle_key) && r.driver_code !== HORS && inP(r.day)), kOf, P), by = {}, first = {};
  Object.values(agg).forEach(a => { const sc = scoreOf(a, P), code = opt.split ? a.k.slice(a.k.indexOf('|') + 1) : a.k;
    by[a.k] = { a, code, shift: opt.split ? a.k.slice(0, a.k.indexOf('|')) : '', nom: drvName(code, Object.keys(a.names)[0]), score: sc, level: levelOf(sc, P), cat: {}, speedS: 0, vmax: 0, vmaxAt: null, worst: null, nOver: 0, trips: 0 };
    if (!first[code] || a.km > first[code].a.km) first[code] = by[a.k];
    DRIVE_CATS.forEach(c => { by[a.k].cat[c] = 0; }); });
  const oOf = r => opt.split ? (r.contract_num && by[cs[r.contract_num] + '|' + r.driver_code]) || first[r.driver_code] : by[r.driver_code];
  evts.forEach(e => { const o = oOf(e); if (!o || !ok(e.vehicle_key) || !inP(dayOf(e))) return; const rl = S.rules[e.rule_id]; if (!rl || num(rl.weight) <= 0) return;
    if (o.cat[rl.category] === undefined) return; o.cat[rl.category]++; if (rl.category === 'Vitesse') o.speedS += num(e.dur_s); });
  trips.forEach(r => { const o = oOf(r); if (!o || !ok(r.vehicle_key) || !inP(dayOf(r))) return; o.trips++;
    if (num(r.vmax) > o.vmax) { o.vmax = num(r.vmax); o.vmaxAt = { t: r.start_at, plate: r.plate, lim: r.lim_at_vmax }; }
    if (rptOverHit(r, P)) o.nOver++;
    if (r.worst_over !== null) {
      if (!o.worst || num(r.worst_over) > o.worst.ex) o.worst = { ex: num(r.worst_over), v: r.speed_at_worst, lim: r.lim_at_worst, hm: r.worst_time || '', t: r.start_at, plate: r.plate }; } });
  return Object.values(by);
}
async function pageConduite() {
  const p = period(), P = S.P, list = await drivingStats(p.from, p.to, { split: true });
  const ranked = list.filter(o => o.a.km >= num(P.kmMin, 20)).sort((x, y) => y.score - x.score || y.a.pts - x.a.pts), small = list.filter(o => o.a.km < num(P.kmMin, 20));
  const nEv = o => DRIVE_CATS.reduce((t, c) => t + o.cat[c], 0), kmT = list.reduce((t, o) => t + o.a.km, 0), evT = list.reduce((t, o) => t + nEv(o), 0);
  const cols = rank => [['Rang', o => rank ? ranked.filter(x => x.shift === o.shift).indexOf(o) + 1 : '', null, 'n'], ['Chauffeur', o => `<b>${dlink(o.code, o.nom)}</b>`, o => o.nom], ['Niveau', o => rank ? badge(o.level, LEVEL_CLS[o.level]) : 'Non classé', o => o.score],
    ['Score /100 km', o => f1(o.score), o => o.score, 'n'], ['Km', o => f0(o.a.km), o => o.a.km, 'n'], ['Conduite', o => fH(o.a.drive), o => o.a.drive, 'n'], ['Événements /100 km', o => o.a.km > 0 ? f1(nEv(o) / o.a.km * 100) : '0', o => o.a.km > 0 ? nEv(o) / o.a.km : 0, 'n']]
    .concat(DRIVE_CATS.map(c => [CAT_TXT[c], o => o.cat[c] ? `<b>${o.cat[c]}</b>` : '0', o => o.cat[c], 'n']))
    .concat([['Temps en excès de vitesse', o => fH(o.speedS / 3600), o => o.speedS, 'n'], ['Vmax (km/h)', o => f0(o.vmax), o => o.vmax, 'n'],
      ['Vmax : véhicule et heure', o => o.vmaxAt ? esc(o.vmaxAt.plate) + ' le ' + fmtDT(o.vmaxAt.t) + (o.vmaxAt.lim ? ' (limite ' + o.vmaxAt.lim + ')' : '') : ''],
      ['Pire dépassement', o => o.worst ? `<b class="${o.worst.lim && o.worst.ex >= rptOverTol(P, num(o.worst.lim)) ? 'red' : ''}">+${f0(o.worst.ex)}</b> (${esc(o.worst.v)} / ${esc(o.worst.lim)})` : '', o => o.worst ? o.worst.ex : 0, 'n'],
      ['Pire dépassement : où et quand', o => o.worst ? esc(o.worst.plate) + ' le ' + fmtDay(localDay(o.worst.t)).slice(0, 5) + ' ' + esc(o.worst.hm) : ''],
      ['Trajets au-dessus du seuil d\'alerte de dépassement', o => f0(o.nOver), o => o.nOver, 'n'], ['Trajets', o => f0(o.trips), null, 'n']]);
  $('#page').innerHTML = `<div class="head"><h1>Conduite</h1><div class="sub">Du plus dangereux au plus sûr. Chiffres bruts : événements détectés par le boîtier Geotab (règles de conduite, une seule version par règle), vitesse du capteur du véhicule, limite de la route fournie par Geotab. Classés : au moins ${esc(P.kmMin || 20)} km.</div>
      <button id="cdpdf">Télécharger le PDF</button></div>
    ${periodBar(go)}
    ${cards([['Le plus dangereux', ranked[0] ? esc(ranked[0].nom) : '—', 'crit'], ['Son score /100 km', ranked[0] ? f1(ranked[0].score) : ''], ['Le plus sûr', ranked.length ? esc(ranked[ranked.length - 1].nom) : '—', 'ok'],
      ['Son score /100 km', ranked.length ? f1(ranked[ranked.length - 1].score) : ''], ['Chauffeurs classés', ranked.length + ' / ' + list.length], ['Km analysés', f0(kmT)], ['Événements de conduite', f0(evT)]])}
    ${svgBars(ranked.map(o => ({ label: o.nom + ' (' + (o.shift === 'Jour' ? 'jour' : 'nuit') + ')', value: Math.max(o.score, 0.5), color: LVL_COLOR[o.level], text: f1(o.score) + ' pts' })), { title: 'Score par chauffeur' })}
    <h2>Classement par shift (1 = le plus dangereux du shift)</h2>${shiftSections(ranked, o => o.shift, (sub, sfx) => table('tcond' + sfx, cols(true), sub))}
    ${small.length ? `<h2>Non classés : moins de ${esc(P.kmMin || 20)} km (pour information)</h2>${shiftSections(small, o => o.shift, (sub, sfx) => table('tcond2' + sfx, cols(false), sub))}` : ''}`;
  $('#cdpdf').onclick = () => { try {
    const tabs = [];
    SHIFTS.forEach(sh => { const nm = sh ? shiftName(sh, P) : 'Hors contrat', a = ranked.filter(o => (o.shift || '') === sh), b = small.filter(o => (o.shift || '') === sh);
      if (a.length) tabs.push(colsTable('Classement conduite : ' + nm + ' (1 = le plus dangereux)', cols(true), a));
      if (b.length) tabs.push(colsTable('Non classés, moins de ' + (P.kmMin || 20) + ' km : ' + nm, cols(false), b)); });
    reportPdf(rptSimple({ kind: 'conduite', title: 'Conduite des chauffeurs', period: p.from === p.to ? 'du ' + fmtDay(p.from) : 'du ' + fmtDay(p.from) + ' au ' + fmtDay(p.to), from: p.from, to: p.to,
      agency: agFilter() ? S.agName[agFilter()] : 'Toutes les agences',
      summary: [['Le plus dangereux', ranked[0] ? ranked[0].nom + ' (' + f1(ranked[0].score) + ' /100 km)' : '—'], ['Le plus sûr', ranked.length ? ranked[ranked.length - 1].nom + ' (' + f1(ranked[ranked.length - 1].score) + ' /100 km)' : '—'],
        ['Chauffeurs classés', ranked.length + ' / ' + list.length], ['Km analysés', f0(kmT)], ['Événements de conduite', f0(evT)],
        ['Sources', 'événements du boîtier Geotab, vitesse du capteur du véhicule, limite de la route fournie par Geotab']], tables: tabs }));
  } catch (e) { alert('PDF impossible : ' + e.message); } };
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
    // contrat en cours : le plus récent déjà commencé (une réservation future ne masque pas le contrat en cours)
    sb.from('contracts').select('num,name,client_code,start_at,end_at').eq('vehicle_key', key).lte('start_at', new Date().toISOString()).order('start_at', { ascending: false }).limit(1)]);
  rptFillMark(fuel.filter(f => f.type === 'PLEIN'));   // litres d'un plein : selon le plein précédent
  const a = aggJournal(jrn.filter(r => r.day >= p.from && r.day <= p.to), () => 'A', P).A || emptyAgg();
  const lv = lvls.map(x => ({ t: new Date(x.at).getTime(), v: num(x.pct) })).sort((x, y) => x.t - y.t), last = lv[lv.length - 1];
  const c0 = (ctr.data || [])[0], cur = c0 && new Date(c0.start_at) <= new Date() && (!c0.end_at || new Date(c0.end_at) >= new Date()) ? c0 : null;
  const cd = ctrDayMap(jrn), er = {}, alS = await alertShifts((al.data || []).slice());
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
      ['Jauge avant → après (%)', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after)], ['Litres', f => f.type === 'PLEIN' ? f1(rptFillL(f)) : f1(f.liters_gauge), null, 'n'], ['Mesure', f => f.type === 'PLEIN' ? esc(rptFillSrc(f)) : 'jauge'],
      ['Chauffeur', f => dlink(f.driver_code, drvName(f.driver_code, f.driver_name))], ['Chauffeur au redémarrage', f => esc(f.next_driver || '')], ['Statut', f => esc(f.status || '')]],
      fuel.sort((x, y) => new Date(y.stop_start) - new Date(x.stop_start)), { empty: 'Aucun' })}
    <h2>Alertes (30 plus récentes)</h2>${alertTable('tfva', alS, false)}`;
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
  const d = drvRow.data || {}, nom = d.name || drvName(code), alS = await alertShifts(al.filter(a => ok(a.vehicle_key)));
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
  rptFillMark(fuel.filter(f => f.type === 'PLEIN'));   // plein précédent de chaque véhicule (litres d'un plein)
  const pleins = fuel.filter(f => f.type === 'PLEIN' && f.driver_code === code), siph = fuel.filter(f => f.type === 'SIPHONAGE_SUSPECT' && (f.driver_code === code || f.next_driver === nom));
  $('#page').innerHTML = `<div class="head"><h1>Compte rendu : ${esc(nom)}</h1><div class="sub">Code client ${esc(code)}${d.phone ? ' · Tél. ' + esc(d.phone) : ''}${d.agency_id ? ' · agence ' + agTxt(d.agency_id) : ''} ·
      ${mine.length ? 'du ' + fmtDay(mine[0].day) + ' au ' + fmtDay(mine[mine.length - 1].day) + ' (données conservées)' : 'aucune journée de travail'} · ${Object.keys(all0.ctr).length} contrats · véhicules ${esc(Object.keys(all0.plates).join(', '))}</div>
      <button id="cprint" class="ghost">Imprimer / PDF</button> <a class="btnlink" href="#/comportement?c=${encodeURIComponent(code)}">Comportement entre deux dates (PDF, e-mail)</a></div>
    ${cards([['Classement danger', pos >= 0 ? (pos + 1) + ' / ' + rk.length + ' (' + esc(rk[pos].level) + ')' : '—'], ['Score /100 km', f1(scoreOf(all0, P))], ['Km', f0(all0.km)], ['Heures sous contrat', fH(all0.ctrH)],
      ['Conduite', fH(all0.drive)], ['Ralenti', fH(all0.idle)], ['dont prolongé', fH(all0.idleLong) + ' (' + all0.nLong + ')', all0.idleLong ? 'crit' : ''], ['Carburant mesuré', all0.fuelN ? f1(all0.fuel) + ' L' : NM],
      ['Consommation', all0.l100 !== null ? f1(all0.l100) + ' L/100' : l100Val(all0)], ['Vmax', f0(all0.vmax) + ' km/h'], ['Événements', f0(all0.evts)], ['Siphonages suspects', f0(all0.siph), all0.siph ? 'crit' : ''], ['Alertes', f0(alS.filter(x => x.status !== 'Faux positif').length)]])}
    <h2>Par mois</h2>${table('tccm', LINE, mRows)}
    <h2>Par semaine</h2>${table('tccw', LINE, wRows)}
    <h2>Par journée de travail (horaires du contrat)</h2>
    ${table('tccj', [['Date', r => fmtDay(r.day), r => r.day], ['Contrat', r => esc(r.contract_num || 'Hors contrat')], ['Shift', r => shiftBadge(r.contract_num ? shiftOf(r.contract_start, P) : ''), r => r.contract_num ? shiftOf(r.contract_start, P) : ''], ['Véhicule', r => vlink(r.vehicle_key, r.plate)], ['Début', r => fmtDT(r.contract_start)],
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
      ['Litres', f => f1(rptFillL(f)), null, 'n'], ['Mesure', f => esc(rptFillSrc(f))]], pleins, { empty: 'Aucun plein pendant ses contrats' })}
    ${siph.length ? table('tccsi', [['Arrêt', f => fmtDTY(f.stop_start)], ['Redémarrage', f => fmtDTY(f.stop_end)], ['Véhicule', f => vlink(f.vehicle_key, f.plate)], ['Jauge', f => f1(f.lvl_before) + ' → ' + f1(f.lvl_after) + ' %'],
      ['Litres (jauge)', f => f1(f.liters_gauge), null, 'n'], ['Rôle', f => f.driver_code === code ? 'Véhicule garé par lui' : 'Redémarré par lui'], ['Statut', f => esc(f.status || '')]], siph) : ''}
    <h2>Alertes</h2>${alertTable('tcca', alS.filter(x => x.status !== 'Faux positif'), false)}
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
  const by = {}; (ctrs || []).forEach(c => { by[c.num] = { c, km: 0, drive: 0, idle: 0, fuel: 0, fuelN: 0, fuelKm: 0, vmax: 0, worst: null, evts: 0, pts: 0 }; });
  trips.forEach(t => { const o = by[t.contract_num]; if (!o) return; o.km += num(t.km); o.drive += num(t.drive_min); o.idle += num(t.idle_min); if (t.fuel_l !== null) { o.fuel += num(t.fuel_l); o.fuelN++; o.fuelKm += num(t.km); }
    o.vmax = Math.max(o.vmax, num(t.vmax)); if (t.worst_over !== null && (o.worst === null || num(t.worst_over) > o.worst)) o.worst = num(t.worst_over); });
  evts.forEach(e => { const o = by[e.contract_num], rl = S.rules[e.rule_id]; if (!o || !rl || num(rl.weight) <= 0) return; o.evts++; o.pts += num(rl.weight); });
  const P = S.P, rows = live.filter(r => by[r.contract_num]).map(r => Object.assign({ live: r }, by[r.contract_num]));
  rows.forEach(o => { o.score = o.pts / Math.max(o.km, num(P.kmMin, 20)) * 100; o.level = levelOf(o.score, P); });
  return `<h2>Chauffeurs en ce moment (depuis le début de leur contrat)</h2>
    ${shiftSections(rows, o => shiftOf(o.c.start_at, P), (sub, sfx) => table('tlived' + sfx, [['Chauffeur', o => `<b>${dlink(o.c.client_code, o.c.name)}</b>`, o => o.c.name], ['Véhicule', o => vlink(o.live.vehicle_key, o.live.plate)],
      ['État', o => badge(o.live.state, (STATE_CLS[o.live.state] || '') + ' dot')], ['Depuis le', o => fmtDT(o.c.start_at), o => o.c.start_at], ['Km', o => f1(o.km), o => o.km, 'n'],
      ['Conduite', o => fH(o.drive / 60), o => o.drive, 'n'], ['Ralenti', o => fH(o.idle / 60), o => o.idle, 'n'], ['Carburant (L)', o => o.fuelN ? f1(o.fuel) : `<span class="nm">${NM}</span>`, o => o.fuel, 'n'],
      ['L/100 km', o => o.fuelKm >= num(P.minFuelKm, 30) ? f1(o.fuel / o.fuelKm * 100) : '', null, 'n']   /* litres mesurés / km de ces mêmes trajets */, ['Vmax', o => f0(o.vmax), o => o.vmax, 'n'],
      ['Pire dépassement', o => o.worst === null ? '' : '+' + f0(o.worst), o => o.worst || 0, 'n'], ['Événements', o => o.evts, null, 'n'],
      ['Score /100 km', o => o.km >= num(P.kmMin, 20) ? badge(f1(o.score), LEVEL_CLS[o.level]) : '<span class="small">trop peu de km</span>', o => o.score, 'n']], sub), { empty: 'Aucun chauffeur sous contrat en ce moment' })}
    <div class="sub">Trajets terminés (contact coupé) : mis à jour toutes les ${esc(P.liveMin || 5)} min ; le trajet en cours est ajouté à la coupure du contact.</div>`;
}

// ---------- COMPORTEMENT CHAUFFEUR : profil et historique entre deux dates, PDF, envoi par e-mail ----------
function compInputs() {
  let c = null; try { c = JSON.parse(localStorage.getItem('comp') || 'null'); } catch (e) { }
  const q = qs(), t = today();
  return { c: q.get('c') || (c && c.c) || '', from: (c && c.from) || addDays(t, -29), to: (c && c.to) || t };
}
/** Toutes les données du chauffeur sur la période (droits de la base : agences), puis le rapport partagé rptDriver (site/report.js) */
async function driverReport(code, from, to) {
  const P = S.P, dr = q => q.eq('driver_code', code).gte('day', from).lte('day', to);
  const [drv, jrn, trips, evts, fuel, stops, idles, al, rankJ] = await Promise.all([
    sb.from('drivers').select('*').eq('code', code).maybeSingle(),
    all('journal', '*', dr),
    all('trips', '*', dr),
    all('events', 'id,vehicle_key,plate,day,start_at,dur_s,km,rule_id,rule_name,driver_code', dr),
    all('fuel', '*', q => q.gte('day', addDays(from, -45)).lte('day', to).in('type', ['PLEIN', 'SIPHONAGE_SUSPECT'])),   // 45 j avant : plein précédent
    all('engine_stops', '*', dr).catch(() => null),
    all('idles', '*', dr),
    all('alerts', '*', dr),
    all('journal', 'id,driver_code,day,km,danger_pts', q => q.gte('day', from).lte('day', to))]);
  const ok = inAgency(), mine = r => ok(r.vehicle_key), d = drv.data || {};
  return rptDriver({ driver: { code, name: d.name || drvName(code), phone: d.phone, email: d.email, agency: d.agency_id ? S.agName[d.agency_id] : '' },
    journal: jrn.filter(mine), trips: trips.filter(mine), events: evts.filter(mine), fuel: fuel.filter(mine), stops: stops ? stops.filter(mine) : null, idles: idles.filter(mine),
    alerts: al.filter(mine), rules: S.rules, P, from, to, rankJournal: rankJ.filter(mine), dayOf: localDay, hmOf: localHM, generatedAt: new Date() });
}
async function pageComportement() {
  const inp = compInputs(), P = S.P;
  const codes = Object.keys(S.drv).filter(c => c !== HORS).sort((a, b) => String(S.drv[a]).localeCompare(String(S.drv[b])));
  const lbl = c => (S.drv[c] || c) + ' (' + c + ')';
  const head = `<div class="head"><h1>Comportement chauffeur</h1><div class="sub">Profil et historique complet d'un chauffeur entre deux dates (journées de travail de ses contrats) : conduite, vitesse, événements Geotab, consommation, pleins, ralenti, alertes. PDF et envoi par e-mail. Rien n'est estimé.</div></div>
    <div class="bar"><label>Chauffeur <input id="cdrv" list="cdrvl" value="${esc(inp.c ? lbl(inp.c) : '')}" placeholder="Nom ou code client" autocomplete="off" size="34"></label>
      <datalist id="cdrvl">${codes.map(c => `<option value="${esc(lbl(c))}"></option>`).join('')}</datalist>
      <label>Du <input type="date" id="cfrom" value="${esc(inp.from)}"></label><label>au <input type="date" id="cto" value="${esc(inp.to)}"></label><button id="cgo">Afficher</button></div>`;
  const bind = () => {
    $('#cgo').onclick = () => {
      const v = $('#cdrv').value.trim(), m = v.match(/\(([^()]+)\)\s*$/), code = m ? m[1] : codes.find(c => c === v || String(S.drv[c]).toLowerCase() === v.toLowerCase()) || '';
      const f = $('#cfrom').value, t = $('#cto').value;
      if (!code) { alert('Chauffeur inconnu : choisissez-le dans la liste.'); return; }
      if (!f || !t || f > t) { alert('Période invalide.'); return; }
      try { localStorage.setItem('comp', JSON.stringify({ c: code, from: f, to: t })); } catch (e) { }
      if (qs().get('c') && qs().get('c') !== code) location.hash = '#/comportement'; else go();
    };
  };
  if (!inp.c) { $('#page').innerHTML = head + msg('Choisissez un chauffeur et une période, puis « Afficher ».'); bind(); return; }
  const rep = await driverReport(inp.c, inp.from, inp.to), a = rep.agg;
  const days = {};
  // un point par journée de travail : score de la journée (journal du collecteur)
  (await all('journal', 'id,day,km,danger_pts,score,vehicle_key', q => q.eq('driver_code', inp.c).gte('day', inp.from).lte('day', inp.to))).filter(r => inAgency()(r.vehicle_key))
    .forEach(r => { const x = days[r.day] = days[r.day] || { km: 0, pts: 0 }; x.km += num(r.km); x.pts += num(r.danger_pts); });
  const dk = Object.keys(days).sort(), sc = x => x.pts / Math.max(x.km, num(P.kmMin, 20)) * 100;
  const initials = String(S.drv[inp.c] || inp.c).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const sum = Object.fromEntries(rep.summary);
  $('#page').innerHTML = head + `
    <div class="dprof">
      <div class="dav" aria-hidden="true">${esc(initials)}</div>
      <div class="did"><h2>${esc(rep.title.replace('Comportement du chauffeur : ', ''))}</h2>
        <div class="sub">${esc(rep.agency)} · ${esc(sum['Téléphone / e-mail'])} · ${esc(rep.period)}</div>
        <div class="dlinks"><a href="#/chauffeur?c=${encodeURIComponent(inp.c)}">Fiche chauffeur (toutes ses données conservées)</a></div></div>
      <div class="dlevel">${rep.level ? badge(rep.level, LEVEL_CLS[rep.level]) : ''}<div class="small">${esc(sum['Rang au classement (1 = le plus dangereux)'] !== '-' ? 'Rang ' + sum['Rang au classement (1 = le plus dangereux)'] : '')}</div></div>
      <div class="dact"><button id="cpdf">Télécharger le PDF</button>
        ${canEdit() ? `<div class="dmail"><input type="email" id="cmail" placeholder="adresse e-mail" value="${esc((S.session && S.session.user && S.session.user.email) || '')}"><button id="csend" class="ghost">Envoyer par e-mail</button></div><div id="cmailst" class="small" aria-live="polite"></div>` : ''}</div>
    </div>
    ${cards([['Km', f0(a.km)], ['Conduite', fH(a.drive)], ['Ralenti', fH(a.idle), a.idleLong ? 'warn' : ''], ['Carburant', a.fuelN ? f1(a.fuel) + ' L' : NM],
      ['L/100 km', l100Val(a)], ['Événements', f0(a.evts)], ['Score /100 km', rep.score != null ? f1(rep.score) : '—', rep.level ? LEVEL_CLS[rep.level] : ''],
      ['Pleins', esc(sum['Pleins détectés'].split(' ')[0])], ['Alertes', esc(String(sum['Alertes']).match(/\d+/g).reduce((t, x) => t + +x, 0))]])}
    <div class="grid2">
      <div><h2>Score de danger par journée</h2>${svgBars(dk.map(k => { const s = sc(days[k]), lv = levelOf(s, P); return { label: fmtDay(k), value: Math.max(s, 0.3), color: LVL_COLOR[lv], text: f1(s) + ' · ' + f0(days[k].km) + ' km' }; }), { title: 'Score par journée', empty: 'Aucune journée de travail' })}</div>
      <div><h2>Km par journée</h2>${svgBars(dk.map(k => ({ label: fmtDay(k), value: days[k].km, text: f1(days[k].km) + ' km' })), { title: 'Km par journée', empty: 'Aucune journée de travail' })}</div>
    </div>
    <div class="panel rptview">${rptHtml(rep)}</div>`;
  bind();
  $('#cpdf').onclick = () => { try { reportPdf(rep); } catch (e) { alert('PDF impossible : ' + e.message); } };
  const sb2 = $('#csend');
  if (sb2) sb2.onclick = async () => {
    const to = $('#cmail').value.trim(), st = $('#cmailst');
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) { st.textContent = 'Adresse e-mail invalide.'; return; }
    sb2.disabled = true; st.textContent = 'Demande envoyée au collecteur (PDF préparé et envoyé dans les 5 min)…';
    try {
      const id = await job('driver_report', JSON.stringify({ code: inp.c, from: inp.from, to: inp.to, email: to }));
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const { data } = await sb.from('jobs').select('done_at,result').eq('id', id).maybeSingle();
        if (data && data.done_at) { st.textContent = /^Erreur|impossible/i.test(data.result || '') ? data.result : 'Envoyé : ' + (data.result || to); break; }
        if (!$('#cmailst')) return;
      }
    } catch (e) { st.textContent = 'Erreur : ' + e.message; }
    sb2.disabled = false;
  };
}

// ---------- RÉSULTAT DE FIN DE SHIFT ----------
/** Contrats d'un shift (jour J 07:00 → 19:00, nuit J 19:00 → J+1 07:00) : PDF général du shift ou PDF par chauffeur */
async function pageFinShift() {
  const P = S.P, q = qs(), cur = shiftAt(new Date(), P), ok = inAgency();
  // par défaut : le dernier shift terminé
  const prev = cur.s === 'Jour' ? { s: 'Nuit', day: addDays(cur.day, -1) } : { s: 'Jour', day: cur.day };
  const sel = { s: q.get('s') === 'Jour' || q.get('s') === 'Nuit' ? q.get('s') : prev.s, day: /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : prev.day };
  const label = shiftName(sel.s, P).replace(/^Shift (jour|nuit)/, (m, x) => 'Shift ' + x + ' du ' + fmtDay(sel.day).slice(0, 5) + (sel.s === 'Nuit' ? ' au ' + fmtDay(addDays(sel.day, 1)).slice(0, 5) : ''));
  const running = sel.s === cur.s && sel.day === cur.day;
  // contrats du shift : une ligne de journal par contrat (shift = heure de début du contrat : 7 h → 19 h jour, sinon nuit)
  const jrn = (await all('journal', '*', x => x.gte('day', addDays(sel.day, -1)).lte('day', addDays(sel.day, 1)).not('contract_num', 'is', null)))
    .filter(r => ok(r.vehicle_key) && r.contract_start && (sc => sc.s === sel.s && sc.day === sel.day)(shiftOfCtr(r.contract_start, P)));
  const nums = jrn.map(r => r.contract_num), byNums = async (t, cols) => { const out = []; for (let i = 0; i < nums.length; i += 150) out.push(...await all(t, cols, x => x.in('contract_num', nums.slice(i, i + 150)))); return out; };
  const [trips, evts, stops, idles, fuel, al0] = await Promise.all([
    byNums('trips', '*'), byNums('events', 'id,vehicle_key,plate,day,start_at,dur_s,km,rule_id,rule_name,driver_code,contract_num'),
    byNums('engine_stops', '*').catch(() => null), byNums('idles', '*').catch(() => []),
    all('fuel', '*', x => x.gte('day', addDays(sel.day, -45)).lte('day', addDays(sel.day, 1)).in('type', ['PLEIN', 'SIPHONAGE_SUSPECT'])),   // 45 j avant : plein précédent
    all('alerts', '*', x => x.gte('day', sel.day).lte('day', addDays(sel.day, 1)))]);
  // alertes du shift (contrat en cours à leur heure, sinon créneau horaire), véhicules de l'agence
  const al = (await alertShifts(al0.filter(a => ok(a.vehicle_key)))).filter(a => { const x = alertShiftDay(a); return x && x.s === sel.s && x.day === sel.day; });
  const agency = agFilter() ? S.agName[agFilter()] : (isAdmin() || S.agencies.length !== 1 ? '' : S.agencies[0].name);
  const tag = sel.day + '_' + sel.s.toLowerCase();
  const rep = rptShiftEnd({ journal: jrn, events: evts, trips, alerts: al, rules: S.rules, P, title: 'Résultat de fin de shift', period: label + (running ? ' (shift en cours : résultats provisoires)' : ''),
    from: sel.day, agency: agency || 'Toutes les agences', fileTag: tag, dayOf: localDay, hmOf: localHM });
  rptFillMark(fuel.filter(f => f.type === 'PLEIN'));   // plein précédent du véhicule (tous chauffeurs) avant de garder ceux du contrat
  const drvRep = r => {
    const mine = x => x.contract_num === r.contract_num;
    // pleins et siphonages du contrat ; siphonage remarqué au redémarrage par ce chauffeur pendant son contrat
    const t0 = new Date(r.contract_start).getTime(), t1 = r.contract_end ? new Date(r.contract_end).getTime() : Infinity;
    const fuelOf = f => mine(f) || (f.type === 'SIPHONAGE_SUSPECT' && f.next_driver === r.driver_name && new Date(f.stop_end).getTime() >= t0 && new Date(f.stop_end).getTime() <= t1);
    const d = rptDriver({ driver: { code: r.driver_code, name: S.drv[r.driver_code] || r.driver_name }, journal: [r], trips: trips.filter(mine), events: evts.filter(mine),
      fuel: fuel.filter(fuelOf), stops: stops ? stops.filter(mine) : null, idles: idles.filter(mine),
      alerts: al.filter(a => a.driver_code === r.driver_code), rules: S.rules, P, from: sel.day, to: addDays(sel.day, 1), rankJournal: jrn, dayOf: localDay, hmOf: localHM });
    return Object.assign(d, { kind: 'finshift_chauffeur', title: 'Fin de shift : ' + (S.drv[r.driver_code] || r.driver_name), period: label + ' · contrat ' + r.contract_num + ' · ' + (r.plate || ''),
      fileName: 'fin_de_shift_' + tag + '_' + r.driver_code });
  };
  const list = jrn.slice().sort((a, b) => String(a.driver_name).localeCompare(String(b.driver_name)));
  $('#page').innerHTML = `<div class="head"><h1>Résultat de fin de shift</h1><div class="sub">Contrats commencés dans le shift choisi (shift = heure de début du contrat). Données Geotab uniquement, « ${NM} » quand Geotab ne fournit pas la valeur.</div></div>
    <div class="bar"><label>Jour <input type="date" id="fsday" value="${esc(sel.day)}" max="${esc(today())}"></label>
      <label>Shift <select id="fss"><option value="Jour"${sel.s === 'Jour' ? ' selected' : ''}>${esc(shiftName('Jour', P))}</option><option value="Nuit"${sel.s === 'Nuit' ? ' selected' : ''}>${esc(shiftName('Nuit', P))}</option></select></label>
      <button id="fspdf"${jrn.length ? '' : ' disabled'}>PDF général du shift</button><button id="fsall" class="ghost"${jrn.length ? '' : ' disabled'}>Un PDF par chauffeur (${jrn.length})</button></div>
    ${running ? msg('Shift en cours : les trajets terminés sont comptés au fil de la collecte (toutes les 5 min).', 'warn') : ''}
    ${list.length ? `<h2>PDF par chauffeur</h2>${table('tfsd', [['Chauffeur', r => `<b>${dlink(r.driver_code, S.drv[r.driver_code] || r.driver_name)}</b>`, r => r.driver_name], ['Véhicule', r => vlink(r.vehicle_key, r.plate)],
      ['Contrat', r => esc(r.contract_num)], ['Début', r => fmtDT(r.contract_start), r => r.contract_start], ['Km', r => f1(r.km), r => r.km, 'n'],
      ['PDF', r => `<button class="ghost fsone" data-c="${esc(r.contract_num)}">PDF</button>`]], list)}` : ''}
    <div class="panel rptview">${rptHtml(rep)}</div>`;
  const go = () => { location.hash = '#/finshift?d=' + encodeURIComponent($('#fsday').value || sel.day) + '&s=' + encodeURIComponent($('#fss').value); };
  $('#fsday').onchange = go; $('#fss').onchange = go;
  const pdf = r => { try { reportPdf(r); } catch (e) { alert('PDF impossible : ' + e.message); } };
  $('#fspdf').onclick = () => pdf(rep);
  document.querySelectorAll('.fsone').forEach(b => { b.onclick = () => pdf(drvRep(jrn.find(r => r.contract_num === b.dataset.c))); });
  // un fichier par chauffeur (le navigateur peut demander d'autoriser les téléchargements multiples)
  $('#fsall').onclick = async () => { for (const r of list) { pdf(drvRep(r)); await new Promise(z => setTimeout(z, 400)); } };
}
