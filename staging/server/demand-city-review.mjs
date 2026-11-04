import {privateModeValid} from './private-files.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const cities=new Set(['Casablanca','Marrakech']);
const bases=new Set(['explicit_country_city','official_venue_address','unresolved_locality']);
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const invalid=()=>{throw Error('Private city review invalid.');};

/** The same normalized identity used by normalizeDemandImport. No address,
 * UUID, trip time, fingerprint or plan-wide count is returned to the browser. */
export function demandReviewIdentity(row){
 if(!Number.isSafeInteger(Number(row.agency_id))||Number(row.agency_id)<=0||typeof row.external_id!=='string'||!row.external_id)invalid();
 return digest([Number(row.agency_id),'uber',row.external_id]);
}
export function demandReviewSignature(row){
 const identity=demandReviewIdentity(row),at=Date.parse(row.started_at);
 if(row.ride_key!==identity||!Number.isFinite(at)||!cities.has(row.city)||!['completed','cancelled'].includes(row.status)||typeof row.pickup_zone!=='string')invalid();
 return digest([Number(row.agency_id),identity,row.city,new Date(at).toISOString(),row.pickup_zone,row.status]);
}
export function validateDemandCityReview(plan){
 if(!keys(plan,['version','reviewed_at','source_sha256','entries'])||plan.version!==1||!Number.isFinite(Date.parse(plan.reviewed_at))||!hex(plan.source_sha256)||!Array.isArray(plan.entries)||plan.entries.length>20000)invalid();
 const seen=new Set();
 for(const entry of plan.entries){
  if(!keys(entry,['agency_id','ride_key','signature','decision','basis','evidence'])||!Number.isSafeInteger(entry.agency_id)||entry.agency_id<=0||!hex(entry.ride_key)||!hex(entry.signature)||!['confirmed','quarantined'].includes(entry.decision)||!bases.has(entry.basis)||!Array.isArray(entry.evidence)||entry.evidence.length>5)invalid();
  if(entry.decision==='quarantined'&&entry.basis!=='unresolved_locality'||entry.decision==='confirmed'&&entry.basis==='unresolved_locality'||entry.basis==='official_venue_address'&&!entry.evidence.length)invalid();
  for(const source of entry.evidence){
   if(!keys(source,['url','checked_at','sha256'])||!Number.isFinite(Date.parse(source.checked_at))||!hex(source.sha256))invalid();
   let u;try{u=new URL(source.url);}catch{invalid();}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)invalid();
  }
  const key=entry.agency_id+':'+entry.ride_key;if(seen.has(key))invalid();seen.add(key);
 }
 return structuredClone(plan);
}

export function createDemandCityReview(plan,{status=plan?'loaded':'not_loaded'}={}){
 const checked=plan?validateDemandCityReview(plan):null;
 const entries=new Map((checked?.entries||[]).map(entry=>[entry.agency_id+':'+entry.ride_key,entry]));
 return Object.freeze({
  partition(rows){
   const included=[],excluded=[],coverage={status:checked?'loaded':status,matched:0,confirmed:0,quarantined:0,changed:0,completed:0,cancelled:0};
   for(const row of rows){
    let identity;try{identity=demandReviewIdentity(row);}catch{included.push(row);continue;}
    const entry=entries.get(Number(row.agency_id)+':'+identity);if(!entry){included.push(row);continue;}
    coverage.matched++;let matches=false;try{matches=demandReviewSignature(row)===entry.signature;}catch{}
    // A changed known identity needs another review; it never silently inherits
    // a previous confirmation or disappears from the uncertainty counter.
    if(!matches||entry.decision==='quarantined'){
     excluded.push(row);coverage.quarantined++;if(!matches)coverage.changed++;if(row.status==='completed')coverage.completed++;if(row.status==='cancelled')coverage.cancelled++;
    }else{included.push(row);coverage.confirmed++;}
   }
   return {included,excluded,coverage};
  }
 });
}

/** Startup-only private plan read. Missing/invalid plans are visible as a
 * coverage limitation, never treated as an empty successful review. */
export function loadDemandCityReview(filename){
 let handle;
 try{
  if(!path.isAbsolute(filename))invalid();
  const parent=path.dirname(filename),dir=fs.lstatSync(parent);
  if(!dir.isDirectory()||dir.isSymbolicLink()||!privateModeValid(dir,0o700,parent)||fs.realpathSync(parent)!==parent)invalid();
  handle=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(handle);
  if(!stat.isFile()||stat.nlink!==1||!privateModeValid(stat,0o600,filename)||stat.size>4*1024*1024)invalid();
  return createDemandCityReview(JSON.parse(fs.readFileSync(handle,'utf8')));
 }catch(error){return createDemandCityReview(null,{status:error.code==='ENOENT'?'not_loaded':'invalid'});}
 finally{if(handle!==undefined)fs.closeSync(handle);}
}
