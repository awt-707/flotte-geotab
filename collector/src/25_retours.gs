// ============================================================================
// Retours des véhicules à l'agence (16/11/2026, demande d'Ahmed : notification quand le chauffeur prévenu est arrivé).
// À chaque passage du collecteur (toutes les 5 min), même sans aucun Ludy ouvert : positions Geotab du passage (DeviceStatusInfo)
// des véhicules dont le chauffeur a été prévenu (return_calls : message envoyé, ni arrivé, ni fait, ni annulé) comparées à la position
// de leur agence (agencies.lat / lng) ; à moins du rayon (agencies.return_radius_m, sinon param returnRadiusM, 300 m) et pas en route
// à 30 km/h ou plus = arrivée notée (arrived_at), une fois. La page Retours, le relais (téléphones) et ce passage appliquent la même règle.
// Ludy (bandeau, notification du navigateur) et l'application Android notifient l'arrivée.
// ============================================================================
function returnArriveStep_(status) {
  let calls;
  try { calls = dbSelect_('return_calls', 'select=id,vehicle_key,agency_id,sent_at,arrived_at&sent_at=not.is.null&arrived_at=is.null&done_at=is.null&cancelled_at=is.null&created_at=gte.' + enc_(new Date(Date.now() - DAY).toISOString()), 'id'); }
  catch (e) { if (/return_calls|42P01|PGRST2/.test(e.message)) return ''; throw e; }   // migration 20261202000000_retours.sql pas encore exécutée
  if (!calls.length) return '';
  const ags = {}; dbSelect_('agencies', 'select=id,name,lat,lng,return_radius_m', 'id').forEach(a => { ags[a.id] = a; });
  const P = params_(), def = +P.returnRadiusM > 0 ? +P.returnRadiusM : 300, now = new Date().toISOString();
  let n = 0;
  calls.forEach(c => {
    const a = ags[c.agency_id], d = ((status || {})[c.vehicle_key] || {}).dsi;
    if (!a || a.lat == null || a.lng == null || !d || !isFinite(+d.latitude) || !isFinite(+d.longitude) || (!+d.latitude && !+d.longitude)) return;
    const m = svDist({ lat: +a.lat, lon: +a.lng }, { lat: +d.latitude, lon: +d.longitude }), rad = +a.return_radius_m > 0 ? +a.return_radius_m : def;
    if (m == null || m > rad || (d.isDriving && +d.speed >= 30)) return;
    sbReq_('patch', 'return_calls?id=eq.' + c.id + '&arrived_at=is.null', { arrived_at: now }, { Prefer: 'return=minimal' });
    n++;
  });
  return n ? 'Retours : ' + n + ' véhicule(s) arrivé(s) à l\'agence' : '';
}
