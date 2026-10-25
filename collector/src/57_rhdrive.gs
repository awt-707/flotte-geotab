// ============================================================================
// RESSOURCES HUMAINES : COPIE DANS GOOGLE DRIVE (demande d'Ahmed, 25/10/2026)
// Dossiers par agence (agencies.rh_drive { contracts, payroll, clock }), sinon ceux des Réglages (rhDriveContracts,
// rhDrivePayroll, rhDriveClock) : lien du dossier ou son identifiant.
// - Contrats : chaque contrat généré, chaque copie signée / légalisée et chaque avenant signé, copiés une fois (PDF) dès le
//   passage suivant (work_contracts.drive_pdf_id / drive_legal_id, hr_events.drive_doc_id).
// - Paie : état mensuel (éléments variables de paie, même calcul que la page État mensuel : rhPresenceCalc / rhMonthlyRows).
// - Pointage : pointage du staff, absences et congés, présence des chauffeurs.
//   Un classeur par mois et par agence, réécrit chaque jour (mois en cours, et le mois précédent jusqu'au 5 pour les
//   corrections tardives).
// ============================================================================
function rhDriveId_(v) { const m = String(v || '').match(/[-\w]{20,}/); return m ? m[0] : ''; }
/** Dossiers Drive des RH ; null tant que la migration 20261114000000_rh_drive.sql n'est pas exécutée */
function rhDriveConf_() {
  let ags;
  try { ags = dbSelect_('agencies', 'select=id,name,rh_drive', 'id'); } catch (e) { return null; }
  const P = {}; dbSelect_('params', 'select=key,value&key=like.rhDrive*', 'key').forEach(p => { P[p.key] = p.value; });
  const def = { contracts: rhDriveId_(P.rhDriveContracts), payroll: rhDriveId_(P.rhDrivePayroll), clock: rhDriveId_(P.rhDriveClock) }, by = {};
  ags.forEach(a => { const d = a.rh_drive || {}; by[a.id] = { name: a.name, contracts: rhDriveId_(d.contracts) || def.contracts, payroll: rhDriveId_(d.payroll) || def.payroll, clock: rhDriveId_(d.clock) || def.clock }; });
  return { def, by, any: !!(def.contracts || def.payroll || def.clock || ags.some(a => by[a.id].contracts || by[a.id].payroll || by[a.id].clock)),
    folder: (ag, kind) => (ag != null && by[ag] ? by[ag][kind] : def[kind]) || '', agName: ag => ag != null && by[ag] ? by[ag].name : 'sans agence' };
}
function rhFileName_(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150); }
/** Fichier du stockage Supabase (clé service) */
function storageBlob_(bucket, path) {
  const c = sbConf_();
  const r = UrlFetchApp.fetch(c.url + '/storage/v1/object/' + bucket + '/' + String(path).split('/').map(enc_).join('/'),
    { method: 'get', muteHttpExceptions: true, headers: Object.assign({ apikey: c.key }, /^sb_/.test(c.key) ? {} : { Authorization: 'Bearer ' + c.key }) });
  if (r.getResponseCode() >= 300) throw new Error('fichier illisible dans le stockage (HTTP ' + r.getResponseCode() + ')');
  return r.getBlob();
}

/** Contrats et avenants signés : copiés une fois dans le dossier Contrats de l'agence du salarié (à chaque passage, quelques fichiers) */
function rhDriveFilesStep_(t0) {
  const conf = rhDriveConf_();
  if (!conf || !conf.any) return '';
  let wc, av;
  try {
    wc = dbSelect_('work_contracts', 'select=id,employee_id,agency_id,name,effective_on,signed_on,legalized_on,pdf_path,legal_path,drive_pdf_id,drive_legal_id,created_at' +
      '&or=' + enc_('(and(pdf_path.not.is.null,drive_pdf_id.is.null),and(legal_path.not.is.null,drive_legal_id.is.null))'), 'id');
    av = dbSelect_('hr_events', 'select=id,employee_id,kind,day_from,label,doc_path,drive_doc_id&kind=eq.avenant&doc_path=not.is.null&drive_doc_id=is.null&cancelled_at=is.null', 'id');
  } catch (e) { return ''; }   // migration 20261114000000_rh_drive.sql pas encore exécutée
  if (!wc.length && !av.length) return '';
  const ids = [...new Set(wc.map(c => c.employee_id).concat(av.map(x => x.employee_id)).filter(x => x != null))], emp = {};
  for (let i = 0; i < ids.length; i += 100) dbSelect_('hr_employees', 'select=id,name,agency_id&id=in.(' + ids.slice(i, i + 100).join(',') + ')', 'id').forEach(e => { emp[e.id] = e; });
  const agOf = (empId, ag) => emp[empId] && emp[empId].agency_id != null ? emp[empId].agency_id : ag;
  let n = 0; const err = [];
  const put = (folderId, bucket, path, name) => { const f = DriveApp.getFolderById(folderId).createFile(storageBlob_(bucket, path).setName(rhFileName_(name) + '.pdf')); n++; return f.getId(); };
  const jobs = [];
  wc.forEach(c => {
    const who = (emp[c.employee_id] || {}).name || c.name || 'Salarié', fid = conf.folder(agOf(c.employee_id, c.agency_id), 'contracts');
    if (c.pdf_path && !c.drive_pdf_id) jobs.push({ fid, bucket: 'contrats', path: c.pdf_path, name: who + ' - Contrat de travail généré le ' + fmtMa_(c.created_at, 'yyyy-MM-dd') + (c.effective_on ? ' (effet ' + c.effective_on + ')' : ''), up: x => ({ drive_pdf_id: x }), t: 'work_contracts', id: c.id });
    if (c.legal_path && !c.drive_legal_id) jobs.push({ fid, bucket: 'contrats', path: c.legal_path, name: who + ' - Contrat ' + (c.legalized_on ? 'signé et légalisé le ' + c.legalized_on : 'signé' + (c.signed_on ? ' le ' + c.signed_on : '')), up: x => ({ drive_legal_id: x }), t: 'work_contracts', id: c.id });
  });
  av.forEach(x => jobs.push({ fid: conf.folder(agOf(x.employee_id, null), 'contracts'), bucket: 'rh', path: x.doc_path, name: ((emp[x.employee_id] || {}).name || 'Salarié') + ' - Avenant du ' + x.day_from + (x.label ? ' - ' + x.label : ''), up: v => ({ drive_doc_id: v }), t: 'hr_events', id: x.id }));
  for (const j of jobs) {
    if (Date.now() - t0 > MAX_RUN_MS - 100000) break;   // le reste au passage suivant
    if (!j.fid) continue;                                  // agence sans dossier Contrats : rien à copier
    try { const id = put(j.fid, j.bucket, j.path, j.name); sbReq_('patch', j.t + '?id=eq.' + j.id, j.up(id), { Prefer: 'return=minimal' }); }
    catch (e) { err.push(j.name + ' : ' + e.message); }
  }
  return (n ? n + ' document' + (n > 1 ? 's' : '') + ' RH copié' + (n > 1 ? 's' : '') + ' dans le Drive' : '') + (err.length ? ' | Drive RH : ' + err.slice(0, 3).join(' ; ') : '');
}

/** Classeur d'un mois dans un dossier : créé une fois, onglets réécrits ensuite (identifiant gardé dans les propriétés) */
function rhSheetWrite_(key, name, folderId, tabs) {
  const props = PropertiesService.getScriptProperties();
  let ss = null; const id = props.getProperty(key);
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(name);
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(folderId));
    props.setProperty(key, ss.getId());
  }
  tabs.forEach((t, i) => {
    let sh = ss.getSheetByName(t.name);
    if (!sh) { sh = i === 0 && ss.getSheets().length === 1 && !ss.getSheets()[0].getLastRow() ? ss.getSheets()[0].setName(t.name) : ss.insertSheet(t.name); }
    sh.clearContents();
    const w = Math.max(...t.rows.map(r => r.length)), rows = t.rows.map(r => r.concat(Array(w - r.length).fill('')));
    if (rows.length) sh.getRange(1, 1, rows.length, w).setValues(rows);
    sh.setFrozenRows(1);
  });
  return ss;
}

/** Paie et pointage du mois dans le Drive (une fois par jour, tâche du jour « rhdrive ») */
function rhDriveSheetsStep_() {
  const conf = rhDriveConf_();
  if (!conf || !conf.any) return '';
  const today = localDay_(new Date()), months = [today.slice(0, 7)];
  if (+today.slice(8, 10) <= 5) months.unshift(rhAddMonths(today.slice(0, 7) + '-01', -1).slice(0, 7));
  const P = {}; dbSelect_('params', 'select=key,value', 'key').forEach(p => { if (p.value !== null && p.value !== '') P[p.key] = p.value; });
  const emps = dbSelect_('hr_employees', 'select=*', 'id');
  if (!emps.length) return '';
  const events = dbSelect_('hr_events', 'select=*', 'id'), off = t => tzOffsetMin_(new Date(t)), out = [];
  const z = d => localToDate_(...d.split('-').map(Number), 0, 0).getTime(), MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  months.forEach(m => {
    const R = rhMonthRange(m), wFrom = rhMonday(R.from), wTo = rhAddDays(rhMonday(R.to), 6), a = new Date(z(wFrom) - 12 * HOUR).toISOString(), b = new Date(z(rhAddDays(wTo, 2))).toISOString();
    const inM = emps.filter(e => (!e.hired_on || e.hired_on <= R.to) && (!e.left_on || e.left_on >= R.from));
    if (!inM.length) return;
    const codes = inM.map(e => e.driver_code).filter(Boolean), staffIds = inM.filter(e => e.kind === 'staff').map(e => e.id), users = inM.map(e => e.user_id).filter(Boolean);
    const inList = l => 'in.(' + l.map(x => '"' + String(x).replace(/"/g, '') + '"').join(',') + ')';
    const contracts = codes.length ? dbSelect_('contracts', 'select=num,client_code,vehicle_key,start_at,end_at&start_at=gte.' + enc_(a) + '&start_at=lt.' + enc_(b), 'num') : [];
    let plan = [], pabs = [], clock = [], sessions = [], cash = [];
    try { plan = codes.length ? dbSelect_('driver_plan', 'select=day,shift,driver_code&day=gte.' + R.from + '&day=lte.' + R.to, 'id').filter(p => codes.indexOf(p.driver_code) >= 0) : []; } catch (e) { }
    try { pabs = codes.length ? dbSelect_('driver_absences', 'select=driver_code,day_from,day_to&day_from=lte.' + R.to + '&day_to=gte.' + R.from, 'id').filter(p => codes.indexOf(p.driver_code) >= 0) : []; } catch (e) { }
    if (staffIds.length) clock = dbSelect_('hr_clock', 'select=employee_id,kind,at&at=gte.' + enc_(a) + '&at=lt.' + enc_(new Date(z(rhAddDays(wTo, 1)) + 12 * HOUR).toISOString()), 'id').filter(c => staffIds.indexOf(c.employee_id) >= 0);
    if (users.length) try { sessions = dbSelect_('user_sessions', 'select=user_id,started_at,last_seen&last_seen=gte.' + enc_(a) + '&started_at=lt.' + enc_(b), 'id').filter(s => users.indexOf(s.user_id) >= 0); } catch (e) { }
    if (codes.length) try { cash = dbSelect_('cash_moves', 'select=kind,amount,day,driver_code&day=gte.' + R.from + '&day=lte.' + R.to + '&kind=' + inList(['avance', 'remboursement', 'bonus']) + '&cancelled_at=is.null', 'id').filter(c => codes.indexOf(c.driver_code) >= 0); } catch (e) { }
    const pres = rhPresenceCalc({ emps: inM, from: R.from, to: R.to, today, now: Date.now(), P, events, contracts, plan, pabs, clock, sessions,
      shiftOfCtr: st => rhShiftOfCtr(st, P, off), dayOf: t => localDay_(new Date(t)), off });
    const rows = rhMonthlyRows(pres, events, cash, R), txt = MOIS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4), hm = t => t ? fmtMa_(t, 'HH:mm') : '', h2 = x => Math.round((x || 0) * 100) / 100;
    // une agence = un classeur (dossiers de l'agence, sinon ceux des Réglages)
    const groups = {}; rows.forEach(x => { const g = x.e.agency_id == null ? '' : String(x.e.agency_id); (groups[g] = groups[g] || []).push(x); });
    Object.keys(groups).forEach(g => {
      const ag = g === '' ? null : +g, list = groups[g].sort((x, y) => String(x.e.name).localeCompare(String(y.e.name))), agTxt = conf.agName(ag);
      const pay = conf.folder(ag, 'payroll'), clk = conf.folder(ag, 'clock');
      try {
        if (pay) {
          rhSheetWrite_('RHDRV|paie|' + g + '|' + m, 'État RH ' + txt + ' - ' + agTxt, pay, [{ name: 'État mensuel', rows: [['Salarié', 'Type', 'CIN', 'N° CNSS', 'Salaire de base', 'Jours de présence', 'Heures', 'HS jour (+25 %)', 'HS nuit (+50 %)', 'Montant HS',
            'Congés (j)', 'Maladie (j)', 'Absences justifiées (j)', 'Absences non justifiées (j)', 'Avances', 'Remboursements', 'Primes']].concat(list.map(x => [x.e.name, x.e.kind === 'staff' ? 'Staff' : 'Chauffeur', x.e.cin || '', x.e.cnss_no || '',
              x.sal == null ? 'non renseigné' : x.sal, x.r.nDays, h2(x.r.hours), h2(x.r.overDay), h2(x.r.overNight), x.pay && (x.r.overDay || x.r.overNight) ? x.pay.amount : 0, x.conge, x.maladie, x.absJ, x.absNJ, x.avance, x.remb, x.prime]))
              .concat([[], ['Mis à jour par Ludy le ' + fmtMa_(new Date(), 'dd/MM/yyyy HH:mm') + ' · présence des chauffeurs d\'après les contrats Ludy, du staff d\'après le pointage ; heures en heures décimales ; cotisations et impôt non calculés.']]) }]);
          out.push('paie ' + m + ' ' + agTxt);
        }
        if (clk) {
          const pts = [['Salarié', 'Jour', 'Arrivée', 'Départ', 'Pointage du départ', 'Pauses', 'Pauses (min)', 'Travaillé (h)', 'Dates de naissance erronées']];
          list.filter(x => x.e.kind === 'staff').forEach(x => (x.r.staffDays || []).forEach(d => pts.push([x.e.name, d.day, hm(d.in), hm(d.out), !d.in ? '' : d.ongoing ? 'en cours' : d.outAuto ? 'non pointé (dernière activité sur Ludy)' : 'pointé', (d.pauses || []).length, Math.round(d.pauseMin || 0), h2((d.workMin || 0) / 60), d.fails || ''])));
          const ids = list.map(x => x.e.id), KD = { conge: 'Congé', maladie: 'Arrêt maladie', absence: 'Absence' };
          const abs = [['Salarié', 'Type', 'Du', 'Au', 'Jours', 'Statut', 'Justifiée', 'Motif', 'Justificatif', 'Annulée']].concat(events
            .filter(x => ids.indexOf(x.employee_id) >= 0 && KD[x.kind] && x.day_from <= R.to && (x.day_to || x.day_from) >= R.from).sort((x, y) => x.day_from < y.day_from ? -1 : 1)
            .map(x => [(list.find(y => y.e.id === x.employee_id) || { e: {} }).e.name || '', KD[x.kind], x.day_from, x.day_to || x.day_from, x.days == null ? '' : +x.days, x.status || '',
              x.kind === 'absence' ? (x.justified ? 'oui' : 'non') : '', x.label || '', x.doc_path ? 'oui' : 'non', x.cancelled_at ? 'oui' : '']));
          const drv = [['Chauffeur', 'Jours de présence', 'Heures', 'HS (h)', 'Planifié sans contrat ni absence déclarée', 'Absences déclarées']].concat(list.filter(x => x.e.kind === 'chauffeur')
            .map(x => [x.e.name, x.r.nDays, h2(x.r.hours), h2(x.r.over), (x.r.gaps || []).join(', '), (x.r.declared || []).join(', ')]));
          rhSheetWrite_('RHDRV|pointage|' + g + '|' + m, 'Pointage et absences ' + txt + ' - ' + agTxt, clk, [{ name: 'Pointage du staff', rows: pts }, { name: 'Absences et congés', rows: abs }, { name: 'Présence des chauffeurs', rows: drv }]);
          out.push('pointage ' + m + ' ' + agTxt);
        }
      } catch (e) { out.push('Drive RH ' + agTxt + ' ' + m + ' : ' + e.message); }
    });
  });
  return out.length ? 'Drive RH : ' + out.join(', ') : '';
}
