// Autocomplétion d'adresses gratuite : Photon (komoot, données OpenStreetMap, sans clé ni facturation), limitée au Maroc.
// Champs concernés : <input data-addr> (course rapide, fiche de course, manifeste). Les lieux habituels (aéroports, gares,
// adresses déjà saisies) sont proposés d'abord, sans appel réseau. Sans réseau ou si Photon ne répond pas : champ libre.
const ADDR_API = 'https://photon.komoot.io/api/';
const ADDR_BBOX = '-17.5,20.5,-0.9,36.2';   // Maroc (minLon, minLat, maxLon, maxLat)
const ADDR = { pop: null, input: null, items: [], sel: -1, timer: 0, seq: 0, cache: {}, lang: 'fr', places: [] };

/** Libellé lisible d'un résultat Photon : nom, rue et numéro, quartier, ville (pays seulement hors Maroc) */
function addrLabel(p) {
  p = p || {};
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const city = p.city || p.town || p.village || p.locality || p.county || p.state || '';
  const out = [];
  const foreign = p.countrycode && String(p.countrycode).toUpperCase() !== 'MA' ? p.country : '';
  [p.name, street, p.district, city, foreign].forEach(x => { x = String(x || '').trim(); if (x && !out.some(y => y.toLowerCase() === x.toLowerCase())) out.push(x); });
  return out.join(', ');
}
/** Résultats Photon (GeoJSON) → libellés sans doublon */
function addrParse(json) {
  const seen = new Set(), out = [];
  ((json && json.features) || []).forEach(f => { const l = addrLabel(f.properties); const k = l.toLowerCase(); if (l && !seen.has(k)) { seen.add(k); out.push(l); } });
  return out;
}
/** Lieux habituels qui contiennent tous les mots tapés (sans accents ni majuscules) */
function addrLocal(q, places) {
  const n = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(), w = n(q).split(/\s+/).filter(Boolean);
  return w.length ? (places || []).filter(p => w.every(x => n(p).indexOf(x) >= 0)).slice(0, 5) : [];
}
async function addrFetch(q) {
  const key = q.toLowerCase(); if (ADDR.cache[key]) return ADDR.cache[key];
  const url = l => ADDR_API + '?q=' + encodeURIComponent(q) + '&limit=7&bbox=' + ADDR_BBOX + '&lat=33.57&lon=-7.59' + (l ? '&lang=' + l : '');
  let r = await fetch(url(ADDR.lang));
  if (r.status === 400 && ADDR.lang) { ADDR.lang = ''; r = await fetch(url('')); }   // langue refusée par le serveur : sans langue
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = addrParse(await r.json()); ADDR.cache[key] = res; return res;
}

function addrClose() { if (ADDR.pop) ADDR.pop.hidden = true; ADDR.items = []; ADDR.sel = -1; }
function addrPick(i) {
  const inp = ADDR.input, v = ADDR.items[i]; if (!inp || v === undefined) return;
  inp.value = v; addrClose();
  inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
}
function addrShow(inp, local, remote, note) {
  if (ADDR.input !== inp || document.activeElement !== inp) return;
  const seen = new Set(local.map(x => x.toLowerCase())), items = local.concat(remote.filter(x => !seen.has(x.toLowerCase()))).slice(0, 8);
  ADDR.items = items; ADDR.sel = -1;
  if (!ADDR.pop) { ADDR.pop = document.createElement('div'); ADDR.pop.className = 'addrpop'; ADDR.pop.setAttribute('role', 'listbox'); document.body.appendChild(ADDR.pop);
    ADDR.pop.addEventListener('mousedown', e => { const b = e.target.closest('[data-ai]'); if (b) { e.preventDefault(); addrPick(+b.dataset.ai); } }); }
  if (!items.length && !note) { addrClose(); return; }
  const r = inp.getBoundingClientRect();
  Object.assign(ADDR.pop.style, { left: Math.max(4, r.left) + 'px', top: (r.bottom + 2) + 'px', width: Math.max(r.width, 260) + 'px' });
  ADDR.pop.innerHTML = items.map((x, i) => `<div class="ai" role="option" data-ai="${i}">${esc(x)}</div>`).join('') + (note ? `<div class="small an">${esc(note)}</div>` : '');
  ADDR.pop.hidden = false;
}
function addrMark() { if (!ADDR.pop) return; ADDR.pop.querySelectorAll('[data-ai]').forEach((d, i) => d.classList.toggle('on', i === ADDR.sel)); }
function addrInput(inp) {
  ADDR.input = inp; clearTimeout(ADDR.timer);
  const q = inp.value.trim(), local = addrLocal(q, ADDR.places);
  if (q.length < 3) { addrShow(inp, local, []); return; }
  addrShow(inp, local, [], 'Recherche…');
  const my = ++ADDR.seq;
  ADDR.timer = setTimeout(async () => {
    let remote = [], note = '';
    try { remote = await addrFetch(q); } catch (e) { note = 'Recherche d\'adresse indisponible : saisie libre.'; }
    if (my === ADDR.seq) addrShow(inp, local, remote, note || (remote.length || local.length ? '' : 'Aucune adresse trouvée : saisie libre.'));
  }, 300);
}
/** Lieux habituels proposés avant la recherche (aéroports, gares, adresses déjà utilisées) */
function addrSetPlaces(list) { ADDR.places = [...new Set((list || []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 300); }

if (typeof document !== 'undefined') {   // navigateur seulement (le fichier est aussi chargé par les tests sous Node)
  document.addEventListener('input', e => { if (e.target.matches && e.target.matches('input[data-addr]') && e.isTrusted) addrInput(e.target); });
  document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('input[data-addr]')) { e.target.setAttribute('autocomplete', 'off'); ADDR.input = e.target; } });
  document.addEventListener('focusout', e => { if (e.target === ADDR.input) setTimeout(addrClose, 150); });
  document.addEventListener('keydown', e => {
    if (!ADDR.pop || ADDR.pop.hidden || e.target !== ADDR.input || !ADDR.items.length) return;
    if (e.key === 'ArrowDown') { ADDR.sel = (ADDR.sel + 1) % ADDR.items.length; addrMark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { ADDR.sel = (ADDR.sel - 1 + ADDR.items.length) % ADDR.items.length; addrMark(); e.preventDefault(); }
    else if (e.key === 'Enter' && ADDR.sel >= 0) { addrPick(ADDR.sel); e.preventDefault(); }
    else if (e.key === 'Escape') addrClose();
  });
  window.addEventListener('scroll', addrClose, true);
  window.addEventListener('resize', addrClose);
}
if (typeof module !== 'undefined') module.exports = { addrLabel, addrParse, addrLocal };
