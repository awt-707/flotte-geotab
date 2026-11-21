// Lecture d'Uber Fleet (19/11/2026, demande d'Ahmed : « on fait notre truc nous-mêmes », plus aucune donnée de l'application de Raphael).
// Ce fichier n'est pas chargé par le site : le site Ludy (plateformes.js, pfReaderSend) l'envoie à l'application Ludy 1.9, qui l'exécute
// dans le volet Uber Fleet ouvert et connecté (commande uber_eval, *.uber.com seulement). La lecture se règle donc avec le site, sans
// réinstaller l'application. Toutes les 10 s :
// 1. données de la carte en temps réel reçues par la page Uber Fleet (réponses JSON gardées par l'application dès le chargement,
//    window.__ludyNet) : pour chaque chauffeur, son état, sa plaque, son nom ; liste complète (full) si au moins 3 chauffeurs y sont lus ;
// 2. sinon, ce que la page affiche (libellés « Disponible », « Course en cours »… et plaque de la même ligne) : lecture partielle.
// Rien n'est deviné : un chauffeur sans état reconnu ou sans plaque lisible n'est pas envoyé. Tant que la lecture n'est pas complète,
// un extrait de la structure des données (diag) est joint pour régler la lecture.
(function () {
  var V = '2026-11-21d';
  var ST = [
    [/offline|hors[ _-]?ligne|logged[ _-]?out|signed[ _-]?off/i, 'offline'],
    [/on[ _-]?trip|in[ _-]?trip|trip[ _-]?in[ _-]?progress|ontrip|driving[ _-]?with|course en cours|en course|with[ _-]?rider|in[ _-]?progress/i, 'on_trip'],
    [/en[ _-]?route|enroute|dispatch|pick[ _-]?up|prise en charge|arriv|accepted|to[ _-]?rider|waiting[ _-]?for/i, 'to_pickup'],
    [/^(online|available|open|idle|active|disponible|en ligne)$|(^|_)(online|available|idle)$/i, 'available']
  ];
  function stOf(v) {
    if (typeof v !== 'string') return null;
    var t = v.replace(/\s+/g, ' ').trim(); if (!t || t.length > 60) return null;
    for (var i = 0; i < ST.length; i++) if (ST[i][0].test(t)) return ST[i][1];
    return null;
  }
  var PLATE = /(?<![0-9])(\d{3,6})\s*[-|\/ ]\s*([A-Z؀-ۿ])\s*[-|\/ ]\s*(\d{1,2})(?![0-9])|(?<![A-Z])WW\s*-?\s*(\d{5,6})(?![0-9])|(?<![0-9])(\d{5,6})\s*-?\s*WW(?![A-Z])|(?<![A-Z])W\s*18\s*-?\s*(\d{4,6})(?![0-9])/i;
  function plateOf(t) {
    var m = String(t || '').toUpperCase().match(PLATE);
    if (!m) return '';
    if (m[1]) return m[1] + '-' + m[2] + '-' + m[3];
    if (m[4]) return 'WW' + m[4];
    if (m[5]) return 'WW' + m[5];
    return 'W18-' + m[6];
  }
  var K_ST = /^(status|state|driverStatus|driver_status|driverState|onlineStatus|availability|supplyStatus|supply_status|activityStatus|tripStatus|jobStatus|statusType|displayStatus)$/i;
  var K_PLATE = /plate|licen[cs]e/i;
  var K_NAME = /^(name|fullName|full_name|displayName|display_name|driverName|driver_name)$/i;
  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''; }
  /** Plaque dans un objet et ses sous-objets proches (véhicule rattaché au chauffeur) */
  function findPlate(o, d) {
    if (!o || typeof o !== 'object' || d > 3) return '';
    for (var k in o) { var v = o[k]; if (K_PLATE.test(k) && typeof v === 'string') { var p = plateOf(v) || (/^\s*\d{5,6}\s*$/.test(v) ? v.trim() : ''); if (p) return p; } }
    for (var k2 in o) { var v2 = o[k2]; if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) { var p2 = findPlate(v2, d + 1); if (p2) return p2; } }
    return '';
  }
  function findName(o) {
    var fn = '', ln = '';
    for (var k in o) {
      var v = o[k];
      if (K_NAME.test(k) && typeof v === 'string' && v.trim() && !/^[0-9a-f-]{20,}$/i.test(v)) return v.trim().slice(0, 80);
      if (/^first_?name$/i.test(k)) fn = str(v); if (/^last_?name$/i.test(k)) ln = str(v);
    }
    if (fn || ln) return (fn + ' ' + ln).trim().slice(0, 80);
    for (var k2 in o) { var v2 = o[k2]; if (v2 && typeof v2 === 'object' && !Array.isArray(v2) && /driver|partner|supplier|user|person/i.test(k2)) { var n = findName(v2); if (n) return n; } }
    return '';
  }
  function findStatus(o, d) {
    if (!o || typeof o !== 'object' || d > 2) return null;
    for (var k in o) { if (K_ST.test(k)) { var s = stOf(o[k]); if (s) return { s: s, raw: str(o[k]) }; if (o[k] && typeof o[k] === 'object') { var s2 = findStatus(o[k], d + 1); if (s2) return s2; } } }
    return null;
  }
  /** Chauffeurs lus dans une réponse JSON : objets qui portent un état reconnu et une plaque */
  function rowsOf(json) {
    var out = {}, n = 0, stack = [[json, 0]];
    while (stack.length && n < 60000) {
      var it = stack.pop(), o = it[0], d = it[1]; n++;
      if (!o || typeof o !== 'object' || d > 14) continue;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) stack.push([o[i], d + 1]); continue; }
      var st = findStatus(o, 0);
      if (st) {
        var p = findPlate(o, 0);
        if (p && !out[p]) out[p] = { plate: p, status: st.s, raw: st.raw.slice(0, 60), name: findName(o) };
      }
      for (var k in o) if (o[k] && typeof o[k] === 'object') stack.push([o[k], d + 1]);
    }
    return Object.keys(out).map(function (p) { return out[p]; });
  }
  /** Squelette d'une réponse (clés et exemples courts) pour régler la lecture : listes réduites à leur premier élément */
  function shape(v, d, budget) {
    if (budget.n <= 0) return '…';
    if (v === null || typeof v !== 'object') { var t = JSON.stringify(v); t = t && t.length > 40 ? t.slice(0, 40) + '…"' : t; budget.n -= (t || '').length; return t; }
    if (d > 6) return Array.isArray(v) ? '[…]' : '{…}';
    if (Array.isArray(v)) { budget.n -= 4; return '[' + v.length + ': ' + (v.length ? shape(v[0], d + 1, budget) : '') + ']'; }
    var parts = [], ks = Object.keys(v).slice(0, 40);
    for (var i = 0; i < ks.length && budget.n > 0; i++) { budget.n -= ks[i].length + 2; parts.push(ks[i] + ':' + shape(v[ks[i]], d + 1, budget)); }
    return '{' + parts.join(',') + '}';
  }
  // ---- lecture de la page affichée (repli, partielle) ----
  function txts(el) { var out = [], w = el.ownerDocument.createTreeWalker(el, 4), n; while ((n = w.nextNode())) { var t = String(n.nodeValue || '').replace(/\s+/g, ' ').trim(); if (t) out.push(t); } return out; }
  function domRows(doc) {
    var out = {}, all = doc.querySelectorAll('body *'), seen = 0;
    for (var i = 0; i < all.length && seen < 3000; i++) {
      var el = all[i];
      if (el.children.length > 0) { var own = ''; for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue; if (!stOf(own) || own.trim().length > 60) continue; }
      var t0 = String(el.textContent || '').trim(); if (t0.length > 60) continue;
      var st = stOf(t0); if (!st) continue; seen++;
      var row = el, plate = '';
      for (var k = 0; k < 8 && row && row !== doc.body; k++) {
        row = row.parentElement; if (!row) break;
        var parts = txts(row); if (parts.join('\n').length > 600) break;
        var nSt = 0, pl = {};
        for (var q = 0; q < parts.length; q++) { if (parts[q].length <= 60 && stOf(parts[q])) nSt++; var pq = plateOf(parts[q]); if (pq) pl[pq] = 1; }
        var pk = Object.keys(pl); if (nSt > 1 || pk.length > 1) break;
        if (pk.length) { plate = pk[0]; break; }
      }
      if (plate) out[plate] = { plate: plate, status: st, raw: t0.slice(0, 60), name: '' };
    }
    return Object.keys(out).map(function (p) { return out[p]; });
  }
  /** Extrait d'une ligne de la liste des chauffeurs (première ligne qui porte un numéro de téléphone) : balises et attributs, sans style */
  function domSample(doc) {
    var all = doc.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i]; if (el.children.length) continue;
      if (!/\+\d{3}\s?\d{6,}/.test(el.textContent || '')) continue;
      var row = el; for (var k = 0; k < 4 && row.parentElement; k++) row = row.parentElement;
      var h = row.outerHTML.replace(/\sstyle="[^"]*"/g, '').replace(/<path[^>]*>/g, '<path>').replace(/\s+/g, ' ');
      return h.slice(0, 4000);
    }
    return '';
  }
  // ---- carte en temps réel d'Uber Fleet (constaté le 19/11/2026) ----
  // /api/GetDriverLiveLocation : data.driverLocations = chauffeurs en ligne (driverId.value, vehicleId.value, supplyActivityState,
  // driverStatus, latitude, longitude) et data.driverStats (onlineDrivers, totalDriversInScope, activityStateCounts) ; ni nom ni plaque.
  // Nom et téléphone : fiches « driver-card » de la liste (data-tracking-payload driverUUID / vehicleUUID). Plaque : toute réponse
  // d'Uber Fleet qui relie un identifiant de véhicule ou de chauffeur à une plaque (gardé dans la page, localStorage « ludyUberMap »).
  function uberSt(v) {
    var t = String(v || '').toUpperCase();
    if (!t) return null;
    if (/OFFLINE/.test(t)) return 'offline';
    if (/NOT_DISPATCHABLE|UNDISPATCHABLE/.test(t)) return null;
    if (/ON_?TRIP|IN_?TRIP|ONTRIP|DROP_?OFF|WITH_RIDER|TRIP_IN_PROGRESS|ACTIVE_TRIP/.test(t)) return 'on_trip';
    if (/EN_?ROUTE|ENROUTE|PICK_?UP|ARRIV|ACCEPT|DISPATCHED(?!ABLE)|WAITING/.test(t)) return 'to_pickup';
    if (/DISPATCHABLE|ONLINE|AVAILABLE|OPEN/.test(t)) return 'available';
    return null;
  }
  function idOf(v) { if (typeof v === 'string') return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? v.toLowerCase() : ''; if (v && typeof v === 'object' && typeof v.value === 'string') return idOf(v.value); return ''; }
  function idsIn(o) {
    var out = [];
    for (var k in o) { var x = idOf(o[k]); if (x && /id$|uuid/i.test(k)) out.push(x); }
    for (var k2 in o) { var c = o[k2]; if (c && typeof c === 'object' && !Array.isArray(c) && !(typeof c.value === 'string')) for (var k3 in c) { var y = idOf(c[k3]); if (y && /id$|uuid/i.test(k3)) out.push(y); } }
    return out;
  }
  /** Plaques et noms rattachés aux identifiants Uber dans une réponse (objets qui ne portent qu'une plaque) */
  function indexJson(j, map) {
    var stack = [[j, 0]], n = 0, hit = 0;
    while (stack.length && n < 80000) {
      var it = stack.pop(), o = it[0], d = it[1]; n++;
      if (!o || typeof o !== 'object' || d > 16) continue;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) stack.push([o[i], d + 1]); continue; }
      var nid = idOf(o.uuid) || (o.driverUuid && idOf(o.driverUuid.uuid || o.driverUuid));
      if (nid && (typeof o.firstName === 'string' || typeof o.lastName === 'string')) { var nm0 = ((o.firstName || '') + ' ' + (o.lastName || '')).trim(); if (nm0 && map.n[nid] !== nm0) { map.n[nid] = nm0.slice(0, 80); hit++; } }
      var pic = typeof o.pictureUrl === 'string' && /^https:\/\/[a-z0-9-]+\.cloudfront\.net\//i.test(o.pictureUrl) ? o.pictureUrl : (typeof o.picUrl === 'string' && /^https:\/\/[a-z0-9-]+\.cloudfront\.net\//i.test(o.picUrl) ? o.picUrl : '');
      if (pic) { var pid = idOf(o.uuid) || idOf(o.id); if (pid) { map.ph = map.ph || {}; if (map.ph[pid] !== pic) { map.ph[pid] = pic.slice(0, 1500); hit++; } } }
      var p = findPlate(o, 0);
      if (p) {
        var ids = idsIn(o), nm = findName(o);
        ids.forEach(function (id) { if (map.p[id] !== p) { map.p[id] = p; hit++; } if (nm && !map.n[id]) map.n[id] = nm; });
      }
      for (var k in o) if (o[k] && typeof o[k] === 'object') stack.push([o[k], d + 1]);
    }
    return hit;
  }
  /** Fiches de la liste des chauffeurs : identifiants, nom, téléphone (et plaque si elle y est écrite) */
  function cardsOf(doc) {
    var out = {}, cs = doc.querySelectorAll ? doc.querySelectorAll('[data-testid="driver-card"]') : [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i], pl = {};
      try { pl = JSON.parse(c.getAttribute('data-tracking-payload') || '{}'); } catch (e) { }
      var did = idOf(pl.driverUUID); if (!did) continue;
      var img = c.querySelector('img[alt]'), lab = c.querySelector('[data-baseweb="typo-labelsmall"]');
      var name = String((lab && lab.textContent) || (img && img.getAttribute('alt')) || '').replace(/\s+/g, ' ').trim();
      var tel = (String(c.textContent || '').match(/\+\d{3}\s?\d[\d ]{6,}/) || [''])[0].replace(/\s+/g, ' ').trim();
      var src = String((img && img.getAttribute('src')) || ''), photo = /^https:\/\/[a-z0-9-]+\.cloudfront\.net\//i.test(src) ? src.slice(0, 1500) : '';
      out[did] = { name: name.slice(0, 80), phone: tel, veh: idOf(pl.vehicleUUID), plate: plateOf(c.textContent || ''), st: String(pl.driverStatus || ''), photo: photo };
    }
    return out;
  }
  /**
   * Dernière réponse de la carte (GetDriverLiveLocation) de moins de 90 s. Liste complète = autant de chauffeurs que « en ligne » dans
   * les comptes de la même réponse (driverStats.onlineDrivers) : la page d'Uber Fleet filtre parfois sa liste (chauffeur cliqué, filtre,
   * recherche : 20/11/2026 22:56, 2 chauffeurs sur 21 en ligne, lus comme la liste entière = 19 fausses déconnexions). La dernière
   * réponse complète est préférée ; sinon la dernière réponse, marquée partielle (jamais de déconnexion déduite).
   */
  function liveComplete(list, st) { var on = st && typeof st.onlineDrivers === 'number' ? st.onlineDrivers : null; return on == null || list.length >= on; }
  function liveOf(net) {
    var part = null;
    for (var i = net.length - 1; i >= 0; i--) {
      var x = net[i]; if (!/GetDriverLiveLocation/i.test(x.url) || Date.now() - x.at > 90000) continue;
      try {
        var j = JSON.parse(x.text); if (!(j && j.data && Array.isArray(j.data.driverLocations))) continue;
        var o = { at: x.at, list: j.data.driverLocations, stats: j.data.driverStats || null };
        o.complete = liveComplete(o.list, o.stats);
        if (o.complete) return o;
        if (!part) part = o;
      } catch (e) { }
    }
    return part;
  }
  function lastCompleteAt(net) {
    for (var i = net.length - 1; i >= 0; i--) {
      var x = net[i]; if (!/GetDriverLiveLocation/i.test(x.url)) continue;
      try { var j = JSON.parse(x.text); if (j && j.data && Array.isArray(j.data.driverLocations) && liveComplete(j.data.driverLocations, j.data.driverStats)) return x.at; } catch (e) { }
    }
    return 0;
  }
  // ---- performances du jour d'Uber (19/11/2026, demande d'Ahmed : revenus, taux d'acceptation, temps en ligne sur la fiche) ----
  // GraphQL GetPerformanceReport (page Performances d'Uber Fleet) : par chauffeur, journée d'Uber (04:00 → 04:00) : revenus totaux,
  // espèces collectées, heures en ligne, courses, taux d'acceptation et d'annulation, première / dernière connexion.
  var PERF = (typeof window !== 'undefined' && window.__ludyPerf) || {};
  if (typeof window !== 'undefined') window.__ludyPerf = PERF;
  function perfIndex(j) {
    var l = j && j.data && j.data.getPerformanceReport, n = 0;
    if (!Array.isArray(l)) return 0;
    l.forEach(function (x) {
      if (!x || x.__typename !== 'DriverPerformanceDetail' || !idOf(x.uuid)) return;
      PERF[idOf(x.uuid)] = { e: num2(x.totalEarnings), cash: num2(x.cashEarnings), h: num2(x.hoursOnline), t: num2(x.totalTrips), a: num2(x.driverAcceptanceRate),
        c: num2(x.driverCancellationRate), first: num2(x.firstOnlineTime), last: num2(x.lastOnlineTime), at: Date.now() };
      n++;
    });
    return n;
  }
  function num2(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? Math.round(n * 1000) / 1000 : null; }
  function perfOf(did) { var p = PERF[did]; return p && Date.now() - p.at < 20 * 60000 ? p : null; }
  /** Jour d'Uber d'un instant : 04:00 → 04:00 UTC (Uber met le Maroc à UTC+0 : 05:00 → 05:00 heure réelle du Maroc ; relevé le 20/11/2026) */
  function uberDay(t) { return Math.floor((t - 4 * 3600000) / 86400000); }
  /** Demande des performances rejouée pour les chauffeurs en ligne, dates décalées au jour d'Uber en cours (toutes les 2 min) */
  var Q_PERF = 'query GetPerformanceReport($performanceReportRequest: PerformanceReportRequest__Input!) { getPerformanceReport(performanceReportRequest: $performanceReportRequest) { uuid totalEarningsLabel totalEarnings earningsPerHourLabel tripsPerOnlineHour hoursOnline totalTrips hoursOnJob hoursOnTrip hoursToTrip hoursAvailableForTrip ... on DriverPerformanceDetail { cashEarningsLabel cashEarnings driverAcceptanceRate driverCancellationRate firstOnlineTime lastOnlineTime firstTripTime lastTripTime __typename } ... on VehiclePerformanceDetail { utilization vehicleIncentiveTarget vehicleIncentiveCompleted vehicleIncentiveEnrollmentStatus vehicleIncentiveUnit vehicleAcceptanceRate __typename } __typename } }';
  var PERF_METRICS = ['vs:TotalEarningsLabel', 'vs:TotalEarnings', 'vs:EarningsPerHourLabel', 'vs:TripsPerOnlineHour', 'vs:HoursOnline', 'vs:HoursOnTrip', 'vs:HoursOnJob', 'vs:TotalTrips', 'vs:CashEarningsLabel',
    'vs:CashEarnings', 'vs:DriverAcceptanceRate', 'vs:DriverCancellationRate', 'vs:FirstOnlineTime', 'vs:LastOnlineTime', 'vs:FirstTripTime', 'vs:LastTripTime'];
  /**
   * Performances du shift en cours (20/11/2026, demande d'Ahmed : « combien ils ont gagné dans le shift », chauffeur par chauffeur) :
   * même demande que la page Performances, période = début du shift (donné par le site Ludy : window.__ludyShift) → maintenant,
   * pour chaque chauffeur vu en ligne depuis le début du shift ; réponse sous un autre nom (shift:) pour ne pas se mêler à la journée.
   */
  var SHIFTP = (typeof window !== 'undefined' && window.__ludyShiftPerf) || { key: '', at: 0, sends: 0, items: [] };
  if (typeof window !== 'undefined') window.__ludyShiftPerf = SHIFTP;
  // chauffeur → plaque et nom vus sur la carte (gardés pour les chauffeurs passés hors ligne pendant le shift)
  var DRVP = {}; try { DRVP = JSON.parse(localStorage.getItem('ludyUberDrvPlate') || '{}') || {}; } catch (e) { DRVP = {}; }
  function drvPlateAdd(rows) {
    var ch = false; (rows || []).forEach(function (x) { if (x.driver && x.plate && (!DRVP[x.driver] || DRVP[x.driver].p !== x.plate || (x.name && DRVP[x.driver].n !== x.name))) { DRVP[x.driver] = { p: x.plate, n: x.name || (DRVP[x.driver] || {}).n || '' }; ch = true; } });
    if (ch) try { localStorage.setItem('ludyUberDrvPlate', JSON.stringify(DRVP)); } catch (e) { }
  }
  function seenAdd(ids) {
    var o = {}; try { o = JSON.parse(localStorage.getItem('ludyUberSeen') || '{}') || {}; } catch (e) { }
    var now = Date.now(); ids.forEach(function (id) { if (id) o[id] = now; });
    Object.keys(o).forEach(function (k) { if (now - o[k] > 50 * 3600000) delete o[k]; });   // 50 h : chauffeurs d'hier (comparaison J-1)
    try { localStorage.setItem('ludyUberSeen', JSON.stringify(o)); } catch (e) { }
    return o;
  }
  function shiftPerfAsk(seen, map) {
    var sh = window.__ludyShift; if (!sh || !sh.key || !sh.from) return;
    if (window.__ludyShiftAt && Date.now() - window.__ludyShiftAt < 120000 && SHIFTP.key === sh.key) return;
    var org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || ''; if (!org) return;
    var from = +new Date(sh.from), ids = Object.keys(seen).filter(function (k) { return seen[k] >= from; }).slice(0, 80);
    if (!ids.length || !(from > 0)) return;
    window.__ludyShiftAt = Date.now();
    var body = JSON.stringify({ operationName: 'GetPerformanceReport', query: Q_PERF.replace('{ getPerformanceReport(', '{ shift: getPerformanceReport('), variables: { performanceReportRequest: {
      orgUUID: org, dimensions: ['vs:driver'], dimensionFilterClause: [{ dimensionName: 'vs:driver', operator: 'OPERATOR_IN', expressions: ids }], metrics: PERF_METRICS,
      timeRange: { startsAt: { value: from }, endsAt: { value: Math.floor(Date.now() / 60000) * 60000 } } } } });
    try {
      window.fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: body, credentials: 'include', __ludy: 1 })
        .then(function (r) { return r.json(); }).then(function (j) {
          var l = j && j.data && j.data.shift; if (!Array.isArray(l)) { window.__ludyShiftRes = 'shift : réponse inattendue ' + JSON.stringify(j).slice(0, 160); return; }
          SHIFTP.key = sh.key; SHIFTP.from = sh.from; SHIFTP.at = Date.now(); SHIFTP.sends = 3;
          SHIFTP.items = l.filter(function (x) { return x && x.__typename === 'DriverPerformanceDetail' && idOf(x.uuid); }).map(function (x) {
            var d = idOf(x.uuid);
            var dp = DRVP[d] || {};
            return { d: d, n: map.n[d] || dp.n || '', p: map.p[d] || dp.p || '', e: num2(x.totalEarnings), cash: num2(x.cashEarnings), h: num2(x.hoursOnline), t: num2(x.totalTrips),
              a: num2(x.driverAcceptanceRate), c: num2(x.driverCancellationRate), hot: num2(x.hoursOnTrip), hto: num2(x.hoursToTrip), hav: num2(x.hoursAvailableForTrip),
              first: num2(x.firstOnlineTime), last: num2(x.lastOnlineTime) };
          });
          window.__ludyShiftRes = 'shift : ' + SHIFTP.items.length + ' chauffeur(s) lu(s)';
        }, function (e) { window.__ludyShiftRes = 'shift : échec ' + String(e && e.message || e).slice(0, 80); });
    } catch (e) { }
  }
  /** Ligne « PERF » du diagnostic (l'application garde 20 000 caractères au plus : reportée si le catalogue prend déjà la place) */
  function shiftPerfLine(used) {
    if (!(SHIFTP.sends > 0) || !SHIFTP.items.length) return '';
    var l = 'PERF ' + JSON.stringify({ period: SHIFTP.key, from: SHIFTP.from, items: SHIFTP.items, prev: SHIFTP.prev && SHIFTP.prev.key === SHIFTP.key ? SHIFTP.prev : null }) + '\n';
    if (used + l.length > 19000) return '';
    SHIFTP.sends--;
    return l;
  }
  /**
   * Revenus par contrat Ludy (21/11/2026, demande d'Ahmed : « combien a rapporté le chauffeur selon son shift de travail, pas selon
   * Uber ») : le site envoie la liste des contrats (window.__ludyCtrs : n° k, compte Uber d, début f, fin t en ms, clé de période p) ;
   * toutes les 2 min, les chiffres d'Uber de chaque compte sur la période exacte de son contrat sont demandés en une seule fois (une
   * réponse nommée par contrat, 15 par demande). Ligne « CTRP » du diagnostic (envoyée 3 fois).
   */
  var CTRP = (typeof window !== 'undefined' && window.__ludyCtrPerf) || { at: 0, items: [], q: [], cur: null, curAt: 0, res: '' };
  if (!CTRP.q) CTRP.q = [];
  if (typeof window !== 'undefined') window.__ludyCtrPerf = CTRP;
  var PERF_FIELDS = Q_PERF.slice(Q_PERF.indexOf('{ uuid'), Q_PERF.lastIndexOf('} }') + 1);
  function ctrPerfAsk() {
    var L = (window.__ludyCtrs && window.__ludyCtrs.list) || [], org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || '';
    if (!L.length || !org || CTRP.busy || Date.now() - CTRP.at < 90000) return;
    CTRP.at = Date.now(); CTRP.busy = 1;
    var lots = [], out = [], errs = []; for (var i = 0; i < L.length; i += 15) lots.push(L.slice(i, i + 15));
    var one = function (lot) {
      var vars = {}, decl = [], fields = [];
      lot.forEach(function (x, j) {
        decl.push('$r' + j + ': PerformanceReportRequest__Input!');
        fields.push('c' + j + ': getPerformanceReport(performanceReportRequest: $r' + j + ') ' + PERF_FIELDS);
        vars['r' + j] = { orgUUID: org, dimensions: ['vs:driver'], dimensionFilterClause: [{ dimensionName: 'vs:driver', operator: 'OPERATOR_IN', expressions: [x.d] }],
          metrics: PERF_METRICS, timeRange: { startsAt: { value: x.f }, endsAt: { value: x.t } } };
      });
      var body = JSON.stringify({ operationName: 'GetPerformanceReport', query: 'query GetPerformanceReport(' + decl.join(', ') + ') { ' + fields.join(' ') + ' }', variables: vars });
      return window.fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: body, credentials: 'include', __ludy: 1 })
        .then(function (r) { return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) { }
          if (!j || !j.data) { errs.push('HTTP ' + r.status + ' ' + String((j && j.errors && j.errors[0] && j.errors[0].message) || t).slice(0, 160)); return; }
          lot.forEach(function (x, k2) {
            var l = j.data['c' + k2]; if (!Array.isArray(l)) return;
            var y = l.filter(function (z) { return z && idOf(z.uuid) === x.d; })[0];
            // aucune ligne pour ce compte sur la période : rien gagné (Uber ne renvoie pas les chauffeurs sans activité)
            out.push(y ? { p: x.p, d: x.d, f: x.f, to: x.t, e: num2(y.totalEarnings), cash: num2(y.cashEarnings), h: num2(y.hoursOnline), t: num2(y.totalTrips), a: num2(y.driverAcceptanceRate),
              c: num2(y.driverCancellationRate), hot: num2(y.hoursOnTrip), hto: num2(y.hoursToTrip), hav: num2(y.hoursAvailableForTrip), first: num2(y.firstOnlineTime), last: num2(y.lastOnlineTime) }
              : { p: x.p, d: x.d, f: x.f, to: x.t, e: 0, cash: 0, h: 0, t: 0 });
          });
        }); }, function (e) { errs.push(String(e && e.message || e).slice(0, 80)); });
    };
    lots.reduce(function (p, l) { return p.then(function () { return one(l); }); }, Promise.resolve()).then(function () {
      // lots de 7 000 caractères au plus (le diagnostic de l'application en garde 20 000), chacun affiché 15 s
      var lots2 = [], b = [], len = 0;
      out.forEach(function (x) { Object.keys(x).forEach(function (k) { if (x[k] == null) delete x[k]; }); var l2 = JSON.stringify(x).length; if (len + l2 > 7000 && b.length) { lots2.push(b); b = []; len = 0; } b.push(x); len += l2; });
      if (b.length) lots2.push(b);
      CTRP.items = out; CTRP.q = lots2; CTRP.cur = null; CTRP.busy = 0;
      CTRP.res = out.length + ' contrat(s) lu(s) sur ' + L.length + (errs.length ? ' · ' + errs.slice(0, 2).join(' | ') : '');
    }, function () { CTRP.busy = 0; });
  }
  /** Ligne « CTRP » : un lot de contrats, affiché 15 s (le site relève toutes les 10 s), puis le suivant */
  function ctrPerfLine(used) {
    if (!CTRP.cur || Date.now() - CTRP.curAt > 15000) { CTRP.cur = CTRP.q.shift() || null; CTRP.curAt = Date.now(); }
    if (!CTRP.cur) return '';
    var l = 'CTRP ' + JSON.stringify(CTRP.cur) + '\n';
    return used + l.length > 19800 ? '' : l;
  }
  /**
   * Courses une par une (20/11/2026, demande d'Ahmed : « les courses de la journée chauffeur par chauffeur », « les rapports d'Uber ») :
   * toutes les 15 min, Ludy demande à Uber Fleet le rapport « Activité des courses » (comme Rapports > Générer un rapport), depuis
   * 3 h avant la fin du rapport précédent (premier rapport : 12 h avant le début du shift) jusqu'à maintenant, attend qu'il soit prêt,
   * le télécharge et envoie au site Ludy les lignes nouvelles ou changées (lignes « TRIPS », un lot affiché 25 s pour que le site le
   * relève) ; le site les importe comme l'import manuel (Contrôle Uber > Import).
   */
  var RPT = '/api/vs-sp-reports-management/';
  var TRP = (typeof window !== 'undefined' && window.__ludyTrips) || { phase: 'idle', at: 0, rid: '', end: 0, start: 0, q: [], cur: null, curAt: 0, n: 0, res: '' };
  if (typeof window !== 'undefined') window.__ludyTrips = TRP;
  function hsh(t) { var h = 5381; for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  /** CSV (guillemets, BOM, ; ou ,) → tableau de lignes */
  function csvRows(t) {
    t = String(t || '').replace(/^﻿/, '');
    var first = t.slice(0, t.indexOf('\n') < 0 ? t.length : t.indexOf('\n')), sep = (first.split(';').length > first.split(',').length) ? ';' : ',';
    var out = [], row = [], cell = '', q = false;
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); out.push(row); row = []; cell = ''; } else cell += c;
    }
    if (cell || row.length) { row.push(cell.replace(/\r$/, '')); out.push(row); }
    return out;
  }
  function rptPost(name, body) {
    return window.fetch(RPT + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: JSON.stringify(body), credentials: 'include', __ludy: 1 })
      .then(function (r) { if (!r.ok) throw new Error(name + ' HTTP ' + r.status); return r.json(); });
  }
  function tripsStep() {
    var org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || ''; if (!org || TRP.busy) return;
    var now = Date.now(), oid = { uuid: { value: org } };
    if (TRP.phase === 'idle') {
      if (now - TRP.at < 15 * 60000) return;
      var end = 0; try { end = +localStorage.getItem('ludyUberTripsEnd') || 0; } catch (e) { }
      var sh = window.__ludyShift, shf = sh && sh.from ? +new Date(sh.from) : now - 12 * 3600000;
      var start = end > now - 48 * 3600000 ? end - 3 * 3600000 : shf - 12 * 3600000;
      start = Math.max(start, now - 30 * 3600000); end = now;
      TRP.at = now; TRP.busy = 1;
      rptPost('GenerateReport', { orgId: oid, reportType: 'REPORT_TYPE_TRIP_ACTIVITY', startDate: { value: new Date(start).toISOString().slice(0, 10) }, endDate: { value: new Date(end).toISOString().slice(0, 10) },
        visibility: '', unixTimeRangeOverride: { startTimeUnixMillis: { value: String(start) }, endTimeUnixMillis: { value: String(end) } }, childOrgUuids: [oid] })
        .then(function (j) {
          var id = j && j.data && j.data.reportId && j.data.reportId.uuid && j.data.reportId.uuid.value;
          if (!id) throw new Error('rapport non créé ' + JSON.stringify(j).slice(0, 120));
          TRP.rid = id; TRP.start = start; TRP.end = end; TRP.phase = 'wait'; TRP.wait = Date.now(); TRP.res = 'rapport demandé ' + new Date(end).toISOString().slice(11, 16);
        }).catch(function (e) { TRP.res = 'rapport : ' + String(e && e.message || e).slice(0, 120); }).then(function () { TRP.busy = 0; });
      return;
    }
    if (TRP.phase === 'wait') {
      if (now - TRP.wait > 15 * 60000) { TRP.phase = 'idle'; TRP.res = 'rapport pas prêt après 15 min'; return; }
      if (TRP.polled && now - TRP.polled < 20000) return;
      TRP.polled = now; TRP.busy = 1;
      rptPost('GetReports', { orgId: oid, pageOptions: { pageToken: { value: '' }, pageSize: { value: 20 } }, filters: [] })
        .then(function (j) {
          var l = (j && j.data && j.data.reports) || [], r = l.filter(function (x) { return x && x.id && x.id.uuid && x.id.uuid.value === TRP.rid; })[0];
          if (!r) return;
          if (/FAIL/.test(r.status || '')) { TRP.phase = 'idle'; TRP.res = 'rapport en échec : ' + (r.failedReason || r.status); return; }
          if (!/COMPLETED/.test(r.status || '')) return;
          return rptPost('DownloadReport', { orgId: oid, reportId: { uuid: { value: TRP.rid } } }).then(function (d) {
            var u = d && d.data && d.data.signedUrl && d.data.signedUrl.value; if (!u) throw new Error('lien du rapport absent');
            return window.fetch(u, { __ludy: 1 }).then(function (r2) { if (!r2.ok) throw new Error('téléchargement HTTP ' + r2.status); return r2.text(); });
          }).then(function (t) {
            if (/^PK/.test(t)) throw new Error('fichier compressé (zip) : lecture à prévoir');
            var rows = csvRows(t), h = -1;
            for (var i = 0; i < Math.min(rows.length, 30); i++) if (rows[i].length > 5 && rows[i].some(function (c) { return /uuid/i.test(c); })) { h = i; break; }
            if (h < 0) throw new Error('colonnes introuvables : ' + JSON.stringify(rows.slice(0, 2)).slice(0, 300));
            var sent = {}; try { sent = JSON.parse(localStorage.getItem('ludyUberTripSent') || '{}') || {}; } catch (e) { }
            var all = ++TRP.n % 4 === 0, fresh = [], hd = rows[h].map(function (c) { return String(c).slice(0, 60); });
            rows.slice(h + 1).forEach(function (r3) {
              if (r3.length < 5) return; var c = r3.map(function (x) { return String(x).slice(0, 160); }), k = hsh(c.join('\u0001'));
              if (!all && sent[k]) return; sent[k] = Date.now(); fresh.push(c);
            });
            Object.keys(sent).forEach(function (k) { if (Date.now() - sent[k] > 3 * 86400000) delete sent[k]; });
            try { localStorage.setItem('ludyUberTripSent', JSON.stringify(sent)); localStorage.setItem('ludyUberTripsEnd', String(TRP.end)); } catch (e) { }
            var b = [], len = 0, flush = function () { if (b.length) TRP.q.push({ id: TRP.rid.slice(0, 8) + '-' + TRP.q.length + '-' + Date.now().toString(36), h: hd, r: b }); b = []; len = 0; };
            fresh.forEach(function (c) { var l2 = JSON.stringify(c).length; if (len + l2 > 8000) flush(); b.push(c); len += l2; });
            flush();
            TRP.phase = 'idle'; TRP.res = 'rapport du ' + new Date(TRP.start).toISOString().slice(0, 16).replace('T', ' ') + ' au ' + new Date(TRP.end).toISOString().slice(11, 16) + ' UTC : ' + (rows.length - h - 1) + ' course(s), ' + fresh.length + ' à envoyer';
          });
        }).catch(function (e) { TRP.phase = 'idle'; TRP.res = 'rapport : ' + String(e && e.message || e).slice(0, 160); }).then(function () { TRP.busy = 0; });
    }
  }
  /** Lot de courses à relever par le site (chaque lot affiché 25 s) */
  function tripsLine(used) {
    if (!TRP.cur || Date.now() - TRP.curAt > 25000) { TRP.cur = TRP.q.shift() || null; TRP.curAt = Date.now(); }
    if (!TRP.cur) return '';
    var l = 'TRIPS ' + JSON.stringify(TRP.cur) + '\n';
    return used + l.length > 19500 ? '' : l;
  }
  function perfAsk(ids) {
    if (!ids.length || (window.__ludyPerfAt && Date.now() - window.__ludyPerfAt < 120000)) return;
    var q = null; try { q = JSON.parse(localStorage.getItem('ludyUberPerfReq') || 'null'); } catch (e) { }
    // aucune demande gardée sur cet ordinateur (page Performances jamais affichée) : la demande de la page Performances, relevée le
    // 20/11/2026 (requête, indicateurs, journée d'Uber 04:00 → 04:00 UTC), construite pour la journée en cours
    if (!q || !q.body) {
      var org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || ''; if (!org) return;
      var d0 = uberDay(Date.now()) * 86400000 + 4 * 3600000;   // 04:00 UTC, comme la page Performances (1795147200000 = 20/11 04:00 UTC)
      q = { url: '/graphql', headers: {}, at: Date.now(), body: JSON.stringify({ operationName: 'GetPerformanceReport', query: Q_PERF, variables: { performanceReportRequest: {
        orgUUID: org, dimensions: ['vs:driver'], dimensionFilterClause: [{ dimensionName: 'vs:driver', operator: 'OPERATOR_IN', expressions: [] }], metrics: PERF_METRICS,
        timeRange: { startsAt: { value: d0 }, endsAt: { value: d0 + 86400000 } } } } }) };
    }
    var j; try { j = JSON.parse(q.body); } catch (e) { return; }
    var shift = (uberDay(Date.now()) - uberDay(q.at)) * 86400000;
    var walk = function (o) {
      for (var k in o) {
        var v = o[k];
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && shift) { var d = new Date(v); if (isFinite(d)) o[k] = new Date(d.getTime() + shift).toISOString(); }
        else if (typeof v === 'string' && /^\d{13}$/.test(v) && shift) o[k] = String(+v + shift);
        else if (typeof v === 'number' && v > 1e12 && v < 1e13 && shift) o[k] = v + shift;
        else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(j.variables || {});
    var req = j.variables && j.variables.performanceReportRequest;
    (req && req.dimensionFilterClause || []).forEach(function (c) { if (c && c.dimensionName === 'vs:driver') c.expressions = ids.slice(0, 80); });
    window.__ludyPerfAt = Date.now();
    var h = { 'content-type': 'application/json', 'x-csrf-token': 'x' }; for (var k2 in (q.headers || {})) h[k2] = q.headers[k2];
    try { window.fetch(q.url || '/graphql', { method: 'POST', headers: h, body: JSON.stringify(j), credentials: 'include', __ludy: 1 }).catch(function () { }); } catch (e) { }
  }
  function read(doc, net, map) {
    net = net || []; map = map || { p: {}, n: {} };
    var live = liveOf(net), cards = cardsOf(doc), lines = [], b = { n: 9000 };
    if (live) {
      var rows = [], miss = [], missIds = [], noPhoto = [], states = {};
      live.list.forEach(function (x) {
        var did = idOf(x.driverId), vid = idOf(x.vehicleId), raw = String(x.supplyActivityState || x.driverStatus || '');
        states[raw] = (states[raw] || 0) + 1;
        var st = uberSt(x.supplyActivityState) || uberSt(x.driverStatus) || 'unknown', cd = cards[did] || {};
        var plate = map.p[vid] || map.p[did] || (cd.veh && map.p[cd.veh]) || cd.plate || '';
        var name = cd.name || map.n[did] || '';
        if (!plate) { miss.push((name || did.slice(0, 8)) + ' · véhicule ' + (vid || '?').slice(0, 8)); missIds.push([did, vid]); return; }
        if (!(cd.photo || (map.ph && map.ph[did]))) noPhoto.push([did, vid]);
        rows.push({ plate: plate, status: st, raw: raw.replace(/^SUPPLY_ACTIVITY_STATE_|^MONITORING_SUPPLY_STATUS_/, '').slice(0, 60), name: name, phone: cd.phone || '', photo: cd.photo || (map.ph && map.ph[did]) || '', driver: did, perf: perfOf(did),
          lat: typeof x.latitude === 'number' ? x.latitude : null, lng: typeof x.longitude === 'number' ? x.longitude : null });
      });
      var full = miss.length === 0 && live.complete;
      if (!live.complete) lines.push('LISTE PARTIELLE ' + V + ' : ' + live.list.length + ' chauffeur(s) dans la réponse de la carte sur ' + (live.stats && live.stats.onlineDrivers) + ' en ligne (filtre de la page d\'Uber Fleet) : aucune déconnexion déduite');
      if (miss.length) {
        lines.push('LUDY ' + V + ' · en ligne (Uber) : ' + live.list.length + ' · plaques trouvées : ' + rows.length + ' · sans plaque : ' + miss.length + ' · fiches de la liste : ' + Object.keys(cards).length + ' · correspondances : ' + Object.keys(map.p).length);
        lines.push('ÉTATS ' + JSON.stringify(states));
        if (live.stats) lines.push('STATS ' + JSON.stringify(live.stats).slice(0, 1500));
        if (miss.length) lines.push('SANS PLAQUE ' + miss.slice(0, 30).join(' | '));
        var seenU = {};
        net.filter(function (x) { return !/tc2\.uber\.com|GetDriverLiveLocation|xp-parameters|bug-report|events\/ack/.test(x.url); }).reverse()
          .filter(function (x) { var k = x.url + x.op; if (seenU[k]) return false; seenU[k] = 1; return true; }).slice(0, 5)
          .forEach(function (x) { var j; try { j = JSON.parse(x.text); } catch (e) { return; } lines.push('== ' + x.url + (x.op ? ' [' + x.op + ']' : '') + ' ' + x.text.length + ' o\n' + shape(j, 0, b)); });
      }
      return { rows: rows, full: full, src: 'GetDriverLiveLocation', diag: lines.join('\n').slice(0, 19000), stats: live.stats, missIds: missIds, noPhoto: noPhoto };
    }
    // pas de données de la carte : repli sur les autres réponses, puis sur la page affichée (lecture partielle)
    var best = [], src = '', recent = net.filter(function (x) { return Date.now() - x.at < 90000; });
    for (var i = recent.length - 1; i >= 0; i--) {
      var j; try { j = JSON.parse(recent[i].text); } catch (e) { continue; }
      var r = rowsOf(j); if (r.length > best.length) { best = r; src = recent[i].url + (recent[i].op ? ' ' + recent[i].op : ''); }
    }
    var d = domRows(doc); if (d.length > best.length) { best = d; src = 'page affichée'; }
    var seen2 = {}, lines2 = [];
    net.slice(-25).forEach(function (x) { lines2.push(new Date(x.at).toISOString().slice(11, 19) + ' ' + x.url + (x.op ? ' [' + x.op + ']' : '') + ' ' + x.text.length + ' o'); });
    recent.slice().sort(function (a, c) { return c.text.length - a.text.length; }).filter(function (x) { var k = x.url + x.op; if (seen2[k]) return false; seen2[k] = 1; return true; }).slice(0, 4)
      .forEach(function (x) { var j; try { j = JSON.parse(x.text); } catch (e) { return; } lines2.push('== ' + x.url + (x.op ? ' [' + x.op + ']' : '') + '\n' + shape(j, 0, b)); });
    return { rows: best, full: false, src: src, diag: ('LUDY ' + V + ' · réponses captées : ' + net.length + '\n' + lines2.join('\n') + '\n== LIGNE DE LA PAGE\n' + domSample(doc)).slice(0, 19000) };
  }
  if (typeof module !== 'undefined') { module.exports = { rowsOf: rowsOf, read: read, stOf: stOf, plateOf: plateOf, shape: shape, uberSt: uberSt, indexJson: indexJson, perfIndex: perfIndex, uberDay: uberDay, csvRows: csvRows, V: V }; return; }
  if (typeof window === 'undefined' || !/(^|\.)uber\.com$/i.test(location.hostname)) return;
  if (window.__ludyURv === V) return;
  window.__ludyURv = V;
  // Uber Fleet arrête de relire la carte quand sa page est cachée (volet masqué derrière Ludy, fenêtre réduite) : la page se croit
  // toujours affichée et au premier plan, pour que la lecture continue pendant qu'on travaille sur Ludy (19/11/2026)
  try {
    var dp = Document.prototype;
    Object.defineProperty(dp, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(dp, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    try { Object.defineProperty(dp, 'webkitHidden', { configurable: true, get: function () { return false; } }); } catch (e) { }
    dp.hasFocus = function () { return true; };
    if (!window.__ludyVis) {
      window.__ludyVis = 1;
      var stop = function (e) { if (!window.__ludyVisFire) e.stopImmediatePropagation(); };
      window.addEventListener('visibilitychange', stop, true);
      window.addEventListener('webkitvisibilitychange', stop, true);
      window.addEventListener('blur', stop, true);
      window.addEventListener('pagehide', stop, true);
    }
    // page déjà mise en pause : elle se croit de nouveau affichée
    window.__ludyVisFire = 1;
    try { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); } finally { window.__ludyVisFire = 0; }
  } catch (e) { }
  clearInterval(window.__ludyURt);
  // correspondances identifiant Uber → plaque / nom, gardées pour cette page (localStorage d'Uber Fleet, sur cet ordinateur seulement)
  var MAP = window.__ludyMap || { p: {}, n: {}, ph: {} };
  if (!window.__ludyMap) try { var sv = JSON.parse(localStorage.getItem('ludyUberMap') || '{}'); if (sv && sv.p) MAP = { p: sv.p || {}, n: sv.n || {}, ph: sv.ph || {} }; } catch (e) { }
  MAP.ph = MAP.ph || {}; window.__ludyMap = MAP;
  var dirty = false;
  function idx(e) { try { if (/tc2\.uber\.com/.test(e.url)) return; var j = JSON.parse(e.text); perfIndex(j); if (indexJson(j, MAP)) dirty = true; } catch (er) { } }
  var NET = window.__ludyNet = window.__ludyNet || [];
  NET.forEach(idx);
  window.__ludyIdxFn = idx;   // nouvelle version de la lecture : c'est elle qui range les réponses suivantes
  if (!NET.__ludyIdx) { var push0 = NET.push; NET.push = function () { for (var i = 0; i < arguments.length; i++) { try { window.__ludyIdxFn && window.__ludyIdxFn(arguments[i]); } catch (e) { } } return push0.apply(this, arguments); }; NET.__ludyIdx = 1; }
  // ---- exploration d'Uber Fleet (19/11/2026, demande d'Ahmed : comprendre Uber Fleet de A à Z et ce qu'on peut en extraire) ----
  // Catalogue de ce que la page charge : chaque adresse (identifiants remplacés par :id), opération GraphQL, requête (texte de la requête,
  // variables), squelette de la réponse, et chaque page visitée (texte affiché, titres des colonnes). Envoyé à Ludy (table uber_catalog,
  // lue par l'administrateur) ; rien d'autre n'est appelé : on ne relève que ce que la page d'Uber Fleet charge d'elle-même.
  var CAT = window.__ludyCat = window.__ludyCat || {};
  function catOp(b) { try { var m = String(b || '').match(/"operationName"\s*:\s*"([^"]{1,80})"/); return m ? m[1] : ''; } catch (e) { return ''; } }
  function catAdd(method, url, reqBody, text) {
    try {
      url = String(url || '');
      if (/tc2\.uber\.com|events\/ack|\/web\/publish|bug-report|\.(js|css|png|jpe?g|svg|woff2?|ico)(\?|$)/i.test(url)) return;
      var path = url.replace(/^https?:\/\/fleethub\.uber\.com/i, '').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').slice(0, 200);
      var op = catOp(reqBody), k = (method || 'GET').toUpperCase() + ' ' + path + (op ? ' [' + op + ']' : '');
      var c = CAT[k] || (CAT[k] = { k: k, url: path, op: op, m: (method || 'GET').toUpperCase(), n: 0, first: Date.now() });
      c.n++; c.at = Date.now(); c.size = String(text || '').length;
      if (!c.res || c.n % 25 === 1) {
        var j = null; try { j = JSON.parse(text); } catch (e) { }
        var res = j ? shape(j, 0, { n: 3500 }) : String(text || '').slice(0, 300);
        if (res !== c.res) { c.res = res; c.sends = 3; }
      }
      if (reqBody && !c.req) {
        var rb = String(reqBody), jq = null; try { jq = JSON.parse(rb); } catch (e) { }
        c.req = jq ? (jq.query ? 'QUERY ' + String(jq.query).replace(/\s+/g, ' ').slice(0, 2500) + ' VARS ' + JSON.stringify(jq.variables || {}).slice(0, 2500) : shape(jq, 0, { n: 1200 })) : rb.slice(0, 800);
        c.sends = 3;
      }
    } catch (e) { }
  }
  function hdrs(h) { var o = {}; try { if (!h) return o; if (typeof h.forEach === 'function') h.forEach(function (v, k) { o[k] = v; }); else for (var k in h) o[k] = h[k]; } catch (e) { } return o; }
  /**
   * Chauffeur en ligne dont la plaque n'est pas encore connue : sa fiche est demandée à Uber Fleet comme quand on clique dessus
   * (même requête GetLivemapSupply que la page, identifiant du chauffeur changé) ; une demande toutes les 10 s au plus, une fois par
   * chauffeur et par 10 min. La réponse passe par la même lecture (plaque, nom, photo gardés).
   */
  var ASKED = {};
  // requête de la fiche d'un chauffeur sur la carte en temps réel (relevée le 19/11/2026 dans Uber Fleet, opération GetLivemapSupply)
  var Q_SUPPLY = 'query GetLivemapSupply($orgUUID: String!, $driverUUID: String!, $vehicleUUID: String) { getLivemapSupply( orgUUID: $orgUUID driverUUID: $driverUUID vehicleUUID: $vehicleUUID ) { uuid driver { uuid firstName lastName phoneNumber countryCode pictureUrl __typename } vehicle { uuid year make model licensePlate __typename } __typename } }';
  function askMissing(list) {
    var org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || '';
    if (!org || !list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var did = list[i][0], vid = list[i][1];
      if (!did || (ASKED[did] && Date.now() - ASKED[did] < 1800000)) continue;
      ASKED[did] = Date.now();
      var g = window.__ludyGql || {}, h = { 'content-type': 'application/json', 'x-csrf-token': 'x' };
      for (var k in (g.headers || {})) h[k] = g.headers[k];
      var body = JSON.stringify({ operationName: 'GetLivemapSupply', variables: { orgUUID: org, driverUUID: did, vehicleUUID: vid || null }, query: Q_SUPPLY });
      try { window.fetch(g.url || '/graphql', { method: 'POST', headers: h, body: body, credentials: 'include', __ludy: 1 }).catch(function () { }); } catch (e) { }
      return;
    }
  }
  if (!window.__ludyCatHook) {
    window.__ludyCatHook = 1;
    try {
      var cf = window.fetch;
      if (cf) window.fetch = function (a, o) {
        var p = cf.apply(this, arguments);
        try {
          var u = a && a.url ? a.url : String(a), m = (o && o.method) || (a && a.method) || 'GET', b = o && typeof o.body === 'string' ? o.body : '';
          var gop = catOp(b); if (gop === 'GetLivemapSupply' && !(o && o.__ludy)) window.__ludyGql = { url: u, body: b, headers: hdrs((o && o.headers) || (a && a.headers)) };
          if (gop === 'GetPerformanceReport' && !(o && o.__ludy) && /vs:driver/.test(b)) { try { localStorage.setItem('ludyUberPerfReq', JSON.stringify({ url: String(u).split('?')[0], body: b, headers: hdrs((o && o.headers) || (a && a.headers)), at: Date.now() })); } catch (e) { } }
          if (/GetDriverLiveLocation/i.test(u) && b && !(o && o.__ludy)) { try { localStorage.setItem('ludyUberLiveReq', JSON.stringify({ url: String(u).split('?')[0], body: b, headers: hdrs((o && o.headers) || (a && a.headers)), at: Date.now() })); } catch (e) { } }
          p.then(function (r) { try { if (/json|text\/plain/i.test(r.headers.get('content-type') || '')) r.clone().text().then(function (t) { catAdd(m, u, b, t); }, function () { }); } catch (e) { } }, function () { });
        } catch (e) { }
        return p;
      };
    } catch (e) { }
    try {
      var co = XMLHttpRequest.prototype.open, cs = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__lcm = m; this.__lcu = u; return co.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (b) {
        var x = this;
        try { x.addEventListener('load', function () { try { var t = x.responseType === 'json' ? JSON.stringify(x.response) : (!x.responseType || x.responseType === 'text') ? x.responseText : ''; catAdd(x.__lcm, x.__lcu, typeof b === 'string' ? b : '', t); } catch (e) { } }); } catch (e) { }
        return cs.apply(this, arguments);
      };
    } catch (e) { }
  }
  /** Page affichée : texte visible (début) et titres des colonnes des tableaux */
  function catPage() {
    try {
      var path = location.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').slice(0, 200), k = 'PAGE ' + path;
      var th = []; var hs = document.querySelectorAll('th, [role="columnheader"]'); for (var i = 0; i < hs.length && i < 60; i++) { var t = String(hs[i].textContent || '').replace(/\s+/g, ' ').trim(); if (t) th.push(t); }
      var txt = String(document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3000);
      var res = 'COLONNES ' + th.join(' | ') + '\nTEXTE\n' + txt;
      var c = CAT[k] || (CAT[k] = { k: k, url: path, op: '', m: 'PAGE', n: 0, first: Date.now() });
      c.at = Date.now();
      if (res.length > (c.res || '').length + 200 || !c.res) { c.res = res; c.n++; c.sends = 3; }
    } catch (e) { }
  }
  /** Lot à envoyer (au plus ~12 000 caractères) : ce qui a changé, envoyé 3 fois (une réception manquée par Ludy est rattrapée) */
  function catBatch(max) {
    var out = [], len = 0; max = max || 12000;
    Object.keys(CAT).forEach(function (k) {
      var c = CAT[k]; if (!(c.sends > 0)) return;
      var it = { k: c.k, url: c.url, op: c.op, m: c.m, n: c.n, first: c.first, at: c.at, size: c.size || 0, req: c.req || '', res: c.res || '' }, s1 = JSON.stringify(it);
      if (len + s1.length > max) return;
      out.push(it); len += s1.length; c.sends--;
    });
    return out.length ? 'CAT ' + JSON.stringify(out) + '\n' : '';
  }
  /**
   * Carte en temps réel lue par Ludy lui-même (19/11/2026, demande d'Ahmed : « Ludy se connecte en arrière-plan à la carte d'Uber ») :
   * quand la page d'Uber Fleet ne relit plus la carte depuis 12 s (autre page d'Uber Fleet ouverte, volet caché), la même demande que la
   * carte (GetDriverLiveLocation, relevée telle quelle quand la carte a été ouverte une fois sur cet ordinateur) est envoyée par Ludy.
   */
  function selfLive() {
    // carte relue par Ludy quand aucune réponse COMPLÈTE n'est arrivée depuis 12 s (la page peut ne relire qu'une partie des chauffeurs)
    var last = lastCompleteAt(NET);
    if (Date.now() - last < 12000 || (window.__ludySelfAt && Date.now() - window.__ludySelfAt < 9000)) return;
    var q = null; try { q = JSON.parse(localStorage.getItem('ludyUberLiveReq') || 'null'); } catch (e) { }
    var org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || '';
    if (q && q.body && org && q.body.indexOf(org) < 0) q = null;   // demande d'une autre organisation Uber : pas reprise
    // aucune demande gardée (carte jamais affichée depuis la version f, volet ouvert caché au démarrage) : la demande de la carte,
    // relevée le 19/11/2026 dans le catalogue (chauffeurs en ligne de l'organisation, avec leurs états et positions)
    if ((!q || !q.body) && org) q = { url: '/api/GetDriverLiveLocation', headers: {}, body: JSON.stringify({ orgId: { uuid: { value: org } }, driverIds: [],
      filters: { allowedActivityStates: [], allowedStatuses: ['MONITORING_SUPPLY_STATUS_ONLINE'] },
      responseSelector: { includeStats: true, locationDetailsOptions: { fieldMask: { paths: ['latitude', 'longitude', 'course', 'locationUpdatedTime', 'driverStatus', 'vehicleId', 'supplyActivityState', 'waypointsLocation', 'dropOffLocation'] } } },
      searchFields: [], searchText: '' }) };
    if (!q || !q.body) { window.__ludySelfRes = 'pas de relecture : organisation Uber inconnue (page ' + location.pathname.slice(0, 60) + ')'; return; }
    window.__ludySelfAt = Date.now();
    var h = { 'content-type': 'application/json', 'x-csrf-token': 'x' }; for (var k in (q.headers || {})) h[k] = q.headers[k];
    try {
      window.fetch(q.url, { method: 'POST', headers: h, body: q.body, credentials: 'include', __ludy: 1 })
        .then(function (r) { window.__ludySelfRes = 'relecture ' + new Date().toISOString().slice(11, 19) + ' : HTTP ' + r.status + (r.ok ? '' : ' (connexion à Uber Fleet à refaire ?)'); }, function (e) { window.__ludySelfRes = 'relecture en échec : ' + String(e && e.message || e).slice(0, 80); });
    } catch (e) { window.__ludySelfRes = 'relecture impossible : ' + String(e && e.message || e).slice(0, 80); }
  }
  function tick() {
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv || !document.body) return;
      selfLive();
      catPage();
      if (dirty) { dirty = false; try { localStorage.setItem('ludyUberMap', JSON.stringify(MAP)); } catch (e) { } }
      var r = read(document, NET, MAP);
      askMissing((r.missIds || []).concat(r.noPhoto || []));
      perfAsk((r.rows || []).map(function (x) { return x.driver; }).filter(Boolean));
      drvPlateAdd(r.rows);
      if (r.src === 'GetDriverLiveLocation') shiftPerfAsk(seenAdd((r.rows || []).map(function (x) { return x.driver; }).concat((r.missIds || []).map(function (x) { return x[0]; }))), MAP);
      try { tripsStep(); } catch (e) { TRP.res = 'rapport : ' + String(e && e.message || e).slice(0, 80); }
      try { ctrPerfAsk(); } catch (e) { CTRP.res = String(e && e.message || e).slice(0, 80); }
      // diagnostic (20 000 caractères au plus) : CAT (catalogue), PERF (shift), TRIPS (courses), puis l'état de la lecture
      var dg = catBatch(TRP.q.length || TRP.cur || CTRP.q.length || CTRP.cur ? 2000 : 8000); dg += ctrPerfLine(dg.length + 300); dg += shiftPerfLine(dg.length + 9500); dg += tripsLine(dg.length + 1200);
      dg += ((window.__ludySelfRes ? 'RELECTURE ' + window.__ludySelfRes + '\n' : '') + (window.__ludyShiftRes ? 'SHIFT ' + window.__ludyShiftRes + '\n' : '') + (CTRP.res ? 'CONTRATS ' + CTRP.res + '\n' : '') + (TRP.res ? 'COURSES ' + TRP.res + (TRP.q.length ? ' · ' + TRP.q.length + ' lot(s) en attente' : '') + '\n' : '') + (r.diag || (r.src ? 'source : ' + r.src : ''))).slice(0, Math.max(1000, 19800 - dg.length));
      inv('uber_push', { rows: r.rows, url: location.href.split('?')[0].slice(0, 200), diag: dg, full: r.full }).catch(function () { });
    } catch (e) { }
  }
  window.__ludyURt = setInterval(tick, 5000);
  setTimeout(tick, 1500);
})();
