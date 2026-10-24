// ---------- Caisse : copie de sauvegarde dans Google Sheets ----------
// Demande d'Ahmed (22/10/2026) : chaque saisie de la Caisse de Ludy recopiée dans le classeur de sauvegarde de son agence
// (agencies.cash_sheet_id ; sans agence : param cashSheetId),
// onglets « … Ludy » copiés du classeur « Suivi Cash Chauffeurs » (même présentation, mêmes formules). À chaque passage (5 min) :
// - onglets Caisse et « Export Uber - Driver Status Ludy » réécrits en entier s'ils ont changé (lignes annulées retirées) ;
// - « Export Uber - Opérations de paiement Ludy » complété par les transactions importées depuis le passage précédent.
// Formules écrites en syntaxe anglaise (Apps Script), mêmes calculs que les lignes du classeur d'origine.
const CSH_SHEET_ = {
  uber: { tab: 'Caisse - Encaissements chauffeurs Ludy', first: 8, cols: 16 },
  depenses: { tab: 'Caisse - Dépenses chauffeurs Ludy', first: 5, cols: 12 },
  rh: { tab: 'Caisse - Avance RH Ludy', first: 5, cols: 10 },
  courses: { tab: 'Caisse - Courses indep Ludy', first: 8, cols: 17, dates: [1, 9] },
  bonus: { tab: 'Caisse - Bonus performance Ludy', first: 5, cols: 10 }
};
// version de l'écriture : la changer réécrit tous les onglets au passage suivant (v3 : formules au séparateur du classeur, v4 : format date, 23/10/2026)
let CSH_FMT_ = 'v4|';
const CSH_DRV_TAB_ = 'Export Uber - Driver Status Ludy', CSH_PAY_TAB_ = 'Export Uber - Opérations de paiement Ludy', CSH_PAY_COLS_ = 37;
const CSH_FLOW_TXT_ = { in: 'Entrée de cash', out: 'Sortie de cash', virement: 'Virement' };
const CSH_KIND_TXT_ = { depot: 'Dépôt en banque', recharge: 'Recharge de caisse', remboursement: 'Remboursement d\'avance', avance: 'Avance sur Salaire' };

/**
 * État du dernier passage (param cashSheetStatus, lisible sur le site) : écrit quand il change, au moins une fois par heure.
 * Rien d'écrit sans classeur réglé ni caisse installée.
 */
function cshStatus_(m) {
  const P = params_(), props = PropertiesService.getScriptProperties();
  if (m === '' && !String(P.cashSheetId || '').trim() && !props.getProperty('CSH_STATUS')) return;
  const txt = m || 'Classeur de la caisse : à jour', prev = props.getProperty('CSH_STATUS') || '', at = +(props.getProperty('CSH_STATUS_AT') || 0);
  if (txt === prev && Date.now() - at < 60 * MIN) return;
  try {
    sbReq_('post', 'params?on_conflict=key', [{ key: 'cashSheetStatus', label: 'Classeur de la caisse : dernier passage (calculé par le collecteur)',
      value: fmtMa_(new Date(), 'dd/MM/yyyy HH:mm') + ' · ' + txt.slice(0, 900), note: 'Ne pas modifier', sort: 999 }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
    props.setProperty('CSH_STATUS', txt); props.setProperty('CSH_STATUS_AT', String(Date.now()));
  } catch (e) { }
}

/** Texte comparable (en-têtes de l'export Uber) : minuscules, sans accents, sans espace autour des « : » */
function cshNorm_(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*:\s*/g, ':').trim(); }
/** Texte libre écrit tel quel (jamais pris pour une formule ou un nombre) */
function cshTxt_(v) { const s = v == null ? '' : String(v); return /^[=+\-@]/.test(s) ? '\'' + s : s; }
/** Date aaaa-mm-jj → numéro de série du tableur (sans fuseau horaire) */
function cshSerial_(d) { if (!d) return ''; const p = String(d).slice(0, 10).split('-').map(Number); return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / DAY; }
function cshNum_(v) { return v === null || v === undefined || v === '' ? '' : +v; }
/** Décalage horaire du Maroc à cet instant (MA_TZ), au format de l'export Uber : « +0100 », « +0000 » */
function cshOff_(at) { const o = tzOffsetMin_(at), a = Math.abs(o); return (o < 0 ? '-' : '+') + ('0' + Math.floor(a / 60)).slice(-2) + ('0' + a % 60).slice(-2); }
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
    // prime (L) et montant déjà payé (P) : valeurs enregistrées dans Ludy (prime de l'historique, part gardée corrigée après coup) ;
    // formules du classeur seulement quand la valeur manque
    const crs = m.kind === 'course', route = String(m.label || '').split(' → ');
    return [day, mgr, flow, amt, crs ? 'Encaissement chauffeur' : cshTxt_(op), crs ? cshTxt_(route[0]) : '', crs ? cshTxt_(route[1] || '') : '', name, crs ? cshSerial_(crsDay || m.day) : '',
      crs ? cshNum_(m.course_amount) : '', crs && m.commission_pct != null ? +m.commission_pct / 100 : '', crs && m.prime != null ? +m.prime : '=J' + r + '*K' + r, crs ? 'Oui' : '', com,
      '=IF($E' + r + '="Encaissement chauffeur",L' + r + ',0)', crs && m.prime_paid != null ? +m.prime_paid : '=IF($E' + r + '="Encaissement chauffeur",J' + r + '-D' + r + ',0)', '=IF($E' + r + '="Encaissement chauffeur",O' + r + '-P' + r + ',0)'];
  }
  return [day, name, uuidF('B'), mgr, amt, flow, cshTxt_(m.kind === 'bonus' ? m.label || 'Bonus' : op), cshTxt_(m.status), cshTxt_(m.source), com];
}

/** Lignes du tableur d'une transaction Uber : colonnes rangées d'après les en-têtes de l'onglet (ligne 5) */
function cshPayRow_(p, r, H) {
  const raw = {}; Object.keys(p.raw || {}).forEach(k => { raw[cshNorm_(k)] = p.raw[k]; });
  const fb = { 'uuid de la transaction': p.tx, 'uuid du chauffeur': p.driver_uuid, 'prenom du chauffeur': p.first_name || p.driver_name, 'nom du chauffeur': p.last_name, 'uuid de la course': p.trip,
    'description': p.description, 'par rapport a la creation de rapport': fmtMa_(p.at, 'yyyy-MM-dd HH:mm:ss') + ' ' + cshOff_(p.at),
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
function cshWrite_(sh, first, rows, ncols, prevN, textCols, dateCols) {
  const need = first + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (rows.length) {
    const rg = sh.getRange(first, 1, rows.length, ncols);
    cshLoosen_(sh, rg);
    (textCols || []).forEach(c => sh.getRange(first, c, rows.length, 1).setNumberFormat('@'));
    // dates (numéros de série) : format date posé sur les lignes écrites (23/10 : 137 lignes du modèle sans format affichaient « 46337 »)
    (dateCols || []).forEach(c => sh.getRange(first, c, rows.length, 1).setNumberFormat('dd/mm/yyyy'));
    // formules écrites avec le séparateur du classeur : Google les lit dans la langue du classeur, par setValues comme par
    // setFormulas (fr_FR : « ; » ; constaté le 23/10 : virgules = « Formula parse error », #ERROR!)
    const semi = cshSemi_(sh), vals = semi ? rows.map(r => r.map(v => typeof v === 'string' && v[0] === '=' ? cshLocalF_(v) : v)) : rows;
    try { rg.setValues(vals); }
    catch (e) {   // règle que Google n'a pas laissé assouplir : listes retirées des lignes écrites (la sauvegarde passe avant les listes)
      if (!/validation/i.test(e.message)) throw e;
      rg.clearDataValidations(); rg.setValues(vals);
    }
  }
  if (prevN > rows.length) sh.getRange(first + rows.length, 1, prevN - rows.length, ncols).clearContent();
}

/** Classeur dont les arguments de formule sont séparés par « ; » (virgule décimale : fr, de, es…) ; anglais et langues à point décimal : « , » */
function cshSemi_(sh) {
  let loc = ''; try { loc = String(sh.getParent().getSpreadsheetLocale() || ''); } catch (e) { }
  return !!loc && !/^(en|ja|zh|ko|th|he|iw|hi|ms|fil|tl)(_|$)/i.test(loc);
}
/** Formule écrite en syntaxe anglaise → séparateurs « ; » (virgules hors textes « … » et noms d'onglets '…') */
function cshLocalF_(f) {
  let out = '', q = '';
  for (const ch of f) {
    if (q) { if (ch === q) q = ''; out += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    out += ch === ',' ? ';' : ch;
  }
  return out;
}

/**
 * Listes déroulantes des onglets copiés du classeur d'origine : en mode « refuser la saisie », Google refuse aussi l'écriture
 * du script (constaté le 22/10/2026 : écriture arrêtée en B8, chauffeur absent de la liste ; listes qui renvoient vers les onglets
 * d'origine, absents du classeur de sauvegarde). Les règles des lignes écrites passent en « afficher un avertissement » (liste
 * gardée, valeur hors liste signalée) et une liste qui renvoie vers un onglet « X » est rattachée à « X Ludy » s'il existe.
 */
function cshLoosen_(sh, rg) {
  let dv; try { dv = rg.getDataValidations(); } catch (e) { return; }
  let ss = null; try { ss = sh.getParent(); } catch (e) { }
  const C = {}, VIR = SpreadsheetApp.DataValidationCriteria && SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE;
  const loose = v => {
    let b = v.copy().setAllowInvalid(true);
    try {
      const cv = v.getCriteriaType() === VIR ? v.getCriteriaValues() : null, r0 = cv && cv[0], nm = r0 && r0.getSheet().getName();
      const lu = nm && !/ Ludy$/.test(nm) && ss && ss.getSheetByName(nm + ' Ludy');
      if (lu) b = b.requireValueInRange(lu.getRange(r0.getA1Notation()), cv[1] !== false);
    } catch (e) { }
    return b.build();
  };
  let changed = false;
  const out = dv.map(row => row.map((v, j) => {
    try {
      if (!v || v.getAllowInvalid()) return v;
      changed = true;
      const k = j + '|' + v.getCriteriaType() + '|' + (v.getCriteriaValues() || []).map(x => x && typeof x === 'object' && x.getA1Notation ? x.getSheet().getName() + '!' + x.getA1Notation() : JSON.stringify(x)).join('|');
      if (!(k in C)) C[k] = loose(v);
      return C[k];
    } catch (e) { changed = true; return null; }   // règle illisible (22/10 : « Plage introuvable », liste vers un onglet absent) : retirée, sinon l'écriture reste bloquée
  }));
  if (changed) rg.setDataValidations(out);
}

/**
 * Un classeur de sauvegarde par agence (agencies.cash_sheet_id) : chaque agence a sa propre caisse. Sans classeur d'agence,
 * param cashSheetId = classeur de toute la caisse (installation sans agences).
 */
function cashSheetStep_(t0) {
  const P = params_();
  let moves;
  try { moves = dbSelect_('cash_moves', 'select=*&cancelled_at=is.null', 'day,id'); }
  catch (e) { if (/cash_moves|404|does not exist|schema cache/i.test(e.message)) return ''; throw e; }   // caisse pas encore installée dans la base
  let ags = [];
  try { ags = dbSelect_('agencies', 'select=id,name,cash_sheet_id&cash_sheet_id=not.is.null', 'id'); } catch (e) { ags = []; }   // colonne pas encore créée
  let targets = ags.filter(a => String(a.cash_sheet_id || '').trim()).map(a => ({ ag: a.id, name: a.name, sheet: String(a.cash_sheet_id).trim() }));
  if (!targets.length && String(P.cashSheetId || '').trim()) targets = [{ ag: null, name: '', sheet: String(P.cashSheetId).trim() }];
  if (!targets.length) return '';
  const drv = dbSelect_('drivers', 'select=code,name,uber_uuid', 'code'), udrv = dbSelect_('uber_drivers', 'select=*', 'uuid');
  // jour des courses Ludy : identifiants dédoublonnés, lus par 100 (adresse limitée à 2 Ko)
  const mis = [...new Set(moves.filter(m => m.mission_id).map(m => m.mission_id))], crsDay = {};
  for (let i = 0; i < mis.length; i += 100) dbSelect_('missions', 'select=id,start_at&id=in.(' + mis.slice(i, i + 100).join(',') + ')', 'id').forEach(x => { if (x.start_at) crsDay[x.id] = localDay_(x.start_at); });
  const out = [];
  targets.forEach(T => {
    if (Date.now() - t0 > MAX_RUN_MS - 90000) return;
    try { const m = cashSheetOne_(t0, T, P, moves, drv, udrv, crsDay); if (m) out.push((targets.length > 1 || T.name ? T.name + ' : ' : '') + m); }
    catch (e) { out.push((T.name ? T.name + ' : ' : '') + e.message); }
  });
  return out.length ? 'Classeur de la caisse : ' + out.join(' ; ') : '';
}
/** État d'écriture d'un classeur (clé par classeur ; reprend l'état de la version sans agences pour le même classeur) */
function cshProp_(props, sheet, k, P) {
  const key = 'CSH|' + sheet + '|' + k, v = props.getProperty(key);
  if (v !== null) return { key, v };
  const old = props.getProperty('CSH_SHEET_' + k);
  return { key, v: old !== null && sheet === String(P.cashSheetId || '').trim() ? old : null };
}
function cashSheetOne_(t0, T, P, allMoves, drv, udrv0, crsDay) {
  const props = PropertiesService.getScriptProperties(), out = [], mine = x => T.ag == null || String(x.agency_id) === String(T.ag);
  const moves = allMoves.filter(mine), udrv = udrv0.filter(mine);
  const ss = SpreadsheetApp.openById(T.sheet);
  const D = {}, U = {}; drv.forEach(d => { D[d.code] = d; }); udrv0.forEach(u => { U[u.uuid] = u; });
  const who = m => { const d = D[m.driver_code] || {}, u = m.uber_uuid || d.uber_uuid; return (u && U[u] && U[u].name) || d.name || m.driver_name || ''; };
  const today = localDay_(Date.now()), dayP = cshProp_(props, T.sheet, 'DAY', P), daily = dayP.v !== today;   // réécrit au moins une fois par jour (modification à la main dans le classeur)
  Object.keys(CSH_SHEET_).forEach(c => {
    const C = CSH_SHEET_[c], sh = ss.getSheetByName(C.tab);
    if (!sh) { out.push('onglet « ' + C.tab + ' » absent'); return; }
    const list = moves.filter(m => m.caisse === c), rows = list.map((m, i) => cshSheetRow_(c, m, C.first + i, who(m), crsDay[m.mission_id]));
    const st = cshProp_(props, T.sheet, c, P), prev = (st.v || '|0').split('|'), h = cshHashStr_(CSH_FMT_ + JSON.stringify(rows));
    if (h === prev[0] && !daily && st.v !== null && props.getProperty(st.key) !== null) return;
    cshWrite_(sh, C.first, rows, C.cols, +prev[1] || 0, null, C.dates || [1]);
    props.setProperty(st.key, h + '|' + rows.length);
    if (h !== prev[0]) out.push(C.tab.replace(/^Caisse - | Ludy$/g, '') + ' ' + rows.length);
  });
  // chauffeurs Uber de l'agence (UUID des formules des onglets Caisse)
  const dsh = ss.getSheetByName(CSH_DRV_TAB_);
  if (dsh) {
    const rows = udrv.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map(u => [cshTxt_(u.name), cshTxt_(u.status), '', u.phone || '', '', cshTxt_(u.email), u.uuid, '']);
    const st = cshProp_(props, T.sheet, 'drv', P), prev = (st.v || '|0').split('|'), h = cshHashStr_(CSH_FMT_ + JSON.stringify(rows));
    if (h !== prev[0] || daily || props.getProperty(st.key) === null) { cshWrite_(dsh, 2, rows, 8, +prev[1] || 0, [4]); props.setProperty(st.key, h + '|' + rows.length); }
  }
  // transactions Uber de l'agence : ajoutées à la suite, dans l'ordre d'import
  const psh = ss.getSheetByName(CSH_PAY_TAB_);
  if (psh) {
    const sp = cshProp_(props, T.sheet, 'pay', P), st = JSON.parse(sp.v || '{"n":0,"at":"","tx":""}'), H = psh.getRange(5, 1, 1, CSH_PAY_COLS_).getValues()[0];
    if (sp.v && st.fmt !== CSH_FMT_) { st.n = 0; st.at = ''; st.tx = ''; }   // format changé : transactions réécrites depuis le début (même ordre)
    st.fmt = CSH_FMT_;
    let added = 0;
    for (let k = 0; k < 20 && Date.now() - t0 < MAX_RUN_MS - 90000; k++) {   // pages de 1 000 lignes (plafond de PostgREST)
      const after = st.at ? '&or=' + enc_('(imported_at.gt."' + st.at + '",and(imported_at.eq."' + st.at + '",tx.gt."' + st.tx + '"))') : '';
      let page;
      try { page = sbReq_('get', 'uber_payments?select=*' + (T.ag == null ? '' : '&agency_id=eq.' + T.ag) + after + '&order=imported_at,tx&limit=1000') || []; }
      catch (e) { if (/raw|first_name|agency_id|404/i.test(e.message)) break; throw e; }
      if (!page.length) break;
      const rows = page.map((p, i) => cshPayRow_(p, 6 + st.n + i, H));
      cshWrite_(psh, 6 + st.n, rows, CSH_PAY_COLS_, 0, [4, 5, 8, 12]);
      st.n += rows.length; st.at = page[page.length - 1].imported_at; st.tx = page[page.length - 1].tx; added += rows.length;
      props.setProperty(sp.key, JSON.stringify(st));
      if (page.length < 1000) break;
    }
    if (added) out.push(added + ' transactions Uber');
  }
  if (daily) props.setProperty(dayP.key, today);
  return out.join(', ');
}
