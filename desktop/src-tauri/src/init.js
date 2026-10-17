// Injecté par l'application Ludy dans chaque page de sa fenêtre (avant les scripts de la page).
// Le site lit window.LUDY_APP pour afficher le volet « Uber Fleet » ; sur Uber, un bouton ramène à Ludy.
(function () {
  var HOME = 'https://ludy-flotte.pages.dev/';
  window.LUDY_APP = { version: '__VERSION__', uber: '__UBER__' };
  if (!/(^|\.)uber\.com$/.test(location.hostname)) return;
  var add = function () {
    if (!document.body || document.getElementById('ludy-back')) return;
    var b = document.createElement('a'), s = b.style;
    b.id = 'ludy-back'; b.href = HOME + '#/direct'; b.textContent = '← Ludy'; b.title = 'Revenir à Ludy';
    s.position = 'fixed'; s.left = '14px'; s.bottom = '14px'; s.zIndex = '2147483647'; s.background = '#0f2633'; s.color = '#f4efe6';
    s.font = '600 14px/1 system-ui, -apple-system, Segoe UI, sans-serif'; s.padding = '11px 18px'; s.borderRadius = '22px';
    s.boxShadow = '0 4px 14px rgba(0,0,0,.35)'; s.textDecoration = 'none';
    document.body.appendChild(b);
  };
  document.addEventListener('DOMContentLoaded', add);
  setInterval(add, 2000);   // Uber redessine sa page : le bouton revient s'il disparaît
})();
