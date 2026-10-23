// ---------- Étude ponctuelle de consommation dans Geotab (hors parc Ludy) ----------
// Demande d'Ahmed (23/10/2026) : L/100 de 20 Toyota RAV4 sur une semaine, sans les ajouter à Ludy.
// Lancée une fois par le collecteur (accès Geotab déjà en place), résultat dans le param geoStudy (rien d'autre n'est enregistré).
// Véhicules : modèle donné par Geotab (DecodeVins sur le VIN du boîtier), à défaut nom / plaque / commentaire du boîtier.
// Consommation : compteurs Geotab au début et à la fin de la période (odomètre DiagnosticOdometerId, carburant total
// DiagnosticDeviceTotalFuelId), même méthode que les chauffeurs en direct ; compteur absent = non mesuré, rien d'estimé.
let GEO_STUDY_ = { id: 'rav4-2026-10-23', label: 'Toyota RAV4', match: /RAV\s*-?\s*4/i, days: 7, max: 20 };

function geoStudyStep_(t0) {
  const S = GEO_STUDY_, props = PropertiesService.getScriptProperties();
  if (!S || props.getProperty('GEO_STUDY') === S.id) return '';
  const tries = +(props.getProperty('GEO_STUDY_TRY|' + S.id) || 0);
  if (tries >= 3) return '';
  props.setProperty('GEO_STUDY_TRY|' + S.id, String(tries + 1));
  let res;
  try { res = geoStudy_(S); }
  catch (e) { res = { id: S.id, label: S.label, error: e.message }; }
  sbReq_('post', 'params?on_conflict=key', [{ key: 'geoStudy', label: 'Étude de consommation Geotab (calculée par le collecteur)', value: JSON.stringify(res), note: 'Ne pas modifier', sort: 999 }],
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
  if (!res.error) props.setProperty('GEO_STUDY', S.id);
  return 'Étude ' + S.label + ' : ' + (res.error ? res.error : res.vehicles.length + ' véhicules');
}

/** Période = les `days` derniers jours complets (heure du Maroc), véhicules trouvés, compteurs au début et à la fin */
function geoStudy_(S) {
  const today = localDay_(Date.now()), d0 = addDays_(today, -S.days), p = s => s.split('-').map(Number);
  const a = p(d0), b = p(today), from = localToDate_(a[0], a[1], a[2], 0, 0).getTime(), to = localToDate_(b[0], b[1], b[2], 0, 0).getTime();
  const devs = geoCall_('Get', { typeName: 'Device', search: { fromDate: iso_(from) } }) || [];
  // modèle selon Geotab (décodage du VIN) ; appel refusé ou absent : nom, plaque et commentaire du boîtier seulement
  const vins = devs.map(d => String(d.vehicleIdentificationNumber || '').trim()).filter(v => v.length >= 11), model = {};
  let decoded = false;
  for (let i = 0; i < vins.length; i += 100) {
    try { (geoCall_('DecodeVins', { vins: vins.slice(i, i + 100) }) || []).forEach((x, j) => { model[vins[i + j]] = x; }); decoded = true; } catch (e) { }
  }
  const txt = d => [d.name, d.licensePlate, d.comment, JSON.stringify(model[String(d.vehicleIdentificationNumber || '').trim()] || '')].join(' ');
  const found = devs.filter(d => S.match.test(txt(d)));
  const take = found.slice(0, 60), calls = [];
  const at = (id, diag, t) => ({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id: id }, diagnosticSearch: { id: diag }, fromDate: iso_(t), toDate: iso_(t) } } });
  take.forEach(d => calls.push(at(d.id, 'DiagnosticOdometerId', from), at(d.id, 'DiagnosticOdometerId', to), at(d.id, 'DiagnosticDeviceTotalFuelId', from), at(d.id, 'DiagnosticDeviceTotalFuelId', to)));
  const r = [];
  for (let i = 0; i < calls.length; i += 100) geoMulti_(calls.slice(i, i + 100)).forEach(x => r.push(x));
  const val = x => { const q = (x || []).slice(-1)[0]; return q && isFinite(+q.data) ? +q.data : null; };
  const diff = (u, v) => u != null && v != null && v - u >= 0 ? v - u : null;
  let rows = take.map((d, i) => {
    const km = diff(val(r[i * 4]), val(r[i * 4 + 1])), l = diff(val(r[i * 4 + 2]), val(r[i * 4 + 3]));
    const kmR = km == null ? null : Math.round(km / 100) / 10, lR = l == null ? null : Math.round(l * 10) / 10;
    const ok = kmR != null && lR != null && kmR >= 10;
    return { name: d.name || '', plate: d.licensePlate || '', km: kmR, l: lR, l100: ok ? Math.round(lR / kmR * 1000) / 10 : null,
      note: kmR == null || lR == null ? 'non mesuré (compteur Geotab absent)' : kmR < 10 ? 'moins de 10 km' : '' };
  });
  // 20 véhicules : d'abord ceux qui ont roulé (consommation mesurée), les plus de km en premier
  rows.sort((x, y) => (y.l100 != null) - (x.l100 != null) || (y.km || 0) - (x.km || 0));
  rows = rows.slice(0, S.max);
  const m = rows.filter(x => x.l100 != null), sk = m.reduce((s, x) => s + x.km, 0), sl = m.reduce((s, x) => s + x.l, 0);
  return { id: S.id, label: S.label, from: iso_(from), to: iso_(to), at: iso_(Date.now()), found: found.length, decoded: decoded, vehicles: rows,
    measured: m.length, km: Math.round(sk * 10) / 10, l: Math.round(sl * 10) / 10,
    avg_weighted: sk ? Math.round(sl / sk * 1000) / 10 : null,
    avg_simple: m.length ? Math.round(m.reduce((s, x) => s + x.l100, 0) / m.length * 10) / 10 : null };
}
