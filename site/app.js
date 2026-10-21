// Ludy (supervision de flotte, données Geotab) — site web (lecture de la base Supabase alimentée par le collecteur Apps Script)
const CFG = window.FLOTTE_CONFIG || {};
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const S = { session: null, profile: null, P: null, veh: null, vehList: [], rules: null, drv: null, timers: [], channel: null, agencies: [], agName: {}, alertCh: null };
const $ = sel => document.querySelector(sel);
const ROLE_TXT = { admin: 'Administrateur', manager: 'Gestionnaire', viewer: 'Lecture seule', pending: 'En attente' };
const canEdit = () => S.profile && ['admin', 'manager'].includes(S.profile.role);
const isAdmin = () => S.profile && S.profile.role === 'admin';
const PARAM_DEFAULTS = { limDbMb: 500, limStorageMb: 1024, limLiveMonth: 500000, manifestKeepDays: 30, shiftAdvance: 2, minFuelKm: 30, kmMin: 20, scoreY: 29, scoreO: 36, scoreR: 74, idleLongMin: 10, liveMin: 5, engStopMin: 3, rpmMin: 300 };

// ---------- Accès aux données ----------
const PK = { trips: 'id', vehicles: 'key', drivers: 'code', params: 'key', contracts: 'num', parc: 'plate', profiles: 'user_id', user_agencies: 'user_id,agency_id', live_status: 'vehicle_key', manager_shifts: 'agency_id,user_id,day,shift' };
async function all(table, cols, build, order) {
  const page = 1000;
  const get = async i => {
    let q = sb.from(table).select(cols || '*');
    if (build) q = build(q);
    if (order) q = q.order(order[0], { ascending: order[1] !== false });
    // toujours un tri sur la clé : sans ordre fixe, la pagination de PostgreSQL peut sauter ou répéter des lignes
    (PK[table] || 'id').split(',').forEach(c => { if (!order || order[0] !== c) q = q.order(c, { ascending: true }); });
    const { data, error } = await q.range(i, i + page - 1);
    if (error) throw new Error(table + ' : ' + error.message);
    return data;
  };
  // 1re page seule ; au-delà, 4 pages demandées en même temps (longues périodes : plusieurs milliers de lignes)
  const out = [];
  for (let i = 0; ;) {
    const batch = await Promise.all((i ? [0, 1, 2, 3] : [0]).map(k => get(i + k * page)));
    for (const d of batch) { out.push(...d); if (d.length < page) return out; }
    i += batch.length * page;
  }
}
async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(fn + ' : ' + error.message); return data; }
/** Fonction de lecture renvoyant des lignes : paginée comme all() (PostgREST renvoie 1 000 lignes au plus).
 *  keys : colonnes qui identifient une ligne, toujours triées (sans ordre fixe, les pages peuvent répéter ou sauter des lignes) */
async function rpcAll(fn, args, keys) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.rpc(fn, args || {}); (keys || []).forEach(k => { q = q.order(k, { ascending: true, nullsFirst: true }); });
    const { data, error } = await q.range(i, i + 999);
    if (error) throw new Error(fn + ' : ' + error.message);
    out.push(...(data || [])); if (!data || data.length < 1000) return out;
  }
}
async function job(kind, arg) {
  const { data, error } = await sb.from('jobs').insert({ kind, arg: arg || null }).select('id').single();
  if (error) throw new Error(error.message); return data.id;
}
async function loadRef(force) {
  if (S.P && !force) return;
  const [params, veh, rules, drv, ags] = await Promise.all([all('params', 'key,value'), all('vehicles', '*', null, ['plate']), all('rules', 'id,name,weight,category'), all('drivers', 'code,name,status'),
    all('agencies', 'id,name', null, ['name'])]);
  S.agencies = ags; S.agName = {}; ags.forEach(a => { S.agName[a.id] = a.name; });
  S.P = Object.assign({}, PARAM_DEFAULTS); params.forEach(p => { if (p.value !== null && p.value !== '') S.P[p.key] = isNaN(+p.value) ? p.value : +p.value; });
  // Heures à l'heure réelle du Maroc publiée par le collecteur (même règle partout, quelle que soit la table des fuseaux du navigateur)
  setTzRules(S.P.tzRules);
  S.vehList = veh; S.veh = {}; veh.forEach(v => { S.veh[v.key] = v; });
  S.rules = {}; rules.forEach(r => { r.name_geotab = r.name; r.name = rptRuleFr(r.name); S.rules[r.id] = r; });   // noms des règles en français partout
  S.drv = { [HORS]: 'Hors contrat' }; drv.forEach(d => { S.drv[d.code] = d.name; });
}

// ---------- Agences ----------
/** Agence choisie dans la barre latérale (vide = toutes celles que l'utilisateur peut voir) */
function agFilter() { let a = ''; try { a = localStorage.getItem('agence') || ''; } catch (e) { } return S.agencies.some(x => String(x.id) === a) ? a : ''; }
/** Filtre par clé de véhicule selon l'agence choisie */
function inAgency() {
  const a = agFilter(), m = mineOn() ? S.mine : null;   // planning : véhicules confiés à l'utilisateur pour le shift en cours (planning.js)
  if (!a && !m) return () => true;
  const ks = a ? new Set(S.vehList.filter(v => String(v.agency_id) === a).map(v => v.key)) : null;
  return k => (!ks || ks.has(k)) && (!m || m.has(k));
}
function agOptions(sel, emptyTxt) { return (emptyTxt !== undefined ? `<option value="">${esc(emptyTxt)}</option>` : '') + S.agencies.map(a => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join(''); }
function agTxt(id) { return id ? esc(S.agName[id] || '') : '<span class="small">aucune</span>'; }

// ---------- Thème : clair par défaut, sombre ou celui de l'appareil au choix (mémorisé dans ce navigateur) ----------
const THEMES = [['light', 'Clair'], ['dark', 'Sombre'], ['auto', 'Auto (appareil)']];
function themeGet() { let t = ''; try { t = localStorage.getItem('theme') || ''; } catch (e) { } return THEMES.some(x => x[0] === t) ? t : 'light'; }
function themeApply(t) { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
themeApply(themeGet());

// ---------- Application Ludy (Mac / Windows, dossier desktop/) : elle injecte window.LUDY_APP dans le site ----------
// Uber Fleet Hub interdit d'être affiché dans un cadre d'un autre site : seule l'application peut l'ouvrir dans sa fenêtre.
/** Application plus ancienne que la dernière publiée : lien « Mettre à jour l'application » en bas du menu */
function verNum(v) { return String(v || '0').split('.').map(x => +x || 0).reduce((a, x) => a * 1000 + x, 0); }
async function appUpdateCheck() {
  if (!window.LUDY_APP || S.appLatest !== undefined) return;
  S.appLatest = null;
  try { const r = await fetch(CFG.SUPABASE_URL + '/storage/v1/object/public/app/version.json?t=' + Date.now()); if (r.ok) S.appLatest = (await r.json()).version || null; } catch (e) { }
  appUpdateShow();
}
// ---------- Nouvelle version du site : une page restée ouverte (application, onglet) garde l'ancien code ----------
// build.txt = commit publié (écrit par la CI) ; changé = rechargement au prochain changement de page, bandeau en attendant
let SITE_BUILD = null, SITE_NEW = false;
async function siteBuildCheck() {
  if (SITE_NEW) return;
  try {
    const r = await fetch('build.txt', { cache: 'no-store' }); if (!r.ok) return;
    const b = (await r.text()).trim(); if (!/^[0-9a-f]{7,40}$/.test(b)) return;
    if (SITE_BUILD === null) SITE_BUILD = b; else if (b !== SITE_BUILD) { SITE_NEW = true; siteNewShow(); }
  } catch (e) { /* hors ligne : nouvel essai plus tard */ }
}
function siteNewShow() {
  const f = $('.side .foot'); if (!SITE_NEW || !f || $('#siteupd')) return;
  f.insertAdjacentHTML('afterbegin', '<button id="siteupd" class="small">Nouvelle version de Ludy : recharger</button>');
  $('#siteupd').onclick = () => location.reload();
}
siteBuildCheck();
setInterval(() => { if (!document.hidden) siteBuildCheck(); }, 300000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) siteBuildCheck(); });
function appUpdateShow() {
  const f = $('.side .foot'); if (!f || !S.appLatest || !window.LUDY_APP || verNum(S.appLatest) <= verNum(window.LUDY_APP.version) || $('#appupd')) return;
  f.insertAdjacentHTML('afterbegin', `<a id="appupd" class="dlapp" href="#/application">Nouvelle version de l'application (${esc(S.appLatest)}) : mettre à jour</a>`);
}
// ---------- Limites de l'hébergement (offre Supabase) : base, stockage, appels du relais En direct ; alerte à 80 % ----------
/** Mesures (administrateur) : usage_stats() ; null si la migration 20261028000000_limites.sql n'est pas exécutée */
async function usageLoad(force) {
  if (!isAdmin()) return null;
  if (S.usage !== undefined && !force) return S.usage;
  try { S.usage = await rpc('usage_stats'); } catch (e) { S.usage = null; }
  return S.usage;
}
/** Lignes [libellé, utilisé, limite, unité, détail] ; projection des appels du mois au rythme des jours comptés */
function usageRows(u, P) {
  if (!u) return [];
  const st = u.storage_mb || {}, stTot = Object.values(st).reduce((a, x) => a + num(x), 0);
  const m = new Date(u.month + 'T12:00:00Z'), dim = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
  const days = Math.max(1, num(u.live_days)), proj = Math.round(num(u.live_month) / days * dim);
  return [['Base de données', num(u.db_mb), num(P.limDbMb, 500), 'Mo', 'données détaillées archivées dans Drive au-delà de ' + num(P.retentionDays, 62) + ' jours'],
    ['Stockage (PDF, application)', Math.round(stTot * 10) / 10, num(P.limStorageMb, 1024), 'Mo', Object.keys(st).map(k => k + ' ' + f1(st[k]) + ' Mo').join(' · ') || 'vide'],
    ['Appels En direct ce mois', num(u.live_month), num(P.limLiveMonth, 500000), '', u.live_since ? 'comptés depuis le ' + fmtDay(u.live_since) + ' · à ce rythme : ' + f0(proj) + ' sur le mois' + (u.live_days < 3 ? ' (estimation encore peu fiable)' : '') : 'aucun appel compté ce mois'],
  ].map(r => r.concat([r[0] === 'Appels En direct ce mois' ? Math.max(r[1], u.live_days >= 3 ? proj : 0) : r[1]]));
}
/** Limite atteinte à 80 % (ou projetée pour les appels du mois) */
function usageAlerts(u, P) { return usageRows(u, P).filter(r => r[5] >= 0.8 * r[2]); }
function usageHtml(u, P) {
  if (!u) return msg('Suivi des limites pas encore installé : exécuter <b>supabase/migrations/20261028000000_limites.sql</b> dans Supabase &gt; SQL Editor.', 'warn');
  return `<div class="usage">${usageRows(u, P).map(r => { const pct = r[2] ? Math.min(100, r[1] / r[2] * 100) : 0, ppct = r[2] ? r[5] / r[2] * 100 : 0, cls = ppct >= 100 ? 'crit' : ppct >= 80 ? 'warn' : 'ok';
    return `<div class="ub"><div class="ul"><b>${esc(r[0])}</b><span>${f0(r[1])}${r[3] ? ' ' + r[3] : ''} / ${f0(r[2])}${r[3] ? ' ' + r[3] : ''} (${f0(pct)} %)</span></div>
      <div class="ubar"><span class="${cls}" style="width:${pct.toFixed(1)}%"></span></div><div class="small">${esc(r[4])}</div></div>`; }).join('')}</div>`;
}
/** Bandeau en bas du menu (administrateur) quand une limite approche */
async function usageWarn() {
  const u = await usageLoad(); const a = usageAlerts(u, S.P || {}), f = $('.side .foot');
  if (!a.length || !f || $('#usewarn')) return;
  f.insertAdjacentHTML('afterbegin', `<a id="usewarn" class="dlapp" href="#/reglages">Limite de l'hébergement bientôt atteinte : ${esc(a.map(r => r[0].toLowerCase()).join(', '))}</a>`);
}
function appUber() { const u = window.LUDY_APP && window.LUDY_APP.uber; return /^https:\/\/([a-z0-9-]+\.)*uber\.com\//.test(u || '') ? u : ''; }
function appIpc() { return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke); }
/** Mode de l'application : 'ext' (1.2 et suivantes : volets des Réglages), 'uber' (1.1 : Uber seul), 'link' (1.0 : lien plein écran), '' (navigateur) */
function appMode() { const A = window.LUDY_APP; if (!A) return ''; if (A.ext && appIpc()) return 'ext'; if (A.embed && appIpc()) return 'uber'; return appUber() ? 'link' : ''; }
function appEmbed() { return appMode() === 'ext' || appMode() === 'uber'; }
function appInvoke(cmd, args) { if (!appIpc()) return Promise.resolve(); return window.__TAURI_INTERNALS__.invoke(cmd, args || {}); }
/**
 * Liens vers l'extérieur dans l'application (WhatsApp, e-mail, cartes, PDF) : la vue web ne sait pas ouvrir WhatsApp ni la messagerie.
 * Application 1.3 : ouverts par le système (application WhatsApp si installée, sinon navigateur ; Mail / Outlook) ;
 * avant 1.3 : message copié, à coller dans WhatsApp ou la messagerie. Navigateur : comportement normal.
 */
function openOut(url) {
  if (window.LUDY_APP && window.LUDY_APP.open && appIpc()) { appInvoke('open_external', { url }).catch(e => alert('Ouverture impossible : ' + (e.message || e))); return true; }
  if (window.LUDY_APP && /^(mailto:|https:\/\/(wa\.me|api\.whatsapp\.com)\/)/i.test(url)) {
    let txt = ''; try { const u = new URL(url); txt = u.searchParams.get(u.protocol === 'mailto:' ? 'body' : 'text') || ''; } catch (e) { }
    const where = /^mailto:/i.test(url) ? 'votre messagerie' : 'WhatsApp';
    const done = ok => appNotice((ok ? 'Message copié : collez-le dans ' + where + '. ' : '') + 'Pour ouvrir ' + where + ' directement depuis Ludy, installez la nouvelle version de l\'application (page Application).');
    if (navigator.clipboard && txt) navigator.clipboard.writeText(txt).then(() => done(true), () => done(false)); else done(false);
    return true;
  }
  if (window.LUDY_APP) return false;   // application avant 1.3 : lien « nouvel onglet » transmis au navigateur par l'application
  window.open(url, '_blank', 'noopener'); return true;
}
function appNotice(text) {
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast info'; t.innerHTML = `<button class="x" aria-label="Fermer">×</button>${esc(text)}`;
  t.querySelector('.x').onclick = () => t.remove(); box.prepend(t); setTimeout(() => t.remove(), 15000);
}
// dans l'application : liens WhatsApp, e-mail et autres sites ouverts par le système
document.addEventListener('click', e => {
  if (!window.LUDY_APP || e.defaultPrevented) return;
  const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
  const href = a.href || '';
  const out = /^(mailto|tel|whatsapp):/i.test(href) || (/^https?:/i.test(href) && a.target === '_blank' && new URL(href).origin !== location.origin);
  if (out && openOut(href)) e.preventDefault();
});
/**
 * Volets externes : sites affichés dans la fenêtre de l'application, à droite du menu Ludy (ils interdisent d'être affichés
 * dans un cadre d'un autre site). Liste réglée dans Réglages > Volets externes (param appSites, JSON [{id, name, url}]).
 */
function extSlug(t) { return normTxt(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'site'; }
function extSites() {
  let l = null; try { l = JSON.parse((S.P && S.P.appSites) || 'null'); } catch (e) { l = null; }
  if (!Array.isArray(l)) l = [{ id: 'uber', name: 'Uber Fleet', url: appUber() }, { id: 'clicar', name: 'Clicar', url: 'https://new.clicar.ma/' }];
  const seen = {};
  return l.map(x => ({ id: extSlug(x.id || x.name), name: String(x.name || x.url || '').trim(), url: String(x.url || '').trim() }))
    .filter(x => /^https:\/\/[^\s/]+/.test(x.url) && !seen[x.id] && (seen[x.id] = 1));
}
function navSites() { const m = appMode(); return m === 'ext' ? extSites() : m === 'uber' ? [{ id: 'uber', name: 'Uber Fleet', url: appUber() }] : []; }
/** Zone du volet : sous sa barre (nom, Recharger, accès réservé), à droite du menu, jusqu'en bas de la fenêtre */
function extPlace() {
  const id = pageOf().slice(2), site = navSites().find(x => x.id === id), m = $('#page'), bar = $('#extbar');
  if (!site || !m || !$('#extzone')) return Promise.resolve();
  const r = m.getBoundingClientRect(), top = bar ? Math.round(bar.getBoundingClientRect().bottom + 8) : Math.round(r.top);
  const box = { x: Math.round(r.left), y: top, w: Math.round(r.width), h: Math.round(window.innerHeight - top) };
  return appMode() === 'ext' ? appInvoke('ext_show', Object.assign({ id: site.id, url: site.url }, box)) : appInvoke('uber_show', box);
}
function extHide() { const m = appMode(); return m === 'ext' ? appInvoke('ext_hide').catch(() => { }) : m === 'uber' ? appInvoke('uber_hide').catch(() => { }) : Promise.resolve(); }
async function pageExt(id) {
  const site = navSites().find(x => x.id === id);
  if (!appEmbed() || !site) { $('#page').innerHTML = msg(site || !appEmbed() ? 'Ce volet s\'affiche dans l\'application Ludy (Mac / Windows). <a href="#/application">Télécharger l\'application</a>' : 'Volet inconnu : il a été retiré dans Réglages.', 'warn'); return; }
  const ext = appMode() === 'ext';
  const show = () => {
    $('#page').innerHTML = `<div class="extbar" id="extbar"><b>${esc(site.name)}</b><span class="small">${esc(site.url.replace(/^https:\/\//, '').replace(/\/$/, ''))}</span>
      ${ext ? '<button class="ghost small" id="extrl">Recharger</button><button class="ghost small" id="extlog">Accès réservé…</button>' : ''}
      <a class="small" href="${esc(site.url)}" target="_blank" rel="noopener">Ouvrir dans le navigateur</a></div><div class="uberbox" id="extzone">Chargement de ${esc(site.name)}…</div>`;
    if (ext) {
      $('#extrl').onclick = () => appInvoke('ext_reload', { id: site.id, url: site.url }).catch(e => alert(e));
      $('#extlog').onclick = () => login();
    }
    return extPlace().catch(e => { $('#extzone').innerHTML = msg('Le volet n\'a pas pu s\'ouvrir : ' + esc(e), 'err'); });
  };
  // accès réservé (identifiant / mot de passe demandés par le site avant toute page) : enregistré sur cet ordinateur seulement
  const login = async () => {
    await extHide();
    const st = await appInvoke('ext_status', { url: site.url }).catch(() => ({}));
    $('#page').innerHTML = `<div class="extbar" id="extbar"><b>${esc(site.name)}</b><span class="small">Accès réservé</span></div>
      <div class="panel" style="max-width:520px"><p>Si ${esc(site.name)} demande un <b>identifiant et un mot de passe</b> avant d'afficher sa page (« accès réservé »), saisissez-les ici.
      Ils sont enregistrés <b>sur cet ordinateur seulement</b>, dans l'application.</p>
      <div class="panel row" style="border:0;padding:0"><label>Identifiant <input id="exu" autocomplete="off" value="${esc(st.user || '')}"></label><label>Mot de passe <input id="exp" type="password" autocomplete="off"></label></div>
      <p><button id="exsave">Enregistrer et ouvrir</button> <button class="ghost" id="exforget">Oublier</button> <button class="ghost" id="excancel">Annuler</button></p></div>`;
    const done = async (u, pw) => { try { await appInvoke('ext_login', { url: site.url, user: u, pass: pw }); await appInvoke('ext_reload', { id: site.id, url: site.url }); } catch (e) { alert(e); } show(); };
    $('#exsave').onclick = () => { const u = $('#exu').value.trim(); if (!u) { alert('Saisissez l\'identifiant.'); return; } done(u, $('#exp').value); };
    $('#exforget').onclick = () => done('', '');
    $('#excancel').onclick = () => show();
  };
  await show();
}
window.addEventListener('resize', () => { if (/^x-/.test(pageOf())) extPlace().catch(() => { }); });
function pageOf() { return (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'direct'; }
const APP_DL = { mac: CFG.SUPABASE_URL + '/storage/v1/object/public/app/Ludy.dmg', win: CFG.SUPABASE_URL + '/storage/v1/object/public/app/Ludy-setup.exe' };
async function pageApplication() {
  $('#page').innerHTML = `<div class="head"><h1>Application Ludy</h1><div class="sub">Le logiciel dans sa propre fenêtre, avec le volet <b>Uber Fleet</b> affiché à l'intérieur (impossible dans un navigateur : Uber l'interdit).
    Les mises à jour du logiciel arrivent toutes seules, sans réinstaller l'application.</div></div>
    ${window.LUDY_APP ? (S.appLatest && verNum(S.appLatest) > verNum(window.LUDY_APP.version) ? msg('Vous avez la version ' + esc(window.LUDY_APP.version || '') + ' de l\'application : la version <b>' + esc(S.appLatest) + '</b> est disponible. Téléchargez-la ci-dessous et remplacez l\'ancienne (sur Mac : refaire la commande du Terminal).', 'warn') : msg('Vous êtes dans l\'application Ludy (version ' + esc(window.LUDY_APP.version || '') + ').', 'ok')) : ''}
    <div class="appdl">
      <div class="panel"><h2>Mac</h2><p><a class="btn" href="${APP_DL.mac}">Télécharger pour Mac</a></p>
        <ol><li>Ouvrir <b>Ludy.dmg</b> et glisser <b>Ludy</b> dans <b>Applications</b>.</li>
        <li>Premier lancement : macOS indique que l'application ne peut pas être vérifiée. Aller dans <b>Réglages Système › Confidentialité et sécurité</b>, en bas : <b>Ouvrir quand même</b> (une seule fois).</li>
        <li>Se connecter à Ludy, puis une fois à Uber dans le volet <b>Uber Fleet</b>.</li></ol></div>
      <div class="panel"><h2>Windows</h2><p><a class="btn" href="${APP_DL.win}">Télécharger pour Windows</a></p>
        <ol><li>Lancer <b>Ludy-setup.exe</b>.</li>
        <li>Si Windows affiche « Windows a protégé votre ordinateur » : <b>Informations complémentaires › Exécuter quand même</b> (une seule fois).</li>
        <li>Se connecter à Ludy, puis une fois à Uber dans le volet <b>Uber Fleet</b>.</li></ol></div>
    </div>
    <div class="sub">Dans l'application : <b>Uber Fleet</b>, <b>Clicar</b>… (liste dans Réglages) s'affichent à droite du menu Ludy ; un clic sur un autre volet revient au logiciel, ils restent ouverts en arrière-plan. Accès réservé (identifiant demandé par le site) : bouton « Accès réservé… » au-dessus du volet. Les PDF sont enregistrés dans Téléchargements et s'ouvrent tout seuls.</div>`;
}

// ---------- Volets visibles par utilisateur (Réglages > Utilisateurs) : profiles.pages = liste des volets, vide = tous ----------
// Le menu ne montre que les volets choisis ; les données restent limitées par agence dans la base.
const ALWAYS_PAGES = { vehicule: 1, chauffeur: 1, application: 1 };   // fiches ouvertes depuis les autres volets, page de téléchargement
function allPages() { return NAV.filter(n => !ADMIN_PAGES[n[0]]).map(n => [n[0], n[1]]).concat(extSites().map(x => ['x-' + x.id, x.name + ' (application)'])); }
function canSee(page) {
  if (isAdmin() || ALWAYS_PAGES[page] || !S.profile || !Array.isArray(S.profile.pages)) return true;
  return S.profile.pages.includes(page);
}
function firstAllowed() { const p = NAV.map(n => n[0]).find(k => !ADMIN_PAGES[k] && canSee(k)); return p || 'application'; }

// ---------- Mise en page ----------
const NAV = [['direct', 'En direct'], ['tableau', 'Tableau de bord'], ['jour', 'Du jour'], ['chauffeurs', 'Classement'], ['comportement', 'Comportement chauffeur'], ['finshift', 'Fin de shift'], ['conduite', 'Conduite'], ['carburant', 'Carburant'], ['conso', 'Consommation'],
  ['ralenti', 'Ralenti'], ['arrets', 'Arrêts moteur'], ['fiches', 'Chauffeurs'], ['alertes', 'Alertes'], ['manifeste', 'Manifestes'], ['courses', 'Courses privées'], ['rapports', 'Rapports'], ['contrats', 'Contrats'], ['plaques', 'Plaques'], ['vehicules', 'Véhicules'], ['agences', 'Agences'], ['planning', 'Planning'], ['reglages', 'Réglages']];
const ADMIN_PAGES = { agences: 1, planning: 1, reglages: 1 };
function shell() {
  const page = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'direct';
  $('#app').innerHTML = `<div class="layout">
  <aside class="side">
    ${BRAND}
    <nav aria-label="Pages">${NAV.filter(n => (!ADMIN_PAGES[n[0]] || isAdmin()) && canSee(n[0])).map(n => `<a href="#/${n[0]}" class="${n[0] === page ? 'on' : ''}"${n[0] === page ? ' aria-current="page"' : ''}>${n[1]}${n[0] === 'alertes' ? '<span class="nb" id="nbal" hidden></span>' : ''}</a>` +
      (n[0] !== 'direct' ? '' : appMode() === 'link' ? `<a href="${esc(appUber())}" id="navuber">Uber Fleet</a>` :
        navSites().filter(x => canSee('x-' + x.id)).map(x => `<a href="#/x-${x.id}" class="navext${page === 'x-' + x.id ? ' on' : ''}" data-ext="${x.id}"${page === 'x-' + x.id ? ' aria-current="page"' : ''}>${esc(x.name)}</a>`).join(''))).join('')}</nav>
    <div class="foot">${mineFoot()}${S.agencies.length > 1 ? `<label class="agsel">Agence <select id="agsel">${agOptions(agFilter(), S.agencies.length ? 'Toutes' : undefined)}</select></label>` : ''}
      ${'Notification' in window && Notification.permission === 'default' ? '<button class="ghost" id="notifon">Activer les notifications</button>' : ''}<span id="health" class="health">Collecte…</span>${window.LUDY_APP ? '' : '<a class="dlapp" href="#/application">Application Mac / Windows</a>'}<span class="who" title="${esc(S.profile.email || '')}">${esc(S.profile.email || '')}</span><span class="role">${ROLE_TXT[S.profile.role]}</span><label class="agsel">Thème <select id="themesel">${THEMES.map(x => `<option value="${x[0]}" ${x[0] === themeGet() ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label><button class="ghost" id="logout">Déconnexion</button></div>
  </aside>
  <main id="page"><div class="loading">Chargement…</div></main></div>`;
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.hash = ''; };
  $('#themesel').onchange = e => { try { localStorage.setItem('theme', e.target.value); } catch (x) { } themeApply(e.target.value); };
  const ag = $('#agsel'); if (ag) ag.onchange = () => { try { localStorage.setItem('agence', ag.value); } catch (e) { } route(); };
  const mo = $('#mineon'); if (mo) mo.onchange = () => { try { localStorage.setItem('mesveh', mo.checked ? '1' : '0'); } catch (e) { } route(); };
  const nb = $('#notifon'); if (nb) nb.onclick = async () => { try { await Notification.requestPermission(); } catch (e) { } nb.remove(); };
  health(); openAlerts(); appUpdateCheck(); appUpdateShow(); siteNewShow(); usageWarn();
  const on = $('.side nav a.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  return page;
}
const BRAND = '<div class="brand"><img class="logo" src="logo-ludy.png" alt="Ludy" width="168" height="41"><small>Supervision de flotte</small></div>';
/** Écran de connexion (fond clair) : logo en version foncée */
const BRAND_LIGHT = '<div class="brand"><img class="logo" src="logo-ludy-sombre.png" alt="Ludy" width="200" height="49"><small>Supervision de flotte</small></div>';
/** Plaque d'immatriculation dessinée comme une vraie plaque (provisoire WW / W18 en jaune) */
function plate(p, others) {
  if (!p) return '';
  const temp = /WW$|^W\d|W18/i.test(String(p).replace(/[\s-]/g, ''));
  return `<span class="plate${temp ? ' temp' : ''}">${esc(p)}</span>${others ? `<span class="alias">aussi ${esc(others)}</span>` : ''}`;
}
/** Nombre d'alertes critiques encore à traiter (pastille du menu) */
async function openAlerts() {
  try {
    // agence choisie ou « Mes véhicules » : seulement ces véhicules (les droits de la base limitent déjà aux agences de l'utilisateur)
    let q = sb.from('alerts').select('id', { count: 'exact', head: true }).eq('severity', 'Critique').eq('status', 'À traiter');
    if (agFilter() || mineOn()) { const ok = inAgency(); q = q.in('vehicle_key', S.vehList.filter(v => ok(v.key)).map(v => v.key).concat(['-'])); }
    const { count } = await q;
    const el = $('#nbal'); if (el) { el.textContent = count || ''; el.hidden = !count; el.title = (count || 0) + ' alertes critiques à traiter'; }
  } catch (e) { }
}
/** Nouvelle alerte reçue en temps réel (Supabase Realtime) : bandeau dans le site, notification du navigateur si la page est en arrière-plan */
function onNewAlert(a) {
  if (!a || !a.id || !inAgency()(a.vehicle_key)) return;
  if (a.day && a.day < addDays(today(), -1)) return;   // alerte d'une journée passée (recalcul, contrats injectés en retard) : pas de bandeau
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast ' + (GRAV_CLS[a.severity] || '');
  t.innerHTML = `<button class="x" aria-label="Fermer">×</button>${badge(a.severity, GRAV_CLS[a.severity])} <b>${esc(a.type)}</b> ${plate(a.plate)}<div>${esc(a.driver_name || '')}${a.time ? ' · ' + esc(a.time) : ''}</div>
    <div class="small">${esc(String(a.detail || '').replace(/https:\/\/maps\.google\.com\/\?q=\S+/g, '').slice(0, 160))}</div><a href="${a.link || '#/alertes?jour=' + esc(a.day) + '&plaque=' + encodeURIComponent(a.plate || '')}">${a.link ? 'Voir le véhicule' : 'Voir l\'alerte'}</a>`;
  t.querySelector('.x').onclick = () => t.remove();
  box.prepend(t); while (box.children.length > 5) box.lastChild.remove();
  if (a.severity !== 'Critique') setTimeout(() => t.remove(), 30000);
  openAlerts();
  // fenêtre cachée, ou volet externe (Uber, Clicar…) affiché par-dessus les bandeaux : notification du système
  try { if ((document.hidden || /^x-/.test(pageOf())) && ['Critique', 'Haute'].includes(a.severity) && 'Notification' in window && Notification.permission === 'granted')
    new Notification('Ludy : ' + a.type + ' ' + (a.plate || ''), { body: (a.driver_name ? a.driver_name + ' · ' : '') + String(a.detail || '').slice(0, 120), tag: a.id }); } catch (e) { }
}
window.__onNewAlert = onNewAlert;
function watchAlerts() {
  if (S.alertCh) return;
  S.alertCh = sb.channel('alertes').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, p => onNewAlert(p.new)).subscribe();
}
function msg(text, kind) { return `<div class="msg ${kind || ''}">${text}</div>`; }
function badge(t, cls) { return t ? `<span class="badge ${cls || ''}">${esc(t)}</span>` : ''; }
const LEVEL_CLS = { 'Faible': 'ok', 'Modéré': 'warn', 'Élevé': 'high', 'Dangereux': 'crit' };
const GRAV_CLS = { 'Critique': 'crit', 'Haute': 'high', 'Moyenne': 'warn', 'Info': 'info' };
const STATE_CLS = { 'En route': 'ok', 'Arrêté, contact mis': 'warn', 'Garé': '', 'Boîtier hors ligne': 'crit', 'Pas de réponse Geotab': 'crit', 'Non relié à Geotab': 'info' };
/** Tableau triable : cols = [[titre, fonction(ligne) -> html, valeur de tri (facultatif), classe]] */
function table(id, cols, rows, opt) {
  opt = opt || {};
  if (!rows.length) return `<div class="empty">${opt.empty || 'Aucune donnée sur la période'}</div>`;
  const st = (window.__sort || {})[id] || {};
  let list = rows.slice();
  if (st.c !== undefined && cols[st.c]) { const f = cols[st.c][2] || cols[st.c][1]; list.sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * (st.d ? -1 : 1); }); }
  return `<div class="tw"><table id="${id}"><thead><tr>${cols.map((c, i) => `<th data-t="${id}" data-c="${i}" class="${c[3] || ''}">${c[0]}${st.c === i ? (st.d ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
    <tbody>${list.map(r => `<tr>${cols.map(c => `<td class="${c[3] || ''}">${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
document.addEventListener('click', e => {
  const th = e.target.closest('th[data-t]'); if (!th) return;
  const id = th.dataset.t, c = +th.dataset.c; window.__sort = window.__sort || {};
  const cur = window.__sort[id] || {}; window.__sort[id] = { c, d: cur.c === c ? !cur.d : true };
  if (window.__rerender) window.__rerender();
});
function cards(items) { return `<div class="cards">${items.map(i => `<div class="card ${i[2] || ''}"><div class="cv">${i[1]}</div><div class="cl">${i[0]}</div></div>`).join('')}</div>`; }
/** Sélecteur de période (comme le tableau de bord du Sheet) */
const PERIODS = ['Aujourd\'hui', 'Hier', '7 derniers jours', 'Semaine en cours', '30 derniers jours', 'Mois en cours', 'Personnalisé'];
/** Réglage mémorisé dans le navigateur ; null si absent, illisible ou stockage bloqué (navigation privée) */
function lsJSON(k) { if (S.mem && k in S.mem) return S.mem[k]; try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
function lsSet(k, v) { (S.mem = S.mem || {})[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* gardé pour cette page ouverte */ } }
function period() {
  const p = lsJSON('periode') || { sel: '7 derniers jours' }, t = today();
  let from = addDays(t, -6), to = t;
  switch (p.sel) {
    case 'Aujourd\'hui': from = t; break;
    case 'Hier': from = to = addDays(t, -1); break;
    case '30 derniers jours': from = addDays(t, -29); break;
    case 'Semaine en cours': from = mondayOf(t); break;
    case 'Mois en cours': from = t.slice(0, 8) + '01'; break;
    case 'Personnalisé': from = p.from || from; to = p.to || to; break;
  }
  return { sel: p.sel, from, to };
}
function periodBar(onchange) {
  const p = period();
  setTimeout(() => {
    const go = () => { const v = { sel: $('#psel').value, from: $('#pfrom').value, to: $('#pto').value }; lsSet('periode', v); onchange(); };
    $('#psel').onchange = go; $('#pfrom').onchange = () => { $('#psel').value = 'Personnalisé'; go(); }; $('#pto').onchange = () => { $('#psel').value = 'Personnalisé'; go(); };
  });
  return `<div class="bar"><label>Période <select id="psel">${PERIODS.map(x => `<option ${x === p.sel ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>du <input type="date" id="pfrom" value="${p.from}"></label><label>au <input type="date" id="pto" value="${p.to}"></label>
    <span class="hint">Journées de travail (horaires des contrats)</span></div>`;
}
async function health() {
  try {
    const { data } = await sb.from('live_status').select('updated_at').order('updated_at', { ascending: false }).limit(1);
    const t = data && data[0] ? new Date(data[0].updated_at).getTime() : 0, m = t ? Math.round((Date.now() - t) / MIN) : null;
    const el = $('#health'); if (!el) return;
    el.className = 'health ' + (m === null ? 'crit' : m <= 2 * (S.P ? S.P.liveMin : 5) + 2 ? 'ok' : m <= 30 ? 'warn' : 'crit');
    el.title = 'Dernière collecte Geotab'; el.textContent = m === null ? 'Collecte : jamais' : 'Collecte : il y a ' + (m < 1 ? 'moins d\'1 min' : m < 120 ? m + ' min' : Math.round(m / 60) + ' h');
  } catch (e) { }
}

// ---------- EN DIRECT : site/direct.js ----------

// ---------- TABLEAU DE BORD ----------
async function pageTableau() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const p = period(), P = S.P, ok = inAgency();
  let [jrn, ac, tne, top] = await Promise.all([
    all('journal', '*', q => q.gte('day', p.from).lte('day', p.to)),
    rpcAll('alert_counts', { p_from: p.from, p_to: p.to }, ['vehicle_key', 'type', 'severity', 'status']),
    all('fuel', 'vehicle_key', q => q.eq('type', 'TRAJET_NON_ENREGISTRE').gte('day', p.from).lte('day', p.to)),
    all('alerts', '*', q => q.in('severity', ['Critique', 'Haute']).gte('day', p.from).lte('day', p.to))]);
  // filtre agence AVANT de garder les 25 plus récentes
  jrn = jrn.filter(r => ok(r.vehicle_key)); ac = ac.filter(x => ok(x.vehicle_key)); tne = { count: tne.filter(r => ok(r.vehicle_key)).length };
  top = { data: await alertShifts(top.filter(a => ok(a.vehicle_key)).sort((x, y) => (String(y.day) + (y.time || '')).localeCompare(String(x.day) + (x.time || ''))).slice(0, 25)) };
  const t = aggJournal(jrn, () => 'ALL', P).ALL || emptyAgg();
  const cnt = f => ac.filter(f).reduce((s, x) => s + x.n, 0);
  const crit = cnt(x => x.severity === 'Critique'), high = cnt(x => x.severity === 'Haute'), ntne = tne.count || 0;
  const byV = aggJournal(jrn, r => r.vehicle_key, P);
  // véhicule retiré du parc mais qui a roulé sur la période : listé (le total des cartes le compte)
  const vrows = S.vehList.filter(v => (v.active !== 'NON' || byV[v.key]) && ok(v.key)).map(v => ({ v, a: byV[v.key] || emptyAgg(), al: cnt(x => x.vehicle_key === v.key) }));
  const byD = aggJournal(jrn.filter(r => r.driver_code !== HORS), r => shiftOf(r.contract_start, P) + '|' + r.driver_code, P);
  const drows0 = Object.values(byD).map(a => { const [sh, code] = a.k.split('|'), sc = scoreOf(a, P); return { a, sh, code, nom: S.drv[code] || Object.keys(a.names)[0] || code, score: sc, level: levelOf(sc, P) }; })
    .sort((x, y) => y.score - x.score || y.a.pts - x.a.pts);
  const drows = SHIFTS.flatMap(s => drows0.filter(d => d.sh === s).slice(0, 10));   // 10 plus dangereux de chaque shift
  if (rid !== ROUTING) return;
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Tableau de bord</h1><div class="sub">Données mesurées par Geotab uniquement, « ${NM} » quand Geotab ne fournit pas la valeur.</div></div>
    ${periodBar(go)}
    ${cards([['Km parcourus', f0(t.km)], ['Carburant mesuré (L)', fuelVal(t)], ['Conso moyenne (L/100)', l100Val(t)], ['Heures de ralenti', fH(t.idle)],
      ['dont ralenti prolongé', fH(t.idleLong), t.idleLong ? 'crit' : ''], ['Arrêts moteur allumé prolongés', f0(t.nLong)], ['Carburant au ralenti (L)', t.idleFuelN ? f1(t.idleFuel) : NM]])}
    ${cards([['Pleins détectés', f0(t.fills)], ['Siphonages suspects', f0(t.siph), t.siph ? 'crit' : ''], ['Trajets non enregistrés (boîtier coupé)', f0(ntne), ntne ? 'crit' : ''],
      ['Km hors contrat', f1(t.kmHors), t.kmHors ? 'crit' : ''], ['Vmax flotte (km/h)', f0(t.vmax)], ['Coût carburant (MAD)', t.costN ? f0(t.cost) : '<span class="nm">prix non saisi</span>'],
      ['Alertes critiques', f0(crit), crit ? 'crit' : ''], ['Alertes hautes', f0(high)]])}
    <h2>Véhicules</h2>
    ${table('tveh', [
      ['Plaque', x => vlink(x.v.key), x => x.v.plate], ['Modèle', x => esc(x.v.model)], ['Contrats', x => Object.keys(x.a.ctr).length, null, 'n'],
      ['Heures sous contrat', x => fH(x.a.ctrH), x => x.a.ctrH, 'n'], ['Km', x => f1(x.a.km), x => x.a.km, 'n'], ['Conduite', x => fH(x.a.drive), x => x.a.drive, 'n'],
      ['Ralenti total', x => fH(x.a.idle), x => x.a.idle, 'n'], ['dont prolongé', x => fH(x.a.idleLong), x => x.a.idleLong, 'n'], ['Arrêts prolongés', x => x.a.nLong, null, 'n'],
      ['Carburant (L)', x => nmv(fuelVal(x.a)), x => x.a.fuel, 'n'], ['L/100 km', x => nmv(l100Val(x.a)), x => x.a.l100 || 0, 'n'], ['Source carburant', x => esc(srcTxt(x.a))],
      ['Coût carburant (MAD)', x => x.a.costN ? f0(x.a.cost) : '', x => x.a.cost, 'n'], ['Pleins', x => x.a.fills, null, 'n'], ['Vmax', x => f0(x.a.vmax), x => x.a.vmax, 'n'],
      ['Pire dépassement', x => x.a.worst === null ? '' : '+' + f0(x.a.worst), x => x.a.worst || 0, 'n'], ['Événements', x => x.a.evts, null, 'n'],
      ['Score /100 km', x => f1(scoreOf(x.a, P)), x => scoreOf(x.a, P), 'n'], ['Siphonages suspects', x => x.a.siph ? `<b class="red">${x.a.siph}</b>` : '0', x => x.a.siph, 'n'],
      ['Km hors contrat', x => x.a.kmHors ? `<b class="red">${f1(x.a.kmHors)}</b>` : '0', x => x.a.kmHors, 'n'], ['Alertes', x => x.al, null, 'n']], vrows)}
    <h2>Chauffeurs les plus dangereux, par shift <a class="more" href="#/chauffeurs">Voir le classement complet</a></h2>
    ${shiftSections(drows, d => d.sh, (sub, sfx) => table('tdrv' + sfx, [['Rang', (d) => sub.indexOf(d) + 1, null, 'n'], ['Chauffeur', d => `<b>${dlink(d.code, d.nom)}</b>`, d => d.nom], ['Code', d => esc(d.code)],
      ['Niveau', d => badge(d.level, LEVEL_CLS[d.level]), d => d.score], ['Score /100 km', d => f1(d.score), d => d.score, 'n'], ['Événements', d => d.a.evts, null, 'n'],
      ['Km', d => f1(d.a.km), d => d.a.km, 'n'], ['Ralenti total', d => fH(d.a.idle), d => d.a.idle, 'n'], ['dont prolongé', d => fH(d.a.idleLong), d => d.a.idleLong, 'n'],
      ['Carburant (L)', d => nmv(fuelVal(d.a)), d => d.a.fuel, 'n'], ['L/100 km', d => nmv(l100Val(d.a)), d => d.a.l100 || 0, 'n'], ['Vmax', d => f0(d.a.vmax), d => d.a.vmax, 'n'],
      ['Siphonages suspects', d => d.a.siph, null, 'n']], sub))}
    <h2>Alertes critiques et hautes <a class="more" href="#/alertes">Voir toutes les alertes</a></h2>
    ${alertSections('tal', top.data || [], false)}`;
  };
  window.__rerender = render; render();
}
function go() { route(); }
/** Liste découpée en Shift jour / Shift nuit / Hors contrat : un tableau par shift (id de tableau suffixé) */
function shiftSections(items, shiftFn, renderFn, opt) {
  opt = opt || {};
  const out = SHIFTS.map(s => { const sub = items.filter(x => (shiftFn(x) || '') === s); if (!sub.length) return '';
    return `<h3 class="shift ${s ? 'sh-' + s.toLowerCase() : ''}">${esc(s ? shiftName(s, S.P) : (opt.none || shiftName('')))} <span class="small">· ${sub.length} ${opt.unit || 'chauffeur' + (sub.length > 1 ? 's' : '')}</span></h3>` + renderFn(sub, s || 'HC'); }).join('');
  return out || `<div class="empty">${opt.empty || 'Aucune donnée sur la période'}</div>`;
}
function shiftBadge(s) { return s ? `<span class="badge sh-${s.toLowerCase()}">${s === 'Jour' ? 'Jour' : 'Nuit'}</span>` : '<span class="small">hors contrat</span>'; }
/** Shift de chaque contrat (début du contrat), pour les trajets, événements et arrêts qui ne portent que le n° de contrat */
async function contractShifts(nums) {
  S.ctrShift = S.ctrShift || {};
  const need = [...new Set(nums.filter(n => n && !(n in S.ctrShift)))];
  for (let i = 0; i < need.length; i += 150) {
    const rows = await all('contracts', 'num,start_at', q => q.in('num', need.slice(i, i + 150)));
    rows.forEach(c => { S.ctrShift[c.num] = shiftOf(c.start_at, S.P); });
  }
  need.forEach(n => { if (!(n in S.ctrShift)) S.ctrShift[n] = ''; });
  return n => (n && S.ctrShift[n]) || '';
}
function nmv(v) { return v === NM || v === 'km insuffisants' ? `<span class="nm">${v}</span>` : v; }
/**
 * Contrats sans date de fin (jamais clôturés dans l'extract) : ajoute les contrats commencés après eux sur le même véhicule,
 * même déjà terminés, pour que ctrEffEnds sache qu'ils ont été remplacés (sinon le chauffeur d'un contrat jamais clôturé
 * resterait affiché alors que le véhicule n'a plus de contrat).
 */
async function withSuccessors(list) {
  const open = list.filter(c => !c.end_at && c.vehicle_key); if (!open.length) return list;
  const lim = new Date(Date.now() - (num(S.P && S.P.retentionDays, 62) + 45) * DAY).toISOString(), first = open.map(c => c.start_at).sort()[0], from = first < lim ? lim : first;   // même fenêtre que le collecteur (contractIndex_)
  const keys = [...new Set(open.map(c => c.vehicle_key))], have = new Set(list.map(c => c.num)), out = list.slice();
  for (let i = 0; i < keys.length; i += 100) {
    (await all('contracts', 'num,client_code,name,vehicle_key,start_at,end_at', q => q.in('vehicle_key', keys.slice(i, i + 100)).gt('start_at', from)
      .lte('start_at', new Date(Date.now() + HOUR).toISOString()))).forEach(c => { if (!have.has(c.num)) { have.add(c.num); out.push(c); } });
  }
  return out;
}
/** Instant d'une alerte (jour + heure du Maroc), null pour une alerte de journée sans heure */
function alertAt(a) { if (!a.time || !a.day) return null; const p = String(a.day).slice(0, 10).split('-').map(Number), h = String(a.time).split(':').map(Number);
  return localToDate(p[0], p[1], p[2], h[0] || 0, h[1] || 0); }
/** N° de contrat d'une alerte de journée de travail (id « TYPE|C|n° ») */
function alertCtrNum(a) { const m = String(a.id || '').match(/\|C\|(.+)$/); return m ? m[1] : ''; }
/**
 * Contrats des alertes : le shift d'une alerte est celui du contrat en cours sur le véhicule à son heure (même chauffeur de préférence),
 * sinon le créneau horaire (shiftAt). Charge les contrats une fois par liste, avant l'affichage ; résultat dans a._sh.
 */
async function alertShifts(rows) {
  rows = rows || []; if (!rows.length) return rows;
  const veh = [...new Set(rows.map(a => a.vehicle_key).filter(Boolean))], days = rows.map(a => String(a.day || '').slice(0, 10)).filter(Boolean).sort();
  const nums = [...new Set(rows.map(alertCtrNum).filter(Boolean))], byNum = {}, byVeh = {};
  try {
    const add = c => { if (byNum[c.num]) return; byNum[c.num] = c; (byVeh[c.vehicle_key] = byVeh[c.vehicle_key] || []).push(c); };
    for (let i = 0; i < veh.length && days.length; i += 100) {
      (await all('contracts', 'num,client_code,vehicle_key,start_at,end_at', q => q.in('vehicle_key', veh.slice(i, i + 100))
        .lte('start_at', dayBounds(addDays(days[days.length - 1], 1)).end.toISOString()).or('end_at.is.null,end_at.gte.' + dayBounds(addDays(days[0], -1)).start.toISOString()))).forEach(add);
    }
    (await withSuccessors(Object.values(byNum))).forEach(add);   // contrat jamais clôturé : son remplaçant, même terminé avant la période
    const miss = nums.filter(n => !byNum[n]);
    for (let i = 0; i < miss.length; i += 150) (await all('contracts', 'num,client_code,vehicle_key,start_at,end_at', q => q.in('num', miss.slice(i, i + 150)))).forEach(add);
  } catch (e) { /* contrats illisibles : créneau horaire seul */ }
  Object.values(byVeh).forEach(l => ctrEffEnds(l));   // contrat jamais clôturé : fin au début du suivant
  rows.forEach(a => {
    const t = alertAt(a); let c = byNum[alertCtrNum(a)] || null;
    if (!c && t) {
      const live = (byVeh[a.vehicle_key] || []).filter(x => new Date(x.start_at) <= t && (x._end === null || x._end >= t));
      c = live.find(x => a.driver_code && x.client_code === a.driver_code) || live.sort((x, y) => new Date(y.start_at) - new Date(x.start_at))[0] || null;
    }
    // contrat de plusieurs jours (location longue) : son shift ne vaut que pour la première journée, ensuite le créneau horaire
    a._sh = c && (!t || t - new Date(c.start_at) < 20 * HOUR) ? shiftOfCtr(c.start_at, S.P) : shiftAt(t, S.P);
  });
  return rows;
}
/** Shift d'une alerte ('Jour' / 'Nuit' / '') : contrat en cours à son heure (alertShifts), sinon créneau horaire */
function alertShift(a) { const x = alertShiftDay(a); return x ? x.s : ''; }
function alertShiftDay(a) { return a._sh !== undefined ? a._sh : shiftAt(alertAt(a), S.P); }
/** Alertes regroupées par shift (du plus récent au plus ancien) : « Shift nuit du 15/10 → 16/10 (19:00 → 07:00) » */
function alertSections(id, rows, editable) {
  const keyOf = a => { const x = alertShiftDay(a); return x ? x.day + (x.s === 'Nuit' ? '|2' : '|1') : ''; }, groups = {};
  rows.forEach(a => { const k = keyOf(a); (groups[k] = groups[k] || []).push(a); });
  const keys = Object.keys(groups).sort().reverse();
  if (!keys.length) return alertTable(id, rows, editable);
  return keys.map((k, i) => { const x = k ? alertShiftDay(groups[k][0]) : null, n = groups[k].length;
    const title = x ? 'Shift ' + shiftDayName(x).replace(/^J/, 'j').replace(/^N/, 'n') + ' (' + shiftName(x.s, S.P).replace(/^.*\(/, '') : 'Sans heure';
    return `<h3 class="shift ${x ? 'sh-' + x.s.toLowerCase() : ''}">${esc(title)} <span class="small">· ${n} alerte${n > 1 ? 's' : ''}</span></h3>` + alertTable(id + (i ? '_' + i : ''), groups[k], editable); }).join('');
}
function alertTable(id, rows, editable) {
  return table(id, [['Date', a => fmtDay(a.day), a => a.day + (a.time || '')], ['Heure', a => esc(a.time || '')], ['Shift', a => { const x = alertShiftDay(a); return x ? shiftBadge(x.s) + `<div class="small">${esc(shiftDayName(x).replace(/^(Jour|Nuit) du /, ''))}</div>` : ''; }, a => { const x = alertShiftDay(a); return x ? x.day + x.s : ''; }],
    ['Plaque', a => plate(a.plate), a => a.plate], ['Chauffeur', a => esc(a.driver_name || '')],
    ['Type', a => esc(a.type)], ['Gravité', a => badge(a.severity, GRAV_CLS[a.severity]), a => ({ Critique: 0, Haute: 1, Moyenne: 2, Info: 3 }[a.severity])],
    ['Valeur', a => esc(a.value || '')], ['Détail', a => linkify(a.detail), null, 'wide'],
    ['Statut', a => editable ? `<select data-al="${esc(a.id)}" class="alst">${['À traiter', 'En cours', 'Traité', 'Faux positif'].map(s => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : esc(a.status), a => a.status],
    ['Commentaire', a => editable ? `<input data-alc="${esc(a.id)}" class="alc" value="${esc(a.comment || '')}" placeholder="…">` : esc(a.comment || '')],
    // fiche de l'alerte : vitesse, limite et positions lues dans Geotab autour de l'heure de l'alerte (site/direct.js)
    ['Fiche', a => { if (!a.time || !a.vehicle_key) return ''; (S.alIdx = S.alIdx || {})[a.id] = a; return `<button type="button" class="small ghost" data-ad="${esc(a.id)}">Détail</button>`; }]], rows, { empty: 'Aucune alerte' });
}
/** Les alertes du moteur v6 contiennent un lien Google Maps : affiché comme lien OpenStreetMap */
function linkify(t) { return esc(t).replace(/https:\/\/maps\.google\.com\/\?q=(-?[0-9.]+),(-?[0-9.]+)/g, (m, la, lo) => `<a target="_blank" rel="noopener" href="${osmUrl(la, lo)}">carte</a>`); }

// ---------- DU JOUR ----------
async function pageJour() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''), P = S.P, day = qs.get('jour') || shiftAt(new Date(), P).day;   // la nuit en cours (avant 7 h) appartient à la journée de la veille
  // journée d'exploitation : shift jour (shiftDay h → shiftNight h) puis shift nuit jusqu'au lendemain shiftDay h ; une nuit appartient au jour où elle commence
  const ok = inAgency(), dp = day.split('-').map(Number), d1 = addDays(day, 1).split('-').map(Number), sd = num(P.shiftDay, 7);
  const w0 = localToDate(dp[0], dp[1], dp[2], sd, 0), w1 = localToDate(d1[0], d1[1], d1[2], sd, 0);
  const [jrn, al0, idl] = (await Promise.all([
    all('journal', '*', q => q.gte('day', addDays(day, -1)).lte('day', addDays(day, 1))),
    all('alerts', '*', q => q.gte('day', day).lte('day', addDays(day, 1)), ['time']),
    all('idles', '*', q => q.gte('start_at', w0.toISOString()).lt('start_at', w1.toISOString()), ['start_at'])])).map(l => l.filter(r => ok(r.vehicle_key)));
  const rows = jrn.filter(r => (r.contract_start ? shiftOfCtr(r.contract_start, P).day : r.day) === day);
  const al = (await alertShifts(al0)).filter(a => { const x = alertShiftDay(a); return x ? x.day === day : a.day === day; })
    .sort((x, y) => (String(y.day) + (y.time || '')).localeCompare(String(x.day) + (x.time || '')));
  if (rid !== ROUTING) return;
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Journée du ${fmtDay(day)}</h1><div class="sub">${esc(shiftName('Jour', P))} du ${fmtDay(day)}, puis ${esc(shiftName('Nuit', P).replace(/^S/, 's'))} du ${fmtDay(day)} au ${fmtDay(addDays(day, 1))}. Chaque ligne de contrat couvre toute la journée de travail, selon les horaires du contrat.</div></div>
    <div class="bar"><label>Date <input type="date" id="jday" value="${esc(day)}"></label><button class="ghost" id="jprev">Veille</button><button class="ghost" id="jnext">Lendemain</button></div>
    <h2>Journées de travail actives, par shift (de la plus dangereuse à la moins dangereuse)</h2>
    ${shiftSections(rows.sort((x, y) => y.score - x.score), r => shiftOf(r.contract_start, P), (sub, sfx) => table('tjour' + sfx, [['Plaque', r => plate(r.plate), r => r.plate], ['Chauffeur', r => esc(S.drv[r.driver_code] || r.driver_name)], ['Contrat', r => esc(r.contract_num || 'Hors contrat')],
      ['Début', r => fmtDT(r.contract_start), r => r.contract_start], ['Fin', r => r.contract_end ? fmtDT(r.contract_end) : (r.contract_num ? 'en cours' : '')],
      ['Km', r => f1(r.km), r => r.km, 'n'], ['Conduite', r => fH(r.drive_h), r => r.drive_h, 'n'], ['Ralenti', r => fH(r.idle_h), r => r.idle_h, 'n'],
      ['dont prolongé', r => fH(r.long_idle_h), r => r.long_idle_h, 'n'], ['Carburant (L)', r => r.fuel_l === null ? `<span class="nm">${NM}</span>` : f1(r.fuel_l), r => r.fuel_l, 'n'],
      ['L/100', r => r.l100 === null ? `<span class="nm">${r.fuel_l === null ? NM : 'km insuffisants'}</span>` : f1(r.l100), r => r.l100, 'n'], ['Vmax', r => f0(r.vmax), r => r.vmax, 'n'],
      ['Pire dépassement', r => r.worst_over === null ? '' : '+' + f0(r.worst_over), r => r.worst_over, 'n'], ['Événements', r => r.n_events, null, 'n'],
      ['Score', r => f1(r.score), r => r.score, 'n'], ['Niveau', r => r.driver_code === HORS ? '' : badge(levelOf(r.score, P), LEVEL_CLS[levelOf(r.score, P)]), r => r.score],
      ['Pleins', r => r.n_fills, null, 'n'], ['Siphonages', r => r.n_siphon ? `<b class="red">${r.n_siphon}</b>` : '0', r => r.n_siphon, 'n']],
      sub), { unit: 'journées', empty: 'Aucune journée de travail ce jour-là' })}
    <h2>Arrêts moteur allumé ≥ ${P.idleLongMin} min</h2>
    ${table('tidl', [['Début', r => fmtDT(r.start_at), r => r.start_at], ['Fin', r => fmtDT(r.end_at)], ['Durée arrêt', r => fH(r.stop_min / 60), r => r.stop_min, 'n'],
      ['Moteur tournant', r => r.engine_check === 'Régime moteur' ? fH(r.engine_min / 60) : 'non vérifiable', r => r.engine_min, 'n'], ['Plaque', r => plate(r.plate), r => r.plate],
      ['Chauffeur', r => esc(S.drv[r.driver_code] || r.driver_name || '')], ['Lieu', r => mapLink(r.lat, r.lon) ? `<a target="_blank" rel="noopener" href="${mapLink(r.lat, r.lon)}">carte</a>` : '']], idl, { empty: 'Aucun arrêt prolongé' })}
    <h2>Alertes de la journée, par shift</h2>${alertSections('tjal', al, false)}`;
    $('#jday').onchange = e => { location.hash = '#/jour?jour=' + e.target.value; };
    $('#jprev').onclick = () => { location.hash = '#/jour?jour=' + addDays(day, -1); };
    $('#jnext').onclick = () => { location.hash = '#/jour?jour=' + addDays(day, 1); };
  };
  window.__rerender = render; render();
}

// ---------- CHAUFFEURS ----------
async function pageChauffeurs() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const p = period(), P = S.P;
  const ok = inAgency();
  const [jrn0, rc] = await Promise.all([all('journal', '*', q => q.gte('day', p.from).lte('day', p.to).neq('driver_code', HORS)), rpcAll('driver_rule_counts', { p_from: p.from, p_to: p.to }, ['driver_code', 'rule_id', 'vehicle_key', 'contract_num'])]);
  // un chauffeur par shift : ses journées de jour et de nuit sont classées séparément
  const jrn = jrn0.filter(r => ok(r.vehicle_key)), agg = aggJournal(jrn, r => shiftOf(r.contract_start, P) + '|' + r.driver_code, P), used = {}, byD = {};
  const ctrSh = {}; jrn.forEach(r => { if (r.contract_num) ctrSh[r.contract_num] = shiftOf(r.contract_start, P); });
  const okv = inAgency();
  // événements des seuls véhicules de l'agence choisie (lignes par chauffeur, règle et véhicule : cumulées)
  // shift de l'événement : celui de son contrat (à défaut : le shift où le chauffeur a le plus de journées sur la période)
  const mainSh = {}; Object.values(agg).forEach(a => { const [sh, c] = a.k.split('|'), n = Object.keys(a.ctr).length; if (!mainSh[c] || n > mainSh[c].n) mainSh[c] = { sh, n }; });
  rc.forEach(x => { const k = (x.contract_num && ctrSh[x.contract_num] !== undefined ? ctrSh[x.contract_num] : (mainSh[x.driver_code] || {}).sh) + '|' + x.driver_code;
    if (!agg[k] || (x.vehicle_key !== undefined && !okv(x.vehicle_key))) return;
    used[x.rule_id] = (used[x.rule_id] || 0) + x.n; const d = byD[k] = byD[k] || {}; d[x.rule_id] = (d[x.rule_id] || 0) + x.n; });
  const ruleIds = Object.keys(used).sort((a, b) => used[b] - used[a]);
  const list = Object.values(agg).map(a => { const [sh, code] = a.k.split('|'), sc = scoreOf(a, P);
    return { a, sh, code, nom: S.drv[code] || Object.keys(a.names)[0] || code, score: sc, level: levelOf(sc, P), rules: byD[a.k] || {} }; })
    .sort((x, y) => y.score - x.score || y.a.pts - x.a.pts);
  const pdf = () => {
    const tabs = [], rk = ruleIds.slice(0, 10);
    SHIFTS.forEach(sh => { const sub = list.filter(d => (d.sh || '') === sh); if (!sub.length) return; const nm = sh ? shiftName(sh, P) : 'Hors contrat';
      tabs.push(colsTable('Classement : ' + nm, [['Rang', d => sub.indexOf(d) + 1, null, 'n'], ['Chauffeur', d => d.nom], ['Code', d => d.code], ['Niveau', d => d.level], ['Score /100 km', d => f1(d.score), null, 'n'],
        ['Points', d => f1(d.a.pts), null, 'n'], ['Événements', d => d.a.evts, null, 'n'], ['Journées', d => Object.keys(d.a.ctr).length || Object.keys(d.a.days).length, null, 'n'], ['Km', d => f1(d.a.km), null, 'n'],
        ['Conduite', d => fH(d.a.drive), null, 'n'], ['Ralenti', d => fH(d.a.idle), null, 'n'], ['Carburant (L)', d => fuelVal(d.a), null, 'n'], ['L/100 km', d => l100Val(d.a), null, 'n'],
        ['Vmax', d => f0(d.a.vmax), null, 'n'], ['Pire dépassement', d => d.a.worst === null ? '' : '+' + f0(d.a.worst), null, 'n'], ['Pleins', d => d.a.fills, null, 'n'], ['Siphonages', d => d.a.siph, null, 'n']], sub));
      if (rk.length) tabs.push(colsTable('Événements Geotab par règle : ' + nm, [['Chauffeur', d => d.nom]].concat(rk.map(id => [((S.rules[id] || {}).name || id) + ' ×' + ((S.rules[id] || {}).weight || ''), d => d.rules[id] || 0, null, 'n'])), sub)); });
    reportPdf(rptSimple({ kind: 'classement', title: 'Classement des chauffeurs', period: p.from === p.to ? 'du ' + fmtDay(p.from) : 'du ' + fmtDay(p.from) + ' au ' + fmtDay(p.to), from: p.from, to: p.to,
      agency: agFilter() ? S.agName[agFilter()] : 'Toutes les agences',
      summary: [['Score', 'points danger pour 100 km (poids des règles dans Réglages)'], ['Seuils', 'Modéré ' + P.scoreY + ', Élevé ' + P.scoreO + ', Dangereux ' + P.scoreR], ['Chauffeurs classés', String(list.length)]], tables: tabs }));
  };
  if (rid !== ROUTING) return;
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Classement des chauffeurs</h1><div class="sub">Score = points danger pour 100 km (poids des règles dans Réglages). Seuils : Modéré ${P.scoreY}, Élevé ${P.scoreO}, Dangereux ${P.scoreR}.</div>
      <button id="rkpdf">Télécharger le PDF</button></div>
    ${periodBar(go)}
    ${shiftSections(list, d => d.sh, (sub, sfx) => table('trank' + sfx, [['Rang', d => sub.indexOf(d) + 1, null, 'n'], ['Chauffeur', d => `<b>${dlink(d.code, d.nom)}</b>`, d => d.nom], ['Code', d => esc(d.code)],
      ['Niveau', d => badge(d.level, LEVEL_CLS[d.level]), d => d.score], ['Score /100 km', d => f1(d.score), d => d.score, 'n'], ['Points danger', d => f1(d.a.pts), d => d.a.pts, 'n'],
      ['Événements', d => d.a.evts, null, 'n'], ['Journées', d => Object.keys(d.a.ctr).length || Object.keys(d.a.days).length, null, 'n'], ['Heures sous contrat', d => fH(d.a.ctrH), d => d.a.ctrH, 'n'],
      ['Km', d => f1(d.a.km), d => d.a.km, 'n'], ['Conduite', d => fH(d.a.drive), d => d.a.drive, 'n'], ['Ralenti total', d => fH(d.a.idle), d => d.a.idle, 'n'],
      ['dont prolongé', d => fH(d.a.idleLong), d => d.a.idleLong, 'n'], ['Carburant (L)', d => nmv(fuelVal(d.a)), d => d.a.fuel, 'n'], ['L/100 km', d => nmv(l100Val(d.a)), d => d.a.l100 || 0, 'n'],
      ['Vmax', d => f0(d.a.vmax), d => d.a.vmax, 'n'], ['Pire dépassement', d => d.a.worst === null ? '' : '+' + f0(d.a.worst), d => d.a.worst || 0, 'n']]
      .concat(ruleIds.map(id => [esc((S.rules[id] || {}).name || id) + ` <span class="small">×${(S.rules[id] || {}).weight || ''}</span>`, d => d.rules[id] || 0, d => d.rules[id] || 0, 'n']))
      .concat([['Pleins', d => d.a.fills, null, 'n'], ['Siphonages suspects', d => d.a.siph, null, 'n'], ['Véhicules', d => esc(Object.keys(d.a.plates).join(', '))]]), sub))}`;
    $('#rkpdf').onclick = () => { try { pdf(); } catch (e) { alert('PDF impossible : ' + e.message); } };
  };
  window.__rerender = render; render();
}

// ---------- ALERTES ----------
async function pageAlertes() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''), p = period();
  const from = qs.get('jour') || p.from, to = qs.get('jour') || p.to;
  const ok = inAgency(), rows = await alertShifts((await all('alerts', '*', q => q.gte('day', from).lte('day', to), ['day', false])).filter(r => ok(r.vehicle_key)));
  const f = Object.assign({}, lsJSON('fal')); if (qs.get('plaque')) f.plate = qs.get('plaque');
  const types = [...new Set(rows.map(r => r.type))].sort();
  if (rid !== ROUTING) return;
  const render = () => {
    const list = rows.filter(r => (!f.sev || r.severity === f.sev) && (!f.st || r.status === f.st) && (!f.type || r.type === f.type) && (!f.plate || normPlate(r.plate) === normPlate(f.plate)));
    $('#page').innerHTML = `<div class="head"><h1>Alertes</h1><div class="sub">${list.length} alertes sur ${rows.length}${qs.get('jour') ? ' le ' + esc(fmtDay(qs.get('jour'))) : ''}. ${canEdit() ? 'Statut et commentaire enregistrés automatiquement.' : ''}</div></div>
    ${qs.get('jour') ? '' : periodBar(go)}
    <div class="bar"><label>Gravité <select id="fsev"><option value="">Toutes</option>${['Critique', 'Haute', 'Moyenne', 'Info'].map(x => `<option ${f.sev === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Statut <select id="fst"><option value="">Tous</option>${['À traiter', 'En cours', 'Traité', 'Faux positif'].map(x => `<option ${f.st === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Type <select id="ftype"><option value="">Tous</option>${types.map(x => `<option ${f.type === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>Plaque <input id="fplate" value="${esc(f.plate || '')}" size="10"></label></div>
    ${alertTable('talall', list, canEdit())}`;
    const set = (k, v) => { f[k] = v; const s = Object.assign({}, f); delete s.plate; lsSet('fal', s); render(); };
    $('#fsev').onchange = e => set('sev', e.target.value); $('#fst').onchange = e => set('st', e.target.value); $('#ftype').onchange = e => set('type', e.target.value);
    $('#fplate').onchange = e => set('plate', e.target.value);
    document.querySelectorAll('.alst').forEach(s => { s.onchange = () => saveAlert(s.dataset.al, { status: s.value }, rows); });
    document.querySelectorAll('.alc').forEach(s => { s.onchange = () => saveAlert(s.dataset.alc, { comment: s.value }, rows); });
  };
  window.__rerender = render; render();
}
async function saveAlert(id, patch, rows) {
  const { error } = await sb.from('alerts').update(patch).eq('id', id);
  if (error) { alert('Non enregistré : ' + error.message); return; }
  const r = rows.find(x => x.id === id); if (r) Object.assign(r, patch);
  // Siphonage marqué faux positif : la ligne carburant aussi (retiré des journées de travail au prochain calcul)
  if (patch.status && /^SIPH\|/.test(id)) {
    await sb.from('fuel').update({ status: patch.status === 'Faux positif' ? 'Faux positif' : 'À vérifier' }).eq('id', id.slice(5));
    await job('recompute', addDays(today(), -31)).catch(() => { });
  }
}

// ---------- CONTRATS ----------
async function pageContrats() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const ok = inAgency(), keep = c => ok(c.vehicle_key) || (!agFilter() && !c.vehicle_key);
  // contrats des 40 derniers jours, plus ceux restés ouverts (sans date de fin) même plus anciens
  const [rec0, open0] = await Promise.all([all('contracts', '*', q => q.gte('start_at', new Date(Date.now() - 40 * DAY).toISOString()), ['start_at', false]),
    all('contracts', '*', q => q.is('end_at', null))]);
  const open1 = await withSuccessors(open0);   // vrai remplaçant d'un vieux contrat ouvert (même fenêtre que le collecteur)
  const seen = {}, recent = rec0.concat(open1).filter(c => !seen[c.num] && (seen[c.num] = 1) && keep(c)).sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)));
  // fin effective par véhicule ; contrats à vérifier : jamais clôturés alors qu'un contrat plus récent a commencé, ou qui se chevauchent
  const byV = {}; recent.forEach(c => { if (c.vehicle_key) (byV[c.vehicle_key] = byV[c.vehicle_key] || []).push(c); });
  const check = [];
  Object.values(byV).forEach(l => ctrEffEnds(l).forEach((c, i, a) => {
    const nx = a[i + 1];
    if (c._next) check.push({ c, why: 'Jamais clôturé dans l\'extract : remplacé par ' + esc(c._next) + ' le ' + fmtDTY(nx.start_at) + '. Trajets comptés jusqu\'à cette heure.' });
    else if (nx && c._end !== null && new Date(nx.start_at).getTime() < c._end - MIN) check.push({ c, why: 'Chevauche ' + esc(nx.num) + ' (' + esc(nx.name || '') + ', début ' + fmtDTY(nx.start_at) + ') sur le même véhicule : les trajets vont au contrat le plus récent.' });
  }));
  const finTxt = c => c._next ? `<span class="badge warn">non clôturé</span> remplacé par ${esc(c._next)}` : c.end_at ? fmtDTY(c.end_at) : 'en cours';
  const jobs = (await sb.from('jobs').select('*').eq('kind', 'after_inject').order('id', { ascending: false }).limit(5)).data || [];
  let search = '';
  if (rid !== ROUTING) return;
  const render = () => {
    const s = normTxt(search), list = recent.filter(c => !s || normTxt([c.num, c.name, c.plate, c.client_code].join(' ')).includes(s));
    $('#page').innerHTML = `<div class="head"><h1>Contrats</h1><div class="sub">Importez l'extract du jour : chauffeurs, données Geotab, journal et alertes se mettent à jour tout seuls (5 min max).</div></div>
    ${canEdit() ? `<div class="panel"><label class="file">Extract des contrats (.xlsx, .xls, .csv) <input type="file" id="cfile" accept=".xlsx,.xls,.csv"></label><div id="cres"></div></div>` : ''}
    ${jobs.length ? `<h2>Derniers calculs après import</h2>${table('tjobs', [['Demandé le', j => fmtDTY(j.created_at)], ['Terminé le', j => j.done_at ? fmtDTY(j.done_at) : '<span class="badge warn">en attente du collecteur</span>'],
      ['Résultat', j => esc(j.result || ''), null, 'wide']], jobs)}` : ''}
    ${check.length ? `<h2>Contrats à vérifier dans l'extract <span class="small">· ${check.length}</span></h2>
    <div class="sub">À corriger dans le logiciel de location puis réimporter l'extract. Un véhicule n'a qu'un chauffeur à la fois : en attendant, chaque trajet va au contrat le plus récent.</div>
    ${table('tctrchk', [['N° contrat', x => esc(x.c.num)], ['Chauffeur', x => `<b>${esc(x.c.name || '')}</b>`, x => x.c.name], ['Véhicule', x => S.veh[x.c.vehicle_key] ? plate(S.veh[x.c.vehicle_key].plate) : esc(x.c.plate || ''), x => x.c.vehicle_key],
      ['Début', x => fmtDTY(x.c.start_at), x => x.c.start_at], ['Fin', x => x.c.end_at ? fmtDTY(x.c.end_at) : 'aucune', x => x.c.end_at || 'z'], ['Problème', x => x.why, null, 'wide']],
      check.sort((a, b) => String(b.c.start_at).localeCompare(String(a.c.start_at))))}` : ''}
    <h2>Contrats des 40 derniers jours <input id="csearch" placeholder="Rechercher (nom, plaque, n°…)" value="${esc(search)}"></h2>
    ${table('tctr', [['N° contrat', c => esc(c.num)], ['Chauffeur', c => `<b>${esc(c.name)}</b>`, c => c.name], ['Code', c => esc(c.client_code)], ['Plaque', c => plate(c.plate), c => c.plate],
      ['Véhicule', c => S.veh[c.vehicle_key] ? plate(S.veh[c.vehicle_key].plate) : `<span class="badge high">inconnu</span>`, c => c.vehicle_key], ['Début', c => fmtDTY(c.start_at), c => c.start_at],
      ['Fin', finTxt, c => c.end_at || (c._next ? 'y' : 'z')], ['Statut', c => esc(c.status || '')], ['Téléphone', c => esc(c.phone || '')]], list.slice(0, 500))}`;
    const fi = $('#cfile'); if (fi) fi.onchange = () => importFile(fi.files[0]);
    const cs = $('#csearch'); cs.oninput = () => { search = cs.value; const pos = cs.selectionStart; render(); const n = $('#csearch'); n.focus(); n.setSelectionRange(pos, pos); };
  };
  window.__rerender = render; render();
}
/**
 * Classeur lu sans ambiguïté de date : un CSV reste en texte (SheetJS lit sinon « 05/10/2026 13:30 » comme le 10 mai, sans l'heure),
 * une date Excel est réécrite jj/mm/aaaa hh:mm telle qu'affichée (heure du Maroc, sans passer par le fuseau du navigateur).
 */
function readBook(buf, name) {
  const csv = /\.(csv|txt)$/i.test(name || '');
  const wb = XLSX.read(buf, { type: 'array', raw: csv, cellNF: true });
  if (!csv) wb.SheetNames.forEach(n => { const sh = wb.Sheets[n];
    Object.keys(sh).forEach(k => { const c = sh[k]; if (k[0] !== '!' && c && c.t === 'n' && c.z && XLSX.SSF.is_date(c.z)) c.w = XLSX.SSF.format('dd/mm/yyyy hh:mm', c.v); }); });
  return wb;
}
async function importFile(file) {
  const out = $('#cres'); if (!file) return;
  out.innerHTML = msg('Lecture du fichier…');
  try {
    const wb = readBook(new Uint8Array(await file.arrayBuffer()), file.name);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '', dateNF: 'dd/mm/yyyy hh:mm' });
    const pc = await all('plate_changes', 'old_plate,new_plate'), cm = buildCanonMap(S.vehList, pc);
    const res = parseContracts(rows, cm);
    out.innerHTML = msg('Enregistrement des contrats…');
    const r = await rpc('import_contracts', { p_rows: res.rows }), added = r.added, updated = r.updated, same = r.same;
    const unknown = [...new Set(res.rows.filter(r => !S.veh[r.vehicle_key]).map(r => r.plate))];
    let j = null;
    if (added + updated) j = await job('after_inject', localDay(r.min_start));
    out.innerHTML = msg(`<b>Contrats lus : ${res.read}</b>, dont ${added} nouveaux, ${updated} mis à jour, ${same + res.dup} déjà à jour${res.invalid ? ', ' + res.invalid + ' lignes invalides' : ''}${r.skipped ? ', ' + r.skipped + ' ignorés (véhicules d\'une autre agence)' : ''}.<br>` +
      (j ? 'Calcul automatique demandé : chauffeurs, trajets, journal et alertes à jour dans 5 minutes maximum. Rien d\'autre à faire.' : 'Aucun changement.') +
      (unknown.length ? `<br><b>Plaques non reconnues (${unknown.length}) :</b> ${unknown.map(esc).join(', ')}<br>Si c'est une nouvelle plaque d'un véhicule existant, ajoutez-la dans <a href="#/plaques">Plaques</a> : les contrats seront rattachés automatiquement.` : ''), unknown.length ? 'warn' : 'ok');
  } catch (e) { out.innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); }
}

// ---------- PLAQUES ----------
async function pagePlaques() {
  const rows = await all('plate_changes', '*', null, ['id', false]);
  const render = () => {
    $('#page').innerHTML = `<div class="head"><h1>Changements de plaque</h1><div class="sub">Ancienne plaque (WW / W18) et plaque définitive : l'historique reste rattaché au même véhicule et les contrats saisis avec l'une ou l'autre plaque sont reconnus.</div></div>
    ${canEdit() ? `<div class="panel row"><label>Ancienne plaque <input id="pold" placeholder="WW968199"></label><label>Plaque définitive <input id="pnew" placeholder="86121-T-1"></label>
      <label>Date du changement <input type="date" id="pdate"></label><label>Note <input id="pnote"></label><button id="padd">Ajouter</button></div>` : ''}
    ${table('tpl', [['Ancienne plaque', r => plate(r.old_plate), r => r.old_plate], ['Plaque définitive', r => plate(r.new_plate), r => r.new_plate],
      ['Date', r => fmtDay(r.changed_on), r => r.changed_on], ['Véhicule', r => esc(r.vehicle || '')], ['État', r => esc(r.status || 'Pris en compte au prochain passage du collecteur (5 min max)'), null, 'wide'],
      ['Note', r => esc(r.note || '')], ['', r => canEdit() ? `<button class="ghost small" data-del="${r.id}">Supprimer</button>` : '']], rows, { empty: 'Aucun changement de plaque saisi' })}`;
    const add = $('#padd');
    if (add) add.onclick = async () => {
      const o = $('#pold').value.trim().toUpperCase(), n = $('#pnew').value.trim().toUpperCase();
      if (normPlate(o).length < 4 || normPlate(n).length < 4) { alert('Saisissez l\'ancienne ET la nouvelle plaque.'); return; }
      const { data, error } = await sb.from('plate_changes').insert({ old_plate: o, new_plate: n, changed_on: $('#pdate').value || null, note: $('#pnote').value || null }).select().single();
      if (error) { alert(error.message); return; }
      rows.unshift(data); await job('apply_plates').catch(e => alert(e.message)); render();
    };
    document.querySelectorAll('[data-del]').forEach(b => { b.onclick = async () => {
      if (!confirm('Supprimer ce changement de plaque ?')) return;
      const { error } = await sb.from('plate_changes').delete().eq('id', b.dataset.del); if (error) { alert(error.message); return; }
      rows.splice(rows.findIndex(r => String(r.id) === b.dataset.del), 1); await job('apply_plates').catch(() => { }); render(); }; });
  };
  window.__rerender = render; render();
}

// ---------- Lecture d'un fichier Excel / CSV : colonnes reconnues par leur titre ----------
async function readSheet(file) {
  const wb = readBook(new Uint8Array(await file.arrayBuffer()), file.name);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
}
/** spec = { champ: [regex, ...] } ; la ligne d'en-têtes est la première qui contient la colonne obligatoire (req) */
function mapColumns(rows, spec, req) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const head = rows[i].map(h => normTxt(h)), idx = {};
    Object.keys(spec).forEach(k => { for (const re of spec[k]) { const j = head.findIndex((h, n) => re.test(h) && !Object.values(idx).includes(n)); if (j >= 0) { idx[k] = j; break; } } });
    if (idx[req] !== undefined) return { idx, data: rows.slice(i + 1).filter(r => r.some(v => String(v).trim() !== '')) };
  }
  return null;
}
/** Agences citées dans un fichier : retrouvées par leur nom, créées si besoin (admin) */
async function agencyIds(names) {
  const out = {}, byName = {}; S.agencies.forEach(a => { byName[normTxt(a.name)] = a.id; });
  const missing = [...new Set(names.map(n => String(n || '').trim()).filter(n => n && !byName[normTxt(n)]))];
  if (missing.length) {
    if (!isAdmin()) throw new Error('Agences inconnues : ' + missing.join(', ') + ' (seul l\'administrateur peut créer une agence)');
    const { data, error } = await sb.from('agencies').insert(missing.map(name => ({ name }))).select('id,name'); if (error) throw error;
    data.forEach(a => { byName[normTxt(a.name)] = a.id; }); await loadRef(true);
  }
  names.forEach(n => { if (String(n || '').trim()) out[n] = byName[normTxt(n)]; });
  return { ids: out, created: missing };
}

// ---------- VÉHICULES (liste du parc gérée ici : remplace le Sheet ETAT PARC) ----------
async function pageVehicules() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  await loadRef(true);
  const ok = inAgency(), rows = S.vehList.filter(v => ok(v.key)), parc = isAdmin() ? await all('parc', '*', null, ['plate']) : [];
  const known = new Set(); S.vehList.forEach(v => [v.plate].concat(String(v.other_plates || '').split(/[,;]\s*/)).forEach(p => { if (p) known.add(normPlate(p)); }));
  const ed = (v, c, w) => isAdmin() ? `<input class="ved" data-k="${esc(v.key)}" data-c="${c}" value="${esc(v[c] == null ? '' : v[c])}" size="${w || 6}">` : esc(v[c] == null ? '' : v[c]);
  if (rid !== ROUTING) return;
  const render = (info) => {
    $('#page').innerHTML = `<div class="head"><h1>Véhicules</h1><div class="sub">La liste des véhicules (parc) se gère ici : ajout à la main ou import d'un fichier Excel. Le collecteur les associe aux boîtiers Geotab (5 min max).
      ${isAdmin() ? 'Agence, réservoir, conso de référence, recette et Actif modifiables dans le tableau.' : ''}</div></div>
    ${isAdmin() ? `<div class="panel row"><label class="file">Importer la liste du parc (.xlsx, .xls, .csv) <input type="file" id="vfile" accept=".xlsx,.xls,.csv"></label>
      <span class="small">Colonnes reconnues : Immatriculation / Plaque, Marque, Modèle, VIN / Châssis, Carburant, Agence. Les agences inconnues sont créées.</span></div>
    <div class="panel row"><label>Plaque <input id="vplate" placeholder="12345-A-1" size="11"></label><label>Marque <input id="vbrand" placeholder="HYUNDAI" size="9"></label>
      <label>Modèle <input id="vmodel" placeholder="STARIA" size="9"></label><label>VIN <input id="vvin" size="17"></label><label>Carburant <select id="vfuel"><option>GO</option><option>ES</option><option>Hybride</option><option>Électrique</option></select></label>
      <label>Agence <select id="vag">${agOptions('', '')}</select></label><button id="vadd">Ajouter le véhicule</button></div>` : ''}
    <div id="vres">${info || ''}</div>
    ${table('tvh', [['Plaque', v => plate(v.plate), v => v.plate], ['Autres plaques', v => esc(v.other_plates || '')], ['Agence', v => isAdmin() ? `<select class="vag" data-k="${esc(v.key)}">${agOptions(v.agency_id, '—')}</select>` : agTxt(v.agency_id), v => S.agName[v.agency_id] || ''],
      ['Marque', v => esc(v.brand || '')], ['Modèle', v => esc(v.model || '')],
      ['Carburant', v => esc(v.fuel || '')], ['VIN', v => esc(v.vin || '')], ['Boîtier Geotab', v => v.geotab_id ? esc(v.geotab_name || v.geotab_id) : '<span class="badge high">non associé</span>'],
      ['Réservoir (L)', v => ed(v, 'tank_l', 4)], ['Conso réf (L/100)', v => ed(v, 'ref_l100', 4)], ['Recette/contrat (MAD)', v => ed(v, 'revenue', 6)], ['Actif', v => ed(v, 'active', 3)],
      ['Dernière finalisation', v => fmtDTY(v.last_sync), v => v.last_sync]], rows, { empty: 'Aucun véhicule : importez la liste du parc ou ajoutez un véhicule ci-dessus.' })}
    ${isAdmin() ? `<h2>Liste du parc (${parc.length})</h2>
    ${table('tparc', [['Plaque', r => plate(r.plate), r => r.plate], ['Marque', r => esc(r.brand || '')], ['Modèle', r => esc(r.model || '')], ['VIN', r => esc(r.vin || '')], ['Carburant', r => esc(r.fuel || '')],
      ['Agence', r => `<select class="pag" data-p="${esc(r.plate)}">${agOptions(r.agency_id, '—')}</select>`, r => S.agName[r.agency_id] || ''],
      ['État', r => known.has(normPlate(r.plate)) ? '<span class="badge ok">dans la flotte</span>' : '<span class="badge warn">ajouté au prochain passage du collecteur</span>'],
      ['Note', r => esc(r.note || '')], ['', r => `<button class="ghost small" data-pdel="${esc(r.plate)}">Retirer</button>`]], parc, { empty: 'Liste du parc vide' })}` : ''}`;
    document.querySelectorAll('.ved').forEach(i => { i.onchange = async () => {
      const c = i.dataset.c, val = c === 'active' ? (i.value.toUpperCase() === 'NON' ? 'NON' : 'OUI') : (i.value === '' ? null : num(i.value, null));
      const { error } = await sb.from('vehicles').update({ [c]: val }).eq('key', i.dataset.k); if (error) alert(error.message); else i.classList.add('saved'); }; });
    document.querySelectorAll('.vag').forEach(i => { i.onchange = async () => {
      const v = S.veh[i.dataset.k], ag = i.value ? +i.value : null;
      const { error } = await sb.from('vehicles').update({ agency_id: ag }).eq('key', i.dataset.k); if (error) { alert(error.message); return; }
      v.agency_id = ag; const pr = parc.filter(r => [v.plate].concat(String(v.other_plates || '').split(/[,;]\s*/)).some(x => normPlate(x) === normPlate(r.plate)));
      for (const r of pr) { await sb.from('parc').update({ agency_id: ag, updated_at: new Date().toISOString() }).eq('plate', r.plate); r.agency_id = ag; }
      i.classList.add('saved'); }; });
    document.querySelectorAll('.pag').forEach(i => { i.onchange = async () => {
      const ag = i.value ? +i.value : null, { error } = await sb.from('parc').update({ agency_id: ag, updated_at: new Date().toISOString() }).eq('plate', i.dataset.p);
      if (error) alert(error.message); else { i.classList.add('saved'); parc.find(r => r.plate === i.dataset.p).agency_id = ag; await loadRef(true); } }; });
    document.querySelectorAll('[data-pdel]').forEach(b => { b.onclick = async () => {
      if (!confirm('Retirer ' + b.dataset.pdel + ' de la liste du parc ? (l\'historique est conservé ; pour ne plus suivre le véhicule, mettez Actif = NON)')) return;
      const { error } = await sb.from('parc').delete().eq('plate', b.dataset.pdel); if (error) { alert(error.message); return; }
      parc.splice(parc.findIndex(r => r.plate === b.dataset.pdel), 1); render(); }; });
    const add = $('#vadd');
    if (add) add.onclick = async () => {
      const pl = $('#vplate').value.trim().toUpperCase().replace(/\s+/g, '');
      if (normPlate(pl).length < 4) { alert('Saisissez la plaque.'); return; }
      const row = { plate: pl, brand: $('#vbrand').value.trim().toUpperCase() || null, model: $('#vmodel').value.trim().toUpperCase() || null, vin: $('#vvin').value.trim().toUpperCase() || null,
        fuel: $('#vfuel').value, agency_id: $('#vag').value ? +$('#vag').value : null, note: 'Ajouté sur le site', updated_at: new Date().toISOString() };
      const { error } = await sb.from('parc').upsert(row, { onConflict: 'plate' }); if (error) { alert(error.message); return; }
      await job('import_vehicles').catch(() => { });
      const i = parc.findIndex(r => r.plate === pl); if (i >= 0) parc[i] = row; else parc.push(row);
      render(msg('Véhicule ' + esc(pl) + ' ajouté : associé à Geotab au prochain passage du collecteur (5 min max).', 'ok'));
    };
    const fi = $('#vfile'); if (fi) fi.onchange = () => importParc(fi.files[0], parc).then(t => render(t)).catch(e => render(msg('Erreur : ' + esc(e.message || e), 'err')));
  };
  window.__rerender = () => render(); render();
}
async function importParc(file, parc) {
  if (!file) return '';
  const m = mapColumns(await readSheet(file), { plate: [/definitiv/, /immatricul/, /^plaque/, /matricule/], brand: [/^marque/], model: [/^modele/, /^model/], vin: [/chassis/, /\bvin\b/],
    fuel: [/^carburant/, /energie/], agency: [/^agence/, /^site$/, /^ville/] }, 'plate');
  if (!m) throw new Error('colonne « Immatriculation » ou « Plaque » introuvable');
  const g = (r, k) => m.idx[k] === undefined ? '' : String(r[m.idx[k]] || '').trim(), seen = {}, rows = [];
  m.data.forEach(r => { const pl = g(r, 'plate').toUpperCase().replace(/\s+/g, ''); if (normPlate(pl).length < 4 || seen[pl]) return; seen[pl] = 1;
    rows.push({ plate: pl, brand: g(r, 'brand') || null, model: g(r, 'model') || null, vin: g(r, 'vin') || null, fuel: g(r, 'fuel') || null, ag: g(r, 'agency') }); });
  if (!rows.length) throw new Error('aucune plaque dans le fichier');
  const ag = await agencyIds(rows.map(r => r.ag)), now = new Date().toISOString(), have = new Set(parc.map(r => r.plate));
  const up = rows.map(r => { const o = { plate: r.plate, brand: r.brand, model: r.model, vin: r.vin, fuel: r.fuel, updated_at: now }; if (r.ag) o.agency_id = ag.ids[r.ag]; return o; });
  // lignes sans agence d'abord (l'agence déjà choisie sur le site est conservée), puis lignes avec agence
  for (const part of [up.filter(o => !('agency_id' in o)), up.filter(o => 'agency_id' in o)])
    for (let i = 0; i < part.length; i += 500) { const { error } = await sb.from('parc').upsert(part.slice(i, i + 500), { onConflict: 'plate' }); if (error) throw error; }
  await job('import_vehicles');
  const fresh = await all('parc', '*', null, ['plate']); parc.splice(0, parc.length, ...fresh);
  const nNew = rows.filter(r => !have.has(r.plate)).length;
  return msg(`<b>${rows.length} véhicules lus</b> : ${nNew} nouveaux, ${rows.length - nNew} mis à jour.${ag.created.length ? ' Agences créées : ' + ag.created.map(esc).join(', ') + '.' : ''}<br>Le collecteur les associe à Geotab dans 5 minutes maximum.`, 'ok');
}

// ---------- FICHES CHAUFFEURS (déduits des contrats ou ajoutés à la main) ----------
async function pageFiches() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const ok = inAgency(), a = agFilter();
  // agence choisie : chauffeurs de l'agence et ceux qui ont eu un contrat sur ses véhicules
  const load = async () => { let r = await all('drivers', '*', null, ['name']);
    if (a) { const seen = new Set((await all('contracts', 'client_code,vehicle_key', q => q.not('vehicle_key', 'is', null))).filter(c => ok(c.vehicle_key)).map(c => c.client_code));
      r = r.filter(d => String(d.agency_id) === a || seen.has(d.code)); }
    return r; };
  let rows = await load();
  let search = '';
  const myAg = S.agencies;
  if (rid !== ROUTING) return;
  const render = (info) => {
    const q = normTxt(search), list = rows.filter(d => !q || normTxt([d.code, d.name, d.phone, d.email, d.other_names].join(' ')).includes(q));
    $('#page').innerHTML = `<div class="head"><h1>Chauffeurs</h1><div class="sub">${rows.length} chauffeurs. Ceux des contrats sont ajoutés automatiquement ; vous pouvez aussi en ajouter (le code doit être le code client des contrats pour croiser avec Geotab).</div></div>
    ${canEdit() ? `<div class="panel row"><label>Code client <input id="dcode" size="9"></label><label>Nom <input id="dname" size="18"></label><label>Téléphone <input id="dphone" size="11"></label>
      <label>Email <input id="demail" type="email" size="18"></label><label>Agence <select id="dag">${agOptions(myAg.length === 1 ? myAg[0].id : '', isAdmin() ? '' : undefined)}</select></label><button id="dadd">Ajouter</button></div>
    <div class="panel row"><label class="file">Importer des chauffeurs (.xlsx, .xls, .csv) <input type="file" id="dfile" accept=".xlsx,.xls,.csv"></label>
      <span class="small">Colonnes reconnues : Code, Nom, Téléphone, Email, Agence. Un chauffeur déjà connu est mis à jour (téléphone, email, agence).</span></div>` : ''}
    <div id="dres">${info || ''}</div>
    <div class="bar"><input id="dsearch" placeholder="Rechercher (nom, code, téléphone…)" value="${esc(search)}" size="32"></div>
    <div class="sub">Shift d'un chauffeur : celui de son dernier contrat (heure de début).</div>
    ${shiftSections(list, d => shiftOf(d.last_contract, S.P), (sub, sfx) => table('tfic' + sfx, [['Code', d => esc(d.code)], ['Nom', d => `<b>${esc(d.name || '')}</b>` + (d.other_names ? `<div class="small">aussi ${esc(d.other_names)}</div>` : ''), d => d.name],
      ['Téléphone', d => canEdit() ? `<input class="ded" data-c="phone" data-k="${esc(d.code)}" value="${esc(d.phone || '')}" size="11">` : esc(d.phone || '')],
      ['Email', d => canEdit() ? `<input class="ded" data-c="email" data-k="${esc(d.code)}" value="${esc(d.email || '')}" size="18">` : esc(d.email || '')],
      ['Agence', d => canEdit() ? `<select class="ded" data-c="agency_id" data-k="${esc(d.code)}">${agOptions(d.agency_id, '—')}</select>` : agTxt(d.agency_id), d => S.agName[d.agency_id] || ''],
      ['Origine', d => d.source === 'manuel' ? '<span class="badge info">ajouté</span>' : 'contrats', d => d.source], ['Statut', d => badge(d.status, d.status === 'NOUVEAU' ? 'info' : ''), d => d.status],
      ['Contrats', d => d.n_contracts || 0, d => d.n_contracts || 0, 'n'], ['Dernier contrat', d => fmtDTY(d.last_contract), d => d.last_contract || ''],
      ['Note', d => canEdit() ? `<input class="ded" data-c="note" data-k="${esc(d.code)}" value="${esc(d.note || '')}" size="16">` : esc(d.note || '')],
      ['', d => canEdit() && d.source === 'manuel' && !d.n_contracts ? `<button class="ghost small" data-ddel="${esc(d.code)}">Supprimer</button>` : '']], sub), { none: 'Sans contrat', empty: 'Aucun chauffeur' })}`;
    document.querySelectorAll('.ded').forEach(i => { i.onchange = async () => {
      const c = i.dataset.c, val = c === 'agency_id' ? (i.value ? +i.value : null) : (i.value.trim() || null);
      const { error } = await sb.from('drivers').update({ [c]: val }).eq('code', i.dataset.k);
      if (error) { alert(error.message); return; } rows.find(d => d.code === i.dataset.k)[c] = val; i.classList.add('saved'); }; });
    document.querySelectorAll('[data-ddel]').forEach(b => { b.onclick = async () => {
      if (!confirm('Supprimer le chauffeur ' + b.dataset.ddel + ' ?')) return;
      const { error } = await sb.from('drivers').delete().eq('code', b.dataset.ddel); if (error) { alert(error.message); return; }
      rows = rows.filter(d => d.code !== b.dataset.ddel); render(); }; });
    const s2 = $('#dsearch'); s2.oninput = () => { search = s2.value; const pos = s2.selectionStart; render(); const n = $('#dsearch'); n.focus(); n.setSelectionRange(pos, pos); };
    const add = $('#dadd');
    if (add) add.onclick = async () => {
      const code = $('#dcode').value.trim().toUpperCase(), name = $('#dname').value.trim();
      if (!code || !name) { alert('Saisissez le code client et le nom.'); return; }
      if (rows.some(d => d.code === code)) { alert('Ce code existe déjà : modifiez la ligne dans le tableau.'); return; }
      const row = { code, name, phone: $('#dphone').value.trim() || null, email: $('#demail').value.trim() || null, agency_id: $('#dag').value ? +$('#dag').value : null,
        source: 'manuel', status: 'ACTIF', detected_at: new Date().toISOString() };
      const { error } = await sb.from('drivers').insert(row); if (error) { alert(/row-level/.test(error.message) ? 'Choisissez une de vos agences.' : error.message); return; }
      rows.push(Object.assign({ n_contracts: 0 }, row)); rows.sort((x, y) => String(x.name).localeCompare(String(y.name))); render(msg('Chauffeur ' + esc(name) + ' ajouté.', 'ok'));
    };
    const fi = $('#dfile'); if (fi) fi.onchange = () => importDrivers(fi.files[0], rows, $('#dag').value).then(async t => { rows = await load(); render(t); }).catch(e => render(msg('Erreur : ' + esc(e.message || e), 'err')));
  };
  window.__rerender = () => render(); render();
}
async function importDrivers(file, rows, defAg) {
  if (!file) return '';
  const m = mapColumns(await readSheet(file), { code: [/^code/, /matricule/], name: [/^nom/, /chauffeur/, /^name/], phone: [/^tel/, /phone/, /gsm|mobile|portable/], email: [/mail/], agency: [/^agence/, /^site$/, /^ville/] }, 'code');
  if (!m) throw new Error('colonne « Code » introuvable');
  const g = (r, k) => m.idx[k] === undefined ? '' : String(r[m.idx[k]] || '').trim(), byCode = {}; rows.forEach(d => { byCode[d.code] = d; });
  const list = m.data.map(r => ({ code: g(r, 'code').toUpperCase(), name: g(r, 'name'), phone: g(r, 'phone'), email: g(r, 'email'), ag: g(r, 'agency') })).filter(r => r.code);
  const ag = await agencyIds(list.map(r => r.ag)), now = new Date().toISOString(), ins = [];
  let upd = 0, err = 0;
  for (const r of list) {
    const agId = r.ag ? ag.ids[r.ag] : (defAg ? +defAg : null);
    if (byCode[r.code]) {
      const o = {}; if (r.phone) o.phone = r.phone; if (r.email) o.email = r.email; if (agId) o.agency_id = agId; if (r.name && byCode[r.code].source === 'manuel') o.name = r.name;
      if (!Object.keys(o).length) continue;
      const { error } = await sb.from('drivers').update(o).eq('code', r.code); if (error) err++; else upd++;
    } else if (r.name) ins.push({ code: r.code, name: r.name, phone: r.phone || null, email: r.email || null, agency_id: agId, source: 'manuel', status: 'ACTIF', detected_at: now });
  }
  for (let i = 0; i < ins.length; i += 500) { const { error } = await sb.from('drivers').upsert(ins.slice(i, i + 500), { onConflict: 'code', ignoreDuplicates: true }); if (error) throw error; }
  return msg(`<b>${list.length} chauffeurs lus</b> : ${ins.length} ajoutés, ${upd} mis à jour${err ? ', ' + err + ' non modifiables (autre agence)' : ''}.${ag.created.length ? ' Agences créées : ' + ag.created.map(esc).join(', ') + '.' : ''}`, err ? 'warn' : 'ok');
}

// ---------- RAPPORTS (PDF) ----------
async function pageRapports() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  const p = period(), sel = agFilter();
  const keys = new Set(S.vehList.filter(v => !sel || String(v.agency_id) === sel).map(v => v.key));
  const [jrn, al] = await Promise.all([all('journal', '*', q => q.gte('day', p.from).lte('day', p.to)), all('alerts', 'id,day,time,plate,vehicle_key,driver_name,type,severity,detail,status', q => q.gte('day', p.from).lte('day', p.to))]);
  const rep = rptBuild({ journal: jrn, alerts: al, vehicles: S.vehList.filter(v => keys.has(v.key)), drivers: S.drv, P: S.P, from: p.from, to: p.to, hmOf: localHM, agency: sel ? S.agName[sel] : (isAdmin() || S.agencies.length !== 1 ? '' : S.agencies[0].name) });
  if (rid !== ROUTING) return;
  $('#page').innerHTML = `<div class="head"><h1>Rapports</h1><div class="sub">Rapport de la période et de l'agence choisies (agence : menu de gauche). ${isAdmin() ? 'Envoi automatique par e-mail : <a href="#/reglages">Réglages > Rapports automatiques</a>.' : ''}</div>
    <button id="rpdf">Télécharger le PDF</button></div>
    ${periodBar(go)}
    <div class="panel rptview">${rptHtml(rep)}</div>`;
  $('#rpdf').onclick = () => { try { reportPdf(rep); } catch (e) { alert('PDF impossible : ' + e.message); } };
}
/** Texte d'une cellule HTML (pour les PDF faits depuis les tableaux des pages) */
function txtOf(html) { const d = document.createElement('div'); d.innerHTML = String(html == null ? '' : html); return d.textContent.replace(/\s+/g, ' ').trim(); }
/** Tableau de page (colonnes de table()) -> tableau de rapport PDF */
function colsTable(title, cols, rows, empty) {
  return { title, empty: empty || 'Aucune donnée', head: cols.map(c => txtOf(c[0])), num: cols.map((c, i) => c[3] === 'n' ? i : -1).filter(i => i >= 0), rows: rows.map(r => cols.map(c => txtOf(c[1](r)))) };
}
/** PDF du rapport (jsPDF + AutoTable, texte vectoriel) */
function reportPdf(rep) {
  if (!window.jspdf) throw new Error('bibliothèque PDF non chargée, réessayez dans un instant');
  if (window.applyPlugin && !window.jspdf.jsPDF.API.autoTable) window.applyPlugin(window.jspdf.jsPDF);
  // signes absents de la police Helvetica du PDF (espaces fines des nombres, flèches, ≥ ≤)
  const cl = v => String(v == null ? '' : v).replace(/[\u202f\u00a0]/g, ' ').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/\s*→\s*/g, ' – ');
  const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12, TOP = 22;
  const C = { ink: [20, 32, 43], mute: [93, 107, 120], line: [216, 222, 228], soft: [243, 245, 247], head: [15, 38, 51], acc: [91, 75, 214], zebra: [247, 248, 250],
    crit: [180, 35, 24], high: [180, 70, 26], warn: [154, 90, 0], ok: [24, 121, 74] };
  const LEVEL = { Dangereux: 'crit', Critique: 'crit', 'Élevé': 'high', Haute: 'high', 'Modéré': 'warn', Moyenne: 'warn', Faible: 'ok' };
  const col = (k, c) => doc['set' + k](c[0], c[1], c[2]), font = (st, sz, c) => { doc.setFont('helvetica', st); doc.setFontSize(sz); col('TextColor', c || C.ink); };
  const sub = cl(rep.agency + ' · ' + rep.period);
  // première page : logo, type de document, titre, agence et période
  try { doc.addImage(RPT_LOGO, 'PNG', M, 9, 34, 8.3); } catch (e) { }
  font('bold', 8, C.acc); doc.text(cl(RPT_KIND[rep.kind] || 'Rapport de la flotte').toUpperCase(), W - M, 12.5, { align: 'right' });
  font('normal', 8, C.mute); doc.text('Édité le ' + fmtDTY(rep.generatedAt), W - M, 17, { align: 'right' });
  font('bold', 17); const tl = doc.splitTextToSize(cl(rep.title), W - 2 * M); doc.text(tl, M, 29);
  let y = 29 + (tl.length - 1) * 6.5 + 6.5; font('normal', 10, C.mute); doc.text(sub, M, y);
  y += 4; col('DrawColor', C.acc); doc.setLineWidth(0.6); doc.line(M, y, W - M, y); y += 6;
  const newPage = () => { doc.addPage(); return TOP + 2; };
  // résumé : cartes de 4 par ligne (libellé, valeur)
  const N = 4, gap = 3, cw = (W - 2 * M - (N - 1) * gap) / N;
  for (let i = 0; i < rep.summary.length; i += N) {
    const row = rep.summary.slice(i, i + N).map(s => { doc.setFontSize(7.2); const l = doc.splitTextToSize(cl(s[0]), cw - 6); doc.setFontSize(10.5); return { l, v: doc.splitTextToSize(cl(s[1]), cw - 6) }; });
    const h = Math.max(...row.map(c => 4.2 + c.l.length * 3 + c.v.length * 4.4 + 1.6));
    if (y + h > H - 16) y = newPage();
    row.forEach((c, j) => { const x = M + j * (cw + gap);
      col('FillColor', C.soft); doc.roundedRect(x, y, cw, h, 1.6, 1.6, 'F');
      font('normal', 7.2, C.mute); doc.text(c.l, x + 3, y + 4.2);
      font('bold', 10.5); doc.text(c.v, x + 3, y + 4.2 + c.l.length * 3 + 3.6); });
    y += h + gap;
  }
  // sections : titre (et nombre de lignes), tableau ; un titre n'est jamais laissé seul en bas de page
  rptTables(rep).forEach(t => {
    if (y > H - 34) y = newPage();
    y += 6; col('FillColor', C.acc); doc.rect(M, y - 3.7, 1.3, 4.8, 'F');
    font('bold', 11.5); const tt = cl(t.title); doc.text(tt, M + 3.5, y);
    if (t.rows.length) { const w = doc.getTextWidth(tt); font('normal', 8.5, C.mute); doc.text('· ' + t.rows.length + (t.rows.length > 1 ? ' lignes' : ' ligne'), M + 3.5 + w + 2.5, y); }
    if (!t.rows.length) { font('normal', 9, C.mute); doc.text(cl(t.empty), M + 3.5, y + 6); y += 9; return; }
    const cs = {}; t.num.forEach(i => { cs[i] = { halign: 'right' }; });
    doc.autoTable({ startY: y + 2.5, head: [t.head.map(cl)], body: t.rows.map(r => r.map(cl)), theme: 'striped', margin: { left: M, right: M, top: TOP, bottom: 16 },
      styles: { font: 'helvetica', fontSize: 7.8, cellPadding: { top: 1.5, bottom: 1.5, left: 1.8, right: 1.8 }, textColor: C.ink, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: C.head, textColor: 255, fontStyle: 'bold', fontSize: 7.6 }, bodyStyles: { fillColor: [255, 255, 255] }, alternateRowStyles: { fillColor: C.zebra },
      columnStyles: cs,
      didParseCell: d => {
        if (d.section === 'head') { if (t.num.indexOf(d.column.index) >= 0) d.cell.styles.halign = 'right'; return; }
        const v = String(d.cell.raw), lv = LEVEL[v];
        if (lv) { d.cell.styles.textColor = C[lv]; d.cell.styles.fontStyle = 'bold'; }
        else if (v === RPT_NM || v === 'prix non saisi' || v === 'km insuffisants') { d.cell.styles.textColor = C.mute; d.cell.styles.fontStyle = 'italic'; }
      } });
    y = doc.lastAutoTable.finalY + 2;
  });
  // en-tête rappelé à partir de la page 2, pied de page partout
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); col('DrawColor', C.line); doc.setLineWidth(0.2);
    if (i > 1) { try { doc.addImage(RPT_LOGO, 'PNG', M, 7.5, 22, 5.4); } catch (e) { }
      font('normal', 8, C.mute); doc.text(doc.splitTextToSize(cl(rep.title), 150)[0] + '  ·  ' + sub, W - M, 11.5, { align: 'right' }); doc.line(M, 15.5, W - M, 15.5); }
    doc.line(M, H - 11, W - M, H - 11);
    font('normal', 7, C.mute); doc.text('Ludy · Supervision de flotte — données mesurées par Geotab uniquement ; « ' + RPT_NM + ' » quand Geotab ne fournit pas la valeur.', M, H - 7);
    doc.text('Page ' + i + ' / ' + n, W - M, H - 7, { align: 'right' });
  }
  doc.save(rptFileName(rep) + '.pdf');
}

// ---------- Réglages : alerte de dépassement de vitesse (seuil par limite de route) ----------
const SPEED_LIMITS = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
/** Réglages > Volets externes : sites affichés dans l'application (nom + adresse https), sans mise à jour de l'application */
function extSettingsHtml(params) {
  const has = params.some(p => p.key === 'appSites');
  return `<h2>Volets externes (application Mac / Windows)</h2><div class="sub">Sites affichés dans l'application Ludy, à droite du menu (ex. Uber Fleet, Clicar).
    Ajout ou retrait ici : visible au prochain chargement de l'application, sans la réinstaller. Adresse en https.</div>
    ${has ? '' : msg('Pour modifier la liste, exécutez d\'abord le SQL <b>20261025000000_volets.sql</b> dans Supabase > SQL Editor. En attendant : Uber Fleet et Clicar.', 'warn')}
    ${table('text', [['Nom', x => `<input class="exn" data-i="${x.i}" value="${esc(x.name)}" size="16"${has ? '' : ' disabled'}>`], ['Adresse', x => `<input class="exu" data-i="${x.i}" value="${esc(x.url)}" size="54"${has ? '' : ' disabled'}>`, null, 'wide'],
      ['', x => has ? `<button class="ghost small" data-exdel="${x.i}">Retirer</button>` : '']], extSites().map((x, i) => Object.assign({ i }, x)), { empty: 'Aucun volet externe' })}
    ${has ? `<div class="panel row"><label>Nom <input id="exnn" size="16" placeholder="Clicar"></label><label>Adresse <input id="exnu" size="40" placeholder="https://new.clicar.ma/"></label><button id="exadd">Ajouter le volet</button></div>` : ''}
    <div id="exres"></div>`;
}
function bindExtSettings(params) {
  if (!params.some(p => p.key === 'appSites')) return;
  const save = async list => {
    const bad = list.find(x => !/^https:\/\/[^\s/]+/.test(x.url) || !x.name);
    if (bad) { $('#exres').innerHTML = msg('Nom et adresse en https obligatoires' + (bad.name ? ' (' + esc(bad.name) + ')' : '') + '.', 'err'); return false; }
    const { error } = await sb.from('params').update({ value: JSON.stringify(list.map(x => ({ id: extSlug(x.id || x.name), name: x.name, url: x.url }))) }).eq('key', 'appSites');
    if (error) { $('#exres').innerHTML = msg(esc(error.message), 'err'); return false; }
    S.P = null; await loadRef(); return true;
  };
  const cur = () => extSites().map(x => ({ id: x.id, name: x.name, url: x.url }));
  document.querySelectorAll('.exn, .exu').forEach(i => { i.onchange = async () => {
    const l = cur(), x = l[+i.dataset.i]; if (!x) return;
    if (i.classList.contains('exn')) x.name = i.value.trim(); else x.url = i.value.trim();
    if (await save(l)) { shell(); pageReglages(); } }; });
  document.querySelectorAll('[data-exdel]').forEach(b => { b.onclick = async () => {
    const l = cur(); if (!confirm('Retirer le volet ' + (l[+b.dataset.exdel] || {}).name + ' ?')) return;
    l.splice(+b.dataset.exdel, 1); if (await save(l)) { shell(); pageReglages(); } }; });
  $('#exadd').onclick = async () => {
    const name = $('#exnn').value.trim(), url = $('#exnu').value.trim();
    const l = cur(); let id = extSlug(name); while (l.some(x => x.id === id)) id += '-2';
    l.push({ id, name, url }); if (await save(l)) { shell(); pageReglages(); }
  };
}
function speedSettingsHtml(params) {
  const pv = k => { const p = params.find(x => x.key === k); return p && p.value != null ? p.value : ''; };
  const P = { overByLimit: pv('overByLimit'), overAlert: pv('overAlert') || 30 }, exact = {}; rptOverTable(P).forEach(x => { exact[x[0]] = x[1]; });
  return `<h2>Alerte de dépassement de vitesse</h2>
    <div class="sub">Alerte « Dépassement limite » quand la vitesse du véhicule dépasse la limite de la route (fournie par Geotab) d'au moins le seuil choisi pour cette limite. Exemple : route à 50 et seuil 30 = alerte à partir de 80 km/h.
      Limite sans seuil saisi : celui de la limite inférieure la plus proche, sinon le seuil général. S'applique aux alertes du collecteur (trajets) et aux alertes en direct.</div>
    <div class="panel row"><label>Seuil général (km/h au-dessus de la limite) <input id="spgen" type="number" min="0" max="100" value="${esc(P.overAlert)}" size="4"></label>
      <label>Vitesse max : alerte quelle que soit la route (km/h) <input id="spvmax" type="number" min="50" max="250" value="${esc(pv('vmaxAlert') || 130)}" size="4"></label></div>
    <div class="tw"><table id="tspeed"><thead><tr><th>Limite de la route</th><th>Seuil d'alerte (km/h au-dessus)</th><th>Alerte à partir de</th></tr></thead><tbody>
      ${SPEED_LIMITS.map(l => `<tr><td><b>${l} km/h</b></td><td><input class="spl" data-l="${l}" type="number" min="0" max="100" value="${exact[l] !== undefined ? esc(exact[l]) : ''}" placeholder="${esc(rptOverTol(P, l))}" size="4"></td>
        <td class="spa" data-l="${l}"><b>${l + rptOverTol(P, l)} km/h</b></td></tr>`).join('')}</tbody></table></div>
    <div class="panel row"><button id="spsave">Enregistrer les seuils</button><span class="small">Les alertes des 7 derniers jours sont recalculées avec les nouveaux seuils (dans les 5 minutes).</span><span id="spres" aria-live="polite"></span></div>`;
}
function bindSpeedSettings(params) {
  const cur = () => { const m = []; document.querySelectorAll('#tspeed .spl').forEach(i => { if (i.value !== '' && isFinite(+i.value)) m.push(i.dataset.l + ':' + Math.round(+i.value)); }); return { overByLimit: m.join(';'), overAlert: num($('#spgen').value, 30) }; };
  const show = () => { const P = cur(); document.querySelectorAll('#tspeed .spa').forEach(td => { const l = +td.dataset.l; td.innerHTML = `<b>${l + rptOverTol(P, l)} km/h</b>`; });
    document.querySelectorAll('#tspeed .spl').forEach(i => { i.placeholder = rptOverTol(P, +i.dataset.l); }); };
  document.querySelectorAll('#tspeed .spl, #spgen').forEach(i => { i.oninput = show; });
  $('#spsave').onclick = async () => {
    const P = cur(), res = $('#spres');
    if (!(P.overAlert >= 0) || !(num($('#spvmax').value) >= 50)) { res.innerHTML = msg('Valeurs invalides.', 'err'); return; }
    const set = async (k, v) => { const { data, error } = await sb.from('params').update({ value: String(v) }).eq('key', k).select('key'); if (error) throw error; return (data || []).length; };
    try {
      await set('overAlert', P.overAlert); await set('vmaxAlert', Math.round(num($('#spvmax').value)));
      if (!await set('overByLimit', P.overByLimit) && P.overByLimit) throw new Error('paramètre « overByLimit » absent de la base : exécutez la migration 20261022000000_vitesse.sql dans Supabase > SQL Editor');
      await job('recompute', addDays(today(), -7));
      S.P = null; await loadRef(); res.innerHTML = msg('Seuils enregistrés. Alertes des 7 derniers jours recalculées dans les 5 minutes.', 'ok');
    } catch (e) { res.innerHTML = msg('Erreur : ' + esc(e.message), 'err'); }
  };
}

// ---------- AGENCES (admin) ----------
async function pageAgences() {
  const rid = ROUTING;   // page demandée pendant le chargement : rien n'est affiché
  await loadRef(true);
  const [users, links] = await Promise.all([all('profiles', 'user_id,email,role', null, ['email']), all('user_agencies', '*')]);
  const nVeh = id => S.vehList.filter(v => v.agency_id === id).length, noAg = S.vehList.filter(v => !v.agency_id && v.active !== 'NON').length;
  const has = (u, a) => links.some(l => l.user_id === u && l.agency_id === a);
  if (rid !== ROUTING) return;
  const render = (info) => {
    $('#page').innerHTML = `<div class="head"><h1>Agences</h1><div class="sub">Chaque gestionnaire ou utilisateur en lecture seule ne voit que les véhicules (trajets, contrats, alertes, chauffeurs) des agences cochées. L'administrateur voit tout.</div></div>
    <div class="panel row"><label>Nouvelle agence <input id="agname" placeholder="Casablanca" size="18"></label><label>Ville <input id="agcity" size="14"></label><button id="agadd">Créer</button></div>
    <div id="agres">${info || ''}</div>
    ${noAg ? msg(noAg + ' véhicule' + (noAg > 1 ? 's actifs n\'ont' : ' actif n\'a') + ' pas d\'agence : visibles seulement par l\'administrateur. Agence à choisir dans <a href="#/vehicules">Véhicules</a>.', 'warn') : ''}
    ${table('tag', [['Agence', a => `<input class="agn" data-a="${a.id}" value="${esc(a.name)}" size="18">`, a => a.name], ['Véhicules', a => nVeh(a.id), a => nVeh(a.id), 'n'],
      ['', a => `<button class="ghost small" data-agdel="${a.id}">Supprimer</button>`]], S.agencies, { empty: 'Aucune agence : créez-en une ci-dessus.' })}
    <h2>Accès des utilisateurs</h2>
    ${S.agencies.length ? table('tagu', [['Utilisateur', u => esc(u.email)], ['Rôle', u => ROLE_TXT[u.role]]].concat(S.agencies.map(a => [esc(a.name),
      u => u.role === 'admin' ? '<span class="small">toutes</span>' : `<input type="checkbox" class="agu" data-u="${u.user_id}" data-a="${a.id}" ${has(u.user_id, a.id) ? 'checked' : ''} aria-label="${esc(u.email)} : ${esc(a.name)}">`])), users) : ''}`;
    $('#agadd').onclick = async () => {
      const name = $('#agname').value.trim(); if (!name) { alert('Saisissez le nom de l\'agence.'); return; }
      const { error } = await sb.from('agencies').insert({ name, city: $('#agcity').value.trim() || null }); if (error) { alert(/duplicate|unique/.test(error.message) ? 'Cette agence existe déjà.' : error.message); return; }
      await loadRef(true); render(msg('Agence ' + esc(name) + ' créée. Rattachez-lui des véhicules (page Véhicules) et des utilisateurs (ci-dessous).', 'ok'));
    };
    document.querySelectorAll('.agn').forEach(i => { i.onchange = async () => { const { error } = await sb.from('agencies').update({ name: i.value.trim() }).eq('id', i.dataset.a); if (error) alert(error.message); else { i.classList.add('saved'); await loadRef(true); } }; });
    document.querySelectorAll('[data-agdel]').forEach(b => { b.onclick = async () => {
      if (!confirm('Supprimer cette agence ? Ses véhicules et chauffeurs restent, sans agence.')) return;
      const { error } = await sb.from('agencies').delete().eq('id', b.dataset.agdel); if (error) { alert(error.message); return; } await loadRef(true); render(); }; });
    document.querySelectorAll('.agu').forEach(c => { c.onchange = async () => {
      const r = { user_id: c.dataset.u, agency_id: +c.dataset.a };
      const { error } = c.checked ? await sb.from('user_agencies').insert(r) : await sb.from('user_agencies').delete().eq('user_id', r.user_id).eq('agency_id', r.agency_id);
      if (error) { alert(error.message); c.checked = !c.checked; return; }
      if (c.checked) links.push(r); else links.splice(links.findIndex(l => l.user_id === r.user_id && l.agency_id === r.agency_id), 1); }; });
  };
  window.__rerender = () => render(); render();
}

// ---------- RÉGLAGES (admin) ----------
async function pageReglages() {
  const my = ROUTING;
  const [params, rules, users, logs, jobs, recs, scheds, types, usage] = await Promise.all([all('params', '*', null, ['sort']), all('rules', '*', null, ['weight', false]), all('profiles', '*', null, ['created_at']),
    sb.from('logs').select('*').order('id', { ascending: false }).limit(150), sb.from('jobs').select('*').order('id', { ascending: false }).limit(30),
    all('alert_recipients', '*', null, ['id']), all('report_schedules', '*', null, ['id']), all('alerts', 'type', q => q.gte('day', addDays(today(), -60))), usageLoad(true)]);
  if (my !== ROUTING) return;   // autre page demandée pendant le chargement : ne pas l'écraser
  const alTypes = [...new Set(types.map(x => x.type))].sort();
  const SEVS = ['Critique', 'Haute', 'Moyenne', 'Info'], FREQ = { jour: 'Chaque jour (veille)', semaine: 'Chaque lundi (semaine passée)', mois: 'Le 1er du mois (mois passé)' };
  const hidden = { geoServer: 1, geoUser: 1, geoDb: 1, tzRules: 1, overByLimit: 1, overAlert: 1, vmaxAlert: 1, appSites: 1 };   // les 3 derniers : bloc « Alerte de dépassement de vitesse »
  $('#page').innerHTML = `<div class="head"><h1>Réglages</h1></div>
    <h2>Limites de l'hébergement</h2><div class="sub">Offre Supabase (base, stockage, appels du temps réel). Le site lui-même (Cloudflare) n'a pas de limite. À 80 % : avertissement en bas du menu. Limites à changer dans les paramètres ci-dessous si l'offre change (Pro : 8 000 Mo, 102 400 Mo, 2 000 000 appels).</div>
    ${usageHtml(usage, S.P)}
    <h2>Utilisateurs</h2><div class="sub">Les nouveaux comptes attendent votre validation (rôle « En attente »). Gestionnaire = import des contrats, chauffeurs, plaques, statut des alertes. Lecture seule = consultation. Agences de chaque utilisateur : <a href="#/agences">Agences</a>.</div>
    ${table('tusr', [['Email', u => esc(u.email)], ['Créé le', u => fmtDTY(u.created_at)], ['Rôle', u => u.user_id === S.session.user.id ? ROLE_TXT[u.role] :
      `<select class="urole" data-u="${u.user_id}">${Object.keys(ROLE_TXT).map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_TXT[r]}</option>`).join('')}</select>`],
      ['Volets visibles', u => u.role === 'admin' ? '<span class="small">tous (administrateur)</span>' : !('pages' in u) ? '<span class="small">tous (SQL 20261025000000_volets.sql à exécuter pour choisir)</span>' :
        `<button class="ghost small" data-upg="${u.user_id}">${Array.isArray(u.pages) ? u.pages.filter(k => allPages().some(x => x[0] === k)).length + ' / ' + allPages().length : 'Tous'} · choisir</button>`]], users)}
    <div id="upgbox"></div>
    ${speedSettingsHtml(params)}
    ${extSettingsHtml(params)}
    <h2>Alertes par e-mail</h2><div class="sub">Chaque nouvelle alerte (veille et jour même) est envoyée une seule fois aux destinataires concernés, dans les minutes qui suivent son calcul par le collecteur.</div>
    <div class="panel row"><label>Email <input id="reml" type="email" size="22" placeholder="chef@clicar.fr"></label><label>Nom <input id="rnom" size="14"></label>
      <label>Agence <select id="rag">${agOptions('', 'Toutes')}</select></label><label>Gravité minimum <select id="rsev">${SEVS.map(x => `<option ${x === 'Haute' ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Types (vide = tous) <select id="rtyp" multiple size="3">${alTypes.map(t => `<option>${esc(t)}</option>`).join('')}</select></label><button id="radd">Ajouter</button></div>
    ${table('trec', [['Email', r => esc(r.email)], ['Nom', r => esc(r.name || '')], ['Agence', r => r.agency_id ? agTxt(r.agency_id) : 'Toutes'], ['Gravité minimum', r => badge(r.min_severity, GRAV_CLS[r.min_severity])],
      ['Types', r => esc(r.types || 'Tous')], ['Actif', r => `<input type="checkbox" class="ract" data-r="${r.id}" ${r.active ? 'checked' : ''} aria-label="Actif">`], ['', r => `<button class="ghost small" data-rdel="${r.id}">Supprimer</button>`]], recs, { empty: 'Aucun destinataire : les alertes ne sont visibles que sur le site.' })}
    <h2>Rapports automatiques (PDF par e-mail)</h2><div class="sub">Envoyés à partir de ${esc(S.P.reportHour === undefined ? 13 : S.P.reportHour)} h, une fois les journées finalisées. Destinataires séparés par des virgules.</div>
    <div class="panel row"><label>Nom <input id="snom" size="14" placeholder="Direction"></label><label>Fréquence <select id="sfreq">${Object.keys(FREQ).map(k => `<option value="${k}">${FREQ[k]}</option>`).join('')}</select></label>
      <label>Agence <select id="sag">${agOptions('', 'Toutes')}</select></label><label>Destinataires <input id="sto" size="34" placeholder="direction@clicar.fr, chef@clicar.fr"></label><button id="sadd">Ajouter</button></div>
    ${table('tsch', [['Nom', r => esc(r.name || '')], ['Fréquence', r => FREQ[r.frequency]], ['Agence', r => r.agency_id ? agTxt(r.agency_id) : 'Toutes'], ['Destinataires', r => esc(r.recipients), null, 'wide'],
      ['Dernier envoi', r => r.last_sent_at ? fmtDTY(r.last_sent_at) + `<div class="small">${esc(r.last_result || '')}</div>` : 'jamais'], ['Actif', r => `<input type="checkbox" class="sact" data-s="${r.id}" ${r.active ? 'checked' : ''} aria-label="Actif">`],
      ['', r => `<button class="ghost small" data-snow="${r.id}">Envoyer maintenant</button> <button class="ghost small" data-sdel="${r.id}">Supprimer</button>`]], scheds, { empty: 'Aucun rapport automatique' })}
    <h2>Actions</h2><div class="panel row">
      <label>Recalculer chauffeurs, journal et alertes depuis le <input type="date" id="rcfrom" value="${addDays(today(), -7)}"></label><button id="rcgo">Recalculer</button>
      <label>Retélécharger depuis Geotab du <input type="date" id="rsfrom" value="${addDays(today(), -2)}"></label><label>au <input type="date" id="rsto" value="${addDays(today(), -1)}"></label><button id="rsgo">Retélécharger</button>
      <button id="vhgo" class="ghost">Réappliquer la liste des véhicules</button></div><div id="actres"></div>
    <h2>Paramètres</h2>
    ${table('tpar', [['Paramètre', p => esc(p.label)], ['Valeur', p => `<input class="ped" data-k="${esc(p.key)}" value="${esc(p.value == null ? '' : p.value)}" size="22">`], ['Note', p => esc(p.note || ''), null, 'wide']], params.filter(p => !hidden[p.key]))}
    <h2>Règles Geotab (poids dans le score de danger)</h2>
    ${table('trul', [['Règle', r => esc(rptRuleFr(r.name)) + (rptRuleFr(r.name) !== r.name ? ` <span class="small">(Geotab : ${esc(r.name)})</span>` : '')], ['Catégorie', r => esc(r.category || '')], ['Poids', r => `<input class="red_" data-k="${esc(r.id)}" value="${esc(r.weight)}" size="4">`, r => r.weight], ['Note', r => esc(r.note || ''), null, 'wide']], rules)}
    <h2>Demandes au collecteur</h2>
    ${table('tjob', [['Demande', j => esc(j.kind) + (j.arg ? ' (' + esc(j.arg) + ')' : '')], ['Le', j => fmtDTY(j.created_at)], ['Terminée', j => j.done_at ? fmtDTY(j.done_at) : '<span class="badge warn">en attente</span>'], ['Résultat', j => esc(j.result || ''), null, 'wide']], jobs.data || [])}
    <h2>Journal technique</h2>
    ${table('tlog', [['Le', l => fmtDTY(l.at)], ['Action', l => esc(l.action)], ['Détail', l => esc(l.detail), null, 'wide'], ['Durée (s)', l => l.dur_s == null ? '' : f1(l.dur_s), null, 'n']], logs.data || [])}`;
  document.querySelectorAll('[data-upg]').forEach(b => { b.onclick = () => {
    const u = users.find(x => x.user_id === b.dataset.upg), cur = Array.isArray(u.pages) ? u.pages : null;
    $('#upgbox').innerHTML = `<div class="panel"><b>Volets visibles par ${esc(u.email)}</b> <span class="small">(${ROLE_TXT[u.role]})</span>
      <div class="upgl">${allPages().map(x => `<label><input type="checkbox" class="upgc" value="${esc(x[0])}" ${!cur || cur.includes(x[0]) ? 'checked' : ''}> ${esc(x[1])}</label>`).join('')}</div>
      <p><button id="upgsave">Enregistrer</button> <button class="ghost" id="upgall">Tout cocher</button> <button class="ghost" id="upgnone">Tout décocher</button> <button class="ghost" id="upgx">Fermer</button></p></div>`;
    const boxes = () => [...document.querySelectorAll('.upgc')];
    $('#upgall').onclick = () => boxes().forEach(c => { c.checked = true; });
    $('#upgnone').onclick = () => boxes().forEach(c => { c.checked = false; });
    $('#upgx').onclick = () => { $('#upgbox').innerHTML = ''; };
    $('#upgsave').onclick = async () => {
      const on = boxes().filter(c => c.checked).map(c => c.value), pages = on.length === boxes().length ? null : on;
      if (pages && !pages.length && !confirm('Aucun volet coché : cet utilisateur ne verra que la page Application. Continuer ?')) return;
      const { error } = await sb.from('profiles').update({ pages }).eq('user_id', u.user_id); if (error) { alert(error.message); return; }
      u.pages = pages; b.textContent = (pages ? pages.length + ' / ' + allPages().length : 'Tous') + ' · choisir'; b.classList.add('saved'); $('#upgbox').innerHTML = msg('Volets enregistrés pour ' + esc(u.email) + ' : visibles à son prochain chargement de page.', 'ok');
    };
    $('#upgbox').scrollIntoView({ block: 'nearest' });
  }; });
  document.querySelectorAll('.urole').forEach(s => { s.onchange = async () => { const { error } = await sb.from('profiles').update({ role: s.value }).eq('user_id', s.dataset.u); if (error) alert(error.message); else s.classList.add('saved'); }; });
  document.querySelectorAll('.ped').forEach(i => { i.onchange = async () => { const { error } = await sb.from('params').update({ value: i.value }).eq('key', i.dataset.k); if (error) alert(error.message); else { i.classList.add('saved'); S.P = null; S.ctrShift = {}; await loadRef(); } }; });   // horaires des shifts changés : shift des contrats recalculé
  document.querySelectorAll('.red_').forEach(i => { i.onchange = async () => { const { error } = await sb.from('rules').update({ weight: num(i.value) }).eq('id', i.dataset.k); if (error) alert(error.message); else { i.classList.add('saved'); await job('recompute', addDays(today(), -31)).catch(e => alert('Recalcul non demandé : ' + e.message)); } }; });
  const done = t => { $('#actres').innerHTML = msg(t + ' Le collecteur s\'en charge dans 5 minutes maximum (suivi ci-dessous).', 'ok'); };
  const fail = e => { $('#actres').innerHTML = msg('Demande non enregistrée : ' + esc(e.message || e), 'err'); };
  $('#rcgo').onclick = async () => { await job('recompute', $('#rcfrom').value).then(() => done('Recalcul demandé.'), fail); };
  $('#rsgo').onclick = async () => { await job('resync', $('#rsfrom').value + '|' + $('#rsto').value).then(() => done('Retéléchargement demandé.'), fail); };
  $('#vhgo').onclick = async () => { await job('import_vehicles').then(() => done('Mise à jour des véhicules demandée.'), fail); };
  const reload = () => pageReglages().catch(e => { $('#page').innerHTML = msg('Erreur : ' + esc(e.message), 'err'); });
  bindSpeedSettings(params);
  bindExtSettings(params);
  $('#radd').onclick = async () => {
    const email = $('#reml').value.trim(); if (!/@/.test(email)) { alert('Saisissez une adresse e-mail.'); return; }
    const types = [...$('#rtyp').selectedOptions].map(o => o.value).join(', ');
    const { error } = await sb.from('alert_recipients').insert({ email, name: $('#rnom').value.trim() || null, agency_id: $('#rag').value ? +$('#rag').value : null, min_severity: $('#rsev').value, types: types || null });
    if (error) alert(error.message); else reload();
  };
  document.querySelectorAll('.ract').forEach(c => { c.onchange = async () => { const { error } = await sb.from('alert_recipients').update({ active: c.checked }).eq('id', c.dataset.r); if (error) alert(error.message); }; });
  document.querySelectorAll('[data-rdel]').forEach(b => { b.onclick = async () => { if (!confirm('Supprimer ce destinataire ?')) return; const { error } = await sb.from('alert_recipients').delete().eq('id', b.dataset.rdel); if (error) alert(error.message); else reload(); }; });
  $('#sadd').onclick = async () => {
    const to = $('#sto').value.trim(); if (!/@/.test(to)) { alert('Saisissez au moins une adresse e-mail.'); return; }
    const { error } = await sb.from('report_schedules').insert({ name: $('#snom').value.trim() || null, frequency: $('#sfreq').value, agency_id: $('#sag').value ? +$('#sag').value : null, recipients: to });
    if (error) alert(error.message); else reload();
  };
  document.querySelectorAll('.sact').forEach(c => { c.onchange = async () => { const { error } = await sb.from('report_schedules').update({ active: c.checked }).eq('id', c.dataset.s); if (error) alert(error.message); }; });
  document.querySelectorAll('[data-sdel]').forEach(b => { b.onclick = async () => { if (!confirm('Supprimer ce rapport automatique ?')) return; const { error } = await sb.from('report_schedules').delete().eq('id', b.dataset.sdel); if (error) alert(error.message); else reload(); }; });
  document.querySelectorAll('[data-snow]').forEach(b => { b.onclick = async () => { b.disabled = true; try { await job('send_report', b.dataset.snow); b.textContent = 'Envoi demandé (5 min max)'; } catch (e) { alert(e.message); b.disabled = false; } }; });
}

// ---------- Connexion ----------
function loginView(info) {
  $('#app').innerHTML = `<div class="login"><div class="lbox">${BRAND_LIGHT}
    <form id="lf"><label>Email<input type="email" id="le" required autocomplete="username"></label>
    <label>Mot de passe<input type="password" id="lp" required autocomplete="current-password" minlength="6"></label>
    <button type="submit">Se connecter</button>
    <div class="lrow"><a href="#" id="lsignup">Créer un compte</a><a href="#" id="lforgot">Mot de passe oublié</a></div></form><div id="lmsg">${info || ''}</div></div></div>`;
  const out = t => { $('#lmsg').innerHTML = t; };
  $('#lf').onsubmit = async e => { e.preventDefault(); out(''); const { error } = await sb.auth.signInWithPassword({ email: $('#le').value, password: $('#lp').value });
    if (error) out(msg(/Invalid login/.test(error.message) ? 'Email ou mot de passe incorrect.' : /confirm/i.test(error.message) ? 'Confirmez d\'abord votre email (lien reçu par mail).' : esc(error.message), 'err')); };
  $('#lsignup').onclick = async e => { e.preventDefault(); if (!$('#le').value || $('#lp').value.length < 6) { out(msg('Saisissez un email et un mot de passe (6 caractères minimum), puis cliquez « Créer un compte ».', 'warn')); return; }
    const { data, error } = await sb.auth.signUp({ email: $('#le').value, password: $('#lp').value, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) out(msg(esc(error.message), 'err')); else out(msg(data.session ? 'Compte créé.' : 'Compte créé : cliquez sur le lien reçu par email pour le confirmer, puis connectez-vous.', 'ok')); };
  $('#lforgot').onclick = async e => { e.preventDefault(); if (!$('#le').value) { out(msg('Saisissez votre email puis cliquez « Mot de passe oublié ».', 'warn')); return; }
    const { error } = await sb.auth.resetPasswordForEmail($('#le').value, { redirectTo: location.origin + location.pathname });
    out(error ? msg(esc(error.message), 'err') : msg('Email envoyé : suivez le lien pour choisir un nouveau mot de passe.', 'ok')); };
}
function pendingView() {
  $('#app').innerHTML = `<div class="login"><div class="lbox">${BRAND_LIGHT}
    ${msg('Votre compte (' + esc(S.profile ? S.profile.email : '') + ') est créé. Il doit être validé par l\'administrateur avant de voir les données.', 'warn')}
    <button id="lout" class="ghost">Déconnexion</button></div></div>`;
  $('#lout').onclick = () => sb.auth.signOut();
}

// ---------- Navigation ----------
const PAGES = { direct: pageDirect, tableau: pageTableau, jour: pageJour, chauffeurs: pageChauffeurs, fiches: pageFiches, alertes: pageAlertes, rapports: pageRapports,
  conduite: pageConduite, comportement: pageComportement, finshift: pageFinShift, carburant: pageCarburant, conso: pageConso, ralenti: pageRalenti, arrets: pageArrets, vehicule: pageFicheVehicule, chauffeur: pageFicheChauffeur,
  contrats: pageContrats, manifeste: pageManifeste, courses: pageCourses, application: pageApplication, plaques: pagePlaques, vehicules: pageVehicules, agences: pageAgences, planning: pagePlanning, reglages: pageReglages };
let ROUTING = 0;
async function route() {
  const my = ++ROUTING;
  if (SITE_NEW) { location.reload(); return; }   // nouvelle version publiée : la page demandée s'ouvre avec le nouveau code
  if (pageOf() === 'uber') { location.replace('#/x-uber'); return; }   // ancien lien (application 1.1)
  if (!/^x-/.test(pageOf()) || !S.session) extHide();   // autre volet : volets externes masqués (leurs pages restent chargées)
  S.timers.forEach(clearInterval); S.timers = [];
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
  if (!S.session) { if (S.alertCh) { sb.removeChannel(S.alertCh); S.alertCh = null; } loginView(); return; }
  if (!S.profile) {
    const { data, error } = await sb.from('profiles').select('*').eq('user_id', S.session.user.id).maybeSingle();
    // erreur réseau : pas de « compte en attente » par erreur ; le profil est relu au prochain changement de page
    if (error) { $('#app').innerHTML = msg('Base inaccessible : ' + esc(error.message) + '. Rechargez la page.', 'err'); return; }
    S.profile = data || { email: S.session.user.email, role: 'pending' };
  }
  if (S.profile.role === 'pending') { pendingView(); return; }
  try { await loadRef(); } catch (e) { $('#app').innerHTML = msg('Base inaccessible : ' + esc(e.message), 'err'); return; }
  await mineLoad();   // planning : véhicules confiés pour le shift en cours
  if (my !== ROUTING) return;   // autre page demandée pendant le chargement
  if (!canSee(pageOf())) { location.replace('#/' + firstAllowed()); return; }   // volet non autorisé à cet utilisateur
  let page = shell();
  if (/^x-/.test(page)) { const id = page.slice(2); PAGES[page] = () => pageExt(id); }
  if (!PAGES[page] || (ADMIN_PAGES[page] && !isAdmin())) page = 'direct';
  watchAlerts();
  window.__rerender = null;
  try { await PAGES[page](); } catch (e) { if (my === ROUTING) $('#page').innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); }
  if (my !== ROUTING) return;
  S.timers.push(setInterval(health, 60000));
  // changement de shift (19 h, 7 h) : répartition du planning relue ; page redessinée si « Mes véhicules » change (sauf pages de saisie)
  S.timers.push(setInterval(async () => {
    const was = S.mine ? [...S.mine].sort().join() : '', k = S.mineKey; await mineLoad();
    if (my === ROUTING && S.mineKey !== k && (S.mine ? [...S.mine].sort().join() : '') !== was && !/^(manifeste|courses|reglages|planning|x-)/.test(pageOf())) route();
  }, 60000));
  if (page === 'direct') {
    LIVE.retryAt = 0; LIVE.primed = false; liveTick(my);
    S.timers.push(setInterval(() => liveTick(my), LIVE_SEC * 1000));
    S.timers.push(setInterval(() => liveDrvTick(my), DRV_SEC * 1000));
    S.timers.push(setInterval(liveClock, 1000));
    S.timers.push(setInterval(() => { if (!document.hidden && my === ROUTING) pageDirect(true).catch(() => { }); }, 60000));
    S.channel = sb.channel('live').on('postgres_changes', { event: '*', schema: 'public', table: 'live_status' }, () => { clearTimeout(window.__lt); window.__lt = setTimeout(() => { if (my === ROUTING) pageDirect(true).catch(() => { }); }, 3000); }).subscribe();
  }
}
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange(async (ev, session) => {
  if (ev === 'PASSWORD_RECOVERY') {
    const p = prompt('Nouveau mot de passe (6 caractères minimum) :');
    if (p) { const { error } = await sb.auth.updateUser({ password: p }); alert(error ? error.message : 'Mot de passe changé.'); }
  }
  const changed = (S.session && S.session.user.id) !== (session && session.user.id);
  if (changed) {   // autre utilisateur : rien de ce qui a été lu pour le précédent n'est gardé (droits par agence, planning)
    S.profile = null; S.P = null; S.mine = null; S.mineKey = undefined; S.mineShift = null; S.ctrShift = {}; S.usage = undefined;
    Object.assign(LIVE, { rows: [], pos: {}, at: 0, trails: {}, ctr: [], alerts: [], seen: {}, primed: false, fast: {}, over: {}, drv: {}, drvAt: 0, sel: '' });
  }
  S.session = session; if (changed) route();
});
sb.auth.getSession().then(({ data }) => { S.session = data.session; route(); });
