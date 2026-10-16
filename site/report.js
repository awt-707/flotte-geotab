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
  jrn.forEach(function (r) { (byV[r.vehicle_key] = byV[r.vehicle_key] || []).push(r); if (r.driver_code && r.driver_code !== HORS) (byD[r.driver_code] = byD[r.driver_code] || []).push(r); });
  var alV = {}, sev = {}; RPT_SEV.forEach(function (s) { sev[s] = 0; });
  al.forEach(function (a) { alV[a.vehicle_key] = (alV[a.vehicle_key] || 0) + 1; sev[a.severity] = (sev[a.severity] || 0) + 1; });
  var drivers = Object.keys(byD).map(function (code) {
    var a = rptAgg(byD[code], minKm), score = a.pts / Math.max(a.km, kmMin) * 100;
    return { code: code, name: (o.drivers || {})[code] || Object.keys(a.names)[0] || code, days: Object.keys(a.ctr).length || Object.keys(a.days).length,
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
    alertCounts: sev, nAlerts: al.length, drivers: drivers, vehicles: vehicles, topAlerts: top
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
  trips.forEach(function (r) {
    var v = keys[r.vehicle_key], code = r.driver_code || HORS, km = rptNum(r.km), pr = rptPrice(v, P), day = o.dayOf(new Date(r.start_at).getTime());
    if (code !== HORS && r.driver_name) names[code] = r.driver_name;
    [tot, byV[r.vehicle_key] = byV[r.vehicle_key] || mk(), byD[code] = byD[code] || mk(), byDay[day] = byDay[day] || mk()].forEach(function (x) {
      x.trips++; x.km += km; x.drive += rptNum(r.drive_min) / 60; x.idleMin += rptNum(r.idle_min);
      if (r.fuel_l !== null && r.fuel_l !== undefined && r.fuel_l !== '') { x.fuel += rptNum(r.fuel_l); x.fuelKm += km; x.fuelN++; if (pr) { x.cost += rptNum(r.fuel_l) * pr; x.costN++; } }
      else x.noFuelKm += km;
      if (r.idle_fuel_l !== null && r.idle_fuel_l !== undefined && r.idle_fuel_l !== '') { x.idleL += rptNum(r.idle_fuel_l); x.idleN++; }
    });
  });
  (o.stops || []).forEach(function (s) {
    if (!keys[s.vehicle_key] || !inP(s.start_at)) return;
    var code = s.driver_code || HORS;
    [tot, byV[s.vehicle_key] = byV[s.vehicle_key] || mk(), byD[code] = byD[code] || mk()].forEach(function (x) {
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
  var cost = function (x) { return x.costN ? rptFmt(x.cost) : (x.fuelN ? 'prix non saisi' : ''); };
  var stopTxt = function (x) { return x.stops ? rptFmt(x.stops) + ' (' + rptH(x.stopMin / 60) + ')' : '0'; };
  var stopL = function (x) { return x.stopLN ? rptFmt(x.stopL, 1) + ' (' + x.stopLN + '/' + x.stops + ' mesurés)' : (x.stops ? RPT_NM : ''); };
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
    { title: 'Par chauffeur (contrats)', empty: 'Aucun trajet sur la période',
      head: ['Chauffeur', 'Code', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Coût (MAD)', 'Ralenti', 'Litres au ralenti', 'Arrêts moteur tournant', 'Litres à l\'arrêt', 'Trajets mesurés'],
      num: [2, 3, 4, 5, 6, 7, 8],
      rows: Object.keys(byD).filter(function (c) { return byD[c].trips; }).sort(function (x, y) { return byD[y].fuel - byD[x].fuel || drvName(x).localeCompare(drvName(y)); }).map(function (c) { var x = byD[c];
        return [drvName(c), c === HORS ? '' : c, rptFmt(x.trips), rptFmt(x.km, 1), liters(x), l100(x), cost(x), rptH(x.idleMin / 60), x.idleN ? rptFmt(x.idleL, 1) : RPT_NM, stopTxt(x), stopL(x), cov(x)]; }) },
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
  ];
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

/** Tableaux du rapport (colonnes + lignes de texte), utilisés pour le HTML et pour le PDF du site */
function rptTables(rep) {
  if (rep.tables) return rep.tables;
  return [
    { title: 'Chauffeurs (du plus dangereux au moins dangereux)', empty: 'Aucune journée de travail sur la période',
      head: ['Rang', 'Chauffeur', 'Code', 'Niveau', 'Score /100 km', 'Journées', 'Km', 'Conduite', 'Événements', 'Siphonages'],
      num: [0, 4, 5, 6, 7, 8, 9],
      rows: rep.drivers.map(function (d, i) { return [String(i + 1), d.name, d.code, d.level, rptFmt(d.score, 1), rptFmt(d.days), rptFmt(d.km), rptH(d.drive), rptFmt(d.evts), rptFmt(d.siph)]; }) },
    { title: 'Véhicules', empty: 'Aucun véhicule',
      head: ['Plaque', 'Modèle', 'Jours roulés', 'Km', 'Conduite', 'Ralenti', 'Carburant (L)', 'L/100 km', 'Événements', 'Alertes', 'Km hors contrat'],
      num: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      rows: rep.vehicles.map(function (v) { return [v.plate, v.model, rptFmt(v.days), rptFmt(v.km), rptH(v.drive), rptH(v.idle), v.fuel === null ? RPT_NM : rptFmt(v.fuel, 1), v.l100Txt, rptFmt(v.evts), rptFmt(v.alerts), rptFmt(v.kmHors, 1)]; }) },
    { title: 'Alertes critiques et hautes' + (rep.topAlerts.length >= 60 ? ' (60 plus récentes)' : ''), empty: 'Aucune alerte critique ou haute',
      head: ['Date', 'Heure', 'Plaque', 'Chauffeur', 'Type', 'Gravité', 'Détail'], num: [],
      rows: rep.topAlerts.map(function (a) { return [rptDay(a.day), a.time || '', a.plate || '', a.driver_name || '', a.type || '', a.severity || '', String(a.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=\S+/g, '').trim()]; }) }
  ];
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
var RPT_CSS = 'body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#1b2a33;margin:18px}.rpt h1{font-size:18px;margin:0 0 2px}.rsub{color:#5d6b74;margin:0 0 12px}' +
  '.rpt h2{font-size:13px;margin:16px 0 6px;border-bottom:2px solid #5b4bd6;padding-bottom:2px}table{border-collapse:collapse;width:100%}' +
  '.rsum{width:auto}.rsum th{text-align:left;font-weight:normal;color:#5d6b74;padding:2px 14px 2px 0}.rsum td{font-weight:bold;padding:2px 0}' +
  '.rtab th{background:#eef0f7;text-align:left;padding:3px 4px;font-size:9px}.rtab td{border-bottom:1px solid #e3e6ea;padding:3px 4px;font-size:9px}' +
  '.rtab .n{text-align:right}.rempty{color:#5d6b74}.rfoot{color:#5d6b74;margin-top:14px;font-size:8px}';
/** Document HTML complet (conversion PDF par Apps Script) */
function rptDoc(rep) { return '<!doctype html><html><head><meta charset="utf-8"><style>' + RPT_CSS + '</style></head><body>' + rptHtml(rep) + '</body></html>'; }
/** Nom de fichier du rapport */
function rptFileName(rep) { return ((rep.kind === 'conso' ? 'rapport_consommation_' : 'rapport_flotte_') + (rep.agency === 'Toutes les agences' ? 'toutes_agences' : rep.agency) + '_' + rep.from + (rep.to !== rep.from ? '_' + rep.to : '')).replace(/[^A-Za-z0-9_\-]+/g, '_'); }

if (typeof module !== 'undefined') module.exports = { rptConso: rptConso, rptBuild: rptBuild, rptTables: rptTables, rptHtml: rptHtml, rptDoc: rptDoc, rptFileName: rptFileName, rptFmt: rptFmt };
