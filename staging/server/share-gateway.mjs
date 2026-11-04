import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

// Hosted document uploads are bounded to 8 MiB for the complete request, including
// multipart overhead. Driver requests and storage deletion lists use 16 KiB.
const COOKIE='__Host-LudyShare',SESSION_MS=8*3600000,MAX_BODY=8*1024*1024;
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE']);
const REQUEST_HEADERS=['accept','accept-language','authorization','apikey','content-type','content-length','prefer','range','range-unit','if-none-match','if-modified-since','x-client-info','x-supabase-api-version','content-profile','accept-profile'];
const RESPONSE_HEADERS=['content-type','content-length','content-encoding','content-disposition','content-range','accept-ranges','etag','last-modified','vary','preference-applied','range-unit','x-total-count','retry-after'];
const digest=value=>createHash('sha256').update(value).digest();
function localOrigin(value){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('Origine locale fixe requise.');return u.origin;}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(value));}
function parsePath(raw){if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//')||raw.length>16384)throw Error();const before=raw.split('?')[0],decoded=decodeURIComponent(before);if(/[\\\u0000-\u001f\u007f]/.test(decoded)||decoded.split('/').some(x=>x==='.'||x==='..'||x.startsWith('.'))||/%[0-9a-f]{2}/i.test(decoded))throw Error();return new URL(raw,'http://local.invalid');}
async function body(req,limit=MAX_BODY){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error('Requête trop volumineuse.'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);}
function routeFor(url,method,accessMode){
 const p=url.pathname;
 if(p.startsWith('/supabase/')){
  const path=p.slice('/supabase'.length);
  if(path==='/auth/v1/token'&&method==='POST'&&['password','refresh_token'].includes(url.searchParams.get('grant_type'))&&[...url.searchParams.keys()].every(k=>k==='grant_type'))return {target:'supabase',path,auth:false};
  if(path==='/auth/v1/user'&&['GET','PUT'].includes(method)||path==='/auth/v1/logout'&&method==='POST')return {target:'supabase',path,auth:true};
  if(/^\/rest\/v1\/[a-zA-Z0-9_]+(?:\/[a-zA-Z0-9_]+)?$/.test(path)&&METHODS.has(method))return {target:'supabase',path,auth:true};
  if(/^\/storage\/v1\/object\/(?:authenticated|public|sign)\/[^/]+\/.+/.test(path)&&['GET','HEAD'].includes(method))return {target:'supabase',path,auth:false};
  if(/^\/storage\/v1\/object\/(?:sign|list)\/[^/]+(?:\/.+)?$/.test(path)&&method==='POST')return {target:'supabase',path,auth:true};
  if(accessMode==='account'){
   const writable=/^\/storage\/v1\/object\/(?:contrats|manifestes|plannings|devis|rh)\/[^/].*$/.test(path)&&['POST','PUT'].includes(method);
   const remove=/^\/storage\/v1\/object\/(?:contrats|manifestes|plannings|devis|rh)$/.test(path)&&method==='DELETE';
   if(writable||remove)return {target:'supabase',path,auth:true,verifyAccount:true,limit:remove?16384:MAX_BODY};
  }
  return null;
 }
 if(p.startsWith('/api/')){
  if(accessMode==='account'&&p.startsWith('/api/driver/')){
   if(url.search)return null;
   if(p==='/api/driver/login'&&method==='POST')return {target:'app',path:p,auth:false,driver:true,login:true,limit:16384};
   if(p==='/api/driver/me'&&method==='GET'||['/api/driver/reports','/api/driver/logout'].includes(p)&&method==='POST'||/^\/api\/driver\/notifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ack$/i.test(p)&&method==='POST')return {target:'app',path:p,auth:true,driver:true,limit:16384};
   return null;
  }
  if(!/^\/api\/(?:fleet|parking|operations|driver-performance|uber-reports)\//.test(p))return null;
  if(/^\/api\/uber-reports\/(?:browser|bridge)\//.test(p)||/^\/api\/fleet\/(?:uber|pair)(?:\/|$)/.test(p)||/^\/api\/operations\/driver-accounts(?:\/|$)/.test(p))return null;
  if(!['GET','HEAD'].includes(method)&&(/^\/api\/fleet\/(?:geotab|bolt|myclicar)\//.test(p)||p==='/api/uber-reports/settings'))return null;
  return METHODS.has(method)?{target:'app',path:p,auth:true}:null;
 }
 if(p.startsWith('/uber-extension')||p.startsWith('/_share/'))return null;
 return ['GET','HEAD'].includes(method)?{target:'app',path:p,auth:false}:null;
}

/** HTTPS is terminated by the explicit tunnel. Only its loopback HTTP connection
 * reaches this gateway; upstream services remain bound to their local ports. */
export function createShareGateway({accessCode,accessMode='invitation',publicOrigin=null,appOrigin='http://127.0.0.1:4173',supabaseOrigin='http://127.0.0.1:57421',anonKey,referenceData='synthetic',now=Date.now}){
 if(!['invitation','account'].includes(accessMode)||accessMode==='invitation'&&(typeof accessCode!=='string'||accessCode.length<32||accessCode.length>256)||typeof anonKey!=='string'||!anonKey)throw Error('Mode d’accès, code de partage fort et clé publique locale requis.');
 appOrigin=localOrigin(appOrigin);supabaseOrigin=localOrigin(supabaseOrigin);
 const codeHash=accessMode==='invitation'?digest(accessCode):null,sessions=new Map(),accounts=new Map(),attempts=new Map(),sockets=new Set(),pendingSockets=new Set();let origin=null,closed=false,globalAttempts={at:0,count:0},authAttempts={at:0,count:0},driverAttempts={at:0,count:0};
 function terminatePending(item){pendingSockets.delete(item);clearTimeout(item.timer);item.request.destroy();item.client.destroy();}
 function disconnect(access){for(const pair of sockets)if(!access||pair.session===access){pair.client.destroy();pair.upstream.destroy();}for(const item of pendingSockets)if(!access||item.session===access)terminatePending(item);}
 function purge(){const at=now();for(const map of [sessions,accounts])for(const [key,row]of map)if(row.expires<=at){map.delete(key);disconnect(row);}for(const [key,row]of attempts)if(row.until<=at)attempts.delete(key);}
 // Account mode is for the hosted stack with unique signing keys. This record
 // limits traffic only; authorization is still verified by Auth, APIs and RLS.
 function clientIp(req){const value=req.headers['x-real-ip'];return LOOPBACK.has(req.socket.remoteAddress)&&typeof value==='string'&&isIP(value)?value.toLowerCase():'127.0.0.1';}
 function accountAccess(req){purge();const key=clientIp(req);let access=accounts.get(key);if(!access){if(accounts.size>=1024)return null;access={expires:now()+SESSION_MS};accounts.set(key,access);}return access;}
 function session(req){purge();const values=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));if(values.length!==1)return null;const id=values[0].slice(COOKIE.length+1);return sessions.get(id)||null;}
 function allowed(req,write=false){return !closed&&origin&&LOOPBACK.has(req.socket.remoteAddress)&&req.headers.host===new URL(origin).host&&(!req.headers.origin||req.headers.origin===origin)&&(!write||req.headers.origin===origin)&&!['cross-site','same-site'].includes(req.headers['sec-fetch-site']);}
 function csp(){return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self' "+origin.replace('https:','wss:')+" https://photon.komoot.io; frame-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";}
 function gate(res){
  const nonce=randomBytes(18).toString('base64');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
  res.end(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accès aux tests Ludy</title><style nonce="${nonce}">body{font:17px system-ui;background:#f4f6f9;color:#202633;display:grid;min-height:95vh;place-items:center}main{background:white;max-width:420px;padding:32px;border-radius:20px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin-top:12px}button{background:#85263e;color:white;border:0;border-radius:8px}p{line-height:1.5}</style><main><h1>Ludy · espace de test</h1><p>Saisissez le code de partage reçu. Votre compte Ludy sera ensuite demandé.</p><form id="access"><label for="code">Code de partage</label><input id="code" type="password" autocomplete="off" required maxlength="256"><button>Accéder à Ludy</button></form><p id="message" role="status"></p></main><script nonce="${nonce}">const form=document.getElementById('access'),input=document.getElementById('code'),message=document.getElementById('message');const fragment=new URLSearchParams(location.hash.slice(1)),provided=fragment.get('access')||'';history.replaceState(null,'',location.pathname+location.search);async function enter(){message.textContent='Vérification…';try{const r=await fetch('/_share/session',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({code:input.value}),redirect:'error'});input.value='';if(!r.ok)throw Error();location.replace('/');}catch{message.textContent='Accès refusé ou temporairement indisponible. Vérifiez le code puis réessayez.';}}form.addEventListener('submit',e=>{e.preventDefault();void enter();});if(provided){input.value=provided;void enter();}</script></html>`);
 }
 function tooMany(req){const at=now();if(at-globalAttempts.at>=60000)globalAttempts={at,count:0};globalAttempts.count++;const key=String(req.headers['cf-connecting-ip']||'loopback').slice(0,80);let row=attempts.get(key);if(!row||row.until<=at){row={count:0,until:at+60000};if(attempts.size>=1024)attempts.delete(attempts.keys().next().value);attempts.set(key,row);}row.count++;return row.count>10||globalAttempts.count>60;}
 function tooManyPasswords(access){const at=now();if(at-authAttempts.at>=60000)authAttempts={at,count:0};if(!access.passwords||at-access.passwords.at>=60000)access.passwords={at,count:0};return ++authAttempts.count>120||++access.passwords.count>20;}
 function driverLoginWait(access){const at=now();if(at-driverAttempts.at>=60000)driverAttempts={at,count:0};if(!access.driverLogins||at-access.driverLogins.at>=600000)access.driverLogins={at,count:0};if(++driverAttempts.count>120)return Math.max(1,Math.ceil((driverAttempts.at+60000-at)/1000));if(++access.driverLogins.count>15)return Math.max(1,Math.ceil((access.driverLogins.at+600000-at)/1000));return 0;}
 function headers(req,target,bytes,route){const h={};for(const name of REQUEST_HEADERS)if(req.headers[name]!==undefined)h[name]=req.headers[name];h.host=new URL(target).host;h.origin=target;delete h['content-length'];if(bytes)h['content-length']=String(bytes.length);if(target===supabaseOrigin){h.apikey=anonKey;h['accept-profile']='public';h['content-profile']='public';}else if(accessMode==='account'&&route?.driver)h['x-ludy-client-ip']=clientIp(req);return h;}
 async function verifyUploadUser(req){
  // Verify the caller before buffering a document. Auth metadata is never retained.
  return new Promise(resolve=>{
   const request=http.request(supabaseOrigin+'/auth/v1/user',{method:'GET',headers:{apikey:anonKey,authorization:req.headers.authorization,accept:'application/json'},timeout:10000},reply=>{const status=reply.statusCode;reply.destroy();resolve(status===200?200:[401,403].includes(status)?401:502);});
   request.on('timeout',()=>request.destroy());request.on('error',()=>resolve(502));request.end();
  });
 }
 async function proxy(req,res,route,url){
  const target=route.target==='supabase'?supabaseOrigin:appOrigin,limit=route.limit||MAX_BODY;
  if(!['GET','HEAD'].includes(req.method)&&Number(req.headers['content-length'])>limit){res.setHeader('Connection','close');return json(res,413,{error:'Requête trop volumineuse.'});}
  if(route.verifyAccount){const verified=await verifyUploadUser(req);if(verified!==200){res.setHeader('Connection','close');return json(res,verified,{error:verified===401?'Connexion Ludy requise.':'Authentification temporairement indisponible.'});}}
  const bytes=['GET','HEAD'].includes(req.method)?null:await body(req,limit);
  if(req.aborted||res.destroyed)return;
  await new Promise(resolve=>{
   const upstream=http.request(target+route.path+url.search,{method:req.method,headers:headers(req,target,bytes,route),timeout:90000},reply=>{
    if(reply.statusCode>=300&&reply.statusCode<400){reply.resume();json(res,502,{error:'Redirection du service local refusée.'});resolve();return;}
    const policy=route.target==='app'&&route.path==='/spreadsheet-worker.js'?"default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'":csp();
    const outgoing={'Cache-Control':'no-store','Content-Security-Policy':policy,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};for(const name of RESPONSE_HEADERS)if(reply.headers[name]!==undefined)outgoing[name]=reply.headers[name];res.writeHead(reply.statusCode,outgoing);reply.pipe(res);reply.on('error',()=>{res.destroy();resolve();});reply.on('end',resolve);
   });
   upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent&&!res.destroyed)json(res,502,{error:'Service local temporairement indisponible.'});else res.destroy();resolve();});res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(bytes);
  });
 }
 const server=http.createServer(async(req,res)=>{
  try{
   if(!origin)return json(res,503,{error:'Partage non initialisé.'});
   if(!allowed(req,!['GET','HEAD'].includes(req.method)))return json(res,403,{error:'Origine refusée.'});
   const url=parsePath(req.url);
   if(accessMode==='account'&&url.pathname==='/health'&&['GET','HEAD'].includes(req.method))return proxy(req,res,{target:'app',path:'/health'},url);
   if(accessMode==='account'&&url.pathname.startsWith('/_share/'))return json(res,404,{error:'Route indisponible.'});
   if(accessMode==='invitation'&&url.pathname==='/_share/session'&&req.method==='POST'){
    purge();if(tooMany(req)){res.setHeader('Retry-After','60');return json(res,429,{error:'Réessayez dans une minute.'});}
    let input;try{input=JSON.parse((await body(req,1024)).toString('utf8'));}catch{return json(res,400,{error:'Code attendu.'});}
    if(typeof input?.code!=='string'||input.code.length>256||!timingSafeEqual(codeHash,digest(input.code)))return json(res,403,{error:'Code refusé.'});
    if(sessions.size>=256)return json(res,503,{error:'Trop de sessions de test ouvertes.'});
    const id=randomBytes(32).toString('base64url');sessions.set(id,{expires:now()+SESSION_MS});res.setHeader('Set-Cookie',`${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`);return json(res,200,{ok:true});
   }
   const access=accessMode==='account'?accountAccess(req):session(req);
   if(!access&&accessMode==='account')return json(res,503,{error:'Trop de connexions. Réessayez plus tard.'});
   if(!access){if(req.method==='GET'&&!url.pathname.startsWith('/supabase/')&&!url.pathname.startsWith('/api/')&&(!req.headers.accept||req.headers.accept.includes('text/html')))return gate(res);return json(res,401,{error:'Code de partage requis.'});}
   if(url.pathname==='/_share/logout'&&req.method==='POST'){for(const [key,value]of sessions)if(value===access)sessions.delete(key);disconnect(access);res.setHeader('Set-Cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);return json(res,200,{ok:true});}
   if(url.pathname==='/config.js'&&['GET','HEAD'].includes(req.method)){
    const config={SUPABASE_URL:origin+'/supabase',SUPABASE_ANON_KEY:anonKey,ENVIRONMENT:'staging',SOURCE_MODE:'mixed',REFERENCE_DATA:referenceData,GEOTAB_ENABLED:false,GEOTAB_LOCAL:true,STAGING:true,SHARED_STAGING:true,HOSTED_STAGING:accessMode==='account'};res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':csp(),'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});return res.end(req.method==='HEAD'?'':'window.FLOTTE_CONFIG = Object.freeze('+JSON.stringify(config)+');\n');
   }
   const route=routeFor(url,req.method,accessMode);if(!route)return json(res,403,{error:'Cette fonction reste disponible sur le poste local.'});
   if(route.auth&&!/^Bearer \S+$/i.test(req.headers.authorization||''))return json(res,401,{error:'Connexion Ludy requise.'});
   if(route.driver&&route.auth&&!/^Bearer dps_[A-Za-z0-9_-]{43}$/.test(req.headers.authorization||''))return json(res,401,{error:'Connexion chauffeur requise.'});
   if(route.login){const wait=driverLoginWait(access);if(wait){res.setHeader('Retry-After',String(wait));return json(res,429,{error:'Trop de tentatives de connexion. Réessayez plus tard.'});}}
   if(route.path==='/auth/v1/token'&&url.searchParams.get('grant_type')==='password'&&tooManyPasswords(access)){res.setHeader('Retry-After','60');return json(res,429,{error:'Trop de tentatives de connexion. Réessayez dans une minute.'});}
   await proxy(req,res,route,url);
  }catch(error){if(!res.headersSent&&!res.destroyed)json(res,error.status===413?413:400,{error:error.status===413?'Requête trop volumineuse.':'Requête refusée.'});else res.destroy();}
 });
 server.headersTimeout=15000;server.requestTimeout=30000;
 server.on('upgrade',(req,client,head)=>{
  let url,access;try{url=parsePath(req.url);access=accessMode==='account'?accountAccess(req):session(req);}catch{}
  if(!allowed(req,true)||!access||url?.pathname!=='/supabase/realtime/v1/websocket'||req.method!=='GET'||String(req.headers.upgrade).toLowerCase()!=='websocket'||sockets.size+pendingSockets.size>=64){client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  const h=headers(req,supabaseOrigin);Object.assign(h,{connection:'Upgrade',upgrade:'websocket','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':req.headers['sec-websocket-version']});if(req.headers['sec-websocket-protocol'])h['sec-websocket-protocol']=req.headers['sec-websocket-protocol'];
  const upstream=http.request(supabaseOrigin+'/realtime/v1/websocket'+url.search,{headers:h,timeout:15000});let pair;
  const handshake={client,request:upstream,session:access,timer:null};pendingSockets.add(handshake);handshake.timer=setTimeout(()=>terminatePending(handshake),Math.max(1,Math.min(15000,access.expires-now())));handshake.timer.unref();
  upstream.on('upgrade',(reply,remote,initial)=>{
   pendingSockets.delete(handshake);clearTimeout(handshake.timer);
   if(!sessionsHas(access)||client.destroyed){remote.destroy();client.destroy();return;}
   const out=['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade'];for(const name of ['sec-websocket-accept','sec-websocket-protocol'])if(reply.headers[name])out.push(name+': '+reply.headers[name]);client.write(out.join('\r\n')+'\r\n\r\n');if(initial.length)client.write(initial);if(head.length)remote.write(head);
   pair={client,upstream:remote,session:access};sockets.add(pair);const expiry=setTimeout(()=>{client.destroy();remote.destroy();},Math.max(1,access.expires-now()));expiry.unref();const cleanup=()=>{clearTimeout(expiry);sockets.delete(pair);client.destroy();remote.destroy();};client.on('close',cleanup);remote.on('close',cleanup);client.on('error',cleanup);remote.on('error',cleanup);client.pipe(remote);remote.pipe(client);
  });
  upstream.on('response',reply=>{reply.resume();pendingSockets.delete(handshake);clearTimeout(handshake.timer);client.end('HTTP/1.1 '+(reply.statusCode||502)+' Realtime unavailable\r\nConnection: close\r\n\r\n');});upstream.on('timeout',()=>terminatePending(handshake));upstream.on('error',()=>terminatePending(handshake));client.on('error',()=>terminatePending(handshake));client.on('close',()=>{if(!pair)terminatePending(handshake);});upstream.end();
 });
 function sessionsHas(access){purge();return [...sessions.values(),...accounts.values()].includes(access);}
 function setPublicOrigin(value){if(value===null){origin=null;}else{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.port)throw Error('Origine HTTPS de partage invalide.');origin=u.origin;}sessions.clear();accounts.clear();disconnect();}
 if(publicOrigin!==null)setPublicOrigin(publicOrigin);
 async function close(){closed=true;sessions.clear();accounts.clear();disconnect();await new Promise(resolve=>{if(!server.listening)return resolve();server.close(resolve);server.closeAllConnections();});}
 return {server,setPublicOrigin,close};
}
