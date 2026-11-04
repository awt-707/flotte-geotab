import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const HOSTING_ROOT=path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_NAMES=['Caddyfile','ludy-stack.service','ludy-app.service','ludy-gateway.service','ludy-display.service','ludy-desktop.service','ludy-vnc.service','ludy-uber-live.service','ludy-uber-reports.service'];
const absolute=value=>typeof value==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(value)&&path.normalize(value)===value&&!value.endsWith('/');
export function hostingConfig({publicOrigin,root='/opt/ludy/current',user='ludy',node='/usr/bin/node',chromium='/usr/bin/chromium'}={}){
 let url;try{url=new URL(publicOrigin);}catch{throw Error('Une origine HTTPS publique est requise.');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||
   !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname)||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local'))throw Error('Utilisez un nom DNS HTTPS sans chemin, port ou identifiants.');
 if(!absolute(root)||!absolute(node)||!absolute(chromium)||!/^\/[a-z]/i.test(root)||root==='/')throw Error('Les chemins doivent être absolus, normalisés et sans espaces.');
 if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)||user==='root')throw Error('Un compte système dédié non root est requis.');
 return {publicOrigin:url.origin,hostname:url.hostname,root,user,node,chromium,staging:path.join(root,'staging')};
}
export async function renderHosting(input){
 const config=hostingConfig(input),values={HOST:config.hostname,ROOT:config.root,STAGING:config.staging,USER:config.user,NODE:config.node,CHROMIUM:config.chromium};
 const files={};
 for(const name of TEMPLATE_NAMES){const template=await fs.readFile(path.join(HOSTING_ROOT,'templates',name+'.in'),'utf8');files[name]=template.replace(/\{\{([A-Z]+)\}\}/g,(_,key)=>{if(!Object.hasOwn(values,key))throw Error('Variable de modèle inconnue.');return values[key];});}
 files['hosting.json']=JSON.stringify({publicOrigin:config.publicOrigin},null,2)+'\n';
 return {config,files};
}
export async function writeRendered(directory,rendered){
 const output=path.resolve(directory);
 // New directory only: never overwrite installed units, private config or prior review.
 await fs.mkdir(output,{mode:0o700});
 try{for(const [name,content]of Object.entries(rendered.files))await fs.writeFile(path.join(output,name),content,{flag:'wx',mode:0o600});}
 catch(error){throw Error('Génération interrompue ; le dossier de sortie existe et doit être contrôlé avant une nouvelle tentative.',{cause:error});}
 return output;
}
