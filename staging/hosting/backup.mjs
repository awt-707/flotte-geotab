// Local staging only. This command never restores, changes source data or stops a collector.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {STAGING_ROOT} from '../scripts/paths.mjs';
import {assertLocalProject,readRuntime} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {privateDirectory} from './auth-config.mjs';
import {validateGeotabCredentials} from '../server/geotab.mjs';
import {validateMyclicarCredentials} from '../server/myclicar.mjs';

export const BACKUP_SCHEMAS=['public','auth','storage','supabase_migrations'];
export const PUBLIC_TRANSIENT=['geotab_session','user_sessions','driver_portal_sessions'];
const AUTH_KEEP=new Set(['users','identities','audit_log_entries']);
const AUTH_TRANSIENT=new Set(['schema_migrations','sessions','refresh_tokens','flow_state','one_time_tokens','mfa_amr_claims','mfa_challenges','webauthn_challenges','oauth_authorizations','oauth_client_states','saml_relay_states']);
const STORAGE_KEEP=new Set(['buckets','objects']);
const STORAGE_TRANSIENT=new Set(['migrations']);
const BUILTIN_SCHEMAS=new Set([...BACKUP_SCHEMAS,'extensions','graphql','graphql_public','_realtime','realtime','supabase_functions','vault']);
const MAX_FILE=64*1024*1024,MAX_TOTAL=10*1024**3;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const fail=message=>Error('Sauvegarde staging : '+message+'.');
const env=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const identifier=value=>typeof value==='string'&&/^[a-z_][a-z0-9_]*$/.test(value);
const quote=value=>'"'+value.replaceAll('"','""')+'"';

const CATALOG_SQL=`select json_build_object(
 'snapshot',pg_export_snapshot(),'database_version',current_setting('server_version'),'database_bytes',pg_database_size(current_database()),
 'extensions',(select json_agg(json_build_object('name',extname,'version',extversion) order by extname) from pg_extension),
 'auth_migrations',(select json_agg(version order by version) from auth.schema_migrations),
 'storage_migrations',(select json_agg(json_build_object('id',id,'name',name) order by id) from storage.migrations),
 'schemas',(select json_agg(nspname order by nspname) from pg_namespace where nspname not like 'pg_%' and nspname<>'information_schema'),
 'tables',(select json_agg(json_build_object('schema',schemaname,'name',tablename) order by schemaname,tablename) from pg_tables where schemaname in ('public','auth','storage','supabase_migrations')),
 'pending_auth_tokens',(select count(*) from auth.users where coalesce(confirmation_token,'')<>'' or coalesce(recovery_token,'')<>'' or coalesce(email_change_token_new,'')<>'' or coalesce(email_change_token_current,'')<>'' or coalesce(phone_change_token,'')<>'' or coalesce(reauthentication_token,'')<>''),
 'vault_secrets',(select count(*) from vault.secrets),
 'storage_objects',(select coalesce(json_agg(to_jsonb(o) order by o.id),'[]'::json) from storage.objects o)
);`;

export function backupPlan(catalog){
 if(!catalog||!Array.isArray(catalog.tables)||!Array.isArray(catalog.schemas)||!Array.isArray(catalog.storage_objects)||!/^\d+\.\d+/.test(catalog.database_version)||!/^[0-9A-F-]+$/i.test(catalog.snapshot))throw fail('inventaire local invalide');
 if(catalog.database_bytes!==undefined&&(!Number.isSafeInteger(catalog.database_bytes)||catalog.database_bytes>MAX_TOTAL))throw fail('base supérieure à 10 Gio ou taille invalide');
 if(catalog.pending_auth_tokens||catalog.vault_secrets)throw fail('jetons Auth en cours ou coffre Vault non vide, revue manuelle requise');
 if(catalog.schemas.some(s=>!BUILTIN_SCHEMAS.has(s)))throw fail('schéma supplémentaire non pris en charge, rien ne sera omis silencieusement');
 const excluded=[],retained=[];
 for(const row of catalog.tables){
  if(!identifier(row.schema)||!identifier(row.name)||!BACKUP_SCHEMAS.includes(row.schema)||!Number.isSafeInteger(row.count)||row.count<0)throw fail('inventaire de tables invalide');
  const table=row.schema+'.'+row.name;
  let keep=true;
  if(row.schema==='public')keep=!PUBLIC_TRANSIENT.includes(row.name);
  if(row.schema==='auth'){
   keep=AUTH_KEEP.has(row.name);
   if(!keep&&!AUTH_TRANSIENT.has(row.name)&&row.count>0)throw fail('configuration Auth persistante supplémentaire, revue nécessaire avant transfert');
  }
  if(row.schema==='storage'){
   keep=STORAGE_KEEP.has(row.name);
   if(!keep&&!STORAGE_TRANSIENT.has(row.name)&&row.count>0)throw fail('fonction Storage supplémentaire ou transfert multipart en cours');
  }
  (keep?retained:excluded).push({...row,table});
 }
 if(!retained.some(t=>t.table==='auth.users')||!retained.some(t=>t.table==='public.params')||!retained.some(t=>t.table==='storage.objects'))throw fail('tables nécessaires absentes');
 for(const object of catalog.storage_objects){
  if(!/^[a-f0-9-]{36}$/i.test(object.id)||typeof object.bucket_id!=='string'||!object.bucket_id||typeof object.name!=='string'||!object.name||object.name.includes('\0')||object.name.split('/').some(p=>['.','..',''].includes(p)))throw fail('objet Storage non portable');
  const size=Number(object.metadata?.size);if(!Number.isSafeInteger(size)||size<0||size>MAX_FILE)throw fail('taille d’objet Storage absente ou supérieure à 64 Mio');
 }
 if(retained.find(t=>t.table==='storage.objects').count!==catalog.storage_objects.length)throw fail('inventaire Storage incomplet');
 return {retained,excluded,storageBytes:catalog.storage_objects.reduce((sum,o)=>sum+Number(o.metadata.size),0)};
}

export function pgDumpArguments(catalog,plan){
 return dockerArgs('pg_dump',['--format=custom','--no-owner','--lock-wait-timeout=2s','--snapshot='+catalog.snapshot,...BACKUP_SCHEMAS.map(s=>'--schema='+s),...plan.excluded.map(t=>'--exclude-table-data='+t.table)]);
}

/** One read-only repeatable-read transaction holds the snapshot until pg_dump finishes. */
export function openLocalSnapshot({spawnFn=spawn}={}){
 const child=spawnFn('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']),{env:env(),stdio:['pipe','pipe','pipe']});
 let pending=null,buffer='',record='',ended=false;
 const done=new Promise(resolve=>child.once('close',code=>{ended=true;if(pending){clearTimeout(pending.timer);pending.reject(fail('transaction locale interrompue'));pending=null;}resolve(code);}));
 child.stderr.on('data',()=>{}); // Never relay database diagnostics or private rows.
 child.on('error',()=>{if(pending){clearTimeout(pending.timer);pending.reject(fail('PostgreSQL local indisponible'));pending=null;}});
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
  buffer+=chunk;if(buffer.length+record.length>32*1024*1024){child.kill('SIGTERM');return;}
  let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;
   if(!pending){child.kill('SIGTERM');return;}
   record+=line;let value;try{value=JSON.parse(record);}catch{if(!/^[\[{]/.test(record)){pending.reject(fail('résultat local illisible'));clearTimeout(pending.timer);pending=null;child.kill('SIGTERM');}continue;}
   const current=pending;pending=null;record='';clearTimeout(current.timer);current.resolve(value);
  }
 });
 const query=sql=>new Promise((resolve,reject)=>{
  if(ended||pending)return reject(fail('transaction locale indisponible'));
  const timer=setTimeout(()=>{if(pending){pending=null;reject(fail('lecture locale trop longue'));child.kill('SIGTERM');}},45000);
  pending={resolve,reject,timer};child.stdin.write(sql+'\n');
 });
 return {query,async begin(){return query("begin isolation level repeatable read read only; set local statement_timeout='30s'; set local lock_timeout='2s';\n"+LOCAL_GUARD+'\n'+CATALOG_SQL);},async close(){if(!ended)child.stdin.end('rollback;\n');const timer=setTimeout(()=>child.kill('SIGTERM'),5000);try{await done;}finally{clearTimeout(timer);}}};
}

export async function snapshotCatalog(snapshot){
 const catalog=await snapshot.begin();
 if(!Array.isArray(catalog.tables)||catalog.tables.length>500||catalog.tables.some(t=>!identifier(t.schema)||!identifier(t.name)||!BACKUP_SCHEMAS.includes(t.schema)))throw fail('catalogue inattendu');
 const parts=catalog.tables.map(t=>`select '${t.schema}'::text as schema,'${t.name}'::text as name,count(*)::bigint as count from ${quote(t.schema)}.${quote(t.name)}`);
 catalog.tables=await snapshot.query(`select coalesce(json_agg(t order by schema,name),'[]'::json) from (${parts.join(' union all ')}) t;`);
 return catalog;
}

async function readSource(filename,maximum=MAX_FILE){
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await file.stat();if(!before.isFile()||before.nlink!==1||(before.mode&0o777)!==0o600||before.size>maximum)throw fail('fichier source privé non conforme');
  const bytes=await file.readFile(),after=await fs.lstat(filename);
  if(after.isSymbolicLink()||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||bytes.length!==before.size)throw fail('fichier source changé pendant la lecture');
  return bytes;
 }finally{await file.close();}
}
export async function privateFileInventory(root=STAGING_ROOT){
 const local=path.join(root,'.local');await privateDirectory(local);
 const entries=[],receipts=[];
 async function add(relative,destination=relative,validate){
  const file=path.join(local,...relative.split('/'));
  let bytes;try{bytes=await readSource(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(validate)validate(bytes);
  entries.push({source:relative,destination,bytes:bytes.length,sha256:hash(bytes)});
 }
 await add('geotab.json','connectors/geotab.json',b=>validateGeotabCredentials(JSON.parse(b)));
 await add('myclicar.json','connectors/myclicar.json',b=>validateMyclicarCredentials(JSON.parse(b)));
 await add('bolt.env','connectors/bolt.env',b=>{
  const lines=b.toString().split(/\r?\n/).filter(l=>l.trim()&&!l.trim().startsWith('#'));
  if(lines.length!==2||!lines.some(l=>/^BOLT_CLIENT_ID=.+$/.test(l))||!lines.some(l=>/^BOLT_CLIENT_SECRET=.+$/.test(l)))throw fail('le fichier Bolt doit contenir uniquement ses deux paramètres');
 });
 await add('reference-import.json','reference-import.json',b=>{JSON.parse(b);});
 await add('connector-state.json','resume-review/connector-state.original.json',b=>{const v=JSON.parse(b);if(v.version!==1||!v.enabled||Object.entries(v.enabled).some(([k,v])=>!['geotab','bolt','myclicar'].includes(k)||typeof v!=='boolean'))throw fail('préférences connecteurs invalides');});
 const reports=path.join(local,'uber-reports');
 try{await privateDirectory(reports);}catch(error){if(error.code==='ENOENT')return entries;throw error;}
 for(const directory of ['files','receipts']){
  const base=path.join(reports,directory);try{await privateDirectory(base);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  async function walk(at,relative){
   for(const item of await fs.readdir(at,{withFileTypes:true})){
    if(item.name.endsWith('.tmp'))continue;
    if(item.isSymbolicLink())throw fail('lien dans l’archive Uber');
    const rel=relative+'/'+item.name;
    if(item.isDirectory()){if(directory!=='files'||relative!=='uber-reports/files'||!/^[a-f0-9-]{36}$/i.test(item.name))throw fail('dossier de rapports inattendu');await privateDirectory(path.join(at,item.name));await walk(path.join(at,item.name),rel);continue;}
    if(!item.isFile())throw fail('rapport non régulier');
    if(directory==='files'&&!/^uber-reports\/files\/[a-f0-9-]{36}\/(?:trip_activity|driver_activity|driver_quality)-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.csv$/i.test(rel))throw fail('nom de CSV inattendu');
    if(directory==='receipts'&&!/^uber-reports\/receipts\/[a-f0-9]{64}\.json$/.test(rel))throw fail('reçu de rapport inattendu');
    await add(rel,rel,b=>{if(directory==='files'){if(hash(b)!==item.name.slice(-68,-4))throw fail('empreinte CSV incorrecte');}else{
     const value=JSON.parse(b);if(value.version!==1||!['pending','imported','failed'].includes(value.status)||typeof value.file!=='string'||!value.file.startsWith('files/')||!Number.isSafeInteger(value.byte_length)||!/^[a-f0-9]{64}$/.test(value.sha256))throw fail('reçu CSV invalide');receipts.push(value);
    }});
   }
  }
  await walk(base,'uber-reports/'+directory);
 }
 for(const receipt of receipts){const file=entries.find(e=>e.source==='uber-reports/'+receipt.file);if(!file||file.bytes!==receipt.byte_length||file.sha256!==receipt.sha256)throw fail('reçu Uber sans CSV complet correspondant');}
 return entries;
}

async function writePrivate(root,relative,bytes){
 const target=path.join(root,...relative.split('/'));await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});
 return {path:relative,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)};
}
async function dumpDatabase(filename,args){
 const file=await fs.open(filename,'wx',0o600);
 try{
  await new Promise((resolve,reject)=>{
   const child=spawn('docker',args,{env:env(),stdio:['ignore',file.fd,'pipe']});
   const timer=setTimeout(()=>child.kill('SIGTERM'),120000);child.stderr.on('data',()=>{});
   child.once('error',()=>{clearTimeout(timer);reject(fail('pg_dump local indisponible'));});
   child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(fail('pg_dump interrompu'));});
  });
  await file.sync();
 }finally{await file.close();}
}
async function hashFile(filename){
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const digest=createHash('sha256');let bytes=0;
 try{for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>MAX_TOTAL)throw fail('sauvegarde supérieure à 10 Gio');digest.update(chunk);}return {bytes,sha256:digest.digest('hex')};}finally{await file.close();}
}
export async function copyStorageObject(runtime,object,{fetchFn=fetch}={}){
 if(runtime.supabaseUrl!=='http://127.0.0.1:57421')throw fail('origine Storage non locale');
 const route='/storage/v1/object/authenticated/'+encodeURIComponent(object.bucket_id)+'/'+object.name.split('/').map(encodeURIComponent).join('/');
 const response=await fetchFn(runtime.supabaseUrl+route,{headers:{apikey:runtime.serviceKey,Authorization:'Bearer '+runtime.serviceKey},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok){await response.body?.cancel();throw fail('objet Storage indisponible, copie incomplète refusée');}
 const chunks=[];let size=0;
 if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>MAX_FILE){await response.body.cancel().catch(()=>{});throw fail('objet Storage trop volumineux');}chunks.push(chunk);}
 if(size!==Number(object.metadata.size))throw fail('taille Storage différente du snapshot');
 return Buffer.concat(chunks);
}

const RESTORE_REVIEW=`# Revue obligatoire avant restauration\n\nAucune restauration automatique n’est fournie. Cette copie provient seulement du staging local.\n\n1. Vérifier toutes les empreintes du manifeste, puis disposer d’une sauvegarde de la cible. Ne jamais viser la production.\n2. Installer exactement la même version CLI, les migrations Ludy et les composants Auth/Storage compatibles ; comparer les versions/empreintes enregistrées. Conserver les clés ES256/API neuves du serveur.\n3. Préparer une restauration sélectionnée : le dump contient aussi des définitions Auth/Storage déjà créées par la CLI. Ne pas exécuter pg_restore --clean globalement, ne pas restaurer les rôles PostgreSQL ou la configuration des services.\n4. Préserver les UUID auth.users/identities et les profils/agences Ludy. Les hashes de mots de passe restent valables avec de nouvelles clés JWT. Aucune ancienne session/refresh-token n’est transférée ; chaque utilisateur se reconnecte. Les jetons Auth temporaires ont été vérifiés vides. Les fonctions Auth non portables peuplées bloquent l’export.\n5. L’amorçage d’une base neuve crée déjà un administrateur : résoudre cette collision avant de charger les comptes. Ne pas laisser bootstrap réinitialiser un compte restauré faute de credentials.json. Choisir explicitement le mot de passe de l’administrateur cible.\n6. Pour Storage, restaurer les buckets et les fichiers binaires avec leurs chemins, types et propriétaires. Restaurer seulement storage.objects en SQL ne restaure aucun fichier. Préparer l’ordre API/metadata, puis comparer chaque hash ; aucun téléchargement manquant ne doit être ignoré.\n7. Les fichiers connectors/ contiennent des secrets fournisseurs. Copier seulement après autorisation de bascule, en mode 600. Le plan original de reprise est documentaire ; utiliser connector-state.paused.json jusqu’à la bascule. Réassocier l’extension Uber et ouvrir de nouvelles sessions navigateur ; aucun profil/cookie n’est transféré.\n8. Vérifier les comptes chauffeur, les rôles, RLS, les compteurs de chaque table conservée et les références aux documents. Conserver les codes chauffeur existants ou les renouveler explicitement ; aucun mot de passe/code en clair n’est contenu dans cette copie.\n9. Les CSV Uber sont archivés avec empreinte ; leur présence sur disque ne signifie pas qu’ils sont tous importés dans le snapshot DB. Examiner les reçus et les imports DB avant toute reprise. La collecte des rapports côté cible doit rester désactivée jusque-là.\n10. Cette sauvegarde est datée et les collecteurs continuent de tourner. La base est un snapshot cohérent ; Storage est vérifié inchangé pendant la copie et les fichiers locaux sont vérifiés individuellement, sans prétendre une transaction commune. Refaire une copie finale et vérifier la bascule avant d’éteindre le poste.\n`;

export async function backupLocal({exportData=false,root=STAGING_ROOT,loadRuntime=readRuntime,guard=assertLocalProject,openSnapshot=openLocalSnapshot,dump=dumpDatabase,fetchFn=fetch,now=Date.now}={}){
 guard();const runtime=loadRuntime();if(runtime.projectId!=='ludy-staging'||runtime.supabaseUrl!=='http://127.0.0.1:57421')throw fail('runtime non local');
 const snapshot=openSnapshot();let directory,complete=false;
 try{
  const catalog=await snapshotCatalog(snapshot),plan=backupPlan(catalog),sources=await privateFileInventory(root);
  const packageBytes=await fs.readFile(path.join(root,'package.json')),packageSpec=JSON.parse(packageBytes);
  if(packageSpec.devDependencies?.supabase!=='2.122.0')throw fail('version CLI non prise en charge pour cette procédure');
  if(plan.storageBytes+sources.reduce((n,f)=>n+f.bytes,0)>MAX_TOTAL)throw fail('copie supérieure à 10 Gio');
  const counts={users:plan.retained.find(t=>t.table==='auth.users').count,retainedTables:plan.retained.length,excludedTables:plan.excluded.length,storageObjects:catalog.storage_objects.length,privateFiles:sources.length};
  if(!exportData)return {mode:'dry-run',counts,storageBytes:plan.storageBytes,schemas:BACKUP_SCHEMAS,connectorFiles:sources.filter(f=>f.destination.startsWith('connectors/')).map(f=>f.destination),changed:false};
  const parent=path.join(root,'.local/backups');await fs.mkdir(parent,{recursive:true,mode:0o700});await privateDirectory(parent);
  directory=path.join(parent,'transfer-'+new Date(now()).toISOString().replaceAll(':','-')+'-'+randomUUID());await fs.mkdir(directory,{mode:0o700});
  const files=[];const filename=path.join(directory,'staging.dump');await dump(filename,pgDumpArguments(catalog,plan));files.push({path:'staging.dump',...await hashFile(filename)});
  if(files[0].bytes+plan.storageBytes+sources.reduce((sum,f)=>sum+f.bytes,0)>MAX_TOTAL)throw fail('copie totale supérieure à 10 Gio');
  for(const source of sources){
   const bytes=await readSource(path.join(root,'.local',...source.source.split('/')));
   if(hash(bytes)!==source.sha256)throw fail('fichier privé modifié depuis l’inventaire');
   files.push(await writePrivate(directory,source.destination,bytes));
  }
  const objects=[];
  for(const object of catalog.storage_objects){const relative='storage/objects/'+object.id+'.bin',bytes=await copyStorageObject(runtime,object,{fetchFn});files.push(await writePrivate(directory,relative,bytes));objects.push({...object,backup_file:relative,sha256:hash(bytes)});}
  // A new read-only snapshot checks object versions/metadata, not the old frozen view.
  const latest=openSnapshot();try{const current=await latest.begin();if(JSON.stringify(current.storage_objects)!==JSON.stringify(catalog.storage_objects))throw fail('Storage a changé pendant la copie, recommencer');}finally{await latest.close();}
  files.push(await writePrivate(directory,'storage/objects.json',json(objects)));
  files.push(await writePrivate(directory,'resume-review/connector-state.paused.json',json({version:1,enabled:{bolt:false,geotab:false,myclicar:false}})));
  files.push(await writePrivate(directory,'RESTORE-REVIEW.md',RESTORE_REVIEW));
  const manifest={format:'ludy-private-staging-backup-v1',projectId:'ludy-staging',createdAt:new Date(now()).toISOString(),cliVersion:packageSpec.devDependencies.supabase,sourcePackageSha256:hash(packageBytes),databaseVersion:catalog.database_version,componentMigrations:{auth:catalog.auth_migrations||[],storage:catalog.storage_migrations||[]},extensions:catalog.extensions||[],snapshot:catalog.snapshot,schemas:BACKUP_SCHEMAS,counts,retainedTables:plan.retained,excludedTableData:plan.excluded,consistency:'database_repeatable_read_snapshot; storage_versions_checked; local_files_individually_checked; final_cutover_copy_required',requiresManualRestoreReview:true,includesProviderSecrets:sources.some(f=>f.destination.startsWith('connectors/')),excluded:['runtime.json','credentials.json','hosting/','share/','uber-pairing.json','browser profiles','Auth sessions/refresh tokens','driver portal sessions','PostgreSQL roles','Vault secrets'],files};
  const receipt=await writePrivate(directory,'manifest.json',json(manifest));complete=true;
  return {mode:'export',directory,counts,bytes:files.reduce((sum,f)=>sum+f.bytes,receipt.bytes),manifestSha256:receipt.sha256,containsPrivateData:true,restored:false,sourceChanged:false};
 }finally{await snapshot.close();if(directory&&!complete)await fs.rm(directory,{recursive:true,force:true});}
}

export async function backupCommand(args=[]){
 if(args.length===1&&['--help','-h'].includes(args[0]))return {usage:'node staging/hosting/backup.mjs [--export]',default:'Inventaire local uniquement, aucun fichier exporté.',destination:'staging/.local/backups/transfer-<date>-<uuid>/',restore:'Aucune restauration automatique.'};
 if(args.length&&args.join(' ')!=='--export')throw fail('argument invalide, utilisez --help');
 return backupLocal({exportData:args[0]==='--export'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)backupCommand(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{console.error('Sauvegarde staging refusée ou interrompue. Aucun détail sensible affiché ; aucune copie incomplète conservée. Vérifier le staging et les prérequis documentés.');process.exitCode=1;});
