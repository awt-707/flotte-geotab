// Volet « Avis clients » (23/11/2026) : notes, messages et réclamations laissés par les clients via le QR des voitures.
// Message traduit en français par le collecteur (comment_fr). Rattaché à la plaque et au chauffeur présent au moment de l'avis.
// Gestionnaire : ses agences (RLS) ; administrateur : tout. Statut Nouveau / Traité (feedback_set).
async function pageAvis() {
  const my = ROUTING;
  const head = `<div class="head"><h1>Avis clients</h1><div class="sub">Notes, messages et réclamations laissés par les clients en scannant le QR dans les voitures. Le message est traduit en français ; la plaque et le chauffeur sont ceux du moment de l'avis.</div></div>`;
  if (!canSee('avis')) { $('#page').innerHTML = head + msg('Accès réservé.', 'warn'); return; }
  const f = lsJSON('avisFilter') || { s: 'Nouveau' };
  $('#page').innerHTML = head + `<div class="bar">
    <label>Afficher <select id="avs"><option${f.s === 'Nouveau' ? ' selected' : ''}>Nouveau</option><option${f.s === 'Traité' ? ' selected' : ''}>Traité</option><option${f.s === 'Tous' ? ' selected' : ''}>Tous</option></select></label>
    <button class="ghost small" id="avrefresh">Actualiser</button></div><div id="avlist" class="loading">Chargement…</div>`;
  $('#avs').onchange = () => { lsSet('avisFilter', { s: $('#avs').value }); pageAvis(); };
  $('#avrefresh').onclick = () => pageAvis();
  let rows;
  try { rows = await all('client_feedback', '*', q => { const s = $('#avs').value; return s === 'Tous' ? q : q.eq('status', s); }, ['created_at', false]); }
  catch (e) { if (my === ROUTING) $('#avlist').innerHTML = msg('Avis pas encore installés : exécuter <b>supabase/migrations/20261218000000_reservation_qr.sql</b>. (' + esc(e.message) + ')', 'err'); return; }
  if (my !== ROUTING) return;
  const a = agFilter();
  if (a) rows = rows.filter(r => String(r.agency_id) === a);
  if (!rows.length) { $('#avlist').innerHTML = '<div class="empty">Aucun avis.</div>'; return; }
  $('#avlist').innerHTML = rows.map(avCard).join('');
  $('#avlist').querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const r = await sb.rpc('feedback_set', { p_id: +b.dataset.done, p_status: b.dataset.st || 'Traité' });
    if (r.error) { alert(r.error.message); b.disabled = false; return; }
    pageAvis();
  });
}
function avStars(n) { n = +n || 0; return n ? '<span class="avstars">' + '★'.repeat(n) + '<span class="o">' + '★'.repeat(5 - n) + '</span></span>' : ''; }
function avCard(r) {
  const txt = r.comment_fr || r.comment || '';
  const orig = r.comment && r.comment_fr && r.comment !== r.comment_fr ? r.comment : '';
  const lang = r.lang && r.lang !== 'fr' ? r.lang.toUpperCase() : '';
  const crit = r.rating && r.rating <= 2;
  return `<div class="avcard${crit ? ' crit' : ''}">
    <div class="avhead"><span>${avStars(r.rating)}${crit ? ' <span class="avbad">⚠ note basse</span>' : ''}</span><span class="small">${esc(fmtDTY(r.created_at))}</span></div>
    <div class="small">${r.plate ? plate(r.plate) : 'Véhicule inconnu'}${r.driver_name ? ' · ' + esc(r.driver_name) : ''}${r.contract_num ? ' · contrat ' + esc(r.contract_num) : ''}</div>
    ${txt ? `<div class="avmsg">${esc(txt)}${lang ? ' <span class="avlang">traduit de ' + esc(lang) + '</span>' : ''}</div>` : ''}
    ${orig ? `<div class="small avorig">« ${esc(orig)} »</div>` : ''}
    ${r.photo ? `<a href="${esc(r.photo)}" target="_blank" rel="noopener"><img class="avphoto" src="${esc(r.photo)}" alt="photo"></a>` : ''}
    <div class="avfoot"><span class="badge ${r.status === 'Traité' ? 'ok' : 'warn'}">${esc(r.status)}</span>
      ${r.status === 'Nouveau' ? `<button class="small" data-done="${r.id}" data-st="Traité">Marquer traité</button>` : `<button class="small ghost" data-done="${r.id}" data-st="Nouveau">Rouvrir</button>`}</div></div>`;
}
