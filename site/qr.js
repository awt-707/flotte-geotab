// Page « Réservation QR » (administrateur) : affiches QR à mettre dans les voitures. Un QR renvoie vers la page publique
// site/reserver.html (clients : réservation d'une course privée, prix façon Uber indicatif). QR générique (toutes voitures) ou
// par véhicule (?v=<clé> : l'agence du véhicule est reprise sur la demande). Tarif réglé dans Réglages (paramètres resv…).
let QR = { lib: null };
function qrUrl(key) { return location.origin + '/reserver.html' + (key ? '?v=' + encodeURIComponent(key) : ''); }
/** Bibliothèque QR (qrcode-generator) chargée à la demande */
function qrLib() {
  if (QR.lib) return Promise.resolve(QR.lib);
  if (window.qrcode) { QR.lib = window.qrcode; return Promise.resolve(QR.lib); }
  return new Promise((res, rej) => { const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
    s.onload = () => { QR.lib = window.qrcode; res(QR.lib); }; s.onerror = () => rej(new Error('QR non chargé')); document.head.appendChild(s); });
}
/** SVG d'un QR (chaîne) */
function qrSvg(url, cell) {
  const qr = QR.lib(0, 'M'); qr.addData(url); qr.make();
  return qr.createSvgTag({ cellSize: cell || 6, margin: 2, scalable: true });
}
async function pageQr() {
  const head = `<div class="head"><h1>Réservation QR</h1><div class="sub">Affiches à coller dans les voitures : le client scanne, réserve une course privée et reçoit une estimation (tarif façon Uber, +${esc(String((S.P && S.P.resvMarkupPct) || 10))} %, réglable). La demande arrive dans <a href="#/courses">Courses privées</a> en « Demande » ; vous confirmez le prix.</div></div>`;
  if (!isAdmin()) { $('#page').innerHTML = head + msg('Réservé à l\'administrateur.', 'warn'); return; }
  $('#page').innerHTML = head + '<div class="loading">Chargement…</div>';
  try { await qrLib(); } catch (e) { $('#page').innerHTML = head + msg('Bibliothèque QR non chargée (réseau) : réessayez.', 'err'); return; }
  const enabled = String((S.P && S.P.resvEnabled) || 'oui').toLowerCase();
  const on = ['oui', 'true', '1'].includes(enabled);
  const vehs = (S.vehList || []).slice().sort((a, b) => String(a.plate).localeCompare(String(b.plate)));
  $('#page').innerHTML = head +
    (on ? '' : msg('Les réservations en ligne sont désactivées (Réglages &gt; « Réservation QR : activée »). La page publique affiche « réservations fermées ».', 'warn')) +
    `<div class="panel"><h2>Tarif</h2><div class="small">Réglé dans <a href="#/reglages">Réglages</a> : prise en charge ${esc(String((S.P && S.P.resvBase) || '?'))} MAD · ${esc(String((S.P && S.P.resvPerKm) || '?'))} MAD/km · ${esc(String((S.P && S.P.resvPerMin) || '?'))} MAD/min · course min ${esc(String((S.P && S.P.resvMinFare) || '?'))} MAD · majoration ${esc(String((S.P && S.P.resvMarkupPct) || '?'))} % · nuit +${esc(String((S.P && S.P.resvNightPct) || '0'))} %. Aucun prix Uber en direct n'est récupérable (API fermée) : le prix est calculé par Ludy à partir de la distance et de la durée réelles.</div></div>
    <div class="panel"><h2>QR générique (toutes les voitures)</h2>
      <div class="qrcard" id="qrgen"></div>
      <div class="mfgo"><button class="small" id="qrgenprint">Imprimer l'affiche</button> <button class="small ghost" id="qrgendl">Télécharger (SVG)</button> <button class="small ghost" id="qrgenall" ${vehs.length ? '' : 'disabled'}>Imprimer une affiche par véhicule (${vehs.length})</button></div>
      <div class="small">Lien : <code>${esc(qrUrl(''))}</code></div></div>
    <div class="panel"><h2>QR par véhicule</h2>
      <div class="mfrow"><label>Véhicule <select id="qrveh"><option value="">Choisir…</option>${vehs.map(v => `<option value="${esc(v.key)}">${esc(v.plate)}${v.model ? ' · ' + esc(v.model) : ''}</option>`).join('')}</select></label></div>
      <div class="qrcard" id="qrvehbox"></div>
      <div class="mfgo"><button class="small" id="qrvehprint" disabled>Imprimer l'affiche</button> <button class="small ghost" id="qrvehdl" disabled>Télécharger (SVG)</button></div>
      <div class="small">Le QR du véhicule rattache la demande à son agence. Sinon, QR générique.</div></div>`;
  // QR générique
  $('#qrgen').innerHTML = qrSvg(qrUrl(''), 6);
  $('#qrgenprint').onclick = () => qrPoster(qrUrl(''), 'Réservez votre course', '');
  $('#qrgendl').onclick = () => qrDownload(qrUrl(''), 'reservation-ludy');
  $('#qrgenall').onclick = () => qrPosterAll(vehs);
  $('#qrveh').onchange = () => {
    const key = $('#qrveh').value, v = vehs.find(x => x.key === key);
    if (!key) { $('#qrvehbox').innerHTML = ''; $('#qrvehprint').disabled = $('#qrvehdl').disabled = true; return; }
    $('#qrvehbox').innerHTML = qrSvg(qrUrl(key), 6);
    $('#qrvehprint').disabled = $('#qrvehdl').disabled = false;
    $('#qrvehprint').onclick = () => qrPoster(qrUrl(key), 'Réservez votre course', (v && v.plate || '') + (v && v.model ? ' · ' + v.model : ''));
    $('#qrvehdl').onclick = () => qrDownload(qrUrl(key), 'reservation-' + (v ? normPlate(v.plate) : key));
  };
}
/** Affiche imprimable (fenêtre autonome, hors CSP du site) */
function qrPosterHtml(url, title, subtitle) {
  return `<div class="poster"><img src="${location.origin}/logo-ludy-sombre.png" onerror="this.style.display='none'" class="lg">
    <h1>${esc(title)}</h1><p class="s">${esc(subtitle || '')}</p>
    <div class="qr">${qrSvg(url, 8)}</div>
    <p class="scan">📱 Scannez ce QR code avec votre téléphone</p>
    <ol><li>Indiquez votre destination</li><li>Recevez une estimation de prix</li><li>Notre agence vous rappelle pour confirmer</li></ol>
    <p class="ft">Ludy · Transport privé avec chauffeur</p></div>`;
}
function qrPosterOpen(body) {
  const w = window.open('', '_blank'); if (!w) { alert('Autorisez les fenêtres pour imprimer.'); return; }
  w.document.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Affiche réservation</title><style>' +
    'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a2330;margin:0}' +
    '.poster{page-break-after:always;text-align:center;padding:40px 30px;max-width:620px;margin:0 auto}' +
    '.poster .lg{height:46px;margin-bottom:10px}.poster h1{font-size:30px;margin:6px 0}.poster .s{color:#5d6b78;font-size:16px;margin:0 0 14px}' +
    '.poster .qr{width:300px;margin:10px auto}.poster .qr svg{width:100%;height:auto}' +
    '.poster .scan{font-size:17px;font-weight:600;margin:14px 0 6px}.poster ol{display:inline-block;text-align:left;color:#333;font-size:15px;line-height:1.6}' +
    '.poster .ft{color:#7b1e2e;font-weight:600;margin-top:16px}@media print{.poster{padding:24px}}</style></head><body>' +
    body + '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print()},150)}</scr' + 'ipt></body></html>');
  w.document.close();
}
function qrPoster(url, title, subtitle) { qrPosterOpen(qrPosterHtml(url, title, subtitle)); }
function qrPosterAll(vehs) { qrPosterOpen(vehs.map(v => qrPosterHtml(qrUrl(v.key), 'Réservez votre course', v.plate + (v.model ? ' · ' + v.model : ''))).join('')); }
function qrDownload(url, name) {
  const svg = qrSvg(url, 8), blob = new Blob([svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')], { type: 'image/svg+xml' });
  const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name + '.svg'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
}
