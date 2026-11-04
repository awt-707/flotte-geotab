// Ressources humaines : calculs purs (testés sous Node). Jours au format AAAA-MM-JJ, instants en millisecondes.
// Rien n'est estimé : présence des chauffeurs = contrats Ludy (un contrat = un shift), présence du staff = pointage sur Ludy.

const RH_DAY_MS = 86400000, RH_H = 3600000;
const RH_KINDS = { conge: 'Congé', maladie: 'Arrêt maladie', absence: 'Absence', avance: 'Avance sur salaire', remboursement: 'Remboursement d\'avance', prime: 'Prime', avenant: 'Avenant', autre: 'Autre' };

function rhD(day) { const p = String(day).slice(0, 10).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); }
function rhDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function rhAddDays(day, n) { return rhDay(rhD(day) + n * RH_DAY_MS); }
function rhMonday(day) { const wd = new Date(rhD(day)).getUTCDay(); return rhAddDays(day, -((wd + 6) % 7)); }
/** Ajoute m mois (fraction = jours sur 30 : 1,5 mois = 1 mois et 15 jours) ; 31/08 + 1 mois = 30/09 */
function rhAddMonths(day, m) {
  const p = String(day).slice(0, 10).split('-').map(Number), whole = Math.floor(m), extra = Math.round((m - whole) * 30);
  const y = p[0] + Math.floor((p[1] - 1 + whole) / 12), mo = (p[1] - 1 + whole) % 12, last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return rhAddDays(rhDay(Date.UTC(y, mo, Math.min(p[2], last))), extra);
}
/** Mois entiers de service entre deux jours (31/08 -> 30/09 = 1 mois) */
function rhMonths(from, to) {
  if (!from || !to || to < from) return 0;
  let n = 0; while (rhAddMonths(from, n + 1) <= rhAddDays(to, 1)) n++;
  return n;
}
function rhMonthRange(month) { const from = month + '-01'; return { from, to: rhAddDays(rhAddMonths(from, 1), -1) }; }
/** Jours entre deux dates incluses, dimanches exclus (jours ouvrables proposés pour un congé) */
function rhWorkingDays(from, to) {
  if (!from || !to || to < from) return 0;
  let n = 0; for (let d = from; d <= to; d = rhAddDays(d, 1)) if (new Date(rhD(d)).getUTCDay() !== 0) n++;
  return n;
}

/**
 * Période d'essai (contrat : durée renouvelable une seule fois par tacite reconduction).
 * Fin = dernier jour inclus. Sans décision à la fin de la première période : renouvelée tacitement ; à la fin de la seconde : confirmée.
 * { state, end1, end2, end, daysLeft, alert }
 */
function rhTrial(e, today, alertDays) {
  if (!e || !e.hired_on || !(+e.trial_months > 0)) return { state: '—', alert: false };
  const m = +e.trial_months, end1 = rhAddDays(rhAddMonths(e.hired_on, m), -1);
  const end2 = e.trial_renewable !== false ? rhAddDays(rhAddMonths(rhAddDays(end1, 1), m), -1) : null;
  let state, end;
  if (e.trial_decision === 'rompue') { state = 'rompue'; end = e.trial_decided_on || end1; }
  else if (e.trial_decision === 'confirmée') { state = 'confirmée'; end = e.trial_decided_on || end1; }
  else if (e.trial_decision === 'renouvelée' || (end2 && today > end1)) {
    end = end2 || end1;
    state = today > end ? 'confirmée (tacite)' : e.trial_decision === 'renouvelée' ? 'renouvelée' : 'renouvelée (tacite)';
  } else { end = end1; state = today > end1 ? 'confirmée (tacite)' : 'en cours'; }
  const daysLeft = Math.round((rhD(end) - rhD(today)) / RH_DAY_MS), open = /^(en cours|renouvelée)/.test(state);
  return { state, end1, end2, end, daysLeft, open, alert: open && daysLeft >= 0 && daysLeft <= (alertDays == null ? 7 : +alertDays) };
}

/**
 * Congés payés : 1,5 jour par mois de service (article 231), droit ouvert après 6 mois ; majoration d'ancienneté :
 * +1,5 jour par an par période entière de 5 ans de service, 30 jours par an au plus. Acquis, pris (validés), solde.
 */
function rhLeave(e, events, today) {
  if (!e || !e.hired_on) return null;
  const end = e.left_on && e.left_on < today ? e.left_on : today, months = rhMonths(e.hired_on, end);
  const per = e.leave_per_month == null ? 1.5 : +e.leave_per_month;
  let acc = 0; for (let i = 0; i < months; i++) acc += Math.min(30 / 12, per + 1.5 * Math.floor(Math.floor(i / 12) / 5) / 12);
  const acquired = Math.round(acc * 100) / 100;
  const taken = (events || []).filter(x => x.kind === 'conge' && !x.cancelled_at && x.status === 'Validé').reduce((s, x) => s + (+x.days || 0), 0);
  return { months, acquired, taken, balance: Math.round((acquired - taken) * 100) / 100, open: months >= 6 };
}
/** Prime d'ancienneté (article 350) : 5 % après 2 ans, 10 % après 5, 15 % après 12, 20 % après 20, 25 % après 25 ; taux actuel et prochain palier */
const RH_SENIORITY = [[2, 5], [5, 10], [12, 15], [20, 20], [25, 25]];
function rhSeniority(hired, day) {
  if (!hired || !day || day < hired) return null;
  const years = Math.floor(rhMonths(hired, day) / 12), cur = RH_SENIORITY.filter(x => x[0] <= years).pop(), nx = RH_SENIORITY.find(x => x[0] > years);
  return { years, pct: cur ? cur[1] : 0, next: nx ? { pct: nx[1], on: rhAddMonths(hired, nx[0] * 12) } : null };
}
/** Salaire à une date : dernier avenant en vigueur, sinon salaire d'embauche */
function rhSalaryAt(e, events, day) {
  const a = (events || []).filter(x => x.kind === 'avenant' && !x.cancelled_at && x.new_salary != null && x.day_from <= day).sort((x, y) => x.day_from < y.day_from ? -1 : 1).pop();
  return a ? +a.new_salary : e && e.salary != null ? +e.salary : null;
}

/** Heures de nuit (21:00 -> 06:00, heure locale) dans [a, b) ; off(t) = décalage local en minutes */
function rhNight(a, b, off) {
  if (!(b > a)) return 0;
  const o = (off ? off(a) : 0) * 60000, la = a + o, lb = b + o;
  let ms = 0;
  for (let d = Math.floor(la / RH_DAY_MS) * RH_DAY_MS - RH_DAY_MS; d < lb; d += RH_DAY_MS) {
    [[d, d + 6 * RH_H], [d + 21 * RH_H, d + 24 * RH_H]].forEach(([x, y]) => { ms += Math.max(0, Math.min(lb, y) - Math.max(la, x)); });
  }
  return ms / RH_H;
}

/**
 * Chauffeurs : présence et heures d'après les contrats (un contrat = un shift).
 * items : [{ code, num, start, end (null = fin inconnue), day (jour du shift), shift }] sur des semaines entières (lundi -> dimanche).
 * Heures supplémentaires : au-delà de weekH par semaine (lundi -> dimanche, jour du shift), les dernières heures de la semaine ;
 * partagées jour (06:00 -> 21:00) / nuit (21:00 -> 06:00). Contrat de plus de maxH heures ou sans fin : jour compté, heures non comptées.
 * Renvoie { code: { items (avec h, night, over, overNight, flag) } }
 */
function rhDriverWork(items, opt) {
  opt = opt || {};
  const maxH = opt.maxH || 16, weekH = (code => (opt.weekH && opt.weekH[code]) || opt.weekHours || 44), out = {};
  (items || []).slice().sort((a, b) => a.start - b.start).forEach(x => {
    const r = Object.assign({}, x, { h: null, night: 0, over: 0, overNight: 0, flag: '' });
    if (x.end == null) r.flag = 'fin du contrat inconnue';
    else if (!(x.end > x.start)) r.flag = 'durée nulle';
    else if ((x.end - x.start) / RH_H > maxH) r.flag = 'durée de ' + Math.round((x.end - x.start) / RH_H) + ' h (au-delà de ' + maxH + ' h)';
    else { r.h = (x.end - x.start) / RH_H; r.night = rhNight(x.start, x.end, opt.off); }
    (out[x.code] = out[x.code] || { items: [] }).items.push(r);
  });
  Object.keys(out).forEach(code => {
    const wk = {};
    out[code].items.forEach(r => { if (r.h != null) (wk[rhMonday(r.day)] = wk[rhMonday(r.day)] || []).push(r); });
    Object.values(wk).forEach(list => {
      let cum = 0; const lim = weekH(code);
      list.forEach(r => {
        if (cum + r.h > lim) {
          const from = cum >= lim ? r.start : r.start + (lim - cum) * RH_H;
          r.over = (r.end - from) / RH_H; r.overNight = rhNight(from, r.end, opt.off);
        }
        cum += r.h;
      });
    });
  });
  return out;
}
/** Totaux d'un chauffeur sur [from, to] (jours de shift) */
function rhDriverSum(w, from, to) {
  const its = ((w && w.items) || []).filter(r => r.day >= from && r.day <= to), r2 = x => Math.round(x * 100) / 100;
  const days = [...new Set(its.map(r => r.day))].sort();
  return { items: its, days, nDays: days.length, hours: r2(its.reduce((s, r) => s + (r.h || 0), 0)), night: r2(its.reduce((s, r) => s + r.night, 0)),
    over: r2(its.reduce((s, r) => s + r.over, 0)), overNight: r2(its.reduce((s, r) => s + r.overNight, 0)),
    overDay: r2(its.reduce((s, r) => s + r.over - r.overNight, 0)), flagged: its.filter(r => r.flag) };
}
/** Montant des heures supplémentaires (article 201 : +25 % de 6 h à 21 h, +50 % de 21 h à 6 h) ; taux horaire = salaire / (heures hebdo × 52 / 12) */
function rhOvertimePay(salary, weekH, overDay, overNight) {
  if (!(+salary > 0)) return null;
  const rate = +salary / ((+weekH || 44) * 52 / 12);
  return { rate: Math.round(rate * 100) / 100, amount: Math.round(rate * (1.25 * (overDay || 0) + 1.5 * (overNight || 0)) * 100) / 100 };
}
/** Jours planifiés (planning des chauffeurs) sans contrat ni absence déclarée : absences non justifiées */
function rhPlanGaps(plan, workDays, declared) {
  const w = new Set(workDays || []), d = new Set(declared || []);
  return [...new Set((plan || []).map(p => p.day))].filter(day => !w.has(day) && !d.has(day)).sort();
}
/** Jours ouvrables seulement (dimanches retirés), comme le dénominateur de l'absentéisme et le décompte des congés */
function rhWorkOnly(days) { return (days || []).filter(d => new Date(rhD(d)).getUTCDay() !== 0); }
/** Jours couverts par des événements (congé validé, arrêt, absence) entre deux dates */
function rhEventDays(events, kinds, from, to) {
  const out = new Set();
  (events || []).filter(x => !x.cancelled_at && kinds.includes(x.kind) && (x.kind !== 'conge' || x.status === 'Validé')).forEach(x => {
    for (let d = x.day_from > from ? x.day_from : from, e = (x.day_to || x.day_from) < to ? (x.day_to || x.day_from) : to; d <= e; d = rhAddDays(d, 1)) out.add(d);
  });
  return [...out].sort();
}

/**
 * Staff : journées d'après le pointage. clock : [{ kind, at (ms) }] ; sessions : [{ started_at, last_seen } en ms] (connexions à Ludy).
 * Départ non pointé : dernière activité sur Ludy de la journée (sinon dernier pointage), signalé. Pause non reprise : close au départ.
 * opt.dayOf(ms) -> jour local ; opt.now. Renvoie [{ day, in, out, outAuto, ongoing, pauses: [{ from, to }], pauseMin, workMin, fails, conn: { first, last, min } }]
 */
function rhStaffDays(clock, sessions, opt) {
  opt = opt || {};
  const dayOf = opt.dayOf || rhDay, now = opt.now || Date.now(), ev = (clock || []).slice().sort((a, b) => a.at - b.at), per = [];
  const ses = (sessions || []).map(s => ({ a: +s.started_at, b: +s.last_seen })).filter(s => s.b >= s.a);
  let cur = null; const fails = {};
  const lastSeen = (from, lim) => ses.filter(s => s.b > from && s.a < lim).reduce((m, s) => Math.max(m, Math.min(s.b, lim)), 0);
  const close = (t, auto) => {
    if (!cur) return;
    const p = cur.pauses[cur.pauses.length - 1];
    if (auto) {
      const lim = Math.min(cur.in + 18 * RH_H, t), seen = lastSeen(cur.in, lim);
      t = Math.min(Math.max(cur.last, seen || 0), lim); cur.outAuto = true;
    }
    if (p && p.to == null) p.to = t;
    cur.out = t; per.push(cur); cur = null;
  };
  ev.forEach(x => {
    if (x.kind === 'fail') { const d = dayOf(x.at); fails[d] = (fails[d] || 0) + 1; return; }
    // journée ouverte depuis plus de 18 h (départ oublié) : close à la dernière activité, l'événement suivant n'y est pas rattaché
    if (cur && x.kind !== 'in' && x.at - cur.in >= 18 * RH_H) close(x.at, true);
    if (x.kind === 'session') { if (cur) cur.last = x.at; return; }
    if (x.kind === 'in') { if (cur) close(x.at, true); cur = { in: x.at, last: x.at, day: dayOf(x.at), pauses: [] }; return; }
    if (!cur) return;
    cur.last = x.at;
    if (x.kind === 'pause') { const p = cur.pauses[cur.pauses.length - 1]; if (!p || p.to != null) cur.pauses.push({ from: x.at, to: null }); }
    else if (x.kind === 'resume') { const p = cur.pauses[cur.pauses.length - 1]; if (p && p.to == null) p.to = x.at; }
    else if (x.kind === 'out') close(x.at, false);
  });
  if (cur) { if (now - cur.in < 18 * RH_H) { const p = cur.pauses[cur.pauses.length - 1]; cur.ongoing = true; cur.out = now; if (p && p.to == null) p.toOpen = now; per.push(cur); cur = null; } else close(now, true); }
  const days = {};
  per.forEach(p => {
    const d = days[p.day] = days[p.day] || { day: p.day, in: p.in, out: p.out, outAuto: false, ongoing: false, pauses: [], pauseMin: 0, workMin: 0, periods: 0, fails: 0 };
    d.in = Math.min(d.in, p.in); d.out = Math.max(d.out, p.out); d.outAuto = d.outAuto || !!p.outAuto; d.ongoing = d.ongoing || !!p.ongoing; d.periods++;
    const pm = p.pauses.reduce((s, x) => s + ((x.to != null ? x.to : x.toOpen) - x.from), 0);
    d.pauses.push(...p.pauses.map(x => ({ from: x.from, to: x.to }))); d.pauseMin += pm / 60000; d.workMin += Math.max(0, p.out - p.in - pm) / 60000;
  });
  Object.keys(fails).forEach(k => { (days[k] = days[k] || { day: k, pauses: [], pauseMin: 0, workMin: 0, periods: 0 }).fails = fails[k]; });
  // connexions à Ludy du jour (réunies quand elles se chevauchent)
  const byDay = {};
  ses.forEach(s => { (byDay[dayOf(s.a)] = byDay[dayOf(s.a)] || []).push(s); });
  Object.keys(byDay).forEach(k => {
    const l = byDay[k].sort((x, y) => x.a - y.a); let ms = 0, a = null, b = null;
    l.forEach(s => { if (a == null || s.a > b) { if (a != null) ms += b - a; a = s.a; b = s.b; } else b = Math.max(b, s.b); });
    if (a != null) ms += b - a;
    const d = days[k] = days[k] || { day: k, pauses: [], pauseMin: 0, workMin: 0, periods: 0, fails: 0 };
    d.conn = { first: l[0].a, last: Math.max(...l.map(s => s.b)), min: ms / 60000 };
  });
  return Object.values(days).map(d => Object.assign(d, { pauseMin: Math.round(d.pauseMin), workMin: Math.round(d.workMin), nPauses: d.pauses.length })).sort((x, y) => x.day < y.day ? -1 : 1);
}
/** Heures supplémentaires du staff par semaine (lundi -> dimanche) : au-delà de weekH */
function rhStaffOver(days, weekH) {
  const wk = {};
  (days || []).forEach(d => { const m = rhMonday(d.day); wk[m] = (wk[m] || 0) + (d.workMin || 0); });
  const out = {}; Object.keys(wk).forEach(m => { out[m] = Math.max(0, Math.round((wk[m] / 60 - (+weekH || 44)) * 100) / 100); });
  return out;
}
/** Heures sup. du staff rattachées aux jours : dépassement de la semaine (lundi → dimanche) porté par ses derniers jours travaillés */
function rhStaffOverDays(days, weekH) {
  const ov = rhStaffOver(days, weekH), out = {};
  Object.keys(ov).forEach(m => {
    let left = ov[m];
    (days || []).filter(d => rhMonday(d.day) === m && d.workMin > 0).sort((a, b) => a.day < b.day ? 1 : -1).forEach(d => {
      if (left <= 0) return; const h = Math.min(left, d.workMin / 60); out[d.day] = Math.round(h * 100) / 100; left -= h;
    });
  });
  return out;
}
/** État du pointage (même règle que la base) : dernier événement des 18 dernières heures */
function rhClockState(clock, now) {
  const l = (clock || []).filter(x => ['in', 'pause', 'resume', 'out'].includes(x.kind) && x.at > (now || Date.now()) - 18 * RH_H).sort((a, b) => a.at - b.at).pop();
  return !l || l.kind === 'out' ? 'off' : l.kind === 'pause' ? 'pause' : 'on';
}
function rhMin(m) { if (m == null || isNaN(m)) return ''; m = Math.round(m); return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); }

// ---------- Présences et état mensuel : calcul partagé site / collecteur (copie dans le Drive) ----------
/** Fin effective des contrats d'un véhicule (lib.js ctrEffEnds) : contrat jamais clôturé = jusqu'au début du suivant */
function rhEffEnds(list, now) {
  const l = list.slice().sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at)), lim = (now || Date.now()) + RH_H;
  l.forEach((c, i) => { const nx = l[i + 1], ns = nx ? Date.parse(nx.start_at) : Infinity;
    c._next = !c.end_at && ns < lim ? nx.num : ''; c._end = c.end_at ? Date.parse(c.end_at) : c._next ? ns : null; });
  return l;
}
/** Shift d'un contrat (lib.js shiftOfCtr) : heure de début avancée de shiftAdvance h ; une nuit appartient au jour où elle commence. off(ms) = décalage local en minutes */
function rhShiftOfCtr(start, P, off) {
  if (!start) return null;
  P = P || {}; const n = (k, d) => (P[k] == null || P[k] === '' || isNaN(+P[k]) ? d : +P[k]);
  const adv = n('shiftAdvance', 2), dH = n('shiftDay', 7), nH = n('shiftNight', 19), ms = Date.parse(start), loc = t => new Date(t + (off ? off(t) : 0) * 60000);
  const a = loc(ms), h = ((a.getUTCHours() + a.getUTCMinutes() / 60 + adv) % 24 + 24) % 24, s = (dH < nH ? h >= dH && h < nH : h >= dH || h < nH) ? 'Jour' : 'Nuit';
  const b = loc(ms + adv * RH_H), day = b.toISOString().slice(0, 10);
  return { s, day: s === 'Nuit' && b.getUTCHours() < dH ? rhAddDays(day, -1) : day };
}
/**
 * Présence de salariés sur [from, to] (jours) d'après des lignes déjà lues. o = { emps, from, to, today, now, P, contracts (semaines entières),
 * plan, pabs (absences du planning), events (RH), clock, sessions, shiftOfCtr(start), dayOf(ms), off(ms), staff (false = pas de pointage lu) }.
 * Chauffeurs : contrats (un contrat = un shift), heures sup. par semaine ; staff : pointage, heures sup. par semaine portées par ses derniers jours.
 */
function rhPresenceCalc(o) {
  const P = o.P || {}, from = o.from, to = o.to, n = (k, d) => (P[k] == null || P[k] === '' || isNaN(+P[k]) ? d : +P[k]);
  const emps = o.emps || [], drv = emps.filter(e => e.kind === 'chauffeur' && e.driver_code), staff = o.staff === false ? [] : emps.filter(e => e.kind === 'staff');
  const out = new Map(emps.map(e => [e.id, { e, nDays: 0, days: [], hours: 0, night: 0, over: 0, overDay: 0, overNight: 0, gaps: [], flagged: [], items: [], staffDays: [], declared: [] }]));
  const evDays = e => rhEventDays((o.events || []).filter(x => x.employee_id === e.id), ['conge', 'maladie', 'absence'], from, to);
  if (drv.length) {
    const wFrom = rhMonday(from), wTo = rhAddDays(rhMonday(to), 6), byV = {}, codes = new Set(drv.map(e => e.driver_code)), items = [];
    (o.contracts || []).forEach(c => { (byV[c.vehicle_key] = byV[c.vehicle_key] || []).push(Object.assign({}, c)); });
    Object.values(byV).forEach(l => rhEffEnds(l, o.now).forEach(c => {
      if (!codes.has(c.client_code) || !c.start_at) return;
      const sh = o.shiftOfCtr(c.start_at); if (!sh || sh.day < wFrom || sh.day > wTo) return;
      items.push({ code: c.client_code, num: c.num, vehicle: c.vehicle_key, start: Date.parse(c.start_at), end: c._end || null, day: sh.day, shift: sh.s });
    }));
    const wh = {}; drv.forEach(e => { wh[e.driver_code] = +e.weekly_hours || 44; });
    const work = rhDriverWork(items, { maxH: n('rhMaxShiftH', 16), weekH: wh, off: o.off });
    drv.forEach(e => {
      const r = out.get(e.id), sm = rhDriverSum(work[e.driver_code], from, to), decl = new Set(evDays(e));
      (o.pabs || []).filter(a => a.driver_code === e.driver_code).forEach(a => { for (let d = a.day_from > from ? a.day_from : from; d <= (a.day_to < to ? a.day_to : to); d = rhAddDays(d, 1)) decl.add(d); });
      const lim = e.left_on && e.left_on < to ? e.left_on : to, start = e.hired_on && e.hired_on > from ? e.hired_on : from;
      Object.assign(r, sm, { gaps: rhPlanGaps((o.plan || []).filter(p => p.driver_code === e.driver_code && p.day >= start && p.day <= lim && p.day < o.today), sm.days, [...decl]), declared: [...decl].sort() });
    });
  }
  staff.forEach(e => {
    const r = out.get(e.id), all7 = rhStaffDays((o.clock || []).filter(c => c.employee_id === e.id).map(c => ({ kind: c.kind, at: Date.parse(c.at) })),
      (o.sessions || []).filter(x => x.user_id === e.user_id).map(x => ({ started_at: Date.parse(x.started_at), last_seen: Date.parse(x.last_seen) })), { dayOf: o.dayOf, now: o.now });
    const ovd = rhStaffOverDays(all7, e.weekly_hours), days = all7.filter(d => d.day >= from && d.day <= to), wk = days.filter(d => d.workMin > 0);
    Object.assign(r, { staffDays: days, nDays: wk.length, days: wk.map(d => d.day), hours: Math.round(wk.reduce((s, d) => s + d.workMin, 0) / 6) / 10,
      over: Math.round(Object.keys(ovd).filter(d => d >= from && d <= to).reduce((s, d) => s + ovd[d], 0) * 100) / 100, declared: evDays(e) });
    r.overDay = r.over; r.flagged = days.filter(d => d.outAuto || d.fails).map(d => ({ day: d.day, flag: [d.outAuto && 'départ non pointé', d.fails && d.fails + ' date(s) de naissance erronée(s)'].filter(Boolean).join(', ') }));
  });
  return [...out.values()];
}
/** État mensuel (éléments variables de paie) : une ligne par salarié ; cash = mouvements de caisse avance / remboursement / bonus du mois */
function rhMonthlyRows(pres, events, cash, R) {
  return (pres || []).map(r => {
    const e = r.e, ev = (events || []).filter(x => x.employee_id === e.id && !x.cancelled_at), sal = rhSalaryAt(e, ev, R.to);
    const sum = k => ev.filter(x => x.kind === k && x.day_from >= R.from && x.day_from <= R.to).reduce((s, x) => s + (+x.amount || 0), 0);
    const cs = k => (cash || []).filter(c => e.driver_code && c.driver_code === e.driver_code && c.kind === k).reduce((s, c) => s + (+c.amount || 0), 0);
    // jours ouvrables (dimanches non comptés), comme le décompte des congés
    const days = k => rhWorkOnly(rhEventDays(ev, [k], R.from, R.to)).length, pay = rhOvertimePay(sal, e.weekly_hours, r.overDay, r.overNight || 0);
    return { e, sal, r, conge: days('conge'), maladie: days('maladie'), absJ: rhWorkOnly(rhEventDays(ev.filter(x => x.kind === 'absence' && x.justified), ['absence'], R.from, R.to)).length,
      absNJ: rhWorkOnly(rhEventDays(ev.filter(x => x.kind === 'absence' && !x.justified), ['absence'], R.from, R.to)).length + (r.gaps || []).length,
      avance: sum('avance') + cs('avance'), remb: sum('remboursement') + cs('remboursement'), prime: sum('prime') + cs('bonus'), pay };
  });
}

// ---------- Alertes (rester en règle) et compte rendu ----------
const RH_DOCS = { contrat: 'Contrat signé', avenant: 'Avenant signé', cin: 'CIN', permis: 'Permis de conduire', carte_pro: 'Carte professionnelle', casier: 'Casier judiciaire (fiche anthropométrique)',
  cnss: 'Attestation CNSS', rib: 'RIB', diplome: 'Diplôme', medical: 'Certificat médical', photo: 'Photo', attestation: 'Attestation', autre: 'Autre' };
const RH_LEVELS = ['Critique', 'Haute', 'Moyenne'];
/** Pièces obligatoires du dossier (réglages rhDocsChauffeur / rhDocsStaff) */
function rhDocsRequired(kind, P) {
  const k = kind === 'staff' ? 'rhDocsStaff' : 'rhDocsChauffeur', v = P && P[k] != null ? P[k] : kind === 'staff' ? 'cin,rib' : 'cin,permis,casier,rib';
  return String(v).split(/[,;\s]+/).map(x => x.trim()).filter(x => RH_DOCS[x]);
}
const rhDaysBetween = (a, b) => Math.round((rhD(b) - rhD(a)) / RH_DAY_MS);
/** Contrat de travail suivi d'un salarié : le plus récent non clos (date d'effet, sinon création) */
function rhContractOf(e, contracts) {
  return (contracts || []).filter(c => c.employee_id === e.id && !c.ended_on).sort((a, b) => ((a.effective_on || '') + a.created_at) < ((b.effective_on || '') + b.created_at) ? 1 : -1)[0] || null;
}
/** État du contrat : à signer / signé, à légaliser / légalisé */
function rhLegal(c) {
  if (!c) return { step: 'aucun', txt: 'Aucun contrat' };
  if (c.legalized_on) return { step: 'legalise', txt: 'Légalisé' + (c.legal_path ? '' : ' (copie à ranger)') };
  if (c.signed_on) return { step: 'signe', txt: 'Signé, à légaliser' };
  return { step: 'genere', txt: 'À faire signer' };
}
/**
 * Pointage du staff : arrivée non pointée. e.work_start (« 08:30 ») et e.work_days (jours ISO, « 1,2,3,4,5,6 » = lundi → samedi) ;
 * alerte rhClockLateMin minutes (30) après l'heure prévue, sauf jour non travaillé, jour férié (rhHolidays : « 2026-11-06,… »),
 * congé validé, arrêt maladie ou absence déclarés, salarié pas encore entré ou sorti. clock : pointages du jour [{ kind }].
 * Renvoie null (rien à signaler) ou { due: heure limite « HH:MM » }.
 */
function rhClockMissing(e, clock, events, day, nowHM, P) {
  P = P || {};
  if (!e || e.kind !== 'staff' || !e.pointage || !e.work_start || (e.hired_on && e.hired_on > day) || (e.left_on && e.left_on <= day)) return null;
  const wd = new Date(rhD(day)).getUTCDay() || 7, days = String(e.work_days == null ? '1,2,3,4,5,6' : e.work_days).split(',').map(Number);
  if (days.indexOf(wd) < 0 || String(P.rhHolidays || '').split(/[,;\s]+/).indexOf(day) >= 0) return null;
  if (rhEventDays((events || []).filter(x => x.employee_id == null || x.employee_id === e.id), ['conge', 'maladie', 'absence'], day, day).length) return null;
  const late = P.rhClockLateMin == null || P.rhClockLateMin === '' || isNaN(+P.rhClockLateMin) ? 30 : +P.rhClockLateMin;
  const m = String(e.work_start).slice(0, 5).split(':').map(Number), lim = m[0] * 60 + m[1] + late, due = String(Math.floor(lim / 60) % 24).padStart(2, '0') + ':' + String(lim % 60).padStart(2, '0');
  if (nowHM < due || (clock || []).some(c => c.kind === 'in')) return null;
  return { due };
}

/**
 * Alertes RH d'après les règles du Code du travail et le dossier du salarié. ctx : { emps, events, contracts, docs, today, P }.
 * Renvoie [{ level: Critique | Haute | Moyenne, type, emp, text, due }] triées par gravité puis échéance.
 */
function rhAlerts(ctx) {
  const P = ctx.P || {}, d0 = ctx.today, out = [], n = (k, d) => (P[k] == null || P[k] === '' || isNaN(+P[k]) ? d : +P[k]);
  const add = (level, type, emp, text, due) => out.push({ level, type, emp, text, due: due || '' });
  const req = k => rhDocsRequired(k, P);
  (ctx.emps || []).filter(e => !e.left_on || e.left_on >= d0).forEach(e => {
    const ev = (ctx.events || []).filter(x => x.employee_id === e.id && !x.cancelled_at), docs = (ctx.docs || []).filter(x => x.employee_id === e.id);
    // période d'essai
    const t = rhTrial(e, d0, n('rhAlertDays', 7));
    if (t.alert) add(t.daysLeft <= 2 ? 'Critique' : 'Haute', 'Période d\'essai', e, 'Fin de la période d\'essai ' + (t.state === 'en cours' ? '' : '(' + t.state + ') ') + 'le ' + rhFr(t.end) + (t.daysLeft ? ' (dans ' + t.daysLeft + ' j)' : ' (aujourd\'hui)') + ' : confirmer, renouveler ou rompre', t.end);
    // contrat de travail : signature, légalisation (suivi, CNSS et dossier : migration 20261111, ctx.v2)
    const v2 = ctx.v2 !== false, c = rhContractOf(e, ctx.contracts), lg = rhLegal(c);
    if (!v2) { /* pas encore suivis */ }
    else if (!c) add('Haute', 'Contrat de travail', e, 'Aucun contrat de travail enregistré (générer le contrat ou enregistrer le contrat signé)');
    else if (lg.step === 'genere') { const age = rhDaysBetween(String(c.created_at).slice(0, 10), d0); if (age > n('rhSignDays', 7)) add('Moyenne', 'Contrat de travail', e, 'Contrat généré le ' + rhFr(String(c.created_at).slice(0, 10)) + ', pas encore signé'); }
    else if (lg.step === 'signe') { const age = rhDaysBetween(c.signed_on, d0); add(age > n('rhLegalDays', 7) ? 'Haute' : 'Moyenne', 'Légalisation', e, 'Contrat signé le ' + rhFr(c.signed_on) + ', pas encore légalisé' + (age > 0 ? ' (' + age + ' j)' : ''), c.signed_on); }
    else if (!c.legal_path) add('Moyenne', 'Légalisation', e, 'Contrat légalisé le ' + rhFr(c.legalized_on) + ' : copie légalisée à ranger dans le dossier');
    // contrat à durée déterminée
    if (e.contract_type && e.contract_type !== 'CDI') {
      if (!e.contract_end) add('Moyenne', 'Fin de contrat', e, e.contract_type + ' sans date de fin renseignée');
      else { const dl = rhDaysBetween(d0, e.contract_end);
        if (dl < 0) add('Critique', 'Fin de contrat', e, e.contract_type + ' terminé le ' + rhFr(e.contract_end) + ' : salarié toujours en poste, à régulariser (renouvellement, nouveau contrat ou sortie)', e.contract_end);
        else if (dl <= n('rhContractEndDays', 30)) add('Haute', 'Fin de contrat', e, e.contract_type + ' se termine le ' + rhFr(e.contract_end) + ' (dans ' + dl + ' j) : renouveler ou préparer la sortie', e.contract_end); }
    }
    // CNSS
    if (v2 && !e.cnss_no) add('Haute', 'CNSS', e, 'N° CNSS non renseigné : immatriculation du salarié à la CNSS à vérifier');
    // pièces du dossier : manquantes, expirées, qui expirent
    const miss = v2 ? req(e.kind).filter(k => !docs.some(x => x.category === k)) : [];
    if (miss.length) add('Moyenne', 'Dossier', e, 'Pièces manquantes : ' + miss.map(k => RH_DOCS[k]).join(', '));
    Object.keys(RH_DOCS).forEach(k => {
      const ex = docs.filter(x => x.category === k && x.expires_on).map(x => x.expires_on).sort().pop(); if (!ex) return;
      const dl = rhDaysBetween(d0, ex), vital = ['permis', 'carte_pro', 'cin'].includes(k);
      if (dl < 0) add(vital ? 'Critique' : 'Haute', 'Dossier', e, RH_DOCS[k] + ' expiré depuis le ' + rhFr(ex), ex);
      else if (dl <= n('rhDocDays', 30)) add(vital ? 'Haute' : 'Moyenne', 'Dossier', e, RH_DOCS[k] + ' expire le ' + rhFr(ex) + ' (dans ' + dl + ' j)', ex);
    });
    // arrêt maladie sans certificat rangé (article 271 : au-delà de 4 jours, certificat médical à fournir s'il est demandé)
    ev.filter(x => x.kind === 'maladie' && !x.doc_path && rhDaysBetween(x.day_from, d0) <= 60 && x.day_from <= d0).forEach(x => {
      const nd = x.days != null ? +x.days : rhDaysBetween(x.day_from, x.day_to || x.day_from) + 1;
      add(nd > 4 ? 'Haute' : 'Moyenne', 'Arrêt maladie', e, 'Arrêt maladie du ' + rhFr(x.day_from) + ' (' + nd + ' j) sans certificat médical rangé', x.day_from);
    });
    // absences non justifiées sur 12 mois (au-delà de 4 jours : faute grave possible, article 39)
    const y0 = rhAddDays(d0, -365), nj = ev.filter(x => x.kind === 'absence' && !x.justified && x.day_from > y0 && x.day_from <= d0)
      .reduce((s, x) => s + (x.days != null ? +x.days : rhDaysBetween(x.day_from, x.day_to || x.day_from) + 1), 0);
    if (nj > 4) add('Haute', 'Absences', e, nj + ' jours d\'absence non justifiée sur 12 mois (plus de 4 jours : faute grave possible, article 39)');
    else if (nj >= 3) add('Moyenne', 'Absences', e, nj + ' jours d\'absence non justifiée sur 12 mois (faute grave possible au-delà de 4 jours, article 39)');
    // congés demandés à valider
    ev.filter(x => x.kind === 'conge' && x.status === 'Demandé').forEach(x => add('Moyenne', 'Congés', e, 'Congé demandé du ' + rhFr(x.day_from) + ' au ' + rhFr(x.day_to || x.day_from) + ' : à valider ou refuser', x.day_from));
    // prime d'ancienneté : nouveau palier dans les 30 jours
    const sn = rhSeniority(e.hired_on, d0);
    if (sn && sn.next && rhDaysBetween(d0, sn.next.on) <= 30) add('Moyenne', 'Ancienneté', e, 'Prime d\'ancienneté de ' + sn.next.pct + ' % à partir du ' + rhFr(sn.next.on) + ' (article 350)', sn.next.on);
    // pointage du staff : arrivée non pointée aujourd'hui, départ non pointé hier (ctx.clock : { id: [{ kind, day }] }, ctx.nowHM)
    if (ctx.clock && e.kind === 'staff' && e.pointage) {
      const ck = ctx.clock[e.id] || [], miss = rhClockMissing(e, ck.filter(c => c.day === d0), ev, d0, ctx.nowHM || '00:00', P);
      if (miss) add('Haute', 'Pointage', e, 'Arrivée non pointée aujourd\'hui (prévue à ' + String(e.work_start).slice(0, 5) + ', alerte à ' + miss.due + ')', d0);
      const y = rhAddDays(d0, -1), yk = ck.filter(c => c.day === y).map(c => c.kind);
      if (yk.indexOf('in') >= 0 && yk.lastIndexOf('out') < Math.max(yk.lastIndexOf('in'), yk.lastIndexOf('resume'), yk.lastIndexOf('pause')))
        add('Moyenne', 'Pointage', e, 'Départ non pointé hier (' + rhFr(y) + ') : fin de journée prise à la dernière activité sur Ludy, à vérifier', y);
    }
    // fiche
    if (e.pointage && !e.birth_date) add('Haute', 'Fiche', e, 'Date de naissance absente : pointage impossible');
    const inc = [!e.hired_on && 'date d\'entrée', e.salary == null && 'salaire', !e.employer_id && 'société', !e.cin && 'N° CIN'].filter(Boolean);
    if (inc.length) add('Moyenne', 'Fiche', e, 'Fiche incomplète : ' + inc.join(', '));
  });
  return out.sort((a, b) => RH_LEVELS.indexOf(a.level) - RH_LEVELS.indexOf(b.level) || (a.due || '9') .localeCompare(b.due || '9') || a.emp.name.localeCompare(b.emp.name));
}
function rhFr(day) { return day ? String(day).slice(8, 10) + '/' + String(day).slice(5, 7) + '/' + String(day).slice(0, 4) : ''; }
/** Salaire de base d'une période : salaire de chaque mois au prorata des jours (calendaires) en poste dans la période */
function rhBasePay(e, events, from, to) {
  let tot = 0, any = false;
  for (let m = from.slice(0, 7) + '-01'; m <= to; m = rhAddMonths(m, 1)) {
    const R = rhMonthRange(m.slice(0, 7)), a = [R.from, from, e.hired_on || R.from].sort().pop(), b = [R.to, to, e.left_on || R.to].sort()[0];
    if (b < a) continue;
    // avenant en cours de mois : chaque salaire sur ses jours
    const cut = (events || []).filter(x => x.kind === 'avenant' && !x.cancelled_at && x.new_salary != null && x.day_from > a && x.day_from <= b).map(x => x.day_from).sort();
    [a].concat(cut).forEach((d1, i, l) => {
      const d2 = i + 1 < l.length ? rhAddDays(l[i + 1], -1) : b, sal = rhSalaryAt(e, events, d1); if (sal == null || d2 < d1) return;
      any = true; tot += sal * (rhDaysBetween(d1, d2) + 1) / (rhDaysBetween(R.from, R.to) + 1);
    });
  }
  return any ? Math.round(tot * 100) / 100 : null;
}
/**
 * Compte rendu d'une période (semaine ou mois) et comparaison à la précédente.
 * ctx : { emps, events, contracts, cur: { from, to, pres, cash }, prev: { from, to, pres, cash }, today }
 * pres : lignes de présence ({ e, nDays, hours, overDay, overNight, gaps }) ; cash : [{ driver_code, kind, amount }] (avance, remboursement, bonus)
 */
function rhReport(ctx) {
  const per = q => {
    const inP = e => (!e.hired_on || e.hired_on <= q.to) && (!e.left_on || e.left_on >= q.from);
    const act = d => (ctx.emps || []).filter(e => (!e.hired_on || e.hired_on <= d) && (!e.left_on || e.left_on > d));
    const rows = (ctx.emps || []).filter(inP).map(e => {
      const ev = (ctx.events || []).filter(x => x.employee_id === e.id && !x.cancelled_at), pr = (q.pres || []).find(r => r.e.id === e.id) || { nDays: 0, hours: 0, overDay: 0, overNight: 0, gaps: [] };
      const sum = k => ev.filter(x => x.kind === k && x.day_from >= q.from && x.day_from <= q.to).reduce((s, x) => s + (+x.amount || 0), 0);
      const cs = k => (q.cash || []).filter(c => e.driver_code && c.driver_code === e.driver_code && c.kind === k).reduce((s, c) => s + (+c.amount || 0), 0);
      const base = rhBasePay(e, ev, q.from, q.to), sal = rhSalaryAt(e, ev, q.to), hs = rhOvertimePay(sal, e.weekly_hours, pr.overDay || 0, pr.overNight || 0);
      const days = k => rhWorkOnly(rhEventDays(ev, [k], q.from, q.to)).length;
      const s0 = [q.from, e.hired_on || q.from].sort().pop(), s1 = [q.to, e.left_on || q.to].sort()[0], theo = s1 >= s0 ? rhWorkingDays(s0, s1) : 0;
      const hsAmt = hs && (pr.overDay || pr.overNight) ? hs.amount : 0, prime = sum('prime') + cs('bonus');
      return { e, base, hsAmt, prime, avance: sum('avance') + cs('avance'), remb: sum('remboursement') + cs('remboursement'), total: base == null ? null : Math.round((base + hsAmt + prime) * 100) / 100,
        nDays: pr.nDays || 0, hours: pr.hours || 0, over: (pr.overDay || 0) + (pr.overNight || 0), conge: days('conge'), maladie: days('maladie'),
        absJ: rhWorkOnly(rhEventDays(ev.filter(x => x.kind === 'absence' && x.justified), ['absence'], q.from, q.to)).length,
        absNJ: rhWorkOnly(rhEventDays(ev.filter(x => x.kind === 'absence' && !x.justified), ['absence'], q.from, q.to)).length + (pr.gaps || []).length, theo };
    });
    const tot = k => Math.round(rows.reduce((s, r) => s + (+r[k] || 0), 0) * 100) / 100;
    const start = act(rhAddDays(q.from, -1)).length, end = act(q.to).length;
    const entries = (ctx.emps || []).filter(e => e.hired_on && e.hired_on >= q.from && e.hired_on <= q.to), exits = (ctx.emps || []).filter(e => e.left_on && e.left_on >= q.from && e.left_on <= q.to);
    const absDays = tot('maladie') + tot('absJ') + tot('absNJ'), theo = tot('theo');
    return { from: q.from, to: q.to, rows, start, end, entries, exits, turnover: start + end ? Math.round(exits.length / ((start + end) / 2) * 1000) / 10 : 0,
      base: tot('base'), hsAmt: tot('hsAmt'), prime: tot('prime'), avance: tot('avance'), remb: tot('remb'), total: tot('total'), missingPay: rows.filter(r => r.base == null).map(r => r.e),
      nDays: tot('nDays'), hours: tot('hours'), over: tot('over'), conge: tot('conge'), maladie: tot('maladie'), absJ: tot('absJ'), absNJ: tot('absNJ'), theo,
      absRate: theo ? Math.round(absDays / theo * 1000) / 10 : null,
      trials: (ctx.emps || []).map(e => [e, rhTrial(e, q.to)]).filter(x => x[1].state !== '—' && x[1].end >= q.from && x[1].end <= q.to || (x[0].trial_decided_on && x[0].trial_decided_on >= q.from && x[0].trial_decided_on <= q.to)) };
  };
  const cur = per(ctx.cur), prev = ctx.prev ? per(ctx.prev) : null;
  const evo = (a, b) => b ? Math.round((a - b) / b * 1000) / 10 : null;
  const legal = { aucun: 0, genere: 0, signe: 0, legalise: 0 };
  (ctx.emps || []).filter(e => !e.left_on || e.left_on > cur.to).forEach(e => { legal[rhLegal(rhContractOf(e, ctx.contracts)).step]++; });
  return { cur, prev, legal, evoTotal: prev ? evo(cur.total, prev.total) : null, evoEnd: prev ? cur.end - prev.end : null };
}

if (typeof module === 'object' && module.exports) module.exports = { rhEffEnds, rhShiftOfCtr, rhPresenceCalc, rhMonthlyRows, rhStaffOverDays, rhWorkOnly, RH_KINDS, RH_DOCS, RH_LEVELS, rhDocsRequired, rhClockMissing, rhSeniority, rhAlerts, rhContractOf, rhLegal, rhBasePay, rhReport, rhFr, rhAddDays, rhMonday, rhAddMonths, rhMonths, rhMonthRange, rhWorkingDays, rhTrial, rhLeave, rhSalaryAt, rhNight,
  rhDriverWork, rhDriverSum, rhOvertimePay, rhPlanGaps, rhEventDays, rhStaffDays, rhStaffOver, rhClockState, rhMin };
