// Lectures partagées et pilotage des connecteurs sur les environnements autorisés.
const FLEET_STATES = {
  available: ['Disponible', 'available'], on_trip: ['En course', 'on-trip'], to_pickup: ['Vers le client', 'to-pickup'],
  offline: ['Hors ligne', 'offline'], unknown: ['Non observé', 'unknown'], on_break: ['En pause', 'on-break']
};
const FLEET_PROVIDERS = { uber: 'Uber Fleet', bolt: 'Bolt', geotab: 'Geotab', myclicar: 'MyClicar' };
const FLEET_READS = new Map();
function fleetReadScope() {
  return { token: S.session?.access_token, user: S.session?.user?.id, revision: S.sessionRevision, route: typeof ROUTING === 'undefined' ? null : ROUTING };
}
function fleetSameReadScope(a, b) { return a.token === b.token && a.user === b.user && a.revision === b.revision && a.route === b.route; }
function fleetCancelReads() {
  for (const request of FLEET_READS.values()) request.controller.abort();
  FLEET_READS.clear();
}
async function fleetApi(path, body) {
  const scope = fleetReadScope(), reading = body === undefined;
  for (const [key, request] of FLEET_READS) if (!fleetSameReadScope(request.scope, scope)) { request.controller.abort(); FLEET_READS.delete(key); }
  if (!scope.token) throw new Error('Reconnectez-vous pour consulter votre flotte.');
  if (reading && FLEET_READS.has(path)) return FLEET_READS.get(path).promise;
  const controller = reading ? new AbortController() : null;
  // Snapshot/status reads must not block a view for the provider action's two-minute deadline.
  const provider = /^(bolt|geotab|myclicar|texat)\//.test(path), snapshot = /\/(live|status|config)(\?|$)/.test(path);
  const timeout = AbortSignal.timeout(provider && (!reading || !snapshot) ? 120000 : 20000);
  const signal = controller ? AbortSignal.any([controller.signal, timeout]) : timeout;
  const request = { scope, controller, promise: null };
  request.promise = (async () => {
    const r = await fetch('/api/fleet/' + path, {
      method: reading ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + scope.token, 'Content-Type': 'application/json' },
      body: reading ? undefined : JSON.stringify(body), signal, cache: 'no-store'
    });
    const data = await r.json().catch(() => ({}));
    if (signal.aborted) throw signal.reason;
    if (reading && (controller.signal.aborted || !fleetSameReadScope(scope, fleetReadScope()))) throw Object.assign(new Error('Lecture remplacée.'), { name: 'AbortError' });
    if (!r.ok) throw new Error(data.error || data.message || 'Lecture impossible (' + r.status + ').');
    return data;
  })().finally(() => { if (FLEET_READS.get(path) === request) FLEET_READS.delete(path); });
  if (reading) FLEET_READS.set(path, request);
  return request.promise;
}
// The cockpit and alert centre need persisted incidents, not a full GPS snapshot.
function startFleetAlerts(my) {
  const owner = S.session?.user?.id, revision = S.sessionRevision;
  if (!owner || !CFG.GEOTAB_LOCAL || !['cockpit', 'alertes'].includes(pageOf())) return;
  let busy = false;
  const current = () => my === ROUTING && owner === S.session?.user?.id && revision === S.sessionRevision;
  const read = async () => {
    if (busy || document.hidden || !current()) return;
    busy = true;
    try {
      const snapshot = await fleetApi('alerts');
      if (!current()) return;
      LIVE.localSource = snapshot.source || {};
      // This endpoint does not measure GPS positions, telemetry or coverage.
      processLocalLive(snapshot);
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      LIVE.localSource = { ...(LIVE.localSource || {}), status: 'error', motion_error: 'Suivi des signalements interrompu. Les incidents conservés restent datés.' };
      suspendLocalMotionDisplay();
    } finally { busy = false; }
    if (current() && typeof operationsSnapshot === 'function') operationsSnapshot();
  };
  void read(); S.timers.push(setInterval(read, 15000));
}
function fleetAgo(at) {
  const ms = Date.parse(at); if (!Number.isFinite(ms)) return 'Aucune lecture';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 15) return 'À l’instant';
  if (sec < 60) return 'Il y a ' + sec + ' s';
  if (sec < 3600) return 'Il y a ' + Math.floor(sec / 60) + ' min';
  if (sec < 86400) return 'Il y a ' + Math.floor(sec / 3600) + ' h';
  return fmtDT(at);
}
function fleetSourceState(source) {
  const state = source && (source.status || source.state);
  if (['healthy', 'connected', 'live', 'ok', 'active'].includes(state)) return ['Connecté', 'ok'];
  if (['error', 'degraded', 'stale', 'disconnected', 'reconnect'].includes(state)) return ['À vérifier', 'warn'];
  if (state === 'paused' || state === 'stopped') return ['En pause', 'mute'];
  return ['À connecter', 'mute'];
}
function fleetConnectorState(source = {}, fallbackInterval = 60) {
  const configured = source.configured !== false && source.status !== 'unconnected' && (source.configured === true || !!source.status);
  const automatic = source.auto_resume === true, active = automatic || source.polling === true;
  const retrying = active && (source.retrying === true || ['error', 'degraded', 'stale', 'disconnected', 'reconnect'].includes(source.status));
  const interval = Number(source.interval_s) > 0 ? Number(source.interval_s) : fallbackInterval;
  const next = active && Number.isFinite(Date.parse(source.next_attempt_at)) ? source.next_attempt_at : null;
  if (source.collectionRemote === true) {
    const [label, tone] = fleetSourceState(source);
    return { active, automatic, configured, retrying, interval, next: null, remote: true, label: 'Données partagées · ' + label, tone,
      detail: 'La collecte est pilotée sur le poste central. Cet ordinateur consulte les données partagées.' };
  }
  let label = !configured ? 'À connecter' : !active ? 'En pause' : retrying ? 'Reconnexion automatique' : source.polling ? 'Suivi actif' : 'Démarrage automatique';
  let tone = !configured || !active ? 'mute' : retrying ? 'warn' : 'ok';
  let detail = !configured ? 'Configurez les accès pour activer le suivi.' : !active ? 'Pause conservée au redémarrage. Reprenez le suivi quand vous le souhaitez.' : automatic ? 'Reprise automatique après une coupure ou un redémarrage de Ludy.' : 'Suivi actif pour cette session.';
  if (source.automation_error) { label = 'Automatisation à vérifier'; tone = 'warn'; detail = source.automation_error; }
  return { active, automatic, configured, retrying, interval, next, label, tone, detail };
}
function fleetConnectorAutomation(source, fallbackInterval) {
  const state = fleetConnectorState(source, fallbackInterval);
  if (state.remote) return `<div class="connector-automation ${state.tone}" data-state="shared"><div><b>${esc(state.label)}</b></div><p>${esc(state.detail)}</p><p>Dernière lecture : ${esc(source.last_success_at ? fmtDTY(source.last_success_at) : 'aucune')}.</p>${source.last_error ? `<p class="connector-error">${esc(source.last_error)}</p>` : ''}</div>`;
  const next = state.next ? `${state.retrying ? 'Nouvel essai' : 'Prochaine lecture'} : ${fmtHMS(state.next)}` : state.active ? 'Lecture en cours ou en préparation' : 'Aucune lecture programmée';
  return `<div class="connector-automation ${state.tone}" data-state="${state.retrying ? 'retrying' : state.active ? 'active' : 'paused'}"><div><b>${esc(state.label)}</b><span>${esc(next)}</span></div><p>${esc(state.detail)}</p>${source?.last_error && state.active ? `<p class="connector-error">${esc(source.last_error)}</p>` : ''}${state.active ? `<small>Cadence cible : ${state.interval} s · les délais du fournisseur peuvent la ralentir.</small>` : ''}</div>`;
}
function fleetBoltActivationFeedback(result) {
  if (result?.ignored || result?.polling === false) return { tone: 'warn', message: 'Le suivi Bolt n’est pas actif. Vérifiez l’état de collecte de ce poste.' };
  if (result?.retrying === true) return { tone: 'warn', message: 'Lecture Bolt impossible pour le moment. Une nouvelle tentative automatique est prévue. Consultez le message du connecteur.' };
  if (result?.ok !== true) return { tone: 'warn', message: 'Le suivi Bolt n’a pas pu démarrer. Vérifiez le message du connecteur.' };
  return { tone: 'ok', message: 'Suivi automatique activé. Les lectures reprennent après une coupure ou un redémarrage.' };
}
function fleetConnectorSurveillance(sources = [], coverage = LIVE.motionCoverage) {
  const states = ['uber', 'bolt', 'geotab'].map(id => { const source = sources.find(s => s.id === id) || {}, [label, tone] = fleetSourceState(source); return `<span class="source-status ${tone}"><i></i>${FLEET_PROVIDERS[id]} · ${esc(label)}</span>`; }).join('');
  const linked = Number(coverage?.linked_drivers), missing = Number(coverage?.unassigned_drivers);
  const detail = Number.isFinite(linked) ? `${linked} affectation${linked === 1 ? '' : 's'} véhicule actuellement confirmée${linked === 1 ? '' : 's'}.${missing > 0 ? ' ' + missing + ' à confirmer.' : ''}` : 'La couverture sera affichée dès la prochaine lecture locale.';
  return `<div class="connector-surveillance-sources">${states}</div><p>${esc(detail)} <a href="#/rapprochements">Vérifier les associations →</a></p>`;
}
function fleetObservation(driver, provider) {
  const ob = (driver.sources || {})[provider];
  if (!ob) return null;
  const age = Date.now() - Date.parse(ob.observed_at || ob.received_at);
  return { ...ob, status: ob.stale || !Number.isFinite(age) || age < -5000 || age > (ob.stale_after_s || 300) * 1000 ? 'unknown' : (ob.status || ob.state || 'unknown') };
}
function fleetPill(ob) {
  const state = FLEET_STATES[ob && (ob.status || ob.state)] || FLEET_STATES.unknown;
  return '<span class="fleet-state ' + state[1] + '" title="' + esc(ob ? fleetAgo(ob.observed_at || ob.received_at) : 'Aucune observation de cette source') + '"><i></i>' + state[0] + '</span>';
}
// Platform vehicle details describe that observation, not a confirmed Ludy assignment.
function fleetVehicleInfo(ob, provider) {
  const plate = typeof ob?.vehicle_label === 'string' ? ob.vehicle_label.trim() : '';
  const model = typeof ob?.evidence?.vehicle_model === 'string' ? ob.evidence.vehicle_model.trim() : '';
  if (!plate && !model) return null;
  const at = ob.evidence?.vehicle_observed_at || ob.observed_at || ob.received_at, age = Date.now() - Date.parse(at);
  const stale = ob.stale || !Number.isFinite(age) || age < -5000 || age > (ob.stale_after_s || 300) * 1000;
  const selected = provider === 'bolt' && ob.evidence?.vehicle_origin !== 'bolt_live';
  const provenance = selected ? 'Sélection Bolt · affectation à confirmer' : stale ? 'Dernière indication · à actualiser' : 'Indication ' + (FLEET_PROVIDERS[provider] || provider || 'plateforme');
  return { plate, model, at, provenance, selected, stale };
}
function fleetVehicleInfoHtml(ob, provider) {
  const info = fleetVehicleInfo(ob, provider); if (!info) return '';
  return `<span class="fleet-vehicle-info"><br><small>${esc(info.plate || 'Plaque non lue')}${info.model ? ' · ' + esc(info.model) : ''}</small><br><small class="ops-muted" title="${esc(info.at ? fleetAgo(info.at) : 'Date inconnue')}">${esc(info.provenance)}</small></span>`;
}
function fleetVehicleSearch(driver) { return Object.values(driver.sources || {}).flatMap(ob => [ob.vehicle_label, ob.evidence?.vehicle_model]).filter(Boolean).join(' '); }
function fleetUberVehicleCoverage(coverage = {}) {
  if (!Number.isSafeInteger(coverage.vehicleObserved)) return 'Lecture des plaques non mesurée · extension 0.5.1 requise';
  return `${coverage.vehicleObserved} plaque(s) lue(s) / ${Number.isSafeInteger(coverage.drivers) ? coverage.drivers : '—'} chauffeur(s)${coverage.vehicleComplete === true ? ' · plaques de la liste lues' : ' · plaques restantes à lire'}`;
}
function fleetInitials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase(); }
function fleetLastSeen(d) { return Object.values(d.sources || {}).map(x => x.observed_at || x.received_at).filter(Boolean).sort().at(-1); }
// Count observed profiles, not cars or online states. A source interruption
// changes availability to unknown; it does not erase the last observation.
function fleetRecentObservation(ob, now = Date.now()) {
  const at = Date.parse(ob?.observed_at), configured = Number(ob?.stale_after_s);
  const ttl = Number.isFinite(configured) && configured > 0 ? configured : 90;
  return Number.isFinite(at) && at <= now + 5000 && now - at <= ttl * 1000;
}
function fleetRosterSummary(drivers = [], now = Date.now()) {
  const unique = new Map();
  drivers.forEach((driver, index) => {
    const key = driver.id ? 'profile:' + driver.id : driver.ludy_driver_code ? 'ludy:' + driver.ludy_driver_code : 'row:' + index;
    const prior = unique.get(key);
    if (!prior) { unique.set(key, { ...driver, sources: { ...driver.sources } }); return; }
    for (const [provider, observation] of Object.entries(driver.sources || {})) {
      if (!prior.sources[provider] || Date.parse(observation.observed_at) > Date.parse(prior.sources[provider].observed_at)) prior.sources[provider] = observation;
    }
  });
  const recent = [], historical = []; let uber = 0, bolt = 0, shared = 0, unlinked = 0;
  for (const driver of unique.values()) {
    const onUber = fleetRecentObservation(driver.sources.uber, now), onBolt = fleetRecentObservation(driver.sources.bolt, now);
    if (!onUber && !onBolt) { historical.push(driver); continue; }
    recent.push(driver); uber += Number(onUber); bolt += Number(onBolt); shared += Number(onUber && onBolt);
    if (!driver.ludy_driver_code) unlinked++;
  }
  return { recent, historical, total: unique.size, uber, bolt, shared, unlinked };
}
function fleetHasState(d, state, provider) { return (provider ? [provider] : ['uber', 'bolt']).some(p => (fleetObservation(d, p) || {}).status === state); }
function fleetSourceCards(sources) {
  return Object.entries(FLEET_PROVIDERS).map(([id, label]) => {
    const source = (sources || []).find(s => (s.id || s.provider) === id), [txt, cls] = fleetSourceState(source);
    return `<a class="source-card" href="${isAdmin() || CFG.WEB_PRODUCTION ? '#/connecteurs' : '#/cockpit'}"><span class="source-logo ${id}">${id === 'bolt' ? workspaceIcon('bolt') : id === 'uber' ? 'U' : id === 'geotab' ? 'G' : 'C'}</span><span class="source-copy"><b>${label}</b><small>${esc(source && source.last_success_at ? fleetAgo(source.last_success_at) : CFG.WEB_PRODUCTION ? 'En attente du poste collecteur' : id === 'uber' ? 'Lecture sur le second écran' : id === 'bolt' ? 'Connexion API sécurisée' : 'Source indépendante')}</small></span><span class="source-status ${cls}"><i></i>${txt}</span></a>`;
  }).join('');
}
function fleetEmpty(title, text, action) {
  return `<div class="fleet-empty">${workspaceIcon('car')}<h3>${esc(title)}</h3><p>${esc(text)}</p>${action || ''}</div>`;
}
function fleetAlertList(alerts) {
  if (!alerts.length) return '<div class="fleet-all-clear">' + workspaceIcon('check') + '<div><b>Aucune alerte active</b><p>Les signalements des sources connectées apparaîtront ici.</p></div></div>';
  return alerts.slice(0, 12).map(a => `<div class="fleet-alert"><span class="alert-marker"></span><div><b>${esc(a.driver_name || a.name || 'Chauffeur')}</b><p>${esc(a.message || a.detail || a.rule || a.type || 'Hors ligne au-delà du seuil de suivi')}</p><small>${esc(FLEET_PROVIDERS[a.source || a.provider] || a.source || a.provider || '')} · ${esc(fleetAgo(a.opened_at || a.created_at || a.observed_at))}</small></div></div>`).join('');
}
async function pageCockpit() {
  const my = ROUTING;
  let data = { drivers: [], sources: [], alerts: [] }, query = '', filter = '', provider = '', page = 1, loading = false, debounce;
  $('#page').innerHTML = `<div class="fleet-page"><div class="fleet-heading"><div><div class="eyebrow">PILOTAGE DE LA FLOTTE <span>·</span> ${esc(fmtDay(today()))}</div><h1>Votre flotte, en un regard<span>.</span></h1><p>Les chauffeurs, leur activité et les points qui demandent votre attention.</p></div><a class="button-link secondary" href="#/direct">${workspaceIcon('direct')} Voir la carte</a></div>
    <div class="fleet-source-grid" id="fleet-sources">${fleetSourceCards([])}</div>
    <div class="fleet-metrics" id="fleet-metrics" aria-label="Indicateurs de la flotte"></div>
    <div id="fleet-error" role="status"></div><div id="fleet-motion-status">${localMotionCoverageHtml()}</div>
    <div class="fleet-content"><section class="fleet-roster"><div class="fleet-section-title"><div><h2>Chauffeurs de la flotte</h2><p>Chaque plateforme conserve son propre statut.</p></div><span class="live-caption" id="fleet-read-time">Lecture en cours…</span></div>
    <div class="fleet-toolbar"><label class="fleet-search">${workspaceIcon('search')}<input id="fleet-search" type="search" placeholder="Rechercher un chauffeur ou un véhicule" aria-label="Rechercher un chauffeur ou un véhicule"></label><select id="fleet-provider" aria-label="Filtrer par plateforme"><option value="">Toutes les plateformes</option value="uber">Uber Fleet</option><option value="bolt">Bolt</option></select><button class="icon-button" id="fleet-refresh" title="Actualiser" aria-label="Actualiser les observations">${workspaceIcon('refresh')}</button></div>
    <div class="fleet-filters" id="fleet-filters"><button data-state="" class="selected" aria-pressed="true">Tous</button>${['available', 'on_trip', 'to_pickup', 'offline', 'unknown'].map(k => `<button data-state="${k}" aria-pressed="false">${FLEET_STATES[k][0]}</button>`).join('')}</div>
    <div id="fleet-roster-content" aria-live="polite">${fleetEmpty('Lecture de la flotte…', 'Connexion aux données du staging.')}</div><div class="fleet-pagination" id="fleet-pagination"></div></section>
    <aside class="fleet-insights"><section class="insight-panel"><div class="insight-title">${workspaceIcon('alertes')}<h2>À votre attention</h2></div><div id="fleet-alerts"></div></section>
    <section class="insight-panel quick-actions"><span class="eyebrow">VOTRE JOURNÉE</span><a href="#/plan">${workspaceIcon('ops')}<span>Planning des chauffeurs<small>Organiser les shifts et les véhicules</small></span>${workspaceIcon('arrow')}</a><a href="#/caisse">${workspaceIcon('finance')}<span>Suivre la caisse<small>Encaissements et dépenses</small></span>${workspaceIcon('arrow')}</a><a href="#/rapports">${workspaceIcon('analyse')}<span>Comptes rendus<small>Retrouver les bilans de la flotte</small></span>${workspaceIcon('arrow')}</a></section>
    <div class="fleet-note">${workspaceIcon('clock')}<p>Les statuts sont horodatés. Une source indisponible apparaît comme non observée.</p></div></aside></div></div>`;
  // Ne pas proposer un raccourci vers un volet que ce rôle ne peut pas utiliser.
  document.querySelectorAll('.quick-actions a').forEach(a => { const p = a.hash.slice(2); if (!canSee(p) || (p === 'caisse' && !canEdit())) a.remove(); });
  const paint = () => {
    if (my !== ROUTING) return;
    const agency = agFilter(), scoped = (data.drivers || []).filter(d => (!agency || String(d.agency_id) === String(agency)) && (!mineOn() || S.mine && S.mine.has(d.vehicle_key)));
    const rows = scoped, visibleIds = new Set(rows.map(d => d.id)), alerts = (data.alerts || []).filter(a => a.status === 'open' && visibleIds.has(a.driver_id));
    $('#fleet-sources').innerHTML = fleetSourceCards(data.sources);
    const counts = [rows.length, rows.filter(d => fleetHasState(d, 'available')).length, rows.filter(d => fleetHasState(d, 'on_trip')).length, rows.filter(d => fleetHasState(d, 'offline') && !['available', 'on_trip', 'to_pickup'].some(s => fleetHasState(d, s))).length];
    const labels = [['Chauffeurs suivis', 'Toutes les sources', 'rh'], ['Disponibles', 'Prêts pour une course', 'car'], ['En course', 'Activité observée', 'direct'], ['Hors ligne', 'Statut explicite de la source', 'clock']];
    $('#fleet-metrics').innerHTML = labels.map((x, i) => `<div class="fleet-metric metric-${i}"><div><span>${x[0]}</span>${workspaceIcon(x[2])}</div><strong>${counts[i]}</strong><small>${x[1]}</small></div>`).join('');
    $('#fleet-alerts').innerHTML = fleetAlertList(alerts);
    const q = normTxt(query), filtered = rows.filter(d => (!q || normTxt([d.name, d.vehicle_label, d.vehicle_key, d.ludy_driver_code, fleetVehicleSearch(d)].join(' ')).includes(q)) && (!provider || (d.sources || {})[provider]) && (!filter || fleetHasState(d, filter, provider)));
    const size = 25, pages = Math.max(1, Math.ceil(filtered.length / size)); page = Math.min(page, pages);
    const visible = filtered.slice((page - 1) * size, page * size);
    $('#fleet-roster-content').innerHTML = visible.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Chauffeur / véhicule</th><th>Uber Fleet</th><th>Bolt</th><th>Dernière lecture</th><th><span class="sr-only">Détails</span></th></tr></thead><tbody>${visible.map(d => `<tr><td><div class="fleet-driver"><span class="driver-avatar">${esc(fleetInitials(d.name))}</span><span><b>${esc(d.name || 'Chauffeur sans nom')}</b><small>${esc(d.vehicle_conflict ? 'Conflit d’affectation à vérifier' : d.vehicle_key ? 'Affectation Ludy : ' + d.vehicle_key : 'Affectation plateforme à confirmer')}</small></span></div></td><td data-label="Uber Fleet">${fleetPill(fleetObservation(d, 'uber'))}${fleetVehicleInfoHtml(d.sources?.uber, 'uber')}</td><td data-label="Bolt">${fleetPill(fleetObservation(d, 'bolt'))}${fleetVehicleInfoHtml(d.sources?.bolt, 'bolt')}</td><td class="fleet-last-seen">${esc(fleetAgo(fleetLastSeen(d)))}</td><td><button class="icon-button driver-history" data-id="${esc(d.id)}" aria-label="Voir la journée de ${esc(d.name)}">${workspaceIcon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>` : fleetEmpty(rows.length ? 'Aucun chauffeur ne correspond' : 'Votre flotte vous attend', rows.length ? 'Essayez un autre nom ou retirez un filtre.' : 'Connectez Uber Fleet ou Bolt pour retrouver ici les statuts de vos chauffeurs.', !rows.length && isAdmin() ? '<a class="button-link" href="#/connecteurs">Connecter une source ' + workspaceIcon('arrow') + '</a>' : '');
    $('#fleet-pagination').innerHTML = `<span>${filtered.length} chauffeur${filtered.length === 1 ? '' : 's'}${filtered.length ? ' · ' + ((page - 1) * size + 1) + '–' + Math.min(page * size, filtered.length) : ''}</span><div><button class="ghost small" id="fleet-prev" ${page <= 1 ? 'disabled' : ''}>Précédent</button><span>${page} / ${pages}</span><button class="ghost small" id="fleet-next" ${page >= pages ? 'disabled' : ''}>Suivant</button></div>`;
    $('#fleet-prev').onclick = () => { page--; paint(); }; $('#fleet-next').onclick = () => { page++; paint(); };
    document.querySelectorAll('.driver-history').forEach(b => b.onclick = () => fleetHistory(rows.find(d => String(d.id) === b.dataset.id), my));
  };
  const refresh = async () => {
    if (loading || my !== ROUTING) return;
    loading = true; const button = $('#fleet-refresh'); if (button) button.disabled = true;
    try { const next = await fleetApi('overview'); if (my !== ROUTING) return; data = next; paint(); $('#fleet-error').innerHTML = ''; $('#fleet-read-time').textContent = 'Actualisé à ' + localHM(new Date()); }
    catch (e) { if (my === ROUTING) { $('#fleet-error').innerHTML = msg(e.message, 'warn'); $('#fleet-read-time').textContent = 'Actualisation interrompue'; paint(); } }
    finally { loading = false; if (my === ROUTING && $('#fleet-refresh')) $('#fleet-refresh').disabled = false; }
  };
  $('#fleet-search').oninput = e => { query = e.target.value; clearTimeout(debounce); debounce = setTimeout(() => { page = 1; paint(); }, 120); };
  $('#fleet-provider').onchange = e => { provider = e.target.value; page = 1; paint(); };
  $('#fleet-filters').onclick = e => { const b = e.target.closest('[data-state]'); if (!b) return; filter = b.dataset.state; page = 1; document.querySelectorAll('#fleet-filters button').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', String(x === b)); }); paint(); };
  $('#fleet-refresh').onclick = refresh;
  paint(); await refresh();
  if (my === ROUTING) S.timers.push(setInterval(() => { if (!document.hidden) refresh(); }, 15000));
}
async function fleetHistory(driver, my) {
  if (!driver || my !== ROUTING) return;
  document.getElementById('fleet-history-dialog')?.remove();
  const dialog = document.createElement('dialog'); dialog.id = 'fleet-history-dialog'; dialog.className = 'fleet-history-dialog';
  dialog.innerHTML = `<div class="history-heading"><span class="driver-avatar">${esc(fleetInitials(driver.name))}</span><div><span class="eyebrow">JOURNÉE DU CHAUFFEUR</span><h2>${esc(driver.name)}</h2></div><button class="icon-button" id="history-close" aria-label="Fermer la fiche">${workspaceIcon('close')}</button></div><div class="history-toolbar"><label>Journée <input type="date" id="history-day" value="${today()}" max="${today()}"></label><small>Heure du Maroc</small><a id="history-performance" class="button-link secondary" href="#/performance-chauffeur?driver_id=${encodeURIComponent(driver.id)}">Performance et activité</a></div><section class="history-hint"><h3>Véhicules indiqués par les plateformes</h3><p>La plaque et le modèle décrivent la lecture de chaque plateforme. L’affectation actuelle à la fiche Ludy est vérifiée séparément.</p>${driver.vehicle_conflict ? '<p class="ops-link-needed">Conflit d’affectation à vérifier</p>' : ''}${['uber', 'bolt'].filter(p => driver.sources?.[p]).map(p => `<p><b>${esc(FLEET_PROVIDERS[p])}</b> ${fleetPill(fleetObservation(driver, p))}${fleetVehicleInfoHtml(driver.sources[p], p) || '<br><small>Véhicule non lu</small>'}</p>`).join('')}</section><div id="history-link"></div><div id="history-content" aria-live="polite"></div>`;
  document.body.appendChild(dialog); dialog.showModal();
  const close = () => { dialog.close(); dialog.remove(); }; $('#history-close').onclick = close; $('#history-performance').onclick=close; dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', e => { if (e.target === dialog) { const b = dialog.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) close(); } });
  let request = 0;
  const load = async () => {
    const n = ++request, day = $('#history-day').value; if (!day) return;
    $('#history-content').innerHTML = '<div class="loading">Lecture de la chronologie…</div>';
    const bounds = dayBounds(day);
    try {
      const result = await fleetApi('history?' + new URLSearchParams({ driver_id: driver.id, from: bounds.start.toISOString(), to: new Date(Math.min(bounds.end.getTime(), Date.now())).toISOString() }));
      if (!dialog.isConnected || n !== request || my !== ROUTING) { if (my !== ROUTING) close(); return; }
      const rows = result.observations || [], intervals = result.intervals || [];
      const timeline = intervals.map(i => { const start = i.start_at || i.start || i.from, end = i.end_at || i.end || i.to; return `<div class="history-interval"><span>${esc(FLEET_PROVIDERS[i.source || i.provider] || i.source || i.provider || '')}</span>${fleetPill({ status: i.status || i.state })}<span>${esc(start ? localHM(start) : '—')} → ${esc(end ? localHM(end) : '—')}</span></div>`; }).join('');
      $('#history-content').innerHTML = rows.length || intervals.length ? `<p class="history-hint">Historique des observations enregistrées. Les périodes sans lecture restent inconnues.</p>${timeline ? '<div class="history-timeline">' + timeline + '</div>' : ''}<h3>Dernières observations</h3><div class="history-observations">${rows.slice().reverse().slice(0, 100).map(o => `<div><span>${esc(fmtDT(o.observed_at || o.received_at))}</span><span><b>${esc(FLEET_PROVIDERS[o.source || o.provider] || o.source || o.provider || '')}</b>${fleetVehicleInfoHtml(o, o.source || o.provider)}</span>${fleetPill(o)}</div>`).join('')}</div>` : fleetEmpty('Pas encore d’observations', 'La chronologie se construit à partir des lectures enregistrées pendant cette journée.');
    } catch (e) { if (dialog.isConnected && n === request) $('#history-content').innerHTML = msg(e.message, 'err'); }
  };
  $('#history-day').onchange = load;
  if (isAdmin()) {
    all('drivers', 'code,name', null, ['name']).then(drivers => {
      if (!dialog.isConnected || my !== ROUTING) return;
      $('#history-link').innerHTML = `<form id="history-link-form" class="history-link-form"><label>Fiche Ludy associée<select id="history-ludy-driver" required><option value="">Choisir un chauffeur…</option>${drivers.map(d => `<option value="${esc(d.code)}" ${d.code === driver.ludy_driver_code ? 'selected' : ''}>${esc(d.name)} · ${esc(d.code)}</option>`).join('')}</select></label><label>Affectation du véhicule<select id="history-vehicle-mode"><option value="automatic" ${!driver.auto_link_disabled && driver.vehicle_link_method !== 'manual' ? 'selected' : ''}>Automatique · plaques Uber / Bolt</option><option value="manual" ${driver.auto_link_disabled || driver.vehicle_link_method === 'manual' ? 'selected' : ''}>Manuelle · véhicule fixé</option></select></label><label id="history-vehicle-label">Véhicule utilisé actuellement<select id="history-vehicle"><option value="">Aucun véhicule associé</option>${S.vehList.filter(v => inAgency()(v.key)).map(v => `<option value="${esc(v.key)}" ${v.key === driver.vehicle_key ? 'selected' : ''}>${esc(v.plate)} · ${esc(v.model || '')}${v.geotab_id ? '' : ' · Geotab non associé'}</option>`).join('')}</select></label><button class="ghost small" type="submit">Enregistrer l’association</button><p>En mode automatique, Ludy associe le véhicule grâce aux plaques récentes d’Uber et Bolt et suit les changements de shift. La fiche chauffeur choisie reste conservée. Deux conducteurs signalés simultanément sur la même voiture restent à vérifier. Le mode manuel fixe le véhicule jusqu’à votre prochaine modification.</p><div id="history-link-result" role="status"></div></form>`;
      const paintMode = () => { const automatic = $('#history-vehicle-mode').value === 'automatic'; $('#history-vehicle').disabled = automatic; $('#history-vehicle-label').hidden = automatic; };
      $('#history-vehicle-mode').onchange = paintMode; paintMode();
      $('#history-link-form').onsubmit = async e => {
        e.preventDefault(); const button = e.target.querySelector('button'), code = $('#history-ludy-driver').value, mode = $('#history-vehicle-mode').value, vehicleKey = mode === 'manual' ? $('#history-vehicle').value || null : null; if (!code) return;
        button.disabled = true;
        try {
          const result = await fleetApi('drivers/link', { driver_id: driver.id, ludy_driver_code: code, vehicle_mode: mode, ...(mode === 'manual' ? { vehicle_key: vehicleKey } : {}) });
          if (!dialog.isConnected || my !== ROUTING) return;
          Object.assign(driver, result.drivers?.[0] || { id: result.driver_id || driver.id, ludy_driver_code: code, vehicle_key: vehicleKey });
          if (typeof OPS !== 'undefined') OPS.overviewAt = 0;
          $('#history-link-result').innerHTML = msg(mode === 'automatic' ? (result.association_pending ? 'Mode automatique enregistré. Le rapprochement sera réessayé à la prochaine lecture.' : 'Association automatique activée. Le véhicule se met à jour dès qu’une plaque actuelle et une correspondance unique sont disponibles.') : vehicleKey ? 'Fiche et véhicule associés manuellement. La surveillance dépend de lectures récentes des plateformes et de Geotab.' : 'Fiche associée sans véhicule. La surveillance des 200 m est inactive pour ce chauffeur.', 'ok'); await load();
        } catch (error) { if (dialog.isConnected) $('#history-link-result').innerHTML = msg(error.message, 'err'); }
        finally { button.disabled = false; }
      };
    }).catch(() => {});
  }
  await load();
}
function setupMyclicarConnector(my) {
  let current = null, busy = false, loading = false, revision = 0;
  const user = S.session?.user?.id;
  const present = () => my === ROUTING && S.session?.user?.id === user && $('#myclicar-connect');
  const result = (text, type = 'ok') => { if (present()) $('#myclicar-result').innerHTML = msg(esc(text), type); };
  const controls = () => {
    if (!present()) return;
    const remote = current?.collectionRemote === true;
    $('#myclicar-connect button').disabled = busy || remote;
    for (const id of ['myclicar-email', 'myclicar-http-user', 'myclicar-password', 'myclicar-http-password']) $('#' + id).disabled = busy || remote;
    const active = current?.auto_resume === true || current?.polling === true;
    $('#myclicar-start').hidden = remote || active;
    $('#myclicar-start').disabled = busy || remote || !current?.configured;
    $('#myclicar-stop').hidden = remote || !active;
    $('#myclicar-stop').disabled = busy || remote;
    $('#myclicar-password').required = !current?.configured;
    $('#myclicar-http-password').required = !current?.httpConfigured;
  };
  const render = data => {
    if (!present()) return;
    // Only public status fields are retained; password fields are never populated from a response.
    current = { configured: data.configured, httpConfigured: data.httpConfigured, polling: data.polling, auto_resume: data.auto_resume, collectionRemote: data.collectionRemote };
    const state = fleetConnectorState(data, 60), coverage = data.coverage || {};
    $('#myclicar-health').className = 'source-status ' + state.tone;
    $('#myclicar-health').textContent = state.label;
    $('#myclicar-automation').innerHTML = fleetConnectorAutomation(data, 60);
    const count = (key, one, many) => {
      const value = Number.isSafeInteger(coverage[key]) && coverage[key] >= 0 ? coverage[key] : '—';
      return `${value} ${value === 1 ? one : many}`;
    };
    $('#myclicar-summary').textContent = data.configured ? `${count('contracts', 'contrat lu', 'contrats lus')} · ${count('active_contracts', 'actif', 'actifs')} · ${count('matched_assignments', 'affectation rapprochée', 'affectations rapprochées')} · ${count('unmatched_contracts', 'contrat à rapprocher', 'contrats à rapprocher')}. Dernière lecture : ${data.last_success_at ? fmtDTY(data.last_success_at) : 'aucune'}.` : 'En attente des accès MyClicar et de la protection HTTP.';
    $('#myclicar-read-error').innerHTML = data.last_error && !state.active ? msg(esc(data.last_error), 'warn') : '';
    const form = $('#myclicar-connect');
    if (!form.dataset.loaded) {
      if (!$('#myclicar-email').value) $('#myclicar-email').value = data.email || '';
      if (!$('#myclicar-http-user').value) $('#myclicar-http-user').value = data.httpUsername || '';
      form.dataset.loaded = '1';
    }
    controls();
  };
  const load = async () => {
    if (!present() || loading || busy) return;
    loading = true; const request = revision;
    try { const data = await fleetApi('myclicar/status'); if (request === revision && !busy) render(data); }
    catch (e) { if (request === revision && !busy) result(e.message, 'err'); }
    finally { loading = false; }
  };
  const mutate = async (route, body, success) => {
    if (!present() || busy || current?.collectionRemote === true) return;
    busy = true; revision++; controls(); result(route === 'myclicar/connect' ? 'Vérification des accès MyClicar…' : 'Mise à jour du suivi…', 'info');
    try {
      const data = await fleetApi(route, body);
      if (present()) { render(data); result(success); }
    } catch (e) { result(e.message, 'err'); }
    finally {
      delete body.password; delete body.httpPassword;
      busy = false; controls();
    }
  };
  $('#myclicar-connect').onsubmit = async event => {
    event.preventDefault(); if (!present() || busy || current?.collectionRemote === true) return;
    const body = { email: $('#myclicar-email').value.trim(), httpUsername: $('#myclicar-http-user').value.trim() };
    if ($('#myclicar-password').value) body.password = $('#myclicar-password').value;
    if ($('#myclicar-http-password').value) body.httpPassword = $('#myclicar-http-password').value;
    $('#myclicar-password').value = ''; $('#myclicar-http-password').value = '';
    await mutate('myclicar/connect', body, 'Accès vérifiés et enregistrés sur le serveur local.');
  };
  $('#myclicar-start').onclick = () => mutate('myclicar/start', {}, 'Demande de suivi automatique enregistrée.');
  $('#myclicar-stop').onclick = () => mutate('myclicar/stop', {}, 'Suivi MyClicar en pause. Cette pause reste conservée au redémarrage.');
  controls();
  return load;
}
function setupGeotabConnector(my) {
  let current = null, busy = false, loading = false, mappingSignature = '';
  const mappingDrafts = new Map(), optionLimit = 50;
  const present = () => my === ROUTING && $('#geotab-connect');
  const normalizedPlate = value => String(value || '').toUpperCase().replace(/[\s-]/g, '');
  const result = (text, type = 'ok') => { if (present()) $('#geotab-result').innerHTML = msg(esc(text), type); };
  const controls = () => {
    if (!present()) return;
    const remote = current?.collectionRemote === true;
    $('#geotab-connect button').disabled = busy || remote;
    for (const id of ['geotab-database', 'geotab-user', 'geotab-password']) $('#' + id).disabled = busy || remote;
    $('#geotab-devices').disabled = busy || remote || !current?.configured;
    const active = current?.auto_resume === true || current?.polling === true;
    $('#geotab-start').hidden = remote || active;
    $('#geotab-start').disabled = busy || remote || !current?.configured || !(current.vehicles || []).some(v => v.geotab_id);
    $('#geotab-stop').hidden = remote || !active; $('#geotab-stop').disabled = busy || remote;
    document.querySelectorAll('.geotab-link-form button,.geotab-link-form select,.geotab-link-form input').forEach(el => { el.disabled = busy || remote; });
  };
  const render = data => {
    current = data;
    const state = fleetConnectorState(data, 2);
    $('#geotab-health').className = 'source-status ' + state.tone;
    $('#geotab-health').textContent = state.label;
    const vehicles = data.vehicles || [], devices = data.devices || [], linked = vehicles.filter(v => v.geotab_id).length;
    const interval = Number.isFinite(Number(data.interval_s)) && Number(data.interval_s) >= 2 ? Number(data.interval_s) : 2;
    $('#geotab-summary').textContent = data.collectionRemote ? `Positions partagées par le poste central. Dernière lecture : ${data.last_success_at ? fmtHMS(data.last_success_at) : 'aucune'}.` : data.configured ? `${linked} véhicule${linked === 1 ? '' : 's'} associé${linked === 1 ? '' : 's'} sur ${vehicles.length} · ${devices.length} boîtiers accessibles. Dernière lecture : ${data.last_success_at ? fmtHMS(data.last_success_at) : 'aucune'}.` : 'En attente des accès MyGeotab.';
    $('#geotab-automation').innerHTML = fleetConnectorAutomation(data, interval);
    if (!$('#geotab-connect').dataset.loaded) {
      if (data.database) $('#geotab-database').value = data.database;
      if (data.userName) $('#geotab-user').value = data.userName;
      $('#geotab-connect').dataset.loaded = '1';
    }
    const signature = JSON.stringify([data.configured, data.collectionRemote, vehicles, devices]);
    if (signature !== mappingSignature && !busy) {
      mappingSignature = signature;
      const linkedIds = new Set(vehicles.map(v => v.geotab_id).filter(Boolean));
      const deviceById = new Map(devices.map(device => [device.id, device]));
      const searchable = devices.map(device => ({ device, text: normTxt([device.plate, device.name, device.id].join(' ')), plate: normalizedPlate(device.plate) }));
      $('#geotab-links').innerHTML = data.collectionRemote ? '<p>Les associations des véhicules et boîtiers sont gérées sur le poste de collecte.</p>' : !data.configured ? '<p>Connectez MyGeotab pour afficher les boîtiers accessibles.</p>' : !vehicles.length ? '<p>Aucun véhicule Ludy disponible.</p>' : vehicles.map((vehicle, index) => {
        const matches = devices.filter(d => normalizedPlate(vehicle.plate) && normalizedPlate(d.plate) === normalizedPlate(vehicle.plate) && !linkedIds.has(d.id));
        const suggested = !vehicle.geotab_id && matches.length === 1 ? matches[0].id : '';
        const saved = vehicle.geotab_id || '', previous = mappingDrafts.get(vehicle.key);
        if (!previous || previous.base !== saved) mappingDrafts.set(vehicle.key, { base: saved, value: saved || suggested, query: previous?.query || '', suggestion: !!suggested });
        const draft = mappingDrafts.get(vehicle.key);
        return `<form class="geotab-link-form" data-index="${index}"><label for="geotab-device-${index}"><b>${esc(vehicle.plate || vehicle.key)}</b><small>${esc(vehicle.model || '')}</small></label><div><input class="geotab-search" type="search" maxlength="100" placeholder="Rechercher une plaque ou un boîtier" aria-label="Rechercher le boîtier de ${esc(vehicle.plate || vehicle.key)}" value="${esc(draft.query)}" autocomplete="off"><small class="geotab-search-count" aria-live="polite"></small><select id="geotab-device-${index}" aria-label="Boîtier de ${esc(vehicle.plate || vehicle.key)}"><option value="">Non associé</option></select><small class="geotab-match-note"></small></div><button type="submit" class="ghost small">Enregistrer</button></form>`;
      }).join('');
      document.querySelectorAll('.geotab-link-form').forEach(form => {
        const vehicle = vehicles[Number(form.dataset.index)], draft = mappingDrafts.get(vehicle.key), select = form.querySelector('select'), search = form.querySelector('.geotab-search');
        const note = () => {
          form.querySelector('.geotab-match-note').textContent = draft.value !== draft.base ? draft.suggestion ? 'Plaque identique : proposition à vérifier et enregistrer.' : 'Modification à enregistrer.' : draft.base ? 'Association enregistrée.' : 'Choisissez le boîtier de ce véhicule.';
        };
        const options = () => {
          const query = normTxt(draft.query), plateQuery = normalizedPlate(draft.query);
          const matches = searchable.filter(item => !query || item.text.includes(query) || plateQuery && item.plate.includes(plateQuery));
          const visible = matches.slice(0, optionLimit).map(item => item.device);
          const selected = deviceById.get(draft.value);
          if (selected && !visible.some(device => device.id === draft.value)) visible.unshift(selected);
          select.innerHTML = '<option value="">Non associé</option>' + (draft.value && !selected ? `<option value="${esc(draft.value)}">Sélection absente du catalogue</option>` : '') + visible.map(device => `<option value="${esc(device.id)}">${esc([device.plate, device.name || device.id].filter(Boolean).join(' · '))}</option>`).join('');
          // Filtering must never select the first match or silently clear a pending association.
          select.value = draft.value;
          form.querySelector('.geotab-search-count').textContent = matches.length > optionLimit ? `${matches.length} résultats · ${optionLimit} premiers affichés. Précisez la recherche ; la sélection reste visible.` : `${matches.length} résultat${matches.length === 1 ? '' : 's'}${draft.value && !matches.some(item => item.device.id === draft.value) ? ' · sélection conservée hors filtre' : ''}.`;
          note();
        };
        options();
        form.onsubmit = async event => {
          event.preventDefault(); if (busy) return;
          const id = select.value || null;
          await mutate('geotab/link', { vehicle_key: vehicle.key, device_id: id }, id ? 'Association enregistrée dans Ludy staging.' : 'Association retirée dans Ludy staging.');
        };
        select.onchange = () => { draft.value = select.value; draft.suggestion = false; note(); };
        search.oninput = () => { draft.query = search.value; options(); };
        search.onkeydown = event => { if (event.key === 'Enter') event.preventDefault(); };
      });
    }
    controls();
  };
  const load = async () => {
    if (!present() || loading || busy) return;
    loading = true;
    try { const data = await fleetApi('geotab/status'); if (present()) render(data); }
    catch (e) { result(e.message, 'err'); }
    finally { loading = false; }
  };
  const mutate = async (route, body, success) => {
    if (busy || current?.collectionRemote === true) return;
    busy = true; controls(); result('Lecture en cours…', 'info');
    try { await fleetApi(route, body); result(success); }
    catch (e) { result(e.message, 'err'); }
    finally {
      if (body && 'password' in body) body.password = '';
      busy = false; mappingSignature = ''; controls(); await load();
    }
  };
  $('#geotab-connect').onsubmit = async event => {
    event.preventDefault(); if (busy || current?.collectionRemote === true) return;
    const body = { database: $('#geotab-database').value.trim(), userName: $('#geotab-user').value.trim(), password: $('#geotab-password').value };
    $('#geotab-password').value = '';
    await mutate('geotab/connect', body, current?.auto_resume ? 'Accès vérifiés. Le suivi reprend automatiquement avec les nouveaux accès.' : 'Accès vérifiés et enregistrés. Associez les véhicules, puis activez le suivi automatique.');
  };
  $('#geotab-start').onclick = () => mutate('geotab/start', {}, 'Suivi automatique activé. Ludy reprend les lectures après une coupure ou un redémarrage.');
  $('#geotab-stop').onclick = () => mutate('geotab/stop', {}, 'Suivi Geotab en pause. Cette pause reste conservée au redémarrage.');
  $('#geotab-devices').onclick = () => mutate('geotab/devices', {}, 'Catalogue des boîtiers actualisé.');
  return load;
}
function setupFleetValidation(my) {
  let busy = false;
  const present = () => my === ROUTING && $('#validation-summary');
  function render(data) {
    if (!present()) return;
    const started = data.status !== 'not_started';
    $('#validation-start').hidden = started;
    $('#validation-summary').textContent = !started ? 'Observation pas encore démarrée.' : `${data.status === 'completed' ? 'Collecte terminée, rapport à examiner' : 'Observation en cours'} · ${data.progress_pct}% · ${data.observed_hours} h observées · ${data.gaps} interruption(s). Fin prévue : ${fmtDTY(data.target_at)}.${data.confirmed_contradictions ? ' Incohérences persistantes à examiner : ' + data.confirmed_contradictions + '.' : ''}${data.last_error ? ' ' + data.last_error : ''}`;
    $('#validation-sources').innerHTML = Object.entries(data.sources || {}).map(([id, s]) => `<span>${esc(FLEET_PROVIDERS[id] || id)}</span><b>${Number(s.availability_pct) || 0}% des contrôles avec des données récentes${s.partial_samples ? ' · ' + Number(s.partial_samples) + ' lecture(s) partielle(s)' : ''}</b>`).join('');
    $('#validation-incidents').textContent = started ? data.real_motion_incident_seen ? 'Un incident réel de déplacement a été observé ; son détail reste accessible dans les alertes.' : 'Aucun nouvel incident réel de déplacement observé pendant cette période. Les scénarios automatisés ne remplacent pas cette observation.' : '';
  }
  const load = async () => {
    if (busy || !present()) return;
    busy = true;
    try { render(await fleetApi('validation/status')); }
    catch { if (present()) $('#validation-summary').textContent = 'Rapport de stabilité momentanément indisponible.'; }
    finally { busy = false; }
  };
  $('#validation-start').onclick = async () => {
    if (busy) return; busy = true; $('#validation-start').disabled = true;
    try { render(await fleetApi('validation/start', {})); }
    catch (e) { if (present()) $('#validation-summary').textContent = e.message; }
    finally { busy = false; if (present()) $('#validation-start').disabled = false; }
  };
  return load;
}
function setupTeksatConnector(my) {
  const user = S.session?.user?.id;
  let loading = false, busy = false;
  const present = () => my === ROUTING && user === S.session?.user?.id && isAdmin() && $('#texat-health');
  const render = data => {
    if (!present()) return;
    const archive = data.rawArchive;
    $('#texat-health').className = 'source-status ' + (data.connection === 'verified' ? 'ok' : 'mute');
    $('#texat-health').textContent = data.connection === 'verified' ? 'Accès vérifié' : data.connection === 'error' ? 'Lecture indisponible' : data.configured ? 'En attente de lecture' : 'À connecter';
    $('#texat-summary').textContent = data.coverage ? `${data.coverage.positionsReturned ?? 0} positions reçues · ${archive?.mappedVehicles ?? 0} véhicules associés à l’historique. Dernière lecture : ${data.lastSuccessAt ? fmtDTY(data.lastSuccessAt) : 'aucune'}.` : 'Aucune position reçue pour le moment.';
    $('#texat-archive').textContent = archive ? `${archive.collectionRunning ? 'Conservation automatique active' : 'Conservation automatique arrêtée'} · ${archive.entries ?? 0} observations conservées · ${((archive.bytes || 0) / 1048576).toFixed(1)} Mo sur ${Math.round((archive.maxBytes || 0) / 1048576)} Mo. ${archive.lastSave ? 'Dernier enregistrement : ' + fmtDTY(archive.lastSave) + '.' : ''} ${archive.pending ? archive.pending + ' observations en attente d’écriture.' : ''}` : 'Historique de secours non activé.';
    const alert = archive?.full || /archive_full$/.test(archive?.stoppedReason || '') ? 'Le stockage de l’historique est plein. La collecte est arrêtée et les données existantes sont conservées.' : archive?.warning ? 'Le stockage de l’historique approche de sa capacité. Prévoir son extension pour poursuivre la collecte.' : archive?.stoppedReason ? 'La conservation est arrêtée : vérifier les accès et les associations des véhicules avant de la reprendre.' : '';
    $('#texat-warning').textContent = alert;
    $('#texat-refresh').disabled = busy || !data.configured;
  };
  const load = async () => {
    if (!present() || loading || busy) return;
    loading = true;
    try { render(await fleetApi('texat/status')); }
    catch { if (present()) $('#texat-result').textContent = 'Statut Teksat indisponible. Réessaie dans quelques instants.'; }
    finally { loading = false; }
  };
  $('#texat-refresh').onclick = async () => {
    if (!present() || busy) return;
    busy = true; $('#texat-refresh').disabled = true; $('#texat-result').textContent = 'Vérification en cours…';
    try {
      const data = await fleetApi('texat/refresh', {});
      if (!present()) return;
      render(data); $('#texat-result').textContent = data.connection === 'verified' ? 'Lecture Teksat vérifiée.' : 'Lecture impossible. Vérifier la configuration du connecteur.';
    } catch (error) { if (present()) $('#texat-result').textContent = error.message; }
    finally { busy = false; if (present()) await load(); }
  };
  return load;
}

async function pageWebConnecteurs() {
  if (!['admin', 'manager', 'viewer'].includes(S.profile?.role)) { $('#page').innerHTML = msg('Cette page n’est pas accessible à votre compte.', 'warn'); return; }
  const my = ROUTING, owner = S.session?.user?.id, revision = S.sessionRevision;
  const current = () => my === ROUTING && owner === S.session?.user?.id && revision === S.sessionRevision;
  let reading = false;
  $('#page').innerHTML = `<div class="fleet-page"><div class="fleet-heading"><div><div class="eyebrow">DONNÉES PARTAGÉES</div><h1>Vos sources, au même endroit<span>.</span></h1><p>La collecte est assurée par le PC fixe. Chaque compte consulte les données selon ses droits.</p></div><a class="button-link secondary" href="#/cockpit">Retour à la flotte ${workspaceIcon('arrow')}</a></div><div class="panel"><p>Les accès aux fournisseurs et les commandes de collecte se gèrent sur le poste collecteur. Fermer Ludy dans ce navigateur n’interrompt pas les lectures.</p>${isAdmin() ? '<p><a href="#/uber-rapports">Réglages métier et rapports Uber</a></p>' : ''}<button class="ghost" id="web-connectors-refresh">Actualiser l’état</button></div><div id="connect-status" role="status"></div><div class="connector-grid" id="web-connectors-sources"></div></div>`;
  const load = async () => {
    if (reading || document.hidden || !current()) return;
    reading = true;
    try {
      const data = await fleetApi('health');
      if (!current()) return;
      $('#web-connectors-sources').innerHTML = Object.entries({ ...FLEET_PROVIDERS, texat: 'Teksat' }).map(([id, label]) => {
        const source = data.sources?.find(item => item.id === id), at = Date.parse(source?.last_success_at), staleAfter = Number(source?.stale_after_s);
        const stale = Number.isFinite(at) && staleAfter > 0 && Date.now() - at > staleAfter * 1000;
        const [state, tone] = !source || !Number.isFinite(at) && source.status === 'unconnected' ? ['En attente de données', 'mute'] : fleetSourceState(stale ? { status: 'stale' } : source);
        return `<section class="connector-card"><div class="connector-title"><span class="source-logo ${id}">${id === 'bolt' ? workspaceIcon('bolt') : label[0]}</span><div><h2>${label}</h2><span class="connector-kind">Collecte centrale · Données partagées</span></div><span class="source-status ${tone}">${state}</span></div><p>${Number.isFinite(at) ? 'Dernière lecture : ' + esc(fmtDT(source.last_success_at)) : 'Aucune lecture reçue.'}</p>${stale ? '<p class="warn">La dernière lecture est ancienne. Le poste collecteur doit être vérifié.</p>' : tone === 'warn' ? '<p class="warn">Cette source demande une vérification sur le poste collecteur.</p>' : ''}</section>`;
      }).join('');
      $('#connect-status').textContent = 'État actualisé. Les dates affichées indiquent la fraîcheur de chaque source.';
    } catch (error) {
      if (current() && error?.name !== 'AbortError') $('#connect-status').innerHTML = msg('État des sources indisponible. Les dernières données affichées sont conservées ; réessayez.', 'warn');
    } finally { reading = false; }
  };
  $('#web-connectors-refresh').onclick = load;
  await load();
  if (current()) S.timers.push(setInterval(load, 30000));
}

async function pageConnecteurs() {
  if (CFG.WEB_PRODUCTION) return pageWebConnecteurs();
  if (!isAdmin()) { $('#page').innerHTML = msg('Cette page est réservée aux administrateurs.', 'warn'); return; }
  const my = ROUTING; let alertSettings = {}, reading = false, boltBusy = false, boltConfigBusy = false, boltLocalConfigured = null, boltConfigError = null, connectorSources = [];
  $('#page').innerHTML = `<div class="fleet-page"><div class="fleet-heading"><div><div class="eyebrow">ADMINISTRATION</div><h1>Vos sources, au même endroit<span>.</span></h1><p>Activez le suivi une fois. Ludy reprend automatiquement les lectures après une coupure.</p></div><a class="button-link secondary" href="#/cockpit">Retour à la flotte ${workspaceIcon('arrow')}</a></div><div id="connect-status" role="status"></div><div class="connector-grid">
    <section class="connector-card"><div class="connector-title"><span class="source-logo uber">U</span><div><h2>Uber Fleet</h2><span class="connector-kind">Lecture du portail · Deuxième écran</span></div><span id="uber-health"></span></div><p>Gardez la carte Uber Fleet ouverte sur votre deuxième écran. L’extension fait défiler la liste pour lire aussi les chauffeurs au-delà des premières lignes. Gardez la liste sans recherche ni filtre restrictif ; le parcours respecte les filtres affichés.</p><ol><li>Installez l’extension locale <a href="/uber-extension/" target="_blank" rel="noopener">Ludy — Uber Fleet</a>.</li><li>Générez un code d’association et collez-le dans l’extension.</li><li>Dans Uber Fleet, démarrez la lecture et laissez la page ouverte.</li></ol><p>Dans l’extension 0.5.1, activez « Reprendre automatiquement » pour retrouver la lecture après fermeture de l’onglet ou du navigateur. L’autorisation Uber est facultative ; sans elle, cliquez de nouveau sur Démarrer. L’extension ne reconnecte pas votre session Uber.</p><div class="uber-legend">${fleetPill({status:'available'})}${fleetPill({status:'on_trip'})}${fleetPill({status:'to_pickup'})}</div><div id="uber-summary" class="connector-read-summary" role="status"></div><button id="uber-pair">Associer mon écran Uber ${workspaceIcon('arrow')}</button><div id="uber-pair-result" aria-live="polite"></div></section>
    <section class="connector-card"><div class="connector-title"><span class="source-logo bolt">${workspaceIcon('bolt')}</span><div><h2>Bolt</h2><span class="connector-kind">Fleet API v2 · Lecture des données</span></div><span id="bolt-health"></span></div><p>Retrouvez les chauffeurs et leurs états directement depuis votre compte Bolt Fleet.</p><div class="connector-detail"><span>Authentification</span><b>Accès privés sur ce poste</b><span>Données</span><b>Chauffeurs, véhicules et activité</b><span>Dernière lecture</span><b id="bolt-last">Pas encore synchronisé</b></div>
      <p id="bolt-config-state" role="status">Vérification des accès enregistrés sur ce poste…</p><form id="bolt-config" class="myclicar-form" method="post" autocomplete="off"><label>Identifiant client Bolt<input id="bolt-client-id" name="clientId" required maxlength="512" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>Secret client Bolt<input id="bolt-client-secret" name="clientSecret" type="password" required maxlength="4096" autocomplete="off" aria-describedby="bolt-config-help"></label><button id="bolt-config-save" type="submit">Enregistrer les accès sur ce poste</button></form><p id="bolt-config-help" class="connector-footnote">Renseignez les deux accès de l’API Bolt Fleet pour préparer cet ordinateur. L’enregistrement ne vérifie pas encore leur validité et ne démarre aucune lecture. Les accès enregistrés ne sont jamais réaffichés ; renseignez-les de nouveau pour les remplacer.</p><div id="bolt-config-result" role="status" aria-live="polite"></div>
      <div id="bolt-coverage" class="connector-read-summary"></div><div id="bolt-automation" role="status"></div><button id="bolt-refresh">Activer le suivi automatique ${workspaceIcon('refresh')}</button><button id="bolt-stop" class="ghost" hidden>Mettre en pause</button><div id="bolt-result" aria-live="polite"></div></section>
    <section class="connector-card geotab-connector"><div class="connector-title"><span class="source-logo geotab">G</span><div><h2>Geotab</h2><span class="connector-kind">Positions, contact, consommation et conduite</span></div><span id="geotab-health" class="source-status mute">À connecter</span></div>
      <p>Connectez le compte MyGeotab dédié au staging, puis associez les boîtiers aux véhicules Ludy. Les positions visent une lecture toutes les 2 secondes, les événements de conduite toutes les 10 secondes et les compteurs toutes les 30 secondes. La cadence s’adapte au nombre de véhicules et aux réponses Geotab.</p>
      <form id="geotab-connect" class="geotab-form" autocomplete="off"><label>Base MyGeotab<input id="geotab-database" name="database" value="clicar" required maxlength="128" autocapitalize="none" spellcheck="false"></label><label>Identifiant MyGeotab<input id="geotab-user" name="username" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>Mot de passe MyGeotab<input id="geotab-password" name="password" type="password" required maxlength="1024" autocomplete="new-password"></label><button type="submit">Tester et enregistrer</button></form>
      <p class="geotab-privacy">Les accès sont conservés sur le serveur local. Après la première activation, le suivi reprend automatiquement ; une pause manuelle reste respectée.</p>
      <div id="geotab-result" role="status" aria-live="polite"></div><div id="geotab-automation" role="status"></div><div id="geotab-summary" class="geotab-summary"></div>
      <details id="geotab-mappings"><summary>Associer les véhicules aux boîtiers</summary><p>Vérifiez chaque correspondance avant de l’enregistrer. Une proposition de plaque n’est pas une association.</p><div id="geotab-links"><p>Connectez MyGeotab pour afficher les boîtiers accessibles.</p></div><button id="geotab-devices" type="button" class="ghost" disabled>Actualiser les boîtiers</button></details>
      <div class="geotab-actions"><button id="geotab-start" disabled>Activer le suivi automatique</button><button id="geotab-stop" class="ghost" hidden>Mettre en pause</button><a href="#/direct" class="button-link secondary">Ouvrir la carte ${workspaceIcon('arrow')}</a></div>
      <p>Les positions conservent l’heure transmise par le boîtier. Les compteurs du jour alimentent la consommation ; les règles Geotab alimentent les alertes de conduite. Dans la fiche d’un chauffeur de la vue d’ensemble, associez son véhicule pour surveiller les déplacements de plus de 200 m lorsqu’Uber ou Bolt le signale hors ligne.</p></section>
    <section class="connector-card texat-connector"><div class="connector-title"><span class="source-logo geotab">T</span><div><h2>Teksat</h2><span class="connector-kind">Historique de secours Geotab</span></div><span id="texat-health" class="source-status mute">En attente</span></div>
      <p>Les positions des véhicules associés sont conservées toutes les minutes après chaque lecture. Geotab reste la source principale.</p>
      <div id="texat-summary" class="connector-read-summary" role="status"></div><div id="texat-archive" class="connector-read-summary"></div><p id="texat-warning" role="status"></p>
      <p>Le basculement automatique attend la confirmation du fuseau des horodatages et de la validité des positions GPS Teksat. Les données reçues restent disponibles pour les corrections ultérieures. Le kilométrage et le carburant de secours ne sont pas encore calculables avec les données confirmées.</p>
      <button id="texat-refresh" class="ghost" disabled>Vérifier la connexion</button><div id="texat-result" role="status" aria-live="polite"></div></section>
    <section class="connector-card myclicar-connector"><div class="connector-title"><span class="source-logo myclicar">C</span><div><h2>MyClicar</h2><span class="connector-kind">Contrats et affectations</span></div><span id="myclicar-health" class="source-status mute">À connecter</span></div>
      <p>Connectez MyClicar sur new.clicar.ma pour lire les contrats et rapprocher les affectations chauffeur–véhicule dans Ludy staging. La protection HTTP du site et le compte de l’application utilisent deux accès distincts.</p>
      <form id="myclicar-connect" class="myclicar-form" autocomplete="off"><fieldset><legend>Compte MyClicar</legend><label>E-mail MyClicar<input id="myclicar-email" name="email" type="email" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>Mot de passe MyClicar<input id="myclicar-password" name="password" type="password" required maxlength="1024" autocomplete="off" aria-describedby="myclicar-password-help"></label></fieldset><fieldset><legend>Protection HTTP de new.clicar.ma</legend><label>Identifiant HTTP<input id="myclicar-http-user" name="httpUsername" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>Mot de passe HTTP<input id="myclicar-http-password" name="httpPassword" type="password" required maxlength="1024" autocomplete="off" aria-describedby="myclicar-password-help"></label></fieldset><button type="submit">Tester et enregistrer</button></form>
      <p id="myclicar-password-help" class="connector-footnote">Les accès sont vérifiés avant leur enregistrement sur le serveur local. Les mots de passe enregistrés ne sont jamais affichés ; laissez leur champ vide pour les conserver.</p>
      <div id="myclicar-result" role="status" aria-live="polite"></div><div id="myclicar-automation" role="status"></div><div id="myclicar-summary" class="connector-read-summary" aria-live="polite"></div><div id="myclicar-read-error" role="status"></div>
      <div class="geotab-actions"><button id="myclicar-start" disabled>Activer le suivi automatique</button><button id="myclicar-stop" class="ghost" hidden>Mettre en pause</button><a href="#/contrats" class="button-link secondary">Consulter les contrats ${workspaceIcon('arrow')}</a></div><p>La lecture alimente uniquement les contrats et affectations du staging. Les contacts et les données financières ne sont pas copiés.</p></section>
    <section class="connector-card connector-surveillance"><div class="connector-title">${workspaceIcon('alertes')}<div><h2>Déplacements hors ligne</h2><span class="connector-kind">Uber et Bolt · alerte critique au-delà de 200 m</span></div></div><div class="connector-rule-steps"><div><b>1</b><span>Hors ligne explicitement confirmé sur toutes les plateformes connues du chauffeur.</span></div><div><b>2</b><span>Véhicule actuel identifié sans ambiguïté, positions Geotab récentes.</span></div><div><b>3</b><span>Plus de 200 m de déplacement confirmé : alerte interne, avec la plateforme et les observations.</span></div></div><div id="connector-motion-health" aria-live="polite"></div><p>Une donnée absente, trop ancienne ou une association incertaine suspend la surveillance concernée. Une activité récente sur Uber ou Bolt exclut l’alerte de déplacement hors ligne ; une donnée de plateforme manquante ou ancienne suspend la surveillance. L’alerte signale un déplacement ; elle ne prouve pas une course.</p><a class="button-link secondary" href="#/alertes">Ouvrir les alertes ${workspaceIcon('arrow')}</a></section>
    <section class="connector-card"><div class="connector-title">${workspaceIcon('clock')}<div><h2>Observation sur 24 heures</h2><span class="connector-kind">Stabilité des sources et cohérence des alertes</span></div></div><p>Gardez Ludy démarré et Uber visible. Les interruptions restent comptées dans le rapport, y compris après un redémarrage.</p><div id="validation-summary" class="connector-read-summary" role="status">Chargement de l’observation…</div><div id="validation-sources" class="connector-detail"></div><button id="validation-start" class="ghost" hidden>Démarrer les 24 heures</button><p id="validation-incidents" class="connector-footnote"></p></section>
    ${typeof disconnectionsSettingsHtml === 'function' ? disconnectionsSettingsHtml() : ''}<section class="connector-card connector-rules"><div class="connector-title">${workspaceIcon('clock')}<div><h2>Durée hors ligne</h2><span class="connector-kind">Signalement complémentaire · Uber et Bolt</span></div></div><form id="fleet-alert-settings"><label class="alert-enabled"><input type="checkbox" id="fleet-alert-enabled" checked> Signaler une durée hors ligne prolongée</label><label>Durée hors ligne avant signalement <span><input type="number" min="1" max="1440" value="5" id="fleet-alert-minutes" required> minutes</span></label><p>Le statut doit rester explicitement hors ligne pendant ce délai. Une interruption de collecte suspend les signalements. Les comptes Bolt suspendus ou désactivés sont exclus des signalements. Ce réglage concerne la durée hors ligne ; l’alerte de déplacement de plus de 200 m est indépendante.</p><button type="submit" class="ghost">Enregistrer la règle</button><div id="fleet-settings-result" role="status"></div></form></section>
    </div><div class="connector-footnote">Les alertes Uber et Bolt sont internes à ce staging. Aucun e-mail de production n’est envoyé.</div></div>`;
  const geotabHealth = setupGeotabConnector(my);
  const teksatHealth = setupTeksatConnector(my);
  const myclicarHealth = setupMyclicarConnector(my);
  const validationHealth = setupFleetValidation(my);
  if (typeof disconnectionsPaintSettings === 'function') disconnectionsPaintSettings();
  const renderBolt = () => {
    if (my !== ROUTING) return;
    const source = connectorSources.find(s => s.id === 'bolt') || {}, state = fleetConnectorState(source), remote = source.collectionRemote === true;
    $('#bolt-health').innerHTML = `<span class="source-status ${remote ? 'mute' : state.tone}"><i></i>${esc(remote ? 'Données partagées' : state.label)}</span>`;
    $('#bolt-last').textContent = source.last_success_at ? fmtDTY(source.last_success_at) : 'Pas encore synchronisé';
    $('#bolt-automation').innerHTML = remote ? '<div class="connector-automation mute" data-state="shared"><div><b>Collecte inactive sur ce poste</b></div><p>Les données Bolt affichées sont partagées. Elles ne confirment pas les accès Bolt de cet ordinateur.</p><p>Pour démarrer ou mettre en pause Bolt, ce poste doit avoir la collecte active.</p><a href="#/application">Vérifier la participation de ce poste</a></div>' : fleetConnectorAutomation(source, 60);
    const coverage = source.coverage || {};
    $('#bolt-coverage').textContent = `${coverage.drivers ?? '—'} chauffeur(s) · ${coverage.vehicles ?? '—'} véhicule(s) · ${coverage.companies ?? '—'} société(s) accessibles à la clé Bolt.${coverage.complete === true ? ' Pagination complète vérifiée.' : ''}`;
    $('#bolt-stop').hidden = remote || !state.active; $('#bolt-stop').disabled = boltBusy || boltConfigBusy || remote;
    $('#bolt-refresh').hidden = !remote && state.active; $('#bolt-refresh').disabled = boltBusy || boltConfigBusy || remote || boltLocalConfigured !== true || !state.configured;
    const localActive = !remote && state.active;
    $('#bolt-config-state').textContent = localActive ? 'Mettez le suivi Bolt en pause avant de modifier les accès de ce poste.' : boltConfigError || (boltLocalConfigured === true ? 'Accès Bolt enregistrés sur ce poste.' : boltLocalConfigured === false ? 'Aucun accès Bolt enregistré sur ce poste.' : 'Vérification des accès enregistrés sur ce poste…');
    for (const id of ['bolt-client-id', 'bolt-client-secret', 'bolt-config-save']) $('#' + id).disabled = boltBusy || boltConfigBusy || localActive;
  };
  const health = () => {
    if (reading) return reading;
    reading = (async () => {
      try {
        const [data, configuration] = await Promise.all([fleetApi('overview'), fleetApi('bolt/config').catch(error => ({ error: error.message }))]); if (my !== ROUTING) return;
        boltLocalConfigured = typeof configuration?.configured === 'boolean' ? configuration.configured : null;
        boltConfigError = boltLocalConfigured === null ? configuration?.error || 'État des accès Bolt indisponible. Réessayez.' : null;
        $('#connect-status').innerHTML = ''; connectorSources = data.sources || []; alertSettings = data.settings || {};
        if (!$('#fleet-alert-settings').dataset.loaded) { $('#fleet-alert-minutes').value = Math.round((alertSettings.offline_threshold_s || 300) / 60); $('#fleet-alert-enabled').checked = alertSettings.enabled !== false; $('#fleet-alert-settings').dataset.loaded = '1'; }
        const uber = connectorSources.find(s => s.id === 'uber'), [label, cls] = fleetSourceState(uber);
        $('#uber-health').innerHTML = `<span class="source-status ${cls}"><i></i>${label}</span>`;
        $('#uber-summary').textContent = uber?.status === 'healthy' ? `Lecture active · ${uber.coverage?.drivers ?? '—'} chauffeur(s) lus · ${uber.coverage?.kind === 'list_sweep' ? uber.coverage.complete ? 'liste affichée parcourue' : 'parcours partiel, vérifier les filtres et la liste' : 'vue visible seulement, extension à mettre à jour'} · ${fleetAgo(uber.last_success_at)}. ${fleetUberVehicleCoverage(uber.coverage)}. La liaison est conservée après redémarrage de Ludy.` : uber?.status === 'paused' ? 'Lecture en pause. Reprenez-la dans l’extension sur votre écran Uber.' : uber?.status === 'unconnected' ? 'Associez l’extension une fois pour démarrer les lectures.' : `Lecture indisponible. ${uber?.last_error || 'Vérifiez que le portail Uber reste visible et que l’extension est démarrée.'} Les statuts anciens ne sont pas utilisés pour les alertes.`;
        renderBolt(); $('#connector-motion-health').innerHTML = fleetConnectorSurveillance(connectorSources);
      } catch (e) { if (my === ROUTING) $('#connect-status').innerHTML = msg(esc(e.message), 'warn'); }
      await Promise.all([geotabHealth(), myclicarHealth(), validationHealth(), teksatHealth()]);
    })().finally(() => { reading = false; });
    return reading;
  };
  $('#uber-pair').onclick = async () => {
    const button = $('#uber-pair'); button.disabled = true;
    try {
      const result = await fleetApi('pair', {}); if (my !== ROUTING) return;
      $('#uber-pair-result').innerHTML = `<div class="pair-code"><label>Code de liaison de cet écran<input id="uber-pair-code" type="password" readonly autocomplete="off"></label><button id="uber-pair-copy" class="ghost small">Copier le code</button><small>La liaison reste active pendant les lectures et résiste aux redémarrages de Ludy. Elle expire après ${Number(result.idle_timeout_days) || 30} jours sans lecture, au plus tard le ${esc(fmtDTY(result.expires_at))}. À coller uniquement dans l’extension Ludy.</small></div>`;
      $('#uber-pair-code').value = result.token;
      $('#uber-pair-copy').onclick = async () => { try { await navigator.clipboard.writeText(result.token); $('#uber-pair-copy').textContent = 'Copié'; } catch (e) { const input = $('#uber-pair-code'); input.type = 'text'; input.select(); $('#uber-pair-copy').textContent = 'Sélectionné : Ctrl+C'; } };
    } catch (e) { if (my === ROUTING) $('#uber-pair-result').innerHTML = msg(e.message, 'err'); }
    finally { if (my === ROUTING) button.disabled = false; }
  };
  $('#bolt-config').onsubmit = async event => {
    event.preventDefault();
    if (boltBusy || boltConfigBusy) return;
    const source = connectorSources.find(s => s.id === 'bolt') || {};
    if (source.collectionRemote !== true && fleetConnectorState(source).active) return;
    const idInput = $('#bolt-client-id'), secretInput = $('#bolt-client-secret');
    const clientId = idInput.value.trim(), clientSecret = secretInput.value;
    if (!clientId || !clientSecret) { $('#bolt-config-result').innerHTML = msg('Renseignez l’identifiant et le secret client Bolt.', 'warn'); return; }
    boltConfigBusy = true; renderBolt(); $('#bolt-config-result').innerHTML = '<p class="sub">Enregistrement des accès sur ce poste…</p>';
    try {
      const result = await fleetApi('bolt/config', { clientId, clientSecret });
      if (result.configured !== true) throw new Error('Enregistrement des accès Bolt non confirmé.');
      if (my !== ROUTING) return;
      $('#bolt-config-result').innerHTML = msg('Accès enregistrés sur ce poste. Leur validité sera vérifiée au démarrage du suivi. Vérifiez la participation de ce poste, puis activez le suivi Bolt.', 'ok');
    } catch (error) { if (my === ROUTING) $('#bolt-config-result').innerHTML = msg(esc(error.message), 'err'); }
    finally { idInput.value = ''; secretInput.value = ''; boltConfigBusy = false; if (my === ROUTING) { await health(); renderBolt(); } }
  };
  $('#bolt-refresh').onclick = async () => {
    const source = connectorSources.find(s => s.id === 'bolt') || {};
    if (boltBusy || boltConfigBusy || source.collectionRemote === true || boltLocalConfigured !== true || !fleetConnectorState(source).configured) return;
    boltBusy = true; renderBolt(); $('#bolt-result').innerHTML = '<p class="sub">Activation du suivi automatique…</p>';
    try { const result = await fleetApi('bolt/start', {}); if (my !== ROUTING) return; const feedback = fleetBoltActivationFeedback(result); $('#bolt-result').innerHTML = msg(esc(feedback.message), feedback.tone); }
    catch (e) { if (my === ROUTING) $('#bolt-result').innerHTML = msg(esc(e.message), 'err'); }
    finally { boltBusy = false; if (my === ROUTING) { await health(); renderBolt(); } }
  };
  $('#fleet-alert-settings').onsubmit = async e => {
    e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
    try { await fleetApi('settings', { offline_threshold_s: Number($('#fleet-alert-minutes').value) * 60, enabled: $('#fleet-alert-enabled').checked, schedule: alertSettings.schedule || null }); if (my === ROUTING) $('#fleet-settings-result').innerHTML = msg('Règle enregistrée.', 'ok'); }
    catch (error) { if (my === ROUTING) $('#fleet-settings-result').innerHTML = msg(error.message, 'err'); }
    finally { if (my === ROUTING) button.disabled = false; }
  };
  $('#bolt-stop').onclick = async () => {
    if (boltBusy || boltConfigBusy || connectorSources.find(s => s.id === 'bolt')?.collectionRemote === true) return;
    boltBusy = true; renderBolt();
    try { await fleetApi('bolt/stop', {}); if (my === ROUTING) $('#bolt-result').innerHTML = msg('Suivi Bolt en pause. Cette pause reste conservée au redémarrage.', 'ok'); }
    catch (e) { if (my === ROUTING) $('#bolt-result').innerHTML = msg(esc(e.message), 'err'); }
    finally { boltBusy = false; if (my === ROUTING) { await health(); renderBolt(); } }
  };
  await health();
  if (my === ROUTING) S.timers.push(setInterval(() => { if (!document.hidden) health(); }, 15000));
}
