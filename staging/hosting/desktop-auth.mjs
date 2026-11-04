import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

export async function assertPrivateFile(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size===0||stat.size>16384)throw Error('Fichier privé régulier 0600 requis.');}
export async function prepareDisplay({directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.local/hosting'),checkVnc=false,run=spawnSync}={}){
 await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700)throw Error('Le dossier du bureau doit être privé (0700).');
 if(checkVnc){await assertPrivateFile(path.join(directory,'vnc.pass'));return {ok:true,vnc:'configured'};}
 const authority=path.join(directory,'Xauthority');
 try{await assertPrivateFile(authority);return {ok:true,created:false};}catch(error){if(error.code!=='ENOENT')throw error;}
 const handle=await fs.open(authority,'wx',0o600);await handle.close();
 const result=run('/usr/bin/xauth',['-f',authority,'source','-'],{input:'add :99 . '+randomBytes(16).toString('hex')+'\n',encoding:'utf8',timeout:5000,maxBuffer:16384});
 if(result.error||result.status!==0){await fs.rm(authority,{force:true});throw Error('Initialisation privée Xauthority impossible ; vérifiez xauth.');}
 await assertPrivateFile(authority);return {ok:true,created:true};
}
async function main(){const args=process.argv.slice(2);if(args.length&&!(args.length===1&&args[0]==='--check-vnc'))throw Error('Option non reconnue.');console.log(JSON.stringify(await prepareDisplay({checkVnc:args.includes('--check-vnc')})));}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
