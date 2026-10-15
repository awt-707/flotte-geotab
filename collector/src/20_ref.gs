// ============================================================================
// RÉFÉRENTIELS SUR LA BASE (paramètres, véhicules, plaques, contrats, chauffeurs)
// Les fonctions du Sheet v6 qui lisaient un onglet lisent ici la table correspondante.
// ============================================================================
/** Lecture d'une table comme un onglet du Sheet : {rows, I, headers} */
function readTable_(k) { return DATA_KEYS.indexOf(k) >= 0 ? readData_(k) : readRef_(k); }
/** Écriture complète d'un petit référentiel (VEH, RULE) : mise à jour par clé, lignes disparues retirées */
function writeTable_(k, headers, rows) {
  const pk = { VEH: 'key', RULE: 'id' }[k];
  if (!pk) throw new Error('writeTable_ ' + k);
  const objs = rows.map(r => toDb_(k, r)).filter(o => o[pk]);
  if (!objs.length) return;
  dbUpsert_(DB[k].table, objs, pk);
  dbDelete_(DB[k].table, pk + '=not.' + inList_(objs.map(o => o[pk])));
  memoClear_();
}
/** Filtre PostgREST « in.(...) » encodé pour l'URL */
function inList_(vals) { return 'in.' + enc_('(' + vals.map(v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + ')'); }

// ---------- Paramètres ----------
const NUM_PARAMS = ['priceDiesel', 'priceGas', 'siphonPct', 'siphonL', 'pleinPct', 'stopMin', 'idleLongMin', 'idleAlertMin', 'idleDayMin', 'minFuelKm',
  'vmaxAlert', 'overAlert', 'scoreY', 'scoreO', 'scoreR', 'kmMin', 'overConsPct', 'ctrTolMin', 'lvlDays',
  'catchupDays', 'reportHour', 'rpmMin', 'fullPct', 'shiftDay', 'shiftNight', 'liveMin', 'autoRenderMin', 'retentionDays'];
function params_() {
  if (MEMO_.__P) return Object.assign({}, MEMO_.__P);
  const P = {};
  PARAM_DEFS.forEach(d => { P[d[0]] = d[2]; });
  dbSelect_('params', 'select=key,value', 'key').forEach(r => { if (r.value !== null && r.value !== '' && P.hasOwnProperty(r.key)) P[r.key] = r.value; });
  NUM_PARAMS.forEach(k => { P[k] = num_(P[k]); });
  MEMO_.__P = P;
  return Object.assign({}, P);
}
function setParam_(key, value) {
  memoClear_();
  sbReq_('patch', 'params?key=eq.' + enc_(key), { value: String(value) }, { Prefer: 'return=minimal' });
}
/** Paramètres par défaut créés s'ils n'existent pas (les valeurs déjà saisies ne sont jamais écrasées) */
function seedParams_() {
  sbReq_('post', 'params?on_conflict=key', PARAM_DEFS.map((d, i) => ({ key: d[0], label: d[1], value: String(d[2]), note: d[3], sort: i + 1 })),
    { Prefer: 'resolution=ignore-duplicates,return=minimal' });
  dbUpsert_('params', PARAM_DEFS.map((d, i) => ({ key: d[0], label: d[1], note: d[3], sort: i + 1 })), 'key');   // libellés à jour
  memoClear_();
}

// ---------- Plaques ----------
/** Clés véhicule présentes dans les données / contrats avec leur historique */
function keyStats_() { return dbRpc_('key_stats') || []; }
/** Changements de plaque saisis sur le site (table plate_changes) : [{old, neu, oldK, newK, row}] */
function platePairs_() {
  if (MEMO_.__pairs) return MEMO_.__pairs;
  const out = [];
  dbSelect_('plate_changes', 'select=id,old_plate,new_plate', 'id').forEach(r => {
    const o = String(r.old_plate || '').trim().toUpperCase().replace(/\s+/g, ''), n = String(r.new_plate || '').trim().toUpperCase().replace(/\s+/g, '');
    if (o.length >= 4 && n.length >= 4) out.push({ old: o, neu: n, oldK: normPlate_(o), newK: normPlate_(n), row: r.id });
  });
  return (MEMO_.__pairs = out);
}
/** Nombre de clés de contrats qui ne sont pas la clé principale de leur véhicule (rattachées par rekeyAll_) */
function canonContracts_() {
  const cm = canonMap_();
  return keyStats_().filter(x => x.n_contracts > 0 && cm[x.vehicle_key] && cm[x.vehicle_key] !== x.vehicle_key).length;
}
/** Toutes les lignes (données, contrats, journal, alertes) d'une plaque absorbée passent sous la clé historique du véhicule */
function rekeyAll_() {
  const cm = canonMap_(), t0 = Date.now(), msg = []; let minDay = '';
  keyStats_().forEach(x => {
    const k = x.vehicle_key, c = cm[k];
    if (!k || !c || c === k) return;
    const d = dbRpc_('rekey_vehicle', { p_alias: k, p_canon: c });
    if (d && (!minDay || d < minDay)) minDay = d;
    msg.push(k + ' → ' + c);
  });
  const props = PropertiesService.getScriptProperties(), all = props.getProperties();
  Object.keys(all).forEach(x => { if (x.indexOf('LIVE|') === 0) { const key = x.slice(5); if (cm[key] && cm[key] !== key) props.deleteProperty(x); } });
  memoClear_();
  if (minDay) markDirty_(minDay);
  if (msg.length) log_('Plaques', 'Données rattachées à la plaque historique : ' + msg.join(' | '), t0);
  return minDay;
}
/** Table des changements de plaque : regroupements détectés automatiquement (même châssis / boîtier) ajoutés, état de chaque ligne */
function syncPlatesTab_() {
  const T = readRef_('VEH'), IV = idx_(H.VEH), cm = canonMap_(), veh = vehicles_();
  const cur = dbSelect_('plate_changes', 'select=id,old_plate,new_plate,vehicle,status', 'id');
  const seen = {}; cur.forEach(r => { seen[normPlate_(r.old_plate) + '>' + normPlate_(r.new_plate)] = 1; });
  const add = [];
  T.rows.forEach(r => {
    const plates = platesOf_(r, IV), def = plates.filter(p => !isTempPlate_(p)), tmp = plates.filter(isTempPlate_);
    if (!def.length) return;
    tmp.forEach(o => { const k = normPlate_(o) + '>' + normPlate_(def[0]); if (!seen[k]) { seen[k] = 1;
      add.push({ old_plate: o, new_plate: def[0], note: 'Détecté automatiquement (même châssis / même boîtier Geotab)' }); } });
  });
  if (add.length) (sbReq_('post', 'plate_changes', add, { Prefer: 'return=representation' }) || []).forEach(r => cur.push(r));
  const upd = [];
  cur.forEach(r => {
    const o = String(r.old_plate || '').trim(), n = String(r.new_plate || '').trim();
    let vehicle = '', status;
    if (!o || !n) status = 'À compléter : ancienne ET nouvelle plaque';
    else {
      const ko = cm[normPlate_(o)], kn = cm[normPlate_(n)], v = veh[ko || kn];
      vehicle = v ? v.plate : '';
      if (ko && kn && ko === kn) status = 'OK : même véhicule, historique conservé';
      else if (ko || kn) status = 'OK : la plaque ' + (ko ? n : o) + ' sera reconnue dans les contrats';
      else status = 'Plaques inconnues (ni dans le Parc ni dans Geotab) : vérifiez l\'orthographe';
    }
    if (String(r.vehicle || '') !== vehicle || String(r.status || '') !== status) upd.push({ id: r.id, vehicle, status });
  });
  upd.forEach(u => sbReq_('patch', 'plate_changes?id=eq.' + u.id, { vehicle: u.vehicle, status: u.status }, { Prefer: 'return=minimal' }));
  if (add.length) delete MEMO_.__pairs;
  return cur.length;
}

// ---------- Contrats ----------
/**
 * Index des contrats par véhicule (rattachement des trajets aux chauffeurs). Mémorisé pour l'exécution.
 * Seuls les contrats des données conservées (+ 45 jours) sont chargés ; le premier contrat connu de chaque véhicule
 * (__first) vient de tout l'historique.
 */
function contractIndex_() {
  if (MEMO_.__cidx) return MEMO_.__cidx;
  const map = {}, now = Date.now(), cm = canonMap_(), first = {}, P = params_();
  Object.defineProperty(map, '__range', { value: null, writable: true, enumerable: false });
  Object.defineProperty(map, '__first', { value: first, writable: true, enumerable: false });
  (dbRpc_('contract_first') || []).forEach(x => {
    const key = canonKey_(x.vehicle_key, cm), t = new Date(x.first_start).getTime();
    if (key && (first[key] === undefined || t < first[key])) first[key] = t;
  });
  const since = new Date(now - ((P.retentionDays || 62) + 45) * DAY).toISOString();
  dbSelect_('contracts', 'select=num,client_code,name,vehicle_key,start_at,end_at&start_at=gte.' + since, 'num').forEach(r => {
    const key = canonKey_(r.vehicle_key, cm); if (!key || !r.start_at) return;
    const st = new Date(r.start_at).getTime(), en = r.end_at ? new Date(r.end_at).getTime() : null;
    (map[key] = map[key] || []).push({ start: st, end: en !== null ? en : now + HOUR, open: en === null,
      code: String(r.client_code || ''), nom: String(r.name || ''), num: String(r.num) });
  });
  Object.keys(map).forEach(k => map[k].sort((a, b) => a.start - b.start));
  return (MEMO_.__cidx = map);
}
/** Contrats par numéro (horaires réels), seulement ceux présents dans les lignes données */
function contractInfoFor_(sets) {
  const nums = {}, m = {};
  sets.forEach(A => { const c = A.I['Contrat']; A.rows.forEach(r => { const n = String(r[c] || ''); if (n) nums[n] = 1; }); });
  const list = Object.keys(nums);
  for (let i = 0; i < list.length; i += 80) {
    dbSelect_('contracts', 'select=num,client_code,name,vehicle_key,start_at,end_at&num=' + inList_(list.slice(i, i + 80)), 'num').forEach(r => {
      m[String(r.num)] = { start: r.start_at ? new Date(r.start_at) : null, end: r.end_at ? new Date(r.end_at) : null,
        code: String(r.client_code || ''), nom: String(r.name || ''), key: String(r.vehicle_key || '') };
    });
  }
  return m;
}
/** Journées de contrat (véhicule relié à Geotab) jamais téléchargées depuis sinceDay. Retourne ['clé|jour', ...]. */
function missingContractDays_(synced, sinceDay) {
  const veh = vehicles_(), today = localDay_(new Date()), need = {}, cm = canonMap_();
  const q = 'select=vehicle_key,start_at,end_at' + (sinceDay ? '&start_at=gte.' + dayBounds_(sinceDay).start.toISOString() : '');
  dbSelect_('contracts', q, 'num').forEach(r => {
    const key = canonKey_(r.vehicle_key, cm), v = veh[key]; if (!v || !v.geoId || !v.active || !r.start_at) return;
    const a = new Date(r.start_at), z = r.end_at ? new Date(r.end_at) : new Date(Math.min(Date.now(), a.getTime() + 16 * HOUR));
    for (let d = localDay_(a), last = localDay_(z), g = 0; d <= last && d <= today && g < 10; d = addDays_(d, 1), g++) need[key + '|' + d] = 1;
  });
  return Object.keys(need).filter(id => !synced[id]).sort();
}
/** Chauffeurs reconstruits depuis les contrats (calcul dans la base) */
function refreshDrivers_() {
  const r = dbRpc_('refresh_drivers') || {};
  memoClear_();
  return { newDrivers: r.new || [], dupes: r.dupes || [] };
}

// ---------- Synchro ----------
/**
 * Véhicule-jours complets : synchronisés après la fin de la fenêtre d'analyse (fin de journée + 12 h) avec le moteur actuel.
 * Lus à partir de sinceDay (par défaut : rattrapage + 3 jours, ou plus tôt si le temps réel d'un véhicule est en retard).
 */
function doneVehDays_(sinceDay) {
  const props = PropertiesService.getScriptProperties(), P = params_(), today = localDay_(new Date());
  let since = sinceDay || addDays_(today, -Math.max(1, P.catchupDays || 7) - 3);
  if (!sinceDay) {
    const all = props.getProperties();
    Object.keys(all).forEach(k => { if (k.indexOf('LIVE|') !== 0) return; try { const x = JSON.parse(all[k]); if (x && x.done > 0) { const d = addDays_(localDay_(x.done), -1); if (d < since) since = d; } } catch (e) { } });
  }
  const mk = '__done|' + since;
  if (MEMO_[mk]) return MEMO_[mk];
  const eng = +(props.getProperty('ENGINE_SINCE') || 0), o = {};
  dbSelect_('vehicle_days', 'select=id,day,synced_at&day=gte.' + since, 'id').forEach(r => {
    const t = r.synced_at ? new Date(r.synced_at).getTime() : 0, d = String(r.day).slice(0, 10);
    if (t && t >= eng && t >= dayBounds_(d).end.getTime() + 12 * HOUR) o[r.id] = 1;
  });
  return (MEMO_[mk] = o);
}
/** Alertes siphonage marquées « Faux positif » sur le site */
function fauxPositifs_() {
  const o = {};
  dbSelect_('alerts', 'select=id&status=eq.' + enc_('Faux positif') + '&id=like.' + enc_('SIPH|*'), 'id').forEach(r => { o[r.id] = 1; });
  return o;
}

// ---------- Parc (liste des véhicules injectée depuis le site) ----------
/** Lignes du parc au format de l'ancien onglet : [en-têtes, [plaque, marque, modèle, VIN, carburant], ...] */
function parcData_(P) {
  let rows = dbSelect_('parc', 'select=plate,brand,model,vin,fuel', 'plate');
  if (!rows.length && !PropertiesService.getScriptProperties().getProperty('PARC_SEEDED')) { seedParcFromSheet_(P); rows = dbSelect_('parc', 'select=plate,brand,model,vin,fuel', 'plate'); }
  return [['Plaque', 'Marque', 'Modèle', 'VIN', 'Carburant']].concat(rows.map(r => [r.plate, r.brand || '', r.model || '', r.vin || '', r.fuel || '']));
}
/** Reprise unique du Sheet « ETAT PARC » dans la table parc (une seule fois ; ensuite le parc se gère sur le site) */
function seedParcFromSheet_(P) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('PARC_SEEDED', '1');
  if (!String(P.parcId || '').trim()) return 0;
  try {
    const src = SpreadsheetApp.openById(String(P.parcId)).getSheetByName(String(P.parcTab));
    if (!src) throw new Error('onglet "' + P.parcTab + '" introuvable');
    const data = src.getDataRange().getValues(), head = data[0].map(h => normTxt_(h));
    const find = (re, dflt) => { const i = head.findIndex(h => re.test(h)); return i >= 0 ? i : dflt; };
    const cPl = colToIndex_(P.parcCol) - 1, cMa = find(/^marque/, 7), cMo = find(/^modele/, 8), cVin = find(/chassis|vin/, 9), cCa = find(/^carburant/, 17);
    const seen = {}, objs = [];
    data.slice(1).forEach(r => {
      const plate = String(r[cPl] || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!plate || plate.length < 4 || seen[plate]) return;
      seen[plate] = 1;
      const s = v => v === '' || v === null || v === undefined ? null : String(v);
      objs.push({ plate, brand: s(r[cMa]), model: s(r[cMo]), vin: s(r[cVin]), fuel: s(r[cCa]), note: 'Repris du Sheet ETAT PARC' });
    });
    if (objs.length) sbReq_('post', 'parc?on_conflict=plate', objs, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    log_('Parc', objs.length + ' véhicules repris une fois du Sheet ETAT PARC. La liste se gère maintenant sur le site (page Véhicules).');
    return objs.length;
  } catch (e) { log_('Parc', 'Reprise du Sheet ETAT PARC impossible (' + e.message + ') : importez la liste des véhicules sur le site (page Véhicules).'); return 0; }
}
