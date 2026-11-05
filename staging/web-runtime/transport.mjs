import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDesktopRpc,createDesktopTransport} from '../desktop-runtime/transport.mjs';
import {initializePrivateRoot,ensurePrivateDirectory,readPrivateJson,writePrivateJson} from '../server/private-files.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail=(status,message)=>Object.assign(Error(message),{status});
const denied=()=>fail(403,'Cette opération est réservée au poste collecteur.');
const healthFields=new Set(['id','name','status','last_success_at','last_error','stale_after_s','motion_error']);

/** Request-scoped credentials, with a distinct disabled observer per administrator.
 * No refresh token, collector lease, provider credential or service-role key. */
export async function createWebTransport({config,stateDir,fetchFn=fetch,now=Date.now,privateRoot=initializePrivateRoot}={}){
 if(!path.isAbsolute(stateDir||''))throw Error('Répertoire privé web requis.');
 if(config?.environment!=='production'||!/^[a-z0-9]{20}$/.test(config.projectRef||'')||config.supabaseUrl!==`https://${config.projectRef}.supabase.co`)throw Error('Projet web invalide.');
 if(typeof config.publishableKey!=='string'||config.publishableKey.length>4096||/[\s\x00-\x1f]/.test(config.publishableKey))throw Error('Clé publique requise.');
 if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)){
  let claims;try{claims=JSON.parse(Buffer.from(config.publishableKey.split('.')[1],'base64url'));}catch{}
  if(claims?.role!=='anon'||claims.ref!==config.projectRef)throw Error('Clé publique requise.');
 }
 await privateRoot(stateDir);
 const context=new AsyncLocalStorage(),verified=new WeakSet(),devices=new Map(),controllers=new Set();
 const serviceKey='web-internal-'+randomBytes(32).toString('hex');let closed=false;
 const checkResponse=response=>{
  if(response.ok)return;
  if(response.status===408||response.status===429||response.status>=500)throw fail(503,'Vérification Ludy momentanément indisponible.');
  throw fail(response.status===403?403:401,'Session Ludy expirée ou invalide.');
 };
 async function authenticate(token,{signal}={}){
  if(closed)throw fail(503,'Services web arrêtés.');
  if(typeof token!=='string'||token.length>16384||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw fail(401,'Connexion Ludy requise.');
  let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));}catch{}
  if(claims?.role!=='authenticated'||!UUID.test(claims.sub||'')||!Number.isFinite(claims.exp)||claims.exp*1000<=now())throw fail(401,'Session Ludy expirée ou invalide.');
  const headers={apikey:config.publishableKey,Authorization:'Bearer '+token},options={headers,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])};
  const userResponse=await fetchFn(config.supabaseUrl+'/auth/v1/user',options);checkResponse(userResponse);
  const user=await userResponse.json();if(user?.id!==claims.sub)throw fail(401,'Session Ludy invalide.');
  const profileResponse=await fetchFn(config.supabaseUrl+'/rest/v1/profiles?'+new URLSearchParams({select:'user_id,role',user_id:'eq.'+user.id,limit:'1'}),options);checkResponse(profileResponse);
  const rows=await profileResponse.json(),role=rows?.length===1?rows[0].role:null;
  if(!['admin','manager','viewer'].includes(role))throw fail(403,'Accès Ludy non autorisé.');
  if(closed||signal?.aborted||claims.exp*1000<=now())throw fail(401,'Session Ludy expirée ou interrompue.');
  const session=Object.freeze({userId:user.id,role,token,expiresAt:claims.exp*1000});verified.add(session);return session;
 }
 function active(){
  const scope=context.getStore();
  if(closed||!scope?.open||scope.controller.signal.aborted||scope.session.expiresAt<=now())throw fail(401,'Requête Ludy expirée ou interrompue.');
  return scope;
 }
 async function device(userId){
  let entry=devices.get(userId);if(entry)return entry.ready;
  entry={registered:false,pending:null,ready:null};devices.set(userId,entry);
  entry.ready=(async()=>{
   const directory=path.join(stateDir,'users',userId);await ensurePrivateDirectory(directory);
   const filename=path.join(directory,'web-observer.json'),stored=await readPrivateJson(filename,{maxBytes:1024});
   if(stored!==null&&(stored.version!==1||stored.userId!==userId||!UUID.test(stored.deviceId||'')||Object.keys(stored).some(key=>!['version','userId','deviceId'].includes(key))))throw fail(503,'Identité observateur web invalide.');
   entry.deviceId=stored?.deviceId||randomUUID();
   if(stored===null)await writePrivateJson(filename,{version:1,userId,deviceId:entry.deviceId},{maxBytes:1024});
   return entry;
  })().catch(error=>{if(devices.get(userId)===entry)devices.delete(userId);throw error;});
  return entry.ready;
 }
 async function desktop(scope){
  if(scope.desktop)return scope.desktop;
  const entry=scope.session.role==='admin'?await device(scope.session.userId):null;active();
  const getSession=()=>scope.open&&!scope.controller.signal.aborted&&scope.session.expiresAt>now()?scope.session:null;
  const call=createDesktopRpc({config,getSession,fetchFn});
  const rpc=async(name,args,options)=>{
   active();
   if(!['desktop_worker_request','desktop_admin_request','desktop_manager_request'].includes(name))throw denied();
   if(name==='desktop_worker_request'&&(args.p_method!=='GET'||args.p_fence!==null))throw denied();
   if(name!=='desktop_manager_request'){
    if(!entry||args.p_device_id!==entry.deviceId)throw denied();
    if(!entry.registered){
     // Coalesce creation, never persist the user JWT. A failed registration is
     // retried only by a later incoming request, not a background timer.
     entry.pending??=call('desktop_worker_register',{p_device_id:entry.deviceId,p_label:'Ludy Web · observateur',p_enabled:false},options)
      .then(result=>{if(result?.device?.enabled!==false||result?.device?.id!==entry.deviceId)throw denied();entry.registered=true;})
      .finally(()=>{entry.pending=null;});
     await entry.pending;active();
    }
   }
   return call(name,args,options);
  };
  scope.desktop=createDesktopTransport({config,deviceId:entry?.deviceId||null,getSession,rpc,fence:null,signal:scope.controller.signal,fetchFn});
  return scope.desktop;
 }
 async function request(input,options={}){
  const scope=active(),url=new URL(input),headers=new Headers(options.headers),method=(options.method||'GET').toUpperCase();
  if(url.origin!==config.supabaseUrl||url.username||url.password||url.hash)throw denied();
  const authorization=headers.get('authorization'),internal=authorization==='Bearer '+serviceKey;
  if(!internal&&authorization!=='Bearer '+scope.session.token)throw fail(401,'Identité de requête incohérente.');
  if(url.pathname.startsWith('/rest/v1/rpc/desktop_')||!url.pathname.startsWith('/rest/v1/')&&url.pathname!=='/auth/v1/user')throw denied();
  // Each handler may re-check auth. Reuse only this request's already verified
  // identity, never an authentication result from another HTTP request.
  if(method==='GET'&&url.pathname==='/auth/v1/user')return Response.json({id:scope.session.userId});
  if(method==='GET'&&url.pathname==='/rest/v1/profiles'&&url.searchParams.get('user_id')==='eq.'+scope.session.userId&&
   ['role','user_id,role'].includes(url.searchParams.get('select'))&&[...url.searchParams.keys()].every(key=>['select','user_id','limit'].includes(key)))return Response.json([{user_id:scope.session.userId,role:scope.session.role}]);
  if(internal&&method==='GET'&&scope.session.role!=='admin'&&url.pathname==='/rest/v1/fleet_sources'){
   const select=url.searchParams.get('select')?.split(',');
   if(select?.length&&select.every(key=>healthFields.has(key))&&[...url.searchParams.keys()].every(key=>['select','id','order','limit','offset'].includes(key))){
    const response=await request(config.supabaseUrl+'/rest/v1/rpc/fleet_source_health',{method:'GET',headers:{Authorization:'Bearer '+scope.session.token},signal:options.signal});
    if(!response.ok)return response;
    let rows=await response.json();const id=url.searchParams.get('id');if(id){if(!/^eq\.(uber|bolt|geotab|myclicar)$/.test(id))throw denied();rows=rows.filter(row=>row.id===id.slice(3));}
    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||1000);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<0||limit>1000)throw denied();
    return Response.json(rows.slice(offset,offset+limit).map(row=>Object.fromEntries(select.map(key=>[key,row[key]]))));
   }
  }
  if(!internal){
   headers.set('apikey',config.publishableKey);
   const result=await fetchFn(input,{...options,headers,redirect:'error',signal:AbortSignal.any([scope.controller.signal,...(options.signal?[options.signal]:[])])});active();return result;
  }
  const transport=await desktop(scope);active();headers.set('authorization','Bearer '+transport.serviceKey);
  return transport.fetchFn(input,{...options,headers});
 }
 async function run(session,work,{signal}={}){
  if(closed||!verified.has(session)||session.expiresAt<=now())throw fail(401,'Session web vérifiée requise.');
  const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});controllers.add(controller);
  const scope={session,controller,open:true,desktop:null};
  try{return await context.run(scope,work);}finally{scope.open=false;controller.abort();controllers.delete(controller);signal?.removeEventListener('abort',abort);}
 }
 return {serviceKey,fetchFn:request,authenticate,run,close(){closed=true;for(const controller of controllers)controller.abort();devices.clear();}};
}
