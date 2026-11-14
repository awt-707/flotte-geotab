// ============================================================================
// Pauses chauffeurs : véhicule en pause qui bouge (14/11/2026, demande d'Ahmed : « alerte très importante »).
// Le site alerte à l'instant (positions toutes les 5 à 15 s) tant qu'un onglet Ludy est ouvert. Ici, à chaque passage du collecteur
// (toutes les 5 min), même sans aucun Ludy ouvert : positions Geotab du passage (DeviceStatusInfo) comparées à la place du véhicule
// au début de la pause (même règle que le site : svMoved de site/suivi_calc.js, ajouté au collecteur en 62_suivi).
// Véhicule en pause qui a bougé (vu par le site ou par le collecteur) = alerte « Véhicule en pause en mouvement » (Critique) dans la table
// alerts : bandeau rouge sur tous les Ludy ouverts (temps réel) et e-mail aux destinataires des alertes (notifyAlerts_, une seule fois).
// L'alerte est reprise à chaque recalcul des alertes (pauseAlertRows_ dans updateDerived_ : replace_alerts efface sinon ce qu'il ne recalcule pas).
// ============================================================================
const PAUSE_ALERT_TYPE_ = 'Véhicule en pause en mouvement', PAUSE_ALERT_DAYS_ = 3;

/** Lignes d'alerte des pauses où le véhicule a bougé, depuis le jour cut (format de la table alerts) */
function pauseAlertRows_(cut) {
  let ps;
  try { ps = dbSelect_('driver_pauses', 'select=id,vehicle_key,plate,driver_code,driver_name,started_at,moved_at,moved_m,moved_note&moved_at=not.is.null&moved_at=gte.' + enc_(dayBounds_(cut).start.toISOString()), 'id'); }
  catch (e) { if (/driver_pauses|42P01|PGRST2/.test(e.message)) return []; throw e; }
  return ps.map(p => ({ id: 'PAUSE|' + p.id, day: localDay_(p.moved_at), time: localHM_(p.moved_at), plate: p.plate || p.vehicle_key, vehicle_key: p.vehicle_key,
    driver_code: p.driver_code || '', driver_name: p.driver_name || '', type: PAUSE_ALERT_TYPE_, severity: 'Critique',
    detail: 'Chauffeur en pause depuis ' + localHM_(p.started_at) + ' : véhicule ' + (p.moved_note || 'en mouvement') + ' (GPS Geotab)', value: p.moved_m != null ? String(p.moved_m) : '' }));
}

/** À chaque passage : pauses ouvertes contrôlées avec les positions Geotab du passage ; alertes manquantes créées */
function pauseMoveStep_(status) {
  let ps;
  try { ps = dbSelect_('driver_pauses', 'select=id,vehicle_key,plate,driver_name,started_at,planned_min,start_lat,start_lon,moved_at,ended_at&ended_at=is.null', 'id'); }
  catch (e) { if (/driver_pauses|42P01|PGRST2/.test(e.message)) return ''; throw e; }   // migration 20261128000000_suivi_pauses.sql pas encore exécutée
  const P = params_(), now = Date.now(); let moved = 0;
  ps.forEach(p => {
    const d = ((status || {})[p.vehicle_key] || {}).dsi;
    if (!d || !isFinite(+d.latitude) || !isFinite(+d.longitude) || (!+d.latitude && !+d.longitude)) return;
    const pos = { lat: +d.latitude, lon: +d.longitude, speed: d.isDriving ? +d.speed || 0 : 0, state: d.isDriving ? 'En route' : 'Garé' };
    // place du véhicule inconnue au début de la pause (relais indisponible) : relevée au premier passage, si le véhicule est à l'arrêt
    if (p.start_lat == null && !d.isDriving && now - new Date(p.started_at).getTime() < 10 * MIN) {
      sbReq_('patch', 'driver_pauses?id=eq.' + p.id + '&start_lat=is.null', { start_lat: pos.lat, start_lon: pos.lon }, { Prefer: 'return=minimal' });
      return;
    }
    if (p.moved_at) return;
    const mv = svMoved(p, pos, P);
    if (!mv) return;
    sbReq_('patch', 'driver_pauses?id=eq.' + p.id + '&moved_at=is.null', { moved_at: new Date(now).toISOString(), moved_m: mv.m, moved_note: mv.why }, { Prefer: 'return=minimal' });
    moved++;
  });
  // alertes des pauses où le véhicule a bougé (vu ici ou par le site) : créées si elles manquent (jamais réécrites : statut et envoi gardés)
  const rows = pauseAlertRows_(addDays_(localDay_(now), -(PAUSE_ALERT_DAYS_ - 1)));
  if (!rows.length) return moved ? moved + ' véhicule(s) en pause en mouvement' : '';
  const have = {};
  dbSelect_('alerts', 'select=id&id=like.' + enc_('PAUSE|*'), 'id').forEach(a => { have[a.id] = 1; });
  const add = rows.filter(r => !have[r.id]);
  if (add.length) dbUpsert_('alerts', add, 'id');
  return moved || add.length ? 'Pauses : ' + (moved ? moved + ' véhicule(s) en pause en mouvement' : '') + (add.length ? (moved ? ', ' : '') + add.length + ' alerte(s) créée(s)' : '') : '';
}
