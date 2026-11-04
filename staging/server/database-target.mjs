// Production is an explicit capability passed by the embedded runtime. Existing
// staging callers retain their loopback-only default, including tests and CLI.
const targets=new WeakSet();
export function createDesktopDatabaseTarget(input){
  const config=input;
  if(!config||config.environment!=='production'||!/^[a-z0-9]{20}$/.test(config.projectRef||'')||config.supabaseUrl!==`https://${config.projectRef}.supabase.co`)
    throw Error('Projet Supabase de production invalide.');
  const target=Object.freeze({origin:config.supabaseUrl,projectRef:config.projectRef});
  targets.add(target);return target;
}
export function assertLocalDatabase(value){
  const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='57421'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)
    throw Error('Backend refusé : Supabase local :57421 obligatoire');
  return u.origin;
}
export function resolveBackendTarget(value,target){
  if(target===undefined)return assertLocalDatabase(value);
  if(!targets.has(target)||value!==target.origin)throw Error('Projet Supabase de production non autorisé.');
  return target.origin;
}
