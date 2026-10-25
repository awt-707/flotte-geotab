// ============================================================================
// ÉCRITURE DES DONNÉES, TABLEAUX CALCULÉS, EN DIRECT
// ============================================================================
/** Table engine_stops absente (migration pas encore exécutée) : signalé une fois par jour */
function stopsMissing_(e) {
  // seulement « fonction ou table inconnue » (le chemin rpc/finalize_vdays figure dans tous les messages : une erreur passagère n'est pas une migration absente)
  if (!/PGRST20[25]|42P01|42883|Could not find the (function|table)|relation .*engine_stops.* does not exist/.test(String(e && e.message))) return false;
  const props = PropertiesService.getScriptProperties(), d = localDay_(new Date());
  if (props.getProperty('STOPS_WARN') !== d) { props.setProperty('STOPS_WARN', d); log_('Arrêts moteur', 'Table engine_stops absente : exécuter supabase/migrations/20261017000000_arrets_moteur.sql dans Supabase > SQL Editor'); }
  return true;
}
/** Lignes temps réel (provisoires) : une ligne finalisée ou une journée finalisée n'est jamais modifiée */
function putLive_(k, rows) {
  const objs = rows.map(r => toDb_(k, r, false));
  for (let i = 0; i < objs.length; i += 2000) dbRpc_('put_rows', { p_table: DB[k].table, p_keys: [], p_rows: objs.slice(i, i + 2000), p_final: false });
}
/** Finalisation : toutes les lignes des véhicule-jours de acc.days sont remplacées (une transaction par lot de 6 véhicule-jours) */
function flush_(acc) {
  if (!acc.days.length) return;
  const actx = attribCtx_();
  attribRows_('TRIP', acc.trips, actx); attribRows_('IDL', acc.idles, actx); attribRows_('STP', acc.stops, actx); attribRows_('EVT', acc.evts, actx); attribRows_('FUEL', acc.fuels, actx);
  const days = acc.days.filter((d, i, a) => a.indexOf(d) === i), lots = chunks_(days, 6), pos = {};
  days.forEach((d, i) => { pos[d] = Math.floor(i / 6); });
  const parts = lots.map(() => ({ trips: [], idles: [], stops: [], events: [], fuel: [], levels: [], sync: [] }));
  const lotOf = (key, day) => { const p = pos[key + '|' + day]; if (p !== undefined) return p;
    const any = days.findIndex(d => d.indexOf(key + '|') === 0); return any >= 0 ? pos[days[any]] : parts.length - 1; };
  [['TRIP', acc.trips, 'trips'], ['IDL', acc.idles, 'idles'], ['STP', acc.stops, 'stops'], ['EVT', acc.evts, 'events'], ['FUEL', acc.fuels, 'fuel'], ['LVL', acc.lvls, 'levels']].forEach(x => {
    const I = idx_(H[x[0]]);
    x[1].forEach(r => { const o = toDb_(x[0], r, true); parts[lotOf(o.vehicle_key, o.vday)][x[2]].push(o); });
  });
  acc.sync.forEach(r => { const o = toDb_('SYNC', r); parts[lotOf(o.vehicle_key, o.day)].sync.push(o); });
  lots.forEach((keys, i) => {
    const p = parts[i];
    const args = { p_keys: keys, p_trips: p.trips, p_idles: p.idles, p_events: p.events, p_fuel: p.fuel, p_levels: p.levels, p_sync: p.sync };
    // arrêts moteur tournant : ignorés tant que la migration 20261017000000_arrets_moteur.sql n'est pas exécutée (la collecte continue)
    try { dbRpc_('finalize_vdays', Object.assign({ p_stops: p.stops }, args)); }
    catch (e) { if (!stopsMissing_(e)) throw e; dbRpc_('finalize_vdays', args); }
  });
  memoClear_();
}
/**
 * Journal (une ligne par journée de travail) et alertes recalculés à partir de fromDay - 3 jours.
 * Données lues à partir de fromDay - 4 jours (une journée de travail de nuit commence la veille).
 */
function updateDerived_(fromDay) {
  const t0 = Date.now(), P = params_(), veh = vehicles_(), rules = rulesMap_(), cidx = contractIndex_();
  // jamais avant les données détaillées conservées (archivées dans Drive au-delà) : journal et alertes plus anciens gardés tels quels
  const keepFrom = addDays_(localDay_(new Date()), -Math.max(7, P.retentionDays || 62));
  const cut = [addDays_(fromDay, -3), keepFrom].sort()[1], c0 = dayBounds_(cut).start.getTime(), lim = addDays_(fromDay, -31), longs = {};
  // contrat long encore en cours à « cut » : sa ligne de journal (datée du début du contrat) est recalculée en entier,
  // données relues depuis son début ; sinon elle resterait figée à ses premiers jours.
  // Commencé plus de 31 jours avant (ou jamais clôturé) : ligne et alertes gardées telles quelles (un total sur une partie du contrat serait faux)
  let dataFrom = addDays_(fromDay, -4);
  Object.keys(cidx).forEach(k => cidx[k].forEach(c => {
    if (c.start >= c0 || c.end < c0) return;
    const d = addDays_(localDay_(new Date(c.start)), -1); if (d < lim) return;
    longs[c.num] = 1; if (d < dataFrom) dataFrom = d;
  }));
  const T = readData_(S.TRIP, dataFrom), E = readData_(S.EVT, dataFrom), F = readData_(S.FUEL, dataFrom), Il = readData_(S.IDL, dataFrom);
  const IJ = idx_(H.JRN);
  const jrn = buildJournalier_(T, E, F, veh, rules, P, fauxPositifs_(), contractInfoFor_([T, E, F]))
    .filter(r => toDayStr_(r[IJ['Date']]) >= cut || longs[String(r[IJ['Contrat']] || '')]);
  dbRpc_('replace_journal', { p_cut: cut, p_rows: jrn.map(r => toDb_('JRN', r)) });
  // contrats longs : leurs alertes de journée de travail (datées du début du contrat, avant cut) recalculées aussi, sinon figées
  const longKeys = {}; let cutA = cut;
  jrn.forEach(r => { const d = toDayStr_(r[IJ['Date']]); if (d < cut && longs[String(r[IJ['Contrat']] || '')]) { longKeys[String(r[IJ['Clé']])] = 1; if (d < cutA) cutA = d; } });
  const al = buildAlerts_(T, E, F, Il, jrn, veh, rules, P, cidx, cutA)
    .filter(r => toDayStr_(r[1]) >= cut || longKeys[String(r[0]).replace(/^[A-Z]+\|/, '')]);
  dbRpc_('replace_alerts', { p_cut: cut, p_rows: al.map(r => toDb_('ALERT', r)) });
  // seuil plus atteint sur un contrat long (moyenne qui redescend) : son ancienne alerte est retirée
  const keep = {}; al.forEach(r => { keep[String(r[0])] = 1; });
  const stale = []; Object.keys(longKeys).forEach(k => ['RALJ', 'CONSO', 'DANG'].forEach(t => { if (!keep[t + '|' + k]) stale.push(t + '|' + k); }));
  for (let i = 0; i < stale.length; i += 40) dbDelete_('alerts', 'id=' + inList_(stale.slice(i, i + 40)));
  PropertiesService.getScriptProperties().setProperty('DERIVED_LAST', String(Date.now()));
  return { jrn: jrn.length, alerts: al.length, ms: Date.now() - t0 };
}
/** Colonnes chauffeur (et nom de règle / chauffeur suivant) recalculées sur les lignes datées à partir de fromDay */
function reattribute_(fromDay) {
  const ctx = attribCtx_(), col = { 'Code chauffeur': 'driver_code', 'Chauffeur': 'driver_name', 'Contrat': 'contract_num', 'Règle': 'rule_name', 'Chauffeur suivant': 'next_driver' };
  let n = 0;
  ['TRIP', 'IDL', 'STP', 'EVT', 'FUEL'].forEach(k => {
    let A; try { A = readData_(k, fromDay); } catch (e) { if (k === 'STP' && stopsMissing_(e)) return; throw e; }
    if (!A.rows.length) return;
    const I = A.I, cols = ['Code chauffeur', 'Chauffeur', 'Contrat'].concat(k === 'EVT' ? ['Règle'] : k === 'FUEL' ? ['Chauffeur suivant'] : []);
    const sig = r => cols.map(c => String(r[I[c]])).join('|');
    const rows = A.rows.map(r => r.slice()), before = rows.map(sig);
    attribRows_(k, rows, ctx);
    const ch = rows.filter((r, i) => sig(r) !== before[i]).map(r => {
      const o = { id: String(r[0]), vehicle_key: String(r[I['Clé plaque']]), vday: rowDay_(k, r, I) };
      cols.forEach(c => { o[col[c]] = r[I[c]] === '' ? null : String(r[I[c]]); });
      return o;
    });
    if (ch.length) { dbUpsert_(DB[k].table, ch, 'id'); n += ch.length; }
  });
  memoClear_();
  return n;
}

// ---------- En direct ----------
/** "1.02:13:00" / "02:13:00" -> minutes */
function durMin_(s) { const m = String(s || '').match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/); return m ? (+(m[1] || 0)) * 1440 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 60 : null; }
/** Table live_status (page « En direct » du site) : état de chaque véhicule + totaux du jour */
function writeLive_(status) {
  const veh = vehicles_(), cidx = contractIndex_(), now = Date.now(), today = localDay_(now);
  const T = readData_(S.TRIP, today), IT = T.I, tot = {};
  T.rows.forEach(r => {
    if (toDayStr_(r[IT['Date']]) !== today) return;
    const k = String(r[IT['Clé plaque']]), o = tot[k] = tot[k] || { km: 0, drive: 0, idle: 0, fuel: 0, fuelN: 0 };
    o.km += num_(r[IT['Km']]); o.drive += num_(r[IT['Conduite (min)']]); o.idle += num_(r[IT['Ralenti moteur tournant (min)']]);
    if (r[IT['Carburant (L)']] !== '') { o.fuel += num_(r[IT['Carburant (L)']]); o.fuelN++; }
  });
  const nAl = {};
  dbSelect_('alerts', 'select=id,vehicle_key&day=eq.' + today, 'id').forEach(r => { nAl[r.vehicle_key] = (nAl[r.vehicle_key] || 0) + 1; });
  const rows = Object.values(veh).filter(v => v.active).map(v => {
    const x = status[v.key] || {}, d = x.dsi, o = tot[v.key] || { km: 0, drive: 0, idle: 0, fuel: 0, fuelN: 0 };
    const c = findContract_(cidx, v.key, now, 0);
    const last = d && d.dateTime ? new Date(d.dateTime) : null, age = last ? (now - last.getTime()) / MIN : null;
    let state;
    if (!v.geoId) state = 'Non relié à Geotab';
    else if (!d) state = 'Pas de réponse Geotab';
    else if (d.isDeviceCommunicating === false && age > 30) state = 'Boîtier hors ligne';
    else if (d.isDriving) state = 'En route';
    else if (x.ignOn) state = 'Arrêté, contact mis';
    else state = 'Garé';
    const dm = d ? durMin_(d.currentStateDuration) : null;
    return { vehicle_key: v.key, plate: v.plate, model: v.model, state, speed: d && d.isDriving ? Math.round(+d.speed || 0) : 0,
      since_min: dm != null ? Math.round(dm) : null, last_pos_at: last ? last.toISOString() : null,
      lat: d && isFinite(+d.latitude) ? +d.latitude : null, lon: d && isFinite(+d.longitude) ? +d.longitude : null,
      ign_on: x.ignOn === undefined ? null : x.ignOn, driver_name: c ? c.nom : 'Aucun contrat', contract_num: c ? c.num : null,
      km_today: r1_(o.km), drive_min_today: Math.round(o.drive), idle_min_today: Math.round(o.idle), fuel_l_today: o.fuelN ? r1_(o.fuel) : null,
      alerts_today: nAl[v.key] || 0, updated_at: new Date(now).toISOString() };
  });
  if (rows.length) {
    dbUpsert_('live_status', rows, 'vehicle_key');
    // véhicules disparus retirés par lots (une liste « not.in » de toutes les clés dépasse vite la longueur d'URL permise)
    const keep = {}; rows.forEach(r => { keep[r.vehicle_key] = 1; });
    const gone = dbSelect_('live_status', 'select=vehicle_key', 'vehicle_key').map(r => r.vehicle_key).filter(k => !keep[k]);
    for (let i = 0; i < gone.length; i += 40) dbDelete_('live_status', 'vehicle_key=' + inList_(gone.slice(i, i + 40)));
  }
  return rows.length;
}

// ---------- Après import de contrats (depuis le site) ----------
function afterInject_(fromDay, runT0) {
  const t0 = Date.now(), msg = [];
  try { const live = liveCatchUp_(jobBudget_(runT0, 90000, 150000)); if (live) { writeLive_(live.status); if (live.n) msg.push(live.n + ' trajets récents ajoutés'); } }
  catch (e) { msg.push('temps réel : ' + e.message); }
  // journées passées des contrats jamais téléchargées (dans la période conservée) : file de finalisation
  try {
    const P = params_(), since = [fromDay, addDays_(localDay_(new Date()), -Math.max(7, P.retentionDays || 62))].sort()[1];
    const miss = missingContractDays_(coverage_(), since).filter(id => dayBounds_(id.split('|')[1]).end.getTime() + 12 * HOUR <= Date.now());
    if (miss.length) { queueDays_(miss.map(id => ({ d: id.split('|')[1], k: id.split('|')[0], solo: 1 }))); msg.push(miss.length + ' journées passées à télécharger (quelques minutes)'); }
  } catch (e) { msg.push('journées manquantes : ' + e.message); }
  const r = rebuild_(addDays_(fromDay, -1));
  clearDirty_(addDays_(fromDay, -1));
  msg.push(r.jrn + ' journées de travail, ' + r.alerts + ' alertes recalculées');
  log_('Après import contrats', msg.join(' | '), t0);
  return msg.join(' | ');
}
/**
 * Ajoute des véhicule-jours à la file de finalisation (traitée par collect). Une propriété Apps Script fait 9 Ko au plus
 * (~200 véhicule-jours) : SYNC_QUEUE garde ce qui tient, le surplus attend dans SYNC_QUEUE_MORE_0, _1… et revient au fil des passages.
 */
const QUEUE_MAX_ = 8000;
function queueMore_(props) { const out = []; for (let i = 0; ; i++) { const v = props.getProperty('SYNC_QUEUE_MORE_' + i); if (!v) return out; JSON.parse(v).forEach(x => out.push(x)); } }
function queueDays_(items) {
  const props = PropertiesService.getScriptProperties(), seen = {};
  const q = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]').concat(queueMore_(props), items || [])
    .filter(x => { const k = x.d + '|' + x.k; if (seen[k]) return false; seen[k] = 1; return true; });
  const parts = [[]]; let size = 2;
  q.forEach(x => { const l = JSON.stringify(x).length + 1; if (size + l > QUEUE_MAX_) { parts.push([]); size = 2; } parts[parts.length - 1].push(x); size += l; });
  props.setProperty('SYNC_QUEUE', JSON.stringify(parts[0]));
  for (let i = 0; ; i++) {
    if (parts[i + 1]) props.setProperty('SYNC_QUEUE_MORE_' + i, JSON.stringify(parts[i + 1]));
    else if (props.getProperty('SYNC_QUEUE_MORE_' + i)) props.deleteProperty('SYNC_QUEUE_MORE_' + i); else break;
  }
  return q.length;
}
/**
 * Finalisation (file SYNC_QUEUE) avec attente en cas de panne Geotab. Le moteur v6 vide la file au 3e échec de suite (SYNC_FAILS) :
 * demandes de retéléchargement, rattrapage du fuseau et journées des contrats importés seraient perdues (dueFinal_ ne remet que
 * les journées jamais finalisées). Ici SYNC_FAILS est remis à 0 avant chaque essai (la file n'est jamais vidée) et les échecs
 * de suite sont comptés dans SYNC_DOWN : à partir du 3e, nouvel essai dans 15 min, puis 30, 60 au plus.
 */
function syncStep_(t0) {
  const props = PropertiesService.getScriptProperties(), wait = +(props.getProperty('SYNC_WAIT') || 0);
  if (wait > Date.now()) return { done: 0, left: 0, warn: [] };
  props.setProperty('SYNC_FAILS', '0');
  const r = syncQueueStep_(t0, MAX_RUN_MS - 60000), down = +(props.getProperty('SYNC_DOWN') || 0);
  if (+(props.getProperty('SYNC_FAILS') || 0) > 0) {
    const n = down + 1; props.setProperty('SYNC_DOWN', String(n));
    if (n >= 3) {
      const min = Math.min(60, 15 * Math.pow(2, n - 3)), left = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]').length + queueMore_(props).length;
      props.setProperty('SYNC_WAIT', String(Date.now() + min * MIN));
      log_('Synchro', n + ' échecs de suite, ' + left + ' véhicule-jours gardés en attente, nouvel essai dans ' + min + ' min. Vérifiez la connexion Geotab. ' + r.warn.join(' ; '), t0);
    }
  } else if (down) { props.deleteProperty('SYNC_DOWN'); props.deleteProperty('SYNC_WAIT'); }
  return r;
}

// ============================================================================
// COLLECTEUR (déclencheur toutes les 5 min)
// ============================================================================
function collect() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;                     // un passage est en cours : prochain passage dans 5 min
  HOLDS_LOCK_ = true; memoClear_();
  const t0 = Date.now(), props = PropertiesService.getScriptProperties(), msg = [];
  try {
    const upd = tryUpdate_(); if (upd) msg.push(upd);                     // nouvelle version publiée (testée) : installée pour le prochain passage
    if (props.getProperty('IMPORT_STEPS')) { if (upd) log_('Collecte', upd, t0); importStep_(t0); return; }   // reprise de l'ancien Sheet : d'abord
    const P = params_();
    try { tzPublish_(); tzFix_(); } catch (e) { msg.push('Fuseau horaire : ' + e.message); }
    let live = null;
    try {
      live = liveRun_(t0, 100000); writeLive_(live.status);
      if (live.n) props.setProperty('LIVE_COUNT', String(+(props.getProperty('LIVE_COUNT') || 0) + live.n));
      if (live.warn.length) msg.push(live.warn.join(' ; '));
    } catch (e) { msg.push('Erreur temps réel : ' + e.message); }
    // Pleins calculés par Geotab après coup : relus à chaque passage pour les journées pas encore finalisées
    try { if (liveFills_() && !(live && live.wrote)) markDirty_(localDay_(Date.now() - DAY)); } catch (e) { msg.push('Pleins : ' + e.message); }
    if (live && live.wrote) markDirty_(localDay_(Date.now() - DAY));
    // Demandes du site (contrats importés, plaques, synchro immédiate, recalcul)
    try { const j = processJobs_(t0); if (j) msg.push(j); } catch (e) { msg.push('Demandes du site : ' + e.message); }
    // Caisse recopiée dans le classeur de sauvegarde (onglets « … Ludy ») : avant le journal, qui peut prendre tout le passage
    { let m = ''; try { m = cashSheetStep_(t0); } catch (e) { m = 'Classeur de la caisse : ' + e.message; } if (m) msg.push(m); cshStatus_(m); }
    // Étude ponctuelle de consommation dans Geotab (véhicules hors parc Ludy), une seule fois
    if (Date.now() - t0 < 150000) { try { const m = geoStudyStep_(t0); if (m) msg.push(m); } catch (e) { msg.push('Étude Geotab : ' + e.message); } }
    // Journal et alertes des derniers jours
    const every = Math.max(5, P.autoRenderMin || 15) * MIN, lastD = +(props.getProperty('DERIVED_LAST') || 0), dirty = props.getProperty('DERIVED_DIRTY');
    if (dirty && Date.now() - lastD >= every - 30000 && Date.now() - t0 < 150000) {
      try { updateDerived_(dirty); props.deleteProperty('DERIVED_DIRTY'); } catch (e) { msg.push('Journal / alertes : ' + e.message); }
    }
    // Nouvelles alertes envoyées par e-mail aux destinataires choisis sur le site
    try { const m = notifyAlerts_(); if (m) msg.push(m); } catch (e) { msg.push('Alertes par e-mail : ' + e.message); }
    // Staff : arrivée non pointée signalée par e-mail (une fois par salarié et par jour)
    try { const m = rhClockStep_(); if (m) msg.push(m); } catch (e) { msg.push('Pointage : ' + e.message); }
    // RH : contrats générés, copies signées / légalisées et avenants signés copiés dans le Drive (une fois chacun)
    if (Date.now() - t0 < 200000) { try { const m = rhDriveFilesStep_(t0); if (m) msg.push(m); } catch (e) { msg.push('Drive RH : ' + e.message); } }
    // Finalisation des journées terminées (une seule fois par véhicule-jour)
    if (Date.now() - t0 < 180000) {
      let n = 0; try { n = queueDays_(dueFinal_(P)); } catch (e) { msg.push('File de finalisation : ' + e.message); n = 1; }   // la file en place est traitée quand même
      if (n) {
        const r = syncStep_(t0);
        if (r.done) msg.push(r.done + ' véhicule-jours finalisés' + (r.left ? ', ' + r.left + ' restants' : ''));
        if (r.warn.length) msg.push(r.warn.join(' ; '));
      }
    }
    // Tâches du jour / du mois, par étapes
    if (Date.now() - t0 < MAX_RUN_MS - 90000) { try { const m = dailyStep_(t0); if (m) msg.push(m); } catch (e) { msg.push('Maintenance : ' + e.message); } }
    // Rapports PDF planifiés (une fois par période, données finalisées)
    if (Date.now() - t0 < MAX_RUN_MS - 60000) { try { const m = reportsStep_(t0); if (m) msg.push(m); } catch (e) { msg.push('Rapports : ' + e.message); } }
    const lastLog = +(props.getProperty('LIVE_LOG_LAST') || 0);
    if (Date.now() - lastLog >= HOUR) {
      msg.unshift((+(props.getProperty('LIVE_COUNT') || 0)) + ' trajets terminés ajoutés depuis ' + (lastLog ? localHM_(lastLog) : 'le démarrage'));
      props.setProperty('LIVE_LOG_LAST', String(Date.now())); props.setProperty('LIVE_COUNT', '0');
    }
    if (msg.length) log_('Collecte', msg.join(' | '), t0);
  } catch (e) { log_('Collecte', 'Erreur : ' + e.message, t0); }
  finally { HOLDS_LOCK_ = false; lock.releaseLock(); }
}
/** Lancement manuel depuis l'éditeur */
function collecterMaintenant() { collect(); }

/** Demandes déposées par le site (table jobs). Les demandes du même type sont traitées ensemble. */
function processJobs_(t0) {
  const jobs = dbSelect_('jobs', 'select=id,kind,arg,created_by,result&done_at=is.null', 'id');
  if (!jobs.length) return '';
  const by = {}, out = [];
  // demande arrêtée en plein traitement (6 min d'Apps Script dépassées) : notée « essai n » avant de commencer, abandonnée au 3e essai
  // (sinon rejouée à chaque passage, qui s'arrête avant les e-mails, la finalisation et les rapports)
  const tries = j => { const m = String(j.result || '').match(/^Essai (\d+)/); return m ? +m[1] : 0; };
  const start = list => { const ids = list.map(j => j.id), n = Math.max(...list.map(tries)) + 1;
    sbReq_('patch', 'jobs?id=in.(' + ids.join(',') + ')', n > 2 ? { done_at: new Date().toISOString(), result: 'Abandonnée : traitement trop long (2 essais). Réessayer sur une période plus courte.' } : { result: 'Essai ' + n + ' en cours' }, { Prefer: 'return=minimal' });
    return n <= 2; };
  jobs.forEach(j => { (by[j.kind] = by[j.kind] || []).push(j); });
  const order = ['apply_plates', 'import_vehicles', 'after_inject', 'resync', 'recompute', 'sync_now', 'send_report', 'driver_report', 'manifest_mail', 'quote_mail', 'rh_drive'];
  // demandes longues (relecture Geotab, recalcul) : lancées seulement s'il reste assez de temps dans le passage (6 min d'Apps Script)
  const heavy = { apply_plates: 1, after_inject: 1, resync: 1, recompute: 1, sync_now: 1, rh_drive: 1 };
  const injDay = args => args.map(a => toDayStr_(a)).filter(Boolean).sort()[0] || addDays_(localDay_(new Date()), -1);
  Object.keys(by).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).forEach(kind => {
    if (Date.now() - t0 > (heavy[kind] ? 150000 : 210000)) return;   // la suite au prochain passage
    if (kind === 'driver_report' || kind === 'manifest_mail' || kind === 'quote_mail') {   // une réponse par demande (chaque utilisateur voit le résultat de la sienne)
      by[kind].forEach(j => {
        if (Date.now() - t0 > 240000) return;
        if (!start([j])) { out.push(kind + ' : abandonnée'); return; }
        let res; try { res = kind === 'manifest_mail' ? jobManifestMail_(j.arg, j.created_by) : kind === 'quote_mail' ? jobQuoteMail_(j.arg, j.created_by) : jobDriverReport_(j.arg, j.created_by); } catch (e) { res = 'Erreur : ' + mailErr_(e); }
        sbReq_('patch', 'jobs?id=eq.' + j.id, { done_at: new Date().toISOString(), result: String(res).slice(0, 2000) }, { Prefer: 'return=minimal' });
        out.push(kind + ' : ' + res);
      });
      return;
    }
    const list = by[kind], args = list.map(j => j.arg).filter(Boolean);
    if (!start(list)) {
      // contrats importés : le recalcul n'est pas perdu (journal et alertes refaits par le passage suivant)
      if (kind === 'after_inject') markDirty_(addDays_(injDay(args), -1));
      out.push(kind + ' : abandonnée'); return;
    }
    let res;
    try {
      if (kind === 'after_inject') res = jobAfterInject_(injDay(args), t0);
      else if (kind === 'apply_plates') res = jobPlates_();
      else if (kind === 'import_vehicles') res = importVehicles(true) + ' véhicules';
      else if (kind === 'sync_now') res = jobSyncNow_(t0);
      else if (kind === 'recompute') res = jobRecompute_(args.map(a => toDayStr_(a)).filter(Boolean).sort()[0]);
      else if (kind === 'resync') res = jobResync_(args, t0);
      else if (kind === 'send_report') res = jobSendReport_(args);
      else if (kind === 'rh_drive') res = [rhDriveFilesStep_(t0), rhDriveSheetsStep_()].filter(Boolean).join(' | ') || 'Drive RH : rien à copier (dossiers non réglés ?)';
      else res = 'Demande inconnue : ' + kind;
    } catch (e) { res = 'Erreur : ' + e.message; }
    const ids = list.map(j => j.id);
    sbReq_('patch', 'jobs?id=in.(' + ids.join(',') + ')', { done_at: new Date().toISOString(), result: String(res).slice(0, 2000) }, { Prefer: 'return=minimal' });
    out.push(kind + ' : ' + res);
    memoClear_();
  });
  return out.join(' | ');
}
function jobAfterInject_(fromDay, t0) {
  const dr = refreshDrivers_();
  if (canonContracts_()) rekeyAll_();
  let m = afterInject_(fromDay, t0);
  if (dr.newDrivers.length) m += ' | nouveaux chauffeurs : ' + dr.newDrivers.join(', ');
  return m;
}
/** Recalcul fait à partir de day : la demande de recalcul en attente (journées finalisées) n'est effacée que si elle est couverte */
function clearDirty_(day) { const p = PropertiesService.getScriptProperties(), d = p.getProperty('DERIVED_DIRTY'); if (d && (!day || d >= day)) p.deleteProperty('DERIVED_DIRTY'); }
function jobPlates_() {
  importVehicles(true);
  const minDay = rekeyAll_();
  const from = minDay || addDays_(localDay_(new Date()), -7), r = rebuild_(from);
  clearDirty_(from);
  return 'plaques appliquées, ' + r.jrn + ' journées de travail recalculées';
}
/**
 * Temps donné à la relecture Geotab d'une demande : compté depuis le début du passage (t0, la demande peut commencer
 * plusieurs minutes après), « reserve » gardée pour la suite (recalcul…), « cap » au plus, 15 s au moins
 */
function jobBudget_(t0, cap, reserve) { return Math.max(15000, Math.min(cap, MAX_RUN_MS - reserve - (t0 ? Date.now() - t0 : 0))); }
function jobSyncNow_(t0) {
  const live = liveCatchUp_(jobBudget_(t0, MAX_RUN_MS - 150000, 120000));
  writeLive_(live.status);
  updateDerived_(localDay_(Date.now() - DAY));
  clearDirty_(localDay_(Date.now() - DAY));
  return (live.n ? live.n + ' trajets terminés ajoutés' : 'aucun nouveau trajet terminé') + (live.warn.length ? ' | ' + live.warn.join(' ; ') : '');
}
function jobRecompute_(fromDay) {
  refreshDrivers_();
  const r = rebuild_(fromDay);
  clearDirty_(fromDay || addDays_(localDay_(new Date()), -31));
  return r.jrn + ' journées de travail, ' + r.alerts + ' alertes';
}
/** Retéléchargement de journées : arg = « aaaa-mm-jj » ou « aaaa-mm-jj|aaaa-mm-jj » (période), éventuellement « |PLAQUE » */
function jobResync_(args, t0) {
  const veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId), items = [];
  let live = 0;
  args.forEach(a => {
    const p = String(a).split('|'), d1 = toDayStr_(p[0]), d2 = toDayStr_(p[1]) || d1, only = p[2] ? plateKey_(p[2]) : '';
    if (!d1) return;
    for (let d = d1, g = 0; d <= d2 && g < 62; d = addDays_(d, 1), g++) {
      if (dayBounds_(d).end.getTime() + 12 * HOUR > Date.now()) { live++; continue; }
      list.forEach(v => { if (!only || v.key === only) items.push({ d, k: v.key, solo: 1 }); });
    }
  });
  if (items.length) queueDays_(items);
  if (live) { const l = liveCatchUp_(jobBudget_(t0, 90000, 60000)); writeLive_(l.status); markDirty_(localDay_(Date.now() - DAY)); }
  return items.length + ' véhicule-jours à retélécharger' + (live ? ', journées récentes mises à jour en temps réel' : '');
}

// ============================================================================
// TÂCHES DU JOUR ET DU MOIS (par étapes, entre deux collectes)
// ============================================================================
function dailyStep_(t0) {
  const props = PropertiesService.getScriptProperties(), now = new Date(), today = localDay_(now), h = +localHM_(now).slice(0, 2);
  let st = JSON.parse(props.getProperty('DAILY') || 'null');
  if (!st || st.day !== today) {
    if (h < 2 && st) return '';                                        // la nuit, après 2 h
    st = { day: today, steps: ['vehicles', 'rules', 'drivers', 'backup', 'prune', 'size', 'manifests', 'rh', 'rhdrive'] };
    const month = today.slice(0, 7);
    if (props.getProperty('ARCH_MONTH') !== month) st.steps.push('arch:trips', 'arch:idles', 'arch:engine_stops', 'arch:events', 'arch:fuel', 'arch:levels',
      'arch:vehicle_days', 'arch:journal', 'arch:alerts', 'arch:done');
  }
  const out = [];
  while (st.steps.length && Date.now() - t0 < MAX_RUN_MS - 90000) {
    const s = st.steps[0];
    try {
      if (s === 'vehicles') importVehicles(true);
      else if (s === 'rules') syncRules_();
      else if (s === 'drivers') { const d = refreshDrivers_(); if (d.newDrivers.length) out.push('nouveaux chauffeurs : ' + d.newDrivers.join(', ')); }
      else if (s === 'backup') out.push(backup_());
      else if (s === 'prune') { dbRpc_('purge_before', { p_table: 'logs', p_before: addDays_(today, -30) }); dbRpc_('purge_before', { p_table: 'jobs', p_before: addDays_(today, -30) }); }
      else if (s === 'size') { const z = dbRpc_('db_size'); if (z && z.total_mb > 400) out.push('Base : ' + z.total_mb + ' Mo sur 500 Mo gratuits, réduire « Données détaillées conservées »'); props.setProperty('DB_MB', String(z ? z.total_mb : '')); }
      else if (s === 'manifests') { const m = pruneManifests_(); if (m) out.push(m); }
      else if (s === 'rh') { const m = rhDigest_(); if (m) out.push(m); }
      else if (s === 'rhdrive') { const m = rhDriveSheetsStep_(); if (m) out.push(m); }
      else if (s === 'arch:done') props.setProperty('ARCH_MONTH', today.slice(0, 7));
      else if (s.indexOf('arch:') === 0) { const m = archiveTable_(s.slice(5)); if (m) out.push(m); }
    } catch (e) { out.push(s + ' : ' + e.message); }
    st.steps.shift();
    props.setProperty('DAILY', JSON.stringify(st));
    memoClear_();
  }
  return out.join(' | ');
}
/**
 * PDF des manifestes plus anciens que « manifestKeepDays » (30 j ; 0 = jamais) effacés du stockage (quota de l'offre Supabase) ;
 * l'historique du manifeste reste (sans PDF). Sans la table (migration pas encore exécutée) : rien à faire.
 */
function pruneManifests_() {
  const days = +params_().manifestKeepDays;
  if (!(days > 0)) return '';
  let rows;
  try { rows = dbSelect_('manifests', 'select=id,file_path&file_path=not.is.null&created_at=lt.' + enc_(new Date(Date.now() - days * 86400000).toISOString()), 'id'); }
  catch (e) { if (/HTTP 404|PGRST205|does not exist/.test(e.message)) return ''; throw e; }
  if (!rows.length) return '';
  const c = sbConf_(), h = Object.assign({ apikey: c.key }, /^sb_/.test(c.key) ? {} : { Authorization: 'Bearer ' + c.key });
  let n = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100);
    const r = UrlFetchApp.fetch(c.url + '/storage/v1/object/manifestes', { method: 'delete', muteHttpExceptions: true, contentType: 'application/json', headers: h,
      payload: JSON.stringify({ prefixes: part.map(x => x.file_path) }) });
    if (r.getResponseCode() >= 300) throw new Error('stockage : HTTP ' + r.getResponseCode() + ' ' + String(r.getContentText()).slice(0, 200));
    sbReq_('patch', 'manifests?id=in.(' + part.map(x => x.id).join(',') + ')', { file_path: null }, { Prefer: 'return=minimal' });
    n += part.length;
  }
  return n + ' PDF de manifestes de plus de ' + days + ' jours effacés du stockage';
}
function driveFolder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
/** Sauvegarde quotidienne dans Drive de ce qui est saisi à la main (contrats, plaques, chauffeurs, réglages, statuts d'alertes) */
function backup_() {
  const o = { at: new Date().toISOString(), version: COLLECTOR_V };
  const base = [['vehicles', 'key'], ['plate_changes', 'id'], ['drivers', 'code'], ['contracts', 'num'], ['rules', 'id'], ['params', 'key'], ['profiles', 'user_id'],
    ['parc', 'plate'], ['agencies', 'id'], ['user_agencies', 'user_id,agency_id'], ['alert_recipients', 'id'], ['report_schedules', 'id']];
  // tables ajoutées par les migrations récentes : absentes tant que la migration n'est pas exécutée (sauvegarde du reste quand même)
  const later = [['fuel_card_tx', 'id'], ['manager_shifts', 'agency_id,user_id,day,shift'], ['manifest_config', 'id'], ['manifests', 'id'],
    ['missions', 'id'], ['pricing_grid', 'id'], ['cash_moves', 'id'], ['cash_log', 'id'], ['uber_drivers', 'uuid'], ['uber_payments', 'tx'],
    ['driver_roster', 'driver_code'], ['driver_plan', 'id'], ['driver_absences', 'id'], ['plan_weeks', 'agency_id,week'],
    ['employers', 'id'], ['work_contracts', 'id'], ['hr_employees', 'id'], ['hr_events', 'id'], ['hr_clock', 'id'], ['hr_documents', 'id']];
  base.forEach(t => { o[t[0]] = dbSelect_(t[0], 'select=*', t[1]); });
  later.forEach(t => { try { o[t[0]] = dbSelect_(t[0], 'select=*', t[1]); } catch (e) { o[t[0]] = 'absente : ' + e.message; } });
  o.alerts = dbSelect_('alerts', 'select=id,status,comment&or=' + enc_('(status.neq.À traiter,comment.neq.)'), 'id');
  o.fuel_status = dbSelect_('fuel', 'select=id,status&status=not.in.' + enc_('("À vérifier","Info")'), 'id');
  const f = driveFolder_('Flotte Geotab - Sauvegardes'), name = 'sauvegarde_' + localDay_(new Date()) + '.json';
  f.createFile(name, JSON.stringify(o), 'application/json');
  // 14 dernières sauvegardes conservées
  const files = [], it = f.getFiles();
  while (it.hasNext()) { const x = it.next(); if (/^sauvegarde_/.test(x.getName())) files.push(x); }
  files.sort((a, b) => b.getName().localeCompare(a.getName())).slice(14).forEach(x => x.setTrashed(true));
  return '';
}
/** Archivage mensuel : lignes plus anciennes que la durée de conservation copiées en CSV dans Drive, puis retirées de la base */
function archiveTable_(table) {
  const P = params_(), today = localDay_(new Date());
  const ret = { trips: P.retentionDays, idles: P.retentionDays, engine_stops: P.retentionDays, events: P.retentionDays, fuel: P.retentionDays, levels: P.lvlDays || 30,
    vehicle_days: (P.retentionDays || 62) + 30, journal: 400, alerts: 180 }[table];
  if (!(ret > 0)) return '';
  const cutoff = addDays_(today, -ret), dc = ['vehicle_days', 'journal', 'alerts'].indexOf(table) >= 0 ? 'day' : 'vday';
  if (table !== 'levels') {
    const rows = dbSelect_(table, 'select=*&' + dc + '=lt.' + cutoff, 'id');
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]), q = v => v === null || v === undefined ? '' : (/[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const csv = [cols.join(';')].concat(rows.map(r => cols.map(c => q(r[c])).join(';'))).join('\n');
    driveFolder_('Flotte Geotab - Archives').createFile(table + '_avant_' + cutoff + '_' + today + '.csv', csv, 'text/csv');
  }
  const n = dbRpc_('purge_before', { p_table: table, p_before: cutoff });
  return n ? table + ' : ' + n + ' lignes archivées' : '';
}
