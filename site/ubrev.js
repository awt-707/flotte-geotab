// Revenus Uber par shift (21/11/2026, demande d'Ahmed : « consulter les chiffres des shifts, les stocker sur une semaine et voir
// l'évolution jour après jour dans un diagramme »). Page #/ubrev.
// Une ligne par contrat Ludy : chiffres d'Uber du compte du chauffeur du début à la fin de son contrat (uber_perf « ctr:<n° de contrat> »,
// lus par l'application Ludy, gardés 62 jours) ; shift = heure de prise du contrat (shiftOfCtr). Contrat sans compte Uber trouvé ou
// pas encore lu : compté à part (« sans chiffres »), jamais estimé.

const UBR = { days: 7, open: '' };
/** Totaux par shift (clé « jour:Jour|Nuit ») d'une liste de contrats { num, start_at, _k } et des lignes uber_perf par période */
function ubrAgg(ctrs, perf) {
  const m = {};
  ctrs.forEach(c => {
    const g = m[c._k] || (m[c._k] = { key: c._k, n: 0, got: 0, e: 0, cash: 0, t: 0, h: 0, list: [] });
    const r = perf['ctr:' + c.num], d = r && r.data;
    g.n++; g.list.push(c);
    if (d) { g.got++; g.e += d.e || 0; g.cash += d.cash || 0; g.t += d.t || 0; g.h += d.h || 0; }
  });
  return m;
}
async function pageUbRev() {
  const rid = ROUTING;
  await loadRef();
  if (rid !== ROUTING) return;
  $('#page').innerHTML = '<div class="head"><h1>Revenus Uber par shift</h1></div><div class="empty">Chargement des contrats et des chiffres d\'Uber…</div>';
  const now = Date.now(), days = UBR.days, from = new Date(now - (days + 1) * DAY).toISOString();
  let ctrs = [], perf = {};
  try {
    const cs = await all('contracts', 'num,name,vehicle_key,plate,start_at,end_at', q => q.gt('start_at', from).lte('start_at', new Date(now + HOUR).toISOString()).not('vehicle_key', 'is', null));
    const byV = {}; cs.forEach(c => { (byV[c.vehicle_key] = byV[c.vehicle_key] || []).push(c); });
    const ok = typeof inAgency === 'function' ? inAgency() : () => true;
    ctrs = [].concat(...Object.values(byV).map(l => ctrEffEnds(l, now))).filter(c => ok(c.vehicle_key));
    ctrs.forEach(c => { c._sh = shiftOfCtr(c.start_at, S.P); c._k = c._sh.day + ':' + c._sh.s; });
    for (let i = 0; i < ctrs.length; i += 80) {
      const r = await sb.from('uber_perf').select('driver_id,driver_name,period,data,updated_at').in('period', ctrs.slice(i, i + 80).map(c => 'ctr:' + c.num));
      if (r.error) throw r.error;
      (r.data || []).forEach(x => { perf[x.period] = x; });
    }
  } catch (e) { if (rid === ROUTING) $('#page').innerHTML = '<div class="head"><h1>Revenus Uber par shift</h1></div>' + msg('Erreur : ' + esc(e.message || e), 'err'); return; }
  if (rid !== ROUTING) return;
  const first = localDay(new Date(now - (days - 1) * DAY)), today = localDay(new Date(now)), dayList = [];
  for (let d = first; d <= today; d = addDays(d, 1)) dayList.push(d);
  const agg = ubrAgg(ctrs.filter(c => c._sh.day >= first), perf), G = (d, s) => agg[d + ':' + s] || { key: d + ':' + s, n: 0, got: 0, e: 0, cash: 0, t: 0, h: 0, list: [] };
  const cur = shiftOfCtr(new Date(), S.P), curK = cur.day + ':' + cur.s;
  const M = v => f0(v) + ' MAD', dn = d => ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + d.slice(8, 10) + '/' + d.slice(5, 7);
  const tot = l => l.reduce((a, g) => ({ n: a.n + g.n, got: a.got + g.got, e: a.e + g.e, cash: a.cash + g.cash, t: a.t + g.t }), { n: 0, got: 0, e: 0, cash: 0, t: 0 });
  const all7 = tot(dayList.map(d => G(d, 'Jour')).concat(dayList.map(d => G(d, 'Nuit'))));
  const chart = cshSvg(dayList.map(dn), [{ name: 'Shift jour', cls: 'ub-jour', values: dayList.map(d => G(d, 'Jour').e) }, { name: 'Shift nuit', cls: 'ub-nuit', values: dayList.map(d => G(d, 'Nuit').e) },
    { name: 'Total de la journée', cls: 'cs-prev', type: 'line', values: dayList.map(d => G(d, 'Jour').e + G(d, 'Nuit').e) }], { group: true, label: 'Revenus Uber par shift', h: 240 });
  const ev = (a, b) => b > 0 ? `<span class="${a >= b ? 'ok' : 'bad'}">${a >= b ? '+' : '−'}${f0(Math.abs(a - b) / b * 100)} %</span>` : '';
  const cell = (g, prev) => { const inc = g.n && g.got < g.n, live = g.key === curK;
    return `<td class="n"><b>${g.n ? M(g.e) : ''}</b>${inc ? `<div class="small nm">${f0(g.n - g.got)} contrat(s) sans chiffres</div>` : ''}${live ? '<div class="small">en cours</div>' : ''}</td>
      <td class="n">${g.n ? M(g.cash) : ''}</td><td class="n">${g.n ? f0(g.n) : ''}</td><td class="n">${g.got ? M(g.e / g.got) : ''}</td><td class="n">${g.n && prev && prev.n && !inc && prev.got === prev.n && !live ? ev(g.e, prev.e) : ''}</td>`; };
  const draw = () => {
  const rows = dayList.slice().reverse().map(d => {
    const j = G(d, 'Jour'), n = G(d, 'Nuit'), pj = G(addDays(d, -1), 'Jour'), pn = G(addDays(d, -1), 'Nuit'), op = UBR.open === d;
    return `<tr class="ubdrv${op ? ' open' : ''}" data-ubr="${d}"><td><span class="ubcar">${op ? '▾' : '▸'}</span> ${esc(dn(d))}</td>${cell(j, pj)}${cell(n, pn)}<td class="n"><b>${j.n + n.n ? M(j.e + n.e) : ''}</b></td></tr>
      ${op ? `<tr class="ubdet"><td colspan="12">${ubrDetail(j, perf, now)}${ubrDetail(n, perf, now)}</td></tr>` : ''}`;
  }).join('');
  $('#page').innerHTML = `<div class="head"><h1>Revenus Uber par shift</h1><span class="small">${esc(agFilter() ? (S.agName || {})[agFilter()] || '' : 'Toutes les agences')}</span></div>
    <div class="znbar"><label>Période <select id="ubrd">${[7, 14, 30].map(x => `<option value="${x}"${x === days ? ' selected' : ''}>${x} derniers jours</option>`).join('')}</select></label>
      <button class="btn small" id="ubrpdf">PDF</button></div>
    <p class="small">Chaque chauffeur : chiffres d'Uber de son compte du début de son contrat Ludy à sa fin, quelle que soit la journée d'Uber ; shift = heure de prise du contrat (règle des Réglages). Chiffres lus par l'application Ludy (robot Uber Fleet) et gardés 62 jours ; historique disponible depuis le 20/11/2026 (avant : compte Uber des contrats inconnu).</p>
    <div class="cards">${[['Revenus Uber', M(all7.e)], ['dont espèces', M(all7.cash)], ['Contrats', f0(all7.n) + (all7.n > all7.got ? ' · ' + f0(all7.n - all7.got) + ' sans chiffres' : '')], ['Moyenne par contrat', all7.got ? M(all7.e / all7.got) : 'non mesuré'], ['Courses Uber', f0(all7.t)]]
      .map(x => `<div class="card"><div class="cv">${x[1]}</div><div class="cl">${esc(x[0])}</div></div>`).join('')}</div>
    <div class="panel"><h3>Évolution jour après jour</h3>${chart}</div>
    <div class="tblwrap"><table class="tbl" id="tubrev"><thead><tr><th rowspan="2">Jour</th><th colspan="5">Shift jour</th><th colspan="5">Shift nuit (commence le soir de ce jour)</th><th rowspan="2" class="n">Total</th></tr>
      <tr><th class="n">Revenus</th><th class="n">dont espèces</th><th class="n">Contrats</th><th class="n">Par contrat</th><th class="n">vs veille</th><th class="n">Revenus</th><th class="n">dont espèces</th><th class="n">Contrats</th><th class="n">Par contrat</th><th class="n">vs veille</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  $('#ubrd').onchange = e => { UBR.days = +e.target.value; pageUbRev(); };
  $('#tubrev').addEventListener('click', e => { const t = e.target.closest('[data-ubr]'); if (!t) return; UBR.open = UBR.open === t.dataset.ubr ? '' : t.dataset.ubr; draw(); });
  $('#ubrpdf').onclick = () => { try { reportPdf(ubrReport(dayList, G, perf, all7, days)); } catch (e) { alert('PDF impossible : ' + e.message); } };
  };
  draw();
}
/** Détail d'un shift : un contrat par ligne */
function ubrDetail(g, perf, now) {
  if (!g.n) return '';
  const l = g.list.slice().sort((a, b) => ((perf['ctr:' + b.num] || {}).data || {}).e - ((perf['ctr:' + a.num] || {}).data || {}).e);
  return `<h4>${esc(shiftDayName({ day: g.key.slice(0, 10), s: g.key.slice(11) }))}</h4><table class="tbl small"><thead><tr><th>Chauffeur (contrat)</th><th>Véhicule</th><th>Contrat</th><th class="n">Revenus</th><th class="n">dont espèces</th><th class="n">Courses</th><th class="n">En ligne</th></tr></thead><tbody>${l.map(c => {
    const d = (perf['ctr:' + c.num] || {}).data, end = c._end && c._end < now ? c._end : null;
    return `<tr><td>${esc(c.name || '')} <span class="small">${esc(c.num)}</span></td><td>${plate(c.plate || c.vehicle_key)}</td><td class="small">${esc(localHM(new Date(c.start_at)))} → ${end ? esc(localHM(new Date(end))) : 'en cours'}</td>
      <td class="n">${d ? f0(d.e || 0) + ' MAD' : '<span class="nm">non mesuré</span>'}</td><td class="n">${d && d.cash != null ? f0(d.cash) + ' MAD' : ''}</td><td class="n">${d && d.t != null ? f0(d.t) : ''}</td><td class="n">${d && d.h != null ? Math.floor(d.h) + ' h ' + String(Math.round((d.h % 1) * 60)).padStart(2, '0') : ''}</td></tr>`; }).join('')}</tbody></table>`;
}
/** PDF : résumé, graphique, tableau par jour et par shift */
function ubrReport(dayList, G, perf, all7, days) {
  const M = v => rptFmt(v, 0) + ' MAD', dn = d => d.slice(8, 10) + '/' + d.slice(5, 7);
  return { kind: 'caisse', title: 'Revenus Uber par shift', agency: agFilter() ? (S.agName || {})[agFilter()] || 'Agence' : 'Toutes les agences', period: days + ' derniers jours (du ' + dn(dayList[0]) + ' au ' + dn(dayList[dayList.length - 1]) + ')',
    generatedAt: new Date().toISOString(), fileName: 'revenus_uber_shifts_' + dayList[0] + '_' + dayList[dayList.length - 1],
    footer: 'Ludy · chiffres d\'Uber du compte de chaque chauffeur du début à la fin de son contrat ; shift = heure de prise du contrat. Contrat sans chiffres : non compté, jamais estimé.',
    summary: [['Revenus Uber', M(all7.e)], ['dont espèces', M(all7.cash)], ['Contrats', rptFmt(all7.n, 0) + (all7.n > all7.got ? ' (' + rptFmt(all7.n - all7.got, 0) + ' sans chiffres)' : '')], ['Moyenne par contrat', all7.got ? M(all7.e / all7.got) : RPT_NM]],
    tables: [
      { title: 'Évolution jour après jour', chart: { type: 'group', labels: dayList.map(dn), series: [{ name: 'Shift jour', color: [217, 119, 6], values: dayList.map(d => G(d, 'Jour').e) }, { name: 'Shift nuit', color: [30, 41, 59], values: dayList.map(d => G(d, 'Nuit').e) }] } },
      { title: 'Par jour et par shift', num: [1, 2, 3, 4, 5, 6, 7], head: ['Jour', 'Jour : revenus', 'Jour : espèces', 'Jour : contrats', 'Nuit : revenus', 'Nuit : espèces', 'Nuit : contrats', 'Total'],
        rows: dayList.map(d => { const j = G(d, 'Jour'), n = G(d, 'Nuit'), c = g => rptFmt(g.n, 0) + (g.got < g.n ? ' (' + rptFmt(g.n - g.got, 0) + ' sans chiffres)' : '');
          return [dn(d), M(j.e), M(j.cash), c(j), M(n.e), M(n.cash), c(n), M(j.e + n.e)]; }) }] };
}
