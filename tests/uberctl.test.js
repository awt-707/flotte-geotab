// Contrôle des courses Uber (14/11/2026, demande d'Ahmed) : export « Activité des courses » croisé avec le GPS Geotab.
// Données synthétiques (le vrai export, avec les noms des chauffeurs, n'est jamais dans le dépôt).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), C = require('../site/uberctl_calc.js'), { startSite, openBrowser } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);

// journée synthétique (UTC) : véhicule à Casablanca, un point GPS toutes les 30 s
const D = '2026-11-13', T = hm => Date.parse(D + 'T' + hm + ':00Z');
const PU = { lat: 33.5966875, lon: -7.6121875 };   // plus code H9WQ+M4 (Casablanca)
function track() {
  const g = [], seg = (a, b, from, to) => { for (let t = T(a); t <= T(b); t += 30000) { const k = (t - T(a)) / Math.max(1, T(b) - T(a)), mv = from.lat !== to.lat || from.lon !== to.lon;
    g.push([t, mv ? 40 : 0, from.lat + (to.lat - from.lat) * k, from.lon + (to.lon - from.lon) * k]); } };
  const P0 = { lat: 33.58, lon: -7.62 }, P1 = { lat: 33.60, lon: -7.60 }, FAR = { lat: 33.5900, lon: -7.6122 }, SOUTH = { lat: 33.5500, lon: -7.6400 };
  seg('09:50', '10:00', P0, P0); seg('10:00', '10:20', P0, P1);               // course Uber terminée (10:00 → 10:20)
  seg('10:20', '10:59', FAR, FAR);                                             // garé à 745 m de la prise en charge
  seg('11:00', '11:15', FAR, SOUTH); seg('11:15', '11:40', SOUTH, { lat: 33.5300, lon: -7.6600 });   // annulation à 11:00 : il part ailleurs
  seg('11:40', '12:59', { lat: 33.5300, lon: -7.6600 }, { lat: 33.5300, lon: -7.6600 });
  seg('13:00', '13:10', { lat: 33.6050, lon: -7.6122 }, PU);                  // annulation à 13:00 : il va vers le client
  seg('13:10', '13:40', PU, PU);
  return g;
}
const CSV = rows => '﻿UUID de la course,UUID du chauffeur,Prénom du chauffeur,Nom du chauffeur,UUID du véhicule,Plaque d\'immatriculation,Type de service,Heure de la demande de course,Heure de dépose,Adresse de prise en charge,Lieu de dépose,Distance de la course,Statut de la course,Type de produit,Type de paiement\n'
  + rows.map(r => r.map(x => /[,"]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x).join(',')).join('\n') + '\n';
const ROWS = [
  ['t1', 'd1', 'Alpha', 'Test', 'v1', '86121-T-1', 'personal_transport', D + ' 10:00:00', D + ' 10:20:00', '1 Rue Test, Casablanca', '2 Rue Test, Casablanca', '3.10', 'completed', 'UberX', 'cash'],
  ['t2', 'd1', 'Alpha', 'Test', 'v1', '86121-T-1', 'personal_transport', D + ' 11:00:00', '', 'H9WQ+M4Q, 100 Av. des FAR, Casablanca 20000, Morocco', '', '0.00', 'rider_cancelled', 'UberX', 'braintree'],
  ['t3', 'd1', 'Alpha', 'Test', 'v1', '86121-T-1', 'personal_transport', D + ' 13:00:00', '', 'H9WQ+M4Q, 100 Av. des FAR, Casablanca 20000, Morocco', '', '0.00', 'rider_cancelled', 'UberX', 'cash'],
  ['t4', 'd2', 'Bravo', 'Test', 'v2', 'WW968202', 'personal_transport', D + ' 12:00:00', D + ' 12:30:00', 'Marrakech', 'Marrakech', '5.00', 'completed', 'UberX', 'braintree']];
const parse = csv => { const XLSX = require('xlsx'), wb = XLSX.read(csv.replace(/^﻿/, ''), { type: 'string', raw: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }); };

test('calculs : export lu (heures UTC), plus code, constat de chaque annulation, trajets sans course Uber', () => {
  const r = C.ubcParseTrips(parse(CSV(ROWS)));
  assert.strictEqual(r.rows.length, 4); assert.deepStrictEqual(r.bad, []);
  assert.strictEqual(r.rows[0].requested_at, D + 'T10:00:00.000Z'); assert.strictEqual(r.rows[1].dropoff_at, null); assert.strictEqual(r.rows[0].km, 3.1);
  assert.strictEqual(r.rows[1].driver_name, 'Alpha Test'); assert.match(C.ubcParseTrips([['x', 'y']]).error, /UUID de la course/);
  // plus code court complété avec la position du véhicule
  const pc = C.ubcPlusCode('H9WQ+M4Q, 100 Av. des FAR, Casablanca', { lat: 33.59, lon: -7.61 });
  assert.ok(Math.abs(pc.lat - PU.lat) < 1e-6 && Math.abs(pc.lon - PU.lon) < 1e-6, JSON.stringify(pc));
  const mk = C.ubcPlusCode('HXWV+72F, Marrakesh 40160, Morocco', { lat: 31.63, lon: -8.0 });
  assert.ok(Math.abs(mk.lat - 31.5957) < 1e-3 && Math.abs(mk.lon + 8.0074) < 1e-3, JSON.stringify(mk));
  assert.strictEqual(C.ubcPlusCode('12 Rue Test, Casablanca', { lat: 33, lon: -7 }), null);
  const g = track(), [t1, t2, t3] = r.rows;
  // part ailleurs : à 745 m à la demande, jamais plus près, 5 km plus loin 15 min après
  const c2 = C.ubcCancelCheck(t2, g, PU, false, Date.parse(t3.requested_at));
  assert.strictEqual(c2.v, 'eloigne'); assert.ok(c2.d0 > 650 && c2.d0 < 850, c2.d0); assert.strictEqual(c2.dmin, c2.d0); assert.ok(c2.dend > 4000); assert.ok(C.ubcSuspect(c2.v));
  // va vers le client
  assert.strictEqual(C.ubcCancelCheck(t3, g, PU, false, null).v, 'approche');
  // reste sur place, prise en charge non localisée : « resté sur place », pas « suspect »
  const still = C.ubcCancelCheck(Object.assign({}, t2, { requested_at: D + 'T10:30:00Z' }), g, null, false, null);
  assert.strictEqual(still.v, 'immobile'); assert.ok(!C.ubcSuspect(still.v));
  // course Uber en cours (course enchaînée), nouvelle demande 1 min après (annulation rapide), sans GPS
  assert.strictEqual(C.ubcCancelCheck(t2, g, PU, true, null).v, 'enchainee');
  assert.strictEqual(C.ubcCancelCheck(t2, g, PU, false, Date.parse(t2.requested_at) + 60000).v, 'rapide');
  assert.strictEqual(C.ubcCancelCheck(t2, [], PU, false, null).v, 'nm');
  // adresse localisée à 300 km (homonyme d'une autre ville) : non retenue
  assert.strictEqual(C.ubcCancelCheck(t2, g, { lat: 31.6, lon: -8.0 }, false, null).v, 'roule');
  // trajets sans course Uber : la course 10:00 → 10:20 est « Uber », le trajet de 11:00 à 11:40 ne l'est pas (au-delà des 15 min de l'annulation)
  const od = C.ubcOffDrive(g, [t1, t2, t3], T('09:30'), T('14:00'));
  assert.ok(od.km_uber > 2.5 && od.km_uber < 5, od.km_uber);
  const s = od.segs.find(x => x.a >= D + 'T11:00');
  assert.ok(s && s.km_off >= 1.5 && s.cancels === 1, JSON.stringify(od.segs));
  assert.ok(od.km_off > od.km_uber, 'plus de km sans course Uber que pendant les courses');
  // synthèse par chauffeur
  t2.chk = c2; const st = C.ubcDriverStats([t1, t2, t3], [{ owner: 'd1', km_off: 6.5, cancels: 1 }]).find(o => o.key === 'd1');
  assert.deepStrictEqual([st.n, st.done, st.rcx, st.susp, st.checked, st.offN, st.offKm, st.offCx, Math.round(st.cxRate * 100)], [3, 1, 2, 1, 1, 1, 6.5, 1, 67]);
});

test('base : import par un gestionnaire limité à ses véhicules, réimport sans doublon, constat gardé si la course ne change pas', () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casablanca'), (2, 'Marrakech');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, active, agency_id) values ('968199WW', '86121-T-1', 'STARIA', 'OUI', 1), ('968202WW', 'WW968202', 'SONATA', 'OUI', 2);`);
  try {
    const rows = JSON.stringify(C.ubcParseTrips(parse(CSV(ROWS))).rows).replace(/'/g, "''");
    const r = JSON.parse(as(MGR, `select public.import_uber_trips('${rows}'::jsonb)`));
    assert.deepStrictEqual([r.added, r.skipped, r.no_vehicle], [3, 1, 0], JSON.stringify(r));
    assert.strictEqual(env.psql("select string_agg(uuid || '=' || vehicle_key || '/' || agency_id, ',' order by uuid) from uber_trips"), 't1=968199WW/1,t2=968199WW/1,t3=968199WW/1');
    as(MGR, `update uber_trips set chk = '{"v":"eloigne"}', pu_lat = 33.5, pu_lon = -7.6, pu_prec = 'plus code' where uuid = 't2'`);
    as(MGR, `insert into uber_days (vehicle_key, day, km_uber, km_off) values ('968199WW', '${D}', 3, 6)`);
    // réimport identique : rien ne change, constat gardé
    const r2 = JSON.parse(as(ADMIN, `select public.import_uber_trips('${rows}'::jsonb)`));
    assert.deepStrictEqual([r2.added, r2.updated, r2.same], [1, 0, 3]);
    assert.strictEqual(env.psql("select chk->>'v' from uber_trips where uuid = 't2'"), 'eloigne');
    assert.strictEqual(env.psql('select count(*) from uber_days'), '1');
    // course changée (statut) : constat et journée à refaire
    const ch = rows.replace('"status":"rider_cancelled"', '"status":"driver_cancelled"');
    assert.notStrictEqual(ch, rows);
    assert.strictEqual(JSON.parse(as(MGR, `select public.import_uber_trips('${ch}'::jsonb)`)).updated, 1);
    assert.strictEqual(env.psql("select status || '|' || coalesce(chk->>'v', 'aucun') || '|' || coalesce(pu_prec, '') from uber_trips where uuid = 't2'"), 'driver_cancelled|aucun|plus code');
    assert.strictEqual(env.psql('select count(*) from uber_days'), '0');
    // lecture : le gestionnaire ne voit que son agence ; écriture directe refusée ; anon : rien
    assert.strictEqual(as(MGR, 'select count(*) from uber_trips'), '3');
    assert.throws(() => as(MGR, "update uber_trips set status = 'completed' where uuid = 't2'"), /permission denied/);
    assert.throws(() => env.psql("begin; set local role anon; select count(*) from uber_trips; commit;"), /permission denied/);
    assert.throws(() => env.psql("begin; set local role anon; select public.import_uber_trips('[]'); commit;"), /permission denied/);
  } finally { env.resetDb(); }
});

test('relais ?mode=track : positions GPS d\'une journée au plus, véhicules de ses agences', async () => {
  const L = await import('../supabase/functions/geotab-live/live.mjs');
  const fetchFn = async (url, opt) => {
    if (/geotab\.com\/apiv1$/.test(url)) { const b = JSON.parse(opt.body);
      if (b.method === 'Authenticate') return new Response(JSON.stringify({ result: { path: 'ThisServer', credentials: { sessionId: 'S' } } }));
      return new Response(JSON.stringify({ result: [{ dateTime: '2026-11-13T10:00:30Z', speed: 41.6, latitude: 33.123456, longitude: -7.654321 }, { dateTime: '2026-11-13T10:00:00Z', speed: 0, latitude: 33.1, longitude: -7.6 }] })); }
    if (/\/vehicles\?/.test(url)) return new Response(JSON.stringify([{ key: '968199WW', plate: '86121-T-1', geotab_id: 'b1', active: 'OUI' }]));
    return new Response('[]');
  };
  const call = async qs => { L.resetMemory(); const r = await L.handle(new Request('http://x/functions/v1/geotab-live?' + new URLSearchParams(qs), { headers: { authorization: 'Bearer x' } }),
    { env: k => ({ SUPABASE_REST: 'http://db', SUPABASE_ANON_KEY: 'anon', GEO_USER: 'a', GEO_PWD: 'b' })[k], fetch: fetchFn, now: () => Date.parse('2026-11-14T00:00:00Z') });
    return { status: r.status, body: await r.json() }; };
  const r = await call({ mode: 'track', key: '968199WW', from: '2026-11-13T09:00:00Z', to: '2026-11-13T20:00:00Z' });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.gps, [[Date.parse('2026-11-13T10:00:00Z'), 0, 33.1, -7.6], [Date.parse('2026-11-13T10:00:30Z'), 42, 33.12346, -7.65432]]);
  assert.strictEqual((await call({ mode: 'track', key: 'AUTRE', from: '2026-11-13T09:00:00Z', to: '2026-11-13T20:00:00Z' })).status, 404);
  assert.strictEqual((await call({ mode: 'track', key: '968199WW', from: '2026-11-10T09:00:00Z', to: '2026-11-13T20:00:00Z' })).status, 400, '26 h au plus');
});

test('site : import de l\'export, vérification Geotab, chauffeur suspect, annulations et trajets sans course Uber', async () => {
  env.resetDb();
  env.psql(`insert into vehicles (key, plate, model, active, geotab_id) values ('968199WW', '86121-T-1', 'STARIA', 'OUI', 'b1');`);
  const g = track(), file = path.join(env.OUT, 'trip_activity_test.csv'); fs.writeFileSync(file, CSV(ROWS));
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  let calls = 0;
  try {
    await page.addInitScript(() => { window.__uiDialogs = true; });
    await page.route('**/functions/v1/geotab-live**', r => { const u = new URL(r.request().url()); calls++;
      if (u.searchParams.get('mode') !== 'track') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"vehicles":[],"events":[]}' });
      const a = Date.parse(u.searchParams.get('from')), b = Date.parse(u.searchParams.get('to'));
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ gps: g.filter(p => p[0] >= a && p[0] <= b) }) }); });
    await page.route('**/photon.komoot.io/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[]}' }));
    await page.goto('http://localhost:8080/#/uberctl?t=import');
    await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
    await page.waitForSelector('#ubxfile', { state: 'attached' });
    await page.setInputFiles('#ubxfile', file);
    await page.waitForSelector('#ubxres .msg.ok');
    assert.match(await page.innerText('#ubxres'), /4 courses lues \(13\/11\/2026 11:00 → 13\/11\/2026 14:00\)[\s\S]*4 nouvelles[\s\S]*1 sur une plaque inconnue de Ludy/);
    // vérification Geotab terminée : constats enregistrés
    for (let i = 0; i < 60 && env.psql("select count(*) from uber_trips where chk is not null") !== '2'; i++) await page.waitForTimeout(250);
    assert.strictEqual(env.psql("select string_agg(uuid || '=' || (chk->>'v') || '/' || pu_prec, ',' order by uuid) from uber_trips where chk is not null"), 't2=eloigne/plus code,t3=approche/plus code');
    for (let i = 0; i < 40 && env.psql('select count(*) from uber_days') !== '1'; i++) await page.waitForTimeout(250);
    assert.match(env.psql("select (km_off > km_uber)::text || '|' || jsonb_array_length(segs) from uber_days"), /^true\|[1-9]/);
    assert.strictEqual(calls >= 1, true);
    // synthèse : le chauffeur, 2 annulations sur 3, 1 où le véhicule n'est pas allé vers le client
    await page.goto('http://localhost:8080/#/uberctl');
    await page.waitForSelector('#tubs');
    const row = await page.innerText('#tubs tbody tr');
    assert.match(row, /Alpha Test[\s\S]*86121-T-1[\s\S]*\b3\b[\s\S]*67 %/);
    assert.match(await page.innerText('.cards'), /Véhicule pas allé vers le client\s*1|1\s*Véhicule pas allé vers le client/);
    await page.click('#tubs tbody tr a');
    await page.waitForSelector('#tubc');
    assert.match(await page.innerText('#tubc'), /S'est éloigné de la prise en charge[\s\S]*à 7\d\d m de la prise en charge/);
    assert.match(await page.innerText('#tubc'), /S'est approché de la prise en charge/);
    await page.goto('http://localhost:8080/#/uberctl?t=hors');
    await page.waitForSelector('#tubh');
    assert.match(await page.innerText('#tubh'), /Alpha Test/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
