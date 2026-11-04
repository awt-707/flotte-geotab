// Mode téléphone (demande d'Ahmed, 04/11/2026 : « dans l'APK, juste la caisse pour les encaissements de shift et de courses privées,
// et le manifeste, rien d'autre ; ultra responsive, simple »). Actif dans l'application Android (user agent « LudyAndroid/… »,
// android/…/MainActivity.java) sans la réinstaller, ou dans un navigateur ouvert une fois avec ?mobile=1 (?mobile=0 pour revenir).
// Trois écrans en bas de l'écran : Encaissement du shift (Uber / Bolt), Courses privées (encaissement), Manifeste. Toutes les autres
// pages renvoient au premier écran ; les calculs et les droits sont ceux du site (caisse.js, manifeste.js, base).
// Chargé avant app.js : utilise ses outils (S, sb, $, esc, route…) au moment de l'appel.

function mobDetect() {
  try { const q = new URLSearchParams(location.search).get('mobile'); if (q === '1' || q === '0') localStorage.setItem('ludyMobile', q); } catch (e) { }
  if (/LudyAndroid\//.test(navigator.userAgent || '')) return true;
  try { return localStorage.getItem('ludyMobile') === '1'; } catch (e) { return false; }
}
const MOBILE = mobDetect();
if (MOBILE) {
  window.__uiDialogs = true;   // confirmations et saisies dessinées par le site (grandes, lisibles au doigt)
  document.documentElement.classList.add('mob');
}

// ---------- Écrans ----------
const MOB_ICON = {
  shift: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/></svg>',
  courses: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V12l2-5h12l2 5v4.5"/><path d="M3 16.5h18v2.5H3z"/><circle cx="7.5" cy="14" r=".9"/><circle cx="16.5" cy="14" r=".9"/><path d="M6.5 11.5h11"/></svg>',
  manifeste: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4M9 11h6M9 14.5h6M9 18h4"/></svg>'
};
const MOB_TABS = [{ k: 'shift', label: 'Encaissement', title: 'Encaissement du shift', href: '#/caisse?t=shift' },
  { k: 'courses', label: 'Courses', title: 'Courses privées', href: '#/caisse?t=courses' },
  { k: 'manifeste', label: 'Manifeste', title: 'Manifeste', href: '#/manifeste' }];
/** Écrans ouverts à cet utilisateur (caisse : gestionnaires et administrateur ; volets choisis par l'administrateur respectés) */
function mobTabs() {
  return MOB_TABS.filter(x => x.k === 'manifeste' ? canSee('manifeste') : canEdit() && canSee('caisse'));
}
/** Écran affiché (null : page hors du mode téléphone) */
function mobCur() {
  const p = pageOf(), t = qs().get('t');
  if (p === 'manifeste') return 'manifeste';
  if (p === 'caisse' && (t === 'shift' || t === 'courses')) return t;
  return null;
}
/** Route en mode téléphone : page hors des trois écrans = premier écran ouvert ; false si la page change */
function mobRoute() {
  const tabs = mobTabs(), cur = mobCur();
  if (!tabs.length) { mobShell(); $('#page').innerHTML = msg('Aucun écran du téléphone n\'est ouvert pour votre compte (caisse : gestionnaires et administrateur). Demandez l\'accès à l\'administrateur.', 'warn'); return false; }
  if (!cur || !tabs.some(x => x.k === cur)) { location.replace(tabs[0].href); return false; }
  return true;
}

// ---------- Cadre : barre du haut (logo, écran, compte) et trois boutons en bas ----------
function mobShellHtml() {
  const tabs = mobTabs(), ag = mobAgId();
  return `<div class="mlay">
  <header class="mtop"><img class="mlogo" src="logo-ludy.png" alt="Ludy" width="96" height="23"><span class="mtitle" id="mtitle"></span>
    <button type="button" class="mmenu" id="mmenu" aria-label="Compte et agence" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/></svg></button></header>
  <div class="msheet" id="msheet" hidden><div class="msheet-card">
    <div class="mwho"><b>${esc(S.profile.name || S.profile.email || '')}</b><span>${esc(ROLE_TXT[S.profile.role] || '')}</span></div>
    ${S.agencies.length > 1 ? `<label>Agence <select id="magsel"><option value="">— Choisir l'agence —</option>${S.agencies.map(a => `<option value="${a.id}" ${String(a.id) === ag ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
    <label>Thème <select id="mtheme">${THEMES.map(x => `<option value="${x[0]}" ${x[0] === themeGet() ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label>
    <button type="button" class="ghost mbtn" id="logout">Déconnexion</button></div></div>
  <main id="page"><div class="loading">Chargement…</div></main>
  <nav class="mtabs" aria-label="Écrans" style="grid-template-columns:repeat(${tabs.length || 1},1fr)">${tabs.map(x => `<a href="${x.href}" data-mt="${x.k}">${MOB_ICON[x.k]}<span>${x.label}</span></a>`).join('')}</nav></div>`;
}
/** Agence choisie (caisse et manifestes : la même) */
function mobAgId() {
  let a = ''; try { a = localStorage.getItem('caisseAg') || localStorage.getItem('agence') || ''; } catch (e) { }
  return S.agencies.some(x => String(x.id) === a) ? a : '';
}
function mobShell() {
  const key = 'mob|' + mobShellHtml();
  if (key !== SHELL_KEY || !$('#app > .mlay') || !$('#page')) {
    SHELL_KEY = key; $('#app').innerHTML = mobShellHtml();
    const sh = $('#msheet'), mb = $('#mmenu'), open = v => { sh.hidden = !v; mb.setAttribute('aria-expanded', v ? 'true' : 'false'); };
    mb.onclick = () => open(sh.hidden);
    sh.onclick = e => { if (e.target === sh) open(false); };
    $('#logout').onclick = doLogout;
    $('#mtheme').onchange = e => { try { localStorage.setItem('theme', e.target.value); } catch (x) { } themeApply(e.target.value); };
    const ag = $('#magsel');
    if (ag) ag.onchange = () => { try { localStorage.setItem('caisseAg', ag.value); localStorage.setItem('agence', ag.value); } catch (e) { } CS.users = null; open(false); route(); };
  } else $('#page').innerHTML = '<div class="loading">Chargement…</div>';
  const cur = mobCur(), t = MOB_TABS.find(x => x.k === cur);
  document.querySelectorAll('.mtabs a').forEach(a => { const on = a.dataset.mt === cur; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const ti = $('#mtitle'); if (ti) ti.textContent = t ? t.title : '';
  window.scrollTo(0, 0);
  return pageOf();
}

// ---------- Caisse (encaissement du shift, courses privées) ----------
async function pageCaisseM() {
  const my = ROUTING, t = qs().get('t') === 'courses' ? 'courses' : 'shift';
  if (!canEdit()) { $('#page').innerHTML = msg('Caisse réservée aux gestionnaires et à l\'administrateur.', 'warn'); return; }
  const ag = cshAg();
  if (!ag) {   // plusieurs agences : chacune a sa caisse
    $('#page').innerHTML = `<div class="mempty"><b>Choisir l'agence</b><p>Chaque agence a sa propre caisse.</p>${S.agencies.map(a => `<button type="button" class="mbtn" data-mag="${a.id}">${esc(a.name)}</button>`).join('')}</div>`;
    document.querySelectorAll('[data-mag]').forEach(b => { b.onclick = () => { try { localStorage.setItem('caisseAg', b.dataset.mag); localStorage.setItem('agence', b.dataset.mag); } catch (e) { } route(); }; });
    return;
  }
  CS.agId = ag.id; CS.agName = ag.name || '';
  const sh = cshShiftSel(), p = { from: addDays(today(), -6), to: today() };
  try { if (t === 'shift') await cshLoad(sh.day, addDays(sh.day, 1)); else await cshLoad(p.from, p.to); }
  catch (e) { if (my === ROUTING) $('#page').innerHTML = msg('Lecture impossible : ' + esc(e.message), 'err'); return; }
  if (my !== ROUTING) return;
  $('#page').innerHTML = (S.agencies.length > 1 ? `<div class="mag">${esc(ag.name)}</div>` : '') + '<div id="cshbody"></div>' + cshDrvDatalist();
  if (t === 'shift') cshTabShiftM(); else await cshTabCoursesM(p);
  window.__rerender = () => pageCaisse();
}
const mobNum = (attr, ph, v) => `<input type="number" inputmode="decimal" min="0" step="1" ${attr}${ph ? ` placeholder="${esc(ph)}"` : ''}${v != null && v !== '' ? ` value="${esc(v)}"` : ''}>`;
function mobPlate(k) { const v = k && vehOf(k); return v ? v.plate : k || ''; }

function cshTabShiftM() {
  const X = cshShiftRows(), { day, s, pf, P, B, addKey, rows, nameOf } = X;
  const link = (d, sh, f) => '#/caisse?t=shift&jour=' + d + '&s=' + sh + ((f || pf) === 'bolt' ? '&pf=bolt' : '');
  const prev = s === 'Nuit' ? [day, 'Jour'] : [addDays(day, -1), 'Nuit'], next = s === 'Jour' ? [day, 'Nuit'] : [addDays(day, 1), 'Jour'];
  const done = rows.filter(r => r.sf), tot = cshR(done.reduce((t, r) => t + cshN(r.sf.total), 0)), rest = cshR(done.reduce((t, r) => t + Math.max(0, cshN(r.sf.rest)), 0));
  const decl = r => r.uber != null ? cshMoney(r.uber) : r.pending ? '<span class="nm">export pas encore importé</span>' : '<span class="nm">compte non relié</span>';
  const who = r => `<div class="mch"><div class="mwho2"><b>${esc(nameOf(r))}</b><span>${r.c.extra ? 'Ajouté au shift (sans contrat)' : 'Contrat ' + esc(r.c.num) + ' · ' + esc(fmtDT(r.c.start_at))}${r.c.vehicle_key ? ' · ' + esc(mobPlate(r.c.vehicle_key)) : ''}</span></div>
    <div class="mdecl"><span>Espèces ${P.name}</span><b>${decl(r)}</b></div></div>`;
  const todoCard = (r, i) => `<div class="mcard" data-row="${i}">${who(r)}
    <div class="mg2"><label>Remis par le chauffeur ${mobNum('class="cgv"', 'MAD')}</label><label>Monnaie rendue ${mobNum('class="cch"', '0')}</label></div>
    <div class="mcalc" aria-live="polite"></div>
    <details class="mmore"><summary>Manque (pas tout remis) et commentaire</summary>
      <label>Manque <span class="small">${r.uber != null ? '(calculé d\'après l\'export, modifiable)' : '(si le chauffeur n\'a pas tout remis)'}</span> ${mobNum('class="cmq"', 'MAD')}</label>
      <label>Commentaire <input class="ccm" placeholder="Ex. remet le reste demain"></label></details>
    <button type="button" class="mbtn" data-csav="${i}">Encaisser</button>${r.added ? `<button type="button" class="mlink" data-cshrm="${i}">Retirer ce chauffeur du shift</button>` : ''}</div>`;
  const doneCard = (r, i) => {
    const f = r.sf, d = f.main, st = f.status, cls = st === 'Manquant' ? ' short' : ' paid';
    const comps = f.comps.map(m => `<div class="small">+ ${cshMoney(m.amount)} ${m.label === CSH_COMPLEMENT ? 'complément' : 'encaissement'} · ${esc(fmtDT(m.created_at))}${cshCanFix(m) ? ` · <button type="button" class="mlink" data-cshx="${m.id}">annuler</button>` : ''}</div>`).join('');
    return `<div class="mcard done${cls}">${who(r)}
      <div class="mres"><div><span>Encaissé</span><b>${cshMoney(f.total)}</b></div><div><span>${st === 'Manquant' ? 'Reste à encaisser' : st === 'Soldé' ? 'Manque remis' : st === 'Excédent' ? 'Excédent' : 'Manque'}</span><b class="${st === 'Manquant' ? 'red' : 'ok'}">${f.rest == null ? '—' : cshMoney(Math.abs(f.rest))}</b></div></div>
      <div class="small">Remis ${cshMoney(d.given)} · monnaie ${cshMoney(d.change)}${d.comment ? ' · ' + esc(d.comment) : ''}</div>${comps}
      <div class="mact">${f.rest > 0.004 ? `<button type="button" class="mbtn" data-cshcp="${i}">+ Complément remis</button>` : ''}${cshCanFix(d) ? `<button type="button" class="ghost mbtn" data-cshx="${d.id}">Annuler l'encaissement</button>` : ''}</div></div>`;
  };
  cshBody(`<div class="mseg" role="group" aria-label="Plateforme">${['uber', 'bolt'].map(x => `<a href="${link(day, s, x)}" class="${x === pf ? 'on' : ''}">${CSH_PF[x].name}</a>`).join('')}</div>
    <div class="mshift"><a href="${link(prev[0], prev[1])}" aria-label="Shift précédent">‹</a><label><b>${esc(shiftDayName({ s, day }))}</b><input type="date" id="cshsd" value="${day}" aria-label="Jour du shift"></label><a href="${link(next[0], next[1])}" aria-label="Shift suivant">›</a></div>
    <div class="mseg msub" role="group" aria-label="Shift">${['Jour', 'Nuit'].map(x => `<a href="${link(day, x)}" class="${x === s ? 'on' : ''}">Shift ${x.toLowerCase()}</a>`).join('')}</div>
    <div class="msum"><div><b>${done.length} / ${rows.length}</b><span>encaissés</span></div><div><b>${cshMoney(tot)}</b><span>encaissé</span></div><div><b class="${rest > 0 ? 'red' : ''}">${cshMoney(rest)}</b><span>reste à encaisser</span></div></div>
    ${rows.length ? rows.map((r, i) => r.sf ? doneCard(r, i) : todoCard(r, i)).join('') : `<div class="mempty"><b>Aucun chauffeur dans ce shift</b><p>${CS.ctr.length ? 'Aucun contrat commencé dans ce shift.' : 'Contrats pas encore importés.'} Ajouter un chauffeur ci-dessous.</p></div>`}
    <div class="mcard madd"><label>Ajouter un chauffeur au shift <input id="cxd" list="cshdrv" placeholder="Nom du chauffeur" autocomplete="off"></label><button type="button" class="ghost mbtn" id="cxadd">Ajouter</button></div>`);
  $('#cshsd').onchange = () => { if ($('#cshsd').value) location.hash = link($('#cshsd').value, s); };
  document.querySelectorAll('.mcard[data-row]').forEach(card => {
    const r = rows[+card.dataset.row], mq = card.querySelector('.cmq'), out = card.querySelector('.mcalc');
    const upd = () => {
      const has = card.querySelector('.cgv').value !== '', net = cshR(cshN(card.querySelector('.cgv').value) - cshN(card.querySelector('.cch').value));
      if (r.uber != null && !mq.dataset.touched) mq.value = has ? String(Math.max(0, cshR(r.uber - net))) : '';
      const man = r.uber != null && !mq.dataset.touched ? cshR(r.uber - net) : mq.value === '' ? null : cshN(mq.value);
      out.innerHTML = has ? `Encaissé <b>${cshMoney(net)}</b>${man == null ? '' : man > 0.004 ? ` · manque <b class="red">${cshMoney(man)}</b>` : man < -0.004 ? ` · excédent <b class="ok">${cshMoney(-man)}</b>` : ' · <b class="ok">cadré</b>'}` : '';
    };
    card.querySelectorAll('.cgv,.cch').forEach(x => { x.oninput = upd; });
    mq.oninput = () => { mq.dataset.touched = '1'; upd(); };
  });
  document.querySelectorAll('[data-csav]').forEach(b => { b.onclick = async () => {
    const card = b.closest('.mcard'), r = rows[+b.dataset.csav], mq = card.querySelector('.cmq');
    b.disabled = true;
    try { if (await cshSaveShift(X, r, { gv: card.querySelector('.cgv').value, ch: card.querySelector('.cch').value, mq: mq.value, touched: !!mq.dataset.touched, cm: card.querySelector('.ccm').value })) pageCaisse(); else b.disabled = false; }
    catch (e) { b.disabled = false; alert(e.message); }
  }; });
  document.querySelectorAll('[data-cshrm]').forEach(a => { a.onclick = () => { const r = rows[+a.dataset.cshrm];
    CSH_ADDED[addKey] = (CSH_ADDED[addKey] || []).filter(x => (x.driver_code || 'N:' + cshName(x.driver_name)) !== r.c.key); cshTabShiftM(); }; });
  document.querySelectorAll('[data-cshcp]').forEach(b => { b.onclick = async () => { const f = rows[+b.dataset.cshcp].sf;
    try { if (await cshComplement(f.main, f.rest)) pageCaisse(); } catch (e) { alert(e.message); } }; });
  document.querySelectorAll('[data-cshx]').forEach(b => { b.onclick = () => cshCancel(+b.dataset.cshx); });
  $('#cxadd').onclick = () => {
    const w = cshResolve(cshVal('cxd')); if (!w.driver_name) { alert('Choisir le chauffeur.'); return; }
    const k = w.driver_code || 'N:' + cshName(w.driver_name);
    if (rows.some(r => (r.c.extra ? r.c.key : r.c.client_code) === k)) { alert(w.driver_name + ' est déjà dans ce shift.'); return; }
    (CSH_ADDED[addKey] = CSH_ADDED[addKey] || []).push(B ? Object.assign({}, w, { uber_uuid: null }) : w); cshTabShiftM();
  };
}

async function cshTabCoursesM(p) {
  const my = ROUTING, pct0 = cshN(S.P.cashCommissionPct === undefined ? 10 : S.P.cashCommissionPct);
  const { todo } = await cshCoursesTodo(p);
  if (my !== ROUTING) return;
  const sel = CS.selMission ? todo.find(m => m.id === CS.selMission) || null : null, f = (sel && sel.data && sel.data.f) || {};
  const recent = CS.moves.filter(m => m.caisse === 'courses' && m.kind === 'course' && cshLive(m)).sort((a, b) => String(b.day).localeCompare(String(a.day)) || b.id - a.id);
  const encToday = recent.filter(m => m.day === today()).reduce((t, m) => t + cshN(m.amount), 0);
  const form = `<div class="mcard mform" id="cshcform"><h3>${sel ? 'Encaisser la course ' + esc(sel.number || '') : 'Encaisser une course'}</h3>
    ${sel ? `<div class="small">${esc(fmtDT(sel.start_at))} · ${esc(sel.client_name || '')}${sel.vehicle_key ? ' · ' + esc(mobPlate(sel.vehicle_key)) : ''} · <button type="button" class="mlink" id="ccclr">autre course</button></div>` : ''}
    <label>Chauffeur <input id="ccw" list="cshdrv" autocomplete="off" value="${esc(sel ? sel.driver_name || '' : '')}" placeholder="Nom du chauffeur"></label>
    <div class="mg2"><label>Montant de la course ${mobNum('id="cca"', 'MAD', sel && sel.total_ttc != null ? sel.total_ttc : '')}</label><label>Remis en caisse ${mobNum('id="ccr"', 'MAD')}</label></div>
    <div class="mcalc" id="cccalc" aria-live="polite"></div>
    <details class="mmore"><summary>Trajet, prime, date, commentaire</summary>
      <div class="mg2"><label>Départ <input id="ccf" value="${esc(f.startAddr || f.startCity || '')}"></label><label>Arrivée <input id="cct" value="${esc(f.endAddr || f.endCity || f.dest || '')}"></label></div>
      <div class="mg2"><label>Prime chauffeur (%) <input id="ccp" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(pct0)}"></label><label>Date <input id="ccd" type="date" value="${today()}"></label></div>
      <label>Commentaire <input id="ccm"></label></details>
    <button type="button" class="mbtn" id="ccsave">Encaisser</button></div>`;
  cshBody(`<div class="msum"><div><b class="${todo.length ? 'red' : ''}">${todo.length}</b><span>course${todo.length > 1 ? 's' : ''} à encaisser</span></div><div><b>${cshMoney(encToday)}</b><span>encaissé aujourd'hui</span></div></div>
    ${sel ? form : ''}
    ${todo.length ? '<h3 class="mh">Courses Ludy à encaisser</h3>' + todo.map(m => `<div class="mcard mcrs${sel && sel.id === m.id ? ' on' : ''}"><div class="mch"><div class="mwho2"><b>${esc(m.client_name || m.number || '')}</b><span>${esc(m.number || '')} · ${esc(fmtDT(m.start_at))}${m.driver_name ? ' · ' + esc(m.driver_name) : ''}</span></div>
      <div class="mdecl"><span>${esc(m.status)}</span><b>${m.total_ttc == null ? '—' : cshMoney(m.total_ttc)}</b></div></div>${sel && sel.id === m.id ? '' : `<button type="button" class="mbtn" data-cshms="${m.id}">Encaisser</button>`}</div>`).join('') : ''}
    ${sel ? '' : form}
    ${recent.length ? '<h3 class="mh">Derniers encaissements (7 jours)</h3>' + recent.slice(0, 30).map(m => `<div class="mcard mline"><div class="mch"><div class="mwho2"><b>${esc(m.driver_code ? cshDrvName(m.driver_code) : m.driver_name || '')}</b><span>${esc(fmtDay(m.day))}${m.label ? ' · ' + esc(m.label) : ''}</span></div>
      <div class="mdecl"><span>Prime ${cshMoney(m.prime)}</span><b>${cshMoney(m.amount)}</b></div></div>${cshCanFix(m) ? `<button type="button" class="mlink" data-cshx="${m.id}">Annuler</button>` : ''}</div>`).join('') : ''}`);
  const calc = () => { const c = cshCourse(cshVal('cca'), cshVal('ccp'), cshVal('ccr') === '' ? cshVal('cca') : cshVal('ccr'));
    $('#cccalc').innerHTML = cshVal('cca') === '' ? '' : `Prime ${cshMoney(c.prime)} · gardée par le chauffeur ${cshMoney(c.paid)} · reste à lui payer ${cshSignedTxt(c.reste)}`; };
  ['cca', 'ccp', 'ccr'].forEach(id => { $('#' + id).oninput = calc; }); calc();
  document.querySelectorAll('[data-cshms]').forEach(b => { b.onclick = () => { CS.selMission = +b.dataset.cshms; cshTabCoursesM(p).then(() => { const x = $('#cshcform'); if (x && x.scrollIntoView) x.scrollIntoView({ block: 'start' }); }); }; });
  if ($('#ccclr')) $('#ccclr').onclick = () => { CS.selMission = null; cshTabCoursesM(p); };
  document.querySelectorAll('[data-cshx]').forEach(b => { b.onclick = () => cshCancel(+b.dataset.cshx); });
  $('#ccsave').onclick = async () => {
    const b = $('#ccsave'); b.disabled = true;
    try { if (await cshSaveCourse(sel, { day: cshVal('ccd'), driver: cshVal('ccw'), from: cshVal('ccf'), to: cshVal('cct'), amount: cshVal('cca'), pct: cshVal('ccp'), given: cshVal('ccr'), comment: cshVal('ccm') })) { CS.selMission = null; pageCaisse(); } else b.disabled = false; }
    catch (e) { b.disabled = false; alert(e.message); }
  };
}
