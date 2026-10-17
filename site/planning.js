// Planning des gestionnaires : l'administrateur coche, par agence, qui est de service chaque jour en shift jour / nuit ;
// les véhicules de l'agence sont répartis automatiquement entre les gestionnaires de service (fonction shift_plan de la base).
// Chaque gestionnaire de service voit « Mes véhicules » dans le menu et peut limiter les pages à sa part.
// Chargé avant app.js : utilise ses outils (sb, S, all, rpc, msg, esc…) au moment de l'appel.

/** Shift en cours (règle des alertes : 7 h → 19 h jour, sinon nuit ; une nuit appartient au jour où elle commence) */
function planNow() { return shiftAt(new Date(), S.P || {}); }
/** Véhicules confiés à l'utilisateur pour le shift en cours (planning) ; relu quand le shift change */
async function mineLoad() {
  const cur = planNow(), k = cur ? cur.s + '|' + cur.day : '';
  if (S.mineKey === k) return;
  S.mineKey = k; S.mine = null; S.mineShift = cur;
  if (!cur || !S.session) return;
  try {
    const rows = await rpc('shift_plan', { p_day: cur.day, p_shift: cur.s });
    const me = (rows || []).filter(r => r.user_id === S.session.user.id);
    if (me.length) S.mine = new Set(me.map(r => r.vehicle_key));
  } catch (e) { /* planning pas encore installé (migration) : pas de filtre */ }
}
/** Filtre « Mes véhicules » actif : seulement pour un utilisateur de service, et s'il ne l'a pas désactivé */
function mineOn() { let off = ''; try { off = localStorage.getItem('mesveh') || ''; } catch (e) { } return !!(S.mine && off !== '0'); }
function mineFoot() {
  if (!S.mine) return '';
  const c = S.mineShift;
  return `<label class="agsel mine"><input type="checkbox" id="mineon" ${mineOn() ? 'checked' : ''}> Mes véhicules (${S.mine.size}) · shift ${c.s.toLowerCase()} du ${fmtDay(c.day).slice(0, 5)}</label>`;
}

async function pagePlanning() {
  const q = qs(), ags = S.agencies, my = ROUTING;
  if (!ags.length) { $('#page').innerHTML = `<div class="head"><h1>Planning des gestionnaires</h1></div>` + msg('Aucune agence : créez-en une dans <a href="#/agences">Agences</a> et rattachez-lui des véhicules et des gestionnaires.', 'warn'); return; }
  const ag = ags.some(a => String(a.id) === q.get('a')) ? q.get('a') : (agFilter() || String(ags[0].id));
  const cur = planNow(), monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(q.get('w') || '') ? q.get('w') : cur.day);
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(monday, i)), sel = { day: /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : cur.day, s: q.get('s') === 'Nuit' || q.get('s') === 'Jour' ? q.get('s') : cur.s };
  let users, links, plan, shifts;
  try {
    [users, links, shifts] = await Promise.all([all('profiles', 'user_id,email,role', null, ['email']), all('user_agencies', '*'),
      all('manager_shifts', '*', x => x.eq('agency_id', ag).gte('day', monday).lte('day', addDays(monday, 6)), ['day'])]);
    plan = await rpc('shift_plan', { p_day: sel.day, p_shift: sel.s });
  } catch (e) {
    $('#page').innerHTML = `<div class="head"><h1>Planning des gestionnaires</h1></div>` + msg('Planning pas encore installé : exécuter <b>supabase/migrations/20261029000000_planning.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message) + ')', 'err'); return;
  }
  if (my !== ROUTING) return;   // autre page demandée pendant le chargement
  // gestionnaires de l'agence (accès coché dans Agences) ; un ancien gestionnaire encore au planning reste affiché
  const inAg = new Set(links.filter(l => String(l.agency_id) === ag).map(l => l.user_id));
  const team = users.filter(u => (u.role === 'manager' && inAg.has(u.user_id)) || shifts.some(s => s.user_id === u.user_id));
  const on = (u, d, s) => shifts.some(x => x.user_id === u && x.day === d && x.shift === s);
  const nVeh = S.vehList.filter(v => String(v.agency_id) === ag && String(v.active || 'OUI').toUpperCase() !== 'NON').length;
  const link = o => '#/planning?' + new URLSearchParams(Object.assign({ a: ag, w: monday, d: sel.day, s: sel.s }, o));
  const mine = plan.filter(r => String(r.agency_id) === ag), byU = {};
  mine.forEach(r => { (byU[r.user_id] = byU[r.user_id] || { email: r.email, list: [] }).list.push(r); });
  const DN = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  $('#page').innerHTML = `<div class="head"><h1>Planning des gestionnaires</h1><div class="sub">Cochez qui est de service, par jour et par shift (jour ${num(S.P.shiftDay, 7)} h → ${num(S.P.shiftNight, 19)} h, nuit ensuite). Les véhicules de l'agence sont répartis automatiquement à parts égales entre les gestionnaires de service ; chacun les retrouve sous « Mes véhicules » dans le menu.</div></div>
    <div class="bar"><label>Agence <select id="plag">${agOptions(ag)}</select></label>
      <a class="btn small ghostb" href="${link({ w: addDays(monday, -7) })}">← Semaine précédente</a><b>Semaine du ${fmtDay(monday)}</b><a class="btn small ghostb" href="${link({ w: addDays(monday, 7) })}">Semaine suivante →</a>
      <button class="ghost small" id="plcopy">Reprendre la semaine précédente</button><span id="plres" class="small"></span></div>
    ${team.length ? `<div class="tw"><table class="plan"><thead><tr><th>Gestionnaire</th>${days.map((d, i) => `<th colspan="2" class="${d === cur.day ? 'today' : ''}">${DN[i]} ${fmtDay(d).slice(0, 5)}</th>`).join('')}</tr>
      <tr><th></th>${days.map(() => '<th class="small">Jour</th><th class="small">Nuit</th>').join('')}</tr></thead>
      <tbody>${team.map(u => `<tr><td>${esc(u.email)}${u.role !== 'manager' ? ` <span class="small">(${esc(ROLE_TXT[u.role] || u.role)})</span>` : ''}</td>${days.map(d => ['Jour', 'Nuit'].map(s =>
        `<td class="c"><input type="checkbox" class="plc" data-u="${u.user_id}" data-d="${d}" data-s="${s}" ${on(u.user_id, d, s) ? 'checked' : ''} aria-label="${esc(u.email)} ${s} ${fmtDay(d)}"></td>`).join('')).join('')}</tr>`).join('')}
      <tr class="tot"><td>Gestionnaires de service</td>${days.map(d => ['Jour', 'Nuit'].map(s => { const n = shifts.filter(x => x.day === d && x.shift === s).length;
        return `<td class="c"><a href="${link({ d, s })}" title="Répartition">${n ? n + ' · ' + Math.ceil(nVeh / n) : '<span class="crit">0</span>'}</a></td>`; }).join('')).join('')}</tr></tbody></table></div>
      <div class="small">Ligne du bas : gestionnaires de service · véhicules au plus par gestionnaire (${nVeh} véhicules actifs dans l'agence). Cliquez pour voir la répartition.</div>`
      : msg('Aucun gestionnaire n\'a accès à cette agence : cochez-les dans <a href="#/agences">Agences</a> (rôle Gestionnaire dans Réglages).', 'warn')}
    <h2>Répartition : shift ${sel.s.toLowerCase()} du ${fmtDay(sel.day)}${sel.day === cur.day && sel.s === cur.s ? ' (en cours)' : ''}</h2>
    ${Object.keys(byU).length ? `<div class="plsplit">${Object.values(byU).map(o => `<div class="panel"><b>${esc(o.email)}</b> <span class="small">${o.list.length} véhicule${o.list.length > 1 ? 's' : ''}</span><div>${o.list.map(r => plate(r.plate)).join(' ')}</div></div>`).join('')}</div>`
      : msg(nVeh ? 'Personne de service sur ce shift : les véhicules ne sont confiés à aucun gestionnaire (chacun voit toute son agence).' : 'Aucun véhicule actif dans cette agence.', 'warn')}`;
  $('#plag').onchange = e => { location.hash = link({ a: e.target.value }); };
  document.querySelectorAll('.plc').forEach(c => { c.onchange = async () => {
    const r = { agency_id: +ag, user_id: c.dataset.u, day: c.dataset.d, shift: c.dataset.s };
    const { error } = c.checked ? await sb.from('manager_shifts').insert(r)
      : await sb.from('manager_shifts').delete().eq('agency_id', r.agency_id).eq('user_id', r.user_id).eq('day', r.day).eq('shift', r.shift);
    if (error) { alert(error.message); c.checked = !c.checked; return; }
    S.mineKey = null; pagePlanning();
  }; });
  $('#plcopy').onclick = async () => {
    const prev = await all('manager_shifts', '*', x => x.eq('agency_id', ag).gte('day', addDays(monday, -7)).lte('day', addDays(monday, -1)));
    if (!prev.length) { $('#plres').textContent = 'Semaine précédente vide.'; return; }
    if (shifts.length && !confirm('Remplacer le planning de cette semaine par celui de la semaine précédente ?')) return;
    let r = await sb.from('manager_shifts').delete().eq('agency_id', ag).gte('day', monday).lte('day', addDays(monday, 6));
    if (!r.error) r = await sb.from('manager_shifts').insert(prev.map(x => ({ agency_id: x.agency_id, user_id: x.user_id, day: addDays(x.day, 7), shift: x.shift })));
    if (r.error) { alert(r.error.message); return; }
    S.mineKey = null; pagePlanning();
  };
}
