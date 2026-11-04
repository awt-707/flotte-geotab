// Source only. Never crawl .local, node_modules, deployment exports or Git.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const STAGING_SOURCE=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const STATIC=new Set(['.js','.css','.html','.png','.jpg','.jpeg','.svg','.ico','.ttf','.woff','.woff2','.webp','.txt','.webmanifest']);
const PART=/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export function allowedSource(relative){
 if(typeof relative!=='string'||relative.includes('\\'))return false;
 const parts=relative.split('/');if(parts.some(p=>!PART.test(p)||p==='node_modules'||p==='data'||p==='exports'||p==='backups'||p==='dist'||p==='coverage'))return false;
 if(relative==='package.json'||relative==='package-lock.json')return true;
 if(relative==='vendor/xlsx-0.20.3.tgz'||relative==='vendor/README.md')return true;
 const name=parts.at(-1),ext=path.extname(name);
 if(parts[0]==='site')return STATIC.has(ext)||relative==='site/_headers';
 if(parts[0]==='server')return ext==='.mjs'&&!name.endsWith('.test.mjs');
 if(parts[0]==='scripts')return (ext==='.mjs'&&!name.endsWith('.test.mjs'))||relative==='scripts/export-reference.sql'||relative==='scripts/certs/supabase-prod-ca-2021.crt';
 if(parts[0]==='supabase')return ['supabase/config.toml','supabase/seed.sql'].includes(relative)||parts.length===3&&parts[1]==='migrations'&&/^\d{14}_[A-Za-z0-9_-]+\.sql$/.test(name);
 if(parts[0]==='uber-extension')return ['.js','.mjs','.css','.html','.png','.svg'].includes(ext)||name==='manifest.json'||name==='manifest.firefox.json';
 if(parts[0]==='hosting')return ['.mjs','.md','.in'].includes(ext);
 return false;
}
export async function sourceManifest(root=STAGING_SOURCE){
 const base=path.resolve(root),entries=[];
 async function walk(directory,relative=''){
  for(const item of await fs.readdir(directory,{withFileTypes:true})){
   const rel=relative?relative+'/'+item.name:item.name;
   if(!PART.test(item.name)||['node_modules','data','exports','backups','dist','coverage'].includes(item.name))continue;
   if(!relative&&!['package.json','package-lock.json','site','server','scripts','supabase','uber-extension','hosting','vendor'].includes(item.name))continue;
   if(item.isSymbolicLink())throw Error('Lien symbolique refusé dans les sources à distribuer : '+rel);
   if(item.isDirectory()){await walk(path.join(directory,item.name),rel);continue;}
   if(!item.isFile()||!allowedSource(rel))continue;
   const file=path.join(directory,item.name),stat=await fs.lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>20*1024*1024)throw Error('Fichier source non régulier ou trop volumineux : '+rel);
   const bytes=await fs.readFile(file);entries.push({path:rel,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
 await walk(base);entries.sort((a,b)=>a.path.localeCompare(b.path));
 for(const required of ['package.json','package-lock.json','scripts/serve.mjs','scripts/guard.mjs','supabase/config.toml'])if(!entries.some(e=>e.path===required))throw Error('Source obligatoire absente : '+required);
 return {format:'ludy-staging-source-v1',files:entries,totalBytes:entries.reduce((n,f)=>n+f.bytes,0)};
}
export async function writeSourceBundle(output,{root=STAGING_SOURCE,run=spawnSync}={}){
 const manifest=await sourceManifest(root),destination=path.resolve(output);
 if(!destination.endsWith('.tar.gz'))throw Error('Le paquet doit porter le suffixe .tar.gz.');
 const directory=path.dirname(destination),temporary=path.join(directory,'.source-'+randomUUID()+'.tar.gz');
 await fs.access(directory);
 for(const filename of [destination,destination+'.manifest.json'])try{await fs.lstat(filename);throw Error('Le paquet ou son manifeste existe déjà.');}catch(error){if(error.code!=='ENOENT')throw error;}
 let linked=false,complete=false;
 try{
  const result=run('tar',['--create','--gzip','--file',temporary,'--format=pax','--owner=0','--group=0','--numeric-owner','--mode=600','--no-recursion','--directory',path.resolve(root),'--null','--files-from=-'],{
   input:manifest.files.map(e=>e.path).join('\0')+'\0',encoding:'utf8',timeout:60000,maxBuffer:1024*1024,
   env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!['TAR_OPTIONS','GZIP','BZIP2','XZ_OPT'].includes(key)))});
  if(result.error||result.status!==0)throw Error('Création du paquet source interrompue.');
  await fs.chmod(temporary,0o600);
  // Link is atomic and refuses a concurrently created destination.
  await fs.link(temporary,destination);
  linked=true;
  const bytes=await fs.readFile(destination),receipt={...manifest,archiveSha256:createHash('sha256').update(bytes).digest('hex')};
  await fs.writeFile(destination+'.manifest.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  complete=true;
  return {file:destination,files:manifest.files.length,bytes:bytes.length,sha256:receipt.archiveSha256,includesPrivateData:false};
 }finally{await fs.rm(temporary,{force:true});if(linked&&!complete)await fs.rm(destination,{force:true});}
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length===1&&['--help','-h'].includes(args[0])){console.log('node staging/hosting/bundle.mjs [--out /chemin/ludy-staging-source.tar.gz]\nSans --out : vérification et manifeste en mémoire, aucun paquet créé. Le paquet exclut données, secrets, profils navigateur, ZIP clients et dépendances installées.');return;}
 if(args.length&&!(args.length===2&&args[0]==='--out'))throw Error('Utilisez --help.');
 if(args.length)console.log(JSON.stringify(await writeSourceBundle(args[1]),null,2));
 else {const m=await sourceManifest();console.log(JSON.stringify({mode:'dry-run',files:m.files.length,bytes:m.totalBytes,includesPrivateData:false},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
