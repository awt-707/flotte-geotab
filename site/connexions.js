// Connexions en temps réel : chaque onglet / application ouvert envoie un signal toutes les minutes (session_ping) ;
// l'administrateur voit qui est en ligne, sur quelle page, depuis quel appareil (page Connexions, pastille en bas du menu).
// Chargé avant app.js : utilise ses outils (sb, S, all, rpc, esc…) au moment de l'appel.
function sessNewId() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
// badge : dernier compte de la pastille { uid, n, at }, gardé d'une page à l'autre ; seen : premier signal de l'onglet envoyé
const SESS = { id: sessNewId(), act: Date.now(), off: false, badge: null, seen: false };
const SESS_ONLINE_MIN = 3, SESS_IDLE_MIN = 10;   // en ligne : signal de moins de 3 min ; actif : utilisé dans les 10 dernières minutes
const SESS_BADGE_SEC = 45;   // pastille relue au plus toutes les 45 s en changeant de page (le signal de la minute la relit toujours)
/** Autre utilisateur ou déconnexion : nouvelle session, compte des connectés oublié et pastille masquée (jamais montrée à un autre compte) */
function sessReset() { SESS.id = sessNewId(); SESS.off = false; SESS.badge = null; SESS.seen = false; sessBadgePaint(); }

/** Appareil : application Ludy (version) ou navigateur, et système */
function sessClient() {
  const ua = navigator.userAgent || '', os = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return (window.LUDY_APP ? 'Application ' + (window.LUDY_APP.version || '') : 'Navigateur') + (os ? ' · ' + os : '');
}
function sessPageName(p) { const n = (typeof NAV !== 'undefined' ? NAV : []).find(x => x[0] === p); return n ? n[1] : p === 'application' ? 'Application' : /^x-/.test(p) ? 'Volet ' + p.slice(2) : p; }
/** Signal de l'onglet : page affichée, appareil, actif (visible et utilisé récemment) ; tick = signal de la minute (pastille relue) */
async function sessPing(tick) {
  if (SESS.off || !S.session || !S.profile || S.profile.role === 'pending') return;
  const active = !document.hidden && Date.now() - SESS.act < SESS_IDLE_MIN * MIN, sid = SESS.id, first = !SESS.seen;
  try { await rpc('session_ping', { p_id: SESS.id, p_page: sessPageName(pageOf()), p_client: sessClient(), p_active: active }); if (SESS.id === sid) SESS.seen = true; }
  catch (e) { if (/session_ping|404|not find|does not exist/i.test(e.message || '')) SESS.off = true; }   // migration pas encore exécutée : plus d'essai
  sessBadge(tick === true || first);   // premier signal : l'onglet vient de s'ajouter au compte
}
/** Déconnexion : la session de cet onglet est close tout de suite (gardée dans l'historique, marquée « Déconnecté ») */
const SESS_OUT = 'Déconnecté';
async function sessEnd() { try { if (S.session) await sb.from('user_sessions').update({ last_seen: new Date().toISOString(), active: false, page: SESS_OUT }).eq('id', SESS.id); } catch (e) { } }
if (typeof document !== 'undefined') {   // navigateur seulement (le fichier est aussi chargé par les tests sous Node)
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(ev => document.addEventListener(ev, () => { SESS.act = Date.now(); }, { passive: true, capture: true }));
  let sessMove = 0; document.addEventListener('mousemove', () => { const t = Date.now(); if (t - sessMove > 15000) { sessMove = t; SESS.act = t; } }, { passive: true });
  setInterval(() => sessPing(true), 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) SESS.act = Date.now(); sessPing(); });
}

/** Sessions des 7 derniers jours regroupées par utilisateur : statut, appareils, page, depuis, dernière activité */
function sessGroup(profiles, rows, now) {
  const on = r => r.page !== SESS_OUT && now - new Date(r.last_seen).getTime() < SESS_ONLINE_MIN * 60000, by = {};
  rows.forEach(r => { (by[r.user_id] = by[r.user_id] || []).push(r); });
  return profiles.filter(p => p.role !== 'pending' || by[p.user_id]).map(p => {
    const l = (by[p.user_id] || []).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen)), live = l.filter(on);
    const st = live.some(r => r.active) ? 'En ligne' : live.length ? 'Inactif' : 'Hors ligne';
    return { p, st, live, last: l[0] ? l[0].last_seen : null, since: live.length ? live.map(r => r.started_at).sort()[0] : null, page: (live.find(r => r.active) || live[0] || {}).page || '' };
  }).sort((a, b) => ['En ligne', 'Inactif', 'Hors ligne'].indexOf(a.st) - ['En ligne', 'Inactif', 'Hors ligne'].indexOf(b.st) || String(b.last || '').localeCompare(String(a.last || '')));
}
/**
 * Historique des connexions : sessions d'un même utilisateur sur le même appareil réunies quand la suivante commence moins de
 * 3 min après la fin de la précédente (page rechargée, nouvel onglet) ; début, fin (dernier signal), durée, dernière page.
 * En cours = signal de moins de 3 min et pas déconnecté.
 */
function sessHistory(profiles, rows, now) {
  const pr = {}; profiles.forEach(p => { pr[p.user_id] = p; });
  const ms = x => new Date(x).getTime(), by = {}, out = [];
  rows.slice().sort((a, b) => ms(a.started_at) - ms(b.started_at)).forEach(r => { const k = r.user_id + '|' + (r.client || ''); (by[k] = by[k] || []).push(r); });
  Object.values(by).forEach(list => {
    let c = null;
    list.forEach(r => {
      const a = ms(r.started_at), b = Math.max(a, ms(r.last_seen)), off = r.page === SESS_OUT;
      if (c && !c.off && a - c.end < SESS_ONLINE_MIN * 60000) { if (b >= c.end) { c.end = b; c.page = r.page; c.off = off; } c.n++; return; }
      c = { p: pr[r.user_id] || { user_id: r.user_id, email: '' }, client: r.client || '', start: a, end: b, page: r.page, off, n: 1 }; out.push(c);
    });
  });
  out.forEach(c => { c.live = !c.off && now - c.end < SESS_ONLINE_MIN * 60000; c.dur = c.end - c.start; });
  return out.sort((x, y) => y.start - x.start);
}
function sessDur(ms) { const m = Math.round(ms / 60000); return m < 1 ? 'moins d\'1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); }
/** Utilisateurs en ligne : signal de moins de 3 min, pas déconnectés (pastille du menu, même règle que la page) */
function sessOnline(rows, now) { return new Set(rows.filter(r => r.page !== SESS_OUT && now - new Date(r.last_seen).getTime() < SESS_ONLINE_MIN * 60000).map(r => r.user_id)).size; }
/** Pastille « ● n connectés » en bas du menu (administrateur) : dernier compte, affiché tout de suite quand le menu est reconstruit */
function sessBadgePaint() {
  const el = typeof document !== 'undefined' && document.getElementById('onl'), b = SESS.badge; if (!el) return;
  const ok = !!b && !SESS.off && isAdmin() && !!S.session && b.uid === S.session.user.id;
  if (ok) el.textContent = '● ' + b.n + ' connecté' + (b.n > 1 ? 's' : '');
  el.hidden = !ok;
}
function sessBadgeSet(n) { if (!S.session) return; SESS.badge = { uid: S.session.user.id, n, at: Date.now() }; sessBadgePaint(); }
/** Compte relu au plus toutes les SESS_BADGE_SEC s (force : tout de suite) ; la page Connexions le met aussi à jour à chaque lecture */
async function sessBadge(force) {
  if (!document.getElementById('onl') || !isAdmin() || !S.session || SESS.off) return;
  sessBadgePaint();
  const b = SESS.badge, sid = SESS.id;
  if (!force && b && b.uid === S.session.user.id && Date.now() - b.at < SESS_BADGE_SEC * 1000) return;
  try {
    const rows = await all('user_sessions', 'id,user_id,last_seen,active,page', q => q.gte('last_seen', new Date(Date.now() - SESS_ONLINE_MIN * MIN).toISOString()));
    if (SESS.id === sid) sessBadgeSet(sessOnline(rows, Date.now()));   // autre utilisateur entre-temps : rien gardé
  } catch (e) { /* lecture en échec (réseau) : dernier compte gardé, nouvel essai au prochain signal */ }
}
async function pageConnexions(refresh) {
  const my = ROUTING, head = `<div class="head"><h1>Connexions</h1><div class="sub">Qui a Ludy ouvert en ce moment (site ou application), sur quelle page et depuis quel appareil. Mis à jour toutes les 15 s ; chaque onglet ouvert envoie un signal toutes les minutes.</div></div>`;
  let profiles, rows;
  try {
    [profiles, rows] = await Promise.all([all('profiles', 'user_id,email,name,role', null, ['email']),
      all('user_sessions', '*', q => q.gte('last_seen', new Date(Date.now() - 30 * DAY).toISOString()), ['last_seen', false])]);
  } catch (e) {
    if (my === ROUTING) $('#page').innerHTML = head + msg('Suivi des connexions pas encore installé : exécuter <b>supabase/migrations/20261101000000_connexions.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message) + ')', 'err');
    return;
  }
  if (my !== ROUTING) return;
  const now = Date.now(), list = sessGroup(profiles, rows, now), n = s => list.filter(x => x.st === s).length;
  sessBadgeSet(sessOnline(rows, now));   // pastille du menu à jour avec la page, sans autre lecture
  const q = qs(), jd = [1, 7, 30].includes(+q.get('j')) ? +q.get('j') : 7, fu = q.get('u') || '';
  const hist = sessHistory(profiles, rows, now).filter(h => h.end >= now - jd * DAY && (!fu || h.p.user_id === fu));
  const tot = {}; hist.forEach(h => { const t = tot[h.p.user_id] = tot[h.p.user_id] || { p: h.p, n: 0, ms: 0, last: 0 }; t.n++; t.ms += h.dur; t.last = Math.max(t.last, h.end); });
  const who = h => esc(h.p.name || h.p.email || '') + (h.p.name ? '<div class="small">' + esc(h.p.email || '') + '</div>' : '');
  const dot = st => `<span class="sdot2 ${st === 'En ligne' ? 'on' : st === 'Inactif' ? 'idle' : 'off'}"></span>${esc(st)}`;
  $('#page').innerHTML = head + cards([['En ligne', f0(n('En ligne')), n('En ligne') ? 'ok' : ''], ['Onglet ouvert, inactif (plus de ' + SESS_IDLE_MIN + ' min)', f0(n('Inactif'))],
      ['Hors ligne', f0(n('Hors ligne'))], ['Comptes', f0(list.length)]]) +
    table('tsess', [['Utilisateur', x => esc(x.p.name || x.p.email || '') + (x.p.name ? '<div class="small">' + esc(x.p.email || '') + '</div>' : ''), x => x.p.email],
      ['Rôle', x => esc(ROLE_TXT[x.p.role] || x.p.role)], ['Statut', x => dot(x.st), x => ['En ligne', 'Inactif', 'Hors ligne'].indexOf(x.st)],
      ['Page actuelle', x => x.live.length ? esc(x.page) : ''], ['Appareils ouverts', x => x.live.map(r => `<div>${esc(r.client || '')}${r.active ? '' : ' <span class="small">(inactif)</span>'}</div>`).join(''), x => x.live.length],
      ['Connecté depuis', x => x.since ? fmtDTY(x.since) : '', x => x.since || ''], ['Dernière activité', x => x.last ? fmtDTY(x.last) + ' <span class="small ago" data-t="' + esc(x.last) + '">' + (typeof ago === 'function' ? ago(x.last) : '') + '</span>' : '<span class="small">aucune (30 jours)</span>', x => x.last || '']],
      list, { empty: 'Aucun compte' }) +
    '<div class="small">En ligne : onglet ou application ouvert et utilisé ces ' + SESS_IDLE_MIN + ' dernières minutes. Inactif : ouvert mais pas utilisé (ou en arrière-plan). Hors ligne : aucun signal depuis ' + SESS_ONLINE_MIN + ' min (fermé, ordinateur en veille ou sans réseau).</div>' +
    `<h2>Historique des connexions</h2><div class="bar"><label>Période <select id="shj">${[[1, 'Dernières 24 h'], [7, '7 derniers jours'], [30, '30 derniers jours']].map(x => `<option value="${x[0]}" ${x[0] === jd ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label>
      <label>Utilisateur <select id="shu"><option value="">Tous</option>${profiles.filter(p => p.role !== 'pending').map(p => `<option value="${esc(p.user_id)}" ${p.user_id === fu ? 'selected' : ''}>${esc(p.name || p.email || '')}</option>`).join('')}</select></label></div>` +
    table('thsum', [['Utilisateur', t => who(t)], ['Connexions', t => f0(t.n), t => t.n, 'n'], ['Temps connecté', t => sessDur(t.ms), t => t.ms, 'n'], ['Dernière connexion', t => fmtDTY(t.last), t => t.last]],
      Object.values(tot).sort((a, b) => b.last - a.last), { empty: 'Aucune connexion sur la période' }) +
    table('thist', [['Utilisateur', h => who(h)], ['Appareil', h => esc(h.client)], ['Début', h => fmtDTY(h.start), h => h.start], ['Fin', h => h.live ? '<span class="sdot2 on"></span>en cours' : fmtDTY(h.end) + (h.off ? ' <span class="small">(déconnexion)</span>' : ''), h => h.end],
      ['Durée', h => sessDur(h.dur), h => h.dur, 'n'], ['Dernière page', h => h.off ? '' : esc(h.page || '')]], hist, { empty: 'Aucune connexion sur la période' }) +
    '<div class="small">Une connexion = un onglet ou l\'application ouvert, du premier au dernier signal (pages rechargées réunies). Historique conservé 30 jours.</div>';
  const go = () => { location.hash = '#/connexions?j=' + $('#shj').value + ($('#shu').value ? '&u=' + encodeURIComponent($('#shu').value) : ''); };
  $('#shj').onchange = go; $('#shu').onchange = go;
  window.__rerender = () => pageConnexions(true);
  if (!refresh) S.timers.push(setInterval(() => { if (!document.hidden && my === ROUTING) pageConnexions(true); }, 15000));
}
if (typeof module !== 'undefined') module.exports = { sessGroup, sessHistory, sessDur, sessOnline };
