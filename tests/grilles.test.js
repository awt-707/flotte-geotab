// Courses privées : une grille par ville de départ. Grille Marrakech de la migration (même logique prix / distance que Casablanca),
// libellés des devis selon la ville de départ, grille choisie dans le devis et la course rapide, nouvelle ville créée par l'administrateur.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), C = require('../site/courses.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const grid = id => JSON.parse(env.psql('select data from pricing_grid where id = ' + id));

test('grille Marrakech : transferts Menara et intervilles depuis Marrakech, reste repris de Casablanca', () => {
  const K = grid(1), M = grid(2);
  assert.strictEqual(env.psql('select string_agg(id || \':\' || name, \',\' order by id) from pricing_grid'), '1:Casablanca,2:Marrakech');
  assert.deepStrictEqual([K.origin, K.airportName, M.origin, M.airportName], ['Casablanca', 'Mohammed V', 'Marrakech', 'Marrakech-Menara']);
  assert.deepStrictEqual(M.airport.map(r => [r.dest, r.SONATA, r.STARIA]), [['Marrakech', 320, 570], ['Casablanca', 2030, 2970], ['Rabat', 2630, 3840], ['Essaouira', 1570, 2320],
    ['Agadir', 2070, 3030], ['Ouarzazate', 1680, 2480], ['El Jadida', 1690, 2480], ['Fès', 4200, 6090], ['Tanger', 4510, 6540], ['Tétouan', 4900, 7100]]);
  assert.deepStrictEqual(M.intercity.map(r => [r.dest, r.SONATA, r.STARIA]), [['En ville (Marrakech)', 150, 200], ['Casablanca', 1720, 2720], ['Aéroport Mohammed V', 1950, 2830],
    ['Rabat', 2380, 3540], ['Essaouira', 1440, 2150], ['Agadir', 1910, 2840], ['Ouarzazate', 1480, 2220], ['El Jadida', 1530, 2290], ['Fès', 3880, 5720], ['Tanger', 4170, 6150], ['Tétouan', 4540, 6700]]);
  // même trajet que la grille de Casablanca = même prix
  const kc = K.intercity.find(r => r.dest === 'Marrakech'), ka = K.airport.find(r => r.dest === 'Marrakech');
  assert.deepStrictEqual([M.intercity[1].SONATA, M.intercity[1].STARIA, M.intercity[2].SONATA, M.intercity[2].STARIA], [kc.SONATA, kc.STARIA, ka.SONATA, ka.STARIA]);
  // mise à disposition, suppléments et conditions : ceux de Casablanca
  ['cats', 'hourly', 'half', 'day', 'wait15', 'kmExtra', 'nightPct', 'proPct', 'depositPct', 'returnPct', 'vat', 'cancel', 'notes', 'company'].forEach(k => assert.deepStrictEqual(M[k], K[k], k));
  assert.match(M.calc, /part fixe \+ prix au km/);
  // la migration est rejouable : pas de seconde grille Marrakech
  env.psql(require('fs').readFileSync(require('path').join(env.ROOT, 'supabase/migrations/20261117000000_grilles_villes.sql'), 'utf8'));
  assert.strictEqual(env.psql('select count(*) from pricing_grid'), '2');
});

test('prix : libellés de la ville de départ ; grille d\'avant (sans ville) = Casablanca', () => {
  const M = grid(2), K = grid(1), P = f => C.crsPrice(f, M);
  let p = P({ kind: 'Transfert aéroport', cat: 'STARIA', dest: 'Essaouira' });
  assert.deepStrictEqual(p.lines.map(l => [l.label, l.amount]), [['Transfert aéroport Marrakech-Menara ↔ Essaouira', 2320]]);
  p = P({ kind: 'Transfert simple', cat: 'SONATA', dest: 'Rabat', returnEmpty: true });
  assert.match(p.lines[0].label, /^Rabat → Marrakech/); assert.strictEqual(p.total, 1666);   // course retour −30 %
  p = P({ kind: 'Déplacement interville', cat: 'SONATA', dest: 'Ouarzazate', startDate: '2026-11-02' });
  assert.deepStrictEqual([p.lines[0].label, p.total, p.deposit], ['Marrakech → Ouarzazate', 1480, 444]);
  const old = Object.assign({}, K); delete old.origin; delete old.airportName;
  assert.strictEqual(C.crsPrice({ kind: 'Transfert aéroport', cat: 'SONATA', dest: 'Rabat' }, old).lines[0].label, 'Transfert aéroport Mohammed V ↔ Rabat');
  assert.strictEqual(C.crsOrigin(old), 'Casablanca');
});

test('droits : grilles créées et retirées par l\'administrateur seul ; Casablanca jamais retirée', () => {
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';`);
  try {
    assert.strictEqual(as(MGR, 'select count(*) from pricing_grid'), '2', 'le gestionnaire lit les grilles');
    assert.throws(() => as(MGR, `insert into pricing_grid (name, data) values ('Agadir', '{}')`), /row-level security/);
    as(MGR, 'delete from pricing_grid where id = 2');
    as(ADMIN, 'delete from pricing_grid where id = 1');
    assert.strictEqual(env.psql('select count(*) from pricing_grid'), '2', 'rien retiré');
    as(ADMIN, `insert into pricing_grid (name, data) values ('Agadir', '{"origin":"Agadir"}')`);
    assert.strictEqual(env.psql("select id > 2 from pricing_grid where name = 'Agadir'"), 't');
    as(ADMIN, "delete from pricing_grid where name = 'Agadir'");
    assert.strictEqual(env.psql('select count(*) from pricing_grid'), '2');
  } finally { env.psql(`delete from pricing_grid where id > 2; update profiles set role = 'pending' where user_id = '${MGR}'`); }
});

test('page : devis au départ de Marrakech, course rapide, grille par ville, nouvelle ville copiée', async () => {
  env.resetDb();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI'), ('968194WW', 'WW968194', 'SONATA', 'OUI')`);
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/courses?new=1');
    await page.waitForSelector('[data-f="gridId"]');
    assert.strictEqual(await page.inputValue('[data-f="gridId"]'), '1', 'Casablanca par défaut (aucune grille rattachée à l\'agence)');
    await page.selectOption('[data-f="gridId"]', '2');
    await page.waitForFunction(() => document.querySelector('[data-f="startCity"]').value === 'Marrakech');
    await page.fill('[data-f="client"]', 'Client TEST');
    await page.selectOption('[data-f="kind"]', 'Transfert aéroport'); await page.selectOption('[data-f="cat"]', 'SONATA');
    await page.waitForSelector('[data-f="dest"]');
    assert.match(await page.innerText('#crsform'), /Destination \(depuis \/ vers l'aéroport Marrakech-Menara\)/);
    await page.selectOption('[data-f="dest"]', 'Agadir');
    await page.waitForFunction(() => /Transfert aéroport Marrakech-Menara ↔ Agadir/.test(document.querySelector('#crsside').innerText));
    assert.match(await page.innerText('#crsside'), /2 070 MAD/);
    await page.click('#crssave'); await page.waitForFunction(() => /Enregistré/.test(document.querySelector('#crsres').innerText));
    const m = JSON.parse(env.psql('select row_to_json(x) from (select total_ttc, data from missions) x'));
    assert.deepStrictEqual([m.total_ttc, m.data.f.gridId, m.data.grid._id, m.data.grid.origin], [2070, '2', 2, 'Marrakech']);
    // course rapide : tarifs de chaque ville de départ
    await page.goto('http://localhost:8080/#/courses?rapide=1'); await page.waitForSelector('#qkgrid');
    assert.deepStrictEqual(await page.$$eval('#qkgrid optgroup', g => g.map(x => x.label)), ['Départ Casablanca', 'Départ Marrakech']);
    await page.selectOption('#qkveh', '968199WW'); await page.selectOption('#qkgrid', '2|I|Essaouira');
    assert.strictEqual(await page.inputValue('#qkprice'), '2150');
    // grille : onglet par ville, nouvelle ville copiée, retirée
    await page.goto('http://localhost:8080/#/courses?t=grille&g=2'); await page.waitForSelector('#gsave');
    assert.match(await page.innerText('#page'), /Grille au départ de Marrakech[\s\S]*Transferts aéroport Marrakech-Menara[\s\S]*Intervilles depuis Marrakech/);
    await page.fill('[data-g="intercity.4.SONATA"]', '1450'); await page.click('#gsave'); await page.waitForSelector('text=Grille enregistrée');
    assert.strictEqual(env.psql("select data->'intercity'->4->>'SONATA' from pricing_grid where id = 2"), '1450');
    assert.strictEqual(env.psql("select data->'intercity'->4->>'SONATA' from pricing_grid where id = 1"), '3490', 'Casablanca inchangée');
    page.once('dialog', d => d.accept('Agadir'));
    await page.click('#gcopy');
    await page.waitForFunction(() => /Grille au départ de Agadir/.test(document.querySelector('#page').innerText));
    assert.strictEqual(env.psql("select data->>'origin' from pricing_grid where name = 'Agadir'"), 'Agadir');
    page.once('dialog', d => d.accept());
    await page.click('#gdrop');
    await page.waitForFunction(() => !/Départ Agadir/.test(document.querySelector('#page').innerText));
    assert.strictEqual(env.psql('select count(*) from pricing_grid'), '2');
    assert.deepStrictEqual(errors, []);
  } finally {
    env.psql(`delete from pricing_grid where id > 2; update pricing_grid set data = jsonb_set(data, '{intercity,4,SONATA}', '1440') where id = 2; truncate missions, cash_moves restart identity`);
    await br.close(); srv.kill();
  }
});
