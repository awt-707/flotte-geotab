import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { MyclicarClient, readMyclicarCredentials, saveMyclicarCredentials, validateMyclicarCredentials } from '../server/myclicar.mjs';

const NOW = Date.parse('2026-10-30T13:00:00Z');
const PORTAL = 'https://new.clicar.ma/';
const API = 'https://new-api.clicar.ma';
const CREDS = { origin: 'https://new.clicar.ma', email: 'test@example.invalid', password: ' synthetic app secret ', httpUsername: 'synthetic-http-user', httpPassword: ' synthetic HTTP secret ' };
const TOKEN = 'SYNTHETIC_ACCESS_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_TOKEN';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const login = (token = TOKEN) => json({ accessToken: token, refreshToken: REFRESH }, 201);
const portal = () => new Response('<html>synthetic portal</html>');
const contract = (index, extra = {}) => ({
  id: 'contract-' + index, reference: 'CON-' + index, status: 'IN_PROGRESS',
  departureDate: '2026-10-30T07:51:00.000Z', actualReturnDate: null,
  departureConditionDate: '30/10/2026 à 08h51', checkoutDate: '',
  endDueDate: '2026-10-29T22:00:00.000Z',
  vehicleRegistration: 'TEST-' + index, vehicleTemporaryRegistration: null,
  vehicleBrand: 'Synthetic', vehicleModel: 'Test model', contactName: 'Chauffeur test ' + index,
  clientReference: 'DRV-' + index, createdAt: '2026-10-30T07:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z', deletedAt: null, originType: 'NEW_CONTRACT',
  ...extra
});
const listing = (rows, { total = rows.length, page = 1, itemsPerPage = 10, pageCount = Math.ceil(total / itemsPerPage) } = {}) => json({ data: rows, meta: { total, page, itemsPerPage, pageCount } });
const secretFree = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [CREDS.password, CREDS.httpPassword, TOKEN, REFRESH, 'upstream private detail']) assert.ok(!text.includes(secret));
};

test('MyClicar validation fixes the portal origin, trims usernames and preserves passwords', () => {
  assert.deepEqual(validateMyclicarCredentials({ ...CREDS, origin: PORTAL, email: '  test@example.invalid  ', httpUsername: ' synthetic-http-user ' }), CREDS);
  const { origin, ...withoutOrigin } = CREDS;
  assert.deepEqual(validateMyclicarCredentials(withoutOrigin), CREDS);
  for (const input of [null, [], { ...CREDS, email: 'missing-at' }, { ...CREDS, email: 'test\n@example.invalid' }, { ...CREDS, httpUsername: 'user:second' }, { ...CREDS, password: '' }, { ...CREDS, httpPassword: '' }, { ...CREDS, password: 'a\0b' }, { ...CREDS, httpPassword: 'x'.repeat(4097) }]) assert.throws(() => validateMyclicarCredentials(input), error => error.status === 400);
  for (const origin of ['http://new.clicar.ma', 'https://new-api.clicar.ma', 'https://new.clicar.ma.evil.invalid', 'https://u:p@new.clicar.ma', PORTAL + 'api', PORTAL + '?next=private', PORTAL + '#fragment', 'http://127.0.0.1']) assert.throws(() => validateMyclicarCredentials({ ...CREDS, origin }), error => error.status === 400);
  assert.throws(() => validateMyclicarCredentials({ ...CREDS, password: 'é'.repeat(4096), httpPassword: 'é'.repeat(4096) }), /volumineux/);
});

test('credential writes are atomic, private, bounded and reject symlinks and hard links', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclicar-client-'));
  const filename = path.join(directory, 'private', 'credentials.json');
  try {
    assert.equal(await readMyclicarCredentials(filename), null);
    await saveMyclicarCredentials(filename, CREDS);
    assert.deepEqual(await readMyclicarCredentials(filename), CREDS);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
    await saveMyclicarCredentials(filename, { ...CREDS, password: 'replacement synthetic secret' });
    assert.equal((await readMyclicarCredentials(filename)).password, 'replacement synthetic secret');
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ['credentials.json']);
    await fs.symlink(filename, path.join(directory, 'file-link'));
    await assert.rejects(readMyclicarCredentials(path.join(directory, 'file-link')), error => error.status === 409);
    await assert.rejects(saveMyclicarCredentials(path.join(directory, 'file-link'), CREDS), error => error.status === 409);
    await fs.symlink(path.dirname(filename), path.join(directory, 'directory-link'));
    await assert.rejects(readMyclicarCredentials(path.join(directory, 'directory-link', 'credentials.json')), error => error.status === 409);
    await assert.rejects(saveMyclicarCredentials(path.join(directory, 'directory-link', 'new.json'), CREDS), error => error.status === 409);
    await fs.link(filename, path.join(directory, 'hard-link'));
    await assert.rejects(readMyclicarCredentials(filename), error => error.status === 409);
    await assert.rejects(saveMyclicarCredentials(filename, CREDS), error => error.status === 409);
    await fs.unlink(path.join(directory, 'hard-link'));
    await fs.chmod(filename, 0o644);
    await assert.rejects(readMyclicarCredentials(filename), /0600/);
    await assert.rejects(saveMyclicarCredentials(filename, CREDS), error => error.status === 409);
    await fs.chmod(filename, 0o600);
    await fs.writeFile(filename, 'upstream private detail');
    await assert.rejects(readMyclicarCredentials(filename), error => { secretFree(error.message); return error.status === 409; });
    await fs.writeFile(filename, 'x'.repeat(16385));
    await assert.rejects(readMyclicarCredentials(filename), error => error.status === 409);
    await fs.unlink(filename);
    await fs.mkdir(filename);
    await assert.rejects(readMyclicarCredentials(filename), error => error.status === 409);
    await assert.rejects(saveMyclicarCredentials(filename, CREDS), error => error.status === 409);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('connection verifies the HTTP portal then logs into the API without forwarding HTTP credentials', async () => {
  const requests = [];
  const client = new MyclicarClient({ credentials: async () => CREDS, now: () => NOW, fetchFn: async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === PORTAL) {
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from(CREDS.httpUsername + ':' + CREDS.httpPassword).toString('base64'));
      return portal();
    }
    assert.equal(url, API + '/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(options.body), { email: CREDS.email, password: CREDS.password, platform: 'clicarmaroc' });
    return login();
  } });
  assert.deepEqual(await Promise.all([client.test(), client.test()]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(await client.test(), { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(client), '{}');
  secretFree(inspect(client, { showHidden: true }));
  client.reset();
  assert.deepEqual(await client.test(), { ok: true });
  assert.equal(requests.length, 4);
});

test('portal or API redirects never forward credentials and are not followed', async () => {
  for (const redirectedStage of ['portal', 'api']) {
    let calls = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
      calls++;
      if (redirectedStage === 'api' && url === PORTAL) return portal();
      return new Response(null, { status: 302, headers: { location: 'https://outside.invalid/private' } });
    } });
    await assert.rejects(client.test(), error => error.status === 502);
    assert.equal(calls, redirectedStage === 'api' ? 2 : 1);
  }
});

test('HTTP and application authentication failures are distinct and redact provider details', async () => {
  for (const stage of ['portal', 'api']) {
    let calls = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
      calls++;
      if (stage === 'api' && url === PORTAL) return portal();
      return json({ error: CREDS.password + TOKEN + 'upstream private detail' }, 401);
    } });
    await assert.rejects(client.test(), error => { secretFree(error.message); secretFree(error); return error.kind === (stage === 'portal' ? 'http_authentication' : 'authentication'); });
    assert.equal(calls, stage === 'portal' ? 1 : 2);
  }
});

test('malformed authentication responses and transport failures never expose secrets', async () => {
  for (const result of [() => json({ accessToken: '' }, 201), () => json({ accessToken: 'a\r\nb' }, 201), () => json({ accessToken: TOKEN }, 200), () => new Response('upstream private detail', { status: 201 }), () => new Response(null, { status: 201, headers: { 'content-length': String(8 * 1024 * 1024 + 1) } })]) {
    const client = new MyclicarClient({ credentials: CREDS, fetchFn: async url => url === PORTAL ? portal() : result() });
    await assert.rejects(client.test(), error => { secretFree(error.message); return error.status === 502; });
  }
  for (const name of ['Error', 'TimeoutError', 'AbortError']) {
    const client = new MyclicarClient({ credentials: CREDS, fetchFn: async () => { throw Object.assign(new Error(CREDS.password + 'upstream private detail'), { name }); } });
    await assert.rejects(client.test(), error => { secretFree(error.message); return name === 'Error' ? /Connexion/.test(error.message) : /Délai/.test(error.message); });
  }
  const brokenStore = new MyclicarClient({ credentials: () => { throw new Error(CREDS.password); } });
  await assert.rejects(brokenStore.test(), error => { secretFree(error.message); return error.status === 409; });
});

test('session deadlines renew locally while JWT tokens and expiry stay private', async () => {
  let now = NOW, auth = 0;
  const token = expiry => ['header', Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url'), 'signature'].join('.');
  const client = new MyclicarClient({ credentials: CREDS, now: () => now, fetchFn: async url => {
    if (url === PORTAL) return portal();
    auth++;
    return login(token((now + 120000) / 1000));
  } });
  await client.test();
  now += 89000;
  await client.test();
  assert.equal(auth, 1);
  now += 1001;
  await client.test();
  assert.equal(auth, 2);
  assert.deepEqual(Object.keys(client), []);
  const expired = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => url === PORTAL ? portal() : login(token((NOW - 1000) / 1000)) });
  await assert.rejects(expired.test(), error => error.kind === 'authentication');
});

test('reset invalidates an authentication in progress', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
    if (url === PORTAL) return portal();
    started(); await held; return login();
  } });
  const pending = client.test();
  await waiting;
  client.reset(); release();
  await assert.rejects(pending, error => error.status === 409);
});

test('429 retry-after dates and seconds hold requests locally and reset cannot evade cooldown', async () => {
  for (const retryHeader of ['120', new Date(NOW + 120000).toUTCString()]) {
    let now = NOW, calls = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => now, fetchFn: async url => {
      calls++;
      if (calls === 1) return json({ error: 'upstream private detail' }, 429, { 'retry-after': retryHeader });
      return url === PORTAL ? portal() : login();
    } });
    await assert.rejects(client.test(), error => error.kind === 'quota' && error.retryAfter === 120);
    client.reset();
    now += 1000;
    await assert.rejects(client.test(), error => error.kind === 'quota' && error.retryAfter === 119);
    now -= 60000;
    await assert.rejects(client.test(), error => error.kind === 'quota' && error.retryAfter === 119);
    assert.equal(calls, 1);
    now = NOW + 120000;
    assert.deepEqual(await client.test(), { ok: true });
    assert.equal(calls, 3);
  }
});

test('429 without a usable retry-after backs off without immediate network retries', async () => {
  let now = NOW, calls = 0;
  const client = new MyclicarClient({ credentials: CREDS, now: () => now, fetchFn: async () => { calls++; return json({}, 429); } });
  for (const seconds of [30, 60, 120]) {
    await assert.rejects(client.test(), error => error.kind === 'quota' && error.retryAfter === seconds);
    const before = calls;
    await assert.rejects(client.test(), error => error.kind === 'quota');
    assert.equal(calls, before);
    now += seconds * 1000;
  }
  assert.equal(calls, 3);
});

test('active contracts use the exact observed GET filter with complete pagination and a minimal result', async () => {
  const requests = [], rows = Array.from({ length: 16 }, (_, index) => contract(index, { email: 'private-contact@example.invalid', phone: 'private-phone', balance: 999999, agentName: 'private-agent', nested: { accessToken: TOKEN } }));
  const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async (url, options) => {
    requests.push({ url, options });
    if (url === PORTAL) return portal();
    if (url === API + '/auth/login') return login();
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' });
    const parsed = new URL(url), page = Number(parsed.searchParams.get('page'));
    assert.equal(url, `${API}/contract?page=${page}&itemsPerPage=10&isBooking=false&isArchived=false&isCanceled=false&status%5B%5D=IN_PROGRESS`);
    assert.equal(options.redirect, 'manual');
    assert.deepEqual([...parsed.searchParams.keys()], ['page', 'itemsPerPage', 'isBooking', 'isArchived', 'isCanceled', 'status[]']);
    return listing(rows.slice((page - 1) * 10, page * 10), { total: rows.length, page });
  } });
  const [first, second] = await Promise.all([client.snapshot(), client.snapshot()]);
  assert.deepEqual(first, second);
  assert.equal(first.complete, true);
  assert.equal(first.at, new Date(NOW).toISOString());
  assert.deepEqual(first.coverage, { contracts: 16, active_contracts: 16 });
  assert.equal(first.contracts.length, 16);
  assert.deepEqual(first.contracts[0], { ...contract(0), checkoutDate: null });
  secretFree(first);
  for (const privateField of ['private-contact', 'private-phone', '999999', 'private-agent', 'nested']) assert.ok(!JSON.stringify(first).includes(privateField));
  assert.equal(requests.length, 4, 'simultaneous snapshots share authentication and page reads');
  await client.snapshot();
  assert.equal(requests.length, 6, 'later snapshots refresh data while reusing the session');
  assert.ok(requests.every(({ url }) => url === PORTAL || url === API + '/auth/login' || url.startsWith(API + '/contract?')));
});

test('empty active rosters and exact page boundaries return complete snapshots without speculative pages', async () => {
  for (const { count, pageCount } of [{ count: 0, pageCount: 0 }, { count: 0, pageCount: 1 }, { count: 10, pageCount: 1 }]) {
    let reads = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
      if (url === PORTAL) return portal();
      if (url === API + '/auth/login') return login();
      reads++;
      return listing(Array.from({ length: count }, (_, index) => contract(index)), { pageCount });
    } });
    const result = await client.snapshot();
    assert.equal(result.contracts.length, count);
    assert.equal(result.complete, true);
    assert.equal(reads, 1);
  }
});

test('a rejected access token renews authentication once and retries only the contract GET', async () => {
  let auth = 0, reads = 0, portals = 0;
  const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async (url, options) => {
    if (url === PORTAL) { portals++; return portal(); }
    if (url === API + '/auth/login') return login(TOKEN + ++auth);
    reads++;
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN + auth);
    if (reads === 1) return json({ error: 'upstream private detail' }, 401);
    return listing([contract(1)]);
  } });
  assert.equal((await client.snapshot()).contracts.length, 1);
  assert.equal(auth, 2);
  assert.equal(portals, 2);
  assert.equal(reads, 2);
  auth = 0; reads = 0;
  const refused = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
    if (url === PORTAL) return portal();
    if (url === API + '/auth/login') { auth++; return login(); }
    reads++; return json({ error: TOKEN + CREDS.password }, 401);
  } });
  await assert.rejects(refused.snapshot(), error => { secretFree(error.message); return error.kind === 'authentication'; });
  assert.equal(auth, 2);
  assert.equal(reads, 2);
});

test('403 and malformed contract reads fail without reauthentication or disclosure', async () => {
  for (const failure of [() => json({ details: CREDS.password + TOKEN }, 403), () => json({ details: CREDS.password + TOKEN }, 500), () => new Response('upstream private detail'), () => new Response(' '.repeat(8 * 1024 * 1024 + 1))]) {
    let auth = 0, reads = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
      if (url === PORTAL) return portal();
      if (url === API + '/auth/login') { auth++; return login(); }
      reads++; return failure();
    } });
    await assert.rejects(client.snapshot(), error => { secretFree(error.message); secretFree(error); return error.status === 502; });
    assert.equal(auth, 1);
    assert.equal(reads, 1);
  }
});

test('pagination rejects ignored filters, incomplete pages, invalid metadata and excessive totals', async () => {
  const failures = [
    () => listing([contract(1, { status: 'COMPLETED' })]),
    () => listing([contract(1, { deletedAt: '2026-10-30T12:00:00Z' })]),
    () => listing([contract(1)], { total: 2 }),
    () => listing([contract(1)], { total: 2001 }),
    () => listing([contract(1)], { page: 2 }),
    () => listing([contract(1)], { itemsPerPage: 100 }),
    () => listing([contract(1)], { pageCount: 2 }),
    () => listing([contract(1)], { total: '1' }),
    () => json({ data: [contract(1)] }),
    () => json({ data: {}, meta: { total: 1, page: 1, pageCount: 1, itemsPerPage: 10 } })
  ];
  for (const failure of failures) {
    let reads = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
      if (url === PORTAL) return portal();
      if (url === API + '/auth/login') return login();
      reads++; return failure();
    } });
    await assert.rejects(client.snapshot(), error => error.status === 502);
    assert.equal(reads, 1);
  }
});

test('changed totals and duplicate IDs or references invalidate the whole multipage snapshot', async () => {
  const first = Array.from({ length: 10 }, (_, index) => contract(index));
  for (const secondPage of [
    () => listing([contract(10), contract(11)], { total: 12, page: 2 }),
    () => listing([contract(0)], { total: 11, page: 2 }),
    () => listing([contract(10, { reference: 'CON-0' })], { total: 11, page: 2 }),
    () => listing([], { total: 11, page: 2 })
  ]) {
    let reads = 0;
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
      if (url === PORTAL) return portal();
      if (url === API + '/auth/login') return login();
      return ++reads === 1 ? listing(first, { total: 11 }) : secondPage();
    } });
    await assert.rejects(client.snapshot(), error => error.status === 502);
    assert.equal(reads, 2);
  }
});

test('provider dates cannot invent future observations or close a contract using its due date', async () => {
  for (const change of [
    { updatedAt: new Date(NOW + 61000).toISOString() },
    { createdAt: new Date(NOW + 61000).toISOString() },
    { departureDate: new Date(NOW + 61000).toISOString() },
    { actualReturnDate: new Date(NOW + 61000).toISOString() },
    { departureDate: '30/10/2026 à 08h51' },
    { updatedAt: 'not-a-date' },
    { reference: '' },
    { id: -1 },
    { contactName: 'Invalid\nname' }
  ]) {
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => url === PORTAL ? portal() : url === API + '/auth/login' ? login() : listing([contract(1, change)]) });
    await assert.rejects(client.snapshot(), error => error.status === 502);
  }
  for (const endDueDate of ['2026-10-29T22:00:00Z', '2026-11-30T22:00:00Z']) {
    const client = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => url === PORTAL ? portal() : url === API + '/auth/login' ? login() : listing([contract(1, { endDueDate })]) });
    const result = await client.snapshot();
    assert.equal(result.contracts[0].status, 'IN_PROGRESS');
    assert.equal(result.contracts[0].actualReturnDate, null);
    assert.equal(result.contracts[0].endDueDate, new Date(endDueDate).toISOString());
    assert.equal(result.contracts[0].departureConditionDate, '30/10/2026 à 08h51');
    assert.equal(result.at, new Date(NOW).toISOString());
  }
});

test('snapshot deadline and reset refuse delayed results without publishing partial data', async () => {
  let now = NOW, reads = 0;
  const slow = new MyclicarClient({ credentials: CREDS, now: () => now, fetchFn: async url => {
    if (url === PORTAL) return portal();
    if (url === API + '/auth/login') return login();
    reads++; now += 60000; return listing([contract(1)]);
  } });
  await assert.rejects(slow.snapshot(), /Délai/);
  assert.equal(reads, 1);
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { started = resolve; });
  const replaced = new MyclicarClient({ credentials: CREDS, now: () => NOW, fetchFn: async url => {
    if (url === PORTAL) return portal();
    if (url === API + '/auth/login') return login();
    started(); await held; return listing([contract(1)]);
  } });
  const pending = replaced.snapshot();
  await waiting; replaced.reset(); release();
  await assert.rejects(pending, error => error.status === 409);
});

test('contract throttling preserves the session and does not send reads before retry-after', async () => {
  let now = NOW, reads = 0, auth = 0;
  const client = new MyclicarClient({ credentials: CREDS, now: () => now, fetchFn: async url => {
    if (url === PORTAL) return portal();
    if (url === API + '/auth/login') { auth++; return login(); }
    reads++;
    return reads === 1 ? json({}, 429, { 'retry-after': '180' }) : listing([contract(1)]);
  } });
  await assert.rejects(client.snapshot(), error => error.kind === 'quota' && error.retryAfter === 180);
  await assert.rejects(client.snapshot(), error => error.kind === 'quota');
  assert.equal(reads, 1);
  now += 180000;
  assert.equal((await client.snapshot()).contracts.length, 1);
  assert.equal(auth, 1);
  assert.equal(reads, 2);
});
