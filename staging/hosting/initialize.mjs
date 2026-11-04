import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initializeAuth,readPrepared} from './auth-config.mjs';

export async function initializeCommand(args,{run=spawnSync}={}){
 if(args.length===1&&args[0]==='--check'){await readPrepared();return {ok:true,prepared:true};}
 if(args.length===0||args.includes('--help'))return {dryRun:true,usage:'node hosting/initialize.mjs --initialize-server --origin https://staging.example.org',note:'Sur une copie serveur neuve uniquement, avant le premier démarrage. Aucun service activé.'};
 if(args.length!==3||args[0]!=='--initialize-server'||args[1]!=='--origin')throw Error('Arguments invalides.');
 const containers=run('docker',['--host=unix:///var/run/docker.sock','ps','-a','--filter','name=ludy-staging','--format','{{.Names}}'],{encoding:'utf8',timeout:15000});
 if(containers.status!==0||containers.stdout.trim())throw Error('Le projet Docker doit être absent avant la préparation du serveur.');
 return initializeAuth({publicOrigin:args[2]});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(await initializeCommand(process.argv.slice(2)),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
