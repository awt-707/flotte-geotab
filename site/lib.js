// Outils communs : dates au fuseau du Maroc, plaques, nombres (mêmes règles que le moteur v6 du collecteur)
const TZ = 'Africa/Casablanca', MIN = 60000, HOUR = 3600000, DAY = 86400000, HORS = 'HORS_CONTRAT';

const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function parts(d) { const o = {}; fmtParts.formatToParts(new Date(d)).forEach(p => { o[p.type] = p.value; }); return o; }
function tzOffsetMin(d) { const p = parts(d); const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); return Math.round((asUtc - Math.floor(new Date(d).getTime() / 1000) * 1000) / MIN); }
function localToDate(y, mo, d, h, mi) { const g = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0)); return new Date(g.getTime() - tzOffsetMin(g) * MIN); }
function localDay(d) { const p = parts(d); return p.year + '-' + p.month + '-' + p.day; }
function localHM(d) { const p = parts(d); return p.hour + ':' + p.minute; }
function dayBounds(day) { const p = day.split('-').map(Number), n = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return { start: localToDate(p[0], p[1], p[2], 0, 0), end: localToDate(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0) }; }
function addDays(day, n) { const p = day.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
function mondayOf(day) { const p = day.split('-').map(Number), wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); return addDays(day, -((wd + 6) % 7)); }
function today() { return localDay(Date.now()); }
function fmtDay(day) { if (!day) return ''; const p = String(day).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function fmtDT(d) { if (!d) return ''; const p = parts(d); return p.day + '/' + p.month + ' ' + p.hour + ':' + p.minute; }
function fmtDTY(d) { if (!d) return ''; const p = parts(d); return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute; }
/** "05/10/2026 à 13h30", "05/10/2026 13:30", "2026-10-05 13:30", "05/10/2026" (heure du Maroc) */
function parseLocalDT(v) {
  if (v instanceof Date) return v;
  const s = String(v == null ? '' : v).trim(); if (!s) return null;
  let m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\D+?(\d{1,2})\s*[hH:]\s*(\d{2})?)?/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return localToDate(y, +m[2], +m[1], +(m[4] || 0), +(m[5] || 0)); }
  m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return localToDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(s); return isNaN(d) ? null : d;
}
function deacc(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function normTxt(s) { return deacc(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
/** Plaque normalisée : chiffres puis lettres. WW968193 et 968193WW donnent 968193WW. */
function normPlate(s) { const t = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); return t.replace(/[^0-9]/g, '') + t.replace(/[^A-Z]/g, ''); }
function isTempPlate(p) { const n = normPlate(p); return /WW$/.test(n) || /W18/.test(String(p).toUpperCase()) || /^W\d/.test(String(p).toUpperCase()); }
function num(v, d) { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isNaN(n) ? (d === undefined ? 0 : d) : n; }
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }), nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function f0(v) { return v === null || v === undefined || v === '' ? '' : nf0.format(v); }
function f1(v) { return v === null || v === undefined || v === '' ? '' : nf1.format(v); }
/** heures décimales -> "2h05" */
function fH(h) { if (h === null || h === undefined || h === '') return ''; const m = Math.round(num(h) * 60); return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function mapLink(la, lo) { return la != null && lo != null && isFinite(+la) && isFinite(+lo) ? 'https://maps.google.com/?q=' + (+la).toFixed(5) + ',' + (+lo).toFixed(5) : ''; }

/** Plaque -> clé du véhicule (toutes les plaques d'un véhicule, y compris les changements saisis, renvoient à sa clé historique) */
function buildCanonMap(vehicles, plateChanges) {
  const m = {};
  vehicles.forEach(v => {
    if (!v.key) return; m[v.key] = v.key;
    [v.plate].concat(String(v.other_plates || '').split(/[,;]\s*/)).map(x => String(x || '').trim()).filter(Boolean).forEach(p => { m[normPlate(p)] = v.key; });
  });
  plateChanges.forEach(r => {
    const o = normPlate(r.old_plate), n = normPlate(r.new_plate); if (o.length < 4 || n.length < 4) return;
    if (m[o] && !m[n]) m[n] = m[o]; else if (m[n] && !m[o]) m[o] = m[n];
  });
  return m;
}
const canonKey = (key, cm) => { key = String(key || ''); return cm[key] || key; };

/** Lecture d'un extract de contrats (2D, en-têtes) : même logique que l'injection du Google Sheet */
function parseContracts(rows, cm) {
  if (!rows || rows.length < 2) throw new Error('Fichier vide.');
  let hr = rows.findIndex(r => r.some(c => /num.*contrat/.test(normTxt(c)))); if (hr < 0) hr = 0;
  const head = rows[hr].map(normTxt), col = re => head.findIndex(h => re.test(h));
  const c = { num: col(/num.*contrat/), code: col(/code client/), nom: col(/nom du client|^client|chauffeur/), plate: col(/^immatriculation$/),
    plateTmp: col(/immatriculation temp/), depEff: col(/depart effectif/), retEff: col(/retour effectif/), dep: col(/date de depart/),
    ret: col(/date de retour/), statut: col(/statut/), origine: col(/origine/), tel: col(/telephone/), mail: col(/e-?mail/), comment: col(/commentaire/), model: col(/modele/) };
  if (c.num < 0 || c.plate < 0) throw new Error('Colonnes « Numéro de contrat » ou « Immatriculation » introuvables.');
  const g = (r, k) => c[k] >= 0 ? String(r[c[k]] == null ? '' : r[c[k]]).trim() : '';
  const out = [], seen = {}; let read = 0, dup = 0, invalid = 0;
  rows.slice(hr + 1).forEach(r => {
    const numc = g(r, 'num'); if (!numc) return; read++;
    if (seen[numc]) { dup++; return; } seen[numc] = 1;
    const plate = (g(r, 'plate') || g(r, 'plateTmp')).toUpperCase().replace(/\s+/g, '');
    const start = parseLocalDT(g(r, 'depEff')) || parseLocalDT(g(r, 'dep'));
    if (!plate || !start) { invalid++; return; }
    const statut = g(r, 'statut');
    let end = parseLocalDT(g(r, 'retEff'));
    if (!end && !/cours/i.test(statut)) { const d = parseLocalDT(g(r, 'ret')); if (d) end = new Date(dayBounds(localDay(d)).end.getTime() - 1); }
    out.push({ num: numc, client_code: g(r, 'code') || ('N-' + normTxt(g(r, 'nom')).replace(/[^a-z]/g, '').slice(0, 12)), name: g(r, 'nom'), plate,
      vehicle_key: canonKey(normPlate(plate), cm), model: g(r, 'model'), start_at: start.toISOString(), end_at: end ? end.toISOString() : null, status: statut,
      origin: g(r, 'origine'), phone: g(r, 'tel').replace(/^'/, ''), email: g(r, 'mail'), comment: g(r, 'comment') });
  });
  return { rows: out, read, dup, invalid };
}
/** Signature d'un contrat : un contrat déjà importé identique est ignoré */
function ctrSig(x) { return [x.client_code, x.name, x.vehicle_key, x.start_at ? new Date(x.start_at).getTime() : '', x.end_at ? new Date(x.end_at).getTime() : '', x.status || ''].join('|'); }

// ---------- Agrégation des journées de travail (comme le tableau de bord du Google Sheet) ----------
function emptyAgg() { return { km: 0, drive: 0, idle: 0, idleLong: 0, nLong: 0, fuel: 0, fuelKm: 0, fuelN: 0, idleFuel: 0, idleFuelN: 0, cost: 0, costN: 0,
  idleCost: 0, idleCostN: 0, ctrH: 0, vmax: 0, limVmax: null, worst: null, evts: 0, pts: 0, fills: 0, fillL: 0, siph: 0, siphL: 0, kmHors: 0, trips: 0,
  days: {}, ctr: {}, names: {}, plates: {}, srcs: {}, l100: null }; }
function aggJournal(rows, keyFn, P) {
  const o = {}, minKm = P.minFuelKm || 30;
  rows.forEach(r => {
    const k = keyFn(r), a = o[k] || (o[k] = Object.assign(emptyAgg(), { k }));
    a.km += num(r.km); a.drive += num(r.drive_h); a.idle += num(r.idle_h); a.idleLong += num(r.long_idle_h); a.nLong += num(r.n_long_idle); a.ctrH += num(r.contract_h);
    if (r.fuel_l !== null) { a.fuel += num(r.fuel_l); a.fuelKm += num(r.fuel_km); a.fuelN++; a.srcs[r.fuel_source] = 1; }
    if (r.idle_fuel_l !== null) { a.idleFuel += num(r.idle_fuel_l); a.idleFuelN++; }
    if (r.fuel_cost !== null) { a.cost += num(r.fuel_cost); a.costN++; }
    if (r.idle_cost !== null) { a.idleCost += num(r.idle_cost); a.idleCostN++; }
    if (num(r.vmax) > a.vmax) { a.vmax = num(r.vmax); a.limVmax = r.lim_at_vmax; }
    if (r.worst_over !== null && (a.worst === null || num(r.worst_over) > a.worst)) a.worst = num(r.worst_over);
    a.evts += num(r.n_events); a.pts += num(r.danger_pts); a.fills += num(r.n_fills); a.fillL += num(r.fill_l); a.siph += num(r.n_siphon); a.siphL += num(r.siphon_l);
    a.kmHors += num(r.km_off_contract); a.trips += num(r.n_trips);
    a.days[r.day] = 1; a.names[r.driver_name] = 1; a.plates[r.plate] = 1; if (r.contract_num) a.ctr[r.contract_num] = 1;
  });
  Object.values(o).forEach(a => { a.l100 = a.fuelKm >= minKm ? a.fuel / a.fuelKm * 100 : null; });
  return o;
}
const NM = 'non mesuré';
function scoreOf(a, P) { return a.pts / Math.max(a.km, P.kmMin || 20) * 100; }
function levelOf(score, P) { return score >= P.scoreR ? 'Dangereux' : score >= P.scoreO ? 'Élevé' : score >= P.scoreY ? 'Modéré' : 'Faible'; }
function fuelVal(a) { return a.fuelN ? f1(a.fuel) : NM; }
function l100Val(a) { return a.l100 !== null ? f1(a.l100) : (a.fuelN ? 'km insuffisants' : NM); }
function srcTxt(a) { const s = Object.keys(a.srcs); return s.length ? (s.length > 1 ? 'Mixte' : s[0]) : 'Non mesuré'; }

if (typeof module !== 'undefined') module.exports = { localDay, localHM, dayBounds, addDays, parseLocalDT, normPlate, buildCanonMap, canonKey, parseContracts, ctrSig, aggJournal, scoreOf, levelOf, tzOffsetMin, localToDate };
