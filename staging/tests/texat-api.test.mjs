import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createTeksatApi} from '../server/texat-api.mjs';
const USER = '11111111-1111-4111-8111-111111111111';
function fixture({role = 'admin', revoked = false} = {}) {
  const calls = []; let refreshes = 0, profileReads = 0;
  const service = {getStatus: () => ({activeFailover: false, configured: true}), async refreshReadOnly() {refreshes++; return {connection: 'verified', activeFailover: false};}};
  const api = createTeksatApi({supabaseUrl: 'http://127.0.0.1:57421', anonKey: 'anon', service, fetchFn: async (url, options) => {
    calls.push(url); assert.equal(new URL(url).origin, 'http://127.0.0.1:57421'); assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (new URL(url).pathname === '/auth/v1/user') return Response.json({id: USER});
    profileReads++; return Response.json([{user_id: USER, role: revoked && profileReads > 1 ? 'viewer' : role}]);
  }});
  async function request({method = 'GET', url = '/api/fleet/texat/status', token = 'test-token', body, origin = 'http://127.0.0.1:4173'} = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {method, url, headers: {host: '127.0.0.1:4173', origin, ...(token ? {authorization: 'Bearer ' + token} : {})}, socket: {remoteAddress: '127.0.0.1'}});
    let response; const res = {writeHead(status, headers) {response = {status, headers};}, end(value) {response.body = JSON.parse(value);}};
    await api(req, res); return response;
  }
  return {request, calls, refreshes: () => refreshes};
}
test('admin status is cached and read-only refresh revalidates the role before publication', async () => {
  const f = fixture(); assert.equal((await f.request()).status, 200); assert.equal(f.refreshes(), 0);
  const result = await f.request({method: 'POST', url: '/api/fleet/texat/refresh', body: {}});
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(f.refreshes(), 1);
  assert.equal(f.calls.length, 6);
  const revoked = fixture({revoked: true});
  const denied = await revoked.request({method: 'POST', url: '/api/fleet/texat/refresh'});
  assert.equal(denied.status, 403); assert.equal(denied.body.connection, undefined);
});
test('anonymous, managers and foreign origins cannot read status or trigger provider requests', async () => {
  for (const [setup, options, expected] of [[{}, {token: null}, 401], [{role: 'manager'}, {}, 403], [{role: 'viewer'}, {}, 403], [{}, {origin: 'https://outside.invalid'}, 403]]) {
    const f = fixture(setup), result = await f.request({method: 'POST', url: '/api/fleet/texat/refresh', ...options});
    assert.equal(result.status, expected); assert.equal(f.refreshes(), 0);
  }
});
test('request parameters cannot change the provider, scope, credentials or collection mode', async () => {
  for (const options of [{url: '/api/fleet/texat/refresh?filialeId=1'}, {body: {password: 'PRIVATE'}}, {body: {url: 'https://outside.invalid'}}, {body: []}]) {
    const f = fixture(), result = await f.request({method: 'POST', url: '/api/fleet/texat/refresh', ...options});
    assert.equal(result.status, 400); assert.equal(f.refreshes(), 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|outside/);
  }
});
