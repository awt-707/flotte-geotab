import path from 'node:path';
import {createDesktopDatabaseTarget} from '../server/database-target.mjs';
import {ensurePrivateDirectory} from '../server/private-files.mjs';
import {requestAllowed,createFleetApi} from '../server/fleet.mjs';
import {createOperationsApi} from '../server/operations.mjs';
import {createDriverPortalApi} from '../server/driver-portal.mjs';
import {createParkingApi} from '../server/parking.mjs';
import {createDriverPerformanceApi} from '../server/driver-performance.mjs';
import {createProviderEarningsApi} from '../server/provider-earnings-api.mjs';
import {createUberReportsApi} from '../server/uber-reports.mjs';
import {loadDemandCityReview} from '../server/demand-city-review.mjs';
import {withDesktopAdminRequest} from '../desktop-runtime/admin-context.mjs';
import {createWebTransport} from './transport.mjs';

const fail=(status,message)=>Object.assign(Error(message),{status});
const collectorOnly=()=>fail(409,'Cette action nécessite le poste collecteur. Les données déjà enregistrées restent consultables sur le web.');
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
const GET=[
 /^\/api\/fleet\/(health|overview|alerts|disconnections|history|drivers\/matches|geotab\/(live|status)|myclicar\/status)$/,
 /^\/api\/operations\/(demand|rush|pauses|events|rotations|fuel|driver-portal)$/,
 /^\/api\/parking\/(zones|overview|alerts)$/,
 /^\/api\/driver-performance\/(drivers|report-periods|detail)$/,
 /^\/api\/provider-earnings\/config$/,
 /^\/api\/uber-reports\/settings$/
];
const POST=[
 /^\/api\/fleet\/(settings|disconnections\/settings|drivers\/link)$/,
 /^\/api\/operations\/(demand\/import|rush|events\/(manual|[a-f0-9-]{36}\/(update|delete))|fuel\/(settings|reference)|driver-accounts(?:\/[a-f0-9-]{36}\/(reset|revoke))?|driver-reports\/[a-f0-9-]{36}\/moderate)$/,
 /^\/api\/parking\/zones(?:\/archive)?$/,
 /^\/api\/uber-reports\/settings$/
];
export function webRouteAllowed(method,pathname){return (method==='GET'?GET:method==='POST'?POST:[]).some(pattern=>pattern.test(pathname));}

function collectorStub(){return {polling:false,close(){},status:async()=>{throw collectorOnly();}};}
class NoProviderClient {async rides(){throw collectorOnly();}}
const defaultFactories={fleet:createFleetApi,operations:createOperationsApi,driver:createDriverPortalApi,parking:createParkingApi,performance:createDriverPerformanceApi,earnings:createProviderEarningsApi,reports:createUberReportsApi};

/** The HTTP boundary must validate its public Host/Origin before normalizing a
 * request for these existing loopback-only handlers. Never listen on a socket here. */
export async function createWebServices({config,stateDir,runtimeRoot,fetchFn=fetch,now=Date.now,transportFactory=createWebTransport,factories={},maxStacks=64,idleMs=600000}={}){
 if(!path.isAbsolute(stateDir||'')||!path.isAbsolute(runtimeRoot||''))throw Error('Répertoires web requis.');
 if(!Number.isInteger(maxStacks)||maxStacks<1||maxStacks>256||!Number.isFinite(idleMs)||idleMs<0)throw Error('Limites web invalides.');
 const databaseTarget=createDesktopDatabaseTarget(config),transport=await transportFactory({config,stateDir,fetchFn,now});
 const make={...defaultFactories,...factories},stacks=new Map(),controllers=new Set();let closed=false;
 async function assemble(session){
  const directory=path.join(stateDir,'users',session.userId,'business');await ensurePrivateDirectory(directory);
  const common={supabaseUrl:config.supabaseUrl,databaseTarget,anonKey:config.publishableKey,serviceKey:transport.serviceKey,fetchFn:transport.fetchFn,now};
  // No coordinator, browser, telemetry writer, provider credentials or lifecycle
  // start/resume exists in this assembly. Private paths only hold local API state.
  const fleet=make.fleet({...common,sharedCollection:true,isCollectionActive:()=>false,Geotab:collectorStub,Myclicar:collectorStub,Bolt:NoProviderClient,
   boltEnvPath:path.join(directory,'unused-bolt.env'),geotabCredentialsPath:path.join(directory,'unused-geotab.json'),myclicarCredentialsPath:path.join(directory,'unused-myclicar.json'),
   uberPairingPath:path.join(directory,'unused-pairing.json'),connectorStatePath:path.join(directory,'unused-connectors.json'),validationPath:path.join(directory,'unused-validation.json')});
  const driver=make.driver(common),operations=make.operations({...common,demandCityReview:loadDemandCityReview(path.join(directory,'demand-city-review.json'))});
  const parking=make.parking({...common,getGeotabZones:async()=>{throw collectorOnly();}});
  const performance=make.performance({...common,boltClient:new NoProviderClient()}),earnings=make.earnings(common);
  const reports=make.reports({...common,authorizePair:async()=>{throw collectorOnly();}});
  return {
   async handle(req,res){
    const pathname=new URL(req.url,'http://127.0.0.1:4173').pathname;
    if(pathname.startsWith('/api/fleet/'))return fleet(req,res);
    if(pathname.startsWith('/api/operations/'))return await driver(req,res)||await operations(req,res);
    if(pathname.startsWith('/api/parking/'))return parking(req,res);
    if(pathname.startsWith('/api/driver-performance/'))return performance(req,res);
    if(pathname.startsWith('/api/provider-earnings/'))return earnings(req,res);
    if(pathname.startsWith('/api/uber-reports/'))return reports(req,res);
    return false;
   },
   async close(){await Promise.allSettled([fleet,driver,operations,parking,performance,earnings,reports].map(service=>Promise.resolve().then(()=>service.close?.())));}
  };
 }
 async function acquire(session){
  // Separate service instances keep even internal helper caches scoped to the
  // current administrator/role. RLS row caches also include token and agencies.
  const key=session.userId+':'+session.role,at=now();
  for(const [oldKey,entry]of stacks)if(entry.active===0&&(at-entry.usedAt>=idleMs||stacks.size>=maxStacks&&oldKey!==key)){stacks.delete(oldKey);await (await entry.stack).close();}
  let entry=stacks.get(key);
  if(!entry){
   if(stacks.size>=maxStacks)throw fail(503,'Trop de sessions actives ; réessayez dans quelques instants.');
   entry={active:0,usedAt:at,stack:null};stacks.set(key,entry);
   entry.stack=assemble(session).catch(error=>{if(stacks.get(key)===entry)stacks.delete(key);throw error;});
  }
  entry.active++;entry.usedAt=at;
  try{return {stack:await entry.stack,release:()=>{entry.active--;entry.usedAt=now();}};}catch(error){entry.active--;throw error;}
 }
 async function handle(req,res){
  const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);req.once?.('aborted',abort);
  let acquired;
  try{
   if(closed)throw fail(503,'Services web arrêtés.');
   if(!requestAllowed(req))throw fail(403,'Origine web non validée.');
   if(typeof req.url!=='string'||!req.url.startsWith('/api/')||req.url.includes('#'))throw fail(404,'Route web inconnue.');
   const pathname=new URL(req.url,'http://127.0.0.1:4173').pathname;
   if(!webRouteAllowed(req.method,pathname))throw collectorOnly();
   const token=String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];
   const session=await transport.authenticate(token,{signal:controller.signal});
   acquired=await acquire(session);
   return await transport.run(session,()=>withDesktopAdminRequest(req,session,()=>acquired.stack.handle(req,res)),{signal:controller.signal});
  }catch(error){
   if(!res.headersSent&&!res.destroyed)send(res,Number.isInteger(error.status)?error.status:503,{error:error.status?error.message:'Services web momentanément indisponibles.'});return true;
  }finally{acquired?.release();controller.abort();controllers.delete(controller);req.removeListener?.('aborted',abort);}
 }
 return {handle,async close(){if(closed)return;closed=true;for(const controller of controllers)controller.abort();transport.close();const current=[...stacks.values()];stacks.clear();await Promise.allSettled(current.map(async entry=>(await entry.stack).close()));}};
}
