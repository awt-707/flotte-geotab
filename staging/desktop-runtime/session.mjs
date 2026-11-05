const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const failed=(status=401)=>Object.assign(Error(status===403?'Accès Ludy refusé.':'Session Ludy expirée ou invalide.'),{status});
function checkResponse(response){
  if(response.ok)return;
  if(response.status===408||response.status===429||response.status>=500&&response.status<=599){
    throw Object.assign(Error('Vérification de la session Ludy momentanément indisponible.'),{status:503});
  }
  throw failed(response.status===403?403:401);
}
/** A late authentication result can never restore a session after logout. */
export function createDesktopSession({config,fetchFn=fetch,now=Date.now,onExpired=()=>{}}){
  let value=null,revision=0,timer;
  const current=()=>value&&value.expiresAt>now()?value:null;
  function clear(){++revision;clearTimeout(timer);timer=null;value=null;}
  async function authenticate(token){
    const ticket=++revision;
    if(typeof token!=='string'||token.length>16384||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw failed();
    let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));}catch{throw failed();}
    // The Auth endpoint verifies signature and user; claims here only bound TTL.
    if(claims.role!=='authenticated'||!Number.isFinite(claims.exp)||claims.exp*1000<=now())throw failed();
    const headers={apikey:config.publishableKey,Authorization:'Bearer '+token};
    const response=await fetchFn(config.supabaseUrl+'/auth/v1/user',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
    checkResponse(response);
    const user=await response.json();if(!UUID.test(user?.id||'')||user.id!==claims.sub)throw failed();
    const profiles=await fetchFn(config.supabaseUrl+'/rest/v1/profiles?'+new URLSearchParams({select:'role',user_id:'eq.'+user.id,limit:'1'}),{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
    checkResponse(profiles);const rows=await profiles.json();
    if(ticket!==revision)throw Object.assign(Error('Session remplacée.'),{status:409});
    value=Object.freeze({userId:user.id,role:rows?.[0]?.role||'viewer',token,expiresAt:claims.exp*1000});
    clearTimeout(timer);timer=setTimeout(()=>{clear();onExpired();},Math.max(1,Math.min(2147483647,value.expiresAt-now())));timer.unref?.();
    return value;
  }
  return {authenticate,current,clear};
}
