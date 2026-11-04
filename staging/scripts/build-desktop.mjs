import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { STAGING_ROOT, LOCAL_DIR, ensureLocalDir } from './paths.mjs';

const DESKTOP = path.join(STAGING_ROOT, 'desktop');
const requireDesktop = createRequire(path.join(DESKTOP, 'package.json'));
const { validateConfig } = requireDesktop('./config.cjs');
export const CLIENT_FILES = Object.freeze([
  'main.cjs', 'config.cjs', 'diagnostic.cjs', 'shell-preload.cjs', 'client-ui.html', 'client-ui.css', 'client-ui.js',
  'assets/icon.png', 'assets/icon.ico', 'assets/icon.icns', 'assets/logo-ludy.png'
]);
export const TARGETS = Object.freeze({
  'linux-x64': { platform:'linux', arch:'x64', label:'Linux' },
  'windows-x64': { platform:'win32', arch:'x64', label:'Windows' },
  'macos-arm64': { platform:'darwin', arch:'arm64', label:'macOS-Apple-Silicon' },
  'macos-x64': { platform:'darwin', arch:'x64', label:'macOS-Intel' }
});
export function parseBuildArgs(args) {
  const result = { target:'all', kind:null, serverUrl:null };
  for (let i=0; i<args.length; i++) {
    const flag=args[i];
    if (['--help','-h'].includes(flag)) return { help:true };
    if (flag==='--target' && args[i+1]) result.target=args[++i];
    else if (flag==='--url' && args[i+1] && !result.kind) { result.kind='remote'; result.serverUrl=args[++i]; }
    else if (flag==='--local' && !result.kind) { result.kind='operator-local'; result.serverUrl='http://127.0.0.1:4173'; }
    else if (flag==='--draft' && !result.kind) result.kind='draft';
    else if (flag==='--mac-local-test' && !result.macLocalTest) result.macLocalTest=true;
    else throw Error('Option inconnue ou contradictoire : utilisez --help.');
  }
  if (!result.kind) throw Error('Précisez --url https://votre-staging, --local ou --draft.');
  if (result.target!=='all' && !TARGETS[result.target]) throw Error('Cible inconnue.');
  if (result.kind==='operator-local') {
    if (!['all','linux-x64'].includes(result.target)) throw Error('La version locale est réservée à Linux.');
    result.target='linux-x64';
  }
  validateConfig(buildConfig(result), {platform: result.kind==='operator-local'?'linux':'win32'});
  return result;
}
export function assertBuildHost(options, host={platform:process.platform,arch:process.arch}) {
  const targets=Object.entries(TARGETS).filter(([key])=>options.target==='all'||options.target===key);
  const macTargets=targets.filter(([,target])=>target.platform==='darwin');
  if (options.macLocalTest && (targets.length!==1 || macTargets.length!==1)) throw Error('--mac-local-test nécessite une cible explicite macos-arm64 ou macos-x64.');
  if (macTargets.length) {
    if (host.platform!=='darwin') throw Error('Construction Mac refusée sur cet ordinateur : les applications macOS doivent être construites et signées sur un Mac. Utilisez le kit de test Mac, ou --target linux-x64 / windows-x64.');
    if (!options.macLocalTest) throw Error('Aucune distribution Mac signée Developer ID et notariée n’est configurée. Pour un test sur ce Mac uniquement, précisez --mac-local-test et sa cible explicite.');
    if (macTargets[0][1].arch!==host.arch) throw Error('Le test Mac local doit cibler l’architecture du Node.js utilisé : '+host.arch+'.');
  }
  return targets;
}
export function macLocalSignOptions() {
  // Ad hoc signatures make the locally built code internally consistent. They
  // neither identify a developer nor make a downloaded app trusted by Gatekeeper.
  return {
    identity:'-', identityValidation:false, type:'development',
    preAutoEntitlements:false, preEmbedProvisioningProfile:false,
    continueOnError:false, strictVerify:true,
    optionsForFile:()=>({timestamp:'none',hardenedRuntime:false})
  };
}
export function buildConfig(options) {
  return {environment:'staging', serverUrl:options.serverUrl, appName:'Ludy Staging', ...(options.kind==='operator-local'?{mode:'operator-local'}:{})};
}
export async function prepareClientSource(destination, options, source=DESKTOP) {
  await fs.mkdir(destination, {recursive:true,mode:0o700});
  for (const relative of CLIENT_FILES) {
    const filename=path.join(source,relative), stat=await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || await fs.realpath(filename)!==filename) throw Error('Fichier client invalide : '+relative);
    await fs.mkdir(path.dirname(path.join(destination,relative)), {recursive:true});
    await fs.copyFile(filename,path.join(destination,relative));
  }
  const packageFile=path.join(source,'package.json'),packageStat=await fs.lstat(packageFile);
  if(!packageStat.isFile()||packageStat.isSymbolicLink()||packageStat.nlink!==1||packageStat.size>8192||await fs.realpath(packageFile)!==packageFile)throw Error('Manifest client invalide.');
  const original=JSON.parse(await fs.readFile(packageFile,'utf8'));
  // A new manifest and an explicit allowlist keep dependencies, server files,
  // credentials, browser profiles and downloaded reports out of every client.
  const manifest={name:original.name,version:original.version,productName:'Ludy Staging',main:'main.cjs',description:'Application de test Ludy',license:'UNLICENSED',private:true};
  await fs.writeFile(path.join(destination,'package.json'),JSON.stringify(manifest,null,2)+'\n');
  await fs.writeFile(path.join(destination,'server.json'),JSON.stringify(buildConfig(options),null,2)+'\n');
  return manifest;
}
async function run(command,args,options={}) {
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','ignore','pipe'],...options});let output='';child.stderr.on('data',data=>{output=(output+data).slice(-4000);});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(command+' : '+(output.trim()||'échec '+code))));});
}
async function sha256(filename) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(filename)) hash.update(chunk);return hash.digest('hex');
}
export async function downloadLock(filename,{pid=process.pid,host=hostname(),isAlive=value=>{try{process.kill(value,0);return true;}catch(error){return error.code!=='ESRCH';}}}={}) {
  const token=randomUUID(),candidate=filename+'.'+token+'.new';
  await fs.writeFile(candidate,JSON.stringify({pid,host,token}),{flag:'wx',mode:0o600});
  try {
    for(let attempt=0;attempt<2;attempt++) {
      try {await fs.link(candidate,filename);return async()=>{const current=JSON.parse(await fs.readFile(filename,'utf8').catch(()=>'null'));if(current?.token===token)await fs.rm(filename,{force:true});};}
      catch(error) {
        if(error.code!=='EEXIST')throw error;
        const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw Error('Verrou de téléchargement invalide.');
        let owner;try{owner=JSON.parse(await fs.readFile(filename,'utf8'));}catch{}
        const obsolete=owner?.host===host&&Number.isInteger(owner.pid)&&owner.pid>0&&!isAlive(owner.pid);
        if(!obsolete)throw Error('Ce runtime est déjà en téléchargement ; son verrou est conservé.');
        await fs.unlink(filename);
      }
    }
    throw Error('Le verrou de téléchargement a changé. Réessayez.');
  } finally {await fs.rm(candidate,{force:true});}
}
export async function electronZip(target,version) {
  const directory=path.join(LOCAL_DIR,'electron-zips');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const name=`electron-v${version}-${target.platform}-${target.arch}.zip`,filename=path.join(directory,name);
  const checksums=JSON.parse(await fs.readFile(path.join(DESKTOP,'node_modules','electron','checksums.json'),'utf8'));
  if (!/^[a-f0-9]{64}$/.test(checksums[name]||'')) throw Error('Somme officielle Electron absente pour '+name);
  if (await fs.stat(filename).catch(()=>null)) {
    if (await sha256(filename)!==checksums[name]) throw Error('Archive Electron locale invalide : '+name);
    return directory;
  }
  const temporary=filename+'.part',lock=filename+'.lock';
  const releaseLock=await downloadLock(lock);
  try {
    await run('curl',['--fail','--silent','--show-error','--location','--connect-timeout','20','--max-time','1200','--continue-at','-','--proto','=https','--proto-redir','=https','--output',temporary,`https://github.com/electron/electron/releases/download/v${version}/${name}`]);
    if (await sha256(temporary)!==checksums[name]) {await fs.rm(temporary,{force:true});throw Error('Téléchargement Electron non conforme à sa somme officielle.');}
    await fs.rename(temporary,filename);return directory;
  } finally {await releaseLock();}
}
async function verifyRemote(origin) {
  const {probeStaging}=requireDesktop('./main.cjs');
  await probeStaging(fetch,{serverUrl:new URL(origin).origin+'/'},AbortSignal.timeout(10000));
}
function instructions(options,target) {
  const launch=target.platform==='darwin'?'Ouvrez Ludy Staging.app.':target.platform==='win32'?'Ouvrez Ludy Staging.exe.':'Ouvrez le programme Ludy Staging dans le dossier extrait.';
  return ['LUDY STAGING — TESTS', '', options.kind==='draft'?'VERSION NON CONFIGURÉE : tests de lancement uniquement. L’adresse HTTPS du serveur Ludy reste à raccorder avant les essais métier.':options.kind==='operator-local'?'VERSION LOCALE : démarrez votre staging habituel sur ce PC avant de lancer cette application.':'Serveur : '+options.serverUrl,
    '', target.platform==='darwin'?'1. Conservez ce dossier sur le Mac où il a été construit.':'1. Extrayez entièrement le ZIP, en conservant tous les fichiers ensemble.', '2. '+launch, '3. Connectez-vous avec votre compte Ludy de test.', '',
    'Aucun mot de passe ni accès aux connecteurs n’est inclus dans cette archive.',
    target.platform==='darwin'?'TEST LOCAL UNIQUEMENT : signature ad hoc vérifiée, sans identité Developer ID ni notarisation Apple. Ce dossier n’est pas une distribution à transmettre à d’autres Mac. Le lancement et les fonctions natives restent à tester sur ce Mac.':target.platform==='win32'?'Cette construction n’est pas signée. Windows peut afficher un avertissement au premier lancement.':'Le ZIP conserve le droit d’exécution. La distribution Linux doit disposer d’un environnement graphique et prendre en charge le sandbox Chromium.',
    'Ne désactivez pas les protections du système. Contactez la personne qui vous a transmis Ludy si le lancement est refusé.',
    '', 'TEST DE LANCEMENT HORS CONNEXION',
    target.platform==='win32'?'Double-cliquez sur Tester Ludy.cmd.':target.platform==='darwin'?'Double-cliquez sur Tester Ludy.command.':'Lancez ./Tester-Ludy.sh depuis le dossier extrait.',
    'Ce test utilise une page fictive et aucun compte. Enregistrez le rapport JSON proposé à la fin et transmettez-le à la personne chargée de la validation.',
    'Il vérifie le conteneur, les fenêtres PDF et la préparation des exports. La connexion, les données métier et les notifications système doivent ensuite être testées sur la version reliée au serveur.',
    '', 'Les mises à jour du site et les données sont centralisées sur le serveur. Les mises à jour du conteneur de bureau nécessitent une nouvelle archive.', ''].join('\n');
}
export function diagnosticLauncher(platform) {
  if(platform==='win32')return {name:'Tester Ludy.cmd',text:'@echo off\r\nstart "" /wait "%~dp0Ludy Staging.exe" --diagnostic\r\n',mode:0o644};
  if(platform==='darwin')return {name:'Tester Ludy.command',text:'#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec "./Ludy Staging.app/Contents/MacOS/Ludy Staging" --diagnostic\n',mode:0o755};
  if(platform==='linux')return {name:'Tester-Ludy.sh',text:'#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec "./Ludy Staging" --diagnostic\n',mode:0o755};
  throw Error('Plateforme de test inconnue.');
}
export async function main(args=process.argv.slice(2)) {
  const options=parseBuildArgs(args);
  if (options.help) {console.log('npm --prefix staging run desktop:build -- --draft --target linux-x64|windows-x64\nnpm --prefix staging run desktop:build -- --url https://votre-staging --target linux-x64|windows-x64\nnpm --prefix staging run desktop:build -- --local\nSur Mac seulement : npm --prefix staging run desktop:build -- --draft --target macos-arm64|macos-x64 --mac-local-test\n--draft : versions non configurées, tests de lancement hors connexion uniquement.\n--local : application Linux pour le staging de ce PC.\n--mac-local-test : construction native et signature ad hoc pour le Mac utilisé ; aucun ZIP de distribution, aucune notarisation.\nLes sorties sont créées dans staging/.local/releases/desktop/. Aucun serveur, compte ou secret n’est inclus.');return;}
  // Refuse unsupported Mac output before probing a server, downloading a runtime,
  // or creating release files. Cross-packaging cannot repair macOS code seals.
  const targets=assertBuildHost(options);
  if (options.kind==='remote') await verifyRemote(options.serverUrl);
  ensureLocalDir();
  const releaseRoot=path.join(LOCAL_DIR,'releases','desktop');await fs.mkdir(releaseRoot,{recursive:true,mode:0o700});
  const temp=await fs.mkdtemp(path.join(releaseRoot,'.build-'));
  const source=path.join(temp,'client'),manifest=await prepareClientSource(source,options);
  const {packager}=await import(pathToFileURL(requireDesktop.resolve('@electron/packager')).href);
  const {listPackage,extractFile}=await import(pathToFileURL(requireDesktop.resolve('@electron/asar')).href);
  const versions=JSON.parse(await fs.readFile(path.join(DESKTOP,'package.json'),'utf8')).devDependencies;
  const outputs=[];
  try {
    for (const [key,target] of targets) {
      console.log('Préparation '+target.label+' '+target.arch+'…');
      const zipDirectory=await electronZip(target,versions.electron);
      const folders=await packager({dir:source,out:path.join(temp,'packages'),tmpdir:path.join(temp,'packager'),name:'Ludy Staging',executableName:'Ludy Staging',appBundleId:'com.ludy.staging',appCategoryType:'public.app-category.business',appVersion:manifest.version,buildVersion:manifest.version,platform:target.platform,arch:target.arch,electronVersion:versions.electron,electronZipDir:zipDirectory,icon:path.join(source,'assets','icon'),asar:true,prune:false,overwrite:false,...(target.platform==='darwin'?{osxSign:macLocalSignOptions()}:{}),win32metadata:{CompanyName:'Ludy',FileDescription:'Ludy Staging',ProductName:'Ludy Staging',InternalName:'Ludy Staging'}});
      const folder=folders[0],asar=target.platform==='darwin'?path.join(folder,'Ludy Staging.app','Contents','Resources','app.asar'):path.join(folder,'resources','app.asar');
      const entries=listPackage(asar).map(p=>p.replace(/^\//,''));
      const allowed=new Set([...CLIENT_FILES,'package.json','server.json','assets']);
      if (entries.some(name=>!allowed.has(name))) throw Error('Archive client avec contenu inattendu.');
      const actual=JSON.parse(extractFile(asar,'server.json').toString());validateConfig(actual,{platform:target.platform});
      if (JSON.stringify(actual)!==JSON.stringify(buildConfig(options))) throw Error('Configuration embarquée différente de la cible.');
      if (target.platform==='darwin') await run('codesign',['--verify','--deep','--strict','--verbose=2',path.join(folder,'Ludy Staging.app')]);
      await fs.writeFile(path.join(folder,'LIRE-MOI.txt'),instructions(options,target));
      const launcher=diagnosticLauncher(target.platform);
      await fs.writeFile(path.join(folder,launcher.name),launcher.text,{mode:launcher.mode});
      const suffix=(options.kind==='draft'?'-NON-CONFIGURE':options.kind==='operator-local'?'-LOCAL':'')+(target.platform==='darwin'?'-TEST-LOCAL':'');
      const name='Ludy-Staging-'+manifest.version+'-'+target.label+'-'+target.arch+suffix;
      const outputFolder=path.join(releaseRoot,name);
      // Never overwrite an earlier release: a timestamp suffix keeps it reviewable.
      const finalFolder=await fs.stat(outputFolder).then(()=>outputFolder+'-'+Date.now()).catch(()=>outputFolder);
      await fs.rename(folder,finalFolder);
      if (target.platform==='darwin') {
        outputs.push({target:key,folder:finalFolder,appPath:path.join(finalFolder,'Ludy Staging.app'),configured:options.kind!=='draft',signed:true,signing:'adhoc-local-test',signatureVerified:true,notarized:false,distributable:false,runtimeVerified:false});
        console.log(path.basename(finalFolder)+' — test local signé ad hoc ; aucun ZIP de distribution');
        continue;
      }
      const zipPath=finalFolder+'.zip';
      await run('zip',['-q','-r','-y',zipPath,path.basename(finalFolder)],{cwd:releaseRoot});
      const size=(await fs.stat(zipPath)).size;
      const hash=await sha256(zipPath);
      await fs.writeFile(zipPath+'.sha256',hash+'  '+path.basename(zipPath)+'\n');
      outputs.push({target:key,file:zipPath,bytes:size,sha256:hash,configured:options.kind!=='draft',signed:false});
      console.log(path.basename(zipPath)+' — '+Math.round(size/1024/1024)+' Mo');
    }
    const report={createdAt:new Date().toISOString(),environment:'staging',serverUrl:options.serverUrl,mode:options.kind,version:manifest.version,electron:versions.electron,outputs};
    await fs.writeFile(path.join(releaseRoot,'build-'+Date.now()+'.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } finally {await fs.rm(temp,{recursive:true,force:true});}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
