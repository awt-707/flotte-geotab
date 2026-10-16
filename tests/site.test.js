// Le site sur une base remplie par le collecteur : chaque page s'affiche sans erreur, sur ordinateur et sur téléphone
const test = require('node:test'), assert = require('node:assert'), path = require('path');
const env = require('./lib/env'), { sheetV6, collector, copyContracts } = require('./lib/v6'), { startSite, openBrowser, login } = require('./lib/browser');
const NOW = Date.UTC(2026, 9, 6, 9, 0);
let srv, B, A;

test.before(async () => {
  A = sheetV6(NOW);
  B = collector(NOW); B.run('installer()'); copyContracts(A, B);
  B.run("sbReq_('post', 'jobs', [{ kind: 'after_inject', arg: '2026-09-29' }])");
  for (let i = 0; i < 4; i++) { B.setNow(NOW + i * 5 * 60000); B.run('collect()'); }   // 4 passages : journées finalisées, journal et alertes calculés
  srv = await startSite();
});
test.after(() => { if (srv) srv.kill(); });

const PAGES = [['direct', 'En direct', /En route|Garé|Arrêté/], ['tableau', 'Tableau de bord', /Km parcourus/], ['jour', 'Journée du', /Journées de travail actives/],
  ['chauffeurs', 'Classement des chauffeurs', /Score/], ['alertes', 'Alertes', /Gravité/], ['contrats', 'Contrats', /Contrats des 40 derniers jours/],
  ['plaques', 'Changements de plaque', /Ancienne plaque/], ['vehicules', 'Véhicules', /WW968194/], ['reglages', 'Réglages', /Journal technique/],
  ['fiches', 'Chauffeurs', /Code/], ['rapports', 'Rapports', /Km parcourus/], ['agences', 'Agences', /Aucune agence|Accès des utilisateurs/],
  ['conduite', 'Conduite', /Excès de vitesse/], ['carburant', 'Carburant', /Jauge en ce moment/], ['conso', 'Consommation', /Rapport de consommation/], ['ralenti', 'Ralenti', /Heures de ralenti par chauffeur/], ['arrets', 'Arrêts moteur tournant', /Détail des arrêts/], ['comportement', 'Comportement chauffeur', /Choisissez un chauffeur/],
  ['vehicule?k=968199WW', 'WW968199', /Journées de travail/], ['chauffeur?c=C038', 'Compte rendu', /Par journée de travail/]];

for (const [viewport, size] of [['ordinateur', { width: 1440, height: 900 }], ['téléphone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  test('toutes les pages sur ' + viewport, async () => {
    const { br, page, errors } = await openBrowser({ viewport: { width: size.width, height: size.height }, isMobile: size.isMobile, hasTouch: size.hasTouch });
    await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
    try {
      await login(page);
      for (const [p, title, content] of PAGES) {
        await page.goto('http://localhost:8080/#/' + p + (p === 'jour' ? '?jour=2026-10-03' : ''));
        // le changement d'adresse (#) ne recharge pas la page : attendre que la nouvelle page remplace l'ancienne
        await page.waitForFunction(t => { const h = document.querySelector('#page h1'); return h && h.innerText.startsWith(t) && !document.querySelector('#page .loading'); }, title, { timeout: 15000 }).catch(() => {});
        const h1 = await page.innerText('#page h1'), txt = await page.innerText('#page');
        assert.ok(h1.startsWith(title), p + ' : titre « ' + h1 + ' »');
        assert.match(txt, content, p + ' : contenu attendu absent');
        assert.strictEqual(await page.locator('#page .msg.err').count(), 0, p + ' : ' + txt.slice(0, 200));
        if (viewport === 'téléphone') {
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(over <= 1, p + ' : la page déborde de ' + over + ' px en largeur');
        }
        await page.screenshot({ path: path.join(env.OUT, 'site_' + p.replace(/\W.*/, '') + (viewport === 'téléphone' ? '_mobile' : '') + '.png') });
      }
      assert.deepStrictEqual(errors, []);
    } finally { await br.close(); }
  });
}

test('« En direct » : un véhicule par ligne, plaques dessinées, carte affichée', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForSelector('#tlive');
    const n = +env.psql('select count(*) from live_status');
    assert.strictEqual(await page.locator('#tlive tbody tr').count(), n);
    assert.ok(await page.locator('#tlive .plate').count() >= n);
    assert.strictEqual(await page.locator('#map.leaflet-container').count(), 1);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('page Carburant : mêmes totaux que « Carburant consommé entre deux dates » du Sheet v6', async () => {
  A.run("queueSync_(['2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04'], false)");
  const ref = A.run("fuelPeriod('2026-09-30T00:00','2026-10-07T00:00','',false)").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = ref.match(/([\d.]+) L consommés · (\d+) km · ([\d.]+) L\/100 km Dont moteur allumé à l'arrêt : ([\d.]+) L · Pleins détectés : (\d+) \(([\d.]+) L/);
  assert.ok(m, ref);
  const { br, page, errors } = await openBrowser();
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    await login(page, '#/carburant');
    await page.waitForSelector('#tcv');
    const card = async l => (await page.locator('.card', { hasText: l }).first().locator('.cv').innerText()).replace(/\s/g, '').replace(',', '.');
    assert.strictEqual(+await card('Carburant consommé'), +m[1]);
    assert.strictEqual(+await card('Km'), +m[2]);
    assert.strictEqual(+await card('Consommation'), +m[3]);
    assert.strictEqual(+await card('moteur allumé'), +m[4]);
    assert.strictEqual(+await card('Pleins détectés'), +m[5]);
    assert.strictEqual(+await card('Litres pleins'), +m[6]);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('compte en attente : aucune donnée visible', async () => {
  srv.kill(); srv = await startSite('pending');
  const { br, page } = await openBrowser();
  try {
    await page.goto('http://localhost:8080/');
    await page.fill('#le', 'new@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('.lbox .msg.warn');
    assert.match(await page.innerText('.lbox'), /doit être validé/);
    assert.strictEqual(await page.locator('.side').count(), 0);
  } finally { await br.close(); srv.kill(); srv = await startSite(); }
});

test('arrêts moteur tournant : chaque arrêt de la base affiché, litres non mesurés signalés', async () => {
  const { br, page, errors } = await openBrowser();
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    await login(page, '#/arrets');
    await page.selectOption('#psel', '30 derniers jours');
    await page.waitForFunction(() => !document.querySelector('#page .loading'), null, { timeout: 15000 });
    const n = +env.psql("select count(*) from engine_stops where day between '2026-09-07' and '2026-10-06'");
    assert.ok(n > 0, 'aucun arrêt calculé');
    assert.strictEqual(await page.locator('#tstops tbody tr').count(), n);
    const nm = +env.psql("select count(*) from engine_stops where day between '2026-09-07' and '2026-10-06' and liters is null");
    assert.strictEqual(await page.locator('#tstops tbody tr td:nth-child(8) .nm').count(), nm, 'litres non mesurés');
    assert.match(await page.innerText('.cards'), new RegExp(`${n - nm} / ${n}`));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('en direct : positions Geotab lues toutes les 5 s, les véhicules bougent sur la carte', async () => {
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => /Temps réel Geotab : actualisé toutes les 5 s/.test(document.querySelector('#livest').innerText), null, { timeout: 15000 });
    const pos = () => page.evaluate(() => Object.fromEntries(Object.entries(LIVE.markers).map(([k, m]) => [k, m.getLatLng().lat + ',' + m.getLatLng().lng])));
    const p1 = await pos();
    assert.deepStrictEqual(Object.keys(p1).sort(), ['968194WW', '968199WW']);
    await page.waitForFunction(p => Object.entries(LIVE.markers).some(([k, m]) => m.getLatLng().lat + ',' + m.getLatLng().lng !== p[k]), p1, { timeout: 20000 });
    await page.waitForTimeout(1600);   // fin du glissement du marqueur
    const live = await page.evaluate(() => LIVE.pos);
    for (const [k, v] of Object.entries(await pos())) assert.strictEqual(v, live[k].lat + ',' + live[k].lon, k + ' : marqueur pas à la position Geotab');
    const txt = await page.innerText('#tlive');
    Object.values(live).filter(v => v.state === 'En route').forEach(v => assert.match(txt, new RegExp(v.speed + ' km/h')));
    assert.match(txt, /\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/, 'heure de position à la seconde');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('en direct : relais Geotab pas encore installé, positions du collecteur et message clair', async () => {
  srv.kill(); process.env.LIVE_OFF = '1'; srv = await startSite(); delete process.env.LIVE_OFF;
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => /indisponible/.test(document.querySelector('#livest').innerText), null, { timeout: 15000 });
    assert.match(await page.innerText('#livest'), /Temps réel Geotab indisponible \(Requested function was not found\) : positions du collecteur/);
    assert.ok(await page.locator('#tlive tbody tr').count() > 0);
    assert.deepStrictEqual(errors.filter(e => !/404/.test(e)), []);
  } finally { await br.close(); srv.kill(); srv = await startSite(); }
});

test('en direct : chauffeur = contrat en cours maintenant, sinon « Hors contrat »', async () => {
  env.psql(`insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at, status)
    values ('LIVE1', 'CLIVE', 'Chauffeur En Cours', 'WW968199', '968199WW', now() - interval '2 hours', null, 'En cours'),
           ('LIVE2', 'COLD', 'Contrat Terminé', 'WW968194', '968194WW', now() - interval '9 hours', now() - interval '3 hours', 'Clôturé')`);
  // contrats sans date de retour (toujours en cours) du 968194WW clos pour le test, rouverts à la fin
  const open = env.psql("select coalesce(string_agg(num, ','), '') from contracts where vehicle_key = '968194WW' and end_at is null").split(',').filter(Boolean);
  env.psql("update contracts set end_at = now() - interval '4 hours' where vehicle_key = '968194WW' and end_at is null");
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => /Temps réel Geotab : actualisé/.test(document.querySelector('#livest').innerText), null, { timeout: 15000 });
    const rows = await page.$$eval('#tlive tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ')));
    const r99 = rows.find(t => /WW968199/.test(t)), r94 = rows.find(t => /WW968194/.test(t));
    assert.match(r99, /Chauffeur En Cours (Jour|Nuit) LIVE1/);
    assert.match(r94, /Hors contrat/); assert.doesNotMatch(r94, /Contrat Terminé/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); env.psql("delete from contracts where num in ('LIVE1', 'LIVE2')" + (open.length ? "; update contracts set end_at = null where num in ('" + open.join("','") + "')" : '')); }
});

test('en direct : alertes à l\'instant (événements Geotab et vitesse au-dessus du seuil), notification des nouvelles', async () => {
  const lim = env.psql("select value from params where key = 'vmaxAlert'");
  env.psql("update params set value = '30' where key = 'vmaxAlert'");
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => /Temps réel Geotab : actualisé/.test(document.querySelector('#livest').innerText), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length > 0, null, { timeout: 30000 });
    const txt = await page.innerText('#livealerts');
    assert.match(txt, /Alertes en direct/);
    const rows = await page.$$eval('#tlal .acard', els => els.map(el => el.innerText.replace(/\s+/g, ' ').trim()));
    assert.ok(rows.length > 0, 'aucune alerte en direct');
    rows.forEach(r => assert.match(r, /^\d{2}\/\d{2} \d{2}:\d{2}:\d{2} .*Voir la fiche/, r));
    const ev = await page.evaluate(() => LIVE.alerts.map(a => a.type));
    assert.ok(ev.some(t => t !== 'Vitesse excessive'), 'aucun événement Geotab');
    const toast = await page.innerText('#toasts .toast');
    assert.match(toast, /Voir le véhicule/);
    // clic sur une alerte de vitesse : fiche avec la vitesse lue dans Geotab autour de l'instant
    await page.click('#tlal .acard:has-text("Vitesse")');
    await page.waitForSelector('#adlg[open] .adgrid', { timeout: 20000 });
    const fiche = await page.innerText('#adlg');
    assert.match(fiche, /Vitesse max/); assert.match(fiche, /Limite de la route à cet instant/); assert.match(fiche, /Rien n'est estimé/);
    assert.match(fiche, /\d+ km\/h à \d{2}:\d{2}:\d{2}/, 'vitesse max lue dans Geotab');
    assert.ok((await page.getAttribute('#adlg svg path.spd', 'd')).length > 20, 'courbe de vitesse vide');
    assert.strictEqual(await page.locator('#admap.leaflet-container').count(), 1);
    await page.click('#adlg .adclose');
    assert.strictEqual(await page.locator('#adlg[open]').count(), 0);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); env.psql(`update params set value = '${lim}' where key = 'vmaxAlert'`); }
});

test('en direct : chauffeurs en ce moment, compteurs Geotab depuis le début du contrat (trajet en cours compris)', async () => {
  const geo = require('./lib/geotab_fake'), id = env.psql("select geotab_id from vehicles where key = '968199WW'");
  const open = env.psql("select coalesce(string_agg(num, ','), '') from contracts where vehicle_key = '968199WW' and end_at is null").split(',').filter(Boolean);
  env.psql("update contracts set end_at = '2026-10-03T07:00:00Z' where vehicle_key = '968199WW' and end_at is null");
  env.psql(`insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at, status) values ('LIVE3', 'CDRV', 'Chauffeur Compteurs', 'WW968199', '968199WW', '2026-10-03T08:00:00Z', null, 'En cours')`);
  const { br, page, errors } = await openBrowser();
  await page.clock.setFixedTime(new Date('2026-10-03T13:30:00Z'));
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => LIVE.drvAt > 0 && LIVE.drv['968199WW'], null, { timeout: 30000 });
    const st = await page.evaluate(() => ({ d: LIVE.drv['968199WW'], at: LIVE.drvGeoAt }));
    const G = (diag, t) => geo.handle('Get', { credentials: { sessionId: 'S1' }, typeName: 'StatusData', search: { deviceSearch: { id }, diagnosticSearch: { id: diag }, fromDate: t, toDate: t } }).result.slice(-1)[0].data;
    const r3 = v => Math.round(v * 1000) / 1000;
    const km = r3((G('DiagnosticOdometerId', st.at) - G('DiagnosticOdometerId', '2026-10-03T08:00:00.000Z')) / 1000);
    const fuel = r3(G('DiagnosticDeviceTotalFuelId', st.at) - G('DiagnosticDeviceTotalFuelId', '2026-10-03T08:00:00.000Z'));
    assert.strictEqual(st.d.km, km); assert.strictEqual(st.d.fuel_l, fuel); assert.ok(km > 0);
    const txt = (await page.innerText('#livedrv')).replace(/\s+/g, ' ');
    assert.match(txt, /Chauffeurs en ce moment/); assert.match(txt, /Chauffeur Compteurs/);
    const nf = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v).replace(/\s/g, ' ');
    assert.ok(txt.replace(/\s/g, ' ').includes(nf(km)), 'km affichés : ' + nf(km));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); env.psql("delete from contracts where num = 'LIVE3'" + (open.length ? "; update contracts set end_at = null where num in ('" + open.join("','") + "')" : '')); }
});

test('en direct : dépassement de la limite de la route au-delà du seuil réglé, alerte à l\'instant', async () => {
  env.psql("update params set value = '0:-200' where key = 'overByLimit'");   // seuil négatif : tout véhicule en route sous une limite connue déclenche (test)
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForFunction(() => LIVE.alerts.some(a => a.type === 'Dépassement limite'), null, { timeout: 60000 });
    const a = await page.evaluate(() => { const a = LIVE.alerts.find(x => x.type === 'Dépassement limite'), v = LIVE.pos[a.vehicle_key]; return { a, v }; });
    assert.match(a.a.detail, /^\d+ km\/h pour \d+ km\/h autorisés \(seuil \+-200, soit -?\d+ km\/h\)$/);
    assert.match(await page.innerText('#livealerts'), /Dépassement limite/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); env.psql("update params set value = '' where key = 'overByLimit'"); }
});

test('page Consommation : entre deux instants (à la minute), mêmes totaux que le Sheet v6, PDF téléchargé', async () => {
  const from = '2026-10-01T06:30', to = '2026-10-04T18:45';
  A.run("queueSync_(['2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05'], false)");
  const ref = A.run(`fuelPeriod('${from}','${to}','',false)`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = ref.match(/([\d.]+) L consommés · (\d+) km · ([\d.]+) L\/100 km Dont moteur allumé à l'arrêt : ([\d.]+) L · Pleins détectés : (\d+) \(([\d.]+) L/);
  assert.ok(m, ref);
  const { br, page, errors } = await openBrowser({ acceptDownloads: true });
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  await page.addInitScript(([a, z]) => { try { localStorage.setItem('conso', JSON.stringify({ a, z, k: '' })); } catch (e) { } }, [from, to]);
  try {
    await login(page, '#/conso');
    await page.waitForSelector('#page .rptview');
    const sum = {}; (await page.$$eval('.rsum tr', trs => trs.map(tr => [tr.cells[0].innerText, tr.cells[1].innerText]))).forEach(([k, v]) => { sum[k] = v; });
    const n = s => +String(s).replace(/[\s ]/g, '').replace(',', '.').match(/^[\d.]+/)[0];
    assert.strictEqual(n(sum['Carburant consommé (L)']), +m[1]);
    assert.strictEqual(Math.round(n(sum['Km parcourus'])), +m[2]);
    assert.strictEqual(n(sum['Consommation (L/100 km)']), +m[3]);
    assert.strictEqual(n(sum['Ralenti (moteur allumé, véhicule immobile)'].split('·')[1]), +m[4]);
    assert.strictEqual(n(sum['Pleins détectés']), +m[5]);
    assert.match(await page.innerText('.rsub'), /du 01\/10\/2026 06:30 au 04\/10\/2026 18:45/);
    assert.match(await page.innerText('.rptview'), /Par véhicule[\s\S]*Par chauffeur[\s\S]*Par jour[\s\S]*Pleins détectés[\s\S]*Siphonages suspects/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cpdf')]);
    assert.match(dl.suggestedFilename(), /^rapport_consommation_toutes_agences_2026-10-01_2026-10-04\.pdf$/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('comportement chauffeur : profil et historique entre deux dates, PDF, envoi par e-mail du même rapport par le collecteur', async () => {
  const fs = require('fs'), from = '2026-09-29', to = '2026-10-06';
  const code = env.psql(`select driver_code from journal where day between '${from}' and '${to}' and driver_code <> 'HORS_CONTRAT' group by 1 order by sum(km) desc limit 1`);
  const km = +env.psql(`select round(sum(km)::numeric, 1) from journal where driver_code = '${code}' and day between '${from}' and '${to}'`);
  const nEv = +env.psql(`select coalesce(sum(n_events), 0) from journal where driver_code = '${code}' and day between '${from}' and '${to}'`);
  const { br, page, errors } = await openBrowser({ acceptDownloads: true });
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  await page.addInitScript(([c, a, z]) => { try { localStorage.setItem('comp', JSON.stringify({ c, from: a, to: z })); } catch (e) { } }, [code, from, to]);
  try {
    await login(page, '#/comportement');
    await page.waitForSelector('.dprof', { timeout: 20000 });
    const sum = {}; (await page.$$eval('.rsum tr', trs => trs.map(tr => [tr.cells[0].innerText, tr.cells[1].innerText]))).forEach(([k, v]) => { sum[k] = v; });
    const n = v => +String(v).replace(/[\s\u202f\u00a0]/g, '').replace(',', '.').match(/^-?[\d.]+/)[0];
    assert.strictEqual(n(sum['Km parcourus']), km);
    assert.strictEqual(n(sum['Événements de conduite']), nEv);
    assert.match(sum['Chauffeur'], new RegExp('code client ' + code));
    const txt = await page.innerText('#page');
    ['Journées de travail (horaires du contrat)', 'Vitesse : dépassements', 'Événements de conduite Geotab par règle', 'Consommation par véhicule', 'Pleins détectés', 'Alertes'].forEach(t => assert.ok(txt.includes(t), t));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cpdf')]);
    assert.match(dl.suggestedFilename(), /^comportement_.*_2026-09-29_2026-10-06\.pdf$/);
    const f = require('path').join(env.OUT, dl.suggestedFilename()); await dl.saveAs(f);
    assert.strictEqual(fs.readFileSync(f).slice(0, 5).toString(), '%PDF-');
    // envoi par e-mail : demande au collecteur, qui prépare le même rapport et l'envoie avec le PDF
    env.psql('delete from jobs'); B.mails.length = 0;
    await page.fill('#cmail', 'chef@exemple.ma'); await page.click('#csend');
    await page.waitForFunction(() => /Demande envoyée/.test(document.querySelector('#cmailst').innerText));
    let raw = ''; for (let i = 0; i < 40 && !raw; i++) { raw = env.psql("select coalesce(max(arg), '') from jobs where kind = 'driver_report'"); if (!raw) await page.waitForTimeout(250); }
    if (!raw) throw new Error('demande non créée : ' + await page.innerText('#cmailst'));
    const arg = JSON.parse(raw);
    assert.deepStrictEqual(arg, { code, from, to, email: 'chef@exemple.ma' });
    B.run('processJobs_(Date.now())');
    assert.strictEqual(B.mails.length, 1);
    const m = B.mails[0];
    assert.strictEqual(m.to, 'chef@exemple.ma'); assert.match(m.subject, /^Ludy : comportement de .* du 29\/09\/2026 au 06\/10\/2026$/);
    assert.strictEqual(m.attachments.length, 1);
    assert.ok(m.htmlBody.includes('Km parcourus : <b>' + sum['Km parcourus'].replace(/\s/g, ' ') + '</b>') || m.htmlBody.replace(/[\u202f\u00a0]/g, ' ').includes('Km parcourus : <b>' + sum['Km parcourus'].replace(/[\s\u202f\u00a0]/g, ' ') + '</b>'), 'mêmes km que la page');
    await page.waitForFunction(() => /Envoyé : PDF envoyé à chef@exemple\.ma/.test(document.querySelector('#cmailst').innerText), null, { timeout: 20000 });
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});

test('PDF des pages Conduite et Classement', async () => {
  const fs = require('fs');
  const { br, page, errors } = await openBrowser({ acceptDownloads: true });
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    for (const [hash, btn, re, word] of [['#/conduite', '#cdpdf', /^conduite_toutes_agences_2026-09-30_2026-10-06\.pdf$/, 'Le plus dangereux'], ['#/chauffeurs', '#rkpdf', /^classement_toutes_agences_2026-09-30_2026-10-06\.pdf$/, 'Seuils']]) {
      if (hash === '#/conduite') await login(page, hash); else { await page.goto('http://localhost:8080/' + hash); await page.waitForSelector('#psel'); }
      await page.selectOption('#psel', '7 derniers jours');
      await page.waitForSelector(btn);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
      assert.match(dl.suggestedFilename(), re);
      const f = require('path').join(env.OUT, dl.suggestedFilename()); await dl.saveAs(f);
      const pdf = fs.readFileSync(f);
      assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-'); assert.ok(pdf.length > 5000);
      assert.ok(pdf.toString('latin1').includes(word), word + ' absent du PDF');
    }
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); }
});


test('shift des alertes : contrat en cours à l\'heure de l\'alerte, sinon créneau 7 h-19 h / 19 h-7 h ; une nuit appartient au jour où elle commence', async () => {
  // 05/10/2026 (heure du Maroc = UTC+1) : contrat de jour pris à 06:31 ; alertes à 06:45 (dans le contrat), 14:06, et 02:30 le 06/10 sans contrat
  env.psql(`insert into contracts (num, client_code, name, plate, vehicle_key, start_at, end_at, status)
    values ('SHJ1', 'CSH', 'Chauffeur Shift', 'SH-1', 'SHTEST', '2026-10-05T05:31:00Z', '2026-10-05T17:20:00Z', 'Clôturé')`);
  env.psql(`insert into alerts (id, day, time, plate, vehicle_key, driver_code, driver_name, type, severity, detail, value, status)
    values ('TSH|1', '2026-10-05', '06:45', 'SH-1', 'SHTEST', 'CSH', 'Chauffeur Shift', 'Dépassement limite', 'Haute', 'TESTSHIFT-A1', '', 'À traiter'),
           ('TSH|2', '2026-10-05', '14:06', 'SH-1', 'SHTEST', 'CSH', 'Chauffeur Shift', 'Dépassement limite', 'Haute', 'TESTSHIFT-A2', '', 'À traiter'),
           ('TSH|3', '2026-10-06', '02:30', 'SH-2', 'SHTEST2', '', '', 'Vitesse excessive', 'Haute', 'TESTSHIFT-A3', '', 'À traiter'),
           ('TSH|4', '2026-10-05', '02:30', 'SH-2', 'SHTEST2', '', '', 'Vitesse excessive', 'Haute', 'TESTSHIFT-A4', '', 'À traiter')`);
  const { br, page, errors } = await openBrowser();
  await page.clock.setFixedTime(new Date('2026-10-06T09:18:00Z'));
  try {
    await login(page, '#/jour?jour=2026-10-05');
    await page.waitForFunction(() => /TESTSHIFT/.test(document.querySelector('#page').innerText), null, { timeout: 15000 });
    // journée du 05/10 = shift jour du 05/10 puis shift nuit du 05/10 au 06/10 ; la nuit du 04/10 au 05/10 (02:30 le 05/10) n'en fait pas partie
    const sec = await page.$$eval('#page h3.shift', hs => hs.filter(h => h.nextElementSibling && /TESTSHIFT/.test(h.nextElementSibling.innerText))
      .map(h => h.innerText.replace(/\s+/g, ' ').trim() + ' = ' + (h.nextElementSibling.innerText.match(/TESTSHIFT-A\d/g) || []).sort().join(',')));
    assert.deepStrictEqual(sec, ['Shift nuit du 05/10 → 06/10 (19:00 → 07:00) · 1 alerte = TESTSHIFT-A3', 'Shift jour du 05/10 (07:00 → 19:00) · 2 alertes = TESTSHIFT-A1,TESTSHIFT-A2']);
    // page Alertes : colonne Shift (06:45 dans un contrat de jour = Jour ; 02:30 = nuit de la veille)
    await page.goto('http://localhost:8080/#/alertes?jour=2026-10-05');
    await page.waitForFunction(() => /TESTSHIFT-A4/.test(document.querySelector('#page').innerText), null, { timeout: 15000 });
    const rows = await page.$$eval('#talall tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ')).filter(t => /TESTSHIFT/.test(t)));
    const row = id => rows.find(t => t.includes(id)) || '';
    assert.match(row('TESTSHIFT-A1'), /06:45 Jour 05\/10 /);
    assert.match(row('TESTSHIFT-A2'), /14:06 Jour 05\/10 /);
    assert.match(row('TESTSHIFT-A4'), /02:30 Nuit 04\/10 → 05\/10 /);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); env.psql("delete from alerts where id like 'TSH|%'; delete from contracts where num = 'SHJ1'"); }
});
