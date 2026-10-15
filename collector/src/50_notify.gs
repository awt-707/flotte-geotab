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
      '</b></td><td>' + rptEsc(a.detail || '').replace(/(https:\/\/maps\.google\.com\/\?q=[0-9.,\-]+)/g, '<a href="$1">carte</a>') + '</td></tr>').join('');
    const html = '<div style="font-family:Arial,sans-serif;font-size:13px"><p>' + list.length + ' nouvelle' + (list.length > 1 ? 's' : '') + ' alerte' + (list.length > 1 ? 's' : '') +
      (r.agency_id ? ' (agence ' + rptEsc(agName[r.agency_id] || '') + ')' : '') + ' :</p><table cellpadding="4" style="border-collapse:collapse;font-size:12px">' +
      '<tr style="background:#eef0f7"><th align="left">Date</th><th align="left">Plaque</th><th align="left">Chauffeur</th><th align="left">Type</th><th align="left">Gravité</th><th align="left">Détail</th></tr>' +
      rows + '</table><p style="color:#5d6b74;font-size:11px">Suivi et statut des alertes : ' + SITE_URL + '/#/alertes</p></div>';
    try {
      MailApp.sendEmail({ to: r.email, subject: 'Flotte : ' + list.length + ' alerte' + (list.length > 1 ? 's' : '') + ' (' + worst.toLowerCase() + ')' + (list.length === 1 ? ' ' + list[0].type + ' ' + list[0].plate : ''), htmlBody: html, name: 'Flotte Geotab' });
      sent++;
    } catch (e) { err.push(r.email + ' : ' + mailErr_(e)); }
  });
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
    journal: dbSelect_('journal', 'select=day,vehicle_key,driver_code,driver_name,contract_num,km,drive_h,idle_h,long_idle_h,n_trips,fuel_l,fuel_km,fuel_cost,n_events,danger_pts,n_siphon,siphon_l,km_off_contract,vmax&day=gte.' + from + '&day=lte.' + to, 'id'),
    alerts: dbSelect_('alerts', 'select=day,time,plate,vehicle_key,driver_name,type,severity,detail&day=gte.' + from + '&day=lte.' + to, 'id'),
    vehicles: veh, drivers: drv, P: P, from: from, to: to, agency: ag, frequency: freq, generatedAt: new Date()
  });
}
/** Envoi d'un rapport planifié (PDF en pièce jointe). force = renvoi demandé depuis le site. */
function sendReport_(s, per) {
  const rep = buildReport_(per.from, per.to, s.agency_id, s.frequency), name = rptFileName(rep);
  const pdf = Utilities.newBlob(rptDoc(rep), 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf');
  const body = '<div style="font-family:Arial,sans-serif;font-size:13px"><p><b>' + rptEsc(rep.title) + '</b><br>' + rptEsc(rep.agency) + ' · ' + rptEsc(rep.period) + '</p><table cellpadding="3" style="font-size:12px">' +
    rep.summary.map(x => '<tr><td style="color:#5d6b74">' + rptEsc(x[0]) + '</td><td><b>' + rptEsc(x[1]) + '</b></td></tr>').join('') +
    '</table><p>Rapport complet (chauffeurs, véhicules, alertes) en pièce jointe.</p></div>';
  const to = String(s.recipients || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  if (!to.length) throw new Error('aucun destinataire valide');
  MailApp.sendEmail({ to: to.join(','), subject: 'Flotte : ' + rep.title.toLowerCase() + ' ' + rep.period + (s.agency_id ? ' (' + rep.agency + ')' : ''),
    htmlBody: body, attachments: [pdf], name: 'Flotte Geotab' });
  return rep.period + ' envoyé à ' + to.length + ' destinataire' + (to.length > 1 ? 's' : '');
}
/** Rapports planifiés dus : une fois par période, quand les journées de la période sont finalisées et le journal à jour */
function reportsStep_() {
  const props = PropertiesService.getScriptProperties(), P = params_(), now = new Date(), today = localDay_(now), h = +Utilities.formatDate(now, TZ, 'HH');
  if (h < (P.reportHour === '' || P.reportHour === undefined ? 13 : P.reportHour)) return '';
  if (JSON.parse(props.getProperty('SYNC_QUEUE') || '[]').length || props.getProperty('DERIVED_DIRTY')) return '';   // données pas encore finalisées
  const list = dbSelect_('report_schedules', 'select=*&active=is.true', 'id'), out = [];
  list.forEach(s => {
    const per = reportPeriod_(s.frequency, today);
    if (s.last_period === per.key) return;
    let res;
    try { res = sendReport_(s, per); } catch (e) { res = 'Erreur : ' + mailErr_(e); }
    sbReq_('patch', 'report_schedules?id=eq.' + s.id, { last_period: per.key, last_sent_at: new Date().toISOString(), last_result: res }, { Prefer: 'return=minimal' });
    out.push('Rapport ' + (s.name || s.frequency) + ' : ' + res);
  });
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
