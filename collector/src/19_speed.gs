// ============================================================================
// DÉPASSEMENT DE VITESSE PAR LIMITE DE ROUTE (à côté du moteur v6, qui reste inchangé)
// Pour chaque trajet : le plus gros dépassement mesuré sur chaque limite de route rencontrée (mêmes relevés et mêmes règles
// que le « pire dépassement » du v6 : vitesse du capteur du véhicule, deux relevés successifs sous la même limite Geotab).
// Stocké avec le trajet (trips.over_by_limit) : les alertes se recalculent avec les seuils réglés dans Réglages
// (param overByLimit, ex. 50:30 = alerte à 80 km/h sur une route à 50) sans retélécharger les journées.
// Seuils vides : alerte du v6 à l'identique (pire dépassement ≥ overAlert).
// ============================================================================
/** { limite: [dépassement, vitesse, instant ms] } du cycle [a, b], null si Geotab n'a fourni aucune limite */
function cOverByLimit_(spd, road, a, b) {
  const pts = cIn_(spd, a, b), out = {};
  let any = false;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1], s = Math.min(p.v, q.v);
    if (s < 30) continue;
    const lp = cLast_(road, p.t, a - 60000), lq = cLast_(road, q.t, a - 60000);
    if (!(lp && lq && lp.v > 0 && lp.v === lq.v)) continue;
    const ex = s - lp.v, k = String(lp.v);
    if (!out[k] || ex > out[k][0]) out[k] = [Math.round(ex), Math.round(s), p.t];
    any = true;
  }
  return any ? out : null;
}
/** Alerte « Dépassement limite » d'une ligne de trajet selon les seuils par limite ; null si aucun seuil atteint */
function overAlertOf_(r, IT, P) {
  const trip = { over_by_limit: r[IT['Dépassements par limite']], worst_over: r[IT['Pire dépassement (km/h)']], lim_at_worst: r[IT['Limite au pire']],
    speed_at_worst: r[IT['Vitesse au pire']], worst_time: r[IT['Heure pire']] };
  const w = rptOverWorst(trip, P);
  if (!w || w.ex < w.tol) return null;
  return { detail: w.v + ' km/h pour ' + w.lim + ' km/h autorisés (seuil d\'alerte +' + w.tol + ' km/h, soit ' + (w.lim + w.tol) + ' km/h) à ' + (w.t ? localHM_(w.t) : w.hm || ''),
    value: '+' + w.ex + ' km/h' };
}
