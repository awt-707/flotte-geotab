import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertLocalProject} from './guard.mjs';
import {LOCAL_DIR} from './paths.mjs';
import {LOCAL_GUARD,dockerArgs} from './import-reference.mjs';
import {readUberCsv,publicPickupLabel} from '../server/uber-reports.mjs';
import {normalizeDemandImport,analyzeDemand} from '../server/demand-analytics.mjs';
import {createDemandCityReview,demandReviewIdentity,demandReviewSignature,validateDemandCityReview} from '../server/demand-city-review.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function read(filename,{privateFile=false}={}){
 if(!path.isAbsolute(filename))throw Error('Absolute path required.');
 const handle=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(handle);if(!st.isFile()||st.size>32*1024*1024||privateFile&&(st.mode&0o777)!==0o600)throw Error('Input file invalid.');return fs.readFileSync(handle,'utf8');}finally{fs.closeSync(handle);}
}
/** Every decision must match both the original normalized CSV row and the
 * current DB row. The routine cannot approve a whole name/address category. */
export function prepareDemandCityReview(csv,decisions,existing,{now=Date.now()}={}){
 if(decisions?.version!==1||decisions.source_sha256!==sha(csv)||decisions.timezone!=='Africa/Casablanca'||!decisions.timezone_evidence||!Number.isSafeInteger(decisions.agency_id)||!['Casablanca','Marrakech'].includes(decisions.city)||!Array.isArray(decisions.entries)||!decisions.entries.length||decisions.entries.length>20000)throw Error('Review decisions invalid.');
 const grid=readUberCsv(csv),header=grid.shift(),names=['UUID de la course','Heure de la demande de course','Adresse de prise en charge','Statut de la course'];
 if(names.some(n=>header.filter(v=>v===n).length!==1)||grid.length>20000)throw Error('Source columns invalid.');
 const [idAt,timeAt,addressAt,statusAt]=names.map(n=>header.indexOf(n)),source=new Map();
 for(const row of grid){if(source.has(row[idAt]))throw Error('Duplicate source identity.');source.set(row[idAt],row);}
 const db=new Map();for(const row of existing){const key=row.agency_id+':'+row.external_id;if(db.has(key))throw Error('Duplicate local identity.');db.set(key,row);}
 const entries=[],originals=[],seen=new Set();
 for(const decision of decisions.entries){
  if(seen.has(decision.external_id))throw Error('Duplicate review identity.');seen.add(decision.external_id);
  const raw=source.get(decision.external_id);if(!raw||!['completed','rider_cancelled','driver_cancelled'].includes(raw[statusAt]))throw Error('Source row unavailable.');
  const normalized=normalizeDemandImport({agency_id:decisions.agency_id,city:decisions.city,file_name:'private-city-review.csv',rows:[{external_id:decision.external_id,started_at:raw[timeAt],pickup_zone:publicPickupLabel(raw[addressAt]),status:raw[statusAt]==='completed'?'completed':'cancelled'}]},{now});
  const expected={...normalized.rows[0],agency_id:decisions.agency_id,city:decisions.city},current=db.get(decisions.agency_id+':'+decision.external_id);
  if(!current||demandReviewSignature(current)!==demandReviewSignature(expected))throw Error('Existing source conflict; no plan emitted.');
  entries.push({agency_id:decisions.agency_id,ride_key:demandReviewIdentity(current),signature:demandReviewSignature(current),decision:decision.decision,basis:decision.basis,evidence:decision.evidence||[]});originals.push(current);
 }
 const plan=validateDemandCityReview({version:1,reviewed_at:new Date(now).toISOString(),source_sha256:decisions.source_sha256,entries});
 const review=createDemandCityReview(plan),summaries={};
 for(const city of ['Casablanca','Marrakech']){const report=analyzeDemand(existing,{city,now,cityReview:review});summaries[city]={stored:report.coverage.report_rows,analyzed:report.total,completed:report.completed,cancelled:report.cancelled,cityReview:report.coverage.city_review};}
 return {plan,originals,report:{databaseWrites:0,externalRequests:0,sourceRows:grid.length,decisions:entries.length,confirmed:entries.filter(e=>e.decision==='confirmed').length,quarantined:entries.filter(e=>e.decision==='quarantined').length,summaries}};
}
function writePrivate(filename,value){const handle=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(handle,JSON.stringify(value,null,2)+'\n');}finally{fs.closeSync(handle);}}
export function main(args=process.argv.slice(2)){
 assertLocalProject();const opts={};for(let i=0;i<args.length;i++){if(!['--csv','--decisions'].includes(args[i])||opts[args[i]]||!args[i+1])throw Error('Use --csv PATH --decisions PRIVATE_PATH.');opts[args[i]]=args[++i];}
 if(!opts['--csv']||!opts['--decisions'])throw Error('Both paths required.');
 const csv=read(opts['--csv']),decisions=JSON.parse(read(opts['--decisions'],{privateFile:true}));
 const sql=`begin isolation level repeatable read read only; set local statement_timeout='15s'; set local lock_timeout='2s'; ${LOCAL_GUARD}\nselect coalesce(jsonb_agg(t),'[]'::jsonb) from (select agency_id,ride_key,external_id,started_at,pickup_zone,status,city from public.ops_demand_rides order by agency_id,ride_key limit 20001) t; rollback;`;
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
 const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{env,input:sql,encoding:'utf8',timeout:20000,maxBuffer:16*1024*1024});
 if(result.error||result.status!==0)throw Error('Local read-only inventory unavailable.');
 const existing=JSON.parse(result.stdout.trim());if(!Array.isArray(existing)||existing.length>20000)throw Error('Inventory limit exceeded.');
 const prepared=prepareDemandCityReview(csv,decisions,existing),directory=path.join(LOCAL_DIR,'pickup-reference-validation','city-review-'+Date.now());
 fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
 writePrivate(path.join(directory,'plan.json'),prepared.plan);writePrivate(path.join(directory,'original-rows.private.json'),prepared.originals);writePrivate(path.join(directory,'report.json'),prepared.report);
 const previous=path.join(LOCAL_DIR,'demand-city-review.json');if(fs.existsSync(previous))writePrivate(path.join(directory,'previous-plan.private.json'),JSON.parse(read(previous,{privateFile:true})));
 console.log(JSON.stringify({directory,planSha256:sha(fs.readFileSync(path.join(directory,'plan.json'))),...prepared.report},null,2));return {directory,...prepared};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{main();}catch{console.error('Préparation interrompue : vérifier les preuves privées et la concordance avec les lignes locales. Aucune écriture de base.');process.exitCode=1;}}
