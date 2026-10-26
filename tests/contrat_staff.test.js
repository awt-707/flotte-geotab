// Contrats de travail du staff (chef d'agence, gestionnaire…) : modèle en français, intitulé du poste au choix, PDF sur une
// colonne, jamais vus par un gestionnaire. Données de test fictives.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const env = require('./lib/env'), M = require('../site/contrat_modele.js'), { ctpBuild } = require('../site/contrat_pdf.js');
const { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const LIBS = { PDFLib: require('pdf-lib'), fontkit: require('@pdf-lib/fontkit'), bidi: require('bidi-js')() };
const FONTS = { r: fs.readFileSync(path.join(env.ROOT, 'site/fonts/NotoSansArabic-Regular.ttf')), b: fs.readFileSync(path.join(env.ROOT, 'site/fonts/NotoSansArabic-Bold.ttf')) };
const CO = { name: 'ATLAS TEST', sigle: 'S.A.S', forme_fr: 'société par actions simplifiée', capital: '10.000', siege_fr: 'Rue Exemple, Casablanca', rc_ville_fr: 'Casablanca',
  rc: '000001', rep_civ: 'M', rep_name: 'Karim Exemple', rep_qual_fr: 'Président', ville_fr: 'Casablanca' };
const EMP = { model: 'staff', civ: 'Mme', nom: 'Salma TEST', naiss: '1998-02-03', lieu: 'Rabat', cin: 'X000002', adresse: 'Rue 1, Casablanca', effet: '2026-09-01', sal: 5000,
  poste: 'Assistante RH', essai_cat: 'employe', lieu_travail: 'Casablanca' };

test('modèle staff : texte du modèle, poste au choix, période d\'essai de l\'article 14, aucune donnée réelle', () => {
  const all = M.CTR_STAFF_ROWS.map(r => r.fr || '').join('\n');
  ['ARTICLE 1 – ENTREE EN VIGUEUR – DUREE – PERIODE D’ESSAI', 'ARTICLE 7 – MOBILITE GEOGRAPHIQUE', '7.3 Acceptation et portée de la Mobilité Géographique',
    'ARTICLE 17 – NON-DÉNIGREMENT', 'ARTICLE 21 – DISPOSITIONS DIVERSES', 'un jour et demi (1,5)', 'loi 09-08'].forEach(w => assert.ok(all.includes(w), w));
  assert.ok(!M.CTR_STAFF_ROWS.some(r => r.ar), 'français seulement');
  assert.ok(!/\d{6,}|@|[A-Z]{2}\d{5,}|\d{2}\/\d{2}\/\d{4}/.test(all), 'ni numéro, ni e-mail, ni CIN, ni date en dur');
  assert.deepStrictEqual(M.ctrMissing(CO, EMP, 'staff'), []);
  assert.deepStrictEqual(M.ctrMissing(CO, Object.assign({}, EMP, { poste: '', essai_cat: '', lieu_travail: '' }), 'staff'), ['Intitulé du poste', 'Période d\'essai (catégorie)', 'Lieu de travail']);
  const txt = JSON.stringify(M.ctrBlocks(CO, EMP, 'staff'));
  assert.ok(!/\{[a-z_]+\}/.test(txt), 'tous les champs remplacés');
  ['en qualité d’<b>Assistante RH</b>', 'les fonctions d’<b>Assistante RH</b>', 'période d’essai d’un mois et demi', 'nette de <b>5.000,00</b> dirhams', 'locaux de la Société situés à Casablanca',
    'Mme <b>Salma TEST</b>, née le 03/02/1998', 'dont elle aurait eu connaissance', 'informations personnelles du Président', 'Fait à Casablanca,'].forEach(w => assert.ok(txt.includes(w), w));
  const chef = JSON.stringify(M.ctrBlocks(CO, Object.assign({}, EMP, { civ: 'M', poste: 'Chef d\'agence', essai_cat: 'cadre' }), 'staff'));
  ['en qualité de <b>Chef d\'agence</b>', 'période d’essai de trois (3) mois', 'dont il aurait eu connaissance', 'né le'].forEach(w => assert.ok(chef.includes(w), w));
  assert.ok(JSON.stringify(M.ctrBlocks(CO, Object.assign({}, EMP, { model: 'chauffeur' }))).includes('Chauffeur'), 'modèle chauffeur inchangé');
});

test('PDF du staff : une colonne en français, sans police arabe, mots jamais collés', async () => {
  const bytes = await ctpBuild({ title: 'Contrat de travail · Salma TEST', mono: true, rows: M.ctrBlocks(CO, EMP, 'staff') }, LIBS, FONTS);
  const file = path.join(env.OUT, 'contrat_staff.pdf'); fs.writeFileSync(file, bytes);
  const doc = await LIBS.PDFLib.PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 4 && doc.getPageCount() <= 8, doc.getPageCount() + ' pages');
  let txt = null; try { txt = execFileSync('pdftotext', [file, '-']).toString(); } catch (e) { }
  if (txt) {
    ['CONTRAT DE TRAVAIL A DUREE', 'Salma TEST', 'X000002', 'Assistante RH', 'ARTICLE 21 – DISPOSITIONS DIVERSES', 'Représentée par Monsieur Karim Exemple'].forEach(w => assert.ok(txt.includes(w), w + ' absent du PDF'));
    assert.ok(!/TRAVAILA|[؀-ۿ]/.test(txt), 'espaces gardées, aucun texte arabe');
  }
});

test('droits : contrat du staff jamais lu ni créé par un gestionnaire, même dans son agence', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);`);
  try {
    as(ADMIN, `insert into work_contracts (agency_id, name, model) values (1, 'Chef TEST', 'staff'), (1, 'Ali TEST', 'chauffeur')`);
    assert.strictEqual(as(MGR, 'select string_agg(name, \',\') from work_contracts'), 'Ali TEST');
    assert.throws(() => as(MGR, `insert into work_contracts (agency_id, name, model) values (1, 'X', 'staff')`), /row-level security/);
    assert.throws(() => as(MGR, `update work_contracts set model = 'staff' where name = 'Ali TEST'`), /row-level security/);
    assert.strictEqual(env.psql("select model from work_contracts where name = 'Ali TEST'"), 'chauffeur', 'gestionnaire : contrat jamais passé en staff');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('page Contrats de travail : modèle staff, poste, catégorie, PDF stocké hors des agences, fiche staff créée', async () => {
  env.resetDb();
  env.psql(`insert into agencies (id, name) overriding system value values (1, 'Rabat');
    insert into employers (name, data) values ('ATLAS TEST', '${JSON.stringify(Object.assign({}, CO, { name: undefined }))}')`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/travail');
    await page.waitForSelector('#ctmodel');
    await page.selectOption('#ctemp', { label: 'ATLAS TEST' }); await page.dispatchEvent('#ctemp', 'change');
    await page.selectOption('#ctmodel', 'staff');
    await page.waitForSelector('#ct_poste');
    assert.strictEqual(await page.$('#ct_nom_ar'), null, 'pas de champs arabes');
    await page.selectOption('#ct_civ', 'Mme');
    for (const k of ['nom', 'lieu', 'cin', 'adresse', 'sal', 'poste', 'lieu_travail']) await page.fill('#ct_' + k, String(EMP[k]));
    await page.fill('#ct_naiss', '03/02/1998'); await page.fill('#ct_effet', '01/09/2026');
    await page.selectOption('#ct_essai_cat', 'employe'); await page.selectOption('#ct_agency', '1');
    assert.match(await page.innerText('#ctmiss'), /Prêt/);
    await page.click('#ctgen');
    await page.waitForSelector('#ctdone .mfok', { timeout: 30000 });
    assert.strictEqual(env.psql("select model || '|' || name || '|' || (pdf_path like '0/%.pdf') || '|' || (data->'emp'->>'poste') from work_contracts"), 'staff|Salma TEST|true|Assistante RH');
    assert.strictEqual(env.psql("select kind || '|' || position || '|' || category || '|' || trial_months || '|' || agency_id from hr_employees"), 'staff|Assistante RH|employe|1.50|1');
    assert.match(await page.innerText('#cthist'), /Salma TEST\s+Assistante RH/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); env.psql('truncate hr_employees, work_contracts, employers restart identity cascade'); }
});
