// Caisse : calculs et lecture des fichiers (sans navigateur : testés sous Node, mêmes règles que le classeur
// « Suivi Cash Chauffeurs - Luxury » : encaissements Uber, dépenses, avances RH, courses privées, bonus, rapprochement Uber, paie).

const CASH_CAISSES = [['uber', 'Encaissements Uber'], ['depenses', 'Dépenses chauffeurs'], ['rh', 'Avances RH'], ['courses', 'Courses privées'], ['bonus', 'Bonus performance']];
const CASH_DEP_CATS = ['Carburant', 'Péage', 'Parking', 'Lavage', 'Contravention', 'NDF', 'Adblue', 'Vidange', 'Recharge téléphone', 'Autre'];
const CASH_RIDE_TYPES = ['Course Uber', 'Course Privée', 'Course Bolt', 'Course InDrive', 'Non applicable'];
const CASH_BONUS = ['Challenge Shift', 'Challenge Semaine', 'Challenge 5k', 'Autre'];
const CASH_SOURCES = ['Chauffeur', 'Caisse', 'Banque', 'Caisse RH', 'Cash Nico'];

function cshN(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[\s  ]/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; }
function cshR(v) { return Math.round(cshN(v) * 100) / 100 + 0; }
/** Montant d'un classeur : « 1 761,00 MAD », « -4 050,00 MAD », 1761 */
function cshAmount(v) {
  if (typeof v === 'number') return v;
  let t = String(v == null ? '' : v).replace(/[\s  ]/g, '').replace(/MAD|DH|€/gi, ''); if (!t) return null;
  const c = t.lastIndexOf(','), d = t.lastIndexOf('.');
  t = c > d ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = parseFloat(t); return isNaN(n) ? null : n;
}
/** Texte comparable : minuscules, sans accents, espaces simples, sans espace autour des « : » */
function cshNorm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s  ]+/g, ' ').replace(/\s*:\s*/g, ':').trim(); }
/** Nom de personne comparable : mots sans accents ni ponctuation, triés (« ELMONTACER Othman » = « Othman Elmontacer ») */
function cshName(s) { return cshNorm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).sort().join(' '); }
/** Téléphone comparable : 9 derniers chiffres (06…, +212 6…, 212 6…) */
function cshPhone(s) { const d = String(s || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }
/** Date d'un classeur ou d'une saisie → aaaa-mm-jj (jj/mm/aaaa [hh:mm], aaaa-mm-jj, numéro de série Excel) ; '' si illisible */
function cshDay(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
  return '';
}
/** Montant signé pour le solde d'une caisse : entrée +, sortie −, virement (hors caisse) 0 ; mouvement annulé 0 */
function cshSigned(m) { if (m.cancelled_at) return 0; const a = cshN(m.amount); return m.flow === 'in' ? a : m.flow === 'out' ? -a : 0; }
function cshLive(m) { return !m.cancelled_at; }
/** Solde de chaque caisse et total en espèces */
function cshBalances(moves) {
  const b = {}; CASH_CAISSES.forEach(c => { b[c[0]] = 0; });
  (moves || []).forEach(m => { if (m.caisse in b) b[m.caisse] = cshR(b[m.caisse] + cshSigned(m)); });
  b.total = cshR(CASH_CAISSES.reduce((s, c) => s + b[c[0]], 0));
  return b;
}
/** Clé d'un chauffeur : code Ludy, sinon UUID Uber relié à un code, sinon UUID Uber, sinon nom */
function cshKey(code, uuid, name, uuid2code) {
  if (code) return code;
  if (uuid && uuid2code && uuid2code[uuid]) return uuid2code[uuid];
  if (uuid) return 'U:' + uuid;
  return name ? 'N:' + cshName(name) : '';
}
function cshMoveKey(m, uuid2code) { return cshKey(m.driver_code, m.uber_uuid, m.driver_name, uuid2code); }
/**
 * Comptes Uber rattachés à un chauffeur Ludy : drivers.uber_uuid (uuid2code), sinon mouvement de caisse qui porte le code Ludy et
 * l'UUID Uber (un seul code pour cet UUID), sinon même nom qu'un seul chauffeur Ludy sans compte Uber, porté par un seul compte Uber non relié.
 * o : { uuid2code, moves, drivers: [{ code, name, uber_uuid }], udrv: [{ uuid, name }], payments } → UUID → code Ludy
 */
function cshLinks(o) {
  const map = Object.assign({}, o.uuid2code || {}), byMove = {};
  (o.moves || []).filter(cshLive).forEach(m => { if (m.uber_uuid && m.driver_code && !map[m.uber_uuid]) (byMove[m.uber_uuid] = byMove[m.uber_uuid] || new Set()).add(m.driver_code); });
  Object.keys(byMove).forEach(u => { if (byMove[u].size === 1) map[u] = [...byMove[u]][0]; });
  if (!o.drivers || !o.drivers.length) return map;
  const uname = {}; (o.udrv || []).forEach(u => { if (u.uuid && u.name) uname[u.uuid] = u.name; });
  (o.payments || []).forEach(p => { if (p.driver_uuid && p.driver_name && !uname[p.driver_uuid]) uname[p.driver_uuid] = p.driver_name; });
  const taken = new Set(Object.values(map)), codes = {}, uuids = {};
  o.drivers.forEach(d => { const n = cshName(d.name); if (n && !d.uber_uuid && !taken.has(d.code)) (codes[n] = codes[n] || []).push(d.code); });
  Object.keys(uname).forEach(u => { const n = cshName(uname[u]); if (n && !map[u]) (uuids[n] = uuids[n] || []).push(u); });
  Object.keys(uuids).forEach(n => { if (uuids[n].length === 1 && codes[n] && codes[n].length === 1) map[uuids[n][0]] = codes[n][0]; });
  return map;
}

/**
 * Rapprochement des espèces Uber par chauffeur sur une période (onglet « Dashboard - Rappro Uber » du classeur) :
 * espèces Uber − dépenses « Course Uber » justifiées OK = théorique à remettre ; écart = théorique − encaissé net ;
 * écart > 0 : à retenir sur la paie (manquant) ; < 0 : à ajouter (excédent).
 * Compte Uber rattaché à aucun chauffeur Ludy (cshLinks) : ligne « Compte Uber non relié », sans effet sur la paie.
 * o : { payments, moves, from, to, uuid2code, drivers, udrv, dayOfPayment(p) → aaaa-mm-jj (jour du shift), names: clé → nom }
 */
function cshRappro(o) {
  o = Object.assign({}, o, { uuid2code: cshLinks(o) });
  const by = {}, get = (k, name) => (by[k] = by[k] || { key: k, name: name || '', uber: 0, frais: 0, net: 0, trips: 0 });
  const inP = d => d && d >= o.from && d <= o.to;
  (o.payments || []).forEach(p => {
    const d = o.dayOfPayment ? o.dayOfPayment(p) : String(p.day || '').slice(0, 10);
    if (!inP(d)) return;
    const r = get(cshKey(null, p.driver_uuid, p.driver_name, o.uuid2code), p.driver_name); r.uber = cshR(r.uber + cshN(p.cash)); if (cshN(p.cash)) r.trips++;
  });
  (o.moves || []).filter(cshLive).forEach(m => {
    if (!inP(m.day)) return;
    const k = cshMoveKey(m, o.uuid2code); if (!k) return;
    if (m.caisse === 'uber' && m.kind === 'encaissement') { const r = get(k, m.driver_name); r.net = cshR(r.net + cshN(m.amount)); }
    if (m.kind === 'depense' && m.ride_type === 'Course Uber' && m.justif === 'OK') { const r = get(k, m.driver_name); r.frais = cshR(r.frais + cshN(m.amount)); }
  });
  return Object.values(by).map(r => {
    if (o.names && o.names[r.key]) r.name = o.names[r.key];
    r.theo = cshR(r.uber - r.frais); r.ecart = cshR(r.theo - r.net);
    r.unlinked = r.key.indexOf('U:') === 0;
    r.statut = r.uber === 0 && r.net === 0 ? 'Sans activité' : r.unlinked ? 'Compte Uber non relié' : r.theo > 0 && r.net === 0 ? 'Non remis' : Math.abs(r.ecart) < 0.01 ? 'Cadré' : r.ecart > 0 ? 'Manquant' : 'Excédent';
    r.effet = r.unlinked ? 'Aucun (relier le compte Uber)' : r.ecart > 0.004 ? 'Retenir ' + Math.round(r.ecart) + ' MAD' : r.ecart < -0.004 ? 'Ajouter ' + Math.round(-r.ecart) + ' MAD' : 'Aucun';
    r.taux = r.theo ? r.net / r.theo : 0;
    return r;
  }).sort((a, b) => b.ecart - a.ecart || String(a.name).localeCompare(String(b.name)));
}

/**
 * Effet sur la paie par chauffeur sur une période (onglet « Base Cash Consolidée » du classeur) :
 * - écart d'espèces Uber (rapprochement) : retenue (manquant) ou ajout (excédent) ; compte Uber non relié : rien ;
 * - dépense d'un chauffeur sans justificatif OK (KO, en attente ou vide) : retenue ; sauf « Course Uber » d'un chauffeur qui a des
 *   espèces Uber au rapprochement : non déduite du théorique, déjà dans le manquant (pas retenue deux fois, écart au classeur) ;
 * - avance sur salaire : déjà versée, à déclarer et à retenir ; remboursement d'avance en espèces : ajout ;
 * - course privée : prime à déclarer ; reste à payer (prime − déjà gardée par le chauffeur) : ajout (ou retenue si négatif) ;
 * - bonus : à déclarer ; « A payer » : ajout.
 */
function cshPayroll(o) {
  const u2c = cshLinks(o), rap = o.rappro || cshRappro(o), by = {};
  const get = (k, name) => (by[k] = by[k] || { key: k, name: name || '', manquant: 0, excedent: 0, depKo: 0, nDepKo: 0, avances: 0, rembours: 0, primes: 0, primePaid: 0, primeReste: 0, bonusPaid: 0, bonusToPay: 0 });
  const inRap = new Set(rap.filter(r => !r.unlinked && r.uber).map(r => r.key));
  rap.forEach(r => { if (r.unlinked) return; if (r.ecart > 0) get(r.key, r.name).manquant = r.ecart; else if (r.ecart < 0) get(r.key, r.name).excedent = -r.ecart; });
  (o.moves || []).filter(cshLive).forEach(m => {
    if (!(m.day >= o.from && m.day <= o.to)) return;
    const k = cshMoveKey(m, u2c); if (!k || k.indexOf('N:') === 0 && !m.driver_name) return;
    const a = cshN(m.amount);
    if (m.kind === 'depense' && m.ride_type === 'Course Uber' && inRap.has(k)) return;
    if (m.kind === 'depense' && a > 0 && m.justif !== 'OK' && m.justif !== 'N.A') { const r = get(k, m.driver_name); r.depKo = cshR(r.depKo + a); r.nDepKo++; }
    else if (m.kind === 'avance') { const r = get(k, m.driver_name); r.avances = cshR(r.avances + a); }
    else if (m.kind === 'remboursement') { const r = get(k, m.driver_name); r.rembours = cshR(r.rembours + a); }
    else if (m.kind === 'course') { const r = get(k, m.driver_name); r.primes = cshR(r.primes + cshN(m.prime)); r.primePaid = cshR(r.primePaid + cshN(m.prime_paid)); }
    else if (m.kind === 'bonus') { const r = get(k, m.driver_name); if (m.status === 'A payer') r.bonusToPay = cshR(r.bonusToPay + a); else r.bonusPaid = cshR(r.bonusPaid + a); }
  });
  return Object.values(by).map(r => {
    if (o.names && o.names[r.key]) r.name = o.names[r.key];
    r.primeReste = cshR(r.primes - r.primePaid);
    r.impact = cshR(-r.manquant + r.excedent - r.depKo - r.avances + r.rembours + r.primeReste + r.bonusToPay);
    r.declarer = cshR(r.avances + r.primes + r.bonusPaid + r.bonusToPay);
    return r;
  }).filter(r => r.manquant || r.excedent || r.depKo || r.avances || r.rembours || r.primes || r.bonusPaid || r.bonusToPay)
    .sort((a, b) => a.impact - b.impact || String(a.name).localeCompare(String(b.name)));
}

/** Semaine (lundi) d'un jour aaaa-mm-jj */
function cshWeek(d) { const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), w = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - w * 86400000).toISOString().slice(0, 10); }
/** Chiffre d'affaires Uber (« Vos revenus ») par chauffeur et par jour ou par semaine (onglet « Suivi Chiffre d'affaires ») */
function cshCA(o) {
  const cols = new Set(), by = {}, tot = {}, u2c = cshLinks(o);
  (o.payments || []).forEach(p => {
    const d = o.dayOfPayment ? o.dayOfPayment(p) : String(p.day || '').slice(0, 10); if (!(d >= o.from && d <= o.to)) return;
    const c = o.by === 'week' ? cshWeek(d) : d, k = cshKey(null, p.driver_uuid, p.driver_name, u2c);
    cols.add(c); const r = by[k] = by[k] || { key: k, name: (o.names && o.names[k]) || p.driver_name || '', total: 0, v: {} };
    r.v[c] = cshR((r.v[c] || 0) + cshN(p.revenue)); r.total = cshR(r.total + cshN(p.revenue)); tot[c] = cshR((tot[c] || 0) + cshN(p.revenue));
  });
  const list = Object.values(by).sort((a, b) => b.total - a.total), keys = [...cols].sort();
  const active = {}; keys.forEach(c => { active[c] = list.filter(r => r.v[c] > 0).length; });
  return { cols: keys, rows: list, total: tot, active, sum: cshR(list.reduce((s, r) => s + r.total, 0)) };
}
/** Évolution jour par jour : espèces Uber, encaissé net, dépenses, avances, courses privées, bonus, dépôts en banque */
function cshDaily(o) {
  const by = {}, get = d => (by[d] = by[d] || { day: d, uber: 0, net: 0, depenses: 0, avances: 0, courses: 0, bonus: 0, depots: 0, revenue: 0 });
  (o.payments || []).forEach(p => { const d = o.dayOfPayment ? o.dayOfPayment(p) : String(p.day || '').slice(0, 10); if (d >= o.from && d <= o.to) { const r = get(d); r.uber = cshR(r.uber + cshN(p.cash)); r.revenue = cshR(r.revenue + cshN(p.revenue)); } });
  (o.moves || []).filter(cshLive).forEach(m => {
    if (!(m.day >= o.from && m.day <= o.to)) return;
    const r = get(m.day), a = cshN(m.amount);
    if (m.kind === 'encaissement') r.net = cshR(r.net + a);
    else if (m.kind === 'depense') r.depenses = cshR(r.depenses + a);
    else if (m.kind === 'avance') r.avances = cshR(r.avances + a);
    else if (m.kind === 'course') r.courses = cshR(r.courses + a);
    else if (m.kind === 'bonus') r.bonus = cshR(r.bonus + a);
    else if (m.kind === 'depot') r.depots = cshR(r.depots + a);
  });
  return Object.values(by).sort((a, b) => a.day.localeCompare(b.day));
}
/** Dépenses de la période par catégorie (onglet Dashboard : NDF, Carburant, Parking, Péage, Lavage…) */
function cshByCategory(moves, from, to) {
  const by = {};
  (moves || []).filter(cshLive).forEach(m => { if (m.kind === 'depense' && m.day >= from && m.day <= to) { const c = m.label || 'Autre'; by[c] = cshR((by[c] || 0) + cshN(m.amount)); } });
  return Object.keys(by).map(k => ({ label: k, amount: by[k] })).sort((a, b) => b.amount - a.amount);
}
/** Course privée : prime du chauffeur et part déjà gardée par lui (montant de la course − montant remis en caisse) */
function cshCourse(courseAmount, pct, remis) {
  const c = cshN(courseAmount), prime = cshR(c * cshN(pct) / 100), paid = cshR(Math.max(0, c - cshN(remis)));
  return { prime, paid, reste: cshR(prime - paid) };
}

// ---------- Lecture des fichiers ----------
/** Heure d'une transaction Uber : « 2026-08-19 20:01:00.232 +0100 +01 » (décalage lu dans le texte) ; sans décalage : heure du Maroc (localToDate) */
function cshUberTime(v, localToDate) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(?:([+-])(\d{2}):?(\d{2}))?/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +String(m[7] || '0').padEnd(3, '0').slice(0, 3));
  if (m[8]) return new Date(ms - (m[8] === '-' ? -1 : 1) * (+m[9] * 60 + +m[10]) * 60000).toISOString();
  return localToDate ? localToDate(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString() : new Date(ms).toISOString();
}
function cshHeader(rows, test, max) { for (let i = 0; i < Math.min((rows || []).length, max || 40); i++) if ((rows[i] || []).some(c => test(cshNorm(c)))) return i; return -1; }
/**
 * Export Uber « Opérations de paiement » (CSV du portail Uber Fleet, ou onglet du classeur) → transactions
 * { tx, at, driver_uuid, driver_name, trip, description, cash, revenue, payout, fare, tip, toll, bonus }.
 * Espèces collectées = − « Montant vous étant versé : Solde des courses : Versements : Espèces collectées » (comme le classeur).
 */
function cshParseUberPayments(rows, localToDate) {
  const h = cshHeader(rows, c => c === 'uuid de la transaction');
  if (h < 0) return { error: 'colonne « UUID de la transaction » introuvable', rows: [] };
  const H = rows[h].map(cshNorm), eq = t => H.indexOf(t), has = t => H.findIndex(c => c.indexOf(t) >= 0);
  const ix = { tx: eq('uuid de la transaction'), du: eq('uuid du chauffeur'), fn: eq('prenom du chauffeur'), ln: eq('nom du chauffeur'), trip: eq('uuid de la course'), desc: eq('description'),
    at: H.findIndex(c => c.indexOf('creation de rapport') >= 0 || c.indexOf('horodatage') >= 0), payout: eq('montant vous etant verse'), revenue: eq('montant vous etant verse:vos revenus'),
    cash: H.findIndex(c => c.indexOf('versements:especes collectees') >= 0), fare: eq('montant vous etant verse:vos revenus:prix de la course'),
    tip: H.findIndex(c => /:pourboire$/.test(c)), toll: H.findIndex(c => /:peage$/.test(c)) };
  const bonusCols = H.map((c, i) => c.indexOf('vos revenus:bonus') >= 0 ? i : -1).filter(i => i >= 0);
  if (ix.at < 0) ix.at = H.findIndex(c => c === 'date' || c.indexOf('date et heure') >= 0);
  const v = (r, i) => i >= 0 ? cshAmount(r[i]) || 0 : 0, out = [], bad = [];
  // ligne complète (cellules non vides et montants non nuls, par en-tête d'origine) : recopiée à l'identique dans le classeur de sauvegarde
  const HELP = ['date', 'prenom nom', 'especes collectees', 'check doublons', ''], rawCols = rows[h].map((c, j) => HELP.indexOf(H[j]) < 0 ? [String(c).trim(), j] : null).filter(Boolean);
  const rawOf = r => { const o = {}; rawCols.forEach(([k, j]) => { const x = r[j]; if (x === undefined || x === null || String(x).trim() === '') return;
    const t = String(x).trim(), n = /^-?[\d\s.,]+(\s*(MAD|DH))?$/i.test(t) ? cshAmount(t) : null; if (n === 0) return; o[k] = n !== null ? n : t; }); return o; };
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [], tx = String(r[ix.tx] || '').trim(); if (!tx) continue;
    const at = cshUberTime(r[ix.at], localToDate);
    if (!at) { bad.push(i + 1); continue; }
    out.push({ tx, at, driver_uuid: String(r[ix.du] || '').trim() || null, driver_name: [r[ix.fn], r[ix.ln]].map(x => String(x || '').trim()).filter(Boolean).join(' ') || null,
      first_name: String(r[ix.fn] || '').trim() || null, last_name: String(r[ix.ln] || '').trim() || null, raw: rawOf(r),
      trip: ix.trip >= 0 ? String(r[ix.trip] || '').trim() || null : null, description: ix.desc >= 0 ? String(r[ix.desc] || '').trim() || null : null,
      cash: cshR(-v(r, ix.cash)), revenue: cshR(v(r, ix.revenue)), payout: cshR(v(r, ix.payout)), fare: cshR(v(r, ix.fare)), tip: cshR(v(r, ix.tip)), toll: cshR(v(r, ix.toll)),
      bonus: cshR(bonusCols.reduce((s, c) => s + v(r, c), 0)) });
  }
  return { rows: out, bad };
}
/** Export Uber « Driver Status » → { uuid, name, phone, email, status } */
function cshParseUberDrivers(rows) {
  const h = cshHeader(rows, c => c === 'uuid du chauffeur'); if (h < 0) return { error: 'colonne « UUID du chauffeur » introuvable', rows: [] };
  const H = rows[h].map(cshNorm), eq = t => H.indexOf(t);
  // onglet des opérations de paiement (il a aussi « UUID du chauffeur ») : pas une liste de chauffeurs (import du classeur complet)
  if (eq('uuid de la transaction') >= 0) return { error: 'opérations de paiement, pas une liste de chauffeurs', rows: [] };
  const ix = { uuid: eq('uuid du chauffeur'), name: eq('nom du chauffeur'), phone: H.findIndex(c => c.indexOf('telephone') >= 0), email: H.findIndex(c => c.indexOf('e-mail') >= 0 || c.indexOf('email') >= 0), status: eq('statut') };
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [], u = String(r[ix.uuid] || '').trim(); if (!/^[0-9a-f-]{20,}$/i.test(u)) continue;
    out.push({ uuid: u, name: String(r[ix.name] || '').trim() || null, phone: ix.phone >= 0 ? String(r[ix.phone] || '').trim() || null : null,
      email: ix.email >= 0 ? String(r[ix.email] || '').trim() || null : null, status: ix.status >= 0 ? String(r[ix.status] || '').trim() || null : null });
  }
  return { rows: out };
}
/**
 * Chauffeur Ludy correspondant à un chauffeur Uber : même téléphone, sinon même nom (mots dans n'importe quel ordre) ;
 * seulement un candidat unique (même règle que refresh_drivers de la base) : deux chauffeurs au même téléphone = aucun.
 */
function cshMatchDriver(u, drivers) {
  const p = cshPhone(u.phone), n = cshName(u.name);
  const bp = p ? drivers.filter(d => cshPhone(d.phone) === p) : [];
  if (bp.length) return bp.length === 1 ? bp[0] : null;
  const bn = n ? drivers.filter(d => cshName(d.name) === n) : [];
  return bn.length === 1 ? bn[0] : null;
}
/** Liens Uber → Ludy d'une liste de chauffeurs Uber : candidat unique dans les deux sens (un chauffeur Ludy proposé à deux comptes = aucun) */
function cshMatchAll(list, drivers) {
  const m = (list || []).map(u => [u, cshMatchDriver(u, drivers)]).filter(x => x[1]), n = {};
  m.forEach(x => { n[x[1].code] = (n[x[1].code] || 0) + 1; });
  return m.filter(x => n[x[1].code] === 1);
}

function cshHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const CSH_FLOW = { 'entree de cash': 'in', 'sortie de cash': 'out', 'virement': 'virement' };
const CSH_SHIFT = { 'shift 1': 'Jour', 'shift 2': 'Nuit', 'jour': 'Jour', 'nuit': 'Nuit' };
/**
 * Historique du classeur (chaque onglet « Caisse - … », reconnu par ses en-têtes) → mouvements de caisse.
 * Lignes vides ou à 0 MAD ignorées ; une date absente reprend celle de la ligne précédente (signalé dans le commentaire) ;
 * onglets « … Ludy » (copie de sauvegarde écrite par le collecteur) ignorés.
 * import_key : même ligne réimportée = pas de doublon (deux lignes identiques gardent chacune la leur) ; calculée sur les colonnes
 * saisies seulement (date, chauffeur, gestionnaire, montants, opération, entrée / sortie, source, libellés), jamais sur les formules
 * (UUID, net, manquant, check Uber, prime, reste) ni sur ce qui change après coup (justificatif, statut, signature, commentaire).
 * legacy_key : clé de la version précédente (ligne entière) : lignes déjà reprises reconnues par le site, sans doublon.
 * ctx : { resolve(name, uuid) → { driver_code, driver_name, uber_uuid } }
 */
function cshParseHistory(sheets, ctx) {
  const res = { moves: [], counts: {}, skipped: 0, ignored: [] }, resolve = ctx && ctx.resolve ? ctx.resolve : (n, u) => ({ driver_code: null, driver_name: n || null, uber_uuid: u || null });
  const TYPES = [['uber', c => c.indexOf('montant especes affiche sur uber') >= 0], ['depenses', c => c.indexOf('montant decaisse') >= 0],
    ['courses', c => c === 'montant de la course'], ['rh', c => c === 'avance signee'], ['bonus', c => c === 'date de saisie']];
  Object.keys(sheets).forEach(name => {
    if (/\sLudy$/i.test(String(name).trim())) { res.ignored.push(name); return; }
    const rows = sheets[name] || [];
    let type = null, h = -1;
    for (const t of TYPES) { h = cshHeader(rows, t[1], 20); if (h >= 0) { type = t[0]; break; } }
    if (!type) return;
    const H = rows[h].map(cshNorm), col = (...ts) => { for (const t of ts) { const i = H.findIndex(c => c === t || c.indexOf(t) === 0); if (i >= 0) return i; } return -1; };
    const seen = {}, seenL = {}; let last = '', n = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || [], g = c => c >= 0 ? r[c] : '', s = c => String(g(c) == null ? '' : g(c)).trim();
      const legacy = JSON.stringify(r.map(x => String(x == null ? '' : x).trim())), A = c => { const v = cshAmount(g(c)); return v == null ? '' : cshR(v); };
      if (!r.some(x => String(x == null ? '' : x).trim())) continue;
      let day = cshDay(g(col('date debut du shift', 'date d\'operation', 'date de saisie', 'date'))), note = '';
      if (!day) { if (!last) { res.skipped++; continue; } day = last; note = 'date absente dans le classeur : reprise de la ligne précédente'; } else last = day;
      const flowTxt = cshNorm(s(col('entree / sortie'))), flow0 = CSH_FLOW[flowTxt] || '';
      const who = s(col('chauffeur', 'driver')), uuid = s(col('uuid chauffeur', 'uui chauffeur')).replace(/^#n\/a$/i, '');
      const m = { caisse: type, day, manager_name: s(col('gestionnaire')) || null, source: s(col('source')) || null, comment: [s(col('commentaires')), note].filter(Boolean).join(' · ') || null };
      if (type === 'uber') {
        const op = cshNorm(s(col('operation'))), uberCash = cshAmount(g(col('montant especes affiche sur uber'))), given = cshAmount(g(col('montant donne par chauffeur'))),
          change = cshAmount(g(col('monnaie rendue'))), net = cshAmount(g(col('montant encaisse net')));
        if (op === 'chauffeur') Object.assign(m, { kind: 'encaissement', flow: 'in', amount: Math.abs(net != null ? net : cshN(given) - cshN(change)), uber_cash: uberCash, given, change });
        // l'« Entrée / Sortie » du classeur fait foi (solde identique) ; un dépôt noté en entrée est signalé
        else if (op.indexOf('depot') >= 0) Object.assign(m, { kind: 'depot', flow: flow0 || 'out', amount: Math.abs(cshN(net) || cshN(given)), label: 'Dépôt en banque',
          comment: [m.comment, flow0 === 'in' ? 'dépôt en banque noté « Entrée de cash » dans le classeur : à vérifier' : ''].filter(Boolean).join(' · ') || null });
        else if (op.indexOf('recharge') >= 0) Object.assign(m, { kind: 'recharge', flow: flow0 || 'in', amount: Math.abs(cshN(net) || cshN(given)), label: 'Recharge de caisse',
          comment: [m.comment, flow0 === 'out' ? 'recharge notée « Sortie de cash » dans le classeur : à vérifier' : ''].filter(Boolean).join(' · ') || null });
        // ligne sans opération ni « Entrée / Sortie » : hors caisse, comme le solde du classeur (seules les entrées et sorties comptent)
        else Object.assign(m, { kind: 'autre', flow: flow0 || 'virement', amount: Math.abs(cshN(net) || cshN(given)), label: s(col('operation')) || (flow0 ? null : 'Ligne sans opération ni entrée / sortie') });
        if (m.kind === 'encaissement' && !who) m.comment = [m.comment, 'chauffeur non renseigné dans le classeur'].filter(Boolean).join(' · ');   // gardé : compté dans la caisse
      } else if (type === 'depenses') {
        const lab = s(col('operation')), ln = cshNorm(lab), a = Math.abs(cshN(cshAmount(g(col('montant decaisse')))));
        if (!a) { res.skipped++; continue; }
        const kind = ln.indexOf('recharge de caisse') >= 0 ? 'recharge' : ln.indexOf('depot en banque') >= 0 ? 'depot' : ln.indexOf('remise d\'especes') >= 0 ? 'autre' : 'depense';
        const jt = s(col('justif')).toUpperCase().replace('NA', 'N.A');
        Object.assign(m, { kind, flow: flow0 || (kind === 'recharge' ? 'in' : 'out'), amount: a, label: lab || null, ride_type: s(col('type de courses')) || null,
          shift: CSH_SHIFT[cshNorm(s(col('shift')))] || null, justif: ['OK', 'KO', 'N.A'].indexOf(jt) >= 0 ? jt : null });
      } else if (type === 'rh') {
        const mot = s(col('motif')), mn = cshNorm(mot), a = Math.abs(cshN(cshAmount(g(col('montant')))));
        if (!a) { res.skipped++; continue; }
        Object.assign(m, { kind: mn.indexOf('avance') >= 0 ? 'avance' : mn.indexOf('recharge') >= 0 ? 'recharge' : 'autre', flow: flow0 || 'out', amount: a, label: mot || null,
          signed: cshNorm(s(col('avance signee'))) === 'ok' ? true : null });
        const sold = s(col('avance signee') + 1); if (sold && !/^ok$/i.test(sold)) m.comment = [m.comment, sold].filter(Boolean).join(' · ');
      } else if (type === 'courses') {
        const mot = s(col('motif')), mn = cshNorm(mot), a = Math.abs(cshN(cshAmount(g(col('montant')))));
        if (!a) { res.skipped++; continue; }
        if (mn.indexOf('encaissement') >= 0) {
          // commission : « 10% » / « 1% » = 10 / 1 % ; fraction seulement sans « % » et < 1 (0,1 = 10 %)
          const ca = cshAmount(g(col('montant de la course'))), pcTxt = s(col('commission chauffeur')), pc = cshAmount(pcTxt.replace('%', '')),
            pct = pc == null ? null : pcTxt.indexOf('%') < 0 && Math.abs(pc) < 1 ? cshR(pc * 100) : pc;
          const prime = cshAmount(g(col('prime chauffeur'))), paid = cshAmount(g(col('montant deja paye')));
          const route = [s(col('depart')), s(col('arrive'))].filter(Boolean).join(' → '), dc = cshDay(g(col('date de la course')));
          Object.assign(m, { kind: 'course', flow: flow0 || 'in', amount: a, course_amount: ca, commission_pct: pct, prime: prime != null ? prime : cshR(cshN(ca) * cshN(pct) / 100),
            prime_paid: paid != null ? paid : cshR(Math.max(0, cshN(ca) - a)), label: route || null,
            comment: [dc && dc !== day ? 'course du ' + dc.split('-').reverse().join('/') : '', m.comment].filter(Boolean).join(' · ') || null });
        } else Object.assign(m, { kind: mn.indexOf('depot') >= 0 ? 'depot' : mn.indexOf('recharge') >= 0 ? 'recharge' : 'autre', flow: flow0 || (mn.indexOf('recharge') >= 0 ? 'in' : 'out'), amount: a, label: mot || null });
      } else if (type === 'bonus') {
        const mot = s(col('motif')), a = Math.abs(cshN(cshAmount(g(col('montant')))));
        if (!a) { res.skipped++; continue; }
        const st = cshNorm(s(col('statut')));
        Object.assign(m, { kind: cshNorm(mot).indexOf('recharge') >= 0 ? 'recharge' : 'bonus', flow: flow0 || 'out', amount: a, label: mot || null, status: st === 'a payer' ? 'A payer' : st === 'paye' ? 'Payé' : null });
      }
      if (who || uuid) Object.assign(m, resolve(who, /^[0-9a-f-]{20,}$/i.test(uuid) ? uuid : ''));
      m.amount = cshR(m.amount);
      // colonnes saisies de chaque onglet (net d'encaissement : seulement quand le montant donné est vide, sinon c'est la formule)
      const ent = type === 'uber' ? [s(col('operation')), A(col('montant especes affiche sur uber')), A(col('montant donne par chauffeur')), A(col('monnaie rendue')),
          s(col('montant donne par chauffeur')) ? '' : A(col('montant encaisse net'))]
        : type === 'depenses' ? [s(col('shift')), A(col('montant decaisse')), s(col('type de courses')), s(col('operation'))]
        : type === 'courses' ? [A(col('montant')), s(col('motif')), s(col('depart')), s(col('arrive')), cshDay(g(col('date de la course'))), A(col('montant de la course')), m.commission_pct == null ? '' : m.commission_pct]
        : [A(col('montant')), s(col('motif'))];
      const sig = JSON.stringify([day, cshName(who), s(col('gestionnaire')), flowTxt, s(col('source'))].concat(ent));
      seen[sig] = (seen[sig] || 0) + 1; seenL[legacy] = (seenL[legacy] || 0) + 1;
      m.import_key = 'xl2:' + type + ':' + cshHash(sig) + ':' + seen[sig];
      m.legacy_key = 'xl:' + type + ':' + cshHash(legacy) + ':' + seenL[legacy];
      res.moves.push(m); n++;
    }
    res.counts[type] = (res.counts[type] || 0) + n;
  });
  return res;
}

if (typeof module !== 'undefined') module.exports = { CASH_CAISSES, cshN, cshR, cshAmount, cshNorm, cshName, cshPhone, cshDay, cshSigned, cshBalances, cshKey, cshRappro, cshPayroll,
  cshWeek, cshCA, cshDaily, cshByCategory, cshCourse, cshUberTime, cshParseUberPayments, cshParseUberDrivers, cshMatchDriver, cshMatchAll, cshLinks, cshParseHistory };
