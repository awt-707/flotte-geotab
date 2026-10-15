// ============================================================================
// INSTALLATION ET REPRISE DE L'ANCIEN GOOGLE SHEET
// ============================================================================
/** À exécuter une fois depuis l'éditeur (bouton Exécuter). Peut être relancé sans risque. */
function installer() {
  const t0 = Date.now(), props = PropertiesService.getScriptProperties(), out = [];
  const miss = ['GEO_USER', 'GEO_PWD', 'SUPABASE_KEY'].filter(k => !String(props.getProperty(k) || '').trim());
  if (miss.length) throw new Error('Propriétés du script manquantes : ' + miss.join(', ') + ' (Paramètres du projet > Propriétés du script).');
  if (/anon|publishable/i.test(jwtRole_(props.getProperty('SUPABASE_KEY')))) throw new Error('SUPABASE_KEY doit être la clé service_role (secrète), pas la clé anon/publique.');
  sbReq_('get', 'params?select=key&limit=1');
  out.push('Supabase : connexion OK');
  seedParams_(); tzPublish_(true);
  if (props.getProperty('GEO_USER')) setParam_('geoUser', props.getProperty('GEO_USER'));
  props.deleteProperty('GEO_SESSION'); geoAuth_(true);
  out.push('Geotab : connexion OK');
  if (!props.getProperty('ENGINE_V')) props.setProperty('ENGINE_V', ENGINE_V);   // jours déjà calculés par le Sheet : valables
  checkEngine_();
  const old = String(props.getProperty('OLD_SHEET_ID') || DEFAULT_OLD_SHEET_ID).trim();
  if (old && !props.getProperty('IMPORT_DONE')) {
    props.setProperty('IMPORT_STEPS', JSON.stringify(IMPORT_TABLES.map(x => x[0]).concat(['fin'])));
    props.deleteProperty('IMPORT_POS');
    out.push('Reprise de l\'historique du Google Sheet : en arrière-plan (10 à 30 min), suivi dans le Journal du site');
  } else {
    try { importVehicles(true); out.push(Object.keys(vehicles_()).length + ' véhicules'); } catch (e) { out.push('Véhicules : ' + e.message); }
    try { syncRules_(); } catch (e) { out.push('Règles : ' + e.message); }
  }
  const m = [1, 5, 10, 15, 30].indexOf(params_().liveMin) >= 0 ? params_().liveMin : 5;
  clearTriggers_('collect');
  ScriptApp.newTrigger('collect').timeBased().everyMinutes(m).create();
  props.setProperty('INSTALLED', '1');
  out.push('Collecte automatique toutes les ' + m + ' min : activée');
  log_('Installation', 'Collecteur ' + COLLECTOR_V + ' | ' + out.join(' | '), t0);
  console.log(out.join('\n'));
  return out.join('\n');
}
/** Rôle d'une clé Supabase (sans la vérifier) */
function jwtRole_(key) {
  key = String(key || '');
  if (/^sb_publishable_/.test(key)) return 'publishable';
  if (/^sb_secret_/.test(key)) return 'service_role';
  try { return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(key.split('.')[1] + '==='.slice((key.split('.')[1].length + 3) % 4))).getDataAsString()).role || ''; }
  catch (e) { return ''; }
}
/** Arrêt de la collecte automatique */
function arreter() { clearTriggers_('collect'); PropertiesService.getScriptProperties().deleteProperty('INSTALLED'); log_('Installation', 'Collecte automatique arrêtée'); }
/** Test rapide depuis l'éditeur */
function testConnexions() {
  const out = [];
  try { sbReq_('get', 'params?select=key&limit=1'); out.push('Supabase OK'); } catch (e) { out.push('Supabase : ' + e.message); }
  try { PropertiesService.getScriptProperties().deleteProperty('GEO_SESSION'); geoAuth_(true); out.push('Geotab OK'); } catch (e) { out.push('Geotab : ' + e.message); }
  console.log(out.join('\n'));
  return out.join('\n');
}

// ---------- Reprise de l'ancien Google Sheet (une fois, par étapes) ----------
// [onglet, clé H, mode] : mode = table de référence (clé de mise à jour) ou données (final / live)
const IMPORT_TABLES = [
  ['PARAMETRES', 'PARAM'], ['VEHICULES', 'VEH', 'key'], ['PLAQUES', 'PLATES'], ['REGLES', 'RULE', 'id'], ['CONTRATS', 'CTR', 'num'], ['CHAUFFEURS', 'DRV', 'code'],
  ['DATA_SYNC', 'SYNC', 'id'], ['DATA_TRAJETS', 'TRIP', 'final'], ['DATA_RALENTI', 'IDL', 'final'], ['DATA_EVENEMENTS', 'EVT', 'final'],
  ['DATA_CARBURANT', 'FUEL', 'final'], ['DATA_NIVEAU', 'LVL', 'final'], ['LIVE_TRAJETS', 'TRIP', 'live'], ['LIVE_RALENTI', 'IDL', 'live'],
  ['LIVE_EVENEMENTS', 'EVT', 'live'], ['LIVE_CARBURANT', 'FUEL', 'live'], ['LIVE_NIVEAU', 'LVL', 'live'], ['DATA_JOURNALIER', 'JRN', 'id'], ['ALERTES', 'ALERT', 'id']
];
/**
 * Lecture rapide d'un onglet par l'API Sheets (valeurs brutes, dates en numéro de série).
 * Si l'API Google Sheets n'est pas activée dans le projet Google du script (projet caché, non modifiable),
 * lecture directe du classeur (SpreadsheetApp, dates déjà converties) : plus lente, mais sans réglage à faire.
 */
function sheetValues_(id, range) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEETS_VIA_APP') !== '1') {
    const r = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + encodeURIComponent(range) +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    const code = r.getResponseCode(), text = r.getContentText();
    if (code === 400 && /Unable to parse range/.test(text)) return null;   // onglet absent
    if (code === 200) return JSON.parse(text).values || [];
    if (code !== 403 || !/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(text))
      throw new Error('Lecture du Sheet ' + range + ' : HTTP ' + code + ' ' + text.slice(0, 200));
    props.setProperty('SHEETS_VIA_APP', '1');
    log_('Reprise du Google Sheet', 'API Google Sheets non activée : lecture directe du classeur (plus lente, rien à faire)');
  }
  return sheetValuesApp_(id, range);
}
/** Même lecture par SpreadsheetApp. range = « Onglet!A2:Z4001 » ou « Onglet!1:1 » */
function sheetValuesApp_(id, range) {
  const m = String(range).match(/^(.*)!(?:([A-Z]+)(\d+):([A-Z]+)(\d+)|(\d+):(\d+))$/);
  if (!m) throw new Error('Plage non reconnue : ' + range);
  const sh = SpreadsheetApp.openById(id).getSheetByName(m[1]);
  if (!sh) return null;
  const lr = sh.getLastRow(), lc = sh.getLastColumn();
  let r0, r1, c0, c1;
  if (m[6]) { r0 = +m[6]; r1 = +m[7]; c0 = 1; c1 = lc; } else { c0 = colToIndex_(m[2]); r0 = +m[3]; c1 = colToIndex_(m[4]); r1 = +m[5]; }
  r1 = Math.min(r1, lr); c1 = Math.min(c1, lc);
  if (r1 < r0 || c1 < c0) return [];
  const v = sh.getRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1).getValues();
  while (v.length && !v[v.length - 1].some(x => x !== '' && x !== null)) v.pop();
  if (m[6]) v.forEach(row => { while (row.length && row[row.length - 1] === '') row.pop(); });   // en-têtes : comme l'API, sans cellules vides en fin
  return v;
}
function sheetTz_(id) {
  const r = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=properties.timeZone',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  try { return JSON.parse(r.getContentText()).properties.timeZone || TZ; } catch (e) { return TZ; }
}
/** Numéro de série Sheets (heure locale du classeur) -> Date */
function serialToDate_(v, tz) {
  const wall = Math.round((v - 25569) * DAY);   // 25569 = 01/01/1970
  const z = Utilities.formatDate(new Date(wall), tz, 'Z'), off = (z[0] === '-' ? -1 : 1) * (+z.substr(1, 2) * 60 + +z.substr(3, 2));
  let t = wall - off * MIN;
  const z2 = Utilities.formatDate(new Date(t), tz, 'Z'), off2 = (z2[0] === '-' ? -1 : 1) * (+z2.substr(1, 2) * 60 + +z2.substr(3, 2));
  if (off2 !== off) t = wall - off2 * MIN;   // changement d'heure
  return new Date(t);
}
const IMPORT_BATCH = 4000;
function importStep_(t0) {
  const props = PropertiesService.getScriptProperties(), id = String(props.getProperty('OLD_SHEET_ID') || DEFAULT_OLD_SHEET_ID).trim();
  let steps = JSON.parse(props.getProperty('IMPORT_STEPS') || '[]'), pos = +(props.getProperty('IMPORT_POS') || 0);
  const tz = props.getProperty('IMPORT_TZ') || sheetTz_(id); props.setProperty('IMPORT_TZ', tz);
  const info = [];
  while (steps.length && Date.now() - t0 < MAX_RUN_MS - 60000) {
    const name = steps[0];
    if (name === 'fin') {
      memoClear_();
      try { importVehicles(true); } catch (e) { info.push('véhicules : ' + e.message); }
      try { syncRules_(); } catch (e) { info.push('règles : ' + e.message); }
      try { rekeyAll_(); refreshDrivers_(); } catch (e) { info.push(e.message); }
      markDirty_(addDays_(localDay_(new Date()), -3));
      props.setProperty('IMPORT_DONE', '1'); props.deleteProperty('IMPORT_POS');
      steps.shift(); break;
    }
    const def = IMPORT_TABLES.find(x => x[0] === name), k = def[1], mode = def[2];
    const n = importSheet_(id, tz, name, k, mode, pos);
    if (n.done) { info.push(name + ' : ' + (pos + n.rows) + ' lignes'); steps.shift(); pos = 0; }
    else pos += n.rows;
    props.setProperty('IMPORT_POS', String(pos));
    props.setProperty('IMPORT_STEPS', JSON.stringify(steps));
  }
  if (!steps.length) props.deleteProperty('IMPORT_STEPS');
  log_('Reprise du Google Sheet', (info.join(' | ') || 'en cours') + (steps.length ? ' | ' + steps.length + ' étapes restantes, reprise dans 5 min' : ' | TERMINÉE'), t0);
}
/** Importe un lot de lignes d'un onglet à partir de la ligne pos (0 = première ligne de données). Retourne {rows, done}. */
function importSheet_(id, tz, name, k, mode, pos) {
  if (k === 'PARAM') {
    const v = sheetValues_(id, name + '!A4:B200') || [], byLabel = {}; PARAM_DEFS.forEach(d => { byLabel[d[1]] = d[0]; });
    v.forEach(r => { const key = byLabel[String(r[0] || '').trim()]; if (key && r[1] !== '' && r[1] !== undefined) setParam_(key, r[1]); });
    return { rows: v.length, done: true };
  }
  const headers = k === 'PLATES' ? H.PLATES : H[k];
  const head = (sheetValues_(id, name + '!1:1') || [[]])[0] || [];
  if (!head.length) return { rows: 0, done: true };
  const hi = idx_(head.map(String)), last = colLetter_(head.length);
  const v = sheetValues_(id, name + '!A' + (pos + 2) + ':' + last + (pos + 1 + IMPORT_BATCH)) || [];
  const cols = DB[k].cols;
  const rows = v.filter(r => r.some(x => x !== '' && x !== null)).map(r => headers.map((h, i) => {
    let x = hi[h] !== undefined ? r[hi[h]] : '';
    if (x === undefined || x === null) x = '';
    if (typeof x === 'number' && (DB_TS[cols[i]] || DB_DATE[cols[i]])) x = serialToDate_(x, tz);
    return x;
  }));
  if (rows.length) {
    if (k === 'PLATES') {
      const objs = rows.map(r => toDb_('PLATES', r)).filter(o => o.old_plate || o.new_plate);
      if (objs.length) sbReq_('post', 'plate_changes', objs, { Prefer: 'return=minimal' });
    } else if (mode === 'final' || mode === 'live') {
      const objs = rows.map(r => toDb_(k, r, mode === 'final')).filter(o => o.id && o.vehicle_key && o.vday);
      for (let i = 0; i < objs.length; i += 1000) dbRpc_('put_rows', { p_table: DB[k].table, p_keys: [], p_rows: objs.slice(i, i + 1000), p_final: mode === 'final' });
    } else {
      const seen = {}, objs = rows.map(r => toDb_(k, r)).filter(o => { const x = o[mode]; if (!x || seen[x]) return false; seen[x] = 1; return true; });
      if (k === 'ALERT') objs.forEach(o => { if (!o.status) o.status = 'À traiter'; if (o.comment === null) o.comment = ''; });
      if (k === 'CTR') objs.forEach(o => { if (!o.vehicle_key && o.plate) o.vehicle_key = normPlate_(o.plate); });
      dbUpsert_(DB[k].table, objs, mode);
    }
  }
  return { rows: v.length, done: v.length < IMPORT_BATCH };
}
function colLetter_(n) { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
