// ============================================================================
// PLEINS EN COURS DE JOURNÉE (à côté du moteur v6, qui reste inchangé)
// Geotab calcule ses pleins (FillUp) avec retard, après le trajet qui suit le plein : la collecte en direct, qui ne relit
// pas un trajet déjà traité, ne les voyait qu'à la finalisation de la journée (le lendemain vers 13 h).
// À chaque passage : FillUp des journées pas encore finalisées (hier et aujourd'hui), toute la flotte en un appel,
// écrits en lignes provisoires avec la même clé et les mêmes valeurs que la finalisation (qui les remplace ensuite).
// ============================================================================
function liveFills_() {
  const veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId);
  if (!list.length) return 0;
  const now = Date.now(), today = localDay_(now), fin = doneVehDays_(addDays_(today, -2));
  const from = dayBounds_(addDays_(today, -1)).start.getTime();
  const calls = list.map(v => ({ method: 'Get', params: { typeName: 'FillUp', search: { deviceSearch: { id: v.geoId }, fromDate: iso_(from), toDate: iso_(now) } } }));
  const res = [];
  geoFetchAll_(chunks_(calls, 100).map(c => ({ method: 'ExecuteMultiCall', params: { calls: c } }))).forEach(rd => {
    const r = rd(); if (r.err) throw r.err; r.res.forEach(x => res.push(x || []));
  });
  const acc = newAcc_(), none = { cycles: [], idles: [], engStops: [], offStops: [], evts: [], lvl: [] };
  list.forEach((v, i) => {
    const fills = [];
    (res[i] || []).forEach(f => {
      const t = new Date(f.dateTime).getTime(); if (isNaN(t) || t < from || t > now || fin[v.key + '|' + localDay_(t)]) return;
      const ex = f.tankLevelExtrema || {};   // mêmes champs que cAnalyze_ (moteur v6)
      fills.push({ t, volume: f.volume != null ? +f.volume : null, derived: f.derivedVolume != null ? +f.derivedVolume : null,
        min: ex.minimaPoint ? cPct_(ex.minimaPoint, f.tankCapacity) : null, max: ex.maximaPoint ? cPct_(ex.maximaPoint, f.tankCapacity) : null,
        cap: f.tankCapacity ? +f.tankCapacity.volume : null, lat: f.location ? f.location.y : '', lon: f.location ? f.location.x : '',
        conf: String(f.confidence || '') });
    });
    if (fills.length) emitRows_(v, Object.assign({ fills }, none), params_(), acc);
  });
  if (!acc.fuels.length) return 0;
  attribRows_('FUEL', acc.fuels, attribCtx_());
  // pleins nouveaux ou modifiés seulement : le journal n'est recalculé que s'il y a du nouveau (sinon toutes les 15 min pour rien)
  const F = ['lvl_before', 'lvl_after', 'liters_gauge', 'liters_geotab', 'driver_code', 'contract_num'], sig = o => F.map(c => o[c] == null ? '' : String(+o[c] === +o[c] ? +o[c] : o[c])).join('|');
  const rows = acc.fuels.map(r => toDb_('FUEL', r, true)), old = {};
  for (let i = 0; i < rows.length; i += 40) dbSelect_('fuel', 'select=id,' + F.join(',') + '&id=' + inList_(rows.slice(i, i + 40).map(o => o.id)), 'id').forEach(o => { old[o.id] = sig(o); });
  const changed = rows.filter(o => old[o.id] !== sig(o)).length;
  putLive_('FUEL', acc.fuels);
  return changed;
}
