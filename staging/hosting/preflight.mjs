import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {STAGING_ROOT} from '../scripts/paths.mjs';
import {readRuntime} from '../scripts/guard.mjs';
import {privateRead} from './auth-config.mjs';
import {verifyHostedRuntime} from './verify-runtime.mjs';

export async function preflight(args,{run=spawnSync}={}){
 if(args.length===1&&args[0]==='--stack'){
  const config=JSON.parse(await privateRead(path.join(STAGING_ROOT,'.local/hosting.json')));
  return verifyHostedRuntime(readRuntime(),config);
 }
 if(args.length)throw Error('Utilisez sans argument (prérequis) ou --stack (contrôles actifs privés).');
 const release=await fs.readFile('/etc/os-release','utf8');
 const disk=await fs.statfs(STAGING_ROOT);
 const checks={ubuntu2404:os.platform()==='linux'&&/^ID=ubuntu$/m.test(release)&&/^VERSION_ID="24\.04"$/m.test(release),arm64:os.arch()==='arm64',node24:Number(process.versions.node.split('.')[0])>=24,cpu:os.availableParallelism()>=2,memory:os.totalmem()>=10*1024**3,disk:disk.bavail*disk.bsize>=40*1024**3};
 for(const [name,command,args]of [['docker','docker',['version']],['compose','docker',['compose','version']],['caddy','caddy',['version']],['tar','tar',['--version']],['systemd','systemctl',['--version']],['sockets','ss',['--version']]])checks[name]=run(command,args,{encoding:'utf8',timeout:15000}).status===0;
 return {ok:Object.values(checks).every(Boolean),checks,changed:false,note:'Prérequis seulement : ne valide ni DNS, ni quotas Oracle, ni pare-feu distant, ni secrets actifs.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const result=await preflight(process.argv.slice(2));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}catch(error){console.error(error.message);process.exitCode=1;}}
