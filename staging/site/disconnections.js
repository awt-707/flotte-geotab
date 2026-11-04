// Internal service-disconnection notices. Only authenticated local snapshots are read.
// This state deliberately stays separate from Geotab movement/conduct notifications.
const DISCONNECTIONS = { owner: null, snapshot: null, error: '', seen: new Set(), notices: new Map(), loop: null, actions: new Set(), saving: null, revision: 0 };
function disconnectionsNormalize(value) {
  if (!value || !Array.isArray(value.alerts) || typeof value.enabled !== 'boolean' || !['any', 'all'].includes(value.policy) || !['contract', 'shift'].includes(value.duty_mode)) throw new Error('Instantané indisponible.');
  const rows = new Map(), rank = { open: 0, suspended: 1, resolved: 2 };
  for (const row of value.alerts.slice(0, 500)) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 160 || typeof row.driver_id !== 'string' || !row.driver_id || row.driver_id.length > 160 || !['uber', 'bolt'].includes(row.source) || !Object.hasOwn(rank, row.status)) continue;
    const previous = rows.get(row.id); if (previous && rank[previous.status] > rank[row.status]) continue;
    rows.set(row.id, { id: row.id, driver_id: row.driver_id, driver_name: String(row.driver_name || 'Chauffeur').slice(0, 160), source: row.source, status: row.status,
      vehicle_key: typeof row.vehicle_key === 'string' ? row.vehicle_key.slice(0, 160) : null, plate: typeof row.plate === 'string' ? row.plate.slice(0, 80) : null,
      disconnected_at: Number.isFinite(Date.parse(row.disconnected_at)) ? row.disconnected_at : null, observed_online_at: Number.isFinite(Date.parse(row.observed_online_at)) ? row.observed_online_at : null });
  }
  return { at: Number.isFinite(Date.parse(value.at)) ? value.at : null, enabled: value.enabled, policy: value.policy, duty_mode: value.duty_mode,
    expected: Number.isInteger(value.coverage?.expected_drivers) && value.coverage.expected_drivers >= 0 ? value.coverage.expected_drivers : null,
    warnings: (Array.isArray(value.warnings) ? value.warnings : []).filter(w => typeof w === 'string' || typeof w?.message === 'string').slice(0, 8).map(w => typeof w === 'string' ? w.slice(0, 500) : (Number.isSafeInteger(w.count) && w.count > 0 ? w.count + ' · ' : '') + w.message.slice(0, 500)),
    alerts: [...rows.values()].sort((a, b) => (Date.parse(b.disconnected_at) || 0) - (Date.parse(a.disconnected_at) || 0)) };
}
function disconnectionsActive(snapshot = DISCONNECTIONS.snapshot, error = DISCONNECTIONS.error) { return snapshot?.enabled && !error ? snapshot.alerts.filter(a => a.status === 'open') : []; }
function disconnectionsPolicy(policy) { return policy === 'all' ? 'Déconnexion confirmée du chauffeur' : 'Déconnexion d’une plateforme'; }
function disconnectionsTime(at) { return at ? fmtDT(at) : 'Heure non disponible'; }
async function disconnectionsRequest(path = '', body, signal) {
  const token = S.session?.access_token; if (!token) throw new Error('Reconnectez-vous à Ludy.');
  const response = await fetch('/api/fleet/disconnections' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) { const error = new Error(response.status === 401 || response.status === 403 ? 'Accès au suivi des déconnexions indisponible. Reconnectez-vous à Ludy.' : 'Suivi des déconnexions temporairement indisponible.'); error.denied = response.status === 401 || response.status === 403; throw error; }
  return response.json();
}
function disconnectionsClearNotices() { for (const notice of DISCONNECTIONS.notices.values()) notice.node.remove(); DISCONNECTIONS.notices.clear(); document.getElementById('disconnection-toasts')?.remove(); }
function disconnectionsStop() {
  const loop = DISCONNECTIONS.loop; DISCONNECTIONS.loop = null;
  if (loop) { clearInterval(loop.timer); loop.controller?.abort(); document.removeEventListener('visibilitychange', loop.visibility); }
  for (const controller of DISCONNECTIONS.actions) controller.abort(); DISCONNECTIONS.actions.clear(); DISCONNECTIONS.saving = null; DISCONNECTIONS.revision++;
}
function disconnectionsReset() { disconnectionsStop(); disconnectionsClearNotices(); DISCONNECTIONS.owner = null; DISCONNECTIONS.snapshot = null; DISCONNECTIONS.error = ''; DISCONNECTIONS.seen.clear(); }
function disconnectionsStart(my) {
  disconnectionsStop(); const owner = S.session?.user?.id; if (!owner) { disconnectionsReset(); return; }
  if (DISCONNECTIONS.owner !== owner) { disconnectionsReset(); DISCONNECTIONS.owner = owner; }
  const loop = { owner, my, busy: false, controller: null, timer: null, visibility: null }; DISCONNECTIONS.loop = loop;
  const current = () => DISCONNECTIONS.loop === loop && my === ROUTING && S.session?.user?.id === owner;
  loop.read = async () => {
    if (!current() || loop.busy || DISCONNECTIONS.saving || document.hidden) return;
    loop.busy = true; const controller = new AbortController(), revision = DISCONNECTIONS.revision; loop.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const value = await disconnectionsRequest('', undefined, controller.signal);
      if (!current() || document.hidden || controller.signal.aborted || revision !== DISCONNECTIONS.revision) return;
      disconnectionsAccept(value);
    } catch (error) {
      if (!current() || document.hidden || revision !== DISCONNECTIONS.revision) return;
      if (error.denied) DISCONNECTIONS.snapshot = null;
      DISCONNECTIONS.error = error.denied ? error.message : 'Suivi des déconnexions interrompu. Les incidents conservés restent datés.';
      disconnectionsClearNotices(); disconnectionsPaint();
    } finally { clearTimeout(timeout); loop.busy = false; if (loop.controller === controller) loop.controller = null; }
  };
  loop.visibility = () => { if (document.hidden) loop.controller?.abort(); else void loop.read(); };
  document.addEventListener('visibilitychange', loop.visibility); loop.timer = setInterval(loop.read, 2000); disconnectionsPaint(); void loop.read();
}
function disconnectionsAccept(value) {
  DISCONNECTIONS.snapshot = disconnectionsNormalize(value); DISCONNECTIONS.error = '';
  disconnectionsReconcile(); disconnectionsPaint();
}
function disconnectionsCard(alert, view) {
  const active = alert.status === 'open' && DISCONNECTIONS.snapshot?.enabled && !DISCONNECTIONS.error;
  const status = active ? 'Urgence' : alert.status === 'resolved' ? 'Épisode terminé' : alert.status === 'suspended' ? 'Vérification suspendue' : DISCONNECTIONS.error ? 'Dernier état reçu' : 'Surveillance désactivée';
  const provider = alert.source === 'uber' ? 'Uber Fleet' : 'Bolt';
  const id = 'dc-' + view + '-' + alert.id.replace(/[^a-z0-9_-]/gi, '_');
  return `<article class="disconnection-card ${active ? 'urgent' : 'past'}" data-disconnection-id="${esc(alert.id)}"><div class="disconnection-card-heading"><b>${esc(alert.driver_name)}</b><span class="disconnection-label">${status}</span></div><p>Déconnexion pendant le service · <b>${provider}</b>${alert.plate ? ' · ' + esc(alert.plate) : ''}</p><time>Hors ligne observé le ${esc(disconnectionsTime(alert.disconnected_at))}</time>${alert.observed_online_at ? '<small>Dernière connexion observée : ' + esc(disconnectionsTime(alert.observed_online_at)) + '</small>' : ''}<button id="${esc(id)}" class="ghost small" data-dc-driver="${esc(alert.driver_id)}">Voir le chauffeur ${workspaceIcon('arrow')}</button><span class="disconnection-action-status" role="status"></span></article>`;
}
function disconnectionsWrite(node, html) {
  if (node._dcHtml === html) return;
  const focused = node.contains(document.activeElement) ? document.activeElement?.getAttribute('data-dc-driver') : null, open = node.querySelector('[data-dc-history]')?.open;
  node.innerHTML = html; node._dcHtml = html;
  if (open !== undefined && node.querySelector('[data-dc-history]')) node.querySelector('[data-dc-history]').open = open;
  if (focused) [...node.querySelectorAll('[data-dc-driver]')].find(button => button.dataset.dcDriver === focused)?.focus({ preventScroll: true });
}
function disconnectionsPaint() {
  const snapshot = DISCONNECTIONS.snapshot, active = disconnectionsActive(), history = snapshot?.alerts.filter(a => a.status !== 'open' || !snapshot.enabled || !!DISCONNECTIONS.error) || [];
  for (const node of document.querySelectorAll('[data-disconnections-view]')) {
    const view = node.dataset.disconnectionsView, cockpit = view === 'cockpit';
    const summary = DISCONNECTIONS.error || (!snapshot ? 'Lecture des déconnexions en cours…' : !snapshot.enabled ? 'Alerte immédiate désactivée.' : `${snapshot.expected === null ? 'Couverture en cours de vérification' : snapshot.expected + ' chauffeur' + (snapshot.expected === 1 ? '' : 's') + ' attendu' + (snapshot.expected === 1 ? '' : 's') + ' en service'} · ${disconnectionsPolicy(snapshot.policy)}.`);
    const cards = active.slice(0, cockpit ? 3 : 100).map(a => disconnectionsCard(a, view)).join('');
    disconnectionsWrite(node, `<section class="disconnections-panel"><div class="ops-panel-heading"><div><span class="eyebrow">DÉCONNEXIONS EN SERVICE</span><h2>${active.length ? active.length + ' urgence' + (active.length === 1 ? '' : 's') + ' à vérifier' : 'Suivi des déconnexions'}</h2></div>${cockpit ? '<a href="#/alertes">Tous les incidents →</a>' : typeof isAdmin === 'function' && isAdmin() ? '<a href="#/connecteurs">Régler le suivi →</a>' : ''}</div><p class="disconnection-summary ${DISCONNECTIONS.error ? 'warn' : ''}" role="status">${esc(summary)}</p>${snapshot?.warnings.length ? '<div class="disconnection-warnings">' + snapshot.warnings.map(w => '<p>' + esc(w) + '</p>').join('') + '</div>' : ''}${cards || (snapshot?.enabled && !DISCONNECTIONS.error ? '<p class="ops-inline-clear">Aucune déconnexion urgente confirmée.</p>' : '')}${!cockpit && history.length ? '<details data-dc-history><summary>Historique des déconnexions (' + history.length + ')</summary><div class="disconnection-history">' + history.slice(0, 100).map(a => disconnectionsCard(a, view + '-history')).join('') + '</div></details>' : ''}<p class="ops-footnote">Une connexion puis une déconnexion doivent avoir été observées pendant le même ${snapshot?.duty_mode === 'shift' ? 'shift' : 'contrat'}. Un compte jamais connecté pendant ce service ne déclenche pas cette alerte. Le signalement dépend de la prochaine observation reçue d’Uber ou Bolt, selon la cadence de la plateforme.</p></section>`);
    node.onclick = event => { const button = event.target.closest('[data-dc-driver]'); if (button && node.contains(button)) void disconnectionsOpenDriver(button.dataset.dcDriver, button); };
  }
  disconnectionsPaintSettings();
}
async function disconnectionsOpenDriver(id, button) {
  const my = ROUTING, owner = S.session?.user?.id; if (!owner || !id) return;
  button.disabled = true; const status = button.parentElement.querySelector('.disconnection-action-status'); if (status) status.textContent = '';
  try {
    const overview = await fleetApi('overview'); if (my !== ROUTING || S.session?.user?.id !== owner || !button.isConnected) return;
    const drivers = (overview.drivers || []).filter(driver => driver.id === id);
    if (drivers.length !== 1) { if (status) status.textContent = 'Cette fiche n’est plus accessible dans votre flotte.'; return; }
    await fleetHistory(drivers[0], my);
  } catch { if (my === ROUTING && S.session?.user?.id === owner && status?.isConnected) status.textContent = 'Fiche momentanément indisponible. Réessayez.'; }
  finally { if (button.isConnected) button.disabled = false; }
}
function disconnectionsReconcile() {
  const active = disconnectionsActive(), ids = new Set(active.map(a => a.id));
  for (const [id, notice] of DISCONNECTIONS.notices) if (!ids.has(id)) { notice.node.remove(); DISCONNECTIONS.notices.delete(id); }
  for (const alert of active) {
    if (DISCONNECTIONS.seen.has(alert.id)) continue; DISCONNECTIONS.seen.add(alert.id);
    let box = document.getElementById('disconnection-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'disconnection-toasts'; box.setAttribute('aria-label', 'Urgences de déconnexion'); document.body.appendChild(box); }
    const node = document.createElement('div'); node.className = 'disconnection-toast'; node.setAttribute('role', 'alert'); node.dataset.disconnectionId = alert.id;
    node.innerHTML = `<button class="disconnection-close" aria-label="Masquer cette notification">×</button><strong>Déconnexion pendant le service</strong><b>${esc(alert.driver_name)} · ${alert.source === 'uber' ? 'Uber Fleet' : 'Bolt'}</b><p>Hors ligne observé à ${esc(disconnectionsTime(alert.disconnected_at))}${alert.plate ? ' · ' + esc(alert.plate) : ''}</p><button class="ghost small" data-dc-driver="${esc(alert.driver_id)}">Voir le chauffeur</button><span class="disconnection-action-status" role="status"></span>`;
    node.querySelector('[data-dc-driver]').onclick = event => void disconnectionsOpenDriver(alert.driver_id, event.currentTarget);
    node.querySelector('.disconnection-close').onclick = () => { node.remove(); DISCONNECTIONS.notices.delete(alert.id); disconnectionsPaintToastDigest(); };
    DISCONNECTIONS.notices.set(alert.id, { node }); box.prepend(node);
  }
  if (DISCONNECTIONS.seen.size > 1000) for (const id of DISCONNECTIONS.seen) { if (!ids.has(id)) DISCONNECTIONS.seen.delete(id); if (DISCONNECTIONS.seen.size <= 1000) break; }
  disconnectionsPaintToastDigest();
}
function disconnectionsPaintToastDigest() {
  const box = document.getElementById('disconnection-toasts'); if (!box) return;
  const notices = [...DISCONNECTIONS.notices.values()]; notices.forEach((notice, index) => notice.node.hidden = index < notices.length - 2);
  box.querySelector('.disconnection-toast-digest')?.remove();
  if (notices.length > 2) { const link = document.createElement('a'); link.className = 'disconnection-toast-digest'; link.href = '#/alertes'; link.textContent = (notices.length - 2) + ' autres déconnexions à vérifier →'; box.appendChild(link); }
  if (!notices.length) box.remove();
}
function disconnectionsSettingsHtml() {
  return `<section class="connector-card disconnection-settings"><div class="connector-title">${workspaceIcon('alertes')}<div><h2>Déconnexion pendant le service</h2><span class="connector-kind">Urgence interne · Uber et Bolt</span></div></div><form id="disconnections-settings"><label class="alert-enabled"><input id="disconnections-enabled" type="checkbox"> Signaler les déconnexions en service dès leur observation</label><label>Règle de signalement<select id="disconnections-policy" required><option value="all">Déconnexion confirmée du chauffeur</option><option value="any">Déconnexion d’une plateforme</option></select></label><label>Service attendu<select id="disconnections-duty" required><option value="contract">Contrat actif</option><option value="shift">Shift en cours</option></select></label><p>La connexion puis la déconnexion doivent être observées pendant le même service. Un compte jamais connecté pendant ce service ne déclenche pas d’alerte. Le suivi fonctionne même sans affectation véhicule actuelle sur la plateforme. En mode « Contrat actif », le contrat doit identifier un véhicule reconnu dans Ludy.</p><p>Avec « Déconnexion confirmée du chauffeur », tous ses comptes Uber/Bolt connus doivent être explicitement hors ligne avec des données récentes. Une activité sur l’autre plateforme empêche l’urgence ; une donnée manquante suspend la conclusion. Le mode « Déconnexion d’une plateforme » peut signaler une transition même si l’autre source est indisponible. Le signalement dépend de la prochaine observation reçue d’Uber ou Bolt, selon la cadence de la plateforme.</p><button type="submit" class="ghost" disabled>Enregistrer le suivi</button><div id="disconnections-settings-result" role="status"></div><p id="disconnections-settings-state" class="connector-footnote">Lecture du réglage…</p></form></section>`;
}
function disconnectionsPaintSettings() {
  const form = document.getElementById('disconnections-settings'); if (!form) return;
  const snapshot = DISCONNECTIONS.snapshot, state = document.getElementById('disconnections-settings-state');
  if (snapshot && !form.dataset.loaded) { document.getElementById('disconnections-enabled').checked = snapshot.enabled; document.getElementById('disconnections-policy').value = snapshot.policy; document.getElementById('disconnections-duty').value = snapshot.duty_mode; form.dataset.loaded = '1'; }
  form.querySelector('button[type="submit"]').disabled = !snapshot || !!DISCONNECTIONS.saving;
  state.textContent = DISCONNECTIONS.error || (!snapshot ? 'Lecture du réglage…' : snapshot.enabled ? 'Alerte immédiate activée. Notifications internes à Ludy.' : 'Alerte immédiate désactivée. Les autres règles de surveillance restent indépendantes.');
  form.onsubmit = async event => {
    event.preventDefault(); if (!DISCONNECTIONS.snapshot || DISCONNECTIONS.saving || !isAdmin()) return;
    const my = ROUTING, owner = S.session?.user?.id, controller = new AbortController(), task = {}; DISCONNECTIONS.saving = task; DISCONNECTIONS.actions.add(controller); DISCONNECTIONS.revision++; DISCONNECTIONS.loop?.controller?.abort();
    const result = document.getElementById('disconnections-settings-result'), timeout = setTimeout(() => controller.abort(), 12000);
    const body = { enabled: document.getElementById('disconnections-enabled').checked, policy: document.getElementById('disconnections-policy').value, duty_mode: document.getElementById('disconnections-duty').value };
    result.textContent = 'Enregistrement…'; disconnectionsPaintSettings();
    try {
      const saved = await disconnectionsRequest('/settings', body, controller.signal), snapshot = Array.isArray(saved.alerts) ? saved : await disconnectionsRequest('', undefined, controller.signal);
      if (my !== ROUTING || S.session?.user?.id !== owner || !form.isConnected || controller.signal.aborted) return;
      form.dataset.loaded = ''; disconnectionsAccept(snapshot); result.textContent = 'Suivi enregistré.';
    } catch { if (my === ROUTING && S.session?.user?.id === owner && result.isConnected) result.textContent = 'Enregistrement non confirmé. Vérifiez le réglage avant de réessayer.'; }
    finally { clearTimeout(timeout); DISCONNECTIONS.actions.delete(controller); if (DISCONNECTIONS.saving === task) { DISCONNECTIONS.saving = null; disconnectionsPaintSettings(); } }
  };
}
