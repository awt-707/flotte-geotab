// Connexions en temps réel : chaque onglet / application ouvert envoie un signal toutes les minutes (session_ping) ;
// l'administrateur voit qui est en ligne, sur quelle page, depuis quel appareil (page Connexions, pastille en bas du menu).
// Chargé avant app.js : utilise ses outils (sb, S, all, rpc, esc…) au moment de l'appel.
function sessNewId() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
const SESS = { id: sessNewId(), act: Date.now(), off: false };
const SESS_ONLINE_MIN = 3, SESS_IDLE_MIN = 10;   // en ligne : signal de moins de 3 min ; actif : utilisé dans les 10 dernières minutes

/** Appareil : application Ludy (version) ou navigateur, et système */
function sessClient() {
  const ua = navigator.userAgent || '', os = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return (window.LUDY_APP ? 'Application ' + (window.LUDY_APP.version || '') : 'Navigateur') + (os ? ' · ' + os : '');
}
function sessPageName(p) { const n = (typeof NAV !== 'undefined' ? NAV : []).find(x => x[0] === p); return n ? n[1] : p === 'application' ? 'Application' : /^x-/.test(p) ? 'Volet ' + p.slice(2) : p; }
/** Signal de l'onglet : page affichée, appareil, actif (visible et utilisé récemment) */
async function sessPing() {
  if (SESS.off || !S.session || !S.profile || S.profile.role === 'pending') return;
  const active = !document.hidden && Date.now() - SESS.act < SESS_IDLE_MIN * MIN;
  try { await rpc('session_ping', { p_id: SESS.id, p_page: sessPageName(pageOf()), p_client: sessClient(), p_active: active }); }
  catch (e) { if (/session_ping|404|not find|does not exist/i.test(e.message || '')) SESS.off = true; }   // migration pas encore exécutée : plus d'essai
  sessBadge();
}
/** Déconnexion : la session de cet onglet disparaît tout de suite de la liste */
async function sessEnd() { try { if (S.session) await sb.from('user_sessions').delete().eq('id', SESS.id); } catch (e) { } }
if (typeof document !== 'undefined') {   // navigateur seulement (le fichier est aussi chargé par les tests sous Node)
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(ev => document.addEventListener(ev, () => { SESS.act = Date.now(); }, { passive: true, capture: true }));
  let sessMove = 0; document.addEventListener('mousemove', () => { const t = Date.now(); if (t - sessMove > 15000) { sessMove = t; SESS.act = t; } }, { passive: true });
  setInterval(sessPing, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) SESS.act = Date.now(); sessPing(); });
}

/** Sessions des 7 derniers jours regroupées par utilisateur : statut, appareils, page, depuis, dernière activité */
function sessGroup(profiles, rows, now) {
  const on = r => now - new Date(r.last_seen).getTime() < SESS_ONLINE_MIN * 60000, by = {};
  rows.forEach(r => { (by[r.user_id] = by[r.user_id] || []).push(r); });
  return profiles.filter(p => p.role !== 'pending' || by[p.user_id]).map(p => {
    const l = (by[p.user_id] || []).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen)), live = l.filter(on);
    const st = live.some(r => r.active) ? 'En ligne' : live.length ? 'Inactif' : 'Hors ligne';
    return { p, st, live, last: l[0] ? l[0].last_seen : null, since: live.length ? live.map(r => r.started_at).sort()[0] : null, page: (live.find(r => r.active) || live[0] || {}).page || '' };
  }).sort((a, b) => ['En ligne', 'Inactif', 'Hors ligne'].indexOf(a.st) - ['En ligne', 'Inactif', 'Hors ligne'].indexOf(b.st) || String(b.last || '').localeCompare(String(a.last || '')));
}
/** Pastille « ● n en ligne » en bas du menu (administrateur) */
async function sessBadge() {
  const el = document.getElementById('onl'); if (!el || !isAdmin() || SESS.off) return;
  try {
    const rows = await all('user_sessions', 'id,user_id,last_seen,active', q => q.gte('last_seen', new Date(Date.now() - SESS_ONLINE_MIN * MIN).toISOString()));
    const n = new Set(rows.map(r => r.user_id)).size;
    el.textContent = '● ' + n + ' connecté' + (n > 1 ? 's' : ''); el.hidden = false;
  } catch (e) { el.hidden = true; }
}
async function pageConnexions(refresh) {
  const my = ROUTING, head = `<div class="head"><h1>Connexions</h1><div class="sub">Qui a Ludy ouvert en ce moment (site ou application), sur quelle page et depuis quel appareil. Mis à jour toutes les 15 s ; chaque onglet ouvert envoie un signal toutes les minutes.</div></div>`;
  let profiles, rows;
  try {
    [profiles, rows] = await Promise.all([all('profiles', 'user_id,email,name,role', null, ['email']),
      all('user_sessions', '*', q => q.gte('last_seen', new Date(Date.now() - 7 * DAY).toISOString()), ['last_seen', false])]);
  } catch (e) {
    if (my === ROUTING) $('#page').innerHTML = head + msg('Suivi des connexions pas encore installé : exécuter <b>supabase/migrations/20261101000000_connexions.sql</b> dans Supabase &gt; SQL Editor. (' + esc(e.message) + ')', 'err');
    return;
  }
  if (my !== ROUTING) return;
  const now = Date.now(), list = sessGroup(profiles, rows, now), n = s => list.filter(x => x.st === s).length;
  const dot = st => `<span class="sdot2 ${st === 'En ligne' ? 'on' : st === 'Inactif' ? 'idle' : 'off'}"></span>${esc(st)}`;
  $('#page').innerHTML = head + cards([['En ligne', f0(n('En ligne')), n('En ligne') ? 'ok' : ''], ['Onglet ouvert, inactif (plus de ' + SESS_IDLE_MIN + ' min)', f0(n('Inactif'))],
      ['Hors ligne', f0(n('Hors ligne'))], ['Comptes', f0(list.length)]]) +
    table('tsess', [['Utilisateur', x => esc(x.p.name || x.p.email || '') + (x.p.name ? '<div class="small">' + esc(x.p.email || '') + '</div>' : ''), x => x.p.email],
      ['Rôle', x => esc(ROLE_TXT[x.p.role] || x.p.role)], ['Statut', x => dot(x.st), x => ['En ligne', 'Inactif', 'Hors ligne'].indexOf(x.st)],
      ['Page actuelle', x => x.live.length ? esc(x.page) : ''], ['Appareils ouverts', x => x.live.map(r => `<div>${esc(r.client || '')}${r.active ? '' : ' <span class="small">(inactif)</span>'}</div>`).join(''), x => x.live.length],
      ['Connecté depuis', x => x.since ? fmtDTY(x.since) : '', x => x.since || ''], ['Dernière activité', x => x.last ? fmtDTY(x.last) + ' <span class="small ago" data-t="' + esc(x.last) + '">' + (typeof ago === 'function' ? ago(x.last) : '') + '</span>' : '<span class="small">aucune (7 jours)</span>', x => x.last || '']],
      list, { empty: 'Aucun compte' }) +
    '<div class="small">En ligne : onglet ou application ouvert et utilisé ces ' + SESS_IDLE_MIN + ' dernières minutes. Inactif : ouvert mais pas utilisé (ou en arrière-plan). Hors ligne : aucun signal depuis ' + SESS_ONLINE_MIN + ' min (fermé, ordinateur en veille ou sans réseau).</div>';
  window.__rerender = () => pageConnexions(true);
  if (!refresh) S.timers.push(setInterval(() => { if (!document.hidden && my === ROUTING) pageConnexions(true); }, 15000));
}
if (typeof module !== 'undefined') module.exports = { sessGroup };
