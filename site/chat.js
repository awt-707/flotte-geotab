// Tchat de Ludy (22/11/2026, demande d'Ahmed : parler aux gestionnaires en ligne sans sortir de Ludy pour WhatsApp).
// Page #/chat : conversations à deux ou de groupe, messages texte, fichiers (PDF, images, tableurs…), messages audio enregistrés
// dans le navigateur, appels audio / vidéo WebRTC entre deux comptes (la base ne relaie que la signalisation : chat_signals).
// Temps réel Supabase (chat_messages, chat_calls, chat_signals) avec repli par relecture (sans temps réel : toutes les 4 s sur la page,
// 15 s ailleurs, 1 s pendant l'établissement d'un appel). Notifications : bandeau en bas à droite, bip, notification du système
// si Ludy est caché, pastille du menu (#nbchat) ; appel entrant = sonnerie plein écran sur toutes les pages. Historique gardé en base.
// En ligne = signal de connexion de moins de 3 min (user_sessions, chat_users()). Tout compte validé (admin, gestionnaire, lecture seule, RH).
const CH = { threads: [], users: [], umap: {}, cur: null, msgs: [], seen: new Set(), lastId: 0, rt: false, poll: 0, fast: 0, call: null, ring: null,
  badge: null, urls: {}, rec: null, ready: false, audio: null, sent: {} };
const CH_MAX_MB = 15, CH_ICE_DEFAULT = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
function chatMe() { return S.session ? S.session.user.id : null; }
function chatName(uid) { const u = CH.umap[uid]; return u ? u.name : (uid === chatMe() ? 'Moi' : 'Compte'); }
/** Titre d'une conversation : nom du groupe, ou l'autre membre */
function chatTitle(t) {
  if (!t) return '';
  if (t.kind === 'group') return t.name || 'Groupe';
  const o = (t.members || []).find(m => m.user_id !== chatMe());
  return o ? o.name : 'Conversation';
}
function chatOther(t) { return t && t.kind === 'direct' ? (t.members || []).find(m => m.user_id !== chatMe()) : null; }
function chatOnline(uid) { const u = CH.umap[uid]; return !!(u && u.online); }
// Icônes du tchat (traits, 24 px, couleur du texte) : refonte du 23/11/2026 (demande d'Ahmed : « plus moderne, beau et bien organisé »)
const CH_ICO = { clip: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>', phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  video: '<path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>', users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', back: '<path d="m15 18-6-6 6-6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  leave: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' };
function chIco(n) { return `<svg class="chi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CH_ICO[n] || ''}</svg>`; }
/** Teinte stable d'un avatar d'après le nom (chaque personne garde sa couleur) */
function chHue(name) { let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function chatHM(d) { const p = parts(new Date(d)); return p.hour + ':' + p.minute; }
function chatDayKey(d) { const p = parts(new Date(d)); return p.year + '-' + p.month + '-' + p.day; }
/** Séparateur de jour : « Aujourd'hui », « Hier », « lundi 21/11 » */
function chatDayLbl(d) {
  const k = chatDayKey(d), now = Date.now();
  if (k === chatDayKey(now)) return 'Aujourd\'hui';
  if (k === chatDayKey(now - 86400000)) return 'Hier';
  const p = parts(new Date(d)); return ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][new Date(d).getDay()] + ' ' + p.day + '/' + p.month;
}
/** Serveurs ICE : STUN de Google, plus ceux du paramètre chatIce (JSON : TURN d'Ahmed s'il en règle un) */
function chatIce() {
  let extra = [];
  try { const v = (S.P || {}).chatIce; if (v) { const o = JSON.parse(String(v)); extra = Array.isArray(o) ? o : o && Array.isArray(o.iceServers) ? o.iceServers : []; } } catch (e) { }
  return CH_ICE_DEFAULT.concat(extra);
}
async function chatRefresh() {
  const [l, u] = await Promise.all([sb.rpc('chat_list'), sb.rpc('chat_users')]);
  if (l.error) throw l.error;
  CH.threads = l.data || []; CH.users = u.data || []; CH.umap = {}; CH.users.forEach(x => { CH.umap[x.user_id] = x; });
  CH.ready = true;
}
function chatBadgeN() { return CH.threads.reduce((s, t) => s + (+t.unread || 0), 0); }
function chatBadgePaint() {
  const n = CH.badge == null ? chatBadgeN() : CH.badge;
  document.querySelectorAll('#nbchat, .mtabs [data-mt="tchat"] .nb').forEach(el => { el.textContent = n || ''; el.hidden = !n; el.title = n + ' message(s) non lu(s)'; });
  const b = $('.mtabs [data-mt="tchat"]'); if (b && !b.querySelector('.nb')) { const s = document.createElement('span'); s.className = 'nb'; s.textContent = n || ''; s.hidden = !n; b.appendChild(s); }
}

// ---------- Page ----------
async function pageChat() {
  const my = ROUTING;
  $('#page').innerHTML = `<div class="head"><h1>Tchat</h1></div><div class="chat" id="chat"><div class="loading">Chargement…</div></div>`;
  try { await chatRefresh(); } catch (e) { if (my === ROUTING) $('#chat').innerHTML = msg('Tchat indisponible : ' + esc(e.message) + (/chat_list|function/i.test(e.message) ? '. Migration 20261213000000_tchat.sql à exécuter.' : ''), 'err'); return; }
  if (my !== ROUTING) return;
  CH.badge = null; chatBadgePaint();
  const q = qs(), u = q.get('u'), tid = +q.get('t');
  if (u && u !== chatMe()) { const r = await sb.rpc('chat_open', { p_user: u }); if (!r.error) { history.replaceState(null, '', '#/chat?t=' + r.data); await chatRefresh(); CH.cur = r.data; } }
  else CH.cur = tid && CH.threads.some(t => t.id === tid) ? tid : null;
  if (my !== ROUTING) return;
  chatPaint();
  if (CH.cur) await chatOpen(CH.cur, my);
  chatWatch(); chatFast(true);
  S.timers.push(setInterval(() => { chatRefresh().then(() => { if (pageOf() === 'chat') chatPaintList(); }).catch(() => { }); }, 30000));   // présence (en ligne)
  window.__rerender = () => { chatPaint(); if (CH.cur) chatOpen(CH.cur, ROUTING); };
  if (typeof svNotifAsk === 'function') svNotifAsk();
}
function chatPaint() {
  const el = $('#chat'); if (!el) return;
  el.innerHTML = `<aside class="chlist${CH.cur ? ' hasc' : ''}" id="chlist"></aside><section class="chmain${CH.cur ? ' on' : ''}" id="chmain">${CH.cur ? '' : `<div class="chempty"><span class="chemptyic">${chIco('chat')}</span><b>Vos conversations</b><p>Choisissez une conversation à gauche, ou écrivez à un collègue en ligne.</p></div>`}</section>`;
  chatPaintList();
}
function chatAvatar(name, online, big) {
  const ini = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  return `<span class="chav${big ? ' big' : ''}" data-on="${online ? 1 : 0}" style="--h:${chHue(name)}" aria-hidden="true">${esc(ini)}</span>`;
}
function chatPaintList() {
  const el = $('#chlist'); if (!el) return;
  const me = chatMe(), onl = CH.users.filter(x => x.user_id !== me && x.online), off = CH.users.filter(x => x.user_id !== me && !x.online);
  const row = t => { const o = chatOther(t), on = o ? chatOnline(o.user_id) : (t.members || []).some(m => m.user_id !== me && chatOnline(m.user_id));
    return `<a href="#/chat?t=${t.id}" class="chrow${t.id === CH.cur ? ' on' : ''}${t.unread ? ' unread' : ''}" data-cht="${t.id}">${chatAvatar(chatTitle(t), on)}<span class="chtx"><b>${esc(chatTitle(t))}${t.kind === 'group' ? ` <span class="small mute">· ${t.members.length}</span>` : ''}</b><span class="chlast">${esc(t.last_text || 'Nouvelle conversation')}</span></span><span class="chmeta">${t.last_at ? esc(chatWhen(t.last_at)) : ''}${t.unread ? `<span class="nb">${t.unread}</span>` : ''}</span></a>`; };
  const usr = x => `<button type="button" class="chrow chuser" data-chu="${x.user_id}">${chatAvatar(x.name, x.online)}<span class="chtx"><b>${esc(x.name)}</b><span class="chlast">${esc(ROLE_TXT[x.role] || x.role)} · ${x.online ? '<span class="ok">en ligne</span>' : x.last_seen ? 'vu ' + esc(chatWhen(x.last_seen)) : 'jamais connecté'}</span></span></button>`;
  const nUnread = chatBadgeN();
  el.innerHTML = `<div class="chlhead"><b>Messages</b>${nUnread ? `<span class="chpillnb">${nUnread} non lu${nUnread > 1 ? 's' : ''}</span>` : ''}<button type="button" class="chpill" id="chgrp" title="Créer un groupe">${chIco('users')}<span>Groupe</span></button></div>
    <div class="chtools"><label class="chsearch">${chIco('search')}<input type="search" id="chq" placeholder="Rechercher" aria-label="Rechercher une conversation ou un compte"></label></div>
    <div class="chsec">Conversations</div><div id="chthreads">${CH.threads.length ? CH.threads.map(row).join('') : '<div class="small mute chpad">Aucune conversation. Choisissez un compte ci-dessous.</div>'}</div>
    <div class="chsec">En ligne <span class="chcount on">${onl.length}</span></div><div id="chonl">${onl.length ? onl.map(usr).join('') : '<div class="small mute chpad">Personne d\'autre n\'est connecté.</div>'}</div>
    <div class="chsec">Hors ligne <span class="chcount">${off.length}</span></div><div id="choff">${off.map(usr).join('')}</div>`;
  el.querySelectorAll('[data-chu]').forEach(b => { b.onclick = async () => { try { const r = await sb.rpc('chat_open', { p_user: b.dataset.chu }); if (r.error) throw r.error; location.hash = '#/chat?t=' + r.data; } catch (e) { uiNote(e.message); } }; });
  $('#chq').oninput = () => { const v = $('#chq').value.trim().toLowerCase(); el.querySelectorAll('.chrow').forEach(r => { r.hidden = !!v && !r.textContent.toLowerCase().includes(v); }); };
  $('#chgrp').onclick = chatNewGroup;
}
/** « 14:05 », « hier », « 12/11 » */
function chatWhen(d) {
  const t = new Date(d), n = new Date(), p = parts(t), pn = parts(n);
  if (p.day === pn.day && p.month === pn.month && p.year === pn.year) return p.hour + ':' + p.minute;
  if (n - t < 7 * 86400000) return ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][t.getDay()] + ' ' + p.hour + ':' + p.minute;
  return p.day + '/' + p.month;
}
async function chatNewGroup() {
  const me = chatMe(), others = CH.users.filter(x => x.user_id !== me);
  if (!others.length) { uiNote('Aucun autre compte validé.'); return; }
  const name = await askText('Nom du groupe', ''); if (!name || !name.trim()) return;
  const el = $('#chmain'); CH.cur = null; $('#chlist').classList.remove('hasc'); el.classList.add('on');
  el.innerHTML = `<div class="chhead"><b>Nouveau groupe : ${esc(name.trim())}</b></div><div class="chgrpform"><p>Membres :</p>${others.map(x => `<label class="chk"><input type="checkbox" value="${x.user_id}"> ${esc(x.name)} <span class="small mute">· ${esc(ROLE_TXT[x.role] || x.role)}</span></label>`).join('')}
    <div class="row"><button type="button" id="chgok">Créer le groupe</button> <button type="button" class="ghost" id="chgno">Annuler</button></div></div>`;
  $('#chgno').onclick = () => { chatPaint(); };
  $('#chgok').onclick = async () => {
    const ids = [...el.querySelectorAll('input:checked')].map(i => i.value); if (!ids.length) { uiNote('Choisissez au moins un membre.'); return; }
    try { const r = await sb.rpc('chat_group', { p_name: name.trim(), p_members: ids }); if (r.error) throw r.error; location.hash = '#/chat?t=' + r.data; } catch (e) { uiNote(e.message); }
  };
}

// ---------- Conversation ouverte ----------
async function chatOpen(id, my) {
  CH.cur = id; const t = CH.threads.find(x => x.id === id); if (!t) return;
  $('#chlist').classList.add('hasc'); const el = $('#chmain'); el.classList.add('on');
  const o = chatOther(t), on = o ? chatOnline(o.user_id) : false, grp = t.kind === 'group';
  el.innerHTML = `<div class="chhead"><a href="#/chat" class="chback" aria-label="Retour à la liste">${chIco('back')}</a>${chatAvatar(chatTitle(t), on)}<span class="chtx"><b>${esc(chatTitle(t))}</b><span class="small mute" id="chsub">${grp ? esc(t.members.map(m => m.name).join(', ')) : on ? '<span class="ok">en ligne</span>' : o && CH.umap[o.user_id] && CH.umap[o.user_id].last_seen ? 'vu ' + esc(chatWhen(CH.umap[o.user_id].last_seen)) : 'hors ligne'}</span></span>
    <span class="chacts">${grp ? `<button type="button" class="chround" id="chadd" title="Ajouter un membre">${chIco('plus')}</button><button type="button" class="chround" id="chleave" title="Quitter le groupe">${chIco('leave')}</button>` : `<button type="button" class="chround" id="chcalla" title="Appel audio">${chIco('phone')}</button><button type="button" class="chround" id="chcallv" title="Appel vidéo">${chIco('video')}</button>`}</span></div>
    <div class="chmsgs" id="chmsgs"><div class="loading">Chargement…</div></div>
    <form class="chcomp" id="chcomp"><button type="button" class="chico" id="chfile" title="Envoyer un fichier (PDF, image, tableur… ${CH_MAX_MB} Mo au plus)">${chIco('clip')}</button><input type="file" id="chfilein" hidden multiple>
      <textarea id="chtxt" rows="1" placeholder="Message…" aria-label="Message"></textarea>
      <button type="button" class="chico" id="chmic" title="Message audio (appuyer pour enregistrer, appuyer encore pour envoyer)">${chIco('mic')}</button><span id="chrec" class="chrec" hidden></span>
      <button type="submit" class="chico chsend" title="Envoyer">${chIco('send')}</button></form>`;
  const { data, error } = await sb.from('chat_messages').select('*').eq('thread_id', id).order('id', { ascending: false }).limit(300);
  if (my !== ROUTING || CH.cur !== id) return;
  if (error) { $('#chmsgs').innerHTML = msg(esc(error.message), 'err'); return; }
  CH.msgs = (data || []).reverse(); CH.msgs.forEach(m => { CH.seen.add(m.id); if (m.id > CH.lastId) CH.lastId = m.id; });
  await chatPaintMsgs();
  chatMarkRead(id);
  // composition
  const ta = $('#chtxt'), form = $('#chcomp');
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !MOBILE) { e.preventDefault(); form.requestSubmit(); } };
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
  form.onsubmit = async e => { e.preventDefault(); const v = ta.value.trim(); if (!v) return; ta.value = ''; ta.style.height = 'auto';
    try { await chatSend(id, 'text', v); } catch (x) { ta.value = v; uiNote('Envoi impossible : ' + x.message); } ta.focus(); };
  $('#chfile').onclick = () => $('#chfilein').click();
  $('#chfilein').onchange = async () => { const fs = [...$('#chfilein').files]; $('#chfilein').value = ''; for (const f of fs) { try { await chatUpload(id, f); } catch (x) { uiNote(esc(f.name) + ' : ' + x.message); } } };
  $('#chmic').onclick = () => chatRecToggle(id);
  if (!grp) { $('#chcalla').onclick = () => chatCall(id, 'audio'); $('#chcallv').onclick = () => chatCall(id, 'video'); }
  else {
    $('#chadd').onclick = async () => { const cand = CH.users.filter(x => !t.members.some(m => m.user_id === x.user_id)); if (!cand.length) { uiNote('Tous les comptes sont déjà membres.'); return; }
      const pick = await askText('Ajouter un membre : ' + cand.map((x, i) => (i + 1) + ' = ' + x.name).join(', ') + '\nNuméro :', '1'); const x = cand[(+pick || 0) - 1]; if (!x) return;
      try { const r = await sb.rpc('chat_group_add', { p_thread: id, p_user: x.user_id }); if (r.error) throw r.error; await chatRefresh(); chatPaint(); chatOpen(id, ROUTING); } catch (e) { uiNote(e.message); } };
    $('#chleave').onclick = async () => { if (!(await ask('Quitter ce groupe ?'))) return; try { const r = await sb.rpc('chat_group_leave', { p_thread: id }); if (r.error) throw r.error; CH.cur = null; location.hash = '#/chat'; } catch (e) { uiNote(e.message); } };
  }
  if (!MOBILE) ta.focus();
}
async function chatMarkRead(id) {
  const t = CH.threads.find(x => x.id === id); if (t) t.unread = 0;
  CH.badge = null; chatBadgePaint(); chatTitlePaint();
  try { await sb.rpc('chat_read', { p_thread: id }); } catch (e) { }
}
/** Lien signé (1 h) d'un fichier du tchat, gardé en mémoire */
async function chatUrl(path) {
  const c = CH.urls[path]; if (c && c.at > Date.now() - 50 * 60000) return c.url;
  const r = await sb.storage.from('chat').createSignedUrl(path, 3600); if (r.error) throw r.error;
  CH.urls[path] = { url: r.data.signedUrl, at: Date.now() }; return r.data.signedUrl;
}
function chatSize(n) { return n == null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
function chatDur(s) { s = Math.max(0, Math.round(+s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function chatText(t) { return esc(t).replace(/(https?:\/\/[^\s<]+)/g, m => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`).replace(/\n/g, '<br>'); }
/** Libellé d'un appel : « 📞 Appel audio · 3:05 », « Appel manqué »… */
function chatCallTxt(m) {
  const [kind, st] = String(m.body || '').split(' '), ic = kind === 'video' ? '🎥' : '📞', mine = m.user_id === chatMe();
  const lbl = { ringing: 'Appel en cours…', accepted: 'Communication en cours', ended: 'Appel ' + (kind === 'video' ? 'vidéo' : 'audio') + (m.duration_s != null ? ' · ' + chatDur(m.duration_s) : ''),
    declined: mine ? 'Appel refusé' : 'Appel refusé par vous', missed: mine ? 'Sans réponse' : 'Appel manqué', busy: 'Occupé', failed: 'Appel échoué' }[st] || 'Appel';
  return `<span class="chcalltxt ${st}">${ic} ${esc(lbl)}</span>`;
}
/** Message à la suite du précédent (même personne, même jour, moins de 5 min) : bulles groupées, nom affiché une fois */
function chatCont(m, prev) {
  return !!(prev && prev.user_id === m.user_id && ![m.kind, prev.kind].some(k => k === 'system' || k === 'call')
    && chatDayKey(prev.created_at) === chatDayKey(m.created_at) && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60000);
}
async function chatMsgHtml(m, prev) {
  const mine = m.user_id === chatMe(), when = fmtDT(m.created_at), cont = chatCont(m, prev);
  if (m.kind === 'system') return `<div class="chsys">${esc(m.body || '')} · ${esc(chatHM(m.created_at))}</div>`;
  let body;
  if (m.deleted_at) body = '<i class="mute">Message retiré</i>';
  else if (m.kind === 'text') body = chatText(m.body || '');
  else if (m.kind === 'call') body = chatCallTxt(m);
  else if (!m.path) body = `<i class="mute">${m.kind === 'audio' ? '🎤 Message audio' : (m.kind === 'image' ? '🖼 ' : '📎 ') + esc(m.file_name || 'Fichier')} · fichier effacé (plus de ${esc(String((S.P || {}).chatFileDays || 180))} jours)</i>`;
  else {
    let url = ''; try { url = await chatUrl(m.path); } catch (e) { url = ''; }
    if (m.kind === 'image' && url) body = `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="chimg" src="${esc(url)}" alt="${esc(m.file_name || 'image')}" loading="lazy"></a>${m.body ? '<div>' + chatText(m.body) + '</div>' : ''}`;
    else if (m.kind === 'audio' && url) body = `<audio controls preload="metadata" src="${esc(url)}"></audio><span class="small mute"> 🎤 ${m.duration_s != null ? chatDur(m.duration_s) : ''}</span>`;
    else body = `<a href="${esc(url || '#')}" target="_blank" rel="noopener" class="chfile">📎 ${esc(m.file_name || 'Fichier')}</a> <span class="small mute">${chatSize(m.file_size)}</span>${url ? '' : ' <span class="small warn">(fichier illisible)</span>'}`;
  }
  const t = CH.threads.find(x => x.id === m.thread_id), who = !mine && !cont && t && t.kind === 'group' ? `<span class="chwho" style="--h:${chHue(chatName(m.user_id))}">${esc(chatName(m.user_id))}</span>` : '';
  const del = mine && !m.deleted_at && m.kind !== 'call' ? `<button type="button" class="chdel" data-chdel="${m.id}" title="Retirer le message">×</button>` : '';
  return `<div class="chm${mine ? ' me' : ''}${m.kind === 'call' ? ' call' : ''}${cont ? ' cont' : ''}" data-chm="${m.id}" data-day="${chatDayKey(m.created_at)}">${who}<div class="chb">${body}<span class="chtime" title="${esc(when)}">${esc(chatHM(m.created_at))}${del}</span></div></div>`;
}
async function chatPaintMsgs() {
  const box = $('#chmsgs'); if (!box) return;
  const html = []; let prev = null;
  for (const m of CH.msgs) { if (!prev || chatDayKey(prev.created_at) !== chatDayKey(m.created_at)) html.push(`<div class="chday"><span>${esc(chatDayLbl(m.created_at))}</span></div>`); html.push(await chatMsgHtml(m, prev)); prev = m; }
  box.innerHTML = html.join('') || '<div class="chsys chnone">Aucun message. Écrivez le premier.</div>';
  box.querySelectorAll('[data-chdel]').forEach(b => { b.onclick = async () => { if (!(await ask('Retirer ce message ?'))) return; await sb.rpc('chat_delete', { p_id: +b.dataset.chdel }); const m = CH.msgs.find(x => x.id === +b.dataset.chdel); if (m) { m.deleted_at = new Date().toISOString(); m.body = null; } chatPaintMsgs(); }; });
  box.scrollTop = box.scrollHeight;
}
async function chatAppend(m) {
  const box = $('#chmsgs'); if (!box || CH.cur !== m.thread_id) return;
  if (box.querySelector('[data-chm="' + m.id + '"]')) return;
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const i = CH.msgs.findIndex(x => x.id === m.id), prev = i > 0 ? CH.msgs[i - 1] : i < 0 ? CH.msgs[CH.msgs.length - 1] : null;
  const none = box.querySelector('.chnone'); if (none) none.remove();
  const last = [...box.querySelectorAll('[data-day]')].pop();
  if (!last || last.dataset.day !== chatDayKey(m.created_at)) box.insertAdjacentHTML('beforeend', `<div class="chday"><span>${esc(chatDayLbl(m.created_at))}</span></div>`);
  box.insertAdjacentHTML('beforeend', await chatMsgHtml(m, prev && prev.id !== m.id ? prev : null));
  box.querySelectorAll('[data-chdel]').forEach(b => { if (!b.onclick) b.onclick = async () => { if (!(await ask('Retirer ce message ?'))) return; await sb.rpc('chat_delete', { p_id: +b.dataset.chdel }); chatPaintMsgs(); }; });
  if (atEnd || m.user_id === chatMe()) box.scrollTop = box.scrollHeight;
}
async function chatSend(id, kind, body, file) {
  const r = await sb.rpc('chat_send', Object.assign({ p_thread: id, p_kind: kind, p_body: body || null }, file || {})); if (r.error) throw r.error;
  const m = r.data; if (m && m.id) { CH.seen.add(m.id); if (m.id > CH.lastId) CH.lastId = m.id; CH.msgs.push(m); await chatAppend(m); }
  const t = CH.threads.find(x => x.id === id); if (t) { t.last_at = m.created_at; t.last_text = kind === 'text' ? body : kind === 'audio' ? '🎤 Message audio' : (kind === 'image' ? '🖼 ' : '📎 ') + (file && file.p_name || ''); CH.threads.sort((a, b) => (b.last_at || '').localeCompare(a.last_at || '')); chatPaintList(); }
  return m;
}
function chatExt(f) { const m = String(f.name || '').match(/\.([A-Za-z0-9]{1,8})$/); if (m) return m[1].toLowerCase(); const t = String(f.type || ''); return t.includes('pdf') ? 'pdf' : t.includes('png') ? 'png' : t.includes('jpeg') ? 'jpg' : t.includes('webm') ? 'webm' : t.includes('ogg') ? 'ogg' : t.includes('mp4') ? 'm4a' : 'bin'; }
/** Fichier ou image envoyé dans la conversation (photos réduites à 2000 px, 15 Mo au plus) */
async function chatUpload(id, file, kind, dur) {
  if (!file) return;
  if (typeof cshImgSmall === 'function' && /^image\//.test(file.type || '')) file = await cshImgSmall(file);
  if (file.size > CH_MAX_MB * 1048576) throw new Error('fichier de plus de ' + CH_MAX_MB + ' Mo');
  if (!file.size) throw new Error('fichier vide');
  kind = kind || (/^image\/(jpeg|png|webp|gif)$/.test(file.type || '') ? 'image' : 'file');
  const path = id + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + chatExt(file);
  const up = await sb.storage.from('chat').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false }); if (up.error) throw up.error;
  return chatSend(id, kind, null, { p_path: path, p_name: kind === 'audio' ? 'Message audio' : (file.name || 'fichier'), p_size: file.size, p_mime: file.type || null, p_duration: dur == null ? null : Math.round(dur) });
}

// ---------- Message audio (MediaRecorder) ----------
function chatRecMime() { const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']; return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ''; }
/**
 * Micro / caméra refusés (23/11/2026, signalé par Ahmed) : message clair selon l'appareil au lieu de l'erreur brute du navigateur.
 * Application Mac avant 2.2 : macOS bloquait le micro (runtime renforcé sans autorisations) ; 2.2 = autorisations ajoutées.
 */
function chatMediaErr(e, video) {
  const what = video ? 'Caméra / micro' : 'Micro', n = (e && e.name) || '', m = String((e && e.message) || e || '');
  const app = window.LUDY_APP, mac = /Mac/i.test(navigator.platform || navigator.userAgent), android = /LudyAndroid/i.test(navigator.userAgent);
  const ver = app && app.version ? String(app.version).split('.').map(Number) : null, old = ver && (ver[0] < 2 || (ver[0] === 2 && ver[1] < 2));
  if (n === 'NotFoundError' || /not found|no device/i.test(m)) return what + ' introuvable : branchez un micro' + (video ? ' / une caméra' : '') + '.';
  if (n === 'NotReadableError' || /in use|could not start/i.test(m)) return what + ' déjà utilisé(e) par une autre application (Zoom, Teams, FaceTime…) : fermez-la puis réessayez.';
  if (app && mac && old) return what + ' bloqué(e) par macOS dans cette version de Ludy (' + app.version + '). Installez Ludy 2.2 (page Application), puis acceptez la demande d\'accès au micro' + (video ? ' et à la caméra' : '') + '.';
  if (app && mac) return what + ' refusé(e) : Réglages Système > Confidentialité et sécurité > ' + (video ? 'Microphone et Caméra' : 'Microphone') + ' > activer Ludy, puis quittez Ludy (Cmd + Q) et rouvrez-le.';
  if (android) return what + ' refusé(e) : Réglages du téléphone > Applications > Ludy > Autorisations > autoriser ' + (video ? 'le micro et l\'appareil photo' : 'le micro') + '.';
  if (app) return what + ' refusé(e) : Paramètres Windows > Confidentialité et sécurité > ' + (video ? 'Microphone et Caméra' : 'Microphone') + ' > autoriser les applications de bureau, puis rouvrez Ludy.';
  return what + ' refusé(e) : cliquez sur le cadenas 🔒 de la barre d\'adresse > ' + (video ? 'Micro et Caméra' : 'Micro') + ' > Autoriser, puis réessayez.';
}
async function chatRecToggle(id) {
  if (CH.rec) { chatRecStop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { uiNote('Enregistrement audio non disponible dans ce navigateur.'); return; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { uiNote(chatMediaErr(e, false)); return; }
  const mime = chatRecMime(), rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), chunks = [];
  CH.rec = { rec, stream, chunks, t0: Date.now(), id, cancel: false };
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const r = CH.rec; CH.rec = null; chatRecPaint();
    if (!r || r.cancel) return;
    const dur = (Date.now() - r.t0) / 1000, type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
    if (dur < 0.7 || !chunks.length) { uiNote('Message audio trop court.'); return; }
    const blob = new Blob(chunks, { type }), file = new File([blob], 'audio.' + (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'), { type });
    try { await chatUpload(r.id, file, 'audio', dur); } catch (e) { uiNote('Envoi impossible : ' + e.message); }
  };
  rec.start(250);
  chatRecPaint();
}
function chatRecStop(cancel) { const r = CH.rec; if (!r) return; r.cancel = !!cancel; try { r.rec.stop(); } catch (e) { CH.rec = null; r.stream.getTracks().forEach(t => t.stop()); chatRecPaint(); } }
function chatRecPaint() {
  const el = $('#chrec'), b = $('#chmic'); if (!el || !b) return;
  if (!CH.rec) { el.hidden = true; b.classList.remove('rec'); b.innerHTML = chIco('mic'); b.title = 'Message audio (appuyer pour enregistrer, appuyer encore pour envoyer)'; clearInterval(CH.recT); return; }
  el.hidden = false; b.classList.add('rec'); b.innerHTML = chIco('stop'); b.title = 'Arrêter et envoyer';
  const tick = () => { if (!CH.rec) return; el.innerHTML = `● ${chatDur((Date.now() - CH.rec.t0) / 1000)} <button type="button" class="ghost small" id="chreccan">annuler</button>`; const c = $('#chreccan'); if (c) c.onclick = () => chatRecStop(true); };
  tick(); clearInterval(CH.recT); CH.recT = setInterval(tick, 500);
}

// ---------- Veille sur toutes les pages : temps réel, repli par relecture, pastille, bandeaux, appels entrants ----------
function chatWatch() {
  if (!S.session || MOBILE && !canSee('chat')) return;
  if (!CH.me || CH.me !== chatMe()) { CH.me = chatMe(); CH.threads = []; CH.users = []; CH.umap = {}; CH.seen = new Set(); CH.lastId = 0; CH.badge = null; CH.ready = false; CH.cur = null; }
  if (!S.chatCh) {
    try {
      S.chatCh = sb.channel('tchat')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, p => chatOnMsg(p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_calls' }, p => chatOnCall(p.new))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_signals' }, p => chatOnSignal(p.new))
        .subscribe(st => { CH.rt = st === 'SUBSCRIBED'; });
    } catch (e) { S.chatCh = null; }
  }
  if (!CH.poll) { CH.poll = setInterval(chatTick, 15000); chatTick(); }
}
/** Relecture rapprochée (page Tchat ouverte, appel en cours) */
function chatFast(on) { clearInterval(CH.fast); CH.fast = on ? setInterval(() => { if (pageOf() !== 'chat' && !CH.call) { clearInterval(CH.fast); CH.fast = 0; return; } chatTick(); }, CH.call ? 1500 : 4000) : 0; }
async function chatTick() {
  if (!S.session) return;
  try {
    if (!CH.ready) await chatRefresh();
    const r = await sb.rpc('chat_badge'); if (r.error || !r.data) return;
    const b = r.data;
    if (!CH.first) { CH.first = true; if (CH.lastId === 0) CH.lastId = +b.last_id || 0; }   // premier passage : l'historique n'est pas rejoué en bandeaux
    CH.badge = +b.unread || 0; chatBadgePaint(); chatTitlePaint();
    // nouveaux messages (temps réel absent ou raté) : relus depuis le dernier identifiant connu
    if (b.last_id && +b.last_id > CH.lastId) {
      const q = await sb.from('chat_messages').select('*').gt('id', CH.lastId).order('id').limit(100);
      (q.data || []).forEach(chatOnMsg);
      if (q.data && q.data.length === 100) CH.lastId = Math.max(CH.lastId, +b.last_id);
    }
    (b.ringing || []).forEach(c => chatOnCall(Object.assign({ status: 'ringing', callee: chatMe() }, c)));
    if (CH.call && !CH.rt) { await chatPullSignals(); const c = CH.call; if (c) { const q = await sb.from('chat_calls').select('*').eq('id', c.id).maybeSingle(); if (q.data && CH.call === c) chatOnCall(q.data); } }
  } catch (e) { }
}
function chatTitlePaint() {
  const n = CH.badge == null ? chatBadgeN() : CH.badge;
  if (!CH.title0 && n) CH.title0 = document.title.replace(/^\(\d+\) /, '');
  if (CH.title0 && !(typeof SV !== 'undefined' && SV.blink)) document.title = (n ? '(' + n + ') ' : '') + CH.title0;
}
async function chatOnMsg(m) {
  if (!m || !m.id || CH.seen.has(m.id)) return;
  CH.seen.add(m.id); if (m.id > CH.lastId) CH.lastId = m.id;
  if (!CH.threads.some(t => t.id === m.thread_id) || (m.kind === 'system')) { try { await chatRefresh(); if (pageOf() === 'chat') chatPaintList(); } catch (e) { } }
  const t = CH.threads.find(x => x.id === m.thread_id), mine = m.user_id === chatMe();
  if (t) { t.last_at = m.created_at; t.last_text = m.kind === 'text' ? (m.body || '').slice(0, 120) : m.kind === 'audio' ? '🎤 Message audio' : m.kind === 'call' ? chatCallTxt(m).replace(/<[^>]+>/g, '') : (m.kind === 'image' ? '🖼 ' : '📎 ') + (m.file_name || ''); }
  const open = pageOf() === 'chat' && CH.cur === m.thread_id;
  if (open) { CH.msgs.push(m); await chatAppend(m); if (!mine && !document.hidden) chatMarkRead(m.thread_id); }
  if (!mine && m.kind !== 'call' && m.kind !== 'system' && (!open || document.hidden)) {
    if (t && !open) t.unread = (+t.unread || 0) + 1; CH.badge = null; chatBadgePaint(); chatTitlePaint();
    chatToast(t, m);
  }
  if (t) { CH.threads.sort((a, b) => (b.last_at || '').localeCompare(a.last_at || '')); if (pageOf() === 'chat') chatPaintList(); }
}
/** Bandeau en bas à droite + bip + notification du système si Ludy est caché */
function chatToast(t, m) {
  const who = chatName(m.user_id), what = m.kind === 'text' ? String(m.body || '').slice(0, 160) : m.kind === 'audio' ? '🎤 Message audio' : (m.kind === 'image' ? '🖼 ' : '📎 ') + (m.file_name || 'Fichier');
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div'); el.className = 'toast chtoast ok';
  el.innerHTML = `<button class="x" aria-label="Fermer">×</button><b>💬 ${esc(who)}${t && t.kind === 'group' ? ' · ' + esc(t.name || 'Groupe') : ''}</b><div>${esc(what)}</div><a href="#/chat?t=${m.thread_id}" class="small">Répondre</a>`;
  el.querySelector('.x').onclick = e => { e.stopPropagation(); el.remove(); };
  el.onclick = () => { location.hash = '#/chat?t=' + m.thread_id; el.remove(); };
  box.prepend(el); while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => el.remove(), 20000);
  chatBeep('msg');
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') { const n = new Notification('Ludy · ' + who, { body: what, tag: 'chat' + m.thread_id, icon: 'icon-192.png' }); n.onclick = () => { try { window.focus(); } catch (e) { } location.hash = '#/chat?t=' + m.thread_id; n.close(); }; } } catch (e) { }
  if (typeof LUDY_APP !== 'undefined' && LUDY_APP && LUDY_APP.notify) { try { LUDY_APP.notify('Ludy · ' + who, what); } catch (e) { } }
}
/** Sons : bip message, sonnerie (appel entrant), retour d'appel (appel sortant) ; synthétisés (aucun fichier) */
function chatBeep(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    if (!CH.audio) CH.audio = new AC(); const ac = CH.audio; if (ac.state === 'suspended') ac.resume().catch(() => { });
    const tone = (f, t0, d, g) => { const o = ac.createOscillator(), v = ac.createGain(); o.type = 'sine'; o.frequency.value = f; v.gain.value = 0; o.connect(v); v.connect(ac.destination);
      v.gain.setValueAtTime(0, t0); v.gain.linearRampToValueAtTime(g || .18, t0 + .02); v.gain.setValueAtTime(g || .18, t0 + d - .04); v.gain.linearRampToValueAtTime(0, t0 + d); o.start(t0); o.stop(t0 + d); };
    const n = ac.currentTime + .02;
    if (kind === 'msg') { tone(880, n, .12); tone(1175, n + .14, .16); }
    else if (kind === 'ring') { tone(660, n, .3, .25); tone(880, n + .35, .3, .25); tone(660, n + .7, .3, .25); tone(880, n + 1.05, .3, .25); }
    else if (kind === 'back') { tone(440, n, .9, .12); }
    else if (kind === 'end') { tone(520, n, .18, .15); tone(390, n + .2, .25, .15); }
  } catch (e) { }
}

// ---------- Appels audio / vidéo (WebRTC ; signalisation par la base) ----------
function chatCallBusy() { return !!(CH.call || CH.ring); }
async function chatCall(id, kind) {
  if (chatCallBusy()) { uiNote('Un appel est déjà en cours.'); return; }
  const t = CH.threads.find(x => x.id === id), o = chatOther(t); if (!o) return;
  if (!window.RTCPeerConnection || !navigator.mediaDevices) { uiNote('Appels non disponibles dans ce navigateur.'); return; }
  if (!chatOnline(o.user_id) && !(await ask(o.name + ' n\'est pas en ligne sur Ludy : appeler quand même ?'))) return;
  let local; try { local = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false }); }
  catch (e) { uiNote(chatMediaErr(e, kind === 'video')); return; }
  const r = await sb.rpc('chat_call_start', { p_thread: id, p_kind: kind });
  if (r.error) { local.getTracks().forEach(x => x.stop()); uiNote(r.error.message); return; }
  const c = r.data;
  CH.call = { id: c.id, thread: id, kind, role: 'caller', other: o.user_id, name: o.name, local, pc: null, status: 'ringing', sigAfter: 0, t0: 0, pend: [], mic: true, cam: true };
  chatCallPaint();
  chatFast(true);
  CH.ringback = setInterval(() => { if (CH.call && CH.call.status === 'ringing') chatBeep('back'); }, 3000); chatBeep('back');
  CH.ringTo = setTimeout(() => { if (CH.call && CH.call.id === c.id && CH.call.status === 'ringing') chatHangup('missed'); }, 45000);
  try { await chatPcStart(true); } catch (e) { chatHangup('failed', 'Échec : ' + e.message); }
}
/** Connexion WebRTC : flux local, candidats ICE, flux distant ; appelant = offre */
async function chatPcStart(offer) {
  const c = CH.call, pc = new RTCPeerConnection({ iceServers: chatIce() }); c.pc = pc;
  c.local.getTracks().forEach(tr => pc.addTrack(tr, c.local));
  pc.onicecandidate = e => { if (e.candidate) chatSig('ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
  pc.ontrack = e => { const v = $('#chcrem'); if (v && e.streams && e.streams[0] && v.srcObject !== e.streams[0]) { v.srcObject = e.streams[0]; v.play && v.play().catch(() => { }); } };
  pc.onconnectionstatechange = () => { if (!CH.call || CH.call.pc !== pc) return; const s = pc.connectionState;
    if (s === 'connected') { clearInterval(CH.ringback); clearTimeout(CH.ringTo); CH.call.status = 'connected'; if (!CH.call.t0) CH.call.t0 = Date.now(); chatCallPaint(); }
    else if (s === 'failed') chatHangup('failed', 'Connexion impossible (réseau). Un serveur TURN peut être nécessaire : Réglages > paramètre chatIce.');
    else if (s === 'disconnected') { CH.call.status = 'wait'; chatCallPaint(); } };
  const lv = $('#chcloc'); if (lv) { lv.srcObject = c.local; lv.muted = true; lv.play && lv.play().catch(() => { }); }
  if (offer) { const d = await pc.createOffer(); await pc.setLocalDescription(d); await chatSig('offer', { type: d.type, sdp: d.sdp }); }
}
async function chatSig(kind, data) { if (!CH.call) return; try { const r = await sb.rpc('chat_signal', { p_call: CH.call.id, p_kind: kind, p_data: data || null }); if (r.error) throw r.error; } catch (e) { if (kind !== 'ice' && kind !== 'hangup') throw e; } }
/** Signaux reçus sans temps réel : relus par identifiant */
async function chatPullSignals() {
  const c = CH.call; if (!c) return;
  const r = await sb.rpc('chat_signals_after', { p_call: c.id, p_after: c.sigAfter }); if (r.error || !CH.call || CH.call !== c) return;
  for (const s of r.data || []) await chatOnSignal(s);
}
async function chatOnSignal(s) {
  const c = CH.call; if (!s || !c || s.call_id !== c.id || s.to_uid !== chatMe()) return;
  if (s.id <= c.sigAfter) return; c.sigAfter = Math.max(c.sigAfter, s.id);
  try {
    if (s.kind === 'hangup') { chatCallEnd('ended', 'Appel terminé'); return; }
    if (!c.pc) { c.pend.push(s); return; }   // signaux reçus avant l'acceptation (offre, candidats) : rejoués à l'acceptation
    if (s.kind === 'offer') { await c.pc.setRemoteDescription(s.data); const a = await c.pc.createAnswer(); await c.pc.setLocalDescription(a); await chatSig('answer', { type: a.type, sdp: a.sdp }); await chatFlushIce(); }
    else if (s.kind === 'answer') { clearInterval(CH.ringback); clearTimeout(CH.ringTo); if (c.status === 'ringing') { c.status = 'connecting'; chatCallPaint(); }
      if (c.pc.signalingState === 'have-local-offer') await c.pc.setRemoteDescription(s.data); await chatFlushIce(); }
    else if (s.kind === 'ice') { if (c.pc.remoteDescription) await c.pc.addIceCandidate(s.data).catch(() => { }); else c.ice = (c.ice || []).concat([s.data]); }
  } catch (e) { chatHangup('failed', 'Échec : ' + e.message); }
}
async function chatFlushIce() { const c = CH.call; if (!c || !c.pc || !c.ice) return; const l = c.ice; c.ice = null; for (const i of l) await c.pc.addIceCandidate(i).catch(() => { }); }
/** Appel entrant / changement d'état d'un appel (temps réel ou relecture) */
async function chatOnCall(c) {
  if (!c || !c.id) return;
  const me = chatMe();
  if (CH.call && CH.call.id === c.id) {
    if (c.status === 'accepted' && CH.call.role === 'caller' && CH.call.status === 'ringing') { CH.call.status = 'connecting'; clearInterval(CH.ringback); clearTimeout(CH.ringTo); chatCallPaint(); }
    else if (['ended', 'declined', 'missed', 'busy', 'failed'].includes(c.status)) chatCallEnd(c.status, { ended: 'Appel terminé', declined: 'Appel refusé', missed: 'Sans réponse', busy: 'Occupé', failed: 'Appel échoué' }[c.status]);
    return;
  }
  if (CH.ring && CH.ring.id === c.id) { if (c.status && c.status !== 'ringing') chatRingStop(c.status === 'missed' ? 'Appel manqué' : null); return; }
  if (c.status !== 'ringing' || c.callee !== me) return;
  if (Date.now() - Date.parse(c.started_at) > 60000) return;   // vieil appel jamais clos
  if (CH.sent['r' + c.id]) return; CH.sent['r' + c.id] = 1;
  if (chatCallBusy()) { sb.rpc('chat_call_set', { p_id: c.id, p_status: 'declined' }).then(null, () => { }); return; }
  if (!CH.umap[c.caller]) { try { await chatRefresh(); } catch (e) { } }
  CH.ring = { id: c.id, thread: c.thread_id, kind: c.kind, caller: c.caller, name: c.caller_name || chatName(c.caller) };
  chatRingPaint();
  chatBeep('ring'); CH.ringI = setInterval(() => chatBeep('ring'), 2500);
  CH.ringTo2 = setTimeout(() => chatRingStop('Appel manqué'), 50000);
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') { const n = new Notification('Ludy · Appel ' + (c.kind === 'video' ? 'vidéo' : 'audio'), { body: CH.ring.name + ' vous appelle', tag: 'call' + c.id, requireInteraction: true, icon: 'icon-192.png' }); n.onclick = () => { try { window.focus(); } catch (e) { } n.close(); }; } } catch (e) { }
  if (typeof svTitle === 'function') svTitle(true, 'Appel de ' + CH.ring.name);
  if (typeof LUDY_APP !== 'undefined' && LUDY_APP && LUDY_APP.notify) { try { LUDY_APP.notify('Ludy · Appel', CH.ring.name + ' vous appelle'); } catch (e) { } }
}
function chatRingPaint() {
  document.querySelectorAll('#chring').forEach(x => x.remove()); const r = CH.ring; if (!r) return;
  const o = document.createElement('div'); o.id = 'chring'; o.className = 'chring'; o.setAttribute('role', 'alertdialog');
  o.innerHTML = `<div class="chringbox">${chatAvatar(r.name, true, true)}<b>${esc(r.name)}</b><p>${r.kind === 'video' ? '🎥 Appel vidéo' : '📞 Appel audio'} entrant…</p>
    <div class="row"><button type="button" class="chacc" id="chracc">Répondre</button><button type="button" class="chdec" id="chrdec">Refuser</button></div></div>`;
  document.body.appendChild(o);
  $('#chracc').onclick = chatAccept; $('#chrdec').onclick = () => { sb.rpc('chat_call_set', { p_id: r.id, p_status: 'declined' }).then(null, () => { }); chatRingStop(); };
}
function chatRingStop(note) {
  clearInterval(CH.ringI); clearTimeout(CH.ringTo2); CH.ring = null; document.querySelectorAll('#chring').forEach(x => x.remove());
  if (typeof svTitle === 'function' && !(typeof SV !== 'undefined' && SV.cur)) svTitle(false);
  if (note) uiNote(note);
}
async function chatAccept() {
  const r = CH.ring; if (!r) return;
  clearInterval(CH.ringI); clearTimeout(CH.ringTo2);
  let local; try { local = await navigator.mediaDevices.getUserMedia({ audio: true, video: r.kind === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false }); }
  catch (e) { uiNote(chatMediaErr(e, r.kind === 'video')); sb.rpc('chat_call_set', { p_id: r.id, p_status: 'declined' }).then(null, () => { }); chatRingStop(); return; }
  const a = await sb.rpc('chat_call_set', { p_id: r.id, p_status: 'accepted' }); if (a.error) { local.getTracks().forEach(x => x.stop()); chatRingStop('Appel déjà terminé'); return; }
  CH.ring = null; document.querySelectorAll('#chring').forEach(x => x.remove()); if (typeof svTitle === 'function') svTitle(false);
  CH.call = { id: r.id, thread: r.thread, kind: r.kind, role: 'callee', other: r.caller, name: r.name, local, pc: null, status: 'connecting', sigAfter: 0, t0: 0, pend: [], mic: true, cam: true };
  chatCallPaint(); chatFast(true);
  try {
    await chatPcStart(false);
    // offre et candidats déjà envoyés par l'appelant : relus depuis le début (temps réel ou non)
    const s = await sb.rpc('chat_signals_after', { p_call: r.id, p_after: 0 });
    const pend = (s.data || []); CH.call.sigAfter = 0; CH.call.pend = [];
    for (const x of pend) await chatOnSignal(x);
  } catch (e) { chatHangup('failed', 'Échec : ' + e.message); }
}
function chatHangup(status, note) {
  const c = CH.call; if (!c) return;
  if (status !== 'failed') chatSig('hangup', null).catch(() => { });
  sb.rpc('chat_call_set', { p_id: c.id, p_status: status === 'missed' ? 'ended' : status || 'ended' }).then(null, () => { });
  chatCallEnd(status || 'ended', note || (status === 'missed' ? 'Sans réponse' : 'Appel terminé'));
}
function chatCallEnd(status, note) {
  const c = CH.call; if (!c) return;
  clearInterval(CH.ringback); clearTimeout(CH.ringTo); clearInterval(CH.callT);
  try { if (c.pc) c.pc.close(); } catch (e) { } try { c.local.getTracks().forEach(x => x.stop()); } catch (e) { }
  CH.call = null; document.querySelectorAll('#chcall').forEach(x => x.remove());
  chatBeep('end'); chatFast(pageOf() === 'chat');
  // ligne « Appel » de la conversation relue (durée, état) une fois l'état enregistré
  const reload = () => { if (pageOf() === 'chat' && CH.cur === c.thread) sb.from('chat_messages').select('*').eq('thread_id', c.thread).order('id', { ascending: false }).limit(300).then(r => { if (!r.error && CH.cur === c.thread) { CH.msgs = (r.data || []).reverse(); chatPaintMsgs(); } }); };
  setTimeout(reload, 1500); setTimeout(reload, 6000);
  if (note) { let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); } const el = document.createElement('div'); el.className = 'toast chtoast'; el.innerHTML = `<b>${esc(note)}</b><div>${esc(c.name)}${c.t0 ? ' · ' + chatDur((Date.now() - c.t0) / 1000) : ''}</div>`; box.prepend(el); setTimeout(() => el.remove(), 8000); }
}
/** Fenêtre d'appel : vidéo distante (ou avatar), vidéo locale en vignette, état, durée, micro / caméra / raccrocher */
function chatCallPaint() {
  const c = CH.call; let o = $('#chcall');
  if (!c) { if (o) o.remove(); return; }
  if (!o) {
    o = document.createElement('div'); o.id = 'chcall'; o.className = 'chcall' + (c.kind === 'video' ? ' video' : ''); o.setAttribute('role', 'dialog');
    o.innerHTML = `<div class="chcbox"><video id="chcrem" autoplay playsinline class="chcrem"></video><div class="chcav">${chatAvatar(c.name, true, true)}</div>
      <video id="chcloc" autoplay playsinline muted class="chcloc"></video>
      <div class="chcinfo"><b>${esc(c.name)}</b><span id="chcst"></span></div>
      <div class="chcbtns"><button type="button" id="chcmic" title="Couper / remettre le micro">🎤</button>${c.kind === 'video' ? '<button type="button" id="chccam" title="Couper / remettre la caméra">📷</button>' : ''}<button type="button" class="chdec" id="chchang" title="Raccrocher">📵</button></div></div>`;
    document.body.appendChild(o);
    $('#chchang').onclick = () => chatHangup('ended');
    $('#chcmic').onclick = () => { c.mic = !c.mic; c.local.getAudioTracks().forEach(t => { t.enabled = c.mic; }); $('#chcmic').classList.toggle('off', !c.mic); };
    const cam = $('#chccam'); if (cam) cam.onclick = () => { c.cam = !c.cam; c.local.getVideoTracks().forEach(t => { t.enabled = c.cam; }); cam.classList.toggle('off', !c.cam); };
    const lv = $('#chcloc'); if (c.local) { lv.srcObject = c.local; lv.play && lv.play().catch(() => { }); }
    clearInterval(CH.callT); CH.callT = setInterval(chatCallPaint, 1000);
  }
  const st = $('#chcst'); if (st) st.textContent = c.status === 'ringing' ? 'Appel en cours… (sonnerie)' : c.status === 'connecting' ? 'Connexion…' : c.status === 'wait' ? 'Connexion interrompue, nouvel essai…' : c.t0 ? chatDur((Date.now() - c.t0) / 1000) : 'Connecté';
  o.classList.toggle('live', c.status === 'connected');
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => { if (CH.call) { try { sb.rpc('chat_call_set', { p_id: CH.call.id, p_status: 'ended' }).then(null, () => { }); } catch (e) { } } if (CH.rec) chatRecStop(true); });
if (typeof module !== 'undefined') module.exports = { chatWhen, chatSize, chatDur, chatText, chatExt };
