// Suivi des pauses chauffeurs et des courses privées (demande d'Ahmed, 14/11/2026) : calculs purs, sans page ni base (testés sous Node).
// Pause : déclenchée par le gestionnaire, 2 h de pause par chauffeur et par shift (param pauseShiftMin), rappel toutes les 30 min
// (pauseRemindMin), fin = compte à rebours écoulé ; véhicule qui bouge pendant la pause (pauseMoveM mètres de sa place, ou en route
// à 10 km/h et plus) = alerte. Course privée : suivi démarré à la prise en charge, arrivée = véhicule à moins de trackArriveM mètres
// de la destination (adresse géolocalisée), suivi levé par le gestionnaire. Aucun chiffre estimé : la distance parcourue est la somme
// des positions GPS Geotab relevées pendant le suivi (« km GPS »), la distance restante est à vol d'oiseau et le dit.
const PAUSE_DEF = { pauseShiftMin: 120, pauseRemindMin: 30, pauseMoveM: 300, pauseMoveKmh: 10, trackArriveM: 300, trackMinMin: 3 };
function svP(P, k) { const v = Number((P || {})[k]); return isFinite(v) && v > 0 ? v : PAUSE_DEF[k]; }
const SV_MIN = 60000;

/** Distance en mètres entre deux points { lat, lon } (haversine) */
function svDist(a, b) {
  if (!a || !b || !isFinite(+a.lat) || !isFinite(+a.lon) || !isFinite(+b.lat) || !isFinite(+b.lon)) return null;
  const R = 6371000, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(+a.lat)) * Math.cos(r(+b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
/** Fin d'une pause (ms) : début + durée prévue */
function svPauseEndAt(p) { return new Date(p.started_at).getTime() + (+p.planned_min || 0) * SV_MIN; }
/** Minutes de pause d'une pause (en cours : jusqu'à maintenant) */
function svPauseMin(p, now) {
  const a = new Date(p.started_at).getTime(), b = p.ended_at ? new Date(p.ended_at).getTime() : now;
  return Math.max(0, (b - a) / SV_MIN);
}
/** Clé du chauffeur (code client, sinon nom) */
function svDrvKey(p) { return p.driver_code || ('N:' + String(p.driver_name || '').trim().toLowerCase()); }
/** Minutes déjà prises par le chauffeur dans le shift (shift_day + shift), pause exclue (except = id) */
function svUsedMin(pauses, drv, day, shift, now, except) {
  return (pauses || []).filter(p => p.end_reason !== 'Annulée' && p.id !== except && svDrvKey(p) === drv && p.shift_day === day && p.shift === shift)
    .reduce((s, p) => s + svPauseMin(p, now), 0);
}
/** Minutes de pause restantes dans le shift (jamais négatif) */
function svLeftMin(pauses, drv, day, shift, now, P, except) {
  return Math.max(0, svP(P, 'pauseShiftMin') - svUsedMin(pauses, drv, day, shift, now, except));
}
/** Rappels dus pour une pause en cours : multiples de pauseRemindMin écoulés depuis le début (30, 60, 90 min…), avant la fin */
function svReminders(p, now, P) {
  if (p.ended_at) return [];
  const ev = svP(P, 'pauseRemindMin'), el = (now - new Date(p.started_at).getTime()) / SV_MIN, out = [];
  for (let m = ev; m <= el && m < (+p.planned_min || 0); m += ev) out.push(m);
  return out;
}
/** État d'une pause en cours à l'instant now : { left (ms), over (bool), el (min) } */
function svPauseState(p, now) {
  const end = svPauseEndAt(p);
  return { left: end - now, over: !p.ended_at && now >= end, el: (now - new Date(p.started_at).getTime()) / SV_MIN };
}
/** Véhicule en pause qui bouge ? pos = position Geotab { lat, lon, speed, state } ; renvoie { m, why } ou null */
function svMoved(p, pos, P) {
  if (!pos || p.ended_at) return null;
  const d = p.start_lat != null ? svDist({ lat: p.start_lat, lon: p.start_lon }, pos) : null, lim = svP(P, 'pauseMoveM');
  const fast = pos.state === 'En route' && +pos.speed >= svP(P, 'pauseMoveKmh');
  if (d != null && d > lim) return { m: Math.round(d), why: 'à ' + (d >= 1000 ? (Math.round(d / 100) / 10).toString().replace('.', ',') + ' km' : Math.round(d) + ' m') + ' de sa place' + (fast ? ', ' + Math.round(+pos.speed) + ' km/h' : '') };
  if (fast) return { m: d != null ? Math.round(d) : null, why: 'en route à ' + Math.round(+pos.speed) + ' km/h' };
  return null;
}
/** Course arrivée ? pos = position du véhicule ; track = { started_at, dest_lat, dest_lon } ; renvoie la distance (m) ou null */
function svArrived(tr, pos, now, P) {
  if (!pos || tr.dest_lat == null || tr.arrived_at || tr.ended_at) return null;
  if (now - new Date(tr.started_at).getTime() < svP(P, 'trackMinMin') * SV_MIN) return null;   // départ : le véhicule est peut-être encore près de l'arrivée d'un aller-retour
  const d = svDist({ lat: tr.dest_lat, lon: tr.dest_lon }, pos);
  return d != null && d <= svP(P, 'trackArriveM') && !(pos.state === 'En route' && +pos.speed >= 30) ? Math.round(d) : null;
}
/** Points GPS du suivi : ajoute pos s'il s'est déplacé d'au moins 30 m (au plus 600 points), renvoie la liste */
function svAddPoint(points, pos, at) {
  const list = Array.isArray(points) ? points.slice() : [];
  if (!pos || !isFinite(+pos.lat) || !isFinite(+pos.lon)) return list;
  const last = list[list.length - 1], d = last ? svDist({ lat: last[1], lon: last[2] }, pos) : null;
  if (last && d != null && d < 30) return list;
  list.push([at, Math.round(+pos.lat * 1e5) / 1e5, Math.round(+pos.lon * 1e5) / 1e5]);
  return list.length > 600 ? list.filter((x, i) => i % 2 === 0 || i === list.length - 1) : list;
}
/** Kilomètres GPS : somme des segments entre les points relevés (sous-estime un trajet suivi sans positions, jamais l'inverse) */
function svKm(points) {
  let m = 0; (points || []).forEach((p, i) => { if (i) m += svDist({ lat: points[i - 1][1], lon: points[i - 1][2] }, { lat: p[1], lon: p[2] }) || 0; });
  return Math.round(m / 100) / 10;
}
/** Durée lisible : 1 h 05, 45 min, 30 s */
function svDur(ms) {
  const neg = ms < 0, s = Math.round(Math.abs(ms) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const t = h ? h + ' h ' + String(m).padStart(2, '0') : m ? m + ' min' + (m < 10 ? ' ' + String(r).padStart(2, '0') + ' s' : '') : r + ' s';
  return (neg ? '−' : '') + t;
}
/** Compte à rebours mm:ss (ou h:mm:ss) */
function svClock(ms) {
  const neg = ms < 0, s = Math.floor(Math.abs(ms) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60, p2 = x => String(x).padStart(2, '0');
  return (neg ? '+' : '') + (h ? h + ':' + p2(m) : p2(m)) + ':' + p2(r);
}
/** Tableau de suivi des pauses : par chauffeur et par shift (pauses, minutes, au-delà des 2 h, déplacements pendant la pause) */
function svStats(pauses, now, P) {
  const lim = svP(P, 'pauseShiftMin'), by = {};
  (pauses || []).filter(p => p.end_reason !== 'Annulée').forEach(p => {
    const k = svDrvKey(p) + '|' + p.shift_day + '|' + p.shift;
    const g = by[k] = by[k] || { driver_code: p.driver_code || '', driver_name: p.driver_name || '', shift_day: p.shift_day, shift: p.shift, plates: [], n: 0, min: 0, moved: 0, late: 0 };
    g.n++; g.min += svPauseMin(p, now); if (p.moved_at) g.moved++;
    if (p.plate && !g.plates.includes(p.plate)) g.plates.push(p.plate);
    // fin de pause dépassée : arrêtée plus de 5 min après la fin du compte à rebours
    if (p.ended_at && new Date(p.ended_at).getTime() - svPauseEndAt(p) > 5 * SV_MIN) g.late++;
  });
  return Object.values(by).map(g => Object.assign(g, { min: Math.round(g.min), over: Math.max(0, Math.round(g.min - lim)) }))
    .sort((a, b) => String(b.shift_day).localeCompare(String(a.shift_day)) || String(a.shift).localeCompare(String(b.shift)) || String(a.driver_name).localeCompare(String(b.driver_name)));
}
/** Durée en darija (écriture arabe) : 1 h 05 → « 1 ساعة و 5 دقايق », 10 min → « 10 دقايق » */
function svDurAr(ms) {
  const s = Math.round(Math.abs(ms) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mn = x => x === 1 ? 'دقيقة' : x + ' دقايق';
  if (h) return h + ' ساعة' + (m ? ' و ' + mn(m) : '');
  if (m) return mn(m);
  return r + ' ثانية';
}
/** Raison du déplacement (texte de svMoved) en darija : « à 1,1 km de sa place, 42 km/h » / « en route à 41 km/h » */
function svWhyAr(why) {
  const t = String(why || ''), far = t.match(/à ([\d,.]+) (km|m) de sa place/), sp = t.match(/(\d+) km\/h/), out = [];
  if (far) out.push('بعيدة على البلاصة ديالها ب ' + far[1] + (far[2] === 'km' ? ' كيلومتر' : ' متر'));
  if (sp) out.push('ب ' + sp[1] + ' كم/س');
  return out.length ? out.join('، ') : 'كاتمشي';
}
/** Message WhatsApp de fin de pause (au chauffeur), en français puis en darija */
function svWaPauseEnd(p, now) {
  const late = now - svPauseEndAt(p), nm = p.driver_name || '', pl = p.plate || '';
  return '🔴 *FIN DE PAUSE*\n' + (nm ? nm + ', v' : 'V') + 'otre pause est terminée' + (late > SV_MIN ? ' depuis ' + svDur(late) : '') + '.\n' +
    'Véhicule ' + pl + ' : merci de reprendre le service maintenant.\n\n' +
    '🔴 *سالات الاستراحة*\n' + (nm ? nm + '، ' : '') + 'الاستراحة ديالك سالات' + (late > SV_MIN ? ' هادي ' + svDurAr(late) : '') + '.\n' +
    'الطوموبيل ' + pl + ': عافاك رجع للخدمة دابا.';
}
/** Message WhatsApp : véhicule en pause en mouvement (français puis darija) */
function svWaMoved(p, why) {
  const nm = p.driver_name || 'Chauffeur', pl = p.plate || '';
  return '🔴 *ALERTE PAUSE*\n' + nm + ' : le véhicule ' + pl + ' est en pause mais il roule (' + why + ').\nMerci d\'appeler l\'exploitation.\n\n' +
    '🔴 *تنبيه الاستراحة*\n' + (p.driver_name ? p.driver_name + '، ' : '') + 'الطوموبيل ' + pl + ' راه فالاستراحة ولكن كاتمشي (' + svWhyAr(why) + ').\nعافاك عيّط للإدارة دابا.';
}
/** Message WhatsApp : pause en cours (temps qui reste, heure de fin), français puis darija ; endHM = heure de fin HH:MM */
function svWaPauseNow(p, now, endHM) {
  const left = svPauseEndAt(p) - now, pl = p.plate || '';
  return '⏸ Pause en cours : reste ' + svDur(left) + ' (fin à ' + endHM + '). Véhicule ' + pl + '.\n\n' +
    '⏸ راك فالاستراحة: باقي ليك ' + svDurAr(left) + ' (كاتسالي مع ' + endHM + '). الطوموبيل ' + pl + '.';
}
/** Message WhatsApp : détail d'une course suivie (client ou chauffeur) */
function svWaTrack(tr, m, fmt) {
  const f = (m && m.data && m.data.f) || {}, d = x => (x ? fmt(x) : '—');
  return [(tr.ended_at || tr.arrived_at ? '✅ *Course terminée*' : '🚘 *Course en cours*') + (m && m.number ? ' · ' + m.number : ''),
    'Client : ' + ((m && (m.client_company || m.client_name)) || '—'),
    'Chauffeur : ' + (tr.driver_name || (m && m.driver_name) || '—') + (tr.driver_phone ? ' · ' + tr.driver_phone : ''),
    'Véhicule : ' + (tr.plate || '—'),
    'Départ : ' + (f.startAddr || '—'), 'Destination : ' + (tr.dest_label || f.endAddr || f.dest || '—'),
    'Prise en charge : ' + d(tr.started_at), (tr.arrived_at ? 'Arrivée : ' + d(tr.arrived_at) : ''),
    (tr.ended_at || tr.arrived_at ? 'Durée : ' + svDur(new Date(tr.arrived_at || tr.ended_at).getTime() - new Date(tr.started_at).getTime()) : ''),
    (Array.isArray(tr.points) && tr.points.length > 1 ? 'Distance (GPS) : ' + String(svKm(tr.points)).replace('.', ',') + ' km' : '')].filter(Boolean).join('\n');
}
if (typeof module !== 'undefined') module.exports = { PAUSE_DEF, svP, svDist, svPauseEndAt, svPauseMin, svDrvKey, svUsedMin, svLeftMin, svReminders, svPauseState, svMoved, svArrived, svAddPoint, svKm, svDur, svClock, svStats, svDurAr, svWhyAr, svWaPauseEnd, svWaMoved, svWaPauseNow, svWaTrack };
