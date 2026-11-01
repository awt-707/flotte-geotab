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
const GEO_LINK_EVERY_ = 30 * MIN;
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
  const last = {}; st.forEach(s => { if (s && s.device) last[s.device.id] = { t: s.dateTime || null, on: s.isDeviceCommunicating !== false }; });
  const since = Date.now() - 30 * DAY;
  const list = devs.filter(d => !L[d.id]).map(d => ({ id: d.id, n: String(d.name || ''), p: String(d.licensePlate || ''), v: geoVin_(d.vehicleIdentificationNumber || d.engineVehicleIdentificationNumber),
    s: String(d.serialNumber || ''), t: last[d.id] ? last[d.id].t : null, on: last[d.id] ? last[d.id].on : null }))
    .filter(x => !x.t || new Date(x.t).getTime() >= since || !st.length)
    .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')) || a.n.localeCompare(b.n)).slice(0, 300);
  sbReq_('post', 'params?on_conflict=key', [
    { key: 'geotabDevices', label: 'Boîtiers Geotab non associés (calculé par le collecteur)', value: JSON.stringify({ at: new Date().toISOString(), list }), note: 'Ne pas modifier', sort: 997 }],
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
  sbReq_('post', 'params?on_conflict=key', [{ key: 'geotabManual', label: 'Boîtiers Geotab choisis à la main (page Véhicules)', value: '{}', note: 'Rempli par la page Véhicules', sort: 998 }],
    { Prefer: 'resolution=ignore-duplicates,return=minimal' });
}
/** À chaque passage : relancée toutes les 30 min tant qu'un véhicule actif n'a pas de boîtier, ou dès qu'un choix manuel n'est pas appliqué */
function geoLinkStep_() {
  const veh = vehicles_(), manual = geoManual_(), props = PropertiesService.getScriptProperties();
  // choix manuel nouveau (ou changé) : appliqué au passage suivant, une fois
  const man = JSON.stringify(manual), pend = props.getProperty('GEO_LINK_MAN') !== man && Object.keys(manual).some(k => veh[k] && veh[k].geoId !== manual[k]);
  const need = Object.values(veh).some(v => v.active && !v.geoId);
  if (!need && !pend) return '';
  if (!pend && Date.now() - +(props.getProperty('GEO_LINK_AT') || 0) < GEO_LINK_EVERY_) return '';
  props.setProperty('GEO_LINK_AT', String(Date.now())); props.setProperty('GEO_LINK_MAN', man);
  return geoRelink_();
}
/** Import du parc (moteur v6) suivi du complément d'association */
function importVehiclesLink_() {
  const n = importVehicles(true);
  let m = ''; try { PropertiesService.getScriptProperties().setProperty('GEO_LINK_AT', String(Date.now())); m = geoRelink_(); } catch (e) { log_('Association Geotab (complément)', e.message); }
  return { n, msg: m };
}
