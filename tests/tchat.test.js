// Tchat de Ludy (22/11/2026, demande d'Ahmed) : conversations, messages, fichiers, messages audio, appels audio / vidéo WebRTC, notifications.
// Base : chat_* (droits par conversation, signalisation des appels) ; site : deux navigateurs (administrateur sur :8080, gestionnaire sur :8081),
// sans temps réel (serveur de test : /realtime 404) = repli par relecture ; faux micro / caméra de Chromium pour l'audio et l'appel.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222', OTHER = '33333333-3333-3333-3333-333333333333';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const asErr = (uid, sql) => { try { as(uid, sql); return ''; } catch (e) { return String(e.stderr || e.message || e); } };
const LAUNCH = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] };
function setup() {
  env.resetDb(); env.psql('truncate chat_threads, chat_calls restart identity cascade');
  env.psql(`insert into auth.users (id, email) values ('${OTHER}', 'o@x') on conflict do nothing;
    insert into profiles (user_id, email, name, role) values ('${ADMIN}', 'admin@x', 'Ahmed', 'admin'), ('${MGR}', 'new@x', 'Karim', 'manager'), ('${OTHER}', 'o@x', 'Omar', 'viewer')
    on conflict (user_id) do update set role = excluded.role, name = excluded.name, email = excluded.email;`);
}

test('calculs : horodatage court, tailles, durées, liens, extensions', () => {
  global.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const C = require('../site/chat.js');
  assert.strictEqual(C.chatDur(125), '2:05'); assert.strictEqual(C.chatDur(null), '0:00');
  assert.deepStrictEqual([C.chatSize(2048), C.chatSize(3 * 1048576), C.chatSize(10)], ['2 Ko', '3,0 Mo', '1 Ko']);
  assert.strictEqual(C.chatText('voir https://x.y/z\nok <b>'), 'voir <a href="https://x.y/z" target="_blank" rel="noopener">https://x.y/z</a><br>ok &lt;b&gt;');
  assert.deepStrictEqual([C.chatExt({ name: 'a.PDF' }), C.chatExt({ name: 'x', type: 'audio/webm' }), C.chatExt({ name: 'x', type: 'audio/mp4' })], ['pdf', 'webm', 'm4a']);
});

test('base : annuaire et présence, conversation à deux, non lus, groupe, droits par conversation, appel et signalisation', () => {
  setup();
  try {
    env.psql(`insert into user_sessions (id, user_id, page, client) values ('abcdefgh', '${MGR}', 'direct', 'Navigateur')`);
    assert.strictEqual(as(ADMIN, 'select string_agg(name || \':\' || role || \':\' || online, \' \' order by online desc, name) from chat_users()'), 'Karim:manager:true Ahmed:admin:false Omar:viewer:false', 'en ligne = signal de moins de 3 min');
    assert.match(asErr(ADMIN, `select chat_open('${ADMIN}')`), /autre compte/);
    const t = as(ADMIN, `select chat_open('${MGR}')`);
    assert.strictEqual(as(MGR, `select chat_open('${ADMIN}')`), t, 'même conversation dans les deux sens');
    assert.strictEqual(as(ADMIN, `select (chat_send(${t}, 'text', 'Salut Karim') ->> 'kind')`), 'text');
    assert.strictEqual(as(ADMIN, 'select body from chat_messages'), 'Salut Karim');
    assert.match(asErr(ADMIN, `select chat_send(${t}, 'text', '  ')`), /vide/);
    assert.match(asErr(ADMIN, `select chat_send(${t}, 'file', null, '99/x.pdf', 'x.pdf', 1, 'application/pdf', null)`), /hors de la conversation/, 'fichier rangé dans le dossier de la conversation');
    assert.strictEqual(as(MGR, 'select unread || \'|\' || last_text || \'|\' || (members -> 1 ->> \'name\') from chat_list()'), '1|Salut Karim|Karim');
    assert.strictEqual(as(MGR, "select (chat_badge() ->> 'unread') || '|' || (chat_badge() ->> 'last_id')"), '1|1');
    as(MGR, `select chat_read(${t})`);
    assert.strictEqual(as(MGR, "select chat_badge() ->> 'unread'"), '0');
    // un tiers ne voit rien ; les règles RLS filtrent les tables lues directement
    assert.strictEqual(as(OTHER, 'select count(*) from chat_messages'), '0'); assert.strictEqual(as(OTHER, 'select count(*) from chat_threads'), '0');
    assert.strictEqual(as(OTHER, 'select count(*) from chat_list()'), '0');
    assert.match(asErr(OTHER, `select chat_send(${t}, 'text', 'coucou')`), /refusé/);
    assert.strictEqual(as(MGR, 'select count(*) from chat_messages'), '1');
    assert.strictEqual(as(ADMIN, `select chat_folder_ok('${t}') || ',' || chat_folder_ok('99') || ',' || chat_folder_ok('x')`), 'true,false,false', 'stockage : dossier de la conversation');
    assert.strictEqual(as(OTHER, `select chat_folder_ok('${t}')`), 'f');
    // message retiré par son auteur seulement
    as(MGR, 'select chat_delete(1)'); assert.strictEqual(as(ADMIN, 'select deleted_at is null from chat_messages where id = 1'), 't');
    as(ADMIN, 'select chat_delete(1)'); assert.strictEqual(as(ADMIN, 'select deleted_at is not null and body is null from chat_messages where id = 1'), 't');
    // groupe : créateur + membres, message système, ajout, départ ; pas d'appel dans un groupe
    const g = as(ADMIN, `select chat_group('Équipe', array['${MGR}', '${ADMIN}']::uuid[])`);
    assert.strictEqual(as(ADMIN, `select count(*) from chat_members where thread_id = ${g}`), '2');
    as(MGR, `select chat_group_add(${g}, '${OTHER}')`);
    assert.strictEqual(as(OTHER, `select name || '|' || last_text from chat_list() where id = ${g}`), 'Équipe|Omar ajouté(e)');
    assert.match(asErr(ADMIN, `select chat_call_start(${g}, 'audio')`), /conversation à deux/);
    as(OTHER, `select chat_group_leave(${g})`); assert.strictEqual(as(OTHER, 'select count(*) from chat_list()'), '0');
    assert.match(asErr(OTHER, `select chat_group_add(${g}, '${OTHER}')`), /refusé/);
    // appel : sonnerie vue par l'appelé, signaux relayés à l'autre seulement, acceptation, fin = durée et ménage des signaux
    const c = as(ADMIN, `select chat_call_start(${t}, 'video') ->> 'id'`);
    assert.strictEqual(as(MGR, "select (chat_badge() -> 'ringing' -> 0 ->> 'caller_name') || '|' || (chat_badge() -> 'ringing' -> 0 ->> 'kind')"), 'Ahmed|video');
    assert.strictEqual(as(ADMIN, "select jsonb_array_length(chat_badge() -> 'ringing')"), '0');
    assert.match(asErr(ADMIN, `select chat_call_start(${t}, 'audio')`), /déjà en communication/, 'correspondant déjà appelé');
    as(ADMIN, `select chat_signal('${c}', 'offer', '{"type":"offer","sdp":"v=0"}')`); as(ADMIN, `select chat_signal('${c}', 'ice', '{"candidate":"x"}')`);
    assert.strictEqual(as(MGR, `select string_agg(kind, ',' order by id) from chat_signals_after('${c}', 0)`), 'offer,ice');
    assert.strictEqual(as(ADMIN, `select count(*) from chat_signals_after('${c}', 0)`), '0', 'l\'appelant ne relit pas ses propres signaux');
    assert.strictEqual(as(OTHER, 'select count(*) from chat_signals'), '0');
    assert.match(asErr(OTHER, `select chat_call_set('${c}', 'accepted')`), /inconnu/);
    as(ADMIN, `select chat_call_set('${c}', 'accepted')`); assert.strictEqual(as(ADMIN, `select status from chat_calls where id = '${c}'`), 'ringing', 'seul l\'appelé accepte');
    as(MGR, `select chat_call_set('${c}', 'accepted')`); assert.strictEqual(as(ADMIN, `select status from chat_calls where id = '${c}'`), 'accepted');
    as(MGR, `select chat_signal('${c}', 'answer', '{"type":"answer","sdp":"v=0"}')`);
    assert.strictEqual(as(ADMIN, `select string_agg(kind, ',') from chat_signals_after('${c}', 0)`), 'answer');
    as(MGR, `select chat_call_set('${c}', 'ended')`);
    assert.strictEqual(as(ADMIN, `select status || '|' || (duration_s is not null) from chat_calls c join chat_messages m on m.call_id = c.id where c.id = '${c}'`), 'ended|true');
    assert.strictEqual(env.psql('select count(*) from chat_signals'), '0', 'signaux effacés à la fin');
    assert.match(as(ADMIN, `select last_text from chat_threads where id = ${t}`), /🎥 Appel · 0 min/);
    // appel refusé / manqué
    const c2 = as(MGR, `select chat_call_start(${t}, 'audio') ->> 'id'`);
    as(ADMIN, `select chat_call_set('${c2}', 'declined')`); assert.strictEqual(as(MGR, `select status from chat_calls where id = '${c2}'`), 'declined');
    const c3 = as(MGR, `select chat_call_start(${t}, 'audio') ->> 'id'`);
    as(MGR, `select chat_call_set('${c3}', 'ended')`); assert.strictEqual(as(MGR, `select status from chat_calls where id = '${c3}'`), 'missed', 'raccroché par l\'appelant avant la réponse = sans réponse');
    // compte en attente : rien
    env.psql(`update profiles set role = 'pending' where user_id = '${OTHER}'`);
    assert.strictEqual(as(OTHER, 'select count(*) from chat_users()'), '0');
    assert.match(asErr(OTHER, `select chat_open('${ADMIN}')`), /refusé/);
    assert.match(asErr(ADMIN, `select chat_open('${OTHER}')`), /en attente/);
  } finally { env.resetDb(); env.psql(`truncate chat_threads, chat_calls restart identity cascade; update profiles set role = 'pending' where user_id = '${MGR}'`); }
});

test('site : deux comptes, message, bandeau et pastille, fichier PDF, message audio, appel audio (sonnerie, réponse, raccroché), groupe, téléphone', async () => {
  setup();
  env.psql(`insert into user_sessions (id, user_id, page, client) values ('mgrsess01', '${MGR}', 'direct', 'Navigateur')`);
  const srvA = await startSite('admin', 8080), srvB = await startSite('pending', 8081);
  const A = await openBrowser({}, LAUNCH), B = await openBrowser({}, LAUNCH);
  const pdf = path.join(__dirname, 'fixtures', 'tchat.pdf'); fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  try {
    // A : liste des comptes, Karim en ligne, ouverture de la conversation, message envoyé
    await login(A.page, '#/chat');
    await A.page.waitForSelector('#chonl');
    assert.match(await A.page.innerText('#chonl'), /Karim[\s\S]*en ligne/);
    assert.match(await A.page.innerText('#choff'), /Omar/);
    await A.page.click('#chonl [data-chu]');
    await A.page.waitForSelector('#chcomp');
    assert.match(await A.page.innerText('.chhead'), /Karim/);
    // B connecté sur une autre page (les messages d'avant la connexion ne sont pas rejoués en bandeau : pastille seulement)
    await login(B.page, '#/direct', 8081);
    await B.page.waitForSelector('#nbchat', { state: 'attached' }); await B.page.waitForFunction(() => CH.first);
    await A.page.fill('#chtxt', 'Salut Karim, tu peux vérifier la caisse ?'); await A.page.keyboard.press('Enter');
    await A.page.waitForSelector('.chm.me');
    assert.strictEqual(env.psql('select body from chat_messages'), 'Salut Karim, tu peux vérifier la caisse ?');
    assert.strictEqual(await A.page.inputValue('#chtxt'), '');
    // B : relecture (sans temps réel) = bandeau + pastille du menu + titre de l'onglet
    await B.page.evaluate(() => chatTick());
    await B.page.waitForSelector('.toast.chtoast');
    assert.match(await B.page.innerText('.toast.chtoast'), /Ahmed[\s\S]*vérifier la caisse/);
    assert.strictEqual(await B.page.innerText('#nbchat'), '1');
    assert.match(await B.page.title(), /^\(1\) /);
    // B répond depuis le bandeau ; A reçoit par relecture rapprochée (4 s)
    await B.page.click('.toast.chtoast a');
    await B.page.waitForSelector('#chcomp');
    assert.match(await B.page.innerText('#chmsgs'), /vérifier la caisse/);
    await B.page.waitForFunction(() => document.querySelector('#nbchat') && document.querySelector('#nbchat').hidden);
    await B.page.fill('#chtxt', 'Oui, je regarde.'); await B.page.click('.chsend');
    await A.page.waitForFunction(() => /Oui, je regarde/.test(document.querySelector('#chmsgs').innerText), null, { timeout: 15000 });
    assert.strictEqual(env.psql(`select last_read_at >= (select max(created_at) from chat_messages) from chat_members where user_id = '${MGR}'`), 't', 'conversation ouverte = lue');
    // fichier PDF (A) : déposé dans le seau chat, lien dans la conversation (B)
    await A.page.setInputFiles('#chfilein', pdf);
    await A.page.waitForSelector('.chm.me .chfile');
    const files = JSON.parse(await (await fetch('http://localhost:8080/storage/v1/object/__liste')).text());
    assert.ok(files.some(f => /^chat\/1\/\d+_[a-z0-9]+\.pdf$/.test(f)), 'fichier rangé dans chat/<conversation>/ : ' + files);
    assert.strictEqual(env.psql("select kind || '|' || file_name || '|' || mime from chat_messages where kind <> 'text'"), 'file|tchat.pdf|application/pdf');
    await B.page.waitForFunction(() => document.querySelector('#chmsgs a.chfile'), null, { timeout: 15000 });
    assert.match(await B.page.getAttribute('#chmsgs a.chfile', 'href'), /\/object\/sign\/chat\/1\//, 'lien signé');
    // message audio (B, faux micro) : enregistré puis envoyé ; A l'entend
    await B.page.click('#chmic'); await B.page.waitForSelector('#chmic.rec'); await B.page.waitForTimeout(1500); await B.page.click('#chmic');
    await B.page.waitForSelector('.chm.me audio', { timeout: 15000 });
    assert.match(env.psql("select mime || '|' || duration_s from chat_messages where kind = 'audio'"), /^audio\/(webm|ogg|mp4)\|[12]$/);
    await A.page.waitForFunction(() => document.querySelector('#chmsgs audio'), null, { timeout: 15000 });
    // appel audio : A appelle, B voit la sonnerie, répond ; connexion WebRTC entre les deux navigateurs ; A raccroche
    await A.page.click('#chcalla');
    await A.page.waitForSelector('#chcall');
    assert.match(await A.page.innerText('#chcst'), /sonnerie/);
    await B.page.waitForSelector('#chring', { timeout: 15000 });
    assert.match(await B.page.innerText('#chring'), /Ahmed[\s\S]*Appel audio entrant/);
    await B.page.click('#chracc');
    await B.page.waitForSelector('#chcall');
    await A.page.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('#chcst') ? document.querySelector('#chcst').textContent : ''), null, { timeout: 30000 });
    await B.page.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('#chcst') ? document.querySelector('#chcst').textContent : ''), null, { timeout: 30000 });
    assert.strictEqual(await A.page.evaluate(() => CH.call.pc.connectionState), 'connected');
    assert.strictEqual(await B.page.evaluate(() => CH.call.pc.getReceivers().filter(r => r.track && r.track.kind === 'audio').length), 1, 'piste audio reçue');
    await A.page.click('#chcmic'); assert.strictEqual(await A.page.evaluate(() => CH.call.local.getAudioTracks()[0].enabled), false, 'micro coupé');
    await A.page.click('#chchang');
    await A.page.waitForSelector('#chcall', { state: 'detached' });
    await B.page.waitForSelector('#chcall', { state: 'detached', timeout: 15000 });
    assert.strictEqual(env.psql("select status || '|' || (duration_s is not null) from chat_calls c join chat_messages m on m.call_id = c.id"), 'ended|true');
    await A.page.waitForFunction(() => /Appel audio · \d+:\d\d/.test(document.querySelector('#chmsgs').innerText), null, { timeout: 15000 });
    assert.strictEqual(env.psql('select count(*) from chat_signals'), '0');
    // appel vidéo : caméra factice, vidéo distante reçue des deux côtés, caméra coupée, fin par B
    await B.page.click('#chcallv'); await B.page.waitForSelector('#chcall.video');
    await A.page.waitForSelector('#chring', { timeout: 15000 }); assert.match(await A.page.innerText('#chring'), /Appel vidéo entrant/); await A.page.click('#chracc');
    await A.page.waitForSelector('#chcall.video');
    await A.page.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('#chcst') ? document.querySelector('#chcst').textContent : ''), null, { timeout: 30000 });
    await B.page.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('#chcst') ? document.querySelector('#chcst').textContent : ''), null, { timeout: 30000 });
    await A.page.waitForFunction(() => { const v = document.querySelector('#chcrem'); return v && v.srcObject && v.srcObject.getVideoTracks().length === 1; }, null, { timeout: 15000 });
    assert.strictEqual(await B.page.evaluate(() => document.querySelector('#chcrem').srcObject.getVideoTracks().length), 1, 'vidéo de l\'autre reçue');
    await B.page.click('#chccam'); assert.strictEqual(await B.page.evaluate(() => CH.call.local.getVideoTracks()[0].enabled), false, 'caméra coupée');
    await B.page.click('#chchang'); await A.page.waitForSelector('#chcall', { state: 'detached', timeout: 15000 });
    assert.strictEqual(env.psql("select kind || '|' || status from chat_calls order by started_at desc limit 1"), 'video|ended');
    // appel refusé : B appelle, A refuse
    await B.page.click('#chcalla'); await A.page.waitForSelector('#chring', { timeout: 15000 }); await A.page.click('#chrdec');
    await B.page.waitForSelector('#chcall', { state: 'detached', timeout: 15000 });
    assert.strictEqual(env.psql("select status from chat_calls order by started_at desc limit 1"), 'declined');
    // groupe créé par A avec Karim : B le voit, message système
    A.page.once('dialog', d => d.accept('Équipe caisse'));
    await A.page.click('#chgrp');
    await A.page.waitForSelector('#chgok', { timeout: 15000 });
    await A.page.check(`.chgrpform input[value="${MGR}"]`); await A.page.click('#chgok');
    await A.page.waitForFunction(() => /Équipe caisse/.test(document.querySelector('.chhead') ? document.querySelector('.chhead').innerText : ''));
    await A.page.fill('#chtxt', 'Bienvenue'); await A.page.keyboard.press('Enter'); await A.page.waitForSelector('.chm.me');
    await B.page.evaluate(() => chatTick());
    await B.page.waitForFunction(() => /Équipe caisse/.test(document.querySelector('#chthreads').innerText), null, { timeout: 15000 });
    await B.page.waitForFunction(() => /Ahmed · Équipe caisse[\s\S]*Bienvenue/.test(document.querySelector('#toasts') ? document.querySelector('#toasts').innerText : ''), null, { timeout: 15000 });   // le bandeau « Appel refusé » peut encore être là
    // mode téléphone (application Android) : écran Tchat
    await B.page.goto('http://localhost:8081/?mobile=1#/chat'); await B.page.waitForSelector('.mtabs [data-mt="tchat"].on');
    await B.page.waitForSelector('#chthreads'); assert.match(await B.page.innerText('#chthreads'), /Ahmed/);
    await B.page.click('#chthreads a'); await B.page.waitForSelector('#chcomp');
    assert.ok(await B.page.isVisible('.chback'), 'retour à la liste sur petit écran');
    await B.page.goto('http://localhost:8081/?mobile=0#/direct');
    assert.deepStrictEqual(A.errors.concat(B.errors), []);
  } finally { await A.br.close(); await B.br.close(); srvA.kill(); srvB.kill(); try { fs.unlinkSync(pdf); } catch (e) { } env.resetDb(); env.psql(`truncate chat_threads, chat_calls restart identity cascade; update profiles set role = 'pending' where user_id = '${MGR}'`); }
});
