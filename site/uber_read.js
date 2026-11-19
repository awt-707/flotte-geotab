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
  var V = '2026-11-19a';
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
  function read(doc, net) {
    var best = [], src = '';
    var recent = (net || []).filter(function (x) { return Date.now() - x.at < 90000; });
    for (var i = recent.length - 1; i >= 0; i--) {
      var j; try { j = JSON.parse(recent[i].text); } catch (e) { continue; }
      var r = rowsOf(j); if (r.length > best.length) { best = r; src = recent[i].url + (recent[i].op ? ' ' + recent[i].op : ''); }
    }
    var full = best.length >= 3, rows = best;
    if (!full) { var d = domRows(doc); if (d.length > rows.length) { rows = d; src = 'page affichée'; } }
    var diag = '';
    if (!full) {
      var b = { n: 14000 }, seenU = {}, lines = [];
      (net || []).slice(-25).forEach(function (x) { lines.push(new Date(x.at).toISOString().slice(11, 19) + ' ' + x.url + (x.op ? ' [' + x.op + ']' : '') + ' ' + x.text.length + ' o'); });
      var big = recent.slice().sort(function (a, c) { return c.text.length - a.text.length; }).filter(function (x) { var k = x.url + x.op; if (seenU[k]) return false; seenU[k] = 1; return true; }).slice(0, 4);
      big.forEach(function (x) { var j; try { j = JSON.parse(x.text); } catch (e) { return; } lines.push('== ' + x.url + (x.op ? ' [' + x.op + ']' : '') + '\n' + shape(j, 0, b)); });
      diag = 'LUDY ' + V + ' · réponses captées : ' + (net || []).length + '\n' + lines.join('\n') + '\n== LIGNE DE LA PAGE\n' + domSample(doc);
    }
    return { rows: rows, full: full, src: src, diag: diag.slice(0, 19000) };
  }
  if (typeof module !== 'undefined') { module.exports = { rowsOf: rowsOf, read: read, stOf: stOf, plateOf: plateOf, shape: shape, V: V }; return; }
  if (typeof window === 'undefined' || !/(^|\.)uber\.com$/i.test(location.hostname)) return;
  if (window.__ludyURv === V) return;
  window.__ludyURv = V;
  clearInterval(window.__ludyURt);
  function tick() {
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv || !document.body) return;
      var r = read(document, window.__ludyNet || []);
      inv('uber_push', { rows: r.rows, url: location.href.split('?')[0].slice(0, 200), diag: (r.full ? '' : r.diag) || (r.src ? 'source : ' + r.src : ''), full: r.full }).catch(function () { });
    } catch (e) { }
  }
  window.__ludyURt = setInterval(tick, 10000);
  setTimeout(tick, 1500);
})();
