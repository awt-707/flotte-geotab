// Passive evidence from responses caused by the user's normal Fleet Earnings
// navigation. This module never sends a provider request or reads auth headers.
import {parseUberEarningsMoney} from './uber-earnings.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS=['revenue','refunds_expenses','adjustments','payout','reported_net_earnings'];
const normalizedName=value=>String(value||'').normalize('NFC').replace(/\s+/g,' ').trim();
function amount(value){if(!value||!/^-?\d{1,20}$/.test(value.amountE5||'')||!/^[A-Z]{3}$/.test(value.currencyCode||''))return null;const n=BigInt(value.amountE5);if(n%1000n!==0n||n/1000n>BigInt(Number.MAX_SAFE_INTEGER)||n/1000n<BigInt(Number.MIN_SAFE_INTEGER))return null;return {minor:Number(n/1000n),currency:value.currencyCode};}
/** Keep only UUID, displayed name, five displayed financial fields and window.
 * No photos, contact details, child earnings, trips, tokens or request query. */
export function projectUberEarningsEvidence({request,response,organizationId}={}){
 const v=request?.variables,data=response?.data?.getEarnerBreakdownsV2;
 if(!UUID.test(organizationId||'')||v?.supplierUuid?.toLowerCase()!==organizationId.toLowerCase()||v.driverList!==null||!data||response.errors?.length||!Array.isArray(data.earnerEarningsBreakdowns)||data.earnerEarningsBreakdowns.length>200)return null;
 const times=['startTimeUnixMillis','endTimeUnixMillis'].map(key=>v.timeRange?.[key]);if(times.some(value=>typeof value!=='string'||!/^\d{12,16}$/.test(value)))return null;const [start,end]=times.map(Number);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start>367*86400000)return null;
 const rows=[];let rejectedIdentity=0,rejectedMoney=0;
 for(const row of data.earnerEarningsBreakdowns){
  if(!UUID.test(row?.earnerUuid||'')||typeof row.earnerMetadata?.name!=='string'||!row.earnerMetadata.name.trim()||row.earnerMetadata.name.length>200||/[\u0000-\u001f\u007f]/.test(row.earnerMetadata.name)){rejectedIdentity++;continue;}
  const values=[row.earnings?.amount,row.reimbursements?.amount,row.adjustmentsFromPreviousPeriods?.amount,row.payouts?.amount,row.netOutstanding].map(amount);if(values.some(value=>!value)||new Set(values.map(value=>value.currency)).size!==1){rejectedMoney++;continue;}
  rows.push({providerDriverId:row.earnerUuid.toLowerCase(),driverName:normalizedName(row.earnerMetadata.name),currency:values[0].currency,metrics:Object.fromEntries(FIELDS.map((key,index)=>[key,values[index].minor]))});
 }
 return {organizationId:organizationId.toLowerCase(),start,end,rows,rejectedIdentity,rejectedMoney};
}
export function attachUberEarningsIdentities(snapshot,evidence=[]){
 const start=Date.parse(snapshot?.providerPeriod?.start_at),end=Date.parse(snapshot?.providerPeriod?.end_at),org=snapshot?.organizationId?.toLowerCase();
 const batches=evidence.filter(batch=>batch&&batch.organizationId===org&&Math.floor(batch.start/60000)*60000===start&&Math.floor(batch.end/60000)*60000===end),windows=new Set(batches.map(batch=>batch.start+':'+batch.end));
 if(windows.size!==1)return {snapshot,matched:0,observed:false};const rows=batches.flatMap(batch=>batch.rows);let matched=0;const diagnostics={incompleteNames:0,noExactName:0,financialMismatch:0,ambiguousIdentities:0,rejectedIdentity:batches.reduce((n,b)=>n+(b.rejectedIdentity||0),0),rejectedMoney:batches.reduce((n,b)=>n+(b.rejectedMoney||0),0)};
 const drivers=snapshot.drivers.map(driver=>{
  if(driver.providerDriverId)return driver;if(!driver.driverNameComplete){diagnostics.incompleteNames++;return driver;}
  const metrics={};try{for(const field of FIELDS){const minor=parseUberEarningsMoney(driver.metrics[field],snapshot.currency);if(minor===null)return driver;metrics[field]=minor;}}catch{return driver;}
  const named=rows.filter(row=>row.currency===snapshot.currency&&row.driverName===normalizedName(driver.driverName));const matches=new Set(named.filter(row=>FIELDS.every(field=>row.metrics[field]===metrics[field])).map(row=>row.providerDriverId));
  if(matches.size!==1){if(matches.size>1)diagnostics.ambiguousIdentities++;else if(named.length)diagnostics.financialMismatch++;else diagnostics.noExactName++;return driver;}matched++;return {...driver,providerDriverId:[...matches][0]};
 });return {snapshot:{...snapshot,providerPeriod:{...snapshot.providerPeriod,start_at:new Date(batches[0].start).toISOString(),end_at:new Date(batches[0].end).toISOString()},drivers},matched,observed:true,diagnostics};
}
export function observeUberEarningsEvidence({page,organizationId}={}){
 const batches=[],pending=new Set();let disposed=false,rateLimited=false;
 function responseSeen(response){
  const url=new URL(response.url());if(disposed||url.origin!=='https://fleethub.uber.com'||url.pathname!=='/graphql'||!['xhr','fetch'].includes(response.request().resourceType()))return;
  if(response.status()===429){rateLimited=true;return;}if(response.status()!==200)return;
  const work=(async()=>{try{const request=response.request().postDataJSON();if(request?.variables?.supplierUuid?.toLowerCase()!==organizationId.toLowerCase()||!request.variables.timeRange)return;const length=Number(await response.headerValue('content-length'));if(length>6*1024*1024)return;const bytes=await response.body();if(disposed||bytes.length>6*1024*1024)return;const projected=projectUberEarningsEvidence({request,response:JSON.parse(bytes.toString('utf8')),organizationId});if(projected&&batches.length<200)batches.push(projected);}catch{}})();pending.add(work);void work.finally(()=>pending.delete(work));
 }
 page.on('response',responseSeen);
 return {get rateLimited(){return rateLimited;},async attach(snapshot){await Promise.all([...pending]);return attachUberEarningsIdentities(snapshot,batches);},dispose(){disposed=true;page.off('response',responseSeen);batches.length=0;}};
}
