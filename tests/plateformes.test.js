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
    assert.match(t, /Uber en ce moment[\s\S]*3\s*En ligne\s*1\s*En route vers le client\s*1\s*En course\s*1\s*Disponibles/);
    await page.click('#liveplat details summary');
    assert.match(await page.innerText('#liveplat table'), /BETA Test[\s\S]*030071WW[\s\S]*En route vers le client[\s\S]*ALPHA Test[\s\S]*En course[\s\S]*GAMMA Test[\s\S]*Disponible/);
    // lecture arrêtée : plus aucun relevé depuis 10 min
    env.psql("update public.fleet_latest set observed_at = now() - interval '10 minutes'");
    await page.evaluate(async () => { await pfLoad(); pfPaint(); });
    assert.match(await page.innerText('#liveplat'), /Lecture de Uber arrêtée depuis le [\s\S]*chiffres pas à jour[\s\S]*—\s*En ligne/);
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); env.psql("drop table if exists public.fleet_latest, public.fleet_drivers; notify pgrst, 'reload schema';"); env.resetDb(); }
});
