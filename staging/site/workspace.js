// Interface du staging : navigation et raccourcis partagés par tous les modules métier.
const WORKSPACE_ICONS = {
  cockpit: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  direct: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15"/>',
  alertes: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  ops: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3"/>',
  analyse: '<path d="M4 20V4M4 20h17M8 16v-5M13 16V7M18 16V3"/>',
  finance: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M15 14h3M7 5V3h11"/>',
  rh: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/>',
  admin: '<path d="M12 8v8M8 12h8"/><circle cx="12" cy="12" r="9"/>',
  connecteurs: '<path d="m8 3 4 4-5 5-4-4M16 21l-4-4 5-5 4 4M9 15l6-6M3 3l2 2M19 19l2 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  car: '<path d="m5 7 2-4h10l2 4 2 3v8H3v-8zM3 10h18M6 14h2m8 0h2M5 18v3m14-3v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  page: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'
};
function workspaceIcon(name) { return '<svg class="wi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (WORKSPACE_ICONS[name] || WORKSPACE_ICONS.page) + '</svg>'; }
function workspaceTitle(page) { return (NAV.find(n => n[0] === page) || [page, page === 'menu' ? 'Personnaliser mon espace' : 'Ludy'])[1]; }
function workspaceMount(page) {
  const title = document.getElementById('workspace-title');
  if (title) title.textContent = workspaceTitle(page);
  const group = document.getElementById('workspace-section'), key = navGroupOf(page);
  if (group) group.textContent = key === 'rh' ? 'Équipe' : key && NAV_GROUPS[key] ? NAV_GROUPS[key].label : 'Pilotage';
  const side = document.querySelector('.side'), toggle = document.getElementById('workspace-toggle'), backdrop = document.getElementById('workspace-backdrop');
  const setMenu = open => { if (side) side.classList.toggle('mobile-open', open); if (toggle) toggle.setAttribute('aria-expanded', String(open)); if (backdrop) backdrop.hidden = !open; };
  if (toggle) toggle.onclick = () => setMenu(!side.classList.contains('mobile-open'));
  if (backdrop) backdrop.onclick = () => setMenu(false);
  const search = document.getElementById('workspace-search');
  if (search) search.onclick = () => { if (matchMedia('(max-width: 900px)').matches) setMenu(true); const q = document.getElementById('navq'); if (q) q.focus(); };
  setMenu(false);
}
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const b = document.getElementById('workspace-search'); if (b) { e.preventDefault(); b.click(); } }
  if (e.key === 'Escape') { const b = document.getElementById('workspace-backdrop'); if (b && !b.hidden) b.click(); }
});
