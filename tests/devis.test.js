// Courses privées : le gestionnaire prépare le devis et l'envoie à l'administrateur, qui le réajuste au besoin et le valide ;
// ensuite seulement le devis part au client. Annulation d'une course dans l'application (fenêtres dessinées par le site :
// l'application Mac n'affiche pas confirm()). Données de test fictives.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const setup = () => {
  env.resetDb(); env.psql('truncate missions, cash_moves restart identity');
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id) values ('968194WW', 'WW968194', 'SONATA', 'OUI', 1);`);
};
const done = () => { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; truncate missions, cash_moves restart identity`); env.resetDb(); };

test('base : devis d\'un gestionnaire toujours validé par l\'administrateur ; course rapide et anciens devis inchangés', () => {
  setup();
  try {
    as(MGR, "insert into missions (agency_id, client_name, kind, total_ttc, needs_validation, level) values (1, 'Client A', 'Transfert aéroport', 320, false, 'Standard')");
    assert.strictEqual(env.psql("select needs_validation from missions where client_name = 'Client A'"), 't');
    assert.throws(() => as(MGR, "update missions set status = 'Devis envoyé' where client_name = 'Client A'"), /validation de l'exploitation requise/);
    as(MGR, "update missions set status = 'Annulée' where client_name = 'Client A'");   // annulation toujours possible
    as(ADMIN, "insert into missions (agency_id, client_name, kind, total_ttc, needs_validation, level) values (1, 'Client admin', 'Transfert aéroport', 320, false, 'Standard')");
    assert.strictEqual(env.psql("select needs_validation from missions where client_name = 'Client admin'"), 'f', 'devis de l\'administrateur : règles de la section 17 seulement');
    as(MGR, `insert into missions (agency_id, client_name, status, vehicle_key, start_at, end_at, level, needs_validation, data) values (1, 'Rapide', 'Confirmée', '968194WW', now() + interval '1 day', now() + interval '1 day 2 hours', 'Standard', false, '{"quick":true}')`);
    assert.strictEqual(env.psql("select status || '|' || needs_validation from missions where client_name = 'Rapide'"), 'Confirmée|false');
    env.psql("insert into missions (agency_id, client_name, status, needs_validation, level) values (1, 'Ancien', 'Devis envoyé', false, 'Standard')");
    as(MGR, "update missions set status = 'Accepté' where client_name = 'Ancien'");
    assert.strictEqual(env.psql("select status from missions where client_name = 'Ancien'"), 'Accepté', 'devis envoyé avant la règle : inchangé');
  } finally { done(); }
});

test('site : gestionnaire → envoi pour validation ; administrateur → pastille, réajustement, validation ; gestionnaire → envoi au client', async () => {
  setup();
  let srv = await startSite('pending'), o = await openBrowser();
  const mid = () => env.psql('select id from missions');
  try {
    // gestionnaire : devis préparé puis envoyé à l'administrateur ; pas d'envoi au client avant la validation
    await login(o.page, '#/courses?new=1');
    await o.page.waitForSelector('[data-f="client"]');
    await o.page.fill('[data-f="client"]', 'Client TEST');
    await o.page.selectOption('[data-f="kind"]', 'Transfert aéroport'); await o.page.selectOption('[data-f="cat"]', 'SONATA');
    await o.page.waitForSelector('[data-f="dest"]'); await o.page.selectOption('[data-f="dest"]', 'Rabat');
    await o.page.fill('[data-f="startDate"]', '2026-12-02'); await o.page.fill('[data-f="startTime"]', '10:00');
    assert.strictEqual(await o.page.$('[data-f="adjust"]'), null, 'ajustement réservé à l\'administrateur');
    await o.page.click('#crssave'); await o.page.waitForFunction(() => /Enregistré/.test(document.querySelector('#crsres').innerText));
    assert.match(await o.page.innerText('#crsside'), /devis préparé par un gestionnaire/);
    let said = ''; o.page.once('dialog', d => { said = d.message(); d.accept(); });
    await o.page.click('[data-crst="Devis envoyé"]'); await o.page.waitForTimeout(300);
    assert.match(said, /Envoyez d'abord le devis à l'administrateur/);
    await o.page.click('#crssub'); await o.page.waitForSelector('text=Envoyé à l\'administrateur pour validation le');
    assert.strictEqual(env.psql("select status || '|' || needs_validation || '|' || (data->'submitted'->>'by') from missions"), 'Demande|true|new@x');
    assert.deepStrictEqual(o.errors, []);
  } finally { await o.br.close(); srv.kill(); }
  srv = await startSite(); o = await openBrowser();
  try {
    // administrateur : pastille du menu, file « À valider », réajustement puis validation
    await login(o.page, '#/tableau');
    await o.page.waitForFunction(() => (document.querySelector('#nbcrs') || {}).textContent === '1');
    await o.page.goto('http://localhost:8080/#/courses?s=avalider'); await o.page.waitForSelector('#tcrs');
    assert.match(await o.page.innerText('#tcrs'), /Client TEST[\s\S]*envoyé pour validation/);
    await o.page.goto('http://localhost:8080/#/courses?id=' + mid()); await o.page.waitForSelector('#crsval');
    await o.page.fill('[data-f="adjust"]', '-50'); await o.page.fill('[data-f="adjustWhy"]', 'geste commercial');
    await o.page.waitForFunction(() => /Ajustement : geste commercial/.test(document.querySelector('#crsside').innerText));
    await o.page.click('#crsval'); await o.page.waitForSelector('text=Devis validé');   // un seul clic, juste après la saisie
    assert.strictEqual(env.psql("select total_ttc || '|' || (validated_at is not null) || '|' || (validated_by = '" + ADMIN + "') from missions"), '900|true|true');
    await o.page.goto('http://localhost:8080/#/tableau'); await o.page.waitForFunction(() => document.querySelector('#nbcrs') && document.querySelector('#nbcrs').hidden);
    assert.deepStrictEqual(o.errors, []);
  } finally { await o.br.close(); srv.kill(); }
  srv = await startSite('pending'); o = await openBrowser();
  try {
    // gestionnaire : devis validé à envoyer (pastille), envoi au client autorisé
    await login(o.page, '#/tableau');
    await o.page.waitForFunction(() => (document.querySelector('#nbcrs') || {}).textContent === '1');
    await o.page.goto('http://localhost:8080/#/courses?id=' + mid()); await o.page.waitForSelector('[data-crst="Devis envoyé"]');
    assert.match(await o.page.innerText('#crsside'), /Validé par l'administrateur le/);
    await o.page.click('[data-crst="Devis envoyé"]'); await o.page.waitForFunction(() => /Devis envoyé/.test(document.querySelector('#crsres').innerText));
    assert.strictEqual(env.psql('select status || \'|\' || total_ttc from missions'), 'Devis envoyé|900');
    assert.deepStrictEqual(o.errors, []);
  } finally { await o.br.close(); srv.kill(); done(); }
});

test('application : annulation d\'une course avec la fenêtre de confirmation dessinée par le site', async () => {
  setup();
  env.psql(`insert into missions (agency_id, status, client_name, kind, category, vehicle_key, start_at, end_at, level, needs_validation, total_ttc, data) values
    (1, 'Confirmée', 'Client X', 'Transfert simple', 'SONATA', '968194WW', now() + interval '1 day', now() + interval '1 day 2 hours', 'Standard', false, 500,
     '{"quick":true,"f":{"quick":true,"kind":"Transfert simple","base":"convenu","agreedPrice":500,"cat":"SONATA","vehicleKey":"968194WW","client":"Client X","startAddr":"A","endAddr":"B","startDate":"2026-12-02","startTime":"10:00","endDate":"2026-12-02","endTime":"12:00","pax":1}}')`);
  const srv = await startSite(), o = await openBrowser();
  await o.page.context().addInitScript(() => { window.__uiDialogs = true; });
  try {
    await login(o.page, '#/courses?id=1');
    await o.page.waitForSelector('[data-crst="Annulée"]');
    o.page.on('dialog', () => { throw new Error('fenêtre du navigateur ouverte'); });
    await o.page.click('[data-crst="Annulée"]');
    await o.page.waitForSelector('.uidlg #uino');
    await o.page.click('.uidlg #uino');   // « Annuler » de la fenêtre : rien ne change
    assert.strictEqual(env.psql('select status from missions'), 'Confirmée');
    await o.page.click('[data-crst="Annulée"]'); await o.page.click('.uidlg #uiok');
    await o.page.waitForFunction(() => /Annulée/.test(document.querySelector('#crsres').innerText));
    assert.strictEqual(env.psql('select status from missions'), 'Annulée');
    // message (alert) : dessiné aussi, sans bloquer la page
    await o.page.evaluate(() => alert('Essai'));
    await o.page.waitForSelector('.uidlg >> text=Essai'); await o.page.click('.uidlg #uiok');
    assert.strictEqual(await o.page.$('.uidlg'), null);
    assert.deepStrictEqual(o.errors, []);
  } finally { await o.br.close(); srv.kill(); done(); }
});
