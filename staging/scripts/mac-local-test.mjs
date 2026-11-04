import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';

const readCommand=promisify(execFile);
const scriptRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

export function validateMacHost({platform,arch,nodeVersion,macVersion}) {
  if(platform!=='darwin')throw Error('Ce kit se prépare et se lance sur le Mac à tester.');
  if(!['arm64','x64'].includes(arch))throw Error('Architecture Mac non prise en charge : '+arch);
  const [major,minor]=String(nodeVersion).replace(/^v/,'').split('.').map(Number);
  if(!Number.isInteger(major)||!Number.isInteger(minor)||major<22||(major===22&&minor<12))throw Error('Installez Node.js LTS (22.12 ou plus récent) depuis https://nodejs.org/fr/download puis relancez ce script.');
  if(macVersion!==undefined&&(!/^\d+\./.test(macVersion)||Number(macVersion.split('.')[0])<13))throw Error('Ce test nécessite macOS 13 ou plus récent.');
}

export async function verifyKit(directory) {
  const root=await fs.realpath(directory);
  const manifestFile=path.join(root,'manifest.json');
  const stat=await fs.lstat(manifestFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Manifest du kit invalide.');
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(manifest.format!=='ludy-mac-local-kit-v1'||!Array.isArray(manifest.files)||manifest.files.length<6||manifest.files.length>64)throw Error('Format du kit invalide.');
  const seen=new Set();
  for(const entry of manifest.files) {
    if(typeof entry.path!=='string'||!entry.path||entry.path.includes('\\')||path.posix.isAbsolute(entry.path)||entry.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(entry.path)||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Entrée du manifest invalide.');
    seen.add(entry.path);
    const filename=path.join(root,entry.path),fileStat=await fs.lstat(filename);
    if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.size>25*1024*1024||await fs.realpath(filename)!==filename)throw Error('Fichier du kit invalide : '+entry.path);
    const hash=createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    if(hash!==entry.sha256)throw Error('Fichier incomplet ou modifié : '+entry.path+'. Extrayez à nouveau le kit.');
  }
  for(const required of ['staging/scripts/mac-local-test.mjs','staging/scripts/build-desktop.mjs','staging/scripts/paths.mjs','staging/desktop/package.json','staging/desktop/package-lock.json','staging/desktop/main.cjs']) {
    if(!seen.has(required))throw Error('Fichier absent du manifest : '+required);
  }
  return manifest;
}

function runProcess(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',...options});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(Error(path.basename(command)+' interrompu ('+(signal||'code '+code)+'). Copiez le message affiché dans le Terminal.')));
  });
}

export async function runMacLocalTest({
  root=scriptRoot,
  host={platform:process.platform,arch:process.arch,nodeVersion:process.versions.node},
  verify=verifyKit,
  readMacVersion=async()=>(await readCommand('/usr/bin/sw_vers',['-productVersion'])).stdout.trim(),
  checkTools=async()=>{await fs.access('/usr/bin/codesign',constants.X_OK);await fs.access('/usr/bin/curl',constants.X_OK);},
  run=runProcess,
  loadBuilder=async(directory)=>await import(pathToFileURL(path.join(directory,'staging/scripts/build-desktop.mjs')).href),
  log=console.log
}={}) {
  // Refuse a wrong host or damaged source kit before any dependency download.
  validateMacHost(host);
  validateMacHost({...host,macVersion:await readMacVersion()});
  await verify(root);
  await checkTools();
  log('Kit vérifié. Installation des outils de construction (quelques minutes)…');
  await run('npm',['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:path.join(root,'staging/desktop'),
    env:{...process.env,ELECTRON_SKIP_BINARY_DOWNLOAD:'1'}
  });
  log('Construction et signature locale de Ludy pour ce Mac…');
  const {main}=await loadBuilder(root);
  const result=await main(['--draft','--target','macos-'+host.arch,'--mac-local-test']);
  const output=result?.outputs?.[0];
  if(result?.outputs?.length!==1||output?.target!=='macos-'+host.arch||output?.signing!=='adhoc-local-test'||output?.signatureVerified!==true||output?.notarized!==false||output?.distributable!==false||!path.isAbsolute(output?.appPath||''))throw Error('Le paquet Mac ne présente pas la signature locale vérifiée attendue. Le lancement est annulé.');
  log('Signature locale vérifiée. Démarrage du diagnostic hors connexion…');
  log('À la fin, enregistrez le rapport JSON proposé et transmettez-le à la personne qui prépare Ludy.');
  await run(path.join(output.appPath,'Contents/MacOS/Ludy Staging'),['--diagnostic'],{cwd:output.folder});
  log('Diagnostic fermé. Le résultat des contrôles figure dans le rapport JSON enregistré.');
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runMacLocalTest().catch(error=>{console.error('\nPréparation arrêtée : '+error.message);process.exitCode=1;});
