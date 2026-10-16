// ============================================================================
// ARRÊTS MOTEUR TOURNANT (véhicule immobile, moteur allumé), un par arrêt d'au moins engStopMin minutes
// Calcul ajouté à côté du moteur v6 : les trajets, ralentis, journal et alertes du v6 ne changent pas.
// Rien n'est estimé :
//  - litres = compteur Geotab « carburant total au ralenti » (DiagnosticDeviceTotalIdleFuelId) relevé juste avant
//    et juste après l'arrêt. Le compteur n'avance qu'au ralenti : un relevé plus ancien reste exact tant qu'il n'y a pas
//    eu d'autre ralenti entre le relevé et l'arrêt. Au-delà de STOP_EXTRA_MAX de ralenti hors arrêt : vide (non mesuré).
//  - ceinture conducteur (DiagnosticDriverSeatbeltId : 0 = bouclée, 1 = débouclée, autre = inconnu) : minutes de l'arrêt
//    dans chaque état, d'après la dernière valeur transmise ; vide si le véhicule ne la transmet pas.
// La climatisation n'est transmise par aucun boîtier de la flotte (Sonde Geotab) : non mesurée.
// ============================================================================
const STOP_EXTRA_MAX = C_MIN;     // ralenti hors arrêt toléré dans la fenêtre des deux relevés
const STOP_EDGE = 30000;          // relevé accepté jusqu'à 30 s à l'intérieur de l'arrêt (envoi du boîtier au démarrage)

/** Minutes de ralenti (segments tl.segs) dans [x, y], hors l'arrêt lui-même */
function stopIdleIn_(segs, self, x, y) {
  let ms = 0;
  segs.forEach(s => { if (s !== self) ms += Math.max(0, Math.min(s.b, y) - Math.max(s.a, x)); });
  return ms;
}
/** Arrêts moteur tournant d'un cycle contact c (tl = cTimeline_ du cycle) */
function cEngStops_(S, logs, c, tl, prevOff, nextOn, P) {
  const minMs = (P.engStopMin > 0 ? P.engStopMin : 3) * C_MIN, out = [];
  tl.segs.forEach(s => {
    if (s.b - s.a < minMs) return;
    const dur = s.b - s.a;
    // Litres : relevés du compteur ralenti encadrant l'arrêt
    let liters = null, extra = null, src = 'Non mesuré';
    const v1 = cLast_(S.idleFuel, s.a + STOP_EDGE, prevOff != null ? prevOff - 10000 : c.a - 6 * C_HOUR);
    const v2 = cFirst_(S.idleFuel, s.b - STOP_EDGE, (nextOn != null ? nextOn : (c.open ? c.b : c.b + 6 * C_HOUR)) + 30000);
    if (!v1 || !v2) src = 'Non mesuré : pas de relevé du compteur ralenti ' + (!v1 ? 'avant' : 'après') + ' l\'arrêt';
    else {
      const ex = stopIdleIn_(tl.segs, s, Math.min(v1.t, s.a), s.a) + stopIdleIn_(tl.segs, s, s.b, Math.max(v2.t, s.b));
      const d = v2.v - v1.v, spanH = (Math.max(v2.t, s.b) - Math.min(v1.t, s.a)) / C_HOUR;
      if (ex > STOP_EXTRA_MAX) src = 'Non mesuré : relevés trop éloignés (' + r1_(ex / C_MIN) + ' min d\'autre ralenti entre les relevés)';
      else if (d < 0 || d > spanH * 4 + 1) src = 'Non mesuré : compteur ralenti incohérent';
      else { liters = d; extra = ex / C_MIN; src = 'Compteur ralenti Geotab'; }
    }
    // Ceinture conducteur : minutes bouclée / débouclée pendant l'arrêt
    let on = 0, off = 0;
    const pts = [cLast_(S.belt, s.a, c.a)].concat(cIn_(S.belt, s.a + 1, s.b)).filter(Boolean);   // valeur du cycle en cours seulement (pas d'état périmé)
    pts.forEach((p, k) => {
      const t0 = Math.max(p.t, s.a), t1 = k + 1 < pts.length ? pts[k + 1].t : s.b;
      if (t1 <= t0) return;
      if (p.v === 0) on += t1 - t0; else if (p.v === 1) off += t1 - t0;
    });
    const pos = cLast_(logs, s.a + 1000, c.a) || cFirst_(logs, s.a, s.b);
    out.push({ a: s.a, b: s.b, min: dur / C_MIN, cycleA: c.a, liters, src, extra,
      lph: liters != null ? liters / ((dur + extra * C_MIN) / C_HOUR) : null,
      beltOn: on || off ? on / C_MIN : null, beltOff: on || off ? off / C_MIN : null,
      lat: pos ? pos.lat : '', lon: pos ? pos.lon : '' });
  });
  return out;
}
/** Lignes de la table engine_stops */
function emitStops_(v, list, acc) {
  (list || []).forEach(s => {
    acc.stops.push(rowOf_(H.STP, { 'Clé': v.key + '|' + iso_(s.a), 'Clé plaque': v.key, 'Plaque': v.plate, 'Trajet ID': v.key + '|' + iso_(s.cycleA),
      'Date': dayToDate_(localDay_(s.a)), 'Début': new Date(s.a), 'Fin': new Date(s.b), 'Durée (min)': r1_(s.min),
      'Litres': s.liters != null ? r2_(s.liters) : '', 'Source litres': s.src, 'Ralenti hors arrêt inclus (min)': s.extra != null ? r1_(s.extra) : '',
      'L/h': s.lph != null ? r2_(s.lph) : '', 'Ceinture bouclée (min)': s.beltOn != null ? r1_(s.beltOn) : '',
      'Ceinture débouclée (min)': s.beltOff != null ? r1_(s.beltOff) : '', 'Lat': s.lat, 'Lon': s.lon }));
  });
}
