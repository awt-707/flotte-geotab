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

/**
 * Encaissement du shift sur le téléphone (04/11/2026, demande d'Ahmed : plus de choix Uber / Bolt) : une fiche par chauffeur avec deux
 * lignes, Uber et Bolt (espèces de chaque plateforme, remis, monnaie, manque) ; « Encaisser » enregistre les lignes remplies.
 */
function cshTabShiftM() {
  const XU = cshShiftRows('uber'), XB = cshShiftRows('bolt'), PFX = { uber: XU, bolt: XB }, { day, s } = XU;
  const link = (d, sh) => '#/caisse?t=shift&jour=' + d + '&s=' + sh;
  const prev = s === 'Nuit' ? [day, 'Jour'] : [addDays(day, -1), 'Nuit'], next = s === 'Jour' ? [day, 'Nuit'] : [addDays(day, 1), 'Jour'];
  // fiches : même contrat (ou même chauffeur ajouté au shift) dans les deux plateformes
  const cards = [], byKey = {};
  [['uber', XU], ['bolt', XB]].forEach(([pf, X]) => X.rows.forEach(r => { const k = r.c.extra ? 'x:' + r.c.key : 'c:' + r.c.num;
    let c = byKey[k]; if (!c) { c = byKey[k] = { r, nameOf: X.nameOf, rows: {} }; cards.push(c); } c.rows[pf] = r; }));
  const lines = [].concat(...cards.map(c => Object.values(c.rows))), done = lines.filter(r => r.sf);
  const tot = cshR(done.reduce((t, r) => t + cshN(r.sf.total), 0)), rest = cshR(done.reduce((t, r) => t + Math.max(0, cshN(r.sf.rest)), 0));
  const nDone = cards.filter(c => Object.values(c.rows).some(r => r.sf)).length;
  const decl = r => r.uber != null ? '<b>' + cshMoney(r.uber) + '</b>' : r.pending ? '<span class="nm">export pas encore importé</span>' : '<span class="nm">compte non relié</span>';
  const line = (c, i, pf) => {
    const r = c.rows[pf], P = CSH_PF[pf]; if (!r) return '';
    if (r.sf) {
      const f = r.sf, d = f.main, st = f.status;
      const comps = f.comps.map(m => `<div class="small">+ ${cshMoney(m.amount)} ${m.label === CSH_COMPLEMENT ? 'complément' : 'encaissement'} · ${esc(fmtDT(m.created_at))}${cshCanFix(m) ? ` · <button type="button" class="mlink" data-cshx="${m.id}">annuler</button>` : ''}</div>`).join('');
      return `<div class="mpfd ${st === 'Manquant' ? 'short' : 'paid'}"><div class="mpfh"><b>${P.name}</b><span>espèces ${decl(r)}</span></div>
        <div class="mres"><div><span>Encaissé</span><b>${cshMoney(f.total)}</b></div><div><span>${st === 'Manquant' ? 'Reste à encaisser' : st === 'Soldé' ? 'Manque remis' : st === 'Excédent' ? 'Excédent' : 'Manque'}</span><b class="${st === 'Manquant' ? 'red' : 'ok'}">${f.rest == null ? '—' : cshMoney(Math.abs(f.rest))}</b></div></div>
        <div class="small">Remis ${cshMoney(d.given)} · monnaie ${cshMoney(d.change)}${d.comment ? ' · ' + esc(d.comment) : ''}</div>${comps}
        <div class="mact">${f.rest > 0.004 ? `<button type="button" class="mbtn" data-cshcp="${i}|${pf}">+ Complément ${P.name} remis</button>` : ''}${cshCanFix(d) ? `<button type="button" class="mlink" data-cshx="${d.id}">Annuler l'encaissement ${P.name}</button>` : ''}</div></div>`;
    }
    return `<div class="mpf" data-pf="${pf}"><div class="mpfh"><b>${P.name}</b><span>espèces ${decl(r)}</span></div>
      <div class="mg2"><label>Remis ${mobNum('class="cgv"', 'MAD')}</label><label>Monnaie rendue ${mobNum('class="cch"', '0')}</label></div>
      <div class="mcalc" aria-live="polite"></div>
      <details class="mmore"><summary>Manque ${P.name} (pas tout remis)</summary>
        <label>Manque <span class="small">${r.uber != null ? '(calculé d\'après l\'export, modifiable)' : '(si le chauffeur n\'a pas tout remis)'}</span> ${mobNum('class="cmq"', 'MAD')}</label></details></div>`;
  };
  const card = (c, i) => { const open = ['uber', 'bolt'].some(pf => c.rows[pf] && !c.rows[pf].sf), r = c.r;
    return `<div class="mcard mdrv" data-card="${i}"><div class="mch"><div class="mwho2"><b>${esc(c.nameOf(r))}</b><span>${r.c.extra ? 'Ajouté au shift (sans contrat)' : 'Contrat ' + esc(r.c.num) + ' · ' + esc(fmtDT(r.c.start_at))}${r.c.vehicle_key ? ' · ' + esc(mobPlate(r.c.vehicle_key)) : ''}</span></div></div>
      ${line(c, i, 'uber')}${line(c, i, 'bolt')}
      ${open ? `<label class="mcom">Commentaire <input class="ccm" placeholder="Ex. remet le reste demain"></label><button type="button" class="mbtn" data-csav="${i}">Encaisser</button>` : ''}
      ${Object.values(c.rows).some(x => x.added) ? `<button type="button" class="mlink" data-cshrm="${i}">Retirer ce chauffeur du shift</button>` : ''}</div>`; };
  cshBody(`<div class="mshift"><a href="${link(prev[0], prev[1])}" aria-label="Shift précédent">‹</a><label><b>${esc(shiftDayName({ s, day }))}</b><input type="date" id="cshsd" value="${day}" aria-label="Jour du shift"></label><a href="${link(next[0], next[1])}" aria-label="Shift suivant">›</a></div>
    <div class="mseg msub" role="group" aria-label="Shift">${['Jour', 'Nuit'].map(x => `<a href="${link(day, x)}" class="${x === s ? 'on' : ''}">Shift ${x.toLowerCase()}</a>`).join('')}</div>
    <div class="msum"><div><b>${nDone} / ${cards.length}</b><span>encaissés</span></div><div><b>${cshMoney(tot)}</b><span>encaissé</span></div><div><b class="${rest > 0 ? 'red' : ''}">${cshMoney(rest)}</b><span>reste à encaisser</span></div></div>
    ${cards.length ? cards.map(card).join('') : `<div class="mempty"><b>Aucun chauffeur dans ce shift</b><p>${CS.ctr.length ? 'Aucun contrat commencé dans ce shift.' : 'Contrats pas encore importés.'} Ajouter un chauffeur ci-dessous.</p></div>`}
    <div class="mcard madd"><label>Ajouter un chauffeur au shift <input id="cxd" list="cshdrv" placeholder="Nom du chauffeur" autocomplete="off"></label><button type="button" class="ghost mbtn" id="cxadd">Ajouter</button></div>`);
  $('#cshsd').onchange = () => { if ($('#cshsd').value) location.hash = link($('#cshsd').value, s); };
  // calcul en direct de chaque ligne : encaissé net, manque proposé d'après l'export (si importé) tant qu'il n'est pas saisi
  document.querySelectorAll('.mcard[data-card] .mpf').forEach(el => {
    const r = cards[+el.closest('.mcard').dataset.card].rows[el.dataset.pf], mq = el.querySelector('.cmq'), out = el.querySelector('.mcalc');
    const upd = () => {
      const has = el.querySelector('.cgv').value !== '', net = cshR(cshN(el.querySelector('.cgv').value) - cshN(el.querySelector('.cch').value));
      if (r.uber != null && !mq.dataset.touched) mq.value = has ? String(Math.max(0, cshR(r.uber - net))) : '';
      const man = r.uber != null && !mq.dataset.touched ? cshR(r.uber - net) : mq.value === '' ? null : cshN(mq.value);
      out.innerHTML = has ? `Encaissé <b>${cshMoney(net)}</b>${man == null ? '' : man > 0.004 ? ` · manque <b class="red">${cshMoney(man)}</b>` : man < -0.004 ? ` · excédent <b class="ok">${cshMoney(-man)}</b>` : ' · <b class="ok">cadré</b>'}` : '';
    };
    el.querySelectorAll('.cgv,.cch').forEach(x => { x.oninput = upd; });
    mq.oninput = () => { mq.dataset.touched = '1'; upd(); };
  });
  // « Encaisser » : chaque ligne remplie (Uber, Bolt) enregistrée ; ligne laissée vide = pas d'espèces remises sur cette plateforme
  document.querySelectorAll('[data-csav]').forEach(b => { b.onclick = async () => {
    const el = b.closest('.mcard'), c = cards[+b.dataset.csav], cm = el.querySelector('.ccm').value;
    const todo = [...el.querySelectorAll('.mpf')].filter(x => x.querySelector('.cgv').value !== '');
    if (!todo.length) { alert('Saisir le montant remis sur la ligne Uber ou Bolt (0 si rien n\'a été remis).'); return; }
    b.disabled = true; let n = 0;
    try {
      for (const x of todo) { const pf = x.dataset.pf, mq = x.querySelector('.cmq');
        if (await cshSaveShift(PFX[pf], c.rows[pf], { gv: x.querySelector('.cgv').value, ch: x.querySelector('.cch').value, mq: mq.value, touched: !!mq.dataset.touched, cm })) n++;
        else if (!n) { b.disabled = false; return; } }
      pageCaisse();
    } catch (e) { alert(e.message); if (n) pageCaisse(); else b.disabled = false; }
  }; });
  document.querySelectorAll('[data-cshrm]').forEach(a => { a.onclick = () => { const r = cards[+a.dataset.cshrm].r;
    [XU, XB].forEach(X => { CSH_ADDED[X.addKey] = (CSH_ADDED[X.addKey] || []).filter(x => (x.driver_code || 'N:' + cshName(x.driver_name)) !== r.c.key); }); cshTabShiftM(); }; });
  document.querySelectorAll('[data-cshcp]').forEach(b => { b.onclick = async () => { const [i, pf] = b.dataset.cshcp.split('|'), f = cards[+i].rows[pf].sf;
    try { if (await cshComplement(f.main, f.rest)) pageCaisse(); } catch (e) { alert(e.message); } }; });
  document.querySelectorAll('[data-cshx]').forEach(b => { b.onclick = () => cshCancel(+b.dataset.cshx); });
  $('#cxadd').onclick = () => {
    const w = cshResolve(cshVal('cxd')); if (!w.driver_name) { alert('Choisir le chauffeur.'); return; }
    const k = w.driver_code || 'N:' + cshName(w.driver_name);
    if (cards.some(c => (c.r.c.extra ? c.r.c.key : c.r.c.client_code) === k)) { alert(w.driver_name + ' est déjà dans ce shift.'); return; }
    (CSH_ADDED[XU.addKey] = CSH_ADDED[XU.addKey] || []).push(w);
    (CSH_ADDED[XB.addKey] = CSH_ADDED[XB.addKey] || []).push(Object.assign({}, w, { uber_uuid: null }));
    cshTabShiftM();
  };
}

// ---------- Courses privées sur le téléphone : créer la course (manifeste et devis faits tout de suite), l'encaisser à l'arrivée ----------
const MOB = { q: null, done: null };
/** PDF envoyé dans WhatsApp au numéro donné : fichier joint par l'application Android 1.2 (LudyAndroid.share), sinon message avec le lien du PDF */
async function mobSharePdf(blob, name, phone, text, link) {
  const wa = typeof manifWa === 'function' ? manifWa(phone) : '';
  if (window.LudyAndroid && typeof window.LudyAndroid.share === 'function') {
    const b64 = await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => ko(r.error); r.readAsDataURL(blob); });
    window.LudyAndroid.share(b64, name, 'application/pdf', text, wa);
    return 'fichier';
  }
  const u = 'https://wa.me/' + (wa || '') + '?text=' + encodeURIComponent(text + (link && text.indexOf(link) < 0 ? '\n' + link : ''));
  if (!openOut(u)) window.open(u, '_blank', 'noopener');
  return 'lien';
}
function mobDownload(blob, name) {
  window.__ludyDlName = name;   // nom du fichier enregistré par l'application Android
  const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 8000);
}
async function cshTabCoursesM(p) {
  const my = ROUTING, mode = qs().get('c') === 'enc' ? 'enc' : 'new';
  // courses à encaisser : aussi celles créées pour les jours suivants (course du soir pour après minuit, réservation)
  const { todo } = await cshCoursesTodo({ from: p.from, to: addDays(today(), 60) });
  if (my !== ROUTING) return;
  const seg = `<div class="mseg" role="group" aria-label="Courses">${[['new', 'Nouvelle course'], ['enc', 'À encaisser' + (todo.length ? ' (' + todo.length + ')' : '')]].map(x => `<a href="#/caisse?t=courses${x[0] === 'enc' ? '&c=enc' : ''}" class="${x[0] === mode ? 'on' : ''}">${x[1]}</a>`).join('')}</div>`;
  if (mode === 'enc') return cshCoursesEncM(p, todo, seg);
  if (!CR.grids.length) await crsLoadGrid();
  const err = await mfEnsure();
  if (my !== ROUTING) return;
  if (typeof addrSetPlaces === 'function') addrSetPlaces(MANIF_PLACES);
  const vs = vehPick(), dep0 = mfNowLocal();
  const q = MOB.q = MOB.q || { veh: '', dep: dep0, end: crsLocalDT(new Date((parseLocalDT(dep0) || new Date()).getTime() + 2 * HOUR)), type: 'Non résident', pax: 1 };
  const G1 = crsGridDefault(), gs = (CR.grids.length ? CR.grids : [CR.grid || {}]).slice().sort((a, b) => (b === G1) - (a === G1));
  const rows = gs.map(g => [crsGridName(g), [].concat((g.airport || []).map(r => [(g._id || 1) + '|A|' + r.dest, 'A' + crsAirport(g).slice(1) + ' ↔ ' + r.dest]))
    .concat((g.intercity || []).map(r => [(g._id || 1) + '|I|' + r.dest, crsOrigin(g) + ' → ' + r.dest]))]);
  const opt = r => `<option value="${esc(r[0])}" ${r[0] === q.grid ? 'selected' : ''}>${esc(r[1])}</option>`;
  const v = (k, d) => esc(q[k] == null ? (d || '') : q[k]);
  const D = MOB.done;
  const doneCard = D ? `<div class="mcard done paid" id="mobdone"><div class="mch"><div class="mwho2"><b>Course ${esc(D.m.number || '')} créée</b><span>${esc(D.status)} · ${esc((D.vv || {}).plate || '')} · ${esc(fmtDT(D.a))} → ${esc(fmtDT(D.b))}</span><span>${esc(D.f.client)}</span></div>
      <div class="mdecl"><span>TTC (TVA ${esc(D.p.vat)} %)</span><b>${cshMoney(D.p.total)}</b></div></div>
      ${D.mf && D.mf.r ? '' : `<div class="msg warn">${esc(D.mf ? D.mf.warn || D.mf.err || '' : 'Manifeste non créé')}</div>`}
      ${D.quote && D.quote.err ? `<div class="msg warn">Devis non mis en ligne : ${esc(D.quote.err)}</div>` : ''}
      <div class="mact">${D.mf && D.mf.r ? `<button type="button" class="mbtn" id="mobmfwa">Manifeste PDF → WhatsApp du chauffeur</button>` : ''}
        ${D.quote ? `<button type="button" class="mbtn" id="mobqwa">Devis PDF → WhatsApp du client</button>` : ''}
        <div class="mg2">${D.mf && D.mf.r ? '<button type="button" class="ghost" id="mobmfdl">Manifeste PDF</button>' : '<span></span>'}${D.quote ? '<button type="button" class="ghost" id="mobqdl">Devis PDF</button>' : ''}</div>
        <button type="button" class="ghost mbtn" id="mobnew">Nouvelle course</button></div>
      <div class="small">Encaissement à l'arrivée du chauffeur : onglet « À encaisser ».</div><div class="small" id="mobshr"></div></div>` : '';
  cshBody(seg + doneCard + (err ? msg('Manifestes pas encore installés dans la base : ' + esc(err), 'err') : '') + (!err && MF.cfg && mfCos().some(c => !c.stamp) ? msg('Cachet manquant (' + esc(mfCos().filter(c => !c.stamp).map(mfCoName).join(', ')) + ') : manifeste impossible pour ses véhicules (à ajouter depuis l\'ordinateur, Manifestes &gt; Réglages).', 'warn') : '') + (D ? '' : `
    <div class="mcard mform"><h3>Course</h3>
      <label>Véhicule <select id="qkveh"><option value="">Choisir…</option>${vs.map(x => `<option value="${esc(x.key)}" ${x.key === q.veh ? 'selected' : ''}>${esc(x.plate)}${x.model ? ' · ' + esc(x.model) : ''}</option>`).join('')}</select></label>
      ${mfCos().length > 1 ? `<label>Société <select id="qkco">${mfCoOpts(q.co, q.veh)}</select></label>` : ''}
      <label>Départ le <input type="datetime-local" id="qkdep" value="${v('dep')}"></label><label>Fin prévue <input type="datetime-local" id="qkend" value="${v('end')}"></label>
      <label>Adresse de départ <input id="qkfrom" data-addr value="${v('from')}" placeholder="Hôtel, adresse, aéroport…"></label>
      <label>Adresse d'arrivée <input id="qkto" data-addr value="${v('to')}" placeholder="Hôtel, adresse, aéroport…"></label>
      <div class="mg2"><label>Chauffeur <input id="qkdrv" list="qkdrvl" value="${v('drv')}" placeholder="Contrat en cours" autocomplete="off"></label><label>Tél. chauffeur <input id="qktel" type="tel" value="${v('tel')}" placeholder="06…"></label></div>
      <datalist id="qkdrvl">${Object.keys(S.drv || {}).filter(c => c !== HORS).map(c => `<option value="${esc(S.drv[c])}"></option>`).join('')}</datalist><div id="qkdinfo" class="small"></div>
      <label>Tarif de la grille (option) <select id="qkgrid"><option value="">—</option>${rows.length > 1 ? rows.map(g => `<optgroup label="Départ ${esc(g[0])}">${g[1].map(opt).join('')}</optgroup>`).join('') : rows.map(g => g[1].map(opt).join('')).join('')}</select></label>
      <label>Prix convenu (MAD TTC, TVA ${esc(crsN((G1 || {}).vat) || 10)} % incluse) <input type="number" inputmode="decimal" min="0" id="qkprice" value="${v('price')}"></label><div id="qkpinfo" class="small"></div></div>
    <div class="mcard mform"><h3>Client</h3>
      <label>Nom et prénom <input id="qkcli" value="${v('client')}"></label>
      <label>Téléphone (WhatsApp du devis) <input id="qkcph" type="tel" value="${v('cphone')}" placeholder="06… ou +33…"></label>
      <div class="mseg" role="group" aria-label="Type de client">${['Résident', 'Non résident'].map(t => `<a href="#" data-qkt="${t}" class="${q.type === t ? 'on' : ''}">${t}</a>`).join('')}</div>
      ${q.type === 'Résident' ? `<label>N° CIN ou passeport <input id="qkcin" value="${v('cin')}"></label>` : ''}
      <div class="mg2"><label>Passagers <input type="number" inputmode="numeric" min="1" id="qkpax" value="${v('pax', 1)}"></label><label>N° de vol / remarque <input id="qkobs" value="${v('obs')}"></label></div>
      ${q.type === 'Résident' ? `<label>Autres passagers (un par ligne) <textarea id="qknames" rows="3">${v('names')}</textarea></label>` : ''}
      <button type="button" class="mbtn" id="qkgo">Créer la course</button><div id="qkres"></div>
      <div class="small">Crée la course (véhicule bloqué), le manifeste et le devis PDF. L'encaissement se fait à l'arrivée du chauffeur.</div></div>`));
  if (D) return mobDoneBind(p);
  const rd = () => { ['veh', 'co', 'dep', 'end', 'from', 'to', 'drv', 'tel', 'grid', 'price', 'client', 'cphone', 'cin', 'pax', 'obs', 'names'].forEach(k => { const e = $('#qk' + ({ client: 'cli', cphone: 'cph' }[k] || k)); if (e) q[k] = e.value; });
    q.gridRef = q.grid && $('#qkgrid').selectedOptions[0] ? $('#qkgrid').selectedOptions[0].textContent : ''; return q; };
  const gridPrice = () => { rd(); const vv = vehOf(q.veh), cat = crsCatOf(vv), [gid, t, dest] = String(q.grid || '').split('|'), g = crsGridOf(gid), row = ((t === 'A' ? g.airport : g.intercity) || []).find(r => r.dest === dest);
    const pr = row && cat ? crsN(row[cat]) : 0, info = $('#qkpinfo');
    if (row && pr) { $('#qkprice').value = q.price = pr; info.textContent = 'Prix de la grille ' + crsGridName(g) + ' pour ' + crsCatName(cat) + ' : ' + crsMoney(pr) + ' (modifiable).'; }
    else info.textContent = q.grid ? (cat ? 'Pas de prix dans la grille pour ce véhicule.' : 'Choisir le véhicule pour le prix de la grille.') : ''; };
  const drvAuto = async () => { rd(); const el = $('#qkdinfo'), t = parseLocalDT(q.dep); if (!q.veh || !t) { el.textContent = ''; return; }
    const key = q.veh + '|' + q.dep; MOB.drvKey = key; el.textContent = 'Recherche du contrat…';
    const c = await mfContractAt(q.veh, t.getTime()).catch(() => null); if (MOB.drvKey !== key || !$('#qkdrv')) return;
    if (c) { if (!q.drvManual) { $('#qkdrv').value = q.drv = c.name || ''; $('#qktel').value = q.tel = c.phone || ''; } el.textContent = 'Contrat ' + c.num + ' : ' + (c.name || c.code) + (c.phone ? ' · ' + c.phone : ''); }
    else el.innerHTML = '<b>Aucun contrat</b> sur ce véhicule à cette heure : choisir le chauffeur.'; };
  $('#qkveh').onchange = () => { q.drvManual = false; drvAuto(); if (q.grid) gridPrice(); const co = $('#qkco'); if (co) { const k = co.value; co.innerHTML = mfCoOpts(k, $('#qkveh').value); co.value = k; } };
  $('#qkdep').onchange = () => { const old = q.dep; rd(); const a = parseLocalDT(old), b = parseLocalDT(q.end), n = parseLocalDT(q.dep);
    if (n && a && b && b > a) { q.end = crsLocalDT(new Date(n.getTime() + (b - a))); $('#qkend').value = q.end; } drvAuto(); };
  $('#qkdrv').oninput = $('#qktel').oninput = () => { q.drvManual = true; };
  $('#qkdrv').onchange = () => { rd(); mfDriverFill({ chauffeur: q.drv }).then(st => { if (st.chauffeurTel && !$('#qktel').value) $('#qktel').value = q.tel = st.chauffeurTel; }); };
  $('#qkgrid').onchange = gridPrice;
  document.querySelectorAll('[data-qkt]').forEach(b => b.onclick = e => { e.preventDefault(); rd(); q.type = b.dataset.qkt; cshTabCoursesM(p); });
  $('#qkgo').onclick = async () => {
    rd(); const res = $('#qkres'), btn = $('#qkgo');
    if (!manifWa(q.cphone) && !await ask('Téléphone du client absent ou invalide : le devis ne pourra pas partir sur son WhatsApp. Créer la course quand même ?')) return;
    btn.disabled = true; btn.textContent = 'Création…'; res.innerHTML = '';
    try {
      const o = await crsQuickCreate(q);
      res.innerHTML = msg('Course créée, manifeste et devis en cours…');
      o.mf = await crsMfCreate(o.m, o.f, true);
      try { o.quote = await crsQuoteSave(o.m, o.f, o.p, o.G); } catch (e) { o.quote = null; o.quoteErr = e.message || String(e); }
      MOB.done = o; MOB.q = null;
      cshTabCoursesM(p);
    } catch (e) { btn.disabled = false; btn.textContent = 'Créer la course'; res.innerHTML = msg(e.bad ? esc(e.message) : 'Course non créée : ' + esc(e.message || e), 'err'); }
  };
  if (q.veh && !q.drv) drvAuto();
}
/** Course créée : manifeste au chauffeur, devis au client, sur WhatsApp en PDF */
function mobDoneBind(p) {
  const D = MOB.done, out = $('#mobshr'), say = t => { if (out) out.textContent = t; };
  const go = async (fn) => { try { const how = await fn(); if (how === 'lien') say('WhatsApp ouvert avec le lien du PDF (installer l\'application Android 1.2 pour envoyer le fichier lui-même).'); } catch (e) { alert('Partage impossible : ' + (e.message || e)); } };
  const mf = D.mf && D.mf.r;
  if ($('#mobmfwa')) $('#mobmfwa').onclick = () => go(() => mobSharePdf(mf.blob, mf.name, D.f.driverPhone || mf.d.chauffeurTel, manifText(mf.d, mf.link), mf.link));
  if ($('#mobmfdl')) $('#mobmfdl').onclick = () => mobDownload(mf.blob, mf.name);
  if ($('#mobqwa')) $('#mobqwa').onclick = () => go(async () => {
    let link = null; if (D.quote.path) { const r = await sb.storage.from('devis').createSignedUrl(D.quote.path, 7 * 86400, { download: true }); if (!r.error) link = r.data.signedUrl; }
    CR.f = D.f; CR.cur = D.m;
    return mobSharePdf(D.quote.blob, D.quote.name, D.f.phone, 'Bonjour ' + D.f.client + ',\n' + crsQuoteText(D.p) + (link ? '\nDevis PDF : ' + link : ''), link);
  });
  if ($('#mobqdl')) $('#mobqdl').onclick = () => mobDownload(D.quote.blob, D.quote.name);
  $('#mobnew').onclick = () => { MOB.done = null; cshTabCoursesM(p); };
}
/** À encaisser : courses Ludy de l'agence pas encore encaissées, encaissement à l'arrivée du chauffeur */
function cshCoursesEncM(p, todo, seg) {
  const pct0 = cshN(S.P.cashCommissionPct === undefined ? 10 : S.P.cashCommissionPct);
  const sel = CS.selMission ? todo.find(m => m.id === CS.selMission) || null : null, f = (sel && sel.data && sel.data.f) || {};
  const recent = CS.moves.filter(m => m.caisse === 'courses' && m.kind === 'course' && cshLive(m)).sort((a, b) => String(b.day).localeCompare(String(a.day)) || b.id - a.id);
  const encToday = recent.filter(m => m.day === today()).reduce((t, m) => t + cshN(m.amount), 0);
  const form = `<div class="mcard mform" id="cshcform"><h3>${sel ? 'Encaisser la course ' + esc(sel.number || '') : 'Encaisser une course hors Ludy'}</h3>
    ${sel ? `<div class="small">${esc(fmtDT(sel.start_at))} · ${esc(sel.client_name || '')}${sel.vehicle_key ? ' · ' + esc(mobPlate(sel.vehicle_key)) : ''} · <button type="button" class="mlink" id="ccclr">autre course</button></div>` : ''}
    <label>Chauffeur <input id="ccw" list="cshdrv" autocomplete="off" value="${esc(sel ? sel.driver_name || '' : '')}" placeholder="Nom du chauffeur"></label>
    <div class="mg2"><label>Montant de la course ${mobNum('id="cca"', 'MAD', sel && sel.total_ttc != null ? sel.total_ttc : '')}</label><label>Remis en caisse ${mobNum('id="ccr"', 'MAD')}</label></div>
    <div class="mcalc" id="cccalc" aria-live="polite"></div>
    <details class="mmore"><summary>Trajet, prime, date, commentaire</summary>
      <div class="mg2"><label>Départ <input id="ccf" value="${esc(f.startAddr || f.startCity || '')}"></label><label>Arrivée <input id="cct" value="${esc(f.endAddr || f.endCity || f.dest || '')}"></label></div>
      <div class="mg2"><label>Prime chauffeur (%) <input id="ccp" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(pct0)}"></label><label>Date <input id="ccd" type="date" value="${today()}"></label></div>
      <label>Commentaire <input id="ccm"></label></details>
    <button type="button" class="mbtn" id="ccsave">Encaisser</button></div>`;
  cshBody(seg + `<div class="msum"><div><b class="${todo.length ? 'red' : ''}">${todo.length}</b><span>course${todo.length > 1 ? 's' : ''} à encaisser</span></div><div><b>${cshMoney(encToday)}</b><span>encaissé aujourd'hui</span></div></div>
    ${sel ? form : ''}
    ${todo.length ? '<h3 class="mh">Courses Ludy à encaisser</h3>' + todo.map(m => `<div class="mcard mcrs${sel && sel.id === m.id ? ' on' : ''}"><div class="mch"><div class="mwho2"><b>${esc(m.client_name || m.number || '')}</b><span>${esc(m.number || '')} · ${esc(fmtDT(m.start_at))}${m.driver_name ? ' · ' + esc(m.driver_name) : ''}</span></div>
      <div class="mdecl"><span>${esc(m.status)}</span><b>${m.total_ttc == null ? '—' : cshMoney(m.total_ttc)}</b></div></div>${sel && sel.id === m.id ? '' : `<button type="button" class="mbtn" data-cshms="${m.id}">Encaisser</button>`}</div>`).join('') : '<div class="mempty"><b>Aucune course à encaisser</b><p>Les courses créées apparaissent ici jusqu\'à leur encaissement.</p></div>'}
    ${sel ? '' : '<details class="mmore"><summary>Course hors Ludy</summary>' + form + '</details>'}
    ${recent.length ? '<h3 class="mh">Derniers encaissements (7 jours)</h3>' + recent.slice(0, 30).map(m => `<div class="mcard mline"><div class="mch"><div class="mwho2"><b>${esc(m.driver_code ? cshDrvName(m.driver_code) : m.driver_name || '')}</b><span>${esc(fmtDay(m.day))}${m.label ? ' · ' + esc(m.label) : ''}</span></div>
      <div class="mdecl"><span>Prime ${cshMoney(m.prime)}</span><b>${cshMoney(m.amount)}</b></div></div>${cshCanFix(m) ? `<button type="button" class="mlink" data-cshx="${m.id}">Annuler</button>` : ''}</div>`).join('') : ''}`);
  const calc = () => { const c = cshCourse(cshVal('cca'), cshVal('ccp'), cshVal('ccr') === '' ? cshVal('cca') : cshVal('ccr'));
    $('#cccalc').innerHTML = cshVal('cca') === '' ? '' : `Prime ${cshMoney(c.prime)} · gardée par le chauffeur ${cshMoney(c.paid)} · reste à lui payer ${cshSignedTxt(c.reste)}`; };
  ['cca', 'ccp', 'ccr'].forEach(id => { $('#' + id).oninput = calc; }); calc();
  document.querySelectorAll('[data-cshms]').forEach(b => { b.onclick = () => { CS.selMission = +b.dataset.cshms; cshCoursesEncM(p, todo, seg); const x = $('#cshcform'); if (x && x.scrollIntoView) x.scrollIntoView({ block: 'start' }); }; });
  if ($('#ccclr')) $('#ccclr').onclick = () => { CS.selMission = null; cshCoursesEncM(p, todo, seg); };
  document.querySelectorAll('[data-cshx]').forEach(b => { b.onclick = () => cshCancel(+b.dataset.cshx); });
  $('#ccsave').onclick = async () => {
    const b = $('#ccsave'); b.disabled = true;
    try { if (await cshSaveCourse(sel, { day: cshVal('ccd'), driver: cshVal('ccw'), from: cshVal('ccf'), to: cshVal('cct'), amount: cshVal('cca'), pct: cshVal('ccp'), given: cshVal('ccr'), comment: cshVal('ccm') })) { CS.selMission = null; pageCaisse(); } else b.disabled = false; }
    catch (e) { b.disabled = false; alert(e.message); }
  };
}
