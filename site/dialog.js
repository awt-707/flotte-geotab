// Fenêtres de confirmation, de saisie et de message dessinées par le site (ask, askText, uiNote).
// L'application Mac (WKWebView, Tauri / wry) n'affiche ni confirm(), ni prompt(), ni alert() : confirm() y renvoie toujours
// « non », d'où des boutons sans effet (annulation d'une course…). Dans l'application, ces fenêtres sont donc dessinées dans
// la page ; dans un navigateur, les fenêtres du navigateur restent utilisées. Chargé avant les pages (index.html).

/** Fenêtres dessinées par le site : dans l'application Ludy (window.LUDY_APP), ou forcées pour les tests (window.__uiDialogs) */
function uiOwnDialogs() { return !!(window.LUDY_APP || window.__uiDialogs); }

function uiDialog(text, o) {
  return new Promise(resolve => {
    const prev = document.activeElement, box = document.createElement('div');
    box.className = 'uidlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    box.innerHTML = `<div class="uidlg-card"><div class="uidlg-text">${e(text).replace(/\n/g, '<br>')}</div>
      ${o.input ? `<input id="uiin" type="text" value="${e(o.def || '')}">` : ''}
      <div class="uidlg-go"><button type="button" id="uiok">${e(o.ok || 'OK')}</button>${o.cancel ? `<button type="button" class="ghost" id="uino">${e(o.cancel)}</button>` : ''}</div></div>`;
    document.body.appendChild(box);
    const done = v => { document.removeEventListener('keydown', key, true); box.remove(); try { if (prev && prev.focus) prev.focus(); } catch (x) { } resolve(v); };
    const yes = () => done(o.input ? box.querySelector('#uiin').value : true), no = () => done(o.input ? null : false);
    const key = ev => { if (ev.key === 'Escape') { ev.preventDefault(); o.cancel ? no() : yes(); } else if (ev.key === 'Enter') { ev.preventDefault(); yes(); } };
    document.addEventListener('keydown', key, true);
    box.querySelector('#uiok').onclick = yes;
    if (o.cancel) box.querySelector('#uino').onclick = no;
    const f = box.querySelector(o.input ? '#uiin' : '#uiok'); if (f) { f.focus(); if (o.input && f.select) f.select(); }
  });
}
/** Confirmation : Promise<boolean> (remplace confirm()) */
function ask(text) { return uiOwnDialogs() ? uiDialog(text, { ok: 'OK', cancel: 'Annuler' }) : Promise.resolve(window.confirm(text)); }
/** Saisie : Promise<texte | null> (remplace prompt()) */
function askText(text, def) { return uiOwnDialogs() ? uiDialog(text, { input: true, def, ok: 'OK', cancel: 'Annuler' }) : Promise.resolve(window.prompt(text, def == null ? '' : def)); }
/** Message (remplace alert(), sans attendre la réponse) */
function uiNote(text) { if (uiOwnDialogs()) { uiDialog(text, { ok: 'OK' }); return; } window.__nativeAlert(text); }
window.__nativeAlert = window.alert.bind(window);
// alert() de toutes les pages : dessiné par le site dans l'application (sinon rien ne s'affiche sur Mac)
window.alert = text => uiNote(text);
