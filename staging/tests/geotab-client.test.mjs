import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeotabClient, readGeotabCredentials, saveGeotabCredentials, validateGeotabCredentials } from '../server/geotab.mjs';

const NOW = Date.parse('2026-10-30T13:00:00Z');
const CREDS = { database: 'test_database', userName: 'test@example.invalid', password: ' SECRET password ' };
const response = (result, status = 200, headers = {}) => new Response(JSON.stringify({ result }), { status, headers });
const failure = (name, message = 'upstream private detail', status = 200, headers = {}) => new Response(JSON.stringify({ error: { errors: [{ name }], message } }), { status, headers });
const login = (sessionId = 'SESSION', host = 'my42.geotab.com') => response({ path: host, credentials: { ...CREDS, sessionId, extra: 'must not propagate' } });
const status = (id, extra = {}) => ({ device: { id }, dateTime: new Date(NOW).toISOString(), latitude: 31.63, longitude: -8, speed: 0, bearing: 40, isDriving: false, isDeviceCommunicating: true, currentStateDuration: '1.02:03:04', ...extra });

test('validation trims account and database but preserves the password exactly', () => {
  assert.deepEqual(validateGeotabCredentials({ ...CREDS, database: ' test_database ', userName: ' test@example.invalid ' }), CREDS);
  for (const input of [null, { ...CREDS, password: '' }, { ...CREDS, database: 'https://host' }, { ...CREDS, userName: 'a\nb' }]) assert.throws(() => validateGeotabCredentials(input), e => e.status === 400);
});

test('credentials are atomic private files; public permissions and symlinks are refused', async () => {
  const local = fileURLToPath(new URL('../.local/', import.meta.url)); await fs.mkdir(local, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(local, 'geotab-client-test-')), filename = path.join(directory, 'credentials.json');
  try {
    assert.equal(await readGeotabCredentials(filename), null);
    await saveGeotabCredentials(filename, CREDS);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600); assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await readGeotabCredentials(filename), CREDS);
    await saveGeotabCredentials(filename, { ...CREDS, password: 'replacement' });
    assert.equal((await readGeotabCredentials(filename)).password, 'replacement');
    assert.deepEqual(await fs.readdir(directory), ['credentials.json']);
    await fs.chmod(filename, 0o644); await assert.rejects(readGeotabCredentials(filename), /0600/);
    await fs.chmod(filename, 0o600); await fs.symlink(filename, path.join(directory, 'link.json'));
    await assert.rejects(readGeotabCredentials(path.join(directory, 'link.json')), /Lecture des identifiants/);
    await fs.writeFile(filename, 'private malformed content');
    await assert.rejects(readGeotabCredentials(filename), e => !e.message.includes('malformed') && e.status === 409);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('authentication is shared, session reused, password never forwarded to Get', async () => {
  const requests = []; let auth = 0;
  const client = new GeotabClient({ credentials: async () => CREDS, now: () => NOW, fetchFn: async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST'); assert.ok(options.signal);
    if (body.method === 'Authenticate') { auth++; assert.equal(url, 'https://my.geotab.com/apiv1'); assert.deepEqual(body.params, CREDS); return login(); }
    assert.equal(url, 'https://my42.geotab.com/apiv1'); assert.equal(body.method, 'Get');
    assert.deepEqual(body.params.credentials, { database: CREDS.database, userName: CREDS.userName, sessionId: 'SESSION' });
    assert.ok(!options.body.includes(CREDS.password)); assert.ok(!options.body.includes('must not propagate'));
    assert.equal(body.params.typeName, 'Device'); assert.equal(body.params.resultsLimit, 500); assert.equal(body.params.search.fromDate, new Date(NOW).toISOString());
    assert.equal(body.params.sort.sortBy, 'id'); assert.equal('lastId' in body.params.sort, false);
    assert.deepEqual(body.params.propertySelector, { fields: ['id', 'name', 'licensePlate', 'vehicleIdentificationNumber'], isIncluded: true });
    return response(body.params.sort.offset ? [] : [{ id: 'b1', name: 'Test vehicle', licensePlate: 'TEST-1', vehicleIdentificationNumber:' synthetic-vin ', privateExtra: 'not returned' }]);
  } });
  const expected = [{ id: 'b1', name: 'Test vehicle', plate: 'TEST-1', vin:'SYNTHETIC-VIN' }];
  assert.deepEqual(await Promise.all([client.devices(), client.devices()]), [expected, expected]); await client.devices();
  assert.equal(auth, 1); assert.equal(requests.length, 7); assert.deepEqual([...new Set(requests.map(x => x.body.method))], ['Authenticate', 'Get']);
  client.reset(); await client.devices(); assert.equal(auth, 2);
});

test('authentication cannot redirect calls or credentials outside Geotab hostnames', async () => {
  for (const host of ['https://my42.geotab.com', 'my42.geotab.com:443', 'my42.geotab.com/path', 'my42.geotab.com.evil.invalid', '127.0.0.1', 'user@my42.geotab.com']) {
    let calls = 0;
    const client = new GeotabClient({ credentials: async () => CREDS, fetchFn: async () => { calls++; return login('SESSION', host); } });
    await assert.rejects(client.devices(), /authentification Geotab invalide/); assert.equal(calls, 1);
  }
});

test('errors do not return provider messages, credentials or session tokens', async () => {
  const privateDetail = CREDS.password + ' SECRET_SESSION';
  const client = new GeotabClient({ credentials: async () => CREDS, fetchFn: async (_url, options) => JSON.parse(options.body).method === 'Authenticate' ? login() : failure('UnexpectedException', privateDetail) });
  await assert.rejects(client.devices(), e => e.message === 'Lecture Geotab indisponible' && !JSON.stringify(e).includes('SECRET'));
  const network = new GeotabClient({ credentials: async () => CREDS, fetchFn: async () => { throw new Error(privateDetail); } });
  await assert.rejects(network.devices(), e => e.message === 'Connexion Geotab indisponible' && !JSON.stringify(e).includes('SECRET'));
});

test('expired sessions reauthenticate once and repeated invalid credentials stop', async () => {
  let auth = 0, get = 0;
  const client = new GeotabClient({ credentials: async () => CREDS, fetchFn: async (_url, options) => {
    const body = JSON.parse(options.body); if (body.method === 'Authenticate') return login('SESSION' + ++auth);
    get++; return get === 1 ? failure('InvalidUserException') : response([]);
  } });
  assert.deepEqual(await client.devices(), []); assert.equal(auth, 2); assert.equal(get, 2);
  let refusedAuth = 0, refusedGet = 0;
  const refused = new GeotabClient({ credentials: async () => CREDS, fetchFn: async (_url, options) => {
    if (JSON.parse(options.body).method === 'Authenticate') { refusedAuth++; return login(); }
    refusedGet++; return failure('InvalidUserException');
  } });
  await assert.rejects(refused.devices(), e => e.kind === 'authentication'); assert.equal(refusedAuth, 2); assert.equal(refusedGet, 2);
});

test('catalogues beyond 2000 devices are paged to an empty page, including an exact page boundary', async () => {
  for (const count of [2000, 2501, 20000, 20001]) {
    const catalogue=Array.from({length:count},(_,i)=>({id:'b'+i,name:'Test '+i,licensePlate:'TEST-'+i}));
    const pages=[];let auth=0;
    const client=new GeotabClient({credentials:async()=>CREDS,now:()=>NOW,fetchFn:async(_url,options)=>{
      const {method,params}=JSON.parse(options.body);if(method==='Authenticate'){auth++;return login();}
      assert.equal(method,'Get');assert.equal(params.typeName,'Device');assert.equal('lastId' in params.sort,false);
      assert.equal(params.search.fromDate,new Date(NOW).toISOString());
      const index=params.sort.offset===null?0:catalogue.findIndex(row=>row.id===params.sort.offset)+1;
      assert.ok(index>=0);const rows=catalogue.slice(index,index+params.resultsLimit);pages.push(rows.length);return response(rows);
    }});
    if(count>20000){await assert.rejects(client.devices(),/supérieur à 20 000/);assert.equal(pages.length,41);continue;}
    const result=await client.devices();assert.equal(result.length,count);assert.equal(result.at(-1).id,catalogue.at(-1).id);assert.equal(pages.at(-1),0);assert.equal(auth,1);
    assert.equal(pages.length,Math.ceil(count/500)+1);
  }
});

test('catalogue deduplicates boundary overlap and rejects a repeated or oversized page', async () => {
  let loop=false;
  const client=new GeotabClient({credentials:async()=>CREDS,fetchFn:async(_url,options)=>{
    const {method,params}=JSON.parse(options.body);if(method==='Authenticate')return login();
    if(loop||params.sort.offset===null)return response([{id:'b1',name:'One'},{id:'b1',name:'Duplicate'}]);
    if(params.sort.offset==='b1')return response([{id:'b1'},{id:'b2',name:'Two'}]);
    return response([]);
  }});
  assert.deepEqual(await client.devices(),[{id:'b1',name:'One',plate:'',vin:''},{id:'b2',name:'Two',plate:'',vin:''}]);
  loop=true;await assert.rejects(client.devices(),/ne progresse plus/);
  const oversized=new GeotabClient({credentials:async()=>CREDS,fetchFn:async(_url,options)=>JSON.parse(options.body).method==='Authenticate'?login():response(Array.from({length:501},(_,i)=>({id:'b'+i})))});
  await assert.rejects(oversized.devices(),/résultat incomplet refusé/);
});

test('catalogue aborts rather than returning partial data after a later page failure or time budget', async()=>{
  let clock=NOW,expired=false;
  const client=new GeotabClient({credentials:async()=>CREDS,now:()=>clock,fetchFn:async(_url,options)=>{
    const {method,params}=JSON.parse(options.body);if(method==='Authenticate')return login();
    if(params.sort.offset===null)return response([{id:'b1'}]);
    if(expired){clock+=60001;return response([]);}
    return failure('OverLimitException');
  }});
  await assert.rejects(client.devices(),e=>e.kind==='quota');expired=true;clock+=120000;
  await assert.rejects(client.devices(),/catalogue Geotab trop longue/);
});

test('positions never infer offline or parked from missing data or unavailable ignition', async () => {
  const rows = {
    moving: status('moving', { isDriving: true, speed: 23.5 }),
    stopped: status('stopped'),
    old: status('old', { dateTime: new Date(NOW - 181000).toISOString(), isDriving: true }),
    offline: status('offline', { isDeviceCommunicating: false }),
    parked: status('parked'),
    missing: null
  };
  const client = new GeotabClient({ credentials: async () => CREDS, now: () => NOW, fetchFn: async (_url, options) => {
    const { method, params } = JSON.parse(options.body); if (method === 'Authenticate') return login();
    assert.equal(method, 'ExecuteMultiCall');
    return response(params.calls.map(({params: call}) => {
      const id = call.search.deviceSearch.id;
      if (call.typeName === 'DeviceStatusInfo') return rows[id] ? [rows[id]] : [];
      assert.equal(call.typeName, 'StatusData'); assert.equal(call.search.fromDate, call.search.toDate); assert.equal(call.search.diagnosticSearch.id, 'DiagnosticIgnitionId');
      return id === 'parked' ? [{ device: { id }, dateTime: new Date(NOW).toISOString(), data: 0 }] : [];
    }));
  } });
  const positions = await client.positions(Object.keys(rows)), states = Object.fromEntries(positions.map(p => [p.id, p.state]));
  assert.deepEqual(states, { moving: 'En route', stopped: 'Arrêté, contact inconnu', old: 'Position ancienne', offline: 'Boîtier hors ligne', parked: 'Garé', missing: 'Pas de réponse Geotab' });
  assert.equal(positions.find(p => p.id === 'stopped').ign_on, null); assert.equal(positions.find(p => p.id === 'moving').speed, 23.5);
  assert.equal(positions.find(p => p.id === 'old').at, rows.old.dateTime); assert.equal(positions.find(p => p.id === 'missing').at, null);
});

test('eleven vehicles use one scoped batch; a hundred use four non-overlapping batches', async () => {
  let concurrent = 0, maximum = 0, batches = 0; const seen = new Set(), ids = Array.from({length:100},(_,i) => 'b'+i);
  const client = new GeotabClient({ credentials: async () => CREDS, now: () => NOW, fetchFn: async (_url, options) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      const { method, params } = JSON.parse(options.body); if (method === 'Authenticate') return login();
      assert.equal(method, 'ExecuteMultiCall'); batches++;
      assert.ok(params.calls.length<=50);assert.equal(params.calls.length%2,0);
      assert.ok(!options.body.includes(CREDS.password));
      assert.deepEqual(params.credentials,{database:CREDS.database,userName:CREDS.userName,sessionId:'SESSION'});
      return response(params.calls.map(call=>{
        assert.equal(call.method,'Get');assert.equal('credentials' in call.params,false);
        const id=call.params.search.deviceSearch.id;assert.ok(ids.includes(id));seen.add(id);
        assert.ok(['DeviceStatusInfo','StatusData'].includes(call.params.typeName));
        assert.equal(call.params.resultsLimit,call.params.typeName==='DeviceStatusInfo'?2:100);
        return call.params.typeName==='DeviceStatusInfo'?[status(id)]:[];
      }));
    } finally { concurrent--; }
  } });
  assert.equal((await client.positions(ids.slice(0,11))).length,11);assert.equal(batches,1);
  batches=0;assert.equal((await client.positions(ids)).length, ids.length); assert.equal(seen.size, ids.length); assert.equal(maximum,1);assert.equal(batches,4);
  const before = seen.size; await assert.rejects(client.positions(Array.from({ length: 101 }, (_, i) => 'b' + i)), /100 véhicules/); assert.equal(seen.size, before);
});

test('quota delays recognize HTTP-date Retry-After as well as numeric seconds',async()=>{
 for(const [header,expected] of [[new Date(NOW+600000).toUTCString(),600],['120.2',121],['not-a-date',120]]){
  const client=new GeotabClient({credentials:async()=>CREDS,now:()=>NOW,fetchFn:async(_url,options)=>JSON.parse(options.body).method==='Authenticate'?login():failure('OverLimitException','private',429,{'retry-after':header})});
  await assert.rejects(client.positions(['b1']),error=>error.status===429&&error.retryAfter===expected&&error.kind==='quota'&&!error.message.includes('private'));
 }
});

test('quota errors include bounded retry information and never become empty success', async () => {
  let calls=0;
  const client = new GeotabClient({ credentials: async () => CREDS, now: () => NOW, fetchFn: async (_url, options) => {
    calls++;const { method } = JSON.parse(options.body); if (method === 'Authenticate') return login();
    assert.equal(method,'ExecuteMultiCall');
    return failure('OverLimitException', 'private', 429, { 'retry-after': '9000' });
  } });
  await assert.rejects(client.positions(['b1']), e => e.status === 429 && e.retryAfter === 9000 && e.kind === 'quota');
  assert.equal(calls,2,'quota must not trigger an optional-contact fallback');
});
test('a two-hour Geotab quota is shared by all reads and survives a session reset',async()=>{
 for(const dated of [false,true])for(const authLimited of [false,true]){
  let time=NOW,calls=0,limited=true;const header=dated?new Date(time+7200000).toUTCString():'7200';
  const client=new GeotabClient({credentials:async()=>CREDS,now:()=>time,fetchFn:async(_url,options)=>{calls++;const {method}=JSON.parse(options.body);return limited&&(authLimited||method!=='Authenticate')?failure('OverLimitException','private',429,{'retry-after':header}):method==='Authenticate'?login():response([]);}});
  await assert.rejects(client.devices(),e=>e.kind==='quota'&&e.retryAfter===7200);const firstCalls=calls;
  time+=3600000;await assert.rejects(client.positions(['b1']),e=>e.kind==='quota'&&e.retryAfter===3600);assert.equal(calls,firstCalls);
  client.reset();time+=3599999;await assert.rejects(client.devices(),e=>e.kind==='quota'&&e.retryAfter===1);assert.equal(calls,firstCalls);
  time++;limited=false;assert.deepEqual(await client.devices(),[]);assert.equal(calls,firstCalls+2);
 }
});

test('optional contact permission failure retries positions only and cools down before retrying contact',async()=>{
  let clock=NOW;const batches=[];
  const client=new GeotabClient({credentials:async()=>CREDS,now:()=>clock,fetchFn:async(_url,options)=>{
    const {method,params}=JSON.parse(options.body);if(method==='Authenticate')return login();
    const types=params.calls.map(call=>call.params.typeName);batches.push(types);
    if(types.includes('StatusData'))return new Response(JSON.stringify({error:{message:CREDS.password,data:{type:'SecurityException',requestIndex:1}}}));
    return response(params.calls.map(call=>[status(call.params.search.deviceSearch.id)]));
  }});
  const first=await client.positions(['b1','b2']);assert.ok(first.every(p=>p.state==='Arrêté, contact inconnu'&&p.ign_on===null));
  assert.deepEqual(batches.map(batch=>batch.length),[4,2]);
  clock+=5000;await client.positions(['b1','b2']);assert.deepEqual(batches.at(-1),['DeviceStatusInfo','DeviceStatusInfo']);
  assert.equal(batches.length,3);
  clock+=30000;await client.positions(['b1','b2']);assert.equal(batches.length,5);assert.ok(batches[3].includes('StatusData'));
});

test('required-position permissions and malformed/partial batch results are not hidden',async()=>{
  const invalid=[{error:{data:{type:'SecurityException',requestIndex:0}}},{result:[]},{result:[[],{error:'private'}]},{result:[[status('b1'),status('b1')],[]]}];
  for(const body of invalid){
    let batches=0;
    const client=new GeotabClient({credentials:async()=>CREDS,fetchFn:async(_url,options)=>{
      if(JSON.parse(options.body).method==='Authenticate')return login();batches++;return new Response(JSON.stringify(body));
    }});
    await assert.rejects(client.positions(['b1']),e=>!e.message.includes('private'));
    assert.equal(batches,1);
  }
});

test('an expired session in a batch is renewed once and its same scoped calls are retried',async()=>{
  let auth=0;const seen=[];
  const client=new GeotabClient({credentials:async()=>CREDS,now:()=>NOW,fetchFn:async(_url,options)=>{
    const {method,params}=JSON.parse(options.body);if(method==='Authenticate')return login('SESSION'+ ++auth);
    seen.push(params.calls);if(seen.length===1)return failure('InvalidUserException');
    assert.equal(params.credentials.sessionId,'SESSION2');return response(params.calls.map(call=>call.params.typeName==='DeviceStatusInfo'?[status('b1')]:[]));
  }});
  assert.equal((await client.positions(['b1']))[0].id,'b1');assert.equal(auth,2);assert.deepEqual(seen[0],seen[1]);
});

test('a failure in a later batch rejects the whole snapshot without returning earlier vehicles',async()=>{
  let batches=0;
  const client=new GeotabClient({credentials:async()=>CREDS,fetchFn:async(_url,options)=>{
    const {method,params}=JSON.parse(options.body);if(method==='Authenticate')return login();
    if(++batches===2)return failure('OverLimitException');
    return response(params.calls.map(call=>call.params.typeName==='DeviceStatusInfo'?[status(call.params.search.deviceSearch.id)]:[]));
  }});
  await assert.rejects(client.positions(Array.from({length:50},(_,i)=>'b'+i)),e=>e.kind==='quota');assert.equal(batches,2);
});

test('reset during authentication prevents an old session from becoming current', async () => {
  let release, auth = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new GeotabClient({ credentials: async () => CREDS, fetchFn: async (_url, options) => {
    if (JSON.parse(options.body).method !== 'Authenticate') return response([]);
    if (++auth === 1) await gate;
    return login();
  } });
  const first = client.devices(); await new Promise(resolve => setImmediate(resolve)); client.reset(); release();
  await assert.rejects(first, /Connexion Geotab remplacée/); assert.equal(client.session, null);
  assert.deepEqual(await client.devices(), []); assert.equal(auth, 2);
});
