// Lecture d'Uber Fleet par l'application Ludy (1.8, 18/11/2026, demande d'Ahmed : ne plus dépendre de l'application de Raphael ;
// n'importe quel ordinateur où l'application Ludy a le volet Uber Fleet ouvert et connecté envoie les états à Ludy).
// Injecté par l'application dans les volets externes ; ne fait rien hors de *.uber.com. Toutes les 10 s, lit ce que la page affiche
// (carte en direct, liste des véhicules / chauffeurs) : pour chaque libellé d'état (« Disponible », « En route vers le lieu de prise en
// charge », « Course en cours »…), la ligne qui le contient et la plaque écrite sur cette ligne. Rien n'est deviné : une ligne sans
// plaque lisible ou sans état reconnu n'est pas envoyée. Envoi à l'application (commande uber_push), qui le passe au site Ludy.
(function () {
  var UR_STATES = [
    [/^disponible$|^available$|^en ligne$|^online$/i, 'available'],
    [/^en route vers le lieu de prise en charge|^en route vers le client|^en route to pick ?up|^en route to rider|^picking up|^arriv(é|ee?) au lieu de prise en charge|^arrived at pick ?up|^en attente du passager|^waiting for rider/i, 'to_pickup'],
    [/^course en cours$|^en course$|^on trip$|^on a trip$|^trip in progress$/i, 'on_trip'],
    [/^hors ligne$|^offline$/i, 'offline']
  ];
  // plaques marocaines : 12345-A-6 / 12345 | A | 6, provisoires WW 123456 / 123456 WW / W18-123456
  var UR_PLATE = /(?<![0-9])(\d{3,6})\s*[-|\/ ]\s*([A-Z؀-ۿ])\s*[-|\/ ]\s*(\d{1,2})(?![0-9])|(?<![A-Z])WW\s*-?\s*(\d{5,6})(?![0-9])|(?<![0-9])(\d{5,6})\s*-?\s*WW(?![A-Z])|(?<![A-Z])W\s*18\s*-?\s*(\d{4,6})(?![0-9])/i;
  function urState(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60) return null;
    for (var i = 0; i < UR_STATES.length; i++) if (UR_STATES[i][0].test(t)) return UR_STATES[i][1];
    return null;
  }
  function urPlate(t) {
    var m = String(t || '').toUpperCase().match(UR_PLATE);
    if (!m) return '';
    if (m[1]) return m[1] + '-' + m[2] + '-' + m[3];
    if (m[4]) return 'WW' + m[4];
    if (m[5]) return 'WW' + m[5];
    return 'W18-' + m[6];
  }
  /** Textes d'un élément, un par nœud de texte (les éléments côte à côte ne sont jamais collés) */
  function urText(el) {
    var out = [], w = el.ownerDocument.createTreeWalker(el, 4), n;
    while ((n = w.nextNode())) { var t = String(n.nodeValue || '').replace(/\s+/g, ' ').trim(); if (t) out.push(t); }
    return out;
  }
  /** Lignes lues dans un document : [{ plate, status, raw, name }] (une par plaque, la dernière lue) */
  function urRead(doc) {
    var out = {}, all = doc.querySelectorAll('body *'), seen = 0;
    for (var i = 0; i < all.length && seen < 3000; i++) {
      var el = all[i];
      if (el.children.length > 0) {
        // libellé d'état écrit directement dans l'élément (pas dans ses enfants)
        var own = ''; for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
        if (!urState(own)) continue;
      }
      var st = urState(el.textContent); if (!st) continue;
      seen++;
      // remonter jusqu'à la ligne qui porte une plaque (au plus 8 niveaux, ligne courte)
      var row = el, plate = '';
      for (var k = 0; k < 8 && row && row !== doc.body; k++) {
        row = row.parentElement; if (!row) break;
        var parts = urText(row), txt = parts.join('\n');
        if (txt.length > 600) break;
        // plusieurs états ou plusieurs plaques : c'est la liste entière, pas une ligne (jamais la plaque d'une autre ligne)
        var nSt = 0, plates = {};
        for (var q = 0; q < parts.length; q++) { if (urState(parts[q])) nSt++; var pq = urPlate(parts[q]); if (pq) plates[pq] = 1; }
        var pk = Object.keys(plates);
        if (nSt > 1 || pk.length > 1) break;
        if (pk.length) { plate = pk[0]; break; }
      }
      if (!plate) continue;
      var lines = urText(row);
      var name = '';
      for (var j = 0; j < lines.length; j++) {
        var s = lines[j];
        if (urState(s) || urPlate(s) || /\d{4}\s|\d{2}:\d{2}|km|min|MAD|DH/i.test(s)) continue;
        if (/^[A-Za-zÀ-ÿ'\-]+(\s+[A-Za-zÀ-ÿ'\-]+){1,4}$/.test(s) && s.length <= 40) { name = s; break; }
      }
      out[plate] = { plate: plate, status: st, raw: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), name: name };
    }
    return Object.keys(out).map(function (p) { return out[p]; });
  }
  if (typeof module !== 'undefined') { module.exports = { urRead: urRead, urState: urState, urPlate: urPlate }; return; }
  if (typeof window === 'undefined' || !/(^|\.)uber\.com$/i.test(location.hostname)) return;
  window.__ludyUberRead = urRead;
  // 1.9 : réponses JSON reçues par la page (données de la carte en temps réel : chauffeurs, états, véhicules), gardées dès le chargement
  // pour la lecture envoyée par le site Ludy (site/uber_read.js) ; rien n'est envoyé ailleurs que dans l'application Ludy
  if (!window.__ludyNetHook) {
    window.__ludyNetHook = 1;
    var NET = window.__ludyNet = window.__ludyNet || [];
    var keep = function (url, op, text) {
      try {
        text = String(text || ''); if (!text || text.length > 3000000) return;
        var c = text.replace(/^\s+/, '').charAt(0); if (c !== '{' && c !== '[') return;
        NET.push({ url: String(url || '').split('?')[0].slice(0, 300), op: op || '', at: Date.now(), text: text });
        while (NET.length > 40) NET.shift();
      } catch (e) { }
    };
    var opOf = function (b) { try { var m = String(b || '').match(/"operationName"\s*:\s*"([^"]{1,80})"/); return m ? m[1] : ''; } catch (e) { return ''; } };
    try {
      var of = window.fetch;
      if (of) window.fetch = function (a, o) {
        var p = of.apply(this, arguments);
        try {
          var u = a && a.url ? a.url : String(a), op = opOf(o && o.body);
          p.then(function (r) { try { if (/json/i.test(r.headers.get('content-type') || '')) r.clone().text().then(function (t) { keep(u, op, t); }, function () { }); } catch (e) { } }, function () { });
        } catch (e) { }
        return p;
      };
    } catch (e) { }
    try {
      var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__lu = u; return xo.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (b) {
        var x = this, op = opOf(b);
        try { x.addEventListener('load', function () { try { var t = x.responseType === 'json' ? JSON.stringify(x.response) : (!x.responseType || x.responseType === 'text') ? x.responseText : ''; keep(x.__lu, op, t); } catch (e) { } }); } catch (e) { }
        return xs.apply(this, arguments);
      };
    } catch (e) { }
  }
  function tick() {
    try {
      if (window.__ludyURv) return;   // lecture du site Ludy en place (1.9) : c'est elle qui envoie
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv || !document.body) return;
      var rows = urRead(document);
      // rien de lu : un extrait du texte visible pour régler la lecture (page pas sur la carte en direct, page changée par Uber)
      var diag = rows.length ? '' : String(document.body.innerText || '').replace(/\s+\n/g, '\n').slice(0, 3000);
      inv('uber_push', { rows: rows, url: location.href.split('?')[0].slice(0, 200), diag: diag }).catch(function () { });
    } catch (e) { }
  }
  setInterval(tick, 10000);
  setTimeout(tick, 4000);
})();
