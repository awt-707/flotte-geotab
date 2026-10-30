// Caisse > Rapports et Dépôt en banque (30/10/2026, demande d'Ahmed) :
// - rapport des encaissements d'une période (semaine du lundi au dimanche, mois, ou dates libres) : PDF et tableur ;
// - compte rendu d'activité avec graphiques : chiffre d'affaires Uber / Bolt / courses privées, comparaison à la période précédente,
//   espèces déclarées et encaissées, chauffeurs ;
// - bordereau de dépôt en banque à signer (billetage, montant en lettres, signatures), dépôt enregistré dans la caisse.
// Calculs : caisse_calc.js (cshSummary, cshBuckets, cshDepositInfo…) ; rien n'est estimé (montants saisis et exports Uber / Bolt).

const CSH_PAL = { uber: [30, 41, 59], bolt: [24, 160, 104], courses: [91, 75, 214], net: [37, 99, 235], prev: [148, 156, 166], decl: [148, 163, 184] };
const CSH_DOW = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
function cshDow(d) { return CSH_DOW[new Date(Date.parse(d + 'T12:00:00Z')).getUTCDay()]; }
/** « du lundi 20/10/2026 au dimanche 26/10/2026 » */
function cshPeriodTxt(from, to) { return from === to ? 'le ' + cshDow(from) + ' ' + fmtDay(from) : 'du ' + cshDow(from) + ' ' + fmtDay(from) + ' au ' + cshDow(to) + ' ' + fmtDay(to); }
/** « comparée au mercredi 28/10/2026 » / « comparée à la période du lundi 12/10/2026 au dimanche 18/10/2026 » */
function cshCmpTxt(pr) { return pr.from === pr.to ? 'comparée au ' + cshDow(pr.from) + ' ' + fmtDay(pr.from) : 'comparée à la période ' + cshPeriodTxt(pr.from, pr.to); }
function cshBucketLabel(k, by) { return by === 'week' ? 'S. ' + fmtDay(k).slice(0, 5) : fmtDay(k).slice(0, 5); }
function cshPctTxt(x) { return x == null ? '—' : (x >= 0 ? '+' : '-') + rptFmt(Math.abs(x) * 100, 1) + ' %'; }
function cshRate(x) { return x == null ? RPT_NM : rptFmt(x * 100, 1) + ' %'; }
function cshFileAg() { return String(CS.agName || 'agence').replace(/[^A-Za-z0-9]+/g, '_'); }

/** Lien du classeur Google de l'agence (créé par le collecteur pour chaque agence) */
async function cshSheetLink() {
  if (CS.sheetFor === CS.agId) return CS.sheetId;
  CS.sheetFor = CS.agId; CS.sheetId = null;
  if (!CS.agId) return null;
  const r = await sb.from('agencies').select('cash_sheet_id').eq('id', CS.agId).maybeSingle();
  CS.sheetId = r && !r.error && r.data ? r.data.cash_sheet_id || null : null;
  return CS.sheetId;
}
function cshSheetUrl(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }

/** Graphique de la page (SVG) : mêmes données que le PDF ; series [{ name, cls, values, type: 'line', dash }] */
function cshSvg(labels, series, opt) {
  const o = opt || {}, W = 760, H = o.h || 210, x0 = 46, x1 = W - 8, top = 10, base = H - 22, n = labels.length;
  if (!n) return '<div class="empty">Aucune donnée sur la période</div>';
  const bars = series.filter(s => s.type !== 'line'), lines = series.filter(s => s.type === 'line'), stack = !o.group;
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, stack ? bars.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0) : Math.max(0, ...bars.map(s => s.values[i] || 0)), ...lines.map(s => s.values[i] || 0));
  const e = mx > 0 ? Math.pow(10, Math.floor(Math.log10(mx / 4))) : 1, f = mx / 4 / e, step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e, ymax = step * Math.max(1, Math.ceil(mx / step));
  const Y = v => base - Math.max(0, v) / ymax * (base - top), slot = (x1 - x0) / n, gw = Math.min(30, slot * 0.68), bw = stack ? gw : gw / Math.max(1, bars.length), every = Math.ceil(n / 16);
  const ax = v => v >= 1e4 ? rptFmt(v / 1e3, 0) + ' k' : v >= 1e3 ? rptFmt(v / 1e3, 1) + ' k' : rptFmt(v, 0);
  let g = '';
  for (let v = 0; v <= ymax + 1e-9; v += step) g += `<line x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}" class="cg"/><text x="${x0 - 5}" y="${Y(v) + 3}" class="ct" text-anchor="end">${ax(v)}</text>`;
  for (let i = 0; i < n; i++) {
    const cx = x0 + slot * (i + 0.5); let acc = 0;
    bars.forEach((s, j) => { const v = Math.max(0, s.values[i] || 0); if (!v) return;
      const y0 = stack ? Y(acc + v) : Y(v), hh = stack ? Y(acc) - Y(acc + v) : base - Y(v), x = stack ? cx - gw / 2 : cx - gw / 2 + j * bw;
      g += `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${(stack ? gw : bw * 0.92).toFixed(1)}" height="${hh.toFixed(1)}" class="${s.cls}"><title>${esc(labels[i])} · ${esc(s.name)} : ${cshMoney(v)}</title></rect>`; if (stack) acc += v; });
    if (i % every === 0) g += `<text x="${cx}" y="${H - 6}" class="ct" text-anchor="middle">${esc(labels[i])}</text>`;
  }
  lines.forEach(s => { const pts = s.values.map((v, i) => v == null ? null : (x0 + slot * (i + 0.5)).toFixed(1) + ',' + Y(v).toFixed(1)).filter(Boolean);
    g += `<polyline points="${pts.join(' ')}" class="${s.cls}" fill="none"${s.dash ? ' stroke-dasharray="4 3"' : ''}><title>${esc(s.name)}</title></polyline>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="cshchart2" role="img" aria-label="${esc(o.label || 'Graphique')}"><line x1="${x0}" x2="${x1}" y1="${base}" y2="${base}" class="ca"/>${g}</svg>
    <div class="small cshlg">${series.map(s => `<span><i class="${s.cls}${s.type === 'line' ? ' ln' : ''}${s.dash ? ' dash' : ''}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

/** Données des deux documents : période, période précédente, courbes alignées */
function cshRptData(p) {
  const pr = cshPrev(p.from, p.to), cur = cshSummary(cshCalcCtx(p)), prv = cshSummary(cshCalcCtx(pr));
  const bk = cshBuckets(cur.daily, p.from, p.to), bp = cshBuckets(prv.daily, pr.from, pr.to, bk.by);
  const labels = bk.list.map(b => cshBucketLabel(b.key, bk.by)), caOf = b => cshR(b.revenue + b.boltRevenue + b.courses);
  let s1 = 0, s2 = 0;
  return { p, pr, cur, prv, bk, bp, labels,
    ca: bk.list.map(caOf), caPrev: bk.list.map((b, i) => bp.list[i] ? caOf(bp.list[i]) : null),
    cum: bk.list.map(b => (s1 = cshR(s1 + caOf(b)))), cumPrev: bk.list.map((b, i) => bp.list[i] ? (s2 = cshR(s2 + caOf(bp.list[i]))) : null) };
}

// ---------- Onglet Rapports ----------
async function cshTabRapports(p) {
  const D = cshRptData(p), c = D.cur, v = D.prv, pre = cshPresets(today());
  const dl = (a, b) => { const x = cshPct(a, b); return x == null ? '<div class="small">période précédente : aucune donnée</div>' : `<div class="small ${x >= 0 ? 'ok' : 'red'}">${x >= 0 ? '▲' : '▼'} ${cshPctTxt(x)} vs période précédente</div>`; };
  const L = D.labels, B = D.bk.list, sheet = await cshSheetLink();
  cshBody(`<div class="bar"><span>Période</span> ${pre.map(x => `<a class="${x.from === p.from && x.to === p.to ? 'on' : ''}" href="${cshHref('rapports', { du: x.from, au: x.to })}">${x.label}</a>`).join(' · ')}
      <span class="small">${esc(cshPeriodTxt(p.from, p.to))} · ${esc(cshCmpTxt(D.pr))}</span></div>
    <div class="cshdocs">
      <div class="panel"><h3>Rapport des encaissements</h3><p class="small">Espèces déclarées par Uber et Bolt, encaissées par shift, rapprochement par chauffeur, détail des encaissements, dépenses, dépôts et soldes des caisses.</p>
        <p><button id="cshrep">PDF</button> <button class="ghost" id="cshrepx">Tableur</button></p></div>
      <div class="panel"><h3>Compte rendu d'activité</h3><p class="small">Évolution du chiffre d'affaires (Uber, Bolt, courses privées) comparée à la période précédente, cumul, espèces, répartition, chauffeurs : graphiques et tableaux.</p>
        <p><button id="cshcr">PDF avec graphiques</button></p></div>
      <div class="panel"><h3>Dépôt en banque</h3><p class="small">Bordereau à signer le jour du dépôt : montant par caisse, billetage, montant en lettres, signatures ; dépôt enregistré dans la caisse.</p>
        <p><a class="btn" href="${cshHref('depot')}">Préparer le bordereau</a></p></div>
      <div class="panel"><h3>Classeur Google de l'agence</h3><p class="small">Copie de la caisse de ${esc(CS.agName || 'l\'agence')}, mise à jour toutes les 5 minutes (onglets « … Ludy »).</p>
        <p>${sheet ? `<a class="btn ghost" href="${cshSheetUrl(sheet)}" target="_blank" rel="noopener">Ouvrir le classeur ↗</a>` : (CS.agId ? '<span class="small">Classeur en cours de création par le collecteur (5 min).</span>' : '<span class="small">Caisse sans agence : classeur réglé dans les paramètres (cashSheetId).</span>')}</p></div>
    </div>` +
    cards([['Chiffre d\'affaires total', cshMoney(c.ca) + dl(c.ca, v.ca)], ['Chiffre d\'affaires Uber', cshMoney(c.revenue) + dl(c.revenue, v.revenue)], ['Chiffre d\'affaires Bolt', cshMoney(c.boltRevenue) + dl(c.boltRevenue, v.boltRevenue)],
      ['Courses privées', cshMoney(c.coursesCA) + dl(c.coursesCA, v.coursesCA)], ['Espèces encaissées', cshMoney(c.cash) + dl(c.cash, v.cash)], ['Taux de remise des espèces', cshRate(c.taux), c.taux != null && c.taux < 0.98 ? 'warn' : ''],
      ['Manquant à retenir', cshMoney(c.manquant), c.manquant ? 'crit' : 'ok'], ['Chauffeurs actifs', f0(c.active) + (c.caPerDriver != null ? `<div class="small">${cshMoney(c.caPerDriver)} par chauffeur</div>` : '')]]) +
    `<div class="grid2"><div class="panel"><h3>Évolution du chiffre d'affaires</h3>${cshSvg(L, [{ name: 'Uber', cls: 'cs-uber', values: B.map(b => b.revenue) }, { name: 'Bolt', cls: 'cs-bolt', values: B.map(b => b.boltRevenue) },
        { name: 'Courses privées', cls: 'cs-crs', values: B.map(b => b.courses) }, { name: 'Période précédente', cls: 'cs-prev', type: 'line', dash: true, values: D.caPrev }], { label: 'Chiffre d\'affaires' })}</div>
      <div class="panel"><h3>Espèces déclarées et encaissées</h3>${cshSvg(L, [{ name: 'Déclarées (Uber + Bolt)', cls: 'cs-decl', values: B.map(b => cshR(b.uber + b.bolt)) },
        { name: 'Encaissées (net)', cls: 'cs-net', values: B.map(b => cshR(b.net + b.boltNet)) }], { group: true, label: 'Espèces' })}</div></div>`);
  $('#cshrep').onclick = () => { try { reportPdf(cshRepEnc(p)); } catch (e) { alert(e.message); } };
  $('#cshrepx').onclick = () => cshRepEncXls(p);
  $('#cshcr').onclick = () => { try { reportPdf(cshRepCR(p)); } catch (e) { alert(e.message); } };
}

// ---------- Rapport des encaissements ----------
function cshEncRows(p) { return CS.moves.filter(m => cshLive(m) && m.kind === 'encaissement' && m.day >= p.from && m.day <= p.to).sort((a, b) => a.day.localeCompare(b.day) || String(a.shift || '').localeCompare(String(b.shift || '')) || a.id - b.id); }
function cshRapRows(c) {
  return c.rap.map(r => Object.assign({ pf: 'Uber' }, r)).concat(c.rapB.map(r => Object.assign({ pf: 'Bolt' }, r))).filter(r => r.statut !== 'Sans activité')
    .sort((a, b) => b.ecart - a.ecart || String(a.name).localeCompare(String(b.name)));
}
function cshRepEnc(p) {
  const c = cshSummary(cshCalcCtx(p)), bal = cshBalances(CS.all.filter(m => m.day && m.day <= p.to)), M = v => cshMoney(v), T = (l, f) => cshR(l.reduce((s, x) => s + f(x), 0));
  const days = c.daily, enc = cshEncRows(p), dep = CS.moves.filter(m => cshLive(m) && m.kind === 'depot' && m.day >= p.from && m.day <= p.to), cats = cshByCategory(CS.moves, p.from, p.to), catT = T(cats, x => x.amount);
  const cn = m => (CASH_CAISSES.find(x => x[0] === m.caisse) || [])[1] || m.caisse;
  return { kind: 'caisse', title: 'Rapport des encaissements', agency: CS.agName || 'Agence', period: cshPeriodTxt(p.from, p.to), from: p.from, to: p.to, generatedAt: new Date().toISOString(),
    fileName: 'encaissements_' + cshFileAg() + '_' + p.from + '_' + p.to,
    footer: 'Ludy · Caisse — montants saisis dans Ludy et exports Uber / Bolt importés ; rien n\'est estimé. « ' + RPT_NM + ' » quand la valeur manque.',
    summary: [['Espèces déclarées par Uber', M(c.uber)], ['Espèces Uber encaissées (net)', M(c.uberNet)], ['Espèces déclarées par Bolt', M(c.bolt)], ['Espèces Bolt encaissées (net)', M(c.boltNet)],
      ['Courses privées encaissées', M(c.courses)], ['Total des espèces encaissées', M(c.cash)], ['Manquant à retenir', M(c.manquant)], ['Excédent à ajouter', M(c.excedent)],
      ['Taux de remise des espèces', cshRate(c.taux)], ['Dépenses chauffeurs', M(c.depenses)], ['Avances sur salaire', M(c.avances)], ['Bonus', M(c.bonus)],
      ['Dépôts en banque', M(c.depots)], ['Solde des caisses au ' + fmtDay(p.to), M(bal.total)], ['Encaissements saisis', f0(c.nEnc)], ['Chauffeurs actifs', f0(c.active)]],
    tables: [
      { title: 'Encaissements par jour de shift', empty: 'Aucun mouvement sur la période', num: [1, 2, 3, 4, 5, 6, 7],
        head: ['Jour', 'Espèces Uber déclarées', 'Encaissé Uber', 'Espèces Bolt déclarées', 'Encaissé Bolt', 'Courses privées', 'Dépenses', 'Dépôts en banque'],
        rows: days.length ? days.map(d => [cshDow(d.day).slice(0, 3) + '. ' + fmtDay(d.day), M(d.uber), M(d.net), M(d.bolt), M(d.boltNet), M(d.courses), M(d.depenses), M(d.depots)])
          .concat([['Total', M(c.uber), M(c.uberNet), M(c.bolt), M(c.boltNet), M(c.courses), M(c.depenses), M(c.depots)]]) : [] },
      { title: 'Rapprochement des espèces par chauffeur', empty: 'Aucune activité sur la période', num: [2, 3, 4, 5, 6],
        head: ['Chauffeur', 'Plateforme', 'Espèces déclarées', 'Frais justifiés', 'À remettre', 'Encaissé', 'Écart', 'Statut'],
        rows: cshRapRows(c).map(r => [r.name || r.key, r.pf, M(r.uber), M(r.frais), M(r.theo), M(r.net), M(r.ecart), r.statut]) },
      { title: 'Détail des encaissements', empty: 'Aucun encaissement saisi sur la période', num: [4, 5, 6, 7],
        head: ['Jour', 'Shift', 'Chauffeur', 'Caisse', 'Espèces déclarées', 'Remis', 'Monnaie rendue', 'Encaissé net', 'Gestionnaire'],
        rows: enc.map(m => [fmtDay(m.day), m.shift || '', m.driver_code ? cshDrvName(m.driver_code) : m.driver_name || '', m.caisse === 'bolt' ? 'Bolt' : 'Uber',
          m.uber_cash == null ? RPT_NM : M(m.uber_cash), m.given == null ? '' : M(m.given), m.change == null ? '' : M(m.change), M(m.amount), m.manager_name || '']) },
      { title: 'Dépenses par catégorie', empty: 'Aucune dépense sur la période', num: [1, 2], head: ['Catégorie', 'Montant', 'Part'],
        rows: cats.length ? cats.map(x => [x.label, M(x.amount), catT ? rptFmt(x.amount / catT * 100, 1) + ' %' : '']).concat([['Total', M(catT), '100 %']]) : [] },
      { title: 'Dépôts en banque', empty: 'Aucun dépôt sur la période', num: [2], head: ['Jour', 'Caisse', 'Montant', 'Référence / commentaire', 'Gestionnaire'],
        rows: dep.map(m => [fmtDay(m.day), cn(m), M(m.amount), m.comment || '', m.manager_name || '']) },
      { title: 'Soldes des caisses au ' + fmtDay(p.to), empty: '', num: [1], head: ['Caisse', 'Solde (espèces en main)'],
        rows: CASH_CAISSES.map(x => [x[1], M(bal[x[0]])]).concat([['Total', M(bal.total)]]) }] };
}
function cshRepEncXls(p) {
  if (!window.XLSX) { alert('Bibliothèque tableur non chargée, réessayez dans un instant.'); return; }
  const rep = cshRepEnc(p), wb = XLSX.utils.book_new(), num = v => { const s = String(v).replace(/[\s  ]/g, '').replace(/MAD$/, '').replace(',', '.').replace('−', '-'); return /^-?\d+(\.\d+)?$/.test(s) ? +s : v; };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[rep.title + ' · ' + rep.agency], [rep.period], []].concat(rep.summary.map(s => [s[0], num(s[1])]))), 'Résumé');
  rep.tables.forEach(t => { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.head].concat(t.rows.map(r => r.map(num)))), t.title.replace(/[\\/?*[\]:]/g, '').slice(0, 31)); });
  XLSX.writeFile(wb, rep.fileName + '.xlsx');
}

// ---------- Compte rendu d'activité (graphiques) ----------
function cshRepCR(p) {
  const D = cshRptData(p), c = D.cur, v = D.prv, M = x => cshMoney(x), B = D.bk.list, by = D.bk.by, dt = (a, b) => cshPctTxt(cshPct(a, b));
  const drv = {}; [[c.caUber, 'u'], [c.caBolt, 'b']].forEach(([ca, k]) => ca.rows.forEach(r => { const x = drv[r.key] = drv[r.key] || { name: r.name || r.key, u: 0, b: 0 }; x[k] = cshR(x[k] + r.total); }));
  const ec = {}; cshRapRows(c).forEach(r => { if (!r.unlinked) ec[r.key] = cshR((ec[r.key] || 0) + r.ecart); });
  const top = Object.keys(drv).map(k => Object.assign({ key: k, t: cshR(drv[k].u + drv[k].b) }, drv[k])).sort((a, b) => b.t - a.t);
  const parts = [['Uber', c.revenue, CSH_PAL.uber], ['Bolt', c.boltRevenue, CSH_PAL.bolt], ['Courses privées', c.coursesCA, CSH_PAL.courses]];
  const unit = by === 'week' ? 'semaine' : 'jour';
  return { kind: 'caisse', title: 'Compte rendu d\'activité — chiffre d\'affaires et encaissements', agency: CS.agName || 'Agence', period: cshPeriodTxt(p.from, p.to) + ' (' + cshCmpTxt(D.pr).replace(/^comparée/, 'comparé') + ')',
    from: p.from, to: p.to, generatedAt: new Date().toISOString(), fileName: 'compte_rendu_caisse_' + cshFileAg() + '_' + p.from + '_' + p.to,
    footer: 'Ludy · Caisse — chiffre d\'affaires Uber (« Vos revenus »), Bolt (« Total des paiements ») et courses privées saisies ; espèces saisies dans Ludy. Rien n\'est estimé.',
    summary: [['Chiffre d\'affaires total', M(c.ca) + '  (' + dt(c.ca, v.ca) + ')'], ['Chiffre d\'affaires Uber', M(c.revenue) + '  (' + dt(c.revenue, v.revenue) + ')'],
      ['Chiffre d\'affaires Bolt', M(c.boltRevenue) + '  (' + dt(c.boltRevenue, v.boltRevenue) + ')'], ['Courses privées (' + f0(c.nCourses) + ')', M(c.coursesCA) + '  (' + dt(c.coursesCA, v.coursesCA) + ')'],
      ['Chauffeurs actifs', f0(c.active) + '  (' + (v.active ? (c.active - v.active >= 0 ? '+' : '−') + Math.abs(c.active - v.active) : '—') + ')'], ['Chiffre d\'affaires par chauffeur', c.caPerDriver == null ? RPT_NM : M(c.caPerDriver)],
      ['Espèces encaissées', M(c.cash) + '  (' + dt(c.cash, v.cash) + ')'], ['Taux de remise des espèces', cshRate(c.taux)],
      ['Manquant à retenir', M(c.manquant)], ['Excédent à ajouter', M(c.excedent)], ['Dépenses chauffeurs', M(c.depenses)], ['Dépôts en banque', M(c.depots)]],
    tables: [
      { title: 'Évolution du chiffre d\'affaires par ' + unit, chart: { type: 'stack', labels: D.labels, series: [{ name: 'Uber', color: CSH_PAL.uber, values: B.map(b => b.revenue) },
        { name: 'Bolt', color: CSH_PAL.bolt, values: B.map(b => b.boltRevenue) }, { name: 'Courses privées', color: CSH_PAL.courses, values: B.map(b => b.courses) },
        { name: 'Période précédente', color: CSH_PAL.prev, type: 'line', dash: true, values: D.caPrev }] } },
      { title: 'Chiffre d\'affaires cumulé : période et période précédente', chart: { type: 'stack', labels: D.labels, height: 58, series: [{ name: 'Cumul de la période', color: CSH_PAL.courses, type: 'line', values: D.cum },
        { name: 'Cumul de la période précédente', color: CSH_PAL.prev, type: 'line', dash: true, values: D.cumPrev }] } },
      { title: 'Espèces déclarées et encaissées par ' + unit, chart: { type: 'group', labels: D.labels, height: 58, series: [{ name: 'Déclarées (Uber + Bolt)', color: CSH_PAL.decl, values: B.map(b => cshR(b.uber + b.bolt)) },
        { name: 'Encaissées (net)', color: CSH_PAL.net, values: B.map(b => cshR(b.net + b.boltNet)) }] } },
      { title: 'Répartition du chiffre d\'affaires', chart: { type: 'hbar', labels: parts.map(x => x[0]), height: 26, fmt: x => M(x) + (c.ca ? '  ·  ' + rptFmt(x / c.ca * 100, 1) + ' %' : ''),
        series: [{ name: '', color: CSH_PAL.uber, colors: parts.map(x => x[2]), values: parts.map(x => x[1]) }] } },
      { title: 'Chauffeurs : chiffre d\'affaires (10 premiers)', empty: 'Aucun chiffre d\'affaires sur la période', chart: { type: 'hbar', labels: top.slice(0, 10).map(x => x.name), height: Math.max(20, Math.min(10, top.length) * 7 + 4), fmt: x => M(x),
        series: top.length ? [{ name: '', color: CSH_PAL.net, values: top.slice(0, 10).map(x => x.t) }] : [] } },
      { title: 'Chiffre d\'affaires et espèces par ' + unit, empty: 'Aucune activité', num: [1, 2, 3, 4, 5, 6, 7], head: [unit === 'jour' ? 'Jour' : 'Semaine du', 'Uber', 'Bolt', 'Courses privées', 'Total', 'Période précédente', 'Espèces déclarées', 'Encaissé'],
        rows: B.map((b, i) => [unit === 'jour' ? cshDow(b.key).slice(0, 3) + '. ' + fmtDay(b.key) : fmtDay(b.key), M(b.revenue), M(b.boltRevenue), M(b.courses), M(D.ca[i]), D.caPrev[i] == null ? '—' : M(D.caPrev[i]), M(cshR(b.uber + b.bolt)), M(cshR(b.net + b.boltNet))])
          .concat([['Total', M(c.revenue), M(c.boltRevenue), M(c.courses), M(cshR(c.revenue + c.boltRevenue + c.courses)), M(cshR(v.revenue + v.boltRevenue + v.courses)), M(c.declared), M(cshR(c.uberNet + c.boltNet))]]) },
      { title: 'Chauffeurs', empty: 'Aucun chiffre d\'affaires sur la période', num: [1, 2, 3, 4], head: ['Chauffeur', 'Chiffre d\'affaires Uber', 'Chiffre d\'affaires Bolt', 'Total', 'Écart espèces (+ manquant)'],
        rows: top.map(x => [x.name, M(x.u), M(x.b), M(x.t), ec[x.key] == null ? '—' : M(ec[x.key])]) }] };
}

// ---------- Dépôt en banque ----------
function cshDepKey() { return 'cshDep:' + (CS.agId || 0); }
async function cshTabDepot() {
  const q = qs(), day = /^\d{4}-\d{2}-\d{2}$/.test(q.get('jour') || '') ? q.get('jour') : today(), info = cshDepositInfo(CS.all, day), sv = lsJSON(cshDepKey()) || {};
  const box = CASH_CAISSES.filter(x => info.balances[x[0]] > 0 || ['uber', 'bolt', 'courses'].indexOf(x[0]) >= 0);
  const hist = CS.all.filter(m => cshLive(m) && m.kind === 'depot').sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id).slice(0, 60);
  cshBody(`<div class="grid2"><div class="panel"><h3>Bordereau de dépôt en banque</h3>
      <div class="mfrow">${cshField('dpday', 'Date du dépôt', 'date', { value: day })}${cshField('dpco', 'Société', 'text', { value: sv.company || '', size: 22, ph: 'Raison sociale' })}</div>
      <div class="mfrow">${cshField('dpbank', 'Banque', 'text', { value: sv.bank || '', size: 18 })}${cshField('dpacc', 'Compte / RIB', 'text', { value: sv.account || '', size: 30 })}</div>
      <div class="mfrow">${cshField('dpwho', 'Déposant', 'text', { value: sv.who || S.profile.name || '', size: 22 })}${cshField('dpcin', 'CIN du déposant', 'text', { value: sv.cin || '', size: 12 })}</div>
      <h3>Montant déposé par caisse</h3>
      <table class="tw cshdep"><thead><tr><th></th><th>Caisse</th><th class="n">Solde au ${fmtDay(day)}</th><th class="n">Déposé (MAD)</th></tr></thead><tbody>
        ${box.map(x => { const b = info.balances[x[0]], on = b > 0 && ['uber', 'bolt', 'courses'].indexOf(x[0]) >= 0;
          return `<tr><td><input type="checkbox" data-dpon="${x[0]}" ${on ? 'checked' : ''}></td><td>${esc(x[1])}</td><td class="n">${cshMoney(b)}</td><td class="n"><input type="number" min="0" step="0.01" data-dpam="${x[0]}" value="${on ? b : ''}" style="width:120px"></td></tr>`; }).join('')}
      </tbody></table>
      <h3>Billetage</h3><table class="tw cshdep"><thead><tr><th>Coupure</th><th>Nombre</th><th class="n">Montant</th></tr></thead><tbody>
        ${CSH_DENOMS.map((d, i) => `<tr><td>${d[1]} de ${rptFmt(d[0], d[0] < 1 ? 2 : 0)} DH</td><td><input type="number" min="0" step="1" data-dpn="${i}" style="width:90px"></td><td class="n" id="dpl${i}"></td></tr>`).join('')}
      </tbody></table>
      ${cshField('dpnote', 'Observations', 'text', { size: 50 })}
      <div id="dptot" class="panel"></div>
      <p><button id="dpsave">Enregistrer le dépôt et télécharger le bordereau</button> <button class="ghost" id="dppdf">Bordereau seul (sans enregistrer)</button></p><div id="dpres"></div></div>
    <div class="panel"><h3>Espèces entrées depuis le dernier dépôt</h3><p class="small">${info.lastDeposit ? 'Dernier dépôt enregistré : ' + fmtDay(info.lastDeposit) : 'Aucun dépôt enregistré avant ce jour.'}</p>
      ${table('tcshdps', [['Jour', r => fmtDay(r.day), r => r.day], ['Uber', r => cshMoney(r.uber), r => r.uber, 'n'], ['Bolt', r => cshMoney(r.bolt), r => r.bolt, 'n'], ['Courses privées', r => cshMoney(r.courses), r => r.courses, 'n'], ['Total', r => '<b>' + cshMoney(r.total) + '</b>', r => r.total, 'n']], info.since, { empty: 'Aucune entrée d\'espèces depuis le dernier dépôt', total: { fmt: x => '<b>' + cshMoney(x) + '</b>' } })}
      <h3>Derniers dépôts</h3>${table('tcshdph', [['Jour', m => fmtDay(m.day), m => m.day], ['Caisse', m => esc((CASH_CAISSES.find(x => x[0] === m.caisse) || [])[1] || m.caisse)], ['Montant', m => cshMoney(m.amount), m => cshN(m.amount), 'n'], ['Référence', m => esc(m.comment || '')]], hist, { empty: 'Aucun dépôt enregistré', page: true })}</div></div>`);
  if ($('#dpday')) $('#dpday').onchange = () => { location.hash = cshHref('depot', { jour: $('#dpday').value }); };
  const read = () => {
    const lines = box.filter(x => $(`[data-dpon="${x[0]}"]`).checked).map(x => ({ caisse: x[0], name: x[1], balance: info.balances[x[0]], amount: cshR(cshN($(`[data-dpam="${x[0]}"]`).value)) })).filter(l => l.amount > 0);
    const counts = CSH_DENOMS.map((d, i) => Math.max(0, Math.floor(cshN($(`[data-dpn="${i}"]`).value))));
    return { day: $('#dpday').value || day, company: $('#dpco').value.trim(), bank: $('#dpbank').value.trim(), account: $('#dpacc').value.trim(), who: $('#dpwho').value.trim(), cin: $('#dpcin').value.trim(),
      note: $('#dpnote').value.trim(), lines, counts, total: cshR(lines.reduce((s, l) => s + l.amount, 0)), bills: cshBillTotal(counts), lastDeposit: info.lastDeposit, since: info.since };
  };
  const show = () => { const d = read();
    CSH_DENOMS.forEach((x, i) => { $('#dpl' + i).textContent = d.counts[i] ? cshMoney(cshR(x[0] * d.counts[i])) : ''; });
    const gap = cshR(d.bills - d.total);
    $('#dptot').innerHTML = `<b>Montant déposé : ${cshMoney(d.total)}</b><div class="small">${esc(cshMadWords(d.total))}</div>
      <div class="small ${d.counts.some(Boolean) ? (Math.abs(gap) < 0.005 ? 'ok' : 'red') : ''}">Billetage : ${cshMoney(d.bills)}${d.counts.some(Boolean) ? (Math.abs(gap) < 0.005 ? ' · égal au montant déposé' : ' · écart ' + cshMoney(gap)) : ' (à compter)'}</div>`; };
  document.querySelectorAll('[data-dpon],[data-dpam],[data-dpn]').forEach(e => { e.oninput = show; e.onchange = show; });
  show();
  const keep = d => lsSet(cshDepKey(), { company: d.company, bank: d.bank, account: d.account, who: d.who, cin: d.cin });
  const check = d => { if (!d.lines.length) return 'Choisir au moins une caisse et un montant à déposer.'; if (d.lines.some(l => l.amount > l.balance + 0.005)) return 'Montant déposé supérieur au solde de la caisse.';
    if (d.counts.some(Boolean) && Math.abs(d.bills - d.total) >= 0.005) return 'Le billetage (' + cshMoney(d.bills) + ') ne correspond pas au montant déposé (' + cshMoney(d.total) + ').'; return ''; };
  $('#dppdf').onclick = () => { const d = read(), e = check(d); if (e) { $('#dpres').innerHTML = msg(esc(e), 'err'); return; } keep(d); d.ref = cshDepRef(d.day, 'projet'); try { cshDepositPdf(d); } catch (x) { alert(x.message); } };
  $('#dpsave').onclick = async () => {
    const d = read(), e = check(d); if (e) { $('#dpres').innerHTML = msg(esc(e), 'err'); return; }
    if (!(await ask('Enregistrer le dépôt de ' + cshMoney(d.total) + ' du ' + fmtDay(d.day) + ' ? Il sort des caisses choisies.'))) return;
    keep(d); d.ref = cshDepRef(d.day);
    try {
      for (const l of d.lines) await cshInsert({ caisse: l.caisse, kind: 'depot', flow: 'out', amount: l.amount, day: d.day, source: 'Banque', label: CSH_KIND.depot,
        comment: 'Bordereau ' + d.ref + (d.bank ? ' · ' + d.bank : '') + (d.who ? ' · déposé par ' + d.who : '') });
      cshDepositPdf(d);
      CS.flash = { id: 'dpres', html: msg('Dépôt enregistré (' + esc(d.ref) + ') et bordereau téléchargé : à faire signer et tamponner par la banque.', 'ok') };
      pageCaisse();
    } catch (x) { $('#dpres').innerHTML = msg(esc(x.message), 'err'); }
  };
  if (CS.flash && $('#' + CS.flash.id)) { $('#' + CS.flash.id).innerHTML = CS.flash.html; CS.flash = null; }
}
/** Référence du bordereau : DEP-<agence>-aaaammjj-n (n = dépôts déjà enregistrés ce jour + 1) */
function cshDepRef(day, draft) {
  const n = new Set(CS.all.filter(m => cshLive(m) && m.kind === 'depot' && m.day === day).map(m => (String(m.comment || '').match(/DEP-[\w-]+/) || [m.id])[0])).size;
  return 'DEP-' + (CS.agId || 0) + '-' + day.replace(/-/g, '') + '-' + (n + 1) + (draft ? ' (' + draft + ')' : '');
}
/** Bordereau de dépôt (A4 portrait) : à signer par le déposant et le responsable, cachet de la banque */
function cshDepositPdf(d) {
  if (!window.jspdf) throw new Error('bibliothèque PDF non chargée, réessayez dans un instant');
  if (window.applyPlugin && !window.jspdf.jsPDF.API.autoTable) window.applyPlugin(window.jspdf.jsPDF);
  const cl = v => String(v == null ? '' : v).replace(/[  ]/g, ' ').replace(/−/g, '-');
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' }), W = 210, H = 297, M = 16;
  const C = { ink: [20, 32, 43], mute: [93, 107, 120], line: [216, 222, 228], soft: [243, 245, 247], head: [15, 38, 51], acc: [91, 75, 214] };
  const col = (k, c) => doc['set' + k](c[0], c[1], c[2]), font = (st, sz, c) => { doc.setFont('helvetica', st); doc.setFontSize(sz); col('TextColor', c || C.ink); };
  const money = v => cl(cshMoney(v));
  try { doc.addImage(RPT_LOGO, 'PNG', M, 12, 38, 9.3); } catch (e) { }
  font('bold', 8, C.acc); doc.text('CAISSE · DÉPÔT EN BANQUE', W - M, 15, { align: 'right' });
  font('normal', 8, C.mute); doc.text('Édité le ' + fmtDTY(new Date().toISOString()), W - M, 19.5, { align: 'right' });
  font('bold', 18); doc.text('Bordereau de dépôt d\'espèces', M, 34);
  font('normal', 10, C.mute); doc.text(cl('N° ' + d.ref + (CS.agName ? ' · ' + CS.agName : '')), M, 40.5);
  col('DrawColor', C.acc); doc.setLineWidth(0.6); doc.line(M, 44, W - M, 44);
  // informations du dépôt : deux colonnes de cases
  const info = [['Société', d.company || '……………………………'], ['Agence', CS.agName || '—'], ['Date du dépôt', cshDow(d.day) + ' ' + fmtDay(d.day)], ['Banque', d.bank || '……………………………'],
    ['Compte / RIB', d.account || '……………………………………………'], ['Déposant', (d.who || '……………………………') + (d.cin ? ' · CIN ' + d.cin : '')],
    ['Période couverte', d.lastDeposit ? 'depuis le dépôt du ' + fmtDay(d.lastDeposit) : 'premier dépôt enregistré'], ['Observations', d.note || '']];
  let y = 50; const cw = (W - 2 * M - 4) / 2;
  info.forEach((it, i) => { const x = M + (i % 2) * (cw + 4), yy = y + Math.floor(i / 2) * 11.5;
    col('FillColor', C.soft); doc.roundedRect(x, yy, cw, 10, 1.4, 1.4, 'F');
    font('normal', 6.8, C.mute); doc.text(cl(it[0]).toUpperCase(), x + 3, yy + 3.7); font('bold', 9.2); doc.text(doc.splitTextToSize(cl(it[1]), cw - 6)[0], x + 3, yy + 7.9); });
  y += Math.ceil(info.length / 2) * 11.5 + 7;
  const tab = (title, head, body, num, opts) => {
    font('bold', 11); col('FillColor', C.acc); doc.rect(M, y - 3.7, 1.3, 4.8, 'F'); doc.text(cl(title), M + 3.5, y);
    const cs = {}; (num || []).forEach(i => { cs[i] = { halign: 'right' }; });
    doc.autoTable({ startY: y + 2.5, head: [head.map(cl)], body: body.map(r => r.map(cl)), theme: 'striped', margin: { left: M, right: M },
      styles: { font: 'helvetica', fontSize: 8.2, cellPadding: 1.25, textColor: C.ink }, headStyles: { fillColor: C.head, textColor: 255, fontStyle: 'bold' }, columnStyles: cs,
      didParseCell: x => { if (x.section === 'head' && (num || []).indexOf(x.column.index) >= 0) x.cell.styles.halign = 'right'; if (x.section === 'body' && x.row.index === body.length - 1 && opts && opts.total) x.cell.styles.fontStyle = 'bold'; } });
    y = doc.lastAutoTable.finalY + 7;
  };
  tab('Montant déposé par caisse', ['Caisse', 'Solde avant dépôt', 'Montant déposé'], d.lines.map(l => [l.name, money(l.balance), money(l.amount)]).concat([['Total', '', money(d.total)]]), [1, 2], { total: true });
  const used = CSH_DENOMS.map((x, i) => [x, d.counts[i]]).filter(z => z[1]);
  tab('Billetage', ['Coupure', 'Nombre', 'Montant'], (used.length ? used.map(z => [z[0][1] + ' de ' + rptFmt(z[0][0], z[0][0] < 1 ? 2 : 0) + ' DH', f0(z[1]), money(cshR(z[0][0] * z[1]))]) : CSH_DENOMS.map(z => [z[1] + ' de ' + rptFmt(z[0], z[0] < 1 ? 2 : 0) + ' DH', '', '']))
    .concat([['Total', '', used.length ? money(d.bills) : '']]), [1, 2], { total: true });
  // montant en chiffres et en lettres
  if (y > H - 86) { doc.addPage(); y = 20; }
  col('FillColor', C.head); doc.roundedRect(M, y, W - 2 * M, 22, 2, 2, 'F');
  font('normal', 8, [190, 205, 215]); doc.text('MONTANT TOTAL DÉPOSÉ', M + 5, y + 6.5);
  font('bold', 17, [255, 255, 255]); doc.text(money(d.total), W - M - 5, y + 10, { align: 'right' });
  font('normal', 8.5, [225, 232, 238]); doc.text(doc.splitTextToSize('Arrêté le présent bordereau à la somme de : ' + cl(cshMadWords(d.total)), W - 2 * M - 10).slice(0, 2), M + 5, y + 15);
  y += 28;
  // signatures (avant le détail pour information : toujours sur la première page quand elle a la place)
  if (y > H - 52) { doc.addPage(); y = 24; }
  const sw = (W - 2 * M - 8) / 3;
  [['Déposant', d.who], ['Responsable d\'agence', ''], ['Cachet et visa de la banque', d.bank]].forEach((s, i) => { const x = M + i * (sw + 4);
    col('DrawColor', C.line); doc.setLineWidth(0.3); doc.roundedRect(x, y, sw, 34, 1.6, 1.6, 'S');
    font('bold', 8.5); doc.text(cl(s[0]), x + 3, y + 5.5); font('normal', 7.5, C.mute); doc.text(cl(s[1] || ''), x + 3, y + 10);
    doc.text('Date et signature', x + 3, y + 30.5); });
  y += 42;
  if (d.since && d.since.length) {
    if (y > H - 50) { doc.addPage(); y = 24; }
    tab('Espèces entrées depuis le dernier dépôt (pour information)', ['Jour', 'Uber', 'Bolt', 'Courses privées', 'Total'], d.since.slice(-14).map(r => [fmtDay(r.day), money(r.uber), money(r.bolt), money(r.courses), money(r.total)]), [1, 2, 3, 4]);
  }
  const np = doc.getNumberOfPages();
  for (let i = 1; i <= np; i++) { doc.setPage(i); font('normal', 7, C.mute); doc.text('Page ' + i + ' / ' + np, W - M, H - 5, { align: 'right' }); }
  doc.setPage(1); font('normal', 7, C.mute);
  doc.text('Document généré par Ludy — à conserver avec le reçu de versement remis par la banque. Le dépôt est enregistré dans la caisse de l\'agence (sortie « Dépôt en banque »).', M, H - 10, { maxWidth: W - 2 * M - 22 });
  doc.save(('bordereau_depot_' + cshFileAg() + '_' + d.day + '_' + d.ref.replace(/[^A-Za-z0-9-]+/g, '_')).replace(/_+/g, '_') + '.pdf');
}
