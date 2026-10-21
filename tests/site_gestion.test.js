// Gestion sans Google Sheet depuis le site : agences, liste des véhicules (import Excel), chauffeurs (ajout et import),
// rapport PDF téléchargé, alerte reçue en temps réel, destinataires des alertes et rapports automatiques, vue d'un gestionnaire d'agence.
// S'appuie sur la base remplie par tests/site.test.js (collecteur sur les vraies données).
const test = require('node:test'), assert = require('node:assert'), path = require('path'), fs = require('fs'), XLSX = require('xlsx');
const env = require('./lib/env'), { startSite, openBrowser, login } = require('./lib/browser');
const MGR = '22222222-2222-2222-2222-222222222222';
let srv;
const xlsx = (name, rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'x'); const f = path.join(env.OUT, name); XLSX.writeFile(wb, f); return f; };
const ready = page => page.waitForFunction(() => !document.querySelector('#page .loading'), null, { timeout: 15000 });

test.before(async () => {
  env.psql("delete from jobs; delete from user_agencies; delete from parc where note is distinct from 'Repris du Sheet ETAT PARC'; update vehicles set agency_id = null; delete from agencies; delete from drivers where source = 'manuel'; delete from alert_recipients; delete from report_schedules");
  srv = await startSite();
});
test.after(() => { if (srv) srv.kill(); env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; delete from user_agencies`); });

test('agences, véhicules et chauffeurs gérés depuis le site', async () => {
  const { br, page, errors } = await openBrowser();
  page.on('dialog', d => d.accept());
  try {
    await login(page, '#/agences'); await ready(page);
    await page.fill('#agname', 'Casablanca'); await page.click('#agadd');
    await page.waitForFunction(() => /créée/.test(document.querySelector('#agres').innerText));
    assert.strictEqual(env.psql("select name from agencies"), 'Casablanca');

    // Liste du parc importée d'un fichier Excel : agence existante reconnue, nouvelle agence créée
    const f = xlsx('parc.xlsx', [['Immatriculation définitive', 'Marque', 'Modèle', 'N° châssis', 'Carburant', 'Agence'],
      ['WW968194', 'HYUNDAI', 'SONATA', 'KMHL341JBRA084312', 'EH', 'casablanca'], ['99999-A-1', 'HYUNDAI', 'STARIA', 'KMHYC811BTU999999', 'GO', 'Rabat']]);
    await page.goto('http://localhost:8080/#/vehicules'); await ready(page);
    await page.setInputFiles('#vfile', f);
    await page.waitForFunction(() => /véhicules lus|Erreur/.test(document.querySelector('#vres').innerText), null, { timeout: 15000 });
    const out = await page.innerText('#vres');
    assert.match(out, /2 véhicules lus : 1 nouveaux, 1 mis à jour/); assert.match(out, /Agences créées : Rabat/);
    assert.strictEqual(env.psql("select a.name from vehicles v join agencies a on a.id = v.agency_id where v.key = '968194WW'"), 'Casablanca');
    assert.strictEqual(env.psql("select a.name from parc p join agencies a on a.id = p.agency_id where p.plate = '99999-A-1'"), 'Rabat');
    assert.match(env.psql('select kind from jobs'), /import_vehicles/);
    assert.match(await page.innerText('#tparc'), /ajouté au prochain passage/);

    // Ajout d'un véhicule à la main
    await page.fill('#vplate', '88888 b 2'); await page.fill('#vmodel', 'staria'); await page.selectOption('#vag', { label: 'Casablanca' }); await page.click('#vadd');
    await page.waitForFunction(() => /88888B2 ajouté/.test(document.querySelector('#vres').innerText));
    assert.strictEqual(env.psql("select model || '|' || agency_id from parc where plate = '88888B2'"), 'STARIA|' + env.psql("select id from agencies where name = 'Casablanca'"));

    // Chauffeur ajouté à la main, puis import d'une liste
    await page.goto('http://localhost:8080/#/fiches'); await ready(page);
    await page.fill('#dcode', 'test01'); await page.fill('#dname', 'Chauffeur Test'); await page.fill('#dphone', '0600000000'); await page.selectOption('#dag', { label: 'Casablanca' }); await page.click('#dadd');
    await page.waitForFunction(() => /ajouté/.test(document.querySelector('#dres').innerText));
    assert.strictEqual(env.psql("select name || '|' || source || '|' || phone from drivers where code = 'TEST01'"), 'Chauffeur Test|manuel|0600000000');
    const known = env.psql("select code from drivers where source = 'contrats' order by code limit 1");
    const fd = xlsx('chauffeurs.xlsx', [['Code client', 'Nom et prénom', 'Téléphone', 'Agence'], ['TEST02', 'Deuxième Test', '0611111111', 'Rabat'], [known, 'Ignoré', '0622222222', 'Casablanca']]);
    await page.setInputFiles('#dfile', fd);
    await page.waitForFunction(() => /chauffeurs lus|Erreur/.test(document.querySelector('#dres').innerText), null, { timeout: 15000 });
    assert.match(await page.innerText('#dres'), /2 chauffeurs lus : 1 ajoutés, 1 mis à jour/);
    assert.strictEqual(env.psql(`select phone || '|' || source from drivers where code = '${known}'`), '0622222222|contrats');
    assert.match(await page.innerText('#page'), /Deuxième Test/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('rapport PDF téléchargé depuis la page Rapports', async () => {
  const { br, page, errors } = await openBrowser({ acceptDownloads: true });
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    await login(page, '#/rapports'); await ready(page);
    await page.selectOption('#psel', '7 derniers jours'); await ready(page);
    const txt = await page.innerText('#page .rptview');
    assert.match(txt, /Rapport de la flotte/); assert.match(txt, /Toutes les agences · du 30\/09\/2026 au 06\/10\/2026/);
    assert.match(txt, /Chauffeurs \(du plus dangereux/); assert.match(txt, /WW968194/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rpdf')]);
    assert.match(dl.suggestedFilename(), /^rapport_flotte_toutes_agences_2026-09-30_2026-10-06\.pdf$/);
    const f = path.join(env.OUT, dl.suggestedFilename()); await dl.saveAs(f);
    const pdf = fs.readFileSync(f);
    assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 5000, 'PDF trop petit : ' + pdf.length);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('alerte reçue en temps réel : bandeau affiché', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct'); await ready(page);
    // alerte d'une journée passée (recalcul) : pas de bandeau
    await page.evaluate(() => window.__onNewAlert({ id: 'RT0', day: addDays(today(), -3), time: '09:15', plate: 'WW968199', vehicle_key: '968199WW', type: 'Excès de vitesse', severity: 'Critique', detail: 'x' }));
    assert.strictEqual(await page.locator('#toasts .toast').count(), 0);
    await page.evaluate(() => window.__onNewAlert({ id: 'RT1', day: today(), time: '09:15', plate: 'WW968199', vehicle_key: '968199WW', driver_name: 'Chauffeur RT', type: 'Excès de vitesse', severity: 'Critique', detail: '142 km/h' }));
    const t = await page.innerText('#toasts .toast');
    assert.match(t, /Critique/); assert.match(t, /Excès de vitesse/); assert.match(t, /WW968199/); assert.match(t, /Chauffeur RT/);
    await page.click('#toasts .toast .x');
    assert.strictEqual(await page.locator('#toasts .toast').count(), 0);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('alerte de dépassement de vitesse : seuil réglable par limite de route dans Réglages', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/reglages'); await ready(page);
    await page.waitForSelector('#tspeed');
    assert.match(await page.innerText('#tspeed'), /50 km\/h\s+80 km\/h/, 'seuil général 30 : route à 50 = alerte à 80');
    env.psql('delete from jobs');
    await page.fill('#tspeed .spl[data-l="50"]', '30'); await page.fill('#tspeed .spl[data-l="80"]', '20'); await page.fill('#tspeed .spl[data-l="120"]', '15');
    const row = l => page.innerText(`#tspeed .spa[data-l="${l}"]`);
    assert.strictEqual(await row(50), '80 km/h'); assert.strictEqual(await row(60), '90 km/h'); assert.strictEqual(await row(100), '120 km/h'); assert.strictEqual(await row(120), '135 km/h');
    await page.click('#spsave');
    await page.waitForFunction(() => /Seuils enregistrés/.test(document.querySelector('#spres').innerText));
    assert.strictEqual(env.psql("select value from params where key = 'overByLimit'"), '50:30;80:20;120:15');
    assert.strictEqual(env.psql("select count(*) from jobs where kind = 'recompute'"), '1', 'alertes recalculées');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); env.psql("update params set value = '' where key = 'overByLimit'; delete from jobs"); }
});

test('destinataires des alertes et rapports automatiques choisis dans Réglages', async () => {
  const { br, page, errors } = await openBrowser();
  page.on('dialog', d => d.accept());
  try {
    await login(page, '#/reglages'); await ready(page);
    await page.fill('#reml', 'chef@clicar.fr'); await page.selectOption('#rag', { label: 'Casablanca' }); await page.selectOption('#rsev', 'Critique'); await page.click('#radd');
    await page.waitForFunction(() => /chef@clicar\.fr/.test((document.querySelector('#trec') || {}).innerText || ''));
    assert.strictEqual(env.psql("select email || '|' || min_severity || '|' || (agency_id is not null) from alert_recipients"), 'chef@clicar.fr|Critique|true');
    await page.fill('#snom', 'Direction'); await page.selectOption('#sfreq', 'semaine'); await page.fill('#sto', 'dg@clicar.fr, adj@clicar.fr'); await page.click('#sadd');
    await page.waitForFunction(() => /Direction/.test((document.querySelector('#tsch') || {}).innerText || ''));
    assert.strictEqual(env.psql("select frequency || '|' || recipients || '|' || (agency_id is null) from report_schedules"), 'semaine|dg@clicar.fr, adj@clicar.fr|true');
    await page.click('[data-snow]');
    await page.waitForFunction(() => /Envoi demandé/.test(document.querySelector('[data-snow]').innerText));
    assert.strictEqual(env.psql("select kind || '|' || arg from jobs where kind = 'send_report'"), 'send_report|' + env.psql('select id from report_schedules'));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('gestionnaire d\'agence : ne voit que les véhicules de son agence', async () => {
  env.psql(`update profiles set role = 'manager' where user_id = '${MGR}'; insert into user_agencies select '${MGR}', id from agencies where name = 'Casablanca'`);
  srv.kill(); srv = await startSite('pending');
  const { br, page, errors } = await openBrowser();
  try {
    await page.goto('http://localhost:8080/#/vehicules');
    await page.fill('#le', 'new@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('.side nav'); await ready(page);
    const txt = await page.innerText('#tvh');
    assert.match(txt, /WW968194/); assert.doesNotMatch(txt, /WW968199/);
    assert.strictEqual(await page.locator('.side nav a[href="#/agences"]').count(), 0);
    await page.goto('http://localhost:8080/#/direct'); await ready(page);
    assert.strictEqual(await page.locator('#tlive tbody tr').count(), 1);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); srv = await startSite(); }
});
