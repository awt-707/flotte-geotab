// Prix « façon Uber » d'une réservation (23/11/2026) : prise en charge + MAD/km + MAD/min, plancher « course minimum »,
// majoration de nuit puis majoration générale (+resvMarkupPct %), arrondi à 5 MAD. Même calcul que create_reservation (base).
// Partagé par la page publique (reserver.html) et la prévisualisation de la page admin. Testé sous Node (tests/reserve.test.js).
function resvN(x) { const n = parseFloat(x); return isFinite(n) ? n : 0; }
/** Prise en charge de nuit ? hour = heure locale (0-23), t = tarif { nightPct, nightFrom, nightTo } */
function resvNight(hour, t) {
  t = t || {}; if (!(resvN(t.nightPct) > 0) || hour == null) return false;
  const f = resvN(t.nightFrom), to = resvN(t.nightTo);
  return f <= to ? (hour >= f && hour < to) : (hour >= f || hour < to);
}
/**
 * km, min = distance et durée routières (OSRM) ; t = tarif (reservation_tariff) ; hour = heure de prise en charge (locale, option).
 * Renvoie { base, perKm, perMin, raw, night, total } ; total arrondi à 5 MAD, majoration incluse.
 */
function resvPrice(km, min, t, hour) {
  t = t || {};
  const base = resvN(t.base), perKm = resvN(t.perKm), perMin = resvN(t.perMin), minFare = resvN(t.minFare), markup = resvN(t.markupPct), nightPct = resvN(t.nightPct);
  let p = base + perKm * resvN(km) + perMin * resvN(min);
  if (p < minFare) p = minFare;
  const night = resvNight(hour, t);
  if (night) p *= 1 + nightPct / 100;
  p *= 1 + markup / 100;
  return { base, perKm, perMin, raw: Math.round(p * 100) / 100, night, total: Math.round(p / 5) * 5, km: resvN(km), min: resvN(min) };
}
if (typeof module !== 'undefined') module.exports = { resvN, resvNight, resvPrice };
