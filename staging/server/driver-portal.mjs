import {resolveBackendTarget} from './database-target.mjs';
import {readLocalJson} from './local-json.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {isIP} from 'node:net';

const origins=new Set(['http://127.0.0.1:4173','http://localhost:4173']);
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
function clientAddress(req){
 const forwarded=req.headers['x-ludy-client-ip'],remote=req.socket?.remoteAddress;
 // Only the local gateway generates this header. External callers never reach
 // this handler; the gateway drops any incoming client-supplied copy.
 return loopback.has(remote)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded.toLowerCase():remote||'local';
}
const hash=value=>createHash('sha256').update(value).digest('hex');
const error=(status,message)=>Object.assign(new Error(message),{status});
const eq=value=>'eq.'+value;
const iso=value=>new Date(value).toISOString();
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function text(value,min,max){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw error(400,'Champ manquant ou trop long');return value.trim();}
function reply(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
async function body(req){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>16384)throw error(413,'Requête trop grande');chunks.push(part);}let result;try{result=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw error(400,'Requête invalide');}if(!result||Array.isArray(result)||typeof result!=='object')throw error(400,'Requête invalide');return result;}
const safeReport=row=>({id:row.id,category:row.category,city:row.city,place:row.place,description:row.description,status:row.status,admin_note:row.admin_note,reported_at:row.reported_at,reviewed_at:row.reviewed_at});
const safeNotification=row=>({id:row.id,kind:row.kind,title:row.title,message:row.message,observed_at:row.observed_at,acknowledged_at:row.acknowledged_at});
const safeAccount=row=>({id:row.id,ludy_driver_code:row.ludy_driver_code,display_name:row.display_name,agency_id:row.agency_id,active:row.active,created_at:row.created_at,rotated_at:row.rotated_at});

export function createDriverPortalApi({supabaseUrl,databaseTarget,serviceKey,anonKey,fetchFn=fetch,now=Date.now,random=randomBytes}){
  const url=new URL(resolveBackendTarget(supabaseUrl,databaseTarget));
  if(!serviceKey||!anonKey)throw Error('Clés locales requises');
  const base=url.origin,buckets=new Map();
  async function db(table,{params={},method='GET',body:payload,token=serviceKey,prefer}={}){
    const response=await fetchFn(base+'/rest/v1/'+table+'?'+new URLSearchParams(params),{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{apikey:token===serviceKey?serviceKey:anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    if(!response.ok)throw error(response.status===409?409:502,response.status===409?'Un accès existe déjà pour ce chauffeur':'Service local momentanément indisponible');
    return readLocalJson(response);
  }
  const rate=(key,limit,window)=>{const time=now(),old=buckets.get(key),bucket=old&&time-old.at<window?old:{at:time,n:0};if(bucket.n>=limit)throw error(429,'Trop de demandes. Réessayez plus tard.');bucket.n++;buckets.set(key,bucket);if(buckets.size>2000)for(const [k,v] of buckets)if(time-v.at>3600000)buckets.delete(k);};
  const bearer=req=>String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];
  async function admin(req){const token=bearer(req);if(!token)throw error(401,'Connexion administrateur requise');const response=await fetchFn(base+'/auth/v1/user',{headers:{apikey:anonKey,Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw error(401,'Session expirée');const user=await response.json();if(!uuid(user.id))throw error(401,'Session invalide');const profiles=await db('profiles',{token,params:{select:'role',user_id:eq(user.id)}});if(profiles?.[0]?.role!=='admin')throw error(403,'Administrateur requis');return user;}
  async function driver(req){const token=bearer(req);if(!/^dps_[A-Za-z0-9_-]{43}$/.test(token||''))throw error(401,'Reconnectez-vous avec votre code personnel');const sessions=await db('driver_portal_sessions',{params:{token_hash:eq(hash(token)),expires_at:'gt.'+iso(now()),select:'account_id,expires_at',limit:'1'}});if(!sessions?.[0])throw error(401,'Session expirée');const accounts=await db('driver_portal_accounts',{params:{id:eq(sessions[0].account_id),active:'eq.true',select:'id,display_name',limit:'1'}});if(!accounts?.[0])throw error(401,'Accès chauffeur désactivé');return {account:accounts[0],tokenHash:hash(token)};}
  async function handler(req,res){
    let path;try{path=new URL(req.url,'http://127.0.0.1:4173').pathname;}catch{return false;}
    if(!path.startsWith('/api/driver/')&&!/^\/api\/operations\/driver(?:-|\/)/.test(path))return false;
    try{
      if(!['127.0.0.1:4173','localhost:4173'].includes(String(req.headers.host||'').toLowerCase())||req.headers.origin&&!origins.has(req.headers.origin)||req.socket?.remoteAddress&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw error(403,'Origine refusée');
      if(path==='/api/driver/login'&&req.method==='POST'){
        rate('login:'+clientAddress(req),15,600000);const input=await body(req),code=typeof input.code==='string'?input.code.trim():'';
        if(!/^LUDY-[A-Za-z0-9_-]{32}$/.test(code))throw error(401,'Code personnel invalide');
        const token='dps_'+random(32).toString('base64url');
        const session=await db('rpc/driver_portal_login',{method:'POST',body:{p_credential_hash:hash(code),p_token_hash:hash(token)}});
        if(!session)throw error(401,'Code personnel invalide');
        reply(res,200,{token,expires_at:session.expires_at,name:session.name});return true;
      }
      if(path.startsWith('/api/driver/')){
        const {account,tokenHash}=await driver(req);
        if(path==='/api/driver/me'&&req.method==='GET'){
          const [reports,notifications]=await Promise.all([db('driver_reports',{params:{account_id:eq(account.id),order:'reported_at.desc',limit:'100',select:'id,category,city,place,description,status,admin_note,reported_at,reviewed_at'}}),db('driver_notifications',{params:{account_id:eq(account.id),order:'observed_at.desc',limit:'100',select:'id,kind,title,message,observed_at,acknowledged_at'}})]);
          reply(res,200,{name:account.display_name,reports:reports.map(safeReport),notifications:notifications.map(safeNotification)});return true;
        }
        if(path==='/api/driver/logout'&&req.method==='POST'){await db('driver_portal_sessions',{method:'DELETE',params:{token_hash:eq(tokenHash)}});reply(res,200,{ok:true});return true;}
        if(path==='/api/driver/reports'&&req.method==='POST'){
          const input=await body(req);if(!['accident','traffic','incident'].includes(input.category)||!['Casablanca','Marrakech','Autre'].includes(input.city))throw error(400,'Type ou ville invalide');
          const row={account_id:account.id,category:input.category,city:input.city,place:text(input.place,2,240),description:text(input.description,5,2000),status:'pending',reported_at:iso(now())};
          rate('report:'+account.id,12,3600000);const saved=await db('driver_reports',{method:'POST',body:row,prefer:'return=representation'});reply(res,201,{report:safeReport(saved[0])});return true;
        }
        const ack=path.match(/^\/api\/driver\/notifications\/([^/]+)\/ack$/);
        if(ack&&req.method==='POST'){
          if(!uuid(ack[1]))throw error(400,'Notification invalide');rate('ack:'+account.id,120,60000);
          const rows=await db('driver_notifications',{params:{id:eq(ack[1]),account_id:eq(account.id),select:'id,acknowledged_at',limit:'1'}});if(!rows[0])throw error(404,'Notification introuvable');
          if(!rows[0].acknowledged_at)await db('driver_notifications',{method:'PATCH',params:{id:eq(ack[1]),account_id:eq(account.id),acknowledged_at:'is.null'},body:{acknowledged_at:iso(now())}});
          reply(res,200,{ok:true});return true;
        }
        throw error(404,'Page introuvable');
      }
      const user=await admin(req);
      if(path==='/api/operations/driver-portal'&&req.method==='GET'){
        const [accounts,drivers,reports]=await Promise.all([db('driver_portal_accounts',{params:{order:'display_name',limit:'2000'}}),db('drivers',{params:{select:'code,name,agency_id',order:'name',limit:'2000'}}),db('driver_reports',{params:{order:'reported_at.desc',limit:'300'}})]);
        const names=new Map(accounts.map(row=>[row.id,row.display_name]));reply(res,200,{accounts:accounts.map(safeAccount),drivers:drivers.map(row=>({code:row.code,name:row.name,agency_id:row.agency_id})),reports:reports.map(row=>({...safeReport(row),account_id:row.account_id,driver_name:names.get(row.account_id)||'Chauffeur'}))});return true;
      }
      if(path==='/api/operations/driver-accounts'&&req.method==='POST'){
        const input=await body(req),driverCode=text(input.driver_code,1,120);const rows=await db('drivers',{params:{code:eq(driverCode),select:'code,name,agency_id',limit:'2'}});if(rows.length!==1)throw error(400,'Fiche chauffeur non reconnue');
        const code='LUDY-'+random(24).toString('base64url'),reference=rows[0],saved=await db('driver_portal_accounts',{method:'POST',body:{ludy_driver_code:reference.code,agency_id:reference.agency_id,display_name:text(reference.name,1,160),credential_hash:hash(code),active:true,created_at:iso(now()),rotated_at:iso(now())},prefer:'return=representation'});
        reply(res,201,{account:safeAccount(saved[0]),code});return true;
      }
      const access=path.match(/^\/api\/operations\/driver-accounts\/([^/]+)\/(reset|revoke)$/);
      if(access&&req.method==='POST'){
        if(!uuid(access[1]))throw error(400,'Accès invalide');
        const code=access[2]==='reset'?'LUDY-'+random(24).toString('base64url'):null;
        const rotated=await db('rpc/driver_portal_rotate',{method:'POST',body:{p_account:access[1],p_credential_hash:code?hash(code):null,p_user:user.id}});
        if(!rotated)throw error(404,'Accès introuvable');
        reply(res,200,code?{code}:{ok:true});return true;
      }
      const moderation=path.match(/^\/api\/operations\/driver-reports\/([^/]+)\/moderate$/);
      if(moderation&&req.method==='POST'){
        if(!uuid(moderation[1]))throw error(400,'Signalement invalide');const input=await body(req);if(!['pending','verified','rejected','closed'].includes(input.status))throw error(400,'Statut invalide');const note=input.note==null||input.note===''?'':text(input.note,1,1000);
        const saved=await db('driver_reports',{method:'PATCH',params:{id:eq(moderation[1])},body:{status:input.status,admin_note:note,reviewed_at:iso(now()),reviewed_by:user.id},prefer:'return=representation'});if(!saved?.[0])throw error(404,'Signalement introuvable');reply(res,200,{report:safeReport(saved[0])});return true;
      }
      throw error(404,'Page introuvable');
    }catch(e){reply(res,Number.isInteger(e.status)?e.status:500,{error:e.status?e.message:'Service local momentanément indisponible'});return true;}
  }
  handler.notify=async({driverCode,eventKey,kind,title,message,observedAt,evidence={}})=>{
    const code=text(driverCode,1,120),key=text(eventKey,1,240);if(!['overconsumption','speeding','harsh_driving','info'].includes(kind))throw Error('Notification kind invalid');
    const at=Date.parse(observedAt);if(!Number.isFinite(at)||at>now()+5000||now()-at>86400000)throw Error('Notification time invalid');
    if(!evidence||Array.isArray(evidence)||typeof evidence!=='object'||Buffer.byteLength(JSON.stringify(evidence))>16000)throw Error('Notification evidence invalid');
    const accounts=await db('driver_portal_accounts',{params:{ludy_driver_code:eq(code),active:'eq.true',select:'id',limit:'2'}});if(accounts.length!==1)return {delivered:false,reason:'no_active_account'};
    const saved=await db('driver_notifications',{method:'POST',params:{on_conflict:'account_id,event_key'},body:{account_id:accounts[0].id,event_key:key,kind,title:text(title,1,160),message:text(message,1,1000),observed_at:iso(at),evidence},prefer:'resolution=ignore-duplicates,return=representation'});return {delivered:!!saved?.length,duplicate:!saved?.length};
  };
  return handler;
}
