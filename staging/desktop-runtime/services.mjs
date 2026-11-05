import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDesktopDatabaseTarget} from '../server/database-target.mjs';
import {initializePrivateRoot,ensurePrivateDirectory,readPrivateJson,writePrivateJson} from '../server/private-files.mjs';
import {createDesktopSession} from './session.mjs';
import {createDesktopRpc,createDesktopTransport} from './transport.mjs';
import {createDesktopCoordinator} from './coordinator.mjs';
import {createDesktopStack} from './stack.mjs';
import {createDesktopUberBrowser} from './uber-browser.mjs';
import {withDesktopAdminRequest,requiresCollector} from './admin-context.mjs';
import {requestAllowed} from '../server/fleet.mjs';

const fail=(status,message)=>Object.assign(Error(message),{status});
const bearer=req=>String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];
const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
async function jsonBody(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw fail(413,'Requête trop grande.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw fail(400,'JSON invalide.');}}
async function preference(filename){
  try{const data=await readPrivateJson(filename,{maxBytes:1024});
    if(data===null)return {version:1,deviceId:randomUUID(),enabled:false};
    if(data.version!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.deviceId)||typeof data.enabled!=='boolean')throw Error();
    return data;
  }catch{throw fail(503,'Préférences du poste invalides.');}
}
const save=(filename,data)=>writePrivateJson(filename,data,{maxBytes:1024});

export async function createDesktopServices({config,stateDir,runtimeRoot,onStatus=()=>{},fetchFn=fetch,
  stackFactory=createDesktopStack,coordinatorFactory=createDesktopCoordinator,privateRoot=initializePrivateRoot,browserFactory=createDesktopUberBrowser}={}){
  if(!path.isAbsolute(stateDir||'')||!path.isAbsolute(runtimeRoot||''))throw Error('Répertoires de l’application requis.');
  const databaseTarget=createDesktopDatabaseTarget(config);await privateRoot(stateDir);
  let epoch=0,stackRevision=0,closed=false,suspended=false,coordinator=null,context=null,stack=null,stackController=null,browser=null,stackQueue=Promise.resolve(),stackBuild=Promise.resolve(),transition=Promise.resolve(),lastError=null;
  const serial=work=>{const next=transition.then(work);transition=next.catch(()=>{});return next;};
  const session=createDesktopSession({config,fetchFn,onExpired:()=>{void logout();}});
  const status=()=>({environment:'production',projectRef:config.projectRef,role:session.current()?.role||null,
    participationEnabled:context?.preferences.enabled||false,coordinator:coordinator?.status()||{state:suspended?'paused':'signed_out'},
    uber:browser?.status()||{state:'stopped'},error:coordinator?.status().state==='unavailable'?'Coordination Supabase momentanément indisponible.':lastError});
  const publish=()=>onStatus(status());
  function dropStack(){
    ++stackRevision;
    stackController?.abort();stackController=null;
    const old=stack,oldBrowser=browser;stack=browser=null;
    const closing=Promise.allSettled([old?.close(),oldBrowser?.close()]);
    stackQueue=stackQueue.then(()=>closing);return stackQueue;
  }
  function replaceStack(fence=null){
    const ticket=epoch;
    const next=stackBuild.catch(()=>{}).then(()=>{
      if(ticket!==epoch||closed||fence!==null&&coordinator?.status().lease?.fence!==fence)return;
      return buildStack(fence);
    });stackBuild=next;return next;
  }
  async function ensureStack(){await stackBuild;if(!stack)await replaceStack();}
  async function buildStack(fence=null){
    const ticket=epoch,ctx=context;await dropStack();
    if(closed||!ctx||!session.current()||ticket!==epoch||fence!==null&&coordinator?.status().lease?.fence!==fence)return;
    const version=stackRevision,controller=new AbortController();stackController=controller;
    const getSession=()=>{const s=session.current();return ticket===epoch&&s?.userId===ctx.userId?s:null;};
    const transport=createDesktopTransport({config,deviceId:ctx.preferences.deviceId,getSession,rpc:ctx.rpc,fence,signal:controller.signal,fetchFn});
    const next=await stackFactory({config,databaseTarget,stateDir:ctx.directory,runtimeRoot,transport,leader:fence!==null,
      isCollectionActive:()=>!controller.signal.aborted&&!!getSession()&&fence!==null&&coordinator?.status().state==='leader'&&coordinator.status().lease?.fence===fence});
    if(controller.signal.aborted||ticket!==epoch||version!==stackRevision){await next.close();return;}
    stack=next;
    if(fence!==null){
      void next.start().catch(()=>{if(!controller.signal.aborted&&ticket===epoch){lastError='Un connecteur demande une vérification.';publish();}});
      if(browserFactory){
        const created=await browserFactory({projectRef:config.projectRef,stateDir:ctx.directory,userId:ctx.userId,
          assertLease:()=>{if(controller.signal.aborted||!getSession())throw fail(409,'Collecte suspendue.');},
          onStatus:value=>{if(value?.state==='browser-install-required')onStatus({state:'browser-install-required'});publish();},request:async(endpoint,{method='GET',body,signal}={})=>{
            const s=getSession();if(!s||controller.signal.aborted)throw fail(409,'Collecte suspendue.');
            if(!/^\/api\/(uber-reports|provider-earnings)\//.test(endpoint))throw fail(400,'Route du navigateur invalide.');
            const response=await fetchFn('http://127.0.0.1:4173'+endpoint,{method,redirect:'error',signal:AbortSignal.any([controller.signal,...(signal?[signal]:[]),AbortSignal.timeout(60000)]),
              headers:{Authorization:'Bearer '+s.token,Origin:'http://127.0.0.1:4173','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
            const result=await response.json();if(!response.ok)throw fail(response.status,'Navigateur Uber indisponible.');return result;
          }});
        if(controller.signal.aborted||ticket!==epoch||version!==stackRevision||stack!==next){await created.close();return;}
        browser=created;
        void created.start().catch(()=>{if(!controller.signal.aborted&&ticket===epoch){lastError='Connectez Uber sur ce poste pour reprendre ses rapports.';publish();}});
      }
    }
  }
  async function reset(){
    ++epoch;const old=coordinator,previous=context,lease=old?.status().lease;coordinator=null;context=null;
    await Promise.allSettled([dropStack(),old?.close()]);
    if(lease&&previous?.lastSession){
      // Logout invalidates every collector immediately. Only this release may
      // use the just-retired user token, so another PC need not wait for expiry.
      const release=createDesktopRpc({config,fetchFn,getSession:()=>previous.lastSession});
      await release('desktop_worker_release',{p_device_id:previous.preferences.deviceId,p_fence:lease.fence}).catch(()=>{});
    }
  }
  async function setSession(token){
    const before=session.current(),verified=await session.authenticate(token);
    return serial(async()=>{
      if(closed||session.current()!==verified)throw fail(409,'Session remplacée.');
      if(context&&before?.userId===verified.userId&&before.role===verified.role){context.lastSession=verified;publish();return status();}
      await reset();if(session.current()!==verified)throw fail(409,'Session remplacée.');
      const directory=path.join(stateDir,'users',verified.userId);await ensurePrivateDirectory(directory);
      const preferencesPath=path.join(directory,'desktop.json'),preferences=await preference(preferencesPath);
      if(verified.role!=='admin')preferences.enabled=false;
      const ticket=epoch;
      const rpc=createDesktopRpc({config,fetchFn,getSession:()=>{const s=session.current();return ticket===epoch&&s?.userId===verified.userId?s:null;}});
      context={userId:verified.userId,directory,preferencesPath,preferences,rpc,lastSession:verified};
      await save(preferencesPath,preferences);
      coordinator=coordinatorFactory({rpc,deviceId:preferences.deviceId,getSession:session.current,onLeader:lease=>replaceStack(lease.fence),onLost:dropStack,onStatus:publish,
        onRegistered:async enabled=>{
          if(ticket!==epoch||context?.userId!==verified.userId)return;
          if(preferences.enabled!==enabled){preferences.enabled=enabled;await save(preferencesPath,preferences);}
          lastError=null;publish();
        }});
      lastError=null;
      if(verified.role==='admin'){
        if(suspended)await coordinator.pause();
        try{await coordinator.restore(preferences.enabled);}catch{lastError='Coordination Supabase momentanément indisponible.';}
      }
      if(!stack)await replaceStack();publish();return status();
    });
  }
  function logout(){session.clear();++epoch;stackController?.abort();return serial(async()=>{await reset();lastError=null;publish();});}
  async function handle(req,res){
    const url=new URL(req.url,'http://127.0.0.1:4173');
    try{
      const isLiveBridge=['/api/fleet/uber/ingest','/api/fleet/uber/collection-status'].includes(url.pathname);
      if(isLiveBridge){
        if(!requestAllowed(req,true))throw fail(403,'Origine locale non autorisée.');
        // Keep lease/logout failures visible to the paired extension as 409/401.
        if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods',url.pathname.endsWith('/collection-status')?'GET, OPTIONS':'POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Max-Age','300');}
        if(req.method==='OPTIONS'){res.writeHead(204);res.end();return true;}
      }
      if(url.pathname==='/api/desktop/session'&&req.method==='POST'){await jsonBody(req);reply(res,200,await setSession(bearer(req)));return true;}
      if(url.pathname==='/api/desktop/logout'&&req.method==='POST'){await jsonBody(req);await logout();reply(res,200,{ok:true});return true;}
      const user=session.current();if(!user)throw fail(401,'Connexion Ludy requise.');
      const isUberBridge=isLiveBridge||url.pathname.startsWith('/api/uber-reports/bridge/');
      if(!isUberBridge&&bearer(req)!==user.token)throw fail(401,'Session du poste remplacée.');
      if(url.pathname==='/api/desktop/status'&&req.method==='GET'){reply(res,200,status());return true;}
      if(url.pathname==='/api/desktop/participation'&&req.method==='POST'){
        const input=await jsonBody(req);if(user.role!=='admin')throw fail(403,'Administrateur requis.');
        if(!input||typeof input.enabled!=='boolean'||Object.keys(input).some(k=>k!=='enabled'))throw fail(400,'Participation invalide.');
        await serial(async()=>{if(session.current()?.userId!==user.userId)throw fail(409,'Session remplacée.');
          await coordinator.register(input.enabled);context.preferences.enabled=input.enabled;await save(context.preferencesPath,context.preferences);lastError=null;});
        reply(res,200,status());return true;
      }
      if(url.pathname==='/api/desktop/uber/open'&&req.method==='POST'){
        await jsonBody(req);if(user.role!=='admin'||!browser)throw fail(409,'Activez la collecte sur ce poste avant de connecter Uber.');
        await browser.openLogin();reply(res,200,{ok:true});return true;
      }
      if(url.pathname.startsWith('/api/desktop/'))return false;
      if(requiresCollector(req)&&coordinator?.status().state!=='leader')throw fail(409,'Cette action demande la collecte active sur ce poste.');
      if(!stack)await ensureStack();
      if(!stack)throw fail(503,'Services du poste indisponibles.');
      return await withDesktopAdminRequest(req,user,()=>stack.handle(req,res));
    }catch(e){if(!res.headersSent)reply(res,Number.isInteger(e.status)?e.status:503,{error:e.status?e.message:'Services du poste momentanément indisponibles.'});return true;}
  }
  return {handle,setSession,status,
    async pause(){suspended=true;await coordinator?.pause();await dropStack();publish();},
    async resume(){if(closed)return;suspended=false;await coordinator?.resume();if(browser?.status().state==='browser-install-required')void browser.start().catch(()=>{});publish();},
    async close(){closed=true;await logout();}
  };
}
