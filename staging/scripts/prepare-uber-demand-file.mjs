#!/usr/bin/env node
// Read-only local preview. This command has deliberately no apply mode.
import path from 'node:path';
import {constants} from 'node:fs';
import {open, mkdir, lstat, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readRuntime} from './guard.mjs';
import {LOCAL_DIR, API_URL, SITE_URL} from './paths.mjs';
import {readUberCsv, normalizeUberCsv, uberPickupCity} from '../server/uber-reports.mjs';
import {parseUberReportTime} from '../server/uber-report-time.mjs';
import {moroccoDay} from '../server/morocco-time.mjs';
import {normalizeDemandImport} from '../server/demand-analytics.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,code='preview_refused')=>Object.assign(Error(message),{code});
const fold=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();
const HEADERS={
 id:['uuid de la course','trip uuid','trip id'],
 time:['heure de la demande de course','heure de demande de course','trip request time'],
 pickup:['adresse de prise en charge','pickup address','pick up address'],
 status:['statut de la course','trip status'],
};
const statuses=['completed','rider_cancelled','driver_cancelled','delivery_failed'];

export function parsePreviewArgs(args){
 const result={};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--only-new'){if(result.onlyNew)throw fail('Option dupliquée.');result.onlyNew=true;continue;}
  const key={'--file':'file','--timezone':'timezone','--timezone-evidence':'timezoneEvidence'}[args[i]];
  if(!key||Object.hasOwn(result,key)||!args[i+1]||args[i+1].startsWith('--'))throw fail('Arguments invalides. Utiliser --file, puis éventuellement --timezone et --timezone-evidence.');
  result[key]=args[++i];
 }
 if(!path.isAbsolute(result.file||''))throw fail('Le chemin absolu du CSV est requis.');
 if(result.timezone&&!['UTC','Africa/Casablanca'].includes(result.timezone))throw fail('Seuls UTC et Africa/Casablanca sont pris en charge ; aucun autre fuseau ne sera deviné.');
 if(!!result.timezone!==!!result.timezoneEvidence||result.timezoneEvidence&&(result.timezoneEvidence.length<8||result.timezoneEvidence.length>500))throw fail('Un fuseau explicite exige une justification de confirmation (8 à 500 caractères).');
 return result;
}

export function confirmedCityMapping(settings,agencies){
 if(!settings||!['ymd','dmy','mdy'].includes(settings.date_format)||!settings.city_agencies||!Array.isArray(agencies))throw fail('Configuration locale des rapports invalide.');
 const mapping={};
 for(const [city,id] of Object.entries(settings.city_agencies)){
  const rows=agencies.filter(a=>String(a.id)===String(id));
  if(!['Casablanca','Marrakech'].includes(city)||!Number.isSafeInteger(id)||id<=0||rows.length!==1||fold(rows[0].city)!==fold(city))throw fail('Association ville / agence non confirmée dans la configuration locale.');
  mapping[city]=id;
 }
 if(!Object.keys(mapping).length)throw fail('Aucune ville associée à une agence dans la configuration locale.');
 return mapping;
}

export function inspectDemandCsv(csv){
 const grid=readUberCsv(csv),columns={};
 for(const [key,names] of Object.entries(HEADERS)){
  const indexes=grid[0].flatMap((h,i)=>names.includes(fold(h))?[i]:[]);
  if(indexes.length!==1)throw fail('Colonnes Trip Activity absentes ou ambiguës dans le contrôle manuel.');
  columns[key]=indexes[0];
 }
 const counts={received:grid.length-1,statuses:Object.fromEntries(statuses.map(s=>[s,0])),unrecognized_status:0,duplicate_trip_ids:0,invalid_trip_ids:0,invalid_timestamp:0};
 const cities={Casablanca:{completed:0,cancelled:0,excluded:0},Marrakech:{completed:0,cancelled:0,excluded:0},outside_or_unlocated:{completed:0,cancelled:0,excluded:0}};
 const ids=new Set(),times=[];
 for(const row of grid.slice(1)){
  const id=String(row[columns.id]||'').toLowerCase().trim(),status=String(row[columns.status]||'').trim();
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))counts.invalid_trip_ids++;
  else{if(ids.has(id))counts.duplicate_trip_ids++;ids.add(id);}
  if(statuses.includes(status))counts.statuses[status]++;else counts.unrecognized_status++;
  const time=String(row[columns.time]||'').trim();
  const parts=time.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:Z|[+-]\d{2}:?\d{2})?$/);
  // Calendar validation only: this UTC construction does not interpret the
  // source timestamp or assign a timezone to it.
  const values=parts?.slice(1).map(Number),calendar=values?new Date(Date.UTC(values[0],values[1]-1,values[2])):null;
  if(!values||calendar.getUTCFullYear()!==values[0]||calendar.getUTCMonth()+1!==values[1]||calendar.getUTCDate()!==values[2]||values[3]>23||values[4]>59||values[5]>59)counts.invalid_timestamp++;else times.push(time);
  const city=uberPickupCity(row[columns.pickup])||'outside_or_unlocated';
  cities[city][status==='completed'?'completed':['rider_cancelled','driver_cancelled'].includes(status)?'cancelled':'excluded']++;
 }
 times.sort();
 return {counts,cities,raw_bounds:{start:times[0]||null,end:times.at(-1)||null,timezone:'unconfirmed'},grid,columns};
}

export function prepareDemandPreview(csv,settings,agencies,{timezone,timezoneEvidence,now=Date.now()}={}){
 const mapping=confirmedCityMapping(settings,agencies),inspection=inspectDemandCsv(csv),sha=digest(csv);
 const report={version:1,mode:'read-only-preview',file_sha256:sha,file_bytes:Buffer.byteLength(csv),source:inspection.counts,cities:inspection.cities,raw_bounds:inspection.raw_bounds,city_agencies:mapping,settings_revision:settings.revision??null,global_csv_timezone:settings.csv_timezone??null,timezone:null,timezone_basis:null,ready:false,blockers:[],notes:['Les adresses sont traitées localement et réduites par publicPickupLabel ; aucun géocodage externe.','Les villes hors Casablanca/Marrakech et les statuts exclus ne participent pas aux métriques.','Les courses annulées sont conservées comme annulations, jamais comme courses terminées.']};
 if(inspection.counts.invalid_trip_ids||inspection.counts.invalid_timestamp||inspection.counts.unrecognized_status){report.blockers.push('invalid_source_rows');return {report,batches:[]};}
 const selected=timezone??settings.csv_timezone;
 if(!['UTC','Africa/Casablanca'].includes(selected)){report.blockers.push('timezone_required');return {report,batches:[]};}
 if(timezone&&(!timezoneEvidence||timezoneEvidence.length<8))throw fail('La confirmation du fuseau de ce fichier est requise.');
 report.timezone=selected;report.timezone_basis=timezone?'file_specific_confirmation':'existing_local_configuration';
 // Bounds are the actual observed instants, never dates inferred from a filename.
 const instants=inspection.grid.slice(1).map(row=>parseUberReportTime(row[inspection.columns.time],{csv_timezone:selected,date_format:settings.date_format,now})).sort();
 const period={start_date:moroccoDay(instants[0]),end_date:moroccoDay(instants.at(-1))};
 if(Date.parse(period.end_date)-Date.parse(period.start_date)>31*86400000)throw fail('Le contrôle manuel accepte au maximum 32 dates locales observées.');
 const normalized=normalizeUberCsv(csv,{...settings,city_agencies:mapping,csv_timezone:selected},{now,period});
 const batches=normalized.batches.map(batch=>({...batch,file_name:'Uber activité · import manuel '+sha.slice(0,12)+'.csv'}));
 report.period=period;report.bounds={start_at:instants[0],end_at:instants.at(-1),time_zone:'Africa/Casablanca'};report.normalized_counts=normalized.counts;
 report.batches=batches.map(batch=>({agency_id:batch.agency_id,city:batch.city,counts:batch.counts,fingerprint:batch.fingerprint}));
 if(!batches.length)report.blockers.push('no_supported_city_rows');
 return {report,batches};
}

export function compareExistingDemand(batches,existing){
 const byKey=new Map(),byExternal=new Map();
 for(const row of existing){const key=String(row.agency_id)+':'+row.ride_key;if(byKey.has(key))throw fail('Résultat local ambigu pour une course existante.');byKey.set(key,row);if(!byExternal.has(row.external_id))byExternal.set(row.external_id,new Set());byExternal.get(row.external_id).add(String(row.agency_id));}
 const result={new_rows:0,identical_rows:0,conflicting_rows:0};
 const perCity=batches.map(batch=>{
  const counts={agency_id:batch.agency_id,city:batch.city,new_rows:0,identical_rows:0,conflicting_rows:0};
  for(const row of batch.rows){
   const prior=byKey.get(String(batch.agency_id)+':'+row.ride_key);
   const otherAgency=[...(byExternal.get(row.external_id)||[])].some(id=>id!==String(batch.agency_id));
   const kind=otherAgency?'conflicting_rows':!prior?'new_rows':prior.external_id===row.external_id&&Date.parse(prior.started_at)===Date.parse(row.started_at)&&prior.pickup_zone===row.pickup_zone&&prior.status===row.status&&prior.city===batch.city?'identical_rows':'conflicting_rows';
   counts[kind]++;result[kind]++;
  }
  return counts;
 });
 return {...result,by_city:perCity};
}

export function newDemandBatches(batches,existing,{now=Date.now()}={}){
 const comparison=compareExistingDemand(batches,existing);
 if(comparison.conflicting_rows)throw fail('Conflit existant : aucun complément préparé.');
 const present=new Set(existing.map(row=>String(row.agency_id)+':'+row.ride_key));
 return batches.flatMap(batch=>{
  const rows=batch.rows.filter(row=>!present.has(String(batch.agency_id)+':'+row.ride_key));
  return rows.length?[normalizeDemandImport({...batch,rows,file_name:batch.file_name.replace('import manuel','complément vérifié'),date_format:'ymd'},{now})]:[];
 });
}

async function readRegular(filename,{privateFile=false,max=6*1024*1024}={}){
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>max||privateFile&&(stat.mode&0o777)!==0o600)throw fail('Fichier local absent, non privé ou de taille invalide.');return await handle.readFile();}finally{await handle.close();}
}
async function privateDirectory(directory){
 await mkdir(directory,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700)throw fail('Répertoire d’archive privée non sûr.');
}
async function privateWrite(filename,content){
 const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);
 let handle;
 try{handle=await open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(bytes);}
 catch(error){if(error.code!=='EEXIST')throw error;const existing=await readRegular(filename,{privateFile:true,max:10*1024*1024});if(!existing.equals(bytes))throw fail('Une archive différente existe déjà : aucun écrasement.');}
 finally{await handle?.close();}
}

export async function localPreviewClient({fetchFn=fetch}={}){
 async function request(url,{method='GET',body,headers={}}={}){
  const parsed=new URL(url);if(![API_URL,SITE_URL].includes(parsed.origin)||parsed.username||parsed.password)throw fail('Accès non local refusé.');
  const response=await fetchFn(url,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw fail('Lecture ou authentification locale refusée (HTTP '+response.status+').');return response.json();
 }
 const health=await request(SITE_URL+'/health');if(health.environment!=='staging'||health.project!=='ludy-staging')throw fail('Serveur local de staging non confirmé.');
 await readRegular(path.join(LOCAL_DIR,'runtime.json'),{privateFile:true,max:65536});
 const runtime=readRuntime(),credentials=JSON.parse(await readRegular(path.join(LOCAL_DIR,'credentials.json'),{privateFile:true,max:65536}));
 if(credentials.environment!=='staging-local-only'||credentials.siteUrl!==SITE_URL||!credentials.userId||typeof credentials.email!=='string'||typeof credentials.password!=='string')throw fail('Identité administrateur locale non confirmée.');
 const auth=await request(API_URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:runtime.anonKey},body:{email:credentials.email,password:credentials.password}});
 if(auth.user?.id!==credentials.userId||typeof auth.access_token!=='string')throw fail('Session locale incohérente.');
 const headers={apikey:runtime.anonKey,Authorization:'Bearer '+auth.access_token};
 const read=(table,params)=>request(API_URL+'/rest/v1/'+table+'?'+new URLSearchParams(params),{headers});
 const profiles=await read('profiles',{user_id:'eq.'+auth.user.id,select:'role'});
 if(profiles.length!==1||profiles[0].role!=='admin')throw fail('Administrateur local requis.');
 // This configuration table is server-only; use the existing authenticated
 // admin route, never the service key or a new direct table privilege.
 const [configuration,agencies]=await Promise.all([request(SITE_URL+'/api/uber-reports/settings',{headers:{...headers,Origin:SITE_URL}}),read('agencies',{select:'id,city',order:'id',limit:'1000'})]);
 if(!configuration.settings||agencies.length>=1000)throw fail('Configuration locale incomplète.');
 const settings=Object.fromEntries(['city_agencies','date_format','csv_timezone','revision'].map(key=>[key,configuration.settings[key]]));
 return {settings,agencies,async existing(agencyIds){
  const rows=[];
  for(const agencyId of agencyIds)for(let offset=0;;offset+=1000){
   const page=await read('ops_demand_rides',{agency_id:'eq.'+agencyId,select:'agency_id,ride_key,external_id,started_at,pickup_zone,status,city',order:'ride_key',offset:String(offset),limit:'1000'});
   if(!Array.isArray(page)||page.length>1000)throw fail('Lecture locale incomplète.');rows.push(...page);
   if(rows.length>50000)throw fail('Plus de 50 000 lignes locales : contrôle manuel requis.');if(page.length<1000)break;
  }
  return rows;
 }};
}

export async function main(args=process.argv.slice(2)){
 const options=parsePreviewArgs(args),bytes=await readRegular(options.file),csv=bytes.toString('utf8');
 if(!Buffer.from(csv).equals(bytes))throw fail('Le CSV doit être un fichier UTF-8 valide.');
 const client=await localPreviewClient(),prepared=prepareDemandPreview(csv,client.settings,client.agencies,options);
 const {report}=prepared;let {batches}=prepared;
 if(batches.length){
  const existing=await client.existing([...new Set(batches.map(b=>b.agency_id))]);report.existing=compareExistingDemand(batches,existing);
  if(report.existing.conflicting_rows)report.blockers.push('existing_rows_conflict');
  else if(options.onlyNew){
   report.source_batches=report.batches;batches=newDemandBatches(batches,existing);report.plan_mode='new_rows_only';
   report.batches=batches.map(batch=>({agency_id:batch.agency_id,city:batch.city,counts:batch.counts,fingerprint:batch.fingerprint}));
   report.planned_new_rows=batches.reduce((sum,batch)=>sum+batch.rows.length,0);report.untouched_existing_rows=report.existing.identical_rows;
  }
 }
 report.ready=report.blockers.length===0;report.review_id=digest(JSON.stringify(report));
 const root=path.join(LOCAL_DIR,'uber-reports');await privateDirectory(LOCAL_DIR);await privateDirectory(root);
 const manual=path.join(root,'manual-imports');await privateDirectory(manual);const directory=path.join(manual,report.file_sha256);await privateDirectory(directory);
 await privateWrite(path.join(directory,'original.csv'),bytes);
 await privateWrite(path.join(directory,'review-'+report.review_id+'.json'),JSON.stringify(report,null,2)+'\n');
 if(report.ready)await privateWrite(path.join(directory,'plan-'+report.review_id+'.json'),JSON.stringify({version:1,review_id:report.review_id,file_sha256:report.file_sha256,timezone:report.timezone,timezone_evidence:options.timezoneEvidence||'existing_local_configuration',plan_mode:report.plan_mode||'full_source',expected_existing:report.existing,batches},null,2)+'\n');
 console.log(JSON.stringify({...report,private_archive:path.relative(path.dirname(LOCAL_DIR),directory),database_writes:0},null,2));
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({ok:false,code:error.code||'preview_refused',message:error.code&&['preview_refused','timezone_required'].includes(error.code)?error.message:'Contrôle arrêté ; aucune écriture des données de courses.'}));process.exitCode=1;});
