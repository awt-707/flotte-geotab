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
  var V = '2026-11-19d';
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
    for (var k in o) { var v = o[k]; if (K_PLATE.test(k) && typeof v === 'string') { var p = plateOf(v); if (p) return p; } }
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
      var pic = typeof o.pictureUrl === 'string' && /^https:\/\/[a-z0-9-]+\.cloudfront\.net\//i.test(o.pictureUrl) ? o.pictureUrl : '';
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
  function liveOf(net) {
    for (var i = net.length - 1; i >= 0; i--) {
      var x = net[i]; if (!/GetDriverLiveLocation/i.test(x.url) || Date.now() - x.at > 90000) continue;
      try { var j = JSON.parse(x.text); if (j && j.data && Array.isArray(j.data.driverLocations)) return { at: x.at, list: j.data.driverLocations, stats: j.data.driverStats || null }; } catch (e) { }
    }
    return null;
  }
  function read(doc, net, map) {
    net = net || []; map = map || { p: {}, n: {} };
    var live = liveOf(net), cards = cardsOf(doc), lines = [], b = { n: 9000 };
    if (live) {
      var rows = [], miss = [], missIds = [], states = {};
      live.list.forEach(function (x) {
        var did = idOf(x.driverId), vid = idOf(x.vehicleId), raw = String(x.supplyActivityState || x.driverStatus || '');
        states[raw] = (states[raw] || 0) + 1;
        var st = uberSt(x.supplyActivityState) || uberSt(x.driverStatus) || 'unknown', cd = cards[did] || {};
        var plate = map.p[vid] || map.p[did] || (cd.veh && map.p[cd.veh]) || cd.plate || '';
        var name = cd.name || map.n[did] || '';
        if (!plate) { miss.push((name || did.slice(0, 8)) + ' · véhicule ' + (vid || '?').slice(0, 8)); missIds.push(did); return; }
        rows.push({ plate: plate, status: st, raw: raw.replace(/^SUPPLY_ACTIVITY_STATE_|^MONITORING_SUPPLY_STATUS_/, '').slice(0, 60), name: name, phone: cd.phone || '', photo: cd.photo || (map.ph && map.ph[did]) || '', driver: did,
          lat: typeof x.latitude === 'number' ? x.latitude : null, lng: typeof x.longitude === 'number' ? x.longitude : null });
      });
      var full = miss.length === 0;
      if (!full) {
        lines.push('LUDY ' + V + ' · en ligne (Uber) : ' + live.list.length + ' · plaques trouvées : ' + rows.length + ' · sans plaque : ' + miss.length + ' · fiches de la liste : ' + Object.keys(cards).length + ' · correspondances : ' + Object.keys(map.p).length);
        lines.push('ÉTATS ' + JSON.stringify(states));
        if (live.stats) lines.push('STATS ' + JSON.stringify(live.stats).slice(0, 1500));
        if (miss.length) lines.push('SANS PLAQUE ' + miss.slice(0, 30).join(' | '));
        var seenU = {};
        net.filter(function (x) { return !/tc2\.uber\.com|GetDriverLiveLocation|xp-parameters|bug-report|events\/ack/.test(x.url); }).reverse()
          .filter(function (x) { var k = x.url + x.op; if (seenU[k]) return false; seenU[k] = 1; return true; }).slice(0, 5)
          .forEach(function (x) { var j; try { j = JSON.parse(x.text); } catch (e) { return; } lines.push('== ' + x.url + (x.op ? ' [' + x.op + ']' : '') + ' ' + x.text.length + ' o\n' + shape(j, 0, b)); });
      }
      return { rows: rows, full: full, src: 'GetDriverLiveLocation', diag: lines.join('\n').slice(0, 19000), stats: live.stats, missIds: missIds };
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
  if (typeof module !== 'undefined') { module.exports = { rowsOf: rowsOf, read: read, stOf: stOf, plateOf: plateOf, shape: shape, uberSt: uberSt, indexJson: indexJson, V: V }; return; }
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
  var MAP = { p: {}, n: {}, ph: {} };
  try { var sv = JSON.parse(localStorage.getItem('ludyUberMap') || '{}'); if (sv && sv.p) MAP = { p: sv.p || {}, n: sv.n || {}, ph: sv.ph || {} }; } catch (e) { }
  var dirty = false;
  function idx(e) { try { if (!/tc2\.uber\.com/.test(e.url) && indexJson(JSON.parse(e.text), MAP)) dirty = true; } catch (er) { } }
  var NET = window.__ludyNet = window.__ludyNet || [];
  NET.forEach(idx);
  if (!NET.__ludyIdx) { var push0 = NET.push; NET.push = function () { for (var i = 0; i < arguments.length; i++) idx(arguments[i]); return push0.apply(this, arguments); }; NET.__ludyIdx = 1; }
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
        c.req = jq ? (jq.query ? 'QUERY ' + String(jq.query).replace(/\s+/g, ' ').slice(0, 2500) + ' VARS ' + JSON.stringify(jq.variables || {}).slice(0, 600) : shape(jq, 0, { n: 1200 })) : rb.slice(0, 800);
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
  function askMissing(ids) {
    var g = window.__ludyGql; if (!g || !ids || !ids.length) return;
    var org = (location.pathname.match(/\/orgs\/([0-9a-f-]{36})/i) || [])[1] || '';
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]; if (ASKED[id] && Date.now() - ASKED[id] < 600000) continue;
      var body = null;
      try {
        var j = JSON.parse(g.body), done = false;
        var swap = function (o) { for (var k in o) { var v = o[k]; if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) && v.toLowerCase() !== org.toLowerCase()) { o[k] = id; done = true; } else if (v && typeof v === 'object') swap(v); } };
        swap(j.variables || {}); if (done) body = JSON.stringify(j);
      } catch (e) { }
      ASKED[id] = Date.now();
      if (!body) return;
      try { window.fetch(g.url, { method: 'POST', headers: g.headers, body: body, credentials: 'include', __ludy: 1 }).catch(function () { }); } catch (e) { }
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
  function catBatch() {
    var out = [], len = 0;
    Object.keys(CAT).forEach(function (k) {
      var c = CAT[k]; if (!(c.sends > 0)) return;
      var it = { k: c.k, url: c.url, op: c.op, m: c.m, n: c.n, first: c.first, at: c.at, size: c.size || 0, req: c.req || '', res: c.res || '' }, s1 = JSON.stringify(it);
      if (len + s1.length > 12000) return;
      out.push(it); len += s1.length; c.sends--;
    });
    return out.length ? 'CAT ' + JSON.stringify(out) + '\n' : '';
  }
  function tick() {
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv || !document.body) return;
      catPage();
      if (dirty) { dirty = false; try { localStorage.setItem('ludyUberMap', JSON.stringify(MAP)); } catch (e) { } }
      var r = read(document, NET, MAP);
      if (r.missIds && r.missIds.length) askMissing(r.missIds);
      inv('uber_push', { rows: r.rows, url: location.href.split('?')[0].slice(0, 200), diag: catBatch() + (r.diag || (r.src ? 'source : ' + r.src : '')).slice(0, 7000), full: r.full }).catch(function () { });
    } catch (e) { }
  }
  window.__ludyURt = setInterval(tick, 10000);
  setTimeout(tick, 1500);
})();
