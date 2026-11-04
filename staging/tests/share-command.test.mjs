import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { quickTunnelOrigin, tunnelEnvironment, tunnelArguments } from '../scripts/share.mjs';
import { createTester, testerOptions } from '../scripts/create-tester.mjs';

test('share command accepts only the printed HTTPS quick tunnel origin and isolates cloudflared environment', () => {
  assert.equal(quickTunnelOrigin('INF | https://fleet-test-123.trycloudflare.com |'), 'https://fleet-test-123.trycloudflare.com');
  for (const value of ['http://test.trycloudflare.com', 'https://test.trycloudflare.com.evil.invalid', 'https://test.trycloudflare.com@evil.invalid', 'https://example.com', 'https://test.trycloudflare.com/path']) assert.equal(quickTunnelOrigin(value), null);
  assert.deepEqual(tunnelEnvironment({ PATH: '/bin', HOME: '/fixture', TUNNEL_TOKEN: 'private', TUNNEL_HTTP_HOST_HEADER: 'evil.invalid', TUNNEL_LOGLEVEL: 'debug', SUPABASE_URL: 'https://prod.invalid', HTTPS_PROXY: 'https://proxy.invalid' }), { PATH: '/bin', HOME: '/fixture' });
  const args = tunnelArguments('/private/cloudflared.yml');
  assert.equal(args[args.indexOf('--url') + 1], 'http://127.0.0.1:4174');
  assert.equal(args[args.indexOf('--metrics') + 1], '127.0.0.1:0');
  assert.equal(args[args.indexOf('--config') + 1], '/private/cloudflared.yml');
});

test('frontend accepts only local Supabase or explicit HTTPS same-origin staging proxy', async () => {
  const source = (await readFile(new URL('../site/app.js', import.meta.url), 'utf8')).split('const sb =')[0];
  const run = (url, config) => vm.runInNewContext(source, { window: { FLOTTE_CONFIG: config }, location: new URL(url), document: { getElementById: () => ({ textContent: '' }) } });
  assert.doesNotThrow(() => run('http://127.0.0.1:4173', { STAGING: true, SUPABASE_URL: 'http://127.0.0.1:57421' }));
  assert.doesNotThrow(() => run('https://test.trycloudflare.com', { STAGING: true, SHARED_STAGING: true, SUPABASE_URL: 'https://test.trycloudflare.com/supabase' }));
  for (const config of [
    { STAGING: true, SUPABASE_URL: 'https://prod.supabase.co' },
    { STAGING: true, SHARED_STAGING: true, SUPABASE_URL: 'https://prod.supabase.co' },
    { STAGING: true, SUPABASE_URL: 'https://test.trycloudflare.com/supabase' },
    { STAGING: false, SHARED_STAGING: true, SUPABASE_URL: 'https://test.trycloudflare.com/supabase' },
    { STAGING: true, SHARED_STAGING: true, SUPABASE_URL: 'https://test.trycloudflare.com/supabase/elsewhere' }
  ]) assert.throws(() => run('https://test.trycloudflare.com', config), /refuse/);
  assert.throws(() => run('http://test.invalid', { STAGING: true, SHARED_STAGING: true, SUPABASE_URL: 'http://test.invalid/supabase' }), /refuse/);
});

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runtime = { projectId: 'ludy-staging', supabaseUrl: 'http://127.0.0.1:57421', serviceKey: 'synthetic-service' };
function fixture({ existing = false, failLinks = false, wrongMarker = false, role = 'viewer', own = true } = {}) {
  const calls = [], saved = [];
  return { calls, saved, save: async data => { saved.push(data); return '/private/tester.json'; }, fetchFn: async (input, init) => {
    const url = new URL(input), data = init.body ? JSON.parse(init.body) : undefined;
    assert.equal(url.origin, runtime.supabaseUrl); assert.equal(init.redirect, 'error');
    calls.push({ path: url.pathname, method: init.method, data });
    if (url.pathname === '/rest/v1/params') return Response.json([{ value: wrongMarker ? 'production' : 'staging' }]);
    if (url.pathname === '/rest/v1/agencies') return Response.json([{ id: 1 }, { id: 2 }]);
    if (url.pathname === '/auth/v1/admin/users' && init.method === 'GET') return Response.json({ users: existing ? [{ email: 'tester@example.invalid' }] : [] });
    if (url.pathname === '/auth/v1/admin/users' && init.method === 'POST') return Response.json({ id });
    if (url.pathname === '/auth/v1/admin/users/' + id && init.method === 'GET') return Response.json({ id, app_metadata: { ludy_test_access: own } });
    if (url.pathname === '/auth/v1/admin/users/' + id) return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id });
    if (url.pathname === '/rest/v1/user_agencies') return failLinks ? Response.json({}, { status: 500 }) : Response.json(data);
    if (url.pathname === '/rest/v1/profiles') return Response.json([{ user_id: id, role: data?.role || role }]);
    throw Error('Unexpected request');
  } };
}
test('tester creation requires an explicit agency scope and has no role/password override', () => {
  assert.deepEqual(testerOptions(['--email', ' TESTER@example.invalid ', '--agency', '1', '--agency', '1']), { agencies: [1], email: 'tester@example.invalid' });
  for (const args of [[], ['--email', 'tester@example.invalid'], ['--email', 'tester@example.invalid', '--all-agencies', '--agency', '1'], ['--email', 'tester@example.invalid', '--agency', '0'], ['--email', 'tester@example.invalid', '--all-agencies', '--role', 'admin'], ['--disable', id, '--all-agencies']]) assert.throws(() => testerOptions(args));
});
test('new tester is scoped before viewer role and credentials are saved privately, never returned', async () => {
  const f = fixture(), result = await createTester({ options: testerOptions(['--email', 'tester@example.invalid', '--agency', '2']), runtime, ...f });
  const writes = f.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(writes.map(call => call.path), ['/auth/v1/admin/users', '/rest/v1/user_agencies', '/rest/v1/profiles']);
  assert.deepEqual(writes[1].data, [{ user_id: id, agency_id: 2 }]);
  assert.equal(writes[2].data.role, 'viewer'); assert.equal(f.saved[0].password.length, 32);
  assert.equal(result.password, undefined); assert.equal(result.filename, '/private/tester.json');
  assert.equal(writes[0].data.email_confirm, true);
});
test('existing accounts, bad scope and a non-staging marker never get mutated', async () => {
  for (const config of [{ existing: true }, { wrongMarker: true }, { agency: '9' }]) {
    const f = fixture(config);
    await assert.rejects(createTester({ options: testerOptions(['--email', 'tester@example.invalid', '--agency', config.agency || '1']), runtime, ...f }));
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  }
  await assert.rejects(createTester({ options: {}, runtime: { ...runtime, supabaseUrl: 'https://prod.invalid' }, ...fixture() }), /local/);
});
test('failed agency grants or private receipt creation delete only the just-created tester', async () => {
  for (const mode of ['links', 'save']) {
    const f = fixture({ failLinks: mode === 'links' });
    if (mode === 'save') f.save = async () => { throw Error('Disk full'); };
    await assert.rejects(createTester({ options: testerOptions(['--email', 'tester@example.invalid', '--all-agencies']), runtime, ...f }));
    assert.deepEqual(f.calls.at(-1), { path: '/auth/v1/admin/users/' + id, method: 'DELETE', data: undefined });
  }
});
test('disabling is limited to provisioned viewer accounts and removes role access before banning login', async () => {
  const options = testerOptions(['--disable', id]), f = fixture();
  const result = await createTester({ options, runtime, ...f });
  assert.equal(result.disabled, true);
  const retry = fixture({ role: 'pending' });
  assert.equal((await createTester({ options, runtime, ...retry })).disabled, true, 'a previously interrupted disable remains retryable');
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => call.data), [{ role: 'pending' }, { ban_duration: '876000h' }]);
  for (const config of [{ role: 'admin' }, { own: false }]) {
    const denied = fixture(config); await assert.rejects(createTester({ options, runtime, ...denied }));
    assert.equal(denied.calls.filter(call => call.method !== 'GET').length, 0);
  }
});
