// Contrats de travail : texte du modèle bilingue, montants en lettres, PDF vectoriel (arabe lié), droits par agence, page du site
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), zlib = require('zlib'), { execFileSync } = require('child_process');
const env = require('./lib/env'), M = require('../site/contrat_modele.js'), { ctpBuild } = require('../site/contrat_pdf.js');
const { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const LIBS = { PDFLib: require('pdf-lib'), fontkit: require('@pdf-lib/fontkit'), bidi: require('bidi-js')() };
const FONTS = { r: fs.readFileSync(path.join(env.ROOT, 'site/fonts/NotoSansArabic-Regular.ttf')), b: fs.readFileSync(path.join(env.ROOT, 'site/fonts/NotoSansArabic-Bold.ttf')) };
// données de test (fictives)
const CO = { name: 'ATLAS TEST', sigle: 'S.A.R.L', forme_fr: 'société à responsabilité limitée de droit marocain', forme_ar: 'شركة ذات مسؤولية محدودة بمقتضى القانون المغربي',
  capital: '100.000', siege_fr: 'Immeuble 1, Rue Exemple, Rabat - Maroc', siege_ar: 'بعمارة 1، زنقة المثال، الرباط - المغرب', rc_ville_fr: 'Rabat', rc_ville_ar: 'الرباط', rc: '000001',
  rep_civ: 'M', rep_name: 'Karim Exemple', rh_mail: 'rh@exemple.ma', rh_tel: '0600000000', ville_fr: 'Casablanca', ville_ar: 'الدار البيضاء' };
const EMP = { civ: 'M', nom: 'Ali TEST', naiss: '1990-01-31', lieu: 'Tiznit', lieu_ar: 'تيزنيت', cin: 'x000001', adresse: 'Rue 1, Casablanca', effet: '2026-08-31', sal: 3200, date_sig: '2026-08-31' };
// texte latin d'un PDF pdf-lib (chaînes des polices standard, flux inflatés)
const latin = buf => { const b = Buffer.from(buf), out = []; let i = 0;
  for (;;) { const a = b.indexOf('stream', i); if (a < 0) break; let s = a + 6; if (b[s] === 13) s++; if (b[s] === 10) s++; const e = b.indexOf('endstream', s); if (e < 0) break;
    try { const t = zlib.inflateSync(b.slice(s, e)).toString('latin1'); for (const m of t.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) if (m[1].length % 4 || /\/Times/.test(t)) out.push(Buffer.from(m[1], 'hex').toString('latin1')); } catch (x) { } i = e + 9; }
  return out.join(''); };

test('montants en lettres (français et arabe, comme le modèle : « trois mille deux cents » / « ثلاثة آلاف ومائتا (3.200) درهم »)', () => {
  const fr = [[3200, 'trois mille deux cents'], [3500, 'trois mille cinq cents'], [2080, 'deux mille quatre-vingts'], [3271, 'trois mille deux cent soixante et onze'],
    [80000, 'quatre-vingt mille'], [21000, 'vingt et un mille'], [1000, 'mille'], [200, 'deux cents'], [1250000, 'un million deux cent cinquante mille']];
  fr.forEach(([n, w]) => assert.strictEqual(M.ctrFrWords(n), w, n));
  const ar = [[3200, 'ثلاثة آلاف ومائتا', 'درهم'], [3500, 'ثلاثة آلاف وخمسمائة', 'درهم'], [2000, 'ألفا', 'درهم'], [2500, 'ألفان وخمسمائة', 'درهم'],
    [4250, 'أربعة آلاف ومائتان وخمسون', 'درهما'], [12000, 'اثنا عشر ألفا', 'درهم'], [3005, 'ثلاثة آلاف وخمسة', 'دراهم']];
  ar.forEach(([n, w, d]) => assert.deepStrictEqual(M.ctrArWords(n), { words: w, noun: d }, String(n)));
  assert.strictEqual(M.ctrArWords(2e6).words, '', 'au-delà d\'un million : saisi à la main');
  assert.strictEqual(M.ctrAmount(3200), '3.200');
  assert.strictEqual(M.ctrAmount(125000), '125.000');
});

test('champs du contrat : salarié(e), société, valeurs saisies prioritaires, rien d\'inventé', () => {
  const v = M.ctrFields(CO, EMP);
  assert.strictEqual(v.nom_ar, 'Ali TEST', 'sans traduction : nom latin dans la colonne arabe');
  assert.deepStrictEqual([v.civ, v.ne, v.civ_ar, v.nat_fr, v.nat_ar, v.cin, v.naiss, v.sal, v.sal_fr, v.sal_ar, v.dh_ar],
    ['M.', 'né', 'السيد', 'Marocaine', 'مغربي', 'X000001', '31/01/1990', '3.200', 'trois mille deux cents', 'ثلاثة آلاف ومائتا', 'درهم']);
  const f = M.ctrFields(Object.assign({}, CO, { rep_civ: 'Mme' }), Object.assign({}, EMP, { civ: 'Mme', sal_fr: 'trois mille deux cents', sal_ar: 'نص' }));
  assert.deepStrictEqual([f.civ, f.ne, f.civ_ar, f.mazdad, f.nat_ar, f.soussigne, f.tenu, f.saiq, f.rep_civ_fr, f.bisifa, f.rep_qual_fr, f.rep_qual_ar, f.sal_ar],
    ['Mme', 'née', 'السيدة', 'المزدادة', 'مغربية', 'soussignée', 'tenue', 'سائقة', 'Madame', 'بصفتها', 'Gérante', 'مسيرة', 'نص']);
  assert.strictEqual(M.ctrFields(CO, Object.assign({}, EMP, { nat_fr: 'Française' })).nat_ar, '', 'autre nationalité : arabe à saisir');
  assert.deepStrictEqual([v.bi_lieu, v.bi_adresse], ['بتيزنيت', 'بـ Rue 1, Casablanca'], '« ب » attaché à l\'arabe, « بـ » devant le latin');
  assert.deepStrictEqual(M.ctrMissing(CO, EMP), []);
  assert.deepStrictEqual(M.ctrMissing(Object.assign({}, CO, { rc: '' }), Object.assign({}, EMP, { cin: '', nat_fr: 'Française' })), ['Société : numéro RC', 'Nationalité (arabe)', 'N° CIN']);
  // valeurs saisies nettoyées (pas de balise ni de champ)
  assert.strictEqual(M.ctrFields(CO, Object.assign({}, EMP, { nom: ' Ali <b>{cin}</b>  TEST ' })).nom, 'Ali bcin/b TEST');
});

test('texte du modèle : toutes les clauses, aucun reste des contrats réels, champs tous remplis', () => {
  const all = M.CTR_ROWS.map(r => (r.fr || '') + ' ' + (r.ar || '')).join('\n');
  ['ARTICLE 19 – JURIDICTION ET COMPETENCE', 'Cour Marocaine d’Arbitrage de la CCI-Maroc', 'taux d’occupation minimal des courses', 'الفصل 14 – السرية', 'DashCam',
    'COPIE DU CASIER JUDICIAIRE DU SALARIE', 'CONVENTION DE MISE A DISPOSITION DU VEHICULE', 'Usages illicites, frauduleux ou contraires à l’ordre public'].forEach(w => assert.ok(all.includes(w), w));
  assert.ok(!/\d{6,}|@|[A-Z]{2}\d{5,}/.test(all.replace(/\{[a-z_]+\}/g, '')), 'ni numéro, ni e-mail, ni CIN en dur dans le modèle');
  const rows = M.ctrBlocks(CO, EMP), txt = JSON.stringify(rows);
  assert.ok(!/\{[a-z_]+\}/.test(txt), 'tous les champs remplacés');
  assert.ok(txt.includes('représentée par Monsieur Karim Exemple en qualité de Gérant') && txt.includes('بصفته مسيرا'));
  assert.ok(txt.includes('trois mille deux cents (3.200) dirhams') && txt.includes('ثلاثة آلاف ومائتا (3.200) درهم'));
  assert.ok(txt.includes('(la «\\u00a0<b>Société</b>\\u00a0») ;') || txt.includes('(la « <b>Société</b> ») ;'), 'espaces insécables autour des guillemets');
});

test('PDF : 2 colonnes français / arabe, police arabe intégrée, texte et pages attendus', async () => {
  const bytes = await ctpBuild({ title: 'Contrat de travail · Ali TEST', rows: M.ctrBlocks(CO, EMP) }, LIBS, FONTS);
  fs.writeFileSync(path.join(env.OUT, 'contrat_travail.pdf'), bytes);
  const doc = await LIBS.PDFLib.PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 20 && doc.getPageCount() <= 30, doc.getPageCount() + ' pages');
  assert.ok(bytes.length < 600000, 'PDF léger : ' + bytes.length);
  const t = latin(bytes);
  ['ATLAS TEST', 'Karim Exemple', 'X000001', '31/08/2026', 'trois mille deux cents', 'rh@exemple.ma', 'ANNEXE 5', 'Je soussigné'].forEach(w => assert.ok(t.includes(w), w + ' absent du PDF'));
  const fonts = []; doc.context.enumerateIndirectObjects().forEach(([, o]) => { const n = o.get && o.get(LIBS.PDFLib.PDFName.of('BaseFont')); if (n) fonts.push(n.toString()); });
  assert.ok(fonts.some(f => /NotoSansArabic-Regular/.test(f)) && fonts.some(f => /NotoSansArabic-Bold/.test(f)), 'polices arabes intégrées : ' + fonts.join(' '));
  // texte arabe lisible (ordre logique) si pdftotext est installé
  let txt = null; try { txt = execFileSync('pdftotext', [path.join(env.OUT, 'contrat_travail.pdf'), '-']).toString(); } catch (e) { }
  if (txt) ['الشركة', 'الشغل', 'المدة'].forEach(w => assert.ok(txt.includes(w), w + ' (arabe) absent'));
});

test('droits : sociétés lues par les gestionnaires, modifiées par l\'administrateur ; contrats et PDF par agence', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Casa');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);`);
  try {
    as(ADMIN, `insert into employers (name, data) values ('ATLAS TEST', '{"rc":"000001"}')`);
    assert.strictEqual(as(MGR, 'select name from employers'), 'ATLAS TEST');
    assert.throws(() => as(MGR, `insert into employers (name) values ('X')`), /row-level security/);
    as(MGR, `update employers set name = 'Y'`); assert.strictEqual(env.psql('select name from employers'), 'ATLAS TEST', 'gestionnaire : aucune modification');
    as(MGR, `insert into work_contracts (employer_id, agency_id, name, created_by) values (1, 1, 'Ali TEST', '${ADMIN}')`);
    assert.strictEqual(env.psql('select created_by from work_contracts'), MGR, 'auteur = utilisateur connecté');
    assert.throws(() => as(MGR, `insert into work_contracts (employer_id, agency_id, name) values (1, 2, 'B')`), /row-level security/);
    assert.throws(() => as(MGR, `insert into work_contracts (employer_id, name) values (1, 'C')`), /row-level security/, 'agence obligatoire pour un gestionnaire');
    as(ADMIN, `insert into work_contracts (employer_id, agency_id, name) values (1, 2, 'D'), (1, null, 'E')`);
    assert.strictEqual(as(MGR, 'select string_agg(name, \',\') from work_contracts'), 'Ali TEST');
    assert.strictEqual(as(ADMIN, 'select count(*) from work_contracts'), '3');
    as(MGR, 'delete from work_contracts'); assert.strictEqual(env.psql('select count(*) from work_contracts'), '3', 'suppression : administrateur seulement');
    env.psql(`update profiles set role = 'viewer' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, 'select count(*) from work_contracts') + as(MGR, 'select count(*) from employers'), '00', 'lecture seule : rien');
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); env.resetDb(); }
});

test('page Contrats de travail : nouvelle société, salarié, PDF généré, enregistré et stocké', async () => {
  env.resetDb();
  env.psql(`insert into agencies (id, name) overriding system value values (1, 'Rabat');
    insert into drivers (code, name, phone, agency_id) values ('C9', 'Ali TEST', '0611223344', 1)`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/travail');
    await page.waitForSelector('#ctconew');
    await page.click('#ctconew');
    for (const [k, v] of Object.entries(CO)) if (k !== 'rep_civ') await page.fill(`[data-ctco="${k}"]`, v);
    await page.click('#ctcosave');
    await page.waitForFunction(() => { const x = document.querySelector('#ctemp'); return x && x.selectedOptions[0] && /ATLAS TEST/.test(x.selectedOptions[0].textContent); });
    await page.fill('#ctdrv', 'Ali TEST'); await page.dispatchEvent('#ctdrv', 'change');
    assert.strictEqual(await page.inputValue('#ct_tel'), '0611223344');
    for (const k of ['naiss', 'lieu', 'cin', 'adresse', 'effet', 'sal']) await page.fill('#ct_' + k, String(EMP[k]));
    await page.dispatchEvent('#ct_effet', 'change');
    assert.strictEqual(await page.inputValue('#ct_date_sig'), '2026-08-31', 'date de signature = date d\'effet par défaut');
    assert.strictEqual(await page.getAttribute('#ct_sal_fr', 'placeholder'), 'trois mille deux cents');
    assert.match(await page.innerText('#ctmiss'), /Prêt/);
    await page.click('#ctgen');
    await page.waitForSelector('#ctdone .mfok', { timeout: 30000 });
    assert.strictEqual(env.psql("select name || '|' || cin || '|' || agency_id || '|' || effective_on || '|' || (data->'company'->>'name') || '|' || (pdf_path like '1/%.pdf') from work_contracts"),
      'Ali TEST|X000001|1|2026-08-31|ATLAS TEST|true');
    assert.match(await page.innerText('#cthist'), /Ali TEST\tX000001\tATLAS TEST\t31\/08\/2026\tRabat/);
    const wa = await page.getAttribute('#ctdone a[href^="https://wa.me/212611223344"]', 'href');
    assert.ok(wa && decodeURIComponent(wa).includes('Contrat PDF à signer : '), 'WhatsApp au salarié avec le lien du PDF');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
