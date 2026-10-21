// Courses privées : prix selon la grille Ludy 10/2026, classement, validation de l'exploitation, droits, page et devis PDF
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), C = require('../site/courses.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const grid = () => JSON.parse(env.psql('select data from pricing_grid where id = 1'));

test('grille de la migration = grille Ludy 10/2026 (PDF d\'Ahmed)', () => {
  const G = grid();
  assert.strictEqual(G.vat, 10);
  assert.deepStrictEqual([G.hourly.SONATA, G.hourly.STARIA, G.hourlyMinH], [220, 300, 2]);
  assert.deepStrictEqual([G.half.h, G.half.km, G.half.SONATA, G.half.STARIA], [4, 80, 800, 1100]);
  assert.deepStrictEqual([G.day.h, G.day.km, G.day.SONATA, G.day.STARIA], [8, 150, 1500, 2000]);
  assert.deepStrictEqual(G.airport.map(r => [r.dest, r.SONATA, r.STARIA]), [['Casablanca', 320, 570], ['Rabat', 950, 1450], ['Marrakech', 1950, 2830], ['Tanger', 2890, 4210],
    ['Agadir', 3650, 5330], ['Fès', 2670, 3890], ['Tétouan', 3100, 4510]]);
  assert.deepStrictEqual(G.intercity.map(r => [r.dest, r.SONATA, r.STARIA]), [['En ville (Casa)', 150, 200], ['Rabat', 780, 1130], ['Marrakech', 1720, 2720], ['Tanger', 2570, 3790],
    ['Agadir', 3490, 5150], ['Fès', 2360, 3470], ['Tétouan', 2770, 4080]]);
  assert.deepStrictEqual([G.nightPct, G.wait15.SONATA, G.wait15.STARIA, G.waitFreeAirport, G.waitFreeOther, G.kmExtra.SONATA, G.kmExtra.STARIA, G.proPct, G.depositPct, G.returnPct],
    [15, 55, 75, 60, 15, 3, 5, 10, 30, 30]);
});

test('prix : mise à disposition, transferts, intervilles, suppléments ; rien d\'estimé hors grille', () => {
  const G = grid(), P = f => C.crsPrice(f, G);
  // plusieurs jours : journée × jours + heures et km prévus au-delà du forfait, acompte 30 %
  let p = P({ kind: 'Mise à disposition sur plusieurs jours', cat: 'SONATA', startDate: '2026-11-01', endDate: '2026-11-04', hoursDay: 10, kmDay: 200 });
  assert.deepStrictEqual(p.lines.map(l => l.amount), [6000, 1760, 600]);   // 4 × 1 500 ; 2 h × 4 j × 220 ; 50 km × 4 j × 3
  assert.deepStrictEqual([p.total, p.deposit, p.ht, p.tva], [8360, 2508, 7600, 760]);
  assert.deepStrictEqual(p.included, { h: 8, km: 150 });
  // une journée de 4 h et 60 km : demi-journée ; tarif horaire : minimum 2 h
  assert.strictEqual(P({ kind: 'Mise à disposition à la journée', cat: 'STARIA', startDate: '2026-11-01', hoursDay: 4, kmDay: 60 }).total, 1100);
  assert.strictEqual(P({ kind: 'Mise à disposition à la journée', cat: 'STARIA', startDate: '2026-11-01', hoursDay: 9, kmDay: 120 }).total, 2000 + 300);
  assert.strictEqual(P({ kind: 'Mise à disposition à l\'heure', cat: 'SONATA', hoursDay: 1 }).total, 440);
  assert.strictEqual(P({ kind: 'Mise à disposition à l\'heure', cat: 'STARIA', hoursDay: 3.5 }).total, 1200);
  // transfert aéroport aller-retour de nuit au retour, attente 90 min (60 incluses → 2 × 15 min), agence −10 % ;
  // aller-retour du même client : le véhicule ne rentre pas à vide, pas de remise « course retour »
  p = P({ kind: 'Transfert aéroport', cat: 'STARIA', dest: 'Marrakech', roundTrip: true, returnEmpty: true, nightReturn: true, waitMin: 90, pro: true });
  assert.deepStrictEqual(p.lines.map(l => l.amount), [2830, 2830, 424.5, 150, -623.45]);
  assert.strictEqual(p.total, 5611.05); assert.strictEqual(p.deposit, 0);
  // course retour (grille) : sens du retour d'un véhicule qui rentrerait à vide, −30 % sur le trajet ; nuit +15 % sur le prix du trajet
  p = P({ kind: 'Déplacement interville', cat: 'STARIA', dest: 'Marrakech', returnEmpty: true, night: true, startDate: '2026-11-01' });
  assert.deepStrictEqual(p.lines.map(l => l.amount), [2720, -816, 285.6]);
  assert.match(p.lines[0].label, /^Marrakech → Casablanca/); assert.strictEqual(p.total, 2189.6);
  // interville : prix de la grille, acompte 30 %, péages compris (forfait)
  p = P({ kind: 'Déplacement interville', cat: 'SONATA', dest: 'Rabat', startDate: '2026-11-01' });
  assert.deepStrictEqual([p.total, p.deposit], [780, 234]);
  // 24 h/24 : pas de prix inventé, à fixer par la direction
  p = P({ kind: 'Disponibilité 24 h/24', cat: 'STARIA', startDate: '2026-11-01', endDate: '2026-11-02', h24: true });
  assert.strictEqual(p.total, 0); assert.match(p.notes.join(' '), /fixer par la direction/);
  assert.strictEqual(P({ kind: 'Disponibilité 24 h/24', cat: 'STARIA', startDate: '2026-11-01', endDate: '2026-11-02', h24: true, dayPrice: 4000, secondDriver: 900 }).total, 8900);
  // destination hors grille : signalée, pas de prix
  assert.match(P({ kind: 'Transfert aéroport', cat: 'SONATA', dest: 'Ouarzazate' }).notes.join(' '), /absente de la grille/);
});

test('classement, formule horaire, validation de l\'exploitation et points à préciser', () => {
  const G = grid();
  assert.strictEqual(C.crsLevel({ kind: 'Mise à disposition à la journée', hoursDay: 8, kmDay: 150, startCity: 'Casablanca' }).level, 'Standard');
  assert.strictEqual(C.crsLevel({ hoursDay: 11, kmDay: 150 }).level, 'Intensive');
  assert.strictEqual(C.crsLevel({ startCity: 'Casablanca', cities: ['Marrakech'] }).level, 'Intensive');
  assert.strictEqual(C.crsLevel({ service: 'VIP' }).level, '24h / VIP');
  assert.strictEqual(C.crsAmplitude({ dayStart: '08:00', dayEnd: '20:30' }), 'Journée très longue (12 à 15 h)');
  assert.strictEqual(C.crsAmplitude({ dayStart: '18:00', dayEnd: '02:00' }), 'Journée standard (jusqu\'à 10 h)');
  const v = C.crsValidation({ startDate: '2026-11-01', endDate: '2026-11-05', kmDay: 350, startCity: 'Casablanca', cities: ['Fès'], dayStart: '18:00', dayEnd: '01:00', drivers: 2, planning: 'non', nVeh: 2 }, 0, G);
  assert.deepStrictEqual(v.map(x => x.split(' (')[0]), ['plus de trois jours consécutifs', 'plus de 300 km par jour', 'plusieurs villes', 'disponibilité après minuit', '2 chauffeurs', 'convoi de 2 véhicules', 'planning non défini']);
  assert.deepStrictEqual(C.crsValidation({ startDate: '2026-11-01', kmDay: 150, startCity: 'Casablanca' }, 1500, G), []);
  assert.deepStrictEqual(C.crsMissing({ kind: 'Mise à disposition à la journée', cat: 'SONATA', startDate: '2026-11-01', pax: 2, client: 'X' }, G), ['heures incluses par jour', 'kilométrage estimé par jour', 'ville de prise en charge (zone d\'utilisation)']);
  assert.ok(!C.crsSeatsOk({ cat: 'SONATA', pax: 6 }, G)); assert.ok(C.crsSeatsOk({ cat: 'SONATA', pax: 6, nVeh: 2 }, G));
});

test('contrôle Geotab : km et amplitude par jour, dépassements au tarif de la grille', () => {
  const t = (d, a, b, km) => ({ start_at: `2026-11-0${d}T${a}:00Z`, end_at: `2026-11-0${d}T${b}:00Z`, km });
  const day = ms => new Date(ms).toISOString().slice(0, 10), hm = ms => new Date(ms).toISOString().slice(11, 16);
  const r = C.crsActual([t(1, '07:00', '09:00', 60), t(1, '15:00', '17:30', 120), t(2, '08:00', '12:00', 90)], {}, { included: { h: 8, km: 150 }, extraHour: 220, extraKm: 3 }, day, hm);
  assert.deepStrictEqual(r.days.map(d => [d.day, d.km, d.h, d.overH, d.overKm, d.from, d.to]), [['2026-11-01', 180, 10.5, 3, 30, '07:00', '17:30'], ['2026-11-02', 90, 4, 0, 0, '08:00', '12:00']]);
  assert.deepStrictEqual([r.km, r.overH, r.overKm, r.amountH, r.amountKm], [270, 3, 30, 660, 90]);
});

test('droits : grille modifiable par l\'administrateur seul ; validation réservée à l\'administrateur ; numéro de devis', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);`);
  const before = env.psql("select data->'day'->>'SONATA' from pricing_grid");
  try {
    assert.strictEqual(as(MGR, "select data->'day'->>'SONATA' from pricing_grid"), '1500', 'le gestionnaire lit la grille');
    as(MGR, `update pricing_grid set data = jsonb_set(data, '{day,SONATA}', '1')`);   // aucune ligne modifiable : sans effet
    assert.strictEqual(env.psql("select data->'day'->>'SONATA' from pricing_grid"), before);
    as(ADMIN, `update pricing_grid set data = jsonb_set(data, '{day,SONATA}', '1600')`);
    assert.strictEqual(env.psql("select data->'day'->>'SONATA' from pricing_grid"), '1600');
    assert.throws(() => env.psql('begin; set local role anon; select count(*) from pricing_grid; commit;'), /permission denied/);
    // gestionnaire : devis de son agence, numéro donné par la base
    as(MGR, "insert into missions (agency_id, client_name, kind, total_ttc, needs_validation, level) values (1, 'Client A', 'Transfert aéroport', 570, false, 'Standard')");
    assert.match(env.psql('select number from missions'), /^DEV-\d{4}-\d{4}$/);
    assert.throws(() => as(MGR, "insert into missions (agency_id, client_name) values (2, 'Autre agence')"), /row-level security/);
    assert.throws(() => as(MGR, `insert into missions (agency_id, client_name, validated_at) values (1, 'X', now())`), /validation réservée|permission denied/);
    // devis à valider : pas d'envoi par le gestionnaire avant la validation de l'administrateur
    as(MGR, "insert into missions (agency_id, client_name, kind, total_ttc, needs_validation, level) values (1, 'Client B', 'Mise à disposition sur plusieurs jours', 9000, true, 'Intensive')");
    const id = env.psql("select id from missions where client_name = 'Client B'");
    assert.throws(() => as(MGR, `update missions set status = 'Devis envoyé' where id = ${id}`), /validation de l'exploitation requise/);
    assert.throws(() => as(MGR, `update missions set validated_at = now() where id = ${id}`), /validation réservée/);
    as(ADMIN, `update missions set validated_at = now(), validated_by = '${ADMIN}' where id = ${id}`);
    as(MGR, `update missions set status = 'Devis envoyé' where id = ${id}`);
    assert.strictEqual(env.psql(`select status from missions where id = ${id}`), 'Devis envoyé');
    // prix changé après validation : refusé au gestionnaire ; par l'administrateur : la validation tombe
    assert.throws(() => as(MGR, `update missions set total_ttc = 5000 where id = ${id}`), /modifiables seulement par l'administrateur/);
    as(ADMIN, `update missions set total_ttc = 9500 where id = ${id}`);
    assert.strictEqual(env.psql(`select validated_at is null from missions where id = ${id}`), 't');
    // lecture : gestionnaire = son agence ; suppression : administrateur
    env.psql("insert into missions (agency_id, client_name) values (2, 'Rabat client')");
    assert.strictEqual(as(MGR, 'select count(*) from missions'), '2');
    as(MGR, `delete from missions where id = ${id}`); assert.strictEqual(env.psql('select count(*) from missions'), '3');
  } finally { env.psql(`update pricing_grid set data = jsonb_set(data, '{day,SONATA}', '${before}'); update profiles set role = 'pending' where user_id = '${MGR}'; truncate missions restart identity`); }
});

test('page Courses privées : nouvelle demande, prix en direct, enregistrement, validation, devis PDF, grille (administrateur)', async () => {
  env.resetDb();
  env.psql(`insert into vehicles (key, plate, model, active) values ('968199WW', 'WW968199', 'STARIA', 'OUI'), ('968194WW', 'WW968194', 'SONATA', 'OUI')`);
  const srv = await startSite(), { br, page, errors } = await openBrowser({ acceptDownloads: true });
  try {
    await login(page, '#/courses');
    await page.waitForSelector('#tcrs, .empty');
    await page.click('text=+ Nouvelle demande');
    await page.waitForSelector('#crsside');
    await page.fill('[data-f="client"]', 'Karim Bennani'); await page.fill('[data-f="phone"]', '0612345678');
    await page.selectOption('[data-f="kind"]', 'Mise à disposition sur plusieurs jours');
    await page.selectOption('[data-f="cat"]', 'STARIA');
    await page.fill('[data-f="startDate"]', '2026-11-10'); await page.fill('[data-f="endDate"]', '2026-11-14');
    await page.fill('[data-f="hoursDay"]', '10'); await page.fill('[data-f="kmDay"]', '250'); await page.fill('[data-f="pax"]', '5');
    await page.check('[data-fa="cities"][value="Marrakech"]');
    const side = await page.innerText('#crsside');
    assert.match(side, /Intensive/); assert.match(side, /Validation de l'exploitation obligatoire/); assert.match(side, /plus de trois jours/);
    // 5 × 2 000 + 2 h × 5 j × 300 + 100 km × 5 j × 5 = 15 500 TTC, acompte 30 %
    assert.match(side, /15 500 MAD/); assert.match(side, /4 650 MAD/);
    await page.click('#crssave'); await page.waitForFunction(() => /Enregistré/.test(document.querySelector('#crsres').innerText));
    const num = env.psql('select number from missions');   // compteur de la base (jamais deux fois le même numéro)
    assert.match(num, /^DEV-\d{4}-\d{4}$/);
    assert.strictEqual(env.psql("select status || '|' || total_ttc || '|' || needs_validation from missions"), 'Demande|15500|true');
    // envoi refusé avant validation, puis validé par l'administrateur et envoyé
    page.once('dialog', d => d.accept());
    await page.click('[data-crst="Devis envoyé"]');
    assert.strictEqual(env.psql('select status from missions'), 'Demande');
    await page.click('#crsval'); await page.waitForSelector('text=Validé par l\'exploitation');
    await page.click('[data-crst="Devis envoyé"]'); await page.waitForFunction(() => /Devis envoyé/.test(document.querySelector('#crsres').innerText));
    assert.strictEqual(env.psql('select status from missions'), 'Devis envoyé');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#crspdf')]);
    assert.strictEqual(dl.suggestedFilename(), 'Devis-' + num + '-Karim-Bennani.pdf');
    const pdf = fs.readFileSync(await dl.path()); assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
    fs.writeFileSync(path.join(env.OUT, 'devis_course.pdf'), pdf);
    // confirmation : véhicule obligatoire, puis bloqué au planning
    await page.click('[data-crst="Accepté"]'); await page.waitForFunction(() => /Accepté/.test(document.querySelector('#crsres').innerText));
    page.once('dialog', d => d.accept());
    await page.click('[data-crst="Acompte reçu"]');
    await page.selectOption('[data-f="vehicleKey"]', '968199WW');
    await page.click('[data-crst="Acompte reçu"]'); await page.waitForFunction(() => /Acompte reçu/.test(document.querySelector('#crsres').innerText));
    assert.strictEqual(env.psql('select status || \'|\' || vehicle_key from missions'), 'Acompte reçu|968199WW');
    await page.goto('http://localhost:8080/#/courses?t=planning&d=2026-11-09'); await page.waitForSelector('table.plan');
    assert.ok((await page.innerText('table.plan')).includes(num.slice(-4)), 'mission au planning');
    // mission en cours : contrôle réel par Geotab (trajets du véhicule affecté pendant la mission)
    env.psql(`update missions set status = 'En cours', start_at = now() - interval '26 hours', end_at = now() + interval '2 days';
      insert into trips (id, vehicle_key, vday, final, start_at, end_at, km) values
        ('T1', '968199WW', current_date, true, now() - interval '25 hours', now() - interval '24 hours', 140),
        ('T2', '968199WW', current_date, true, now() - interval '3 hours', now() - interval '2 hours', 30.5)`);
    await page.goto('http://localhost:8080/#/courses?id=' + env.psql('select id from missions')); await page.waitForSelector('#tcrsg');
    const geo = await page.innerText('#crsgeo');
    assert.match(geo, /Contrôle réel \(Geotab\)/); assert.match(geo, /170,5/);
    // En direct : véhicule en course privée signalé (carte du véhicule, marqueur, info-bulle)
    env.psql(`insert into live_status (vehicle_key, plate, model, state, lat, lon, updated_at) values ('968199WW', 'WW968199', 'STARIA', 'En route', 33.59, -7.61, now()), ('968194WW', 'WW968194', 'SONATA', 'Garé', 33.6, -7.62, now())`);
    await page.goto('http://localhost:8080/#/direct'); await page.waitForSelector('#vlist .vcard.crs');
    assert.strictEqual(await page.locator('#vlist .vcard.crs').count(), 1);
    assert.match(await page.innerText('#vlist .vcard.crs'), /Course privée[\s\S]*Karim Bennani/);
    assert.strictEqual(await page.locator('.vmk-pin.crs').count(), 1);
    // grille : l'administrateur la modifie
    await page.goto('http://localhost:8080/#/courses?t=grille'); await page.waitForSelector('#gsave');
    await page.fill('[data-g="day.STARIA"]', '2100'); await page.click('#gsave'); await page.waitForSelector('text=Grille enregistrée');
    assert.strictEqual(env.psql("select data->'day'->>'STARIA' from pricing_grid"), '2100');
    assert.deepStrictEqual(errors, []);
  } finally { env.psql(`update pricing_grid set data = jsonb_set(data, '{day,STARIA}', '2000')`); await br.close(); srv.kill(); }
});
