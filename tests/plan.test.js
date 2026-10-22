// Planning des chauffeurs : génération de la semaine, repos, absences, contrôle, textes à partager ; droits de la base ; page.
// Données synthétiques.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), P = require('../site/plan_calc.js'), { startSite, openBrowser, login } = require('./lib/browser');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const MON = '2026-10-26', DAYS = P.planWeekDays(MON);
const VEH = [{ key: 'V1', plate: 'WW1' }, { key: 'V2', plate: 'WW2' }];
// 6 chauffeurs habituels (V1/V2 × jour/nuit + 2 remplaçants), repos décalés
const DRV = [
  { code: 'A', name: 'Ali', shift: 'Jour', vehicle: 'V1', off: [1, 2] }, { code: 'B', name: 'Badr', shift: 'Nuit', vehicle: 'V1', off: [3, 4] },
  { code: 'C', name: 'Chaimae', shift: 'Jour', vehicle: 'V2', off: [5, 6] }, { code: 'D', name: 'Driss', shift: 'Nuit', vehicle: 'V2', off: [6, 7] },
  { code: 'E', name: 'Ehab', shift: 'Jour', vehicle: '', off: [3, 4] }, { code: 'F', name: 'Fouad', shift: 'Nuit', vehicle: '', off: [1, 2] },
  { code: 'G', name: 'Ghali', shift: '', vehicle: '', off: [7, 1] }];

test('génération : chauffeur habituel d\'abord, remplaçant les jours de repos, jamais au repos, absent, 2 fois le même jour ou en jour après une nuit', () => {
  const g = P.planWeek({ days: DAYS, vehicles: VEH, drivers: DRV, absent: {}, locked: [], prevNight: [] });
  const at = (d, s, v) => (g.cells.find(c => c.day === DAYS[d] && c.shift === s && c.vehicle_key === v) || {}).driver_code;
  assert.strictEqual(g.cells.length, 2 * 2 * 7);
  assert.strictEqual(at(2, 'Jour', 'V1'), 'A', 'mercredi : Ali sur son véhicule');
  assert.notStrictEqual(at(0, 'Jour', 'V1'), 'A', 'lundi : Ali au repos');
  assert.strictEqual(at(0, 'Jour', 'V1'), 'E', 'remplaçant de jour d\'abord');
  assert.strictEqual(at(0, 'Nuit', 'V1'), 'B');
  // aucune règle enfreinte, et tout est couvert avec 7 chauffeurs pour 2 véhicules (besoin 6)
  assert.deepStrictEqual(P.planCheck(g.cells, DRV, {}, []), {});
  assert.strictEqual(g.unfilled, 0);
  assert.ok(Object.values(g.count).every(n => n <= 5));
  assert.strictEqual(P.planNeed(2), 6);
});

test('absence : seules les cases de l\'absent changent ; case modifiée à la main gardée ; non couvert si personne', () => {
  const base = P.planWeek({ days: DAYS, vehicles: VEH, drivers: DRV, absent: {}, locked: [], prevNight: [] }).cells;
  const absent = { A: { [DAYS[2]]: 'maladie' } };
  const keep = base.filter(c => c.driver_code && !(c.driver_code === 'A' && c.day === DAYS[2]));
  const g = P.planWeek({ days: DAYS, vehicles: VEH, drivers: DRV, absent, locked: keep, prevNight: [] });
  const diff = g.cells.filter(c => (base.find(b => b.day === c.day && b.shift === c.shift && b.vehicle_key === c.vehicle_key) || {}).driver_code !== c.driver_code);
  assert.strictEqual(diff.length, 1, 'continuité : une seule case remplacée');
  assert.strictEqual(diff[0].day, DAYS[2]); assert.notStrictEqual(diff[0].driver_code, 'A'); assert.ok(diff[0].driver_code);
  // trois véhicules avec deux chauffeurs : cases non couvertes signalées
  const g2 = P.planWeek({ days: DAYS, vehicles: VEH.concat([{ key: 'V3', plate: 'WW3' }]), drivers: DRV.slice(0, 2), absent: {}, locked: [], prevNight: [] });
  assert.ok(g2.unfilled > 0);
  const w = P.planCheck(g2.cells, DRV.slice(0, 2), {}, []);
  assert.ok(Object.values(w).some(x => x.indexOf('non couvert') >= 0));
  // contrôle d'une saisie à la main : repos, absent, deux shifts le même jour, jour après une nuit
  const bad = [{ day: DAYS[0], shift: 'Jour', vehicle_key: 'V1', driver_code: 'A' }, { day: DAYS[0], shift: 'Nuit', vehicle_key: 'V2', driver_code: 'A' },
    { day: DAYS[1], shift: 'Jour', vehicle_key: 'V1', driver_code: 'B' }, { day: DAYS[0], shift: 'Nuit', vehicle_key: 'V1', driver_code: 'B' }];
  const c = P.planCheck(bad, DRV, { A: { [DAYS[0]]: 'x' } }, []);
  assert.deepStrictEqual(c[DAYS[0] + '|Jour|V1'], ['jour de repos', 'absent', 'deux shifts le même jour']);
  assert.deepStrictEqual(c[DAYS[1] + '|Jour|V1'], ['sans repos après une nuit']);
});

test('repos répartis automatiquement : deux jours consécutifs, étalés sur la semaine', () => {
  const ds = Array.from({ length: 7 }, (x, i) => ({ code: 'X' + i, shift: 'Jour', vehicle: 'V' + (i % 3), off: [] }));
  const m = P.planAutoOff(ds), load = [0, 0, 0, 0, 0, 0, 0, 0];
  Object.values(m).forEach(p => { assert.strictEqual(p.length, 2); assert.strictEqual(p[1], p[0] % 7 + 1); p.forEach(w => load[w]++); });
  assert.deepStrictEqual(load.slice(1), [2, 2, 2, 2, 2, 2, 2], '7 chauffeurs : chaque jour, 2 au repos');
});

test('textes à partager : semaine de l\'agence, planning individuel, veille de shift', () => {
  const cells = P.planWeek({ days: DAYS, vehicles: VEH, drivers: DRV, absent: {}, locked: [], prevNight: [] }).cells;
  const o = { monday: MON, cells, names: Object.fromEntries(DRV.map(d => [d.code, d.name])), plates: { V1: 'WW1', V2: 'WW2' }, phones: { A: '0611111111' }, P: { shiftDay: 7, shiftNight: 19 }, agency: 'Casa' };
  const w = P.planWeekText(o);
  assert.match(w, /semaine du 26\/10 au 01\/11 · Casa/);
  assert.match(w, /\*Mercredi 28\/10\*\n☀️ Jour \(07:00 → 19:00\) : WW1 Ali · WW2 Chaimae/);
  const a = P.planDriverText(o, 'A');
  assert.match(a, /Bonjour Ali/); assert.match(a, /Lundi 26\/10 : repos/); assert.match(a, /Mercredi 28\/10 : ☀️ Jour 07:00 → 19:00 · WW1/);
  assert.match(P.planEveText(o, DAYS[2], 'Jour'), /Shift jour du mercredi 28\/10 · 07:00 → 19:00 · Casa\n\nWW1 : Ali \(0611111111\)/);
  assert.match(P.planEveDriverText(o, DAYS[2], 'Nuit', { driver_code: 'B', vehicle_key: 'V1' }), /mercredi 28\/10 tu es en shift nuit \(19:00 → 07:00\) sur le véhicule WW1/);
});

const setup = () => {
  env.resetDb();
  env.psql(`insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'mgr@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Casa'), (2, 'Rabat'); insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into params (key, label, value) values ('planManagersEdit', 'x', 'oui');
    insert into vehicles (key, plate, model, active, agency_id) values ('V1', 'WW1', 'STARIA', 'OUI', 1), ('V2', 'WW2', 'SONATA', 'OUI', 1), ('V9', 'WW9', 'STARIA', 'OUI', 2);
    insert into drivers (code, name, phone, status, agency_id, last_contract) values ${DRV.map(d => `('${d.code}', '${d.name}', '06${d.code.charCodeAt(0)}000000', 'ACTIF', 1, now())`).join(', ')}, ('Z', 'Zakaria', '0600000099', 'ACTIF', 2, now());
    insert into driver_roster (driver_code, agency_id, shift, vehicle_key, off_days) values ${DRV.map(d => `('${d.code}', 1, ${d.shift ? `'${d.shift}'` : 'null'}, ${d.vehicle ? `'${d.vehicle}'` : 'null'}, '{${d.off.join(',')}}')`).join(', ')};`);
};

test('base : planning lu et modifié par l\'agence seulement, semaine verrouillée par l\'administrateur, gestionnaires bloqués par le réglage, historique', () => {
  setup();
  try {
    const cells = JSON.stringify([{ day: DAYS[0], shift: 'Jour', vehicle_key: 'V1', driver_code: 'E', locked: true }]);
    assert.deepStrictEqual(JSON.parse(as(MGR, `select plan_save(1, '${DAYS[0]}', '${DAYS[6]}', '${cells}')`)), { cells: 1, changed: 1 });
    assert.throws(() => as(MGR, `select plan_save(2, '${DAYS[0]}', '${DAYS[6]}', '[]')`), /non autorisée/);
    assert.throws(() => as(MGR, "insert into driver_roster (driver_code, agency_id) values ('Z', 2)"), /row-level security/);
    assert.strictEqual(as(MGR, 'select count(*) from drivers where agency_id = 2 or code = \'Z\''), '0');
    // semaine verrouillée : seul l'administrateur peut la verrouiller et la modifier
    assert.throws(() => as(MGR, `select plan_week_set(1, '${MON}', 'verrouiller')`), /réservé à l'administrateur/);
    as(ADMIN, `select plan_week_set(1, '${MON}', 'verrouiller')`);
    assert.throws(() => as(MGR, `select plan_save(1, '${DAYS[0]}', '${DAYS[6]}', '[]')`), /verrouillée/);
    as(ADMIN, `select plan_save(1, '${DAYS[0]}', '${DAYS[6]}', '[]')`);
    as(ADMIN, `select plan_week_set(1, '${MON}', 'déverrouiller')`);
    // réglage : gestionnaires en lecture seule
    env.psql("update params set value = 'non' where key = 'planManagersEdit'");
    assert.throws(() => as(MGR, `select plan_save(1, '${DAYS[0]}', '${DAYS[6]}', '[]')`), /non autorisée/);
    assert.strictEqual(as(MGR, "select plan_can_edit(1, '" + MON + "')"), 'f');
    env.psql("update params set value = 'oui' where key = 'planManagersEdit'");
    as(MGR, "insert into driver_absences (agency_id, driver_code, day_from, day_to, reason) values (1, 'A', '" + DAYS[2] + "', '" + DAYS[2] + "', 'maladie')");
    assert.match(as(ADMIN, "select string_agg(action, ',' order by id) from plan_log where agency_id = 1"), /^(chauffeur insert,){7}modification,verrouiller,modification,déverrouiller,absence insert$/);
    assert.throws(() => env.psql('begin; set local role anon; select count(*) from driver_plan; commit;'), /permission denied/);
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'`); }
});

test('page Planning chauffeurs : générer la semaine, case modifiée gardée, absence remplacée, WhatsApp individuel, veille de shift', async () => {
  setup();
  const srv = await startSite(), { br, page, errors } = await openBrowser({ acceptDownloads: true });
  try {
    await login(page, '#/plan?a=1&w=' + MON);
    await page.waitForSelector('#plgen');
    await page.click('#plgen');
    await page.waitForFunction(() => document.querySelectorAll('.plgrid input[data-k]').length === 28 && [...document.querySelectorAll('.plgrid input[data-k]')].every(i => i.value));
    assert.strictEqual(env.psql(`select count(*) || '|' || count(driver_code) from driver_plan where agency_id = 1`), '28|28');
    assert.strictEqual(env.psql(`select driver_code from driver_plan where day = '${DAYS[2]}' and shift = 'Jour' and vehicle_key = 'V1'`), 'A');
    // case modifiée à la main : verrouillée, gardée par une nouvelle génération
    const k = `${DAYS[3]}|Jour|V2`;
    await page.fill(`input[data-k="${k}"]`, 'Ghali'); await page.dispatchEvent(`input[data-k="${k}"]`, 'change');
    await page.waitForFunction(k => { const i = document.querySelector(`input[data-k="${k}"]`); return i && i.value === 'Ghali' && i.parentElement.querySelector('.pllock'); }, k);
    await page.click('#plgen');
    await page.waitForSelector('#plgen');
    assert.strictEqual(env.psql(`select driver_code || '|' || locked from driver_plan where day = '${DAYS[3]}' and shift = 'Jour' and vehicle_key = 'V2'`), 'G|true');
    // planning individuel sur WhatsApp : lien vers le numéro du chauffeur avec son planning
    const href = await page.getAttribute('#tpldrv a[href*="wa.me/212"]', 'href');
    assert.match(decodeURIComponent(href), /wa\.me\/2126\d+\?text=Bonjour .+, voici ton planning de la semaine du 26\/10 au 01\/11/);
    // absence : Ali absent mercredi → remplacé, le reste ne bouge pas
    const before = env.psql(`select string_agg(day || shift || vehicle_key || coalesce(driver_code, '-'), ',' order by day, shift, vehicle_key) from driver_plan where not (day = '${DAYS[2]}' and driver_code = 'A')`);
    await page.goto(page.url().replace(/#.*/, '') + '#/plan?t=absences&a=1&w=' + MON);
    await page.waitForSelector('#plasave');
    await page.fill('#pla', 'Ali'); await page.fill('#plf1', DAYS[2]); await page.fill('#plf2', DAYS[2]); await page.fill('#plr', 'maladie');
    await page.click('#plasave');
    await page.waitForFunction(() => /Remplacements/.test((document.querySelector('#plares') || {}).innerText || ''));
    const rep = env.psql(`select driver_code from driver_plan where day = '${DAYS[2]}' and shift = 'Jour' and vehicle_key = 'V1'`);
    assert.ok(rep && rep !== 'A', 'Ali remplacé : ' + rep);
    const after = env.psql(`select string_agg(day || shift || vehicle_key || coalesce(driver_code, '-'), ',' order by day, shift, vehicle_key) from driver_plan where not (day = '${DAYS[2]}' and shift = 'Jour' and vehicle_key = 'V1')`);
    assert.strictEqual(after, before.split(',').filter(x => !x.startsWith(DAYS[2] + 'JourV1')).join(','), 'continuité : seule la case d\'Ali change');
    // veille de shift : liste du shift avec rappel WhatsApp individuel
    await page.goto(page.url().replace(/#.*/, '') + `#/plan?t=veille&a=1&w=${MON}&jour=${DAYS[4]}&s=Nuit`);
    await page.waitForSelector('#tpleve');
    assert.match(await page.innerText('.pltxt'), /Shift nuit du vendredi 30\/10 · 19:00 → 07:00 · Casa\n\nWW1 : Badr/);
    assert.ok(await page.$('#tpleve a[href*="wa.me/212"]'));
    assert.deepStrictEqual(errors, []);
  } finally { await br.close(); srv.kill(); }
});
