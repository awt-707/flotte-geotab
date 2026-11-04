import '../site/timezone.js';
import '../uber-extension/earnings-reader.js';
import {calculateUberEarnings} from './uber-earnings-calculation.mjs';
import {createHash} from 'node:crypto';
import {readUberCsv} from './uber-reports.mjs';

const reader=globalThis.LudyUberEarningsReader;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fail=(code,message)=>Object.assign(Error(message),{status:400,code});
export const UBER_EARNINGS_FIELDS=Object.freeze([...reader.FIELDS]);
export const parseUberEarningsMoney=reader.money;
export const parseUberEarningsPeriod=reader.period;
const fold=value=>String(value??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/\s*:\s*/g,':').replace(/\s+/g,' ').trim();

/** Decode only a driver-level financial export triggered from this same page.
 * Column names come from Uber's public Payment Based Reports documentation.
 * Organization balance exports and transaction exports have different scopes. */
export function readUberEarningsDriverExport(csv,pageSnapshot,{organizationId,now=Date.now()}={}){
 normalizeUberEarnings(pageSnapshot,{organizationId,now});
 const grid=readUberCsv(csv);if(grid.length>5001)throw fail('rows_limit','Export Earnings limité à 5 000 chauffeurs.');
 const named={id:['driver uuid','driver id','uuid du chauffeur'],name:['driver name','nom complet du chauffeur'],first:['driver first name','prenom du chauffeur'],last:['driver last name','driver surname','nom de famille du chauffeur','nom du chauffeur'],currency:['currency','currency code','devise'],organization:['organization uuid','organisation uuid']};
 const indices={};for(const [key,labels]of Object.entries(named)){const found=grid[0].map((label,index)=>labels.includes(fold(label))?index:-1).filter(index=>index>=0);if(found.length>1)throw fail('export_columns','Colonnes de l’export Earnings ambiguës.');indices[key]=found[0]??null;}
 const nested={'total earnings:net fare':'fare','total earnings:promotions':'bonus','total earnings:tip':'tips','total earnings:tips':'tips','payouts:cash collected':'cash','paid to you':'payout','paid to you:your earnings':'revenue','paid to you:trip balance:payouts:cash collected':'cash','paid to you:your earnings:fare':'fare'};
 const fields=grid[0].map(header=>nested[fold(header)]||reader.fieldFor(header));
 if(!fields.includes('revenue')||indices.name===null&&(indices.first===null||indices.last===null)||new Set(fields.filter(Boolean)).size!==fields.filter(Boolean).length)throw fail('export_columns','L’export doit être un relevé financier par chauffeur avec des colonnes non ambiguës.');
 const drivers=grid.slice(1).map(row=>{
  const value=index=>index===null?'':String(row[index]??'').trim();
  if(indices.organization!==null&&value(indices.organization).toLowerCase()!==organizationId.toLowerCase())throw fail('organization_mismatch','L’export Earnings contient une autre flotte.');
  if(indices.currency!==null&&value(indices.currency)!==pageSnapshot.currency)throw fail('currency_ambiguous','La devise de l’export diffère de la page Earnings.');
  const name=indices.name!==null?value(indices.name):[value(indices.first),value(indices.last)].filter(Boolean).join(' '),metrics={};
  for(let index=0;index<fields.length;index++)if(fields[index])metrics[fields[index]]=String(row[index]??'').trim();
  return {providerDriverId:value(indices.id)||null,driverName:name,driverNameComplete:!/(?:\.{2,}|…)$/.test(name),metrics};
 });
 if(pageSnapshot.coverage.driverRowsTotal!==null&&pageSnapshot.coverage.driverRowsTotal!==drivers.length)throw fail('export_coverage','L’export ne contient pas le nombre de chauffeurs annoncé dans Earnings.');
 const complete=pageSnapshot.coverage.filtered!==true;
 const snapshot={...pageSnapshot,drivers,coverage:{...pageSnapshot.coverage,complete,driverRowsObserved:drivers.length,driverRowsTotal:drivers.length,reason:complete?null:'Liste chauffeurs filtrée.'}};
 normalizeUberEarnings(snapshot,{organizationId,now});return snapshot;
}

/** Provider periods and account balances never become timestamped trip income.
 * The caller authorizes the collector and persists this immutable statement. */
export function normalizeUberEarnings(input,{organizationId,now=Date.now()}={}){
 if(!UUID.test(organizationId||'')||!input||input.version!==1||input.source!=='uber_fleet_earnings'||input.organizationId?.toLowerCase()!==organizationId.toLowerCase())throw fail('organization_mismatch','La flotte du relevé Earnings ne correspond pas à la configuration.');
 const source=reader.providerUrl(input.sourceUrl,organizationId),observed=Date.parse(input.observedAt);
 if(typeof input.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.observedAt)||!Number.isFinite(observed)||observed>now+60000||observed<now-15*60000)throw fail('observation_expired','Lecture Earnings périmée ou horodatage invalide.');
 const displayedPeriod=reader.period(input.providerPeriod?.label,{timeZone:input.providerPeriod?.time_zone||input.providerPeriod?.timeZone});
 const boundary=key=>{const raw=input.providerPeriod?.[key],value=Date.parse(raw),displayed=Date.parse(displayedPeriod[key]);if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)||!Number.isFinite(value)||value<displayed||value>=displayed+60000)throw fail('period_mismatch','Les bornes Earnings ne correspondent pas à la minute affichée.');return new Date(value).toISOString();};
 // UI labels omit seconds; a passively observed response can prove a more
 // precise boundary inside that displayed minute. Never round that evidence.
 const providerPeriod={...displayedPeriod,start_at:boundary('start_at'),end_at:boundary('end_at')};
 if(Date.parse(providerPeriod.end_at)>now+8*86400000||Date.parse(providerPeriod.end_at)<=Date.parse(providerPeriod.start_at))throw fail('period_mismatch','Les bornes Earnings ne correspondent pas à la période affichée.');
 const currency=input.currency;if(!/^[A-Z]{3}$/.test(currency||''))throw fail('currency_ambiguous','Devise Earnings explicite requise.');
 const normalizedMetrics=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!reader.FIELDS.includes(key)))throw fail('metrics_invalid','Colonnes Earnings non reconnues.');
  return Object.fromEntries(reader.FIELDS.map(field=>[field+'_minor',reader.money(value[field]??null,currency)]));
 };
 const withProof=(metrics,breakdown)=>{const normalized=normalizedMetrics(metrics);if(!breakdown)return {amounts:normalized,provenance:null};const entries=Array.isArray(breakdown.entries)?breakdown.entries.map(entry=>({field:entry?.field,label:entry?.label,minor:reader.money(entry?.amount??null,currency)})):[];return calculateUberEarnings(normalized,{complete:breakdown.complete===true,entries});};
 const resolvedFleet=withProof(input.fleet,input.fleetBreakdown),fleet=resolvedFleet.amounts,seen=new Set();
 if(!Array.isArray(input.drivers)||input.drivers.length>5000)throw fail('rows_limit','Nombre de chauffeurs Earnings invalide.');
 const drivers=input.drivers.map((row,index)=>{
  const provider_driver_id=row?.providerDriverId?.toLowerCase()||null;if(provider_driver_id&&!UUID.test(provider_driver_id))throw fail('driver_identity','Identifiant chauffeur Earnings invalide.');
  if(provider_driver_id&&seen.has(provider_driver_id))throw fail('driver_duplicate','Un chauffeur figure plusieurs fois dans le relevé Earnings.');if(provider_driver_id)seen.add(provider_driver_id);
  const driver_name=row?.driverName;if(typeof driver_name!=='string'||!driver_name.trim()||driver_name.length>200||/[\u0000-\u001f\u007f]/.test(driver_name))throw fail('driver_identity','Nom chauffeur Earnings invalide.');
  const resolved=withProof(row.metrics,row.breakdown);
  return {provider_driver_id,driver_name:driver_name.trim(),driver_name_complete:row.driverNameComplete===true&&!/(?:\.{2,}|…)$/.test(driver_name.trim()),provider_row:index,...resolved.amounts,financial_provenance:resolved.provenance};
 });
 const rawCoverage=input.coverage;
 if(!rawCoverage||typeof rawCoverage.complete!=='boolean'||rawCoverage.driverRowsObserved!==drivers.length||!Number.isInteger(rawCoverage.pages)||rawCoverage.pages<1||rawCoverage.pages>100||rawCoverage.driverRowsTotal!==null&&(!Number.isInteger(rawCoverage.driverRowsTotal)||rawCoverage.driverRowsTotal<drivers.length||rawCoverage.driverRowsTotal>5000))throw fail('coverage_invalid','Couverture du relevé Earnings incohérente.');
 if(rawCoverage.complete&&rawCoverage.driverRowsTotal!==null&&rawCoverage.driverRowsTotal!==drivers.length)throw fail('coverage_invalid','Le relevé Earnings ne couvre pas tous les chauffeurs annoncés.');
 if(rawCoverage.complete&&rawCoverage.filtered===true)throw fail('coverage_invalid','Un relevé Earnings filtré ne constitue pas la flotte complète.');
 const coverage={complete:rawCoverage.complete,filtered:rawCoverage.filtered===true,driver_rows_observed:drivers.length,driver_rows_total:rawCoverage.driverRowsTotal,pages:rawCoverage.pages,reason:rawCoverage.complete?null:'Lecture de la liste chauffeurs partielle ou filtrée.'};
 const value={version:1,source:'uber_fleet_earnings',organization_id:source.organizationId,source_url:source.url,observed_at:new Date(observed).toISOString(),provider_period:{...providerPeriod,mode:['settlement','custom'].includes(input.providerPeriod.mode)?input.providerPeriod.mode:'provider'},currency,fleet,fleet_provenance:resolvedFleet.provenance,drivers,coverage};
 // An idempotency key identifies this exact financial snapshot, not a bank transfer.
 const signature={...value};delete signature.observed_at;
 return {...value,sha256:createHash('sha256').update(JSON.stringify(signature)).digest('hex')};
}
