import {privateModeValid,syncPrivateDirectory} from './private-files.mjs';
import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const DEFAULT_FILE=fileURLToPath(new URL('../.local/uber-reports-browser/lease.json',import.meta.url));
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const unavailable=()=>fail(503,'Bail du navigateur de rapports indisponible. Vérifiez son fichier local privé.');
const conflict=()=>fail(409,'Un autre collecteur détient le bail, ou ce bail a expiré.');
const validId=value=>typeof value==='string'&&UUID.test(value);
const owner=input=>{
  if(!input||!validId(input.collectorId)||!validId(input.userId))throw fail(400,'Identifiants du collecteur et de l’administrateur invalides.');
  return {collectorId:input.collectorId.toLowerCase(),userId:input.userId.toLowerCase()};
};
const same=(lease,identity)=>lease.collectorId===identity.collectorId&&lease.userId===identity.userId;

// One instance is owned by the local server; browser collectors use its API.
// Disk persistence survives server restarts, while this queue serializes requests.
export function createUberReportBrowserLease({filePath=DEFAULT_FILE,now=Date.now,ttlMs=90000}={}) {
  if(typeof filePath!=='string'||!isAbsolute(filePath))throw new TypeError('Chemin absolu du bail local requis.');
  if(typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<=0)throw new TypeError('Horloge et durée du bail invalides.');
  const directory=dirname(filePath);let queue=Promise.resolve();
  const serial=work=>{const task=queue.then(work);queue=task.catch(()=>{});return task;};
  const clock=()=>{const at=now();if(!Number.isSafeInteger(at)||at<0||at+ttlMs>8640000000000000)throw unavailable();return at;};
  const fresh=(lease,at)=>lease!==null&&Date.parse(lease.expiresAt)>at;
  async function privateDirectory(create=false) {
    if(create)await mkdir(directory,{recursive:true,mode:0o700});
    let stat;try{stat=await lstat(directory);}catch(error){if(error.code==='ENOENT'&&!create)return false;throw error;}
    if(!stat.isDirectory()||!privateModeValid(stat,0o700,directory))throw unavailable();return true;
  }
  async function read() {
    let file;
    try{
      if(!await privateDirectory())return null;
      try{file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const stat=await file.stat();if(!stat.isFile()||!privateModeValid(stat,0o600,filePath)||stat.size>1024)throw unavailable();
      const data=JSON.parse(await file.readFile('utf8'));
      if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!=='collectorId,expiresAt,userId'||
          !validId(data.collectorId)||!validId(data.userId)||typeof data.expiresAt!=='string'||
          !Number.isFinite(Date.parse(data.expiresAt))||new Date(data.expiresAt).toISOString()!==data.expiresAt)throw unavailable();
      return {...owner(data),expiresAt:data.expiresAt};
    }catch{throw unavailable();}finally{await file?.close();}
  }
  async function save(lease) {
    const temporary=filePath+'.'+randomUUID()+'.tmp';let file,dir;
    try{
      await privateDirectory(true);
      file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await file.writeFile(JSON.stringify(lease)+'\n');await file.sync();await file.close();file=null;
      await rename(temporary,filePath);
      await syncPrivateDirectory(directory);
    }catch{throw unavailable();}finally{await file?.close();await dir?.close();await rm(temporary,{force:true}).catch(()=>{});}
  }
  async function renew(identity,at){const lease={...identity,expiresAt:new Date(at+ttlMs).toISOString()};await save(lease);return lease;}
  async function owned(identity,at){const lease=await read();if(!fresh(lease,at)||!same(lease,identity))throw conflict();return lease;}
  return {
    current:()=>serial(async()=>{const lease=await read();return fresh(lease,clock())?lease:null;}),
    claim:input=>serial(async()=>{const identity=owner(input),lease=await read(),at=clock();if(fresh(lease,at)&&!same(lease,identity))throw conflict();return renew(identity,at);}),
    heartbeat:input=>serial(async()=>{const identity=owner(input),at=clock();await owned(identity,at);return renew(identity,at);}),
    assertOwner:input=>serial(async()=>owned(owner(input),clock())),
    release:input=>serial(async()=>{const identity=owner(input),lease=await read();if(lease===null)return {released:false};if(!same(lease,identity))throw conflict();if(!fresh(lease,clock()))return {released:false};
      try{await rm(filePath);}catch{throw unavailable();}return {released:true};})
  };
}
