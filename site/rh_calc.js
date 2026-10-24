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

/** Congés payés (article 231 : 1,5 jour par mois de service, droit ouvert après 6 mois) : acquis, pris (validés), solde */
function rhLeave(e, events, today) {
  if (!e || !e.hired_on) return null;
  const end = e.left_on && e.left_on < today ? e.left_on : today, months = rhMonths(e.hired_on, end);
  const per = e.leave_per_month == null ? 1.5 : +e.leave_per_month, acquired = Math.round(months * per * 100) / 100;
  const taken = (events || []).filter(x => x.kind === 'conge' && !x.cancelled_at && x.status === 'Validé').reduce((s, x) => s + (+x.days || 0), 0);
  return { months, acquired, taken, balance: Math.round((acquired - taken) * 100) / 100, open: months >= 6 };
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
      t = Math.max(cur.last, seen || 0); cur.outAuto = true;
    }
    if (p && p.to == null) p.to = t;
    cur.out = t; per.push(cur); cur = null;
  };
  ev.forEach(x => {
    if (x.kind === 'fail') { const d = dayOf(x.at); fails[d] = (fails[d] || 0) + 1; return; }
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
/** État du pointage (même règle que la base) : dernier événement des 18 dernières heures */
function rhClockState(clock, now) {
  const l = (clock || []).filter(x => ['in', 'pause', 'resume', 'out'].includes(x.kind) && x.at > (now || Date.now()) - 18 * RH_H).sort((a, b) => a.at - b.at).pop();
  return !l || l.kind === 'out' ? 'off' : l.kind === 'pause' ? 'pause' : 'on';
}
function rhMin(m) { if (m == null || isNaN(m)) return ''; m = Math.round(m); return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); }

if (typeof module === 'object' && module.exports) module.exports = { RH_KINDS, rhAddDays, rhMonday, rhAddMonths, rhMonths, rhMonthRange, rhWorkingDays, rhTrial, rhLeave, rhSalaryAt, rhNight,
  rhDriverWork, rhDriverSum, rhOvertimePay, rhPlanGaps, rhEventDays, rhStaffDays, rhStaffOver, rhClockState, rhMin };
