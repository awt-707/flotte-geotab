// Zones de travail Uber (20/11/2026, demande d'Ahmed : « un nuage de zones de travail pour rentabiliser »). Calculs purs, testés sous Node.
// Entrée : lignes de uber_zones (base) = { kind, cy, cx, dow, hour, n, v } par case (taille c en degrés), jour (1 = lundi) et heure du Maroc.
//   pickup   : prises en charge (début de « Course en cours »), v = somme des durées de course (min)
//   dropoff  : déposes (fin de « Course en cours »)
//   wait     : attentes « Disponible » terminées par une demande, v = somme des minutes d'attente
//   idle     : « Disponible » terminé par une déconnexion, v = somme des minutes
//   approach : trajets vers le client, lieu = où la demande a été reçue, v = somme des km à vol d'oiseau
// Rien n'est estimé : moyennes = sommes mesurées / nombres mesurés ; par semaine = nombre / semaines de données de la période.

const ZN_KINDS = ['pickup', 'dropoff', 'wait', 'idle', 'approach'];
const ZN_DAYS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
/** Créneau choisi : jours (1…7) et heures (0…23, plage qui peut passer minuit) */
function znSlot(days, h1, h2) {
  const d = new Set((days && days.length ? days : [1, 2, 3, 4, 5, 6, 7]).map(Number)), hs = new Set();
  const a = ((+h1 % 24) + 24) % 24, b = ((+h2 % 24) + 24) % 24;
  for (let h = a; ; h = (h + 1) % 24) { hs.add(h); if (h === b) break; }
  return { days: d, hours: hs };
}
/** Cases du créneau : par case, nombres et moyennes de chaque mesure */
function znCells(rows, slot) {
  const m = {};
  (rows || []).forEach(r => {
    if (slot && (!slot.days.has(+r.dow) || !slot.hours.has(+r.hour))) return;
    if (!ZN_KINDS.includes(r.kind)) return;
    const k = r.cy + ':' + r.cx, c = m[k] || (m[k] = { key: k, cy: +r.cy, cx: +r.cx, pickup: 0, dropoff: 0, wait: 0, idle: 0, approach: 0, tripMin: 0, tripN: 0, waitMin: 0, idleMin: 0, appKm: 0 });
    const n = +r.n || 0, v = r.v == null ? null : +r.v;
    c[r.kind] += n;
    if (r.kind === 'pickup' && v != null) { c.tripMin += v; c.tripN += n; }
    if (r.kind === 'wait' && v != null) c.waitMin += v;
    if (r.kind === 'idle' && v != null) c.idleMin += v;
    if (r.kind === 'approach' && v != null) c.appKm += v;
  });
  return Object.values(m).map(c => Object.assign(c, {
    avgWait: c.wait ? c.waitMin / c.wait : null,            // minutes d'attente avant une demande
    avgTrip: c.tripN ? c.tripMin / c.tripN : null,          // durée moyenne d'une course partie de la case
    avgApp: c.approach ? c.appKm / c.approach : null,       // km à vide moyens pour aller chercher le client
    // part des attentes finies par une demande (le reste : déconnexion sans course)
    hitRate: c.wait + c.idle ? c.wait / (c.wait + c.idle) : null
  }));
}
/** Semaines de données de la période (au moins 1) : depuis la première position enregistrée si elle est plus récente que le début */
function znWeeks(from, to, first) {
  const a = Math.max(+new Date(from), first ? +new Date(first) : 0), b = +new Date(to);
  return Math.max(1, (b - a) / (7 * 86400000));
}
/**
 * Classement des zones pour le créneau : prises en charge par semaine (demande réelle), puis attente moyenne la plus courte.
 * minN = nombre de prises en charge en dessous duquel la zone est marquée « peu de données » et classée après les autres.
 */
function znRank(cells, weeks, minN) {
  const w = weeks > 0 ? weeks : 1, mn = minN == null ? 3 : minN;
  return cells.filter(c => c.pickup > 0).map(c => Object.assign({}, c, { perWeek: c.pickup / w, few: c.pickup < mn }))
    .sort((a, b) => (a.few - b.few) || (b.perWeek - a.perWeek) || ((a.avgWait == null ? 1e9 : a.avgWait) - (b.avgWait == null ? 1e9 : b.avgWait)));
}
/** Coins de la case (degrés) */
function znBounds(cy, cx, c) { return [[cy * c, cx * c], [(cy + 1) * c, (cx + 1) * c]]; }
function znCenter(cy, cx, c) { return [(cy + 0.5) * c, (cx + 0.5) * c]; }
/** Valeur d'une couche pour une case */
function znVal(c, layer, weeks) {
  const w = weeks > 0 ? weeks : 1;
  if (layer === 'pickup') return c.pickup ? c.pickup / w : null;
  if (layer === 'dropoff') return c.dropoff ? c.dropoff / w : null;
  if (layer === 'approach') return c.approach ? c.approach / w : null;
  if (layer === 'wait') return c.avgWait;
  return null;
}
/** Paliers de couleur (5) d'après les valeurs : quantiles ; attente = plus court = meilleur (couleur forte) */
function znSteps(vals) {
  const v = vals.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return [];
  const q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return [q(0.2), q(0.4), q(0.6), q(0.8)];
}
function znLevel(x, steps, low) {
  if (x == null) return -1;
  let i = 0; while (i < steps.length && x > steps[i]) i++;
  return low ? 4 - i : i;
}
/** Demande par jour et heure (uber_demand) → grille 7 × 24 */
function znDemandGrid(rows) {
  const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ done: 0, rc: 0, dc: 0, other: 0, km: 0 })));
  (rows || []).forEach(r => { const d = +r.dow - 1, h = +r.hour; if (d < 0 || d > 6 || h < 0 || h > 23) return; const x = g[d][h];
    x.done += +r.done || 0; x.rc += +r.rider_cancel || 0; x.dc += +r.driver_cancel || 0; x.other += +r.other || 0; x.km += +r.km || 0; });
  return g;
}
if (typeof module !== 'undefined') module.exports = { ZN_DAYS, znSlot, znCells, znWeeks, znRank, znBounds, znCenter, znVal, znSteps, znLevel, znDemandGrid };
