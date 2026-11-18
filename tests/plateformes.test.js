// Chauffeurs Uber / Bolt en ce moment sur la page En direct (18/11/2026, demande d'Ahmed : en ligne, en route vers le client, en course,
// lus sur l'écran Uber Fleet par l'application de bureau). Données synthétiques uniquement.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), P = require('../site/plateformes_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const { execSync } = require('child_process');

test('comptes par plateforme : en ligne, vers le client, en course, disponibles ; chauffeur plus vu = pas compté ; lecture arrêtée = pas à jour', () => {
  const now = Date.parse('2026-11-18T18:20:00Z'), ago = s => new Date(now - s * 1000).toISOString();
  const drivers = [{ id: 'a', name: 'ALPHA', agency_id: 2 }, { id: 'b', name: 'BETA', agency_id: 2 }, { id: 'c', name: 'GAMMA', agency_id: 1 }, { id: 'd', name: 'DELTA', agency_id: 2 }, { id: 'e', name: 'EPS', agency_id: 2 }];
  const latest = [
    { driver_id: 'a', source: 'uber', status: 'on_trip', observed_at: ago(5), vehicle_label: '030070WW' },
    { driver_id: 'b', source: 'uber', status: 'to_pickup', observed_at: ago(10), vehicle_label: '030071WW' },
    { driver_id: 'c', source: 'uber', status: 'available', observed_at: ago(3), vehicle_label: '968205WW' },
    { driver_id: 'd', source: 'uber', status: 'available', observed_at: ago(600), vehicle_label: '030072WW' },   // plus vu depuis 10 min
    { driver_id: 'e', source: 'uber', status: 'unknown', observed_at: ago(20), vehicle_label: '030073WW', evidence: { raw_state: 'Pastille #545454' } },
    { driver_id: 'a', source: 'bolt', status: 'offline', observed_at: ago(5) }];
  const s = P.pfSummary(latest, drivers, { now });
  assert.deepStrictEqual([s.uber.online, s.uber.to_pickup, s.uber.on_trip, s.uber.available, s.uber.unknown, s.uber.stale], [4, 1, 1, 1, 1, false]);
  assert.deepStrictEqual(s.uber.list.map(x => x.name + ':' + x.status), ['BETA:to_pickup', 'ALPHA:on_trip', 'GAMMA:available', 'EPS:unknown']);
  assert.deepStrictEqual([s.bolt.online, s.bolt.stale, s.bolt.seen], [0, false, true], 'Bolt : tous hors ligne, lecture à jour');
  const m = P.pfSummary(latest, drivers, { now, keep: d => d && d.agency_id === 2 });
  assert.deepStrictEqual([m.uber.online, m.uber.available], [3, 0], 'agence de Marrakech seulement');
  const old = P.pfSummary(latest, drivers, { now: now + 10 * 60000 });
  assert.deepStrictEqual([old.uber.online, old.uber.stale], [0, true], 'aucune lecture depuis 10 min : rien compté, chiffres pas à jour');
});

test('page En direct : bloc « Uber en ce moment » (chiffres et liste des chauffeurs), lecture arrêtée signalée', async () => {
  env.resetDb();
  // tables de l'application de bureau (absentes des migrations de Ludy) : créées pour le test
  env.psql(`create table if not exists public.fleet_drivers (id uuid primary key, name text, ludy_driver_code text, vehicle_key text, agency_id bigint);
    create table if not exists public.fleet_latest (identity_id uuid, driver_id uuid, source text, status text, observed_at timestamptz, vehicle_label text, evidence jsonb default '{}');
    grant select on public.fleet_drivers, public.fleet_latest to authenticated;
    truncate public.fleet_drivers, public.fleet_latest;
    insert into vehicles (key, plate, model, active) values ('030070WW', 'WW030070', 'RAV4', 'OUI'), ('030071WW', 'WW030071', 'RAV4', 'OUI'), ('030075WW', 'WW030075', 'RAV4', 'OUI');
    insert into live_status (vehicle_key, plate, model, state, speed, lat, lon, updated_at) values ('030070WW', 'WW030070', 'RAV4', 'En route', 42, 31.62, -8.01, now()),
      ('030071WW', 'WW030071', 'RAV4', 'En route', 30, 31.63, -8.02, now()), ('030075WW', 'WW030075', 'RAV4', 'Garé', 0, 31.64, -8.03, now()),
      ('030076WW', 'WW030076', 'RAV4', 'En route', 55, 31.65, -8.04, now()), ('030077WW', 'WW030077', 'RAV4', 'Garé', 0, 31.66, -8.05, now());
    insert into vehicles (key, plate, model, active) values ('030076WW', 'WW030076', 'RAV4', 'OUI'), ('030077WW', 'WW030077', 'RAV4', 'OUI');
    insert into drivers (code, name) values ('D6', 'DELTA Test'), ('D7', 'EPSILON Test');
    insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('K6', 'D6', 'DELTA Test', 'WW030076', '030076WW', now() - interval '2 hours'),
      ('K7', 'D7', 'EPSILON Test', 'WW030077', '030077WW', now() - interval '2 hours');
    insert into public.fleet_drivers (id, name, ludy_driver_code) values ('00000000-0000-0000-0000-00000000000e', 'EPSILON T.', 'D7');
    insert into public.fleet_latest (driver_id, source, status, observed_at, vehicle_label) values ('00000000-0000-0000-0000-00000000000e', 'uber', 'available', now() - interval '6 seconds', '99999-A-1');
    insert into public.fleet_drivers (id, name, agency_id) values ('00000000-0000-0000-0000-00000000000a', 'ALPHA Test', null), ('00000000-0000-0000-0000-00000000000b', 'BETA Test', null), ('00000000-0000-0000-0000-00000000000c', 'GAMMA Test', null);
    insert into public.fleet_latest (driver_id, source, status, observed_at, vehicle_label) values
      ('00000000-0000-0000-0000-00000000000a', 'uber', 'on_trip', now() - interval '5 seconds', '030070WW'),
      ('00000000-0000-0000-0000-00000000000b', 'uber', 'to_pickup', now() - interval '8 seconds', '030071WW'),
      ('00000000-0000-0000-0000-00000000000c', 'uber', 'available', now() - interval '10 seconds', '030072WW');
    notify pgrst, 'reload schema';`);
  execSync('sleep 1.5');
  const srv = await startSite(), { br, page, errors } = await openBrowser();
  try {
    await login(page, '#/direct');
    await page.waitForSelector('#liveplat .pfblk');
    const t = await page.innerText('#liveplat');
    assert.match(t, /Uber en ce moment[\s\S]*4\s*En ligne\s*1\s*En route vers le client\s*1\s*En course\s*2\s*Disponibles/);
    await page.click('#liveplat details summary');
    assert.match(await page.innerText('#liveplat table'), /BETA Test[\s\S]*030071WW[\s\S]*En route vers le client[\s\S]*ALPHA Test[\s\S]*En course[\s\S]*GAMMA Test[\s\S]*Disponible/);
    // carte et cartes véhicules : état Uber du véhicule (plaque lue sur l'écran Uber Fleet)
    await page.waitForFunction(() => /Uber · En course/.test((document.querySelector('.vcard[data-vk="030070WW"]') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030071WW"]'), /Uber · Vers le client/);
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030075WW"]'), /Uber ·/, 'véhicule pas en ligne sur Uber : rien');
    const lbl = await page.evaluate(() => LIVE.markers['030070WW'].getElement().innerText);
    assert.match(lbl, /WW030070 · 42 km\/h\s*Uber · En course/);
    assert.match(await page.evaluate(() => LIVE.markers['030071WW'].getTooltip().getContent()), /Uber : <b>En route vers le client<\/b> · BETA Test/);
    // sous contrat, pas en ligne : « Hors ligne », en rouge s'il roule ; chauffeur en ligne avec un autre véhicule : jamais « hors ligne »
    await page.waitForFunction(() => /Hors ligne · roule/.test((document.querySelector('.vcard[data-vk="030076WW"]') || {}).innerText || ''));
    assert.match(await page.innerText('.vcard[data-vk="030077WW"]'), /Uber · Disponible · autre véhicule/);
    assert.match(await page.innerText('#liveplat'), /Sous contrat mais déconnectés d'Uber et de Bolt\s*1\s*Déconnectés \(sous contrat\)\s*1\s*Déconnectés et qui roulent[\s\S]*WW030076[\s\S]*DELTA Test[\s\S]*En route · 55 km\/h/);
    // lecture arrêtée : plus aucun relevé depuis 10 min
    env.psql("update public.fleet_latest set observed_at = now() - interval '10 minutes'");
    await page.evaluate(async () => { await pfLoad(); pfPaint(); });
    assert.match(await page.innerText('#liveplat'), /Lecture de Uber arrêtée depuis le [\s\S]*chiffres pas à jour[\s\S]*—\s*En ligne/);
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030070WW"]'), /Uber ·/, 'lecture arrêtée : plus de pastille sur la carte');
    assert.doesNotMatch(await page.innerText('.vcard[data-vk="030076WW"]'), /Hors ligne/, 'lecture arrêtée : jamais « hors ligne » supposé');
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql("drop table if exists public.fleet_latest, public.fleet_drivers; notify pgrst, 'reload schema';"); env.resetDb(); }
});
