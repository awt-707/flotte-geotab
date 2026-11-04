// Page « Personnaliser le menu » (#/menu, chaque utilisateur pour lui-même) : favoris en haut du menu, ordre des volets et
// des dossiers (glisser-déposer ou flèches), volets masqués (toujours trouvables par la recherche du menu), retour au menu
// d'origine. Enregistré dans profiles.menu (menuSave, app.js) : le même menu sur tous les appareils de l'utilisateur.
// Chargé avant app.js : utilise ses outils (menuCfg, menuSave, navEntries, navOrdered…) au moment de l'appel.

function pageMenu() {
  const my = ROUTING, cfg = menuCfg(), ents = navOrdered(navEntries(), cfg), hide = new Set(cfg.hide);
  const leaves = [].concat(...ents.map(e => e.leaves)), byId = new Map(leaves.map(l => [l.id, l]));
  const favs = cfg.fav.filter(id => byId.has(id)), favSet = new Set(favs);
  const name = l => l.label + (l.group ? ' (' + l.group + ')' : '');
  const btns = (k, i, n) => `<button type="button" class="ghost small" data-mn="${k}" data-i="${i}" data-d="-1" ${i ? '' : 'disabled'} title="Monter">↑</button>`
    + `<button type="button" class="ghost small" data-mn="${k}" data-i="${i}" data-d="1" ${i < n - 1 ? '' : 'disabled'} title="Descendre">↓</button>`;
  $('#page').innerHTML = `<div class="head"><h1>Personnaliser le menu</h1><div class="sub">Votre menu, rien que pour vous (les autres utilisateurs gardent le leur) : favoris en haut, volets dans l'ordre de votre choix, volets inutiles masqués. Astuce : touche <b>/</b> pour chercher une page, ☆ à côté d'un volet du menu pour l'ajouter aux favoris.</div></div>
    <div class="grid2"><div class="panel"><h2>Favoris (en haut du menu)</h2>
      ${favs.length ? `<ol class="mnlist" data-list="fav">${favs.map((id, i) => `<li draggable="true" data-id="${esc(id)}"><span class="mngrip" aria-hidden="true">⠿</span><span class="mnname">${esc(name(byId.get(id)))}</span>
        <span class="mnact">${btns('fav', i, favs.length)}<button type="button" class="ghost small" data-mnx="${esc(id)}" title="Retirer des favoris">✕</button></span></li>`).join('')}</ol>` : '<div class="small">Aucun favori : en ajouter ici ou avec ☆ dans le menu.</div>'}
      <div class="mfrow"><label>Ajouter <select id="mnadd"><option value="">Choisir une page…</option>${leaves.filter(l => !favSet.has(l.id)).sort((a, b) => name(a).localeCompare(name(b), 'fr')).map(l => `<option value="${esc(l.id)}">${esc(name(l))}</option>`).join('')}</select></label></div></div>
    <div class="panel"><h2>Ordre du menu</h2>
      <ol class="mnlist" data-list="order">${ents.map((e, i) => `<li draggable="true" data-id="${esc(e.id)}" class="${hide.has(e.id) ? 'off' : ''}"><span class="mngrip" aria-hidden="true">⠿</span>
        <span class="mnname">${esc(e.label)}${e.id.startsWith('g:') ? ` <span class="small">dossier : ${esc(e.leaves.map(l => l.label).join(', '))}</span>` : ''}</span>
        <span class="mnact">${btns('order', i, ents.length)}<label class="chk"><input type="checkbox" data-mnh="${esc(e.id)}" ${hide.has(e.id) ? '' : 'checked'}> Afficher</label></span></li>`).join('')}</ol>
      <div class="small">Glisser une ligne (⠿) ou utiliser les flèches. Un volet masqué reste accessible par la recherche du menu.</div>
      <p><button type="button" class="ghost" id="mnreset">Revenir au menu d'origine (ordre alphabétique, aucun favori)</button> <span id="mnout" class="small"></span></p></div></div>`;
  if (my !== ROUTING) return;
  const save = async m => { const ok = await menuSave(m); if (my !== ROUTING) return; pageMenu(); const o = $('#mnout'); if (o) o.textContent = ok ? 'Enregistré.' : 'Enregistré sur cet appareil seulement (exécuter supabase/migrations/20261116000000_menu.sql pour le retrouver partout).'; };
  const cur = () => Object.assign({}, cfg, { fav: favs.slice(), order: ents.map(e => e.id), hide: [...hide] });
  const move = (list, i, j) => { const a = list.slice(), [x] = a.splice(i, 1); a.splice(j, 0, x); return a; };
  document.querySelectorAll('[data-mn]').forEach(b => b.onclick = () => {
    const m = cur(), k = b.dataset.mn, i = +b.dataset.i, j = i + +b.dataset.d;
    m[k] = move(m[k], i, j); save(m);
  });
  document.querySelectorAll('[data-mnx]').forEach(b => b.onclick = () => { const m = cur(); m.fav = m.fav.filter(x => x !== b.dataset.mnx); save(m); });
  document.querySelectorAll('[data-mnh]').forEach(c => c.onchange = () => { const m = cur(); m.hide = c.checked ? m.hide.filter(x => x !== c.dataset.mnh) : m.hide.concat([c.dataset.mnh]); save(m); });
  $('#mnadd').onchange = e => { if (!e.target.value) return; const m = cur(); m.fav.push(e.target.value); save(m); };
  $('#mnreset').onclick = async () => { if (await ask('Revenir au menu d\'origine ?')) save({ fav: [], order: [], hide: [] }); };
  // glisser-déposer dans une même liste
  let drag = null;
  document.querySelectorAll('.mnlist li').forEach(li => {
    li.addEventListener('dragstart', e => { drag = li; li.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch (x) { } });
    li.addEventListener('dragend', () => { li.classList.remove('drag'); document.querySelectorAll('.mnlist li.over').forEach(x => x.classList.remove('over')); });
    li.addEventListener('dragover', e => { if (drag && drag.parentNode === li.parentNode && drag !== li) { e.preventDefault(); li.classList.add('over'); } });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', e => {
      e.preventDefault(); if (!drag || drag.parentNode !== li.parentNode || drag === li) return;
      const k = li.parentNode.dataset.list, ids = [...li.parentNode.children].map(x => x.dataset.id), m = cur();
      m[k] = move(ids, ids.indexOf(drag.dataset.id), ids.indexOf(li.dataset.id)); drag = null; save(m);
    });
  });
}
