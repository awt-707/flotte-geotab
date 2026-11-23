// Page publique (QR dans les voitures). Deux volets : réserver une course privée (prix façon Uber indicatif, OSRM + tarif) et
// noter la course en cours / laisser une réclamation (étoiles, message, photo). Multilingue (reserve_i18n.js) ; l'avis arrive
// traduit en français côté agence (collecteur). Anon : reservation_tariff (tarif + véhicule + chauffeur du moment),
// create_reservation, create_feedback. Prix indicatif : l'agence confirme.
(function () {
  var CFG = window.FLOTTE_CONFIG || {};
  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  var PHOTON = 'https://photon.komoot.io/api/', BBOX = '-17.5,20.5,-0.9,36.2', OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var app = document.getElementById('app');
  var T = null, tab = 'book', lang = 'fr';
  var pts = { o: null, d: null }, route = null, sending = false;
  var fb = { rating: 0, photo: '' };
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var qget = function (k) { return new URLSearchParams(location.search).get(k) || ''; };
  var money = function (n) { return (Math.round(n) || 0).toLocaleString('fr-FR').replace(/ |,/g, ' ') + ' MAD'; };
  var D = function () { return RESV_I18N[lang] || RESV_I18N.fr; };
  var t = function (k) { return (D()[k] != null ? D() : RESV_I18N.fr)[k] || RESV_I18N.fr[k] || k; };

  function pickLang() {
    var q = qget('lang').toLowerCase().slice(0, 2);
    var nav = (navigator.language || 'fr').toLowerCase().slice(0, 2);
    var has = function (l) { return RESV_I18N[l]; };
    lang = has(q) ? q : has(nav) ? nav : 'fr';
  }

  function start() {
    pickLang();
    sb.rpc('reservation_tariff', { v: qget('v') || null }).then(function (r) { T = (r && !r.error && r.data) || null; render(); }, function () { T = null; render(); });
  }

  function render() {
    document.documentElement.lang = lang; document.body.dir = lang === 'ar' ? 'rtl' : 'ltr';
    var tl = document.getElementById('tagline'); if (tl) tl.textContent = t('tagline');
    if (!T) { app.innerHTML = '<div class="card"><div class="msg err">' + E(t('unavailable')) + '</div></div>' + langBar(); bindLang(); return; }
    if (!T.enabled && tab === 'book') { /* booking off but rating still ok */ }
    var sub = [T.agency, T.vehicle && T.vehicle.plate].filter(Boolean).join(' · ');
    app.innerHTML = langBar() +
      '<div class="tabs"><button data-tab="book" class="' + (tab === 'book' ? 'on' : '') + '">' + E(t('book')) + '</button>' +
      '<button data-tab="rate" class="' + (tab === 'rate' ? 'on' : '') + '">★ ' + E(t('rate')) + '</button></div>' +
      (sub ? '<div class="sub">' + E(sub) + '</div>' : '') +
      '<div id="body"></div>';
    bindLang();
    app.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { tab = b.dataset.tab; render(); }); });
    if (tab === 'book') renderBook(); else renderRate();
  }
  function langBar() {
    return '<div class="langbar"><select id="lang">' + RESV_LANGS.map(function (l) {
      return '<option value="' + l[0] + '"' + (l[0] === lang ? ' selected' : '') + '>' + E(l[1]) + '</option>'; }).join('') + '</select></div>';
  }
  function bindLang() { var s = document.getElementById('lang'); if (s) s.addEventListener('change', function () { lang = s.value; render(); }); }

  // ---------- Réserver ----------
  function renderBook() {
    var body = document.getElementById('body');
    if (!T.enabled) { body.innerHTML = '<div class="msg warn">' + E(t('closed')) + '</div>'; return; }
    var now = new Date(Date.now() + 60 * 60000), pad = function (x) { return String(x).padStart(2, '0'); };
    var defWhen = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    body.innerHTML =
      '<div class="card">' +
        '<div class="acbox"><label>' + E(t('pickup')) + '</label><input id="o" autocomplete="off" placeholder="' + E(t('pickupPh')) + '"><div id="oL"></div></div>' +
        '<div class="acbox"><label>' + E(t('dest')) + '</label><input id="d" autocomplete="off" placeholder="' + E(t('destPh')) + '"><div id="dL"></div></div>' +
        '<div class="row2"><div><label>' + E(t('when')) + '</label><input id="when" type="datetime-local" value="' + defWhen + '"></div>' +
        '<div><label>' + E(t('pax')) + '</label><input id="pax" type="number" min="1" max="60" value="1"></div></div>' +
      '</div><div id="est"></div>' +
      '<div class="card"><label>' + E(t('name')) + '</label><input id="client" autocomplete="name" placeholder="' + E(t('namePh')) + '">' +
        '<label>' + E(t('phone')) + '</label><input id="phone" type="tel" autocomplete="tel" placeholder="06…">' +
        '<label>' + E(t('remark')) + '</label><textarea id="rnote" rows="2" placeholder="' + E(t('remarkPh')) + '"></textarea></div>' +
      '<button class="go" id="send" disabled>' + E(t('send')) + '</button>' +
      '<div class="note" id="notemsg">' + E(T.note || '') + '</div>';
    bindAC(document.getElementById('o'), document.getElementById('oL'), 'o');
    bindAC(document.getElementById('d'), document.getElementById('dL'), 'd');
    document.getElementById('when').addEventListener('change', estimate);
    document.getElementById('send').addEventListener('click', send);
    estimate();
  }
  function bindAC(inp, box, which) {
    var timer = 0, seq = 0;
    inp.addEventListener('input', function () {
      pts[which] = null; route = null; estimate();
      var q = inp.value.trim(); clearTimeout(timer);
      if (q.length < 3) { box.innerHTML = ''; return; }
      timer = setTimeout(function () {
        var my = ++seq;
        fetch(PHOTON + '?q=' + encodeURIComponent(q) + '&limit=6&bbox=' + BBOX + '&lat=33.57&lon=-7.59&lang=' + (lang === 'ar' ? 'default' : lang)).then(function (r) { return r.json(); }).then(function (j) {
          if (my !== seq || document.activeElement !== inp) return;
          var feats = (j && j.features) || [];
          box.innerHTML = '<div class="aclist">' + feats.map(function (f, i) { return '<div data-i="' + i + '">' + E(label(f.properties)) + '</div>'; }).join('') + '</div>';
          box.querySelectorAll('[data-i]').forEach(function (el) {
            el.addEventListener('mousedown', function (e) {
              e.preventDefault(); var f = feats[+el.dataset.i], c = (f.geometry || {}).coordinates || [];
              pts[which] = { label: label(f.properties), lat: +c[1], lon: +c[0] }; inp.value = pts[which].label; box.innerHTML = ''; estimate();
            });
          });
        }).catch(function () { box.innerHTML = ''; });
      }, 300);
    });
    inp.addEventListener('blur', function () { setTimeout(function () { box.innerHTML = ''; }, 200); });
  }
  function label(p) {
    p = p || {}; var out = [], street = [p.housenumber, p.street].filter(Boolean).join(' ');
    var city = p.city || p.town || p.village || p.locality || p.county || '';
    [p.name, street, p.district, city].forEach(function (x) { x = String(x || '').trim(); if (x && out.indexOf(x) < 0) out.push(x); });
    return out.join(', ');
  }
  function estimate() {
    var est = document.getElementById('est'), send = document.getElementById('send');
    if (!est) return;
    if (!pts.o || !pts.d) { est.innerHTML = ''; if (send) send.disabled = true; return; }
    est.innerHTML = '<div class="price"><div class="spin" style="color:#fff">' + E(t('calc')) + '</div></div>';
    var o = pts.o, d = pts.d;
    fetch(OSRM + o.lon + ',' + o.lat + ';' + d.lon + ',' + d.lat + '?overview=false').then(function (r) { return r.json(); }).then(function (j) {
      var rt = j && j.routes && j.routes[0]; route = rt ? { km: rt.distance / 1000, min: rt.duration / 60 } : haversine(o, d); showPrice();
    }).catch(function () { route = haversine(o, d); showPrice(); });
  }
  function haversine(o, d) {
    var R = 6371, rad = function (x) { return x * Math.PI / 180; };
    var a = Math.sin(rad(d.lat - o.lat) / 2), b = Math.sin(rad(d.lon - o.lon) / 2);
    var km = 2 * R * Math.asin(Math.min(1, Math.sqrt(a * a + Math.cos(rad(o.lat)) * Math.cos(rad(d.lat)) * b * b))) * 1.4;
    return { km: km, min: km / 35 * 60, approx: true };
  }
  function hourOf() { var w = document.getElementById('when'); var x = w && w.value ? new Date(w.value) : new Date(); return x.getHours(); }
  function showPrice() {
    var est = document.getElementById('est'), send = document.getElementById('send'); if (!est || !route) { if (est) est.innerHTML = ''; return; }
    var p = resvPrice(route.km, route.min, T, hourOf());
    est.innerHTML = '<div class="price"><div class="lbl">' + E(t('estimate')) + '</div><div class="big">' + E(money(p.total)) + '</div>' +
      '<div class="det">' + E(Math.round(route.km) + ' km · ' + Math.round(route.min) + ' min' + (route.approx ? ' (' + t('approx') + ')' : '') + (p.night ? ' · ' + t('night') : '')) + '</div></div>';
    if (send) send.disabled = false;
  }
  function send() {
    if (sending) return;
    var g = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    if (!g('client') || !g('phone')) { note(t('needNP'), 'warn'); return; }
    if (!pts.o || !pts.d || !route) { note(t('needTrip'), 'warn'); return; }
    sending = true; var btn = document.getElementById('send'); btn.disabled = true; btn.textContent = t('sending');
    var when = g('when');
    var payload = { v: qget('v') || null, client: g('client'), phone: g('phone'), when: when ? new Date(when).toISOString() : null, hour: hourOf(),
      pax: +g('pax') || 1, originLabel: pts.o.label, originLat: pts.o.lat, originLon: pts.o.lon, destLabel: pts.d.label, destLat: pts.d.lat, destLon: pts.d.lon,
      km: Math.round(route.km * 10) / 10, min: Math.round(route.min), note: g('rnote') };
    sb.rpc('create_reservation', { p: payload }).then(function (r) {
      sending = false;
      if (r.error) { btn.disabled = false; btn.textContent = t('send'); note(r.error.message, 'err'); return; }
      var num = (r.data && r.data.number) || '';
      app.innerHTML = langBar() + '<div class="card done"><div class="chk">✅</div><div class="ref">' + E(t('sentTitle')) + '</div>' +
        '<div class="sub">' + E(t('sentSub')) + (num ? ' (' + t('ref') + ' ' + E(num) + ')' : '') + '.</div>' +
        '<div class="msg ok">' + E(t('estimate') + ' : ' + money((r.data && r.data.estimate) || resvPrice(route.km, route.min, T, hourOf()).total) + ' (' + t('indic') + ')') + '</div></div>';
      bindLang();
    }, function () { sending = false; btn.disabled = false; btn.textContent = t('send'); note(t('unavailable'), 'err'); });
  }
  function note(txt, cls) { var n = document.getElementById('notemsg'); if (n) n.outerHTML = '<div class="msg ' + cls + '" id="notemsg">' + E(txt) + '</div>'; }

  // ---------- Noter / réclamation ----------
  function renderRate() {
    var body = document.getElementById('body');
    var ride = [T.driver ? t('driver') + ' : ' + T.driver : '', T.vehicle && T.vehicle.plate ? t('vehicle') + ' : ' + T.vehicle.plate : ''].filter(Boolean).join(' · ');
    body.innerHTML =
      '<div class="card">' + (ride ? '<div class="ride"><b>' + E(t('ride')) + '</b><div class="small">' + E(ride) + '</div></div>' : '') +
        '<label>' + E(t('stars')) + '</label><div class="stars" id="stars">' + [1, 2, 3, 4, 5].map(function (i) { return '<span data-s="' + i + '">★</span>'; }).join('') + '</div>' +
        '<label>' + E(t('msg')) + '</label><textarea id="fcomment" rows="4" placeholder="' + E(t('msgPh')) + '"></textarea>' +
        '<label>' + E(t('photo')) + '</label><input id="fphoto" type="file" accept="image/*" capture="environment"><div id="fthumb"></div>' +
      '</div>' +
      '<button class="go" id="rsend">' + E(t('rsend')) + '</button><div class="note" id="notemsg"></div>';
    paintStars();
    body.querySelectorAll('#stars span').forEach(function (el) { el.addEventListener('click', function () { fb.rating = +el.dataset.s; paintStars(); }); });
    document.getElementById('fphoto').addEventListener('change', onPhoto);
    document.getElementById('rsend').addEventListener('click', sendFeedback);
  }
  function paintStars() { var s = document.getElementById('stars'); if (s) s.querySelectorAll('span').forEach(function (el) { el.classList.toggle('on', +el.dataset.s <= fb.rating); }); }
  function onPhoto(e) {
    var f = e.target.files && e.target.files[0]; if (!f) { fb.photo = ''; return; }
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () {
      var max = 1200, w = img.width, h = img.height; if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h);
      try { fb.photo = cv.toDataURL('image/jpeg', 0.7); } catch (x) { fb.photo = ''; }
      URL.revokeObjectURL(url);
      var th = document.getElementById('fthumb'); if (th) th.innerHTML = fb.photo ? '<img src="' + fb.photo + '" class="thumb">' : '';
    };
    img.onerror = function () { fb.photo = ''; URL.revokeObjectURL(url); };
    img.src = url;
  }
  function sendFeedback() {
    if (sending) return;
    var cmt = (document.getElementById('fcomment') || {}).value || '';
    if (!fb.rating && !cmt.trim() && !fb.photo) { note(t('rateEmpty'), 'warn'); return; }
    sending = true; var btn = document.getElementById('rsend'); btn.disabled = true; btn.textContent = t('sending');
    sb.rpc('create_feedback', { p: { v: qget('v') || null, rating: fb.rating, lang: lang, comment: cmt, photo: fb.photo || null } }).then(function (r) {
      sending = false;
      if (r.error) { btn.disabled = false; btn.textContent = t('rsend'); note(r.error.message, 'err'); return; }
      app.innerHTML = langBar() + '<div class="card done"><div class="chk">🙏</div><div class="ref">' + E(t('thanksTitle')) + '</div><div class="sub">' + E(t('thanksSub')) + '</div></div>';
      bindLang();
    }, function () { sending = false; btn.disabled = false; btn.textContent = t('rsend'); note(t('unavailable'), 'err'); });
  }

  if (window.supabase && CFG.SUPABASE_URL) start(); else app.innerHTML = '<div class="card"><div class="msg err">Erreur</div></div>';
})();
