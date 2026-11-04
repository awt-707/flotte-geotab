// Operational views. Provider reads are owned by the local server; live views share its cache.
const OPS = { overview: null, overviewAt: 0, overviewBusy: null, owner: null, map: null, abort: null, paint: null, selected: '', mapFilter: '', mapQuery: '', mapProvider: '', report: null, notices: new Map() };
function opsClearNotifications() { for (const n of OPS.notices.values()) { clearTimeout(n.timer); n.node.remove(); } OPS.notices.clear(); document.getElementById('ops-alert-digest')?.remove(); }
function opsReconcileNotifications(alerts) {
  const active = new Set(alerts.map(a => a.id));
  for (const [id, notice] of OPS.notices) if (!active.has(id)) { clearTimeout(notice.timer); notice.node.remove(); OPS.notices.delete(id); }
  const box = document.getElementById('toasts'); if (box) opsPaintAlertDigest(box);
}
function opsPaintAlertDigest(box) {
  const collapsed = [...OPS.notices.values()].filter(n => n.collapsed), old = document.getElementById('ops-alert-digest');
  if (!collapsed.length || !box.isConnected) { old?.remove(); return; }
  const digest = old || document.createElement('div'); digest.id = 'ops-alert-digest'; digest.className = 'toast ops-alert-digest';
  digest.innerHTML = `<a href="#/alertes">${workspaceIcon('alertes')}<span><b>${collapsed.length} signalement${collapsed.length === 1 ? '' : 's'} reçu${collapsed.length === 1 ? '' : 's'}</b><small>Ouvrir le centre d’alertes</small></span>${workspaceIcon('arrow')}</a><button class="x" aria-label="Masquer les notifications">×</button>`;
  digest.querySelector('.x').onclick = opsClearNotifications; if (!old) box.appendChild(digest);
}
function opsTrackAlertToast(node, alert, box) {
  const previous = OPS.notices.get(alert.id); if (previous) { clearTimeout(previous.timer); previous.node.remove(); }
  const item = { node, collapsed: false, timer: null }; OPS.notices.set(alert.id, item); node.classList.add('ops-new-alert');
  const collapse = () => {
    if (node.contains(document.activeElement)) { item.timer = setTimeout(collapse, 3000); return; }
    clearTimeout(item.timer); item.collapsed = true; node.remove(); opsPaintAlertDigest(box);
  };
  item.collapse = collapse; node.querySelector('.x').onclick = () => { node.querySelector('.x').blur(); collapse(); };
  item.timer = setTimeout(collapse, 12000);
  const full = [...OPS.notices.values()].filter(n => !n.collapsed); full.slice(0, Math.max(0, full.length - 2)).forEach(n => n.collapse());
  while (OPS.notices.size > 100) { const key = OPS.notices.keys().next().value, n = OPS.notices.get(key); clearTimeout(n.timer); n.node.remove(); OPS.notices.delete(key); }
  opsPaintAlertDigest(box);
}
function operationsCleanup() {
  OPS.abort?.abort(); OPS.abort = null; OPS.paint = null;
  // Let the next route read its own snapshot; late completions keep their token.
  if (typeof LIVE !== 'undefined') { LIVE.request = null; LIVE.busy = false; }
  OPS.zonesNavigation?.cleanup(); OPS.zonesNavigation = null;
  if (OPS.map) { OPS.map.remove(); OPS.map = null; }
  document.getElementById('ops-vehicle-drawer')?.remove();
  if (typeof MAP !== 'undefined' && MAP) { Object.values(LIVE.markers || {}).forEach(m => cancelAnimationFrame(m._anim)); MAP.remove(); MAP = null; LIVE.markers = {}; }
  if (OPS.owner !== S.session?.user?.id) { OPS.overview = null; OPS.overviewAt = 0; OPS.report = null; OPS.mapQuery = ''; OPS.mapFilter = ''; OPS.mapProvider = ''; OPS.selected = ''; OPS.owner = S.session?.user?.id; }
}
function opsHTML(id, html) {
  const e = document.getElementById(id); if (!e || e._html === html) return;
  const disclosures = [...e.querySelectorAll('details[data-disclosure]')].map(d => [d.dataset.disclosure, d.open]), focused = document.activeElement;
  const attr = e.contains(focused) && ['id', 'href', 'data-id', 'data-la'].find(a => focused.hasAttribute(a)), value = attr && focused.getAttribute(attr);
  e.innerHTML = html; e._html = html;
  for (const [key, open] of disclosures) { const d = [...e.querySelectorAll('details[data-disclosure]')].find(d => d.dataset.disclosure === key); if (d) d.open = open; }
  if (attr) [...e.querySelectorAll('a,button,input,select,summary')].find(n => n.getAttribute(attr) === value)?.focus({ preventScroll: true });
}
function opsHeader(eyebrow, title, subtitle, actions = '') { return `<div class="ops-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="ops-heading-actions">${actions}</div></div>`; }
function opsLink(href, text, icon = 'arrow', primary = false) { return `<a class="button-link ${primary ? '' : 'secondary'}" href="${href}">${workspaceIcon(icon)} ${text}</a>`; }
function opsVehicles() { return (S.vehList || []).filter(v => inAgency()(v.key)); }
function opsNumber(value, digits = 1) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('fr-FR', { maximumFractionDigits: digits }); }
function opsDuration(minutes) { if (minutes == null || !Number.isFinite(Number(minutes))) return '—'; const total = Math.round(Number(minutes)); return Math.floor(total / 60) + ' h ' + String(total % 60).padStart(2, '0'); }
function opsStat(label, value, foot = '', tone = '') { return `<div class="ops-stat ${tone}"><span>${label}</span><strong>${value}</strong>${foot ? `<small>${foot}</small>` : ''}</div>`; }
function opsSourceStrip(sources) { return `<div class="ops-source-strip">${Object.entries(FLEET_PROVIDERS).map(([id, name]) => { const s = sources?.find(s => s.id === id), [label, tone] = fleetSourceState(s); return `<a href="${isAdmin() ? '#/connecteurs' : '#/cockpit'}" class="ops-source ${tone}" title="${esc(name + ' · ' + label + ' · ' + (s?.last_success_at ? fleetAgo(s.last_success_at) : 'Aucune lecture'))}"><i></i><b>${name}</b><span>${label}</span></a>`; }).join('')}</div>`; }
async function opsOverview(force = false) {
  const user = S.session?.user?.id, sessionRevision = S.sessionRevision;
  if (OPS.owner !== user || OPS.overviewRevision !== sessionRevision) { OPS.owner = user; OPS.overview = null; OPS.overviewAt = 0; OPS.overviewRevision = sessionRevision; }
  if (!user) throw new Error('Reconnectez-vous à Ludy.');
  if (!force && OPS.overview && Date.now() - OPS.overviewAt < 12000) return OPS.overview;
  if (OPS.overviewBusy?.owner === user && OPS.overviewBusy.sessionRevision === sessionRevision) return OPS.overviewBusy.promise;
  const request = { owner: user, sessionRevision, promise: null }; OPS.overviewBusy = request;
  request.promise = fleetApi('overview').then(data => {
    if (S.session?.user?.id !== user || S.sessionRevision !== sessionRevision || OPS.overviewBusy !== request) throw new Error('La session a changé.');
    OPS.overview = data;
    if(Array.isArray(data.vehicles)){S.vehList=data.vehicles.map(v=>({...S.veh?.[v.key],...v}));S.veh=Object.fromEntries(S.vehList.map(v=>[v.key,v]));}
    OPS.overviewAt = Date.now(); return data;
  }).finally(() => { if (OPS.overviewBusy === request) OPS.overviewBusy = null; });
  return request.promise;
}

function opsOnlineDrivers(data=OPS.overview){return fleetRosterSummary(opsCockpitScope(data?.drivers||[])).recent.filter(d=>['available','on_trip','to_pickup','on_break'].some(state=>fleetHasState(d,state)));}
function opsUnlocatedDriversHtml(rows){const online=opsOnlineDrivers(),missing=online.filter(d=>!d.vehicle_key||opsDriverForVehicle(d.vehicle_key)?.id!==d.id||!rows.some(r=>r.vehicle_key===d.vehicle_key&&r.live&&Number.isFinite(r.lat)&&Number.isFinite(r.lon)));return `<details class="ops-unlocated" data-disclosure="unlocated-drivers"><summary>${online.length} chauffeur(s) en ligne · ${missing.length} sans position GPS actuelle confirmée</summary><p>Les profils Uber/Bolt restent comptés même sans véhicule associé ou sans boîtier. La carte ne place que les positions réellement reçues.</p><div class="ops-unlocated-list">${missing.map(d=>`<a href="#/performance-chauffeur?driver_id=${encodeURIComponent(d.id)}"><b>${esc(d.name)}</b><small>${esc(d.vehicle_label||S.veh?.[d.vehicle_key]?.plate||'Véhicule à identifier')}</small>${opsPlatformPills(d)}</a>`).join('')||'<span>Tous les chauffeurs en ligne ont une position associée récente.</span>'}</div></details>`;}
function operationsSnapshot() { if (OPS.paint) OPS.paint(); }
function opsDriverForVehicle(key) {
  const owner = S.session?.user?.id, age = Date.now() - OPS.overviewAt;
  if (!owner || OPS.owner !== owner || !Number.isFinite(age) || age < 0 || age > 30000) return null;
  const rows = (OPS.overview?.drivers || []).filter(d => d.vehicle_key === key); if (rows.length !== 1) return null;
  const driver = rows[0]; if (driver.vehicle_conflict) return null;
  if (!['platform_plate', 'myclicar_contract'].includes(driver.vehicle_link_method)) return driver;
  const proof = driver.vehicle_link_evidence, source = OPS.overview?.sources?.find(s => s.id === proof?.source), now = Date.now();
  const observed = Date.parse(proof?.observed_at), expiry = Date.parse(proof?.expires_at);
  if (!Number.isFinite(observed) || observed > now + 5000 || !Number.isFinite(expiry) || expiry <= now || expiry <= observed || proof?.method && proof.method !== driver.vehicle_link_method) return null;
  if (driver.vehicle_link_method === 'myclicar_contract') {
    if (proof.source !== 'myclicar' || proof.method !== 'myclicar_contract' || typeof proof.contract_id !== 'string' || !proof.contract_id || typeof proof.client_code !== 'string' || !proof.client_code || typeof proof.vehicle_key !== 'string' || !proof.vehicle_key || proof.vehicle_key !== key || proof.client_code !== driver.ludy_driver_code || expiry - observed > 300000) return null;
  } else if (!['uber', 'bolt'].includes(proof.source)) return null;
  if (proof?.source === 'bolt' && proof.vehicle_origin !== 'bolt_live') return null;
  return source?.status === 'healthy' && Date.parse(source.last_success_at) <= now + 5000 && now - Date.parse(source.last_success_at) <= (source.stale_after_s || 90) * 1000 ? driver : null;
}
function opsVehicleAssignmentLabel(key) {
  if (!OPS.overview || OPS.owner !== S.session?.user?.id) return 'Lecture des affectations…';
  if (!Number.isFinite(OPS.overviewAt) || Date.now() < OPS.overviewAt || Date.now() - OPS.overviewAt > 30000) return 'Affectations à actualiser';
  if (OPS.overview?.drivers?.some(d => d.vehicle_key === key && d.vehicle_conflict)) return 'Conflit d’affectation à vérifier';
  const observed = opsObservedDriverForVehicle(key);
  if (observed) return observed.name;
  // Parking has its own dated badge, validated against this vehicle's GPS fix.
  // A cached parking response alone cannot supply a current driver label.
  if (OPS.overview.drivers?.some(d => d.vehicle_key === key)) return 'Affectation à actualiser';
  return 'Aucun chauffeur en service identifié';
}
// A current, unique platform plate can identify the observed driver without
// guessing which Ludy person/contract it belongs to. It is display evidence only.
function opsObservedDriverForVehicle(key) {
  const owner = S.session?.user?.id, now = Date.now();
  if (!owner || OPS.owner !== owner || !Number.isFinite(OPS.overviewAt) || now < OPS.overviewAt || now - OPS.overviewAt > 30000) return null;
  const rows = (OPS.overview?.vehicle_observations || []).filter(row => row.vehicle_key === key && ['uber','bolt'].includes(row.source) && ['available','on_trip','to_pickup','on_break'].includes(row.status)
    && Number.isFinite(Date.parse(row.observed_at)) && Date.parse(row.observed_at) <= now + 5000 && Date.parse(row.expires_at) > now);
  if (!rows.length || new Set(rows.map(row => row.driver_id)).size !== 1) return null;
  const driver = OPS.overview.drivers?.find(d => d.id === rows[0].driver_id);
  if (!driver || driver.vehicle_conflict) return null;
  const sources = {};
  for (const row of rows) {
    const source = OPS.overview.sources?.find(s => s.id === row.source), age = now - Date.parse(source?.last_success_at), ttl = Number(source?.stale_after_s) * 1000;
    if (source?.status !== 'healthy' || !Number.isFinite(age) || age < -5000 || !Number.isFinite(ttl) || ttl <= 0 || age > ttl) continue;
    if (!sources[row.source] || Date.parse(sources[row.source].observed_at) < Date.parse(row.observed_at)) sources[row.source] = { status: row.status, observed_at: row.observed_at, stale_after_s: source.stale_after_s };
  }
  return Object.keys(sources).length ? { ...driver, sources, observed_assignment: true, observed_vehicle_key: key } : null;
}
function opsDriverNeedsReview(driver) { return !driver.ludy_driver_code || !driver.vehicle_key || opsDriverForVehicle(driver.vehicle_key)?.id !== driver.id; }
function opsMatchNeedsReview(row) { return !['linked', 'manual'].includes(row.status) || !row.vehicle_key || row.vehicle_conflict === true; }
async function opsRefreshMapRoster(my) {
  try {
    await opsOverview(); if (my !== ROUTING) return;
    opsHTML('ops-roster-status', ''); paintOperationsDirect();
  } catch {
    if (my !== ROUTING) return;
    opsHTML('ops-roster-status', msg('Actualisation des affectations interrompue. Les dernières indications restent datées ; le suivi Geotab est indépendant. Nouvel essai automatique.', 'warn'));
    paintOperationsDirect();
  }
}
function opsObserveMapTiles(layer, status) {
  if (!status) return;
  let timer = null, loading = true, removed = false; const failures = new Set();
  const paint = () => {
    if (removed || !status.isConnected) return;
    const state = failures.size ? 'error' : loading ? 'loading' : 'ready';
    const text = state === 'error' ? 'Fond de carte incomplet. Les positions restent disponibles.' : state === 'loading' ? 'Chargement du fond de carte…' : 'Chargement du fond de carte terminé';
    if (status.dataset.state !== state) { status.dataset.state = state; status.textContent = text; }
  };
  const handlers = {
    loading() { loading = true; clearTimeout(timer); timer = setTimeout(paint, 350); },
    load() { loading = false; clearTimeout(timer); paint(); },
    tileerror(e) { failures.add(e.tile); paint(); },
    tileload(e) { if (failures.delete(e.tile)) paint(); },
    tileunload(e) { if (failures.delete(e.tile)) paint(); },
    remove() { removed = true; clearTimeout(timer); layer.off(handlers); }
  };
  layer.on(handlers); paint();
}
function opsPlatformPills(driver, dated = false) { return ['uber', 'bolt'].filter(p => driver?.sources?.[p]).map(p => `<span class="ops-platform"><b>${p === 'uber' ? 'Uber' : 'Bolt'}</b>${fleetPill(fleetObservation(driver, p))}${dated ? '<small>Lecture ' + esc(fleetAgo(driver.sources[p].observed_at)) + '</small>' + fleetVehicleInfoHtml(driver.sources[p], p) : ''}</span>`).join(''); }
function opsMotionCoverage() {
  const c = LIVE.motionCoverage, issue = LIVE.localSource?.motion_error;
  if (issue) return `<div class="ops-notice warn">${workspaceIcon('alertes')}<span>${esc(issue)}</span></div>`;
  if (!c) return '';
  const missing = Number(c.unassigned_drivers) || 0, conflicts = Number(c.conflicting_vehicles) || 0;
  const watches = (LIVE.motionWatches || []).filter(w => inAgency()(w.key));
  return `<div class="ops-coverage ${missing || conflicts ? 'warn' : 'ok'}"><span>${workspaceIcon(missing || conflicts ? 'rh' : 'check')} <b>${Number(c.linked_drivers) || 0}</b> chauffeur${c.linked_drivers === 1 ? '' : 's'} avec un véhicule associé</span>${missing ? `<span><b>${missing}</b> affectation${missing === 1 ? '' : 's'} actuelle${missing === 1 ? '' : 's'} à confirmer pour surveiller les 200 m</span>` : ''}${conflicts ? `<span><b>${conflicts}</b> véhicule${conflicts === 1 ? '' : 's'} avec un conflit d’affectation</span>` : ''}${missing || conflicts ? isAdmin() ? '<a href="#/rapprochements">Vérifier les associations →</a>' : '' : '<span>Surveillance selon la disponibilité des sources</span>'}${watches.length ? `<details class="ops-engine-watch" data-disclosure="engine-watch"><summary>${workspaceIcon('alertes')} ${watches.length} observation${watches.length > 1 ? 's' : ''} hors ligne, contact mis · arrêt du moteur attendu</summary>${watches.map(w => `<p>${esc(w.driver_name || 'Chauffeur associé')} · ${esc(w.plate || w.key)} · ${w.source === 'uber' ? 'Uber' : 'Bolt'} · ${Math.round(Number(w.distance_m) || 0)} m observés</p>`).join('')}<small>Alerte critique au-delà de 200 m de déplacement observé.</small></details>` : ''}</div>`;
}
function opsAlertCards(alerts, limit = 12) {
  return alerts.slice(0, limit).map(a => { const correction = localMotionCorrection(a); return `<button class="ops-alert-card ${correction ? 'corrected' : a.motion && (!a.status || a.status === 'open') ? 'critical' : 'severity-' + (GRAV_CLS[a.severity] || 'warn')}" data-la="${esc(a.id)}"><span class="ops-alert-icon">${workspaceIcon(a.motion ? 'alertes' : 'car')}</span><span class="ops-alert-copy"><span class="ops-alert-heading"><b>${esc(a.type)}</b>${correction ? badge(correction.label, 'info') : a.status === 'resolved' ? badge('Épisode terminé', 'info') : a.status === 'suspended' ? badge('Surveillance suspendue', 'warn') : badge(a.severity, GRAV_CLS[a.severity])}</span><span>${plate(a.plate)} ${esc(a.driver_name || '')}</span><small>${esc(correction?.explanation || a.detail || '')}</small><time>${esc(fmtHMS(a.at))}</time></span><span class="ops-card-arrow">${workspaceIcon('arrow')}</span></button>`; }).join('');
}
function opsCockpitScope(rows, agency = agFilter(), mine = mineOn()) {
  return rows.filter(d => (!agency || String(d.agency_id) === String(agency)) && (!mine || S.mine?.has(d.vehicle_key)));
}
function opsClearCockpitScope() {
  try { localStorage.removeItem('agence'); localStorage.setItem('mesveh', '0'); }
  catch { opsHTML('fleet-error', msg('Impossible de modifier les filtres enregistrés dans ce navigateur.', 'warn')); return; }
  route();
}
async function pageOperationsCockpit() {
  const my = ROUTING; let data = OPS.overview || { drivers: [], sources: [], alerts: [] }, query = '', filter = '', provider = '', range = 'recent', page = 1, loading = false;
  $('#page').innerHTML = `<div class="ops-page ops-cockpit">${opsHeader('POSTE DE PILOTAGE · ' + esc(fmtDay(today())), 'Chaque mouvement compte.', 'La situation de votre flotte et les décisions à prendre, au même endroit.', opsLink('#/direct', 'Ouvrir la carte', 'direct', true))}
    <div id="ops-sources"></div><div id="fleet-error" role="status"></div><div id="fleet-scope" role="status"></div><div class="ops-stats" id="fleet-metrics"></div>
    <div data-disconnections-view="cockpit"></div><div class="ops-focus-grid"><section class="ops-focus-panel"><div class="ops-panel-heading"><div><span class="eyebrow">PRIORITÉ</span><h2>À votre attention</h2></div><a href="#/alertes">Tout voir ${workspaceIcon('arrow')}</a></div><div id="ops-priorities"></div></section><section class="ops-quick-panel"><span class="eyebrow">PASSER À L’ACTION</span>${opsLink('#/performance-chauffeur','Performance chauffeur','analyse')+opsLink('#/parkings','Parc et zones','direct')+opsLink('#/trajets', 'Revoir un trajet', 'direct')}${opsLink('#/bilans', 'Analyser la journée', 'analyse')}${canSee('plan') ? opsLink('#/plan', 'Préparer les affectations', 'ops') : ''}</section></div>
    <div id="fleet-motion-status"></div><section class="ops-roster"><div class="ops-panel-heading"><div><span class="eyebrow">VOS CHAUFFEURS</span><h2>La flotte en activité</h2></div><span class="live-caption" id="fleet-read-time">Lecture en cours…</span></div>
    <div class="fleet-filters" id="fleet-roster-range" aria-label="Période des observations"></div><p class="ops-footnote">Les profils sans observation récente restent accessibles dans « Tous les profils ». Un chauffeur présent sur Uber et Bolt est compté une seule fois après rapprochement de ses comptes.</p>
    <div class="ops-roster-toolbar"><label class="fleet-search">${workspaceIcon('search')}<input id="fleet-search" type="search" placeholder="Chauffeur, plaque ou fiche…" aria-label="Rechercher un chauffeur ou un véhicule"></label><select id="fleet-provider" aria-label="Filtrer par plateforme"><option value="">Uber et Bolt</option><option value="uber">Uber Fleet</option><option value="bolt">Bolt</option></select><button class="icon-button" id="fleet-refresh" aria-label="Actualiser les observations">${workspaceIcon('refresh')}</button></div>
    <div class="fleet-filters" id="fleet-filters"><button data-state="" class="selected" aria-pressed="true">Tous</button>${['available', 'on_trip', 'to_pickup', 'offline', 'unknown'].map(k => `<button data-state="${k}" aria-pressed="false">${FLEET_STATES[k][0]}</button>`).join('')}<button data-state="unlinked" aria-pressed="false">À vérifier</button></div>
    <div id="fleet-roster-content"></div><div class="fleet-pagination" id="fleet-pagination"></div></section></div>`;
  const paint = () => {
    if (my !== ROUTING) return;
    if (typeof disconnectionsPaint === 'function') disconnectionsPaint();
    const at = Date.now(), agency = agFilter(), mine = mineOn(), all = fleetRosterSummary(data.drivers || [], at);
    const rows = opsCockpitScope([...all.recent, ...all.historical], agency, mine), summary = fleetRosterSummary(rows, at);
    const outside = all.recent.length - summary.recent.length, scope = [agency ? 'Agence : ' + (S.agName?.[agency] || agency) : '', mine ? 'Mes véhicules' : ''].filter(Boolean);
    opsHTML('fleet-scope', scope.length ? `<div class="ops-notice info"><span>Périmètre : ${esc(scope.join(' · '))}. <b>${outside}</b> profil${outside === 1 ? '' : 's'} observé${outside === 1 ? '' : 's'} récemment hors de ce périmètre.</span><button id="fleet-all-scope" class="ghost small">Afficher toute la flotte</button></div>` : '<p class="ops-footnote">Périmètre : toute la flotte accessible.</p>');
    if ($('#fleet-all-scope')) $('#fleet-all-scope').onclick = opsClearCockpitScope;
    opsHTML('fleet-roster-range', `<button id="fleet-range-recent" data-range="recent" class="${range === 'recent' ? 'selected' : ''}" aria-pressed="${range === 'recent'}">Récents (${summary.recent.length})</button><button id="fleet-range-all" data-range="all" class="${range === 'all' ? 'selected' : ''}" aria-pressed="${range === 'all'}">Tous les profils (${rows.length})</button>`);
    const activeAlerts = LIVE.alerts.filter(a => inAgency()(a.vehicle_key)), critical = activeAlerts.filter(a => a.motion), unknown = summary.recent.filter(d => !['uber', 'bolt'].some(p => fleetObservation(d, p) && fleetObservation(d, p).status !== 'unknown'));
    opsHTML('ops-sources', opsSourceStrip(data.sources));
    opsHTML('fleet-metrics', opsStat('Chauffeurs suivis', summary.recent.length, `Observations récentes, y compris hors ligne<br>${summary.uber} Uber · ${summary.bolt} Bolt · ${summary.shared} commun${summary.shared === 1 ? '' : 's'}${summary.unlinked ? '<br>' + summary.unlinked + ' profil(s) à rapprocher' : ''}`) + opsStat('Chauffeurs en ligne', opsOnlineDrivers(data).length, 'Uber et Bolt dédupliqués · disponible, course, approche ou pause', 'ok') + opsStat('Véhicules suivis GPS', opsVehicles().filter(v=>v.geotab_id).length+'<small> / '+opsVehicles().length+'</small>', 'Parc référencé, utilisé ou non') + opsStat('En course', summary.recent.filter(d => fleetHasState(d, 'on_trip')).length, 'Activité observée', 'ok') + opsStat('Disponibles', summary.recent.filter(d => fleetHasState(d, 'available')).length, 'Prêts pour une course') + opsStat('Alertes critiques', critical.length, critical.length ? 'Déplacements à vérifier' : 'Aucun déplacement signalé', critical.length ? 'critical' : '') + opsStat('État indisponible', unknown.length, 'À vérifier dans les sources', unknown.length ? 'warn' : ''));
    const offline = (data.alerts || []).filter(a => a.status === 'open' && rows.some(d => d.id === a.driver_id));
    opsHTML('ops-priorities', critical.length ? opsAlertCards(critical, 3) : offline.length ? fleetAlertList(offline.slice(0, 3)) : `<div class="ops-all-clear"><span>${workspaceIcon('check')}</span><div><b>Aucun signalement prioritaire</b><p>${activeAlerts.length ? activeAlerts.length + ' événements de conduite à consulter dans le centre d’alertes.' : 'Gardez un œil sur la fraîcheur des sources.'}</p></div></div>`);
    opsHTML('fleet-motion-status', opsMotionCoverage());
    const q = normTxt(query), filtered = (range === 'all' ? rows : summary.recent).filter(d => (!q || normTxt([d.name, d.vehicle_label, S.veh[d.vehicle_key]?.plate, d.ludy_driver_code, fleetVehicleSearch(d)].join(' ')).includes(q)) && (!provider || (range === 'all' ? d.sources?.[provider] : fleetRecentObservation(d.sources?.[provider], at))) && (!filter || (filter === 'unlinked' ? opsDriverNeedsReview(d) : fleetHasState(d, filter, provider))));
    const size = matchMedia('(max-width: 650px)').matches ? 8 : 20, pages = Math.max(1, Math.ceil(filtered.length / size)); page = Math.min(page, pages);
    const visible = filtered.slice((page - 1) * size, page * size);
    opsHTML('fleet-roster-content', visible.length ? `<div class="fleet-table-wrap"><table class="fleet-table ops-driver-table"><thead><tr><th>Chauffeur</th><th>Véhicule associé</th><th>Uber Fleet</th><th>Bolt</th><th>Dernière lecture</th><th><span class="sr-only">Fiche</span></th></tr></thead><tbody>${visible.map(d => `<tr><td><div class="fleet-driver"><span class="driver-avatar">${esc(fleetInitials(d.name))}</span><span><b>${esc(d.name)}</b><small>${d.ludy_driver_code ? esc(d.ludy_driver_code) : '<span class="ops-link-needed">Fiche à associer</span>'}</small></span></div></td><td data-label="Véhicule">${!opsDriverNeedsReview(d) && S.veh[d.vehicle_key] ? plate(S.veh[d.vehicle_key].plate) : '<span class="ops-muted">' + (d.vehicle_conflict ? 'Conflit d’affectation à vérifier' : 'Affectation à confirmer') + '</span>'}</td><td data-label="Uber Fleet">${fleetPill(fleetObservation(d, 'uber'))}${fleetVehicleInfoHtml(d.sources?.uber, 'uber')}</td><td data-label="Bolt">${fleetPill(fleetObservation(d, 'bolt'))}${fleetVehicleInfoHtml(d.sources?.bolt, 'bolt')}</td><td class="fleet-last-seen">${esc(fleetAgo(fleetLastSeen(d)))}</td><td><button class="icon-button driver-history" data-id="${esc(d.id)}" aria-label="Ouvrir la fiche de ${esc(d.name)}">${workspaceIcon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>` : fleetEmpty('Aucun chauffeur dans cette sélection', rows.length ? 'Essayez un autre filtre ou une autre recherche.' : 'Les chauffeurs apparaissent lorsque les plateformes transmettent leurs observations.'));
    opsHTML('fleet-pagination', `<span>${filtered.length} fiche${filtered.length === 1 ? '' : 's'}</span><div><button class="ghost small" id="fleet-prev" ${page <= 1 ? 'disabled' : ''}>Précédent</button><span>${page} / ${pages}</span><button class="ghost small" id="fleet-next" ${page >= pages ? 'disabled' : ''}>Suivant</button></div>`);
    $('#fleet-prev').onclick = () => { page--; paint(); }; $('#fleet-next').onclick = () => { page++; paint(); };
    $('#fleet-roster-content').onclick = e => { const b = e.target.closest('.driver-history'); if (b) fleetHistory(rows.find(d => d.id === b.dataset.id), my); };
  };
  const refresh = async () => {
    if (loading || my !== ROUTING) return; loading = true; $('#fleet-refresh').disabled = true;
    try { const result = await opsOverview(true); if (my !== ROUTING) return; data = result; opsHTML('fleet-error', ''); $('#fleet-read-time').textContent = 'Actualisé à ' + localHM(new Date()); paint(); }
    catch (e) { if (my === ROUTING) { opsHTML('fleet-error', msg(esc(e.message), 'warn')); $('#fleet-read-time').textContent = 'Actualisation interrompue'; } }
    finally { loading = false; if (my === ROUTING) $('#fleet-refresh').disabled = false; }
  };
  $('#fleet-search').oninput = e => { query = e.target.value; page = 1; paint(); };
  $('#fleet-provider').onchange = e => { provider = e.target.value; page = 1; paint(); };
  $('#fleet-roster-range').onclick = e => { const b = e.target.closest('[data-range]'); if (!b) return; range = b.dataset.range; page = 1; paint(); };
  $('#fleet-filters').onclick = e => { const b = e.target.closest('[data-state]'); if (!b) return; filter = b.dataset.state; page = 1; $('#fleet-filters').querySelectorAll('button').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', String(x === b)); }); paint(); };
  $('#fleet-refresh').onclick = refresh; OPS.paint = paint; paint(); await refresh();
  if (my === ROUTING) S.timers.push(setInterval(() => { if (!document.hidden) refresh(); }, 15000));
}

function opsFilterVehicles(rows) {
  const q = normTxt(OPS.mapQuery);
  return rows.filter(r => (!q || normTxt([r.plate, r.model, r.driver_name, opsDriverForVehicle(r.vehicle_key)?.name].join(' ')).includes(q))
    && (!OPS.mapProvider || (opsDriverForVehicle(r.vehicle_key) || opsObservedDriverForVehicle(r.vehicle_key))?.sources?.[OPS.mapProvider])
    && (!OPS.mapFilter || OPS.mapFilter === 'moving' && r.state === 'En route' || OPS.mapFilter === 'parked' && r.state === 'Garé' || OPS.mapFilter === 'stale' && !r.live || OPS.mapFilter === 'critical' && LIVE.motion[r.vehicle_key]));
}
function opsVehicleZoneAlerts(key) {
  if (typeof zoneAlertsForVehicle !== 'function') return [];
  const driver = opsDriverForVehicle(key) || opsObservedDriverForVehicle(key);
  // A newer explicit trip observation can arrive before the next zone poll.
  // Hide the availability notice immediately; this never alters Geotab state.
  if (driver && ['on_trip', 'to_pickup'].some(state => fleetHasState(driver, state))) return [];
  return zoneAlertsForVehicle(key).filter(a => a.category === 'outside_operating');
}
function opsVehicleZoneBadge(alerts) {
  if (!alerts.length) return '';
  return '<span class="ops-zone-badge">' + workspaceIcon('alertes') + '<span>Disponible hors zone' + (alerts.some(a => a.indicative === true) ? ' <small>· indicatif</small>' : '') + '</span></span>';
}
function opsVehicleZoneSignals(alerts) {
  return alerts.map(a => `<a class="ops-zone-signal" href="#/parkings"><span class="ops-zone-icon">${workspaceIcon('alertes')}</span><span><b>Disponible hors zone</b><small>${esc(a.zone_name || 'Zone d’activité surveillée')}</small>${a.indicative === true ? '<small>Signalement indicatif · contour approximatif</small>' : ''}<small>Voir les zones et les observations</small></span>${workspaceIcon('arrow')}</a>`).join('');
}
function opsVehicleCard(r) {
  const appearance = typeof mapVehicleAppearance === 'function' ? mapVehicleAppearance(r) : null, parking = appearance?.kind === 'parking' ? appearance : null;
  const confirmed = opsDriverForVehicle(r.vehicle_key), d = confirmed || opsObservedDriverForVehicle(r.vehicle_key), critical = LIVE.motion[r.vehicle_key];
  return `<span class="ops-vehicle-top">${plate(r.plate)}<span>${r.live && r.speed != null ? '<b>' + f0(r.speed) + '</b> km/h' : '—'}</span></span><span class="ops-vehicle-model">${esc(r.model || 'Véhicule')}</span><span class="ops-vehicle-state ${r.live ? ST_CLS(r.state) : 'mute'}"><i></i>${esc(r.state === 'En route' ? 'En mouvement · Geotab' : r.state)}</span>${critical ? '<span class="ops-vehicle-alert">' + workspaceIcon('alertes') + ' Alerte : déplacement hors ligne</span>' : ''}${opsVehicleZoneBadge(opsVehicleZoneAlerts(r.vehicle_key))}${parking ? '<span class="ops-parking-state"><b>P</b> ' + esc(parking.label) + '</span>' : ''}<span class="ops-vehicle-bottom"><span><b>${esc(d?.name || opsVehicleAssignmentLabel(r.vehicle_key))}</b><small>${esc(r.last_pos_at ? fleetAgo(r.last_pos_at) : 'Position non reçue')}</small></span>${consoGauge(r)}</span>${d && !confirmed ? '<small class="ops-observed-assignment">' + (d.ludy_driver_code ? 'Plaque observée · rapprochement en cours' : 'Plaque observée · fiche Ludy à rapprocher') + '</small>' : ''}${d ? '<span class="ops-vehicle-platforms">' + opsPlatformPills(d) + '</span>' : ''}`;
}
function opsPaintVehicleList(rows) {
  const list = $('#vlist'); if (!list) return;
  const existing = new Map([...list.querySelectorAll('.vcard')].map(e => [e.dataset.vk, e]));
  let cursor = list.firstElementChild;
  for (const r of rows) {
    let card = existing.get(r.vehicle_key);
    if (!card) { card = document.createElement('button'); card.type = 'button'; card.className = 'vcard ops-vehicle-card'; card.dataset.vk = r.vehicle_key; }
    card.classList.toggle('on', LIVE.sel === r.vehicle_key); card.classList.toggle('has-critical', !!LIVE.motion[r.vehicle_key]);
    const zoneAlerts = opsVehicleZoneAlerts(r.vehicle_key);
    card.setAttribute('aria-label', (r.plate || '') + ' · ' + (r.state || '') + (zoneAlerts.length ? ' · Disponible hors zone' + (zoneAlerts.some(a => a.indicative === true) ? ' · indicatif' : '') : '') + ' · ouvrir le détail'); card.setAttribute('aria-pressed', String(LIVE.sel === r.vehicle_key));
    const html = opsVehicleCard(r); if (card._html !== html) { card.innerHTML = html; card._html = html; }
    if (card !== cursor) list.insertBefore(card, cursor); cursor = card.nextElementSibling; existing.delete(r.vehicle_key);
  }
  existing.forEach(e => e.remove());
  let empty = list.querySelector('.ops-vehicle-empty');
  if (!rows.length && !empty) { empty = document.createElement('div'); empty.className = 'ops-vehicle-empty'; empty.innerHTML = fleetEmpty('Aucun véhicule', 'Modifiez les filtres pour retrouver votre flotte.'); list.appendChild(empty); }
  else if (rows.length && empty) empty.remove();
}
async function pageOperationsDirect(refresh) {
  const my = ROUTING, owner = S.session?.user?.id, sessionRevision = S.sessionRevision;
  const current = () => my === ROUTING && owner === S.session?.user?.id && sessionRevision === S.sessionRevision;
  const [rows] = await Promise.all([all('live_status', '*', null, ['plate']), loadLiveContracts(), refresh && LIVE.base ? null : loadConsoBase().catch(() => { if (current()) LIVE.base = {}; })]);
  if (!current()) return; LIVE.rows = rows.filter(r => inAgency()(r.vehicle_key));
  if (refresh) { if (document.querySelector('.ops-direct')) paintOperationsDirect(); return; }
  LIVE.drvErr = ''; LIVE.drvFallback = ''; LIVE.trails = {}; LIVE.markers = {}; LIVE.fitted = false; LIVE.sel = '';
  $('#page').innerHTML = `<div class="ops-direct">${opsHeader('SUPERVISION EN TEMPS RÉEL', 'La flotte, en mouvement.', '<span id="livest">' + liveStatusTxt() + '</span>', opsLink('#/trajets', 'Revoir les trajets', 'clock'))}<div id="livecards" class="ops-live-metrics"></div><div id="livecoverage"></div><div id="ops-unlocated-drivers"></div><div id="ops-roster-status" role="status" aria-live="polite"></div>
    <div class="ops-map-workspace"><aside class="ops-vehicle-panel"><div class="ops-vehicle-search"><label class="fleet-search">${workspaceIcon('search')}<input id="ops-map-search" type="search" value="${esc(OPS.mapQuery)}" placeholder="Plaque, chauffeur…" aria-label="Rechercher dans la carte"></label><select id="ops-map-provider" aria-label="Plateforme du chauffeur"><option value="">Toutes les plateformes</option><option value="uber" ${OPS.mapProvider === 'uber' ? 'selected' : ''}>Uber</option><option value="bolt" ${OPS.mapProvider === 'bolt' ? 'selected' : ''}>Bolt</option></select></div>
    <div class="ops-map-filters" id="ops-map-filters">${[['', 'Tous'], ['moving', 'En mouvement'], ['parked', 'Garés'], ['critical', 'Critiques'], ['stale', 'Anciens']].map(([key, label]) => `<button data-filter="${key}" class="${OPS.mapFilter === key ? 'selected' : ''}" aria-pressed="${OPS.mapFilter === key}">${label}</button>`).join('')}</div><div class="ops-list-count" id="ops-map-count"></div><div class="vlist" id="vlist" aria-label="Véhicules suivis"></div></aside>
    <section class="ops-map-panel" aria-label="Carte de la flotte"><div id="map" aria-describedby="ops-map-status"></div><div class="ops-map-tools">${typeof mapZonesMarkup === 'function' ? mapZonesMarkup() : ''}<button id="ops-fit-map" class="button-link secondary">${workspaceIcon('direct')} Recentrer la flotte</button><span class="ops-map-live"><i></i> Suivi en direct</span></div><div class="ops-map-legend" aria-label="Couleurs des statuts Uber et Bolt"><span><i class="platform-available"></i> Disponible</span><span><i class="platform-on-trip"></i> En course</span><span><i class="platform-to-pickup"></i> Vers le client</span><span><i class="platform-on-break"></i> En pause</span><span><i class="platform-offline"></i> Hors ligne</span><span><i class="platform-unknown"></i> Inconnu / ancien</span><span><b class="vmk-parking-key" aria-hidden="true">P</b> Au parking</span><span><b class="vmk-parking-key is-last-known" aria-hidden="true">P</b> Dernier parking connu</span><span><b class="ops-critical-key" aria-hidden="true">!</b> Alerte distincte</span></div></section></div><div id="ops-map-status" class="ops-basemap-status" role="status" aria-live="polite" aria-atomic="true"></div>
    <section class="ops-live-events"><div class="ops-panel-heading"><div><span class="eyebrow">SURVEILLANCE</span><h2>Derniers signalements</h2></div><a href="#/alertes">Centre d’alertes ${workspaceIcon('arrow')}</a></div><div id="ops-map-alerts"></div></section>
    <details class="ops-telemetry-details"><summary>Consulter les compteurs de tous les véhicules ${workspaceIcon('analyse')}</summary><div id="livedrv"></div></details></div>`;
  drawMap(liveRows());
  OPS.zonesNavigation?.cleanup();
  OPS.zonesNavigation = typeof mountMapZones === 'function' ? mountMapZones({ map: MAP, container: $('.ops-map-tools'), isCurrent: () => my === ROUTING, onNavigate: () => { LIVE.fitted = true; } }) : null;
  const fit = () => { const rows = opsFilterVehicles(liveRows()).filter(r => r.lat != null && r.lon != null); if (MAP && rows.length) MAP.fitBounds(L.latLngBounds(rows.map(r => [r.lat, r.lon])).pad(0.2), { maxZoom: 14 }); };
  $('#ops-fit-map').onclick = fit;
  $('#ops-map-search').oninput = e => { OPS.mapQuery = e.target.value; paintOperationsDirect(); };
  $('#ops-map-provider').onchange = e => { OPS.mapProvider = e.target.value; paintOperationsDirect(); };
  $('#ops-map-filters').onclick = e => { const b = e.target.closest('[data-filter]'); if (!b) return; OPS.mapFilter = b.dataset.filter; $('#ops-map-filters').querySelectorAll('button').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', String(x === b)); }); paintOperationsDirect(); };
  $('.ops-telemetry-details').ontoggle = () => { if ($('.ops-telemetry-details')?.open) opsHTML('livedrv', localVehicleTelemetryHtml(liveRows())); };
  $('#vlist').addEventListener('click', e => { const c = e.target.closest('.vcard'); if (c) { LIVE.sel = c.dataset.vk; opsOpenVehicle(c.dataset.vk); } });
  const refreshRoster = () => opsRefreshMapRoster(my);
  paintOperationsDirect(); refreshRoster(); S.timers.push(setInterval(() => { if (!document.hidden && my === ROUTING) refreshRoster(); }, 15000));
  window.__rerender = () => { if (my === ROUTING) paintOperationsDirect(); };
}
function paintOperationsDirect() {
  if (!document.querySelector('.ops-direct')) return;
  OPS.zonesNavigation?.syncScope();
  const allRows = liveRows(), rows = opsFilterVehicles(allRows), critical = LIVE.alerts.filter(a => a.motion && inAgency()(a.vehicle_key));
  opsHTML('livecards', opsStat('Véhicules suivis GPS',opsVehicles().filter(v=>v.geotab_id).length+'<small> / '+opsVehicles().length+'</small>','Parc total, utilisé ou non')+opsStat('Chauffeurs en ligne',opsOnlineDrivers().length,'Uber et Bolt réunis, même sans GPS') + opsStat('En mouvement', allRows.filter(r => r.state === 'En route').length, '', 'ok') + opsStat('Contact mis à l’arrêt', allRows.filter(r => r.state === 'Arrêté, contact mis').length, '', 'warn') + opsStat('Positions récentes', allRows.filter(r => r.live).length + '<small> / ' + allRows.length + '</small>') + opsStat('Alertes critiques', critical.length, '', critical.length ? 'critical' : ''));
  opsHTML('livecoverage', opsMotionCoverage());opsHTML('ops-unlocated-drivers',opsUnlocatedDriversHtml(allRows)); opsHTML('livest', liveStatusTxt());
  opsHTML('ops-map-count', rows.length + ' véhicule' + (rows.length === 1 ? '' : 's') + (OPS.mapFilter || OPS.mapQuery || OPS.mapProvider ? ' dans la sélection' : ' dans votre flotte'));
  opsPaintVehicleList(rows);
  const alerts = LIVE.alerts.filter(a => inAgency()(a.vehicle_key));
  opsHTML('ops-map-alerts', alerts.length ? opsAlertCards(alerts, 3) : '<div class="ops-inline-clear">' + workspaceIcon('check') + ' Aucun signalement reçu sur les 30 dernières minutes.</div>');
  if ($('.ops-telemetry-details')?.open) opsHTML('livedrv', localVehicleTelemetryHtml(allRows));
  if (MAP) {
    const visible = new Set(rows.filter(r => r.lat != null && r.lon != null).map(r => r.vehicle_key));
    Object.keys(LIVE.markers).forEach(key => { if (!visible.has(key)) { cancelAnimationFrame(LIVE.markers[key]._anim); MAP.removeLayer(LIVE.markers[key]); delete LIVE.markers[key]; if (LIVE.trails[key]?.line) MAP.removeLayer(LIVE.trails[key].line); delete LIVE.trails[key]; } });
    rows.forEach(placeMarker);
    rows.forEach(r => { const marker = LIVE.markers[r.vehicle_key]; if (marker && !marker._opsDrawer) { marker.on('click', () => opsOpenVehicle(r.vehicle_key)); marker._opsDrawer = true; } });
  }
  if (document.getElementById('ops-vehicle-drawer')) opsPaintVehicleDrawer();
}
function opsOpenVehicle(key) {
  LIVE.sel = key;
  let drawer = document.getElementById('ops-vehicle-drawer');
  if (!drawer) { drawer = document.createElement('dialog'); drawer.id = 'ops-vehicle-drawer'; drawer.className = 'ops-vehicle-drawer'; drawer.setAttribute('aria-labelledby', 'ops-drawer-title'); drawer.innerHTML = '<button class="icon-button ops-drawer-close" aria-label="Fermer le véhicule">' + workspaceIcon('close') + '</button><div id="ops-drawer-content"></div>'; document.body.appendChild(drawer); drawer.querySelector('button').onclick = () => drawer.close(); drawer.addEventListener('close', () => drawer.remove()); drawer.addEventListener('click', e => { if (e.target === drawer) { const b = drawer.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) drawer.close(); } }); }
  opsPaintVehicleDrawer();
  if (!drawer.open) drawer.showModal();
}
function opsPaintVehicleDrawer() {
  const r = liveRows().find(r => r.vehicle_key === LIVE.sel); if (!r) { opsHTML('ops-drawer-content', '<h2 id="ops-drawer-title">Véhicule indisponible</h2><p class="ops-muted">Ce véhicule n’est plus disponible dans le suivi actuel.</p>'); return; }
  const confirmed = opsDriverForVehicle(r.vehicle_key), d = confirmed || opsObservedDriverForVehicle(r.vehicle_key), telemetry = LIVE.drv[r.vehicle_key], alerts = LIVE.alerts.filter(a => a.vehicle_key === r.vehicle_key), zoneAlerts = opsVehicleZoneAlerts(r.vehicle_key);
  const appearance = typeof mapVehicleAppearance === 'function' ? mapVehicleAppearance(r) : null, parking = appearance?.kind === 'parking' ? appearance : null;
  const telemetryFresh = localTelemetryFresh(telemetry) && Date.parse(telemetry.at) <= Date.now(), telemetryAt = Number.isFinite(Date.parse(telemetry?.at)) ? fmtHMS(telemetry.at) : null;
  opsHTML('ops-drawer-content', `<div class="ops-drawer-heading"><span class="eyebrow">VÉHICULE EN DIRECT</span><h2 id="ops-drawer-title">${esc(r.plate)}</h2><p>${esc(r.model || '')}</p><span class="ops-state-origin">Mouvement du véhicule · Geotab</span>${badge(r.state === 'En route' ? 'En mouvement' : r.state, ST_CLS(r.state))}</div><div class="ops-drawer-driver"><span class="driver-avatar">${esc(fleetInitials(d?.name))}</span><div><b>${esc(d?.name || opsVehicleAssignmentLabel(r.vehicle_key))}</b><small>${confirmed ? 'Affectation actuelle confirmée' : d ? d.ludy_driver_code ? 'Plaque observée · rapprochement en cours' : 'Plaque observée · fiche Ludy à rapprocher' : 'Aucune affectation actuelle confirmée par les sources'}</small></div></div><div class="ops-drawer-platforms"><span class="ops-state-origin">Disponibilité sur les plateformes</span>${d ? opsPlatformPills(d, true) : '<span class="ops-muted">Aucun compte Uber/Bolt actuellement confirmé pour ce véhicule</span>'}${opsVehicleZoneBadge(zoneAlerts)}</div>${parking ? '<p class="ops-parking-state"><b>P</b> ' + esc(parking.label) + '</p>' : ''}
    <div class="ops-drawer-stats">${opsStat('Vitesse', r.live ? opsNumber(r.speed, 0) + '<small> km/h</small>' : '—')}${opsStat('Distance du jour', telemetryFresh ? opsNumber(telemetry.km) + '<small> km</small>' : '—')}${opsStat('Consommation', telemetryFresh && telemetry.km >= 10 && telemetry.fuel_l != null ? opsNumber(telemetry.fuel_l / telemetry.km * 100) + '<small> L/100</small>' : '—')}${opsStat('Contact', r.ign_on === true ? 'Mis' : r.ign_on === false ? 'Coupé' : 'Inconnu')}</div><p class="ops-freshness">Position : ${esc(r.last_pos_at ? fmtHMS(r.last_pos_at) : 'Non reçue')}.<br>${telemetryAt ? 'Compteurs depuis minuit, heure du Maroc · lecture ' + esc(telemetryAt) + (telemetryFresh ? '.' : ' · données à actualiser.') : 'Compteurs non reçus.'}</p>
    ${alerts.some(a => a.motion) ? '<p class="ops-alert-explanation">Le rouge signale une alerte à vérifier. Geotab indique le mouvement du véhicule ; le statut hors ligne vient de la plateforme citée dans l’alerte.</p>' : ''}<div class="ops-drawer-actions">${opsLink('#/trajets?key=' + encodeURIComponent(r.vehicle_key), 'Revoir les trajets', 'direct', true)}${opsLink('#/vehicule?k=' + encodeURIComponent(r.vehicle_key), 'Fiche du véhicule', 'car')}</div><h3>Signalements du véhicule</h3>${opsVehicleZoneSignals(zoneAlerts)}${alerts.length ? opsAlertCards(alerts, 8) : zoneAlerts.length ? '' : '<p class="ops-muted">Aucun signalement récent.</p>'}${r.reference_contract ? '<details class="ops-contract-reference" data-disclosure="contract-reference"><summary id="ops-contract-summary">Référence du contrat importé</summary><p>' + esc(r.reference_contract.name) + ' · contrat ' + esc(r.reference_contract.num) + '</p><small>Cette copie de contrat ne confirme pas le chauffeur au volant actuellement.</small></details>' : ''}`);
  $('#ops-drawer-content').querySelectorAll('a').forEach(a => a.onclick = () => document.getElementById('ops-vehicle-drawer')?.close());
}

async function pageOperationsAlerts() {
  const my = ROUTING; let severity = '', query = '', period = 'active';
  $('#page').innerHTML = `<div class="ops-page">${opsHeader('SURVEILLANCE', 'Centre d’alertes', 'Repérez les situations prioritaires et consultez les faits observés.', opsLink('#/archives-alertes', 'Archives Geotab', 'clock'))}<div data-disconnections-view="alerts"></div><h2>Déplacements et conduite</h2><div class="fleet-filters ops-alert-tabs" id="ops-alert-tabs"><button data-period="active" class="selected" aria-pressed="true">Actives</button><button data-period="past" aria-pressed="false">Déplacements passés</button></div><div class="ops-alert-toolbar"><label class="fleet-search">${workspaceIcon('search')}<input id="ops-alert-search" type="search" placeholder="Plaque, chauffeur, événement…" aria-label="Rechercher un déplacement ou un événement de conduite"></label><select id="ops-alert-severity" aria-label="Niveau de priorité"><option value="">Toutes les priorités</option><option value="Critique">Critiques</option><option value="Haute">Hautes</option><option value="Moyenne">Moyennes</option></select></div><div id="ops-alert-status"></div><div id="ops-alert-summary" class="ops-stats"></div><div id="ops-alert-list" class="ops-alert-feed"></div><p class="ops-footnote">Les événements de conduite couvrent les 30 dernières minutes. Les déplacements hors ligne terminés ou suspendus restent consultables dans « Déplacements passés ».</p></div>`;
  const paint = () => { if (my !== ROUTING) return; const all = (period === 'past' ? (LIVE.motionHistory || []).filter(a => a.status !== 'open') : LIVE.alerts).filter(a => inAgency()(a.vehicle_key)), q = normTxt(query), rows = all.filter(a => (!severity || a.severity === severity) && (!q || normTxt([a.plate, a.driver_name, a.type, a.detail].join(' ')).includes(q)));
    if (typeof disconnectionsPaint === 'function') disconnectionsPaint();
    opsHTML('ops-alert-summary', ['Critique', 'Haute', 'Moyenne'].map(s => opsStat(s === 'Critique' ? 'Critiques' : s === 'Haute' ? 'Hautes' : 'Moyennes', all.filter(a => a.severity === s).length, period === 'past' ? 'Signalements conservés' : s === 'Critique' ? 'À vérifier en priorité' : 'Événements observés', s === 'Critique' ? 'critical' : s === 'Haute' ? 'warn' : '')).join(''));
    const source = LIVE.localSource;
    opsHTML('ops-alert-status', source?.status !== 'healthy' ? msg('Le suivi Geotab est interrompu ou en attente. Les derniers signalements restent datés.', 'warn') : '<div class="ops-feed-time"><i></i> Suivi actif · dernière lecture ' + esc(source.events_at ? fmtHMS(source.events_at) : 'en cours') + '</div>');
    opsHTML('ops-alert-list', rows.length ? opsAlertCards(rows, 100) : fleetEmpty('Aucune alerte dans cette sélection', 'Les nouveaux signalements apparaîtront automatiquement.'));
  };
  $('#ops-alert-tabs').onclick = e => { const b = e.target.closest('[data-period]'); if (!b) return; period = b.dataset.period; $('#ops-alert-tabs').querySelectorAll('button').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', String(x === b)); }); paint(); };
  $('#ops-alert-search').oninput = e => { query = e.target.value; paint(); }; $('#ops-alert-severity').onchange = e => { severity = e.target.value; paint(); }; OPS.paint = paint; paint();
}

function opsVehicleOptions(selected = '', all = false) { return (all ? '<option value="">Tous les véhicules visibles</option>' : '<option value="">Choisir un véhicule…</option>') + opsVehicles().filter(v => v.geotab_id).map(v => `<option value="${esc(v.key)}" ${v.key === selected ? 'selected' : ''}>${esc(v.plate)}${v.model ? ' · ' + esc(v.model) : ''}</option>`).join(''); }
async function opsRead(path, controller) {
  const token = S.session?.access_token; if (!token) throw new Error('Reconnectez-vous à Ludy.');
  const response = await fetch('/api/fleet/' + path, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]), cache: 'no-store' });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Lecture momentanément indisponible.'); return data;
}
function opsWarnings(warnings) { return warnings?.length ? `<div class="ops-notice warn">${workspaceIcon('alertes')}<div>${warnings.map(w => '<p>' + esc(typeof w === 'string' ? w : w.message || w.reason || 'Certaines données ne sont pas disponibles.') + '</p>').join('')}</div></div>` : ''; }
function opsSpeedChart(gps) {
  const points = (gps || []).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])); if (points.length < 2) return '<div class="ops-chart-empty">Pas assez de relevés de vitesse pour cette période.</div>';
  const start = points[0][0], span = Math.max(1, points.at(-1)[0] - start), max = Math.max(30, ...points.map(p => p[1]));
  const step = Math.max(1, Math.ceil(points.length / 600)), sampled = points.filter((p, i) => i % step === 0 || i === points.length - 1);
  const coords = sampled.map(p => ((p[0] - start) / span * 930 + 42).toFixed(1) + ',' + (145 - Math.max(0, p[1]) / max * 115).toFixed(1)).join(' ');
  return `<svg class="ops-speed-chart" viewBox="0 0 1000 180" role="img" aria-label="Évolution de la vitesse sur la période"><path d="M42 30H972M42 87H972M42 145H972" class="ops-chart-grid"/><text x="5" y="35">${Math.round(max)}</text><text x="12" y="92">${Math.round(max / 2)}</text><text x="20" y="149">0</text><polyline points="${coords}"/><text x="42" y="172">${esc(localHM(start))}</text><text x="920" y="172">${esc(localHM(points.at(-1)[0]))}</text><text x="42" y="15">km/h</text></svg>`;
}
function opsHistoryMap(gps, selected) {
  if (OPS.map) { OPS.map.remove(); OPS.map = null; }
  const container = $('#ops-history-map'); if (!container || !window.L) return;
  const valid = (gps || []).filter(p => Number.isFinite(p[2]) && Number.isFinite(p[3]));
  if (!valid.length) { container.innerHTML = fleetEmpty('Aucun tracé disponible', 'Geotab n’a pas renvoyé de positions sur cette période.'); return; }
  OPS.map = L.map(container, { scrollWheelZoom: false }); osmLayer('ops-history-map-status').addTo(OPS.map);
  const points = valid.map(p => [p[2], p[3]]), step = Math.max(1, Math.ceil(points.length / 4000));
  L.polyline(points.filter((p, i) => i % step === 0 || i === points.length - 1), { color: '#84283f', weight: 4, opacity: .8 }).addTo(OPS.map);
  L.circleMarker(points[0], { radius: 6, color: '#fff', fillColor: '#208465', fillOpacity: 1, weight: 3 }).bindTooltip('Départ').addTo(OPS.map);
  L.circleMarker(points.at(-1), { radius: 6, color: '#fff', fillColor: '#84283f', fillOpacity: 1, weight: 3 }).bindTooltip('Dernier point').addTo(OPS.map);
  if (selected) { const seg = valid.filter(p => p[0] >= Date.parse(selected.start) && p[0] <= Date.parse(selected.stop || selected.next_start)); if (seg.length) { const line = L.polyline(seg.map(p => [p[2], p[3]]), { color: '#256dca', weight: 6 }).addTo(OPS.map); OPS.map.fitBounds(line.getBounds().pad(.15)); return; } }
  OPS.map.fitBounds(L.latLngBounds(points).pad(.12), { maxZoom: 15 });
}
async function pageOperationsHistory() {
  const my = ROUTING, params = new URLSearchParams(location.hash.split('?')[1] || ''), selected = params.get('key') || ''; let result = null;
  $('#page').innerHTML = `<div class="ops-page">${opsHeader('HISTORIQUE GEOTAB', 'Revoir les trajets', 'Retrouvez les déplacements, les arrêts et les événements d’un véhicule.', opsLink('#/direct', 'Retour au direct', 'direct'))}<form id="ops-history-form" class="ops-query-form"><label>Véhicule<select id="ops-history-vehicle" required>${opsVehicleOptions(selected)}</select></label><label>Journée<input id="ops-history-day" type="date" value="${today()}" max="${today()}" required></label><button type="submit">${workspaceIcon('search')} Afficher la journée</button><span>Heure du Maroc</span></form><div id="ops-history-status" role="status"></div><div id="ops-history-content">${fleetEmpty('Une journée, tous ses déplacements', 'Choisissez un véhicule et une date pour afficher ses trajets.')}</div></div>`;
  $('#ops-history-form').onsubmit = async e => {
    e.preventDefault(); const key = $('#ops-history-vehicle').value, day = $('#ops-history-day').value; if (!key || !day) return;
    OPS.abort?.abort(); const controller = OPS.abort = new AbortController(), bounds = dayBounds(day), button = e.target.querySelector('button'); button.disabled = true;
    opsHTML('ops-history-status', '<div class="ops-loading"><span></span>Lecture des trajets et des compteurs…</div>');
    try {
      const data = await opsRead('geotab/history?' + new URLSearchParams({ key, from: bounds.start.toISOString(), to: bounds.end.toISOString() }), controller);
      if (my !== ROUTING || controller.signal.aborted) return; result = data;
      const s = data.summary || {}, trips = data.trips || [];
      opsHTML('ops-history-status', opsWarnings(data.warnings));
      opsHTML('ops-history-content', `<div class="ops-stats">${opsStat('Distance', opsNumber(s.km) + '<small> km</small>')}${opsStat('Conduite', opsDuration(s.drive_min))}${opsStat('Carburant', opsNumber(s.fuel_l) + '<small> L</small>')}${opsStat('Consommation', opsNumber(s.l100) + '<small> L/100</small>')}${opsStat('Trajets', opsNumber(s.trips, 0))}</div><div class="ops-history-grid"><section class="ops-history-route"><div class="ops-panel-heading"><div><span class="eyebrow">${esc(data.vehicle?.plate || S.veh[key]?.plate || '')}</span><h2>Le parcours de la journée</h2></div><button type="button" class="ghost small" id="ops-history-all">Tout le parcours</button></div><div id="ops-history-map" aria-describedby="ops-history-map-status"></div><div id="ops-history-map-status" class="ops-basemap-status" role="status" aria-live="polite" aria-atomic="true"></div><div class="ops-chart-section"><h3>Vitesse observée</h3>${opsSpeedChart(data.gps)}</div></section><section class="ops-trip-panel"><div class="ops-panel-heading"><h2>${trips.length} trajet${trips.length === 1 ? '' : 's'}</h2><span class="ops-muted">${esc(fmtDay(day))}</span></div><div class="ops-trip-list">${trips.length ? trips.map((t, i) => `<button type="button" class="ops-trip" data-trip="${i}"><span class="ops-trip-index">${i + 1}</span><span><b>${esc(localHM(t.start))} → ${t.stop ? esc(localHM(t.stop)) : 'En cours'}</b><small>${opsNumber(t.distance_km)} km · ${opsDuration(t.drive_min)}${t.partial ? ' · partiel' : ''}</small><small>Ralenti ${opsDuration(t.idle_min)} · max ${opsNumber(t.max_speed, 0)} km/h</small></span>${workspaceIcon('arrow')}</button>`).join('') : '<p class="ops-empty-inline">Aucun trajet transmis sur cette période.</p>'}</div></section></div><section class="ops-history-events"><div class="ops-panel-heading"><h2>Événements de conduite</h2><span>${(data.events || []).length} événements</span></div><div class="ops-event-timeline">${(data.events || []).map(v => `<div><time>${esc(localHM(v.at))}</time><span class="ops-timeline-dot"></span><b>${esc(S.rules[v.rule]?.name || 'Événement Geotab')}</b><span>${v.dur_min == null ? '—' : Math.round(v.dur_min * 60) + ' s'}</span></div>`).join('') || '<p class="ops-empty-inline">Aucun événement transmis.</p>'}</div></section><p class="ops-footnote">Période observée : ${esc(fmtDT(data.from))} → ${esc(fmtDT(data.to))}, heure du Maroc. Lecture du ${esc(fmtHMS(data.at))}. Les valeurs indisponibles sont affichées « — ». Les trajets partiels ne sont pas assimilés à des trajets complets.</p>`);
      opsHistoryMap(data.gps); $('#ops-history-all').onclick = () => opsHistoryMap(result.gps);
      $('#ops-history-content').querySelectorAll('[data-trip]').forEach(b => b.onclick = () => { $('#ops-history-content').querySelectorAll('[data-trip]').forEach(x => x.classList.toggle('selected', x === b)); opsHistoryMap(result.gps, result.trips[Number(b.dataset.trip)]); });
    } catch (error) { if (my === ROUTING && !controller.signal.aborted) opsHTML('ops-history-status', msg(esc(error.message), 'err')); }
    finally { if (my === ROUTING && !controller.signal.aborted) button.disabled = false; }
  };
}
function opsCsvCell(value) { const text = value == null ? '' : String(value); return '"' + (/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"'; }
function opsReportCsv(data) {
  const columns = [['plate', 'Véhicule'], ['model', 'Modèle'], ['km', 'Distance km'], ['fuel_l', 'Carburant L'], ['l100', 'L/100 km'], ['drive_min', 'Conduite min'], ['idle_min', 'Ralenti min'], ['idle_l', 'Carburant ralenti L'], ['trips', 'Trajets'], ['max_speed', 'Vitesse max km/h'], ['events', 'Événements'], ['status', 'Disponibilité']];
  return '\ufeff' + [['Période du', data.from, 'au', data.to], columns.map(c => c[1]), ...(data.rows || []).map(r => columns.map(c => r[c[0]]))].map(row => row.map(opsCsvCell).join(';')).join('\r\n');
}
async function pageOperationsReport() {
  const my = ROUTING; let data = null;
  $('#page').innerHTML = `<div class="ops-page">${opsHeader('ANALYSE DE LA FLOTTE', 'Des journées lisibles.', 'Comparez les kilomètres, la consommation et la conduite sur la période choisie.', '<button id="ops-export-report" class="button-link secondary" disabled>' + workspaceIcon('page') + ' Exporter CSV</button>')}<form id="ops-report-form" class="ops-query-form"><label>Du<input id="ops-report-from" type="date" value="${today()}" max="${today()}" required></label><label>Au<input id="ops-report-to" type="date" value="${today()}" max="${today()}" required></label><label>Véhicules<select id="ops-report-vehicle">${opsVehicleOptions('', true)}</select></label><button type="submit">${workspaceIcon('analyse')} Calculer le bilan</button><span>7 jours maximum · heure du Maroc</span></form><div id="ops-report-status" role="status"></div><div id="ops-report-content">${fleetEmpty('Votre bilan, à la bonne échelle', 'Une journée pour piloter, une semaine pour prendre du recul.')}</div></div>`;
  $('#ops-report-form').onsubmit = async e => {
    e.preventDefault(); const from = $('#ops-report-from').value, to = $('#ops-report-to').value, key = $('#ops-report-vehicle').value;
    if (!from || !to || to < from || Date.parse(to) - Date.parse(from) > 6 * 86400000) { opsHTML('ops-report-status', msg('Choisissez une période de 1 à 7 jours.', 'warn')); return; }
    const keys = key ? [key] : opsVehicles().filter(v => v.geotab_id).map(v => v.key); if (!keys.length) { opsHTML('ops-report-status', msg('Aucun véhicule associé à Geotab dans votre sélection.', 'warn')); return; }
    OPS.abort?.abort(); const controller = OPS.abort = new AbortController(), button = e.target.querySelector('button'); button.disabled = true; $('#ops-export-report').disabled = true;
    opsHTML('ops-report-status', '<div class="ops-loading"><span></span>Préparation du bilan de la flotte…</div>');
    try {
      const result = await opsRead('geotab/report?' + new URLSearchParams({ from: dayBounds(from).start.toISOString(), to: dayBounds(to).end.toISOString(), keys: keys.join(',') }), controller);
      if (my !== ROUTING || controller.signal.aborted) return; data = result;
      const t = data.totals || {}, coverage = data.coverage || {};
      opsHTML('ops-report-status', opsWarnings(data.warnings));
      opsHTML('ops-report-content', `<div class="ops-report-coverage"><span>${workspaceIcon('check')} ${coverage.complete ?? '—'} / ${coverage.vehicles ?? data.rows?.length ?? '—'} véhicules avec données complètes</span><span>${esc(fmtDT(data.from))} → ${esc(fmtDT(data.to))}</span></div><div class="ops-stats">${opsStat('Distance totale', opsNumber(t.km) + '<small> km</small>')}${opsStat('Carburant', opsNumber(t.fuel_l) + '<small> L</small>')}${opsStat('Consommation moyenne', opsNumber(t.l100) + '<small> L/100</small>')}${opsStat('Temps de conduite', opsDuration(t.drive_min))}${opsStat('Événements', opsNumber(t.events, 0), '', t.events ? 'warn' : '')}</div><section class="ops-report-table"><div class="ops-panel-heading"><h2>Le détail par véhicule</h2><span class="ops-muted">${data.rows?.length || 0} véhicules</span></div><div class="ops-table-scroll"><table><thead><tr><th>Véhicule</th><th>Distance</th><th>Carburant</th><th>L/100 km</th><th>Conduite</th><th>Ralenti</th><th>Événements</th><th>Couverture</th></tr></thead><tbody>${(data.rows || []).map(r => `<tr><td><a href="#/trajets?key=${encodeURIComponent(r.key)}">${plate(r.plate)}</a><small>${esc(r.model || '')}</small></td><td>${opsNumber(r.km)} <small>km</small></td><td>${opsNumber(r.fuel_l)} <small>L</small></td><td>${opsNumber(r.l100)}</td><td>${opsDuration(r.drive_min)}</td><td>${opsDuration(r.idle_min)}</td><td>${opsNumber(r.events, 0)}</td><td><span class="source-status ${r.status === 'complete' || r.status === 'healthy' ? 'ok' : 'warn'}">${r.status === 'complete' || r.status === 'healthy' ? 'Complète' : r.status === 'unavailable' ? 'Indisponible' : 'Partielle'}</span>${r.warnings?.length ? '<small>' + esc(r.warnings.map(w => typeof w === 'string' ? w : w.message || '').join(' · ')) + '</small>' : ''}</td></tr>`).join('')}</tbody></table></div></section><p class="ops-footnote">Les totaux ne remplacent pas les données manquantes par zéro. Les valeurs « — » sont indisponibles ou incomplètes.</p>`);
      $('#ops-export-report').disabled = !data.rows?.length;
    } catch (error) { if (my === ROUTING && !controller.signal.aborted) opsHTML('ops-report-status', msg(esc(error.message), 'err')); }
    finally { if (my === ROUTING && !controller.signal.aborted) button.disabled = false; }
  };
  $('#ops-export-report').onclick = () => { if (!data) return; const href = URL.createObjectURL(new Blob([opsReportCsv(data)], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a'); a.href = href; a.download = 'ludy-bilan-' + today() + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); };
}

async function pageOperationsMatches() {
  const my = ROUTING; let data = null, filter = 'review', busy = false;
  $('#page').innerHTML = `<div class="ops-page">${opsHeader('CHAUFFEURS & VÉHICULES', 'Les bonnes associations.', 'Les comptes et les véhicules sont rapprochés automatiquement à chaque lecture des plateformes.', '<button id="ops-match-refresh" class="button-link">' + workspaceIcon('refresh') + ' Actualiser les associations</button>')}<div class="ops-notice info">${workspaceIcon('check')}<span>Les noms complets uniques identifient les fiches Ludy ; les plaques récentes identifient les voitures. Les changements de shift suivent les observations Uber et Bolt. Les conflits et les choix manuels restent visibles.</span></div><div id="ops-match-status" role="status"></div><div id="ops-match-metrics" class="ops-stats"></div><div class="fleet-filters ops-match-filters" id="ops-match-filters"><button data-filter="review" class="selected">À vérifier</button><button data-filter="all">Toutes les fiches</button><button data-filter="linked">Associées</button></div><div id="ops-match-list"></div></div>`;
  const paint = () => { if (!data || my !== ROUTING) return; const counts = data.counts || {}, rows = (data.rows || []).filter(r => filter === 'all' || filter === 'linked' ? filter === 'all' || ['linked', 'manual'].includes(r.status) : opsMatchNeedsReview(r));
    opsHTML('ops-match-metrics', opsStat('Fiches associées', counts.linked || 0) + opsStat('À rapprocher', (counts.unmatched || 0) + (counts.ambiguous || 0), 'Vérification nécessaire', 'warn') + opsStat('Véhicules identifiés', counts.vehicle_ready || 0) + opsStat('Choix manuels', counts.manual || 0, 'Conservés automatiquement'));
    opsHTML('ops-match-list', rows.length ? `<div class="ops-match-grid">${rows.map(r => `<article class="ops-match-card"><div><span class="driver-avatar">${esc(fleetInitials(r.driver_name))}</span><span><h3>${esc(r.driver_name)}</h3><small>${r.status === 'linked' ? 'Fiche associée' : r.status === 'manual' ? 'Choix manuel' : r.status === 'ready' ? 'Correspondance trouvée' : r.status === 'ambiguous' ? 'Plusieurs correspondances' : 'Fiche à identifier'}</small></span></div><div class="ops-match-target">${workspaceIcon('arrow')}<span><b>${esc(r.ludy_name || 'Aucune fiche associée')}</b><small>${esc(r.ludy_driver_code || r.reason || '')}</small></span></div><div class="ops-match-vehicle">${workspaceIcon('car')} ${r.vehicle_plate ? plate(r.vehicle_plate) : '<span>Véhicule à associer</span>'}</div>${r.vehicle_conflict ? '<p class="ops-link-needed">Conflit d’affectation à vérifier</p>' : ''}${r.vehicle_reason ? '<p class="ops-muted">' + esc(r.vehicle_reason) + '</p>' : ''}<button class="ghost ops-match-open" data-id="${esc(r.driver_id)}">Vérifier la fiche ${workspaceIcon('arrow')}</button></article>`).join('')}</div>` : fleetEmpty('Les associations sont à jour', 'Aucune fiche ne demande de vérification dans cette sélection.'));
    $('#ops-match-list').onclick = async e => { const b = e.target.closest('.ops-match-open'); if (!b) return; b.disabled = true; try { const overview = await opsOverview(true); if (my !== ROUTING) return; const driver = overview.drivers.find(d => d.id === b.dataset.id); if (driver) fleetHistory(driver, my); } catch (error) { opsHTML('ops-match-status', msg(esc(error.message), 'err')); } finally { b.disabled = false; } };
  };
  const load = async apply => { if (busy || my !== ROUTING) return; busy = true; $('#ops-match-refresh').disabled = true; try { const response = await fleetApi(apply ? 'drivers/match' : 'drivers/matches', apply ? {} : undefined); if (my !== ROUTING) return; data = response.review || response; opsHTML('ops-match-status', apply ? msg((response.applied || 0) + ' association(s) de fiche et ' + (response.vehicle_linked || 0) + ' association(s) de véhicule appliquées.', 'ok') : ''); paint(); } catch (error) { if (my === ROUTING) opsHTML('ops-match-status', msg(esc(error.message), 'err')); } finally { busy = false; if (my === ROUTING) $('#ops-match-refresh').disabled = false; } };
  $('#ops-match-refresh').onclick = () => load(true); $('#ops-match-filters').onclick = e => { const b = e.target.closest('[data-filter]'); if (!b) return; filter = b.dataset.filter; $('#ops-match-filters').querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === b)); paint(); };
  await load(false);
}
