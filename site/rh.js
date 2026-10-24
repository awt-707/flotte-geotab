// Ressources humaines (dossier « Ressources humaines » du menu) : salariés (chauffeurs et staff), périodes d'essai,
// présences (chauffeurs : contrats Ludy ; staff : pointage sur Ludy), heures supplémentaires, absences, congés, arrêts
// maladie, avances et primes (saisies RH + Caisse), avenants, état mensuel ; pointage du staff (date de naissance à
// chaque ouverture de Ludy, pauses, fin de journée). Calculs purs dans rh_calc.js. Chargé avant app.js.

const RH_TABS = [['bord', 'Tableau de bord'], ['salaries', 'Salariés'], ['presences', 'Présences'], ['pointage', 'Pointage du staff'], ['absences', 'Absences et congés'],
  ['avances', 'Avances et primes'], ['avenants', 'Avenants'], ['essai', 'Périodes d\'essai'], ['mois', 'État mensuel'], ['travail', 'Contrats de travail']];
const RH_ADMIN_TABS = { pointage: 1 };
const RH_ABS = ['conge', 'maladie', 'absence'], RH_MONEY = ['avance', 'remboursement', 'prime'];
const RH_STATUS = { conge: ['Demandé', 'Validé', 'Refusé'], avance: ['À rembourser', 'Remboursée'], prime: ['À payer', 'Payée'] };
const RH = { emp: [], ev: [], employers: [], drivers: [], profiles: [], err: '' };

const rhTabsFor = () => RH_TABS.filter(x => !RH_ADMIN_TABS[x[0]] || isAdmin());
const rhHref = (t, extra) => t === 'travail' ? '#/travail' : '#/rh?t=' + t + (extra ? '&' + extra : '');
const rhMoney = v => v == null || v === '' ? '' : f0(Math.round(+v)) + ' DH';
const rhH = h => h == null ? '' : rhMin(h * 60);
const rhEmp = id => RH.emp.find(e => String(e.id) === String(id));
const rhAgOk = () => { const a = agFilter(); return e => !a || String(e.agency_id) === a; };
const rhOffset = t => tzOffsetMin(new Date(t));
const rhMonthNow = () => today().slice(0, 7);
const rhMonthTxt = m => { const n = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']; return n[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4); };

async function rhLoad() {
  const [emp, ev, employers, drivers] = await Promise.all([all('hr_employees', '*', null, ['name']), all('hr_events', '*', null, ['day_from', false]),
    all('employers', 'id,name,data,active', null, ['name']).catch(() => []), all('drivers', 'code,name,phone,agency_id', null, ['name']).catch(() => [])]);
  RH.emp = emp; RH.ev = ev; RH.employers = employers; RH.drivers = drivers.filter(d => d.code && d.code !== HORS);
  RH.profiles = isAdmin() ? await all('profiles', 'user_id,email,role', null, ['email']).catch(() => []) : [];
}

/** Dossier « Ressources humaines » */
async function pageRH() {
  const my = ROUTING, q = qs(), tabs = rhTabsFor(), t = q.get('t') === 'fiche' ? 'fiche' : tabs.some(x => x[0] === q.get('t')) ? q.get('t') : 'bord';
  const head = `<div class="head"><h1>Ressources humaines</h1><div class="sub">Salariés, présences (chauffeurs : contrats Ludy ; staff : pointage sur Ludy), heures supplémentaires, absences, congés, arrêts maladie, avances, primes, avenants et périodes d'essai.</div></div>`;
  if (!canEdit()) { $('#page').innerHTML = head + msg('Ressources humaines réservées aux gestionnaires et à l\'administrateur.', 'warn'); return; }
  const bar = `<div class="tabs">${tabs.map(x => `<a href="${rhHref(x[0])}" class="${t === x[0] || (t === 'fiche' && x[0] === 'salaries') ? 'on' : ''}">${x[1]}</a>`).join('')}</div>`;
  $('#page').innerHTML = head + bar + '<div class="loading">Chargement…</div>';
  try { await rhLoad(); } catch (e) {
    if (my !== ROUTING) return;
    $('#page').innerHTML = head + bar + msg('Ressources humaines pas encore installées dans la base : exécuter <b>supabase/migrations/20261110000000_rh.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message || e) + ')', 'err');
    return;
  }
  if (my !== ROUTING) return;
  const box = '<div id="rhbody"></div>';
  $('#page').innerHTML = head + bar + (isAdmin() ? '' : msg('Gestionnaire : chauffeurs des agences auxquelles vous êtes rattaché. Le staff est géré par l\'administrateur.', '')) + box;
  const V = { bord: rhBoard, salaries: rhList, fiche: rhFiche, presences: rhPresence, pointage: rhClockBoard, absences: rhAbsences, avances: rhAdvances, avenants: rhAvenants, essai: rhTrials, mois: rhMonthly };
  try { await V[t](my, q); } catch (e) { if (my === ROUTING) $('#rhbody').innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); }
}

// ---------- Tableau de bord ----------
async function rhBoard(my) {
  const ok = rhAgOk(), act = RH.emp.filter(e => !e.left_on && ok(e)), d0 = today(), P = S.P || {};
  const trials = act.map(e => [e, rhTrial(e, d0, num(P.rhAlertDays, 7))]).filter(x => x[1].alert).sort((a, b) => a[1].daysLeft - b[1].daysLeft);
  const ids = new Set(act.map(e => e.id)), cur = RH.ev.filter(x => ids.has(x.employee_id) && !x.cancelled_at && RH_ABS.includes(x.kind) && x.day_from <= d0 && (x.day_to || x.day_from) >= d0 && (x.kind !== 'conge' || x.status === 'Validé'));
  const pend = RH.ev.filter(x => ids.has(x.employee_id) && !x.cancelled_at && x.kind === 'conge' && x.status === 'Demandé');
  const inc = act.filter(e => !e.hired_on || e.salary == null || !e.employer_id || (e.pointage && !e.birth_date));
  const coded = new Set(RH.emp.map(e => e.driver_code).filter(Boolean)), noFile = RH.drivers.filter(d => !coded.has(d.code) && (!agFilter() || String(d.agency_id) === agFilter()));
  let live = '';
  if (isAdmin()) {
    const staff = act.filter(e => e.kind === 'staff' && e.pointage);
    if (staff.length) {
      const ck = await all('hr_clock', 'employee_id,kind,at', x => x.gte('at', new Date(Date.now() - 18 * HOUR).toISOString()).in('employee_id', staff.map(e => e.id)), ['at']).catch(() => []);
      if (my !== ROUTING) return;
      const st = staff.map(e => { const l = ck.filter(c => c.employee_id === e.id).map(c => ({ kind: c.kind, at: Date.parse(c.at) })); return [e, rhClockState(l)]; });
      live = `<div class="panel"><h2>Staff en ce moment</h2>${table('rhlive', [['Salarié', x => `<a href="${rhHref('fiche', 'id=' + x[0].id)}">${esc(x[0].name)}</a>`], ['État', x => rhStateTxt(x[1])]], st)}</div>`;
    }
  }
  const card = (l, v, h) => `<div class="card"><div class="cv">${v}</div><div class="cl">${l}</div>${h ? `<div class="small">${h}</div>` : ''}</div>`;
  $('#rhbody').innerHTML = `<div class="cards">${card('Salariés actifs', act.length, act.filter(e => e.kind === 'chauffeur').length + ' chauffeurs · ' + act.filter(e => e.kind === 'staff').length + ' staff')}
      ${card('Périodes d\'essai à décider', trials.length, 'fin dans ' + num(P.rhAlertDays, 7) + ' jours au plus')}${card('Absents aujourd\'hui', cur.length, 'congé validé, arrêt maladie, absence')}${card('Congés à valider', pend.length)}</div>
    ${noFile.length ? msg(noFile.length + ' chauffeur' + (noFile.length > 1 ? 's' : '') + ' de Ludy sans fiche RH : <a href="' + rhHref('salaries') + '">les créer depuis la liste des salariés</a>.', 'warn') : ''}
    ${trials.length ? `<div class="panel"><h2>Périodes d'essai à décider</h2>${table('rhtr', [['Salarié', x => rhLink(x[0])], ['Entrée', x => esc(fmtDay(x[0].hired_on))], ['État', x => esc(x[1].state)], ['Fin', x => esc(fmtDay(x[1].end))], ['Jours restants', x => String(x[1].daysLeft), null, 'num']], trials)}</div>` : ''}
    ${cur.length ? `<div class="panel"><h2>Absents aujourd'hui</h2>${table('rhab', [['Salarié', x => rhLink(rhEmp(x.employee_id))], ['Motif', x => esc(RH_KINDS[x.kind])], ['Du', x => esc(fmtDay(x.day_from))], ['Au', x => esc(fmtDay(x.day_to || x.day_from))]], cur)}</div>` : ''}
    ${pend.length ? `<div class="panel"><h2>Congés à valider</h2>${table('rhpd', [['Salarié', x => rhLink(rhEmp(x.employee_id))], ['Du', x => esc(fmtDay(x.day_from))], ['Au', x => esc(fmtDay(x.day_to || x.day_from))], ['Jours', x => esc(x.days == null ? '' : f1(x.days)), null, 'num'], ['', x => `<a href="${rhHref('absences', 'm=' + x.day_from.slice(0, 7))}">Valider</a>`]], pend)}</div>` : ''}
    ${live}
    ${inc.length ? `<div class="panel"><h2>Fiches incomplètes</h2>${table('rhinc', [['Salarié', e => rhLink(e)], ['Manque', e => esc([!e.employer_id && 'société', !e.hired_on && 'date d\'entrée', e.salary == null && 'salaire', e.pointage && !e.birth_date && 'date de naissance (pointage impossible)'].filter(Boolean).join(', '))]], inc)}</div>` : ''}`;
}
const rhLink = e => e ? `<a href="${rhHref('fiche', 'id=' + e.id)}">${esc(e.name)}</a>${e.left_on ? ' <span class="small">(sorti)</span>' : ''}` : '';
const rhStateTxt = s => s === 'on' ? '<span class="ok">● En service</span>' : s === 'pause' ? '<span class="warn">● En pause</span>' : '<span class="small">Hors service</span>';

// ---------- Salariés ----------
function rhList() {
  const q = qs(), kind = q.get('k') || '', stt = q.get('s') || 'actifs', ok = rhAgOk(), d0 = today();
  const rows = RH.emp.filter(e => ok(e) && (!kind || e.kind === kind) && (stt === 'tous' || (stt === 'sortis' ? !!e.left_on : !e.left_on)));
  const coded = new Set(RH.emp.map(e => e.driver_code).filter(Boolean)), noFile = RH.drivers.filter(d => !coded.has(d.code) && (!agFilter() || String(d.agency_id) === agFilter()));
  const emp = id => (RH.employers.find(x => x.id === id) || {}).name || '';
  const sel = (k, v, opts) => `<select data-rhf="${k}">${opts.map(o => `<option value="${o[0]}" ${o[0] === v ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  $('#rhbody').innerHTML = `<div class="bar">${sel('k', kind, [['', 'Chauffeurs et staff'], ['chauffeur', 'Chauffeurs'], ['staff', 'Staff']])}${sel('s', stt, [['actifs', 'En poste'], ['sortis', 'Sortis'], ['tous', 'Tous']])}
      <button id="rhnew">Nouveau salarié</button>${noFile.length ? `<button class="ghost" id="rhdrv">Créer les fiches des chauffeurs de Ludy (${noFile.length})</button>` : ''}</div><div id="rhform"></div>
    ${table('rhemp', [['Salarié', e => rhLink(e), e => e.name], ['Type', e => e.kind === 'staff' ? 'Staff' : 'Chauffeur'], ['Poste', e => esc(e.position || '')], ['Société', e => esc(emp(e.employer_id))],
      ['Agence', e => esc(S.agName[e.agency_id] || '')], ['Entrée', e => esc(fmtDay(e.hired_on)), e => e.hired_on || ''], ['Période d\'essai', e => { const t = rhTrial(e, d0); return esc(t.state + (t.open ? ' · fin ' + fmtDay(t.end) : '')); }],
      ['Salaire', e => rhMoney(rhSalaryAt(e, RH.ev.filter(x => x.employee_id === e.id), d0)), null, 'num'], ['Congés (solde)', e => { const l = rhLeave(e, RH.ev.filter(x => x.employee_id === e.id), d0); return l ? f1(l.balance) + ' j' : ''; }, null, 'num'],
      ['Pointage', e => e.kind === 'staff' ? (e.pointage ? 'Oui' : 'Non') : 'Contrats']], rows, { empty: 'Aucun salarié' })}`;
  document.querySelectorAll('[data-rhf]').forEach(s => s.onchange = () => { const p = qs(); p.set(s.dataset.rhf, s.value); p.set('t', 'salaries'); location.hash = '#/rh?' + p.toString(); });
  window.__rerender = rhList;
  $('#rhnew').onclick = () => rhEmpForm(null, $('#rhform'));
  if ($('#rhdrv')) $('#rhdrv').onclick = async () => {
    if (!confirm('Créer ' + noFile.length + ' fiche(s) chauffeur à partir des chauffeurs de Ludy (nom, téléphone, agence) ? La date d\'entrée, le salaire et la société seront à compléter.')) return;
    const rows = noFile.filter(d => isAdmin() || S.agencies.some(a => a.id === d.agency_id)).map(d => ({ kind: 'chauffeur', name: d.name, driver_code: d.code, phone: d.phone || null, agency_id: d.agency_id || null, position: 'Chauffeur' }));
    for (let i = 0; i < rows.length; i += 200) { const r = await sb.from('hr_employees').insert(rows.slice(i, i + 200)); if (r.error) { alert('Erreur : ' + r.error.message); break; } }
    route();
  };
}
const RH_EMP_FIELDS = [['name', 'Nom et prénom', 24], ['position', 'Poste', 16], ['cin', 'N° CIN', 11], ['birth_date', 'Date de naissance', 11, 'date'], ['phone', 'Téléphone', 13], ['email', 'E-mail', 22],
  ['hired_on', 'Date d\'entrée', 11, 'date'], ['salary', 'Salaire net d\'embauche (DH)', 9, 'num'], ['weekly_hours', 'Durée hebdomadaire (h)', 5, 'num'], ['leave_per_month', 'Congés acquis par mois (j)', 5, 'num'],
  ['trial_months', 'Période d\'essai (mois)', 5, 'num'], ['note', 'Note', 40]];
/** Formulaire de la fiche (création / modification) */
function rhEmpForm(e, box) {
  const v = Object.assign({ kind: 'chauffeur', weekly_hours: 44, leave_per_month: 1.5, trial_months: 1.5, trial_renewable: true, agency_id: S.agencies.length === 1 ? S.agencies[0].id : '' }, e || {});
  const dv = (k, t) => t === 'date' ? fmtDay(v[k]) : v[k] == null ? '' : v[k];
  const usedUsers = new Set(RH.emp.filter(x => x.user_id && (!e || x.id !== e.id)).map(x => x.user_id));
  box.innerHTML = `<div class="panel"><h2>${e ? 'Modifier la fiche' : 'Nouveau salarié'}</h2>
    <div class="mfrow"><label>Type <select id="rhe_kind" ${isAdmin() ? '' : 'disabled'}><option value="chauffeur" ${v.kind === 'chauffeur' ? 'selected' : ''}>Chauffeur (présence = contrats Ludy)</option>${isAdmin() ? `<option value="staff" ${v.kind === 'staff' ? 'selected' : ''}>Staff (présence = pointage sur Ludy)</option>` : ''}</select></label>
      <label>Société <select id="rhe_employer"><option value="">—</option>${RH.employers.map(x => `<option value="${x.id}" ${String(x.id) === String(v.employer_id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>Agence <select id="rhe_agency">${agOptions(v.agency_id, isAdmin() ? '— aucune —' : '— choisir —')}</select></label>
      <label id="rhe_drvl">Chauffeur de Ludy <select id="rhe_driver"><option value="">—</option>${RH.drivers.map(d => `<option value="${esc(d.code)}" ${d.code === v.driver_code ? 'selected' : ''}>${esc(d.name)} (${esc(d.code)})</option>`).join('')}</select></label></div>
    <div class="mfrow">${RH_EMP_FIELDS.map(f => `<label>${f[1]} <input data-rhe="${f[0]}" data-t="${f[3] || ''}" value="${esc(dv(f[0], f[3]))}" size="${f[2]}"${f[3] === 'date' ? ' placeholder="JJ/MM/AAAA" inputmode="numeric"' : f[3] === 'num' ? ' inputmode="decimal"' : ''}></label>`).join('')}
      <label class="chk"><input type="checkbox" id="rhe_renew" ${v.trial_renewable !== false ? 'checked' : ''}> Période d'essai renouvelable une fois</label></div>
    ${isAdmin() ? `<div class="mfrow" id="rhe_staff"><label>Compte Ludy du salarié <select id="rhe_user"><option value="">—</option>${RH.profiles.filter(p => !usedUsers.has(p.user_id)).map(p => `<option value="${p.user_id}" ${p.user_id === v.user_id ? 'selected' : ''}>${esc(p.email)}</option>`).join('')}</select></label>
      <label class="chk"><input type="checkbox" id="rhe_point" ${v.pointage ? 'checked' : ''}> Pointage obligatoire : date de naissance à chaque ouverture de Ludy, pauses, fin de journée</label></div>` : ''}
    <div class="mfgo"><button id="rhesave">Enregistrer</button> <button class="ghost" id="rhecancel">Annuler</button> <span id="rheres"></span></div></div>`;
  const kindSync = () => { const k = $('#rhe_kind').value; $('#rhe_drvl').hidden = k !== 'chauffeur'; if ($('#rhe_staff')) $('#rhe_staff').hidden = k !== 'staff'; };
  $('#rhe_kind').onchange = kindSync; kindSync();
  $('#rhe_driver').onchange = () => { const d = RH.drivers.find(x => x.code === $('#rhe_driver').value); if (!d) return;
    const n = $('[data-rhe="name"]'); if (!n.value.trim()) n.value = d.name; const p = $('[data-rhe="phone"]'); if (!p.value.trim() && d.phone) p.value = d.phone;
    if (d.agency_id && $(`#rhe_agency option[value="${d.agency_id}"]`)) $('#rhe_agency').value = String(d.agency_id); };
  $('#rhecancel').onclick = () => { box.innerHTML = ''; };
  $('#rhesave').onclick = async () => {
    const out = $('#rheres'), row = { kind: $('#rhe_kind').value, employer_id: +$('#rhe_employer').value || null, agency_id: +$('#rhe_agency').value || null, trial_renewable: $('#rhe_renew').checked };
    const bad = [];
    box.querySelectorAll('[data-rhe]').forEach(i => {
      const k = i.dataset.rhe, t = i.dataset.t, s = i.value.trim();
      if (t === 'date') { const d = ctrParseDate(s); if (d === null) bad.push(i.closest('label').firstChild.textContent.trim()); row[k] = d || null; }
      else if (t === 'num') { const n = s === '' ? null : num(s, NaN); if (n !== null && isNaN(n)) bad.push(i.closest('label').firstChild.textContent.trim()); row[k] = n; }
      else row[k] = s || null;
    });
    ['weekly_hours', 'leave_per_month', 'trial_months'].forEach(k => { if (row[k] == null) row[k] = k === 'weekly_hours' ? 44 : k === 'leave_per_month' ? 1.5 : 0; });
    row.driver_code = row.kind === 'chauffeur' ? ($('#rhe_driver').value || null) : null;
    if (isAdmin()) { row.user_id = row.kind === 'staff' ? ($('#rhe_user').value || null) : null; row.pointage = row.kind === 'staff' && $('#rhe_point').checked; }
    if (!row.name) bad.push('Nom et prénom');
    if (!isAdmin() && !row.agency_id) bad.push('Agence');
    if (row.pointage && !row.birth_date) bad.push('Date de naissance (obligatoire pour le pointage)');
    if (row.pointage && !row.user_id) bad.push('Compte Ludy (obligatoire pour le pointage)');
    if (bad.length) { out.innerHTML = '<span class="err">À corriger : ' + esc(bad.join(', ')) + '.</span>'; return; }
    const r = e ? await sb.from('hr_employees').update(row).eq('id', e.id).select('id').single() : await sb.from('hr_employees').insert(row).select('id').single();
    if (r.error) { out.innerHTML = '<span class="err">Erreur : ' + esc(/hr_employees_driver/.test(r.error.message) ? 'ce chauffeur a déjà une fiche' : /hr_employees_user/.test(r.error.message) ? 'ce compte Ludy est déjà rattaché à un salarié' : r.error.message) + '</span>'; return; }
    location.hash = rhHref('fiche', 'id=' + r.data.id); if (e) route();
  };
}

// ---------- Fiche du salarié ----------
async function rhFiche(my, q) {
  const e = rhEmp(q.get('id'));
  if (!e) { $('#rhbody').innerHTML = msg('Salarié introuvable (ou hors de vos agences).', 'err'); return; }
  const d0 = today(), ev = RH.ev.filter(x => x.employee_id === e.id), tr = rhTrial(e, d0, num((S.P || {}).rhAlertDays, 7)), lv = rhLeave(e, ev, d0), sal = rhSalaryAt(e, ev, d0);
  const wc = await all('work_contracts', 'id,created_at,effective_on,pdf_path,name,cin,driver_code,employee_id,data', x => x.or('employee_id.eq.' + e.id + (e.driver_code ? ',driver_code.eq.' + e.driver_code : '') + (e.cin ? ',cin.eq.' + e.cin : '')), ['created_at', false]).catch(() => []);
  if (my !== ROUTING) return;
  const emp = (RH.employers.find(x => x.id === e.employer_id) || {}).name || '';
  const kv = (k, v) => `<div class="kv"><span class="small">${k}</span><b>${v || '—'}</b></div>`;
  $('#rhbody').innerHTML = `<div class="bar"><a href="${rhHref('salaries')}">← Salariés</a></div>
    <div class="grid2 mfgrid"><div>
      <div class="panel"><h2>${esc(e.name)} ${e.left_on ? '<span class="small">(sorti le ' + esc(fmtDay(e.left_on)) + ')</span>' : ''}</h2>
        <div class="kvs">${kv('Type', e.kind === 'staff' ? 'Staff (pointage)' : 'Chauffeur (contrats Ludy)')}${kv('Poste', esc(e.position || ''))}${kv('Société', esc(emp))}${kv('Agence', esc(S.agName[e.agency_id] || ''))}
          ${kv('Date d\'entrée', esc(fmtDay(e.hired_on)))}${kv('Salaire actuel', rhMoney(sal))}${kv('Durée hebdomadaire', esc(f1(e.weekly_hours)) + ' h')}${kv('CIN', esc(e.cin || ''))}
          ${kv('Date de naissance', esc(fmtDay(e.birth_date)))}${kv('Téléphone', esc(e.phone || ''))}${kv('Code chauffeur', esc(e.driver_code || ''))}${e.kind === 'staff' ? kv('Pointage', e.pointage ? 'Obligatoire' : 'Non') : ''}</div>
        ${e.note ? `<div class="small">${esc(e.note)}</div>` : ''}
        <div class="mfgo"><button class="ghost small" id="rhfed">Modifier la fiche</button><button class="ghost small" id="rhfctr">Nouveau contrat de travail</button>${e.left_on ? `<button class="ghost small" id="rhfback">Réintégrer</button>` : `<button class="ghost small" id="rhfleft">Sortie du salarié</button>`}</div>
        <div id="rhfform"></div></div>
      <div class="panel"><h2>Période d'essai</h2>${rhTrialBox(e, tr)}</div>
      <div class="panel"><h2>Congés payés</h2>${lv ? `<div class="kvs">${kv('Mois de service', lv.months)}${kv('Acquis', f1(lv.acquired) + ' j')}${kv('Pris (validés)', f1(lv.taken) + ' j')}${kv('Solde', f1(lv.balance) + ' j')}</div>
        <div class="small">${esc(f1(e.leave_per_month))} jour(s) par mois de service (article 231 du Code du travail) ; ${lv.open ? 'droit ouvert (6 mois de service atteints).' : 'droit ouvert après 6 mois de service continu.'}</div>` : '<div class="small">Date d\'entrée à renseigner.</div>'}</div>
      <div class="panel"><h2>Contrats de travail (${wc.length})</h2>${table('rhwc', [['Créé le', c => esc(fmtDTY(c.created_at))], ['Date d\'effet', c => esc(fmtDay(c.effective_on))], ['Société', c => esc((c.data && c.data.company && c.data.company.name) || '')],
        ['', c => c.pdf_path ? `<button class="ghost small" data-rhwc="${c.id}">PDF</button>` : '']], wc, { empty: 'Aucun contrat généré dans Ludy' })}</div>
    </div><div>
      <div class="panel"><h2>Événements</h2><div id="rhfev"></div></div>
      <div class="panel"><h2>Présence de ${rhMonthTxt(rhMonthNow())}</h2><div id="rhfpres"><div class="loading">Calcul…</div></div></div>
    </div></div>`;
  $('#rhfed').onclick = () => rhEmpForm(e, $('#rhfform'));
  $('#rhfctr').onclick = () => {
    if (typeof CT === 'undefined') return;
    CT.draft = { civ: 'M', nat_fr: 'Marocaine', nom: e.name, naiss: e.birth_date || '', cin: e.cin || '', tel: e.phone || '', agency: e.agency_id || '', employer_id: e.employer_id || '', driver_code: e.driver_code || '',
      effet: e.hired_on || '', sal: sal || '', employee_id: e.id }; CT.last = null; location.hash = '#/travail';
  };
  if ($('#rhfleft')) $('#rhfleft').onclick = async () => {
    const d = ctrParseDate(prompt('Date de sortie (JJ/MM/AAAA) :', fmtDay(d0)) || ''); if (!d) return;
    const why = prompt('Motif (démission, fin de période d\'essai, licenciement…) :') || null;
    const r = await sb.from('hr_employees').update({ left_on: d, left_reason: why, pointage: false }).eq('id', e.id); if (r.error) alert(r.error.message); else route();
  };
  if ($('#rhfback')) $('#rhfback').onclick = async () => { const r = await sb.from('hr_employees').update({ left_on: null, left_reason: null }).eq('id', e.id); if (r.error) alert(r.error.message); else route(); };
  document.querySelectorAll('[data-rhwc]').forEach(b => b.onclick = async () => { try { const u = await ctrLink(wc.find(c => String(c.id) === b.dataset.rhwc).pdf_path); if (!openOut(u)) window.open(u, '_blank', 'noopener'); } catch (x) { alert('PDF inaccessible : ' + x.message); } });
  rhTrialBind(e);
  rhEventsBox($('#rhfev'), ev, [e]);
  const m = rhMonthRange(rhMonthNow()), pr = await rhPresenceData([e], m.from, m.to);
  if (my !== ROUTING) return;
  const r = pr[0];
  $('#rhfpres').innerHTML = `<div class="kvs">${kv('Jours de présence', r.nDays)}${kv('Heures', rhH(r.hours))}${kv('Heures sup. (jour / nuit)', rhH(r.overDay) + ' / ' + rhH(r.overNight))}${kv('Absences non justifiées', r.gaps.length)}</div>
    ${rhDetail(r)}<div class="small"><a href="${rhHref('presences', 'm=' + rhMonthNow() + '&id=' + e.id)}">Voir les autres mois</a></div>`;
}
function rhTrialBox(e, t) {
  if (t.state === '—') return '<div class="small">Date d\'entrée ou durée à renseigner.</div>';
  return `<div class="kvs"><div class="kv"><span class="small">État</span><b>${esc(t.state)}</b></div><div class="kv"><span class="small">Fin de la 1re période</span><b>${esc(fmtDay(t.end1))}</b></div>
      ${t.end2 ? `<div class="kv"><span class="small">Fin si renouvelée</span><b>${esc(fmtDay(t.end2))}</b></div>` : ''}${t.open ? `<div class="kv"><span class="small">Jours restants</span><b>${t.daysLeft}</b></div>` : ''}</div>
    <div class="small">Durée ${esc(f1(e.trial_months))} mois${e.trial_renewable !== false ? ', renouvelable une fois par tacite reconduction (sans décision à la fin de la 1re période : renouvelée ; à la fin de la seconde : confirmée)' : ''}. Dernier jour inclus.</div>
    ${t.open ? `<div class="mfgo"><button class="small" data-rhtd="confirmée">Confirmer l'embauche</button>${e.trial_renewable !== false && t.state === 'en cours' ? '<button class="ghost small" data-rhtd="renouvelée">Renouveler</button>' : ''}<button class="ghost small" data-rhtd="rompue">Rompre la période d'essai</button></div>` : e.trial_decision ? `<div class="mfgo"><button class="ghost small" data-rhtd="">Annuler la décision</button></div>` : ''}`;
}
function rhTrialBind(e) {
  document.querySelectorAll('[data-rhtd]').forEach(b => b.onclick = async () => {
    const dec = b.dataset.rhtd || null, row = { trial_decision: dec, trial_decided_on: dec ? today() : null };
    if (dec === 'rompue') {
      const d = ctrParseDate(prompt('Date de fin du contrat (JJ/MM/AAAA). Préavis de 8 jours prévu au contrat :', fmtDay(addDays(today(), 8))) || ''); if (!d) return;
      Object.assign(row, { trial_decided_on: today(), left_on: d, left_reason: 'Rupture de la période d\'essai', pointage: false });
    } else if (dec && !confirm(dec === 'confirmée' ? 'Confirmer l\'embauche de ' + e.name + ' ?' : 'Renouveler la période d\'essai de ' + e.name + ' ?')) return;
    const r = await sb.from('hr_employees').update(row).eq('id', e.id); if (r.error) alert(r.error.message); else route();
  });
}

// ---------- Événements (absences, congés, maladie, avances, primes, avenants) ----------
/** Liste + formulaire ; kinds : types proposés ; emps : salariés proposés */
function rhEventsBox(box, list, emps, kinds, opt) {
  opt = opt || {}; kinds = kinds || Object.keys(RH_KINDS);
  const one = emps.length === 1, rows = list.filter(x => kinds.includes(x.kind));
  box.innerHTML = `${rows.length ? table('rhev' + (opt.id || ''), [['Date', x => esc(fmtDay(x.day_from) + (x.day_to && x.day_to !== x.day_from ? ' → ' + fmtDay(x.day_to) : '')), x => x.day_from],
      ...(one ? [] : [['Salarié', x => rhLink(rhEmp(x.employee_id))]]), ['Type', x => esc(RH_KINDS[x.kind]) + (x.kind === 'absence' ? (x.justified ? ' justifiée' : ' non justifiée') : '')],
      ['Jours', x => x.days == null ? '' : f1(x.days), null, 'num'], ['Montant', x => x.new_salary != null ? 'Salaire : ' + rhMoney(x.new_salary) : rhMoney(x.amount), null, 'num'],
      ['Statut', x => x.cancelled_at ? '<span class="small">Annulé</span>' : esc(x.status || '')], ['Motif / objet', x => esc(x.label || '')],
      ['', x => `<span class="mfha">${x.doc_path ? `<button class="ghost small" data-rhdoc="${x.id}">Justificatif</button>` : ''}${!x.cancelled_at && RH_STATUS[x.kind] ? RH_STATUS[x.kind].filter(s => s !== x.status).map(s => `<button class="ghost small" data-rhst="${x.id}" data-v="${esc(s)}">${esc(s)}</button>`).join('') : ''}${x.cancelled_at ? '' : `<button class="ghost small" data-rhcx="${x.id}">Annuler</button>`}</span>`]],
    rows, { empty: 'Aucun' }) : '<div class="empty">Aucun événement</div>'}
    ${opt.noForm ? '' : `<details class="rhadd"><summary>+ Ajouter</summary><div class="mfrow">
      ${one ? '' : `<label>Salarié <select id="rhv_emp"><option value="">Choisir…</option>${emps.filter(e => !e.left_on).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>`}
      <label>Type <select id="rhv_kind">${kinds.map(k => `<option value="${k}">${esc(RH_KINDS[k])}</option>`).join('')}</select></label>
      <label>Du <input id="rhv_from" placeholder="JJ/MM/AAAA" size="11" inputmode="numeric" value="${esc(fmtDay(today()))}"></label><label id="rhv_tol">Au <input id="rhv_to" placeholder="JJ/MM/AAAA" size="11" inputmode="numeric"></label>
      <label id="rhv_daysl">Jours décomptés <input id="rhv_days" size="5" inputmode="decimal"></label><label id="rhv_amtl">Montant (DH) <input id="rhv_amt" size="8" inputmode="decimal"></label>
      <label id="rhv_sall">Nouveau salaire (DH, option) <input id="rhv_sal" size="8" inputmode="decimal"></label>
      <label id="rhv_stl">Statut <select id="rhv_st"></select></label><label class="chk" id="rhv_jl"><input type="checkbox" id="rhv_j"> Justifiée</label>
      <label>Motif / objet <input id="rhv_label" size="30"></label><label>Justificatif (option) <input type="file" id="rhv_file" accept="image/*,application/pdf"></label></div>
      <div class="mfgo"><button id="rhvsave">Enregistrer</button> <span id="rhvres" class="small"></span></div></details>`}`;
  window.__rerender = null;
  box.querySelectorAll('[data-rhdoc]').forEach(b => b.onclick = async () => {
    const x = list.find(y => String(y.id) === b.dataset.rhdoc), r = await sb.storage.from('rh').createSignedUrl(x.doc_path, 600);
    if (r.error) { alert('Justificatif inaccessible : ' + r.error.message); return; } if (!openOut(r.data.signedUrl)) window.open(r.data.signedUrl, '_blank', 'noopener');
  });
  box.querySelectorAll('[data-rhst]').forEach(b => b.onclick = async () => {
    const x = list.find(y => String(y.id) === b.dataset.rhst), r = await sb.from('hr_events').update({ status: b.dataset.v }).eq('id', x.id);
    if (r.error) { alert(r.error.message); return; }
    if (x.kind === 'conge') await rhPlanSync(Object.assign({}, x, { status: b.dataset.v }));
    route();
  });
  box.querySelectorAll('[data-rhcx]').forEach(b => b.onclick = async () => {
    const x = list.find(y => String(y.id) === b.dataset.rhcx), why = prompt('Motif de l\'annulation :'); if (why === null) return;
    const r = await sb.from('hr_events').update({ cancelled_at: new Date().toISOString(), cancel_reason: why || null }).eq('id', x.id);
    if (r.error) { alert(r.error.message); return; }
    await rhPlanSync(Object.assign({}, x, { cancelled_at: 1 })); route();
  });
  if (opt.noForm) return;
  const sync = () => {
    const k = $('#rhv_kind').value, abs = RH_ABS.includes(k);
    $('#rhv_tol').hidden = !abs; $('#rhv_daysl').hidden = !abs; $('#rhv_amtl').hidden = !RH_MONEY.includes(k); $('#rhv_sall').hidden = k !== 'avenant'; $('#rhv_jl').hidden = k !== 'absence';
    const st = RH_STATUS[k]; $('#rhv_stl').hidden = !st; $('#rhv_st').innerHTML = (st || []).map(s => `<option ${k === 'conge' && s === 'Validé' ? 'selected' : ''}>${esc(s)}</option>`).join('');
    const f = ctrParseDate($('#rhv_from').value), t = ctrParseDate($('#rhv_to').value) || f;
    if (abs && f && t && !$('#rhv_days').dataset.manual) $('#rhv_days').value = k === 'conge' ? rhWorkingDays(f, t) : Math.round((Date.parse(t) - Date.parse(f)) / 864e5) + 1;
  };
  $('#rhv_kind').onchange = sync; $('#rhv_from').oninput = sync; $('#rhv_to').oninput = sync; $('#rhv_days').oninput = () => { $('#rhv_days').dataset.manual = '1'; }; sync();
  $('#rhvsave').onclick = async () => {
    const out = $('#rhvres'), k = $('#rhv_kind').value, emp = one ? emps[0] : rhEmp($('#rhv_emp').value), f = ctrParseDate($('#rhv_from').value), t = RH_ABS.includes(k) ? (ctrParseDate($('#rhv_to').value) || f) : null;
    const bad = [];
    if (!emp) bad.push('salarié'); if (!f) bad.push('date'); if (t && f && t < f) bad.push('dates (fin avant le début)');
    const amt = $('#rhv_amt').value.trim() === '' ? null : num($('#rhv_amt').value, NaN), sal = $('#rhv_sal').value.trim() === '' ? null : num($('#rhv_sal').value, NaN), days = $('#rhv_days').value.trim() === '' ? null : num($('#rhv_days').value, NaN);
    if (RH_MONEY.includes(k) && !(amt > 0)) bad.push('montant'); if (k === 'avenant' && sal !== null && !(sal >= 0)) bad.push('nouveau salaire'); if (days !== null && isNaN(days)) bad.push('jours');
    if (k === 'avenant' && !$('#rhv_label').value.trim()) bad.push('objet de l\'avenant');
    if (bad.length) { out.innerHTML = '<span class="err">À compléter : ' + esc(bad.join(', ')) + '.</span>'; return; }
    const row = { employee_id: emp.id, kind: k, day_from: f, day_to: t, days: RH_ABS.includes(k) ? days : null, amount: RH_MONEY.includes(k) ? amt : null, new_salary: k === 'avenant' ? sal : null,
      justified: k === 'absence' ? $('#rhv_j').checked : null, status: RH_STATUS[k] ? $('#rhv_st').value : null, label: $('#rhv_label').value.trim() || null };
    out.textContent = 'Enregistrement…';
    const fl = $('#rhv_file').files[0];
    if (fl) {
      const ext = (fl.name.match(/\.(pdf|png|jpe?g|webp|heic)$/i) || ['', 'bin'])[1].toLowerCase(), pth = emp.id + '/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()) + '.' + ext;
      const up = await sb.storage.from('rh').upload(pth, fl, { contentType: fl.type || 'application/octet-stream', upsert: false });
      if (up.error) { out.innerHTML = '<span class="err">Justificatif non envoyé : ' + esc(up.error.message) + '</span>'; return; }
      row.doc_path = pth;
    }
    const r = await sb.from('hr_events').insert(row).select('*').single();
    if (r.error) { out.innerHTML = '<span class="err">Erreur : ' + esc(r.error.message) + '</span>'; return; }
    const w = await rhPlanSync(r.data);
    if (w) alert(w);
    route();
  };
}
/** Congé validé, arrêt maladie, absence d'un chauffeur : posé aussi dans le planning des chauffeurs (le chauffeur n'y est plus planifié) ; retiré à l'annulation */
async function rhPlanSync(x) {
  const e = rhEmp(x.employee_id);
  if (!e || e.kind !== 'chauffeur' || !e.driver_code || !RH_ABS.includes(x.kind)) return '';
  const want = !x.cancelled_at && (x.kind !== 'conge' || x.status === 'Validé');
  try {
    if (x.plan_absence_id && !want) { await sb.from('driver_absences').delete().eq('id', x.plan_absence_id); await sb.from('hr_events').update({ plan_absence_id: null }).eq('id', x.id); }
    if (!x.plan_absence_id && want) {
      const r = await sb.from('driver_absences').insert({ agency_id: e.agency_id, driver_code: e.driver_code, day_from: x.day_from, day_to: x.day_to || x.day_from, reason: 'RH : ' + RH_KINDS[x.kind] + (x.label ? ' · ' + x.label : '') }).select('id').single();
      if (r.error) return 'Enregistré dans les RH, mais pas dans le planning des chauffeurs (' + r.error.message + ') : à poser dans Planning chauffeurs > Absences.';
      await sb.from('hr_events').update({ plan_absence_id: r.data.id }).eq('id', x.id);
    }
  } catch (err) { return 'Planning des chauffeurs non mis à jour : ' + (err.message || err); }
  return '';
}

// ---------- Présences ----------
/** Données de présence de salariés sur [from, to] : chauffeurs (contrats), staff (pointage) */
async function rhPresenceData(emps, from, to) {
  const P = S.P || {}, drv = emps.filter(e => e.kind === 'chauffeur' && e.driver_code), staff = emps.filter(e => e.kind === 'staff');
  const out = new Map(emps.map(e => [e.id, { e, nDays: 0, days: [], hours: 0, night: 0, over: 0, overDay: 0, overNight: 0, gaps: [], flagged: [], items: [], staffDays: [], declared: [] }]));
  const evDays = e => rhEventDays(RH.ev.filter(x => x.employee_id === e.id), RH_ABS, from, to);
  if (drv.length) {
    // semaines entières (heures supplémentaires par semaine), + 2 jours pour la fin des contrats jamais clôturés
    const wFrom = mondayOf(from), wTo = addDays(mondayOf(to), 6), t0 = localToDate(...wFrom.split('-').map(Number), 0, 0).getTime() - 12 * HOUR, t1 = localToDate(...addDays(wTo, 2).split('-').map(Number), 0, 0).getTime();
    const ctr = await all('contracts', 'num,client_code,vehicle_key,start_at,end_at', x => x.gte('start_at', new Date(t0).toISOString()).lt('start_at', new Date(t1).toISOString()), ['start_at']);
    const byV = {}; ctr.forEach(c => { (byV[c.vehicle_key] = byV[c.vehicle_key] || []).push(c); });
    const codes = new Set(drv.map(e => e.driver_code)), items = [];
    Object.values(byV).forEach(l => ctrEffEnds(l).forEach(c => {
      if (!codes.has(c.client_code) || !c.start_at) return;
      const sh = shiftOfCtr(c.start_at, P);
      if (sh.day < wFrom || sh.day > wTo) return;
      items.push({ code: c.client_code, num: c.num, vehicle: c.vehicle_key, start: Date.parse(c.start_at), end: c._end || null, day: sh.day, shift: sh.s });
    }));
    const wh = {}; drv.forEach(e => { wh[e.driver_code] = +e.weekly_hours || 44; });
    const work = rhDriverWork(items, { maxH: num(P.rhMaxShiftH, 16), weekH: wh, off: rhOffset });
    const [plan, pabs] = await Promise.all([all('driver_plan', 'day,shift,driver_code', x => x.gte('day', from).lte('day', to).in('driver_code', [...codes]), ['day']).catch(() => []),
      all('driver_absences', 'driver_code,day_from,day_to', x => x.lte('day_from', to).gte('day_to', from).in('driver_code', [...codes]), ['day_from']).catch(() => [])]);
    drv.forEach(e => {
      const r = out.get(e.id), s = rhDriverSum(work[e.driver_code], from, to);
      const decl = new Set(evDays(e));
      pabs.filter(a => a.driver_code === e.driver_code).forEach(a => { for (let d = a.day_from > from ? a.day_from : from; d <= (a.day_to < to ? a.day_to : to); d = addDays(d, 1)) decl.add(d); });
      const lim = e.left_on && e.left_on < to ? e.left_on : to, start = e.hired_on && e.hired_on > from ? e.hired_on : from;
      Object.assign(r, s, { gaps: rhPlanGaps(plan.filter(p => p.driver_code === e.driver_code && p.day >= start && p.day <= lim && p.day < today()), s.days, [...decl]), declared: [...decl].sort() });
    });
  }
  if (staff.length && isAdmin()) {
    const a = localToDate(...from.split('-').map(Number), 0, 0).getTime() - 12 * HOUR, b = localToDate(...addDays(to, 1).split('-').map(Number), 0, 0).getTime() + 12 * HOUR;
    const [ck, ses] = await Promise.all([all('hr_clock', 'employee_id,kind,at', x => x.gte('at', new Date(a).toISOString()).lt('at', new Date(b).toISOString()).in('employee_id', staff.map(e => e.id)), ['at']).catch(() => []),
      all('user_sessions', 'user_id,started_at,last_seen', x => x.gte('last_seen', new Date(a).toISOString()).lt('started_at', new Date(b).toISOString()).in('user_id', staff.map(e => e.user_id).filter(Boolean)), ['started_at']).catch(() => [])]);
    staff.forEach(e => {
      const r = out.get(e.id), days = rhStaffDays(ck.filter(c => c.employee_id === e.id).map(c => ({ kind: c.kind, at: Date.parse(c.at) })),
        ses.filter(s => s.user_id === e.user_id).map(s => ({ started_at: Date.parse(s.started_at), last_seen: Date.parse(s.last_seen) })), { dayOf: t => localDay(t) }).filter(d => d.day >= from && d.day <= to);
      const ov = rhStaffOver(days, e.weekly_hours), wk = days.filter(d => d.workMin > 0);
      Object.assign(r, { staffDays: days, nDays: wk.length, days: wk.map(d => d.day), hours: Math.round(wk.reduce((s, d) => s + d.workMin, 0) / 6) / 10,
        over: Object.keys(ov).filter(m => m >= mondayOf(from) && m <= to).reduce((s, m) => s + ov[m], 0), declared: evDays(e) });
      r.overDay = r.over; r.flagged = days.filter(d => d.outAuto || d.fails).map(d => ({ day: d.day, flag: [d.outAuto && 'départ non pointé', d.fails && d.fails + ' date(s) de naissance erronée(s)'].filter(Boolean).join(', ') }));
    });
  }
  return [...out.values()];
}
/** Détail d'un salarié : shifts (chauffeur) ou journées pointées (staff) */
function rhDetail(r) {
  if (r.e.kind === 'staff') {
    if (!isAdmin()) return '';
    return table('rhsd' + r.e.id, [['Jour', d => esc(fmtDay(d.day)), d => d.day], ['Arrivée', d => d.in ? esc(localHM(d.in)) : ''], ['Départ', d => d.out ? esc(localHM(d.out)) + (d.outAuto ? ' <span class="warn">non pointé</span>' : d.ongoing ? ' <span class="small">en cours</span>' : '') : ''],
      ['Pauses', d => d.nPauses + (d.pauseMin ? ' · ' + rhMin(d.pauseMin) : ''), null, 'num'], ['Travaillé', d => rhMin(d.workMin), null, 'num'], ['Connecté à Ludy', d => d.conn ? esc(localHM(d.conn.first) + ' → ' + localHM(d.conn.last)) + ' · ' + rhMin(d.conn.min) : ''],
      ['Contrôle', d => d.fails ? '<span class="warn">' + d.fails + ' date(s) de naissance erronée(s)</span>' : '']], r.staffDays, { empty: 'Aucun pointage' });
  }
  return table('rhdd' + r.e.id, [['Jour', x => esc(fmtDay(x.day)), x => x.day], ['Shift', x => esc(x.shift || '')], ['Contrat', x => esc(x.num)], ['Début', x => esc(localHM(x.start))], ['Fin', x => x.end ? esc(localHM(x.end)) : ''],
    ['Heures', x => x.h == null ? '<span class="warn">' + esc(x.flag) + '</span>' : rhH(x.h), null, 'num'], ['dont nuit', x => x.night ? rhH(x.night) : '', null, 'num'], ['Heures sup.', x => x.over ? rhH(x.over) : '', null, 'num']], r.items, { empty: 'Aucun contrat' })
    + (r.gaps.length ? `<div class="small warn">Planifié sans contrat ni absence déclarée : ${r.gaps.map(fmtDay).join(', ')}</div>` : '');
}
function rhMonthBar(m, extra) {
  return `<div class="bar"><button class="ghost small" data-rhm="${rhAddMonths(m + '-01', -1).slice(0, 7)}">←</button><b>${esc(rhMonthTxt(m))}</b><button class="ghost small" data-rhm="${rhAddMonths(m + '-01', 1).slice(0, 7)}">→</button>${extra || ''}</div>`;
}
function rhMonthBind(t) { document.querySelectorAll('[data-rhm]').forEach(b => b.onclick = () => { const p = qs(); p.set('t', t); p.set('m', b.dataset.rhm); location.hash = '#/rh?' + p.toString(); }); }
async function rhPresence(my, q) {
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : rhMonthNow(), R = rhMonthRange(m), ok = rhAgOk();
  const emps = RH.emp.filter(e => ok(e) && (!e.hired_on || e.hired_on <= R.to) && (!e.left_on || e.left_on >= R.from));
  $('#rhbody').innerHTML = rhMonthBar(m) + '<div class="loading">Calcul des présences…</div>';
  rhMonthBind('presences');
  const rows = await rhPresenceData(emps, R.from, R.to);
  if (my !== ROUTING) return;
  const sel = q.get('id');
  $('#rhbody').innerHTML = rhMonthBar(m) + `<div class="small">Chauffeurs : un contrat Ludy = un shift (jour du shift, comme partout dans Ludy) ; heures = durée du contrat ; contrat de plus de ${esc(num((S.P || {}).rhMaxShiftH, 16))} h ou sans fin : jour compté, heures à vérifier. Staff : pointage (arrivée → départ, pauses déduites). Heures supplémentaires : au-delà de la durée hebdomadaire de la fiche (44 h par défaut), semaine du lundi au dimanche.</div>
    ${table('rhpres', [['Salarié', r => `<a href="#" data-rhsel="${r.e.id}">${esc(r.e.name)}</a>`, r => r.e.name], ['Type', r => r.e.kind === 'staff' ? 'Staff' : 'Chauffeur'], ['Jours de présence', r => String(r.nDays), r => r.nDays, 'num'],
      ['Heures', r => rhH(r.hours), r => r.hours, 'num'], ['dont nuit', r => r.night ? rhH(r.night) : '', r => r.night, 'num'], ['Heures sup. jour', r => r.overDay ? rhH(r.overDay) : '', r => r.overDay, 'num'],
      ['Heures sup. nuit', r => r.overNight ? rhH(r.overNight) : '', r => r.overNight, 'num'], ['Absences déclarées (j)', r => r.declared.length ? String(r.declared.length) : '', r => r.declared.length, 'num'],
      ['Absences non justifiées (j)', r => r.gaps.length ? `<span class="warn">${r.gaps.length}</span>` : '', r => r.gaps.length, 'num'], ['À vérifier', r => r.flagged.length ? `<span class="warn">${r.flagged.length}</span>` : '', r => r.flagged.length, 'num']],
      rows, { empty: 'Aucun salarié sur le mois' })}<div id="rhpdet"></div>`;
  const show = id => { const r = rows.find(x => String(x.e.id) === String(id)); if (!r) return; $('#rhpdet').innerHTML = `<div class="panel"><h2>${esc(r.e.name)} · ${esc(rhMonthTxt(m))}</h2>${rhDetail(r)}</div>`; };
  document.querySelectorAll('[data-rhsel]').forEach(a => a.onclick = ev => { ev.preventDefault(); show(a.dataset.rhsel); $('#rhpdet').scrollIntoView({ block: 'start' }); });
  window.__rerender = null;
  if (sel) show(sel);
}

// ---------- Pointage du staff (administrateur) ----------
async function rhClockBoard(my, q) {
  if (!isAdmin()) { $('#rhbody').innerHTML = msg('Réservé à l\'administrateur.', 'warn'); return; }
  const staff = RH.emp.filter(e => e.kind === 'staff' && !e.left_on);
  const ck = staff.length ? await all('hr_clock', 'id,employee_id,kind,at,client,note,created_by', x => x.gte('at', new Date(Date.now() - 40 * 86400000).toISOString()).in('employee_id', staff.map(e => e.id)), ['at', false]).catch(() => []) : [];
  if (my !== ROUTING) return;
  const ev = id => ck.filter(c => c.employee_id === id).map(c => ({ kind: c.kind, at: Date.parse(c.at) }));
  const st = staff.map(e => { const d = rhStaffDays(ev(e.id), [], { dayOf: t => localDay(t) }).find(x => x.day === today()); return { e, s: rhClockState(ev(e.id)), d }; });
  const KTXT = { in: 'Arrivée', pause: 'Pause', resume: 'Reprise', out: 'Départ', session: 'Ouverture de Ludy', fail: 'Date de naissance erronée' };
  $('#rhbody').innerHTML = `<div class="small">Chaque ouverture de Ludy par un salarié au pointage obligatoire demande sa date de naissance (contrôlée par la base) ; la première de la journée pointe l'arrivée. Pauses et fin de journée en bas du menu. Départ non pointé : dernière activité sur Ludy.</div>
    ${!staff.length ? msg('Aucun salarié staff : créez sa fiche (type Staff), rattachez son compte Ludy et cochez « Pointage obligatoire ».', 'warn') : ''}
    <div class="panel"><h2>Aujourd'hui</h2>${table('rhck', [['Salarié', x => rhLink(x.e)], ['Pointage', x => x.e.pointage ? (x.e.birth_date ? 'Obligatoire' : '<span class="warn">date de naissance manquante</span>') : 'Non'], ['État', x => rhStateTxt(x.s)],
      ['Arrivée', x => x.d && x.d.in ? esc(localHM(x.d.in)) : ''], ['Pauses', x => x.d ? x.d.nPauses + (x.d.pauseMin ? ' · ' + rhMin(x.d.pauseMin) : '') : '', null, 'num'], ['Travaillé', x => x.d ? rhMin(x.d.workMin) : '', null, 'num']], st, { empty: 'Aucun' })}</div>
    <div class="panel"><h2>Corriger un pointage</h2><div class="mfrow"><label>Salarié <select id="rhc_emp">${staff.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>
      <label>Type <select id="rhc_kind">${['in', 'pause', 'resume', 'out'].map(k => `<option value="${k}">${KTXT[k]}</option>`).join('')}</select></label>
      <label>Date et heure <input type="datetime-local" id="rhc_at"></label><label>Motif <input id="rhc_note" size="28" placeholder="Ex. oubli de pointage"></label><button id="rhcadd">Ajouter</button> <span id="rhcres" class="small"></span></div></div>
    <div class="panel"><h2>Derniers pointages (40 jours)</h2>${table('rhcl', [['Date', c => esc(fmtDTY(c.at)), c => c.at], ['Salarié', c => esc((rhEmp(c.employee_id) || {}).name || '')], ['Événement', c => esc(KTXT[c.kind] || c.kind)],
      ['Appareil', c => esc(c.client || '')], ['Note', c => esc(c.note || '')], ['', c => `<button class="ghost small" data-rhcdel="${c.id}">Supprimer</button>`]], ck.slice(0, 400), { empty: 'Aucun pointage' })}</div>`;
  $('#rhcadd').onclick = async () => {
    const e = rhEmp($('#rhc_emp').value), t = parseLocalDT($('#rhc_at').value), note = $('#rhc_note').value.trim();
    if (!e || !t || !note) { $('#rhcres').innerHTML = '<span class="err">Salarié, date et heure, motif obligatoires.</span>'; return; }
    const r = await sb.from('hr_clock').insert({ employee_id: e.id, user_id: e.user_id, kind: $('#rhc_kind').value, at: t.toISOString(), client: 'Correction', note: note + ' (' + (S.profile.email || '') + ')' });
    if (r.error) $('#rhcres').innerHTML = '<span class="err">' + esc(r.error.message) + '</span>'; else route();
  };
  document.querySelectorAll('[data-rhcdel]').forEach(b => b.onclick = async () => { if (!confirm('Supprimer ce pointage ?')) return; const r = await sb.from('hr_clock').delete().eq('id', b.dataset.rhcdel); if (r.error) alert(r.error.message); else route(); });
}

// ---------- Absences et congés / Avances et primes / Avenants ----------
async function rhAbsences(my, q) {
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : rhMonthNow(), R = rhMonthRange(m), ok = rhAgOk(), emps = RH.emp.filter(ok), ids = new Set(emps.map(e => e.id));
  const list = RH.ev.filter(x => ids.has(x.employee_id) && RH_ABS.includes(x.kind) && x.day_from <= R.to && (x.day_to || x.day_from) >= R.from);
  $('#rhbody').innerHTML = rhMonthBar(m) + `<div class="small">Congé validé, arrêt maladie et absence d'un chauffeur : posés aussi dans le planning des chauffeurs (il n'y est plus planifié ces jours-là). Jours de congé proposés : jours ouvrables (dimanches exclus), modifiables.</div><div class="panel" id="rhabx"></div>`;
  rhMonthBind('absences');
  rhEventsBox($('#rhabx'), list, emps, RH_ABS, { id: 'a' });
}
async function rhAdvances(my, q) {
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : rhMonthNow(), R = rhMonthRange(m), ok = rhAgOk(), emps = RH.emp.filter(ok), ids = new Set(emps.map(e => e.id));
  const list = RH.ev.filter(x => ids.has(x.employee_id) && RH_MONEY.includes(x.kind) && x.day_from >= R.from && x.day_from <= R.to);
  const codes = emps.map(e => e.driver_code).filter(Boolean);
  const cash = codes.length ? await all('cash_moves', 'id,kind,amount,day,driver_code,label,status,flow,cancelled_at', x => x.gte('day', R.from).lte('day', R.to).in('kind', ['avance', 'remboursement', 'bonus']).in('driver_code', codes).is('cancelled_at', null), ['day']).catch(() => []) : [];
  if (my !== ROUTING) return;
  const byCode = {}; emps.forEach(e => { if (e.driver_code) byCode[e.driver_code] = e; });
  const tot = {}; const add = (e, k, v) => { const t = tot[e.id] = tot[e.id] || { e, avance: 0, remboursement: 0, prime: 0 }; t[k] += +v || 0; };
  list.filter(x => !x.cancelled_at).forEach(x => add(rhEmp(x.employee_id), x.kind, x.amount));
  cash.forEach(c => { const e = byCode[c.driver_code]; if (e) add(e, c.kind === 'bonus' ? 'prime' : c.kind, c.amount); });
  $('#rhbody').innerHTML = rhMonthBar(m) + `<div class="small">Saisies des RH (virement, staff…) et de la Caisse (avances RH, remboursements, bonus des chauffeurs), sans double saisie : une avance donnée en caisse se saisit dans la Caisse.</div>
    <div class="panel"><h2>Totaux de ${esc(rhMonthTxt(m))}</h2>${table('rhmt', [['Salarié', t => rhLink(t.e)], ['Avances', t => rhMoney(t.avance), null, 'num'], ['Remboursements', t => rhMoney(t.remboursement), null, 'num'], ['Reste dû (mois)', t => rhMoney(t.avance - t.remboursement), null, 'num'], ['Primes', t => rhMoney(t.prime), null, 'num']], Object.values(tot), { empty: 'Aucune avance ni prime ce mois-ci' })}</div>
    <div class="panel"><h2>Caisse (${cash.length})</h2>${table('rhcash', [['Date', c => esc(fmtDay(c.day)), c => c.day], ['Salarié', c => rhLink(byCode[c.driver_code])], ['Type', c => esc(c.kind === 'bonus' ? 'Bonus' : RH_KINDS[c.kind])], ['Montant', c => rhMoney(c.amount), null, 'num'], ['Statut', c => esc(c.status || '')], ['Motif', c => esc(c.label || '')]], cash, { empty: 'Aucune' })}</div>
    <div class="panel"><h2>Saisies RH</h2><div id="rhavx"></div></div>`;
  rhMonthBind('avances');
  rhEventsBox($('#rhavx'), list, emps, RH_MONEY, { id: 'm' });
}
function rhAvenants() {
  const ok = rhAgOk(), emps = RH.emp.filter(ok), ids = new Set(emps.map(e => e.id)), list = RH.ev.filter(x => ids.has(x.employee_id) && x.kind === 'avenant');
  $('#rhbody').innerHTML = `<div class="small">Avenant au contrat : date d'effet, objet, nouveau salaire (le salaire en vigueur change à cette date, l'historique reste), avenant signé en justificatif.</div><div class="panel" id="rhavn"></div>`;
  rhEventsBox($('#rhavn'), list, emps, ['avenant'], { id: 'v' });
}
function rhTrials() {
  const ok = rhAgOk(), d0 = today(), rows = RH.emp.filter(e => ok(e) && !e.left_on).map(e => [e, rhTrial(e, d0, num((S.P || {}).rhAlertDays, 7))]).filter(x => x[1].state !== '—')
    .sort((a, b) => (b[1].open - a[1].open) || (a[1].daysLeft - b[1].daysLeft));
  $('#rhbody').innerHTML = `<div class="small">Période d'essai du contrat (1,5 mois par défaut, article 14 de la loi 65-99), renouvelable une seule fois par tacite reconduction : sans décision à la fin de la 1re période, elle est renouvelée ; à la fin de la seconde, l'embauche est confirmée. Dernier jour inclus.</div>
    ${table('rhtrl', [['Salarié', x => rhLink(x[0])], ['Entrée', x => esc(fmtDay(x[0].hired_on)), x => x[0].hired_on], ['Fin 1re période', x => esc(fmtDay(x[1].end1)), x => x[1].end1], ['Fin si renouvelée', x => esc(fmtDay(x[1].end2 || '')), x => x[1].end2 || ''],
      ['État', x => x[1].alert ? `<span class="warn">${esc(x[1].state)}</span>` : esc(x[1].state)], ['Jours restants', x => x[1].open ? String(x[1].daysLeft) : '', x => x[1].open ? x[1].daysLeft : 9999, 'num'],
      ['', x => x[1].open ? `<a href="${rhHref('fiche', 'id=' + x[0].id)}">Décider</a>` : '']], rows, { empty: 'Aucune période d\'essai (date d\'entrée à renseigner dans les fiches)' })}`;
}

// ---------- État mensuel (éléments variables de paie) ----------
async function rhMonthly(my, q) {
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : rhMonthNow(), R = rhMonthRange(m), ok = rhAgOk();
  const emps = RH.emp.filter(e => ok(e) && (!e.hired_on || e.hired_on <= R.to) && (!e.left_on || e.left_on >= R.from));
  $('#rhbody').innerHTML = rhMonthBar(m) + '<div class="loading">Calcul…</div>'; rhMonthBind('mois');
  const pres = await rhPresenceData(emps, R.from, R.to), codes = emps.map(e => e.driver_code).filter(Boolean);
  const cash = codes.length ? await all('cash_moves', 'kind,amount,day,driver_code', x => x.gte('day', R.from).lte('day', R.to).in('kind', ['avance', 'remboursement', 'bonus']).in('driver_code', codes).is('cancelled_at', null), ['day']).catch(() => []) : [];
  if (my !== ROUTING) return;
  const rows = pres.map(r => {
    const e = r.e, ev = RH.ev.filter(x => x.employee_id === e.id && !x.cancelled_at), sal = rhSalaryAt(e, ev, R.to), sum = k => ev.filter(x => x.kind === k && x.day_from >= R.from && x.day_from <= R.to).reduce((s, x) => s + (+x.amount || 0), 0);
    const cs = k => cash.filter(c => c.driver_code === e.driver_code && c.kind === k).reduce((s, c) => s + (+c.amount || 0), 0);
    const days = k => rhEventDays(ev, [k], R.from, R.to).length, pay = rhOvertimePay(sal, e.weekly_hours, r.overDay, r.overNight || 0);
    return { e, sal, r, conge: days('conge'), maladie: days('maladie'), absJ: rhEventDays(ev.filter(x => x.kind === 'absence' && x.justified), ['absence'], R.from, R.to).length,
      absNJ: rhEventDays(ev.filter(x => x.kind === 'absence' && !x.justified), ['absence'], R.from, R.to).length + r.gaps.length, avance: sum('avance') + cs('avance'), remb: sum('remboursement') + cs('remboursement'), prime: sum('prime') + cs('bonus'), pay };
  });
  const cols = [['Salarié', x => x.e.name], ['Type', x => x.e.kind === 'staff' ? 'Staff' : 'Chauffeur'], ['Salaire de base', x => x.sal == null ? '' : f0(x.sal), 'num'], ['Jours de présence', x => String(x.r.nDays), 'num'],
    ['Heures', x => rhH(x.r.hours), 'num'], ['HS jour (+25 %)', x => x.r.overDay ? rhH(x.r.overDay) : '', 'num'], ['HS nuit (+50 %)', x => x.r.overNight ? rhH(x.r.overNight) : '', 'num'],
    ['Montant HS', x => x.pay && (x.r.overDay || x.r.overNight) ? f0(x.pay.amount) : '', 'num'], ['Congés (j)', x => x.conge ? String(x.conge) : '', 'num'], ['Maladie (j)', x => x.maladie ? String(x.maladie) : '', 'num'],
    ['Absences justifiées (j)', x => x.absJ ? String(x.absJ) : '', 'num'], ['Absences non justifiées (j)', x => x.absNJ ? String(x.absNJ) : '', 'num'], ['Avances', x => x.avance ? f0(x.avance) : '', 'num'],
    ['Remboursements', x => x.remb ? f0(x.remb) : '', 'num'], ['Primes', x => x.prime ? f0(x.prime) : '', 'num']];
  $('#rhbody').innerHTML = rhMonthBar(m, '<button class="ghost small" id="rhxl">Excel</button><button class="ghost small" id="rhpdf">PDF</button>') +
    `<div class="small">Éléments variables de la paie du mois, pour le comptable. Montant des heures supplémentaires (article 201 du Code du travail) : taux horaire = salaire / (durée hebdomadaire × 52 / 12), +25 % de 6 h à 21 h, +50 % de 21 h à 6 h ; heures sur le jour de repos hebdomadaire non distinguées. Absences non justifiées des chauffeurs : jours planifiés sans contrat ni absence déclarée. Les cotisations et l'impôt ne sont pas calculés ici.</div>
    ${table('rhmo', cols.map(c => [c[0], x => esc(c[1](x)), null, c[2] || '']), rows, { empty: 'Aucun salarié sur le mois' })}`;
  const aoa = [cols.map(c => c[0])].concat(rows.map(x => cols.map(c => c[1](x))));
  $('#rhxl').onclick = () => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'RH ' + m); XLSX.writeFile(wb, 'Etat-RH-' + m + '.xlsx'); };
  $('#rhpdf').onclick = () => {
    try {
      reportPdf(rptSimple({ kind: 'rh', title: 'État mensuel des ressources humaines', period: rhMonthTxt(m), from: R.from, to: R.to, agency: agFilter() ? S.agName[agFilter()] : 'Toutes les agences',
        footer: 'Ludy · Ressources humaines — présence des chauffeurs d\'après les contrats Ludy, du staff d\'après le pointage sur Ludy.',
        summary: [['Salariés', String(rows.length)], ['Jours de présence', f0(rows.reduce((s, x) => s + x.r.nDays, 0))], ['Heures supplémentaires', rhH(rows.reduce((s, x) => s + (x.r.over || 0), 0))], ['Avances', rhMoney(rows.reduce((s, x) => s + x.avance, 0))]],
        tables: [{ title: 'Salariés', empty: 'Aucun', head: aoa[0], num: cols.map((c, i) => c[2] ? i : -1).filter(i => i >= 0), rows: aoa.slice(1) }], fileName: 'Etat-RH-' + m }));
    } catch (e) { alert(e.message || e); }
  };
}

// ---------- Mon pointage (tout salarié au pointage) ----------
async function pageMoi() {
  const my = ROUTING, me = S.rhMe;
  $('#page').innerHTML = '<div class="head"><h1>Mon pointage</h1><div class="sub">Vos arrivées, pauses et départs des 31 derniers jours.</div></div><div class="loading">Chargement…</div>';
  if (!me) { $('#page').innerHTML = '<div class="head"><h1>Mon pointage</h1></div>' + msg('Aucune fiche de salarié rattachée à votre compte.', 'warn'); return; }
  const ck = await all('hr_clock', 'kind,at', x => x.eq('employee_id', me.id).gte('at', new Date(Date.now() - 31 * 86400000).toISOString()), ['at']).catch(() => []);
  if (my !== ROUTING) return;
  const days = rhStaffDays(ck.map(c => ({ kind: c.kind, at: Date.parse(c.at) })), [], { dayOf: t => localDay(t) }).reverse();
  $('#page').innerHTML = '<div class="head"><h1>Mon pointage</h1><div class="sub">' + esc(me.name) + ' · vos arrivées, pauses et départs des 31 derniers jours.</div></div>' +
    table('rhme', [['Jour', d => esc(fmtDay(d.day))], ['Arrivée', d => d.in ? esc(localHM(d.in)) : ''], ['Départ', d => d.out ? esc(localHM(d.out)) + (d.outAuto ? ' <span class="warn">non pointé</span>' : d.ongoing ? ' <span class="small">en cours</span>' : '') : ''],
      ['Pauses', d => d.nPauses + (d.pauseMin ? ' · ' + rhMin(d.pauseMin) : ''), null, 'num'], ['Travaillé', d => rhMin(d.workMin), null, 'num']], days, { empty: 'Aucun pointage' });
}

// ---------- Pointage à l'ouverture de Ludy, pauses, fin de journée ----------
const RH_OK_KEY = 'rhok';
function rhClient() { return (window.LUDY_APP ? 'Application ' + (window.LUDY_APP.version || '') : 'Navigateur') + ' · ' + (/Mac/.test(navigator.platform) ? 'Mac' : /Win/.test(navigator.platform) ? 'Windows' : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'autre'); }
function rhOkGet() { try { return sessionStorage.getItem(RH_OK_KEY) === S.session.user.id + '|' + today(); } catch (e) { return false; } }
function rhOkSet(v) { try { if (v) sessionStorage.setItem(RH_OK_KEY, S.session.user.id + '|' + today()); else sessionStorage.removeItem(RH_OK_KEY); } catch (e) { } }
/** true : Ludy utilisable ; false : écran de pointage affiché (date de naissance, pause en cours) */
async function rhGate(my) {
  if (S.rhMe === undefined || (S.rhMe && S.rhMe.pointage)) {   // relu à chaque page : pause ou fin de journée pointée depuis un autre appareil
    const r = await sb.rpc('hr_me').then(x => x, () => ({ error: 1 }));
    S.rhMe = r && !r.error && r.data ? r.data : null;
  }
  if (my !== ROUTING) return false;
  const me = S.rhMe;
  if (!me || !me.pointage) return true;
  if (rhOkGet() && me.state === 'on') return true;
  if (rhOkGet() && me.state === 'pause') { rhPauseView(); return false; }
  rhGateView();
  return false;
}
function rhGateView() {
  const me = S.rhMe, off = me.state === 'off';
  $('#app').innerHTML = `<div class="login"><div class="lbox">${BRAND_LIGHT}<h2>Bonjour ${esc(me.name)}</h2>
    <p class="small">${off ? 'Pour commencer votre journée sur Ludy, confirmez votre identité : votre arrivée sera pointée.' : 'Journée en cours depuis ' + esc(me.arrived ? localHM(me.arrived) : '') + ' : confirmez votre identité pour continuer.'}</p>
    <form id="rhgf"><label>Votre date de naissance <input id="rhgb" placeholder="JJ/MM/AAAA" inputmode="numeric" maxlength="10" autocomplete="off" required></label>
    <button type="submit">${off ? 'Commencer ma journée' : 'Continuer'}</button></form><div id="rhgr"></div>
    <p><button class="ghost small" id="rhglo">Se déconnecter</button></p></div></div>`;
  const inp = $('#rhgb');
  inp.focus();
  inp.addEventListener('input', e => { if (e.inputType && /^delete/.test(e.inputType)) return; const dg = inp.value.replace(/\D/g, '').slice(0, 8); if (/^\d+$/.test(inp.value.replace(/\//g, ''))) inp.value = dg.slice(0, 2) + (dg.length > 2 ? '/' + dg.slice(2, 4) : '') + (dg.length > 4 ? '/' + dg.slice(4) : ''); });
  $('#rhglo').onclick = async () => { await sessEnd(); await sb.auth.signOut(); location.hash = ''; };
  $('#rhgf').onsubmit = async ev => {
    ev.preventDefault();
    const d = ctrParseDate(inp.value), out = $('#rhgr');
    if (!d) { out.innerHTML = msg('Date invalide : JJ/MM/AAAA.', 'err'); return; }
    const r = await sb.rpc('hr_clock_do', { p_kind: 'in', p_birth: d, p_client: rhClient() });
    if (r.error || !r.data || !r.data.ok) { out.innerHTML = msg(esc((r.data && r.data.error) || (r.error && r.error.message) || 'Erreur'), 'err'); inp.value = ''; inp.focus(); return; }
    S.rhMe = r.data; rhOkSet(true); route();
  };
}
function rhPauseView() {
  const me = S.rhMe, since = me.since ? Date.parse(me.since) : Date.now();
  $('#app').innerHTML = `<div class="login"><div class="lbox">${BRAND_LIGHT}<h2>En pause</h2><p>Depuis ${esc(localHM(since))} · <b id="rhpt"></b></p>
    <button id="rhpres">Reprendre le travail</button><p><button class="ghost small" id="rhpout">Fin de journée</button></p><div id="rhpr"></div></div></div>`;
  const tick = () => { const el = $('#rhpt'); if (el) el.textContent = rhMin((Date.now() - since) / 60000); };
  tick(); S.timers.push(setInterval(tick, 30000));
  $('#rhpres').onclick = () => rhDo('resume', $('#rhpr'));
  $('#rhpout').onclick = () => rhEndDay($('#rhpr'));
}
async function rhDo(kind, out) {
  const r = await sb.rpc('hr_clock_do', { p_kind: kind, p_client: rhClient() });
  if (r.error || !r.data || !r.data.ok) { const m = (r.data && r.data.error) || (r.error && r.error.message) || 'Erreur'; if (out) out.innerHTML = msg(esc(m), 'err'); else alert(m); return false; }
  S.rhMe = r.data; route(); return true;
}
async function rhEndDay(out) {
  if (!confirm('Pointer la fin de votre journée ?')) return false;
  const ok = await rhDo('out', out); if (ok) rhOkSet(false); return ok;
}
/** Bas du menu : état du pointage, pause, fin de journée */
function rhFoot() {
  const me = S.rhMe; if (!me || !me.pointage || me.state !== 'on') return '';
  return `<div class="rhfoot"><span class="ok">● En service</span> <span class="small">depuis ${esc(me.arrived ? localHM(me.arrived) : '')}</span>
    <span><button class="ghost small" id="rhfp">Pause</button><button class="ghost small" id="rhfo">Fin de journée</button></span><a href="#/moi" class="small">Mon pointage</a></div>`;
}
function rhFootBind() {
  if ($('#rhfp')) $('#rhfp').onclick = () => rhDo('pause');
  if ($('#rhfo')) $('#rhfo').onclick = () => rhEndDay();
}
