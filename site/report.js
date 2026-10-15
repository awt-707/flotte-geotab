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

/** Tableaux du rapport (colonnes + lignes de texte), utilisés pour le HTML et pour le PDF du site */
function rptTables(rep) {
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
function rptFileName(rep) { return ('rapport_flotte_' + (rep.agency === 'Toutes les agences' ? 'toutes_agences' : rep.agency) + '_' + rep.from + (rep.to !== rep.from ? '_' + rep.to : '')).replace(/[^A-Za-z0-9_\-]+/g, '_'); }

if (typeof module !== 'undefined') module.exports = { rptBuild: rptBuild, rptTables: rptTables, rptHtml: rptHtml, rptDoc: rptDoc, rptFileName: rptFileName, rptFmt: rptFmt };
