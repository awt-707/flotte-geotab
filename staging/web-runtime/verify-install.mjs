import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readWebConfig} from './config.mjs';
import {initializePrivateRoot} from '../server/private-files.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyWebInstallation({runtimeRoot,configPath,stateDir,manifestSha256}){
  runtimeRoot=await fs.realpath(runtimeRoot);
  if(!path.isAbsolute(stateDir||''))throw Error('Le dossier prive web doit etre distinct du programme.');
  const relativeState=path.relative(runtimeRoot,path.resolve(stateDir));
  if(relativeState===''||relativeState!=='..'&&!relativeState.startsWith('..'+path.sep)&&!path.isAbsolute(relativeState))throw Error('Le dossier prive web doit etre distinct du programme.');
  if(!/^[a-f0-9]{64}$/.test(manifestSha256||''))throw Error('Empreinte du manifeste requise.');
  readWebConfig(configPath);
  const bytes=await fs.readFile(path.join(runtimeRoot,'build-manifest.json'));
  if(digest(bytes)!==manifestSha256)throw Error('Manifeste web different de la livraison.');
  const manifest=JSON.parse(bytes);
  if(manifest.format!=='ludy-web-runtime-v1'||manifest.collector!==false||manifest.configurationEmbedded!==false||!Array.isArray(manifest.sources)||!Array.isArray(manifest.dependencies))throw Error('Manifeste web invalide.');
  const entries=[...manifest.sources,...manifest.dependencies.map(item=>({...item,path:'node_modules/'+item.path}))],seen=new Set();
  for(const entry of entries){
    if(typeof entry.path!=='string'||!entry.path||entry.path.split('/').some(part=>!part||part==='.'||part==='..')||entry.path.includes('\\')||path.isAbsolute(entry.path)||seen.has(entry.path)||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Fichier manifeste invalide.');
    seen.add(entry.path);const filename=path.resolve(runtimeRoot,entry.path);
    if(!filename.startsWith(runtimeRoot+path.sep)||await fs.realpath(filename)!==filename)throw Error('Chemin web invalide.');
    const stat=await fs.lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==entry.bytes||digest(await fs.readFile(filename))!==entry.sha256)throw Error('Fichier web different de la livraison.');
  }
  for(const required of ['web-runtime/main.mjs','web-runtime/server.mjs','web-runtime/services.mjs','site/index.html'])if(!seen.has(required))throw Error('Livraison web incomplete.');
  await initializePrivateRoot(stateDir);
  return {verified:true,version:manifest.version,files:entries.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args={};
  for(let i=2;i<process.argv.length;i++){
    const name=process.argv[i];if(!['--config','--state-dir','--manifest-sha256'].includes(name)||args[name]||!process.argv[i+1])throw Error('Options de verification invalides.');
    args[name]=process.argv[++i];
  }
  const result=await verifyWebInstallation({runtimeRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),configPath:args['--config'],stateDir:args['--state-dir'],manifestSha256:args['--manifest-sha256']});
  console.log(JSON.stringify(result));
}
