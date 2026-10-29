// Contrats de travail (CDI chauffeur bilingue français / arabe, ou staff en français) : texte du modèle d'Ahmed (contrat_modele.js), PDF vectoriel
// (contrat_pdf.js) ; société employeuse au choix (plusieurs sociétés, gérées par l'administrateur), salarié saisi ou repris
// d'un chauffeur de Ludy. PDF gardé dans le stockage privé « contrats », historique, partage WhatsApp (lien signé 7 jours).
// Chargé avant app.js : utilise ses outils (sb, S, all, msg, esc…) au moment de l'appel.

// bibliothèques chargées seulement sur cette page (versions épinglées dans package.json, vérifiées par npm run check)
const CTR_LIBS = ['https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js',
  'https://cdn.jsdelivr.net/npm/bidi-js@1.0.3/dist/bidi.min.js'];
const CTR_LINK_DAYS = 7;
const CTR_CO_FIELDS = [['name', 'Nom de la société', 26, 'Ex. ATLAS TRANSPORT'], ['sigle', 'Forme (sigle)', 9, 'S.A.R.L'],
  ['forme_fr', 'Forme juridique (français)', 44, 'société à responsabilité limitée de droit marocain'], ['forme_ar', 'Forme juridique (arabe)', 44, 'شركة ذات مسؤولية محدودة بمقتضى القانون المغربي', 1],
  ['capital', 'Capital (dirhams)', 10, 'Ex. 100.000'], ['siege_fr', 'Siège (français)', 52, 'Immeuble …, Rabat - Maroc'], ['siege_ar', 'Siège (arabe, suite de « الكائن مقرها »)', 52, 'بعمارة …، الرباط - المغرب', 1],
  ['rc_ville_fr', 'Ville du registre de commerce', 14, 'Ex. Rabat'], ['rc_ville_ar', 'Ville du RC (arabe)', 14, 'الرباط', 1], ['rc', 'N° RC', 10, ''],
  ['rep_name', 'Dirigeant (nom et prénom)', 24, ''], ['rep_name_ar', 'Dirigeant en arabe (option)', 24, '', 1], ['rep_qual_fr', 'Qualité', 12, 'Ex. Gérant'], ['rep_qual_ar', 'Qualité (arabe)', 12, 'مسيرا', 1],
  ['rh_mail', 'E-mail RH (article 17)', 24, ''], ['rh_tel', 'Téléphone RH', 14, ''], ['ville_fr', 'Ville de signature', 14, 'Ex. Casablanca'], ['ville_ar', 'Ville de signature (arabe)', 14, 'الدار البيضاء', 1]];
const CTR_CO_DEFAULT = { sigle: 'S.A.R.L', forme_fr: 'société à responsabilité limitée de droit marocain', forme_ar: 'شركة ذات مسؤولية محدودة بمقتضى القانون المغربي', rep_civ: 'M' };
const CT = { emp: null, hist: [], drivers: [], draft: null, last: null, coEdit: null };

/** pdf-lib, fontkit, bidi-js et polices arabes (une seule fois) */
let CTR_READY = null;
function ctrLibs() {
  if (!CTR_READY) CTR_READY = (async () => {
    for (const src of CTR_LIBS) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Bibliothèque PDF non chargée (' + src.split('/npm/')[1].split('/')[0] + ')')); document.head.appendChild(s); });
    }
    const font = async f => { const r = await fetch('fonts/' + f); if (!r.ok) throw new Error('Police ' + f + ' introuvable'); return new Uint8Array(await r.arrayBuffer()); };
    return { libs: { PDFLib: window.PDFLib, fontkit: window.fontkit, bidi: window.bidi_js() }, fonts: { r: await font('NotoSansArabic-Regular.ttf'), b: await font('NotoSansArabic-Bold.ttf') } };
  })().catch(e => { CTR_READY = null; throw e; });
  return CTR_READY;
}
const ctrSlug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'salarie';
const ctrFileName = e => 'Contrat-de-travail-' + ctrSlug(e.nom) + '-' + String(e.effet || '').slice(0, 10) + '.pdf';
function ctrText(c, e, link) {
  return ['📄 Ludy · Contrat de travail', (c.name || '') + (c.sigle ? ' ' + c.sigle : ''), 'Salarié : ' + (e.nom || ''), 'Date d\'effet : ' + ctrDate(e.effet),
    link ? 'Contrat PDF à signer : ' + link + ' (lien valable ' + CTR_LINK_DAYS + ' jours)' : 'Contrat PDF joint.'].join('\n');
}
async function ctrLink(path) {
  if (!path) return null;
  const { data, error } = await sb.storage.from('contrats').createSignedUrl(path, CTR_LINK_DAYS * 86400, { download: true });
  if (error) throw error;
  return data.signedUrl;
}

async function pageContratsTravail() {
  const my = ROUTING;
  const head = `<div class="head"><h1>Contrats de travail</h1><div class="sub">Contrat à durée indéterminée repris des modèles : chauffeur (français / arabe) ou staff (chef d'agence, gestionnaire…, français) ; choisir la société, saisir le salarié, générer le PDF à signer. Plusieurs sociétés possibles (nom, dirigeant, siège…). La fiche du salarié est créée ou complétée dans les Ressources humaines.</div></div>`
    + (typeof rhTabsFor === 'function' && rhCan() ? `<div class="tabs">${rhTabsFor().map(x => `<a href="${rhHref(x[0])}" class="${x[0] === 'travail' ? 'on' : ''}">${x[1]}</a>`).join('')}</div>` : '');
  if (!rhCan()) { $('#page').innerHTML = head + msg('Contrats de travail réservés aux gestionnaires, aux ressources humaines et à l\'administrateur.', 'warn'); return; }
  $('#page').innerHTML = head + '<div class="loading">Chargement…</div>';
  let err = '';
  try {
    const [emp, hist, drv] = await Promise.all([all('employers', 'id,name,data,active', null, ['name']), all('work_contracts', '*', null, ['created_at', false]),
      all('drivers', 'code,name,phone,agency_id', null, ['name']).catch(() => [])]);
    CT.emp = emp; CT.hist = hist; CT.drivers = drv;
  } catch (e) { err = e.message || String(e); }
  if (my !== ROUTING) return;
  if (err) { $('#page').innerHTML = head + msg('Contrats de travail pas encore installés dans la base : exécuter <b>supabase/migrations/20261109000000_contrats_travail.sql</b> dans Supabase &gt; SQL Editor. (' + esc(err) + ')', 'err'); return; }
  const st = CT.draft || (CT.draft = { civ: 'M', nat_fr: 'Marocaine', employer_id: (CT.emp.find(x => x.active) || {}).id || '', agency: S.agencies.length === 1 ? S.agencies[0].id : '' });
  // modèle staff (chef d'agence, gestionnaire…) : administrateur et ressources humaines seulement (les gestionnaires ne voient pas le staff)
  if (st.model !== 'staff' || !rhFull()) st.model = 'chauffeur';
  const staff = st.model === 'staff';
  const act = CT.emp.filter(x => x.active || String(x.id) === String(st.employer_id));
  // dates : saisie au clavier JJ/MM/AAAA (le calendrier du navigateur ne permet pas toujours de changer l'année ni de taper les chiffres)
  const inp = (k, label, size, o) => { o = o || {}; const val = o.date ? ctrDate(st[k]) : st[k];
    if (o.date) Object.assign(o, { ph: 'JJ/MM/AAAA' }), size = 11;
    return `<label>${label} <input id="ct_${k}" data-ct="${k}" value="${esc(val == null ? '' : val)}"${size ? ` size="${size}"` : ''}${o.type ? ` type="${o.type}"` : ''}${o.date ? ' data-ctd="1" inputmode="numeric" maxlength="10" autocomplete="off"' : ''}${o.ar ? ' dir="rtl"' : ''}${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.list ? ` list="${o.list}" autocomplete="off"` : ''}></label>`; };
  $('#page').innerHTML = head + `
    ${!CT.emp.length ? msg(rhFull() ? 'Aucune société : l\'ajouter avec « Nouvelle société » (nom, siège, RC, dirigeant…).' : 'Aucune société enregistrée : l\'administrateur doit l\'ajouter (Contrats de travail &gt; Nouvelle société).', 'warn') : ''}
    <div class="grid2 mfgrid"><div>
      <div class="panel"><h2>Société employeuse</h2>
        <div class="mfrow"><label>Société <select id="ctemp"><option value="">Choisir…</option>${act.map(x => `<option value="${x.id}" ${String(x.id) === String(st.employer_id) ? 'selected' : ''}>${esc(x.name)}${x.active ? '' : ' (désactivée)'}</option>`).join('')}</select></label>
          ${rhFull() ? '<button type="button" class="ghost small" id="ctcoed">Modifier</button><button type="button" class="ghost small" id="ctconew">Nouvelle société</button>' : ''}</div>
        <div id="ctcoinfo" class="small"></div><div id="ctcobox"></div></div>
      <div class="panel"><h2>Salarié</h2>
        ${rhFull() ? `<div class="mfrow"><label>Modèle de contrat <select id="ctmodel">${Object.keys(CTR_MODELS).map(k => `<option value="${k}" ${k === st.model ? 'selected' : ''}>${esc(CTR_MODELS[k])}</option>`).join('')}</select></label></div>` : ''}
        ${staff ? `<div class="mfrow">${inp('poste', 'Intitulé du poste', 22, { list: 'ctpostes', ph: 'Ex. Chef d\'agence' })}<datalist id="ctpostes">${CTR_POSTES.map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>
          <label>Catégorie (période d'essai, article 14) <select id="ct_essai_cat" data-ct="essai_cat"><option value="">Choisir…</option>${CTR_ESSAI.map(x => `<option value="${x[0]}" ${x[0] === st.essai_cat ? 'selected' : ''}>${esc(x[2])}</option>`).join('')}</select></label>
          ${inp('lieu_travail', 'Lieu de travail (ville)', 14, { ph: 'Ex. Casablanca' })}</div>`
        : `<div class="mfrow"><label>Chauffeur de Ludy (option) <input id="ctdrv" list="ctdrvl" value="${esc(st.drvName || '')}" placeholder="Remplit nom, téléphone, agence" size="26" autocomplete="off"></label>
          <datalist id="ctdrvl">${CT.drivers.filter(d => d.code !== HORS && d.name).map(d => `<option value="${esc(d.name)}"></option>`).join('')}</datalist></div>`}
        <div class="mfrow"><label>Civilité <select id="ct_civ" data-ct="civ"><option value="M" ${st.civ !== 'Mme' ? 'selected' : ''}>M.</option><option value="Mme" ${st.civ === 'Mme' ? 'selected' : ''}>Mme</option></select></label>
          ${inp('nom', 'Nom et prénom', 24, { ph: 'Ex. Ali BENNANI' })}${staff ? '' : inp('nom_ar', 'Nom et prénom en arabe (option)', 22, { ar: 1 })}</div>
        <div class="mfrow">${inp('naiss', 'Date de naissance', 0, { date: 1 })}${inp('lieu', 'Lieu de naissance', 18)}${staff ? '' : inp('lieu_ar', 'Lieu de naissance en arabe (option)', 18, { ar: 1 })}</div>
        <div class="mfrow">${inp('nat_fr', 'Nationalité', 12)}${staff ? '' : inp('nat_ar', 'Nationalité en arabe', 12, { ar: 1, ph: '' })}${inp('cin', 'N° CIN', 12, { ph: 'Ex. AB123456' })}</div>
        <div class="mfrow">${inp('adresse', 'Adresse', 36)}${staff ? '' : inp('adresse_ar', 'Adresse en arabe (option)', 36, { ar: 1 })}</div>
        <div class="mfrow">${inp('tel', 'Téléphone (pour WhatsApp, pas dans le contrat)', 15, { ph: '06…' })}
          <label>Agence <select id="ct_agency" data-ct="agency">${agOptions(st.agency, rhFull() ? '— aucune —' : '— choisir —')}</select></label></div>
        <div class="small">${staff ? 'Contrat du staff en français seulement, repris du modèle (contrat d\'une assistante RH) : intitulé du poste au choix.' : 'Sans traduction arabe, le nom, le lieu et l\'adresse sont repris en lettres latines dans la colonne arabe.'}</div></div>
      <div class="panel"><h2>Contrat</h2>
        <div class="mfrow">${inp('effet', 'Date d\'effet', 0, { date: 1 })}${inp('sal', 'Salaire net mensuel (dirhams)', 0, { type: 'number' })}${inp('date_sig', 'Date de signature (vide : à écrire à la main)', 0, { date: 1 })}</div>
        ${staff ? '' : `<div class="mfrow">${inp('sal_fr', 'Salaire en lettres (français)', 34)}${inp('sal_ar', 'Salaire en lettres (arabe)', 30, { ar: 1 })}</div>
        <div class="small">Montant en lettres proposé automatiquement (gris) : à corriger si besoin en le tapant.</div>`}
        <div class="mfgo"><button id="ctgen">Générer le contrat PDF</button> <span id="ctmiss" class="small"></span></div></div>
      <div id="ctdone"></div>
    </div><div>
      <div class="panel"><h2>Contrats générés (${CT.hist.length})</h2><div id="cthist"></div></div>
    </div></div>`;
  ctrBind(); ctrCoInfo(); ctrHistory();
  if (CT.last) ctrDone(CT.last);
}

function ctrCo() { const e = CT.emp.find(x => String(x.id) === String(CT.draft.employer_id)); return e ? Object.assign({ name: e.name }, e.data || {}) : null; }
function ctrCoInfo() {
  const c = ctrCo(), box = $('#ctcoinfo'); if (!box) return;
  box.innerHTML = c ? esc([c.name + (c.sigle ? ' ' + c.sigle : ''), c.capital ? 'capital ' + c.capital + ' DH' : '', c.rc ? 'RC ' + (c.rc_ville_fr || '') + ' ' + c.rc : '',
    (c.rep_civ === 'Mme' ? 'Mme ' : 'M. ') + (c.rep_name || '?') + ', ' + (c.rep_qual_fr || (c.rep_civ === 'Mme' ? 'Gérante' : 'Gérant'))].filter(Boolean).join(' · ')) : '';
}
function ctrRead() {
  const st = CT.draft;
  st.badDates = [];
  document.querySelectorAll('[data-ct]').forEach(i => {
    if (!i.dataset.ctd) { st[i.dataset.ct] = i.value.trim(); return; }
    const d = ctrParseDate(i.value);
    st[i.dataset.ct] = d || ''; i.classList.toggle('bad', d === null);
    if (d === null) st.badDates.push(i.closest('label').firstChild.textContent.trim());
  });
  st.employer_id = $('#ctemp').value; st.drvName = $('#ctdrv') ? $('#ctdrv').value.trim() : '';
  if ($('#ctmodel')) st.model = $('#ctmodel').value;
  return st;
}
/** Valeurs proposées (montant en lettres, nationalité en arabe) affichées en gris dans les cases vides */
function ctrHints() {
  const st = ctrRead(), v = ctrFields({}, Object.assign({}, st, { sal_fr: '', sal_ar: '', nat_ar: '' }));
  if ($('#ct_sal_fr')) { $('#ct_sal_fr').placeholder = v.sal_fr || ''; $('#ct_sal_ar').placeholder = v.sal_ar ? v.sal_ar + ' (' + v.sal + ') ' + v.dh_ar : ''; }
  if ($('#ct_nat_ar')) $('#ct_nat_ar').placeholder = v.nat_ar || 'à saisir';
  const c = ctrCo(), miss = c ? ctrMissing(c, st, st.model) : ['Société'];
  if (!rhFull() && !st.agency) miss.push('Agence');
  st.badDates.forEach(l => miss.push(l + ' invalide (JJ/MM/AAAA)'));
  const co = miss.filter(x => /^Société : /.test(x)).map(x => x.slice(10)), rest = miss.filter(x => !/^Société : /.test(x));
  $('#ctmiss').textContent = !miss.length ? 'Prêt.' : [co.length ? 'Fiche de la société à compléter (' + (rhFull() ? 'bouton Modifier' : 'administrateur') + ') : ' + co.join(', ') + '.' : '',
    rest.length ? 'À compléter : ' + rest.join(', ') + '.' : ''].filter(Boolean).join(' ');
  return miss;
}
function ctrBind() {
  document.querySelectorAll('[data-ct]').forEach(i => { i.oninput = ctrHints; i.onchange = ctrHints; });
  // dates : « / » ajoutés en tapant les chiffres (31011990 -> 31/01/1990)
  document.querySelectorAll('[data-ctd]').forEach(i => i.addEventListener('input', e => {
    if (e.inputType && /^delete/.test(e.inputType)) return;
    const dg = i.value.replace(/\D/g, '').slice(0, 8);
    if (/^\d+$/.test(i.value.replace(/\//g, '')) && i.selectionStart === i.value.length) i.value = dg.slice(0, 2) + (dg.length > 2 ? '/' + dg.slice(2, 4) : '') + (dg.length > 4 ? '/' + dg.slice(4) : '');
    ctrHints();
  }));
  $('#ct_effet').addEventListener('change', () => { if (!$('#ct_date_sig').value && ctrParseDate($('#ct_effet').value)) { $('#ct_date_sig').value = $('#ct_effet').value; ctrHints(); } });
  $('#ctemp').onchange = () => { ctrRead(); ctrCoInfo(); ctrHints(); };
  if ($('#ctmodel')) $('#ctmodel').onchange = () => { ctrRead(); CT.last = null; pageContratsTravail(); };
  if ($('#ctdrv')) $('#ctdrv').onchange = () => {
    const n = $('#ctdrv').value.trim().toLowerCase(), d = CT.drivers.find(x => String(x.name || '').toLowerCase() === n);
    if (!d) return;
    if (!$('#ct_nom').value.trim()) $('#ct_nom').value = d.name;
    if (!$('#ct_tel').value.trim() && d.phone) $('#ct_tel').value = d.phone;
    if (d.agency_id && $(`#ct_agency option[value="${d.agency_id}"]`)) $('#ct_agency').value = String(d.agency_id);
    CT.draft.driver_code = d.code; CT.draft._linkName = $('#ct_nom').value.trim() || d.name; ctrHints();
  };
  if ($('#ctcoed')) $('#ctcoed').onclick = () => { const e = CT.emp.find(x => String(x.id) === $('#ctemp').value); if (!e) { alert('Choisir la société à modifier.'); return; } ctrCoEditor(e); };
  if ($('#ctconew')) $('#ctconew').onclick = () => ctrCoEditor(null);
  $('#ctgen').onclick = ctrGenerate;
  ctrHints();
}

// ---------- Sociétés (administrateur) ----------
function ctrCoEditor(e) {
  const c = Object.assign({}, CTR_CO_DEFAULT, e ? Object.assign({ name: e.name }, e.data || {}) : {}), box = $('#ctcobox');
  box.innerHTML = `<div class="ctco"><h3>${e ? 'Modifier ' + esc(e.name) : 'Nouvelle société'}</h3>
    <div class="mfrow"><label>Dirigeant <select id="ctco_rep_civ"><option value="M" ${c.rep_civ !== 'Mme' ? 'selected' : ''}>Monsieur</option><option value="Mme" ${c.rep_civ === 'Mme' ? 'selected' : ''}>Madame</option></select></label></div>
    <div class="mfrow">${CTR_CO_FIELDS.map(f => `<label>${f[1]} <input data-ctco="${f[0]}" value="${esc(c[f[0]] || '')}" size="${f[2]}"${f[4] ? ' dir="rtl"' : ''}${f[3] ? ` placeholder="${esc(f[3])}"` : ''}></label>`).join('')}</div>
    ${e ? `<label class="chk"><input type="checkbox" id="ctco_act" ${e.active ? 'checked' : ''}> Société active (proposée dans la liste)</label>` : ''}
    <div class="mfgo"><button id="ctcosave">Enregistrer la société</button> <button class="ghost" id="ctcocancel">Annuler</button> <span id="ctcores"></span></div>
    <div class="small">Les contrats déjà générés gardent la société telle qu'elle était au moment du contrat.</div></div>`;
  $('#ctcocancel').onclick = () => { box.innerHTML = ''; };
  $('#ctcosave').onclick = async () => {
    const d = { rep_civ: $('#ctco_rep_civ').value }; box.querySelectorAll('[data-ctco]').forEach(i => { d[i.dataset.ctco] = i.value.trim(); });
    const name = d.name; delete d.name;
    if (!name) { $('#ctcores').innerHTML = '<span class="err">Nom de la société obligatoire.</span>'; return; }
    const row = { name, data: d }; if (e) row.active = $('#ctco_act').checked;
    const r = e ? await sb.from('employers').update(row).eq('id', e.id).select('id,name,data,active').single() : await sb.from('employers').insert(row).select('id,name,data,active').single();
    if (r.error) { $('#ctcores').innerHTML = '<span class="err">Erreur : ' + esc(r.error.message) + '</span>'; return; }
    CT.emp = CT.emp.filter(x => x.id !== r.data.id).concat([r.data]).sort((a, b) => a.name.localeCompare(b.name));
    ctrRead(); CT.draft.employer_id = r.data.id; pageContratsTravail();
  };
}

// ---------- Génération ----------
async function ctrGenerate() {
  const miss = ctrHints(), st = Object.assign({}, CT.draft), c = ctrCo(), btn = $('#ctgen');
  // chauffeur / fiche RH choisis pour un autre nom (nouveau salarié saisi ensuite) : contrat non rattaché à eux
  const nk = x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if ((st.driver_code || st.employee_id) && nk(st._linkName) !== nk(st.nom)) { delete st.driver_code; delete st.employee_id; delete CT.draft.driver_code; delete CT.draft.employee_id; }
  if (miss.length) { alert('À compléter : ' + miss.join(', ') + '.'); return; }
  btn.disabled = true; btn.textContent = 'Création du PDF…';
  try {
    CT.last = await ctrMake(c, st);
    if (CT.last.row) CT.hist.unshift(CT.last.row);
    ctrDone(CT.last); ctrHistory();
  } catch (e) { alert(e.message || e); }
  btn.disabled = false; btn.textContent = 'Générer le contrat PDF';
}
async function ctrMake(c, st) {
  const L = await ctrLibs(), e = Object.assign({}, st);
  const staff = e.model === 'staff';
  const bytes = await ctpBuild({ title: 'Contrat de travail · ' + e.nom, mono: staff, rows: ctrBlocks(c, e, e.model) }, L.libs, L.fonts);
  const blob = new Blob([bytes], { type: 'application/pdf' }), name = ctrFileName(e), ag = e.agency ? +e.agency : null;
  let path = null, link = null, upErr = '';
  try {
    // staff : dossier 0 du stockage (administrateur et ressources humaines, jamais un gestionnaire)
    const pth = (staff ? 0 : ag || 0) + '/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '.pdf';
    const up = await sb.storage.from('contrats').upload(pth, blob, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw up.error;
    path = pth; link = await ctrLink(path);
  } catch (x) { upErr = x.message || String(x); }
  const emp = CT.emp.find(x => String(x.id) === String(st.employer_id));
  const row = { employer_id: emp ? emp.id : null, agency_id: ag, driver_code: e.driver_code || null, name: e.nom, cin: String(e.cin || '').toUpperCase(),
    effective_on: e.effet || null, pdf_path: path, data: { emp: e, company: c, file_name: name } };
  if (staff) { row.model = 'staff'; row.driver_code = null; }
  const ins = await sb.from('work_contracts').insert(row).select('id,created_at').single();
  if (ins.error && staff && /model/.test(ins.error.message)) ins.error.message = 'contrat du staff pas encore installé : exécuter supabase/migrations/20261115000000_contrat_staff.sql dans Supabase > SQL Editor (' + ins.error.message + ')';
  const empId = ins.error ? '' : await ctrLinkEmployee(e, emp ? emp.id : null, ins.data.id, ag);
  return { c, e, blob, name, link, path, upErr, empId, saveErr: ins.error ? ins.error.message : '', row: ins.error ? null : Object.assign({}, row, ins.data, { employee_id: empId || null }) };
}
/** Fiche RH du chauffeur créée (ou complétée : seulement les champs vides) à la génération du contrat ; contrat rattaché à la fiche */
async function ctrLinkEmployee(e, employerId, wcId, ag) {
  try {
    let cur = null;
    if (e.employee_id) cur = (await sb.from('hr_employees').select('*').eq('id', e.employee_id).maybeSingle()).data;
    if (!cur && e.driver_code) cur = (await sb.from('hr_employees').select('*').eq('driver_code', e.driver_code).maybeSingle()).data;
    if (!cur && e.cin) { const r = await sb.from('hr_employees').select('*').ilike('cin', String(e.cin).trim()).limit(1); cur = r.data && r.data[0]; }
    const staff = e.model === 'staff', es = CTR_ESSAI.find(x => x[0] === e.essai_cat);
    const fill = { name: e.nom, cin: String(e.cin || '').trim().toUpperCase() || null, birth_date: e.naiss || null, phone: e.tel || null, employer_id: employerId, agency_id: ag,
      driver_code: staff ? null : e.driver_code || null, position: staff ? e.poste || null : 'Chauffeur', hired_on: e.effet || null, salary: +e.sal || null };
    if (staff && es) { fill.category = es[0]; fill.trial_months = es[3]; }
    let r;
    if (cur) {
      const up = { work_contract_id: wcId };
      Object.keys(fill).forEach(k => { if (fill[k] != null && (cur[k] == null || cur[k] === '') && (k !== 'driver_code' || cur.kind === 'chauffeur')) up[k] = fill[k]; });
      r = await sb.from('hr_employees').update(up).eq('id', cur.id).select('id').single();
    } else r = await sb.from('hr_employees').insert(Object.assign({ kind: staff ? 'staff' : 'chauffeur', work_contract_id: wcId }, fill)).select('id').single();
    if (r.error) return '';
    await sb.from('work_contracts').update({ employee_id: r.data.id }).eq('id', wcId);
    return r.data.id;
  } catch (x) { return ''; }   // ressources humaines pas encore installées : le contrat reste valable
}
function ctrDone(m) {
  const box = $('#ctdone'); if (!box) return;
  const txt = ctrText(m.c, m.e, m.link), wa = typeof manifWa === 'function' ? manifWa(m.e.tel) : '';
  const canFile = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([m.blob], m.name, { type: 'application/pdf' })] })); } catch (e) { return false; } })();
  box.innerHTML = `<div class="panel mfok"><h2>Contrat prêt</h2><div class="small">${esc(m.name)} · à imprimer en deux exemplaires et à signer${m.empId ? ` · <a href="#/rh?t=fiche&id=${m.empId}">fiche du salarié (Ressources humaines)</a>` : ''}</div>
    ${m.saveErr ? msg('Contrat non enregistré dans l\'historique : ' + esc(m.saveErr), 'warn') : ''}
    ${m.link ? '' : msg('PDF non mis en ligne (' + esc(m.upErr || 'stockage indisponible') + ') : le message part sans lien, joignez le PDF téléchargé.', 'warn')}
    <div class="adact mfact"><button class="small" id="ctdl">Télécharger le PDF</button><button class="ghost small" id="ctopen">Ouvrir</button>
      ${wa ? `<a class="btn small ghostb" href="https://wa.me/${wa}?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">WhatsApp au salarié</a>` : ''}
      <a class="btn small ghostb" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">WhatsApp (choisir le contact)</a>
      ${canFile ? '<button class="ghost small" id="ctshare">Partager le PDF…</button>' : ''}</div></div>`;
  $('#ctdl').onclick = () => { const u = URL.createObjectURL(m.blob), a = document.createElement('a'); a.href = u; a.download = m.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  $('#ctopen').onclick = () => { const u = m.link || URL.createObjectURL(m.blob); if (!(m.link && openOut(u))) window.open(u, '_blank', 'noopener'); };
  if ($('#ctshare')) $('#ctshare').onclick = () => navigator.share({ files: [new File([m.blob], m.name, { type: 'application/pdf' })], text: txt }).catch(() => { });
}
function ctrHistory() {
  const box = $('#cthist'); if (!box) return;
  const coName = h => (h.data && h.data.company && h.data.company.name) || ((CT.emp.find(x => x.id === h.employer_id) || {}).name || '');
  box.innerHTML = table('cth', [['Créé le', h => esc(fmtDTY(h.created_at)), h => h.created_at], ['Salarié', h => esc(h.name || '') + (h.model === 'staff' ? '<br><span class="small">' + esc(((h.data || {}).emp || {}).poste || 'Staff') + '</span>' : '')], ['CIN', h => esc(h.cin || '')], ['Société', h => esc(coName(h))],
    ['Effet', h => esc(ctrDate(h.effective_on)), h => h.effective_on || ''], ['Agence', h => esc(S.agName[h.agency_id] || '')],
    ['Signature / légalisation', h => { const l = rhLegal(h); return (l.step === 'legalise' ? '<span class="ok">' : '<span class="warn">') + esc(h.ended_on ? 'Clos' : l.txt) + '</span>' + (h.employee_id ? ` <a class="small" href="${rhHref('fiche', 'id=' + h.employee_id + '&go=wc')}">suivi</a>` : ''); }],
    ['', h => `<span class="mfha">${h.pdf_path ? `<button class="ghost small" data-ctpdf="${h.id}">PDF</button><button class="ghost small" data-ctwa="${h.id}">WhatsApp</button>` : ''}<button class="ghost small" data-ctre="${h.id}">Reprendre</button>${rhFull() ? `<button class="ghost small" data-ctdel="${h.id}">Supprimer</button>` : ''}</span>`]],
    CT.hist, { empty: 'Aucun contrat généré', page: true });
  window.__rerender = ctrHistory;
  const byId = id => CT.hist.find(h => String(h.id) === String(id));
  box.querySelectorAll('[data-ctpdf]').forEach(b => b.onclick = async () => { try { const u = await ctrLink(byId(b.dataset.ctpdf).pdf_path); if (!openOut(u)) window.open(u, '_blank', 'noopener'); } catch (e) { alert('PDF inaccessible : ' + e.message); } });
  box.querySelectorAll('[data-ctwa]').forEach(b => b.onclick = async () => {
    const h = byId(b.dataset.ctwa), d = h.data || {}; let link = null; try { link = await ctrLink(h.pdf_path); } catch (e) { }
    const wa = typeof manifWa === 'function' ? manifWa((d.emp || {}).tel) : '', u = 'https://wa.me/' + (wa || '') + '?text=' + encodeURIComponent(ctrText(d.company || {}, d.emp || {}, link));
    if (!openOut(u)) window.open(u, '_blank', 'noopener');
  });
  box.querySelectorAll('[data-ctre]').forEach(b => b.onclick = () => {
    const h = byId(b.dataset.ctre), e = (h.data && h.data.emp) || {};
    CT.draft = Object.assign({}, e, { employer_id: CT.emp.some(x => x.id === h.employer_id) ? h.employer_id : e.employer_id }); CT.last = null; pageContratsTravail(); window.scrollTo(0, 0);
  });
  box.querySelectorAll('[data-ctdel]').forEach(b => b.onclick = async () => {
    const h = byId(b.dataset.ctdel); if (!await ask('Supprimer le contrat de ' + (h.name || '') + ' de l\'historique ?')) return;
    const r = await sb.from('work_contracts').delete().eq('id', h.id);
    if (r.error) { alert(r.error.message); return; }
    if (h.pdf_path) await sb.storage.from('contrats').remove([h.pdf_path]).catch(() => { });
    CT.hist = CT.hist.filter(x => x.id !== h.id); ctrHistory();
  });
}
