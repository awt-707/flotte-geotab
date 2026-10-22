// ---------- Caisse : copie de sauvegarde dans Google Sheets ----------
// Demande d'Ahmed (22/10/2026) : chaque saisie de la Caisse de Ludy recopiée dans le classeur de sauvegarde (param cashSheetId),
// onglets « … Ludy » copiés du classeur « Suivi Cash Chauffeurs » (même présentation, mêmes formules). À chaque passage (5 min) :
// - onglets Caisse et « Export Uber - Driver Status Ludy » réécrits en entier s'ils ont changé (lignes annulées retirées) ;
// - « Export Uber - Opérations de paiement Ludy » complété par les transactions importées depuis le passage précédent.
// Formules écrites en syntaxe anglaise (Apps Script), mêmes calculs que les lignes du classeur d'origine.
const CSH_SHEET_ = {
  uber: { tab: 'Caisse - Encaissements chauffeurs Ludy', first: 8, cols: 16 },
  depenses: { tab: 'Caisse - Dépenses chauffeurs Ludy', first: 5, cols: 12 },
  rh: { tab: 'Caisse - Avance RH Ludy', first: 5, cols: 10 },
  courses: { tab: 'Caisse - Courses indep Ludy', first: 8, cols: 17 },
  bonus: { tab: 'Caisse - Bonus performance Ludy', first: 5, cols: 10 }
};
const CSH_DRV_TAB_ = 'Export Uber - Driver Status Ludy', CSH_PAY_TAB_ = 'Export Uber - Opérations de paiement Ludy', CSH_PAY_COLS_ = 37;
const CSH_FLOW_TXT_ = { in: 'Entrée de cash', out: 'Sortie de cash', virement: 'Virement' };
const CSH_KIND_TXT_ = { depot: 'Dépôt en banque', recharge: 'Recharge de caisse', remboursement: 'Remboursement d\'avance', avance: 'Avance sur Salaire' };

/** Texte comparable (en-têtes de l'export Uber) : minuscules, sans accents, sans espace autour des « : » */
function cshNorm_(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*:\s*/g, ':').trim(); }
/** Texte libre écrit tel quel (jamais pris pour une formule ou un nombre) */
function cshTxt_(v) { const s = v == null ? '' : String(v); return /^[=+\-@]/.test(s) ? '\'' + s : s; }
/** Date aaaa-mm-jj → numéro de série du tableur (sans fuseau horaire) */
function cshSerial_(d) { if (!d) return ''; const p = String(d).slice(0, 10).split('-').map(Number); return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / DAY; }
function cshNum_(v) { return v === null || v === undefined || v === '' ? '' : +v; }
function cshHashStr_(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + s.length; }

/** Une ligne de l'onglet de la caisse (valeurs et formules), r = numéro de ligne dans le tableur */
function cshSheetRow_(caisse, m, r, who, crsDay) {
  const day = cshSerial_(m.day), flow = CSH_FLOW_TXT_[m.flow] || '', mgr = cshTxt_(m.manager_name), com = cshTxt_(m.comment), name = cshTxt_(who), amt = cshNum_(m.amount);
  const uuidF = col => '=IF(' + col + r + '="","",XLOOKUP(' + col + r + ',\'' + CSH_DRV_TAB_ + '\'!$A:$A,\'' + CSH_DRV_TAB_ + '\'!$G:$G))';
  const op = CSH_KIND_TXT_[m.kind] && m.kind !== 'avance' ? CSH_KIND_TXT_[m.kind] : (m.label || '');
  if (caisse === 'uber') {
    const enc = m.kind === 'encaissement', given = m.given != null ? cshNum_(m.given) : amt;
    return [day, name, uuidF('B'), mgr, enc ? 'Chauffeur' : cshTxt_(op || 'Autre'), flow, cshTxt_(m.source), enc ? cshNum_(m.uber_cash) : '', given, enc ? cshNum_(m.change) : '',
      '=I' + r + '-J' + r, '=H' + r + '-K' + r, com,
      '=SUMIFS(\'' + CSH_PAY_TAB_ + '\'!$C$6:$C,\'' + CSH_PAY_TAB_ + '\'!$B$6:$B,$B' + r + ',\'' + CSH_PAY_TAB_ + '\'!$A$6:$A,$A' + r + ')',
      '=IF(G' + r + '="Chauffeur",IF(N' + r + '-K' + r + '=0,"OK","KO"),"N.A")', ''];
  }
  if (caisse === 'depenses') return [day, m.shift === 'Jour' ? 'Shift 1' : m.shift === 'Nuit' ? 'Shift 2' : '', name, uuidF('C'), mgr, amt, cshTxt_(m.ride_type),
    cshTxt_(m.kind === 'depense' ? m.label || 'Autre' : op), flow, cshTxt_(m.source), m.justif === 'En attente' ? '' : cshTxt_(m.justif), com];
  if (caisse === 'rh') return [day, name, uuidF('B'), mgr, amt, flow, cshTxt_(m.source), cshTxt_(m.kind === 'avance' ? CSH_KIND_TXT_.avance : op), com, m.signed ? 'OK' : ''];
  if (caisse === 'courses') {
    const crs = m.kind === 'course', route = String(m.label || '').split(' → ');
    return [day, mgr, flow, amt, crs ? 'Encaissement chauffeur' : cshTxt_(op), crs ? cshTxt_(route[0]) : '', crs ? cshTxt_(route[1] || '') : '', name, crs ? cshSerial_(crsDay || m.day) : '',
      crs ? cshNum_(m.course_amount) : '', crs && m.commission_pct != null ? +m.commission_pct / 100 : '', '=J' + r + '*K' + r, crs ? 'Oui' : '', com,
      '=IF($E' + r + '="Encaissement chauffeur",L' + r + ',0)', '=IF($E' + r + '="Encaissement chauffeur",J' + r + '-D' + r + ',0)', '=IF($E' + r + '="Encaissement chauffeur",O' + r + '-P' + r + ',0)'];
  }
  return [day, name, uuidF('B'), mgr, amt, flow, cshTxt_(m.kind === 'bonus' ? m.label || 'Bonus' : op), cshTxt_(m.status), cshTxt_(m.source), com];
}

/** Lignes du tableur d'une transaction Uber : colonnes rangées d'après les en-têtes de l'onglet (ligne 5) */
function cshPayRow_(p, r, H) {
  const raw = {}; Object.keys(p.raw || {}).forEach(k => { raw[cshNorm_(k)] = p.raw[k]; });
  const fb = { 'uuid de la transaction': p.tx, 'uuid du chauffeur': p.driver_uuid, 'prenom du chauffeur': p.first_name || p.driver_name, 'nom du chauffeur': p.last_name, 'uuid de la course': p.trip,
    'description': p.description, 'par rapport a la creation de rapport': fmtMa_(p.at, 'yyyy-MM-dd HH:mm:ss') + ' +0100',
    'montant vous etant verse': p.payout, 'montant vous etant verse:vos revenus': p.revenue, 'montant vous etant verse:solde des courses:versements:especes collectees': p.cash == null ? '' : -p.cash,
    'montant vous etant verse:vos revenus:prix de la course': p.fare, 'montant vous etant verse:vos revenus:pourboire': p.tip };
  const row = []; let firstAmt = -1;
  for (let j = 0; j < CSH_PAY_COLS_; j++) {
    const h = cshNorm_(H[j]); if (firstAmt < 0 && h === 'montant vous etant verse') firstAmt = j;
    let v = h in raw ? raw[h] : p.raw ? '' : (fb[h] == null ? '' : fb[h]);
    if (v === '' && firstAmt >= 0 && j >= firstAmt && h && h !== 'check doublons') v = 0;   // montants absents de l'export = 0, comme le classeur
    row.push(typeof v === 'number' ? v : cshTxt_(v));
  }
  row[0] = '=IF(L' + r + '="","",DATE(VALUE(LEFT(L' + r + ',4)),VALUE(MID(L' + r + ',6,2)),VALUE(MID(L' + r + ',9,2))))';
  row[1] = '=IF(F' + r + '="","",F' + r + '&" "&G' + r + ')';
  row[2] = '=-O' + r;
  row[CSH_PAY_COLS_ - 1] = '=COUNTIFS($D:$D,D' + r + ')';
  return row;
}

/** Écrit des lignes à partir de la ligne first (lignes ajoutées si l'onglet est trop court), efface celles d'avant en trop */
function cshWrite_(sh, first, rows, ncols, prevN, textCols) {
  const need = first + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (rows.length) {
    (textCols || []).forEach(c => sh.getRange(first, c, rows.length, 1).setNumberFormat('@'));
    sh.getRange(first, 1, rows.length, ncols).setValues(rows);
  }
  if (prevN > rows.length) sh.getRange(first + rows.length, 1, prevN - rows.length, ncols).clearContent();
}

function cashSheetStep_(t0) {
  const P = params_(), id = String(P.cashSheetId || '').trim();
  if (!id) return '';
  const props = PropertiesService.getScriptProperties(), out = [];
  let moves;
  try { moves = dbSelect_('cash_moves', 'select=*&cancelled_at=is.null', 'day,id'); }
  catch (e) { if (/cash_moves|404|does not exist|schema cache/i.test(e.message)) return ''; throw e; }   // caisse pas encore installée dans la base
  const ss = SpreadsheetApp.openById(id);
  const drv = dbSelect_('drivers', 'select=code,name,uber_uuid', 'code'), udrv = dbSelect_('uber_drivers', 'select=uuid,name,phone,email,status', 'uuid');
  const D = {}, U = {}; drv.forEach(d => { D[d.code] = d; }); udrv.forEach(u => { U[u.uuid] = u; });
  const who = m => { const d = D[m.driver_code] || {}, u = m.uber_uuid || d.uber_uuid; return (u && U[u] && U[u].name) || d.name || m.driver_name || ''; };
  const mis = moves.filter(m => m.mission_id).map(m => m.mission_id), crsDay = {};
  if (mis.length) dbSelect_('missions', 'select=id,start_at&id=in.(' + mis.join(',') + ')', 'id').forEach(x => { if (x.start_at) crsDay[x.id] = localDay_(x.start_at); });
  const today = localDay_(Date.now()), daily = props.getProperty('CSH_SHEET_DAY') !== today;   // réécrit au moins une fois par jour (modification à la main dans le classeur)
  Object.keys(CSH_SHEET_).forEach(c => {
    const T = CSH_SHEET_[c], sh = ss.getSheetByName(T.tab);
    if (!sh) { out.push('onglet « ' + T.tab + ' » absent'); return; }
    const list = moves.filter(m => m.caisse === c), rows = list.map((m, i) => cshSheetRow_(c, m, T.first + i, who(m), crsDay[m.mission_id]));
    const key = 'CSH_SHEET_' + c, prev = (props.getProperty(key) || '|0').split('|'), h = cshHashStr_(JSON.stringify(rows));
    if (h === prev[0] && !daily) return;
    cshWrite_(sh, T.first, rows, T.cols, +prev[1] || 0);
    props.setProperty(key, h + '|' + rows.length);
    if (h !== prev[0]) out.push(T.tab.replace(/^Caisse - | Ludy$/g, '') + ' ' + rows.length);
  });
  // chauffeurs Uber (UUID des formules des onglets Caisse)
  const dsh = ss.getSheetByName(CSH_DRV_TAB_);
  if (dsh) {
    const rows = udrv.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map(u => [cshTxt_(u.name), cshTxt_(u.status), '', u.phone || '', '', cshTxt_(u.email), u.uuid, '']);
    const prev = (props.getProperty('CSH_SHEET_drv') || '|0').split('|'), h = cshHashStr_(JSON.stringify(rows));
    if (h !== prev[0] || daily) { cshWrite_(dsh, 2, rows, 8, +prev[1] || 0, [4]); props.setProperty('CSH_SHEET_drv', h + '|' + rows.length); }
  }
  // transactions Uber : ajoutées à la suite, dans l'ordre d'import
  const psh = ss.getSheetByName(CSH_PAY_TAB_);
  if (psh) {
    const st = JSON.parse(props.getProperty('CSH_SHEET_pay') || '{"n":0,"at":"","tx":""}'), H = psh.getRange(5, 1, 1, CSH_PAY_COLS_).getValues()[0];
    let added = 0;
    for (let k = 0; k < 10 && Date.now() - t0 < MAX_RUN_MS - 90000; k++) {
      const after = st.at ? '&or=' + enc_('(imported_at.gt."' + st.at + '",and(imported_at.eq."' + st.at + '",tx.gt."' + st.tx + '"))') : '';
      let page;
      try { page = sbReq_('get', 'uber_payments?select=*' + after + '&order=imported_at,tx&limit=2000') || []; }
      catch (e) { if (/raw|first_name|404/i.test(e.message)) break; throw e; }
      if (!page.length) break;
      const rows = page.map((p, i) => cshPayRow_(p, 6 + st.n + i, H));
      cshWrite_(psh, 6 + st.n, rows, CSH_PAY_COLS_, 0, [4, 5, 8, 12]);
      st.n += rows.length; st.at = page[page.length - 1].imported_at; st.tx = page[page.length - 1].tx; added += rows.length;
      props.setProperty('CSH_SHEET_pay', JSON.stringify(st));
      if (page.length < 2000) break;
    }
    if (added) out.push(added + ' transactions Uber');
  }
  if (daily) props.setProperty('CSH_SHEET_DAY', today);
  return out.length ? 'Classeur de la caisse : ' + out.join(', ') : '';
}
