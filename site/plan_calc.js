// Planning des chauffeurs (calculs purs, testés sous Node) : chaque véhicule actif de l'agence tourne en deux shifts (jour, nuit)
// tous les jours ; chaque chauffeur a deux jours de repos par semaine. Génération de la semaine, remplacement des absents,
// contrôle des règles (repos, absence, un seul shift par jour, pas de jour juste après une nuit), textes à partager.

const PLAN_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const PLAN_SHIFTS = ['Jour', 'Nuit'];
const PLAN_MAX = 5;   // shifts par semaine (7 jours − 2 jours de repos)

function planAddDays(d, n) { const p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
/** Jour de la semaine : 1 = lundi … 7 = dimanche */
function planWd(d) { const p = d.split('-').map(Number), w = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); return w === 0 ? 7 : w; }
function planMonday(d) { return planAddDays(d, 1 - planWd(d)); }
function planWeekDays(monday) { return [0, 1, 2, 3, 4, 5, 6].map(i => planAddDays(monday, i)); }
function planDdMm(d) { return d.slice(8, 10) + '/' + d.slice(5, 7); }
function planHours(s, P) { const z = h => String(h == null ? '' : h).padStart(2, '0') + ':00', d = P && P.shiftDay != null ? +P.shiftDay : 7, n = P && P.shiftNight != null ? +P.shiftNight : 19; return s === 'Jour' ? z(d) + ' → ' + z(n) : z(n) + ' → ' + z(d); }
/** Chauffeurs nécessaires pour couvrir tous les véhicules 2 shifts × 7 jours avec 5 shifts par chauffeur */
function planNeed(nVeh) { return Math.ceil(nVeh * PLAN_SHIFTS.length * 7 / PLAN_MAX); }
function planOff(dr, day) { return (dr.off || []).indexOf(planWd(day)) >= 0; }
function planAbsent(absent, code, day) { return !!(absent && absent[code] && absent[code][day]); }

/**
 * Jours de repos répartis automatiquement (deux jours consécutifs par chauffeur) : pour chaque shift, les repos sont étalés sur la
 * semaine pour qu'il reste chaque jour le plus de chauffeurs possible. Les chauffeurs qui ont déjà leurs repos les gardent.
 * drivers : [{ code, shift, vehicle, off }] → { code: [j1, j2] } pour ceux qui n'en avaient pas
 */
function planAutoOff(drivers) {
  const load = { Jour: [0, 0, 0, 0, 0, 0, 0, 0], Nuit: [0, 0, 0, 0, 0, 0, 0, 0], '': [0, 0, 0, 0, 0, 0, 0, 0] }, out = {};
  const g = d => PLAN_SHIFTS.indexOf(d.shift) >= 0 ? d.shift : '';
  drivers.forEach(d => { if ((d.off || []).length === 2) d.off.forEach(w => { load[g(d)][w]++; }); });
  drivers.filter(d => (d.off || []).length !== 2).sort((a, b) => String(a.vehicle || '').localeCompare(String(b.vehicle || '')) || String(a.code).localeCompare(String(b.code))).forEach((d, i) => {
    const L = load[g(d)]; let best = null;
    for (let k = 0; k < 7; k++) {
      const a = (i + k) % 7 + 1, b = a % 7 + 1, sc = L[a] + L[b];   // à charge égale : décalé d'un jour par chauffeur (repos étalés)
      if (!best || sc < best.sc) best = { sc, p: [a, b] };
    }
    best.p.forEach(w => { L[w]++; }); out[d.code] = best.p;
  });
  return out;
}

/**
 * Semaine générée. o = { days: [7 jours], vehicles: [{ key }], drivers: [{ code, name, shift, vehicle, off, active }],
 *   absent: { code: { jour: true } }, locked: [{ day, shift, vehicle_key, driver_code }] (gardées telles quelles),
 *   prevNight: [codes] (chauffeurs de nuit la veille du lundi) }
 * Ordre : jour puis nuit, chaque jour ; d'abord le chauffeur habituel du véhicule pour ce shift, sinon le remplaçant disponible
 * qui a le moins de shifts (même shift d'abord) ; jamais un chauffeur au repos, absent, déjà pris ce jour-là, au-delà de 5 shifts
 * ou en jour juste après une nuit. Case sans chauffeur possible : non couverte.
 */
function planWeek(o) {
  const drivers = (o.drivers || []).filter(d => d.active !== false), byCode = {}, count = {}, cells = [];
  drivers.forEach(d => { byCode[d.code] = d; count[d.code] = 0; });
  const lock = {}; (o.locked || []).forEach(c => { lock[c.day + '|' + c.shift + '|' + c.vehicle_key] = c; });
  // shifts déjà fixés (cases verrouillées) comptés d'avance
  (o.locked || []).forEach(c => { if (c.driver_code && count[c.driver_code] !== undefined) count[c.driver_code]++; });
  let nights = new Set(o.prevNight || []);
  const vehicles = (o.vehicles || []).slice().sort((a, b) => String(a.plate || a.key).localeCompare(String(b.plate || b.key)));
  o.days.forEach(day => {
    const used = new Set(), tonight = new Set();
    (o.locked || []).filter(c => c.day === day && c.driver_code).forEach(c => { used.add(c.driver_code); if (c.shift === 'Nuit') tonight.add(c.driver_code); });
    const free = (d, s) => !used.has(d.code) && !planOff(d, day) && !planAbsent(o.absent, d.code, day) && count[d.code] < PLAN_MAX && !(s === 'Jour' && nights.has(d.code));
    PLAN_SHIFTS.forEach(s => {
      const todo = [];
      vehicles.forEach(v => {
        const k = day + '|' + s + '|' + v.key;
        if (lock[k]) { cells.push({ day, shift: s, vehicle_key: v.key, driver_code: lock[k].driver_code || null, locked: true }); return; }
        const reg = drivers.find(d => d.vehicle === v.key && d.shift === s && free(d, s));
        if (reg) { used.add(reg.code); count[reg.code]++; if (s === 'Nuit') tonight.add(reg.code); cells.push({ day, shift: s, vehicle_key: v.key, driver_code: reg.code, locked: false }); }
        else todo.push(v);
      });
      todo.forEach(v => {
        // remplaçant : pas le chauffeur habituel d'un autre véhicule encore à servir ce shift, même shift d'abord, le moins chargé
        const cand = drivers.filter(d => free(d, s) && !(d.vehicle && d.vehicle !== v.key && d.shift === s && vehicles.some(x => x.key === d.vehicle)))
          .sort((a, b) => ((a.shift === s ? 0 : a.shift ? 2 : 1) - (b.shift === s ? 0 : b.shift ? 2 : 1)) || count[a.code] - count[b.code] || String(a.name || a.code).localeCompare(String(b.name || b.code)));
        const c = cand[0];
        if (c) { used.add(c.code); count[c.code]++; if (s === 'Nuit') tonight.add(c.code); }
        cells.push({ day, shift: s, vehicle_key: v.key, driver_code: c ? c.code : null, locked: false });
      });
    });
    nights = tonight;
  });
  return { cells, count, unfilled: cells.filter(c => !c.driver_code).length };
}

/** Contrôle d'une semaine (cases modifiées à la main comprises) : { 'jour|shift|véhicule': ['…'] } */
function planCheck(cells, drivers, absent, prevNight) {
  const by = {}, out = {}, perDay = {}, cnt = {}, nights = {};
  (drivers || []).forEach(d => { by[d.code] = d; });
  (prevNight || []).forEach(c => { nights[c] = true; });
  cells.forEach(c => { if (!c.driver_code) return; const k = c.day + '|' + c.driver_code; perDay[k] = (perDay[k] || 0) + 1; cnt[c.driver_code] = (cnt[c.driver_code] || 0) + 1; });
  const nightOf = {}; cells.forEach(c => { if (c.driver_code && c.shift === 'Nuit') nightOf[c.day + '|' + c.driver_code] = true; });
  const first = cells.reduce((m, c) => !m || c.day < m ? c.day : m, '');
  cells.forEach(c => {
    const w = [], d = by[c.driver_code], k = c.day + '|' + c.shift + '|' + c.vehicle_key;
    if (!c.driver_code) w.push('non couvert');
    else {
      if (d && planOff(d, c.day)) w.push('jour de repos');
      if (planAbsent(absent, c.driver_code, c.day)) w.push('absent');
      if (perDay[c.day + '|' + c.driver_code] > 1) w.push('deux shifts le même jour');
      if (c.shift === 'Jour' && (nightOf[planAddDays(c.day, -1) + '|' + c.driver_code] || (nights[c.driver_code] && c.day === first))) w.push('sans repos après une nuit');
      if (cnt[c.driver_code] > PLAN_MAX) w.push(cnt[c.driver_code] + ' shifts dans la semaine');
      if (d && d.active === false) w.push('chauffeur inactif');
    }
    if (w.length) out[k] = w;
  });
  return out;
}

// ---------- Textes à partager (WhatsApp, e-mail) ----------
const PLAN_ICON = { Jour: '☀️', Nuit: '🌙' };
/** Planning de la semaine, toute l'agence */
function planWeekText(o) {
  const name = c => (o.names[c] || c), plate = k => (o.plates[k] || k), days = planWeekDays(o.monday), out = [];
  out.push('📅 Planning chauffeurs · semaine du ' + planDdMm(days[0]) + ' au ' + planDdMm(days[6]) + (o.agency ? ' · ' + o.agency : ''));
  days.forEach((d, i) => {
    out.push(''); out.push('*' + PLAN_DAYS[i] + ' ' + planDdMm(d) + '*');
    PLAN_SHIFTS.forEach(s => {
      const l = o.cells.filter(c => c.day === d && c.shift === s).sort((a, b) => plate(a.vehicle_key).localeCompare(plate(b.vehicle_key)));
      if (!l.length) return;
      out.push(PLAN_ICON[s] + ' ' + s + ' (' + planHours(s, o.P) + ') : ' + l.map(c => plate(c.vehicle_key) + ' ' + (c.driver_code ? name(c.driver_code) : '— non couvert')).join(' · '));
    });
  });
  return out.join('\n');
}
/** Planning de la semaine d'un chauffeur */
function planDriverText(o, code) {
  const days = planWeekDays(o.monday), mine = o.cells.filter(c => c.driver_code === code), out = [];
  out.push('Bonjour ' + (o.names[code] || '') + ', voici ton planning de la semaine du ' + planDdMm(days[0]) + ' au ' + planDdMm(days[6]) + ' :');
  days.forEach((d, i) => {
    const c = mine.filter(x => x.day === d);
    out.push('• ' + PLAN_DAYS[i] + ' ' + planDdMm(d) + ' : ' + (c.length ? c.map(x => PLAN_ICON[x.shift] + ' ' + x.shift + ' ' + planHours(x.shift, o.P) + ' · ' + (o.plates[x.vehicle_key] || x.vehicle_key)).join(' + ') : 'repos'));
  });
  out.push('', 'Merci de prévenir au plus tôt en cas d\'empêchement.');
  return out.join('\n');
}
/** Veille de shift : liste du shift à venir (agence) */
function planEveText(o, day, s) {
  const l = o.cells.filter(c => c.day === day && c.shift === s).sort((a, b) => (o.plates[a.vehicle_key] || '').localeCompare(o.plates[b.vehicle_key] || ''));
  const out = [PLAN_ICON[s] + ' Shift ' + s.toLowerCase() + ' du ' + PLAN_DAYS[planWd(day) - 1].toLowerCase() + ' ' + planDdMm(day) + ' · ' + planHours(s, o.P) + (o.agency ? ' · ' + o.agency : ''), ''];
  l.forEach(c => out.push((o.plates[c.vehicle_key] || c.vehicle_key) + ' : ' + (c.driver_code ? (o.names[c.driver_code] || c.driver_code) + (o.phones && o.phones[c.driver_code] ? ' (' + o.phones[c.driver_code] + ')' : '') : '⚠️ non couvert')));
  return out.join('\n');
}
/** Rappel individuel de la veille */
function planEveDriverText(o, day, s, c) {
  return 'Bonjour ' + (o.names[c.driver_code] || '') + ', rappel : ' + PLAN_DAYS[planWd(day) - 1].toLowerCase() + ' ' + planDdMm(day) + ' tu es en shift ' + s.toLowerCase() + ' (' + planHours(s, o.P) + ') sur le véhicule ' +
    (o.plates[c.vehicle_key] || c.vehicle_key) + '. Merci de confirmer.';
}

if (typeof module !== 'undefined') module.exports = { PLAN_DAYS, PLAN_MAX, planWd, planMonday, planWeekDays, planNeed, planAutoOff, planWeek, planCheck, planWeekText, planDriverText, planEveText, planEveDriverText, planAddDays };
