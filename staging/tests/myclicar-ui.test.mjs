import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = await fs.readFile(new URL('../site/fleet.js', import.meta.url), 'utf8');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const initial = () => ({ configured: true, httpConfigured: true, email: 'test@example.invalid', httpUsername: 'staging-user', status: 'paused', polling: false, auto_resume: false, coverage: { contracts: 12, active_contracts: 4, matched_assignments: 3, unmatched_contracts: 1 } });
function ui(status = initial()) {
  const elements = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', innerHTML: '', textContent: '', dataset: {}, hidden: false, disabled: false, required: true });
    return elements.get(selector);
  };
  const context = vm.createContext({
    S: { session: { user: { id: 'local-test-user' }, access_token: 'local-test-token' } }, ROUTING: 1,
    $: element, esc: escape, msg: (value, type) => `<p class="${type}">${value}</p>`,
    fmtDTY: value => `date:${value}`, fmtHMS: () => '12:00:20',
    api: async (path, body) => { calls.push({ path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), sent: body }); return status; }
  });
  vm.runInContext(code, context);
  const run = source => vm.runInContext(source, context);
  run('fleetApi = (...args) => api(...args); loadMyclicar = setupMyclicarConnector(1)');
  return { context, element, calls, run, load: () => run('loadMyclicar()'), submit: () => element('#myclicar-connect').onsubmit({ preventDefault() {} }) };
}

test('MyClicar presents separate masked application and HTTP credentials with an explicit staging scope', () => {
  for (const id of ['myclicar-password', 'myclicar-http-password']) {
    const input = code.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
    assert.ok(input);
    assert.match(input, /type="password"/);
    assert.match(input, /autocomplete="off"/);
    assert.doesNotMatch(input, /value=/);
  }
  assert.match(code, /Compte MyClicar/);
  assert.match(code, /Protection HTTP de new\.clicar\.ma/);
  assert.match(code, /Les contacts et les données financières ne sont pas copiés/);
  assert.match(code, /const myclicarHealth = setupMyclicarConnector\(my\)/);
  assert.match(code, /Promise\.all\(\[geotabHealth\(\), myclicarHealth\(\), validationHealth\(\), teksatHealth\(\)\]\)/);
});

test('saved credentials stay private while public status renders coverage and durable pause', async () => {
  const status = { ...initial(), password: 'must-never-prefill', httpPassword: 'must-never-prefill-http', last_success_at: '2026-10-30T10:00:00Z' };
  const { load, element, calls } = ui(status);
  await load();
  assert.equal(calls[0].path, 'myclicar/status');
  assert.equal(calls[0].body, undefined);
  assert.equal(element('#myclicar-email').value, 'test@example.invalid');
  assert.equal(element('#myclicar-http-user').value, 'staging-user');
  assert.equal(element('#myclicar-password').value, '');
  assert.equal(element('#myclicar-http-password').value, '');
  assert.equal(element('#myclicar-password').required, false);
  assert.equal(element('#myclicar-http-password').required, false);
  assert.equal(element('#myclicar-health').textContent, 'En pause');
  assert.match(element('#myclicar-automation').innerHTML, /Pause conservée au redémarrage/);
  assert.equal(element('#myclicar-start').disabled, false);
  assert.equal(element('#myclicar-stop').hidden, true);
  assert.match(element('#myclicar-summary').textContent, /12 contrats lus · 4 actifs · 3 affectations rapprochées · 1 contrat à rapprocher/);
  assert.match(element('#myclicar-summary').textContent, /Dernière lecture : date:2026-10-30T10:00:00Z/);
});

test('blank passwords are omitted from connect and existing form edits survive status refreshes', async () => {
  const { load, element, submit, calls } = ui();
  await load();
  element('#myclicar-email').value = '  changed@example.invalid  ';
  element('#myclicar-http-user').value = ' changed-http ';
  await load();
  assert.equal(element('#myclicar-email').value, '  changed@example.invalid  ');
  await submit();
  assert.equal(calls.at(-1).path, 'myclicar/connect');
  assert.deepEqual(calls.at(-1).body, { email: 'changed@example.invalid', httpUsername: 'changed-http' });
  assert.match(element('#myclicar-result').innerHTML, /Accès vérifiés et enregistrés/);
  assert.equal(element('#myclicar-health').textContent, 'En pause', 'saving credentials does not activate polling');
});

test('new credentials are cleared immediately and successful connection waits for server validation', async () => {
  const { context, load, element, submit, calls } = ui({ configured: false, httpConfigured: false, status: 'unconnected' });
  await load();
  assert.equal(element('#myclicar-password').required, true);
  assert.equal(element('#myclicar-http-password').required, true);
  assert.equal(element('#myclicar-start').disabled, true);
  let resolve;
  context.api = (path, body) => { calls.push({ path, body: JSON.parse(JSON.stringify(body)), sent: body }); return new Promise(done => { resolve = done; }); };
  element('#myclicar-email').value = 'first@example.invalid';
  element('#myclicar-http-user').value = 'http-test';
  element('#myclicar-password').value = ' synthetic app password ';
  element('#myclicar-http-password').value = ' synthetic HTTP password ';
  const pending = submit();
  assert.equal(element('#myclicar-password').value, '');
  assert.equal(element('#myclicar-http-password').value, '');
  assert.equal(element('#myclicar-connect button').disabled, true);
  assert.equal(element('#myclicar-health').textContent, 'À connecter');
  assert.doesNotMatch(element('#myclicar-result').innerHTML, /Accès vérifiés et enregistrés/);
  assert.deepEqual(calls.at(-1).body, { email: 'first@example.invalid', httpUsername: 'http-test', password: ' synthetic app password ', httpPassword: ' synthetic HTTP password ' });
  await submit();
  assert.equal(calls.length, 2, 'double submit does not duplicate a credential request');
  resolve(initial());
  await pending;
  assert.equal(element('#myclicar-connect button').disabled, false);
  assert.equal(element('#myclicar-health').textContent, 'En pause');
  assert.equal('password' in calls.at(-1).sent, false);
  assert.equal('httpPassword' in calls.at(-1).sent, false);
});

test('failed validation leaves the last confirmed status intact and renders the error as text', async () => {
  const { context, load, element, submit } = ui({ configured: false, httpConfigured: false, status: 'unconnected' });
  await load();
  context.api = async () => { throw new Error('<img src=x onerror=bad()> HTTP refusé'); };
  await submit();
  assert.equal(element('#myclicar-health').textContent, 'À connecter');
  assert.equal(element('#myclicar-start').disabled, true);
  assert.match(element('#myclicar-result').innerHTML, /&lt;img/);
  assert.doesNotMatch(element('#myclicar-result').innerHTML, /<img|Accès vérifiés/);
});

test('activation and pause render authoritative automation status including retry and persistence errors', async () => {
  const { context, load, element, calls } = ui();
  await load();
  context.api = async (path, body) => {
    calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
    return path === 'myclicar/start' ? { ...initial(), polling: true, auto_resume: true, status: 'error', retrying: true, next_attempt_at: '2026-10-30T12:00:20Z', last_error: '<script>provider unavailable</script>' } : initial();
  };
  await element('#myclicar-start').onclick();
  assert.deepEqual(calls.at(-1), { path: 'myclicar/start', body: {} });
  assert.equal(element('#myclicar-health').textContent, 'Reconnexion automatique');
  assert.match(element('#myclicar-automation').innerHTML, /Nouvel essai : 12:00:20/);
  assert.match(element('#myclicar-automation').innerHTML, /Cadence cible : 60 s/);
  assert.match(element('#myclicar-automation').innerHTML, /&lt;script/);
  assert.equal(element('#myclicar-start').hidden, true);
  assert.equal(element('#myclicar-stop').hidden, false);
  await element('#myclicar-stop').onclick();
  assert.deepEqual(calls.at(-1), { path: 'myclicar/stop', body: {} });
  assert.equal(element('#myclicar-health').textContent, 'En pause');
  context.api = async () => ({ ...initial(), polling: true, status: 'healthy', automation_error: 'Sauvegarde locale indisponible' });
  await load();
  assert.equal(element('#myclicar-health').textContent, 'Automatisation à vérifier');
  assert.match(element('#myclicar-automation').innerHTML, /Sauvegarde locale indisponible/);
});

test('a stale status request cannot undo a completed mutation', async () => {
  const { context, load, element } = ui();
  await load();
  let resolve;
  context.api = path => path === 'myclicar/status' ? new Promise(done => { resolve = done; }) : Promise.resolve({ ...initial(), polling: true, auto_resume: true, status: 'healthy' });
  const pending = load();
  await element('#myclicar-start').onclick();
  assert.equal(element('#myclicar-health').textContent, 'Suivi actif');
  resolve(initial());
  await pending;
  assert.equal(element('#myclicar-health').textContent, 'Suivi actif');
});

test('late responses after logout are discarded and further local polling stops', async () => {
  const { context, load, element, calls } = ui();
  await load();
  let resolve;
  context.api = path => { calls.push({ path }); return new Promise(done => { resolve = done; }); };
  const pending = load();
  context.S.session = null;
  resolve({ ...initial(), polling: true, auto_resume: true, status: 'healthy' });
  await pending;
  assert.equal(element('#myclicar-health').textContent, 'En pause');
  await load();
  assert.equal(calls.length, 2);
});

test('unknown coverage stays distinct from zero and paused read errors remain visible', async () => {
  const { load, element } = ui({ ...initial(), coverage: { contracts: 0, active_contracts: null }, status: 'error', last_error: '<b>Session expirée</b>' });
  await load();
  assert.match(element('#myclicar-summary').textContent, /0 contrats lus · — actifs · — affectations rapprochées · — contrats à rapprocher/);
  assert.match(element('#myclicar-summary').textContent, /Dernière lecture : aucune/);
  assert.match(element('#myclicar-read-error').innerHTML, /&lt;b&gt;Session expirée/);
  assert.doesNotMatch(element('#myclicar-read-error').innerHTML, /<b>/);
});

test('MyClicar status has a bounded read deadline while actions retain their connector timeout', async () => {
  const requests = [], timeouts = [];
  const context = vm.createContext({
    S: { session: { access_token: 'synthetic-local-token' } },
    AbortController, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: value => { timeouts.push(value); return new AbortController().signal; } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => initial() }; }
  });
  vm.runInContext(code, context);
  await vm.runInContext("fleetApi('myclicar/status')", context);
  await vm.runInContext("fleetApi('myclicar/start', {})", context);
  assert.deepEqual(requests.map(item => item.url), ['/api/fleet/myclicar/status', '/api/fleet/myclicar/start']);
  assert.deepEqual(timeouts, [20000, 120000]);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-local-token');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.body, '{}');
  assert.equal(requests[1].options.cache, 'no-store');
});
