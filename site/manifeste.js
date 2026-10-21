// Manifestes de passagers (transport touristique) : même document que le modèle d'Ahmed (formulaires officiels en fond,
// mêmes positions), véhicules et chauffeurs pris dans Ludy ; PDF gardé dans le stockage « manifestes » ; partage WhatsApp / e-mail.
// Chargé avant app.js : utilise ses outils (sb, S, all, msg, esc…) au moment de l'appel.

const MANIF_BG = { bg1: 'manifeste/resident-1.jpg', bg2: 'manifeste/resident-2.jpg', bg3: 'manifeste/non-resident.jpg' };
const MANIF_PRESTA = ['Transfert', 'Transfert aéroport', 'Circuit', 'Mise à disposition'];
const MANIF_NATURES = ['Transfert', 'Excursion', 'Tourisme', 'Affaires', 'Mise à disposition'];
const MANIF_SEATS = { staria: 9, sonata: 4 };   // places autorisées par modèle quand le parc ne les donne pas
const MANIF_LINK_DAYS = 7;                      // validité du lien du PDF dans les messages
const MANIF_PLACES = ['Aéroport Mohammed V, Casablanca', 'Aéroport Marrakech Menara', 'Aéroport Rabat-Salé', 'Aéroport Tanger Ibn Battouta',
  'Aéroport Fès-Saïss', 'Aéroport Agadir Al Massira', 'Gare Casa-Port, Casablanca', 'Gare Casa-Voyageurs, Casablanca',
  'Gare Rabat-Ville', 'Gare Rabat-Agdal', 'Gare de Marrakech', 'Gare Tanger Ville', 'Gare de Fès'];

/** PDF du manifeste (repris tel quel du modèle) : fonds officiels, texte posé dans les cases, cachet */
function buildManifest(jsPDFCtor, d, A) {
  const doc = new jsPDFCtor({ unit: 'pt', format: [595, 841], compress: true });
  doc.setTextColor(10, 25, 60);
  function fit(txt, x, cy, maxW, size, minSize) {
    txt = (txt == null ? '' : String(txt)).trim();
    if (!txt) return;
    size = size || 10; minSize = minSize || 6;
    doc.setFont('helvetica', 'normal');
    let s = size;
    doc.setFontSize(s);
    while (doc.getTextWidth(txt) > maxW && s > minSize) { s -= 0.5; doc.setFontSize(s); }
    if (doc.getTextWidth(txt) > maxW) {   // tronque
      while (txt.length > 1 && doc.getTextWidth(txt + '…') > maxW) txt = txt.slice(0, -1);
      txt += '…';
    }
    doc.text(txt, x, cy + s * 0.35);
  }
  function two(txt, x, cy, maxW, size) {
    txt = (txt || '').trim(); if (!txt) return;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size);
    if (doc.getTextWidth(txt) <= maxW) { fit(txt, x, cy, maxW, size); return; }
    let lines = doc.splitTextToSize(txt, maxW);
    if (lines.length > 2) lines = [lines[0], lines.slice(1).join(' ')];
    fit(lines[0], x, cy - size * 0.55, maxW, size, 5.5);
    fit(lines[1], x, cy + size * 0.55, maxW, size, 5.5);
  }
  function bold(txt, x, cy, maxW, size) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(size);
    doc.text(txt, x, cy + size * 0.35);
    doc.setFont('helvetica', 'normal');
  }
  function stamp(cx, cy) {
    if (!A.stamp) return;
    const w = A.stampW || 110, h = w * (A.stampRatio || 1);
    doc.addImage(A.stamp, A.stampFmt || 'PNG', cx - w / 2, cy - h / 2, w, h, 'stamp', 'FAST');
  }
  const V = 230, W = 178;   // colonne valeur
  const C = d.company;
  function itinerary(rows) {
    fit(d.depart, V, rows.depart, W, 10);
    fit(d.prestation, V, rows.type, W, 10);
    fit(d.terminus, V, rows.terminus, W, 10);
    fit(d.nature, V, rows.nature, W, 10);
    fit(d.dateDepart, V, rows.dateDep, W, 10);
    fit(d.dateRetour, V, rows.dateRet, W, 10);
    two(d.observations, V, rows.obs, W, 9);
    fit(d.etabli, rows.etabliX, rows.etabliY, 90, 10);
  }
  function company(rows) {
    fit(C.autorisation, V, rows.aut, W, 10);
    fit(C.dossier, V, rows.dos, W, 10);
    fit(C.nom, V, rows.den, W, 10);
    two(C.adresse, V, rows.adr, W, 8.5);
    fit(C.tel, V, rows.tel, W, 10);
    bold('(' + (d.vehicule.marque || 'HYUNDAI').toUpperCase() + ' ' + String(d.vehicule.modele || '').toUpperCase() + ')', rows.modX, rows.mod, 150, 10.5);
    fit(d.vehicule.plaque, V, rows.imm, W, 11);
    fit(String(d.vehicule.places), V, rows.pla, W, 10);
    fit(d.vehicule.remplacement, V, rows.rem, W, 10);
  }
  if (d.type === 'resident') {
    // page 1 : donneur d'ordre + passagers
    doc.addImage(A.bg1, 'JPEG', 0, 0, 595, 841, 'bg1', 'FAST');
    fit(d.donneur, V, 185.3, W, 10.5);
    fit(d.cin, V, 204.4, W, 10.5);
    (d.passagers || []).forEach((p, i) => {
      if (i >= 59) return;
      const col = i < 30 ? 0 : 1, r = col ? i - 30 : i;
      const cy = (607 + 32.1 * r) * 0.48;
      fit(p, col ? 326 : 81, cy, col ? 240 : 208, 10);
    });
    // page 2 : itinéraire + transporteur
    doc.addPage([595, 841]);
    doc.addImage(A.bg2, 'JPEG', 0, 0, 595, 841, 'bg2', 'FAST');
    itinerary({ depart: 94.6, type: 116.2, terminus: 137.8, nature: 157.9, dateDep: 177.6, dateRet: 196.8, obs: 220.3, etabliX: 218, etabliY: 255 });
    company({ aut: 409.4, dos: 429.6, den: 486.2, adr: 505.4, tel: 524.4, mod: 559.2, modX: 218, imm: 579.4, pla: 598.4, rem: 620 });
    stamp(342, 698);
  } else {
    doc.addImage(A.bg3, 'JPEG', 0, 0, 595, 841, 'bg3', 'FAST');
    fit(d.donneur, V, 130.6, W, 10.5);
    fit(String(d.nbPassagers || ''), V, 148.8, W, 10.5);
    itinerary({ depart: 205, type: 225.6, terminus: 248, nature: 267.8, dateDep: 287, dateRet: 306.2, obs: 330, etabliX: 216, etabliY: 355 });
    company({ aut: 467.6, dos: 486.7, den: 544.4, adr: 563.2, tel: 582, mod: 617, modX: 202, imm: 637.7, pla: 656.3, rem: 677.8 });
    stamp(352, 741);
  }
  return doc;
}

// ---------- Outils (sans dépendance au site : testés sous Node) ----------
/** « 2026-10-17T14:30 » → « 17/10/2026 à 14:30 » ; « 2026-10-18 » → « 18/10/2026 » (heure du Maroc saisie telle quelle) */
function manifFrDate(iso) { if (!iso) return ''; const p = String(iso).split('T'), d = p[0].split('-'); let s = d[2] + '/' + d[1] + '/' + d[0]; if (p[1]) s += ' à ' + p[1].slice(0, 5); return s; }
function manifSlug(s, n) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, n || 40); }
/** Nom du fichier (comme le modèle) : Manifeste-Mission-JJMMAA-HHhMM-Chauffeur.pdf */
function manifFileName(d) {
  const r = d.dateDep || '', mission = r ? r.slice(8, 10) + r.slice(5, 7) + r.slice(2, 4) + '-' + r.slice(11, 13) + 'h' + r.slice(14, 16) : '';
  return 'Manifeste-Mission-' + mission + '-' + manifSlug(d.chauffeur || 'chauffeur', 30) + '.pdf';
}
/** Numéro pour WhatsApp (wa.me) : 06 12 34 56 78 → 212612345678 ; vide si le numéro n'est pas reconnu */
function manifWa(phone) {
  let s = String(phone || '').replace(/\D/g, '');
  if (/^00/.test(s)) s = s.slice(2);
  if (/^2120[5-7]\d{8}$/.test(s)) s = '212' + s.slice(4);   // « +212 (0)6 … » : zéro national en trop
  if (/^0[5-7]\d{8}$/.test(s)) s = '212' + s.slice(1);
  else if (/^[5-7]\d{8}$/.test(s)) s = '212' + s;
  return /^\d{10,15}$/.test(s) ? s : '';
}
/** Message détaillé (WhatsApp, e-mail) */
function manifText(d, link) {
  const v = d.vehicule || {}, L = [];
  L.push('📄 Ludy · Manifeste de passagers');
  L.push('Mission du ' + d.dateDepart);
  L.push('Chauffeur : ' + (d.chauffeur || 'non renseigné') + (d.chauffeurTel ? ' · ' + d.chauffeurTel : ''));
  L.push('Véhicule : ' + v.plaque + ' · ' + [v.marque, v.modele].filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join(' ') + (v.places ? ' · ' + v.places + ' places' : ''));
  if (v.remplacement) L.push('Véhicule de remplacement : ' + v.remplacement);
  L.push('Client : ' + d.donneur + (d.type === 'resident' ? ' (résident)' : ' (non résident)'));
  if (d.type === 'resident') L.push('Passagers (' + (d.passagers || []).length + ') : ' + (d.passagers || []).join(', '));
  else L.push('Passagers : ' + d.nbPassagers);
  L.push('Trajet : ' + d.depart + ' → ' + d.terminus);
  L.push('Prestation : ' + d.prestation + (d.nature ? ' · nature : ' + d.nature : ''));
  if (d.dateRetour) L.push('Retour : ' + d.dateRetour);
  if (d.observations) L.push('Observations : ' + d.observations);
  if (link) L.push('Manifeste PDF : ' + link + ' (lien valable ' + MANIF_LINK_DAYS + ' jours)');
  return L.join('\n');
}
/** Places autorisées : parc, sinon modèle */
function manifSeats(model, parcSeats) { const n = parseInt(parcSeats, 10); if (n > 0) return n; const m = String(model || '').toLowerCase(); return Object.keys(MANIF_SEATS).filter(k => m.indexOf(k) >= 0).map(k => MANIF_SEATS[k])[0] || ''; }

// ---------- Page Manifeste ----------
const MF = { cfg: null, parc: [], bg: {}, last: null, draft: null, hist: [], drvAuto: null };
function mfParcOf(v) { const n = normPlate(v.plate); return MF.parc.find(p => normPlate(p.plate) === n) || MF.parc.find(p => String(v.other_plates || '').split(/[,;]/).some(o => o.trim() && normPlate(o) === normPlate(p.plate))) || {}; }
function mfVehicles() { const ok = inAgency(); return S.vehList.filter(v => ok(v.key) && String(v.active || 'OUI').toUpperCase() !== 'NON').sort((a, b) => String(a.plate).localeCompare(String(b.plate))); }
function mfVeh(key) {
  const v = S.veh[key]; if (!v) return null; const p = mfParcOf(v);
  return { key, plaque: v.plate, marque: String(v.brand || p.brand || 'HYUNDAI').toUpperCase(), modele: String(v.model || p.model || '').replace(/^hyundai\s+/i, ''), places: manifSeats(v.model || p.model, p.seats), autorisation: String(p.agrement || '').trim() };
}
function mfNowLocal() { const d = new Date(), p = parts(d); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute; }
/** Contrat en cours sur le véhicule à l'heure de départ (chauffeur du manifeste) */
async function mfContractAt(key, t) {
  const tol = num(S.P.ctrTolMin, 20) * MIN;
  const list = await withSuccessors(await all('contracts', 'num,client_code,name,phone,email,vehicle_key,start_at,end_at', q => q.eq('vehicle_key', key)
    .lte('start_at', new Date(t + tol).toISOString()).or('end_at.is.null,end_at.gte.' + new Date(t - tol).toISOString())));
  const eff = ctrEffEnds(list.filter(c => c.vehicle_key === key), t).map(c => ({ c, a: new Date(c.start_at).getTime(), b: c._end !== null ? c._end : t + HOUR }));
  let best = null; eff.forEach(x => { if (t >= x.a && t <= x.b) best = x; });
  if (!best) { let bd = Infinity; eff.forEach(x => { const dd = t < x.a ? x.a - t : t - x.b; if (dd <= tol && dd < bd) { bd = dd; best = x; } }); }
  if (!best) return null;
  const c = best.c; let phone = c.phone || '', email = c.email || '';
  if ((!phone || !email) && c.client_code) { const { data } = await sb.from('drivers').select('phone,email').eq('code', c.client_code).maybeSingle(); if (data) { phone = phone || data.phone || ''; email = email || data.email || ''; } }
  return { name: c.name || S.drv[c.client_code] || c.client_code, code: c.client_code, phone, email, num: c.num };
}
async function mfImage(url) {
  if (MF.bg[url]) return MF.bg[url];
  const r = await fetch(url); if (!r.ok) throw new Error('fond du manifeste introuvable (' + url + ')');
  return (MF.bg[url] = new Uint8Array(await r.arrayBuffer()));
}
function mfRatio(src) { return new Promise(res => { const i = new Image(); i.onload = () => res(i.height / i.width || 1); i.onerror = () => res(1); i.src = src; }); }

async function pageManifeste() {
  const P = S.P, q = qs(), my = ROUTING;
  let cfgErr = '';
  try {
    const [c, parc] = await Promise.all([sb.from('manifest_config').select('*').eq('id', 1).maybeSingle(), all('parc', '*').catch(() => [])]);
    if (c.error) throw new Error(c.error.message);
    MF.cfg = c.data || { company: {}, email_to: '', stamp: null }; MF.parc = parc;
  } catch (e) { cfgErr = e.message; MF.cfg = { company: {}, email_to: '', stamp: null }; }
  const since = new Date(Date.now() - 60 * DAY).toISOString();
  MF.hist = cfgErr ? [] : await all('manifests', 'id,created_at,vehicle_key,plate,driver_name,driver_phone,client,depart_at,file_name,file_path,data', x => x.gte('created_at', since), ['created_at', false]).catch(() => []);
  if (my !== ROUTING) return;   // autre page demandée pendant le chargement
  const vs = mfVehicles(), edit = canEdit();
  const st = MF.draft || { type: 'resident', nb: 1, prestation: 'Transfert', nature: 'Transfert', passengers: [''], donneurVoyage: true, dateDep: mfNowLocal(), vehicle: q.get('k') || '' };
  MF.draft = st;
  const places = [...new Set(MF.hist.flatMap(h => [h.data && h.data.raw && h.data.raw.depart, h.data && h.data.raw && h.data.raw.terminus]).filter(Boolean).concat(MANIF_PLACES))].slice(0, 120);
  $('#page').innerHTML = `<div class="head"><h1>Manifestes</h1><div class="sub">Manifeste de passagers (transport touristique) sur les formulaires officiels : véhicule, N° d'agrément et chauffeur pris dans Ludy (contrat en cours à l'heure de départ). PDF à partager par WhatsApp ou par e-mail.</div></div>
    ${cfgErr ? msg('Manifestes pas encore installés dans la base : exécuter <b>supabase/migrations/20261027000000_manifestes.sql</b> dans Supabase &gt; SQL Editor. (' + esc(cfgErr) + ')', 'err') : ''}
    ${!cfgErr && !MF.cfg.stamp ? msg('Cachet de l\'entreprise manquant : ' + (isAdmin() ? 'l\'ajouter dans « Réglages des manifestes » en bas de page.' : 'l\'administrateur doit l\'ajouter (Manifestes &gt; Réglages).'), 'warn') : ''}
    ${!edit ? msg('Lecture seule : la création de manifestes est réservée aux gestionnaires et à l\'administrateur.', 'warn') : ''}
    <div class="grid2 mfgrid">
    <div>
      <div class="panel"><h2>Véhicule et chauffeur</h2>
        <div class="mfrow"><label>Véhicule <select id="mfveh"><option value="">Choisir…</option>${vs.map(v => `<option value="${esc(v.key)}" ${v.key === st.vehicle ? 'selected' : ''}>${esc(v.plate)}${v.model ? ' · ' + esc(v.model) : ''}</option>`).join('')}</select></label>
          <label>Véhicule de remplacement <input id="mfrep" value="${esc(st.remplacement || '')}" placeholder="Immatriculation (option)" size="18"></label></div>
        <div id="mfvinfo" class="small"></div>
        <div class="mfrow"><label>Date et heure de départ <input type="datetime-local" id="mfdep" value="${esc(st.dateDep || '')}"></label>
          <label>Date de retour (option) <input type="date" id="mfret" value="${esc(st.dateRet || '')}"></label></div>
        <div class="mfrow"><label>Chauffeur <input id="mfdrv" list="mfdrvl" value="${esc(st.chauffeur || '')}" placeholder="Contrat en cours, sinon choisir" size="28" autocomplete="off"></label>
          <datalist id="mfdrvl">${Object.keys(S.drv).filter(c => c !== HORS).map(c => `<option value="${esc(S.drv[c])}"></option>`).join('')}</datalist>
          <label>Téléphone du chauffeur <input id="mftel" value="${esc(st.chauffeurTel || '')}" placeholder="06…" size="15"></label></div>
        <div id="mfdinfo" class="small"></div>
      </div>
      <div class="panel"><h2>Client et trajet</h2>
        <div class="seg" role="group" aria-label="Type de client"><button type="button" data-mft="resident" class="${st.type === 'resident' ? '' : 'ghost'}">Résident</button><button type="button" data-mft="non" class="${st.type === 'resident' ? 'ghost' : ''}">Non résident</button></div>
        <div class="mfrow"><label>Donneur d'ordre (nom et prénom) <input id="mfdon" value="${esc(st.donneur || '')}" placeholder="Ex. Karim Bennani" size="28"></label>
          ${st.type === 'resident' ? `<label>N° CIN ou passeport <input id="mfcin" value="${esc(st.cin || '')}" placeholder="Ex. BK123456" size="14"></label>` : `<label>Nombre de passagers <input type="number" id="mfnb" min="1" value="${esc(st.nb || 1)}" style="width:90px"></label>`}</div>
        <div class="mfrow"><label>Départ <input id="mfa" list="mfpl" value="${esc(st.depart || '')}" placeholder="Adresse, hôtel, aéroport…" size="34"></label>
          <button type="button" class="ghost small" id="mfswap" title="Inverser départ et terminus">⇅</button>
          <label>Terminus <input id="mfb" list="mfpl" value="${esc(st.terminus || '')}" placeholder="Adresse, hôtel, aéroport…" size="34"></label></div>
        <datalist id="mfpl">${places.map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
        <div class="mfrow"><label>Type de prestation <select id="mfpre">${MANIF_PRESTA.map(p => `<option ${p === st.prestation ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
          <label>Nature du voyage <input id="mfnat" list="mfnatl" value="${esc(st.nature || '')}" size="20"></label>
          <datalist id="mfnatl">${MANIF_NATURES.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist></div>
        ${st.type === 'resident' ? `<h3>Passagers</h3><label class="chk"><input type="checkbox" id="mfdv" ${st.donneurVoyage !== false ? 'checked' : ''}> Le donneur d'ordre fait partie des passagers</label>
          <div id="mfpass"></div><button type="button" class="ghost small" id="mfadd">+ Ajouter un passager</button><div class="small" id="mfphint"></div>` : ''}
        <label class="mfobs">Observations (option) <textarea id="mfobs" rows="2" placeholder="N° de vol, bagages, remarque…">${esc(st.obs || '')}</textarea></label>
        <div class="mfgo"><button id="mfgen" ${edit && !cfgErr ? '' : 'disabled'}>Générer le manifeste PDF</button> <button type="button" class="ghost" id="mfnew">Nouvelle course</button></div>
      </div>
    </div>
    <div><div id="mfdone"></div>
      <div class="panel"><h2>Derniers manifestes <span class="small">(60 jours${agFilter() ? ', agence choisie' : ''})</span></h2><div id="mfhist"></div></div>
    </div></div>
    ${isAdmin() && !cfgErr ? '<details class="panel" id="mfset"><summary><h2>Réglages des manifestes</h2></summary><div id="mfsetb"></div></details>' : ''}`;
  mfBind();
  if (MF.last) mfDone(MF.last);
  mfHistory();
  if (isAdmin() && !cfgErr) mfSettings();
}

function mfRead() {
  const st = MF.draft, v = id => { const e = $('#' + id); return e ? e.value : undefined; };
  st.vehicle = v('mfveh'); st.remplacement = v('mfrep'); st.dateDep = v('mfdep'); st.dateRet = v('mfret'); st.chauffeur = v('mfdrv'); st.chauffeurTel = v('mftel');
  st.donneur = v('mfdon'); if ($('#mfcin')) st.cin = v('mfcin'); if ($('#mfnb')) st.nb = Math.max(1, parseInt(v('mfnb'), 10) || 1);
  st.depart = v('mfa'); st.terminus = v('mfb'); st.prestation = v('mfpre'); st.nature = v('mfnat'); st.obs = v('mfobs');
  if ($('#mfdv')) st.donneurVoyage = $('#mfdv').checked;
  if ($('#mfpass')) st.passengers = [...document.querySelectorAll('#mfpass input')].map(i => i.value);
  return st;
}
function mfMax() { const v = MF.draft.vehicle && mfVeh(MF.draft.vehicle); return (v && v.places) || 59; }
function mfPassengers() {
  const box = $('#mfpass'); if (!box) return;
  const st = MF.draft, off = st.donneurVoyage !== false ? 1 : 0, room = Math.max(mfMax() - off, 0);
  if (!st.passengers.length && !off) st.passengers = [''];
  if (st.passengers.length > room) st.passengers = st.passengers.slice(0, room);
  box.innerHTML = st.passengers.map((p, i) => `<div class="mfp"><span class="n">${i + 1 + off}</span><input value="${esc(p)}" placeholder="Nom et prénom" aria-label="Passager ${i + 1 + off}"><button type="button" class="ghost small" data-mfdel="${i}" aria-label="Retirer ce passager">×</button></div>`).join('');
  box.querySelectorAll('[data-mfdel]').forEach(b => b.onclick = () => { mfRead(); st.passengers.splice(+b.dataset.mfdel, 1); mfPassengers(); });
  $('#mfadd').hidden = st.passengers.length >= room;
  $('#mfphint').textContent = (off ? 'Passager 1 : le donneur d\'ordre. ' : '') + 'Maximum ' + mfMax() + ' passagers pour ce véhicule. Noms en lettres latines.';
}
function mfVehInfo() {
  const v = MF.draft.vehicle && mfVeh(MF.draft.vehicle), el = $('#mfvinfo'); if (!el) return;
  el.innerHTML = !v ? '' : esc([v.marque, v.modele].filter(Boolean).join(' ')) + ' · ' + (v.places ? v.places + ' places autorisées' : '<b>places non renseignées</b>') + ' · ' +
    (v.autorisation ? 'N° d\'agrément ' + esc(v.autorisation) : '<b>N° d\'agrément non renseigné</b> (N° d\'autorisation de l\'entreprise imprimé)');
}
/** Chauffeur du contrat en cours sur le véhicule à l'heure de départ (remplit les champs sauf saisie manuelle) */
async function mfDriverAuto() {
  const st = MF.draft, el = $('#mfdinfo'); if (!st.vehicle || !st.dateDep || !el) { if (el) el.textContent = ''; return; }
  const t = parseLocalDT(st.dateDep); if (!t) return;
  const my = MF.drvAuto = st.vehicle + '|' + st.dateDep; el.textContent = 'Recherche du contrat…';
  let c = null; try { c = await mfContractAt(st.vehicle, t.getTime()); } catch (e) { el.textContent = 'Contrats illisibles : ' + e.message; return; }
  if (MF.drvAuto !== my) return;
  if (c) {
    if (!st.drvManual) { $('#mfdrv').value = st.chauffeur = c.name || ''; $('#mftel').value = st.chauffeurTel = c.phone || ''; }
    st.chauffeurEmail = c.email || ''; el.innerHTML = 'Contrat ' + esc(c.num) + ' : ' + esc(c.name || c.code) + (c.phone ? ' · ' + esc(c.phone) : '') + (st.drvManual ? ' (chauffeur saisi à la main gardé)' : '');
  } else el.innerHTML = '<b>Aucun contrat</b> sur ce véhicule à cette heure : choisir le chauffeur.';
}
function mfBind() {
  const st = MF.draft;
  $('#mfveh').onchange = () => { mfRead(); st.drvManual = false; mfVehInfo(); mfPassengers(); mfDriverAuto(); };
  $('#mfdep').onchange = () => { mfRead(); mfDriverAuto(); };
  $('#mfdrv').oninput = $('#mftel').oninput = () => { st.drvManual = true; };
  $('#mfdrv').onchange = () => {   // chauffeur choisi dans la liste : son téléphone
    const code = Object.keys(S.drv).find(c => c !== HORS && String(S.drv[c]).toLowerCase() === $('#mfdrv').value.trim().toLowerCase());
    if (code) sb.from('drivers').select('phone,email').eq('code', code).maybeSingle().then(({ data }) => { if (data && data.phone) $('#mftel').value = data.phone; st.chauffeurEmail = (data && data.email) || ''; });
  };
  document.querySelectorAll('[data-mft]').forEach(b => b.onclick = () => { mfRead(); st.type = b.dataset.mft === 'resident' ? 'resident' : 'non'; pageManifeste(); });
  $('#mfswap').onclick = () => { const a = $('#mfa').value; $('#mfa').value = $('#mfb').value; $('#mfb').value = a; };
  if ($('#mfadd')) $('#mfadd').onclick = () => { mfRead(); st.passengers.push(''); mfPassengers(); const ins = document.querySelectorAll('#mfpass input'); if (ins.length) ins[ins.length - 1].focus(); };
  if ($('#mfdv')) $('#mfdv').onchange = () => { mfRead(); mfPassengers(); };
  $('#mfnew').onclick = () => { MF.draft = null; MF.last = null; pageManifeste(); };
  $('#mfgen').onclick = mfGenerate;
  mfVehInfo(); mfPassengers(); mfDriverAuto();
}

async function mfGenerate() {
  const st = mfRead(), btn = $('#mfgen'), bad = [];
  const v = st.vehicle && mfVeh(st.vehicle);
  if (!v) bad.push('le véhicule');
  if (!String(st.donneur || '').trim()) bad.push('le donneur d\'ordre');
  if (st.type === 'resident' && !String(st.cin || '').trim()) bad.push('le N° de CIN ou de passeport');
  if (!String(st.depart || '').trim()) bad.push('le départ');
  if (!String(st.terminus || '').trim()) bad.push('le terminus');
  if (!st.dateDep) bad.push('la date de départ');
  if (!String(st.chauffeur || '').trim()) bad.push('le chauffeur');
  if (v && !v.places) bad.push('le nombre de places du véhicule (Réglages des manifestes)');
  if (bad.length) { alert('À compléter : ' + bad.join(', ') + '.'); return; }
  if (!MF.cfg.stamp) { alert('Cachet de l\'entreprise manquant : impossible de générer (Manifestes > Réglages des manifestes).'); return; }
  if (!window.jspdf) { alert('Bibliothèque PDF non chargée, réessayez dans un instant.'); return; }
  v.remplacement = String(st.remplacement || '').trim().toUpperCase();
  const dn = String(st.donneur).trim(), pass = st.type === 'resident' ? (st.donneurVoyage !== false ? [dn] : []).concat(st.passengers.map(p => p.trim()).filter(Boolean)).slice(0, v.places || 59) : [];
  const company = Object.assign({}, MF.cfg.company || {}, v.autorisation ? { autorisation: v.autorisation } : {});
  const d = { type: st.type, company, vehicule: v, donneur: dn, cin: String(st.cin || '').trim().toUpperCase(), nbPassagers: st.type === 'resident' ? pass.length : Math.min(st.nb || 1, v.places || 59), passagers: pass,
    depart: st.depart.trim(), terminus: st.terminus.trim(), prestation: st.prestation, nature: String(st.nature || '').trim(),
    dateDepart: manifFrDate(st.dateDep), dateRetour: manifFrDate(st.dateRet), observations: String(st.obs || '').trim(),
    etabli: fmtDay(addDays(today(), -1)), chauffeur: st.chauffeur.trim(), chauffeurTel: String(st.chauffeurTel || '').trim(), dateDep: st.dateDep };
  btn.disabled = true; btn.textContent = 'Création…';
  try {
    const A = { stamp: MF.cfg.stamp, stampW: 150, stampRatio: await mfRatio(MF.cfg.stamp) };
    if (d.type === 'resident') { A.bg1 = await mfImage(MANIF_BG.bg1); A.bg2 = await mfImage(MANIF_BG.bg2); } else A.bg3 = await mfImage(MANIF_BG.bg3);
    const doc = buildManifest(window.jspdf.jsPDF, d, A), blob = doc.output('blob'), name = manifFileName(d);
    // PDF gardé dans le stockage privé « manifestes » : lien signé dans les messages
    let path = null, link = null, upErr = '';
    try {
      const pth = today().slice(0, 7) + '/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '.pdf';
      const up = await sb.storage.from('manifestes').upload(pth, blob, { contentType: 'application/pdf', upsert: false });
      if (up.error) throw up.error;
      path = pth; link = await mfLink(path);
    } catch (e) { upErr = e.message || String(e); }
    const raw = Object.assign({}, st); delete raw.drvManual;
    const row = { vehicle_key: v.key, plate: v.plaque, driver_name: d.chauffeur, driver_phone: d.chauffeurTel || null, client: d.donneur,
      depart_at: (parseLocalDT(st.dateDep) || new Date()).toISOString(), file_name: name, file_path: path, message: manifText(d, link), data: { d: Object.assign({}, d, { company: undefined }), raw } };
    const ins = await sb.from('manifests').insert(row).select('id').single();
    MF.last = { id: ins.data ? ins.data.id : null, d, blob, name, link, path, upErr, saveErr: ins.error ? ins.error.message : '', email: st.chauffeurEmail || '' };
    MF.draft = st;
    mfDone(MF.last);
    if (!ins.error) { MF.hist.unshift(Object.assign({ id: ins.data.id, created_at: new Date().toISOString() }, row)); mfHistory(); }
  } catch (e) { alert('Erreur lors de la création du PDF : ' + (e.message || e)); }
  btn.disabled = false; btn.textContent = 'Générer le manifeste PDF';
}
async function mfLink(path) {
  if (!path) return null;
  const { data, error } = await sb.storage.from('manifestes').createSignedUrl(path, MANIF_LINK_DAYS * 86400, { download: true });
  if (error) throw error;
  return data.signedUrl;
}
/** Panneau du manifeste créé : partage WhatsApp / e-mail, téléchargement */
function mfDone(m) {
  const box = $('#mfdone'); if (!box) return;
  const txt = manifText(m.d, m.link), wa = manifWa(m.d.chauffeurTel), subj = 'Manifeste mission du ' + m.d.dateDepart + ' · ' + m.d.vehicule.plaque;
  const canFile = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([m.blob], m.name, { type: 'application/pdf' })] })); } catch (e) { return false; } })();
  box.innerHTML = `<div class="panel mfok"><h2>Manifeste prêt</h2><div class="small">${esc(m.name)}</div>
    ${m.saveErr ? msg('Manifeste non enregistré dans l\'historique : ' + esc(m.saveErr), 'warn') : ''}
    ${m.link ? '' : msg('PDF non mis en ligne (' + esc(m.upErr || 'stockage indisponible') + ') : le message part sans lien, joignez le PDF téléchargé.', 'warn')}
    <div class="adact mfact">
      ${wa ? `<a class="btn small" id="mfwa1" href="https://wa.me/${wa}?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">WhatsApp au chauffeur</a>` : ''}
      <a class="btn small${wa ? ' ghostb' : ''}" id="mfwa" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">WhatsApp (choisir le contact)</a>
      <a class="btn small ghostb" id="mfmail" href="mailto:${encodeURIComponent(MF.cfg.email_to || m.email || '').replace(/%2C/gi, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(txt)}">Ma messagerie</a>
      ${canFile ? '<button class="ghost small" id="mfshare">Partager le PDF…</button>' : ''}
      <button class="ghost small" id="mfdl">Télécharger le PDF</button><button class="ghost small" id="mfcopy">Copier le message</button><button class="ghost small" id="mfret2">Préparer le retour</button></div>
    ${m.id ? `<div class="mfrow mfmailrow"><label>E-mail avec le PDF joint (envoyé par Ludy) <input id="mfto" value="${esc(MF.cfg.email_to || m.email || '')}" placeholder="adresse@exemple.ma, autre@exemple.ma" size="40"></label><button class="small" id="mfsend">Envoyer</button></div><div id="mfsendr" class="small"></div>` : ''}
    <details><summary class="small">Aperçu du message</summary><pre class="mftxt">${esc(txt)}</pre></details></div>`;
  $('#mfdl').onclick = () => { const u = URL.createObjectURL(m.blob), a = document.createElement('a'); a.href = u; a.download = m.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  $('#mfcopy').onclick = async () => { try { await navigator.clipboard.writeText(txt); $('#mfcopy').textContent = 'Copié'; } catch (e) { prompt('Copiez le message :', txt); } };
  if ($('#mfshare')) $('#mfshare').onclick = () => navigator.share({ files: [new File([m.blob], m.name, { type: 'application/pdf' })], text: txt }).catch(() => { });
  $('#mfret2').onclick = () => { const s = Object.assign({}, MF.draft, { depart: MF.draft.terminus, terminus: MF.draft.depart, dateDep: mfNowLocal(), dateRet: '' }); MF.draft = s; MF.last = null; pageManifeste(); };
  if ($('#mfsend')) $('#mfsend').onclick = () => mfSendMail(m.id, $('#mfto').value, $('#mfsendr'));
}
/** E-mail avec le PDF joint : demande « manifest_mail » traitée par le collecteur (5 minutes au plus) */
async function mfSendMail(id, to, out) {
  const list = String(to || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  if (!list.length || list.some(x => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x))) { out.innerHTML = msg('Adresse e-mail invalide.', 'err'); return; }
  const { data, error } = await sb.from('jobs').insert({ kind: 'manifest_mail', arg: JSON.stringify({ id, to: list.join(',') }) }).select('id').single();
  if (error) { out.innerHTML = msg('Envoi impossible : ' + esc(error.message), 'err'); return; }
  out.innerHTML = msg('Envoi demandé à ' + esc(list.join(', ')) + ' : le collecteur l\'envoie dans les 5 minutes avec le PDF joint.', 'ok');
  // résultat de la demande (le collecteur passe toutes les 5 minutes)
  const t0 = Date.now(), my = ROUTING, poll = async () => {
    if (my !== ROUTING || Date.now() - t0 > 8 * 60000) return;
    const r = await sb.from('jobs').select('done_at,result').eq('id', data.id).maybeSingle();
    if (r.data && r.data.done_at) { out.innerHTML = msg(esc(r.data.result || 'Envoyé'), /^Erreur/.test(r.data.result || '') ? 'err' : 'ok'); return; }
    setTimeout(poll, 20000);
  };
  setTimeout(poll, 20000);
}
function mfHistory() {
  const box = $('#mfhist'); if (!box) return;
  const ok = inAgency(), rows = MF.hist.filter(h => ok(h.vehicle_key));
  box.innerHTML = table('mfh', [['Départ', h => esc(fmtDTY(h.depart_at)), h => h.depart_at], ['Véhicule', h => plate(h.plate)], ['Chauffeur', h => esc(h.driver_name || '')], ['Client', h => esc(h.client || '')],
    ['Trajet', h => { const r = (h.data && h.data.raw) || {}; return esc((r.depart || '') + ' → ' + (r.terminus || '')); }],
    ['', h => `<span class="mfha">${h.file_path && canEdit() ? `<button class="ghost small" data-mfpdf="${h.id}">PDF</button><button class="ghost small" data-mfwa="${h.id}">WhatsApp</button>` : ''}${canEdit() ? `<button class="ghost small" data-mfre="${h.id}">Reprendre</button>` : ''}</span>`]], rows, { empty: 'Aucun manifeste sur les 60 derniers jours' });
  window.__rerender = mfHistory;
  const byId = id => rows.find(h => String(h.id) === String(id));
  box.querySelectorAll('[data-mfpdf]').forEach(b => b.onclick = async () => { try { { const u = await mfLink(byId(b.dataset.mfpdf).file_path); if (!openOut(u)) window.open(u, '_blank', 'noopener'); } } catch (e) { alert('PDF inaccessible : ' + e.message); } });
  box.querySelectorAll('[data-mfwa]').forEach(b => b.onclick = async () => {
    const h = byId(b.dataset.mfwa); let link = null; try { link = await mfLink(h.file_path); } catch (e) { }
    const d = (h.data && h.data.d) || null, txt = d ? manifText(d, link) : (h.message || ''), wa = manifWa(h.driver_phone);
    { const u = 'https://wa.me/' + (wa || '') + '?text=' + encodeURIComponent(txt); if (!openOut(u)) window.open(u, '_blank', 'noopener'); }
  });
  box.querySelectorAll('[data-mfre]').forEach(b => b.onclick = () => {
    const h = byId(b.dataset.mfre), r = Object.assign({}, (h.data && h.data.raw) || {});
    MF.draft = Object.assign({ passengers: [''], type: 'resident' }, r, { dateDep: mfNowLocal(), drvManual: false }); MF.last = null; pageManifeste(); window.scrollTo(0, 0);
  });
}

// ---------- Réglages (administrateur) : entreprise, cachet, agrément et places par véhicule ----------
function mfSettings() {
  const c = MF.cfg.company || {}, box = $('#mfsetb'), vs = mfVehicles();
  box.innerHTML = `<div class="mfrow">${[['nom', 'Dénomination', 28], ['adresse', 'Adresse', 48], ['tel', 'Tél/Fax', 14], ['autorisation', 'N° d\'autorisation', 16], ['dossier', 'N° de dossier', 16]]
      .map(x => `<label>${x[1]} <input data-mfc="${x[0]}" value="${esc(c[x[0]] || '')}" size="${x[2]}"></label>`).join('')}</div>
    <div class="mfrow"><label>Destinataires e-mail par défaut (ex. service de l'équipement et du transport) <input id="mfcto" value="${esc(MF.cfg.email_to || '')}" size="48" placeholder="adresse@exemple.ma, autre@exemple.ma"></label></div>
    <h3>Cachet</h3><div class="mfrow"><div class="mfstamp" id="mfsp">${MF.cfg.stamp ? `<img src="${esc(MF.cfg.stamp)}" alt="Cachet">` : '<span class="small">Aucun</span>'}</div>
      <label>Photo du cachet (fond blanc, rendu transparent) <input type="file" id="mfsf" accept="image/*"></label><button type="button" class="ghost small" id="mfsdel">Retirer</button></div>
    <h3>Véhicules</h3><div class="small">N° d'agrément imprimé à la place du N° d'autorisation de l'entreprise ; places autorisées (vide : ${Object.keys(MANIF_SEATS).map(k => k.charAt(0).toUpperCase() + k.slice(1) + ' ' + MANIF_SEATS[k]).join(', ')}).</div>
    ${table('mfvt', [['Plaque', v => plate(v.plate)], ['Modèle', v => esc(v.model || '')], ['N° d\'agrément', v => `<input data-mfag="${esc(v.key)}" value="${esc(mfParcOf(v).agrement || '')}" size="16">`],
      ['Places', v => `<input type="number" min="1" max="59" data-mfse="${esc(v.key)}" value="${esc(mfParcOf(v).seats || '')}" style="width:80px">`]], vs, { empty: 'Aucun véhicule' })}
    <div class="mfgo"><button id="mfsave">Enregistrer les réglages</button> <span id="mfsres"></span></div>`;
  let stamp = MF.cfg.stamp || null;
  $('#mfsf').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { stamp = await mfStamp(f); $('#mfsp').innerHTML = `<img src="${esc(stamp)}" alt="Cachet">`; } catch (x) { alert(x.message); } };
  $('#mfsdel').onclick = () => { stamp = null; $('#mfsp').innerHTML = '<span class="small">Aucun</span>'; };
  $('#mfsave').onclick = async () => {
    const out = $('#mfsres'), comp = {}; document.querySelectorAll('[data-mfc]').forEach(i => { comp[i.dataset.mfc] = i.value.trim(); });
    out.textContent = 'Enregistrement…';
    try {
      const r = await sb.from('manifest_config').upsert({ id: 1, company: comp, email_to: $('#mfcto').value.trim() || null, stamp, updated_at: new Date().toISOString() });
      if (r.error) throw new Error(r.error.message);
      // agrément et places : ligne du parc du véhicule (créée si absente)
      for (const v of vs) {
        const ag = $(`[data-mfag="${CSS.escape(v.key)}"]`).value.trim(), se = parseInt($(`[data-mfse="${CSS.escape(v.key)}"]`).value, 10) || null, p = mfParcOf(v);
        if ((p.agrement || '') === ag && (p.seats || null) === se) continue;
        const u = p.plate ? await sb.from('parc').update({ agrement: ag || null, seats: se }).eq('plate', p.plate)
          : await sb.from('parc').insert({ plate: v.plate, brand: v.brand || null, model: v.model || null, agency_id: v.agency_id || null, agrement: ag || null, seats: se });
        if (u.error) throw new Error(v.plate + ' : ' + u.error.message);
      }
      out.innerHTML = '<span class="ok">Réglages enregistrés.</span>'; MF.cfg = Object.assign({}, MF.cfg, { company: comp, email_to: $('#mfcto').value.trim(), stamp });
      MF.parc = await all('parc', '*'); mfVehInfo(); mfPassengers();
    } catch (e) { out.innerHTML = '<span class="err">Erreur : ' + esc(e.message) + '</span>'; }
  };
}
/** Photo du cachet → PNG à fond transparent recadré (comme le modèle) */
function mfStamp(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Photo illisible'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Photo illisible'));
      img.onload = () => {
        const max = 600, sc = Math.min(1, max / Math.max(img.width, img.height)), w = Math.round(img.width * sc), h = Math.round(img.height * sc);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, w, h);
        const dd = cx.getImageData(0, 0, w, h), px = dd.data;
        let minX = w, minY = h, maxX = 0, maxY = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const k = (y * w + x) * 4, lum = 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
          const a = lum > 215 ? 0 : lum > 150 ? Math.round((215 - lum) / 65 * 255) : 255;
          px[k + 3] = a;
          if (a > 40) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
        }
        cx.putImageData(dd, 0, 0);
        if (maxX <= minX || maxY <= minY) { reject(new Error('Cachet non détecté sur la photo')); return; }
        const m = 6; minX = Math.max(0, minX - m); minY = Math.max(0, minY - m); maxX = Math.min(w - 1, maxX + m); maxY = Math.min(h - 1, maxY + m);
        const cw = maxX - minX + 1, ch = maxY - minY + 1, out = document.createElement('canvas'); out.width = cw; out.height = ch;
        out.getContext('2d').drawImage(cv, minX, minY, cw, ch, 0, 0, cw, ch);
        resolve(out.toDataURL('image/png'));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

if (typeof module !== 'undefined') module.exports = { buildManifest, manifText, manifFileName, manifFrDate, manifWa, manifSeats };
