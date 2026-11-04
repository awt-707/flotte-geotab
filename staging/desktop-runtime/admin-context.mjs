import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage();
const routes=[
  [/^\/api\/fleet\/(settings|disconnections\/settings)$/,['fleet_settings']],
  [/^\/api\/fleet\/drivers\/link$/,['rpc/fleet_link_driver','rpc/fleet_link_driver_automatic']],
  [/^\/api\/fleet\/geotab\/link$/,['vehicles']],
  [/^\/api\/uber-reports\/settings$/,['rpc/uber_report_configure']],
  [/^\/api\/parking\/zones(?:\/archive)?$/,['fleet_parking_zones','rpc/fleet_archive_parking_zone']],
  [/^\/api\/operations\/events\/(manual|[a-f0-9-]{36}\/(update|delete))$/,['rpc/ops_mutate_manual_event']],
  [/^\/api\/operations\/fuel\/settings$/,['ops_fuel_settings']],
  [/^\/api\/operations\/fuel\/reference$/,['vehicles']],
  [/^\/api\/operations\/rush$/,['ops_rush_rules']],
  [/^\/api\/operations\/demand\/import$/,['rpc/ops_import_demand']],
  [/^\/api\/operations\/driver-(portal|accounts(?:\/[a-f0-9-]{36}\/(reset|revoke))?|reports\/[a-f0-9-]{36}\/moderate)$/,['driver_portal_accounts','driver_reports','rpc/driver_portal_rotate']]
];
export function isAdministrativeOperation(resource,method){
  const active=context.getStore();return !!active?.open&&active.role==='admin'&&active.resources.includes(resource)&&(method!=='GET'||resource==='driver_portal_accounts'||resource==='driver_reports');
}
export function isManagerOperation(resource,method){
  const active=context.getStore();return !!active?.open&&active.role==='manager'&&active.resources.includes(resource)&&method!=='GET';
}
export async function withDesktopAdminRequest(req,user,work){
  const pathname=new URL(req.url,'http://127.0.0.1:4173').pathname;
  const permitted=user?.role==='admin'||user?.role==='manager'&&/^\/api\/operations\/(rush|demand\/import)$/.test(pathname);
  const resources=permitted&&['GET','POST'].includes(req.method)?routes.find(([pattern])=>pattern.test(pathname))?.[1]:null;
  if(!resources)return work();
  const scope={open:true,resources,role:user.role};
  return context.run(scope,async()=>{try{return await work();}finally{scope.open=false;}});
}
export function requiresCollector(req){
  if(req.method==='OPTIONS'||['GET','HEAD'].includes(req.method))return false;
  const p=new URL(req.url,'http://127.0.0.1:4173').pathname;
  // Preparing this computer's credentials never starts collection or writes to
  // Supabase. The fleet handler still checks the authenticated admin role.
  if(req.method==='POST'&&p==='/api/fleet/bolt/config')return false;
  return /^\/api\/fleet\/(?:geotab|myclicar|bolt)\//.test(p)||p==='/api/fleet/uber/ingest'||p==='/api/fleet/drivers/match'||p==='/api/fleet/pair/revoke'||p==='/api/fleet/validation/start'||
    p==='/api/operations/fuel/calibrate'||p.startsWith('/api/uber-reports/browser/')||p.startsWith('/api/uber-reports/bridge/')||p==='/api/provider-earnings/uber'||p.startsWith('/api/driver-performance/');
}
