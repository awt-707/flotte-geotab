import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createShareGateway } from '../server/share-gateway.mjs';

const ORIGIN='https://ludy-test.example',CODE='synthetic-access-code-for-local-tests-123456789',JWT='Bearer synthetic-user-jwt',ANON='synthetic-public-key';
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
function request(base,path='/',{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request(base+path,{method,headers:{host:new URL(ORIGIN).host,...(body?{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}:{}),...headers}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);});}
async function fixture(work,options={}){
 const seen=[],upgraded=[],upstreamSockets=new Set();let clock=Date.now();
 const make=kind=>http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const item={kind,path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()};seen.push(item);res.setHeader('Set-Cookie','upstream-private=not-for-browser');if(req.url==='/redirect'){res.writeHead(302,{Location:'https://outside.example/'});res.end();return;}if(kind==='supabase'&&req.url==='/auth/v1/user')res.statusCode=options.authStatus??(req.headers.authorization===JWT?200:401);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(item));});
 const app=make('app'),db=make('supabase');db.on('upgrade',(req,socket)=>{upgraded.push({path:req.url,headers:req.headers});upstreamSockets.add(socket);socket.on('close',()=>upstreamSockets.delete(socket));const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');});
 const appOrigin=await listen(app),supabaseOrigin=await listen(db),gateway=createShareGateway({accessCode:CODE,anonKey:ANON,appOrigin,supabaseOrigin,referenceData:'snapshot',now:()=>clock,...options}),base=await listen(gateway.server);
 const login=async()=>{const result=await request(base,'/_share/session',{method:'POST',headers:{origin:ORIGIN},body:JSON.stringify({code:CODE})});assert.equal(result.status,200);return result.headers['set-cookie'][0].split(';')[0];};
 try{await work({base,seen,upgraded,appOrigin,supabaseOrigin,gateway,login,db,advance:ms=>clock+=ms});}finally{await gateway.close();for(const socket of upstreamSockets)socket.destroy();app.closeAllConnections();db.closeAllConnections();await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>db.close(resolve))]);}
}

test('the shared page stays closed until the HTTPS origin and access code are set',async()=>fixture(async f=>{
 assert.equal((await request(f.base)).status,503);f.gateway.setPublicOrigin(ORIGIN);const gate=await request(f.base,'/',{headers:{accept:'text/html'}});assert.equal(gate.status,200);assert.match(gate.text,/Code de partage/);assert.doesNotMatch(gate.text,new RegExp(CODE));assert.match(gate.headers['content-security-policy'],/script-src 'nonce-/);assert.equal(f.seen.length,0);
 for(const path of ['/config.js','/api/fleet/overview','/supabase/rest/v1/vehicles'])assert.equal((await request(f.base,path,{headers:{accept:'application/json'}})).status,401);assert.equal(f.seen.length,0);
 assert.equal((await request(f.base,'/_share/session',{method:'POST',body:JSON.stringify({code:CODE})})).status,403);
 const login=await request(f.base,'/_share/session',{method:'POST',headers:{origin:ORIGIN},body:JSON.stringify({code:CODE})});assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800/);
}));

test('the access cookie expires and logout removes it without touching Ludy JWTs',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();assert.equal((await request(f.base,'/config.js',{headers:{cookie}})).status,200);f.advance(8*3600000+1);assert.equal((await request(f.base,'/config.js',{headers:{cookie,accept:'application/json'}})).status,401);
 const next=await f.login();assert.equal((await request(f.base,'/_share/logout',{method:'POST',headers:{cookie:next,origin:ORIGIN}})).status,200);assert.equal((await request(f.base,'/api/fleet/overview',{headers:{cookie:next,authorization:JWT}})).status,401);
}));

test('configuration uses only the shared same origin and keeps staging reference flags',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login(),result=await request(f.base,'/config.js',{headers:{cookie}});assert.equal(result.status,200);assert.match(result.text,/"SUPABASE_URL":"https:\/\/ludy-test.example\/supabase"/);assert.match(result.text,/"SHARED_STAGING":true/);assert.match(result.text,/"REFERENCE_DATA":"snapshot"/);assert.doesNotMatch(result.text,/57421|serviceKey|service_role/);assert.match(result.headers['content-security-policy'],/wss:\/\/ludy-test.example/);assert.doesNotMatch(result.headers['content-security-policy'],/127\.0\.0\.1/);
}));

test('business proxy preserves user JWT and rewrites only the local transport origin',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login(),result=await request(f.base,'/api/parking/zones',{method:'POST',headers:{cookie,origin:ORIGIN,authorization:JWT,'x-forwarded-host':'ignored.example'},body:'{"name":"Synthetic zone"}'});assert.equal(result.status,200);const actual=f.seen.at(-1);assert.equal(actual.kind,'app');assert.equal(actual.headers.authorization,JWT);assert.equal(actual.headers.host,new URL(f.appOrigin).host);assert.equal(actual.headers.origin,f.appOrigin);assert.equal(actual.headers.cookie,undefined);assert.equal(actual.headers['x-forwarded-host'],undefined);assert.equal(result.headers['set-cookie'],undefined);
 assert.equal((await request(f.base,'/api/fleet/overview',{headers:{cookie}})).status,401);assert.equal((await request(f.base,'/api/fleet/overview',{headers:{cookie,authorization:JWT,origin:'https://another.example'}})).status,403);
}));

test('Supabase REST preserves JWT and RLS while the gateway supplies only its public key',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();for(const [method,path,body]of [['GET','/supabase/rest/v1/vehicles?select=key',undefined],['POST','/supabase/rest/v1/rpc/session_ping','{}'],['PATCH','/supabase/rest/v1/fleet_parking_zones?id=eq.1','{"name":"Synthetic"}']]){const result=await request(f.base,path,{method,headers:{cookie,origin:ORIGIN,authorization:JWT,apikey:'different-client-key'},body});assert.equal(result.status,200);const actual=f.seen.at(-1);assert.equal(actual.kind,'supabase');assert.equal(actual.headers.authorization,JWT);assert.equal(actual.headers.apikey,ANON);assert.equal(actual.headers['accept-profile'],'public');assert.equal(actual.headers['content-profile'],'public');assert.ok(!actual.path.startsWith('/supabase'));}
}));

test('only normal password login, token refresh and current-user auth endpoints are exposed',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();for(const grant of ['password','refresh_token']){const response=await request(f.base,'/supabase/auth/v1/token?grant_type='+grant,{method:'POST',headers:{cookie,origin:ORIGIN},body:'{}'});assert.equal(response.status,200);assert.equal(f.seen.at(-1).headers.apikey,ANON);}
 for(const path of ['/supabase/auth/v1/signup','/supabase/auth/v1/recover','/supabase/auth/v1/admin/users','/supabase/auth/v1/token?grant_type=client_credentials'])assert.equal((await request(f.base,path,{method:'POST',headers:{cookie,origin:ORIGIN,authorization:JWT},body:'{}'})).status,403);
 assert.equal((await request(f.base,'/supabase/auth/v1/user',{headers:{cookie,authorization:JWT}})).status,200);
}));

test('connector controls and browser ingestion remain local while business screens stay available',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();for(const path of ['/api/fleet/geotab/connect','/api/fleet/bolt/start','/api/fleet/myclicar/start','/api/fleet/pair','/api/fleet/uber/ingest','/api/uber-reports/browser/claim','/api/uber-reports/bridge/ingest','/api/uber-reports/settings','/api/operations/driver-accounts','/api/operations/driver-accounts/synthetic/reset','/api/operations/driver-accounts/synthetic/revoke'])assert.equal((await request(f.base,path,{method:'POST',headers:{cookie,origin:ORIGIN,authorization:JWT},body:'{}'})).status,403);
 for(const path of ['/api/fleet/overview','/api/fleet/geotab/live','/api/parking/overview','/api/driver-performance/drivers','/api/operations/events'])assert.equal((await request(f.base,path,{headers:{cookie,authorization:JWT}})).status,200);
}));

test('PDF reads and signed-link creation pass through without exposing storage administration',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();for(const [method,path]of [['POST','/supabase/storage/v1/object/sign/contrats/local-document.pdf'],['POST','/supabase/storage/v1/object/list/contrats'],['GET','/supabase/storage/v1/object/sign/contrats/local-document.pdf?token=synthetic'],['GET','/supabase/storage/v1/object/authenticated/contrats/local-document.pdf']])assert.equal((await request(f.base,path,{method,headers:{cookie,origin:ORIGIN,authorization:JWT},body:method==='POST'?'{}':undefined})).status,200);
 for(const path of ['/supabase/storage/v1/bucket','/supabase/functions/v1/task','/supabase/graphql/v1'])assert.equal((await request(f.base,path,{method:'POST',headers:{cookie,origin:ORIGIN,authorization:JWT},body:'{}'})).status,403);
}));

test('bad share codes are bounded and changing the tunnel origin invalidates active sessions',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();for(let i=0;i<9;i++)assert.equal((await request(f.base,'/_share/session',{method:'POST',headers:{origin:ORIGIN},body:'{"code":"incorrect"}'})).status,403);assert.equal((await request(f.base,'/_share/session',{method:'POST',headers:{origin:ORIGIN},body:'{"code":"incorrect"}'})).status,429);
 f.gateway.setPublicOrigin('https://new-ludy-test.example');assert.equal((await request(f.base,'/config.js',{headers:{cookie}})).status,403);assert.equal((await request(f.base,'/config.js',{headers:{cookie,host:'new-ludy-test.example',accept:'application/json'}})).status,401);
}));

test('upstream redirects are not followed or exposed to the shared client',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login(),result=await request(f.base,'/redirect',{headers:{cookie}});assert.equal(result.status,502);assert.equal(result.headers.location,undefined);
}));

test('Realtime uses the same access session and closes when that session is revoked',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();const socket=await new Promise((resolve,reject)=>{const req=http.request(f.base+'/supabase/realtime/v1/websocket?apikey='+ANON+'&vsn=1.0.0',{headers:{host:new URL(ORIGIN).host,origin:ORIGIN,cookie,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}},(res)=>reject(Error('Status '+res.statusCode)));req.on('upgrade',(_res,socket)=>resolve(socket));req.on('error',reject);req.end();});assert.equal(f.upgraded.length,1);assert.equal(f.upgraded[0].headers.cookie,undefined);assert.equal(f.upgraded[0].headers.apikey,ANON);assert.equal(f.upgraded[0].headers.origin,f.supabaseOrigin);const closed=once(socket,'close');await request(f.base,'/_share/logout',{method:'POST',headers:{cookie,origin:ORIGIN}});await closed;
}));

test('the spreadsheet worker retains its networkless content security policy',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login(),result=await request(f.base,'/spreadsheet-worker.js',{headers:{cookie}});assert.equal(result.status,200);assert.equal(result.headers['content-security-policy'],"default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'");
}));

test('password retries are limited without limiting normal token refresh',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();const login=grant=>request(f.base,'/supabase/auth/v1/token?grant_type='+grant,{method:'POST',headers:{cookie,origin:ORIGIN},body:'{}'});
 for(let i=0;i<20;i++)assert.equal((await login('password')).status,200);const denied=await login('password');assert.equal(denied.status,429);assert.equal(denied.headers['retry-after'],'60');assert.equal((await login('refresh_token')).status,200);f.advance(60001);assert.equal((await login('password')).status,200);
}));

test('closing the gateway closes a pending Realtime handshake immediately',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();f.db.removeAllListeners('upgrade');let remote;const reached=new Promise(resolve=>f.db.once('upgrade',(_req,socket)=>{remote=socket;resolve();}));
 const stopped=new Promise(resolve=>{const req=http.request(f.base+'/supabase/realtime/v1/websocket?apikey='+ANON+'&vsn=1.0.0',{headers:{host:new URL(ORIGIN).host,origin:ORIGIN,cookie,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}});req.on('error',()=>resolve());req.on('close',()=>resolve());req.end();});
 await reached;await f.gateway.close();await stopped;remote.destroy();
}));

test('hosted account mode exposes the login shell and health but requires bearer authorization for data',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);
 for(const path of ['/','/health','/config.js'])assert.equal((await request(f.base,path)).status,200);
 assert.ok(f.seen.some(x=>x.path==='/health'));
 for(const path of ['/api/fleet/overview','/supabase/rest/v1/vehicles','/supabase/auth/v1/user'])assert.equal((await request(f.base,path)).status,401);
 const response=await request(f.base,'/supabase/rest/v1/vehicles',{headers:{authorization:JWT}});assert.equal(response.status,200);assert.equal(f.seen.at(-1).headers.authorization,JWT);
 assert.equal((await request(f.base,'/_share/session',{method:'POST',headers:{origin:ORIGIN},body:JSON.stringify({code:CODE})})).status,404);
 assert.equal((await request(f.base,'/health',{headers:{host:'untrusted.example'}})).status,403);
 assert.equal((await request(f.base,'/api/fleet/geotab/connect',{method:'POST',headers:{origin:ORIGIN,authorization:JWT},body:'{}'})).status,403);
},{accessMode:'account',accessCode:undefined}));

test('hosted password rate limiting survives absent cookies and stays separate per trusted proxy client',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);
 const login=ip=>request(f.base,'/supabase/auth/v1/token?grant_type=password',{method:'POST',headers:{origin:ORIGIN,'x-real-ip':ip},body:'{}'});
 for(let i=0;i<20;i++)assert.equal((await login('192.0.2.10')).status,200);
 assert.equal((await login('192.0.2.10')).status,429);
 assert.equal((await login('192.0.2.11')).status,200);
 assert.equal(f.seen.at(-1).headers['x-real-ip'],undefined);
 assert.equal((await request(f.base,'/supabase/auth/v1/token?grant_type=password',{method:'POST',body:'{}'})).status,403);
 f.advance(60001);assert.equal((await login('192.0.2.10')).status,200);
},{accessMode:'account'}));

test('hosted Realtime uses its HTTPS origin and keeps provider controls private',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);
 const socket=await new Promise((resolve,reject)=>{const req=http.request(f.base+'/supabase/realtime/v1/websocket?apikey='+ANON+'&vsn=1.0.0',{headers:{host:new URL(ORIGIN).host,origin:ORIGIN,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}},res=>reject(Error('Status '+res.statusCode)));req.on('upgrade',(_res,socket)=>resolve(socket));req.on('error',reject);req.end();});
 assert.equal(f.upgraded.length,1);assert.equal(f.upgraded[0].headers.apikey,ANON);
 const closed=once(socket,'close');await f.gateway.close();await closed;
},{accessMode:'account'}));

test('hosted document writes verify the user before forwarding only allowed buckets with the same JWT',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);
 for(const bucket of ['contrats','manifestes','plannings','devis','rh']){
  const path='/supabase/storage/v1/object/'+bucket+'/synthetic.pdf',before=f.seen.length;
  assert.equal((await request(f.base,path,{method:'POST',headers:{origin:ORIGIN,authorization:JWT,'content-type':'application/pdf',apikey:'untrusted-key'},body:'%PDF synthetic'})).status,200);
  const [check,upload]=f.seen.slice(before);assert.equal(check.path,'/auth/v1/user');assert.equal(check.method,'GET');assert.equal(check.body,'');assert.equal(check.headers.apikey,ANON);assert.equal(check.headers.authorization,JWT);
  assert.equal(upload.path,path.slice('/supabase'.length));assert.equal(upload.body,'%PDF synthetic');assert.equal(upload.headers.authorization,JWT);assert.equal(upload.headers.apikey,ANON);assert.equal(upload.headers['content-type'],'application/pdf');
  assert.equal((await request(f.base,'/supabase/storage/v1/object/'+bucket,{method:'DELETE',headers:{origin:ORIGIN,authorization:JWT},body:JSON.stringify({prefixes:['synthetic.pdf']})})).status,200);
  assert.equal(f.seen.at(-1).method,'DELETE');assert.deepEqual(JSON.parse(f.seen.at(-1).body),{prefixes:['synthetic.pdf']});
 }
 for(const path of ['/supabase/storage/v1/object/unknown/file.pdf','/supabase/storage/v1/bucket/rh','/supabase/storage/v1/object/copy','/supabase/storage/v1/object/move'])assert.equal((await request(f.base,path,{method:'POST',headers:{origin:ORIGIN,authorization:JWT},body:'{}'})).status,403);
},{accessMode:'account'}));

test('hosted document writes reject missing or expired authentication without forwarding the file',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const path='/supabase/storage/v1/object/rh/synthetic.pdf';
 assert.equal((await request(f.base,path,{method:'POST',headers:{origin:ORIGIN},body:'synthetic document'})).status,401);assert.equal(f.seen.length,0);
 assert.equal((await request(f.base,path,{method:'POST',headers:{origin:ORIGIN,authorization:'Bearer expired-user'},body:'synthetic document'})).status,401);assert.equal(f.seen.length,1);assert.equal(f.seen[0].path,'/auth/v1/user');assert.equal(f.seen[0].body,'');
},{accessMode:'account'}));

test('document authentication outages fail closed and oversized requests are rejected before Auth or Storage',async()=>{
 await fixture(async f=>{f.gateway.setPublicOrigin(ORIGIN);assert.equal((await request(f.base,'/supabase/storage/v1/object/rh/synthetic.pdf',{method:'POST',headers:{origin:ORIGIN,authorization:JWT},body:'synthetic document'})).status,502);assert.equal(f.seen.length,1);assert.equal(f.seen[0].path,'/auth/v1/user');},{accessMode:'account',authStatus:503});
 await fixture(async f=>{f.gateway.setPublicOrigin(ORIGIN);const rejected=await request(f.base,'/supabase/storage/v1/object/rh/synthetic.pdf',{method:'POST',headers:{origin:ORIGIN,authorization:JWT,'content-length':String(8*1024*1024+1)}});assert.equal(rejected.status,413);assert.equal(f.seen.length,0);},{accessMode:'account'});
});

test('invitation sharing still refuses document writes and the separate driver portal',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const cookie=await f.login();
 for(const path of ['/supabase/storage/v1/object/rh/synthetic.pdf','/api/driver/login'])assert.equal((await request(f.base,path,{method:'POST',headers:{cookie,origin:ORIGIN,authorization:JWT},body:'{}'})).status,403);
 assert.equal((await request(f.base,'/supabase/storage/v1/object/rh',{method:'DELETE',headers:{cookie,origin:ORIGIN,authorization:JWT},body:'{"prefixes":["synthetic.pdf"]}'})).status,403);assert.equal(f.seen.length,0);
}));

test('hosted driver routes preserve the personal token and replace all incoming internal client-IP headers',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const driver='Bearer dps_'+'a'.repeat(43),notification='12345678-1234-1234-1234-123456789012';
 for(const [method,path]of [['POST','/api/driver/login'],['GET','/api/driver/me'],['POST','/api/driver/reports'],['POST','/api/driver/notifications/'+notification+'/ack'],['POST','/api/driver/logout']]){
  const result=await request(f.base,path,{method,headers:{origin:ORIGIN,'x-real-ip':'192.0.2.42','x-ludy-client-ip':'198.51.100.77',...(path.endsWith('/login')?{}:{authorization:driver})},body:method==='POST'?'{}':undefined});assert.equal(result.status,200,path);
  const actual=f.seen.at(-1);assert.equal(actual.kind,'app');assert.equal(actual.headers['x-ludy-client-ip'],'192.0.2.42');assert.equal(actual.headers['x-real-ip'],undefined);assert.equal(actual.headers.authorization,path.endsWith('/login')?undefined:driver);
 }
 assert.equal((await request(f.base,'/api/driver/me',{headers:{authorization:JWT}})).status,401);
 for(const path of ['/api/driver/unknown','/api/driver/reports/123','/api/driver/notifications/not-a-uuid/ack','/api/driver/login?next=anything'])assert.equal((await request(f.base,path,{method:'POST',headers:{origin:ORIGIN,authorization:driver},body:'{}'})).status,403);
 const before=f.seen.length;assert.equal((await request(f.base,'/api/driver/reports',{method:'POST',headers:{origin:ORIGIN,authorization:driver,'content-length':'16385'}})).status,413);assert.equal(f.seen.length,before);
},{accessMode:'account'}));

test('hosted driver login limits follow the trusted Caddy IP without blocking another driver address',async()=>fixture(async f=>{
 f.gateway.setPublicOrigin(ORIGIN);const login=ip=>request(f.base,'/api/driver/login',{method:'POST',headers:{origin:ORIGIN,'x-real-ip':ip},body:'{}'});
 for(let i=0;i<15;i++)assert.equal((await login('192.0.2.10')).status,200);
 const denied=await login('192.0.2.10');assert.equal(denied.status,429);assert.equal(denied.headers['retry-after'],'600');assert.equal((await login('192.0.2.11')).status,200);
 assert.equal((await login('2001:DB8::2')).status,200);assert.equal(f.seen.at(-1).headers['x-ludy-client-ip'],'2001:db8::2');
 assert.equal((await login('invalid address')).status,200);assert.equal(f.seen.at(-1).headers['x-ludy-client-ip'],'127.0.0.1');
 f.advance(600001);assert.equal((await login('192.0.2.10')).status,200);
},{accessMode:'account'}));
