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
          m.uber_cash == null ? (m.label === CSH_COMPLEMENT ? 'complément' : RPT_NM) : M(m.uber_cash), m.given == null ? '' : M(m.given), m.change == null ? '' : M(m.change), M(m.amount), m.manager_name || '']) },
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
  // historique : un dépôt groupé (Uber + Bolt + courses privées…) = une ligne, un montant ; reçu de la banque joint
  const groups = cshDepGroups(CS.all), filesOf = g => (CS.files || []).filter(f => f.kind === 'depot' && f.dep_ref === g.key);
  const pend = cshR(['uber', 'bolt', 'courses'].reduce((t, k) => t + Math.max(0, cshN(info.balances[k])), 0)), noProof = groups.filter(g => !filesOf(g).length);
  // jours à déposer (demande d'Ahmed : dépôt du lundi au lundi) : période choisie, par défaut depuis le dernier jour déjà déposé
  const okD = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const lastCov = cshDepLastDay(CS.all, day);   // jamais au-delà de la date d'un dépôt
  const firstIn = CS.all.filter(m => cshLive(m) && m.flow === 'in' && (m.kind === 'encaissement' || m.kind === 'course') && m.day <= day).reduce((x, m) => !x || m.day < x ? m.day : x, '');
  const dFrom0 = lastCov ? cshAddDay(lastCov, 1) : firstIn || cshAddDay(day, -7), dFrom = okD(q.get('dpdu')) ? q.get('dpdu') : (dFrom0 < cshAddDay(day, -62) ? cshAddDay(day, -62) : dFrom0);
  const dTo = okD(q.get('dpau')) ? q.get('dpau') : day, mon = cshWeek(day), pre = cshPresets(day)[0];
  const days = dFrom <= dTo ? cshDepositDays(CS.all, dFrom, dTo) : [];
  const dRow = r => `<tr class="${r.deposited ? 'paid' : ''}"><td><input type="checkbox" data-dpd="${r.day}" ${r.total > 0 && !r.deposited ? 'checked' : ''} ${r.total > 0 ? '' : 'disabled'}></td>
    <td>${esc(cshDow(r.day))} ${fmtDay(r.day)}</td><td class="n">${cshMoney(r.uber)}</td><td class="n">${cshMoney(r.bolt)}</td><td class="n">${cshMoney(r.courses)}</td><td class="n"><b>${cshMoney(r.total)}</b></td>
    <td class="small">${r.deposited ? 'déjà déposé · ' + esc(r.deposited) : r.total > 0 ? '' : 'aucune entrée'}</td></tr>`;
  cshBody(cards([['Espèces à déposer (Uber + Bolt + courses)', cshMoney(pend), pend > 0 ? 'warn' : 'ok'], ['Dernier dépôt', groups.length ? cshMoney(groups[0].total) + `<div class="small">${esc(cshDow(groups[0].day))} ${fmtDay(groups[0].day)}${groups[0].ref ? ' · ' + esc(groups[0].ref) : ''}</div>` : 'aucun'],
      ['Déposé depuis le 1er du mois', cshMoney(groups.filter(g => g.day >= day.slice(0, 8) + '01' && g.day <= day).reduce((t, g) => t + g.total, 0))],
      ['Dépôts sans reçu de la banque', f0(CS.filesErr ? 0 : noProof.length), !CS.filesErr && noProof.length ? 'warn' : 'ok']]) +
    `<div class="grid2"><div class="panel"><h3>Bordereau de dépôt en banque</h3>
      <div class="mfrow">${cshField('dpday', 'Date du dépôt', 'date', { value: day })}${cshField('dpco', 'Société', 'text', { value: sv.company || '', size: 22, ph: 'Raison sociale' })}</div>
      <div class="mfrow">${cshField('dpbank', 'Banque', 'text', { value: sv.bank || '', size: 18 })}${cshField('dpacc', 'Compte / RIB', 'text', { value: sv.account || '', size: 30 })}</div>
      <div class="mfrow">${cshField('dpwho', 'Déposant', 'text', { value: sv.who || S.profile.name || '', size: 22 })}${cshField('dpcin', 'CIN du déposant', 'text', { value: sv.cin || '', size: 12 })}</div>
      <h3>Jours déposés</h3>
      <div class="mfrow">${cshField('dpdu', 'Du', 'date', { value: dFrom })}${cshField('dpau', 'Au', 'date', { value: dTo })}
        <button class="ghost small" data-dpp="${cshAddDay(mon, -7)}|${mon}">Lundi → lundi</button><button class="ghost small" data-dpp="${pre.from}|${pre.to}">Semaine précédente (lun → dim)</button>
        <button class="ghost small" data-dpp="${dFrom0 < cshAddDay(day, -62) ? cshAddDay(day, -62) : dFrom0}|${day}">Depuis le dernier dépôt</button></div>
      <p class="small">Cochez les jours dont les espèces partent en banque : les montants Uber, Bolt et courses privées ci-dessous se remplissent tout seuls (modifiables). Les jours déjà déposés sont signalés et décochés.</p>
      <div class="tw"><table class="cshdep" id="dpdays"><thead><tr><th><input type="checkbox" id="dpall" title="Tout cocher / décocher"></th><th>Jour</th><th class="n">Uber</th><th class="n">Bolt</th><th class="n">Courses privées</th><th class="n">Total</th><th></th></tr></thead>
        <tbody>${days.length ? days.map(dRow).join('') : '<tr><td colspan="7" class="empty">Choisir une période (du … au …).</td></tr>'}</tbody><tfoot><tr class="ttot"><td></td><td id="dpdn"></td><td class="n" id="dpdu_"></td><td class="n" id="dpdb_"></td><td class="n" id="dpdc_"></td><td class="n" id="dpdt_"></td><td></td></tr></tfoot></table></div>
      <h3>Montant déposé par caisse</h3>
      <table class="tw cshdep"><thead><tr><th></th><th>Caisse</th><th class="n">Solde au ${fmtDay(day)}</th><th class="n">Déposé (MAD)</th></tr></thead><tbody>
        ${box.map(x => { const b = info.balances[x[0]], on = b > 0 && ['uber', 'bolt', 'courses'].indexOf(x[0]) >= 0;
          return `<tr><td><input type="checkbox" data-dpon="${x[0]}" ${on ? 'checked' : ''}></td><td>${esc(x[1])}</td><td class="n">${cshMoney(b)}</td><td class="n"><input type="number" min="0" step="0.01" data-dpam="${x[0]}" value="${on ? b : ''}" style="width:120px"></td></tr>`; }).join('')}
      </tbody></table>
      <h3>Billetage</h3><table class="tw cshdep"><thead><tr><th>Coupure</th><th>Nombre</th><th class="n">Montant</th></tr></thead><tbody>
        ${CSH_DENOMS.map((d, i) => `<tr><td>${d[1]} de ${rptFmt(d[0], d[0] < 1 ? 2 : 0)} DH</td><td><input type="number" min="0" step="1" data-dpn="${i}" style="width:90px"></td><td class="n" id="dpl${i}"></td></tr>`).join('')}
      </tbody></table>
      ${cshField('dpnote', 'Observations', 'text', { size: 50 })}
      ${CS.filesErr ? '' : '<label>Reçu de la banque (photo ou PDF, si déjà disponible) <input type="file" id="dpfile" accept="image/*,application/pdf"></label>'}
      <div id="dptot" class="panel"></div>
      <p><button id="dpsave">Enregistrer le dépôt et télécharger le bordereau</button> <button class="ghost" id="dppdf">Bordereau seul (sans enregistrer)</button></p><div id="dpres"></div></div>
    <div class="panel"><h3>Espèces entrées depuis le dernier dépôt</h3><p class="small">${info.lastDeposit ? 'Dernier dépôt enregistré : ' + fmtDay(info.lastDeposit) : 'Aucun dépôt enregistré avant ce jour.'}</p>
      ${table('tcshdps', [['Jour', r => fmtDay(r.day), r => r.day], ['Uber', r => cshMoney(r.uber), r => r.uber, 'n'], ['Bolt', r => cshMoney(r.bolt), r => r.bolt, 'n'], ['Courses privées', r => cshMoney(r.courses), r => r.courses, 'n'], ['Total', r => '<b>' + cshMoney(r.total) + '</b>', r => r.total, 'n']], info.since, { empty: 'Aucune entrée d\'espèces depuis le dernier dépôt', total: { fmt: x => '<b>' + cshMoney(x) + '</b>' } })}
    </div></div>
    <div class="panel"><h3>Historique des dépôts en banque</h3><p class="small">Un dépôt groupé = une ligne : espèces Uber, Bolt et courses privées réunies en un seul montant déposé. Reçu de la banque : déposez la photo ou le PDF du reçu remis par la banque${CS.filesErr ? ' (migration 20261122000000_justificatifs.sql à exécuter dans Supabase)' : ' ; il est aussi copié dans le Google Drive de l\'agence. ' + cshDriveLink('depot')}.</p>
      ${table('tcshdph', [['Date du dépôt', g => esc(cshDow(g.day)) + ' ' + fmtDay(g.day), g => g.day], ['Bordereau', g => g.ref ? esc(g.ref) : '<span class="small">' + esc(g.note || 'saisi sans bordereau') + '</span>', g => g.ref || ''],
        ['Jours couverts', g => g.days.length ? esc(cshDaysTxt(g.days)) : '<span class="nm">non précisés</span>'], ['Uber', g => cshMoney(g.uber), g => g.uber, 'n'], ['Bolt', g => cshMoney(g.bolt), g => g.bolt, 'n'],
        ['Courses privées', g => cshMoney(g.courses), g => g.courses, 'n'], ['Autres caisses', g => g.other ? cshMoney(g.other) : '', g => g.other, 'n'], ['Montant déposé', g => '<b>' + cshMoney(g.total) + '</b>', g => g.total, 'n'],
        ['Banque', g => esc(g.bank || '')], ['Déposé par', g => esc(g.who || '')],
        ['Reçu de la banque', g => CS.filesErr ? '' : (filesOf(g).length ? cshFileLinks(filesOf(g)) + ' ' + cshUpBtn('depot|' + g.key, '+ fichier') : '<span class="small red">à déposer</span> ' + cshUpBtn('depot|' + g.key)), g => filesOf(g).length]],
        groups, { empty: 'Aucun dépôt enregistré', page: true, total: { fmt: x => '<b>' + cshMoney(x) + '</b>' } })}</div>`);
  if ($('#dpday')) $('#dpday').onchange = () => { location.hash = cshHref('depot', { jour: $('#dpday').value }); };
  const goR = (a, b) => { location.hash = cshHref('depot', { jour: $('#dpday').value || day, dpdu: a, dpau: b }); };
  $('#dpdu').onchange = $('#dpau').onchange = () => goR($('#dpdu').value, $('#dpau').value);
  document.querySelectorAll('[data-dpp]').forEach(b => { b.onclick = () => { const [a, z] = b.dataset.dpp.split('|'); goR(a, z); }; });
  const picked = () => [...document.querySelectorAll('[data-dpd]')].filter(c => c.checked).map(c => c.dataset.dpd);
  const pickDays = () => {   // jours cochés → montants Uber / Bolt / courses privées
    const sum = cshDepositSum(days, picked()), n = picked().length;
    $('#dpdn').textContent = n + ' jour' + (n > 1 ? 's' : '') + ' coché' + (n > 1 ? 's' : '');
    [['uber', 'dpdu_'], ['bolt', 'dpdb_'], ['courses', 'dpdc_'], ['total', 'dpdt_']].forEach(([k, id]) => { $('#' + id).innerHTML = '<b>' + cshMoney(sum[k]) + '</b>'; });
    ['uber', 'bolt', 'courses'].forEach(k => { const a = $(`[data-dpam="${k}"]`), c = $(`[data-dpon="${k}"]`); if (!a || !c) return; a.value = sum[k] > 0 ? sum[k] : ''; c.checked = sum[k] > 0; });
  };
  document.querySelectorAll('[data-dpd]').forEach(c => { c.onchange = () => { pickDays(); show(); }; });
  $('#dpall').onchange = () => { document.querySelectorAll('[data-dpd]:not([disabled])').forEach(c => { c.checked = $('#dpall').checked; }); pickDays(); show(); };
  const read = () => {
    const lines = box.filter(x => $(`[data-dpon="${x[0]}"]`).checked).map(x => ({ caisse: x[0], name: x[1], balance: info.balances[x[0]], amount: cshR(cshN($(`[data-dpam="${x[0]}"]`).value)) })).filter(l => l.amount > 0);
    const counts = CSH_DENOMS.map((d, i) => Math.max(0, Math.floor(cshN($(`[data-dpn="${i}"]`).value))));
    return { day: $('#dpday').value || day, company: $('#dpco').value.trim(), bank: $('#dpbank').value.trim(), account: $('#dpacc').value.trim(), who: $('#dpwho').value.trim(), cin: $('#dpcin').value.trim(),
      note: $('#dpnote').value.trim(), lines, counts, total: cshR(lines.reduce((s, l) => s + l.amount, 0)), bills: cshBillTotal(counts), lastDeposit: info.lastDeposit, since: info.since,
      days: days.filter(r => picked().indexOf(r.day) >= 0) };
  };
  const show = () => { const d = read();
    CSH_DENOMS.forEach((x, i) => { $('#dpl' + i).textContent = d.counts[i] ? cshMoney(cshR(x[0] * d.counts[i])) : ''; });
    const gap = cshR(d.bills - d.total);
    $('#dptot').innerHTML = `<b>Montant déposé : ${cshMoney(d.total)}</b><div class="small">${esc(cshMadWords(d.total))}</div>
      <div class="small ${d.counts.some(Boolean) ? (Math.abs(gap) < 0.005 ? 'ok' : 'red') : ''}">Billetage : ${cshMoney(d.bills)}${d.counts.some(Boolean) ? (Math.abs(gap) < 0.005 ? ' · égal au montant déposé' : ' · écart ' + cshMoney(gap)) : ' (à compter)'}</div>`; };
  document.querySelectorAll('[data-dpon],[data-dpam],[data-dpn]').forEach(e => { e.oninput = show; e.onchange = show; });
  if (days.length) pickDays();
  show();
  const keep = d => lsSet(cshDepKey(), { company: d.company, bank: d.bank, account: d.account, who: d.who, cin: d.cin });
  const check = d => { if (!d.lines.length) return 'Choisir au moins une caisse et un montant à déposer.'; if (d.lines.some(l => l.amount > l.balance + 0.005)) return 'Montant déposé supérieur au solde de la caisse.';
    if (d.counts.some(Boolean) && Math.abs(d.bills - d.total) >= 0.005) return 'Le billetage (' + cshMoney(d.bills) + ') ne correspond pas au montant déposé (' + cshMoney(d.total) + ').'; return ''; };
  $('#dppdf').onclick = () => { const d = read(), e = check(d); if (e) { $('#dpres').innerHTML = msg(esc(e), 'err'); return; } keep(d); d.ref = cshDepRef(d.day, 'projet'); try { cshDepositPdf(d); } catch (x) { alert(x.message); } };
  $('#dpsave').onclick = async () => {
    const d = read(), e = check(d); if (e) { $('#dpres').innerHTML = msg(esc(e), 'err'); return; }
    // jours cochés après la date du dépôt : leurs espèces ne peuvent pas être dans ce dépôt
    const late = d.days.filter(r => r.day > d.day);
    if (late.length) { $('#dpres').innerHTML = msg('Le dépôt du ' + fmtDay(d.day) + ' ne peut pas contenir les espèces du ' + late.map(r => fmtDay(r.day)).join(', ') + ' : décochez ces jours ou changez la date du dépôt.', 'err'); return; }
    const pf0 = $('#dpfile') && $('#dpfile').files[0]; if (pf0) { try { cshFileCheck(pf0); } catch (x) { $('#dpres').innerHTML = msg('Reçu de la banque : ' + esc(x.message), 'err'); return; } }
    if (!(await ask('Enregistrer le dépôt de ' + cshMoney(d.total) + ' du ' + fmtDay(d.day) + ' ? Il sort des caisses choisies.'))) return;
    keep(d); d.ref = cshDepRef(d.day);
    try {
      for (const l of d.lines) await cshInsert({ caisse: l.caisse, kind: 'depot', flow: 'out', amount: l.amount, day: d.day, source: 'Banque', label: CSH_KIND.depot,
        comment: 'Bordereau ' + d.ref + (d.bank ? ' · ' + d.bank : '') + (d.who ? ' · déposé par ' + d.who : '') + (d.days.length ? ' · jours ' + d.days.map(r => r.day).join(',') : '') });
      cshDepositPdf(d);
      let up = '';
      const pf = $('#dpfile') && $('#dpfile').files[0];
      if (pf) { try { await cshFileUpload(pf, { kind: 'depot', ref: d.ref, day: d.day, title: [d.day, d.ref, cshR(d.total) + ' MAD', d.bank].filter(Boolean).join(' - ') }); up = ' Reçu de la banque joint.'; }
        catch (x) { up = ' Le reçu de la banque n\'a pas pu être déposé (' + esc(x.message || x) + ') : le déposer depuis l\'historique.'; } }
      CS.flash = { id: 'dpres', html: msg('Dépôt enregistré (' + esc(d.ref) + ') et bordereau téléchargé : à faire signer et tamponner par la banque.' + up, 'ok') };
      pageCaisse();
    } catch (x) { $('#dpres').innerHTML = msg(esc(x.message), 'err'); }
  };
  cshBindFiles();
  if (CS.flash && $('#' + CS.flash.id)) { $('#' + CS.flash.id).innerHTML = CS.flash.html; CS.flash = null; }
}
/** Jours cochés en texte court : « du lun. 27/10 au dim. 02/11 (7 jours) », sinon la liste */
function cshDaysTxt(l) {
  const a = l.slice().sort(), n = a.length, suite = n > 1 && cshNDays(a[0], a[n - 1]) === n;
  return n === 1 ? cshDow(a[0]) + ' ' + fmtDay(a[0]) : suite ? 'du ' + cshDow(a[0]) + ' ' + fmtDay(a[0]) + ' au ' + cshDow(a[n - 1]) + ' ' + fmtDay(a[n - 1]) + ' (' + n + ' jours)' : a.map(fmtDay).join(', ');
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
    ['Période couverte', d.days && d.days.length ? cshDaysTxt(d.days.map(r => r.day)) : d.lastDeposit ? 'depuis le dépôt du ' + fmtDay(d.lastDeposit) : 'premier dépôt enregistré'], ['Observations', d.note || '']];
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
  if (d.days && d.days.length) {
    if (y > H - 50) { doc.addPage(); y = 24; }
    const sm = cshDepositSum(d.days, d.days.map(r => r.day));
    tab('Jours déposés', ['Jour', 'Uber', 'Bolt', 'Courses privées', 'Total'], d.days.map(r => [cshDow(r.day) + ' ' + fmtDay(r.day), money(r.uber), money(r.bolt), money(r.courses), money(r.total)])
      .concat([['Total (' + d.days.length + ' jours)', money(sm.uber), money(sm.bolt), money(sm.courses), money(sm.total)]]), [1, 2, 3, 4], { total: true });
  } else if (d.since && d.since.length) {
    if (y > H - 50) { doc.addPage(); y = 24; }
    tab('Espèces entrées depuis le dernier dépôt (pour information)', ['Jour', 'Uber', 'Bolt', 'Courses privées', 'Total'], d.since.slice(-14).map(r => [fmtDay(r.day), money(r.uber), money(r.bolt), money(r.courses), money(r.total)]), [1, 2, 3, 4]);
  }
  const np = doc.getNumberOfPages();
  for (let i = 1; i <= np; i++) { doc.setPage(i); font('normal', 7, C.mute); doc.text('Page ' + i + ' / ' + np, W - M, H - 5, { align: 'right' }); }
  doc.setPage(1); font('normal', 7, C.mute);
  doc.text('Document généré par Ludy — à conserver avec le reçu de versement remis par la banque. Le dépôt est enregistré dans la caisse de l\'agence (sortie « Dépôt en banque »).', M, H - 10, { maxWidth: W - 2 * M - 22 });
  doc.save(('bordereau_depot_' + cshFileAg() + '_' + d.day + '_' + d.ref.replace(/[^A-Za-z0-9-]+/g, '_')).replace(/_+/g, '_') + '.pdf');
}

// ---------- Fiche d'encaissement du shift (03/11/2026, demande d'Ahmed) ----------
// Fiche imprimée pour encaisser les chauffeurs dans la rue : chauffeurs du shift (contrats commencés dans le shift, chauffeurs ajoutés,
// encaissements déjà saisis sans contrat), espèces Uber et Bolt connues (exports importés), cases à remplir à la main (remis, monnaie,
// manque, signature) et lignes vides pour les chauffeurs imprévus. La fiche remplie est ensuite déposée dans Ludy (photo ou PDF).
/** Lignes de la fiche : une par chauffeur du shift, espèces Uber / Bolt connues (null = export pas importé ou compte non relié) */
function cshFicheRows(day, s) {
  const win = cshShiftWin(day, s), rows = [];
  CS.ctr.filter(c => c._day === day && c._shift === s && c.client_code).sort((a, b) => String(cshDrvName(a.client_code)).localeCompare(String(cshDrvName(b.client_code))) || a._s - b._s)
    .forEach(c => rows.push({ c, code: c.client_code, name: cshDrvName(c.client_code) }));
  const add = (code, name, uuid) => { const k = code || 'N:' + cshName(name);
    if (rows.some(r => (r.code || 'N:' + cshName(r.name)) === k)) return;
    rows.push({ c: Object.assign({ key: k, extra: true, client_code: code || null, uber_uuid: uuid || null, num: null }, win), code: code || null, name: name || cshDrvName(code), extra: true }); };
  CS.moves.filter(m => cshLive(m) && (m.caisse === 'uber' || m.caisse === 'bolt') && m.kind === 'encaissement' && m.day === day && cshMoveShift(m) === s && !m.contract_num)
    .forEach(m => add(m.driver_code, m.driver_name, m.uber_uuid));
  ['uber', 'bolt'].forEach(pf => (CSH_ADDED[pf + '|' + day + '|' + s] || []).forEach(a => add(a.driver_code, a.driver_name, a.uber_uuid)));
  return rows.map(r => {
    const u = r.code || r.c.uber_uuid ? cshCtrCash('uber', r.c) : { v: null }, b = r.code ? cshCtrCash('bolt', r.c) : { v: null };
    const d = (CS.drivers || []).find(x => x.code === r.code) || {}, v = r.c.vehicle_key ? vehOf(r.c.vehicle_key) : null;
    const done = CS.moves.filter(m => cshLive(m) && (m.caisse === 'uber' || m.caisse === 'bolt') && m.kind === 'encaissement' && m.day === day && cshMoveShift(m) === s &&
      (r.c.num ? m.contract_num === r.c.num : !m.contract_num && (m.driver_code || 'N:' + cshName(m.driver_name)) === (r.code || 'N:' + cshName(r.name))));
    return { name: r.name, phone: d.phone || '', plate: v ? v.plate : '', ctr: r.c.num ? r.c.num + ' · ' + fmtDT(r.c.start_at) : 'sans contrat',
      uber: u.v, uberWhy: u.pending ? 'non importé' : u.v == null ? 'non relié' : '', bolt: b.v, boltWhy: b.pending ? 'non importé' : b.v == null ? 'non relié' : '',
      done: done.length ? cshR(done.reduce((t, m) => t + cshN(m.amount), 0)) : null };
  });
}
/** PDF A4 paysage de la fiche ; renvoie { blob, name } quand asBlob, sinon télécharge */
function cshFichePdf(day, s, asBlob) {
  if (!window.jspdf) throw new Error('bibliothèque PDF non chargée, réessayez dans un instant');
  if (window.applyPlugin && !window.jspdf.jsPDF.API.autoTable) window.applyPlugin(window.jspdf.jsPDF);
  const cl = v => String(v == null ? '' : v).replace(/[  ]/g, ' ').replace(/−/g, '-').replace(/\s*→\s*/g, ' - ');
  const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' }), W = 297, H = 210, M = 10;
  const C = { ink: [20, 32, 43], mute: [93, 107, 120], line: [150, 160, 170], soft: [243, 245, 247], head: [15, 38, 51], acc: [91, 75, 214] };
  const col = (k, c) => doc['set' + k](c[0], c[1], c[2]), font = (st, sz, c) => { doc.setFont('helvetica', st); doc.setFontSize(sz); col('TextColor', c || C.ink); };
  const rows = cshFicheRows(day, s), ref = 'FE-' + (CS.agId || 0) + '-' + day.replace(/-/g, '') + '-' + (s === 'Jour' ? 'J' : 'N');
  const win = cshShiftWin(day, s), money = v => cl(cshMoney(v));
  const head = () => {
    try { doc.addImage(RPT_LOGO, 'PNG', M, 7, 32, 7.8); } catch (e) { }
    font('bold', 8, C.acc); doc.text('CAISSE · FICHE D\'ENCAISSEMENT DU SHIFT', W - M, 10, { align: 'right' });
    font('normal', 7.5, C.mute); doc.text(cl('N° ' + ref + ' · éditée le ' + fmtDTY(new Date().toISOString())), W - M, 14, { align: 'right' });
    font('bold', 14); doc.text(cl('Shift ' + shiftDayName({ s, day }) + (CS.agName ? ' · ' + CS.agName : '')), M, 23);
    font('normal', 8.5, C.mute); doc.text(cl('Du ' + fmtDTY(new Date(win._s).toISOString()) + ' au ' + fmtDTY(new Date(win._e).toISOString()) +
      ' · Espèces Uber / Bolt = espèces collectées pendant le contrat d\'après les exports importés dans Ludy à l\'édition de la fiche'), M, 28);
  };
  head();
  const blank = Math.max(3, 12 - rows.length);   // jusqu'à 12 lignes : fiche et signatures sur une page
  const body = rows.map((r, i) => [String(i + 1), r.name + (r.phone ? '\n' + r.phone : ''), r.plate, r.ctr,
    r.uber != null ? money(r.uber) : r.uberWhy, r.bolt != null ? money(r.bolt) : r.boltWhy,
    r.uber != null || r.bolt != null ? money(cshN(r.uber) + cshN(r.bolt)) : '', r.done != null ? 'déjà saisi : ' + money(r.done) : '', '', '', ''])
    .concat(Array.from({ length: blank }, (x, i) => [String(rows.length + i + 1), '', '', '', '', '', '', '', '', '', '']));
  doc.autoTable({ startY: 32, head: [['N°', 'Chauffeur / téléphone', 'Véhicule', 'Contrat · début', 'Espèces Uber', 'Espèces Bolt', 'À remettre', 'Remis', 'Monnaie rendue', 'Manque', 'Signature du chauffeur'].map(cl)],
    body: body.map(r => r.map(cl)), theme: 'grid', margin: { left: M, right: M, top: 32 },
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.4, textColor: C.ink, lineColor: C.line, lineWidth: 0.2, minCellHeight: 10.5, valign: 'middle' },
    headStyles: { fillColor: C.head, textColor: 255, fontStyle: 'bold', minCellHeight: 7 },
    columnStyles: { 0: { cellWidth: 8, halign: 'center' }, 1: { cellWidth: 46 }, 2: { cellWidth: 22 }, 3: { cellWidth: 30 }, 4: { cellWidth: 21, halign: 'right' }, 5: { cellWidth: 21, halign: 'right' },
      6: { cellWidth: 21, halign: 'right', fontStyle: 'bold' }, 7: { cellWidth: 25, halign: 'right' }, 8: { cellWidth: 22 }, 9: { cellWidth: 20 }, 10: { cellWidth: 41 } },
    didParseCell: x => { if (x.section === 'body' && (x.column.index === 4 || x.column.index === 5) && /non /.test(x.cell.raw)) { x.cell.styles.fontStyle = 'italic'; x.cell.styles.textColor = C.mute; x.cell.styles.fontSize = 7; }
      if (x.section === 'body' && x.column.index === 7 && x.cell.raw) { x.cell.styles.fontSize = 6.8; x.cell.styles.textColor = C.mute; } },
    didDrawPage: d => { if (d.pageNumber > 1) head(); } });
  // totaux et signatures du gestionnaire
  let y = doc.lastAutoTable.finalY + 4; if (y > H - 34) { doc.addPage(); head(); y = 34; }
  const known = rows.filter(r => r.uber != null || r.bolt != null);
  font('bold', 9); doc.text(cl('Total à remettre connu : ' + (known.length ? money(known.reduce((t, r) => t + cshN(r.uber) + cshN(r.bolt), 0)) + ' (' + known.length + ' / ' + rows.length + ' chauffeurs)' : 'exports pas encore importés')), M, y + 3);
  const box = (x, w, label) => { col('DrawColor', C.line); doc.setLineWidth(0.3); doc.rect(x, y + 6, w, 18); font('normal', 7, C.mute); doc.text(cl(label).toUpperCase(), x + 2, y + 9.5); };
  const bw = (W - 2 * M - 12) / 4;
  box(M, bw, 'Total remis (espèces)'); box(M + bw + 4, bw, 'Total des manques'); box(M + 2 * (bw + 4), bw, 'Encaissé par (nom et signature)'); box(M + 3 * (bw + 4), bw, 'Fin de l\'encaissement (date et heure)');
  font('normal', 7, C.mute); doc.text(cl('Une fois l\'encaissement fini : saisir chaque ligne dans Ludy (Caisse > Encaissement du shift) et déposer la photo de cette fiche sur la même page.'), M, H - 6);
  const n = doc.internal.getNumberOfPages(); for (let i = 1; i <= n; i++) { doc.setPage(i); font('normal', 7, C.mute); doc.text('Page ' + i + ' / ' + n, W - M, H - 6, { align: 'right' }); }
  const name = 'Fiche_encaissement_' + day + '_' + s + '.pdf';
  if (asBlob) return { blob: doc.output('blob'), name, rows };
  doc.save(name); return { name, rows };
}
/** Fiches remplies déposées pour ce shift : liste, dépôt (photo ou PDF), lien signé */
async function cshFicheBox(day, s) {
  const el = $('#cshfiches'); if (!el) return;
  const q = sb.from('cash_sheets').select('id,day,shift,path,file_name,created_by,created_at').eq('day', day).eq('shift', s).order('created_at');
  const { data, error } = await (CS.agId ? q.eq('agency_id', CS.agId) : q.is('agency_id', null));
  if (!$('#cshfiches')) return;
  if (error) { el.innerHTML = /cash_sheets|relation|schema cache/i.test(error.message) ? msg('Dépôt des fiches : migration 20261121000000_fiche_encaissement.sql à exécuter dans Supabase.', 'warn') : msg(esc(error.message), 'err'); return; }
  el.innerHTML = (data || []).length ? `<ul class="small">${data.map(f => `<li>${esc(f.file_name || f.path.split('/').pop())} · déposée le ${esc(fmtDTY(f.created_at))} · <a href="#" data-cshfo="${esc(f.path)}">voir</a>${isAdmin() ? ` · <a href="#" data-cshfd="${f.id}">retirer</a>` : ''}</li>`).join('')}</ul>`
    : '<p class="small">Aucune fiche déposée pour ce shift.</p>';
  el.querySelectorAll('[data-cshfo]').forEach(a => { a.onclick = async e => { e.preventDefault();
    const r = await sb.storage.from('caisse').createSignedUrl(a.dataset.cshfo, 3600); if (r.error) { alert(r.error.message); return; } openOut(r.data.signedUrl); }; });
  el.querySelectorAll('[data-cshfd]').forEach(a => { a.onclick = async e => { e.preventDefault();
    if (!await ask('Retirer cette fiche déposée ?')) return; const { error: er } = await sb.from('cash_sheets').delete().eq('id', +a.dataset.cshfd); if (er) alert(er.message); else cshFicheBox(day, s); }; });
}
async function cshFicheUpload(day, s, file) {
  if (!file) return;
  if (!/^(image\/|application\/pdf)/.test(file.type || '')) throw new Error('photo (JPG, PNG…) ou PDF seulement');
  if (file.size > 15 * 1024 * 1024) throw new Error('fichier trop lourd (15 Mo au plus)');
  const ext = (String(file.name || '').match(/\.([a-z0-9]{2,5})$/i) || [, (file.type.split('/')[1] || 'bin')])[1].toLowerCase();
  const path = (CS.agId || 0) + '/fiches/' + day + '_' + s + '_' + Date.now() + '.' + ext;
  const up = await sb.storage.from('caisse').upload(path, file, { contentType: file.type, upsert: false }); if (up.error) throw up.error;
  const { error } = await sb.from('cash_sheets').insert({ agency_id: CS.agId || null, day, shift: s, path, file_name: file.name || null }); if (error) throw error;
}

// ---------- Justificatifs des dépenses et reçus de la banque (04/11/2026, demande d'Ahmed) ----------
// Fichier (photo ou PDF) déposé dans le seau privé « caisse » (<agence>/justificatifs/… ou <agence>/depots/…) et noté dans cash_files ;
// le collecteur le copie ensuite dans le Google Drive de l'agence : « Justificatifs agence … » (un sous-dossier par catégorie de dépense)
// et « Dépôts banque agence … ».
const CSH_FILE_MAX = 15 * 1024 * 1024;
function cshFileExt(f) { return (String((f && f.name) || '').match(/\.([a-z0-9]{2,5})$/i) || [, String((f && f.type) || '').split('/')[1] || 'bin'])[1].toLowerCase().replace('jpeg', 'jpg'); }
function cshFileCheck(f) {
  if (!f) throw new Error('aucun fichier choisi');
  if (!/^(image\/|application\/pdf)/.test(f.type || '')) throw new Error('photo (JPG, PNG…) ou PDF seulement');
  if (f.size > CSH_FILE_MAX) throw new Error('fichier trop lourd (15 Mo au plus)');
}
/** Dépôt d'un fichier : meta = { kind: 'justif', move } ou { kind: 'depot', ref, day, title } */
/**
 * Photo d'un justificatif (appareil photo du téléphone : 3 à 10 Mo) réduite avant le dépôt : 2000 px au plus, JPEG qualité 0,85 (lisible,
 * ~0,5 Mo). PDF, petite image ou photo illisible par le navigateur : fichier d'origine.
 */
async function cshImgSmall(file, max) {
  max = max || 2000;
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type || '') || file.size < 600 * 1024 || typeof createImageBitmap !== 'function') return file;
  try {
    const bm = await createImageBitmap(file), k = Math.min(1, max / Math.max(bm.width, bm.height)), w = Math.round(bm.width * k), h = Math.round(bm.height * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(bm, 0, 0, w, h); if (bm.close) bm.close();
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], String(file.name || 'justificatif').replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (e) { return file; }
}
async function cshFileUpload(file, meta) {
  cshFileCheck(file);
  file = await cshImgSmall(file);
  const ag = CS.agId || 0, key = meta.kind === 'justif' ? 'm' + meta.move.id : String(meta.ref).replace(/[^\w-]+/g, '_');
  const path = ag + '/' + (meta.kind === 'justif' ? 'justificatifs' : 'depots') + '/' + key + '_' + Date.now() + '.' + cshFileExt(file);
  const up = await sb.storage.from('caisse').upload(path, file, { contentType: file.type, upsert: false }); if (up.error) throw up.error;
  const m = meta.move, row = meta.kind === 'justif'
    ? { kind: 'justif', move_id: m.id, day: m.day, category: m.label || 'Autre', title: [m.day, m.driver_code ? cshDrvName(m.driver_code) : m.driver_name || 'sans chauffeur', cshR(m.amount) + ' MAD', m.label || 'Dépense', 'n°' + m.id].join(' - ') }
    : { kind: 'depot', dep_ref: meta.ref, day: meta.day, title: meta.title };
  const { error } = await sb.from('cash_files').insert(Object.assign(row, { agency_id: CS.agId || null, path, file_name: file.name || null })); if (error) throw error;
}
/** Liens des fichiers joints (ouverts par un lien signé d'une heure) */
function cshFileLinks(list) {
  return (list || []).map(f => `<a href="#" class="small" data-cshfo="${esc(f.path)}" title="Déposé le ${esc(fmtDTY(f.created_at))}${f.drive_id ? ' · copié dans le Drive' : ''}">📎 ${esc(f.file_name || 'fichier')}</a>${f.drive_id ? ' <span class="small ok" title="Copié dans le Google Drive de l\'agence">Drive ✓</span>' : ''}`).join('<br>');
}
/** Bouton « Déposer » (choix d'un fichier) : data-cshup = « justif|<id dépense> » ou « depot|<référence> » */
function cshUpBtn(v, label) { return `<label class="btn ghost small cshup">${label || 'Déposer'}<input type="file" accept="image/*,application/pdf" data-cshup="${esc(v)}" hidden></label>`; }
function cshDriveLink(kind) {
  let o = {}; try { o = JSON.parse(String((S.P || {}).cashDrive || '{}')) || {}; } catch (e) { o = {}; }
  const id = (o[CS.agId || 0] || {})[kind];
  return id ? `<a class="small" href="https://drive.google.com/drive/folders/${encodeURIComponent(id)}" target="_blank" rel="noopener">${kind === 'justif' ? 'Dossier Google Drive des justificatifs' : 'Dossier Google Drive des dépôts'} ↗</a>`
    : '<span class="small">Dossier Google Drive : créé par le collecteur au prochain passage (5 min).</span>';
}
function cshBindFiles(onDone) {
  document.querySelectorAll('[data-cshfo]').forEach(a => { a.onclick = async e => { e.preventDefault();
    const r = await sb.storage.from('caisse').createSignedUrl(a.dataset.cshfo, 3600); if (r.error) { alert(r.error.message); return; } openOut(r.data.signedUrl); }; });
  document.querySelectorAll('[data-cshup]').forEach(i => { i.onchange = async () => {
    const [kind, k] = i.dataset.cshup.split('|'), f = i.files[0]; if (!f) return;
    try {
      if (kind === 'justif') {
        const m = CS.moves.find(x => x.id === +k); if (!m) throw new Error('dépense introuvable');
        await cshFileUpload(f, { kind, move: m });
        if (!m.justif || m.justif === 'En attente') await cshPatch(m.id, { justif: 'OK' });   // justificatif fourni
      } else {
        const g = cshDepGroups(CS.all).find(x => x.key === k); if (!g) throw new Error('dépôt introuvable');
        await cshFileUpload(f, { kind, ref: g.key, day: g.day, title: [g.day, g.ref || 'Dépôt', cshR(g.total) + ' MAD', g.bank].filter(Boolean).join(' - ') });
      }
      (onDone || pageCaisse)();
    } catch (e) { alert('Dépôt du fichier : ' + (e.message || e)); i.value = ''; }
  }; });
}
