// ============================================================================
// ALERTES PAR E-MAIL ET RAPPORTS PDF AUTOMATIQUES
// Destinataires des alertes : Réglages > Alertes par e-mail (table alert_recipients).
// Rapports planifiés : Réglages > Rapports (table report_schedules). Le PDF est construit avec site/report.js (mêmes calculs que le site).
// ============================================================================
const SEV_RANK = { 'Critique': 0, 'Haute': 1, 'Moyenne': 2, 'Info': 3 };
/** Message d'erreur d'envoi, avec la marche à suivre quand l'autorisation d'envoyer des e-mails n'a pas encore été acceptée */
function mailErr_(e) {
  const m = String(e && e.message || e);
  return /permission|autoris|script\.send_mail/i.test(m) ? m + ' (ouvrez le projet Apps Script et exécutez « installer » une fois pour accepter l\'envoi d\'e-mails)' : m;
}

/** Nouvelles alertes (veille et jour même) envoyées une seule fois à chaque destinataire concerné */
function notifyAlerts_() {
  const props = PropertiesService.getScriptProperties(), today = localDay_(new Date()), now = new Date().toISOString();
  if (!props.getProperty('NOTIFY_FROM')) {   // premier passage : l'historique n'est pas envoyé
    sbReq_('patch', 'alerts?notified_at=is.null', { notified_at: now }, { Prefer: 'return=minimal' });
    props.setProperty('NOTIFY_FROM', today);
    return '';
  }
  const al = dbSelect_('alerts', 'select=id,day,time,plate,vehicle_key,driver_name,type,severity,detail,value&notified_at=is.null', 'id');
  if (!al.length) return '';
  const since = addDays_(today, -1), fresh = al.filter(a => String(a.day) >= since);
  // marquées avant l'envoi : une alerte n'est jamais envoyée deux fois, même si un envoi échoue
  const ids = al.map(a => a.id);
  for (let i = 0; i < ids.length; i += 300) dbRpc_('mark_notified', { p_ids: ids.slice(i, i + 300) });
  if (!fresh.length) return '';
  const rec = dbSelect_('alert_recipients', 'select=id,email,name,agency_id,min_severity,types&active=is.true', 'id');
  if (!rec.length) return '';
  const vAg = {}, agName = {};
  dbSelect_('vehicles', 'select=key,agency_id', 'key').forEach(v => { vAg[v.key] = v.agency_id; });
  dbSelect_('agencies', 'select=id,name', 'id').forEach(a => { agName[a.id] = a.name; });
  let sent = 0; const err = [];
  rec.forEach(r => {
    const types = String(r.types || '').split(',').map(x => x.trim()).filter(Boolean), max = SEV_RANK[r.min_severity] === undefined ? 1 : SEV_RANK[r.min_severity];
    const list = fresh.filter(a => (SEV_RANK[a.severity] === undefined ? 9 : SEV_RANK[a.severity]) <= max && (!r.agency_id || vAg[a.vehicle_key] === r.agency_id) && (!types.length || types.indexOf(a.type) >= 0))
      .sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || (String(x.day) + x.time).localeCompare(String(y.day) + y.time));
    if (!list.length) return;
    const worst = list[0].severity;
    const rows = list.map(a => '<tr><td>' + rptDay(a.day) + ' ' + rptEsc(a.time || '') + '</td><td><b>' + rptEsc(a.plate || '') + '</b></td><td>' + rptEsc(a.driver_name || '') +
      '</td><td>' + rptEsc(a.type) + '</td><td style="color:' + (a.severity === 'Critique' ? '#b42318' : a.severity === 'Haute' ? '#c4320a' : '#5d6b74') + '"><b>' + rptEsc(a.severity) +
      '</b></td><td>' + rptEsc(a.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=(-?[0-9.]+),(-?[0-9.]+)/g, (m, la, lo) => '<a href="https://www.openstreetmap.org/?mlat=' + la + '&mlon=' + lo + '#map=17/' + la + '/' + lo + '">carte</a>') + '</td></tr>').join('');
    const html = '<div style="font-family:Arial,sans-serif;font-size:13px"><p>' + list.length + ' nouvelle' + (list.length > 1 ? 's' : '') + ' alerte' + (list.length > 1 ? 's' : '') +
      (r.agency_id ? ' (agence ' + rptEsc(agName[r.agency_id] || '') + ')' : '') + ' :</p><table cellpadding="4" style="border-collapse:collapse;font-size:12px">' +
      '<tr style="background:#eef0f7"><th align="left">Date</th><th align="left">Plaque</th><th align="left">Chauffeur</th><th align="left">Type</th><th align="left">Gravité</th><th align="left">Détail</th></tr>' +
      rows + '</table><p style="color:#5d6b74;font-size:11px">Suivi et statut des alertes : ' + SITE_URL + '/#/alertes</p></div>';
    try {
      MailApp.sendEmail({ to: r.email, subject: 'Ludy : ' + list.length + ' alerte' + (list.length > 1 ? 's' : '') + ' (' + worst.toLowerCase() + ')' + (list.length === 1 ? ' ' + list[0].type + ' ' + list[0].plate : ''), htmlBody: html, name: 'Ludy' });
      sent++;
    } catch (e) { err.push(r.email + ' : ' + mailErr_(e)); }
  });
  // aucun e-mail parti faute d'autorisation ou de quota : les alertes récentes repartiront au passage suivant (non perdues)
  if (!sent && err.length && err.every(x => /permission|autoris|script\.send_mail|too many times|quota/i.test(x))) {
    const fid = fresh.map(a => a.id);
    for (let i = 0; i < fid.length; i += 40) sbReq_('patch', 'alerts?id=' + inList_(fid.slice(i, i + 40)), { notified_at: null }, { Prefer: 'return=minimal' });
  }
  return (sent ? 'alertes envoyées par e-mail à ' + sent + ' destinataire' + (sent > 1 ? 's' : '') : '') + (err.length ? ' | e-mail impossible : ' + err.join(' ; ') : '');
}

/** Période du dernier rapport complet : jour = veille, semaine = lundi-dimanche précédents, mois = mois précédent */
function reportPeriod_(freq, today) {
  if (freq === 'jour') { const d = addDays_(today, -1); return { key: d, from: d, to: d }; }
  if (freq === 'semaine') {
    const p = today.split('-').map(Number), wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(), mon = addDays_(today, -((wd + 6) % 7) - 7);
    return { key: mon, from: mon, to: addDays_(mon, 6) };
  }
  const first = today.slice(0, 8) + '01', last = addDays_(first, -1);
  return { key: last.slice(0, 7), from: last.slice(0, 8) + '01', to: last };
}
/** Rapport d'une période et d'une agence (vide = toutes) */
function buildReport_(from, to, agencyId, freq) {
  const P = params_();
  const veh = dbSelect_('vehicles', 'select=key,plate,model,active,agency_id', 'key').filter(v => !agencyId || v.agency_id === agencyId);
  const drv = {}; dbSelect_('drivers', 'select=code,name', 'code').forEach(d => { drv[d.code] = d.name; });
  const ag = agencyId ? (dbSelect_('agencies', 'select=id,name&id=eq.' + agencyId, 'id')[0] || {}).name : '';
  return rptBuild({
    journal: dbSelect_('journal', 'select=day,vehicle_key,driver_code,driver_name,contract_num,contract_start,km,drive_h,idle_h,long_idle_h,n_trips,fuel_l,fuel_km,fuel_cost,n_events,danger_pts,n_siphon,siphon_l,km_off_contract,vmax&day=gte.' + from + '&day=lte.' + to, 'id'),
    alerts: dbSelect_('alerts', 'select=day,time,plate,vehicle_key,driver_name,type,severity,detail&day=gte.' + from + '&day=lte.' + to, 'id'),
    vehicles: veh, drivers: drv, P: P, from: from, to: to, agency: ag, frequency: freq, hmOf: localHM_, generatedAt: new Date()
  });
}
/** Rapport de consommation des journées from..to (heure du Maroc) et d'une agence (vide = toutes) */
function buildConso_(from, to, agencyId) {
  const P = params_(), A = dayBounds_(from).start.getTime(), Z = dayBounds_(to).end.getTime(), aI = new Date(A).toISOString(), zI = new Date(Z).toISOString();
  const veh = dbSelect_('vehicles', 'select=key,plate,model,fuel,active,agency_id,geotab_id', 'key').filter(v => !agencyId || v.agency_id === agencyId);
  const drv = {}; dbSelect_('drivers', 'select=code,name', 'code').forEach(d => { drv[d.code] = d.name; });
  let stops = null;
  try { stops = dbSelect_('engine_stops', 'select=vehicle_key,start_at,dur_min,liters,driver_code,contract_num&start_at=gte.' + enc_(aI) + '&start_at=lt.' + enc_(zI), 'id'); } catch (e) { stops = null; }
  const have = {}; dbSelect_('vehicle_days', 'select=vehicle_key,day&day=gte.' + from + '&day=lte.' + to, 'id').forEach(x => { have[x.vehicle_key + '|' + x.day] = 1; });
  const missing = [];
  for (let d = from; d <= to; d = addDays_(d, 1)) veh.filter(v => v.geotab_id && v.active !== 'NON').forEach(v => { if (!have[v.key + '|' + d]) missing.push({ plate: v.plate, day: d }); });
  const ag = agencyId ? (dbSelect_('agencies', 'select=id,name&id=eq.' + agencyId, 'id')[0] || {}).name : '';
  // shift jour / nuit de chaque contrat (heure de début, heure du Maroc) : contrats en cours pendant la période
  const ctrSh = {}; dbSelect_('contracts', 'select=num,start_at&start_at=lt.' + enc_(zI) + '&or=(end_at.gte.' + enc_(new Date(A - 3 * 86400000).toISOString()) + ',end_at.is.null)', 'num')
    .forEach(c => { ctrSh[c.num] = c.start_at ? rptShift(localHM_(c.start_at), P) : ''; });
  return rptConso({
    trips: dbSelect_('trips', 'select=vehicle_key,plate,start_at,km,drive_min,idle_min,fuel_l,fuel_source,idle_fuel_l,driver_code,driver_name,contract_num&start_at=gte.' + enc_(aI) + '&start_at=lt.' + enc_(zI), 'id'),
    fuel: dbSelect_('fuel', 'select=vehicle_key,plate,type,stop_start,stop_end,lvl_before,lvl_after,liters_gauge,liters_geotab,engine,status,driver_code,driver_name&stop_start=gte.' + enc_(aI) + '&stop_start=lt.' + enc_(zI), 'id'),
    stops: stops, vehicles: veh, drivers: drv, P: P, a: A, z: Z, missing: missing, agency: ag, dayOf: localDay_, hmOf: localHM_, ctrShift: n => ctrSh[n] || '', generatedAt: new Date()
  });
}
const pdfOf_ = rep => { const name = rptFileName(rep); return Utilities.newBlob(rptDoc(rep), 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf'); };
/** Envoi d'un rapport planifié : rapport de la flotte + rapport de consommation (deux PDF en pièce jointe) */
function sendReport_(s, per) {
  const rep = buildReport_(per.from, per.to, s.agency_id, s.frequency), pdf = pdfOf_(rep);
  let conso = null; try { conso = pdfOf_(buildConso_(per.from, per.to, s.agency_id)); } catch (e) { log_('Rapports', 'Rapport de consommation impossible : ' + e.message); }
  const body = '<div style="font-family:Arial,sans-serif;font-size:13px"><p><b>' + rptEsc(rep.title) + '</b><br>' + rptEsc(rep.agency) + ' · ' + rptEsc(rep.period) + '</p><table cellpadding="3" style="font-size:12px">' +
    rep.summary.map(x => '<tr><td style="color:#5d6b74">' + rptEsc(x[0]) + '</td><td><b>' + rptEsc(x[1]) + '</b></td></tr>').join('') +
    '</table><p>En pièce jointe : rapport complet (chauffeurs, véhicules, alertes)' + (conso ? ' et rapport de consommation (carburant, ralenti, arrêts moteur, pleins, siphonages)' : '') + '.</p></div>';
  const to = String(s.recipients || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  if (!to.length) throw new Error('aucun destinataire valide');
  MailApp.sendEmail({ to: to.join(','), subject: 'Ludy : ' + rep.title.toLowerCase() + ' ' + rep.period + (s.agency_id ? ' (' + rep.agency + ')' : ''),
    htmlBody: body, attachments: conso ? [pdf, conso] : [pdf], name: 'Ludy' });
  return rep.period + ' envoyé à ' + to.length + ' destinataire' + (to.length > 1 ? 's' : '');
}
/** Rapports planifiés dus : une fois par période, quand les journées de la période sont finalisées et le journal à jour */
function reportsStep_() {
  const props = PropertiesService.getScriptProperties(), P = params_(), now = new Date(), today = localDay_(now), h = +localHM_(now).slice(0, 2);
  if (h < (P.reportHour === '' || P.reportHour === undefined ? 13 : P.reportHour)) return '';
  if (JSON.parse(props.getProperty('SYNC_QUEUE') || '[]').length || props.getProperty('DERIVED_DIRTY')) return '';   // données pas encore finalisées
  const list = dbSelect_('report_schedules', 'select=*&active=is.true', 'id'), out = [], t0 = Date.now(), hour = today + ' ' + h;
  for (const s of list) {
    if (Date.now() - t0 > 120000) break;                                   // le reste au passage suivant (jamais d'envoi coupé en plein milieu)
    const per = reportPeriod_(s.frequency, today);
    if (s.last_period === per.key) continue;
    if (dayBounds_(per.to).end.getTime() + 12 * HOUR > now.getTime()) continue;   // journées de la période pas encore finalisées
    if (props.getProperty('REPORT_ERR|' + s.id) === hour) continue;      // en échec : nouvel essai l'heure suivante
    let res, ok = true;
    try { res = sendReport_(s, per); } catch (e) { res = 'Erreur : ' + mailErr_(e); ok = false; }
    // période notée envoyée seulement si l'envoi a réussi : un rapport en échec est renvoyé plus tard
    sbReq_('patch', 'report_schedules?id=eq.' + s.id, ok ? { last_period: per.key, last_sent_at: new Date().toISOString(), last_result: res } : { last_result: res }, { Prefer: 'return=minimal' });
    if (ok) props.deleteProperty('REPORT_ERR|' + s.id); else props.setProperty('REPORT_ERR|' + s.id, hour);
    out.push('Rapport ' + (s.name || s.frequency) + ' : ' + res);
  }
  return out.join(' | ');
}
/** Demande du site « Envoyer maintenant » : dernier rapport complet de chaque planification demandée */
function jobSendReport_(args) {
  const today = localDay_(new Date()), out = [];
  args.forEach(id => {
    const s = dbSelect_('report_schedules', 'select=*&id=eq.' + enc_(id), 'id')[0];
    if (!s) { out.push('rapport ' + id + ' introuvable'); return; }
    const per = reportPeriod_(s.frequency, today);
    let res;
    try { res = sendReport_(s, per); } catch (e) { res = 'Erreur : ' + mailErr_(e); }
    sbReq_('patch', 'report_schedules?id=eq.' + s.id, { last_sent_at: new Date().toISOString(), last_result: res }, { Prefer: 'return=minimal' });
    out.push(res);
  });
  return out.join(' | ');
}

/** Comportement d'un chauffeur entre deux jours (même calcul que la page du site : rptDriver de site/report.js) */
function buildDriver_(code, from, to, keys) {
  const P = params_(), c = enc_(code), dr = '&driver_code=eq.' + c + '&day=gte.' + from + '&day=lte.' + to;
  const d = dbSelect_('drivers', 'select=*&code=eq.' + c, 'code')[0] || {};
  const ag = d.agency_id ? (dbSelect_('agencies', 'select=id,name&id=eq.' + d.agency_id, 'id')[0] || {}).name : '';
  let stops = null;
  try { stops = dbSelect_('engine_stops', 'select=*' + dr, 'id'); } catch (e) { stops = null; }
  const rules = {}; Object.keys(rulesMap_()).forEach(id => { const r = rulesMap_()[id]; rules[id] = { name: rptRuleFr(r.name), weight: r.w, category: r.cat }; });
  // keys : véhicules des agences du demandeur (gestionnaire) ; absent = administrateur, toute la flotte
  const mine = l => keys ? (l || []).filter(r => keys[r.vehicle_key]) : l;
  return rptDriver({
    driver: { code, name: d.name || code, phone: d.phone, email: d.email, agency: ag },
    journal: mine(dbSelect_('journal', 'select=*' + dr, 'id')),
    trips: mine(dbSelect_('trips', 'select=*' + dr, 'id')),
    events: mine(dbSelect_('events', 'select=id,vehicle_key,plate,day,start_at,dur_s,km,rule_id,rule_name,driver_code' + dr, 'id')),
    fuel: mine(dbSelect_('fuel', 'select=*&type=in.(PLEIN,SIPHONAGE_SUSPECT)&day=gte.' + from + '&day=lte.' + to, 'id')),
    stops: stops && mine(stops), idles: mine(dbSelect_('idles', 'select=*' + dr, 'id')), alerts: mine(dbSelect_('alerts', 'select=*' + dr, 'id')),
    rules, P, from, to, rankJournal: mine(dbSelect_('journal', 'select=id,driver_code,day,km,danger_pts,vehicle_key&day=gte.' + from + '&day=lte.' + to, 'id')),
    dayOf: localDay_, hmOf: localHM_, generatedAt: new Date()
  });
}
/** Demande du site : PDF du comportement d'un chauffeur envoyé à une adresse e-mail. arg = {"code","from","to","email"} */
function jobDriverReport_(arg, by) {
  let a; try { a = JSON.parse(arg || '{}'); } catch (e) { return 'Erreur : demande illisible'; }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!a.code || !day.test(a.from || '') || !day.test(a.to || '') || a.from > a.to) return 'Erreur : chauffeur ou période invalide';
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a.email || '')) return 'Erreur : adresse e-mail invalide';
  // demandé par un gestionnaire : seulement les véhicules de ses agences (comme sur le site)
  let keys = null;
  if (by) {
    const pr = dbSelect_('profiles', 'select=user_id,role&user_id=eq.' + enc_(by), 'user_id')[0];
    if (!pr || pr.role !== 'admin') {
      const ags = dbSelect_('user_agencies', 'select=user_id,agency_id&user_id=eq.' + enc_(by), 'user_id,agency_id').map(x => x.agency_id);
      keys = {}; if (ags.length) dbSelect_('vehicles', 'select=key&agency_id=in.(' + ags.join(',') + ')', 'key').forEach(v => { keys[v.key] = 1; });
      if (!Object.keys(keys).length) return 'Erreur : aucun véhicule dans vos agences';
    }
  }
  const rep = buildDriver_(a.code, a.from, a.to, keys);
  MailApp.sendEmail({ to: a.email, subject: 'Ludy : ' + rep.title.toLowerCase().replace('comportement du chauffeur : ', 'comportement de ') + ' ' + rep.period,
    htmlBody: '<p>Bonjour,</p><p>Ci-joint le rapport de comportement de <b>' + rptEsc(rep.title.replace('Comportement du chauffeur : ', '')) + '</b> ' + rptEsc(rep.period) + '.</p>' +
      '<p>' + rep.summary.slice(2, 14).map(x => rptEsc(x[0]) + ' : <b>' + rptEsc(x[1]) + '</b>').join('<br>') + '</p><p style="color:#5d6b74">Données mesurées par Geotab uniquement ; « non mesuré » quand Geotab ne fournit pas la valeur.</p>',
    attachments: [pdfOf_(rep)], name: 'Ludy' });
  return 'PDF envoyé à ' + a.email;
}
