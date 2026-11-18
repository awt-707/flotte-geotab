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

if (typeof module !== 'undefined') module.exports = { PF_ST, PF_FRESH_MS, pfSummary };
