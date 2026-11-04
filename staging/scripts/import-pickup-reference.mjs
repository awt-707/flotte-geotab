#!/usr/bin/env node
import path from 'node:path';
import {constants} from 'node:fs';
import {open,mkdir,lstat,writeFile,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parsePickupReferenceCsv} from '../server/pickup-reference.mjs';
import {LOCAL_DIR,STAGING_ROOT} from './paths.mjs';

async function privateDirectory(directory){await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700)throw Error('Archive privée non sûre.');}
export async function main(args=process.argv.slice(2)){
 if(args.length!==2||args[0]!=='--file'||!path.isAbsolute(args[1]))throw Error('Utiliser --file avec le chemin absolu du CSV fourni.');
 const file=await open(args[1],constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
 try{const info=await file.stat();if(!info.isFile()||info.size>1024*1024)throw Error('Fichier CSV invalide.');bytes=await file.readFile();}finally{await file.close();}
 const csv=bytes.toString('utf8');if(!Buffer.from(csv).equals(bytes))throw Error('CSV UTF-8 requis.');
 const catalog=parsePickupReferenceCsv(csv,{filename:path.basename(args[1])});
 await privateDirectory(LOCAL_DIR);const parent=path.join(LOCAL_DIR,'pickup-references');await privateDirectory(parent);const archive=path.join(parent,catalog.source.sha256);await privateDirectory(archive);
 const original=path.join(archive,'original.csv');try{await writeFile(original,bytes,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const info=await lstat(original);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||!(await readFile(original)).equals(bytes))throw Error('Archive existante différente ou non privée.');}
 // Reviewed source data is serialized as one server module so the existing
 // source bundle includes it, without allowing arbitrary JSON/private files.
 await writeFile(path.join(STAGING_ROOT,'server/pickup-reference-data.mjs'),'// Supplied reference catalog, not ride coordinates or verified demand statistics.\nexport default '+JSON.stringify(catalog,null,2)+';\n');
 console.log(JSON.stringify({ok:true,entries:catalog.entries.length,zones:catalog.entries.filter(row=>row.kind==='zone').length,points:catalog.entries.filter(row=>row.kind==='point').length,source_sha256:catalog.source.sha256,database_writes:0,external_requests:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('Import local du référentiel refusé ; aucune écriture de courses.');process.exitCode=1;});
