// ============================================================================
// SUPABASE (API REST PostgREST) : lecture / écriture de la base
// Propriétés du script : SUPABASE_URL (https://xxxx.supabase.co) et SUPABASE_KEY (clé service_role)
// ============================================================================
H.PLATES = ['Ancienne plaque (WW / W18)', 'Plaque définitive', 'Date du changement', 'Véhicule', 'Statut', 'Note'];

/** Colonnes de la base, dans l'ordre des en-têtes H (le moteur travaille en lignes-tableaux, comme dans le Sheet) */
const DB = {
  TRIP: { table: 'trips', cols: ['id', 'vehicle_key', 'plate', 'day', 'start_at', 'end_at', 'km', 'drive_min', 'still_min', 'evoff_min', 'idle_min',
    'idle_source', 'long_idle_min', 'n_long_idle', 'vmax', 'vavg', 'vmax_gps', 'lim_at_vmax', 'lim_source', 'worst_over', 'speed_at_worst',
    'lim_at_worst', 'worst_time', 'fuel_l', 'fuel_source', 'ecu_l', 'idle_fuel_l', 'idle_fuel_source', 'lat', 'lon', 'driver_code', 'driver_name', 'contract_num'] },
  IDL: { table: 'idles', cols: ['id', 'vehicle_key', 'plate', 'trip_id', 'day', 'start_at', 'end_at', 'stop_min', 'engine_min', 'engine_check', 'liters',
    'liters_source', 'lat', 'lon', 'driver_code', 'driver_name', 'contract_num'] },
  EVT: { table: 'events', cols: ['id', 'vehicle_key', 'plate', 'day', 'start_at', 'end_at', 'dur_s', 'km', 'rule_id', 'rule_name', 'driver_code', 'driver_name', 'contract_num'] },
  FUEL: { table: 'fuel', cols: ['id', 'vehicle_key', 'plate', 'day', 'type', 'stop_start', 'stop_end', 'stop_min', 'engine', 'lvl_before', 'lvl_after',
    'delta_pct', 'liters_gauge', 'liters_geotab', 'source', 'lat', 'lon', 'driver_code', 'driver_name', 'contract_num', 'next_driver', 'status'] },
  LVL: { table: 'levels', cols: ['id', 'vehicle_key', 'at', 'pct'] },
  SYNC: { table: 'vehicle_days', cols: ['id', 'vehicle_key', 'day', 'synced_at', 'n_trips', 'n_events', 'n_levels', 'fuel_counter', 'speed_limits'] },
  JRN: { table: 'journal', cols: ['id', 'day', 'plate', 'model', 'driver_code', 'driver_name', 'contract_num', 'contract_start', 'contract_end', 'contract_h',
    'n_trips', 'km', 'drive_h', 'idle_h', 'idle_source', 'long_idle_h', 'n_long_idle', 'fuel_l', 'fuel_km', 'l100', 'fuel_source', 'idle_fuel_l',
    'idle_fuel_source', 'fuel_cost', 'idle_cost', 'vmax', 'lim_at_vmax', 'worst_over', 'n_events', 'danger_pts', 'score', 'n_fills', 'fill_l',
    'n_siphon', 'siphon_l', 'km_off_contract'] },
  ALERT: { table: 'alerts', cols: ['id', 'day', 'time', 'plate', 'driver_code', 'driver_name', 'type', 'severity', 'detail', 'value', 'status', 'comment'] },
  VEH: { table: 'vehicles', cols: ['plate', 'key', 'brand', 'model', 'fuel', 'vin', 'geotab_id', 'geotab_name', 'tank_l', 'ref_l100', 'revenue', 'active', 'last_sync', 'other_plates'] },
  DRV: { table: 'drivers', cols: ['code', 'name', 'other_names', 'phone', 'email', 'first_contract', 'last_contract', 'n_contracts', 'status', 'detected_at', 'note'] },
  CTR: { table: 'contracts', cols: ['num', 'client_code', 'name', 'plate', 'vehicle_key', 'model', 'start_at', 'end_at', 'status', 'origin', 'phone', 'email',
    'comment', 'imported_at', 'updated_at'] },
  RULE: { table: 'rules', cols: ['id', 'name', 'weight', 'category', 'n_events', 'note'] },
  PLATES: { table: 'plate_changes', cols: ['old_plate', 'new_plate', 'changed_on', 'vehicle', 'status', 'note'] }
};
const DB_TS = { start_at: 1, end_at: 1, stop_start: 1, stop_end: 1, at: 1, synced_at: 1, contract_start: 1, contract_end: 1, last_sync: 1,
  first_contract: 1, last_contract: 1, detected_at: 1, imported_at: 1, updated_at: 1 };
const DB_DATE = { day: 1, changed_on: 1, vday: 1 };
const DB_NUM = {};
['km', 'drive_min', 'still_min', 'evoff_min', 'idle_min', 'long_idle_min', 'n_long_idle', 'vmax', 'vavg', 'vmax_gps', 'lim_at_vmax', 'worst_over',
  'speed_at_worst', 'lim_at_worst', 'fuel_l', 'ecu_l', 'idle_fuel_l', 'lat', 'lon', 'stop_min', 'engine_min', 'liters', 'dur_s', 'lvl_before', 'lvl_after',
  'delta_pct', 'liters_gauge', 'liters_geotab', 'pct', 'n_trips', 'n_events', 'n_levels', 'contract_h', 'drive_h', 'idle_h', 'long_idle_h',
  'fuel_km', 'l100', 'fuel_cost', 'idle_cost', 'danger_pts', 'score', 'n_fills', 'fill_l', 'n_siphon', 'siphon_l', 'km_off_contract', 'tank_l',
  'ref_l100', 'revenue', 'n_contracts', 'weight', 'n_events'].forEach(c => { DB_NUM[c] = 1; });
const DB_INT = { n_long_idle: 1, n_trips: 1, n_events: 1, n_levels: 1, n_fills: 1, n_siphon: 1, n_contracts: 1 };
const DATA_KEYS = ['TRIP', 'IDL', 'EVT', 'FUEL', 'LVL'];

/** Ligne-tableau (ordre H) -> objet base. final : true = journée finalisée, false = temps réel, undefined = pas de colonne */
function toDb_(k, r, final) {
  const cols = DB[k].cols, o = {};
  cols.forEach((c, i) => {
    let v = r[i];
    if (v === '' || v === undefined || v === null || (typeof v === 'number' && !isFinite(v))) { o[c] = null; return; }
    if (DB_TS[c]) { const d = toDate_(v); o[c] = d ? d.toISOString() : null; }
    else if (DB_DATE[c]) { o[c] = toDayStr_(v) || null; }
    else if (DB_NUM[c]) { const n = num_(v, NaN); o[c] = isFinite(n) ? (DB_INT[c] ? Math.round(n) : n) : null; }
    else o[c] = String(v);
  });
  if (DATA_KEYS.indexOf(k) >= 0) { o.vday = rowDay_(k, r, idx_(H[k])); o.final = !!final; }
  if (k === 'JRN' || k === 'ALERT') o.vehicle_key = r[idx_(H[k])['Plaque']] ? plateKey_(r[idx_(H[k])['Plaque']]) : null;
  return o;
}
/** Objet base -> ligne-tableau (ordre H) avec des Date comme dans le Sheet */
function fromDb_(k, o) {
  return DB[k].cols.map(c => {
    const v = o[c];
    if (v === null || v === undefined) return '';
    if (DB_TS[c]) return new Date(v);
    if (DB_DATE[c]) return dayToDate_(String(v).slice(0, 10));
    return v;
  });
}

// ---------- Appels REST ----------
function sbConf_() {
  const p = PropertiesService.getScriptProperties();
  const url = String(p.getProperty('SUPABASE_URL') || DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, ''), key = String(p.getProperty('SUPABASE_KEY') || '').trim();
  if (!url || !key) throw new Error('Supabase non configuré : propriété du script SUPABASE_KEY (clé service_role).');
  return { url, key, rest: p.getProperty('SUPABASE_REST_PATH') || '/rest/v1/' };
}
function sbReq_(method, path, body, headers) {
  const c = sbConf_();
  const opt = { method, muteHttpExceptions: true, contentType: 'application/json',
    headers: Object.assign({ apikey: c.key }, /^sb_/.test(c.key) ? {} : { Authorization: 'Bearer ' + c.key }, headers || {}) };   // nouvelles clés sb_secret_ : en-tête apikey seul
  if (body !== undefined) opt.payload = JSON.stringify(body);
  let last = '';
  for (let a = 0; a < 4; a++) {
    const r = UrlFetchApp.fetch(c.url + c.rest + path, opt), code = r.getResponseCode();
    if (code < 300) { const t = r.getContentText(); return t ? JSON.parse(t) : null; }
    last = 'HTTP ' + code + ' ' + String(r.getContentText()).slice(0, 400);
    if (code >= 500 || code === 429 || code === 408) { Utilities.sleep(1500 * (a + 1)); continue; }
    break;
  }
  throw new Error('Supabase ' + method + ' ' + path.split('?')[0] + ' : ' + last);
}
const enc_ = v => encodeURIComponent(v);
/** Lecture paginée (1 000 lignes par page côté Supabase) */
function dbSelect_(table, query, order) {
  const out = [], page = 1000;
  for (let off = 0; ; off += page) {
    const q = (query ? query + '&' : '') + 'order=' + (order || 'id') + '&limit=' + page + '&offset=' + off;
    const rows = sbReq_('get', table + '?' + q) || [];
    rows.forEach(r => out.push(r));
    if (rows.length < page) break;
  }
  return out;
}
/** Insertion ou mise à jour par clé (seules les colonnes envoyées sont modifiées) */
function dbUpsert_(table, objs, onConflict) {
  for (let i = 0; i < objs.length; i += 500) {
    sbReq_('post', table + '?on_conflict=' + (onConflict || 'id'), objs.slice(i, i + 500),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }
}
function dbDelete_(table, filter) { return sbReq_('delete', table + '?' + filter, undefined, { Prefer: 'return=minimal' }); }
function dbRpc_(fn, args) { return sbReq_('post', 'rpc/' + fn, args || {}); }

/** Données d'analyse à partir de fromDay (lignes finalisées + temps réel), mémorisées pour l'exécution */
let MEMO_ = {};
function memoClear_() { MEMO_ = {}; }
function readData_(k, fromDay, toDay) {
  const mk = 'D|' + k + '|' + (fromDay || '') + '|' + (toDay || '');
  if (MEMO_[mk]) return MEMO_[mk];
  const t = DB[k].table, dc = k === 'LVL' ? 'vday' : 'day';
  const q = [fromDay ? dc + '=gte.' + fromDay : '', toDay ? dc + '=lte.' + toDay : ''].filter(Boolean).join('&');
  const ord = { TRIP: 'start_at,id', IDL: 'start_at,id', EVT: 'start_at,id', FUEL: 'stop_start,id', LVL: 'at,id' }[k];   // ordre chronologique, comme le Sheet
  const rows = dbSelect_(t, 'select=' + DB[k].cols.join(',') + (q ? '&' + q : ''), ord).map(o => fromDb_(k, o));
  return (MEMO_[mk] = { rows, I: idx_(H[k]), headers: H[k] });
}
/** Table de référence entière (petites tables) en lignes-tableaux */
function readRef_(k, query) {
  const mk = 'R|' + k + '|' + (query || '');
  if (MEMO_[mk]) return MEMO_[mk];
  const keyCol = { VEH: 'key', DRV: 'code', CTR: 'num', RULE: 'id', PLATES: 'id' }[k] || 'id';
  const rows = dbSelect_(DB[k].table, 'select=' + DB[k].cols.join(',') + (query ? '&' + query : ''), keyCol).map(o => fromDb_(k, o));
  return (MEMO_[mk] = { rows, I: idx_(H[k]), headers: H[k] });
}

// ---------- Journal technique (onglet « Journal » du site) ----------
function log_(action, detail, t0) {
  try { sbReq_('post', 'logs', [{ action, detail: String(detail).slice(0, 4000), dur_s: t0 ? r1_((Date.now() - t0) / 1000) : null }], { Prefer: 'return=minimal' }); }
  catch (e) { console.log(action + ' : ' + detail + ' (journal indisponible : ' + e.message + ')'); }
}
