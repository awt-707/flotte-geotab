// Contrôle des courses Uber (14/11/2026, demande d'Ahmed) : calculs purs, testés sous Node (tests/uberctl.test.js).
// Export Uber Fleet « Activité des courses » (trip_activity) croisé avec le GPS Geotab du véhicule :
// - annulation : le véhicule est-il allé vers la prise en charge dans les 15 min après la demande ? (l'export ne donne pas
//   l'heure de l'annulation : on décrit ce que le véhicule a fait, rien n'est supposé) ;
// - trajets sans course Uber : le véhicule roule alors qu'aucune course Uber n'est en cours (de la demande à la dépose).
// Heures de l'export = UTC (vérifié le 14/11 sur les positions Geotab).

const UBC_DEF = { ubcWinMin: 15, ubcNearM: 300, ubcAwayM: 500, ubcStillM: 300, ubcOffKm: 1.5, ubcStopMin: 3, ubcMoveKmh: 8, ubcPadMin: 1, ubcGeoMaxKm: 15 };
function ubcP(P, k) { const v = Number((P || {})[k]); return isFinite(v) && v > 0 ? v : UBC_DEF[k]; }
const UBC_ST = { completed: 'Terminée', rider_cancelled: 'Annulée par le client', driver_cancelled: 'Annulée par le chauffeur' };
const UBC_V = {
  approche: { t: 'S\'est approché de la prise en charge', lv: 'ok' },
  enchainee: { t: 'Course Uber en cours à ce moment (course enchaînée)', lv: 'ok' },
  eloigne: { t: 'S\'est éloigné de la prise en charge', lv: 'bad' },
  sans_approche: { t: 'Ne s\'est pas approché de la prise en charge', lv: 'bad' },
  immobile: { t: 'Véhicule resté sur place', lv: 'warn' },
  rapide: { t: 'Nouvelle demande du chauffeur juste après (annulation rapide)', lv: 'mute' },
  roule: { t: 'A roulé (prise en charge non localisée)', lv: 'warn' },
  nm: { t: 'Non mesuré', lv: 'mute' }
};
/** Suspecte : le véhicule n'est pas allé vers le client (mesuré) */
function ubcSuspect(v) { return v === 'eloigne' || v === 'sans_approche'; }

function ubcNorm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
/** Date de l'export (aaaa-mm-jj hh:mm:ss, UTC) → ISO ; null si vide */
function ubcTime(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString() : null;
}
/** Export « Activité des courses » (lignes d'un tableur : tableau de tableaux) → courses ; { error } si ce n'est pas cet export */
function ubcParseTrips(rows) {
  let h = -1;
  for (let i = 0; i < Math.min((rows || []).length, 30); i++) if ((rows[i] || []).some(c => ubcNorm(c) === 'uuid de la course') && (rows[i] || []).some(c => ubcNorm(c) === 'statut de la course')) { h = i; break; }
  if (h < 0) return { error: 'colonnes « UUID de la course » et « Statut de la course » introuvables (export Uber Fleet « Activité des courses »)', rows: [] };
  const H = rows[h].map(ubcNorm), eq = t => H.indexOf(t);
  const ix = { uuid: eq('uuid de la course'), du: eq('uuid du chauffeur'), fn: eq('prenom du chauffeur'), ln: eq('nom du chauffeur'), vu: eq('uuid du vehicule'),
    plate: eq('plaque d\'immatriculation'), svc: eq('type de service'), req: eq('heure de la demande de course'), drop: eq('heure de depose'),
    pu: eq('adresse de prise en charge'), da: eq('lieu de depose'), km: eq('distance de la course'), st: eq('statut de la course'), prod: eq('type de produit'), pay: eq('type de paiement') };
  const t = (r, i) => i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '', out = [], bad = [], seen = new Set();
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [], u = t(r, ix.uuid); if (!u) continue;
    const req = ubcTime(t(r, ix.req)), st = t(r, ix.st);
    if (!req || !st) { bad.push(i + 1); continue; }
    if (seen.has(u)) continue; seen.add(u);
    const km = parseFloat(t(r, ix.km).replace(',', '.'));
    out.push({ uuid: u, driver_uuid: t(r, ix.du) || null, driver_name: [t(r, ix.fn), t(r, ix.ln)].filter(Boolean).join(' ') || null, vehicle_uuid: t(r, ix.vu) || null,
      plate: t(r, ix.plate) || null, service: t(r, ix.svc) || null, product: t(r, ix.prod) || null, payment: t(r, ix.pay) || null, requested_at: req,
      dropoff_at: ubcTime(t(r, ix.drop)), pickup_addr: t(r, ix.pu) || null, drop_addr: t(r, ix.da) || null, km: isFinite(km) ? km : null, status: st });
  }
  return { rows: out, bad };
}
// Plus codes (Open Location Code) des adresses Uber (« HXWV+72F, Marrakesh ») : position exacte de la prise en charge,
// code court complété avec une position de référence (celle du véhicule à la demande), algorithme de référence d'OLC.
const UBC_OLC = '23456789CFGHJMPQRVWX', UBC_OLC_RES = [20, 1, 0.05, 0.0025, 0.000125];
function ubcOlcEncode(lat, lon) {
  let la = Math.min(89.9999999, Math.max(-90, lat)) + 90, lo = ((lon + 180) % 360 + 360) % 360, s = '';
  for (let i = 0; i < 5; i++) { const r = UBC_OLC_RES[i], a = Math.min(19, Math.floor(la / r)), b = Math.min(19, Math.floor(lo / r)); s += UBC_OLC[a] + UBC_OLC[b]; la -= a * r; lo -= b * r; }
  return s.slice(0, 8) + '+' + s.slice(8);
}
function ubcOlcDecode(code) {
  const c = String(code).toUpperCase().replace('+', '').slice(0, 10);
  if (c.length < 10 || /[^23456789CFGHJMPQRVWX]/.test(c)) return null;
  let lat = -90, lon = -180;
  for (let i = 0; i < 5; i++) { lat += UBC_OLC.indexOf(c[2 * i]) * UBC_OLC_RES[i]; lon += UBC_OLC.indexOf(c[2 * i + 1]) * UBC_OLC_RES[i]; }
  return { lat: lat + UBC_OLC_RES[4] / 2, lon: lon + UBC_OLC_RES[4] / 2 };
}
/** Position d'un plus code trouvé dans une adresse ; ref = { lat, lon } proche (code court) ; null sans plus code */
function ubcPlusCode(addr, ref) {
  const m = String(addr || '').toUpperCase().match(/(?:^|[^0-9A-Z])([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})(?![0-9A-Z])/);
  if (!m) return null;
  const code = m[1], sep = code.indexOf('+');
  if (sep === 8) return ubcOlcDecode(code);
  if (!ref || sep % 2) return null;
  const pad = 8 - sep, res = Math.pow(20, 2 - pad / 2), half = res / 2, p = ubcOlcDecode(ubcOlcEncode(ref.lat, ref.lon).slice(0, pad) + code);
  if (!p) return null;
  if (ref.lat + half < p.lat && p.lat - res >= -90) p.lat -= res; else if (ref.lat - half > p.lat && p.lat + res <= 90) p.lat += res;
  if (ref.lon + half < p.lon) p.lon -= res; else if (ref.lon - half > p.lon) p.lon += res;
  return p;
}
function ubcDist(a, b) {
  if (!a || !b || !isFinite(+a.lat) || !isFinite(+a.lon) || !isFinite(+b.lat) || !isFinite(+b.lon)) return null;
  const R = 6371000, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(+a.lat)) * Math.cos(r(+b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
const ubcPt = p => ({ lat: p[2], lon: p[3] });
const ubcMs = s => s ? new Date(s).getTime() : null;
/** Fenêtre Uber d'une course : de la demande à la dépose (annulée : demande + 15 min au plus, coupée à la demande suivante du chauffeur) */
function ubcWindow(tr, P, nextReq) {
  const a = ubcMs(tr.requested_at);
  let b = tr.status === 'completed' && tr.dropoff_at ? ubcMs(tr.dropoff_at) : a + ubcP(P, 'ubcWinMin') * 60000;
  if (tr.status !== 'completed' && nextReq && nextReq > a) b = Math.min(b, nextReq);
  return [a, Math.max(a, b)];
}
/**
 * Constat Geotab d'une annulation. gps = [[ms, km/h, lat, lon]] triés ; pu = { lat, lon } de la prise en charge (précise) ou null ;
 * busy = une autre course Uber du chauffeur était en cours ; nextReq = demande suivante du même chauffeur (ms) ou null.
 * Renvoie { v, d0, dmin, dend, path, disp, n } (distances en m) ; v = clé de UBC_V.
 */
function ubcCancelCheck(tr, gps, pu, busy, nextReq, P) {
  const t = ubcMs(tr.requested_at), [, end] = ubcWindow(Object.assign({}, tr, { status: 'cancel' }), P, nextReq);
  const pts = (gps || []).filter(p => p[0] >= t - 3 * 60000 && p[0] <= end);
  if (!pts.length) return { v: 'nm', n: 0, why: 'GPS Geotab non relevé' };
  const p0 = pts.reduce((a, b) => Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a);
  if (Math.abs(p0[0] - t) > 3 * 60000) return { v: 'nm', n: pts.length, why: 'GPS Geotab non relevé à l\'heure de la demande' };
  const w = pts.filter(p => p[0] >= p0[0]);
  if (nextReq && nextReq - t < 4 * 60000 && !busy) return { v: 'rapide', n: w.length, min: Math.round((nextReq - t) / 60000), at: ubcPt(p0) };
  let path = 0, disp = 0; for (let i = 1; i < w.length; i++) path += ubcDist(ubcPt(w[i - 1]), ubcPt(w[i])) || 0;
  w.forEach(p => { disp = Math.max(disp, ubcDist(ubcPt(p0), ubcPt(p)) || 0); });
  const o = { n: w.length, path: Math.round(path), disp: Math.round(disp), at: ubcPt(p0), end: ubcPt(w[w.length - 1]), min: Math.round((w[w.length - 1][0] - p0[0]) / 60000) };
  if (busy) return Object.assign(o, { v: 'enchainee' });
  // prise en charge localisée (adresse précise, à moins de 15 km du véhicule : sinon homonyme d'une autre ville)
  const d0 = pu ? ubcDist(ubcPt(p0), pu) : null;
  if (d0 != null && d0 <= ubcP(P, 'ubcGeoMaxKm') * 1000) {
    let dmin = d0; w.forEach(p => { dmin = Math.min(dmin, ubcDist(ubcPt(p), pu)); });
    const dend = ubcDist(ubcPt(w[w.length - 1]), pu);
    Object.assign(o, { d0: Math.round(d0), dmin: Math.round(dmin), dend: Math.round(dend) });
    const near = ubcP(P, 'ubcNearM');
    if (dmin <= near || d0 - dmin >= Math.max(near, 0.3 * d0)) o.v = 'approche';
    else if (disp <= ubcP(P, 'ubcStillM')) o.v = 'immobile';
    else if (dend - d0 >= ubcP(P, 'ubcAwayM')) o.v = 'eloigne';
    else o.v = 'sans_approche';
    return o;
  }
  o.v = disp <= ubcP(P, 'ubcStillM') ? 'immobile' : 'roule';
  if (pu && d0 != null) o.why = 'adresse de prise en charge localisée à ' + Math.round(d0 / 1000) + ' km : homonyme probable, non retenue';
  return o;
}
/**
 * Trajets sans course Uber d'un véhicule sur une fenêtre [from, to] : km roulés pendant une course Uber réalisée (demande → dépose, ±1 min)
 * et en dehors ; segments de mouvement (arrêt de 3 min et plus = nouveau segment) dont au moins 1,5 km hors course Uber.
 * trips = courses Uber du véhicule (tous chauffeurs) ; renvoie { km_uber, km_off, segs: [{ a, b, km_off, km_in, min, from, to, cancels }] }.
 */
function ubcOffDrive(gps, trips, from, to, P) {
  const pad = ubcP(P, 'ubcPadMin') * 60000, mv = ubcP(P, 'ubcMoveKmh'), stop = ubcP(P, 'ubcStopMin') * 60000;
  const byDrv = {}; (trips || []).forEach(t => { (byDrv[t.driver_uuid || ''] = byDrv[t.driver_uuid || ''] || []).push(ubcMs(t.requested_at)); });
  Object.values(byDrv).forEach(a => a.sort((x, y) => x - y));
  // courses réalisées seulement : une demande annulée n'est pas une course (le trajet vers un client qui annule compte « sans course Uber »)
  const W = (trips || []).filter(t => t.status === 'completed').map(t => { const l = byDrv[t.driver_uuid || ''], nx = l.find(x => x > ubcMs(t.requested_at)); return ubcWindow(t, P, nx); });
  const cancels = (trips || []).filter(t => t.status !== 'completed').map(t => ubcMs(t.requested_at));
  const inW = t => W.some(([a, b]) => t >= a - pad && t <= b + pad);
  const pts = (gps || []).filter(p => p[0] >= from && p[0] <= to);
  let kmU = 0, kmO = 0, cur = null, last = -Infinity; const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], d = ubcDist(ubcPt(p), ubcPt(q)) || 0;
    if (q[0] - p[0] > 20 * 60000 && d > 2000) { cur = null; continue; }   // trou du GPS : distance non comptée
    if (!(q[1] >= mv || d > 80)) continue;
    if (!cur || q[0] - last > stop) { cur = { a: p[0], b: q[0], km_in: 0, km_off: 0, from: ubcPt(p), to: ubcPt(q) }; segs.push(cur); }
    const off = !inW(q[0]); if (off) { cur.km_off += d / 1000; kmO += d / 1000; } else { cur.km_in += d / 1000; kmU += d / 1000; }
    cur.b = q[0]; cur.to = ubcPt(q); last = q[0];
  }
  const r1 = x => Math.round(x * 10) / 10;
  return { km_uber: r1(kmU), km_off: r1(kmO), n: pts.length,
    segs: segs.filter(s => s.km_off >= ubcP(P, 'ubcOffKm')).map(s => ({ a: new Date(s.a).toISOString(), b: new Date(s.b).toISOString(), min: Math.round((s.b - s.a) / 60000),
      km_off: r1(s.km_off), km_in: r1(s.km_in), from: s.from, to: s.to, cancels: cancels.filter(c => c >= s.a - 15 * 60000 && c <= s.b).length })) };
}
/** Synthèse par chauffeur Uber : courses, annulations, constats Geotab, km sans course Uber (days = uber_days, attribués au chauffeur des segments) */
function ubcDriverStats(trips, segOwner) {
  const by = {};
  (trips || []).forEach(t => {
    const k = t.driver_uuid || ('N:' + (t.driver_name || '')), o = by[k] = by[k] || { key: k, name: t.driver_name || '—', plates: {}, n: 0, done: 0, rcx: 0, dcx: 0, cash: 0, km: 0, susp: 0, still: 0, checked: 0, nm: 0, offKm: 0, offN: 0, offCx: 0 };
    o.n++; o.plates[t.plate || '?'] = 1;
    if (t.status === 'completed') { o.done++; o.km += +t.km || 0; if (t.payment === 'cash') o.cash++; }
    else if (t.status === 'rider_cancelled') o.rcx++; else o.dcx++;
    if (t.status !== 'completed') {
      const v = t.chk && t.chk.v;
      if (!v) return;
      if (v === 'nm') o.nm++; else if (v !== 'rapide') o.checked++;
      if (ubcSuspect(v)) o.susp++; if (v === 'immobile') o.still++;
    }
  });
  (segOwner || []).forEach(s => { const o = by[s.owner]; if (!o) return; o.offKm += s.km_off; o.offN++; if (s.cancels) o.offCx++; });
  return Object.values(by).map(o => Object.assign(o, { plates: Object.keys(o.plates), cxRate: o.n ? (o.rcx + o.dcx) / o.n : 0, km: Math.round(o.km * 10) / 10, offKm: Math.round(o.offKm * 10) / 10 }));
}
/** Chauffeur Uber d'un instant sur un véhicule : course Uber la plus proche avant (même véhicule), sinon après */
function ubcOwnerAt(trips, t) {
  let best = null, bd = Infinity;
  (trips || []).forEach(x => { const a = ubcMs(x.requested_at), d = t >= a ? t - a : (a - t) * 1.5; if (d < bd) { bd = d; best = x; } });
  return best && bd <= 6 * 3600000 ? (best.driver_uuid || ('N:' + (best.driver_name || ''))) : null;
}
if (typeof module !== 'undefined') module.exports = { ubcOlcEncode, ubcOlcDecode, ubcPlusCode, UBC_DEF, UBC_ST, UBC_V, ubcP, ubcSuspect, ubcTime, ubcParseTrips, ubcDist, ubcWindow, ubcCancelCheck, ubcOffDrive, ubcDriverStats, ubcOwnerAt };
