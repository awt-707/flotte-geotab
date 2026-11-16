// ---------- Association aux boîtiers Geotab : complément de mapGeotabDevices (moteur v6, inchangé) ----------
// Signalé par Ahmed (01/11/2026) : véhicules « Non relié à Geotab » alors que le boîtier est présent et en ligne dans Geotab.
// Le moteur v6 n'associe qu'à l'import du parc (une fois par jour, ou à l'ajout d'un véhicule) et seulement si le nom ou la plaque
// du boîtier est exactement la plaque, ou si le VIN saisi dans Geotab est celui du parc. Un boîtier installé ou renommé après
// l'ajout du véhicule, un VIN lu par le boîtier (engineVehicleIdentificationNumber) mais pas saisi, ou une plaque écrite autrement
// (« Santa Fe 12345-A-40 », lettre arabe) restaient non associés.
// Ici, pour les véhicules actifs encore sans boîtier : choix de l'administrateur (param geotabManual {clé: id du boîtier}),
// sinon VIN (saisi ou lu par le boîtier), sinon plaque trouvée dans le nom / la plaque / le commentaire du boîtier,
// sinon même numéro et même région quand la lettre n'est pas lisible. Toujours un seul boîtier candidat, jamais un boîtier
// déjà associé à un autre véhicule. Relancé toutes les 30 min tant qu'un véhicule actif n'a pas de boîtier, et après chaque import du parc.
// Boîtiers libres (non associés, vus dans les 30 derniers jours) publiés dans le param geotabDevices pour le choix sur la page Véhicules.
const GEO_LINK_EVERY_ = 30 * MIN, GEO_FLEET_EVERY_ = 60 * MIN;
const GEO_AR_ = { 'أ': 'A', 'ا': 'A', 'إ': 'A', 'آ': 'A', 'ب': 'B', 'د': 'D', 'ه': 'H', 'ھ': 'H', 'و': 'W', 'ط': 'T', 'ج': 'J' };
function geoArLat_(s) { return String(s || '').replace(/[؀-ۿ]/g, c => GEO_AR_[c] || '?'); }
/** Plaques lisibles dans un texte libre (nom, plaque ou commentaire du boîtier), sous la forme de normPlate_ */
function geoPlatesIn_(s) {
  const t = geoArLat_(s).toUpperCase(), out = [];
  if (!t.trim()) return out;
  out.push({ k: normPlate_(t.replace(/\?/g, '')), whole: true });
  const re = /(\d{3,6})\s*[-|\/.\s]\s*([A-Z?]{1,2})\s*[-|\/.\s]\s*(\d{1,2})(?!\d)/g;
  let m; while ((m = re.exec(t))) out.push({ k: m[1] + m[3] + m[2].replace(/\?/g, ''), num: m[1] + m[3], unk: /\?/.test(m[2]) });
  const ww = /(?:^|[^0-9A-Z])(\d{5,6})\s*-?\s*WW(?![A-Z])|WW\s*-?\s*(\d{5,6})(?!\d)/g;
  while ((m = ww.exec(t))) out.push({ k: (m[1] || m[2]) + 'WW' });
  return out;
}
function geoVin_(s) { return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); }
function geoManual_() {
  let m = {};
  try { const r = dbSelect_('params', 'select=key,value&key=eq.geotabManual', 'key')[0]; m = JSON.parse(String((r && r.value) || '{}')) || {}; } catch (e) { m = {}; }
  return m && typeof m === 'object' ? m : {};
}
/** Une passe d'association ; renvoie un texte court (vide si rien de nouveau) */
function geoRelink_() {
  const T = readTable_(S.VEH), I = idx_(H.VEH);
  if (!T.rows.length) return '';
  const now = Date.now(), devs = (geoCall_('Get', { typeName: 'Device', resultsLimit: 5000 }) || []).filter(x => !x.activeTo || new Date(x.activeTo).getTime() > now);
  const byId = {}; devs.forEach(d => { byId[d.id] = d; });
  const manual = geoManual_(), rows = T.rows.map(r => r.slice());
  const keyOf = r => String(r[I['Clé']]), geo = r => String(r[I['Geotab ID']] || '');
  const linked = [], changed = [];
  const set = (r, d, how) => { r[I['Geotab ID']] = d.id; r[I['Nom Geotab']] = d.name || d.id; changed.push(r[I['Plaque']] + ' → ' + (d.name || d.id) + ' (' + how + ')'); };
  // 1. choix de l'administrateur : prioritaire, retiré du véhicule qui avait ce boîtier
  rows.forEach(r => {
    const id = manual[keyOf(r)], d = id && byId[id];
    if (!d || geo(r) === d.id) return;
    rows.forEach(o => { if (o !== r && geo(o) === d.id) { o[I['Geotab ID']] = ''; o[I['Nom Geotab']] = ''; } });
    set(r, d, 'choisi sur le site');
  });
  const used = {}; rows.forEach(r => { if (geo(r)) used[geo(r)] = 1; });
  const free = devs.filter(d => !used[d.id]);
  // index des boîtiers libres : VIN, plaque exacte, numéro + région (lettre illisible ou absente)
  const ix = { vin: {}, plate: {}, num: {} }, add = (m, k, d) => { if (!k) return; (m[k] = m[k] || {})[d.id] = d; };
  free.forEach(d => {
    [d.vehicleIdentificationNumber, d.engineVehicleIdentificationNumber].map(geoVin_).filter(v => v.length >= 11).forEach(v => add(ix.vin, v, d));
    [d.name, d.licensePlate, d.comment].forEach(s => geoPlatesIn_(s).forEach(p => {
      if (p.k.length >= 5) add(ix.plate, p.k, d);
      if (p.num && p.num.length >= 5) add(ix.num, p.num, d);
    }));
  });
  const one = m => { const a = m ? Object.values(m) : []; return a.length === 1 ? a[0] : null; };
  const taken = {};
  rows.forEach(r => {
    const active = String(r[I['Actif']] || 'OUI').toUpperCase() !== 'NON';
    if (geo(r) || !active) return;
    const vin = geoVin_(r[I['VIN']]), keys = [keyOf(r)].concat(platesOf_(r, I).map(normPlate_));
    let d = null, how = '';
    if (vin.length >= 11 && (d = one(ix.vin[vin]))) how = 'VIN';
    if (!d) { const c = {}; keys.forEach(k => Object.assign(c, ix.plate[k] || {})); if ((d = one(c))) how = 'plaque'; }
    if (!d) {
      // même numéro et même région, lettre illisible dans Geotab : seulement si aucune autre plaque du parc n'a ce numéro
      const c = {}; keys.forEach(k => { const n = k.replace(/[^0-9]/g, ''), l = k.replace(/[0-9]/g, '');
        if (n.length >= 5 && l && l !== 'WW' && !rows.some(o => o !== r && platesOf_(o, I).some(p => normPlate_(p).replace(/[^0-9]/g, '') === n))) Object.assign(c, ix.num[n] || {}); });
      if ((d = one(c))) how = 'numéro de plaque';
    }
    if (d && !taken[d.id]) { taken[d.id] = 1; set(r, d, how); }
  });
  rows.forEach(r => { if (geo(r)) linked.push(geo(r)); });
  if (changed.length) { writeTable_(S.VEH, H.VEH, rows); memoClear_(); }
  const missing = rows.filter(r => !geo(r) && String(r[I['Actif']] || 'OUI').toUpperCase() !== 'NON').map(r => r[I['Plaque']]);
  geoPublishFree_(devs, linked);
  const txt = (changed.length ? changed.length + ' associé' + (changed.length > 1 ? 's' : '') + ' : ' + changed.join(', ') : '') +
    (missing.length ? (changed.length ? ' | ' : '') + 'sans boîtier : ' + missing.join(', ') : '');
  const props = PropertiesService.getScriptProperties();
  if (txt && (changed.length || props.getProperty('GEO_LINK_MSG') !== txt)) log_('Association Geotab (complément)', txt);
  props.setProperty('GEO_LINK_MSG', txt);
  return changed.length ? 'Geotab : ' + changed.join(', ') : '';
}
/** Boîtiers libres (vus dans les 30 derniers jours) pour le choix de l'administrateur sur la page Véhicules */
function geoPublishFree_(devs, linked) {
  const L = {}; linked.forEach(id => { L[id] = 1; });
  let st = []; try { st = geoCall_('Get', { typeName: 'DeviceStatusInfo' }) || []; } catch (e) { st = []; }
  const last = {}; st.forEach(s => { if (s && s.device) last[s.device.id] = { t: s.dateTime || null, on: s.isDeviceCommunicating !== false, lat: s.latitude == null ? null : +s.latitude, lng: s.longitude == null ? null : +s.longitude }; });
  const since = Date.now() - 30 * DAY;
  // boîtiers dont le nom, la plaque ou le commentaire porte une plaque marocaine d'abord : la base Geotab compte aussi des centaines de
  // véhicules d'autres flottes (plaques françaises), qui remplissaient les 300 places de la liste et cachaient les boîtiers de la flotte
  const ma = d => [d.name, d.licensePlate, d.comment].some(x => geoPlatesIn_(x).some(p => !p.whole));
  const list = devs.filter(d => !L[d.id]).map(d => ({ id: d.id, n: String(d.name || ''), p: String(d.licensePlate || ''), v: geoVin_(d.vehicleIdentificationNumber || d.engineVehicleIdentificationNumber),
    s: String(d.serialNumber || ''), t: last[d.id] ? last[d.id].t : null, on: last[d.id] ? last[d.id].on : null, ma: ma(d) }))
    .filter(x => !x.t || new Date(x.t).getTime() >= since || !st.length)
    .sort((a, b) => (b.ma - a.ma) || String(b.t || '').localeCompare(String(a.t || '')) || a.n.localeCompare(b.n)).slice(0, 300)
    .map(x => { delete x.ma; return x; });
  // boîtiers de la flotte (16/11/2026, demande d'Ahmed : numéros des boîtiers installés au Maroc avec la plaque) : boîtiers associés à
  // un véhicule de Ludy, et boîtiers libres dont la dernière position Geotab est au Maroc ou dont le nom / la plaque est une plaque marocaine
  const inMa = s => s && s.lat != null && s.lat >= 20.7 && s.lat <= 35.95 && s.lng >= -17.2 && s.lng <= -0.99;
  const fl0 = devs.filter(d => L[d.id] || inMa(last[d.id]) || ma(d)), first = geoFirstFix_(fl0);
  const fleet = fl0.map(d => ({ id: d.id, s: String(d.serialNumber || ''), n: String(d.name || ''), p: String(d.licensePlate || ''),
    v: geoVin_(d.vehicleIdentificationNumber || d.engineVehicleIdentificationNumber), t: last[d.id] ? last[d.id].t : null, on: last[d.id] ? last[d.id].on : null,
    a: d.activeFrom || null, b: first[d.id] || null, maroc: last[d.id] && last[d.id].lat != null ? !!inMa(last[d.id]) : null, lie: !!L[d.id] })).sort((a, b) => (b.lie - a.lie) || a.n.localeCompare(b.n));
  sbReq_('post', 'params?on_conflict=key', [
    { key: 'geotabDevices', label: 'Boîtiers Geotab non associés (calculé par le collecteur)', value: JSON.stringify({ at: new Date().toISOString(), list }), note: 'Ne pas modifier', sort: 997 },
    { key: 'geotabFleet', label: 'Boîtiers Geotab de la flotte : associés ou au Maroc (calculé par le collecteur)', value: JSON.stringify({ at: new Date().toISOString(), list: fleet }), note: 'Ne pas modifier', sort: 997 }],
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
  try { PropertiesService.getScriptProperties().setProperty('GEO_FLEET_AT', String(Date.now())); } catch (e) { }
  try { geoFleetSheet_(fleet); } catch (e) { log_('Boîtiers Geotab (Google Sheet)', e.message); }
  sbReq_('post', 'params?on_conflict=key', [{ key: 'geotabManual', label: 'Boîtiers Geotab choisis à la main (page Véhicules)', value: '{}', note: 'Rempli par la page Véhicules', sort: 998 }],
    { Prefer: 'resolution=ignore-duplicates,return=minimal' });
}
/** À chaque passage : relancée toutes les 30 min tant qu'un véhicule actif n'a pas de boîtier, ou dès qu'un choix manuel n'est pas appliqué */
function geoLinkStep_() {
  const veh = vehicles_(), manual = geoManual_(), props = PropertiesService.getScriptProperties();
  // choix manuel nouveau (ou changé) : appliqué au passage suivant, une fois
  const man = JSON.stringify(manual), pend = props.getProperty('GEO_LINK_MAN') !== man && Object.keys(manual).some(k => veh[k] && veh[k].geoId !== manual[k]);
  const need = Object.values(veh).some(v => v.active && !v.geoId);
  // liste des boîtiers de la flotte (param geotabFleet) republiée au moins une fois par jour, même sans véhicule à associer
  const stale = Date.now() - +(props.getProperty('GEO_FLEET_AT') || 0) > GEO_FLEET_EVERY_;
  if (!need && !pend && !stale) return '';
  if (!pend && !stale && Date.now() - +(props.getProperty('GEO_LINK_AT') || 0) < GEO_LINK_EVERY_) return '';
  props.setProperty('GEO_LINK_AT', String(Date.now())); props.setProperty('GEO_LINK_MAN', man);
  return geoRelink_();
}
/** Import du parc (moteur v6) suivi du complément d'association */
function importVehiclesLink_() {
  const n = importVehicles(true);
  let m = ''; try { PropertiesService.getScriptProperties().setProperty('GEO_LINK_AT', String(Date.now())); m = geoRelink_(); } catch (e) { log_('Association Geotab (complément)', e.message); }
  return { n, msg: m };
}

// ---------- Boîtiers Geotab dans le Google Sheet d'Ahmed (16/11/2026 : « chaque plaque avec chaque numéro de boîtier, à chaque
// activation d'un boîtier au Maroc ça se stocke dans le fichier, tout le temps à jour ») ----------
// Classeur = param geotabSheetId (identifiant jamais dans le dépôt), onglet « Boîtiers Geotab (Ludy) » créé s'il manque, les autres
// onglets du classeur jamais touchés. Réécrit à chaque publication de la liste des boîtiers (toutes les heures) : une ligne par boîtier
// (associé à un véhicule de Ludy, ou dernière position au Maroc, ou plaque marocaine), lignes existantes gardées dans leur ordre
// (un boîtier qui n'est plus dans Geotab reste, statut « Plus actif dans Geotab »), nouveaux boîtiers ajoutés à la suite par date d'activation.
/**
 * Date d'installation = premier bornage GPS du boîtier (16/11/2026, demande d'Ahmed) : première position Geotab (LogRecord) depuis
 * son activation, lue une fois par boîtier (propriété GEO_FIRST {id: date}) ; 15 boîtiers au plus par passage ; aucune position :
 * réessayé le lendemain (rien d'estimé).
 */
function geoFirstFix_(devs) {
  const props = PropertiesService.getScriptProperties();
  let F = {}; try { F = JSON.parse(props.getProperty('GEO_FIRST') || '{}') || {}; } catch (e) { F = {}; }
  const now = Date.now(), todo = devs.filter(d => !F[d.id] || (!F[d.id].t && now - (+F[d.id].at || 0) > DAY)).slice(0, 15);
  let changed = false;
  todo.forEach(d => {
    try {
      const r = geoCall_('Get', { typeName: 'LogRecord', search: { deviceSearch: { id: d.id }, fromDate: d.activeFrom || '2015-01-01T00:00:00.000Z', toDate: new Date(now).toISOString() }, resultsLimit: 1 }) || [];
      F[d.id] = { t: r[0] && r[0].dateTime ? r[0].dateTime : '', at: now }; changed = true;
    } catch (e) { /* réessayé au passage suivant */ }
  });
  if (changed) props.setProperty('GEO_FIRST', JSON.stringify(F));
  const out = {}; Object.keys(F).forEach(k => { if (F[k] && F[k].t) out[k] = F[k].t; });
  return out;
}
const GEO_SHEET_TAB_ = 'Boîtiers Geotab (Ludy)';
const GEO_SHEET_H_ = ['Immatriculation', 'Immatriculation provisoire', 'Marque', 'Modèle', 'N° de châssis (VIN)', 'N° de boîtier Geotab', 'Nom dans Geotab',
  'Date d\'installation (1er bornage GPS)', 'Date d\'activation Geotab', 'Ajouté au fichier le', 'Dernier signal', 'Communique', 'Dernière position au Maroc', 'Relié à Ludy', 'Agence', 'Statut',
  'Identifiant Geotab', 'Mis à jour le'];
function geoSheetRows_(fleet, veh, ags, old, nowTxt, fmt) {
  const byGeo = {}; veh.forEach(v => { if (v.geotab_id) byGeo[v.geotab_id] = v; });
  const agN = {}; ags.forEach(a => { agN[a.id] = a.name; });
  const ID = GEO_SHEET_H_.indexOf('Identifiant Geotab'), FIRST = GEO_SHEET_H_.indexOf('Ajouté au fichier le'), ST = GEO_SHEET_H_.indexOf('Statut'), UP = GEO_SHEET_H_.indexOf('Mis à jour le');
  const prev = {}; old.forEach(r => { if (r[ID]) prev[r[ID]] = r; });
  const plates = x => (Array.isArray(x) ? x : String(x || '').split(/[,;]\s*/)).filter(Boolean).join(', ');
  const row = f => {
    const v = byGeo[f.id] || {}, o = prev[f.id] || [];
    const first = o[FIRST] || nowTxt;
    return [v.plate || f.p || f.n, plates(v.other_plates), v.brand || '', v.model || '', v.vin || f.v || '', f.s, f.n, f.b ? fmt(f.b) : '', f.a ? fmt(f.a) : '', first,
      f.t ? fmt(f.t) : '', f.on == null ? '' : f.on ? 'Oui' : 'Non', f.maroc == null ? 'non mesuré' : f.maroc ? 'Oui' : 'Non', f.lie ? 'Oui' : 'Non',
      agN[v.agency_id] || '', 'Actif', f.id, nowTxt].map(x => cshTxt_(x));
  };
  const cur = {}; fleet.forEach(f => { cur[f.id] = f; });
  const out = old.filter(r => r[ID]).map(r => {
    if (cur[r[ID]]) return row(cur[r[ID]]);
    const k = r.slice(0, GEO_SHEET_H_.length); while (k.length < GEO_SHEET_H_.length) k.push('');
    if (k[ST] !== 'Plus actif dans Geotab') { k[ST] = 'Plus actif dans Geotab'; k[UP] = nowTxt; }
    return k;
  });
  fleet.filter(f => !prev[f.id]).sort((a, b) => (!a.a - !b.a) || String(a.a || '').localeCompare(String(b.a || '')) || a.n.localeCompare(b.n)).forEach(f => out.push(row(f)));
  return out;
}
function geoFleetSheet_(fleet) {
  let id = '';
  try { const r = dbSelect_('params', 'select=key,value&key=eq.geotabSheetId', 'key')[0]; id = String((r && r.value) || '').trim(); } catch (e) { id = ''; }
  if (!id) return '';
  const veh = dbSelect_('vehicles', 'select=key,plate,brand,model,vin,other_plates,agency_id,geotab_id', 'key');
  let ags = []; try { ags = dbSelect_('agencies', 'select=id,name', 'id'); } catch (e) { ags = []; }
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(GEO_SHEET_TAB_);
  if (!sh) { sh = ss.insertSheet(GEO_SHEET_TAB_); sh.setFrozenRows(1); }
  // lignes existantes relues d'après les titres de leur colonne (une colonne ajoutée dans une version suivante ne décale rien)
  const n0 = Math.max(0, sh.getLastRow() - 1), w = Math.max(GEO_SHEET_H_.length, sh.getLastColumn ? sh.getLastColumn() : GEO_SHEET_H_.length);
  const oh = sh.getRange(1, 1, 1, w).getValues()[0].map(x => String(x || ''));
  const old = n0 ? sh.getRange(2, 1, n0, w).getValues().map(r => GEO_SHEET_H_.map(h => { const j = oh.indexOf(h); return j < 0 || r[j] == null ? '' : String(r[j]); })) : [];
  const fmt = t => fmtMa_(t, 'dd/MM/yyyy HH:mm'), rows = geoSheetRows_(fleet, veh, ags, old, fmt(Date.now()), fmt);
  sh.getRange(1, 1, 1, GEO_SHEET_H_.length).setValues([GEO_SHEET_H_]);
  if (rows.length) {
    if (rows.length + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
    const rg = sh.getRange(2, 1, rows.length, GEO_SHEET_H_.length);
    rg.setNumberFormat('@'); rg.setValues(rows);
  }
  if (n0 > rows.length) sh.getRange(2 + rows.length, 1, n0 - rows.length, GEO_SHEET_H_.length).clearContent();
  return rows.length + ' boîtiers';
}
