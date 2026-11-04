import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertLocalProject } from './guard.mjs';
import { STAGING_ROOT, LOCAL_DIR, ensureLocalDir } from './paths.mjs';

// Metadata supplied by the project owner. No password, cloud linking or restore.
export const SOURCE = Object.freeze({host:'aws-0-eu-west-1.pooler.supabase.com',port:5432,database:'postgres',user:'postgres.cgiiwumbblimvmrypxlc'});
export const REFERENCE = Object.freeze({
  agencies:{limit:100,columns:['id','name','city']},
  parc:{limit:2000,columns:['plate','brand','model','fuel','agency_id']},
  vehicles:{limit:2000,columns:['key','plate','brand','model','fuel','active','agency_id','other_plates']},
  drivers:{limit:5000,columns:['code','name','status','source','agency_id']},
  contracts:{limit:2000,columns:['num','client_code','name','plate','vehicle_key','model','start_at','end_at','status','origin','imported_at','updated_at']},
  rules:{limit:500,columns:['id','name','weight','category']}
});
const SQL_FILE = path.join(STAGING_ROOT,'scripts','export-reference.sql');
export const SOURCE_CA = path.join(STAGING_ROOT,'scripts','certs','supabase-prod-ca-2021.crt');
const SOURCE_CA_FINGERPRINT = '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA';

export function checkSourceCA() {
  let cert;
  try { cert=new X509Certificate(fs.readFileSync(SOURCE_CA)); }
  catch { throw new Error('Certificat racine Supabase absent ou illisible : '+SOURCE_CA); }
  if(!cert.ca || cert.fingerprint256.replaceAll(':','')!==SOURCE_CA_FINGERPRINT || Date.parse(cert.validFrom)>Date.now() || Date.parse(cert.validTo)<=Date.now()) {
    throw new Error('Certificat racine Supabase inattendu ou expire : export refuse.');
  }
  return cert;
}

export function validateReference(value) {
  if(value?.format!=='ludy-reference-v1' || value.read_only!=='on' || value.contract_days!==30 || !Number.isFinite(Date.parse(value.exported_at))) throw new Error('Format ou lecture seule non confirme : export refuse.');
  if(!value.tables || Object.keys(value.tables).length!==Object.keys(REFERENCE).length || Object.keys(value.tables).some(k=>!REFERENCE[k])) throw new Error('Tables inattendues : export refuse.');
  const counts={};
  for(const [table,spec] of Object.entries(REFERENCE)) {
    const rows=value.tables[table];
    if(!Array.isArray(rows)) throw new Error('Donnees absentes pour '+table);
    if(rows.length>spec.limit) throw new Error('Limite atteinte pour '+table+' ('+spec.limit+'). Export incomplet refuse ; aucune nouvelle lecture automatique.');
    if(rows.some(row=>!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).length!==spec.columns.length || Object.keys(row).some(k=>!spec.columns.includes(k)))) throw new Error('Colonnes inattendues pour '+table);
    counts[table]=rows.length;
  }
  return counts;
}

export function psqlExportEnv(input=process.env) {
  const env=Object.fromEntries(Object.entries(input).filter(([key])=>!key.startsWith('PG')));
  return {...env,PGSSLMODE:'verify-full',PGSSLROOTCERT:SOURCE_CA,PGGSSENCMODE:'disable',PGCONNECT_TIMEOUT:'5',PGAPPNAME:'ludy_staging_reference_readonly'};
}

export function psqlExportArgs() {
  return ['--no-psqlrc','--no-readline','--password','--quiet','--no-align','--tuples-only','--set=ON_ERROR_STOP=1',
    '--host='+SOURCE.host,'--port='+SOURCE.port,'--username='+SOURCE.user,'--dbname='+SOURCE.database,'--file='+SQL_FILE];
}

export function exportReference(args=process.argv.slice(2)) {
  assertLocalProject();
  if(args.length>1 || (args.length===1 && !['--plan','--export'].includes(args[0]))) throw new Error('Usage : node staging/scripts/export-reference.mjs [--plan | --export]');
  console.log('Source de lecture : '+SOURCE.host+':'+SOURCE.port+' / '+SOURCE.user);
  console.log('Perimetre : agences, parc, vehicules, chauffeurs, regles et contrats des 30 derniers jours.');
  console.log('Transaction READ ONLY, une connexion, lecture limitee a 15 s, attente de verrou limitee a 1 s.');
  console.log('Aucun compte Auth, contact, parametre externe ou automatisme exporte. Ce fichier est un extrait de test, pas une sauvegarde complete.');
  if(args[0]!=='--export') {
    console.log('Preparation uniquement : aucune connexion distante. Pour exporter a un moment calme : npm --prefix staging run export:reference -- --export');
    return;
  }
  if(!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Lancer dans un terminal interactif : psql demandera le mot de passe sans l’afficher.');
  checkSourceCA();
  const version=spawnSync('psql',['--version'],{encoding:'utf8',env:psqlExportEnv(),timeout:5000});
  const major=Number(version.stdout?.match(/PostgreSQL\) (\d+)/)?.[1]);
  if(version.status!==0 || major<16 || !major) throw new Error('Client psql 16 ou plus recent requis.');
  console.log('TLS : verification stricte active avec la CA Supabase et le nom du serveur (verify-full).');
  console.log('Cette lecture sollicite temporairement la production. Aucun impact nul ne peut etre garanti.');
  console.log('Saisissez le mot de passe PostgreSQL dans le terminal (aucun caractere affiche). Il ne sera ni enregistre ni inclus dans la commande.');
  ensureLocalDir();
  const folder=path.join(LOCAL_DIR,'exports');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});fs.chmodSync(folder,0o700);
  const filename=path.join(folder,'reference-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json');
  const partial=filename+'.partial';
  const fd=fs.openSync(partial,'wx',0o600);
  let result;
  try {
    result=spawnSync('psql',psqlExportArgs(),{env:psqlExportEnv(),stdio:['inherit',fd,'inherit'],timeout:120000});
  } finally { fs.closeSync(fd); }
  try {
    if(result.error || result.status!==0) throw new Error('Export interrompu ou refuse. Aucun fichier incomplet conserve et aucune relance automatique.');
    const raw=fs.readFileSync(partial,'utf8');
    let value;try{value=JSON.parse(raw);}catch{throw new Error('Reponse JSON invalide : export abandonne.');}
    const counts=validateReference(value);
    const data={...value,source_project:SOURCE.user.slice('postgres.'.length)};
    fs.writeFileSync(partial,JSON.stringify(data)+'\n',{mode:0o600});
    fs.renameSync(partial,filename);
    console.log('Export termine : '+filename);
    console.log('Lignes exportees : '+JSON.stringify(counts));
    console.log('Copie privee ignoree par Git. Aucune importation ni restauration effectuee ; ne publiez pas ce fichier.');
  } catch(error) { fs.rmSync(partial,{force:true});throw error; }
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { exportReference(); } catch(error) { console.error(error.message);process.exitCode=1; }
}
