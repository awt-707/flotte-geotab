// Chauffeurs Uber / Bolt en ce moment (18/11/2026, demande d'Ahmed : « il me faut absolument le nombre de chauffeurs en course, en ligne
// et en route vers le client sur Ludy », l'API officielle d'Uber met du temps à être ouverte). Source : états relevés en direct sur l'écran
// d'Uber Fleet (et l'API Bolt) par l'application de bureau, rangés dans la base (`fleet_latest` : dernier état de chaque chauffeur,
// `fleet_drivers` : nom, agence). Calculs purs, testés sous Node. Rien d'estimé : un chauffeur que la lecture ne voit plus depuis
// plus de `fresh` ms n'est plus compté en ligne ; lecture arrêtée = chiffres « pas à jour », jamais devinés.
const PF_ST = { available: 'Disponible', to_pickup: 'En route vers le client', on_trip: 'En course', unknown: 'État non reconnu', offline: 'Hors ligne' };
const PF_ORD = { to_pickup: 0, on_trip: 1, available: 2, unknown: 3, offline: 4 };
const PF_FRESH_MS = 2 * 60000;

/**
 * latest : lignes de fleet_latest { driver_id, source, status, observed_at, vehicle_label, evidence } ; drivers : { id, name, agency_id, ludy_driver_code } ;
 * o : { now (ms), fresh (ms), keep(driver, row) → compté ?, nameOf(driver, row) }.
 * Renvoie par plateforme : en ligne (disponible + vers le client + en course + non reconnu), chaque état, la liste des chauffeurs en ligne,
 * l'heure de la dernière lecture et `stale` (aucune lecture récente : chiffres pas à jour).
 */
function pfSummary(latest, drivers, o) {
  o = o || {};
  const now = o.now || Date.now(), fresh = o.fresh || PF_FRESH_MS, keep = o.keep || (() => true), byId = {};
  (drivers || []).forEach(d => { byId[d.id] = d; });
  const out = {};
  ['uber', 'bolt'].forEach(src => { out[src] = { source: src, online: 0, available: 0, to_pickup: 0, on_trip: 0, unknown: 0, list: [], lastAt: 0, stale: true, seen: false }; });
  (latest || []).forEach(r => {
    const s = out[r.source]; if (!s) return;
    const d = byId[r.driver_id] || null;
    if (!keep(d, r)) return;
    s.seen = true;
    const t = new Date(r.observed_at).getTime(); if (!isFinite(t)) return;
    if (t > s.lastAt) s.lastAt = t;
    if (now - t > fresh) return;   // plus vu par la lecture : pas compté en ligne
    const st = PF_ST[r.status] ? r.status : 'unknown';
    if (st === 'offline') return;
    s[st]++; s.online++;
    s.list.push({ driverId: r.driver_id, name: o.nameOf ? o.nameOf(d, r) : (d && d.name) || '', plate: r.vehicle_label || (d && d.vehicle_key) || '', status: st,
      label: PF_ST[st], raw: (r.evidence && r.evidence.raw_state) || '', at: t, agencyId: d ? d.agency_id : null });
  });
  Object.values(out).forEach(s => {
    s.stale = !s.lastAt || now - s.lastAt > fresh;
    s.list.sort((a, b) => PF_ORD[a.status] - PF_ORD[b.status] || String(a.name).localeCompare(String(b.name)));
  });
  return out;
}

/**
 * Chauffeurs qui viennent de se déconnecter d'Uber (18/11/2026, demande d'Ahmed : alerte rouge « chauffeur déconnecté » avec message WhatsApp).
 * Uber Fleet ne montre que les chauffeurs connectés : un chauffeur vu en ligne et que la lecture, toujours à jour, ne voit plus depuis plus
 * de `fresh` ms (au plus `maxAge` ms) = déconnecté. Lecture d'Uber arrêtée = personne n'est déclaré déconnecté (rien de supposé).
 * o.keep(d, r) : garder seulement les chauffeurs dont le contrat est en cours (pas en fin de shift, pas en pause, pas rappelé à l'agence).
 * Renvoie [{ key, driverId, name, plate, lastAt, status (dernier état vu), d, r }], clé = chauffeur + heure du dernier relevé (une alerte par déconnexion).
 */
function pfDisconnects(latest, drivers, o) {
  o = o || {};
  const now = o.now || Date.now(), fresh = o.fresh || PF_FRESH_MS, maxAge = o.maxAge || 45 * 60000, byId = {};
  (drivers || []).forEach(d => { byId[d.id] = d; });
  const uber = (latest || []).filter(r => r.source === 'uber');
  const readerAt = uber.reduce((m, r) => Math.max(m, new Date(r.observed_at).getTime() || 0), 0);
  if (!readerAt || now - readerAt > fresh) return [];
  const out = [];
  uber.forEach(r => {
    if (r.status === 'offline') return;
    const t = new Date(r.observed_at).getTime(), age = now - t;
    if (!(age > fresh && age <= maxAge)) return;
    const d = byId[r.driver_id] || null;
    if (o.keep && !o.keep(d, r)) return;
    out.push({ key: 'UOFF|' + r.driver_id + '|' + r.observed_at, driverId: r.driver_id, name: (d && d.name) || '', plate: r.vehicle_label || '', lastAt: t, status: r.status, d, r });
  });
  return out.sort((a, b) => b.lastAt - a.lastAt);
}
/** Message au chauffeur (français puis darija) : se reconnecter à Uber ou appeler l'agence */
function pfWaOff(x, hm, dur, durAr) {
  const nm = x.name || '', pl = x.plate || '', h = hm(x.lastAt), d = dur(x.now - x.lastAt), da = durAr ? durAr(x.now - x.lastAt) : d;
  return '🔴 *DÉCONNECTÉ D\'UBER*\n' + (nm ? 'Bonjour ' + nm + ',\n' : 'Bonjour,\n') +
    'Vous n\'êtes plus connecté à Uber depuis ' + h + ' (' + d + ')' + (pl ? ' avec le véhicule ' + pl : '') + '.\n' +
    'Merci de vous reconnecter tout de suite, ou d\'appeler l\'agence si vous avez un problème.\n\n' +
    '🔴 *خرجتي من Uber*\n' + (nm ? 'السلام ' + nm + '،\n' : 'السلام،\n') +
    'راك ماشي متصل ب Uber من ' + h + ' (' + da + ')' + (pl ? ' بالطوموبيل ' + pl : '') + '.\n' +
    'عافاك رجع دخل دابا، ولا عيط للوكالة إلا كان شي مشكل.';
}
/** Message à partager (responsable, groupe) : qui, quel véhicule, depuis quand, ce que dit le GPS */
function pfShareOff(x, hm, dur) {
  return '🔴 Chauffeur déconnecté d\'Uber : ' + (x.name || 'chauffeur') + (x.plate ? ' · ' + x.plate : '') + ' · plus connecté depuis ' + hm(x.lastAt) + ' (' + dur(x.now - x.lastAt) + ')' +
    (x.ctr ? ' · contrat ' + x.ctr : '') + (x.geo ? ' · GPS : ' + x.geo : '') + (x.phone ? ' · tél. ' + x.phone : '');
}

if (typeof module !== 'undefined') module.exports = { PF_ST, PF_FRESH_MS, pfSummary, pfDisconnects, pfWaOff, pfShareOff };
