// Native macOS CI packaging. Ad hoc integrity never implies Gatekeeper trust.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {STAGING_ROOT} from './paths.mjs';
import {validateMacHost} from './mac-local-test.mjs';
const require=createRequire(import.meta.url),execute=promisify(execFile);
const {readEmbeddedConfig}=require('../desktop/embedded-config.cjs');
const ARCHITECTURES=Object.freeze({'macos-arm64':'arm64','macos-x64':'x64'});
const host=()=>({platform:process.platform,arch:process.arch,nodeVersion:process.versions.node});
async function run(command,args,options={}) {return execute(command,args,{encoding:'utf8',maxBuffer:4*1024*1024,timeout:30*60*1000,...options});}
async function fileHash(filename){const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);return hash.digest('hex');}
const inside=(root,filename)=>filename===root||filename.startsWith(root+path.sep);

export function parseMacArtifactArgs(args) {
  const options={};
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(['--help','-h'].includes(flag)&&args.length===1)return{help:true};
    if(flag==='--check'&&!options.check){options.check=true;continue;}
    const key={'--config':'configPath','--target':'target','--output-dir':'outputDir'}[flag];
    if(!key||options[key]||!args[i+1]||args[i+1].startsWith('--'))throw Error('Options invalides : --config FICHIER --target macos-arm64|macos-x64 --output-dir DOSSIER [--check].');
    options[key]=key==='target'?args[++i]:path.resolve(args[++i]);
  }
  if(!options.configPath||!options.outputDir||!ARCHITECTURES[options.target])throw Error('Configuration publique, cible Mac explicite et dossier de sortie requis.');
  return options;
}
export function assertNativeMacTarget(target,current=host()) {
  if(!ARCHITECTURES[target])throw Error('Cible macOS inconnue.');
  validateMacHost(current);
  if(current.arch!==ARCHITECTURES[target])throw Error('Le runner et Node.js doivent utiliser l’architecture native '+ARCHITECTURES[target]+'.');
}
export function parseEmbeddedBuildOutput(output) {
  // Electron Packager writes progress messages to stdout before the builder's
  // final JSON object. Only accept a complete object at the end of the output.
  const text=String(output).trimEnd();
  const starts=[...text.matchAll(/^\{/gm)].map(match=>match.index).reverse();
  for(const start of starts){
    try{const value=JSON.parse(text.slice(start));if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
  }
  throw Error('Résultat JSON de construction invalide.');
}
export async function inventoryMacApp(filename) {
  const root=path.resolve(filename),rootStat=await fs.lstat(root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||path.basename(root)!=='Ludy.app')throw Error('Bundle Ludy.app régulier requis.');
  const canonical=await fs.realpath(root),entries=[];
  async function visit(relative='.') {
    const file=relative==='.'?canonical:path.join(canonical,relative),stat=await fs.lstat(file),base={path:relative,mode:stat.mode&0o7777};
    if(stat.mode&0o7000)throw Error('Permissions spéciales refusées dans le bundle : '+relative);
    if(stat.isSymbolicLink()){
      const target=await fs.readlink(file);
      if(path.isAbsolute(target)||!inside(canonical,path.resolve(path.dirname(file),target))||!inside(canonical,await fs.realpath(file)))throw Error('Lien extérieur au bundle refusé : '+relative);
      entries.push({...base,type:'symlink',target});
    }else if(stat.isDirectory()){
      entries.push({...base,type:'directory'});
      for(const name of (await fs.readdir(file)).sort()){
        if(/[\u0000-\u001f\\]/.test(name))throw Error('Nom de fichier invalide.');
        await visit(relative==='.'?name:relative+'/'+name);
      }
    }else if(stat.isFile()&&stat.nlink===1){entries.push({...base,type:'file',bytes:stat.size,sha256:await fileHash(file)});}
    else throw Error('Fichier non régulier refusé dans le bundle : '+relative);
  }
  await visit();return entries;
}
export function compareMacInventories(expected,actual){
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('L’archive ne conserve pas exactement les fichiers, permissions et liens du bundle.');
}
export function validateMacZipMembers(text){
  const names=text.trim().split('\n'),seen=new Set();
  if(!text.trim()||names.some(name=>{
    if(!name||/[\u0000-\u001f\\]/.test(name)||name!=='Ludy.app/'&&!name.startsWith('Ludy.app/')||name.split('/').some(part=>part==='.'||part==='..')||seen.has(name))return true;
    seen.add(name);return false;
  }))throw Error('L’archive doit contenir uniquement Ludy.app et ses ressources.');
  return names.length;
}
async function verifySignature(appPath,command){
  await command('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',appPath]);
  const display=await command('/usr/bin/codesign',['--display','--verbose=4',appPath]);
  if(!/^Signature=adhoc\s*$/m.test(display.stderr+'\n'+display.stdout))throw Error('Signature ad hoc attendue ; aucune identité Apple n’est configurée dans ce parcours.');
}
export function macArtifactReadme({version,target,file}) {
  return ['LUDY '+version+' — '+(target==='macos-arm64'?'MAC APPLE SILICON':'MAC INTEL'),'',
    'Cette archive contient une application compilée sur macOS avec son serveur local. Node.js et les sources ne sont pas nécessaires sur le Mac destinataire.',
    '1. Vérifiez que cette version correspond au processeur du Mac (Apple Silicon ou Intel).',
    '2. Quittez l’ancienne version par le menu Ludy > Quitter Ludy. Si Téléchargements contient déjà Ludy.app, déplacez ou renommez cette ancienne copie avant d’extraire le nouveau ZIP.',
    '3. Extrayez '+file+' dans Téléchargements sur le Mac pour obtenir exactement ~/Downloads/Ludy.app.',
    'Dans Terminal sur ce Mac, pour cette copie issue de l’archive vérifiée :', '',
    'xattr -cr ~/Downloads/Ludy.app',
    'open ~/Downloads/Ludy.app', '',
    'xattr efface récursivement les attributs étendus de cette application, dont la quarantaine ; open lance Ludy. Cette préparation n’est pas nécessaire à chaque ouverture.',
    '4. Connectez-vous à Ludy avec votre compte. La base de production est déjà préparée ; aucune migration ne doit être exécutée par les collègues.',
    '5. Sur les postes des collègues, laissez « Participer à la collecte » désactivé : le PC fixe centralise les connecteurs et les collègues consultent les données partagées avec leur propre compte.', '',
    'La signature ad hoc vérifie l’intégrité du bundle. Cette version n’est pas signée Developer ID et n’a pas été notariée par Apple. macOS peut donc refuser son ouverture après téléchargement. La réussite des contrôles de construction ne garantit pas une installation sans avertissement.',
    'Si macOS bloque cette application dont vous avez vérifié l’origine et l’empreinte, suivez la procédure Apple ciblée : Réglages Système > Confidentialité et sécurité > Ouvrir quand même, lorsque ce bouton est proposé pour Ludy. Cette autorisation concerne uniquement cette application ; elle ne désactive pas les protections globales.',
    'Procédure officielle : https://support.apple.com/fr-fr/102445',
    'Si ce bouton n’est pas proposé ou si macOS indique que le fichier est endommagé, conservez le message exact et demandez une nouvelle archive vérifiée ou une version Developer ID notariée.', '',
    'Vérification de l’archive depuis Terminal, dans ce dossier :',
    'shasum -a 256 -c "'+file+'.sha256"', '',
    'manifest.json décrit le résultat de construction et app-bundle-manifest.json les empreintes, permissions et liens du bundle. Aucun secret de fournisseur ni clé de service Supabase n’est embarqué.',
    'La construction ne lance pas l’application et ne contacte pas Supabase. Les essais métier et le lancement sur le Mac destinataire restent à effectuer.',''].join('\n');
}

export async function packageMacArtifact({appPath,outputDir,target,version,projectRef},{command=run,currentHost=host()}={}) {
  assertNativeMacTarget(target,currentHost);
  if(!/^\d+\.\d+\.\d+$/.test(version||'')||!/^[a-z0-9]{20}$/.test(projectRef||'')||!path.isAbsolute(appPath||'')||!path.isAbsolute(outputDir||''))throw Error('Métadonnées de construction invalides.');
  // Never reuse a prior output directory, even when empty.
  await fs.mkdir(path.dirname(outputDir),{recursive:true});
  await fs.mkdir(outputDir,{mode:0o700});
  const out=await fs.realpath(outputDir);let temporary;
  try{
    appPath=await fs.realpath(appPath);temporary=await fs.mkdtemp(path.join(path.dirname(out),'.ludy-macos-archive-'));temporary=await fs.realpath(temporary);
    const entries=await inventoryMacApp(appPath);
    const executable=entries.find(entry=>entry.path==='Contents/MacOS/Ludy');
    if(executable?.type!=='file'||!(executable.mode&0o111))throw Error('Exécutable Ludy absent ou non exécutable.');
    await verifySignature(appPath,command);
    const architecture=(await command('/usr/bin/lipo',['-archs',path.join(appPath,'Contents/MacOS/Ludy')])).stdout.trim();
    if(architecture!==(target==='macos-arm64'?'arm64':'x86_64'))throw Error('Architecture du bundle différente de la cible.');
    const name='Ludy-'+version+'-'+target+'-ADHOC-NON-NOTARISE.zip',archive=path.join(temporary,name);
    // Bundle files and framework symlinks are preserved. Resource forks/ACLs are
    // not part of this fresh Electron bundle; no __MACOSX side-tree is shipped.
    await command('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc',appPath,archive]);
    validateMacZipMembers((await command('/usr/bin/unzip',['-Z1',archive])).stdout);
    await command('/usr/bin/unzip',['-tq',archive]);
    const extracted=path.join(temporary,'extracted');await fs.mkdir(extracted);
    await command('/usr/bin/ditto',['-x','-k',archive,extracted]);
    const restored=path.join(extracted,'Ludy.app');
    compareMacInventories(entries,await inventoryMacApp(restored));
    await verifySignature(restored,command);
    const sha256=await fileHash(archive),file=path.join(out,name),sha256File=file+'.sha256',bundleManifestFile=path.join(out,'app-bundle-manifest.json'),readmeFile=path.join(out,'LIRE-MOI.txt');
    const bundle={format:'ludy-macos-app-bundle-v1',app:'Ludy.app',target,version,entries};
    const result={format:'ludy-macos-artifact-v1',version,target,projectRef,appPath,file,sha256,bytes:(await fs.stat(archive)).size,sha256File,bundleManifestFile,readmeFile,
      signing:'adhoc',signatureVerified:true,notarized:false,gatekeeperApproved:false,archiveVerified:true,permissionsVerified:true,symlinksVerified:true,embeddedServer:true,productionAccess:false,runtimeVerified:false};
    await fs.copyFile(archive,file,0x1);
    await fs.writeFile(sha256File,sha256+'  '+name+'\n',{flag:'wx',mode:0o644});
    await fs.writeFile(bundleManifestFile,JSON.stringify(bundle,null,2)+'\n',{flag:'wx',mode:0o644});
    await fs.writeFile(readmeFile,macArtifactReadme({...result,file:name}),{flag:'wx',mode:0o644});
    await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o644});
    return result;
  }catch(error){await fs.rm(out,{recursive:true,force:true});throw error;}
  finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true});}
}
export async function buildMacArtifact(options,{command=run,currentHost=host(),packageArtifact=packageMacArtifact}={}) {
  const config=readEmbeddedConfig(options.configPath);
  if(options.check)return{configurationValid:true,target:options.target,projectRef:config.projectRef,productionAccess:false,readyForDeployment:false};
  assertNativeMacTarget(options.target,currentHost);
  const macVersion=(await command('/usr/bin/sw_vers',['-productVersion'])).stdout.trim();
  assertNativeMacTarget(options.target,{...currentHost,macVersion});
  try{await fs.lstat(options.outputDir);throw Error('Le dossier de sortie existe déjà. Choisissez un nouveau dossier.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const built=await command(process.execPath,[path.join(STAGING_ROOT,'scripts/build-embedded-desktop.mjs'),'--config',options.configPath,'--target',options.target,'--mac-local-test']);
  const result=parseEmbeddedBuildOutput(built.stdout);
  if(result?.target!==options.target||result.projectRef!==config.projectRef||result.signing!=='adhoc-local-test'||result.signed!==true||result.notarized!==false||result.distributable!==false||result.configured!==true||!path.isAbsolute(result.appPath||''))throw Error('Résultat de construction Mac incohérent.');
  return packageArtifact({...options,appPath:result.appPath,version:result.version,projectRef:result.projectRef},{command,currentHost});
}
export async function main(args=process.argv.slice(2)) {
  const options=parseMacArtifactArgs(args);
  if(options.help){console.log('node staging/scripts/build-macos-artifact.mjs --config PUBLIC.json --target macos-arm64|macos-x64 --output-dir DOSSIER [--check]\nConstruction native Mac et ZIP ad hoc vérifié. Aucune signature Developer ID ou notarisation Apple.');return;}
  const result=await buildMacArtifact(options);console.log(JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
