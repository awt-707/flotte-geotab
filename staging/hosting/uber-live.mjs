import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {STAGING_ROOT} from '../scripts/paths.mjs';
import {privateDirectory,privateRead} from './auth-config.mjs';

const invalid=()=>Object.assign(Error('Configurez le fichier privé .local/hosting/uber-live.json avec l’UUID de la flotte Uber confirmée, et LUDY_LIVE_CHROMIUM avec un exécutable absolu.'),{exitCode:78});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)&&!/^0{8}-(?:0{4}-){3}0{12}$/.test(value);
export function liveMapUrl(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!uuid(value.organizationId))throw invalid();
 return 'https://fleethub.uber.com/orgs/'+value.organizationId.toLowerCase()+'/livemap';
}
function absoluteExecutable(value){return typeof value==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(value)&&path.normalize(value)===value&&!value.endsWith('/');}

/** Read-only validation. No URL, profile path or browser arguments come from the JSON file. */
export async function uberLivePlan({root=STAGING_ROOT,env=process.env}={}){
 try{
  const local=path.join(root,'.local'),directory=path.join(local,'hosting');
  await privateDirectory(local);await privateDirectory(directory);
  const bytes=await privateRead(path.join(directory,'uber-live.json'));
  if(Buffer.byteLength(bytes)>4096)throw invalid();
  const url=liveMapUrl(JSON.parse(bytes)),executable=env.LUDY_LIVE_CHROMIUM;
  if(!absoluteExecutable(executable))throw invalid();
  const binary=await fs.stat(executable);if(!binary.isFile()||(binary.mode&0o022)!==0)throw invalid();
  await fs.access(executable,constants.X_OK);
  const profile=path.join(local,'uber-live-browser');
  try{await privateDirectory(profile);}catch(error){if(error.code!=='ENOENT')throw error;}
  return {executable,profile,url,args:['--user-data-dir='+profile,'--no-first-run','--disable-session-crashed-bubble',url]};
 }catch{throw invalid();}
}

export async function runUberLive({root=STAGING_ROOT,env=process.env,spawnFn=spawn,signals=process}={}){
 const plan=await uberLivePlan({root,env});
 // Never repair/delete a browser profile or its Chromium singleton locks.
 await fs.mkdir(plan.profile,{recursive:true,mode:0o700});await privateDirectory(plan.profile);
 const child=spawnFn(plan.executable,plan.args,{env,stdio:['ignore','ignore','ignore'],shell:false,detached:false});
 let stopping=false;
 const stop=signal=>{stopping=true;child.kill(signal);};
 const interrupt=()=>stop('SIGINT'),terminate=()=>stop('SIGTERM');
 signals.on('SIGINT',interrupt);signals.on('SIGTERM',terminate);
 try{
  const result=await new Promise((resolve,reject)=>{
   child.once('error',()=>reject(Object.assign(Error('Le navigateur Live Map ne peut pas démarrer. Vérifiez Chromium et le bureau privé.'),{exitCode:70})));
   child.once('close',(code,signal)=>resolve({code,signal}));
  });
  return stopping?0:Number.isInteger(result.code)&&result.code>=0?result.code:70;
 }finally{signals.removeListener('SIGINT',interrupt);signals.removeListener('SIGTERM',terminate);}
}

export async function uberLiveCommand(args=process.argv.slice(2),options={}){
 if(args.length===1&&['--help','-h'].includes(args[0]))return {usage:'node staging/hosting/uber-live.mjs [--check]',configuration:'staging/.local/hosting/uber-live.json : {"organizationId":"UUID confirmé"}',browser:'LUDY_LIVE_CHROMIUM : chemin absolu',note:'Connexion humaine et association de l’extension requises. Aucun profil ni verrou n’est effacé.'};
 if(args.length===1&&args[0]==='--check'){await uberLivePlan(options);return {ok:true,configured:true,started:false};}
 if(args.length)throw invalid();
 return {exitCode:await runUberLive(options)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const result=await uberLiveCommand();if(Object.hasOwn(result,'exitCode'))process.exitCode=result.exitCode;else console.log(JSON.stringify(result,null,2));}
 catch(error){console.error(error.message);process.exitCode=error.exitCode||78;}
}
