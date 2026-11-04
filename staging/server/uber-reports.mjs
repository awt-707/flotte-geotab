import {resolveBackendTarget} from './database-target.mjs';
import {readLocalJson} from './local-json.mjs';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
import {assertLocalSupabase,requestAllowed} from './fleet.mjs';
import {normalizeDemandImport} from './demand-analytics.mjs';
import {normalizeUberDriverReport} from './uber-driver-reports.mjs';
import {parseUberReportTime} from './uber-report-time.mjs';
import {moroccoDay,moroccoParts} from './morocco-time.mjs';
import {uberPickupCity} from './uber-pickup-city.mjs';
export {uberPickupCity} from './uber-pickup-city.mjs';

const MAX_CSV=6*1024*1024,MAX_BODY=8*1024*1024,DAY=86400000;
const localDay=moroccoDay;
const fail=(status,message)=>Object.assign(Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const COLLECTOR_STATUSES=new Set(['stopped','starting','waiting','waiting_page','waiting_report','retrying','ready','action_required']);
const REPORT_TYPES=['trip_activity','driver_activity','driver_quality'];
const COLLECTOR_DIAGNOSTICS=new Set(['session_required','form_unrecognized','control_unrecognized','organization_required','organization_mismatch','dates_readonly','download_link_missing','download_host','form_timeout','generation_verification']);
function normalizeReportStructure(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||!['dialog','drawer','document'].includes(input.scope))return null;
 const count=value=>Number.isInteger(value)&&value>=0&&value<=20?value:0;
 const list=(value,allowed,max)=>Array.isArray(value)?[...new Set(value.filter(item=>allowed.includes(item)))].slice(0,max):[];
 const names=['report_type','start_date','end_date','start_time','end_time','organization'],seen=new Set();
 const fields=(Array.isArray(input.fields)?input.fields:[]).slice(0,6).flatMap(row=>{
  if(!row||!names.includes(row.field)||seen.has(row.field))return [];seen.add(row.field);
  return [{field:row.field,labels:count(row.labels),tags:list(row.tags,['INPUT','SELECT','BUTTON','DIV','SPAN','LABEL','TEXTAREA','OPTION'],8),roles:list(row.roles,['combobox','button','listbox','option','checkbox','textbox'],6),inputs:list(row.inputs,['text','date','time','checkbox','other'],5),readonly:count(row.readonly),values:list(row.values,['empty','date_ymd','time','report_type','other'],5)}];
 });
 const clean={scope:input.scope,matches:Object.fromEntries(['report_type','start_date','end_date','generate','organization'].map(key=>[key,count(input.matches?.[key])])),fields};
 return Buffer.byteLength(JSON.stringify(clean))<=2000?clean:null;
}
export function normalizeUberCollector(input,config,{now=Date.now()}={}){
 if(!input||typeof input!=='object'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.version||'')||!uuid(input.collectorId)||typeof input.active!=='boolean'||!COLLECTOR_STATUSES.has(input.status)||!Array.isArray(input.reports)||input.reports.length>3)throw fail(400,'État du collecteur invalide');
 if(input.organizationId!=null&&(!uuid(input.organizationId)||input.organizationId.toLowerCase()!==config.organization_id))throw fail(409,'La flotte du collecteur a changé');
 const date=(value,future=false)=>{if(value==null)return null;const at=Date.parse(value);if(typeof value!=='string'||!Number.isFinite(at)||at<now-90*DAY||at>now+(future?7*DAY:60000))throw fail(400,'Horodatage du collecteur invalide');return new Date(at).toISOString();};
 const seen=new Set(),reports=input.reports.map(row=>{if(!row||!REPORT_TYPES.includes(row.report_type)||seen.has(row.report_type)||!COLLECTOR_STATUSES.has(row.status))throw fail(400,'État de rapport invalide');seen.add(row.report_type);const diagnostic=['action_required','retrying'].includes(row.status)&&COLLECTOR_DIAGNOSTICS.has(row.diagnostic)?row.diagnostic:null;return {report_type:row.report_type,status:row.status,last_import_at:date(row.last_import_at),next_attempt_at:date(row.next_attempt_at,true),diagnostic,structure:diagnostic&&['action_required','retrying'].includes(row.status)?normalizeReportStructure(row.structure):null};});
 return {version:input.version,collector_id:input.collectorId.toLowerCase(),organization_id:input.organizationId?.toLowerCase()||null,active:input.active,status:input.status,next_attempt_at:date(input.nextAttemptAt,true),reports};
}
const fold=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[_’'—–-]/g,' ').replace(/\s+/g,' ').trim();
const aliases={external_id:['trip uuid','trip id','uuid de la course','id de la course','identifiant de la course'],started_at:['trip request time','heure de demande de course','heure de la demande de course','heure de demande','date et heure de la demande','date de demande de course','date et heure de demande de course'],pickup_zone:['pickup address','pick up address','adresse de prise en charge','adresse de depart','lieu de prise en charge'],status:['trip status','statut de la course','etat de la course','statut course']};
// https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/performance-based-reports-fleet
// Header names are matched, never column positions. Unsupported translations fail closed.
function csvStructure(input){
 let text=input.replace(/^\ufeff/,'');let delimiter;
 const declared=text.match(/^sep=([,;\t])\r?\n/i);if(declared){delimiter=declared[1];text=text.slice(declared[0].length);}
 if(!delimiter){const counts={',':0,';':0,'\t':0};let quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){i++;continue;}quoted=!quoted;}if(!quoted&&(c==='\r'||c==='\n'))break;if(!quoted&&Object.hasOwn(counts,c))counts[c]++;}const choices=Object.entries(counts).sort((a,b)=>b[1]-a[1]);if(!choices[0][1]||choices[0][1]===choices[1][1])throw fail(400,'Séparateur CSV non reconnu');delimiter=choices[0][0];}
 let quoted=false,closed=false,start=true,columns=1,expected=null,rows=0,nonblank=false;
 const finish=()=>{if(nonblank){if(expected===null)expected=columns;else if(columns!==expected)throw fail(400,'Colonnes CSV incohérentes');rows++;if(rows>20001||columns>200)throw fail(413,'Rapport limité à 20 000 courses et 200 colonnes');}columns=1;start=true;closed=false;nonblank=false;};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){i++;continue;}quoted=false;closed=true;}continue;}
  if(c==='\r'||c==='\n'){finish();if(c==='\r'&&text[i+1]==='\n')i++;continue;}
  if(c===delimiter){columns++;start=true;closed=false;nonblank=true;continue;}
  if(c==='"'){if(!start||closed)throw fail(400,'Guillemets CSV invalides');quoted=true;start=false;nonblank=true;continue;}
  if(closed&&!/\s/.test(c))throw fail(400,'Guillemets CSV invalides');if(!/\s/.test(c)){start=false;nonblank=true;}
 }
 if(quoted)throw fail(400,'Rapport CSV incomplet');finish();if(rows<1)throw fail(400,'Rapport CSV vide');return {text,delimiter,rows};
}
export function publicPickupLabel(address){
 const clean=String(address||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'').replace(/[+-]?\d{1,3}\.\d{3,}/g,'').replace(/(?:\+?\d[\s().-]*){9,}/g,'');
 return clean.split(',').map(part=>part.trim()).filter(part=>part&&!/^(?:app(?:artement)?|apt|etage|étage|floor|unit|porte|lot|residence|résidence)\b/i.test(part))
  .map(part=>part.replace(/^(?:(?:n[°o.]|numero|numéro)\s*)?\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?\s*[,.:;/-]?\s*/i,'').replace(/\b(?:app(?:artement)?|apt|etage|étage|floor|unit|porte)\s*\d+\b.*$/i,'').trim())
  .filter(Boolean).join(', ').replace(/\s+/g,' ').slice(0,160);
}
function reportStatus(value){const text=fold(value);if(['completed','complete','finished','terminee','termine','effectuee','effectue'].includes(text))return 'completed';if(['cancelled','canceled','rider cancelled','rider canceled','driver cancelled','driver canceled','annulee','annule','annulee par le passager','annulee par le chauffeur'].includes(text))return 'cancelled';if(['reserved','failed','delivery failed','payment failed','fare split','in progress','requested','accepted','en cours','reservee','echec'].includes(text))return 'excluded';throw fail(400,'Statut de course non reconnu dans le rapport Uber');}
export function readUberCsv(csv){
 if(typeof csv!=='string'||!csv.trim()||Buffer.byteLength(csv)>MAX_CSV||csv.includes('\0'))throw fail(400,'Rapport CSV absent ou trop volumineux');
 const structure=csvStructure(csv);let grid;try{const workbook=XLSX.read(structure.text,{type:'string',raw:true,FS:structure.delimiter,sheetRows:20002});if(workbook.SheetNames.length!==1)throw Error();grid=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,raw:true,defval:'',blankrows:false});}catch{throw fail(400,'Rapport CSV non reconnu');}
 if(grid.length!==structure.rows)throw fail(400,'Lecture CSV incomplète');
 return grid;
}
export function normalizeUberCsv(csv,config,{now=Date.now(),period=uberReportPeriod(now),allowedTripIds=null}={}){
 const grid=readUberCsv(csv);
 const columns={};for(const [field,names]of Object.entries(aliases)){const indexes=grid[0].map((value,index)=>names.includes(fold(value))?index:-1).filter(index=>index>=0);if(indexes.length!==1)throw fail(400,'Colonnes du rapport activité Uber manquantes ou ambiguës');columns[field]=indexes[0];}
 const byCity={Casablanca:[],Marrakech:[]},identityCities=new Map(),counts={received:grid.length-1,completed:0,cancelled:0,excluded_status:0,unlocated_city:0,unconfigured_city:0,missing_cancelled_pickup:0,imported:0,duplicates:0};
 for(const row of grid.slice(1)){
  if(allowedTripIds&&!allowedTripIds.has(String(row[columns.external_id]||'').trim().toLowerCase()))continue;
  const status=reportStatus(row[columns.status]);if(status==='excluded'){counts.excluded_status++;continue;}
  const address=String(row[columns.pickup_zone]||'');if(!address.trim()&&status==='cancelled'){counts.missing_cancelled_pickup++;continue;}
  if(!address.trim())throw fail(400,'Adresse de prise en charge manquante pour une course terminée');
  const city=uberPickupCity(address);if(!city){counts.unlocated_city++;continue;}if(!config.city_agencies?.[city]){counts.unconfigured_city++;continue;}
  const external_id=String(row[columns.external_id]||'').trim().toLowerCase();if(!uuid(external_id))throw fail(400,'Identifiant de course Uber absent ou non reconnu');
  if(identityCities.has(external_id.toLowerCase())&&identityCities.get(external_id.toLowerCase())!==city)throw fail(400,'Une course Uber porte deux villes contradictoires');identityCities.set(external_id.toLowerCase(),city);
  const pickup_zone=publicPickupLabel(address);if(!pickup_zone)throw fail(400,'Lieu de prise en charge non exploitable');
  byCity[city].push({external_id,started_at:parseUberReportTime(row[columns.started_at],{date_format:config.date_format,csv_timezone:config.csv_timezone,now}),pickup_zone,status});
 }
 const expected=period,batches=[];for(const [city,rows]of Object.entries(byCity)){if(!rows.length)continue;const batch=normalizeDemandImport({agency_id:config.city_agencies[city],city,file_name:'Uber activité · collecte automatique.csv',rows,date_format:config.date_format,date_system:'1900'},{now});
  if(batch.rows.some(row=>{const date=localDay(row.started_at);return date<expected.start_date||date>expected.end_date;}))throw fail(400,`Rapport hors période : les courses doivent appartenir au ${expected.start_date} – ${expected.end_date}, heure du Maroc.`);
  batches.push(batch);counts.completed+=batch.counts.completed;counts.cancelled+=batch.counts.cancelled;counts.duplicates+=batch.counts.duplicates;counts.imported+=batch.rows.length;}
 return {batches,counts,file_sha256:hash(csv)};
}
export function uberReportPeriod(now=Date.now()){
 const p=moroccoParts(now);
 const day=Date.UTC(p.year,p.month-1,p.day);return {start_date:new Date(day-7*DAY).toISOString().slice(0,10),end_date:new Date(day-DAY).toISOString().slice(0,10)};
}
export function validatedUberImportPeriod(input,at,{allowPrevious=false}={}){
 const expected=uberReportPeriod(at);if(input.startDate==null&&input.endDate==null&&input.reportType==='trip_activity')return expected;
 for(let lag=0;lag<=(allowPrevious?1:0);lag++){const period=Object.fromEntries(Object.entries(expected).map(([key,date])=>[key,new Date(Date.parse(date)-lag*DAY).toISOString().slice(0,10)]));if(input.startDate===period.start_date&&input.endDate===period.end_date)return period;}
 throw fail(400,'La période du rapport doit couvrir les sept journées demandées, ou leur décalage autorisé d’une journée complète.');
}
export function assertUberReportSource(value,organization){let url;try{url=new URL(value);}catch{throw fail(400,'Page Uber Reports invalide');}if(url.protocol!=='https:'||url.hostname!=='fleethub.uber.com'||url.port||url.username||url.password||url.search||url.hash||!new RegExp('^/orgs/'+organization+'/(?:reports|reporting)(?:/|$)','i').test(url.pathname))throw fail(400,'La page Rapports ne correspond pas à la flotte configurée');return url.pathname;}

export function createUberReportsApi({supabaseUrl,databaseTarget,anonKey,serviceKey,authorizePair,reportFiles=null,browserLease=null,fetchFn=fetch,now=Date.now}){
 const base=resolveBackendTarget(supabaseUrl,databaseTarget);if(typeof authorizePair!=='function')throw Error('Validation de la liaison Uber requise');let queue=Promise.resolve();const serial=work=>{const next=queue.then(work);queue=next.catch(()=>{});return next;};
 async function db(table,{method='GET',params={},body,token=serviceKey}={}){const response=await fetchFn(base+'/rest/v1/'+table+'?'+new URLSearchParams(params),{method,headers:{apikey:token===serviceKey?serviceKey:anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw fail(502,'Synchronisation locale des rapports indisponible');return readLocalJson(response);}
 async function admin(req){const token=String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];if(!token)throw fail(401,'Connexion administrateur requise');const response=await fetchFn(base+'/auth/v1/user',{headers:{apikey:anonKey,Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw fail(401,'Session expirée');const user=await response.json();if(!user.id)throw fail(401,'Session invalide');const profiles=await db('profiles',{token,params:{user_id:'eq.'+user.id,select:'role'}});if(profiles?.[0]?.role!=='admin')throw fail(403,'Administrateur requis');return {token,user};}
 async function readBody(req,max=65536){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>max)throw fail(413,'Rapport trop volumineux');chunks.push(c);}try{const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw fail(400,'Requête invalide');}}
 const settings=async()=>{const rows=await db('uber_report_settings',{params:{id:'eq.1'}});if(!rows?.[0])throw fail(503,'Réglages des rapports non installés');return rows[0];};
 const bridgeConfig=s=>({enabled:s.enabled,organization_id:s.organization_id,organization_label:s.organization_label||null,city_agencies:s.city_agencies,date_format:s.date_format,report_type:'trip_activity',report_types:REPORT_TYPES,...uberReportPeriod(now()),interval_seconds:21600,recommended_extension_version:'0.6.6'});
 const requireExtensionCollector=async()=>{if(await browserLease?.current())throw fail(409,'Le navigateur local Ludy prend en charge les rapports. Arrêtez les rapports dans l’extension ; la Live Map peut continuer.');};
 async function importReport(input,{allowPrevious=false}={}){
  const config=await settings();if(!config.enabled)throw fail(409,'Collecte automatique des rapports désactivée');
  if(!REPORT_TYPES.includes(input.reportType)||!uuid(input.organizationId)||input.organizationId.toLowerCase()!==config.organization_id)throw fail(400,'Rapport ou organisation Uber non autorisé');assertUberReportSource(input.sourceUrl,config.organization_id);
  if(typeof input.filename!=='string'||input.filename.length>200||!input.filename.toLowerCase().endsWith('.csv'))throw fail(400,'Export CSV Uber requis');
  await db('uber_report_settings',{method:'PATCH',params:{id:'eq.1'},body:{last_attempt_at:new Date(now()).toISOString()}});
  let stored=null;
  try{
   const at=now(),period=validatedUberImportPeriod(input,at,{allowPrevious}),expected=uberReportPeriod(at),lag=Math.round((Date.parse(expected.end_date)-Date.parse(period.end_date))/DAY);
   const grid=readUberCsv(input.csv);
   if(reportFiles)stored=await reportFiles.persistReport({organizationId:config.organization_id,reportType:input.reportType,period,csv:input.csv});
   if(input.reportType==='trip_activity'&&!['UTC','Africa/Casablanca'].includes(config.csv_timezone))throw Object.assign(fail(400,'CSV conservé : confirmez le fuseau horaire des horodatages Uber dans les réglages avant de l’analyser.'),{code:'timezone_required'});
   const driver=normalizeUberDriverReport(grid,input.reportType,config,{period,now:at,allowBoundaryExclusions:true}),normalized=input.reportType==='trip_activity'?normalizeUberCsv(input.csv,config,{now:at,period,allowedTripIds:new Set(driver.rows.map(row=>row.external_id))}):{batches:[],counts:{received:grid.length-1,imported:0},file_sha256:hash(input.csv)};
   const result=await db('rpc/uber_driver_report_commit',{method:'POST',body:{p_org:config.organization_id,p_revision:config.revision,p_hash:normalized.file_sha256,p_type:input.reportType,p_batches:normalized.batches,p_rows:driver.rows,p_counts:{...normalized.counts,...driver.counts,csv_timezone:config.csv_timezone||null,report_start_date:period.start_date,report_end_date:period.end_date,period_lag_days:lag},p_from:driver.period.from_at,p_to:driver.period.to_at}});
   if(!stored)return result;
   let receipt;try{receipt=await reportFiles.markImported(stored.token);}catch{return {...result,local_file:{stored:true,status:'pending',file:stored.receipt.file},archive_warning:'Données importées ; le reçu du fichier local reste à mettre à jour.'};}
   return {...result,local_file:{stored:true,status:receipt.status,file:receipt.file}};
  }catch(error){
   if(stored){let receipt;try{receipt=await reportFiles.markFailed(stored.token);}catch{}error.localFile={stored:true,status:receipt?.status||'pending',file:stored.receipt.file};}
   await db('uber_report_settings',{method:'PATCH',params:{id:'eq.1'},body:{last_status:'error',last_error:error.status&&error.status<500?error.message:'Import local interrompu ; aucun résultat partiel validé.'}}).catch(()=>{});throw error;
  }
 }
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 return async(req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1:4173').pathname;if(!path.startsWith('/api/uber-reports/'))return false;
  try{
   const bridge=path.startsWith('/api/uber-reports/bridge/');if(!requestAllowed(req,bridge))throw fail(403,'Origine refusée');
   if(bridge&&req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Max-Age','300');}
   if(req.method==='OPTIONS'){if(!bridge)throw fail(405,'Méthode non autorisée');res.writeHead(204);res.end();return true;}
   if(bridge){if(!/^Bearer ludy_uber_[A-Za-z0-9_-]{43}$/.test(String(req.headers.authorization||'')))throw fail(401,'Code de liaison Uber requis');await authorizePair(req);
    if(path==='/api/uber-reports/bridge/config'&&req.method==='GET'){await requireExtensionCollector();send(res,200,bridgeConfig(await settings()));return true;}
    if(path==='/api/uber-reports/bridge/status'&&req.method==='POST'){
     const input=await readBody(req,8192);await serial(async()=>{await requireExtensionCollector();const config=await settings(),state=normalizeUberCollector(input,config,{now:now()});
      await db('uber_report_settings',{method:'PATCH',params:{id:'eq.1'},body:{collector_seen_at:new Date(now()).toISOString(),collector_state:state}});
     });send(res,200,{ok:true});return true;
    }
    if(path==='/api/uber-reports/bridge/ingest'&&req.method==='POST'){
     const input=await readBody(req,MAX_BODY);const result=await serial(async()=>{await requireExtensionCollector();return importReport(input);});send(res,200,{ok:true,...result});return true;
    }
    throw fail(404,'Route rapport inconnue');
   }
   const a=await admin(req);
   if(path.startsWith('/api/uber-reports/browser/')){
    if(!browserLease||!reportFiles)throw fail(503,'Collecteur local de rapports non installé');
    if(path==='/api/uber-reports/browser/config'&&req.method==='GET'){
     const collectorId=new URL(req.url,'http://127.0.0.1:4173').searchParams.get('collectorId');await browserLease.assertOwner({collectorId,userId:a.user.id});send(res,200,bridgeConfig(await settings()));return true;
    }
    if(req.method!=='POST')throw fail(405,'Méthode non autorisée');
    const input=await readBody(req,path.endsWith('/ingest')?MAX_BODY:1024),owner={collectorId:input.collectorId,userId:a.user.id};
    if(path==='/api/uber-reports/browser/claim'){
     const result=await serial(async()=>{const config=await settings();if(!config.enabled)throw fail(409,'Activez d’abord les rapports automatiques dans Ludy');return browserLease.claim(owner);});send(res,200,{ok:true,expires_at:result.expiresAt});return true;
    }
    if(path==='/api/uber-reports/browser/heartbeat'){
     await browserLease.assertOwner(owner);if(!(await settings()).enabled){await browserLease.release(owner);throw fail(409,'Collecte automatique des rapports désactivée');}
     const result=await browserLease.heartbeat(owner);send(res,200,{ok:true,expires_at:result.expiresAt});return true;
    }
    if(path==='/api/uber-reports/browser/release'){send(res,200,{ok:true,...await serial(()=>browserLease.release(owner))});return true;}
    if(path==='/api/uber-reports/browser/ingest'){
     const result=await serial(async()=>{await browserLease.assertOwner(owner);return importReport(input,{allowPrevious:true});});send(res,200,{ok:true,...result});return true;
    }
    throw fail(404,'Route du collecteur local inconnue');
   }
   if(path==='/api/uber-reports/settings'&&req.method==='GET'){
    const [config,agencies,identities,journal]=await Promise.all([settings(),db('agencies',{token:a.token,params:{select:'id,name,city',order:'name'}}),db('fleet_identities',{token:a.token,params:{source:'eq.uber',select:'organization_id',limit:'1000'}}),db('uber_driver_report_imports',{params:{order:'last_received_at.desc',limit:'20'}})]);
    const lease=await browserLease?.current();send(res,200,{settings:config,bridge:bridgeConfig(config),local_browser:{available:!!browserLease,active:!!lease,expires_at:lease?.expiresAt||null},local_files:{enabled:!!reportFiles,directory:'staging/.local/uber-reports/'},agencies,organizations:[...new Set(identities.map(row=>row.organization_id).filter(uuid).map(value=>value.toLowerCase()))],journal});return true;
   }
   if(path==='/api/uber-reports/settings'&&req.method==='POST'){
    const b=await readBody(req);if(b.csv_timezone!=null&&!['UTC','Africa/Casablanca'].includes(b.csv_timezone))throw fail(400,'Fuseau horaire CSV non pris en charge');if(typeof b.enabled!=='boolean'||!['dmy','ymd','mdy'].includes(b.date_format)||!b.city_agencies||Array.isArray(b.city_agencies)||typeof b.city_agencies!=='object'||b.organization_id!=null&&!uuid(b.organization_id))throw fail(400,'Réglages Uber incomplets');
    if(b.organization_label!=null&&(typeof b.organization_label!=='string'||!b.organization_label.trim()||b.organization_label.trim().length>160||/[\u0000-\u001f\u007f-\u009f]/.test(b.organization_label)))throw fail(400,'Nom d’organisation Uber invalide (160 caractères maximum)');
    const mapping={};for(const [city,id]of Object.entries(b.city_agencies)){if(!['Casablanca','Marrakech'].includes(city)||!Number.isSafeInteger(id)||id<=0)throw fail(400,'Association ville / agence invalide');const rows=await db('agencies',{token:a.token,params:{id:'eq.'+id,select:'id,city'}});if(rows.length!==1||fold(rows[0].city)!==fold(city))throw fail(400,'La ville et l’agence ne correspondent pas');mapping[city]=id;}
    if(b.enabled&&(!b.organization_id||!Object.keys(mapping).length))throw fail(400,'Choisir la flotte Uber et au moins une agence');
    const result=await serial(()=>db('rpc/uber_report_configure',{method:'POST',body:{p_enabled:b.enabled,p_org:b.organization_id?.toLowerCase()||null,p_mapping:mapping,p_format:b.date_format,p_user:a.user.id,p_org_label:b.organization_label?.trim()||null,p_csv_timezone:b.csv_timezone??null}}));send(res,200,{settings:result,bridge:bridgeConfig(result)});return true;
   }
   throw fail(404,'Route rapport inconnue');
  }catch(error){send(res,Number.isInteger(error.status)?error.status:500,{error:error.status&&error.status<500?error.message:'Synchronisation des rapports indisponible',...(error.localFile?{local_file:error.localFile}:{}),...(error.code==='timezone_required'?{code:'timezone_required'}:{})});return true;}
 };
}
