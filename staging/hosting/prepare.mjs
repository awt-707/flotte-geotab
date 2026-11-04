import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {renderHosting,writeRendered} from './config.mjs';

export function parsePrepareArgs(args){
 if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
 const result={},keys={'--origin':'publicOrigin','--root':'root','--user':'user','--node':'node','--chromium':'chromium','--out':'out'};
 for(let i=0;i<args.length;i+=2){const key=keys[args[i]];if(!key||result[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('Option inconnue, dupliquée ou incomplète. Utilisez --help.');result[key]=args[i+1];}
 return result;
}
async function main(){
 const input=parsePrepareArgs(process.argv.slice(2));
 if(input.help){console.log('node staging/hosting/prepare.mjs --origin https://staging.example.com [--root /opt/ludy/current] [--user ludy] [--node /usr/bin/node] [--chromium /usr/bin/chromium] [--out DOSSIER_NOUVEAU]\nSans --out : simulation, aucun fichier écrit, aucune connexion distante. --out génère seulement les fichiers à relire ; aucune installation ni activation.\n--chromium configure la Live Map uniquement. Les rapports utilisent le Chromium fourni par la version Playwright épinglée.');return;}
 const rendered=await renderHosting(input),output=input.out?await writeRendered(input.out,rendered):null;
 console.log(JSON.stringify({mode:output?'prepared':'dry-run',publicOrigin:rendered.config.publicOrigin,root:rendered.config.root,files:Object.keys(rendered.files),output,installed:false,started:false},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
