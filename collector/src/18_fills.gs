// ============================================================================
// PLEINS EN COURS DE JOURNÉE (à côté du moteur v6, qui reste inchangé)
// Geotab calcule ses pleins (FillUp) avec retard, après le trajet qui suit le plein : la collecte en direct, qui ne relit
// pas un trajet déjà traité, ne les voyait qu'à la finalisation de la journée (le lendemain vers 13 h).
// À chaque passage : FillUp des journées pas encore finalisées (hier et aujourd'hui), toute la flotte en un appel,
// écrits en lignes provisoires avec la même clé et les mêmes valeurs que la finalisation (qui les remplace ensuite).
// ============================================================================
function liveFills_() {
  const veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId);
  if (!list.length) return 0;
  const now = Date.now(), today = localDay_(now), fin = doneVehDays_(addDays_(today, -2));
  const from = dayBounds_(addDays_(today, -1)).start.getTime();
  const calls = list.map(v => ({ method: 'Get', params: { typeName: 'FillUp', search: { deviceSearch: { id: v.geoId }, fromDate: iso_(from), toDate: iso_(now) } } }));
  const res = [];
  geoFetchAll_(chunks_(calls, 100).map(c => ({ method: 'ExecuteMultiCall', params: { calls: c } }))).forEach(rd => {
    const r = rd(); if (r.err) throw r.err; r.res.forEach(x => res.push(x || []));
  });
  const acc = newAcc_(), none = { cycles: [], idles: [], engStops: [], offStops: [], evts: [], lvl: [] };
  list.forEach((v, i) => {
    const fills = [];
    (res[i] || []).forEach(f => {
      const t = new Date(f.dateTime).getTime(); if (isNaN(t) || t < from || t > now || fin[v.key + '|' + localDay_(t)]) return;
      const ex = f.tankLevelExtrema || {};   // mêmes champs que cAnalyze_ (moteur v6)
      fills.push({ t, volume: f.volume != null ? +f.volume : null, derived: f.derivedVolume != null ? +f.derivedVolume : null,
        min: ex.minimaPoint ? cPct_(ex.minimaPoint, f.tankCapacity) : null, max: ex.maximaPoint ? cPct_(ex.maximaPoint, f.tankCapacity) : null,
        cap: f.tankCapacity ? +f.tankCapacity.volume : null, lat: f.location ? f.location.y : '', lon: f.location ? f.location.x : '',
        conf: String(f.confidence || '') });
    });
    if (fills.length) emitRows_(v, Object.assign({ fills }, none), params_(), acc);
  });
  if (!acc.fuels.length) return 0;
  attribRows_('FUEL', acc.fuels, attribCtx_());
  // pleins nouveaux ou modifiés seulement : le journal n'est recalculé que s'il y a du nouveau (sinon toutes les 15 min pour rien)
  const F = ['lvl_before', 'lvl_after', 'liters_gauge', 'liters_geotab', 'driver_code', 'contract_num'], sig = o => F.map(c => o[c] == null ? '' : String(+o[c] === +o[c] ? +o[c] : o[c])).join('|');
  const rows = acc.fuels.map(r => toDb_('FUEL', r, true)), old = {};
  // clés lues par lots tenus sous ~1,5 Ko d'URL (UrlFetch refuse au-delà de 2 Ko ; 40 clés de plein encodées en font ~2,7)
  const lots = [[]];
  rows.forEach(o => { const l = lots[lots.length - 1]; if (l.length && inList_(l.concat(o.id)).length > 1500) lots.push([o.id]); else l.push(o.id); });
  lots.forEach(l => { if (l.length) dbSelect_('fuel', 'select=id,' + F.join(',') + '&id=' + inList_(l), 'id').forEach(o => { old[o.id] = sig(o); }); });
  const changed = rows.filter(o => old[o.id] !== sig(o)).length;
  putLive_('FUEL', acc.fuels);
  return changed;
}

// ============================================================================
// PLEINS VUS PAR LA JAUGE (à côté du moteur v6, qui reste inchangé)
// Geotab peut publier son FillUp des heures après le plein, ou jamais (968200WW le 19/10/2026 : jauge 8 % → 98 %, aucun FillUp).
// À chaque passage, sur les 3 derniers jours : montée de jauge d'au moins GAUGE_FILL_PCT points en 3 h au plus (relevés `levels`)
// sans plein Geotab de 4 h avant à 4 h après = plein « Jauge (en attente du FillUp Geotab) », litres non mesurés (la jauge du Staria
// n'est pas proportionnelle : rien d'estimé). Dès que Geotab publie son FillUp, la ligne de la jauge est retirée.
// Contrôle sur les vraies données (05/10 → 30/10) : 110 FillUp sur 110 retrouvés par la jauge, 2 montées sans FillUp (deux vrais pleins).
// Journée finalisée (la finalisation remplace toutes ses lignes) : la ligne est réécrite au passage suivant, en ligne finalisée.
// ============================================================================
const GAUGE_FILL_PCT = 20, GAUGE_FILL_WIN = 3 * HOUR, GAUGE_FILL_NEAR = 4 * HOUR, GAUGE_FILL_DAYS = 3;
/** Montées de jauge d'une liste triée [{ t, p }] : [[indice du point bas, indice du point haut]] */
function gaugeRises_(l) {
  const out = [];
  let k = 0;
  while (k < l.length) {
    let lo = k, hi = k;
    for (let j = k + 1; j < l.length && l[j].t - l[lo].t <= GAUGE_FILL_WIN; j++) {
      if (hi === lo && l[j].p <= l[lo].p) { lo = hi = j; continue; }   // la jauge baisse encore : nouveau point bas
      if (l[j].p >= l[hi].p) hi = j; else if (l[hi].p - l[j].p > 3) break;   // redescend après la montée : fin du plein
    }
    if (hi > lo && l[hi].p - l[lo].p >= GAUGE_FILL_PCT) { out.push([lo, hi]); k = hi + 1; } else k = Math.max(k + 1, lo);
  }
  return out;
}
function gaugeFills_() {
  const veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId);
  if (!list.length) return 0;
  const now = Date.now(), from = addDays_(localDay_(now), -(GAUGE_FILL_DAYS - 1)), t0 = dayBounds_(from).start.getTime() - GAUGE_FILL_WIN;
  const keys = list.map(v => v.key), inK = 'vehicle_key=' + inList_(keys);
  const lv = dbSelect_('levels', 'select=vehicle_key,at,pct&' + inK + '&at=gte.' + new Date(t0).toISOString(), 'at,id');
  const fu = dbSelect_('fuel', 'select=id,vehicle_key,stop_start,lvl_before,lvl_after,driver_code&type=eq.PLEIN&' + inK +
    '&stop_start=gte.' + new Date(t0 - GAUGE_FILL_NEAR).toISOString(), 'stop_start,id');
  const byV = {}, geo = {}, old = {};
  lv.forEach(x => { const t = new Date(x.at).getTime(), p = +x.pct; if (!isNaN(t) && x.pct !== null && isFinite(p)) (byV[x.vehicle_key] = byV[x.vehicle_key] || []).push({ t, p }); });
  fu.forEach(f => { if (/\|PLEIN_JAUGE$/.test(f.id)) old[f.id] = f; else (geo[f.vehicle_key] = geo[f.vehicle_key] || []).push(new Date(f.stop_start).getTime()); });
  const rows = [];
  list.forEach(v => {
    const l = byV[v.key] || [];
    gaugeRises_(l).forEach(([lo, hi]) => {
      const a = l[lo], b = l[hi];
      if (localDay_(a.t) < from) return;
      if ((geo[v.key] || []).some(t => t >= a.t - GAUGE_FILL_NEAR && t <= b.t + GAUGE_FILL_NEAR)) return;   // plein Geotab : c'est lui qui compte
      rows.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(a.t) + '|PLEIN_JAUGE', 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(a.t)),
        'Type': 'PLEIN', 'Arrêt début': new Date(a.t), 'Arrêt fin': new Date(b.t), 'Moteur': '', 'Niveau avant (%)': r1_(a.p), 'Niveau après (%)': r1_(b.p),
        'Écart (%)': r1_(b.p - a.p), 'Litres (jauge)': '', 'Litres Geotab': '', 'Source': 'Jauge (en attente du FillUp Geotab)', 'Lat': '', 'Lon': '', 'Statut': 'Info' }));
    });
  });
  if (rows.length) attribRows_('FUEL', rows, attribCtx_());
  const F = ['stop_start', 'lvl_before', 'lvl_after', 'driver_code'], sig = o => F.map(c => o[c] == null ? '' : c === 'stop_start' ? new Date(o[c]).getTime() : String(+o[c] === +o[c] ? +o[c] : o[c])).join('|');
  const objs = rows.map(r => toDb_('FUEL', r, false)), keep = {};
  const fin = doneVehDays_(addDays_(from, -1)), fresh = [], done = [];
  objs.forEach(o => { keep[o.id] = 1; if (old[o.id] && sig(old[o.id]) === sig(o)) return; (fin[o.vehicle_key + '|' + o.vday] ? done : fresh).push(o); });
  const gone = Object.keys(old).filter(id => !keep[id]);
  // retirées : plein Geotab publié entre-temps (ou montée qui n'en est plus une) ; lots d'identifiants tenus sous ~1,5 Ko d'URL
  const lots = [[]];
  gone.forEach(id => { const x = lots[lots.length - 1]; if (x.length && inList_(x.concat(id)).length > 1500) lots.push([id]); else x.push(id); });
  lots.forEach(x => { if (x.length) dbDelete_('fuel', 'id=' + inList_(x)); });
  if (fresh.length) dbRpc_('put_rows', { p_table: 'fuel', p_keys: [], p_rows: fresh, p_final: false });
  // journée déjà finalisée : ligne finalisée (put_rows provisoire n'écrit jamais dans une journée finalisée) ; statut saisi sur le site gardé
  if (done.length) {
    done.forEach(o => { o.final = true; if (old[o.id]) delete o.status; });
    // PostgREST : mêmes colonnes dans tout un lot (nouvelles lignes avec statut, lignes existantes sans)
    [done.filter(o => !old[o.id]), done.filter(o => old[o.id])].forEach(x => { if (x.length) dbUpsert_('fuel', x, 'id'); });
  }
  return fresh.length + done.length + gone.length;
}
