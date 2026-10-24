// Planning des chauffeurs (page #/plan) : par agence, chaque véhicule actif en shift jour et shift nuit, 7 jours sur 7 ; chaque
// chauffeur a 2 jours de repos. Semaine générée automatiquement (chauffeur habituel, sinon remplaçant), modifiable case par case
// (case verrouillée), absences remplacées sans toucher au reste, partage de la semaine et de la veille de shift (WhatsApp, PDF),
// planning individuel de chaque chauffeur sur WhatsApp. Calculs : plan_calc.js. Droits : base (plan_can_edit, plan_save).

const PL = { ag: null, monday: '', cells: [], drivers: [], roster: {}, abs: [], absent: {}, week: null, can: false, prevNight: [], real: {}, users: null, sendIdx: 0 };
const PL_TABS = [['semaine', 'Semaine'], ['veille', 'Veille de shift'], ['chauffeurs', 'Chauffeurs et repos'], ['absences', 'Absences'], ['historique', 'Historique']];
const PL_WD = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

function plAgency() {
  const l = S.agencies || [], q = qs();
  if (!l.length) return null;
  if (l.length === 1) return l[0];
  let a = q.get('a') || ''; if (!a) { try { a = localStorage.getItem('planAg') || ''; } catch (e) { } }
  return l.find(x => String(x.id) === a) || l.find(x => String(x.id) === agFilter()) || l[0];
}
function plHref(t, extra) { const o = Object.assign({ t, a: PL.ag ? PL.ag.id : '', w: PL.monday }, extra || {}); return '#/plan?' + Object.keys(o).filter(k => o[k] !== '' && o[k] != null).map(k => k + '=' + encodeURIComponent(o[k])).join('&'); }
function plVehicles() { return S.vehList.filter(v => v.active === 'OUI' && (!PL.ag || String(v.agency_id) === String(PL.ag.id))).sort((a, b) => String(a.plate || a.key).localeCompare(String(b.plate || b.key))); }
function plPlate(k) { const v = S.veh[k]; return v ? (v.plate || k) + (v.model ? ' · ' + v.model : '') : k; }
function plName(c) { const d = PL.drivers.find(x => x.code === c); return d ? d.name || c : (S.drv && S.drv[c]) || c; }
function plCtx() {
  const names = {}, plates = {}, phones = {}, off = {};
  PL.drivers.forEach(d => { names[d.code] = d.name || d.code; phones[d.code] = d.phone || ''; off[d.code] = d.off || []; });
  S.vehList.forEach(v => { plates[v.key] = v.plate || v.key; });
  return { monday: PL.monday, cells: PL.cells, names, plates, phones, off, absent: PL.absent, P: S.P, agency: PL.ag ? PL.ag.name : '' };
}
/** Absences → { code: { jour: true } } */
function plAbsentMap(abs) { const m = {}; abs.forEach(a => { for (let d = a.day_from; d <= a.day_to; d = planAddDays(d, 1)) { (m[a.driver_code] = m[a.driver_code] || {})[d] = a.reason || 'absent'; } }); return m; }

async function plLoad() {
  const ag = PL.ag ? PL.ag.id : null, from = PL.monday, to = planAddDays(from, 6), A = q => ag ? q.eq('agency_id', ag) : q;
  const [drv, roster, cells, prev, abs, weeks, ctr] = await Promise.all([
    all('drivers', 'code,name,phone,status,agency_id,last_contract', q => ag ? q.eq('agency_id', ag) : q, ['name']),
    all('driver_roster', '*', A, ['driver_code']),
    all('driver_plan', 'day,shift,vehicle_key,driver_code,locked,note', q => A(q).gte('day', from).lte('day', to), ['day']),
    all('driver_plan', 'driver_code', q => A(q).eq('day', planAddDays(from, -1)).eq('shift', 'Nuit'), ['day']),
    all('driver_absences', '*', q => A(q).lte('day_from', to).gte('day_to', from), ['day_from']),
    all('plan_weeks', '*', q => A(q).eq('week', from), ['week']),
    all('contracts', 'num,client_code,vehicle_key,start_at,end_at', q => q.gte('start_at', dayBounds(planAddDays(from, -1)).start.toISOString()).lt('start_at', dayBounds(planAddDays(to, 1)).end.toISOString()), ['start_at'])]);
  PL.roster = {}; roster.forEach(r => { PL.roster[r.driver_code] = r; });
  const recent = addDays(today(), -45);
  PL.drivers = drv.map(d => { const r = PL.roster[d.code] || {};
    return { code: d.code, name: d.name, phone: d.phone, shift: r.shift || '', vehicle: r.vehicle_key || '', off: r.off_days || [], active: r.left_at ? false : r.driver_code ? r.active : !!(d.last_contract && d.last_contract >= recent) || d.status === 'NOUVEAU',
      inRoster: !!r.driver_code, note: r.note || '', left: r.left_at || '', leftReason: r.left_reason || '', replacedBy: r.replaced_by || '' }; });
  PL.cells = cells.map(c => ({ day: c.day, shift: c.shift, vehicle_key: c.vehicle_key, driver_code: c.driver_code, locked: c.locked, note: c.note }));
  PL.prevNight = prev.map(x => x.driver_code).filter(Boolean);
  PL.abs = abs; PL.absent = plAbsentMap(abs); PL.week = weeks[0] || null;
  // réel : chauffeur du contrat commencé dans le shift sur le véhicule
  PL.real = {}; ctr.forEach(c => { const sh = shiftOfCtr(c.start_at, S.P); if (sh && c.client_code) PL.real[sh.day + '|' + sh.s + '|' + c.vehicle_key] = c.client_code; });
  try { PL.can = await rpc('plan_can_edit', { p_agency: ag, p_week: from }); } catch (e) { PL.can = false; }
}
async function plSave(cells, note) {
  const r = await rpc('plan_save', { p_agency: PL.ag ? PL.ag.id : null, p_from: PL.monday, p_to: planAddDays(PL.monday, 6), p_cells: cells, p_note: note || null });
  PL.cells = cells; return r;
}
/** Cases de la semaine complétées par le générateur ; keep = cases gardées telles quelles (verrouillées ou assignées à garder) */
function plGenerate(keep) {
  const g = planWeek({ days: planWeekDays(PL.monday), vehicles: plVehicles(), drivers: PL.drivers, absent: PL.absent, locked: keep, prevNight: PL.prevNight });
  const lk = {}; PL.cells.forEach(c => { lk[c.day + '|' + c.shift + '|' + c.vehicle_key] = c; });
  return g.cells.map(c => { const o = lk[c.day + '|' + c.shift + '|' + c.vehicle_key]; return Object.assign(c, { locked: o && c.locked ? !!o.locked : false, note: o ? o.note : null }); });
}

async function pagePlan() {
  const my = ROUTING, q = qs(), t = PL_TABS.some(x => x[0] === q.get('t')) ? q.get('t') : 'semaine';
  const head = `<div class="head"><h1>Planning chauffeurs</h1><div class="sub">Chaque véhicule en shift jour et shift nuit, 7 jours sur 7 ; deux jours de repos par chauffeur. Semaine générée automatiquement, modifiable, absences remplacées, partage aux chauffeurs (WhatsApp, PDF).</div></div>`;
  PL.ag = plAgency();
  if (!PL.ag) { $('#page').innerHTML = head + msg('Aucune agence : créez-en une dans <a href="#/agences">Agences</a> et rattachez-lui ses véhicules.', 'warn'); return; }
  try { localStorage.setItem('planAg', String(PL.ag.id)); } catch (e) { }
  const cur = shiftAt(new Date(), S.P) || { day: today() };
  PL.monday = planMonday(/^\d{4}-\d{2}-\d{2}$/.test(q.get('w') || '') ? q.get('w') : cur.day);
  $('#page').innerHTML = head + '<div class="loading">Chargement du planning…</div>';
  try { await plLoad(); }
  catch (e) {
    if (my !== ROUTING) return;
    $('#page').innerHTML = head + msg(/driver_plan|driver_roster|plan_|does not exist|schema cache/i.test(e.message) ? 'Planning pas encore installé : exécuter <b>supabase/migrations/20261106000000_planning_chauffeurs.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message) + ')' : 'Lecture impossible : ' + esc(e.message), 'err');
    return;
  }
  if (my !== ROUTING) return;
  const agSel = S.agencies.length > 1 ? `<label>Agence <select id="plag">${S.agencies.map(a => `<option value="${a.id}" ${a.id === PL.ag.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : `<b>${esc(PL.ag.name)}</b>`;
  const days = planWeekDays(PL.monday);
  const bar = `<div class="bar">${agSel}<a class="btn small ghostb" href="${plHref(t, { w: planAddDays(PL.monday, -7) })}">← Semaine précédente</a><b>Semaine du ${fmtDay(days[0])} au ${fmtDay(days[6])}</b>
    <a class="btn small ghostb" href="${plHref(t, { w: planAddDays(PL.monday, 7) })}">Semaine suivante →</a>${PL.monday !== planMonday(cur.day) ? `<a class="small" href="${plHref(t, { w: planMonday(cur.day) })}">cette semaine</a>` : ''}
    ${PL.week && PL.week.published_at ? `<span class="badge ok">publiée le ${esc(fmtDTY(PL.week.published_at))}</span>` : '<span class="badge">non publiée</span>'}${PL.week && PL.week.locked ? '<span class="badge crit">verrouillée</span>' : ''}${PL.can ? '' : '<span class="small">lecture seule</span>'}</div>`;
  const tabs = `<div class="tabs">${PL_TABS.map(x => `<a href="${plHref(x[0])}" class="${t === x[0] ? 'on' : ''}">${x[1]}</a>`).join('')}</div>`;
  $('#page').innerHTML = head + bar + tabs + '<div id="plbody"></div>' + `<datalist id="plandrv">${PL.drivers.filter(d => d.active).map(d => `<option value="${esc(d.name || d.code)}"></option>`).join('')}</datalist>`;
  if ($('#plag')) $('#plag').onchange = () => { location.hash = '#/plan?t=' + t + '&a=' + $('#plag').value + '&w=' + PL.monday; };
  ({ semaine: plTabWeek, veille: plTabEve, chauffeurs: plTabDrivers, absences: plTabAbs, historique: plTabLog })[t]();
  window.__rerender = () => pagePlan();
}
function plBody(h) { const b = $('#plbody'); if (b) b.innerHTML = h; }
function plWa(phone, text) { const n = manifWa(phone); return 'https://wa.me/' + n + '?text=' + encodeURIComponent(text); }

// ---------- Semaine ----------
function plTabWeek() {
  const days = planWeekDays(PL.monday), veh = plVehicles(), q = qs(), f = (q.get('f') || '').toLowerCase(), only = q.get('s') || '';
  const by = {}; PL.cells.forEach(c => { by[c.day + '|' + c.shift + '|' + c.vehicle_key] = c; });
  const warn = planCheck(PL.cells, PL.drivers, PL.absent, PL.prevNight), act = PL.drivers.filter(d => d.active), need = planNeed(veh.length);
  const unf = PL.cells.filter(c => !c.driver_code).length + Math.max(0, veh.length * 14 - PL.cells.length), nWarn = Object.keys(warn).filter(k => warn[k].some(w => w !== 'non couvert')).length;
  const cnt = {}; PL.cells.forEach(c => { if (c.driver_code) cnt[c.driver_code] = (cnt[c.driver_code] || 0) + 1; });
  const rows = [];
  veh.forEach(v => PLAN_SHIFTS.forEach(s => {
    if (only && only !== s) return;
    const names = days.map(d => { const c = by[d + '|' + s + '|' + v.key]; return c && c.driver_code ? plName(c.driver_code) : ''; });
    if (f && (v.plate || v.key).toLowerCase().indexOf(f) < 0 && !names.some(n => n.toLowerCase().indexOf(f) >= 0)) return;
    rows.push(`<tr><th class="plv">${esc(v.plate || v.key)}<span class="small">${esc(v.model || '')}</span></th><td class="pls ${s === 'Jour' ? 'plj' : 'pln'}">${s === 'Jour' ? '☀️' : '🌙'} ${s}</td>${days.map((d, i) => {
      const k = d + '|' + s + '|' + v.key, c = by[k], w = warn[k] || (c ? [] : ['non couvert']), real = PL.real[k], code = c && c.driver_code;
      const cls = !code ? 'plempty' : w.length ? 'plwarn' : '', title = w.join(', ') + (real && real !== code ? (w.length ? ' · ' : '') + 'contrat réel : ' + plName(real) : '');
      const val = code ? esc(plName(code)) : '';
      return `<td class="plc ${cls}" title="${esc(title)}">${PL.can ? `<input list="plandrv" data-k="${esc(k)}" value="${val}" placeholder="—">` : (val || '—')}${c && c.locked ? '<span class="pllock" title="modifié à la main : gardé par la génération">●</span>' : ''}${real && real !== code ? `<div class="small plreal">réel : ${esc(plName(real))}</div>` : ''}</td>`; }).join('')}</tr>`);
  }));
  const offTxt = d => (d.off || []).map(w => PL_WD[w - 1]).join(' ') || '—';
  const drows = act.concat(PL.drivers.filter(d => !d.active && cnt[d.code])).map(d => ({ d, n: cnt[d.code] || 0, nights: PL.cells.filter(c => c.driver_code === d.code && c.shift === 'Nuit').length }));
  plBody(cards([['Véhicules', f0(veh.length) + ' <span class="small">× 2 shifts × 7 j</span>'], ['Chauffeurs actifs', f0(act.length) + ` <span class="small">besoin ${need}</span>`, act.length < need ? 'warn' : 'ok'],
      ['Cases non couvertes', f0(unf), unf ? 'crit' : 'ok'], ['Cases à vérifier', f0(nWarn), nWarn ? 'warn' : 'ok']]) +
    `<div class="bar">${PL.can ? `<button id="plgen">Générer / compléter la semaine</button><button class="ghost" id="plcopy">Reprendre la semaine précédente</button><button class="ghost" id="plreset">Tout recalculer</button><button class="ghost" id="plpub">Publier</button>` : ''}
      ${isAdmin() ? `<button class="ghost" id="pllock">${PL.week && PL.week.locked ? 'Déverrouiller' : 'Verrouiller'}</button>` : ''}
      ${PL.cells.length ? '<button id="plwapdf">Partager le PDF sur WhatsApp</button>' : ''}<button class="ghost" id="plpdf">Télécharger le PDF</button><button class="ghost" id="plcp">Copier le texte</button><span class="small" id="plwast"></span></div>
    ${act.some(d => (d.off || []).length !== 2) ? msg(act.filter(d => (d.off || []).length !== 2).length + ' chauffeur(s) actif(s) sans leurs 2 jours de repos réglés : la génération leur répartit des repos sur la semaine. Pour les fixer : onglet <a href="' + plHref('chauffeurs') + '">Chauffeurs et repos</a>, « Répartir les repos manquants ».', 'warn') : ''}
    <div class="bar"><input id="plf" placeholder="Rechercher plaque ou chauffeur" value="${esc(q.get('f') || '')}" size="26"><label>Shift <select id="pls"><option value="">Jour et nuit</option><option ${only === 'Jour' ? 'selected' : ''}>Jour</option><option ${only === 'Nuit' ? 'selected' : ''}>Nuit</option></select></label>
      <span class="small">● case modifiée à la main (gardée par la génération) · rouge : non couverte · orange : à vérifier (survol pour le détail)</span></div>
    <div class="tw plgrid"><table><thead><tr><th>Véhicule</th><th>Shift</th>${days.map((d, i) => `<th>${PLAN_DAYS[i].slice(0, 3)} ${d.slice(8, 10)}/${d.slice(5, 7)}${d === today() ? ' •' : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('') || `<tr><td colspan="9" class="empty">${veh.length ? 'Aucune ligne' : 'Aucun véhicule actif dans cette agence'}</td></tr>`}</tbody></table></div>
    <h2>Planning individuel des chauffeurs</h2>
    ${PL.cells.length ? '' : msg('Semaine pas encore générée : cliquer sur « Générer / compléter la semaine » avant d\'envoyer les plannings aux chauffeurs.', 'warn')}
    <div class="bar"><button class="ghost" id="plsendall" ${PL.cells.length ? '' : 'disabled'}>Envoyer à chaque chauffeur sur WhatsApp (un par un)</button><span class="small" id="plsendst">Chaque clic ouvre WhatsApp avec le planning du chauffeur suivant : il ne reste qu'à appuyer sur Envoyer.</span></div>` +
    table('tpldrv', [['Chauffeur', r => esc(r.d.name || r.d.code) + (r.d.active ? '' : ' <span class="small">(inactif)</span>')], ['Téléphone', r => esc(r.d.phone || '')], ['Shift habituel', r => esc(r.d.shift || '—')],
      ['Véhicule habituel', r => esc(r.d.vehicle ? plPlate(r.d.vehicle) : '—')], ['Repos', r => esc(offTxt(r.d))], ['Shifts', r => f0(r.n) + (r.nights ? ` <span class="small">dont ${r.nights} nuits</span>` : ''), r => r.n, 'n'],
      ['Absences', r => esc(Object.keys(PL.absent[r.d.code] || {}).filter(d => d >= days[0] && d <= days[6]).map(d => d.slice(8, 10) + '/' + d.slice(5, 7)).join(' '))],
      ['', r => !PL.cells.length ? '' : !r.n ? '<span class="small">aucun shift cette semaine</span>' : manifWa(r.d.phone) ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(plWa(r.d.phone, planDriverText(plCtx(), r.d.code)))}">WhatsApp</a>` : '<span class="small">pas de numéro</span>']], drows, { empty: 'Aucun chauffeur actif : voir l\'onglet Chauffeurs et repos.' }));
  const goF = () => { location.hash = plHref('semaine', { f: $('#plf').value, s: $('#pls').value }); };
  $('#plf').onchange = goF; $('#pls').onchange = goF;
  document.querySelectorAll('.plgrid input[data-k]').forEach(inp => { inp.onchange = () => plEditCell(inp); });
  if ($('#plgen')) $('#plgen').onclick = () => plRun(() => plGenerate(PL.cells.filter(c => c.locked)), 'génération');
  if ($('#plreset')) $('#plreset').onclick = () => { if (confirm('Recalculer toute la semaine ? Les cases modifiées à la main seront aussi recalculées.')) plRun(() => { PL.cells = []; return plGenerate([]); }, 'recalcul complet'); };
  if ($('#plcopy')) $('#plcopy').onclick = () => plRun(async () => {
    const prev = await all('driver_plan', 'day,shift,vehicle_key,driver_code', q => (PL.ag ? q.eq('agency_id', PL.ag.id) : q).gte('day', planAddDays(PL.monday, -7)).lte('day', planAddDays(PL.monday, -1)), ['day']);
    const by = {}; PL.drivers.forEach(d => { by[d.code] = d; });
    const keep = prev.filter(c => c.driver_code && by[c.driver_code] && by[c.driver_code].active).map(c => ({ day: planAddDays(c.day, 7), shift: c.shift, vehicle_key: c.vehicle_key, driver_code: c.driver_code }))
      .filter(c => !planOff(by[c.driver_code], c.day) && !(PL.absent[c.driver_code] || {})[c.day] && plVehicles().some(v => v.key === c.vehicle_key));
    PL.cells = PL.cells.filter(c => c.locked);
    return plGenerate(PL.cells.concat(keep.filter(k => !PL.cells.some(c => c.day === k.day && c.shift === k.shift && c.vehicle_key === k.vehicle_key)))).map(c => Object.assign(c, { locked: PL.cells.some(x => x.locked && x.day === c.day && x.shift === c.shift && x.vehicle_key === c.vehicle_key) }));
  }, 'reprise de la semaine précédente');
  if ($('#plpub')) $('#plpub').onclick = async () => { try { await rpc('plan_week_set', { p_agency: PL.ag.id, p_week: PL.monday, p_action: 'publier' }); pagePlan(); } catch (e) { alert(e.message); } };
  if ($('#pllock')) $('#pllock').onclick = async () => { try { await rpc('plan_week_set', { p_agency: PL.ag.id, p_week: PL.monday, p_action: PL.week && PL.week.locked ? 'déverrouiller' : 'verrouiller' }); pagePlan(); } catch (e) { alert(e.message); } };
  $('#plcp').onclick = () => { try { navigator.clipboard.writeText(planWeekText(plCtx())); $('#plcp').textContent = 'Copié'; } catch (e) { alert(e.message); } };
  $('#plpdf').onclick = () => plPdf();
  if ($('#plwapdf')) $('#plwapdf').onclick = () => { const f = plPdf(true), d = planWeekDays(PL.monday);
    plSharePdf(f, '📅 Planning chauffeurs · semaine du ' + fmtDay(d[0]) + ' au ' + fmtDay(d[6]) + (PL.ag ? ' · ' + PL.ag.name : ''), 'semaine', $('#plwast')); };
  $('#plsendall').onclick = () => {
    const l = drows.filter(r => r.n && manifWa(r.d.phone));
    if (!l.length) { alert('Aucun chauffeur planifié avec un numéro de téléphone.'); return; }
    const r = l[PL.sendIdx % l.length]; PL.sendIdx++;
    window.open(plWa(r.d.phone, planDriverText(plCtx(), r.d.code)), '_blank', 'noopener');
    $('#plsendst').textContent = 'Envoyé à ' + (r.d.name || r.d.code) + ' (' + Math.min(PL.sendIdx, l.length) + ' / ' + l.length + ')' + (PL.sendIdx >= l.length ? ' : tous ouverts.' : ' · cliquer encore pour le suivant');
    if (PL.sendIdx >= l.length) PL.sendIdx = 0;
  };
}
async function plRun(fn, note) {
  try { const cells = await fn(); const r = await plSave(cells, note); pagePlan(); return r; }
  catch (e) { alert(e.message); }
}
/** Case modifiée à la main : chauffeur choisi (ou vidé), case verrouillée */
async function plEditCell(inp) {
  const [day, shift, vehicle_key] = inp.dataset.k.split('|'), v = inp.value.trim().toLowerCase();
  const d = v ? PL.drivers.find(x => String(x.name || x.code).toLowerCase() === v || String(x.code).toLowerCase() === v) : null;
  if (v && !d) { alert('Chauffeur inconnu dans cette agence : ' + inp.value); inp.value = ''; return; }
  const cells = PL.cells.filter(c => !(c.day === day && c.shift === shift && c.vehicle_key === vehicle_key));
  if (d) cells.forEach(c => { if (c.day === day && c.driver_code === d.code) { c.driver_code = null; c.locked = false; } });   // déjà pris ce jour-là : retiré de l'autre case
  cells.push({ day, shift, vehicle_key, driver_code: d ? d.code : null, locked: true });
  try { await plSave(cells, 'case ' + plPlate(vehicle_key) + ' ' + shift + ' ' + day.slice(8, 10) + '/' + day.slice(5, 7)); pagePlan(); } catch (e) { alert(e.message); pagePlan(); }
}
/** PDF de la semaine (grille véhicules × shifts × jours) ; asBlob : pour le partage */
function plPdf(asBlob) {
  const days = planWeekDays(PL.monday), by = {}; PL.cells.forEach(c => { by[c.day + '|' + c.shift + '|' + c.vehicle_key] = c; });
  const rows = []; plVehicles().forEach(v => PLAN_SHIFTS.forEach(s => rows.push({ v, s })));
  const cols = [['Véhicule', r => esc(r.v.plate || r.v.key)], ['Shift', r => r.s + ' ' + planHours(r.s, S.P)]].concat(days.map((d, i) => [PLAN_DAYS[i].slice(0, 3) + ' ' + d.slice(8, 10) + '/' + d.slice(5, 7), r => { const c = by[d + '|' + r.s + '|' + r.v.key]; return c && c.driver_code ? esc(plName(c.driver_code)) : 'non couvert'; }]));
  const cnt = {}; PL.cells.forEach(c => { if (c.driver_code) cnt[c.driver_code] = (cnt[c.driver_code] || 0) + 1; });
  const drv = PL.drivers.filter(d => cnt[d.code]).map(d => ({ d, n: cnt[d.code] }));
  try { return reportPdf(Object.assign(rptSimple({ kind: 'planning', agency: PL.ag.name, title: 'Planning chauffeurs · semaine du ' + fmtDay(days[0]) + ' au ' + fmtDay(days[6]), period: fmtDay(days[0]) + ' → ' + fmtDay(days[6]), from: days[0], to: days[6],
    summary: [['Véhicules', f0(plVehicles().length)], ['Chauffeurs planifiés', f0(drv.length)], ['Cases non couvertes', f0(PL.cells.filter(c => !c.driver_code).length)]],
    tables: [colsTable('Planning', cols, rows), colsTable('Chauffeurs', [['Chauffeur', r => esc(r.d.name || r.d.code)], ['Téléphone', r => esc(r.d.phone || '')], ['Shifts', r => f0(r.n), null, 'n'], ['Repos', r => (r.d.off || []).map(w => PLAN_DAYS[w - 1]).join(', ')]], drv)],
    fileName: 'planning_' + (PL.ag.name || '').replace(/\W+/g, '_') + '_' + days[0] }), { asBlob: !!asBlob })); } catch (e) { alert(e.message); }
}
/**
 * Partage d'un PDF sur WhatsApp : sur téléphone, le fichier lui-même (partage du système) ; sinon PDF déposé dans le stockage
 * privé « plannings » et lien signé (7 jours) dans le message WhatsApp ; sans stockage : PDF téléchargé, à joindre à la main.
 */
async function plSharePdf(f, caption, kind, st) {
  if (!f || !f.blob) return;
  const say = t => { if (st) st.textContent = t; };
  const file = typeof File === 'function' ? new File([f.blob], f.name, { type: 'application/pdf' }) : null;
  if (file && !window.LUDY_APP && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: caption }); say('PDF partagé.'); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {
    say('Préparation du lien…');
    const path = (PL.ag ? PL.ag.id : 0) + '/' + PL.monday + '_' + kind + '_' + Date.now() + '.pdf';
    const up = await sb.storage.from('plannings').upload(path, f.blob, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw new Error(up.error.message);
    const sg = await sb.storage.from('plannings').createSignedUrl(path, 7 * 86400, { download: f.name });
    if (sg.error) throw new Error(sg.error.message);
    window.open('https://wa.me/?text=' + encodeURIComponent(caption + '\nPDF : ' + sg.data.signedUrl), '_blank', 'noopener');
    say('Lien du PDF envoyé dans WhatsApp (valable 7 jours).');
  } catch (e) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    say('PDF téléchargé : à joindre dans WhatsApp (stockage indisponible : ' + e.message + ').');
  }
}
/** PDF de la veille de shift : véhicule, chauffeur, téléphone */
function plEvePdf(day, s, list) {
  const ph = plCtx().phones;
  try { return reportPdf(Object.assign(rptSimple({ kind: 'planning', agency: PL.ag.name, title: 'Shift ' + s.toLowerCase() + ' du ' + PLAN_DAYS[planWd(day) - 1].toLowerCase() + ' ' + fmtDay(day) + ' · ' + planHours(s, S.P), period: fmtDay(day), from: day, to: day,
    summary: [['Véhicules', f0(list.length)], ['Non couverts', f0(list.filter(c => !c.driver_code).length)]],
    tables: [colsTable('Chauffeurs du shift', [['Véhicule', c => esc(plPlate(c.vehicle_key))], ['Chauffeur', c => c.driver_code ? esc(plName(c.driver_code)) : 'non couvert'], ['Téléphone', c => esc(ph[c.driver_code] || '')]], list)],
    fileName: 'shift_' + s.toLowerCase() + '_' + day }), { asBlob: true })); } catch (e) { alert(e.message); }
}

// ---------- Veille de shift ----------
function plNextShift() {
  const c = shiftAt(new Date(), S.P) || { s: 'Jour', day: today() };
  return c.s === 'Jour' ? { day: c.day, s: 'Nuit' } : { day: planAddDays(c.day, 1), s: 'Jour' };
}
async function plTabEve() {
  const q = qs(), nx = plNextShift(), day = /^\d{4}-\d{2}-\d{2}$/.test(q.get('jour') || '') ? q.get('jour') : nx.day, s = q.get('s') === 'Jour' || q.get('s') === 'Nuit' ? q.get('s') : nx.s;
  if (planMonday(day) !== PL.monday) { location.hash = plHref('veille', { w: planMonday(day), jour: day, s }); return; }
  const ctx = plCtx(), l = PL.cells.filter(c => c.day === day && c.shift === s).sort((a, b) => plPlate(a.vehicle_key).localeCompare(plPlate(b.vehicle_key)));
  const missing = plVehicles().filter(v => !l.some(c => c.vehicle_key === v.key)).map(v => ({ day, shift: s, vehicle_key: v.key, driver_code: null }));
  const list = l.concat(missing), txt = planEveText(Object.assign(ctx, { cells: list }), day, s);
  plBody(`<div class="bar"><label>Jour <input type="date" id="pled" value="${day}"></label><label>Shift <select id="ples"><option ${s === 'Jour' ? 'selected' : ''}>Jour</option><option ${s === 'Nuit' ? 'selected' : ''}>Nuit</option></select></label>
      <b>${s === 'Jour' ? '☀️' : '🌙'} ${esc(planHours(s, S.P))}</b><button id="plewapdf">Partager le PDF sur WhatsApp</button><a class="btn ghostb" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(txt)}">Partager en texte</a><button class="ghost" id="plecp">Copier</button><span class="small" id="plewast"></span></div>` +
    table('tpleve', [['Véhicule', c => esc(plPlate(c.vehicle_key))], ['Chauffeur', c => c.driver_code ? esc(plName(c.driver_code)) : '<b class="red">non couvert</b>'], ['Téléphone', c => esc((ctx.phones || {})[c.driver_code] || '')],
      ['Rappel', c => c.driver_code && manifWa(ctx.phones[c.driver_code]) ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(plWa(ctx.phones[c.driver_code], planEveDriverText(ctx, day, s, c)))}">WhatsApp</a>` : ''],
      ['', c => PL.can && c.driver_code ? `<button class="ghost small" data-plabs="${esc(c.driver_code)}">Absent : remplacer</button>` : '']], list, { empty: 'Aucun véhicule actif' }) +
    `<pre class="pltxt">${esc(txt)}</pre>`);
  const go = () => { location.hash = plHref('veille', { jour: $('#pled').value, s: $('#ples').value, w: planMonday($('#pled').value) }); };
  $('#pled').onchange = go; $('#ples').onchange = go;
  $('#plecp').onclick = () => { try { navigator.clipboard.writeText(txt); $('#plecp').textContent = 'Copié'; } catch (e) { alert(e.message); } };
  $('#plewapdf').onclick = () => plSharePdf(plEvePdf(day, s, list), (s === 'Jour' ? '☀️' : '🌙') + ' Shift ' + s.toLowerCase() + ' du ' + fmtDay(day) + ' · ' + planHours(s, S.P) + (PL.ag ? ' · ' + PL.ag.name : ''), 'veille', $('#plewast'));
  document.querySelectorAll('[data-plabs]').forEach(b => { b.onclick = async () => {
    const why = prompt('Absence de ' + plName(b.dataset.plabs) + ' le ' + fmtDay(day) + ' : motif ?', 'absent'); if (why === null) return;
    try { const r = await plAbsence(b.dataset.plabs, day, day, why); alert(r); pagePlan(); } catch (e) { alert(e.message); }
  }; });
}

/**
 * Absence déclarée : enregistrée, puis la semaine concernée est réajustée (chauffeur absent retiré de ses cases, remplacé par le
 * meilleur disponible ; toutes les autres cases restent telles quelles pour la continuité). Retourne le résumé des remplacements.
 */
async function plAbsence(code, from, to, reason) {
  const ins = await sb.from('driver_absences').insert({ agency_id: PL.ag ? PL.ag.id : null, driver_code: code, day_from: from, day_to: to, reason: reason || null });
  if (ins.error) throw new Error(ins.error.message);
  const out = [], saveMonday = PL.monday;
  for (let w = planMonday(from); w <= planMonday(to); w = planAddDays(w, 7)) {
    PL.monday = w; await plLoad();
    const freed = PL.cells.filter(c => c.driver_code === code && c.day >= from && c.day <= to);
    if (!freed.length) continue;
    const keep = PL.cells.filter(c => c.driver_code && !(c.driver_code === code && c.day >= from && c.day <= to));
    const cells = plGenerate(keep).map(c => { const o = PL.cells.find(x => x.day === c.day && x.shift === c.shift && x.vehicle_key === c.vehicle_key); return Object.assign(c, { locked: !!(o && o.locked && o.driver_code !== code) }); });
    await plSave(cells, 'absence ' + plName(code));
    freed.forEach(f => { const n = cells.find(c => c.day === f.day && c.shift === f.shift && c.vehicle_key === f.vehicle_key); out.push(fmtDay(f.day).slice(0, 5) + ' ' + f.shift.toLowerCase() + ' ' + plPlate(f.vehicle_key) + ' : ' + (n && n.driver_code ? plName(n.driver_code) : 'non couvert (aucun chauffeur disponible)')); });
  }
  PL.monday = saveMonday;
  return out.length ? 'Remplacements : ' + out.join(' ; ') : 'Absence enregistrée (aucun shift prévu sur ces jours).';
}

// ---------- Chauffeurs et repos ----------
function plTabDrivers() {
  const veh = plVehicles(), ds = PL.drivers.filter(d => !d.left).sort((a, b) => (b.active - a.active) || String(a.name || a.code).localeCompare(String(b.name || b.code))), ex = PL.drivers.filter(d => d.left);
  const days = planWeekDays(PL.monday), act = ds.filter(d => d.active);
  const avail = s => days.map(d => act.filter(x => (x.shift === s || !x.shift) && !planOff(x, d) && !(PL.absent[x.code] || {})[d]).length);
  const regs = {}; act.forEach(d => { if (d.vehicle && d.shift) regs[d.vehicle + '|' + d.shift] = (regs[d.vehicle + '|' + d.shift] || 0) + 1; });
  const dis = PL.can ? '' : 'disabled';
  plBody(`<p class="small">Pour chaque chauffeur : actif, shift habituel, véhicule habituel et ses 2 jours de repos. La génération place d'abord chaque chauffeur sur son véhicule et son shift, puis complète avec les autres (sans jamais dépasser 5 shifts, ni mettre un jour juste après une nuit). Besoin : ${planNeed(veh.length)} chauffeurs actifs pour ${veh.length} véhicules.</p>
    <div class="tw"><table class="plcov"><thead><tr><th>Disponibles</th>${days.map((d, i) => `<th>${PLAN_DAYS[i].slice(0, 3)}</th>`).join('')}</tr></thead><tbody>
      ${PLAN_SHIFTS.map(s => `<tr><td>${s === 'Jour' ? '☀️' : '🌙'} ${s} (besoin ${veh.length})</td>${avail(s).map(n => `<td class="n ${n < veh.length ? 'red' : 'ok'}">${n}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="small">Disponibles = chauffeurs actifs de ce shift (ou sans shift habituel), hors repos et absences.</div>
    ${PL.can ? `<div class="bar"><button class="ghost" id="ploff">Répartir les repos manquants</button><button class="ghost" id="plassign">Répartir véhicules et shifts manquants</button></div>` : ''}
    <div class="tw"><table class="plros"><thead><tr><th>Chauffeur</th><th>Actif</th><th>Shift habituel</th><th>Véhicule habituel</th><th>Repos (2 jours)</th><th>Note</th>${PL.can ? '<th></th>' : ''}</tr></thead><tbody>
    ${ds.map(d => `<tr data-c="${esc(d.code)}"><td>${esc(d.name || d.code)}<div class="small">${esc(d.code)}${d.phone ? ' · ' + esc(d.phone) : ''}</div></td>
      <td><input type="checkbox" class="pra" ${d.active ? 'checked' : ''} ${dis}></td>
      <td><select class="prs" ${dis}><option value="">—</option>${PLAN_SHIFTS.map(s => `<option ${d.shift === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td><select class="prv" ${dis}><option value="">—</option>${veh.map(v => `<option value="${esc(v.key)}" ${d.vehicle === v.key ? 'selected' : ''}>${esc(v.plate || v.key)}</option>`).join('')}</select></td>
      <td class="proff">${PL_WD.map((w, i) => `<label title="${PLAN_DAYS[i]}"><input type="checkbox" value="${i + 1}" ${(d.off || []).indexOf(i + 1) >= 0 ? 'checked' : ''} ${dis}>${w}</label>`).join('')}</td>
      <td><input class="prn" value="${esc(d.note || '')}" size="14" ${dis}></td>${PL.can ? `<td><button class="ghost small" data-plleave="${esc(d.code)}">Départ / remplacer</button></td>` : ''}</tr>`).join('') || '<tr><td colspan="7" class="empty">Aucun chauffeur dans cette agence</td></tr>'}</tbody></table></div>
    <div id="plleave"></div>
    <h3>Ex-chauffeurs (${ex.length})</h3>` + table('tplex', [['Chauffeur', d => esc(d.name || d.code) + `<div class="small">${esc(d.code)}${d.phone ? ' · ' + esc(d.phone) : ''}</div>`], ['Parti le', d => fmtDay(d.left), d => d.left], ['Motif', d => esc(d.leftReason)],
      ['Remplacé par', d => esc(d.replacedBy ? plName(d.replacedBy) : '')], ['', d => PL.can ? `<button class="ghost small" data-plback="${esc(d.code)}">Réintégrer</button>` : '']], ex, { empty: 'Aucun ex-chauffeur' }));
  document.querySelectorAll('[data-plleave]').forEach(b => { b.onclick = () => plLeaveForm(b.dataset.plleave); });
  document.querySelectorAll('[data-plback]').forEach(b => { b.onclick = async () => {
    if (!confirm('Réintégrer ' + plName(b.dataset.plback) + ' parmi les chauffeurs actifs ?')) return;
    const r = await sb.from('driver_roster').update({ active: true, left_at: null, left_reason: null, replaced_by: null, updated_at: new Date().toISOString() }).eq('driver_code', b.dataset.plback);
    if (r.error) alert(r.error.message); else pagePlan(); }; });
  const rowOf = tr => { const off = [...tr.querySelectorAll('.proff input:checked')].map(x => +x.value);
    return { driver_code: tr.dataset.c, agency_id: PL.ag ? PL.ag.id : null, active: tr.querySelector('.pra').checked, shift: tr.querySelector('.prs').value || null, vehicle_key: tr.querySelector('.prv').value || null, off_days: off, note: tr.querySelector('.prn').value || null, updated_at: new Date().toISOString() }; };
  document.querySelectorAll('.plros tr[data-c]').forEach(tr => tr.querySelectorAll('input,select').forEach(el => { el.onchange = async () => {
    const r = rowOf(tr);
    if (r.off_days.length > 2) { el.checked = false; alert('Deux jours de repos par chauffeur.'); return; }
    const u = await sb.from('driver_roster').upsert(r, { onConflict: 'driver_code' });
    if (u.error) { alert(u.error.message); return; }
    el.classList.add('saved'); const d = PL.drivers.find(x => x.code === r.driver_code); if (d) Object.assign(d, { active: r.active, shift: r.shift || '', vehicle: r.vehicle_key || '', off: r.off_days, note: r.note || '' });
  }; }));
  const bulk = async (rows) => { if (!rows.length) { alert('Rien à répartir.'); return; } const u = await sb.from('driver_roster').upsert(rows, { onConflict: 'driver_code' }); if (u.error) alert(u.error.message); else pagePlan(); };
  const base = d => ({ driver_code: d.code, agency_id: PL.ag ? PL.ag.id : null, active: d.active, shift: d.shift || null, vehicle_key: d.vehicle || null, off_days: d.off || [], note: d.note || null, updated_at: new Date().toISOString() });
  if ($('#ploff')) $('#ploff').onclick = () => { const m = planAutoOff(act.map(d => Object.assign({}, d))); bulk(act.filter(d => m[d.code]).map(d => Object.assign(base(d), { off_days: m[d.code] }))); };
  if ($('#plassign')) $('#plassign').onclick = () => {
    // chaque chauffeur actif sans véhicule ni shift : sur le couple véhicule × shift qui a le moins de chauffeurs habituels
    const slots = []; veh.forEach(v => PLAN_SHIFTS.forEach(s => slots.push({ v: v.key, s, n: regs[v.key + '|' + s] || 0 })));
    const rows = act.filter(d => !d.vehicle || !d.shift).map(d => { const pool = slots.filter(x => !d.shift || x.s === d.shift).sort((a, b) => a.n - b.n); const x = pool[0]; if (!x) return null; x.n++; return Object.assign(base(d), { shift: x.s, vehicle_key: x.v }); }).filter(Boolean);
    bulk(rows);
  };
}

// ---------- Absences ----------
function plTabAbs() {
  const days = planWeekDays(PL.monday);
  plBody((PL.can ? `<div class="panel"><h3>Déclarer une absence</h3><div class="mfrow"><label>Chauffeur <input list="plandrv" id="pla" size="22"></label><label>Du <input type="date" id="plf1" value="${today()}"></label><label>Au <input type="date" id="plf2" value="${today()}"></label>
      <label>Motif <input id="plr" size="22" placeholder="maladie, congé…"></label><button id="plasave">Enregistrer et remplacer</button></div>
      <div class="small">Le chauffeur est retiré de ses shifts sur ces jours et remplacé par le meilleur chauffeur disponible (même shift, le moins chargé, au repos respecté). Le reste du planning ne bouge pas.</div><div id="plares"></div></div>` : '') +
    `<h3>Absences de la semaine</h3>` + table('tplabs', [['Chauffeur', a => esc(plName(a.driver_code))], ['Du', a => fmtDay(a.day_from), a => a.day_from], ['Au', a => fmtDay(a.day_to), a => a.day_to], ['Motif', a => esc(a.reason || '')],
      ['', a => PL.can ? `<button class="ghost small" data-pldel="${a.id}">Supprimer</button>` : '']], PL.abs.filter(a => a.day_to >= days[0] && a.day_from <= days[6]), { empty: 'Aucune absence cette semaine' }));
  if ($('#plasave')) $('#plasave').onclick = async () => {
    const v = $('#pla').value.trim().toLowerCase(), d = PL.drivers.find(x => String(x.name || x.code).toLowerCase() === v || String(x.code).toLowerCase() === v), f1 = $('#plf1').value, f2 = $('#plf2').value;
    if (!d || !f1 || !f2 || f2 < f1) { alert('Chauffeur et dates obligatoires.'); return; }
    if (planMonday(f2) > planAddDays(planMonday(f1), 35)) { alert('Six semaines au plus par absence.'); return; }
    try { $('#plares').innerHTML = msg('Remplacement…'); const r = await plAbsence(d.code, f1, f2, $('#plr').value.trim()); $('#plares').innerHTML = msg(esc(r), 'ok'); setTimeout(() => pagePlan(), 2500); }
    catch (e) { $('#plares').innerHTML = msg(esc(e.message), 'err'); }
  };
  document.querySelectorAll('[data-pldel]').forEach(b => { b.onclick = async () => { if (!confirm('Supprimer cette absence ? (le planning n\'est pas recalculé : utiliser « Générer / compléter » si besoin)')) return;
    const r = await sb.from('driver_absences').delete().eq('id', +b.dataset.pldel); if (r.error) alert(r.error.message); else pagePlan(); }; });
}

// ---------- Historique ----------
async function plTabLog() {
  const my = ROUTING;
  let rows = [];
  try { rows = await all('plan_log', '*', q => (PL.ag ? q.eq('agency_id', PL.ag.id) : q).gte('at', dayBounds(addDays(today(), -60)).start.toISOString()), ['at', false]); } catch (e) { plBody(msg(esc(e.message), 'err')); return; }
  if (!PL.users) { PL.users = {}; try { (await all('profiles', 'user_id,email')).forEach(u => { PL.users[u.user_id] = u.email; }); } catch (e) { } }
  if (my !== ROUTING) return;
  const draw = () => plBody('<div class="small">Qui a modifié le planning, déclaré une absence, publié ou verrouillé une semaine (60 derniers jours).</div>' +
    table('tpllog', [['Le', l => fmtDTY(l.at), l => l.at], ['Par', l => esc(PL.users[l.by] || '')], ['Action', l => esc(l.action)], ['Détail', l => esc(l.detail || '')]], rows, { empty: 'Aucune modification', page: true }));
  draw(); window.__repage = draw;   // page ou tri : historique déjà lu redessiné
}

/** Départ d'un chauffeur : remplaçant (chauffeur existant ou nouveau), date ; le remplaçant reprend ses réglages et ses shifts planifiés */
function plLeaveForm(code) {
  const box = $('#plleave'); if (!box) return;
  const others = PL.drivers.filter(d => d.code !== code && !d.left).sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code)));
  box.innerHTML = `<div class="panel"><h3>Départ de ${esc(plName(code))}</h3>
    <p class="small">Le remplaçant reprend son shift, son véhicule, ses jours de repos et tous ses shifts déjà planifiés à partir de la date choisie. Un jour où le remplaçant travaille déjà, la case reste à pourvoir (en rouge dans la semaine). ${esc(plName(code))} passe dans les ex-chauffeurs.</p>
    <div class="mfrow"><label>Remplaçant <input id="plrep" list="plrepl" size="24" placeholder="chauffeur existant ou nouveau nom"></label><datalist id="plrepl">${others.map(d => `<option value="${esc(d.name || d.code)}"></option>`).join('')}</datalist>
      <label>Téléphone (nouveau chauffeur) <input id="plrept" size="14" placeholder="06…"></label><label>À partir du <input type="date" id="plrepd" value="${today()}"></label>
      <label>Motif <input id="plrepm" size="20" placeholder="licencié, démission…"></label><button id="plrepok">Confirmer le remplacement</button><button class="ghost" id="plrepx">Annuler</button></div><div id="plrepr"></div></div>`;
  box.scrollIntoView({ block: 'nearest' });
  $('#plrepx').onclick = () => { box.innerHTML = ''; };
  $('#plrepok').onclick = async () => {
    const v = $('#plrep').value.trim(), from = $('#plrepd').value, out = $('#plrepr');
    if (!v || !from) { out.innerHTML = msg('Remplaçant et date obligatoires.', 'err'); return; }
    let nd = others.find(d => String(d.name || d.code).toLowerCase() === v.toLowerCase() || String(d.code).toLowerCase() === v.toLowerCase());
    try {
      if (!nd) {   // nouveau chauffeur (pas encore de contrat) : fiche créée à la main dans l'agence
        if (!confirm('« ' + v + ' » n\'existe pas dans Ludy : créer ce nouveau chauffeur ?')) return;
        const c = 'M' + Date.now().toString(36).toUpperCase();
        const r = await sb.from('drivers').insert({ code: c, name: v, phone: $('#plrept').value.trim() || null, agency_id: PL.ag ? PL.ag.id : null, source: 'manuel', status: 'NOUVEAU', detected_at: new Date().toISOString() });
        if (r.error) throw new Error(r.error.message);
        nd = { code: c, name: v };
      }
      const res = await rpc('plan_replace_driver', { p_agency: PL.ag ? PL.ag.id : null, p_old: code, p_new: nd.code, p_from: from, p_reason: $('#plrepm').value.trim() || null });
      out.innerHTML = msg(esc(plName(code)) + ' remplacé par ' + esc(nd.name || nd.code) + ' : ' + res.moved + ' shift(s) repris' + (res.free ? ', <b>' + res.free + ' à pourvoir</b> (remplaçant déjà en service ces jours-là)' : '') + '.', res.free ? 'warn' : 'ok');
      setTimeout(() => pagePlan(), 2500);
    } catch (e) { out.innerHTML = msg(esc(e.message), 'err'); }
  };
}
