// Rapport de flotte (période, agence) : mêmes calculs sur le site (PDF téléchargé) et dans le collecteur (PDF envoyé par e-mail).
// Données mesurées uniquement : « non mesuré » quand Geotab ne fournit pas la valeur. Aucun nom global commun avec le site ou le collecteur (préfixe rpt).
var RPT_SEV = ['Critique', 'Haute', 'Moyenne', 'Info'];
var RPT_NM = 'non mesuré';
var RPT_FREQ = { jour: 'quotidien', semaine: 'hebdomadaire', mois: 'mensuel' };
function rptNum(v) { var n = typeof v === 'number' ? v : parseFloat(String(v === null || v === undefined ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; }
function rptFmt(v, d) {
  if (v === null || v === undefined || v === '' || !isFinite(v)) return '';
  var s = Number(v).toFixed(d || 0).split('.'), i = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return d ? i + ',' + s[1] : i;
}
function rptH(h) { if (h === null || h === undefined || h === '') return ''; var m = Math.round(rptNum(h) * 60); return Math.floor(m / 60) + 'h' + ('0' + (m % 60)).slice(-2); }
function rptDay(d) { if (!d) return ''; var p = String(d).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function rptEsc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/** Cumul de lignes du journal (journées de travail) */
function rptAgg(rows, minKm) {
  var a = { km: 0, drive: 0, idle: 0, idleLong: 0, fuel: 0, fuelKm: 0, fuelN: 0, cost: 0, costN: 0, evts: 0, pts: 0, siph: 0, siphL: 0, kmHors: 0, vmax: 0, trips: 0, days: {}, ctr: {}, names: {}, l100: null };
  rows.forEach(function (r) {
    a.km += rptNum(r.km); a.drive += rptNum(r.drive_h); a.idle += rptNum(r.idle_h); a.idleLong += rptNum(r.long_idle_h); a.trips += rptNum(r.n_trips);
    if (r.fuel_l !== null && r.fuel_l !== undefined) { a.fuel += rptNum(r.fuel_l); a.fuelKm += rptNum(r.fuel_km); a.fuelN++; }
    if (r.fuel_cost !== null && r.fuel_cost !== undefined) { a.cost += rptNum(r.fuel_cost); a.costN++; }
    a.evts += rptNum(r.n_events); a.pts += rptNum(r.danger_pts); a.siph += rptNum(r.n_siphon); a.siphL += rptNum(r.siphon_l); a.kmHors += rptNum(r.km_off_contract);
    if (rptNum(r.vmax) > a.vmax) a.vmax = rptNum(r.vmax);
    a.days[r.day] = 1; if (r.contract_num) a.ctr[r.contract_num] = 1; if (r.driver_name) a.names[r.driver_name] = 1;
  });
  a.l100 = a.fuelKm >= (minKm || 30) ? a.fuel / a.fuelKm * 100 : null;
  return a;
}
/** Shift d'un contrat d'après l'heure de début 'hh:mm' (heure du Maroc) : le début de shift le plus proche (jour shiftDay h, nuit shiftNight h) */
function rptShiftH(P, k, def) { return P && P[k] !== undefined && P[k] !== null && P[k] !== '' ? rptNum(P[k]) : def; }
function rptShift(hm, P) {
  if (!hm) return '';
  var h = rptNum(String(hm).slice(0, 2)) + rptNum(String(hm).slice(3, 5)) / 60, d = rptShiftH(P, 'shiftDay', 7), n = rptShiftH(P, 'shiftNight', 19);
  var dist = function (a, b) { var x = Math.abs(a - b) % 24; return Math.min(x, 24 - x); };
  return dist(h, d) <= dist(h, n) ? 'Jour' : 'Nuit';
}
var RPT_SHIFTS = ['Jour', 'Nuit', ''];
function rptShiftName(s, P) {
  var z = function (h) { return ('0' + h).slice(-2) + ':00'; }, d = rptShiftH(P, 'shiftDay', 7), n = rptShiftH(P, 'shiftNight', 19);
  return s === 'Jour' ? 'Shift jour (' + z(d) + ' → ' + z(n) + ')' : s === 'Nuit' ? 'Shift nuit (' + z(n) + ' → ' + z(d) + ')' : 'Hors contrat';
}
/** Un tableau par shift (jour, nuit, hors contrat) ; t.rowsOf(shift) donne les lignes du shift */
function rptSplit(t, P, shifts) {  // t.none : titre des lignes sans shift (défaut « Hors contrat »)
  var out = [];
  shifts.forEach(function (s) { var rows = t.rowsOf(s); if (rows.length) out.push({ title: t.title + ' : ' + (s === '' && t.none ? t.none : rptShiftName(s, P)), empty: '', head: t.head, num: t.num, rows: rows }); });
  return out.length ? out : [{ title: t.title, empty: t.empty, head: t.head, num: t.num, rows: [] }];
}
function rptLevel(score, P) { return score >= P.scoreR ? 'Dangereux' : score >= P.scoreO ? 'Élevé' : score >= P.scoreY ? 'Modéré' : 'Faible'; }

/**
 * o = { journal, alerts, vehicles: [{key, plate, model, active}], drivers: {code: nom}, P: {minFuelKm, kmMin, scoreY, scoreO, scoreR},
 *       from, to, agency (nom ou ''), frequency (jour / semaine / mois, facultatif), generatedAt (Date) }
 */
function rptBuild(o) {
  var P = o.P || {}, minKm = rptNum(P.minFuelKm) || 30, kmMin = rptNum(P.kmMin) || 20, keys = {}, HORS = 'HORS_CONTRAT';
  (o.vehicles || []).forEach(function (v) { keys[v.key] = v; });
  var jrn = (o.journal || []).filter(function (r) { return keys[r.vehicle_key]; });
  var al = (o.alerts || []).filter(function (a) { return keys[a.vehicle_key]; });
  var t = rptAgg(jrn, minKm), byV = {}, byD = {};
  // shift du chauffeur = heure de début du contrat (o.hmOf : heure du Maroc) ; un chauffeur qui a fait les deux shifts apparaît dans chacun
  var shOf = function (r) { return o.hmOf && r.contract_num && r.contract_start ? rptShift(o.hmOf(new Date(r.contract_start).getTime()), P) : ''; };
  jrn.forEach(function (r) { (byV[r.vehicle_key] = byV[r.vehicle_key] || []).push(r); if (r.driver_code && r.driver_code !== HORS) { var k = shOf(r) + '|' + r.driver_code; (byD[k] = byD[k] || []).push(r); } });
  var alV = {}, sev = {}; RPT_SEV.forEach(function (s) { sev[s] = 0; });
  al.forEach(function (a) { alV[a.vehicle_key] = (alV[a.vehicle_key] || 0) + 1; sev[a.severity] = (sev[a.severity] || 0) + 1; });
  var drivers = Object.keys(byD).map(function (k) {
    var a = rptAgg(byD[k], minKm), score = a.pts / Math.max(a.km, kmMin) * 100, code = k.slice(k.indexOf('|') + 1);
    return { code: code, shift: k.slice(0, k.indexOf('|')), name: (o.drivers || {})[code] || Object.keys(a.names)[0] || code, days: Object.keys(a.ctr).length || Object.keys(a.days).length,
      km: a.km, drive: a.drive, idle: a.idle, evts: a.evts, score: score, level: rptLevel(score, P), siph: a.siph };
  }).sort(function (x, y) { return y.score - x.score || x.name.localeCompare(y.name); });
  var vehicles = Object.keys(keys).map(function (k) { return keys[k]; }).filter(function (v) { return v.active !== 'NON' || byV[v.key]; }).map(function (v) {
    var a = rptAgg(byV[v.key] || [], minKm);
    return { plate: v.plate, model: v.model || '', days: Object.keys(a.days).length, contracts: Object.keys(a.ctr).length, km: a.km, drive: a.drive, idle: a.idle,
      fuel: a.fuelN ? a.fuel : null, l100: a.l100, l100Txt: a.l100 !== null ? rptFmt(a.l100, 1) : (a.fuelN ? 'km insuffisants' : RPT_NM),
      evts: a.evts, alerts: alV[v.key] || 0, siph: a.siph, kmHors: a.kmHors };
  }).sort(function (x, y) { return y.km - x.km || String(x.plate).localeCompare(String(y.plate)); });
  var rank = { Critique: 0, Haute: 1, Moyenne: 2, Info: 3 };
  var top = al.filter(function (a) { return rank[a.severity] <= 1; })
    .sort(function (x, y) { return rank[x.severity] - rank[y.severity] || (String(y.day) + (y.time || '')).localeCompare(String(x.day) + (x.time || '')); }).slice(0, 60);
  var period = o.from === o.to ? 'du ' + rptDay(o.from) : 'du ' + rptDay(o.from) + ' au ' + rptDay(o.to);
  return {
    title: 'Rapport ' + (o.frequency ? RPT_FREQ[o.frequency] + ' ' : '') + 'de la flotte', period: period, from: o.from, to: o.to, agency: o.agency || 'Toutes les agences',
    generatedAt: o.generatedAt || new Date(), nVeh: vehicles.length,
    summary: [
      ['Véhicules en activité', rptFmt(Object.keys(byV).length) + ' / ' + rptFmt(vehicles.length)],
      ['Journées de travail (contrats)', rptFmt(Object.keys(t.ctr).length)],
      ['Km parcourus', rptFmt(t.km)],
      ['Heures de conduite', rptH(t.drive)],
      ['Heures de ralenti', rptH(t.idle) + (t.idleLong ? ' (dont prolongé ' + rptH(t.idleLong) + ')' : '')],
      ['Carburant mesuré (L)', t.fuelN ? rptFmt(t.fuel, 1) : RPT_NM],
      ['Conso moyenne (L/100 km)', t.l100 !== null ? rptFmt(t.l100, 1) : (t.fuelN ? 'km insuffisants' : RPT_NM)],
      ['Coût carburant (MAD)', t.costN ? rptFmt(t.cost) : 'prix non saisi'],
      ['Événements de conduite', rptFmt(t.evts)],
      ['Vitesse max (km/h)', rptFmt(t.vmax)],
      ['Siphonages suspects', rptFmt(t.siph) + (t.siph ? ' (' + rptFmt(t.siphL, 1) + ' L)' : '')],
      ['Km hors contrat', rptFmt(t.kmHors, 1)],
      ['Alertes', RPT_SEV.map(function (s) { return s + ' ' + sev[s]; }).join(' · ')]
    ],
    alertCounts: sev, nAlerts: al.length, drivers: drivers, vehicles: vehicles, topAlerts: top, shifts: !!o.hmOf, P: P
  };
}

/** Prix du litre selon le carburant du véhicule (gasoil / essence) ; 0 = prix non saisi */
function rptPrice(v, P) { var d = /GO|GAS ?OIL|GASOIL|DIESEL|GAZOIL/.test(String((v && v.fuel) || '').toUpperCase()); return rptNum(d ? P.priceDiesel : P.priceGas); }
function rptDT(t, dayOf, hmOf) { return t ? rptDay(dayOf(t)) + ' ' + hmOf(t) : ''; }
/**
 * Rapport de consommation entre deux instants (règles du Sheet v6 « Carburant consommé entre deux dates ») :
 * un trajet compte s'il démarre dans [a, z[ ; litres = compteur carburant du véhicule trajet par trajet, jamais estimés.
 * o = { trips, fuel, stops (null = arrêts moteur non disponibles), vehicles, P, a, z (ms), agency, missing: [{plate, day}],
 *       dayOf(ms) -> 'aaaa-mm-jj', hmOf(ms) -> 'hh:mm' (heure du Maroc), generatedAt }
 */
function rptConso(o) {
  var P = o.P || {}, minKm = rptNum(P.minFuelKm) || 30, keys = {}, HORS = 'HORS_CONTRAT', a = o.a, z = o.z;
  (o.vehicles || []).forEach(function (v) { keys[v.key] = v; });
  var inP = function (t) { t = new Date(t).getTime(); return t >= a && t < z; };
  var mk = function () { return { trips: 0, km: 0, drive: 0, fuel: 0, fuelKm: 0, fuelN: 0, noFuelKm: 0, cost: 0, costN: 0, idleMin: 0, idleL: 0, idleN: 0,
    stops: 0, stopMin: 0, stopL: 0, stopLN: 0, pleins: 0, pleinsL: 0, siph: 0, siphL: 0 }; };
  var tot = mk(), byV = {}, byD = {}, byDay = {}, names = {};
  var trips = (o.trips || []).filter(function (r) { return keys[r.vehicle_key] && inP(r.start_at); });
  // chauffeur par shift : o.ctrShift(n° de contrat) -> 'Jour' / 'Nuit' (début du contrat) ; hors contrat : ''
  var dkOf = function (r) { var code = r.driver_code || HORS; return (code !== HORS && o.ctrShift ? o.ctrShift(r.contract_num) || '' : '') + '|' + code; };
  trips.forEach(function (r) {
    var v = keys[r.vehicle_key], code = r.driver_code || HORS, km = rptNum(r.km), pr = rptPrice(v, P), day = o.dayOf(new Date(r.start_at).getTime()), dk = dkOf(r);
    if (code !== HORS && r.driver_name) names[code] = r.driver_name;
    [tot, byV[r.vehicle_key] = byV[r.vehicle_key] || mk(), byD[dk] = byD[dk] || mk(), byDay[day] = byDay[day] || mk()].forEach(function (x) {
      x.trips++; x.km += km; x.drive += rptNum(r.drive_min) / 60; x.idleMin += rptNum(r.idle_min);
      if (r.fuel_l !== null && r.fuel_l !== undefined && r.fuel_l !== '') { x.fuel += rptNum(r.fuel_l); x.fuelKm += km; x.fuelN++; if (pr) { x.cost += rptNum(r.fuel_l) * pr; x.costN++; } }
      else x.noFuelKm += km;
      if (r.idle_fuel_l !== null && r.idle_fuel_l !== undefined && r.idle_fuel_l !== '') { x.idleL += rptNum(r.idle_fuel_l); x.idleN++; }
    });
  });
  (o.stops || []).forEach(function (s) {
    if (!keys[s.vehicle_key] || !inP(s.start_at)) return;
    var dk = dkOf(s);
    [tot, byV[s.vehicle_key] = byV[s.vehicle_key] || mk(), byD[dk] = byD[dk] || mk()].forEach(function (x) {
      x.stops++; x.stopMin += rptNum(s.dur_min); if (s.liters !== null && s.liters !== undefined) { x.stopL += rptNum(s.liters); x.stopLN++; } });
  });
  var fills = [], siph = [], tne = [];
  (o.fuel || []).forEach(function (f) {
    if (!keys[f.vehicle_key] || !inP(f.stop_start)) return;
    var x = byV[f.vehicle_key] = byV[f.vehicle_key] || mk();
    if (f.type === 'PLEIN') { fills.push(f); [tot, x].forEach(function (y) { y.pleins++; y.pleinsL += rptNum(f.liters_gauge); }); }
    else if (f.type === 'SIPHONAGE_SUSPECT' && f.status !== 'Faux positif') { siph.push(f); [tot, x].forEach(function (y) { y.siph++; y.siphL += Math.abs(rptNum(f.liters_gauge)); }); }
    else if (f.type === 'TRAJET_NON_ENREGISTRE') tne.push(f);
  });
  var l100 = function (x) { return x.fuelKm >= minKm ? rptFmt(x.fuel / x.fuelKm * 100, 1) : (x.fuelN ? 'km insuffisants' : RPT_NM); };
  var liters = function (x) { return x.fuelN ? rptFmt(x.fuel, 1) : RPT_NM; };
  var cov = function (x) { return x.trips ? Math.round(x.fuelN / x.trips * 100) + ' %' : '-'; };
  var cost = function (x) { return x.costN ? rptFmt(x.cost) + (x.costN < x.fuelN ? ' (partiel : prix non saisi pour une partie)' : '') : (x.fuelN ? 'prix non saisi' : ''); };
  var stopTxt = function (x) { return x.stops ? rptFmt(x.stops) + ' (' + rptH(x.stopMin / 60) + ')' : '0'; };
  var stopL = function (x) { return x.stopLN ? rptFmt(x.stopL, 1) + ' (' + x.stopLN + '/' + x.stops + ' mesurés)' : (x.stops ? RPT_NM : ''); };
  var kc = function (k) { return k.slice(k.indexOf('|') + 1); };
  var drvName = function (c) { return c === HORS ? 'Hors contrat' : ((o.drivers || {})[c] || names[c] || c); };
  var fdt = function (t) { return rptDT(new Date(t).getTime(), o.dayOf, o.hmOf); };
  var vlist = Object.keys(keys).filter(function (k) { return byV[k] || keys[k].active !== 'NON'; }).sort(function (x, y) { return ((byV[y] || {}).fuel || 0) - ((byV[x] || {}).fuel || 0) || String(keys[x].plate).localeCompare(String(keys[y].plate)); });
  var tables = [
    { title: 'Par véhicule', empty: 'Aucun véhicule',
      head: ['Plaque', 'Modèle', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Coût (MAD)', 'Ralenti', 'Litres au ralenti', 'Arrêts moteur tournant', 'Litres à l\'arrêt', 'Pleins', 'Litres pleins (jauge)', 'Siphonages suspects', 'Trajets mesurés'],
      num: [2, 3, 4, 5, 6, 7, 8, 11, 12, 13],
      rows: vlist.map(function (k) { var x = byV[k] || mk(), v = keys[k];
        return [v.plate, v.model || '', rptFmt(x.trips), rptFmt(x.km, 1), liters(x), l100(x), cost(x), rptH(x.idleMin / 60), x.idleN ? rptFmt(x.idleL, 1) : (x.trips ? RPT_NM : ''),
          stopTxt(x), stopL(x), rptFmt(x.pleins), rptFmt(x.pleinsL, 1), x.siph ? rptFmt(x.siph) + ' (' + rptFmt(x.siphL, 1) + ' L)' : '0', cov(x)]; }) },
  ].concat(rptSplit({ title: 'Par chauffeur', empty: 'Aucun trajet sur la période',
      head: ['Chauffeur', 'Code', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Coût (MAD)', 'Ralenti', 'Litres au ralenti', 'Arrêts moteur tournant', 'Litres à l\'arrêt', 'Trajets mesurés'],
      num: [2, 3, 4, 5, 6, 7, 8],
      rowsOf: function (sh) { return Object.keys(byD).filter(function (k) { return byD[k].trips && k.slice(0, k.indexOf('|')) === sh; }).sort(function (x, y) { return byD[y].fuel - byD[x].fuel || drvName(kc(x)).localeCompare(drvName(kc(y))); })
        .map(function (k) { var x = byD[k], c = kc(k); return [drvName(c), c === HORS ? '' : c, rptFmt(x.trips), rptFmt(x.km, 1), liters(x), l100(x), cost(x), rptH(x.idleMin / 60), x.idleN ? rptFmt(x.idleL, 1) : RPT_NM, stopTxt(x), stopL(x), cov(x)]; }); } }, P, RPT_SHIFTS)).concat([
    { title: 'Par jour', empty: 'Aucun trajet sur la période',
      head: ['Jour', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Coût (MAD)', 'Litres au ralenti', 'Trajets mesurés'], num: [1, 2, 3, 4, 5, 6],
      rows: Object.keys(byDay).sort().map(function (d) { var x = byDay[d]; return [rptDay(d), rptFmt(x.trips), rptFmt(x.km, 1), liters(x), l100(x), cost(x), x.idleN ? rptFmt(x.idleL, 1) : RPT_NM, cov(x)]; }) },
    { title: 'Pleins détectés par Geotab (à pointer avec les tickets)', empty: 'Aucun plein sur la période',
      head: ['Date / heure', 'Plaque', 'Chauffeur', 'Jauge avant (%)', 'Jauge après (%)', 'Litres (jauge)', 'Estimation Geotab (L)'], num: [3, 4, 5, 6],
      rows: fills.sort(function (x, y) { return new Date(x.stop_start) - new Date(y.stop_start); }).map(function (f) {
        return [fdt(f.stop_start), keys[f.vehicle_key].plate, f.driver_name || '', rptFmt(f.lvl_before), rptFmt(f.lvl_after), rptFmt(f.liters_gauge, 1), f.liters_geotab === null || f.liters_geotab === undefined ? '' : rptFmt(f.liters_geotab, 1)]; }) },
    { title: 'Siphonages suspects (baisse de jauge moteur coupé, sans trajet)', empty: 'Aucun siphonage suspect',
      head: ['Arrêt', 'Redémarrage', 'Plaque', 'Chauffeur à l\'arrêt', 'Jauge avant → après (%)', 'Litres (jauge)', 'Statut'], num: [5],
      rows: siph.sort(function (x, y) { return new Date(x.stop_start) - new Date(y.stop_start); }).map(function (f) {
        return [fdt(f.stop_start), fdt(f.stop_end), keys[f.vehicle_key].plate, f.driver_name || '', rptFmt(f.lvl_before) + ' → ' + rptFmt(f.lvl_after), rptFmt(Math.abs(rptNum(f.liters_gauge)), 1), f.status || '']; }) }
  ]);
  if (tne.length) tables.push({ title: 'Trajets non enregistrés (boîtier coupé, compteur km du véhicule avancé)', empty: '', head: ['De', 'À', 'Plaque', 'Chauffeur', 'Km non enregistrés'], num: [4],
    rows: tne.map(function (f) { return [fdt(f.stop_start), fdt(f.stop_end), keys[f.vehicle_key].plate, f.driver_name || '', String(f.engine || '').split(' ')[0]]; }) });
  if ((o.missing || []).length) tables.push({ title: 'Journées pas encore téléchargées depuis Geotab : totaux incomplets', empty: '', head: ['Plaque', 'Jour'], num: [],
    rows: o.missing.map(function (m) { return [m.plate, rptDay(m.day)]; }) });
  var period = 'du ' + fdt(a) + ' au ' + fdt(z);
  return {
    kind: 'conso', title: 'Rapport de consommation', period: period, from: o.dayOf(a), to: o.dayOf(z - 1), agency: o.agency || 'Toutes les agences',
    generatedAt: o.generatedAt || new Date(), totals: tot,
    summary: [
      ['Véhicules', rptFmt(Object.keys(byV).filter(function (k) { return byV[k].trips; }).length) + ' en activité sur ' + rptFmt(vlist.length)],
      ['Trajets', rptFmt(tot.trips) + ' (' + cov(tot) + ' avec litres mesurés)'],
      ['Km parcourus', rptFmt(tot.km, 1)],
      ['Carburant consommé (L)', liters(tot)],
      ['Consommation (L/100 km)', l100(tot)],
      ['Coût carburant (MAD)', cost(tot) || 'prix non saisi'],
      ['Ralenti (moteur allumé, véhicule immobile)', rptH(tot.idleMin / 60) + ' · ' + (tot.idleN ? rptFmt(tot.idleL, 1) + ' L' : RPT_NM)],
      ['Arrêts moteur tournant (' + rptFmt(rptNum(P.engStopMin) || 3) + ' min et plus)', o.stops ? stopTxt(tot) + (tot.stops ? ' · ' + stopL(tot) + ' L' : '') : 'non disponible'],
      ['Pleins détectés', rptFmt(tot.pleins) + (tot.pleins ? ' (' + rptFmt(tot.pleinsL, 1) + ' L jauge)' : '')],
      ['Siphonages suspects', rptFmt(tot.siph) + (tot.siph ? ' (' + rptFmt(tot.siphL, 1) + ' L)' : '')],
      ['Non mesuré', tot.noFuelKm ? rptFmt(tot.trips - tot.fuelN) + ' trajets, ' + rptFmt(tot.noFuelKm, 1) + ' km sans litres' : 'tous les trajets ont leurs litres'],
      ['Données', (o.missing || []).length ? o.missing.length + ' véhicule-jours pas encore téléchargés : totaux incomplets' : 'complètes']
    ],
    tables: tables
  };
}

/**
 * Comportement d'un chauffeur entre deux jours (heure du Maroc) : profil, conduite (vitesse, événements, score),
 * consommation, pleins, siphonages, ralenti, arrêts moteur tournant, alertes. Toutes les valeurs viennent des tables
 * calculées depuis Geotab ; rien n'est estimé.
 * o = { driver: {code, name, phone, email, agency}, journal, trips, events, fuel, stops (null = non disponible), idles, alerts,
 *       rules: {id: {name, weight, category}}, P, from, to, rankJournal (journal de tous les chauffeurs visibles, pour le rang),
 *       dayOf(ms), hmOf(ms), generatedAt }
 */
function rptDriver(o) {
  var P = o.P || {}, d = o.driver || {}, code = d.code, minKm = rptNum(P.minFuelKm) || 30, kmMin = rptNum(P.kmMin) || 20, over = rptNum(P.overAlert) || 30, vAl = rptNum(P.vmaxAlert) || 130;
  var inDay = function (x) { return x && String(x).slice(0, 10) >= o.from && String(x).slice(0, 10) <= o.to; };
  var jrn = (o.journal || []).filter(function (r) { return r.driver_code === code && inDay(r.day); }).sort(function (x, y) { return String(x.contract_start || x.day).localeCompare(String(y.contract_start || y.day)); });
  var trips = (o.trips || []).filter(function (r) { return r.driver_code === code && inDay(r.day); });
  var evts = (o.events || []).filter(function (e) { return e.driver_code === code && inDay(e.day); });
  var rules = o.rules || {}, rl = function (id) { return rules[id] || { name: id, weight: 0, category: '' }; };
  var a = rptAgg(jrn, minKm), score = a.pts / Math.max(a.km, kmMin) * 100;
  var dt = function (t) { return t ? rptDT(new Date(t).getTime(), o.dayOf, o.hmOf) : ''; };
  var shiftOf = function (r) { return r.contract_num && r.contract_start && o.hmOf ? rptShift(o.hmOf(new Date(r.contract_start).getTime()), P) : ''; };
  // rang : même score que le Classement (points de danger / 100 km), chauffeurs avec au moins kmMin km
  var rank = null;
  if (o.rankJournal) {
    var by = {}; o.rankJournal.forEach(function (r) { if (!r.driver_code || r.driver_code === 'HORS_CONTRAT' || !inDay(r.day)) return; var x = by[r.driver_code] = by[r.driver_code] || { km: 0, pts: 0 }; x.km += rptNum(r.km); x.pts += rptNum(r.danger_pts); });
    var list = Object.keys(by).filter(function (c) { return by[c].km >= kmMin; }).map(function (c) { return { c: c, s: by[c].pts / Math.max(by[c].km, kmMin) * 100 }; }).sort(function (x, y) { return y.s - x.s; });
    var pos = list.map(function (x) { return x.c; }).indexOf(code); rank = pos >= 0 ? { pos: pos + 1, n: list.length } : { pos: null, n: list.length };
  }
  // vitesse
  var vmaxT = null, worstT = null, nOver = 0, nVal = 0;
  trips.forEach(function (t) { if (rptNum(t.vmax) > (vmaxT ? rptNum(vmaxT.vmax) : 0)) vmaxT = t; if (t.worst_over !== null && t.worst_over !== undefined && t.worst_over !== '') {
    if (!worstT || rptNum(t.worst_over) > rptNum(worstT.worst_over)) worstT = t; if (rptNum(t.worst_over) >= over) nOver++; } if (rptNum(t.vmax) >= vAl) nVal++; });
  var speed = trips.filter(function (t) { return rptNum(t.worst_over) >= 10 || rptNum(t.vmax) >= vAl; }).sort(function (x, y) { return new Date(x.start_at) - new Date(y.start_at); });
  // événements par règle
  var byR = {}; evts.forEach(function (e) { var r = rl(e.rule_id), x = byR[e.rule_id] = byR[e.rule_id] || { n: r.name || e.rule_name || e.rule_id, cat: r.category || '', w: rptNum(r.weight), c: 0, s: 0 }; x.c++; x.s += rptNum(e.dur_s); });
  var rList = Object.keys(byR).map(function (k) { return byR[k]; }).sort(function (x, y) { return y.c * y.w - x.c * x.w || y.c - x.c; });
  // consommation par véhicule (trajets)
  var cv = {}; trips.forEach(function (t) { var x = cv[t.vehicle_key] = cv[t.vehicle_key] || { plate: t.plate || t.vehicle_key, n: 0, km: 0, l: 0, lkm: 0, ln: 0, il: 0, iln: 0 };
    x.n++; x.km += rptNum(t.km); if (t.fuel_l !== null && t.fuel_l !== undefined && t.fuel_l !== '') { x.l += rptNum(t.fuel_l); x.lkm += rptNum(t.km); x.ln++; }
    if (t.idle_fuel_l !== null && t.idle_fuel_l !== undefined && t.idle_fuel_l !== '') { x.il += rptNum(t.idle_fuel_l); x.iln++; } });
  var fuel = (o.fuel || []).filter(function (f) { return inDay(f.day); });
  var fills = fuel.filter(function (f) { return f.type === 'PLEIN' && f.driver_code === code; }).sort(function (x, y) { return new Date(x.stop_start) - new Date(y.stop_start); });
  var siph = fuel.filter(function (f) { return f.type === 'SIPHONAGE_SUSPECT' && f.status !== 'Faux positif' && (f.driver_code === code || (d.name && f.next_driver === d.name)); });
  var stops = o.stops ? o.stops.filter(function (s) { return s.driver_code === code && inDay(s.day); }).sort(function (x, y) { return new Date(x.start_at) - new Date(y.start_at); }) : null;
  var idles = (o.idles || []).filter(function (s) { return s.driver_code === code && inDay(s.day); }).sort(function (x, y) { return new Date(x.start_at) - new Date(y.start_at); });
  var al = (o.alerts || []).filter(function (x) { return x.driver_code === code && inDay(x.day) && x.status !== 'Faux positif'; }).sort(function (x, y) { return (String(x.day) + (x.time || '')).localeCompare(String(y.day) + (y.time || '')); });
  var sev = {}; RPT_SEV.forEach(function (k) { sev[k] = 0; }); al.forEach(function (x) { sev[x.severity] = (sev[x.severity] || 0) + 1; });
  var stL = stops ? stops.filter(function (s) { return s.liters !== null && s.liters !== undefined; }) : [];
  var plates = {}; jrn.forEach(function (r) { if (r.plate) plates[r.plate] = 1; });
  var period = o.from === o.to ? 'du ' + rptDay(o.from) : 'du ' + rptDay(o.from) + ' au ' + rptDay(o.to);
  var nm = function (v, k) { return v === null || v === undefined || v === '' ? RPT_NM : rptFmt(v, k); };
  var tables = [
    { title: 'Journées de travail (horaires du contrat)', empty: 'Aucune journée de travail sur la période',
      head: ['Date', 'Shift', 'Contrat', 'Véhicule', 'Début', 'Fin', 'Km', 'Conduite', 'Ralenti', 'Carburant (L)', 'L/100 km', 'Vmax', 'Pire dépassement', 'Événements', 'Score'], num: [6, 7, 8, 9, 10, 11, 12, 13, 14],
      rows: jrn.map(function (r) { var sh = shiftOf(r); return [rptDay(r.day), sh ? (sh === 'Jour' ? 'Jour' : 'Nuit') : '', r.contract_num || 'Hors contrat', r.plate || '', dt(r.contract_start), r.contract_end ? dt(r.contract_end) : (r.contract_num ? 'en cours' : ''),
        rptFmt(r.km, 1), rptH(r.drive_h), rptH(r.idle_h), nm(r.fuel_l, 1), r.l100 === null || r.l100 === undefined || r.l100 === '' ? '' : rptFmt(r.l100, 1), rptFmt(r.vmax),
        r.worst_over === null || r.worst_over === undefined || r.worst_over === '' ? '' : '+' + rptFmt(r.worst_over), rptFmt(r.n_events), rptFmt(r.score, 1)]; }) },
    { title: 'Vitesse : dépassements de 10 km/h et plus, ou Vmax ≥ ' + vAl + ' km/h', empty: 'Aucun dépassement relevé (ou limites de route non fournies par Geotab)',
      head: ['Trajet du', 'Véhicule', 'Km', 'Vmax', 'Limite à Vmax', 'Vitesse / limite au pire', 'Dépassement', 'Heure du pire'], num: [2, 3, 4, 6],
      rows: speed.map(function (t) { return [dt(t.start_at), t.plate || '', rptFmt(t.km, 1), rptFmt(t.vmax), t.lim_at_vmax === null || t.lim_at_vmax === undefined ? '' : rptFmt(t.lim_at_vmax),
        (t.speed_at_worst === null || t.speed_at_worst === undefined ? '' : rptFmt(t.speed_at_worst)) + ' / ' + (t.lim_at_worst === null || t.lim_at_worst === undefined ? '' : rptFmt(t.lim_at_worst)),
        t.worst_over === null || t.worst_over === undefined || t.worst_over === '' ? '' : '+' + rptFmt(t.worst_over), t.worst_time || '']; }) },
    { title: 'Événements de conduite Geotab par règle', empty: 'Aucun événement de conduite',
      head: ['Règle', 'Catégorie', 'Nombre', 'Poids', 'Points', 'Durée cumulée'], num: [2, 3, 4, 5],
      rows: rList.map(function (x) { return [x.n, x.cat, rptFmt(x.c), rptFmt(x.w, 1), rptFmt(x.c * x.w, 1), rptH(x.s / 3600)]; }) },
    { title: 'Détail des événements de conduite' + (evts.length > 300 ? ' (300 plus récents)' : ''), empty: 'Aucun événement de conduite',
      head: ['Date / heure', 'Véhicule', 'Règle', 'Durée (s)', 'Distance (km)'], num: [3, 4],
      rows: evts.slice().sort(function (x, y) { return new Date(y.start_at) - new Date(x.start_at); }).slice(0, 300).map(function (e) { return [dt(e.start_at), e.plate || '', rl(e.rule_id).name || e.rule_name || e.rule_id, rptFmt(e.dur_s), e.km === null || e.km === undefined ? '' : rptFmt(e.km, 2)]; }) },
    { title: 'Consommation par véhicule (trajets)', empty: 'Aucun trajet sur la période',
      head: ['Véhicule', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Litres au ralenti', 'Trajets mesurés'], num: [1, 2, 3, 4, 5],
      rows: Object.keys(cv).map(function (k) { var x = cv[k]; return [x.plate, rptFmt(x.n), rptFmt(x.km, 1), x.ln ? rptFmt(x.l, 1) : RPT_NM, x.lkm >= minKm ? rptFmt(x.l / x.lkm * 100, 1) : (x.ln ? 'km insuffisants' : RPT_NM),
        x.iln ? rptFmt(x.il, 1) : RPT_NM, Math.round(x.ln / x.n * 100) + ' %']; }) },
    { title: 'Pleins détectés par Geotab pendant ses contrats', empty: 'Aucun plein détecté',
      head: ['Date / heure', 'Véhicule', 'Jauge avant → après (%)', 'Litres (jauge)', 'Litres Geotab'], num: [3, 4],
      rows: fills.map(function (f) { return [dt(f.stop_start), f.plate || '', rptFmt(f.lvl_before) + ' → ' + rptFmt(f.lvl_after), nm(f.liters_gauge, 1), nm(f.liters_geotab, 1)]; }) }
  ];
  if (siph.length) tables.push({ title: 'Siphonages suspects (baisse de jauge moteur coupé, sans trajet)', empty: '', head: ['Arrêt', 'Redémarrage', 'Véhicule', 'Jauge avant → après (%)', 'Litres (jauge)', 'Rôle', 'Statut'], num: [4],
    rows: siph.map(function (f) { return [dt(f.stop_start), dt(f.stop_end), f.plate || '', rptFmt(f.lvl_before) + ' → ' + rptFmt(f.lvl_after), rptFmt(Math.abs(rptNum(f.liters_gauge)), 1), f.driver_code === code ? 'Véhicule garé par lui' : 'Redémarré par lui', f.status || '']; }) });
  tables.push({ title: 'Ralenti prolongé (' + (rptNum(P.idleLongMin) || 10) + ' min et plus)', empty: 'Aucun ralenti prolongé',
    head: ['Début', 'Véhicule', 'Durée (min)', 'Moteur tournant (min)', 'Litres'], num: [2, 3, 4],
    rows: idles.map(function (s) { return [dt(s.start_at), s.plate || '', rptFmt(s.stop_min), s.engine_check === 'Régime moteur' ? rptFmt(s.engine_min) : 'non vérifiable', nm(s.liters, 1)]; }) });
  if (stops) tables.push({ title: 'Arrêts moteur tournant (' + (rptNum(P.engStopMin) || 3) + ' min et plus)', empty: 'Aucun arrêt moteur tournant',
    head: ['Début', 'Véhicule', 'Durée (min)', 'Litres de l\'arrêt', 'Ceinture conducteur (bouclée / débouclée, min)'], num: [2, 3],
    rows: stops.map(function (s) { return [dt(s.start_at), s.plate || '', rptFmt(s.dur_min, 1), nm(s.liters, 2),
      s.belt_on_min === null && s.belt_off_min === null || s.belt_on_min === undefined ? RPT_NM : rptFmt(s.belt_on_min) + ' / ' + rptFmt(s.belt_off_min)]; }) });
  tables.push({ title: 'Alertes', empty: 'Aucune alerte', head: ['Date', 'Heure', 'Véhicule', 'Type', 'Gravité', 'Détail'], num: [],
    rows: al.map(function (x) { return [rptDay(x.day), x.time || '', x.plate || '', x.type || '', x.severity || '', String(x.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=\S+/g, '').trim()]; }) });
  return {
    kind: 'chauffeur', title: 'Comportement du chauffeur : ' + (d.name || code), period: period, from: o.from, to: o.to, agency: 'Code client ' + code + (d.agency ? ' · agence ' + d.agency : ''),
    generatedAt: o.generatedAt || new Date(), score: a.km ? score : null, level: a.km ? rptLevel(score, P) : '', rank: rank, agg: a,
    summary: [
      ['Chauffeur', (d.name || code) + ' (code client ' + code + ')'],
      ['Téléphone / e-mail', [d.phone, d.email].filter(Boolean).join(' · ') || 'non renseignés'],
      ['Journées de travail (contrats)', rptFmt(Object.keys(a.ctr).length) + ' · véhicules ' + (Object.keys(plates).join(', ') || '-')],
      ['Km parcourus', rptFmt(a.km, 1)],
      ['Conduite / ralenti', rptH(a.drive) + ' / ' + rptH(a.idle) + (a.idleLong ? ' (dont prolongé ' + rptH(a.idleLong) + ')' : '')],
      ['Carburant mesuré (L)', a.fuelN ? rptFmt(a.fuel, 1) : RPT_NM],
      ['Consommation (L/100 km)', a.l100 !== null ? rptFmt(a.l100, 1) : (a.fuelN ? 'km insuffisants' : RPT_NM)],
      ['Coût carburant (MAD)', a.costN ? rptFmt(a.cost) : 'prix non saisi'],
      ['Vitesse max', vmaxT ? rptFmt(vmaxT.vmax) + ' km/h le ' + dt(vmaxT.start_at) + ' (' + (vmaxT.plate || '') + (vmaxT.lim_at_vmax ? ', limite ' + rptFmt(vmaxT.lim_at_vmax) : '') + ')' : '-'],
      ['Pire dépassement de la limite', worstT ? '+' + rptFmt(worstT.worst_over) + ' km/h (' + rptFmt(worstT.speed_at_worst) + ' / ' + rptFmt(worstT.lim_at_worst) + ') le ' + dt(worstT.start_at) : 'aucun (ou limites non fournies)'],
      ['Trajets dépassant de ' + over + ' km/h ou plus / Vmax ≥ ' + vAl, rptFmt(nOver) + ' / ' + rptFmt(nVal)],
      ['Événements de conduite', rptFmt(a.evts) + ' (' + rptFmt(a.pts, 1) + ' points)'],
      ['Score /100 km', a.km >= kmMin ? rptFmt(score, 1) + ' (' + rptLevel(score, P) + ')' : (a.km ? 'trop peu de km' : '-')],
      ['Rang au classement (1 = le plus dangereux)', rank ? (rank.pos ? rank.pos + ' / ' + rank.n : 'non classé (moins de ' + kmMin + ' km)') : '-'],
      ['Ralenti prolongé', rptFmt(idles.length) + ' arrêts'],
      ['Arrêts moteur tournant', stops ? rptFmt(stops.length) + (stL.length ? ' · ' + rptFmt(stL.reduce(function (t, s) { return t + rptNum(s.liters); }, 0), 1) + ' L mesurés (' + stL.length + '/' + stops.length + ')' : '') : 'non disponible'],
      ['Pleins détectés', rptFmt(fills.length) + (fills.length ? ' (' + rptFmt(fills.reduce(function (t, f) { return t + rptNum(f.liters_gauge); }, 0), 1) + ' L jauge)' : '')],
      ['Siphonages suspects', rptFmt(siph.length)],
      ['Alertes', RPT_SEV.map(function (k) { return k + ' ' + sev[k]; }).join(' · ')]
    ],
    tables: tables
  };
}
/** Rapport fait de tableaux déjà prêts (pages Conduite, Classement) : { title, period, agency, summary, tables } */
function rptSimple(o) { return { kind: o.kind || 'tableau', title: o.title, period: o.period, from: o.from, to: o.to, agency: o.agency || 'Toutes les agences', generatedAt: o.generatedAt || new Date(), summary: o.summary || [], tables: o.tables || [] }; }

/** Tableaux du rapport (colonnes + lignes de texte), utilisés pour le HTML et pour le PDF du site */
function rptTables(rep) {
  if (rep.tables) return rep.tables;
  var drvT = { title: 'Chauffeurs (du plus dangereux au moins dangereux)', empty: 'Aucune journée de travail sur la période',
    head: ['Rang', 'Chauffeur', 'Code', 'Niveau', 'Score /100 km', 'Journées', 'Km', 'Conduite', 'Événements', 'Siphonages'],
    num: [0, 4, 5, 6, 7, 8, 9],
    rowsOf: function (s) { return rep.drivers.filter(function (d) { return s === null || (d.shift || '') === s; })
      .map(function (d, i) { return [String(i + 1), d.name, d.code, d.level, rptFmt(d.score, 1), rptFmt(d.days), rptFmt(d.km), rptH(d.drive), rptFmt(d.evts), rptFmt(d.siph)]; }); } };
  drvT.none = 'heure de début du contrat inconnue';
  var drvTables = rep.shifts ? rptSplit(drvT, rep.P, RPT_SHIFTS) : [{ title: drvT.title, empty: drvT.empty, head: drvT.head, num: drvT.num, rows: drvT.rowsOf(null) }];
  return drvTables.concat([
    { title: 'Véhicules', empty: 'Aucun véhicule',
      head: ['Plaque', 'Modèle', 'Jours roulés', 'Km', 'Conduite', 'Ralenti', 'Carburant (L)', 'L/100 km', 'Événements', 'Alertes', 'Km hors contrat'],
      num: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      rows: rep.vehicles.map(function (v) { return [v.plate, v.model, rptFmt(v.days), rptFmt(v.km), rptH(v.drive), rptH(v.idle), v.fuel === null ? RPT_NM : rptFmt(v.fuel, 1), v.l100Txt, rptFmt(v.evts), rptFmt(v.alerts), rptFmt(v.kmHors, 1)]; }) },
    { title: 'Alertes critiques et hautes' + (rep.topAlerts.length >= 60 ? ' (60 plus récentes)' : ''), empty: 'Aucune alerte critique ou haute',
      head: ['Date', 'Heure', 'Plaque', 'Chauffeur', 'Type', 'Gravité', 'Détail'], num: [],
      rows: rep.topAlerts.map(function (a) { return [rptDay(a.day), a.time || '', a.plate || '', a.driver_name || '', a.type || '', a.severity || '', String(a.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=\S+/g, '').trim()]; }) }
  ]);
}

/** Corps HTML du rapport (affiché sur le site, converti en PDF par le collecteur) */
function rptHtml(rep) {
  var h = '<div class="rpt"><h1>' + rptEsc(rep.title) + '</h1><p class="rsub">' + rptEsc(rep.agency) + ' · ' + rptEsc(rep.period) + '</p>';
  h += '<table class="rsum">' + rep.summary.map(function (s) { return '<tr><th>' + rptEsc(s[0]) + '</th><td>' + rptEsc(s[1]) + '</td></tr>'; }).join('') + '</table>';
  rptTables(rep).forEach(function (t) {
    h += '<h2>' + rptEsc(t.title) + '</h2>';
    if (!t.rows.length) { h += '<p class="rempty">' + rptEsc(t.empty) + '</p>'; return; }
    h += '<table class="rtab"><thead><tr>' + t.head.map(function (c, i) { return '<th' + (t.num.indexOf(i) >= 0 ? ' class="n"' : '') + '>' + rptEsc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      t.rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (t.num.indexOf(i) >= 0 ? ' class="n"' : '') + '>' + rptEsc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  });
  return h + '<p class="rfoot">Données mesurées par Geotab uniquement ; « ' + RPT_NM + ' » quand Geotab ne fournit pas la valeur.</p></div>';
}
/** Logo Ludy (version foncée, fond transparent) pour l'en-tête des PDF */
var RPT_LOGO = 'data:image/png;base64,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';
var RPT_CSS = 'body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#1b2a33;margin:18px}.rpt h1{font-size:18px;margin:0 0 2px}.rsub{color:#5d6b74;margin:0 0 12px}' +
  '.rpt h2{font-size:13px;margin:16px 0 6px;border-bottom:2px solid #5b4bd6;padding-bottom:2px}table{border-collapse:collapse;width:100%}' +
  '.rsum{width:auto}.rsum th{text-align:left;font-weight:normal;color:#5d6b74;padding:2px 14px 2px 0}.rsum td{font-weight:bold;padding:2px 0}' +
  '.rtab th{background:#eef0f7;text-align:left;padding:3px 4px;font-size:9px}.rtab td{border-bottom:1px solid #e3e6ea;padding:3px 4px;font-size:9px}' +
  '.rtab .n{text-align:right}.rempty{color:#5d6b74}.rfoot{color:#5d6b74;margin-top:14px;font-size:8px}';
/** Document HTML complet (conversion PDF par Apps Script) */
function rptDoc(rep) { return '<!doctype html><html><head><meta charset="utf-8"><style>' + RPT_CSS + '</style></head><body><img src="' + RPT_LOGO + '" alt="Ludy" style="height:30px;float:right">' + rptHtml(rep) + '</body></html>'; }
/** Nom de fichier du rapport */
function rptFileName(rep) { return ((rep.kind === 'conso' ? 'rapport_consommation_' : rep.kind === 'chauffeur' ? 'comportement_' : rep.kind === 'conduite' ? 'conduite_' : rep.kind === 'classement' ? 'classement_' : 'rapport_flotte_') + (rep.agency === 'Toutes les agences' ? 'toutes_agences' : rep.agency) + '_' + rep.from + (rep.to !== rep.from ? '_' + rep.to : '')).replace(/[^A-Za-z0-9_\-]+/g, '_'); }

if (typeof module !== 'undefined') module.exports = { rptConso: rptConso, rptBuild: rptBuild, rptTables: rptTables, rptHtml: rptHtml, rptDoc: rptDoc, rptFileName: rptFileName, rptFmt: rptFmt, rptShift: rptShift, rptDriver: rptDriver, rptSimple: rptSimple };
