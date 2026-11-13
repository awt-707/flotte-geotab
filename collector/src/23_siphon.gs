// ============================================================================
// Contrôle des siphonages suspects (13/11/2026, doute d'Ahmed : « ça fait beaucoup », « vérifies-tu qu'il n'y a pas de perte de données GPS ? »).
// Le moteur v6 (inchangé) lève un siphonage suspect quand la jauge baisse entre l'arrêt moteur et le redémarrage, sans trajet.
// Sur les vraies données (01 → 13/11, 19 alertes), deux causes de fausses alertes :
//  - véhicule garé en pente / carburant qui bouge : la jauge lit moins au redémarrage puis remonte dès que le véhicule roule
//    (12 alertes sur 19) ; du carburant volé ne revient jamais sans plein ;
//  - véhicule qui a bougé pendant « l'arrêt » (boîtier qui ne voyait plus le contact, perte GPS) : la baisse est la consommation
//    d'un trajet non enregistré (3 alertes ; le moteur v6 ne le voit qu'avec le compteur km, absent sur les hybrides).
// Chaque siphonage suspect est donc contrôlé, une fois les relevés d'après le redémarrage arrivés :
//  1. positions GPS Geotab pendant l'arrêt : déplacé de plus de SIPH_MOVE_M_ mètres (ou vitesse ≥ SIPH_SPEED_) = trajet non enregistré ;
//  2. jauge dans les SIPH_AFTER_ après le redémarrage (avant tout plein) : remontée à moins du seuil d'alerte du niveau d'avant = jauge instable ;
//  sinon : véhicule immobile et jauge restée basse = siphonage à vérifier.
// Résultat dans fuel.check_note ; statut « Faux positif » pour les deux premiers cas (seulement si le statut est encore « À vérifier »).
// Rien n'est estimé : sans relevé de jauge après le redémarrage ni position GPS, la ligne reste « À vérifier » et le dit.
// ============================================================================
const SIPH_DAYS_ = 14, SIPH_MOVE_M_ = 300, SIPH_SPEED_ = 10, SIPH_AFTER_ = 90 * MIN, SIPH_MAX_ = 15;

function siphDistM_(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon);
  const x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
/**
 * Verdict d'un siphonage suspect (calcul pur, testé) : s = ligne fuel, gps = [{ t, lat, lon, speed }] de l'arrêt (et 10 min après le redémarrage),
 * lv = [{ t, v }] relevés de jauge après le redémarrage (avant tout plein), thr = seuil d'alerte (L ou %), unit = 'L' ou '%'.
 * Renvoie { status: 'Faux positif' | 'À vérifier', note }.
 */
function siphVerdict_(s, gps, lv, thr, unit) {
  const a = new Date(s.stop_start).getTime(), b = new Date(s.stop_end).getTime(), u = unit === 'L' ? ' L' : ' %', f1 = x => String(Math.round(x * 10) / 10).replace('.', ',');
  const pts = (gps || []).filter(p => isFinite(p.lat) && isFinite(p.lon) && (p.lat || p.lon)).sort((x, y) => x.t - y.t);
  const ref = s.lat !== '' && s.lat != null && isFinite(+s.lat) && +s.lat ? { lat: +s.lat, lon: +s.lon } : (pts.filter(p => p.t <= a + MIN).pop() || null);
  if (ref) {
    const during = pts.filter(p => p.t > a + MIN && p.t <= b + 10 * MIN);
    let far = 0; during.forEach(p => { far = Math.max(far, siphDistM_(ref, p)); });
    const fast = during.filter(p => p.t < b - MIN && +p.speed >= SIPH_SPEED_);
    if (far > SIPH_MOVE_M_ || fast.length) {
      return { status: 'Faux positif', note: 'Véhicule déplacé pendant l\'arrêt (GPS Geotab' + (far > SIPH_MOVE_M_ ? ' : jusqu\'à ' + (far >= 1000 ? f1(far / 1000) + ' km' : Math.round(far) + ' m') + ' de sa place' : '') +
        (fast.length ? ', vitesse ' + Math.max.apply(null, fast.map(p => Math.round(+p.speed))) + ' km/h' : '') + ') : trajet non enregistré par le boîtier, la baisse est la consommation, pas un siphonage' };
    }
  }
  const before = +s.lvl_before, after = (lv || []).filter(p => p.t >= b && p.t <= b + SIPH_AFTER_ && isFinite(p.v));
  if (after.length >= 2 && isFinite(before)) {
    const top = after.reduce((m, p) => p.v > m.v ? p : m, after[0]), rest = before - top.v;
    if (rest < thr) {
      return { status: 'Faux positif', note: 'Jauge remontée à ' + f1(top.v) + u + ' ' + Math.max(1, Math.round((top.t - b) / MIN)) + ' min après le redémarrage (' + f1(before) + u +
        ' avant l\'arrêt) : véhicule garé en pente ou jauge instable, pas de carburant perdu' };
    }
    return { status: 'À vérifier', note: (ref ? 'Véhicule immobile pendant l\'arrêt (GPS Geotab)' : 'Position GPS non relevée') + ' et jauge restée basse ' + Math.round(SIPH_AFTER_ / MIN) +
      ' min après le redémarrage (au plus ' + f1(top.v) + u + ', ' + f1(before) + u + ' avant l\'arrêt) : siphonage possible, à vérifier' };
  }
  return { status: 'À vérifier', note: (ref ? 'Véhicule immobile pendant l\'arrêt (GPS Geotab)' : 'Position GPS non relevée') + ' ; jauge non relevée après le redémarrage : non mesuré, à vérifier' };
}
/** À chaque passage : siphonages suspects pas encore contrôlés (relevés d'après le redémarrage arrivés), SIPH_MAX_ au plus */
function siphonCheckStep_() {
  const now = Date.now(), since = addDays_(localDay_(now), -(SIPH_DAYS_ - 1));
  let rows;
  try { rows = dbSelect_('fuel', 'select=id,vehicle_key,stop_start,stop_end,lvl_before,source,lat,lon,status,check_note&type=eq.SIPHONAGE_SUSPECT&check_note=is.null&day=gte.' + since, 'stop_start,id'); }
  catch (e) { if (/check_note/.test(e.message)) return ''; throw e; }   // migration 20261126000000_siphon_controle.sql pas encore exécutée
  if (!rows.length) return '';
  const props = PropertiesService.getScriptProperties(), P = params_(), veh = vehicles_();
  let memo = {}; try { memo = JSON.parse(props.getProperty('SIPH_CHK') || '{}') || {}; } catch (e) { memo = {}; }
  let n = 0, fp = 0;
  rows.forEach(s => {
    const b = new Date(s.stop_end).getTime();
    let r = memo[s.id];
    if (!r) {
      if (n >= SIPH_MAX_ || b + SIPH_AFTER_ > now) return;   // relevés d'après le redémarrage pas encore tous arrivés
      const v = veh[s.vehicle_key]; if (!v || !v.geoId) return;
      const a = new Date(s.stop_start).getTime(), iso = t => new Date(t).toISOString(), unit = /\(L\)/.test(s.source || '') ? 'L' : '%';
      const logs = geoCall_('Get', { typeName: 'LogRecord', search: { deviceSearch: { id: v.geoId }, fromDate: iso(a - 30 * MIN), toDate: iso(b + 10 * MIN) }, resultsLimit: 5000 }) || [];
      const gps = logs.map(l => ({ t: new Date(l.dateTime).getTime(), lat: +l.latitude, lon: +l.longitude, speed: +l.speed || 0 }));
      // jauge après le redémarrage, coupée au premier plein (le plein remonte la jauge pour une autre raison)
      const fills = dbSelect_('fuel', 'select=stop_start&type=eq.PLEIN&vehicle_key=eq.' + enc_(s.vehicle_key) + '&stop_start=gte.' + iso(b) + '&stop_start=lte.' + iso(b + SIPH_AFTER_), 'stop_start');
      const cut = fills.length ? new Date(fills[0].stop_start).getTime() - 5 * MIN : b + SIPH_AFTER_;
      const lv = dbSelect_('levels', 'select=at,pct&vehicle_key=eq.' + enc_(s.vehicle_key) + '&at=gte.' + iso(b) + '&at=lte.' + iso(cut), 'at,id')
        .map(x => ({ t: new Date(x.at).getTime(), v: +x.pct })).filter(x => x.v !== null && isFinite(x.v));
      r = siphVerdict_(s, gps, lv, unit === 'L' ? +P.siphonL || 5 : +P.siphonPct || 7, unit);
      memo[s.id] = r; n++;
    }
    const patch = { check_note: r.note };
    if (r.status === 'Faux positif' && (!s.status || s.status === 'À vérifier')) { patch.status = 'Faux positif'; fp++; }
    sbReq_('patch', 'fuel?id=eq.' + enc_(s.id), patch, { Prefer: 'return=minimal' });
  });
  // mémoire des verdicts (une ligne réécrite par la finalisation perd sa note : remise sans rappeler Geotab), 14 jours
  const keep = {}; Object.keys(memo).forEach(id => { const d = (id.split('|')[1] || '').slice(0, 10); if (d >= addDays_(since, -1)) keep[id] = memo[id]; });
  props.setProperty('SIPH_CHK', JSON.stringify(keep));
  return n ? 'Siphonages contrôlés : ' + n + (fp ? ', dont ' + fp + ' faux positif' + (fp > 1 ? 's' : '') + ' (jauge remontée ou véhicule déplacé)' : '') : '';
}
