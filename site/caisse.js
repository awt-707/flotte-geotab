// Caisse (page #/caisse) : suivi du cash des chauffeurs, repris du classeur « Suivi Cash Chauffeurs - Luxury ».
// Un journal unique (cash_moves) : encaissements Uber par shift, dépenses, avances RH, courses privées, bonus, dépôts et recharges ;
// exports Uber (espèces collectées, revenus) ; rapprochement, effet sur la paie, chiffre d'affaires. Calculs : caisse_calc.js.

const CS = { moves: [], all: [], pay: [], drivers: [], udrv: [], uuid2code: {}, names: {}, ctrByDrv: {}, err: '' };
const CSH_TABS = [['bord', 'Tableau de bord'], ['shift', 'Encaissement du shift'], ['depenses', 'Dépenses'], ['rh', 'Avances RH'], ['courses', 'Courses privées'],
  ['bonus', 'Bonus'], ['rappro', 'Rapprochement Uber'], ['paie', 'Paie'], ['ca', 'Chiffre d\'affaires'], ['journal', 'Journal'], ['import', 'Imports']];
const CSH_KIND = { encaissement: 'Encaissement', depense: 'Dépense', avance: 'Avance', remboursement: 'Remboursement d\'avance', course: 'Course privée', bonus: 'Bonus',
  recharge: 'Recharge de caisse', depot: 'Dépôt en banque', autre: 'Autre' };
const CSH_FLOW_TXT = { in: 'Entrée de cash', out: 'Sortie de cash', virement: 'Virement' };
const CSH_ST_CLS = { 'Cadré': 'ok', 'Manquant': 'crit', 'Non remis': 'crit', 'Excédent': 'warn', 'Sans activité': '' };
function cshMoney(v) { return typeof crsMoney === 'function' ? crsMoney(v) : f0(v) + ' MAD'; }
function cshSignedTxt(v) { const n = cshR(v); return n > 0 ? '<b class="ok">+' + cshMoney(n) + '</b>' : n < 0 ? '<b class="red">' + cshMoney(n) + '</b>' : cshMoney(0); }

/** Période de la page (du / au), 7 derniers jours par défaut */
function cshPeriod() { const q = qs(); const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('au') || '') ? q.get('au') : today(); const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('du') || '') ? q.get('du') : addDays(to, -6); return { from: from <= to ? from : to, to }; }
function cshHref(t, extra) { const p = cshPeriod(), o = Object.assign({ t, du: p.from, au: p.to }, extra || {}); return '#/caisse?' + Object.keys(o).filter(k => o[k] !== '' && o[k] != null).map(k => k + '=' + encodeURIComponent(o[k])).join('&'); }
/** Nom d'un chauffeur (code Ludy) */
function cshDrvName(code) { return (S.drv && S.drv[code]) || code; }
/** Chauffeur saisi (nom tapé ou choisi) → { driver_code, driver_name, uber_uuid } */
function cshResolve(name, uuid) {
  const n = cshName(name), u = String(uuid || '').trim();
  let d = (u && CS.drivers.find(x => x.uber_uuid === u)) || (n && CS.drivers.find(x => cshName(x.name) === n)) || null;
  if (!d && n) { const ud = CS.udrv.find(x => cshName(x.name) === n); if (ud) return { driver_code: CS.uuid2code[ud.uuid] || null, driver_name: ud.name, uber_uuid: ud.uuid }; }
  return d ? { driver_code: d.code, driver_name: d.name, uber_uuid: d.uber_uuid || u || null } : { driver_code: null, driver_name: String(name || '').trim() || null, uber_uuid: u || null };
}
/**
 * Agence de la caisse : chaque agence a sa propre caisse (mouvements, soldes, exports Uber, classeur de sauvegarde).
 * Une seule agence : elle ; plusieurs : celle choisie sur la page (sinon celle du menu) ; aucune agence créée : caisse unique (id null).
 */
function cshAg() {
  const l = S.agencies || [];
  if (!l.length) return { id: null, name: '' };
  if (l.length === 1) return l[0];
  let a = ''; try { a = localStorage.getItem('caisseAg') || ''; } catch (e) { }
  return l.find(x => String(x.id) === a) || l.find(x => String(x.id) === agFilter()) || null;
}
function cshAgency() { return CS.agId; }
/** Jour du shift d'une transaction Uber : contrat du chauffeur à cette heure (shift du contrat), sinon date de la transaction */
function cshPayDay(p) {
  const code = CS.uuid2code[p.driver_uuid], t = new Date(p.at).getTime();
  const c = code && (CS.ctrByDrv[code] || []).find(x => t >= x._s && t <= x._e);
  return c ? c._day : localDay(t);
}
function cshPayShift(p) { const code = CS.uuid2code[p.driver_uuid], t = new Date(p.at).getTime(); const c = code && (CS.ctrByDrv[code] || []).find(x => t >= x._s && t <= x._e); return c ? c._shift : ''; }

async function cshLoad(from, to) {
  const lo = addDays(from, -2), hi = addDays(to, 2), ag = CS.agId, A = q => ag ? q.eq('agency_id', ag) : q;
  const keys = ag ? S.vehList.filter(v => String(v.agency_id) === String(ag)).map(v => v.key) : null;
  const [drv, udrv, moves, all_, pay, ctr] = await Promise.all([
    all('drivers', 'code,name,phone,email,uber_uuid,agency_id', null, ['name']),
    all('uber_drivers', 'uuid,name,phone,email,status', A, ['name']),
    all('cash_moves', '*', q => A(q).gte('day', from).lte('day', to), ['day']),
    all('cash_moves', 'id,caisse,flow,amount,cancelled_at', A),
    all('uber_payments', 'tx,at,driver_uuid,driver_name,cash,revenue', q => A(q).gte('at', dayBounds(lo).start.toISOString()).lt('at', dayBounds(hi).end.toISOString()), ['at']),
    keys && !keys.length ? Promise.resolve([]) : all('contracts', 'num,client_code,name,vehicle_key,start_at,end_at', q => { q = q.lt('start_at', dayBounds(hi).end.toISOString()).gte('start_at', dayBounds(addDays(lo, -7)).start.toISOString()); return keys ? q.in('vehicle_key', keys) : q; }, ['start_at'])]);
  CS.drivers = drv; CS.udrv = udrv; CS.moves = moves; CS.all = all_; CS.pay = pay;
  CS.uuid2code = {}; drv.forEach(d => { if (d.uber_uuid) CS.uuid2code[d.uber_uuid] = d.code; });
  CS.names = {}; drv.forEach(d => { CS.names[d.code] = d.name; }); udrv.forEach(u => { if (!CS.uuid2code[u.uuid]) CS.names['U:' + u.uuid] = u.name; });
  // contrats par chauffeur : fin réelle (contrat jamais clôturé = début du suivant sur le véhicule), shift du contrat
  const byVeh = {}; ctr.forEach(c => { (byVeh[c.vehicle_key || '?'] = byVeh[c.vehicle_key || '?'] || []).push(c); });
  CS.ctr = []; Object.values(byVeh).forEach(l => ctrEffEnds(l).forEach(c => { const sh = shiftOfCtr(c.start_at, S.P) || {}; c._s = new Date(c.start_at).getTime(); c._e = c._end || Date.now(); c._day = sh.day; c._shift = sh.s; CS.ctr.push(c); }));
  CS.ctrByDrv = {}; CS.ctr.forEach(c => { if (c.client_code) (CS.ctrByDrv[c.client_code] = CS.ctrByDrv[c.client_code] || []).push(c); });
}

async function pageCaisse() {
  const my = ROUTING, q = qs(), t = CSH_TABS.some(x => x[0] === q.get('t')) ? q.get('t') : 'bord', p = cshPeriod();
  const head = `<div class="head"><h1>Caisse</h1><div class="sub">Cash des chauffeurs : encaissements Uber par shift, dépenses, avances, courses privées, bonus, dépôts en banque ; rapprochement avec Uber et effet sur la paie. Rien n'est estimé : montants saisis et exports Uber.</div></div>`;
  if (!canEdit()) { $('#page').innerHTML = head + msg('Caisse réservée aux gestionnaires et à l\'administrateur.', 'warn'); return; }
  const ag = cshAg(), agSel = S.agencies.length > 1 ? `<div class="bar"><label>Agence <select id="cshag"><option value="">— choisir —</option>${S.agencies.map(a => `<option value="${a.id}" ${ag && a.id === ag.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label><span class="small">Chaque agence a sa propre caisse : saisies, soldes, exports Uber et classeur de sauvegarde.</span></div>` : '';
  const bindAg = () => { const x = $('#cshag'); if (x) x.onchange = () => { try { localStorage.setItem('caisseAg', x.value); } catch (e) { } CS.users = null; pageCaisse(); }; };
  if (!ag) { $('#page').innerHTML = head + agSel + msg('Choisir l\'agence : chaque agence a sa propre caisse.', 'warn'); bindAg(); return; }
  CS.agId = ag.id; CS.agName = ag.name || '';
  $('#page').innerHTML = head + agSel + '<div class="loading">Chargement de la caisse…</div>'; bindAg();
  const sh = cshShiftSel();
  try { if (t === 'shift') await cshLoad(sh.day, addDays(sh.day, 1)); else await cshLoad(p.from, p.to); }
  catch (e) {
    if (my !== ROUTING) return;
    $('#page').innerHTML = head + agSel + msg(/agency_id/i.test(e.message) ? 'Caisse par agence pas encore installée : exécuter <b>supabase/migrations/20261105000000_chauffeurs_auto.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message) + ')'
      : /cash_moves|uber_payments|uber_drivers|uber_uuid|does not exist|schema cache/i.test(e.message) ? 'Caisse pas encore installée dans la base : exécuter <b>supabase/migrations/20261103000000_caisse.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message) + ')' : 'Lecture impossible : ' + esc(e.message), 'err');
    bindAg();
    return;
  }
  if (my !== ROUTING) return;
  const tabs = `<div class="tabs">${CSH_TABS.map(x => `<a href="${cshHref(x[0])}" class="${t === x[0] ? 'on' : ''}">${x[1]}</a>`).join('')}</div>`;
  const bar = t === 'shift' || t === 'import' ? '' : `<div class="bar"><label>Du <input type="date" id="cshdu" value="${p.from}"></label><label>Au <input type="date" id="cshau" value="${p.to}"></label>
    <span class="small">${[['Aujourd\'hui', 0, 0], ['7 jours', 6, 0], ['30 jours', 29, 0]].map(x => `<a href="${cshHref(t, { du: addDays(today(), -x[1]), au: today() })}">${x[0]}</a>`).join(' · ')}</span></div>`;
  $('#page').innerHTML = head + agSel + tabs + bar + '<div id="cshbody"></div>' + `<datalist id="cshdrv">${[...new Set(CS.drivers.filter(d => !CS.agId || !d.agency_id || String(d.agency_id) === String(CS.agId)).map(d => d.name).concat(CS.udrv.filter(u => !CS.uuid2code[u.uuid]).map(u => u.name)).filter(Boolean))].sort().map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>`;
  const go = () => { location.hash = cshHref(t, { du: $('#cshdu').value, au: $('#cshau').value }); };
  if ($('#cshdu')) { $('#cshdu').onchange = go; $('#cshau').onchange = go; }
  bindAg();
  const tab = ({ bord: cshTabBord, shift: cshTabShift, depenses: cshTabDep, rh: cshTabRh, courses: cshTabCourses, bonus: cshTabBonus, rappro: cshTabRappro, paie: cshTabPaie, ca: cshTabCA, journal: cshTabJournal, import: cshTabImport })[t];
  tab(p);
  window.__rerender = () => pageCaisse();
  window.__repage = () => tab(p);   // page ou tri d'une liste : onglet redessiné avec les mouvements déjà lus (sans relire la base)
}
function cshBody(html) { const b = $('#cshbody'); if (b) b.innerHTML = html; }
function cshRap(p) { return cshRappro({ payments: CS.pay, moves: CS.moves, from: p.from, to: p.to, uuid2code: CS.uuid2code, dayOfPayment: cshPayDay, names: CS.names }); }
function cshLastImport() { const l = CS.pay.reduce((m, x) => x.at > m ? x.at : m, ''); return l; }
function cshUberWarn(p) {
  const l = cshLastImport();
  if (!l) return msg('Aucune transaction Uber sur la période : importer l\'export Uber « Opérations de paiement » (onglet Imports) pour comparer les espèces encaissées à celles déclarées par Uber.', 'warn');
  return localDay(l) < p.to ? `<div class="small">Données Uber jusqu'au ${esc(fmtDTY(l))} (dernier export importé). <a href="${cshHref('import')}">Importer un export plus récent</a></div>` : '';
}

// ---------- Tableau de bord ----------
function cshTabBord(p) {
  const bal = cshBalances(CS.all), rap = cshRap(p), daily = cshDaily({ payments: CS.pay, moves: CS.moves, from: p.from, to: p.to, dayOfPayment: cshPayDay });
  const sum = k => cshR(daily.reduce((s, d) => s + d[k], 0)), man = cshR(rap.reduce((s, r) => s + Math.max(0, r.ecart), 0)), exc = cshR(rap.reduce((s, r) => s + Math.max(0, -r.ecart), 0));
  const cats = cshByCategory(CS.moves, p.from, p.to), courses = CS.moves.filter(m => cshLive(m) && m.kind === 'course'), caCourses = cshR(courses.reduce((s, m) => s + cshN(m.course_amount), 0));
  const top = rap.filter(r => r.ecart > 0).slice(0, 10);
  const W = 760, H = 180, mx = Math.max(1, ...daily.map(d => Math.max(d.uber, d.net))), bw = daily.length ? Math.max(4, Math.min(28, (W - 40) / daily.length / 2.4)) : 10;
  const bars = daily.map((d, i) => { const x = 30 + i * ((W - 40) / Math.max(1, daily.length)); const hu = d.uber / mx * (H - 30), hn = d.net / mx * (H - 30);
    return `<rect x="${x}" y="${H - 20 - hu}" width="${bw}" height="${hu}" class="cb-u"><title>${fmtDay(d.day)} · espèces Uber ${cshMoney(d.uber)}</title></rect><rect x="${x + bw + 1}" y="${H - 20 - hn}" width="${bw}" height="${hn}" class="cb-n"><title>${fmtDay(d.day)} · encaissé ${cshMoney(d.net)}</title></rect>` +
      (daily.length <= 16 || i % Math.ceil(daily.length / 12) === 0 ? `<text x="${x}" y="${H - 5}" class="cb-t">${d.day.slice(8, 10)}/${d.day.slice(5, 7)}</text>` : ''); }).join('');
  cshBody(cshUberWarn(p) + `<h2>Soldes des caisses (espèces en main)</h2>` + cards(CASH_CAISSES.map(c => [c[1], cshMoney(bal[c[0]]), bal[c[0]] < 0 ? 'crit' : '']).concat([['Total espèces', '<b>' + cshMoney(bal.total) + '</b>', bal.total < 0 ? 'crit' : 'ok']])) +
    `<h2>Période du ${fmtDay(p.from)} au ${fmtDay(p.to)}</h2>` +
    cards([['Espèces déclarées par Uber', cshMoney(sum('uber'))], ['Espèces encaissées (net)', cshMoney(sum('net'))], ['Manquant à retenir', cshMoney(man), man ? 'crit' : 'ok'], ['Excédent à ajouter', cshMoney(exc), exc ? 'warn' : ''],
      ['Dépenses chauffeurs', cshMoney(sum('depenses'))], ['Avances sur salaire', cshMoney(sum('avances'))], ['Courses privées encaissées', cshMoney(sum('courses')) + `<div class="small">CA courses : ${cshMoney(caCourses)}</div>`],
      ['Bonus', cshMoney(sum('bonus'))], ['Dépôts en banque', cshMoney(sum('depots'))], ['Chiffre d\'affaires Uber', cshMoney(sum('revenue'))]]) +
    `<div class="panel"><h3>Espèces déclarées par Uber et encaissées, par jour de shift</h3>${daily.length ? `<svg viewBox="0 0 ${W} ${H}" class="cshchart" role="img" aria-label="Espèces par jour">${bars}</svg>
      <div class="small"><span class="lg-u">■</span> Espèces Uber · <span class="lg-n">■</span> Encaissé net</div>` : '<div class="empty">Aucun mouvement sur la période</div>'}</div>` +
    `<div class="grid2"><div class="panel"><h3>Dépenses par catégorie</h3>${table('tcshcat', [['Catégorie', r => esc(r.label)], ['Montant', r => cshMoney(r.amount), r => r.amount, 'n']], cats, { empty: 'Aucune dépense sur la période', total: cshTot() })}</div>
      <div class="panel"><h3>Chauffeurs : cash manquant</h3>${table('tcshtop', [['Chauffeur', r => esc(r.name || r.key)], ['Espèces Uber', r => cshMoney(r.uber), r => r.uber, 'n'], ['Encaissé', r => cshMoney(r.net), r => r.net, 'n'], ['Manquant', r => '<b class="red">' + cshMoney(r.ecart) + '</b>', r => r.ecart, 'n']], top, { empty: 'Aucun manquant sur la période', total: cshTot() })}
      <a href="${cshHref('rappro')}">Rapprochement complet</a> · <a href="${cshHref('paie')}">Effet sur la paie</a></div></div>`);
}

// ---------- Saisie commune ----------
function cshField(id, label, type, opt) {
  const o = opt || {};
  if (type === 'select') return `<label>${label} <select id="${id}">${o.options.map(x => { const [v, t] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(v)}" ${String(v) === String(o.value || '') ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></label>`;
  return `<label>${label} <input id="${id}" type="${type || 'text'}" ${o.value != null ? 'value="' + esc(o.value) + '"' : ''} ${o.size ? 'size="' + o.size + '"' : ''} ${o.list ? 'list="' + o.list + '"' : ''} ${o.min != null ? 'min="' + o.min + '"' : ''} ${o.step ? 'step="' + o.step + '"' : ''} placeholder="${esc(o.ph || '')}" ${type === 'number' ? 'style="width:' + (o.w || 110) + 'px"' : ''}></label>`;
}
function cshVal(id) { const e = $('#' + id); return e ? (e.type === 'checkbox' ? e.checked : e.value) : ''; }
/** Enregistre un mouvement (gestionnaire : auteur et date imposés par la base) */
async function cshInsert(row) {
  row.manager_name = row.manager_name || S.profile.name || S.profile.email || null;
  row.agency_id = CS.agId;   // caisse de l'agence choisie
  const r = await sb.from('cash_moves').insert(row).select('id').single();
  if (r.error) throw new Error(r.error.message);
  return r.data.id;
}
function cshCanFix(m) { return isAdmin() || (m.created_by === S.session.user.id && Date.now() - new Date(m.created_at).getTime() < 24 * HOUR); }
async function cshCancel(id) {
  const why = prompt('Annuler ce mouvement ? Motif (gardé dans l\'historique) :'); if (why === null) return;
  const r = await sb.from('cash_moves').update({ cancelled_at: new Date().toISOString(), cancel_reason: why || 'annulé' }).eq('id', id);
  if (r.error) { alert(r.error.message); return; }
  pageCaisse();
}
async function cshPatch(id, patch, el) {
  const r = await sb.from('cash_moves').update(patch).eq('id', id);
  if (r.error) { alert(r.error.message); return false; }
  if (el) el.classList.add('saved'); const m = CS.moves.find(x => x.id === id); if (m) Object.assign(m, patch);
  return true;
}
function cshBindRowActions() {
  document.querySelectorAll('[data-cshx]').forEach(b => { b.onclick = () => cshCancel(+b.dataset.cshx); });
  document.querySelectorAll('[data-cshj]').forEach(s => { s.onchange = () => cshPatch(+s.dataset.cshj, { justif: s.value }, s); });
  document.querySelectorAll('[data-cshs]').forEach(s => { s.onchange = () => cshPatch(+s.dataset.cshs, { status: s.value }, s); });
  document.querySelectorAll('[data-cshg]').forEach(s => { s.onchange = () => cshPatch(+s.dataset.cshg, { signed: s.checked }, s); });
  document.querySelectorAll('[data-cshh]').forEach(b => { b.onclick = () => cshHistory(+b.dataset.cshh); });
}
function cshActCol() { return ['', m => (m.cancelled_at ? `<span class="small crit" title="${esc(m.cancel_reason || '')}">annulé</span>` : cshCanFix(m) ? `<button class="ghost small" data-cshx="${m.id}">Annuler</button>` : '') + (isAdmin() ? ` <button class="ghost small" data-cshh="${m.id}">Historique</button>` : '')]; }
function cshDrvCol() { return ['Chauffeur', m => esc(m.driver_code ? cshDrvName(m.driver_code) : m.driver_name || '') + (m.driver_code || !m.driver_name ? '' : ' <span class="small" title="Pas de chauffeur Ludy correspondant">(Uber)</span>'), m => m.driver_name || '']; }
/** Total d'un tableau de la caisse : montants des lignes non annulées (kinds : seulement ces opérations, ex. les dépenses d'une liste qui contient aussi les recharges) */
function cshTot(kinds, skip) { return { fmt: v => '<b>' + cshMoney(v) + '</b>', live: m => cshLive(m) && (!kinds || kinds.indexOf(m.kind) >= 0), skip: skip || [] }; }
/** Liste de mouvements (du plus récent au plus ancien), par pages de 50 / 100 / 200 : total de toutes les lignes, tableur de toutes les lignes */
function cshList(id, rows, cols, kinds, skip) { return table(id, cols, rows.slice().sort((a, b) => String(b.day).localeCompare(String(a.day)) || b.id - a.id), { empty: 'Aucun mouvement sur la période', total: cshTot(kinds, skip), page: true }); }
/** Petit formulaire « recharge de caisse / dépôt en banque » d'une caisse */
function cshMoveForm(caisse) {
  return `<details class="panel"><summary><h3>Recharge de caisse ou dépôt en banque</h3></summary><div class="mfrow">
    ${cshField('cmk' + caisse, 'Opération', 'select', { options: [['recharge', 'Recharge de caisse (entrée)'], ['depot', 'Dépôt en banque (sortie)']] })}
    ${cshField('cmd' + caisse, 'Date', 'date', { value: today() })}${cshField('cma' + caisse, 'Montant (MAD)', 'number', { min: 0, step: 1 })}
    ${cshField('cms' + caisse, 'Source', 'select', { options: CASH_SOURCES.concat(['Autre']), value: 'Banque' })}${cshField('cmc' + caisse, 'Commentaire', 'text', { size: 28 })}
    <button class="small" data-cshmv="${caisse}">Enregistrer</button></div></details>`;
}
function cshBindMoveForm() {
  document.querySelectorAll('[data-cshmv]').forEach(b => { b.onclick = async () => {
    const c = b.dataset.cshmv, k = cshVal('cmk' + c), a = cshN(cshVal('cma' + c));
    if (!(a > 0) || !cshVal('cmd' + c)) { alert('Date et montant obligatoires.'); return; }
    try { await cshInsert({ caisse: c, kind: k, flow: k === 'recharge' ? 'in' : 'out', amount: a, day: cshVal('cmd' + c), source: cshVal('cms' + c), label: CSH_KIND[k], comment: cshVal('cmc' + c) || null }); pageCaisse(); }
    catch (e) { alert(e.message); }
  }; });
}

// ---------- Encaissement du shift ----------
/** Shift choisi (?jour=&s=), sinon le shift en cours */
function cshShiftSel() {
  const q = qs(), cur = shiftAt(new Date(), S.P) || { s: 'Jour', day: today() };
  return { day: /^\d{4}-\d{2}-\d{2}$/.test(q.get('jour') || '') ? q.get('jour') : cur.day, s: q.get('s') === 'Nuit' || q.get('s') === 'Jour' ? q.get('s') : cur.s };
}
function cshTabShift() {
  const { day, s } = cshShiftSel();
  const ctr = CS.ctr.filter(c => c._day === day && c._shift === s && c.client_code).sort((a, b) => String(cshDrvName(a.client_code)).localeCompare(String(cshDrvName(b.client_code))));
  const enc = CS.moves.filter(m => cshLive(m) && m.caisse === 'uber' && m.kind === 'encaissement' && m.day === day && (m.shift === s || !m.shift));
  const cashOf = c => { const u = (CS.drivers.find(d => d.code === c.client_code) || {}).uber_uuid; if (!u) return null;
    return cshR(CS.pay.filter(x => x.driver_uuid === u && new Date(x.at).getTime() >= c._s && new Date(x.at).getTime() <= c._e).reduce((t, x) => t + cshN(x.cash), 0)); };
  const lastImp = cshLastImport();
  const rows = ctr.map(c => { const done = enc.filter(m => m.driver_code === c.client_code); const u = cashOf(c);
    return { c, done, uber: u, uuid: (CS.drivers.find(d => d.code === c.client_code) || {}).uber_uuid }; });
  const others = enc.filter(m => !ctr.some(c => c.client_code === m.driver_code));
  const link = (d, sh) => '#/caisse?t=shift&jour=' + d + '&s=' + sh;
  const prev = s === 'Nuit' ? [day, 'Jour'] : [addDays(day, -1), 'Nuit'], next = s === 'Jour' ? [day, 'Nuit'] : [addDays(day, 1), 'Jour'];
  cshBody(`<div class="bar"><a class="btn small ghostb" href="${link(prev[0], prev[1])}">← Shift précédent</a><label>Jour <input type="date" id="cshsd" value="${day}"></label>
      <label>Shift <select id="cshss"><option ${s === 'Jour' ? 'selected' : ''}>Jour</option><option ${s === 'Nuit' ? 'selected' : ''}>Nuit</option></select></label>
      <b>${esc(shiftDayName({ s, day }))}</b><a class="btn small ghostb" href="${link(next[0], next[1])}">Shift suivant →</a></div>
    <div class="small">Chauffeurs dont le contrat a commencé dans ce shift. Espèces Uber = espèces collectées pendant le contrat (export Uber importé${lastImp ? ', jusqu\'au ' + esc(fmtDTY(lastImp)) : ''}). Encaissé net = remis par le chauffeur − monnaie rendue. Manquant = espèces Uber − encaissé net : déduit de la paie (dépenses justifiées comptées au rapprochement).</div>
    <div class="tw"><table class="cshshift"><thead><tr><th>Chauffeur</th><th>Contrat</th><th class="n">Espèces Uber</th><th class="n">Remis</th><th class="n">Monnaie rendue</th><th class="n">Encaissé net</th><th class="n">Manquant</th><th>Commentaire</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((r, i) => { const d = r.done[0];
      if (d) return `<tr class="done"><td>${esc(cshDrvName(r.c.client_code))}</td><td class="small">${esc(r.c.num)} · ${esc(fmtDT(r.c.start_at))}</td><td class="n">${r.uber == null ? '<span class="nm">UUID Uber non relié</span>' : cshMoney(r.uber)}</td>
        <td class="n">${cshMoney(d.given)}</td><td class="n">${cshMoney(d.change)}</td><td class="n"><b>${cshMoney(d.amount)}</b></td><td class="n">${d.uber_cash == null ? '' : cshSignedTxt(-(cshN(d.uber_cash) - cshN(d.amount)))}</td><td class="small">${esc(d.comment || '')}</td><td>${cshCanFix(d) ? `<button class="ghost small" data-cshx="${d.id}">Annuler</button>` : '<span class="small ok">enregistré</span>'}</td></tr>`;
      return `<tr data-row="${i}"><td>${esc(cshDrvName(r.c.client_code))}</td><td class="small">${esc(r.c.num)} · ${esc(fmtDT(r.c.start_at))}</td>
        <td class="n">${r.uber == null ? `<a class="nm" href="${cshHref('import')}">UUID Uber non relié</a>` : cshMoney(r.uber)}</td>
        <td class="n"><input type="number" min="0" step="1" class="cgv" style="width:90px"></td><td class="n"><input type="number" min="0" step="1" class="cch" style="width:80px"></td>
        <td class="n cnet"></td><td class="n cman"></td><td><input class="ccm" size="18" placeholder="si manquant"></td><td><button class="small" data-csav="${i}">Enregistrer</button></td></tr>`; }).join('')
      : `<tr><td colspan="9" class="empty">Aucun contrat commencé dans ce shift${CS.ctr.length ? '' : ' (contrats non importés ?)'}.</td></tr>`}
    </tbody>${rows.length ? (() => { const d = rows.map(r => r.done[0]).filter(Boolean), sum = f => cshR(d.reduce((t, m) => t + cshN(f(m)), 0)), ub = cshR(rows.reduce((t, r) => t + cshN(r.uber), 0));
      const man = cshR(d.reduce((t, m) => t + (m.uber_cash == null ? 0 : cshN(m.uber_cash) - cshN(m.amount)), 0));
      return `<tfoot><tr class="ttot"><td>Total · ${d.length} / ${rows.length} encaissé${d.length > 1 ? 's' : ''}</td><td></td><td class="n"><b>${cshMoney(ub)}</b></td><td class="n"><b>${cshMoney(sum(m => m.given))}</b></td><td class="n"><b>${cshMoney(sum(m => m.change))}</b></td>
        <td class="n"><b>${cshMoney(sum(m => m.amount))}</b></td><td class="n">${cshSignedTxt(-man)}</td><td></td><td></td></tr></tfoot>`; })() : ''}</table></div>
    <details class="panel"><summary><h3>Encaissement d'un autre chauffeur (sans contrat dans ce shift)</h3></summary><div class="mfrow">
      ${cshField('cxd', 'Chauffeur', 'text', { list: 'cshdrv', size: 24 })}${cshField('cxu', 'Espèces Uber (MAD)', 'number', { min: 0 })}${cshField('cxg', 'Remis (MAD)', 'number', { min: 0 })}
      ${cshField('cxc', 'Monnaie rendue (MAD)', 'number', { min: 0 })}${cshField('cxm', 'Commentaire', 'text', { size: 24 })}<button class="small" id="cxsave">Enregistrer</button></div></details>
    ${others.length ? '<h3>Autres encaissements de ce shift</h3>' + cshList('tcsho', others, [cshDrvCol(), ['Espèces Uber', m => m.uber_cash == null ? '' : cshMoney(m.uber_cash), m => cshN(m.uber_cash), 'n'], ['Encaissé net', m => cshMoney(m.amount), m => cshN(m.amount), 'n'], ['Commentaire', m => esc(m.comment || '')], cshActCol()]) : ''}
    ${cshMoveForm('uber')}`);
  const goS = () => { location.hash = '#/caisse?t=shift&jour=' + $('#cshsd').value + '&s=' + $('#cshss').value; };
  $('#cshsd').onchange = goS; $('#cshss').onchange = goS;
  document.querySelectorAll('tr[data-row]').forEach(tr => { const r = rows[+tr.dataset.row], upd = () => {
    const g = cshN(tr.querySelector('.cgv').value), ch = cshN(tr.querySelector('.cch').value), net = cshR(g - ch);
    tr.querySelector('.cnet').textContent = tr.querySelector('.cgv').value === '' ? '' : cshMoney(net);
    tr.querySelector('.cman').innerHTML = tr.querySelector('.cgv').value === '' || r.uber == null ? '' : cshSignedTxt(-(r.uber - net)); };
    tr.querySelectorAll('input').forEach(i => { i.oninput = upd; }); });
  document.querySelectorAll('[data-csav]').forEach(b => { b.onclick = async () => {
    const r = rows[+b.dataset.csav], tr = b.closest('tr'), gv = tr.querySelector('.cgv').value;
    if (gv === '') { alert('Montant remis par le chauffeur obligatoire (0 si rien n\'a été remis).'); return; }
    const g = cshN(gv), ch = cshN(tr.querySelector('.cch').value), net = cshR(g - ch);
    if (net < 0) { alert('La monnaie rendue dépasse le montant remis.'); return; }
    const man = r.uber == null ? 0 : cshR(r.uber - net), cm = tr.querySelector('.ccm').value.trim();
    if (man > 0 && !cm && !confirm('Manquant de ' + cshMoney(man) + ' sans commentaire : il sera déduit de la paie. Enregistrer ?')) return;
    b.disabled = true;
    try { await cshInsert({ caisse: 'uber', kind: 'encaissement', flow: 'in', amount: net, day, shift: s, driver_code: r.c.client_code, driver_name: cshDrvName(r.c.client_code), uber_uuid: r.uuid || null,
      contract_num: r.c.num, vehicle_key: r.c.vehicle_key || null, uber_cash: r.uber, given: g, change: ch, source: 'Chauffeur', comment: cm || null }); pageCaisse(); }
    catch (e) { b.disabled = false; alert(e.message); }
  }; });
  $('#cxsave').onclick = async () => {
    const who = cshResolve(cshVal('cxd')), gv = cshVal('cxg');
    if (!who.driver_name || gv === '') { alert('Chauffeur et montant remis obligatoires.'); return; }
    const g = cshN(gv), ch = cshN(cshVal('cxc')), net = cshR(g - ch);
    if (net < 0) { alert('La monnaie rendue dépasse le montant remis.'); return; }
    try { await cshInsert(Object.assign(who, { caisse: 'uber', kind: 'encaissement', flow: 'in', amount: net, day, shift: s, uber_cash: cshVal('cxu') === '' ? null : cshN(cshVal('cxu')), given: g, change: ch, source: 'Chauffeur', comment: cshVal('cxm') || null })); pageCaisse(); }
    catch (e) { alert(e.message); }
  };
  cshBindRowActions(); cshBindMoveForm();
}

// ---------- Dépenses ----------
function cshTabDep(p) {
  const rows = CS.moves.filter(m => m.caisse === 'depenses'), bal = cshBalances(CS.all);
  const cur = shiftAt(new Date(), S.P) || {};
  cshBody(cards([['Solde de la caisse dépenses', cshMoney(bal.depenses), bal.depenses < 0 ? 'crit' : 'ok'], ['Dépenses de la période', cshMoney(rows.filter(m => cshLive(m) && m.kind === 'depense').reduce((s, m) => s + cshN(m.amount), 0))],
      ['Justificatifs à fournir', f0(rows.filter(m => cshLive(m) && m.kind === 'depense' && m.driver_name && m.justif !== 'OK' && m.justif !== 'N.A').length)]]) +
    `<div class="panel"><h3>Nouvelle dépense (ticket par ticket)</h3><div class="mfrow">
      ${cshField('cdd', 'Date du shift', 'date', { value: cur.day || today() })}${cshField('cds', 'Shift', 'select', { options: ['Jour', 'Nuit'], value: cur.s })}
      ${cshField('cdw', 'Chauffeur', 'text', { list: 'cshdrv', size: 22 })}${cshField('cdc', 'Catégorie', 'select', { options: CASH_DEP_CATS })}
      ${cshField('cdr', 'Type de course', 'select', { options: CASH_RIDE_TYPES })}${cshField('cda', 'Montant (MAD)', 'number', { min: 0, step: 1 })}
      ${cshField('cdj', 'Justificatif', 'select', { options: [['En attente', 'En attente'], ['OK', 'OK (rangé)'], ['KO', 'KO (absent)'], ['N.A', 'N.A']] })}
      ${cshField('cdo', 'Source', 'select', { options: ['Chauffeur / Uber', 'Caisse - Dépenses', 'Banque'] })}${cshField('cdm', 'Commentaire', 'text', { size: 26 })}
      <button id="cdsave">Enregistrer</button></div>
      <div class="small">Tout décaissement sans justificatif OK est déduit de la paie du chauffeur (Paie). Les dépenses « Course Uber » justifiées réduisent le cash à remettre (Rapprochement Uber).</div></div>` +
    cshList('tcshdep', rows, [['Date', m => fmtDay(m.day) + (m.shift ? ' <span class="small">' + m.shift + '</span>' : ''), m => m.day], cshDrvCol(), ['Opération', m => esc(m.label || CSH_KIND[m.kind] || '') + (m.kind !== 'depense' ? ' <span class="small">(' + CSH_FLOW_TXT[m.flow] + ')</span>' : '')],
      ['Type', m => esc(m.ride_type || '')], ['Montant', m => cshMoney(m.amount), m => cshN(m.amount), 'n'],
      ['Justificatif', m => m.kind !== 'depense' ? esc(m.justif || '') : `<select data-cshj="${m.id}" ${m.cancelled_at ? 'disabled' : ''}>${['En attente', 'OK', 'KO', 'N.A'].map(x => `<option ${x === (m.justif || 'En attente') ? 'selected' : ''}>${x}</option>`).join('')}</select>`, m => m.justif || ''],
      ['Gestionnaire', m => esc(m.manager_name || '')], ['Commentaire', m => esc(m.comment || '')], cshActCol()], ['depense']) + cshMoveForm('depenses'));
  $('#cdsave').onclick = async () => {
    const a = cshN(cshVal('cda')); if (!(a > 0) || !cshVal('cdd')) { alert('Date et montant obligatoires.'); return; }
    const who = cshVal('cdw') ? cshResolve(cshVal('cdw')) : {};
    try { await cshInsert(Object.assign(who, { caisse: 'depenses', kind: 'depense', flow: 'out', amount: a, day: cshVal('cdd'), shift: cshVal('cds'), label: cshVal('cdc'), ride_type: cshVal('cdr'),
      justif: cshVal('cdj'), source: cshVal('cdo'), comment: cshVal('cdm') || null })); pageCaisse(); }
    catch (e) { alert(e.message); }
  };
  cshBindRowActions(); cshBindMoveForm();
}

// ---------- Avances RH ----------
function cshTabRh(p) {
  const rows = CS.moves.filter(m => m.caisse === 'rh'), bal = cshBalances(CS.all), by = {};
  rows.filter(m => cshLive(m) && m.kind === 'avance').forEach(m => { const k = m.driver_code || m.driver_name || '?'; by[k] = (by[k] || 0) + cshN(m.amount); });
  cshBody(cards([['Solde de la caisse RH', cshMoney(bal.rh), bal.rh < 0 ? 'crit' : 'ok'], ['Avances de la période', cshMoney(Object.values(by).reduce((s, v) => s + v, 0))], ['Chauffeurs concernés', f0(Object.keys(by).length)],
      ['Avances non signées', f0(rows.filter(m => cshLive(m) && m.kind === 'avance' && !m.signed).length)]]) +
    `<div class="panel"><h3>Nouvelle avance ou remboursement</h3><div class="mfrow">
      ${cshField('crd', 'Date', 'date', { value: today() })}${cshField('crw', 'Chauffeur', 'text', { list: 'cshdrv', size: 22 })}
      ${cshField('crk', 'Opération', 'select', { options: [['avance', 'Avance sur salaire'], ['remboursement', 'Remboursement d\'avance (entrée)']] })}
      ${cshField('crf', 'Mode', 'select', { options: [['out', 'Espèces (caisse RH)'], ['virement', 'Virement']] })}${cshField('cra', 'Montant (MAD)', 'number', { min: 0, step: 1 })}
      <label class="chk"><input type="checkbox" id="crg"> Avance signée par le chauffeur</label>${cshField('crm', 'Motif / commentaire', 'text', { size: 26, ph: 'Avance classique, médicaments…' })}<button id="crsave">Enregistrer</button></div>
      <div class="small">Avance : déjà versée, à déclarer et retenue sur la paie (Paie). Remboursement en espèces : ajouté à la caisse RH et à la paie.</div></div>` +
    cshList('tcshrh', rows, [['Date', m => fmtDay(m.day), m => m.day], cshDrvCol(), ['Opération', m => esc(CSH_KIND[m.kind] || m.kind) + (m.label && m.label !== CSH_KIND[m.kind] ? ' <span class="small">' + esc(m.label) + '</span>' : '')],
      ['Mode', m => esc(CSH_FLOW_TXT[m.flow] || '')], ['Montant', m => cshMoney(m.amount), m => cshN(m.amount), 'n'],
      ['Signée', m => m.kind === 'avance' ? `<input type="checkbox" data-cshg="${m.id}" ${m.signed ? 'checked' : ''} ${m.cancelled_at ? 'disabled' : ''} aria-label="Avance signée">` : ''],
      ['Gestionnaire', m => esc(m.manager_name || '')], ['Commentaire', m => esc(m.comment || '')], cshActCol()], ['avance', 'remboursement']) + cshMoveForm('rh'));
  $('#crsave').onclick = async () => {
    const a = cshN(cshVal('cra')), who = cshResolve(cshVal('crw')), k = cshVal('crk');
    if (!(a > 0) || !who.driver_name) { alert('Chauffeur et montant obligatoires.'); return; }
    try { await cshInsert(Object.assign(who, { caisse: 'rh', kind: k, flow: k === 'remboursement' ? (cshVal('crf') === 'virement' ? 'virement' : 'in') : cshVal('crf'), amount: a, day: cshVal('crd'),
      label: k === 'avance' ? 'Avance sur salaire' : 'Remboursement d\'avance', signed: k === 'avance' ? !!cshVal('crg') : null, source: cshVal('crf') === 'virement' ? 'Banque' : 'Caisse RH', comment: cshVal('crm') || null })); pageCaisse(); }
    catch (e) { alert(e.message); }
  };
  cshBindRowActions(); cshBindMoveForm();
}

// ---------- Courses privées ----------
async function cshTabCourses(p) {
  const my = ROUTING, pct0 = cshN(S.P.cashCommissionPct === undefined ? 10 : S.P.cashCommissionPct);
  let mis = [];
  try { mis = await all('missions', 'id,number,status,client_name,driver_name,vehicle_key,start_at,total_ttc,data', q => (CS.agId ? q.eq('agency_id', CS.agId) : q).in('status', ['Confirmée', 'En cours', 'Terminée', 'Facturée']).gte('start_at', dayBounds(addDays(p.from, -30)).start.toISOString()).lt('start_at', dayBounds(p.to).end.toISOString()), ['start_at', false]); }
  catch (e) { mis = []; }
  if (my !== ROUTING) return;
  const done = new Set((await all('cash_moves', 'id,mission_id', q => (CS.agId ? q.eq('agency_id', CS.agId) : q).not('mission_id', 'is', null).is('cancelled_at', null)).catch(() => [])).map(x => x.mission_id));
  if (my !== ROUTING) return;
  const todo = mis.filter(m => !done.has(m.id)), rows = CS.moves.filter(m => m.caisse === 'courses'), bal = cshBalances(CS.all), live = rows.filter(m => cshLive(m) && m.kind === 'course');
  const sel = CS.selMission ? mis.find(m => m.id === CS.selMission) : null, f = (sel && sel.data && sel.data.f) || {};
  cshBody(cards([['Solde de la caisse courses privées', cshMoney(bal.courses), bal.courses < 0 ? 'crit' : 'ok'], ['Encaissé sur la période', cshMoney(live.reduce((s, m) => s + cshN(m.amount), 0))],
      ['Montant des courses', cshMoney(live.reduce((s, m) => s + cshN(m.course_amount), 0))], ['Primes chauffeurs', cshMoney(live.reduce((s, m) => s + cshN(m.prime), 0))],
      ['Primes restant à payer', cshMoney(live.reduce((s, m) => s + cshN(m.prime) - cshN(m.prime_paid), 0))], ['Courses Ludy à encaisser', f0(todo.length), todo.length ? 'warn' : '']]) +
    (todo.length ? '<h3>Courses Ludy pas encore encaissées</h3>' + table('tcshtodo', [['N°', m => `<a href="#/courses?id=${m.id}">${esc(m.number || '#' + m.id)}</a>`], ['Début', m => fmtDTY(m.start_at), m => m.start_at], ['Client', m => esc(m.client_name || '')],
      ['Chauffeur', m => esc(m.driver_name || '')], ['Statut', m => esc(m.status)], ['Montant TTC', m => m.total_ttc == null ? '' : cshMoney(m.total_ttc), m => cshN(m.total_ttc), 'n'], ['', m => `<button class="small" data-cshms="${m.id}">Encaisser</button>`]], todo, { total: cshTot() }) : '') +
    `<div class="panel" id="cshcform"><h3>Encaissement d'une course privée${sel ? ' · ' + esc(sel.number || '') : ''}</h3><div class="mfrow">
      ${cshField('ccd', 'Date d\'encaissement', 'date', { value: today() })}${cshField('ccw', 'Chauffeur', 'text', { list: 'cshdrv', size: 22, value: sel ? sel.driver_name || '' : '' })}
      ${cshField('ccf', 'Départ', 'text', { size: 18, value: f.startAddr || f.startCity || '' })}${cshField('cct', 'Arrivée', 'text', { size: 18, value: f.endAddr || f.endCity || f.dest || '' })}
      ${cshField('cca', 'Montant de la course (MAD)', 'number', { min: 0, value: sel && sel.total_ttc != null ? sel.total_ttc : '' })}${cshField('ccp', 'Prime chauffeur (%)', 'number', { min: 0, step: 0.5, value: pct0, w: 80 })}
      ${cshField('ccr', 'Montant remis en caisse (MAD)', 'number', { min: 0 })}${cshField('ccm', 'Commentaire', 'text', { size: 24 })}<button id="ccsave">Encaisser</button></div>
      <div class="small" id="cccalc"></div></div>` +
    cshList('tcshcrs', rows, [['Date', m => fmtDay(m.day), m => m.day], cshDrvCol(), ['Opération', m => m.kind === 'course' ? esc(m.label || 'Course privée') + (m.mission_id ? ' <a class="small" href="#/courses?id=' + m.mission_id + '">fiche</a>' : '') : esc(CSH_KIND[m.kind] || m.kind)],
      ['Course', m => m.course_amount == null ? '' : cshMoney(m.course_amount), m => cshN(m.course_amount), 'n'], ['Encaissé', m => (m.flow === 'out' ? '−' : '') + cshMoney(m.amount), m => cshN(m.amount), 'n'],
      ['Prime', m => m.prime == null ? '' : cshMoney(m.prime) + (m.commission_pct != null ? ' <span class="small">(' + f1(m.commission_pct) + ' %)</span>' : ''), m => cshN(m.prime), 'n'],
      ['Déjà gardée', m => m.prime_paid == null ? '' : cshMoney(m.prime_paid), m => cshN(m.prime_paid), 'n'], ['Reste à payer', m => m.kind === 'course' ? cshSignedTxt(cshN(m.prime) - cshN(m.prime_paid)) : '', m => cshN(m.prime) - cshN(m.prime_paid), 'n'],
      ['Commentaire', m => esc(m.comment || '')], cshActCol()], ['course']) + cshMoveForm('courses'));
  const calc = () => { const c = cshCourse(cshVal('cca'), cshVal('ccp'), cshVal('ccr') === '' ? cshVal('cca') : cshVal('ccr'));
    $('#cccalc').innerHTML = cshVal('cca') === '' ? 'Prime = montant de la course × prime (%). Si le chauffeur garde sa prime, saisir le montant remis : la part gardée est comptée comme déjà payée.' :
      `Prime ${cshMoney(c.prime)} · déjà gardée par le chauffeur ${cshMoney(c.paid)} · reste à payer sur la paie ${cshSignedTxt(c.reste)}`; };
  ['cca', 'ccp', 'ccr'].forEach(id => { $('#' + id).oninput = calc; }); calc();
  document.querySelectorAll('[data-cshms]').forEach(b => { b.onclick = () => { CS.selMission = +b.dataset.cshms; cshTabCourses(p); setTimeout(() => { const x = $('#cshcform'); if (x) x.scrollIntoView({ block: 'center' }); }, 50); }; });
  $('#ccsave').onclick = async () => {
    const ca = cshN(cshVal('cca')), rv = cshVal('ccr'), who = cshResolve(cshVal('ccw'));
    if (!(ca > 0) || rv === '' || !who.driver_name) { alert('Chauffeur, montant de la course et montant remis obligatoires.'); return; }
    const c = cshCourse(ca, cshVal('ccp'), rv);
    try { await cshInsert(Object.assign(who, { caisse: 'courses', kind: 'course', flow: 'in', amount: cshN(rv), day: cshVal('ccd'), mission_id: sel ? sel.id : null, vehicle_key: sel ? sel.vehicle_key : null,
      course_amount: ca, commission_pct: cshN(cshVal('ccp')), prime: c.prime, prime_paid: c.paid, label: [cshVal('ccf'), cshVal('cct')].filter(Boolean).join(' → ') || null, source: 'Chauffeur',
      comment: [sel ? 'Course ' + (sel.number || '') : '', cshVal('ccm')].filter(Boolean).join(' · ') || null })); CS.selMission = null; pageCaisse(); }
    catch (e) { alert(e.message); }
  };
  cshBindRowActions(); cshBindMoveForm();
}

// ---------- Bonus ----------
function cshTabBonus(p) {
  const rows = CS.moves.filter(m => m.caisse === 'bonus'), bal = cshBalances(CS.all), live = rows.filter(m => cshLive(m) && m.kind === 'bonus');
  cshBody(cards([['Solde de la caisse bonus', cshMoney(bal.bonus), bal.bonus < 0 ? 'crit' : 'ok'], ['Bonus payés', cshMoney(live.filter(m => m.status !== 'A payer').reduce((s, m) => s + cshN(m.amount), 0))],
      ['Bonus à payer', cshMoney(live.filter(m => m.status === 'A payer').reduce((s, m) => s + cshN(m.amount), 0))]]) +
    `<div class="panel"><h3>Nouveau bonus</h3><div class="mfrow">${cshField('cbd', 'Date', 'date', { value: today() })}${cshField('cbw', 'Chauffeur', 'text', { list: 'cshdrv', size: 22 })}
      ${cshField('cbm', 'Motif', 'select', { options: CASH_BONUS })}${cshField('cba', 'Montant (MAD)', 'number', { min: 0, step: 1 })}${cshField('cbs', 'Statut', 'select', { options: ['Payé', 'A payer'] })}
      ${cshField('cbo', 'Source', 'select', { options: ['Caisse', 'Banque', 'Cash Nico'] })}${cshField('cbc', 'Commentaire', 'text', { size: 24 })}<button id="cbsave">Enregistrer</button></div>
      <div class="small">Payé : sorti de la caisse, à déclarer sur la paie. À payer : ajouté à la paie (pas encore sorti de la caisse).</div></div>` +
    cshList('tcshbon', rows, [['Date', m => fmtDay(m.day), m => m.day], cshDrvCol(), ['Motif', m => esc(m.label || CSH_KIND[m.kind])], ['Montant', m => cshMoney(m.amount), m => cshN(m.amount), 'n'],
      ['Statut', m => m.kind !== 'bonus' ? '' : `<select data-cshs="${m.id}" ${m.cancelled_at ? 'disabled' : ''}>${['Payé', 'A payer'].map(x => `<option ${x === (m.status || 'Payé') ? 'selected' : ''}>${x}</option>`).join('')}</select>`, m => m.status || ''],
      ['Gestionnaire', m => esc(m.manager_name || '')], ['Commentaire', m => esc(m.comment || '')], cshActCol()], ['bonus']) + cshMoveForm('bonus'));
  $('#cbsave').onclick = async () => {
    const a = cshN(cshVal('cba')), who = cshResolve(cshVal('cbw')), st = cshVal('cbs');
    if (!(a > 0) || !who.driver_name) { alert('Chauffeur et montant obligatoires.'); return; }
    // « A payer » : pas encore sorti de la caisse (statut changé en « Payé » au paiement)
    try { await cshInsert(Object.assign(who, { caisse: 'bonus', kind: 'bonus', flow: st === 'Payé' && cshVal('cbo') !== 'Banque' ? 'out' : 'virement', amount: a, day: cshVal('cbd'), label: cshVal('cbm'), status: st, source: cshVal('cbo'), comment: cshVal('cbc') || null })); pageCaisse(); }
    catch (e) { alert(e.message); }
  };
  // statut changé : la base met à jour la sortie de caisse (« Payé » en espèces = sortie, « A payer » ou par banque = hors caisse)
  document.querySelectorAll('[data-cshs]').forEach(s => { s.onchange = async () => { if (await cshPatch(+s.dataset.cshs, { status: s.value }, s)) pageCaisse(); }; });
  document.querySelectorAll('[data-cshx]').forEach(b => { b.onclick = () => cshCancel(+b.dataset.cshx); });
  document.querySelectorAll('[data-cshh]').forEach(b => { b.onclick = () => cshHistory(+b.dataset.cshh); });
  cshBindMoveForm();
}

// ---------- Rapprochement Uber ----------
function cshRapCols() {
  return [['Chauffeur', r => esc(r.name || r.key) + (r.key.indexOf('U:') === 0 ? ' <span class="small" title="Chauffeur Uber non relié à un chauffeur Ludy">(Uber)</span>' : '')],
    ['Espèces Uber', r => cshMoney(r.uber), r => r.uber, 'n'], ['Frais Uber justifiés', r => cshMoney(r.frais), r => r.frais, 'n'], ['Théorique à remettre', r => cshMoney(r.theo), r => r.theo, 'n'],
    ['Encaissé net', r => cshMoney(r.net), r => r.net, 'n'], ['Écart', r => r.ecart > 0 ? '<b class="red">' + cshMoney(r.ecart) + '</b>' : r.ecart < 0 ? '<b class="warn">' + cshMoney(r.ecart) + '</b>' : cshMoney(0), r => r.ecart, 'n'],
    ['Effet paie', r => esc(r.effet)], ['Statut', r => badge(r.statut, CSH_ST_CLS[r.statut]), r => r.statut], ['Taux de collecte', r => r.theo ? f0(r.taux * 100) + ' %' : '', r => r.taux, 'n']];
}
function cshTabRappro(p) {
  const rap = cshRap(p), tot = k => cshR(rap.reduce((s, r) => s + r[k], 0));
  const man = cshR(rap.reduce((s, r) => s + Math.max(0, r.ecart), 0)), exc = cshR(rap.reduce((s, r) => s + Math.max(0, -r.ecart), 0));
  cshBody(cshUberWarn(p) + cards([['Espèces déclarées Uber', cshMoney(tot('uber'))], ['Dépenses Uber justifiées', cshMoney(tot('frais'))], ['Espèces encaissées nettes', cshMoney(tot('net'))],
      ['Manquant à retenir', cshMoney(man), man ? 'crit' : 'ok'], ['Excédent à ajouter', cshMoney(exc), exc ? 'warn' : '']]) +
    `<div class="small">Espèces Uber attribuées au shift du contrat du chauffeur (sinon au jour de la transaction). Frais justifiés = dépenses « Course Uber » au justificatif OK. Écart = théorique − encaissé : positif = manquant (retenu sur la paie), négatif = excédent (ajouté).</div>
    <div class="bar"><button class="ghost small" id="cshrpdf">PDF</button><button class="ghost small" id="cshrxls">Tableur</button></div>` + table('tcshrap', cshRapCols(), rap, { empty: 'Aucune espèce Uber ni encaissement sur la période', total: cshTot(null, ['Taux de collecte']) }));
  $('#cshrpdf').onclick = () => { try { reportPdf(rptSimple({ kind: 'caisse', agency: CS.agName || undefined, title: 'Rapprochement des espèces Uber', period: fmtDay(p.from) + ' → ' + fmtDay(p.to), from: p.from, to: p.to,
    summary: [['Espèces Uber', cshMoney(tot('uber'))], ['Frais justifiés', cshMoney(tot('frais'))], ['Encaissé net', cshMoney(tot('net'))], ['Manquant', cshMoney(man)], ['Excédent', cshMoney(exc)]],
    tables: [colsTable('Par chauffeur', cshRapCols(), rap)], fileName: 'rapprochement_uber_' + p.from + '_' + p.to })); } catch (e) { alert(e.message); } };
  $('#cshrxls').onclick = () => cshXls('rapprochement_uber_' + p.from + '_' + p.to, cshRapCols(), rap);
}

// ---------- Paie ----------
function cshPaieCols() {
  return [['Chauffeur', r => esc(r.name || r.key)], ['Manquant cash', r => r.manquant ? '<span class="red">−' + cshMoney(r.manquant) + '</span>' : '', r => r.manquant, 'n'],
    ['Excédent cash', r => r.excedent ? '+' + cshMoney(r.excedent) : '', r => r.excedent, 'n'], ['Dépenses sans justificatif', r => r.depKo ? '<span class="red">−' + cshMoney(r.depKo) + '</span> <span class="small">(' + r.nDepKo + ')</span>' : '', r => r.depKo, 'n'],
    ['Avances', r => r.avances ? '<span class="red">−' + cshMoney(r.avances) + '</span>' : '', r => r.avances, 'n'], ['Remboursements', r => r.rembours ? '+' + cshMoney(r.rembours) : '', r => r.rembours, 'n'],
    ['Primes courses privées', r => r.primes ? cshMoney(r.primes) + (r.primePaid ? ' <span class="small">dont ' + cshMoney(r.primePaid) + ' gardés</span>' : '') : '', r => r.primes, 'n'],
    ['Bonus', r => r.bonusPaid || r.bonusToPay ? cshMoney(r.bonusPaid + r.bonusToPay) + (r.bonusToPay ? ' <span class="small">dont ' + cshMoney(r.bonusToPay) + ' à payer</span>' : '') : '', r => r.bonusPaid + r.bonusToPay, 'n'],
    ['Effet net sur la paie', r => cshSignedTxt(r.impact), r => r.impact, 'n'], ['Déjà versé / à déclarer', r => cshMoney(r.declarer), r => r.declarer, 'n']];
}
function cshTabPaie(p) {
  const pay = cshPayroll({ payments: CS.pay, moves: CS.moves, from: p.from, to: p.to, uuid2code: CS.uuid2code, dayOfPayment: cshPayDay, names: CS.names });
  const tot = k => cshR(pay.reduce((s, r) => s + r[k], 0));
  cshBody(cshUberWarn(p) + cards([['Retenues (manquants, dépenses sans justificatif, avances)', cshMoney(tot('manquant') + tot('depKo') + tot('avances')), 'crit'], ['Ajouts (excédents, remboursements, primes, bonus à payer)', cshMoney(tot('excedent') + tot('rembours') + tot('primeReste') + tot('bonusToPay'))],
      ['Effet net total', cshSignedTxt(tot('impact'))], ['Chauffeurs concernés', f0(pay.length)]]) +
    `<div class="small">Règles du classeur : manquant d'espèces Uber retenu, excédent ajouté ; dépense sans justificatif OK retenue ; avance déjà versée retenue ; prime de course privée ajoutée (moins la part gardée par le chauffeur) ; bonus « A payer » ajouté. Choisir la période de paie ci-dessus.</div>
    <div class="bar"><button class="ghost small" id="cshppdf">PDF</button><button class="ghost small" id="cshpxls">Tableur</button></div>` + table('tcshpay', cshPaieCols(), pay, { empty: 'Aucun effet sur la paie sur la période', total: cshTot() }));
  $('#cshppdf').onclick = () => { try { reportPdf(rptSimple({ kind: 'caisse', agency: CS.agName || undefined, title: 'Effet de la caisse sur la paie', period: fmtDay(p.from) + ' → ' + fmtDay(p.to), from: p.from, to: p.to,
    summary: [['Effet net total', cshMoney(tot('impact'))], ['Chauffeurs', f0(pay.length)]], tables: [colsTable('Par chauffeur', cshPaieCols(), pay)], fileName: 'paie_caisse_' + p.from + '_' + p.to })); } catch (e) { alert(e.message); } };
  $('#cshpxls').onclick = () => cshXls('paie_caisse_' + p.from + '_' + p.to, cshPaieCols(), pay);
}

// ---------- Chiffre d'affaires ----------
function cshTabCA(p) {
  const q = qs(), by = q.get('par') === 'jour' ? 'day' : 'week';
  const ca = cshCA({ payments: CS.pay, from: p.from, to: p.to, by, uuid2code: CS.uuid2code, dayOfPayment: cshPayDay, names: CS.names });
  const priv = {}; CS.moves.filter(m => cshLive(m) && m.kind === 'course').forEach(m => { const c = by === 'week' ? cshWeek(m.day) : m.day; priv[c] = cshR((priv[c] || 0) + cshN(m.course_amount)); });
  const lab = c => by === 'week' ? 'Sem. du ' + fmtDay(c).slice(0, 5) : fmtDay(c).slice(0, 5);
  const cols = [['Chauffeur', r => esc(r.name || r.key)]].concat(ca.cols.map(c => [lab(c), r => r.v[c] ? cshMoney(r.v[c]) : '', r => r.v[c] || 0, 'n'])).concat([['Total', r => '<b>' + cshMoney(r.total) + '</b>', r => r.total, 'n']]);
  cshBody(cshUberWarn(p) + cards([['Chiffre d\'affaires Uber', cshMoney(ca.sum)], ['Courses privées', cshMoney(Object.values(priv).reduce((s, v) => s + v, 0))], ['Chauffeurs actifs', f0(ca.rows.length)],
      ['CA moyen par chauffeur', ca.rows.length ? cshMoney(ca.sum / ca.rows.length) : '—']]) +
    `<div class="bar"><span>Par</span> <a class="${by === 'week' ? 'on' : ''}" href="${cshHref('ca', { par: 'semaine' })}">semaine</a> · <a class="${by === 'day' ? 'on' : ''}" href="${cshHref('ca', { par: 'jour' })}">jour</a>
      <button class="ghost small" id="cshcxls">Tableur</button></div>
    <div class="tw"><table class="cshca"><thead><tr><th></th>${ca.cols.map(c => `<th class="n">${lab(c)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>
      <tr><td>Chauffeurs actifs</td>${ca.cols.map(c => `<td class="n">${ca.active[c]}</td>`).join('')}<td class="n">${ca.rows.length}</td></tr>
      <tr><td><b>Total CA Uber</b></td>${ca.cols.map(c => `<td class="n"><b>${cshMoney(ca.total[c])}</b></td>`).join('')}<td class="n"><b>${cshMoney(ca.sum)}</b></td></tr>
      <tr><td>CA moyen / chauffeur</td>${ca.cols.map(c => `<td class="n">${ca.active[c] ? cshMoney(ca.total[c] / ca.active[c]) : '—'}</td>`).join('')}<td class="n">${ca.rows.length ? cshMoney(ca.sum / ca.rows.length) : '—'}</td></tr>
      <tr><td>Courses privées</td>${ca.cols.map(c => `<td class="n">${priv[c] ? cshMoney(priv[c]) : ''}</td>`).join('')}<td class="n">${cshMoney(Object.values(priv).reduce((s, v) => s + v, 0))}</td></tr></tbody></table></div>
    <h3>Par chauffeur</h3>` + table('tcshca', cols, ca.rows, { empty: 'Aucune transaction Uber sur la période', total: cshTot() }) +
    '<div class="small">Chiffre d\'affaires Uber = « Vos revenus » de l\'export Uber (comme le classeur), attribué au shift du contrat du chauffeur. Base pour la rentabilité : à rapprocher des dépenses, primes, bonus et du carburant (Consommation).</div>');
  $('#cshcxls').onclick = () => cshXls('chiffre_affaires_' + p.from + '_' + p.to, cols, ca.rows);
}

// ---------- Journal ----------
function cshJournalCols() {
  return [['Date', m => fmtDay(m.day) + (m.shift ? ' <span class="small">' + m.shift + '</span>' : ''), m => m.day], ['Caisse', m => esc((CASH_CAISSES.find(c => c[0] === m.caisse) || [])[1] || m.caisse)],
    ['Opération', m => esc(CSH_KIND[m.kind] || m.kind) + (m.label && m.label !== CSH_KIND[m.kind] ? ' <span class="small">' + esc(m.label) + '</span>' : '')], cshDrvCol(),
    ['Entrée / sortie', m => esc(CSH_FLOW_TXT[m.flow] || '')], ['Montant', m => (m.cancelled_at ? '<s>' : '') + cshMoney(m.amount) + (m.cancelled_at ? '</s>' : ''), m => cshN(m.amount), 'n'],
    ['Effet caisse', m => cshSignedTxt(cshSigned(m)), m => cshSigned(m), 'n'], ['Justif / statut', m => esc([m.justif, m.status, m.signed ? 'signée' : ''].filter(Boolean).join(' · '))],
    ['Gestionnaire', m => esc(m.manager_name || '')], ['Commentaire', m => esc(m.comment || '')]];
}
function cshTabJournal(p) {
  const q = qs(), fc = q.get('caisse') || '', fd = q.get('chauffeur') || '';
  const rows = CS.moves.filter(m => (!fc || m.caisse === fc) && (!fd || cshName(m.driver_code ? cshDrvName(m.driver_code) : m.driver_name).indexOf(cshName(fd)) >= 0));
  cshBody(`<div class="bar"><label>Caisse <select id="cshjc"><option value="">Toutes</option>${CASH_CAISSES.map(c => `<option value="${c[0]}" ${c[0] === fc ? 'selected' : ''}>${c[1]}</option>`).join('')}</select></label>
      <label>Chauffeur <input id="cshjd" list="cshdrv" value="${esc(fd)}" size="20"></label><button class="ghost small" id="cshjx">Tableur</button><span class="small">${rows.length} mouvements</span></div>` +
    cshList('tcshjrn', rows, cshJournalCols().concat([cshActCol()]), null, ['Montant']) + '<div id="cshlog"></div>');
  const go = () => { location.hash = cshHref('journal', { caisse: $('#cshjc').value, chauffeur: $('#cshjd').value }); };
  $('#cshjc').onchange = go; $('#cshjd').onchange = go;
  $('#cshjx').onclick = () => cshXls('journal_caisse_' + p.from + '_' + p.to, cshJournalCols(), rows);
  cshBindRowActions();
}
async function cshHistory(id) {
  const box = $('#cshlog') || $('#cshbody'); if (!box) return;
  const r = await sb.from('cash_log').select('*').eq('move_id', id).order('id');
  if (r.error) { alert(r.error.message); return; }
  if (!CS.users) { CS.users = {}; ((await sb.from('profiles').select('user_id,email')).data || []).forEach(u => { CS.users[u.user_id] = u.email; }); }
  const diff = l => { if (!l.old) return 'création'; if (!l.new) return 'suppression'; return Object.keys(l.new).filter(k => !['updated_at', 'updated_by'].includes(k) && JSON.stringify(l.new[k]) !== JSON.stringify(l.old[k])).map(k => k + ' : ' + (l.old[k] == null ? '—' : l.old[k]) + ' → ' + (l.new[k] == null ? '—' : l.new[k])).join(' ; ') || 'aucun changement'; };
  const div = document.createElement('div'); div.className = 'panel';
  div.innerHTML = `<h3>Historique du mouvement n° ${id}</h3>` + table('tcshlog', [['Le', l => fmtDTY(l.at)], ['Par', l => esc(CS.users[l.by] || l.by || '')], ['Changement', l => esc(diff(l)), null, 'wide']], r.data || []);
  box.prepend(div); div.scrollIntoView({ block: 'nearest' });
}
/** Export tableur (colonnes d'un tableau de page) */
function cshXls(name, cols, rows) {
  if (!window.XLSX) { alert('Bibliothèque tableur non chargée, réessayez dans un instant.'); return; }
  const aoa = [cols.filter(c => c[0]).map(c => txtOf(c[0]))].concat(rows.map(r => cols.filter(c => c[0]).map(c => { const v = c[2] ? c[2](r) : txtOf(c[1](r)); return typeof v === 'number' ? Math.round(v * 100) / 100 : txtOf(c[1](r)); })));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Ludy'); XLSX.writeFile(wb, name + '.xlsx');
}

// ---------- Imports ----------
function cshTabImport() {
  const unmapped = CS.udrv.filter(u => !CS.uuid2code[u.uuid]), mapped = CS.drivers.filter(d => d.uber_uuid);
  const sugg = u => cshMatchDriver(u, CS.drivers.filter(d => !d.uber_uuid));
  cshBody(`<div class="grid2"><div class="panel"><h3>1. Export Uber « Opérations de paiement »</h3><p class="small">Portail Uber Fleet &gt; Rapports &gt; Opérations de paiement (CSV), ou l'onglet du classeur. Chaque transaction n'est enregistrée qu'une fois (réimporter n'ajoute pas de doublon). Espèces collectées et revenus (chiffre d'affaires) par chauffeur.</p>
      <input type="file" id="cshfp" accept=".csv,.xlsx,.xls"><div id="cshfpr"></div></div>
    <div class="panel"><h3>2. Export Uber « Driver Status »</h3><p class="small">Liste des chauffeurs Uber (UUID, téléphone) : relie chaque chauffeur Uber à son chauffeur Ludy (même téléphone, sinon même nom).</p>
      <input type="file" id="cshfd" accept=".csv,.xlsx,.xls"><div id="cshfdr"></div></div></div>
    ${isAdmin() ? `<div class="panel"><h3>3. Historique du classeur « Suivi Cash Chauffeurs »</h3><p class="small">Google Sheets &gt; Fichier &gt; Télécharger &gt; Microsoft Excel (.xlsx), puis choisir le fichier : onglets Caisse (encaissements, dépenses, avance RH, courses indep, bonus), exports Uber. Réimporter le même classeur n'ajoute pas de doublon. Administrateur seulement.</p>
      <input type="file" id="cshfh" accept=".xlsx"><div id="cshfhr"></div></div>` : ''}
    ${isAdmin() && CS.agId ? `<div class="panel"><h3>4. Classeur de sauvegarde${CS.agName ? ' · ' + esc(CS.agName) : ''}</h3><p class="small">Chaque saisie de la caisse de cette agence est recopiée dans ce classeur Google Sheets (onglets « … Ludy ») toutes les 5 minutes. Coller le lien du classeur (vide = pas de copie).</p>${S.P.cashSheetStatus ? `<p class="small">Dernier passage du collecteur : <b>${esc(S.P.cashSheetStatus)}</b></p>` : ''}
      <div class="mfrow"><input id="cshsheet" size="60" placeholder="https://docs.google.com/spreadsheets/d/…"><button class="small" id="cshsheetok">Enregistrer</button></div><div id="cshsheetr"></div></div>` : ''}
    <h3>Chauffeurs Uber non reliés à un chauffeur Ludy (${unmapped.length})</h3>
    ${table('tcshmap', [['Chauffeur Uber', u => esc(u.name || '')], ['Téléphone', u => esc(u.phone || '')], ['Statut Uber', u => esc(u.status || '')],
      ['Chauffeur Ludy', u => { const s = sugg(u); return `<select data-cshmap="${esc(u.uuid)}"><option value="">—</option>${CS.drivers.filter(d => !d.uber_uuid).map(d => `<option value="${esc(d.code)}" ${s && s.code === d.code ? 'selected' : ''}>${esc(d.name || d.code)}</option>`).join('')}</select>${s ? ' <span class="small">proposé</span>' : ''}`; }],
      ['', u => `<button class="small" data-cshmapok="${esc(u.uuid)}">Relier</button>`]], unmapped, { empty: 'Tous les chauffeurs Uber importés sont reliés.', page: true })}
    <details class="panel"><summary><h3>Chauffeurs reliés (${mapped.length})</h3></summary>${table('tcshmapd', [['Chauffeur Ludy', d => esc(d.name || d.code)], ['Chauffeur Uber', d => esc((CS.udrv.find(u => u.uuid === d.uber_uuid) || {}).name || d.uber_uuid)],
      ['', d => `<button class="ghost small" data-cshunmap="${esc(d.code)}">Délier</button>`]], mapped, { page: true })}</details>`);
  if (CS.flash) { const x = $('#' + CS.flash.id); if (x) x.innerHTML = CS.flash.html; CS.flash = null; }
  const shIn = $('#cshsheet');
  if (shIn) {
    sb.from('agencies').select('cash_sheet_id').eq('id', CS.agId).single().then(r => { if (r.data && r.data.cash_sheet_id) shIn.value = 'https://docs.google.com/spreadsheets/d/' + r.data.cash_sheet_id; });
    $('#cshsheetok').onclick = async () => { const v = shIn.value.trim(), m = v.match(/\/d\/([\w-]{20,})/) || v.match(/^([\w-]{20,})$/);
      if (v && !m) { $('#cshsheetr').innerHTML = msg('Lien de classeur Google Sheets non reconnu.', 'err'); return; }
      const r = await sb.from('agencies').update({ cash_sheet_id: m ? m[1] : null }).eq('id', CS.agId);
      $('#cshsheetr').innerHTML = r.error ? msg(esc(r.error.message), 'err') : msg(m ? 'Classeur enregistré : la caisse de l\'agence y sera recopiée au prochain passage du collecteur (5 min).' : 'Copie arrêtée pour cette agence.', 'ok'); };
  }
  const read = async (f, out) => { out.innerHTML = msg('Lecture du fichier…'); return cshReadBook(new Uint8Array(await f.arrayBuffer()), f.name); };
  const rowsOf = (wb, test) => { for (const n of wb.SheetNames) { const r = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }); if (test(r)) return r; } return null; };
  // base sans la migration 20261104000000_caisse_classeur.sql : transactions enregistrées sans la ligne complète de l'export
  const slim = rows => rows.map(r => { const o = Object.assign({}, r); delete o.first_name; delete o.last_name; delete o.raw; return o; });
  const withAg = rows => rows.map(r => CS.agId ? Object.assign(r, { agency_id: CS.agId }) : r);   // lignes de l'agence de la caisse
  const batch = async (tbl, rows, conflict, out, label) => { let n = 0; for (let i = 0; i < rows.length; i += 500) {
    let part = withAg(rows.slice(i, i + 500)), r = await sb.from(tbl).upsert(part, { onConflict: conflict, ignoreDuplicates: true });
    if (r.error && tbl === 'uber_payments' && /first_name|last_name|raw/.test(r.error.message)) r = await sb.from(tbl).upsert(slim(part), { onConflict: conflict, ignoreDuplicates: true });
    if (r.error) throw new Error(r.error.message); n += Math.min(500, rows.length - i); out.innerHTML = msg(label + ' : ' + n + ' / ' + rows.length + '…'); } };
  $('#cshfp').onchange = async e => { const f = e.target.files[0], out = $('#cshfpr'); if (!f) return;
    try { const wb = await read(f, out), rows = rowsOf(wb, r => cshParseUberPayments(r).rows.length > 0) || [], res = cshParseUberPayments(rows, localToDate);
      if (res.error || !res.rows.length) throw new Error(res.error || 'aucune transaction trouvée');
      await batch('uber_payments', res.rows, 'tx', out, 'Transactions');
      const d = res.rows.map(r => r.at).sort();
      out.innerHTML = msg(`<b>${res.rows.length} transactions lues</b> du ${fmtDTY(d[0])} au ${fmtDTY(d[d.length - 1])} (déjà présentes ignorées)${res.bad.length ? ', ' + res.bad.length + ' lignes sans heure ignorées' : ''}. Espèces : ${cshMoney(res.rows.reduce((s, r) => s + r.cash, 0))}.`, 'ok'); }
    catch (x) { out.innerHTML = msg('Erreur : ' + esc(x.message || x), 'err'); } };
  $('#cshfd').onchange = async e => { const f = e.target.files[0], out = $('#cshfdr'); if (!f) return;
    try { const wb = await read(f, out), rows = rowsOf(wb, r => cshParseUberDrivers(r).rows.length > 0) || [], res = cshParseUberDrivers(rows);
      if (res.error || !res.rows.length) throw new Error(res.error || 'aucun chauffeur trouvé');
      const up = await sb.from('uber_drivers').upsert(withAg(res.rows.map(r => Object.assign(r, { updated_at: new Date().toISOString() }))), { onConflict: 'uuid' }); if (up.error) throw new Error(up.error.message);
      const auto = await cshAutoMap(res.rows);
      CS.flash = { id: 'cshfdr', html: msg(`<b>${res.rows.length} chauffeurs Uber</b> enregistrés ; ${auto} reliés automatiquement à leur chauffeur Ludy (même téléphone ou même nom).`, 'ok') };
      await pageCaisse(); }
    catch (x) { out.innerHTML = msg('Erreur : ' + esc(x.message || x), 'err'); } };
  const fh = $('#cshfh'); if (fh) fh.onchange = async e => { const f = e.target.files[0], out = $('#cshfhr'); if (!f) return;
    try { const wb = await read(f, out), sheets = {}; wb.SheetNames.forEach(n => { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }); });
      // 1. chauffeurs et transactions Uber du classeur, 2. mouvements des caisses (chauffeurs reconnus par UUID Uber ou par nom)
      const dRows = Object.values(sheets).find(r => cshParseUberDrivers(r).rows.length > 0);
      let nd = 0; if (dRows) { const d = cshParseUberDrivers(dRows).rows; const up = await sb.from('uber_drivers').upsert(withAg(d), { onConflict: 'uuid' }); if (up.error) throw new Error(up.error.message); nd = await cshAutoMap(d); await cshLoad(today(), today()); }
      const pRows = Object.values(sheets).find(r => cshHeader(r, c => c === 'uuid de la transaction') >= 0);
      let np = 0; if (pRows) { const pr = cshParseUberPayments(pRows, localToDate).rows; await batch('uber_payments', pr, 'tx', out, 'Transactions Uber'); np = pr.length; }
      const h = cshParseHistory(sheets, { resolve: (n, u) => { const r = cshResolve(n, u); return { driver_code: r.driver_code, driver_name: r.driver_code ? cshDrvName(r.driver_code) : r.driver_name, uber_uuid: r.uber_uuid }; } });
      h.moves.forEach(m => { m.agency_id = CS.agId; });
      await batch('cash_moves', h.moves, 'import_key', out, 'Mouvements de caisse');
      out.innerHTML = msg(`<b>Historique repris</b> : ${h.moves.length} mouvements (${Object.keys(h.counts).map(k => ((CASH_CAISSES.find(c => c[0] === k) || [])[1] || k) + ' ' + h.counts[k]).join(', ')}), ${h.skipped} lignes vides ou à 0 MAD ignorées ; ${np} transactions Uber ; ${nd} chauffeurs Uber reliés. Lignes déjà reprises ignorées.`, 'ok'); }
    catch (x) { out.innerHTML = msg('Erreur : ' + esc(x.message || x), 'err'); } };
  document.querySelectorAll('[data-cshmapok]').forEach(b => { b.onclick = async () => { const u = b.dataset.cshmapok, s = document.querySelector('[data-cshmap="' + u + '"]'); if (!s.value) { alert('Choisir le chauffeur Ludy.'); return; }
    const r = await sb.from('drivers').update({ uber_uuid: u }).eq('code', s.value); if (r.error) { alert(r.error.message); return; } pageCaisse(); }; });
  document.querySelectorAll('[data-cshunmap]').forEach(b => { b.onclick = async () => { if (!confirm('Délier ce chauffeur de son compte Uber ?')) return; const r = await sb.from('drivers').update({ uber_uuid: null }).eq('code', b.dataset.cshunmap); if (r.error) { alert(r.error.message); return; } pageCaisse(); }; });
}
/** Classeur ou CSV : les exports Uber sont en UTF-8 (accents des en-têtes), lus comme texte ; sinon Windows-1252 */
function cshReadBook(buf, name) {
  if (!/\.(csv|txt)$/i.test(name || '')) return readBook(buf, name);
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.indexOf('\ufffd') >= 0) t = new TextDecoder('windows-1252').decode(buf);
  return XLSX.read(t.replace(/^\ufeff/, ''), { type: 'string', raw: true });
}
/** Relie automatiquement les chauffeurs Uber à leur chauffeur Ludy (même téléphone, sinon même nom) ; jamais un chauffeur déjà relié */
async function cshAutoMap(list) {
  const drv = await all('drivers', 'code,name,phone,uber_uuid'), used = new Set(drv.filter(d => d.uber_uuid).map(d => d.uber_uuid)); let n = 0;
  for (const u of list) {
    if (used.has(u.uuid)) continue;
    const d = cshMatchDriver(u, drv.filter(x => !x.uber_uuid)); if (!d) continue;
    const r = await sb.from('drivers').update({ uber_uuid: u.uuid }).eq('code', d.code); if (!r.error) { d.uber_uuid = u.uuid; used.add(u.uuid); n++; }
  }
  return n;
}
