// Source-only Mac test kit. Nothing is collected by walking the project tree.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {CLIENT_FILES} from './build-desktop.mjs';
import {STAGING_ROOT,LOCAL_DIR,ensureLocalDir} from './paths.mjs';

export const KIT_SOURCE_FILES=Object.freeze([
  'scripts/paths.mjs','scripts/build-desktop.mjs','scripts/mac-local-test.mjs',
  ...CLIENT_FILES.map(file=>'desktop/'+file),'desktop/package.json','desktop/package-lock.json'
]);
export const KIT_LAUNCHER='#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nif ! command -v node >/dev/null 2>&1; then\n  printf \'%s\\n\' "Node.js est nécessaire. Installez la version LTS officielle (22.12 minimum) : https://nodejs.org/fr/download"\n  exit 1\nfi\nexec node ./staging/scripts/mac-local-test.mjs\n';
const README=[
  'LUDY — TEST MAC LOCAL', '',
  'Ce kit contient uniquement les sources du client de test. Il reconstruit Ludy sur votre Mac et vérifie sa signature ad hoc avant le test de lancement.',
  'macOS 13 minimum. Installez une version LTS officielle de Node.js, version 22.12 minimum : https://nodejs.org/fr/download',
  'Une connexion Internet est nécessaire pour les téléchargements npm et GitHub. La première préparation prend quelques minutes.', '',
  '1. Extrayez entièrement ce ZIP.',
  '2. Ouvrez Terminal. Tapez sh suivi d’un espace, puis glissez le fichier Preparer Ludy.command depuis Finder dans le Terminal.',
  '3. Appuyez sur Entrée. Conservez la fenêtre ouverte pendant la préparation et suivez les indications du test.',
  '4. Enregistrez le rapport JSON de diagnostic et transmettez-le à la personne chargée de la validation.', '',
  'Ce test utilise une page fictive : aucun compte, mot de passe, accès Supabase ou accès aux connecteurs n’est nécessaire.',
  'Le kit ne contient ni serveur, ni données métier, ni dépendances déjà installées.',
  'Le test de lancement ne valide pas la connexion au serveur, les données métier ou toutes les fonctions natives.', '',
  'La signature ad hoc sert au test sur le Mac qui construit l’application. Elle n’est pas une signature Developer ID ni une notarisation Apple.',
  'L’application construite reste un test local, sans ZIP de distribution. Ne la transmettez pas comme application Mac prête à installer.',
  'Si macOS refuse encore le lancement, conservez le message exact pour le diagnostic. Les protections du système restent actives.', ''
].join('\n');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function prepareMacTestKit(destination,sourceRoot=STAGING_ROOT) {
  const source=path.resolve(sourceRoot),out=path.resolve(destination),payload=[];
  if(await fs.realpath(source)!==source)throw Error('Répertoire source symbolique refusé.');
  // Validate and read the whole allowlist before creating an output directory.
  for(const relative of KIT_SOURCE_FILES) {
    const filename=path.join(source,relative),stat=await fs.lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>20*1024*1024||await fs.realpath(filename)!==filename)throw Error('Source du kit non régulière : '+relative);
    const bytes=await fs.readFile(filename);
    payload.push({path:'staging/'+relative,bytes});
  }
  const packageInfo=JSON.parse(payload.find(file=>file.path==='staging/desktop/package.json').bytes.toString('utf8'));
  if(!/^\d+\.\d+\.\d+$/.test(packageInfo.version||''))throw Error('Version du client invalide.');
  payload.push({path:'Preparer Ludy.command',bytes:Buffer.from(KIT_LAUNCHER)},{path:'LIRE-MOI.txt',bytes:Buffer.from(README)});
  const manifest={format:'ludy-mac-local-kit-v1',version:packageInfo.version,files:payload.map(file=>({path:file.path,sha256:digest(file.bytes)})).sort((a,b)=>a.path.localeCompare(b.path)),totalBytes:payload.reduce((total,file)=>total+file.bytes.length,0)};
  await fs.mkdir(out,{mode:0o700});
  try {
    if(await fs.realpath(out)!==out)throw Error('Destination symbolique refusée.');
    for(const file of payload) {
      const filename=path.join(out,file.path);
      await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
      await fs.writeFile(filename,file.bytes,{flag:'wx',mode:file.path==='Preparer Ludy.command'?0o755:0o644});
    }
    await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
    return manifest;
  } catch(error) {await fs.rm(out,{recursive:true,force:true});throw error;}
}

async function zip(directory,filename,rootName) {
  await new Promise((resolve,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ZIPOPT'));
    const child=spawn('zip',['-q','-r','-y',filename,rootName],{cwd:directory,env,stdio:['ignore','ignore','pipe']});let message='';
    child.stderr.on('data',chunk=>{message=(message+chunk).slice(-4000);});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Création ZIP interrompue : '+(message.trim()||code))));
  });
}
export async function main(args=process.argv.slice(2)) {
  if(args.length===1&&['--help','-h'].includes(args[0])){console.log('node staging/scripts/build-mac-test-kit.mjs\nCrée un kit de sources pour le test local sur Mac, dans staging/.local/releases/desktop/.');return;}
  if(args.length)throw Error('Option inconnue. Utilisez --help.');
  ensureLocalDir();
  const releaseRoot=path.join(LOCAL_DIR,'releases','desktop');await fs.mkdir(releaseRoot,{recursive:true,mode:0o700});
  const temp=await fs.mkdtemp(path.join(releaseRoot,'.mac-kit-'));
  try {
    const prepared=path.join(temp,'sources'),manifest=await prepareMacTestKit(prepared);
    const name='Ludy-Mac-Test-Local-'+manifest.version;
    await fs.rename(prepared,path.join(temp,name));
    const filename=path.join(temp,'kit.zip');await zip(temp,filename,name);
    const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);const sha256=hash.digest('hex');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-'),file=path.join(releaseRoot,name+'-'+stamp+'-'+randomUUID().slice(0,8)+'.zip');
    // Atomic publication refuses any existing filename instead of replacing it.
    await fs.link(filename,file);
    try{await fs.writeFile(file+'.sha256',sha256+'  '+path.basename(file)+'\n',{flag:'wx',mode:0o600});}
    catch(error){await fs.unlink(file);throw error;}
    const result={file,sha256,bytes:(await fs.stat(file)).size,files:manifest.files.length,version:manifest.version,sourceOnly:true,includesPrivateData:false};
    console.log(JSON.stringify(result,null,2));return result;
  } finally {await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
