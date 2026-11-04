// Read-only compatibility check: temporary configuration, existing local Docker
// metadata only. Never starts/stops containers, bootstraps a DB or changes keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {STAGING_ROOT,CLI} from '../scripts/paths.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
import {initializeAuth,readPrepared,AUTH_VARIABLES} from '../hosting/auth-config.mjs';
if(process.argv.slice(2).join(' ')!=='--read-only-status')throw Error('Utilisez --read-only-status pour le contrôle local sans démarrage.');
assertLocalProject();
const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-hosting-cli-'));
try{
 await fs.mkdir(path.join(root,'supabase'));
 await fs.copyFile(path.join(STAGING_ROOT,'supabase/config.toml'),path.join(root,'supabase/config.toml'));
 await fs.copyFile(path.join(STAGING_ROOT,'package.json'),path.join(root,'package.json'));
 await initializeAuth({root,publicOrigin:'https://staging.example.org'});
 const secrets=await readPrepared({root}),env={...process.env,DO_NOT_TRACK:'1',SUPABASE_TELEMETRY_DISABLED:'1'};
 for(const [key,name]of Object.entries(AUTH_VARIABLES))env[name]=secrets[key];
 const result=spawnSync(CLI,['status','--workdir',root,'-o','json'],{env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
 if(result.status!==0)throw Error('Le parseur CLI n’a pas validé la préparation temporaire ; aucun détail sensible affiché.');
 const value=JSON.parse(result.stdout);
 if(value.ANON_KEY!==secrets.anon_key||value.SERVICE_ROLE_KEY!==secrets.service_role_key||value.PUBLISHABLE_KEY!==secrets.publishable_key||value.SECRET_KEY!==secrets.secret_key)throw Error('Les clés générées ne sont pas toutes reprises par CLI 2.122.0.');
 console.log('CLI 2.122.0 : configuration privée et quatre clés API acceptées. Configuration active inchangée ; aucune stack démarrée.');
}finally{await fs.rm(root,{recursive:true,force:true});}
