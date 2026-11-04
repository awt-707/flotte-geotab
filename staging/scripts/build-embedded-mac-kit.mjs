import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {runtimeSourceFiles,EMBEDDED_CLIENT_FILES} from './build-embedded-desktop.mjs';
import {verifyEmbeddedMacKit} from './mac-embedded-local.mjs';
import {STAGING_ROOT,LOCAL_DIR,ensureLocalDir} from './paths.mjs';
const require=createRequire(import.meta.url);
const {validateEmbeddedConfig}=require('../desktop/embedded-config.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const MAC_EMBEDDED_TOOLS=Object.freeze(['scripts/paths.mjs','scripts/build-desktop.mjs','scripts/build-embedded-desktop.mjs','scripts/mac-local-test.mjs','scripts/mac-embedded-local.mjs','desktop/config.cjs','desktop/embedded-bootstrap.cjs','desktop/package.json','desktop/package-lock.json']);
export const MAC_EMBEDDED_LAUNCHER='#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nif ! command -v node >/dev/null 2>&1; then\n  printf \'%s\\n\' "Installez Node.js LTS officiel (22.12 minimum) : https://nodejs.org/fr/download"\n  exit 1\nfi\nexec node ./staging/scripts/mac-embedded-local.mjs\n';
const README=[
  'LUDY 0.2 — CLIENT ET SERVEUR EMBARQUÉS — TEST MAC LOCAL','',
  'Ce kit reconstruit Ludy et son serveur local sur votre Mac. Il utilise le projet Supabase de production indiqué dans desktop-public.json. Ce fichier contient uniquement une configuration publique ; aucun mot de passe ni clé de service n’est inclus.',
  'La préparation ne contacte pas Supabase et n’applique aucune migration. Une fois Ludy.app ouverte et votre session connectée, les données de production sont accessibles selon vos droits. La collecte nécessite une participation explicite sur un compte administrateur.',
  'Prérequis : macOS 13 ou plus récent, Node.js LTS officiel 22.12 ou plus récent (https://nodejs.org/fr/download), connexion Internet pour npm et Electron/GitHub. Choisissez Node Apple Silicon sur un Mac Apple Silicon, Intel sur un Mac Intel. Prévoyez quelques minutes et de l’espace libre pour les dépendances et l’application.','',
  '1. Extrayez entièrement le ZIP.',
  '2. Ouvrez Terminal. Tapez sh suivi d’un espace et glissez Preparer Ludy Mac.command depuis Finder dans Terminal. Appuyez sur Entrée.',
  '3. Le script vérifie les empreintes du kit, installe les outils depuis leurs lockfiles, construit l’application pour ce Mac et vérifie sa signature ad hoc.',
  '4. Le Terminal affiche le chemin de Ludy.app. Dans Finder, utilisez Aller > Aller au dossier pour ouvrir le dossier indiqué, puis ouvrez Ludy.app.',
  '5. Connectez-vous à Ludy. La base et ses migrations de production doivent avoir été préparées suivant le guide de déploiement. Activez « Participer à la collecte » uniquement sur les postes administrateurs prévus pour cela.','',
  'Vérification des sources seule, depuis le dossier du kit :',
  'node staging/scripts/mac-embedded-local.mjs --verify',
  'Pour vérifier le ZIP avant extraction, placez-le à côté du fichier .zip.sha256 et utilisez :',
  'shasum -a 256 -c "nom-du-kit.zip.sha256"','',
  'Le serveur écoute seulement 127.0.0.1:4173. Fermez l’ancienne application Ludy avant d’ouvrir celle-ci. Les profils et identifiants des connecteurs sont créés sur ce Mac dans les données privées de Ludy ; ils ne sont pas inclus dans ce kit.',
  'La signature ad hoc est destinée au test sur le Mac qui effectue la construction. Ce n’est ni une signature Developer ID ni une notarisation Apple. Aucun ZIP d’application Mac redistribuable n’est produit. Si macOS refuse le lancement, conservez le message exact ; les protections système restent actives.',
  'Cette préparation ne valide pas à elle seule les fonctions métier, les migrations, la connexion aux fournisseurs ou le basculement entre deux ordinateurs.',''
].join('\n');
async function bytesAt(filename) {
  const s=await fs.lstat(filename);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>30*1024*1024||await fs.realpath(filename)!==filename)throw Error('Source non régulière refusée : '+path.basename(filename));
  return fs.readFile(filename);
}
export async function prepareEmbeddedMacKit(destination,config,sourceRoot=STAGING_ROOT) {
  config=validateEmbeddedConfig(config);const source=path.resolve(sourceRoot),out=path.resolve(destination);
  if(await fs.realpath(source)!==source)throw Error('Répertoire source symbolique refusé.');
  const files=[...new Set([...await runtimeSourceFiles(source),...MAC_EMBEDDED_TOOLS,...EMBEDDED_CLIENT_FILES.map(file=>'desktop/'+file)])].sort();
  const payload=[];for(const relative of files)payload.push({path:'staging/'+relative,bytes:await bytesAt(path.join(source,relative))});
  const info=JSON.parse(payload.find(file=>file.path==='staging/desktop/package.json').bytes);
  if(!/^\d+\.\d+\.\d+$/.test(info.version||''))throw Error('Version desktop invalide.');
  payload.push({path:'desktop-public.json',bytes:Buffer.from(JSON.stringify(config,null,2)+'\n')},{path:'Preparer Ludy Mac.command',bytes:Buffer.from(MAC_EMBEDDED_LAUNCHER)},{path:'LIRE-MOI.txt',bytes:Buffer.from(README)});
  const manifest={format:'ludy-embedded-mac-source-v1',version:info.version,projectRef:config.projectRef,files:payload.map(file=>({path:file.path,sha256:sha(file.bytes)})).sort((a,b)=>a.path.localeCompare(b.path)),totalBytes:payload.reduce((sum,file)=>sum+file.bytes.length,0)};
  await fs.mkdir(out,{mode:0o700});
  try{
    if(await fs.realpath(out)!==out)throw Error('Destination symbolique refusée.');
    for(const entry of payload){const filename=path.join(out,entry.path);await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});await fs.writeFile(filename,entry.bytes,{flag:'wx',mode:entry.path==='Preparer Ludy Mac.command'?0o755:0o644});}
    await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
    await verifyEmbeddedMacKit(out);return manifest;
  }catch(error){await fs.rm(out,{recursive:true,force:true});throw error;}
}
async function archive(directory,filename,name){await new Promise((resolve,reject)=>{const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ZIPOPT'));const child=spawn('zip',['-q','-r','-y',filename,name],{cwd:directory,env,stdio:['ignore','ignore','pipe']});let message='';child.stderr.on('data',chunk=>message=(message+chunk).slice(-1000));child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Création ZIP interrompue : '+(message||code))));});}
export async function main(args=process.argv.slice(2)) {
  if(args.length)throw Error('Ce constructeur utilise seulement staging/.local/production/desktop-public.json et n’accepte aucune option.');
  const config=validateEmbeddedConfig(JSON.parse(await bytesAt(path.join(LOCAL_DIR,'production/desktop-public.json'))));
  ensureLocalDir();const releases=path.join(LOCAL_DIR,'releases','embedded-desktop');await fs.mkdir(releases,{recursive:true,mode:0o700});
  const temp=await fs.mkdtemp(path.join(releases,'.mac-source-'));
  try{
    const prepared=path.join(temp,'sources'),manifest=await prepareEmbeddedMacKit(prepared,config),name='Ludy-'+manifest.version+'-Mac-Sources-TEST-LOCAL';
    await fs.rename(prepared,path.join(temp,name));await verifyEmbeddedMacKit(path.join(temp,name));
    const temporaryZip=path.join(temp,'kit.zip');await archive(temp,temporaryZip,name);
    const digest=createHash('sha256');for await(const bytes of createReadStream(temporaryZip))digest.update(bytes);const sha256=digest.digest('hex');
    const file=path.join(releases,name+'-'+Date.now()+'-'+randomUUID().slice(0,8)+'.zip');await fs.link(temporaryZip,file);
    try{await fs.writeFile(file+'.sha256',sha256+'  '+path.basename(file)+'\n',{flag:'wx',mode:0o600});}catch(error){await fs.unlink(file);throw error;}
    const result={file,sha256,bytes:(await fs.stat(file)).size,files:manifest.files.length,version:manifest.version,projectRef:manifest.projectRef,sourceOnly:true,embeddedServer:true,productionAccess:false,macRuntimeVerified:false,applicationNotarized:false};
    console.log(JSON.stringify(result,null,2));return result;
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
