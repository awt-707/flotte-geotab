// Organisation des retours de véhicules à l'agence (16/11/2026, demande d'Ahmed : « les chauffeurs viennent tous en même temps,
// ça engendre du retard ») : calculs purs, sans page ni base (testés sous Node).
// Ordre des retours : du plus proche au plus loin de l'agence (position Geotab, distance à vol d'oiseau, dite comme telle), ou par heure
// de départ du contrat (le plus ancien d'abord), ou à la main. Heure de retour de chaque chauffeur = première heure + rang × intervalle.
// Rien d'estimé : pas de temps de trajet calculé (la distance est à vol d'oiseau), position inconnue = « non mesuré », classée à la fin.
const RT_DEF = { returnSlotMin: 10, returnRadiusM: 300 };
function rtP(P, k) { const v = Number((P || {})[k]); return isFinite(v) && v > 0 ? v : RT_DEF[k]; }

/** Distance en mètres (haversine) entre { lat, lon } et { lat, lon } ; null si une position manque */
function rtDist(a, b) {
  if (!a || !b || a.lat == null || b.lat == null || a.lon == null || b.lon == null || !isFinite(+a.lat) || !isFinite(+a.lon) || !isFinite(+b.lat) || !isFinite(+b.lon)) return null;
  const R = 6371000, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(+a.lat)) * Math.cos(r(+b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * Coordonnées saisies pour une agence : « 31.6295, -7.9811 », « 31,6295 -7,9811 », lien Google Maps (…/@31.62,-7.98,17z, ?q=31.62,-7.98,
 * !3d31.62!4d-7.98) ; null si illisible ou hors des bornes (latitude −90 → 90, longitude −180 → 180).
 */
function rtParseCoords(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const ok = (a, b) => { const la = +a, lo = +b; return isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la !== 0 || lo !== 0) ? { lat: la, lon: lo } : null; };
  let m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/); if (m) return ok(m[1], m[2]);
  m = t.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/); if (m) return ok(m[1], m[2]);
  m = t.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i); if (m) return ok(m[1], m[2]);
  m = t.match(/^(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (m) return ok(m[1].replace(',', '.'), m[2].replace(',', '.'));
  return null;
}

/**
 * Véhicule arrivé à l'agence : à moins du rayon (mètres) et pas en route à 30 km/h ou plus (il passe devant l'agence sans s'arrêter).
 * Même règle sur la page, au collecteur (returnArriveStep_) et au relais des téléphones (wReturned, live.mjs).
 */
function rtArrived(row, radius) {
  const p = row.p || null;
  return row.dist != null && row.dist <= radius && !(p && p.state === 'En route' && +p.speed >= 30);
}
/** État d'un retour : 'fait' (retour fait), 'arrive' (à l'agence), 'envoye' (message envoyé), 'aprevenir' */
function rtState(row, radius) {
  const c = row.call || null;
  if (c && c.done_at) return 'fait';
  if ((c && c.arrived_at) || rtArrived(row, radius)) return 'arrive';
  if (c && c.sent_at) return 'envoye';
  return 'aprevenir';
}
const RT_ST_TXT = { fait: 'Retour fait', arrive: 'À l\'agence', envoye: 'Message envoyé', aprevenir: 'À prévenir' };
const RT_ST_ORD = { envoye: 0, aprevenir: 0, arrive: 1, fait: 2 };

/**
 * Ordre des retours. mode 'dist' : du plus proche au plus loin (position inconnue à la fin) ; 'depart' : heure de départ du contrat
 * (le plus ancien d'abord) ; 'manuel' : ordre gardé (liste de n° de contrat), nouveaux à la fin dans l'ordre des distances.
 * Les retours faits et les véhicules déjà à l'agence passent après ceux qui restent à faire rentrer.
 */
function rtOrder(rows, mode, manual, radius) {
  const st = r => RT_ST_ORD[rtState(r, radius)];
  const byDist = (a, b) => (a.dist == null) - (b.dist == null) || (a.dist || 0) - (b.dist || 0) || String(a.start_at || '').localeCompare(String(b.start_at || ''));
  const byDep = (a, b) => String(a.start_at || '').localeCompare(String(b.start_at || '')) || byDist(a, b);
  const pos = {}; (manual || []).forEach((n, i) => { pos[n] = i; });
  const byMan = (a, b) => ((a.num in pos) ? pos[a.num] : 1e9) - ((b.num in pos) ? pos[b.num] : 1e9) || byDist(a, b);
  const f = mode === 'depart' ? byDep : mode === 'manuel' ? byMan : byDist;
  return rows.slice().sort((a, b) => st(a) - st(b) || f(a, b));
}

/**
 * Heures de retour : les chauffeurs déjà prévenus gardent l'heure envoyée ; les autres, dans l'ordre, reçoivent les créneaux libres
 * à partir de la première heure (start, ms), un toutes les `step` minutes, sans reprendre un créneau déjà donné. Faits / à l'agence : aucun.
 */
function rtSlots(rows, start, step, radius) {
  const out = {}, taken = [];
  rows.forEach(r => { const c = r.call; if (c && c.slot_at && rtState(r, radius) === 'envoye') { out[r.num] = new Date(c.slot_at).getTime(); taken.push(out[r.num]); } });
  let t = start;
  const free = x => !taken.some(y => Math.abs(y - x) < step * 60000 / 2);
  rows.forEach(r => {
    if (out[r.num] || rtState(r, radius) !== 'aprevenir') return;
    while (!free(t)) t += step * 60000;
    out[r.num] = t; taken.push(t); t += step * 60000;
  });
  return out;
}

/** Heure « HH:MM » d'un instant (ms) dans le fuseau donné par la fonction hm (heure du Maroc sur le site) */
function rtHM(t, hm) { return hm ? hm(t) : new Date(t).toISOString().slice(11, 16); }

/** Message WhatsApp au chauffeur (français puis darija) : se déconnecter d'Uber / Bolt et rentrer à l'agence pour l'heure donnée */
function rtMsg(row, agency, slotTxt) {
  const nm = row.driver_name || '', pl = row.plate || '', ag = (agency && agency.name) || 'l\'agence';
  const map = agency && agency.lat != null && agency.lng != null ? '\n📍 https://www.google.com/maps/search/?api=1&query=' + agency.lat + ',' + agency.lng : '';
  const adr = agency && agency.address ? '\n' + agency.address : '';
  return '🚗 *RETOUR DU VÉHICULE*\n' + (nm ? 'Bonjour ' + nm + ',\n' : 'Bonjour,\n') +
    'Merci de vous *déconnecter d\'Uber et de Bolt* maintenant (ne plus accepter de course) et de rentrer à l\'agence ' + ag + ' pour le retour du véhicule ' + pl + '.\n' +
    '⏰ Heure de retour à l\'agence : *' + slotTxt + '*' + adr + map + '\n\n' +
    '🚗 *رجوع الطوموبيل*\n' + (nm ? 'السلام ' + nm + '،\n' : 'السلام،\n') +
    'عافاك *خرج من Uber و Bolt* دابا (ما تقبل حتى كورسة) ورجع للوكالة باش ترجع الطوموبيل ' + pl + '.\n' +
    '⏰ ساعة الرجوع للوكالة: *' + slotTxt + '*' + map;
}

if (typeof module !== 'undefined') module.exports = { RT_DEF, rtP, rtDist, rtParseCoords, rtArrived, rtState, RT_ST_TXT, rtOrder, rtSlots, rtHM, rtMsg };
