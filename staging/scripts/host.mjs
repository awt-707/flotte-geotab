import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRuntime } from './guard.mjs';
import { LOCAL_DIR, SITE_URL } from './paths.mjs';
import { hostingConfig } from '../hosting/config.mjs';
import { createShareGateway } from '../server/share-gateway.mjs';

export const HOST_PORT=4174;
export function readHostingConfig(filename=path.join(LOCAL_DIR,'hosting.json')) {
  let stat;try {stat=fs.lstatSync(filename);}catch {throw Error('Préparez staging/.local/hosting.json avec l’adresse HTTPS du serveur.');}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||(stat.mode&0o077)!==0)throw Error('La configuration d’hébergement doit être un fichier privé régulier (mode 600).');
  let input;try {input=JSON.parse(fs.readFileSync(filename,'utf8'));}catch {throw Error('Configuration d’hébergement illisible.');}
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='publicOrigin'))throw Error('Seule publicOrigin est attendue dans hosting.json.');
  const config=hostingConfig(input),host=new URL(config.publicOrigin).hostname;
  if(['supabase.co','supabase.com','supabase.in','ludy-flotte.pages.dev'].some(base=>host===base||host.endsWith('.'+base)))throw Error('Une adresse propre au staging est requise.');
  return {publicOrigin:config.publicOrigin};
}
export async function checkHosting({loadRuntime=readRuntime,loadConfig=readHostingConfig,verify,fetchFn=fetch}={}) {
  const runtime=loadRuntime(),config=loadConfig();
  const verifier=verify||(await import('../hosting/verify-runtime.mjs')).verifyHostedRuntime;
  const verified=await verifier(runtime,config);
  if(verified?.ok!==true||verified.projectId!=='ludy-staging')throw Error('La préparation sécurisée du serveur n’est pas confirmée.');
  const response=await fetchFn(SITE_URL+'/health',{redirect:'error',signal:AbortSignal.timeout(5000)});
  const marker=await response.json();
  if(!response.ok||marker.environment!=='staging'||marker.project!=='ludy-staging')throw Error('Démarrez le serveur Ludy staging avant la passerelle.');
  return {runtime,config};
}
export async function main(args=process.argv.slice(2)) {
  if(args.length===1&&['--help','-h'].includes(args[0])) {console.log('npm --prefix staging run host [-- --check]\nPasserelle du staging hébergé, liée uniquement à 127.0.0.1:4174.\nCaddy fournit HTTPS. Chaque utilisateur se connecte avec son compte Ludy.\nLe lancement exige des clés propres au serveur et des ports internes confinés.\n--check vérifie ces conditions sans ouvrir de port.');return;}
  if(args.length&&!(args.length===1&&args[0]==='--check'))throw Error('Option inconnue : utilisez --help.');
  const {runtime,config}=await checkHosting();
  if(args[0]==='--check'){console.log('Configuration du staging hébergé vérifiée. Aucun port ouvert.');return;}
  const gateway=createShareGateway({accessMode:'account',publicOrigin:config.publicOrigin,anonKey:runtime.anonKey,referenceData:fs.existsSync(path.join(LOCAL_DIR,'reference-import.json'))?'snapshot':'synthetic'});
  let stopped=false,timer,checking=false;
  const shutdown=async()=>{if(stopped)return;stopped=true;clearInterval(timer);await gateway.close();};
  const onSignal=()=>{void shutdown();};
  try {
    await new Promise((resolve,reject)=>{gateway.server.once('error',reject);gateway.server.listen(HOST_PORT,'127.0.0.1',resolve);});
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,onSignal);
    console.log('Passerelle Ludy staging active sur 127.0.0.1:'+HOST_PORT+' ; HTTPS : '+config.publicOrigin);
    timer=setInterval(async()=>{
      if(checking||stopped)return;checking=true;
      try {const latest=await checkHosting();if(latest.config.publicOrigin!==config.publicOrigin||latest.runtime.anonKey!==runtime.anonKey||latest.runtime.serviceKey!==runtime.serviceKey)throw Error('Configuration modifiée.');}
      catch {console.error('La vérification du serveur a échoué. Passerelle fermée ; contrôlez la configuration avant de redémarrer.');process.exitCode=1;await shutdown();}
      finally {checking=false;}
    },60000);timer.unref();
    await new Promise(resolve=>gateway.server.once('close',resolve));
  } finally {await shutdown();for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,onSignal);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.code==='EADDRINUSE'?'Le port 4174 est déjà utilisé par une passerelle.':error.message||'Hébergement refusé.');process.exitCode=1;});
