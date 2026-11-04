import {privateModeValid,ensurePrivateDirectory,syncPrivateDirectory} from './private-files.mjs';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { boltState, validTime } from './fleet-domain.mjs';
import {retryAfterSeconds,retryDeadline} from './provider-retry.mjs';
import {boltFinancialCapabilities} from './bolt-finance.mjs';

const TOKEN_URL='https://oidc.bolt.eu/token';
const API_URL='https://node.bolt.eu/fleet-integration-gateway-v2/fleetIntegration/v2/';
const ALLOWED=new Set(['getCompanies','getDrivers','getOnlineDrivers','getVehicles','getRideHistory']);
const RIDE_FIELDS=new Set(['company_id','driver_uuids','start_datetime','end_datetime','limit','offset','order_states']);
const PAGE_LIMIT=1000,MAX_ROWS=100000,MAX_PAGES=100,SNAPSHOT_MS=60000;
const incomplete=()=>new BoltError('Lecture Bolt incomplète ou incohérente : synchronisation interrompue',502);
function quotaError(response,now){
  return new BoltError('Quota Bolt atteint : nouvel essai différé',429,retryAfterSeconds(response.headers.get('retry-after'),now));
}
const timeout=(maximum,deadline)=>{
  const left=deadline-performance.now();
  if(left<=0)throw new BoltError('Délai de lecture Bolt atteint : synchronisation interrompue',502);
  return AbortSignal.timeout(Math.max(1,Math.floor(Math.min(maximum,left))));
};
function uniqueRows(rows,key,maximum=MAX_ROWS,seen=new Set()){
  if(!Array.isArray(rows)||rows.length>maximum)throw incomplete();
  for(const row of rows){
    const id=row?.[key];
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof id!=='string'||!id.trim()||id.length>160||seen.has(id))throw incomplete();
    seen.add(id);
  }
  return rows;
}
function declaredTotal(data,key,required=true){
  const total=data[key];
  if(total===undefined&&!required)return null;
  if(!Number.isSafeInteger(total)||total<0||total>MAX_ROWS)throw incomplete();
  return total;
}
const vehicleText=(value,max=160)=>typeof value==='string'&&value.trim().length<=max&&!/[\u0000-\u001f]/.test(value)?value.trim()||null:null;
const plateKey=value=>vehicleText(value)?.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu,'')||null;
const sameLabel=(a,b)=>a.normalize('NFKC').toLowerCase().replace(/\s+/g,' ')===b.normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
function vehicleCatalogue(rows){
  const ids=new Map(),plates=new Map();
  for(const row of rows){ids.set(row.uuid,row);const plate=plateKey(row.registration_number);if(plate)plates.set(plate,plates.has(plate)?null:row);}
  return {ids,plates};
}
function vehicleDetails(vehicle,catalogue){
  const id=vehicleText(vehicle?.uuid),plate=vehicleText(vehicle?.registration_number),key=plateKey(plate);
  // A model can describe a car, never identify one. Catalogue joins remain
  // inside this company and reject conflicting UUID/plate evidence.
  let reference=id?catalogue.ids.get(id):key?catalogue.plates.get(key):null;
  if(reference&&key&&plateKey(reference.registration_number)&&plateKey(reference.registration_number)!==key)reference=null;
  const make=vehicleText(vehicle?.make),model=vehicleText(vehicle?.model);
  if(reference&&[['make',make],['model',model]].some(([field,value])=>value&&vehicleText(reference[field])&&!sameLabel(value,vehicleText(reference[field]))))reference=null;
  const resolvedMake=make||vehicleText(reference?.make),resolvedModel=model||vehicleText(reference?.model);
  return {plate:plate||vehicleText(reference?.registration_number),uuid:id||vehicleText(reference?.uuid),
    model:resolvedModel?[resolvedMake,resolvedModel].filter(Boolean).join(' ').slice(0,260):null,
    model_origin:resolvedModel?(model&&(!resolvedMake||make)?'vehicle_payload':'vehicle_inventory'):null};
}
const CREDENTIAL_BYTES=32768;
export function validateBoltCredentials(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['clientId','clientSecret'].includes(k)))throw new BoltError('Identifiants API Bolt requis',400);
  const clientId=typeof input.clientId==='string'?input.clientId.trim():'',clientSecret=input.clientSecret;
  if(!clientId||clientId.length>512||/[\x00-\x1f\x7f]/.test(clientId))throw new BoltError('Identifiant client Bolt invalide',400);
  if(typeof clientSecret!=='string'||!clientSecret.length||clientSecret.length>4096||/[\x00-\x1f\x7f]/.test(clientSecret))throw new BoltError('Secret client Bolt invalide',400);
  return {clientId,clientSecret};
}
async function privateBoltFile(filename){
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!privateModeValid(info,0o600,filename)||info.size>CREDENTIAL_BYTES)throw new BoltError('Fichier Bolt privé requis',409);
  const normalize=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  if(normalize(await realpath(filename))!==normalize(filename))throw new BoltError('Fichier Bolt privé requis',409);
  return info;
}
export async function readBoltCredentials(filename) {
  if(!filename) return null;
  let file;
  try {
    await privateBoltFile(filename);file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await file.stat();if(!info.isFile()||info.nlink!==1||!privateModeValid(info,0o600,filename)||info.size>CREDENTIAL_BYTES)throw new Error();
    const bytes=Buffer.alloc(CREDENTIAL_BYTES+1);let count=0;
    while(count<bytes.length){const {bytesRead}=await file.read(bytes,count,bytes.length-count,null);if(!bytesRead)break;count+=bytesRead;}
    if(count>CREDENTIAL_BYTES)throw new Error();
    const env={};for(const line of bytes.subarray(0,count).toString('utf8').split(/\r?\n/)){
      const m=line.match(/^(BOLT_CLIENT_ID|BOLT_CLIENT_SECRET)=(.*)$/);if(!m)continue;
      const raw=m[2].trim();env[m[1]]=raw.startsWith('"')?JSON.parse(raw):raw.replace(/^'(.*)'$/,'$1');
    }
    const clientId=env.BOLT_CLIENT_ID, clientSecret=env.BOLT_CLIENT_SECRET;
    return clientId&&clientSecret?validateBoltCredentials({clientId,clientSecret}):null;
  } catch(e) {if(e.code==='ENOENT')return null;throw new BoltError('Lecture des identifiants Bolt locaux impossible',409);}
  finally{await file?.close();}
}
export async function saveBoltCredentials(filename,input){
  const value=validateBoltCredentials(input);
  if(typeof filename!=='string'||!path.isAbsolute(filename))throw new BoltError('Stockage Bolt local non configuré',409);
  const directory=path.dirname(filename),temporary=path.join(directory,'.bolt-'+randomUUID()+'.tmp');let file;
  try{
    await ensurePrivateDirectory(directory);
    try{await privateBoltFile(filename);}catch(error){if(error.code!=='ENOENT')throw error;}
    file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await file.writeFile('BOLT_CLIENT_ID='+JSON.stringify(value.clientId)+'\nBOLT_CLIENT_SECRET='+JSON.stringify(value.clientSecret)+'\n');
    await file.sync();await file.close();file=null;
    await rename(temporary,filename);await syncPrivateDirectory(directory);
  }catch{throw new BoltError('Enregistrement privé des identifiants Bolt impossible',409);}
  finally{await file?.close();await rm(temporary,{force:true}).catch(()=>{});}
}
export class BoltError extends Error {
  constructor(message,code=502,retryAfter=60){super(message);this.status=code;this.retryAfter=retryAfter;}
}
export class BoltClient {
  constructor({credentials,fetchFn=fetch,now=Date.now}){this.credentials=credentials;this.fetch=fetchFn;this.now=now;this.token=null;this.tokenUntil=0;this.tokenPromise=null;this.blockedUntil=0;this.credentialRevision=0;}
  resetCredentials(){this.credentialRevision++;this.token=null;this.tokenUntil=0;this.blockedUntil=0;}
  financialCapabilities(){return boltFinancialCapabilities();}
  quota(response){const error=quotaError(response,this.now());this.blockedUntil=Math.max(this.blockedUntil,retryDeadline(this.now(),error.retryAfter));return error;}
  async accessToken(force=false,deadline=performance.now()+20000){
    if(this.now()<this.blockedUntil)throw new BoltError('Quota Bolt atteint : nouvel essai différé',429,Math.max(1,Math.ceil((this.blockedUntil-this.now())/1000)));
    if(!force && this.token && this.now()<this.tokenUntil)return this.token;
    if(this.tokenPromise)return this.tokenPromise;
    const revision=this.credentialRevision;
    this.tokenPromise=(async()=>{
      const creds=await this.credentials();if(!creds)throw new BoltError('Identifiants Bolt non configurés',409);
      const res=await this.fetch(TOKEN_URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:creds.clientId,client_secret:creds.clientSecret,grant_type:'client_credentials',scope:'fleet-integration:api'}).toString(),signal:timeout(20000,deadline)});
      if(res.status===429){await res.body?.cancel().catch(()=>{});throw this.quota(res);}
      const data=await res.json().catch(()=>null);
      if(revision!==this.credentialRevision)throw new BoltError('Identifiants Bolt modifiés : relancez la lecture',409);
      if(!res.ok || !data?.access_token)throw new BoltError('Authentification Bolt refusée (HTTP '+res.status+')',502);
      this.token=data.access_token;this.tokenUntil=this.now()+Math.max(10,Number(data.expires_in || 600)-60)*1000;return this.token;
    })().finally(()=>{this.tokenPromise=null;});return this.tokenPromise;
  }
  async call(endpoint,body,retry=true,deadline=performance.now()+25000){
    if(!ALLOWED.has(endpoint))throw new BoltError('Endpoint Bolt non autorisé',400);
    const token=await this.accessToken(false,deadline);
    const res=await this.fetch(API_URL+endpoint,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:timeout(25000,deadline)});
    if(res.status===429){await res.body?.cancel().catch(()=>{});throw this.quota(res);}
    const json=await res.json().catch(()=>null);
    if(json?.code===503 && retry){await this.accessToken(true,deadline);return this.call(endpoint,body,false,deadline);}
    if(json?.code===1005)throw this.quota(res);
    if(endpoint==='getRideHistory'&&json?.code===702){
      // Provider messages can contain submitted values. Retain only known field
      // names so a validation failure stays diagnosable without exposing them.
      const fields=[...new Set((Array.isArray(json.validation_errors)?json.validation_errors:[]).slice(0,100).map(e=>e?.property).filter(f=>RIDE_FIELDS.has(f)))];
      throw new BoltError('Paramètres Bolt getRideHistory refusés (code 702'+(fields.length?' ; champs : '+fields.join(', '):'')+')',502);
    }
    if(!res.ok || json?.code!==0)throw new BoltError('Bolt '+endpoint+' indisponible (code '+(Number.isFinite(json?.code)?json.code:res.status)+')',502);
    if(!json.data || typeof json.data!=='object')throw new BoltError('Réponse Bolt incomplète',502);
    return json.data;
  }
  async pages(endpoint,body,key,totalKey='total_rows'){
    return (await this.pageSet(endpoint,body,key,totalKey)).rows;
  }
  async pageSet(endpoint,body,key,totalKey='total_rows',deadline=performance.now()+SNAPSHOT_MS,maximum=MAX_ROWS){
    const out=[],seen=new Set();let total=null,observedAt=null;
    for(let page=0;page<MAX_PAGES;page++){
      const data=await this.call(endpoint,{...body,limit:PAGE_LIMIT,offset:out.length},true,deadline);
      const count=declaredTotal(data,totalKey),part=uniqueRows(data[key],key==='orders'?'order_reference':'uuid',PAGE_LIMIT,seen);
      if(count>maximum)throw new BoltError('Lecture Bolt trop volumineuse : réduire la période',413);
      if(total!==null&&total!==count)throw incomplete();
      total=count;observedAt ||= new Date(this.now()).toISOString();
      if(out.length+part.length>total||!part.length&&out.length<total)throw incomplete();
      out.push(...part);
      if(out.length===total)return {rows:out,total,pages:page+1,observedAt};
      // A short page is not the end when Bolt declares more rows. Advance by
      // the actual rows received, never skip the remainder of a short page.
    }
    throw new BoltError('Pagination Bolt trop longue : synchronisation interrompue',502);
  }
  async snapshot(){
    const deadline=performance.now()+SNAPSHOT_MS;
    const data=await this.call('getCompanies',undefined,true,deadline);if(!Array.isArray(data.companies)||data.companies.length>1000)throw incomplete();
    const companies=data.companies;
    const rows=[],vehicles=[],byCompany=[],companyIds=new Set(),driverStatuses={active:0,suspended:0,deactivated:0,unknown:0};
    for(const company of companies){
      const companyId=company?.company_id;if(!Number.isSafeInteger(companyId)||companyId<1||companyIds.has(companyId))throw incomplete();companyIds.add(companyId);
      // No status/date/UUID filters: every roster row accessible to this API key.
      const roster=await this.pageSet('getDrivers',{company_id:companyId},'drivers','total_rows',deadline),drivers=roster.rows;
      // The documented online endpoint is unpaginated. Refuse duplicates or an
      // advertised incomplete list instead of choosing a possibly stale status.
      const live=await this.call('getOnlineDrivers',{company_id:companyId},true,deadline);
      uniqueRows(live.drivers,'uuid');
      const onlineTotal=declaredTotal(live,'total_rows',false),onlineAt=new Date(this.now()).toISOString();
      if(onlineTotal!==null&&onlineTotal!==live.drivers.length||live.has_more===true||live.next_cursor!=null)throw incomplete();
      const liveById=new Map(live.drivers.map(x=>[x.uuid,x]));
      const inventory=await this.pageSet('getVehicles',{company_id:companyId},'vehicles','total_rows',deadline),fleet=inventory.rows,catalogue=vehicleCatalogue(fleet);
      for(const d of drivers){
        const o=liveById.get(d.uuid),onlineVehicle=vehicleDetails(o?.vehicle,catalogue),hasLiveIdentity=!!(onlineVehicle.plate||onlineVehicle.uuid),v=hasLiveIdentity?onlineVehicle:vehicleDetails(d.vehicles?.selected,catalogue);
        rows.push({sourceId:d.uuid,organizationId:String(companyId),name:[d.first_name,d.last_name].filter(Boolean).join(' ') || d.display_name || 'Chauffeur Bolt',
          state:boltState(d,o),readAt:o?onlineAt:roster.observedAt,sourceAt:null,eventAt:validTime(o?.current_state?.changed_at),vehicleLabel:v.plate,vehicleModel:v.model,
          evidence:{method:'official_api',account_status:d.status || null,is_online:typeof d.is_online==='boolean'?d.is_online:null,raw_state:o?.current_state?.code || null,order_state:o?.current_order?.state || null,
            vehicle_origin:v.plate?(hasLiveIdentity?'bolt_live':'bolt_selected'):null,vehicle_uuid:v.uuid,vehicle_model:v.model,vehicle_model_origin:v.model_origin,
            location:o?.current_location && Number.isFinite(o.current_location.lat)&&Number.isFinite(o.current_location.lng)?{lat:o.current_location.lat,lng:o.current_location.lng}:null}});
        driverStatuses[Object.hasOwn(driverStatuses,d.status)?d.status:'unknown']++;
      }
      // A driver returned online between roster and live requests is preserved, with its real UUID.
      const known=new Set(drivers.map(x=>x.uuid));
      let onlineOnly=0;
      for(const o of live.drivers){if(known.has(o.uuid))continue;onlineOnly++;const v=vehicleDetails(o.vehicle,catalogue);rows.push({sourceId:o.uuid,organizationId:String(companyId),name:[o.first_name,o.last_name].filter(Boolean).join(' ') || o.display_name || 'Chauffeur Bolt',state:boltState(o,o),readAt:onlineAt,sourceAt:null,eventAt:validTime(o.current_state?.changed_at),vehicleLabel:v.plate,vehicleModel:v.model,evidence:{method:'official_api',raw_state:o.current_state?.code || null,vehicle_origin:v.plate?'bolt_live':null,vehicle_uuid:v.uuid,vehicle_model:v.model,vehicle_model_origin:v.model_origin}});}
      for(const v of fleet)vehicles.push({source:'bolt',organization_id:String(companyId),external_id:v.uuid,plate:v.registration_number || null,make:v.make || null,model:v.model || null,status:v.status || null,received_at:inventory.observedAt});
      byCompany.push({company_id:companyId,drivers:drivers.length+onlineOnly,vehicles:fleet.length,online_drivers:live.drivers.length,online_only_drivers:onlineOnly,drivers_total:roster.total,vehicles_total:inventory.total});
    }
    return {rows,vehicles,companies:companies.map(c=>({id:c.company_id,name:c.legal_name || null,city:c.city_name || null,status:c.status_code || null})),at:new Date(this.now()).toISOString(),
      coverage:{kind:'company_roster',complete:true,scope:'api_key_companies',companies:companies.length,drivers:rows.length,vehicles:vehicles.length,
        roster_drivers:byCompany.reduce((n,c)=>n+c.drivers_total,0),online_drivers:byCompany.reduce((n,c)=>n+c.online_drivers,0),online_only_drivers:byCompany.reduce((n,c)=>n+c.online_only_drivers,0),driver_statuses:driverStatuses,by_company:byCompany}};
  }
  async rides(companyId,from,to,{driverUuids,maxRows=MAX_ROWS}={}){
    const a=Date.parse(from),b=Date.parse(to);if(!Number.isSafeInteger(companyId)||companyId<1||!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>31*86400000)throw new BoltError('Période Bolt : 31 jours maximum',400);
    // getRideHistory rejects fractional seconds (702), despite the general
    // OpenAPI date-time type. Send UTC at its supported whole-second precision.
    if(Math.floor(b/1000)<=Math.floor(a/1000))throw new BoltError('Période Bolt : une seconde minimum',400);
    const startDatetime=new Date(a).toISOString().replace(/\.\d{3}Z$/,'Z'),endDatetime=new Date(b).toISOString().replace(/\.\d{3}Z$/,'Z');
    if(driverUuids!==undefined&&(!Array.isArray(driverUuids)||driverUuids.length<1||driverUuids.length>1000||driverUuids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))))throw new BoltError('Identifiants chauffeur Bolt invalides',400);
    if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>MAX_ROWS)throw new BoltError('Limite de lecture Bolt invalide',400);
    return (await this.pageSet('getRideHistory',{company_id:companyId,start_datetime:startDatetime,end_datetime:endDatetime,...(driverUuids?{driver_uuids:[...new Set(driverUuids)]}:{})},'orders','total',performance.now()+SNAPSHOT_MS,maxRows)).rows;
  }
}
