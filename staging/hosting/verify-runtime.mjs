import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {STAGING_ROOT} from '../scripts/paths.mjs';
import {hostingConfig as normalizeHostingConfig} from './config.mjs';
import {readPrepared,publicSigningKey} from './auth-config.mjs';

const execute=promisify(execFile);
const reject=reason=>Error('Hébergement refusé : '+reason+'.');
const parse=value=>JSON.parse(value);
const envOf=container=>Object.fromEntries((container.Config?.Env||[]).map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
const EXPECTED_NAMES=['studio','pg_meta','storage','rest','realtime','inbucket','auth','kong','db'].map(name=>'supabase_'+name+'_ludy-staging');
const loopback=ip=>ip==='127.0.0.1'||ip==='::1';
const keysOf=value=>{const parsed=typeof value==='string'?parse(value):value;return Array.isArray(parsed)?parsed:parsed?.keys;};
function assertKeys(value,expected,{privateKey=false}={}){
 const keys=keysOf(value);
 if(!Array.isArray(keys)||keys.length!==1||JSON.stringify(publicSigningKey(keys[0]))!==JSON.stringify(publicSigningKey(expected))||keys[0].k||(!privateKey&&keys[0].d)||(privateKey&&keys[0].d!==expected.d))throw reject('clés de signature actives non conformes');
}
export function verifyDockerBindings(containers,network){
 if(network?.Name!=='ludy-staging'||network.Driver!=='bridge'||network.Options?.['com.docker.network.bridge.host_binding_ipv4']!=='127.0.0.1')throw reject('réseau Docker non isolé');
 const seen=new Set();
 for(const container of containers){
  const name=container.Name?.replace(/^\//,'');
  if(!EXPECTED_NAMES.includes(name)||seen.has(name)||!container.State?.Running||container.HostConfig?.NetworkMode==='host'||container.HostConfig?.Privileged)throw reject('conteneurs de test inattendus ou arrêtés');
  seen.add(name);
  if(Object.keys(container.NetworkSettings?.Networks||{}).join(',')!=='ludy-staging')throw reject('réseau partagé par le projet');
  for(const bindings of Object.values(container.NetworkSettings?.Ports||{}))for(const binding of bindings||[])if(!loopback(binding.HostIp))throw reject('port Supabase publié hors loopback');
 }
 if(EXPECTED_NAMES.some(name=>!seen.has(name)))throw reject('stack incomplète');
 const members=Object.values(network.Containers||{});
 if(members.length!==containers.length||members.some(member=>!seen.has(member.Name)))throw reject('réseau partagé avec un autre conteneur');
 return true;
}
export function verifyListeningSockets(output){
 const protectedPorts=new Set([4173,4174,5999,2019,...Array.from({length:10},(_,i)=>57420+i)]);
 for(const line of output.trim().split('\n')){
  if(!line.trim())continue;
  // ss -H -ltn: state, recv-q, send-q, local address:port, peer.
  const local=line.trim().split(/\s+/)[3],match=local?.match(/^(.*):(\d+)$/);
  if(!match)throw reject('contrôle des ports illisible');
  const address=match[1].replace(/^\[|\]$/g,'');
  if(protectedPorts.has(Number(match[2]))&&!loopback(address))throw reject('service interne publié hors loopback');
 }
 return true;
}
export function verifyActiveSecrets(containers,secrets,kongConfig){
 const byName=new Map(containers.map(c=>[c.Name.replace(/^\//,''),envOf(c)]));
 const env=name=>byName.get('supabase_'+name+'_ludy-staging')||{};
 if(env('auth').GOTRUE_JWT_SECRET!==secrets.jwt_secret||env('realtime').API_JWT_SECRET!==secrets.jwt_secret||env('realtime').METRICS_JWT_SECRET!==secrets.jwt_secret||env('storage').AUTH_JWT_SECRET!==secrets.jwt_secret||env('db').JWT_SECRET!==secrets.jwt_secret)throw reject('secret JWT actif non conforme');
 assertKeys(env('auth').GOTRUE_JWT_KEYS,secrets.signingKey,{privateKey:true});
 for(const value of [env('rest').PGRST_JWT_SECRET,env('realtime').API_JWT_JWKS,env('storage').JWT_JWKS])assertKeys(value,secrets.signingKey);
 if(env('storage').ANON_KEY!==secrets.anon_key||env('storage').SERVICE_KEY!==secrets.service_role_key)throw reject('clés Storage non conformes');
 for(const [key,field]of Object.entries({SUPABASE_ANON_KEY:'anon_key',SUPABASE_SERVICE_KEY:'service_role_key',SUPABASE_PUBLISHABLE_KEY:'publishable_key',SUPABASE_SECRET_KEY:'secret_key',AUTH_JWT_SECRET:'jwt_secret'}))if(env('studio')[key]!==secrets[field])throw reject('clés API non conformes');
 const present=new Set(kongConfig.match(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)||[]);
 const expected=[secrets.anon_key,secrets.service_role_key,secrets.publishable_key,secrets.secret_key];
 if(present.size!==expected.length||expected.some(key=>!present.has(key)))throw reject('clés de la passerelle Supabase non conformes');
 return true;
}

/** Checks only loopback services. No tokens, Docker config or response bodies escape errors. */
export async function verifyHostedRuntime(runtime,hostingConfig,options={}){
 const root=options.root||STAGING_ROOT,now=options.now?.()??Date.now();
 const run=options.run|| (async(command,args)=>{try{return(await execute(command,args,{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024})).stdout;}catch{throw reject('inspection locale indisponible');}});
 const fetchImpl=options.fetch||globalThis.fetch;
 try{
  const config=normalizeHostingConfig(hostingConfig);
  const secrets=await readPrepared({root,publicOrigin:config.publicOrigin,now});
  if(runtime?.projectId!=='ludy-staging'||runtime.supabaseUrl!=='http://127.0.0.1:57421'||runtime.anonKey!==secrets.anon_key||runtime.serviceKey!==secrets.service_role_key)throw reject('runtime différent de la préparation privée');
  const docker=args=>run('docker',['--host=unix:///var/run/docker.sock',...args]);
  const names=(await docker(['ps','-a','--filter','name=ludy-staging','--format','{{.Names}}'])).trim().split('\n');
  if(names.length!==EXPECTED_NAMES.length||names.some(name=>!EXPECTED_NAMES.includes(name)))throw reject('inventaire Docker inattendu');
  const [containers,networks,kong,sockets]=await Promise.all([
   docker(['inspect',...names]).then(parse),docker(['network','inspect','ludy-staging']).then(parse),docker(['exec','supabase_kong_ludy-staging','cat','/home/kong/kong.yml']),run('ss',['-H','-ltn'])
  ]);
  verifyDockerBindings(containers,networks[0]);verifyListeningSockets(sockets);verifyActiveSecrets(containers,secrets,kong);
  const request=async(route,key)=>fetchImpl(runtime.supabaseUrl+route,{headers:{apikey:key,Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(10000)});
  const denied=await request('/auth/v1/admin/users?page=1&per_page=1',runtime.anonKey);
  const deniedStatus=denied.status;await denied.body?.cancel();
  if(![401,403].includes(deniedStatus))throw reject('accès anonyme privilégié non refusé');
  const marker=await request('/rest/v1/params?select=value&key=eq.environment',runtime.serviceKey);
  if(!marker.ok)throw reject('marqueur staging inaccessible');
  const markerBody=await marker.json();if(markerBody?.[0]?.value!=='staging')throw reject('base non identifiée comme staging');
  const response=await request('/auth/v1/.well-known/jwks.json',runtime.anonKey);
  if(!response.ok)throw reject('clé Auth publique inaccessible');
  assertKeys(await response.json(),secrets.signingKey);
  return {ok:true,checkedAt:new Date(now).toISOString(),projectId:'ludy-staging'};
 }catch(error){
  // Intentionally drop causes: process stderr and JSON parsers may contain keys.
  throw reject(error?.message?.startsWith('Hébergement refusé : ')?error.message.slice('Hébergement refusé : '.length).replace(/\.$/,''):'préparation ou contrôle local incomplet');
 }
}
