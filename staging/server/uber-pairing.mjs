import {privateModeValid} from './private-files.mjs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,rename,rm,chmod} from 'node:fs/promises';
import pathModule from 'node:path';

const DAY=86400000,MAX_AGE=90*DAY,IDLE_AGE=30*DAY,TOUCH_INTERVAL=5*60000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>Object.assign(new Error('Stockage privé de la liaison Uber indisponible.'),{status:503});
const validUser=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const validEntry=e=>e&&/^[a-f0-9]{64}$/.test(e.hash)&&validUser(e.user)&&
  [e.createdAt,e.lastSeenAt,e.expires,e.idleExpires].every(Number.isFinite)&&e.createdAt<=e.lastSeenAt&&
  e.lastSeenAt<e.expires&&e.expires-e.createdAt<=MAX_AGE&&e.idleExpires<=e.expires&&e.idleExpires-e.lastSeenAt<=IDLE_AGE;

/** The caller validates the issuing user's admin role on every use. Tokens never enter this file. */
export function createUberPairing({path,now=Date.now}={}) {
  if(path!==undefined&&(typeof path!=='string'||!pathModule.isAbsolute(path)))throw new TypeError('Chemin privé absolu requis.');
  let loaded=false,entries=[],queue=Promise.resolve();
  const serialize=fn=>{const work=queue.then(fn);queue=work.catch(()=>{});return work;};
  async function load() {
    if(loaded)return;
    if(!path){loaded=true;return;}
    let file;
    try{
      file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await file.stat();if(!stat.isFile()||!privateModeValid(stat,0o600,path)||stat.size>65536)throw fail();
      const value=JSON.parse(await file.readFile('utf8'));
      if(value.version!==1||!Array.isArray(value.entries)||value.entries.length>100||value.entries.some(e=>!validEntry(e)))throw fail();
      entries=value.entries;
    }catch(error){if(error.code!=='ENOENT')throw fail();}
    finally{await file?.close();}
    loaded=true;
  }
  async function save(next) {
    if(!path){entries=next;return;}
    const parent=pathModule.dirname(path),temporary=path+'.'+randomUUID()+'.tmp';let file;
    try{
      await mkdir(parent,{recursive:true,mode:0o700});await chmod(parent,0o700);
      file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await file.writeFile(JSON.stringify({version:1,entries:next})+'\n');await file.sync();await file.close();file=null;
      await rename(temporary,path);entries=next;
    }catch{throw fail();}finally{await file?.close();await rm(temporary,{force:true}).catch(()=>{});}
  }
  const live=e=>e.expires>now()&&e.idleExpires>now();
  function issue(user) {return serialize(async()=>{
    if(!validUser(user))throw new TypeError('Administrateur local requis.');
    await load();const at=now(),token='ludy_uber_'+randomBytes(32).toString('base64url');
    const entry={hash:hash(token),user,createdAt:at,lastSeenAt:at,expires:at+MAX_AGE,idleExpires:at+IDLE_AGE};
    const next=entries.filter(e=>e.user!==user&&live(e));if(next.length>=100)throw fail();
    await save([...next,entry]);
    return {token,expires_at:new Date(entry.expires).toISOString(),idle_expires_at:new Date(entry.idleExpires).toISOString(),
      idle_timeout_days:30,ingest_url:'http://127.0.0.1:4173/api/fleet/uber/ingest'};
  });}
  function verify(token) {return serialize(async()=>{
    if(typeof token!=='string'||!/^ludy_uber_[A-Za-z0-9_-]{43}$/.test(token))return null;
    await load();const digest=hash(token),entry=entries.find(e=>e.hash===digest);
    if(!entry||!live(entry))return null;
    const at=now();
    // Persist activity at most once every five minutes, never extending the absolute expiry.
    if(at-entry.lastSeenAt>=TOUCH_INTERVAL){
      const next={...entry,lastSeenAt:at,idleExpires:Math.min(at+IDLE_AGE,entry.expires)};
      await save(entries.filter(live).map(e=>e.hash===digest?next:e));
      return {user:next.user,expires:next.expires,idleExpires:next.idleExpires};
    }
    return {user:entry.user,expires:entry.expires,idleExpires:entry.idleExpires};
  });}
  function revokeUser(user) {return serialize(async()=>{await load();await save(entries.filter(e=>e.user!==user&&live(e)));});}
  function close(){entries=[];loaded=false;}
  return {issue,verify,revokeUser,close};
}
