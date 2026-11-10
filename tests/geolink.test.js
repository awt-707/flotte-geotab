// Association aux boîtiers Geotab, complément du moteur v6 (collector/src/21_geolink.gs) : signalé par Ahmed le 01/11/2026,
// véhicules « Non relié à Geotab » alors que le boîtier est présent et en ligne dans Geotab (boîtier installé après l'ajout au parc,
// VIN lu par le boîtier seulement, plaque écrite autrement dans le nom du boîtier). Boîtiers synthétiques ajoutés au faux Geotab.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env');

const EXTRA = [
  { id: 'bX1', name: 'Santa Fe 12345 | أ | 40', licensePlate: '', vehicleIdentificationNumber: '', activeTo: '2050-01-01T00:00:00.000Z' },
  { id: 'bX2', name: 'SANTA FE 2', licensePlate: '', vehicleIdentificationNumber: '', engineVehicleIdentificationNumber: 'KMHS381ABTU000002', activeTo: '2050-01-01T00:00:00.000Z' },
  { id: 'bX3', name: '34567-ه-1', licensePlate: '', vehicleIdentificationNumber: '', activeTo: '2050-01-01T00:00:00.000Z' },
  { id: 'bX4', name: '45678-A-6', licensePlate: '', activeTo: '2050-01-01T00:00:00.000Z' },
  { id: 'bX5', name: 'Clicar 45678 A 6 bis', licensePlate: '', activeTo: '2050-01-01T00:00:00.000Z' },
  { id: 'bX6', name: 'RAV4 99999-B-6', licensePlate: '', activeTo: '2050-01-01T00:00:00.000Z' },
  { id: 'bOld', name: '56789-A-6', licensePlate: '', activeTo: '2020-01-01T00:00:00.000Z' }
];

test('boîtiers Geotab : VIN lu par le boîtier, plaque dans le nom, lettre arabe, ambiguïté refusée, choix manuel, nouvel essai', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 9, 4, 12, 0));
  env.psql(`insert into parc (plate, brand, model, vin, fuel) values ('WW968194', 'HYUNDAI', 'SONATA', 'KMHL341JBRA084312', 'EH'),
    ('12345-A-40', 'HYUNDAI', 'SANTA FE', null, 'ES'), ('23456-B-6', 'HYUNDAI', 'SANTA FE', 'KMHS381ABTU000002', 'ES'),
    ('34567-D-1', 'HYUNDAI', 'SANTA FE', null, 'ES'), ('45678-A-6', 'HYUNDAI', 'SANTA FE', null, 'ES'), ('56789-A-6', 'HYUNDAI', 'SANTA FE', null, 'ES')`);
  // boîtiers pas encore dans Geotab à l'ajout au parc : rien d'associé par le moteur v6
  B.run('importVehicles(true)');
  const geo = () => Object.fromEntries(env.psql("select key || '=' || coalesce(geotab_id, '') from vehicles order by key").split('\n').filter(Boolean).map(x => x.split('=')));
  assert.deepStrictEqual(geo(), { '1234540A': '', '234566B': '', '345671D': '', '456786A': '', '567896A': '', '968194WW': 'b1861' });
  // boîtiers installés ensuite (et un autre véhicule Clicar de la même base)
  B.ctx.__extra = EXTRA;
  B.run(`var __g0 = geoCall_; geoCall_ = function (m, p) { const r = __g0(m, p); return m === 'Get' && p && p.typeName === 'Device' ? r.concat(__extra) : r; }`);
  const m = B.run('geoLinkStep_()');
  assert.match(m, /12345-A-40 → Santa Fe/);
  const g = geo();
  assert.strictEqual(g['1234540A'], 'bX1', 'plaque avec lettre arabe dans le nom du boîtier');
  assert.strictEqual(g['234566B'], 'bX2', 'VIN lu par le boîtier (engineVehicleIdentificationNumber)');
  assert.strictEqual(g['345671D'], 'bX3', 'même numéro et même région, lettre différente / illisible');
  assert.strictEqual(g['456786A'], '', 'deux boîtiers possibles : rien d\'associé');
  assert.strictEqual(g['567896A'], '', 'boîtier désactivé ignoré');
  assert.strictEqual(g['968194WW'], 'b1861', 'association du moteur v6 inchangée');
  assert.match(env.psql("select detail from logs where action = 'Association Geotab (complément)' order by id desc limit 1"), /sans boîtier : 45678-A-6, 56789-A-6/);
  // boîtiers libres publiés pour la page Véhicules (jamais les boîtiers associés)
  const free = JSON.parse(env.psql("select value from params where key = 'geotabDevices'")).list.map(d => d.id).sort();
  assert.deepStrictEqual(free, ['b185C', 'bX4', 'bX5', 'bX6']);   // b185C : boîtier réel du faux Geotab, véhicule pas dans ce parc
  assert.strictEqual(env.psql("select value from params where key = 'geotabManual'"), '{}');
  // nouvel essai seulement toutes les 30 minutes
  assert.strictEqual(B.run('geoLinkStep_()'), '');
  // choix de l'administrateur : appliqué au passage suivant, prioritaire
  env.psql(`update params set value = '{"456786A":"bX5"}' where key = 'geotabManual'`);
  assert.match(B.run('geoLinkStep_()'), /45678-A-6 → Clicar 45678 A 6 bis \(choisi sur le site\)/);
  assert.strictEqual(geo()['456786A'], 'bX5');
  // import du parc du lendemain (moteur v6 puis complément) : associations gardées
  B.run('importVehiclesLink_()');
  const g2 = geo();
  assert.deepStrictEqual([g2['1234540A'], g2['234566B'], g2['345671D'], g2['456786A']], ['bX1', 'bX2', 'bX3', 'bX5']);
  // live_status : plus « Non relié à Geotab » pour les véhicules associés
  B.run('memoClear_(); writeLive_({})');
  assert.strictEqual(env.psql("select state from live_status where vehicle_key = '1234540A'"), 'Pas de réponse Geotab');
  assert.strictEqual(env.psql("select state from live_status where vehicle_key = '567896A'"), 'Non relié à Geotab');
});

test('liste des boîtiers libres : plaques marocaines d\'abord (la base Geotab compte des centaines de véhicules d\'autres flottes)', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 10, 10, 12, 0));
  // 320 boîtiers à plaque française vus récemment + 2 boîtiers de la flotte (plaques WW), sans relevé récent : avant, hors des 300 premiers
  const fr = Array.from({ length: 320 }, (_, i) => ({ id: 'bF' + i, name: 'H' + String.fromCharCode(65 + i % 26) + '-' + String(100 + i).slice(-3) + '-QM', licensePlate: '' }));
  const ma = [{ id: 'bM1', name: '968209 WW', licensePlate: '' }, { id: 'bM2', name: 'Sonata', licensePlate: 'WW968210' }];
  B.ctx.__devs = fr.concat(ma);
  B.run(`geoCall_ = function (m, p) { return m === 'Get' && p.typeName === 'DeviceStatusInfo' ? __devs.filter(d => d.id.startsWith('bF')).map(d => ({ device: { id: d.id }, dateTime: '2026-11-10T11:59:00Z', isDeviceCommunicating: true })) : []; }; geoPublishFree_(__devs, [])`);
  const list = JSON.parse(env.psql("select value from params where key = 'geotabDevices'")).list;
  assert.strictEqual(list.length, 300);
  assert.deepStrictEqual(list.slice(0, 2).map(d => d.id).sort(), ['bM1', 'bM2']);
  assert.ok(!('ma' in list[0]));
});

test('plaques lues dans un texte libre (nom, plaque, commentaire du boîtier)', () => {
  const { collector } = require('./lib/v6');
  const B = collector(Date.UTC(2026, 9, 4, 12, 0));
  const P = s => JSON.parse(B.run('JSON.stringify(geoPlatesIn_(' + JSON.stringify(s) + ').map(p => p.k))'));
  assert.ok(P('86120-T-1').includes('861201T'));
  assert.ok(P('Staria 86120 T 1').includes('861201T'));
  assert.ok(P('86120-ط-1').includes('861201T'));
  assert.ok(P('WW-968194').includes('968194WW'));
  assert.ok(P('968194 WW').includes('968194WW'));
  assert.deepStrictEqual(P(''), []);
});

test('page Véhicules : véhicule sans boîtier signalé, boîtier choisi par l\'administrateur (param geotabManual + demande au collecteur)', async () => {
  const { startSite, openBrowser, login } = require('./lib/browser');
  env.resetDb();
  env.psql(`insert into vehicles (key, plate, model, active, geotab_id, geotab_name) values ('968194WW', 'WW968194', 'SONATA', 'OUI', 'b1861', '86431-T-1'), ('1234540A', '12345-A-40', 'SANTA FE', 'OUI', null, null);
    insert into params (key, value) values ('geotabDevices', '{"at":"2026-11-01T10:00:00Z","list":[{"id":"bX1","n":"Santa Fe 1","p":"","v":"KMHS381ABTU000001","s":"G9","t":"2026-11-01T09:58:00Z","on":true}]}'),
      ('geotabManual', '{}') on conflict (key) do update set value = excluded.value`);
  const srv = await startSite();
  const { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/vehicules');
    await page.waitForSelector('#tvh');
    assert.match(await page.innerText('#page'), /1 véhicule sans boîtier Geotab \(12345-A-40\)/);
    const opts = await page.locator('select.vgeo[data-k="1234540A"] option').allInnerTexts();
    assert.match(opts.join('|'), /Santa Fe 1 · VIN …000001 · vu 01\/11\/2026/);
    await page.selectOption('select.vgeo[data-k="1234540A"]', 'bX1');
    await page.waitForFunction(() => /Boîtier choisi pour 1234540A/.test(document.querySelector('#vres').innerText), null, { timeout: 15000 });
    assert.strictEqual(env.psql("select value from params where key = 'geotabManual'"), '{"1234540A":"bX1"}');
    assert.match(env.psql('select kind from jobs'), /import_vehicles/);
    assert.match(await page.innerText('#tvh'), /boîtier choisi, associé au prochain passage/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.resetDb(); }
});
