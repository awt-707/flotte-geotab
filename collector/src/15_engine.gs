// ============================================================================
// MOTEUR v6 (repris tel quel du Google Sheet, sauf lecture / écriture)
// ============================================================================
function idx_(headers) { const o = {}; headers.forEach((h, i) => { o[String(h).trim()] = i; }); return o; }
function num_(v, d) { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isNaN(n) ? (d === undefined ? 0 : d) : n; }
function r1_(x) { return Math.round(x * 10) / 10; }
function r2_(x) { return Math.round(x * 100) / 100; }
function deacc_(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function normTxt_(s) { return deacc_(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function normPlate_(s) {
  const t = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return t.replace(/[^0-9]/g, '') + t.replace(/[^A-Z]/g, '');
}
function tzOffsetMin_(date) {
  const t = new Date(date).getTime(); let lo = 0, hi = MA_TZ.length - 1;
  while (lo < hi) { const k = (lo + hi + 1) >> 1; if (MA_TZ[k][0] <= t) lo = k; else hi = k - 1; }
  return MA_TZ[lo][1];
}
/** Date au format donné, à l'heure du Maroc (MA_TZ) */
function fmtMa_(d, pat) { const t = new Date(d).getTime(); return Utilities.formatDate(new Date(t + tzOffsetMin_(t) * MIN), 'UTC', pat); }
function localToDate_(y, mo, d, h, mi) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0));
  return new Date(guess.getTime() - tzOffsetMin_(guess) * MIN);
}
function localDay_(d) { return fmtMa_(d, 'yyyy-MM-dd'); }
function localHM_(d) { return fmtMa_(d, 'HH:mm'); }
function fmtDay_(day) { const p = day.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function fmtDT_(d) { return d ? fmtMa_(d, 'dd/MM HH:mm') : ''; }
function dayBounds_(day) {
  const p = day.split('-').map(Number);
  const start = localToDate_(p[0], p[1], p[2], 0, 0);
  const n = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  const end = localToDate_(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0);
  return { start, end };
}
function dayToDate_(day) { return new Date(dayBounds_(day).start.getTime() + 12 * HOUR); }
function addDays_(day, n) {
  const p = day.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
function toDate_(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (v === '' || v == null) return null;
  return parseLocalDT_(v);
}
function toDayStr_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : localDay_(v);
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
  return '';
}
function parseLocalDT_(v) {
  if (v instanceof Date) return v;
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\D+?(\d{1,2})\s*[hH:]\s*(\d{2})?)?/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return localToDate_(y, +m[2], +m[1], +(m[4] || 0), +(m[5] || 0)); }
  m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return localToDate_(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function parseDur_(s) {
  if (s == null || s === '') return 0;
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + parseFloat(m[4]);
}
function median_(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function clean_(rows) { return rows.map(r => r.map(v => (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) ? '' : v)); }
function rowOf_(headers, obj) { return headers.map(h => obj[h] === undefined || obj[h] === null ? '' : obj[h]); }
function fit_(r, n) { const o = r.slice(0, n); while (o.length < n) o.push(''); return o; }
function tms_(v) { const d = toDate_(v); return d ? d.getTime() : 0; }
function geoRaw_(server, method, params) {
  const resp = UrlFetchApp.fetch('https://' + server + '/apiv1', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ method: method, params: params })
  });
  return geoParse_(resp, method);
}
function geoFetchAll_(reqs) {
  const go = s => UrlFetchApp.fetchAll(reqs.map(r => ({ url: 'https://' + s.server + '/apiv1', method: 'post', contentType: 'application/json',
    muteHttpExceptions: true, payload: JSON.stringify({ method: r.method, params: Object.assign({}, r.params, { credentials: s.credentials }) }) })));
  const authErr = r => { const t = r.getContentText(); return t.length < 5000 && /"error"/.test(t) && /InvalidUser|Credential|DbUnavailable/i.test(t); };
  let resps = go(geoAuth_(false));
  if (resps.some(authErr)) resps = go(geoAuth_(true));
  return resps.map((resp, i) => () => { try { return { res: geoParse_(resp, reqs[i].method) }; } catch (e) { return { err: e }; } });
}
function geoParse_(resp, method) {
  let j;
  try { j = JSON.parse(resp.getContentText()); }
  catch (e) { throw new Error('Réponse Geotab illisible (HTTP ' + resp.getResponseCode() + ')'); }
  if (j.error) {
    const er = j.error;
    const name = (er.errors && er.errors[0] && er.errors[0].name) || (er.data && er.data.type) || er.name || '';
    const e = new Error('Geotab ' + method + ' : ' + (er.message || name));
    e.geoName = name;
    throw e;
  }
  return j.result;
}
function geoAuth_(force) {
  const props = PropertiesService.getScriptProperties();
  if (!force) { const c = props.getProperty('GEO_SESSION'); if (c) return JSON.parse(c); }
  const P = params_();
  const pwd = props.getProperty('GEO_PWD');
  const user = props.getProperty('GEO_USER') || P.geoUser;
  if (!user || !pwd) throw new Error('Accès Geotab non configuré : menu Flotte Geotab > Configurer accès Geotab.');
  const base = String(P.geoServer || 'my.geotab.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const res = geoRaw_(base, 'Authenticate', { database: String(P.geoDb), userName: user, password: pwd });
  const server = res.path && res.path !== 'ThisServer' ? res.path : base;
  const sess = { server: server, credentials: res.credentials };
  props.setProperty('GEO_SESSION', JSON.stringify(sess));
  return sess;
}
function geoCall_(method, params) {
  let s = geoAuth_(false);
  try { return geoRaw_(s.server, method, Object.assign({}, params, { credentials: s.credentials })); }
  catch (e) {
    if (/InvalidUser|Credential|session|DbUnavailable/i.test((e.geoName || '') + ' ' + e.message)) {
      s = geoAuth_(true);
      return geoRaw_(s.server, method, Object.assign({}, params, { credentials: s.credentials }));
    }
    throw e;
  }
}
function geoMulti_(calls) { return geoCall_('ExecuteMultiCall', { calls: calls }); }
function iso_(d) { return new Date(d).toISOString(); }
function modelDefaults_(model) {
  const m = String(model || '').toUpperCase();
  for (const k in MODEL_DEFAULTS) if (k !== '_' && m.indexOf(k) >= 0) return MODEL_DEFAULTS[k];
  return MODEL_DEFAULTS._;
}
function colToIndex_(col) {
  let n = 0; String(col).toUpperCase().replace(/[^A-Z]/g, '').split('').forEach(c => { n = n * 26 + c.charCodeAt(0) - 64; });
  return n;
}
function importVehicles(silent) {
  const t0 = Date.now(), P = params_();
  // Liste du parc injectée depuis le site (table parc), qui remplace le Sheet « ETAT PARC » : plaque, marque, modèle, VIN, carburant
  const data = parcData_(P);
  const cPl = 0, cMa = 1, cMo = 2, cVin = 3, cCa = 4;
  const T = readTable_(S.VEH), I = idx_(H.VEH);
  const byKey = {}, known = {}; T.rows.forEach(r => { byKey[String(r[I['Clé']])] = r; platesOf_(r, I).forEach(p => { known[normPlate_(p)] = 1; }); });
  let added = 0;
  const out = {};
  data.slice(1).forEach(r => {
    const plate = String(r[cPl] || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!plate || plate.length < 4) return;
    const key = normPlate_(plate);
    const old = byKey[key];
    const d = modelDefaults_(r[cMo]);
    const row = old ? old.slice() : new Array(H.VEH.length).fill('');
    while (row.length < H.VEH.length) row.push('');
    row[I['Plaque']] = plate; row[I['Clé']] = key;
    row[I['Marque']] = r[cMa]; row[I['Modèle']] = r[cMo]; row[I['VIN']] = r[cVin]; row[I['Carburant']] = r[cCa];
    if (row[I['Réservoir (L)']] === '') row[I['Réservoir (L)']] = d.tank;
    if (row[I['Actif']] === '') row[I['Actif']] = 'OUI';
    if (!old && !known[key]) added++;
    out[key] = row;
  });
  T.rows.forEach(r => { const k = String(r[I['Clé']]); if (!out[k]) out[k] = r; });
  // Un même véhicule (même châssis) peut apparaître sous deux plaques : plaque W18/WW provisoire puis plaque définitive.
  // Une seule ligne est gardée (la plaque qui a l'historique), l'autre devient « Autres plaques » : pas de double comptage.
  const mg = mergeAliases_(out, I);
  const rows = Object.values(out).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // journal : seulement les regroupements nouveaux ou modifiés
  const prev = {}; T.rows.forEach(r => { prev[String(r[I['Clé']])] = String(r[I['Plaque']]) + '|' + String(r[I['Autres plaques']] || ''); });
  const merged = rows.filter(r => String(r[I['Autres plaques']] || '') && prev[String(r[I['Clé']])] !== String(r[I['Plaque']]) + '|' + String(r[I['Autres plaques']] || ''))
    .map(r => r[I['Plaque']] + ' = ' + r[I['Autres plaques']]);
  writeTable_(S.VEH, H.VEH, rows);
  log_('Import véhicules', rows.length + ' véhicules (' + added + ' nouveaux)' + (merged.length ? ' | même véhicule, plaques regroupées : ' + merged.join(' ; ') : ''), t0);
  if (silent !== true) toast_(rows.length + ' véhicules, ' + added + ' nouveaux.', 'Import véhicules');
  memoClear_();
  const nCtr = canonContracts_();
  // Une plaque devenue « autre plaque » d'un véhicule : ses données éventuelles sont rattachées à la clé historique
  const was = {}; T.rows.forEach(r => { was[String(r[I['Clé']])] = 1; });
  const gone = mg.aliased.filter(k => was[k]);
  if ((gone.length || nCtr) && true) { try { rekeyAll_(); } catch (e) { log_('Plaques', e.message); } }
  try { mapGeotabDevices(true); } catch (e) { log_('Association Geotab', e.message); }
  try { syncPlatesTab_(); } catch (e) { log_('Plaques', e.message); }
  return rows.length;
}
function isTempPlate_(p) { const n = normPlate_(p); return /WW$/.test(n) || /W18/.test(String(p).toUpperCase()) || /^W\d/.test(String(p).toUpperCase()); }
function platesOf_(r, I) { return [String(r[I['Plaque']] || '')].concat(String(r[I['Autres plaques']] || '').split(/[,;]\s*/)).map(x => x.trim()).filter(Boolean); }
function mergeAliases_(out, I) {
  const keys = Object.keys(out), parent = {}, msgs = [], aliased = [];
  keys.forEach(k => { parent[k] = k; });
  const find = k => { while (parent[k] !== k) k = parent[k] = parent[parent[k]]; return k; };
  const union = (a, b) => { if (parent[a] === undefined || parent[b] === undefined) return; a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const by = {};
  keys.forEach(k => {
    const vin = String(out[k][I['VIN']] || '').toUpperCase().replace(/\s+/g, ''), g = String(out[k][I['Geotab ID']] || '');
    if (vin.length >= 8) (by['V' + vin] = by['V' + vin] || []).push(k);
    if (g) (by['G' + g] = by['G' + g] || []).push(k);
    platesOf_(out[k], I).forEach(p => union(k, normPlate_(p)));
  });
  Object.keys(by).forEach(x => by[x].slice(1).forEach(k => union(by[x][0], k)));
  const pairs = platePairs_(), pk = {};
  pairs.forEach(p => { union(p.oldK, p.newK); pk[p.oldK] = p; pk[p.newK] = p; });
  const hist = {};
  try { keyStats_().forEach(x => { hist[x.vehicle_key] = (x.n_days || 0) + (x.n_contracts || 0); }); } catch (e) { }   // base : historique par clé
  const groups = {}; keys.forEach(k => { const g = find(k); (groups[g] = groups[g] || []).push(k); });
  Object.values(groups).forEach(ks => {
    ks.sort((a, b) => (hist[b] || 0) - (hist[a] || 0) || isTempPlate_(out[b][I['Plaque']]) - isTempPlate_(out[a][I['Plaque']]) || a.localeCompare(b));
    const keep = out[ks[0]];
    let plates = [];
    ks.forEach(k => platesOf_(out[k], I).forEach(p => { if (plates.indexOf(p) < 0) plates.push(p); }));
    // plaques de PLAQUES concernant ce véhicule (même si la plaque définitive n'est pas encore dans le Parc)
    pairs.forEach(p => { if (ks.indexOf(p.oldK) >= 0 || ks.indexOf(p.newK) >= 0 || plates.some(x => normPlate_(x) === p.oldK || normPlate_(x) === p.newK)) [p.old, p.neu].forEach(x => { if (!plates.some(y => normPlate_(y) === normPlate_(x))) plates.push(x); }); });
    if (plates.length < 2 && ks.length < 2) return;
    const declared = pairs.filter(p => plates.some(x => normPlate_(x) === p.newK)).map(p => p.neu);
    const display = declared[declared.length - 1] || plates.find(p => !isTempPlate_(p)) || keep[I['Plaque']];
    ks.slice(1).forEach(k => {
      const r = out[k];
      if (keep[I['Geotab ID']] === '' && r[I['Geotab ID']] !== '') { keep[I['Geotab ID']] = r[I['Geotab ID']]; keep[I['Nom Geotab']] = r[I['Nom Geotab']]; }
      if (keep[I['VIN']] === '' && r[I['VIN']] !== '') keep[I['VIN']] = r[I['VIN']];
      delete out[k]; aliased.push(k);
    });
    const others = plates.filter(p => normPlate_(p) !== normPlate_(display));
    const before = String(keep[I['Plaque']]) + '|' + String(keep[I['Autres plaques']] || '');
    keep[I['Plaque']] = display; keep[I['Autres plaques']] = others.join(', ');
    if (ks.length > 1 || before !== display + '|' + others.join(', ')) msgs.push(display + ' = ' + others.join(', '));
  });
  return { msgs, aliased };
}
function canonMap_() {
  if (MEMO_.__canon) return MEMO_.__canon;
  const T = readTable_(S.VEH), I = idx_(H.VEH), m = {};
  T.rows.forEach(r => {
    const k = String(r[I['Clé']] || ''); if (!k) return;
    m[k] = k;
    platesOf_(r, I).forEach(p => { m[normPlate_(p)] = k; });
  });
  platePairs_().forEach(p => { if (m[p.oldK] && !m[p.newK]) m[p.newK] = m[p.oldK]; else if (m[p.newK] && !m[p.oldK]) m[p.oldK] = m[p.newK]; });
  return (MEMO_.__canon = m);
}
function plateKey_(p) { return canonKey_(normPlate_(p)); }
function canonKey_(key, cm) { key = String(key || ''); const m = cm || canonMap_(); return m[key] || key; }
function mapGeotabDevices(silent) {
  const devs = geoCall_('Get', { typeName: 'Device', resultsLimit: 5000 }) || [];
  const T = readTable_(S.VEH), I = idx_(H.VEH);
  const now = Date.now();
  const active = devs.filter(d => !d.activeTo || new Date(d.activeTo).getTime() > now);
  let mapped = 0; const missing = [];
  const rows = T.rows.map(r => {
    const key = String(r[I['Clé']]), vin = String(r[I['VIN']] || '').toUpperCase();
    const keys = [key].concat(platesOf_(r, I).map(normPlate_));
    const d = active.find(x => keys.indexOf(normPlate_(x.name)) >= 0 || keys.indexOf(normPlate_(x.licensePlate)) >= 0 ||
      (vin && String(x.vehicleIdentificationNumber || '').toUpperCase() === vin));
    if (d) { r[I['Geotab ID']] = d.id; r[I['Nom Geotab']] = d.name; mapped++; } else missing.push(r[I['Plaque']]);
    return r;
  });
  writeTable_(S.VEH, H.VEH, rows);
  memoClear_();
  log_('Association Geotab', mapped + ' associés' + (missing.length ? ', non trouvés : ' + missing.join(', ') : ''));
  if (silent !== true) toast_(mapped + ' véhicules associés à Geotab' + (missing.length ? ' (' + missing.length + ' non trouvés)' : ''), 'Geotab');
}
function vehicles_() {
  if (MEMO_.__veh) return MEMO_.__veh;
  const T = readTable_(S.VEH), I = T.I, P = params_();
  const map = {};
  T.rows.forEach(r => {
    const key = String(r[I['Clé']] || ''); if (!key) return;
    const fuelTxt = String(r[I['Carburant']] || '').toUpperCase();
    const diesel = /GO|GAS ?OIL|GASOIL|DIESEL|GAZOIL/.test(fuelTxt);
    map[key] = {
      key, plate: String(r[I['Plaque']]), model: String(r[I['Modèle']] || ''), brand: String(r[I['Marque']] || ''),
      fuelType: diesel ? 'Gasoil' : 'Essence', price: diesel ? P.priceDiesel : P.priceGas,
      geoId: String(r[I['Geotab ID']] || ''), geoName: String(r[I['Nom Geotab']] || ''),
      tank: num_(r[I['Réservoir (L)']], 0), ref: num_(r[I['Conso réf (L/100)']], 0), revenue: num_(r[I['Recette/contrat (MAD)']], 0),
      active: String(r[I['Actif']] || 'OUI').toUpperCase() !== 'NON',
      aliases: String(r[I['Autres plaques']] || '').split(/[,;]\s*/).filter(Boolean)
    };
  });
  return (MEMO_.__veh = map);
}
function findContract_(cidx, key, t, tolMs) {
  const a = cidx[key] || []; let best = null;
  for (const c of a) if (t >= c.start && t <= c.end) best = c;
  if (best) return best;
  let bd = Infinity;
  for (const c of a) {
    const d = t < c.start ? c.start - t : (t > c.end ? t - c.end : 0);
    if (d <= tolMs && d < bd) { bd = d; best = c; }
  }
  return best;
}
function attrib_(cidx, key, t, tolMs) {
  const c = findContract_(cidx, key, t, tolMs);
  if (c) return { code: c.code, nom: c.nom, num: c.num };
  // Avant le premier contrat connu ou après la dernière information de l'extract : personne n'est mis en cause
  if (!cidx.__range) { let hi = 0; Object.keys(cidx).forEach(k => cidx[k].forEach(x => { hi = Math.max(hi, x.start, x.open ? 0 : x.end); })); cidx.__range = [0, hi]; }
  const f0 = (cidx[key] || [])[0], first = cidx.__first && cidx.__first[key] !== undefined ? cidx.__first[key] : (f0 ? f0.start : null);
  // Avant le premier contrat connu de CE véhicule (contrat démarré avant l'extract) ou après la dernière info de l'extract
  if (first === null || t < first - tolMs || t > cidx.__range[1] + tolMs) return { code: HORS, nom: HORS_PERIODE, num: '' };
  return { code: HORS, nom: 'Hors contrat', num: '' };
}
function ruleCategory_(name) {
  const n = normTxt_(name);
  if (/debranch|unplug|tamper|alimentation du boitier|perte d.alimentation|deconnexion/.test(n)) return 'Boîtier';
  if (/odo|notification|myclicar|rapport|report|etat de parc|zone|entree|entre en|pays|port\b|fourriere|vol\b|vole|antidemarr|immobili|continuous|tow|battery|batterie|tire|pneu|esr|intramuros|72h|72 ?heures/.test(n)) return 'Hors conduite';
  if (/collision|accident|crash/.test(n)) return 'Collision';
  if (/vitesse|speed/.test(n)) return 'Vitesse';
  if (/ceinture|seat ?belt/.test(n)) return 'Ceinture';
  if (/frein|brak/.test(n)) return 'Freinage';
  if (/accel|jackrabbit/.test(n)) return 'Accélération';
  if (/virage|corner/.test(n)) return 'Virage';
  if (/ralenti|idl/.test(n)) return 'Ralenti';
  if (/fault|defaut|moteur|engine|panne/.test(n)) return 'Moteur';
  return 'Hors conduite';
}
function defaultWeight_(name, allNames) {
  if (/^Règle inconnue/.test(name)) return [0, 'Hors conduite', 'Règle non lisible avec ce compte Geotab (non comptée)'];
  const cat = ruleCategory_(name), w = RULE_W[cat] || 0;
  if (!w) return [0, cat, cat === 'Hors conduite' ? 'Règle hors conduite (non comptée)' : 'Non comptée dans le score'];
  const isNew = /\((new|nouveau)\)/i.test(name);
  if (cat !== 'Collision' && !isNew && allNames.some(o => o !== name && ruleCategory_(o) === cat && /\((new|nouveau)\)/i.test(o)))
    return [0, cat, 'Doublon : la version (New) de cette règle est comptée'];
  return [w, cat, ''];
}
function syncRules_() {
  const list = geoCall_('Get', { typeName: 'Rule' }) || [];
  // Règles présentes dans les événements mais absentes de la liste (autre groupe, règle système) : on cherche leur nom
  const known = {}; list.forEach(r => { known[r.id] = 1; });
  const E = readData_(S.EVT, addDays_(localDay_(new Date()), -7)), IE0 = idx_(H.EVT), miss = {};
  E.rows.forEach(r => { const id = String(r[IE0['Règle ID']] || ''); if (id && !known[id]) miss[id] = 1; });
  Object.keys(miss).slice(0, 50).forEach(id => {
    let name = '';
    try { const g = geoCall_('Get', { typeName: 'Rule', search: { id: id } }) || []; name = g[0] && g[0].name; } catch (e) { }
    list.push({ id: id, name: name || ('Règle inconnue ' + id) });
  });
  const T = readTable_(S.RULE), I = idx_(H.RULE), props = PropertiesService.getScriptProperties();
  const reset = false;   // poids saisis conservés   // V6 : nouveaux poids (conduite uniquement, sans doublons)
  const old = {}; T.rows.forEach(r => { old[String(r[I['Règle ID']])] = r; });
  const names = list.map(r => r.name || '');
  const rows = list.map(r => {
    const o = old[r.id], d = defaultWeight_(r.name, names);
    if (o && !reset) { o[I['Règle']] = r.name; o[I['Catégorie']] = d[1]; return o; }
    return [r.id, r.name, d[0], d[1], o ? o[I['Événements (total)']] : 0, d[2]];
  });
  T.rows.forEach(r => { if (!list.find(x => x.id === r[I['Règle ID']])) rows.push(r); });
  rows.sort((a, b) => (b[2] > 0) - (a[2] > 0) || String(a[3]).localeCompare(String(b[3])) || String(a[1]).localeCompare(String(b[1])));
  writeTable_(S.RULE, H.RULE, rows);
  if (reset) props.setProperty('RULES_V6', '1');
  memoClear_();
}
function rulesMap_() {
  if (MEMO_.__rules) return MEMO_.__rules;
  const T = readTable_(S.RULE), I = idx_(H.RULE), m = {};
  T.rows.forEach(r => { m[String(r[I['Règle ID']])] = { name: String(r[I['Règle']]), w: num_(r[I['Poids danger']]), cat: String(r[I['Catégorie']]) }; });
  return (MEMO_.__rules = m);
}
function checkEngine_() {
  const props = PropertiesService.getScriptProperties(), cur = props.getProperty('ENGINE_V');
  if (cur === ENGINE_V) return;
  if (cur) props.setProperty('ENGINE_SINCE', String(Date.now()));   // 1re installation : les jours déjà calculés par le moteur V5 restent valables
  props.setProperty('ENGINE_V', ENGINE_V);
}
function syncLease_() {
  const l = JSON.parse(PropertiesService.getScriptProperties().getProperty('SYNC_LEASE') || 'null');
  return l && l.until > Date.now() ? l : null;
}
function syncQueueStep_(t0, budgetMs) {
  const props = PropertiesService.getScriptProperties();
  const me = String(Date.now()) + Math.random().toString(36).slice(2, 7);
  const lease = () => props.setProperty('SYNC_LEASE', JSON.stringify({ id: me, until: Date.now() + LEASE_MS }));
  lease();
  try {
    checkEngine_();
    let q = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]');
    // Les journées pas encore terminées depuis 12 h sont couvertes par le temps réel, pas par la file
    const nowMs = Date.now(); q = q.filter(x => dayBounds_(x.d).end.getTime() + 12 * HOUR <= nowMs);
    if (!q.length) { props.setProperty('SYNC_QUEUE', '[]'); return { done: 0, left: 0, warn: [], tm: '' }; }
    const handled = {};
    const P = params_(), veh = vehicles_();
    try { syncRules_(); } catch (e) { log_('Règles', e.message); }
    const acc = newAcc_();
    let done = 0, lastBatch = 0, failed = false;
    const flushEst = Math.min(+(props.getProperty('SYNC_FLUSH_MS') || 30000), 90000);
    let nBatch = 0;
    while (q.length && (nBatch++ === 0 || Date.now() - t0 + Math.max(60000, 1.3 * lastBatch) + flushEst < budgetMs)) {
      const tb = takeBatch_(q, veh), tb0 = Date.now();
      const kept = {}; tb.rest.forEach(x => { kept[x.d + '|' + x.k] = 1; });
      if (!tb.blocks.length) { q.forEach(x => { if (!kept[x.d + '|' + x.k]) handled[x.d + '|' + x.k] = 1; }); q = tb.rest; break; }
      let r;
      try { r = syncBlocks_(tb.blocks, P, acc); }
      catch (e) { acc.warn.push('Téléchargement Geotab : ' + e.message); failed = true; break; }
      const again = {}; r.retry.concat(r.later).forEach(x => { again[x.d + '|' + x.k] = 1; });
      q.forEach(x => { const id = x.d + '|' + x.k; if (!kept[id] && !again[id]) handled[id] = 1; });
      q = r.retry.concat(tb.rest).concat(r.later);
      done += r.done; lastBatch = Date.now() - tb0;
      lease();
      if (r.limited) { acc.warn.push('Limite d\'appels Geotab atteinte : reprise dans 1 min'); break; }
    }
    const f0 = Date.now();
    flush_(acc);
    if (acc.days.length) {
      props.setProperty('SYNC_FLUSH_MS', String(Date.now() - f0));
      markDirty_(acc.days.map(id => id.split('|')[1]).sort()[0]);
    }
    acc.warn = acc.warn.filter((w, i, a) => a.indexOf(w) === i);
    const stored = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]'), seen = {};
    q = q.concat(stored).filter(x => { const id = x.d + '|' + x.k; if (handled[id] || seen[id]) return false; seen[id] = 1; return true; });
    props.setProperty('SYNC_QUEUE', JSON.stringify(q));
    const fails = failed ? +(props.getProperty('SYNC_FAILS') || 0) + 1 : 0;
    props.setProperty('SYNC_FAILS', String(fails));
    if (done >= 4) {
      const old = +(props.getProperty('SYNC_RATE') || 0), now = (Date.now() - t0) / done;
      props.setProperty('SYNC_RATE', String(old ? 0.6 * old + 0.4 * now : now));
    }
    const tm = acc.tm ? ' [Geotab ' + Math.round(acc.tm.dl / 1000) + ' s, calcul ' + Math.round(acc.tm.calc / 1000) + ' s, écriture ' + Math.round((Date.now() - f0) / 1000) + ' s]' : '';
    if (q.length && fails >= 3) {
      log_('Synchro', 'Arrêt après 3 échecs de suite, ' + q.length + ' véhicule-jours en attente. Vérifiez la connexion Geotab. ' + acc.warn.join(' ; '), t0);
      props.setProperty('SYNC_QUEUE', '[]'); props.setProperty('SYNC_FAILS', '0');
      return { done, left: 0, warn: acc.warn, tm, stop: true };
    }
    return { done, left: q.length, warn: acc.warn, tm };
  } finally {
    const l = JSON.parse(props.getProperty('SYNC_LEASE') || 'null');
    if (l && l.id === me) props.deleteProperty('SYNC_LEASE');
  }
}
function clearTriggers_(fn) { ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); }); }
function etaMin_(n) {
  const rate = +(PropertiesService.getScriptProperties().getProperty('SYNC_RATE') || 0);
  if (!rate || !n) return 0;
  const perRun = Math.max(1, Math.floor(MAX_RUN_MS / rate));
  return Math.max(1, Math.ceil((n * rate + Math.floor((n - 1) / perRun) * 75000) / 60000));
}
function takeBatch_(q, veh) {
  const blocks = [], used = {}, inBatch = {};
  for (let i = 0; i < q.length && blocks.length < SYNC_PARALLEL; i++) {
    if (used[i]) continue;
    const it = q[i], v = veh[it.k];
    if (!v || !v.geoId) { used[i] = 1; continue; }
    if (inBatch[it.k]) continue;
    const b = { v, days: [it.d], tries: it.tries || 0 }; used[i] = 1; inBatch[it.k] = 1;
    for (let j = i + 1; !it.solo && j < q.length && b.days.length < SYNC_CHUNK_DAYS; j++)
      if (!used[j] && !q[j].solo && q[j].k === it.k && q[j].d === addDays_(b.days[b.days.length - 1], 1)) { b.days.push(q[j].d); used[j] = 1; }
    blocks.push(b);
  }
  return { blocks, rest: q.filter((x, i) => !used[i]) };
}
function blockWin_(days, now) {
  const dayFrom = dayBounds_(days[0]).start.getTime(), dayTo = dayBounds_(days[days.length - 1]).end.getTime();
  return { dayFrom, dayTo, from: dayFrom - 12 * HOUR, to: Math.min(dayTo + 12 * HOUR, now), now };
}
function syncBlocks_(blocks, P, acc) {
  const now = Date.now(), reqs = [], meta = [], retry = [], later = [];
  let done = 0, limited = false;
  blocks.forEach(b => {
    const days = b.days.filter(d => dayBounds_(d).start.getTime() <= now);
    done += b.days.length - days.length;
    if (!days.length) return;
    const bw = blockWin_(days, now), cq = cCalls_(b.v.geoId, bw);
    meta.push({ v: b.v, days, bw, cq, i: reqs.length, tries: b.tries || 0 });
    reqs.push({ method: 'ExecuteMultiCall', params: { calls: cq.calls } },
      { method: 'GetRoadMaxSpeeds', params: { deviceSearch: { id: b.v.geoId }, fromDate: iso_(bw.dayFrom), toDate: iso_(bw.to) } });
  });
  const tf = Date.now(), res = reqs.length ? geoFetchAll_(reqs) : [];
  acc.tm = acc.tm || { dl: 0, calc: 0 }; acc.tm.dl += Date.now() - tf; const tc = Date.now();
  const isLimit = e => /limit|quota|429|too many|OverLimit/i.test((e.geoName || '') + ' ' + e.message);
  meta.forEach(m => {
    const r0 = res[m.i](), r1 = res[m.i + 1](), lbl = m.v.plate + ' ' + m.days.join(', ');
    res[m.i] = res[m.i + 1] = null;   // réponse brute libérée
    if (r0.err) {
      if (isLimit(r0.err)) { limited = true; m.days.forEach(d => retry.push({ d, k: m.v.key })); return; }
      if (m.days.length > 1) { m.days.forEach(d => retry.push({ d, k: m.v.key, solo: 1 })); return; }   // nouvel essai jour par jour
      // Erreur passagère (ex. « Service temporarily unavailable ») : nouvel essai en fin de file, 3 essais au total
      if (m.tries < 2) { later.push({ d: m.days[0], k: m.v.key, solo: 1, tries: m.tries + 1 }); return; }
      acc.warn.push(lbl + ' : ' + r0.err.message + ' (abandon après 3 essais, relancez « Vérifier et réparer les données »)'); done += m.days.length; return;
    }
    const data = m.cq.map(r0.res);
    const trunc = [data.logs].concat(Object.keys(data.sd).map(k => data.sd[k])).some(a => (a || []).length >= GEO_MAX_RESULTS);
    if (trunc && m.days.length > 1) { m.days.forEach(d => retry.push({ d, k: m.v.key, solo: 1 })); return; }   // trop de points : jour par jour
    if (trunc) acc.warn.push(lbl + ' : plus de ' + GEO_MAX_RESULTS + ' points Geotab sur la journée, données incomplètes');
    if (r1.err) { if (isLimit(r1.err)) { limited = true; m.days.forEach(d => retry.push({ d, k: m.v.key, solo: m.days.length === 1 ? 1 : undefined })); return; }
      acc.warn.push(lbl + ' : limites de vitesse indisponibles'); data.road = []; }
    else data.road = r1.res;
    m.days.forEach(d => {
      try { emitVehicleDay_(m.v, d, data, m.bw, P, acc); }
      catch (e) { acc.warn.push(m.v.plate + ' ' + d + ' : ' + e.message); }
      done++;
    });
  });
  acc.tm.calc += Date.now() - tc;
  return { retry, later, limited, done };
}
function emitVehicleDay_(v, day, data, bw, P, acc) {
  const b = dayBounds_(day);
  const win = { dayFrom: b.start.getTime(), dayTo: b.end.getTime(), from: bw.from, to: bw.to, now: bw.now };
  if (win.dayFrom > bw.now) return;
  const o = cAnalyze_(data, win, P);
  o.evts = o.evts.filter(e => keepEvt_(acc.rules, e.rule));
  emitRows_(v, o, P, acc);
  acc.days.push(v.key + '|' + day);
  acc.sync.push([v.key + '|' + day, v.key, dayToDate_(day), new Date(), o.cycles.length, o.evts.length, o.sources.lvlL || o.sources.lvlPct,
    o.sources.fuel ? 'OUI' : 'NON', o.sources.road ? 'OUI' : 'NON']);
}
function keepEvt_(rules, rid) {
  if (!rules) return true;
  const r = rules[String(rid)]; if (!r) return true;
  return r.w > 0 || r.cat === 'Collision' || r.cat === 'Boîtier' || r.cat === 'Moteur';
}
function emitRows_(v, o, P, acc) {
  const tank = v.tank > 0 ? v.tank : 0;
  o.cycles.forEach(c => {
    const w = c.worst;
    acc.trips.push(rowOf_(H.TRIP, { 'ID': v.key + '|' + iso_(c.a), 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(c.a)),
      'Début': new Date(c.a), 'Fin': new Date(c.b), 'Km': r2_(c.km), 'Conduite (min)': r1_(c.driveMin),
      'Ralenti contact (min)': r1_(c.stillMin), 'Moteur éteint à l\'arrêt (min)': r1_(c.evOffMin), 'Ralenti moteur tournant (min)': r1_(c.idleMin),
      'Source ralenti': c.coverage >= 0.8 ? 'Régime moteur' : 'Régime moteur (couverture ' + Math.round(c.coverage * 100) + ' %)',
      'Ralenti prolongé (min)': Math.round(c.longMin), 'Nb ralentis prolongés': c.nLong,
      'Vmax (km/h)': c.vmax, 'Vmax GPS (contrôle)': c.vmaxGps, 'Vmoy (km/h)': c.driveMin > 0 ? Math.round(c.km / (c.driveMin / 60)) : '', 'Limite à Vmax': c.limAtMax || '',
      'Source limite': c.limAtMax ? 'Geotab (vitesse capteur véhicule)' : '', 'Pire dépassement (km/h)': w ? Math.round(w.ex) : '', 'Vitesse au pire': w ? Math.round(w.v) : '',
      'Limite au pire': w ? w.lim : '', 'Heure pire': w ? localHM_(w.t) : '',
      'Carburant (L)': c.fuelL != null ? r2_(c.fuelL) : '', 'Source carburant': c.fuelL != null ? 'Compteur' : 'Non mesuré',
      'Contrôle calculateur (L)': c.ecuL != null ? r2_(c.ecuL) : '', 'Carburant ralenti (L)': c.idleL != null ? r2_(c.idleL) : '',
      'Source carburant ralenti': c.idleL != null ? 'Compteur ralenti' : '', 'Lat arrêt': c.lat, 'Lon arrêt': c.lon,
      'Dépassements par limite': c.obl ? JSON.stringify(c.obl) : '' }));
  });
  o.idles.forEach(s => {
    acc.idles.push(rowOf_(H.IDL, { 'Clé': v.key + '|' + iso_(s.a), 'Clé plaque': v.key, 'Plaque': v.plate, 'Trajet ID': v.key + '|' + iso_(s.cycleA),
      'Date': dayToDate_(localDay_(s.a)), 'Début': new Date(s.a), 'Fin': new Date(s.b), 'Durée arrêt (min)': Math.round(s.min),
      'Moteur tournant (min)': Math.round(s.min), 'Vérification moteur': 'Régime moteur', 'Litres': '', 'Source litres': '', 'Lat': s.lat, 'Lon': s.lon }));
  });
  emitStops_(v, o.engStops, acc);
  o.fills.forEach(f => {
    acc.fuels.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(f.t) + '|PLEIN', 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(f.t)),
      'Type': 'PLEIN', 'Arrêt début': new Date(f.t), 'Arrêt fin': new Date(f.t), 'Moteur': '', 'Niveau avant (%)': f.min != null ? r1_(f.min) : '',
      'Niveau après (%)': f.max != null ? r1_(f.max) : '', 'Écart (%)': f.min != null && f.max != null ? r1_(f.max - f.min) : '',
      'Litres (jauge)': f.derived != null ? r1_(f.derived) : '', 'Litres Geotab': f.volume != null ? r1_(f.volume) : '', 'Source': 'Geotab FillUp',
      'Lat': f.lat, 'Lon': f.lon, 'Statut': 'Info' }));
  });
  o.offStops.forEach(s => {
    if (s.odoKm != null && s.odoKm >= 10) {   // seuil 10 km : en dessous, écarts de relevé ou mode électrique des hybrides
      // Le véhicule a roulé alors que le boîtier ne voyait pas le contact : trajet non enregistré, pas un siphonage
      acc.fuels.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(s.off) + '|TRAJET_NON_ENREGISTRE', 'Clé plaque': v.key, 'Plaque': v.plate,
        'Date': dayToDate_(localDay_(s.off)), 'Type': 'TRAJET_NON_ENREGISTRE', 'Arrêt début': new Date(s.off), 'Arrêt fin': new Date(s.on),
        'Durée arrêt (min)': Math.round(s.min), 'Moteur': r1_(s.odoKm) + ' km non enregistrés', 'Niveau avant (%)': s.before != null ? r1_(s.before) : '',
        'Niveau après (%)': s.after != null ? r1_(s.after) : '', 'Écart (%)': s.delta != null ? r1_(s.delta) : '',
        'Litres (jauge)': s.delta != null ? r1_(s.unit === 'L' ? s.delta : (tank ? s.delta / 100 * tank : s.delta)) : '', 'Source': 'Compteur km véhicule + jauge',
        'Lat': s.lat, 'Lon': s.lon, 'Statut': 'À vérifier' }));
      return;
    }
    if (s.delta == null || s.min < P.stopMin) return;
    const litres = s.unit === 'L' ? s.delta : (tank ? s.delta / 100 * tank : null);
    const suspect = s.unit === 'L' ? -s.delta >= P.siphonL : (-s.delta >= P.siphonPct && (litres === null || -litres >= P.siphonL));
    if (!suspect) return;
    acc.fuels.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(s.off) + '|SIPHONAGE_SUSPECT', 'Clé plaque': v.key, 'Plaque': v.plate,
      'Date': dayToDate_(localDay_(s.off)), 'Type': 'SIPHONAGE_SUSPECT', 'Arrêt début': new Date(s.off), 'Arrêt fin': new Date(s.on),
      'Durée arrêt (min)': Math.round(s.min), 'Moteur': 'Coupé', 'Niveau avant (%)': r1_(s.before), 'Niveau après (%)': r1_(s.after),
      'Écart (%)': r1_(s.delta), 'Litres (jauge)': litres != null ? r1_(litres) : '', 'Source': 'Jauge (' + s.unit + ')', 'Lat': s.lat, 'Lon': s.lon, 'Statut': 'À vérifier' }));
  });
  o.evts.forEach(e => {
    acc.evts.push(rowOf_(H.EVT, { 'ID': e.id, 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(e.t)), 'Début': new Date(e.t),
      'Fin': e.end ? new Date(e.end) : '', 'Durée (s)': Math.round(parseDur_(e.durS)), 'Distance (km)': r2_(e.km), 'Règle ID': e.rule }));
  });
  o.lvl.forEach(x => { acc.lvls.push([v.key + '|' + x.t, v.key, new Date(x.t), r1_(x.unit === 'L' && tank ? x.v / tank * 100 : x.v)]); });
}
function cSeries_(raw, from, to) {
  const m = {};
  (raw || []).forEach(x => {
    const t = new Date(x.dateTime).getTime(), v = +x.data;
    if (isNaN(t) || !isFinite(v)) return;
    if (t === from || t === to) return;            // Geotab ajoute une valeur aux bornes de la fenêtre
    m[t] = v;
  });
  return Object.keys(m).map(Number).sort((a, b) => a - b).map(t => ({ t, v: m[t] }));
}
function cLb_(s, x) { let lo = 0, hi = s.length; while (lo < hi) { const k = (lo + hi) >> 1; if (s[k].t < x) lo = k + 1; else hi = k; } return lo; }
function cLast_(s, t, floor) { const i = cLb_(s, t + 1) - 1; return i >= 0 && s[i].t >= floor ? s[i] : null; }
function cFirst_(s, t, ceil) { const i = cLb_(s, t); return i < s.length && s[i].t <= ceil ? s[i] : null; }
function cMedian_(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
function cIn_(s, a, b) { const o = []; for (let i = cLb_(s, a); i < s.length && s[i].t <= b; i++) o.push(s[i]); return o; }
function cCycles_(ign, winFrom, winTo, now) {
  const out = []; let on = null, prev = null;
  ign.forEach(p => {
    if (p.v >= 1 && on === null && (prev === null || prev.v < 1)) on = p.t;
    if (p.v < 1 && on !== null) { out.push({ a: on, b: p.t, open: false }); on = null; }
    prev = p;
  });
  if (on !== null) out.push({ a: on, b: Math.min(winTo, now), open: true });
  // un cycle dont on n'a pas vu le début (déjà allumé avant la fenêtre) est écarté
  return out.filter(c => c.b > c.a);
}
function cCounter_(s, cyc, prevOff, nextOn) {
  const v1 = cLast_(s, cyc.a + 30000, prevOff != null ? prevOff - 10000 : cyc.a - 6 * C_HOUR);
  const v2 = cyc.open ? null : cFirst_(s, cyc.b - 10000, (nextOn != null ? nextOn : cyc.b + 6 * C_HOUR) + 30000);
  if (!v1 || !v2) return null;
  const d = v2.v - v1.v;
  return d >= 0 ? d : null;
}
function cTimeline_(rpm, spd, a, b, P) {
  const bp = [a, b];
  cIn_(rpm, a, b).forEach(p => bp.push(p.t));
  cIn_(spd, a, b).forEach(p => bp.push(p.t));
  const ts = Array.from(new Set(bp.filter(t => t >= a && t <= b))).sort((x, y) => x - y);
  let drive = 0, still = 0, idle = 0, evOff = 0, unknown = 0, segs = [], cur = null;
  for (let k = 0; k < ts.length - 1; k++) {
    const t0 = ts[k], dt = ts[k + 1] - t0;
    const r = cLast_(rpm, t0, a - 2000), v = cLast_(spd, t0, a - 2000);
    let state;
    if (!v) state = r && r.v > P.rpmMin ? 'unk' : 'unk';
    else if (v.v >= 2) state = 'drive';
    else if (!r) state = 'stillUnk';
    else state = r.v > P.rpmMin ? 'idle' : 'evOff';
    if (state === 'drive') drive += dt;
    if (state === 'idle' || state === 'evOff' || state === 'stillUnk') still += dt;
    if (state === 'idle') idle += dt;
    if (state === 'evOff') evOff += dt;
    if (state === 'unk' || state === 'stillUnk') unknown += dt;
    if (state === 'idle') { if (!cur) cur = { a: t0, b: t0 }; cur.b = t0 + dt; }
    else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  return { drive, still, idle, evOff, unknown, coverage: (b - a) ? 1 - unknown / (b - a) : 0, segs };
}
function cPct_(pt, cap) {
  const v = +pt.data, c = cap && cap.volume ? +cap.volume : 0;
  return /Units/i.test(String(pt.source || '')) && c > 0 ? v / c * 100 : v;
}
function cRoad_(res) {
  let arr = res || [];
  if (!Array.isArray(arr) && typeof arr === 'object') arr = Object.keys(arr).map(k => ({ k, v: arr[k] }));
  return arr.map(x => ({ t: new Date(x.k || x.key || x.dateTime).getTime(), v: +(x.v != null ? x.v : x.value) }))
    .filter(x => !isNaN(x.t) && isFinite(x.v)).sort((a, b) => a.t - b.t);
}
function cSpeed_(spd, logs, road, a, b) {
  const pts = cIn_(spd, a, b);
  let vmax = 0, tMax = null, worst = null, nLim = 0, nKnown = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1], s = Math.min(p.v, q.v);
    if (s > vmax) { vmax = s; tMax = p.t; }
    if (s >= 30) {
      nLim++;
      const lp = cLast_(road, p.t, a - 60000), lq = cLast_(road, q.t, a - 60000);
      if (lp && lq && lp.v > 0 && lp.v === lq.v) {
        nKnown++;
        const ex = s - lp.v;
        if (!worst || ex > worst.ex) { const g = cLast_(logs, p.t, p.t - 60000) || cFirst_(logs, p.t, p.t + 60000); worst = { ex, v: s, lim: lp.v, t: p.t, lat: g ? g.lat : '', lon: g ? g.lon : '' }; }
      }
    }
  }
  let vg = 0; const g = cIn_(logs, a, b);
  for (let i = 0; i + 1 < g.length; i++) vg = Math.max(vg, Math.min(g[i].v, g[i + 1].v));
  const limAtMax = tMax ? cLast_(road, tMax, a - 60000) : null;
  return { vmax: Math.round(vmax), vmaxGps: Math.round(vg), tMax, limAtMax: limAtMax && limAtMax.v > 0 ? limAtMax.v : null, worst, limCoverage: nLim ? nKnown / nLim : null };
}
function cPrep_(d, win) {
  if (d._pre && d._pre.from === win.from && d._pre.to === win.to && d._pre.now === win.now) return d._pre;
  const S = {};
  Object.keys(CORE_DIAGS).forEach(k => { S[k] = cSeries_(d.sd[k], win.from, win.to); });
  const logs = (d.logs || []).map(x => ({ t: new Date(x.dateTime).getTime(), v: +x.speed || 0, lat: x.latitude, lon: x.longitude }))
    .filter(x => !isNaN(x.t)).sort((a, b) => a.t - b.t);
  const road = cRoad_(d.road);
  const trips = (d.trips || []).map(t => ({ a: new Date(t.start).getTime(), b: new Date(t.stop).getTime(), km: +t.distance || 0,
    gIdle: t.idlingDuration, lat: t.stopPoint ? t.stopPoint.y : '', lon: t.stopPoint ? t.stopPoint.x : '' })).sort((x, y) => x.a - y.a);
  const cyc = cCycles_(S.ign, win.from, win.to, win.now);
  const lvl = S.lvlL.length ? { s: S.lvlL, unit: 'L' } : { s: S.lvlPct, unit: '%' };
  return (d._pre = { from: win.from, to: win.to, now: win.now, S, logs, road, trips, cyc, lvl });
}
function cAnalyze_(d, win, P) {
  const pre = cPrep_(d, win), S = pre.S, logs = pre.logs, road = pre.road, trips = pre.trips, cyc = pre.cyc, lvl = pre.lvl;
  const out = { cycles: [], idles: [], engStops: [], offStops: [], fills: [], evts: [], sources: {} };
  // nombre de lectures sur la fenêtre d'analyse du jour (jour ± 12 h), quelle que soit la taille du bloc téléchargé
  const wA = win.dayFrom - 12 * C_HOUR, wB = Math.min(win.dayTo + 12 * C_HOUR, win.to);
  Object.keys(S).forEach(k => { out.sources[k] = cIn_(S[k], wA + 1, wB - 1).length; });   // bornes exclues, comme cSeries_
  out.sources.logs = cIn_(logs, win.dayFrom - 6 * C_HOUR, wB).length; out.sources.road = cIn_(road, win.dayFrom, wB).length;

  cyc.forEach((c, i) => {
    if (c.a < win.dayFrom || c.a >= win.dayTo) return;
    const prevOff = i > 0 ? cyc[i - 1].b : null, nextOn = i + 1 < cyc.length ? cyc[i + 1].a : null;
    const tl = cTimeline_(S.rpm, S.spd, c.a, c.b, P);
    const km = trips.filter(t => t.a >= c.a - 60000 && t.a < c.b).reduce((s, t) => s + t.km, 0);
    const fuel = cCounter_(S.fuel, c, prevOff, nextOn), ecu = cCounter_(S.ecu, c, prevOff, nextOn), idleL = cCounter_(S.idleFuel, c, prevOff, nextOn);
    const hours = (c.b - c.a) / C_HOUR, plaus = L => L != null && L <= km * 0.4 + hours * 4 + 1;
    const sp = cSpeed_(S.spd, logs, road, c.a, c.b), obl = cOverByLimit_(S.spd, road, c.a, c.b);   // obl : hors moteur v6 (19_speed.gs)
    const lastLog = cLast_(logs, c.b, c.a);
    const long = tl.segs.filter(s => s.b - s.a >= P.idleLongMin * C_MIN);
    const hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];   // nb et minutes : <1, 1-3, 3-5, 5-10, >=10 min
    tl.segs.forEach(s => { const m = (s.b - s.a) / C_MIN, k = m < 1 ? 0 : m < 3 ? 1 : m < 5 ? 2 : m < 10 ? 3 : 4; hist[k]++; hist[5 + k] += m; });
    long.forEach(s => {
      const pos = cLast_(logs, s.a + 1000, c.a) || cFirst_(logs, s.a, s.b);
      out.idles.push({ a: s.a, b: s.b, min: (s.b - s.a) / C_MIN, cycleA: c.a, lat: pos ? pos.lat : '', lon: pos ? pos.lon : '' });
    });
    cEngStops_(S, logs, c, tl, prevOff, nextOn, P).forEach(s => out.engStops.push(s));   // hors moteur v6 (17_stops.gs)
    let gap = null;
    if (plaus(fuel) && plaus(ecu) && ecu > 0.5) gap = fuel - ecu;
    out.cycles.push({
      a: c.a, b: c.b, open: c.open, km,
      driveMin: tl.drive / C_MIN, stillMin: tl.still / C_MIN, idleMin: tl.idle / C_MIN, evOffMin: tl.evOff / C_MIN,
      coverage: tl.coverage, hist, nLong: long.length, longMin: long.reduce((s, x) => s + (x.b - x.a), 0) / C_MIN,
      fuelL: plaus(fuel) ? fuel : null, ecuL: plaus(ecu) ? ecu : null, gapL: gap, idleL: plaus(idleL) ? idleL : null,
      vmax: sp.vmax, vmaxGps: sp.vmaxGps, limAtMax: sp.limAtMax, worst: sp.worst, obl, limCoverage: sp.limCoverage,
      lat: lastLog ? lastLog.lat : '', lon: lastLog ? lastLog.lon : ''
    });
  });

  // Arrêts moteur coupé : variation de jauge sans aucun cycle contact
  for (let i = 0; i + 1 < cyc.length; i++) {
    const off = cyc[i].b, on = cyc[i + 1].a;
    if (off < win.dayFrom || off >= win.dayTo || cyc[i].open) continue;
    const before = cMedian_(cIn_(lvl.s, off - 10 * C_MIN, off + 2 * C_MIN).map(p => p.v));
    const after = cMedian_(cIn_(lvl.s, on - C_MIN, on + 10 * C_MIN).map(p => p.v));
    const pos = cLast_(logs, off, off - 2 * C_HOUR);
    // Compteur kilométrique du véhicule : s'il avance moteur « coupé », le boîtier ne transmettait plus (trajet non enregistré)
    const o1 = cLast_(S.odo, off + 60000, off - 2 * C_HOUR), o2 = cFirst_(S.odo, on - 60000, on + 30 * C_MIN);
    // km enregistrés par le compteur du véhicule moins les km réellement roulés autour de l'arrêt (capteur de vitesse) :
    // le compteur n'est relevé que toutes les 2-3 min, cette correction évite les faux écarts
    const kmSpd = (x, y) => { let km = 0; const pts = cIn_(S.spd, x - 30 * C_MIN, y); for (let k = 0; k < pts.length; k++) { const t0 = Math.max(x, pts[k].t), t1 = Math.min(y, k + 1 < pts.length ? pts[k + 1].t : y); if (t1 > t0) km += pts[k].v * (t1 - t0) / C_HOUR; } return km; };
    const odoKm = o1 && o2 ? (o2.v - o1.v) / 1000 - kmSpd(o1.t, off) - kmSpd(on, o2.t) : null;
    const p2 = cFirst_(logs, on, on + 10 * C_MIN);
    out.offStops.push({ off, on, min: (on - off) / C_MIN, before, after, delta: before != null && after != null ? after - before : null, unit: lvl.unit,
      lat: pos ? pos.lat : '', lon: pos ? pos.lon : '', odoKm, lat2: p2 ? p2.lat : '', lon2: p2 ? p2.lon : '', v2: p2 ? p2.v : null });
  }
  out.lvl = []; const bk = {};
  lvl.s.forEach(p => { if (p.t < win.dayFrom || p.t >= win.dayTo) return; const k = Math.floor(p.t / (15 * C_MIN)); (bk[k] = bk[k] || []).push(p.v); });
  Object.keys(bk).forEach(k => out.lvl.push({ t: +k * 15 * C_MIN, v: cMedian_(bk[k]), unit: lvl.unit }));
  (d.fills || []).forEach(f => {
    const t = new Date(f.dateTime).getTime(); if (isNaN(t) || t < win.dayFrom || t >= win.dayTo) return;
    const ex = f.tankLevelExtrema || {};
    out.fills.push({ t, volume: f.volume != null ? +f.volume : null, derived: f.derivedVolume != null ? +f.derivedVolume : null,
      min: ex.minimaPoint ? cPct_(ex.minimaPoint, f.tankCapacity) : null, max: ex.maximaPoint ? cPct_(ex.maximaPoint, f.tankCapacity) : null,
      cap: f.tankCapacity ? +f.tankCapacity.volume : null, lat: f.location ? f.location.y : '', lon: f.location ? f.location.x : '',
      conf: String(f.confidence || '') });
  });
  (d.exc || []).forEach(e => {
    if (e.state === 'Invalid' || e.state === 1) return;
    const t = new Date(e.activeFrom).getTime(); if (isNaN(t) || t < win.dayFrom || t >= win.dayTo) return;
    out.evts.push({ id: String(e.id), t, end: e.activeTo ? new Date(e.activeTo).getTime() : null, rule: e.rule && e.rule.id ? String(e.rule.id) : '',
      durS: e.duration, km: +e.distance || 0 });
  });
  return out;
}
function cCalls_(devId, win) {
  const ds = { id: devId }, iso = t => new Date(t).toISOString();
  const sd = diag => ({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: ds, diagnosticSearch: { id: diag }, fromDate: iso(win.from), toDate: iso(win.to) }, resultsLimit: 50000 } });
  const calls = [
    { method: 'Get', params: { typeName: 'Trip', search: { deviceSearch: ds, fromDate: iso(win.from), toDate: iso(win.to), includeOverlappedTrips: true } } },
    { method: 'Get', params: { typeName: 'ExceptionEvent', search: { deviceSearch: ds, fromDate: iso(win.dayFrom), toDate: iso(win.dayTo) } } },
    { method: 'Get', params: { typeName: 'LogRecord', search: { deviceSearch: ds, fromDate: iso(win.dayFrom - 6 * C_HOUR), toDate: iso(win.to) }, resultsLimit: 50000,
      propertySelector: { fields: ['dateTime', 'speed', 'latitude', 'longitude'], isIncluded: true } } },
    { method: 'Get', params: { typeName: 'FillUp', search: { deviceSearch: ds, fromDate: iso(win.dayFrom), toDate: iso(win.dayTo) } } }
  ];
  const keys = Object.keys(CORE_DIAGS);
  keys.forEach(k => calls.push(sd(CORE_DIAGS[k])));
  return { calls, map: res => { const d = { trips: res[0], exc: res[1], logs: res[2], fills: res[3], sd: {} }; keys.forEach((k, i) => { d.sd[k] = res[4 + i]; }); return d; } };
}
function newAcc_() { return { trips: [], evts: [], fuels: [], lvls: [], idles: [], stops: [], sync: [], days: [], warn: [], rules: rulesMap_() }; }
function attribCtx_() { const P = params_(); return { cidx: contractIndex_(), tol: P.ctrTolMin * MIN, rules: rulesMap_() }; }
function attribRows_(k, rows, ctx) {
  if (!rows || !rows.length) return;
  const I = idx_(H[k]), tc = I[ATTR_TIME[k]];
  rows.forEach(r => {
    const key = String(r[I['Clé plaque']]), a = attrib_(ctx.cidx, key, tms_(r[tc]), ctx.tol);
    r[I['Code chauffeur']] = a.code; r[I['Chauffeur']] = a.nom; r[I['Contrat']] = a.num;
    if (k === 'EVT') { const rid = String(r[I['Règle ID']]); r[I['Règle']] = ctx.rules[rid] ? ctx.rules[rid].name : rid; }
    if (k === 'FUEL') { const b = attrib_(ctx.cidx, key, tms_(r[I['Arrêt fin']]), ctx.tol); r[I['Chauffeur suivant']] = b.code === a.code ? '' : b.nom; }
  });
}
function rowDay_(k, r, I) {
  if (k === 'IDL' || k === 'STP') { const m = String(r[I['Trajet ID']] || '').split('|')[1]; if (m) return localDay_(new Date(m)); }
  if (k === 'LVL') return localDay_(toDate_(r[I['Horodatage']]) || new Date(0));
  return localDay_(toDate_(r[I[ATTR_TIME[k]]]) || new Date(0));
}
function initLive_(v, fin, today) {
  const y = addDays_(today, -1), d = fin[v.key + '|' + y] ? today : y;
  return { done: dayBounds_(d).start.getTime(), init: 1, span: LIVE_SPAN };
}
function chunks_(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function liveRun_(t0, budgetMs, opt) {
  opt = opt || {};
  const P = params_(), veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId);
  const out = { status: {}, wrote: 0, n: 0, warn: [], pending: 0, more: 0 };
  if (!list.length) return out;
  const props = PropertiesService.getScriptProperties(), allP = props.getProperties();
  const now = Date.now(), today = localDay_(now), fin = doneVehDays_(), st = {}, changed = {};
  list.forEach(v => {
    let x = null; try { x = JSON.parse(allP['LIVE|' + v.key] || 'null'); } catch (e) { }
    if (!x || !(x.done > 0)) { x = initLive_(v, fin, today); changed[v.key] = 1; }
    // jour finalisé entre-temps : on repart après lui (ses données sont dans DATA_*)
    for (let d = localDay_(x.done); d < today && fin[v.key + '|' + d]; d = addDays_(d, 1)) { x = { done: dayBounds_(d).end.getTime(), init: 1, span: LIVE_SPAN }; changed[v.key] = 1; }
    st[v.key] = x;
  });
  // 1) État des véhicules + contact depuis le dernier cycle calculé : un seul aller-retour pour toute la flotte
  const calls = [];
  list.forEach(v => calls.push(
    { method: 'Get', params: { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: v.geoId } } } },
    { method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id: v.geoId }, diagnosticSearch: { id: CORE_DIAGS.ign },
      fromDate: iso_(st[v.key].done - LIVE_CTX), toDate: iso_(now) } } }));
  const parts = chunks_(calls, 100), resp = geoFetchAll_(parts.map(c => ({ method: 'ExecuteMultiCall', params: { calls: c } })));
  const flat = [];
  resp.forEach((rd, i) => { const r = rd(); if (r.err) throw r.err; parts[i].forEach((c, j) => flat.push(r.res[j])); });
  const cand = [];
  list.forEach((v, i) => {
    const dsi = (flat[2 * i] || [])[0] || null, ign = flat[2 * i + 1] || [], s0 = st[v.key].done, from = s0 - LIVE_CTX;
    let ser = cSeries_(ign, from, now);
    const lastIgn = ser.length ? ser[ser.length - 1] : null;
    out.status[v.key] = { dsi, ignOn: lastIgn ? lastIgn.v >= 1 : null, ignAt: lastIgn ? lastIgn.t : null };
    if (!st[v.key].init && !ser.some(p => p.t === s0 - 1000)) { ser = ser.concat([{ t: s0 - 1000, v: 1 }]).sort((a, b) => a.t - b.t); }
    const cyc = cCycles_(ser, from, now, now).filter(c => c.a >= s0 && !c.open && c.b <= now - LIVE_SETTLE);
    if (!cyc.length) return;
    let k = 0; while (k + 1 < cyc.length && cyc[k + 1].b <= s0 + (st[v.key].span || LIVE_SPAN)) k++;
    cand.push({ v, s0, from, lastB: cyc[k].b, to: Math.min(now, cyc[k].b + 30 * MIN), more: k < cyc.length - 1 });
  });
  out.pending = cand.length;
  // 2) Cycles terminés : téléchargement de la seule fenêtre utile, 8 véhicules en parallèle
  const acc = newAcc_();
  for (const grp of chunks_(cand, 8)) {
    if (Date.now() - t0 > budgetMs) { out.more += 1; break; }
    const reqs = [], meta = [];
    grp.forEach(c => {
      const cq = cCalls_(c.v.geoId, { from: c.from, to: c.to, dayFrom: c.s0 - LIVE_EVBACK, dayTo: c.to });
      cq.calls[2].params.search.fromDate = iso_(c.from);   // positions GPS : fenêtre de calcul seulement
      meta.push({ c, cq, i: reqs.length });
      reqs.push({ method: 'ExecuteMultiCall', params: { calls: cq.calls } },
        { method: 'GetRoadMaxSpeeds', params: { deviceSearch: { id: c.v.geoId }, fromDate: iso_(c.from), toDate: iso_(c.to) } });
    });
    const res = geoFetchAll_(reqs);
    meta.forEach(m => {
      const c = m.c, v = c.v, x = st[v.key], r0 = res[m.i](), r1 = res[m.i + 1]();
      if (r0.err) { out.warn.push(v.plate + ' : ' + r0.err.message); return; }
      const data = m.cq.map(r0.res);
      if ([data.logs].concat(Object.keys(data.sd).map(q => data.sd[q])).some(a => (a || []).length >= GEO_MAX_RESULTS)) {
        x.span = Math.max(HOUR, (x.span || LIVE_SPAN) / 2); changed[v.key] = 1; out.warn.push(v.plate + ' : trop de points, tranche réduite'); return;
      }
      data.road = r1.err ? [] : r1.res;
      if (!x.init) data.sd.ign = (data.sd.ign || []).concat([{ dateTime: iso_(c.s0 - 1000), data: 1 }]);   // fin du cycle précédent = c.s0
      const win = { dayFrom: c.s0 - LIVE_EVBACK, dayTo: c.to + 1, from: c.from, to: c.to, now };
      const o = cAnalyze_(data, win, P);
      const emit = [];
      for (const cy of o.cycles.filter(q => q.a >= c.s0).sort((a, b) => a.a - b.a)) {
        if (cy.open || cy.b > c.lastB || cy.b > now - LIVE_SETTLE) break;
        if (cy.driveMin > 1 && cy.km === 0 && now - cy.b < LIVE_KM_WAIT) break;   // trajet Geotab (km) pas encore calculé
        emit.push(cy);
      }
      if (!emit.length) return;
      const newDone = emit[emit.length - 1].b, okDay = t => !fin[v.key + '|' + localDay_(t)], starts = {};
      emit.forEach(cy => { starts[cy.a] = 1; });
      const sel = {
        cycles: emit.filter(cy => okDay(cy.a)),
        idles: o.idles.filter(q => starts[q.cycleA] && okDay(q.cycleA)),
        engStops: o.engStops.filter(q => starts[q.cycleA] && okDay(q.cycleA)),
        offStops: o.offStops.filter(q => q.off >= c.s0 && q.off < newDone && okDay(q.off)),
        fills: o.fills.filter(q => okDay(q.t)),
        evts: o.evts.filter(e => keepEvt_(acc.rules, e.rule) && okDay(e.t)),
        lvl: o.lvl.filter(q => q.t >= c.from && q.t + 15 * MIN <= c.to && okDay(q.t))
      };
      emitRows_(v, sel, P, acc);
      st[v.key] = { done: newDone, init: 0, span: LIVE_SPAN }; changed[v.key] = 1;
      out.n += emit.length;
      if (c.more || newDone < c.lastB) out.more++;
    });
  }
  // 3) Écriture (mise à jour par clé : un trajet recalculé remplace sa version précédente)
  const actx = attribCtx_();
  attribRows_('TRIP', acc.trips, actx); attribRows_('IDL', acc.idles, actx); attribRows_('STP', acc.stops, actx); attribRows_('EVT', acc.evts, actx); attribRows_('FUEL', acc.fuels, actx);
  [['TRIP', acc.trips], ['IDL', acc.idles], ['STP', acc.stops], ['EVT', acc.evts], ['FUEL', acc.fuels], ['LVL', acc.lvls]].forEach(x => {
    if (!x[1].length) return;
    try { putLive_(x[0], x[1]); } catch (e) { if (x[0] === 'STP' && stopsMissing_(e)) return; throw e; }
    out.wrote += x[1].length;   // base : lignes provisoires (final = false)
  });
  if (out.wrote) memoClear_();
  const upd = {}; Object.keys(changed).forEach(k => { upd['LIVE|' + k] = JSON.stringify(st[k]); });
  if (Object.keys(upd).length) props.setProperties(upd);
  props.setProperty('LIVE_LAST', String(Date.now()));
  return out;
}
function liveCatchUp_(budgetMs) {
  const t0 = Date.now(); let r = null, n = 0;
  for (let i = 0; i < 8; i++) {
    const x = liveRun_(t0, budgetMs, { all: true }); n += x.n;
    r = r ? Object.assign(x, { n, wrote: r.wrote + x.wrote, warn: r.warn.concat(x.warn) }) : x;
    if (!x.more || Date.now() - t0 > budgetMs) break;
    memoClear_();
  }
  return r;
}
function coverage_() {
  const fin = doneVehDays_(addDays_(localDay_(new Date()), -Math.max(7, params_().retentionDays || 62) - 3)), o = Object.assign({}, fin), all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('LIVE|') !== 0) return;
    let x = null; try { x = JSON.parse(all[k]); } catch (e) { }
    if (!x || !(x.done > 0)) return;
    const key = k.slice(5), today = localDay_(new Date());
    for (let d = addDays_(today, -2); d <= today; d = addDays_(d, 1)) if (x.done >= dayBounds_(d).start.getTime()) o[key + '|' + d] = 1;
  });
  return o;
}
function jrnSort_(x, y) { return tms_(y[1]) - tms_(x[1]) || tms_(y[7]) - tms_(x[7]) || String(x[2]).localeCompare(String(y[2])); }
function alertSort_(a, b) { return tms_(b[1]) - tms_(a[1]) || (G_ORDER[a[7]] || 0) - (G_ORDER[b[7]] || 0) || String(b[2]).localeCompare(String(a[2])); }
function dueFinal_(P) {
  const fin = doneVehDays_(), list = Object.values(vehicles_()).filter(v => v.active && v.geoId), now = Date.now(), today = localDay_(now), q = [];
  for (let i = Math.max(1, P.catchupDays || 7); i >= 1; i--) {
    const d = addDays_(today, -i); if (dayBounds_(d).end.getTime() + 12 * HOUR > now) continue;
    list.forEach(v => { if (!fin[v.key + '|' + d]) q.push({ d, k: v.key }); });
  }
  return q;
}
function markDirty_(day) {
  const props = PropertiesService.getScriptProperties(), cur = props.getProperty('DERIVED_DIRTY');
  if (!cur || day < cur) props.setProperty('DERIVED_DIRTY', day);
}
function rebuild_(fromDay) {
  const today = localDay_(new Date()), P = params_();
  const oldest = addDays_(today, -Math.max(7, P.retentionDays || 62));
  fromDay = fromDay && fromDay > oldest ? fromDay : (fromDay ? oldest : addDays_(today, -31));
  reattribute_(fromDay);
  return updateDerived_(fromDay);
}
function buildJournalier_(T, E, F, veh, rules, P, faux, ctrs) {
  faux = faux || {}; ctrs = ctrs || {};
  const IT = idx_(H.TRIP), IE = idx_(H.EVT), IF = idx_(H.FUEL);
  const agg = {};
  const get = (num, day, key, code, nom) => {
    const k = num ? 'C|' + num : 'H|' + day + '|' + key;
    return agg[k] || (agg[k] = { k, num, day, key, code, nom, n: 0, km: 0, drive: 0, idle: 0, idleLong: 0, nLong: 0, idleSrcs: {}, idleFuelSrcs: {},
      fuel: 0, fuelKm: 0, srcs: {}, idleFuel: 0, idleFuelN: 0, vmax: 0, limVmax: '', worst: null, evts: 0, pts: 0,
      pleins: 0, pleinsL: 0, siph: 0, siphL: 0, kmHors: 0 });
  };
  T.rows.forEach(r => {
    const a = get(String(r[IT['Contrat']] || ''), toDayStr_(r[IT['Date']]), String(r[IT['Clé plaque']]), String(r[IT['Code chauffeur']]), String(r[IT['Chauffeur']]));
    const km = num_(r[IT['Km']]);
    a.n++; a.km += km; a.drive += num_(r[IT['Conduite (min)']]);
    const isrc = String(r[IT['Source ralenti']] || 'Régime moteur');
    a.idle += num_(r[IT['Ralenti moteur tournant (min)']]); a.idleSrcs[isrc] = 1;
    a.idleLong += num_(r[IT['Ralenti prolongé (min)']]); a.nLong += num_(r[IT['Nb ralentis prolongés']]);
    const src = String(r[IT['Source carburant']] || 'Non mesuré');
    if (src !== 'Non mesuré' && r[IT['Carburant (L)']] !== '') { a.fuel += num_(r[IT['Carburant (L)']]); a.fuelKm += km; a.srcs[src] = 1; }
    if (r[IT['Carburant ralenti (L)']] !== '') { a.idleFuel += num_(r[IT['Carburant ralenti (L)']]); a.idleFuelN++; a.idleFuelSrcs[r[IT['Source carburant ralenti']]] = 1; }
    const vm = num_(r[IT['Vmax (km/h)']]);
    if (vm > a.vmax) { a.vmax = vm; a.limVmax = r[IT['Limite à Vmax']]; }
    const w = r[IT['Pire dépassement (km/h)']];
    if (w !== '' && (a.worst === null || num_(w) > a.worst)) a.worst = num_(w);
    if (r[IT['Code chauffeur']] === HORS) a.kmHors += km;
  });
  E.rows.forEach(r => {
    const rid = String(r[IE['Règle ID']]), w = rules[rid] ? rules[rid].w : 0;
    if (w <= 0) return;
    const a = get(String(r[IE['Contrat']] || ''), toDayStr_(r[IE['Date']]), String(r[IE['Clé plaque']]), String(r[IE['Code chauffeur']]), String(r[IE['Chauffeur']]));
    a.evts++; a.pts += w;
  });
  F.rows.forEach(r => {
    const type = r[IF['Type']];
    const a = get(String(r[IF['Contrat']] || ''), toDayStr_(r[IF['Date']]), String(r[IF['Clé plaque']]), String(r[IF['Code chauffeur']]), String(r[IF['Chauffeur']]));
    if (type === 'PLEIN') { a.pleins++; a.pleinsL += num_(r[IF['Litres (jauge)']]); }
    if (type === 'SIPHONAGE_SUSPECT' && r[IF['Statut']] !== 'Faux positif' && !faux['SIPH|' + r[0]]) { a.siph++; a.siphL += -num_(r[IF['Litres (jauge)']]); }
  });
  const now = Date.now();
  return Object.values(agg).map(a => {
    const v = veh[a.key] || { plate: a.key, model: '', price: 0 };
    const c = a.num ? ctrs[a.num] : null;
    const day = c && c.start ? localDay_(c.start) : a.day;
    if (!day) return null;
    const cEnd = c ? (c.end ? c.end.getTime() : now) : null;
    const score = a.km > 0 || a.pts > 0 ? a.pts / Math.max(a.km, P.kmMin) * 100 : 0;
    const srcs = Object.keys(a.srcs), isr = Object.keys(a.idleSrcs), ifs = Object.keys(a.idleFuelSrcs);
    const one = (l, dflt) => l.length ? (l.length > 1 ? 'Mixte' : l[0]) : dflt;
    const fuelOk = a.fuelKm > 0;
    return rowOf_(H.JRN, {
      'Clé': a.k, 'Date': dayToDate_(day), 'Plaque': v.plate, 'Modèle': v.model, 'Code chauffeur': a.code, 'Chauffeur': a.nom,
      'Contrat': a.num, 'Début contrat': c && c.start ? c.start : '', 'Fin contrat': c && c.end ? c.end : '',
      'Durée contrat (h)': c && c.start ? r2_((cEnd - c.start.getTime()) / HOUR) : '', 'Trajets': a.n, 'Km': r1_(a.km),
      'Conduite (h)': r2_(a.drive / 60), 'Ralenti (h)': r2_(a.idle / 60), 'Source ralenti': one(isr, ''), 'Ralenti prolongé (h)': r2_(a.idleLong / 60),
      'Nb ralentis prolongés': a.nLong, 'Carburant (L)': fuelOk ? r1_(a.fuel) : '', 'Km mesurés carburant': r1_(a.fuelKm),
      'L/100 km': a.fuelKm >= P.minFuelKm ? r1_(a.fuel / a.fuelKm * 100) : '',
      'Source carburant': srcs.length ? (srcs.length > 1 ? 'Mixte' : srcs[0]) : 'Non mesuré',
      'Carburant ralenti (L)': a.idleFuelN ? r2_(a.idleFuel) : '', 'Source carburant ralenti': one(ifs, ''),
      'Coût carburant (MAD)': fuelOk && v.price > 0 ? Math.round(a.fuel * v.price) : '',
      'Coût ralenti (MAD)': a.idleFuelN && v.price > 0 ? Math.round(a.idleFuel * v.price) : '',
      'Vmax (km/h)': a.vmax, 'Limite à Vmax': a.limVmax, 'Pire dépassement (km/h)': a.worst === null ? '' : a.worst,
      'Événements': a.evts, 'Points danger': r1_(a.pts), 'Score /100 km': r1_(score), 'Pleins': a.pleins,
      'Litres pleins (jauge)': r1_(a.pleinsL), 'Siphonages suspects': a.siph, 'Litres suspects': r1_(a.siphL), 'Km hors contrat': r1_(a.kmHors)
    });
  }).filter(Boolean).sort((x, y) => y[1] - x[1] || tms_(y[7]) - tms_(x[7]) || String(x[2]).localeCompare(String(y[2])));
}
function buildAlerts_(T, E, F, Il, jrn, veh, rules, P, cidx, cut) {
  const IT = idx_(H.TRIP), IE = idx_(H.EVT), IF = idx_(H.FUEL), II = idx_(H.IDL), IJ = idx_(H.JRN);
  const out = [];
  const add = (key, date, plate, code, nom, type, grav, detail, val, noTime) => {
    const d = date instanceof Date ? date : toDate_(date);
    out.push([key, d ? dayToDate_(localDay_(d)) : '', d && !noTime ? localHM_(d) : '', plate, code, nom, type, grav, detail, val, '', '']);
  };
  const map = (la, lo) => la !== '' && lo !== '' && la != null ? ' https://maps.google.com/?q=' + la + ',' + lo : '';
  // Siphonage
  F.rows.forEach(r => {
    if (r[IF['Type']] !== 'SIPHONAGE_SUSPECT') return;
    const nxt = r[IF['Chauffeur suivant']] ? ' / redémarré par ' + r[IF['Chauffeur suivant']] : '';
    add('SIPH|' + r[0], r[IF['Arrêt début']], r[IF['Plaque']], r[IF['Code chauffeur']], r[IF['Chauffeur']], 'Siphonage suspect', 'Critique',
      'Jauge ' + r[IF['Niveau avant (%)']] + ' % → ' + r[IF['Niveau après (%)']] + ' % pendant un arrêt moteur coupé de ' + r[IF['Durée arrêt (min)']] +
      ' min, sans trajet (' + fmtDT_(r[IF['Arrêt début']]) + ' → ' + fmtDT_(r[IF['Arrêt fin']]) + ')' + nxt + map(r[IF['Lat']], r[IF['Lon']]),
      r[IF['Litres (jauge)']] !== '' ? Math.abs(num_(r[IF['Litres (jauge)']])) + ' L' : r[IF['Écart (%)']] + ' %');
  });
  // Trajets non enregistrés : le compteur km du véhicule avance pendant une coupure du boîtier
  F.rows.forEach(r => {
    if (r[IF['Type']] !== 'TRAJET_NON_ENREGISTRE') return;
    add('TNE|' + r[0], r[IF['Arrêt début']], r[IF['Plaque']], r[IF['Code chauffeur']], r[IF['Chauffeur']], 'Trajet non enregistré (boîtier coupé)', 'Critique',
      'Boîtier Geotab sans contact de ' + fmtDT_(r[IF['Arrêt début']]) + ' à ' + fmtDT_(r[IF['Arrêt fin']]) + ' mais le compteur kilométrique du véhicule a avancé de ' +
      String(r[IF['Moteur']]).split(' ')[0] + ' km' + (r[IF['Litres (jauge)']] !== '' ? ', jauge ' + r[IF['Litres (jauge)']] + ' L' : '') +
      '. Le véhicule a roulé sans être suivi : boîtier débranché, privé d\'alimentation ou en panne' + map(r[IF['Lat']], r[IF['Lon']]), String(r[IF['Moteur']]).split(' ')[0] + ' km');
  });
  // Vitesse
  T.rows.forEach(r => {
    const vm = num_(r[IT['Vmax (km/h)']]), w = r[IT['Pire dépassement (km/h)']];
    if (vm >= P.vmaxAlert) add('VIT|' + r[0], r[IT['Début']], r[IT['Plaque']], r[IT['Code chauffeur']], r[IT['Chauffeur']], 'Vitesse excessive', 'Haute',
      'Vmax ' + vm + ' km/h' + (r[IT['Limite à Vmax']] !== '' ? ' (limite de la route ' + r[IT['Limite à Vmax']] + ' km/h)' : '') + ', trajet du ' + fmtDT_(r[IT['Début']]), vm + ' km/h');
    const ob = String(P.overByLimit || '').trim() ? overAlertOf_(r, IT, P) : null;   // seuils par limite de route (19_speed.gs) ; vides : règle du v6
    if (ob) add('DEP|' + r[0], r[IT['Début']], r[IT['Plaque']], r[IT['Code chauffeur']], r[IT['Chauffeur']], 'Dépassement limite', 'Haute', ob.detail, ob.value);
    else if (!String(P.overByLimit || '').trim() && w !== '' && num_(w) >= P.overAlert) add('DEP|' + r[0], r[IT['Début']], r[IT['Plaque']], r[IT['Code chauffeur']], r[IT['Chauffeur']], 'Dépassement limite', 'Haute',
      r[IT['Vitesse au pire']] + ' km/h pour ' + r[IT['Limite au pire']] + ' km/h autorisés à ' + r[IT['Heure pire']], '+' + w + ' km/h');
  });
  // Ralenti prolongé : chaque arrêt moteur allumé au-delà du seuil d'alerte
  Il.rows.forEach(r => {
    const d = idleCounted_(r);
    if (d < P.idleAlertMin) return;
    const ver = r[II['Vérification moteur']] === 'Régime moteur';
    add('RALP|' + r[0], r[II['Début']], r[II['Plaque']], r[II['Code chauffeur']], r[II['Chauffeur']], 'Ralenti prolongé', d >= 2 * P.idleAlertMin ? 'Haute' : 'Moyenne',
      'Véhicule immobile de ' + localHM_(toDate_(r[II['Début']])) + ' à ' + localHM_(toDate_(r[II['Fin']])) + ' (' + r[II['Durée arrêt (min)']] + ' min), ' +
      (ver ? 'moteur thermique tournant ' + d + ' min (régime moteur)' : 'contact mis, régime moteur non disponible') +
      (r[II['Litres']] !== '' ? ', ' + r[II['Litres']] + ' L (' + r[II['Source litres']] + ')' : '') + map(r[II['Lat']], r[II['Lon']]), d + ' min');
  });
  // Événements moteur / boîtier
  const motor = {};
  E.rows.forEach(r => {
    const rid = String(r[IE['Règle ID']]), cat = rules[rid] ? rules[rid].cat : '';
    if (cat === 'Moteur') { const k = toDayStr_(r[IE['Date']]) + '|' + r[IE['Clé plaque']]; (motor[k] = motor[k] || { r, n: 0 }).n++; }
    if (cat === 'Collision') add('COL|' + r[0], r[IE['Début']], r[IE['Plaque']], r[IE['Code chauffeur']], r[IE['Chauffeur']], 'Collision', 'Critique', r[IE['Règle']] + ' détectée par le boîtier Geotab', '');
    if (cat === 'Boîtier') add('BOI|' + r[0], r[IE['Début']], r[IE['Plaque']], r[IE['Code chauffeur']], r[IE['Chauffeur']], 'Boîtier Geotab', 'Critique', r[IE['Règle']], '');
  });
  Object.keys(motor).forEach(k => { const m = motor[k], r = m.r;
    add('MOT|' + k, r[IE['Début']], r[IE['Plaque']], r[IE['Code chauffeur']], r[IE['Chauffeur']], 'Défaut moteur', 'Moyenne',
      m.n + ' événement(s) ' + r[IE['Règle']] + ', premier à ' + localHM_(toDate_(r[IE['Début']])), m.n, true); });
  // Par journée de travail (contrat)
  jrn.forEach(j => {
    const key = j[IJ['Clé']], d = j[IJ['Date']], code = j[IJ['Code chauffeur']], nom = j[IJ['Chauffeur']], pl = j[IJ['Plaque']];
    const horaires = j[IJ['Début contrat']] ? ' (contrat ' + j[IJ['Contrat']] + ', ' + fmtDT_(j[IJ['Début contrat']]) + ' → ' + (j[IJ['Fin contrat']] ? fmtDT_(j[IJ['Fin contrat']]) : 'en cours') + ')' : '';
    const longMin = Math.round(num_(j[IJ['Ralenti prolongé (h)']]) * 60);
    if (longMin >= P.idleDayMin) add('RALJ|' + key, d, pl, code, nom, 'Ralenti prolongé sur la journée', longMin >= 2 * P.idleDayMin ? 'Haute' : 'Moyenne',
      j[IJ['Nb ralentis prolongés']] + ' arrêts moteur allumé totalisant ' + fmtH_(longMin / 60) + horaires +
      (j[IJ['Carburant ralenti (L)']] !== '' ? ', ' + j[IJ['Carburant ralenti (L)']] + ' L au ralenti' : ''), fmtH_(longMin / 60), true);
    if (code === HORS && nom === 'Hors contrat' && num_(j[IJ['Km']]) >= 1) add('HC|' + key, d, pl, code, nom, 'Usage hors contrat', 'Haute',
      j[IJ['Km']] + ' km roulés sans contrat actif (' + j[IJ['Trajets']] + ' trajets)', j[IJ['Km']] + ' km', true);
    const v = veh[plateKey_(pl)], l100 = j[IJ['L/100 km']];
    if (v && v.ref > 0 && l100 !== '' && num_(l100) > v.ref * (1 + P.overConsPct / 100))
      add('CONSO|' + key, d, pl, code, nom, 'Surconsommation', 'Moyenne', l100 + ' L/100 km mesurés (' + j[IJ['Source carburant']] + ') pour ' + v.ref + ' de référence' + horaires, l100 + ' L/100', true);
    const sc = num_(j[IJ['Score /100 km']]);
    if (code !== HORS && sc >= P.scoreR && num_(j[IJ['Km']]) >= P.kmMin) add('DANG|' + key, d, pl, code, nom, 'Conduite dangereuse', 'Haute',
      j[IJ['Événements']] + ' événements, ' + j[IJ['Points danger']] + ' points sur ' + j[IJ['Km']] + ' km' + horaires, sc + ' /100 km', true);
  });
  // Aucune donnée Geotab alors qu'un contrat est actif
  const Sy = readRef_('SYNC', cut ? 'day=gte.' + cut : ''), IS = idx_(H.SYNC);
  Sy.rows.forEach(r => {
    if (num_(r[IS['Trajets']]) > 0) return;
    const key = String(r[IS['Clé plaque']]), day = toDayStr_(r[IS['Date']]); if (!day || (cut && day < cut)) return;
    const b = dayBounds_(day), end = Math.min(b.end.getTime(), Date.now());
    let covered = 0, who = null;
    (cidx[key] || []).forEach(c => { const ov = Math.min(c.end, end) - Math.max(c.start, b.start.getTime()); if (ov > 0) { covered += ov; who = c; } });
    if (covered >= 3 * HOUR && who) add('NODATA|' + key + '|' + day, dayToDate_(day), (veh[key] || {}).plate || key, who.code, who.nom, 'Aucune donnée Geotab', 'Haute',
      'Contrat actif ' + Math.round(covered / HOUR) + ' h sans aucun trajet remonté : véhicule immobile ou boîtier débranché', Math.round(covered / HOUR) + ' h', true);
  });
  // Nouveaux chauffeurs
  const D = readRef_('DRV', 'status=eq.NOUVEAU'), ID = idx_(H.DRV);
  D.rows.forEach(r => { if (r[ID['Statut']] === 'NOUVEAU') add('NEW|' + r[0], r[ID['Détecté le']] || r[ID['Premier contrat']], '', r[0], r[1], 'Nouveau chauffeur', 'Info',
    'Premier contrat le ' + fmtDT_(r[ID['Premier contrat']]) + (r[ID['Note']] ? ' | ' + r[ID['Note']] : ''), '', true); });
  // v6 : seulement les alertes datées à partir de cut (le reste du tableau n'est pas touché)
  const outC = cut ? out.filter(r => r[1] && toDayStr_(r[1]) >= cut) : out;
  // Fusion avec les statuts existants
  const A = { rows: [] }, IA = idx_(H.ALERT), old = {};   // base : statuts conservés par replace_alerts
  A.rows.forEach(r => { old[String(r[0])] = r; });
  outC.forEach(r => { const o = old[r[0]]; r[IA['Statut']] = o ? o[IA['Statut']] : 'À traiter'; r[IA['Commentaire']] = o ? o[IA['Commentaire']] : ''; });
  outC.sort(alertSort_);
  return outC;
}
function fmtH_(h) { const m = Math.round(num_(h) * 60); return Math.floor(m / 60) + 'h' + ('0' + (m % 60)).slice(-2); }
function idleCounted_(r) {
  const I = idx_(H.IDL);
  return r[I['Vérification moteur']] === 'Régime moteur' ? num_(r[I['Moteur tournant (min)']]) : num_(r[I['Durée arrêt (min)']]);
}