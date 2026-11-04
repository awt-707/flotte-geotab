import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,link,lstat,mkdir,open,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_DIRECTORY=fileURLToPath(new URL('../.local/uber-reports/',import.meta.url));
const MAX_BYTES=6*1024*1024,DAY=86400000,TYPES=new Set(['trip_activity','driver_activity','driver_quality']);
const STATES=new Set(['pending','imported','failed']),queues=new Map();
const digest=value=>createHash('sha256').update(value).digest('hex');
const error=(status,message,code)=>Object.assign(Error(message),{status,code});
const unavailable=()=>error(503,'Stockage privé des rapports Uber indisponible.','UBER_REPORT_STORAGE_UNAVAILABLE');
const badInput=()=>error(400,'Métadonnées ou contenu du rapport Uber invalides.','UBER_REPORT_FILE_INVALID');
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const validStamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const validToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

function identity({organizationId,reportType,period,sha256}){
 if(typeof organizationId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(organizationId)||!TYPES.has(reportType)||!period||!validDate(period.start_date)||!validDate(period.end_date)||!validToken(sha256))throw badInput();
 const span=Date.parse(period.end_date)-Date.parse(period.start_date);
 if(span<0||span>31*DAY)throw badInput();
 const organization_id=organizationId.toLowerCase(),start_date=period.start_date,end_date=period.end_date;
 const token=digest(JSON.stringify([organization_id,reportType,start_date,end_date,sha256]));
 const file=`files/${organization_id}/${reportType}-${start_date}_${end_date}-${sha256}.csv`;
 return {token,organization_id,report_type:reportType,start_date,end_date,sha256,file};
}

function serialize(key,work){
 const result=(queues.get(key)||Promise.resolve()).then(work),tail=result.then(()=>{},()=>{});
 queues.set(key,tail);void tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});return result;
}

async function privateDirectory(directory){
 await ensurePrivateDirectory(directory);
}

async function syncDirectory(directory){
 await syncPrivateDirectory(directory);
}

// The temporary file is fully written and synced before it becomes visible.
// link publishes an immutable file without replacing a concurrent writer's copy.
async function atomicWrite(filename,bytes,{replace=false}={}){
 const temporary=filename+'.'+randomUUID()+'.tmp';let handle;
 try{
  handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
  if(replace)await rename(temporary,filename);
  else try{await link(temporary,filename);}catch(err){if(err.code==='EEXIST')return false;throw err;}
  await syncDirectory(path.dirname(filename));return true;
 }finally{await handle?.close();await rm(temporary,{force:true}).catch(()=>{});}
}

async function privateRead(filename,maxBytes){
 let handle;
 try{
  handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>maxBytes)throw unavailable();
  // Correct accidentally broadened permissions before reading or returning it.
  if(process.platform==='win32'){if(!privateModeValid(stat,0o600,filename))throw unavailable();}else await handle.chmod(0o600);
  const bytes=await handle.readFile();
  if(bytes.length<1||bytes.length>maxBytes)throw unavailable();return bytes;
 }finally{await handle?.close();}
}

function checkedReceipt(value,token){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!STATES.has(value.status)||!Number.isInteger(value.byte_length)||value.byte_length<1||value.byte_length>MAX_BYTES||!validStamp(value.created_at)||!validStamp(value.updated_at)||value.status==='imported'&&!validStamp(value.imported_at)||value.status!=='imported'&&value.imported_at!==null)throw unavailable();
 let id;try{id=identity({organizationId:value.organization_id,reportType:value.report_type,period:value,sha256:value.sha256});}catch{throw unavailable();}
 if(id.token!==token||value.file!==id.file)throw unavailable();
 return {version:1,organization_id:id.organization_id,report_type:id.report_type,start_date:id.start_date,end_date:id.end_date,sha256:id.sha256,byte_length:value.byte_length,file:id.file,status:value.status,created_at:value.created_at,updated_at:value.updated_at,imported_at:value.imported_at};
}

/**
 * Private, local archive for already validated Uber CSV exports.
 *
 * CSVs stay immutable in files/<organization>/<type>-<period>-<sha256>.csv.
 * receipts/<opaque token>.json records pending/imported/failed without CSV text,
 * source URL, names, credentials or arbitrary error messages. Files are retained
 * after import for local inspection; this module has no retention deletion job.
 *
 * The caller validates the report schema and authorizes access before persisting.
 * The token is internal to the server, never an accepted browser filesystem path.
 * Each report's writes are serialized across store instances in this Node process.
 */
export function createUberReportFileStore({directory=DEFAULT_DIRECTORY,now=Date.now}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof now!=='function')throw new TypeError('Dossier privé absolu et horloge requis.');
 const base=path.resolve(directory),receiptDirectory=path.join(base,'receipts'),filesDirectory=path.join(base,'files');
 const receiptPath=token=>path.join(receiptDirectory,token+'.json');
 const csvPath=receipt=>path.join(base,...receipt.file.split('/'));
 const stamp=()=>{const at=now();if(!Number.isFinite(at))throw unavailable();return new Date(at).toISOString();};
 async function prepareDirectories(organization){
  await privateDirectory(base);await privateDirectory(receiptDirectory);await privateDirectory(filesDirectory);
  if(organization)await privateDirectory(path.join(filesDirectory,organization));
 }
 async function load(token){
  try{return checkedReceipt(JSON.parse((await privateRead(receiptPath(token),4096)).toString('utf8')),token);}
  catch(err){if(err.code==='ENOENT')return null;throw unavailable();}
 }
 async function verifyFile(receipt){
  const bytes=await privateRead(csvPath(receipt),MAX_BYTES);
  if(bytes.length!==receipt.byte_length||digest(bytes)!==receipt.sha256)throw unavailable();
 }
 async function persistReport(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw badInput();
  const {organizationId,reportType,period,csv}=input;
  if(typeof csv!=='string'||!csv.trim()||csv.includes('\0'))throw badInput();
  const byteLength=Buffer.byteLength(csv,'utf8');if(byteLength>MAX_BYTES)throw error(413,'Rapport Uber limité à 6 Mo.','UBER_REPORT_FILE_TOO_LARGE');
  const bytes=Buffer.from(csv,'utf8'),id=identity({organizationId,reportType,period,sha256:digest(bytes)});
  return serialize(base+':'+id.token,async()=>{
   try{
    await prepareDirectories(id.organization_id);
    const created=await atomicWrite(csvPath(id),bytes),existing=await load(id.token);
    const at=stamp(),receipt=existing||{version:1,organization_id:id.organization_id,report_type:id.report_type,start_date:id.start_date,end_date:id.end_date,sha256:id.sha256,byte_length:bytes.length,file:id.file,status:'pending',created_at:at,updated_at:at,imported_at:null};
    await verifyFile(receipt);
    if(!existing){await atomicWrite(receiptPath(id.token),Buffer.from(JSON.stringify(receipt)+'\n'));}
    const saved=await load(id.token);if(!saved)throw unavailable();
    return {token:id.token,created,receipt:saved};
   }catch{throw unavailable();}
  });
 }
 async function mark(token,status){
  if(!validToken(token))throw badInput();
  return serialize(base+':'+token,async()=>{
   try{
    await prepareDirectories();const receipt=await load(token);
    if(!receipt)throw error(404,'Reçu de rapport Uber introuvable.','UBER_REPORT_FILE_NOT_FOUND');
    await privateDirectory(path.join(filesDirectory,receipt.organization_id));await verifyFile(receipt);
    if(receipt.status==='imported'||receipt.status===status)return receipt;
    const updated={...receipt,status,updated_at:stamp()};if(status==='imported')updated.imported_at=updated.updated_at;
    await atomicWrite(receiptPath(token),Buffer.from(JSON.stringify(updated)+'\n'),{replace:true});return updated;
   }catch(err){if(err.code==='UBER_REPORT_FILE_NOT_FOUND')throw err;throw unavailable();}
  });
 }
 return {persistReport,markImported:token=>mark(token,'imported'),markFailed:token=>mark(token,'failed')};
}

const store=createUberReportFileStore();
export const persistReport=input=>store.persistReport(input);
export const markImported=token=>store.markImported(token);
export const markFailed=token=>store.markFailed(token);
import {privateModeValid,syncPrivateDirectory,ensurePrivateDirectory} from './private-files.mjs';
