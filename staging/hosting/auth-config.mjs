import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {STAGING_ROOT} from '../scripts/paths.mjs';
import {hostingConfig} from './config.mjs';

export const AUTH_VARIABLES={jwt_secret:'LUDY_HOSTING_JWT_SECRET',anon_key:'LUDY_HOSTING_ANON_KEY',service_role_key:'LUDY_HOSTING_SERVICE_KEY',publishable_key:'LUDY_HOSTING_PUBLISHABLE_KEY',secret_key:'LUDY_HOSTING_SECRET_KEY'};
export const SIGNING_PATH='../.local/hosting/signing-keys.json';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const failure=()=>Error('Préparation privée du serveur absente ou incohérente ; ouverture refusée.');

export async function privateDirectory(directory){
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||(process.getuid&&stat.uid!==process.getuid()))throw failure();
}
export async function privateRead(filename){
 const stat=await fs.lstat(filename);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size<1||stat.size>131072||(process.getuid&&stat.uid!==process.getuid()))throw failure();
 return fs.readFile(filename,'utf8');
}
function encode(value){return Buffer.from(JSON.stringify(value)).toString('base64url');}
function apiToken(role,key,kid,now){
 const body=encode({alg:'ES256',typ:'JWT',kid})+'.'+encode({iss:'supabase-demo',role,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+3650*86400});
 return body+'.'+sign('sha256',Buffer.from(body),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
export function createAuthSecrets(publicOrigin,{now=Date.now()}={}){
 hostingConfig({publicOrigin});
 const pair=generateKeyPairSync('ec',{namedCurve:'P-256'}),kid=randomUUID();
 const signingKey={...pair.privateKey.export({format:'jwk'}),kid,alg:'ES256',use:'sig',key_ops:['sign','verify']};
 return {version:1,cliVersion:'2.122.0',projectId:'ludy-staging',publicOrigin,createdAt:new Date(now).toISOString(),jwt_secret:randomBytes(64).toString('base64url'),anon_key:apiToken('anon',pair.privateKey,kid,now),service_role_key:apiToken('service_role',pair.privateKey,kid,now),publishable_key:'sb_publishable_'+randomBytes(32).toString('base64url'),secret_key:'sb_secret_'+randomBytes(32).toString('base64url'),signingKey};
}
export function renderAuthConfig(original){
 if(!/^project_id = "ludy-staging"$/m.test(original)||!/^\[auth\]$/m.test(original)||/https:\/\//i.test(original))throw failure();
 const fields=Object.keys(AUTH_VARIABLES).concat('signing_keys_path');
 const section=original.match(/^\[auth\]\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
 if(!section||fields.some(k=>new RegExp('^\\s*'+k+'\\s*=','m').test(section)))throw failure();
 const extra=Object.entries(AUTH_VARIABLES).map(([key,env])=>`${key} = "env(${env})"`).join('\n')+`\nsigning_keys_path = "${SIGNING_PATH}"\n`;
 return original.replace('[auth]\n','[auth]\n'+extra);
}
export function authEnvironment(secrets){return Object.entries(AUTH_VARIABLES).map(([key,env])=>`${env}=${secrets[key]}`).join('\n')+'\n';}
export function publicSigningKey(key){return {kty:key.kty,kid:key.kid,crv:key.crv,x:key.x,y:key.y,alg:key.alg};}
export function validateSecrets(value,{now=Date.now()}={}){
 try{
  if(value?.version!==1||value.cliVersion!=='2.122.0'||value.projectId!=='ludy-staging'||!Number.isFinite(Date.parse(value.createdAt)))throw failure();
  hostingConfig({publicOrigin:value.publicOrigin});
  if(!/^[A-Za-z0-9_-]{86}$/.test(value.jwt_secret)||!/^sb_publishable_[A-Za-z0-9_-]{43}$/.test(value.publishable_key)||!/^sb_secret_[A-Za-z0-9_-]{43}$/.test(value.secret_key))throw failure();
  const key=value.signingKey;
  if(key?.kty!=='EC'||key.crv!=='P-256'||key.alg!=='ES256'||!key.d||!key.kid||key.kid.length!==36)throw failure();
  const derived=createPublicKey(createPrivateKey({key,format:'jwk'})).export({format:'jwk'});
  if(derived.x!==key.x||derived.y!==key.y)throw failure();
  for(const [field,role]of [['anon_key','anon'],['service_role_key','service_role']]){
   const parts=value[field]?.split('.');if(parts?.length!==3)throw failure();
   const header=JSON.parse(Buffer.from(parts[0],'base64url')),body=JSON.parse(Buffer.from(parts[1],'base64url'));
   if(header.alg!=='ES256'||header.kid!==key.kid||body.role!==role||body.iss!=='supabase-demo'||body.exp*1000<now+86400000||body.iat*1000>now+60000||!verify('sha256',Buffer.from(parts.slice(0,2).join('.')),{key:createPublicKey({key:derived,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')))throw failure();
  }
  return value;
 }catch{throw failure();}
}
export async function readPrepared({root=STAGING_ROOT,publicOrigin,now=Date.now()}={}){
 try{
  const local=path.join(root,'.local'),directory=path.join(local,'hosting');
  await privateDirectory(local);await privateDirectory(directory);
  const value=validateSecrets(JSON.parse(await privateRead(path.join(directory,'auth-secrets.json'))),{now});
  if(publicOrigin&&value.publicOrigin!==publicOrigin)throw failure();
  const config=await fs.readFile(path.join(root,'supabase/config.toml'),'utf8');
  if(sha256(config)!==value.configSha256||await privateRead(path.join(directory,'auth.env'))!==authEnvironment(value))throw failure();
  const keys=JSON.parse(await privateRead(path.join(directory,'signing-keys.json')));
  if(JSON.stringify(keys)!==JSON.stringify([value.signingKey]))throw failure();
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(pkg.devDependencies?.supabase!=='2.122.0')throw failure();
  return value;
 }catch{throw failure();}
}
export async function initializeAuth({root=STAGING_ROOT,publicOrigin,now=Date.now()}={}){
 // Only a fresh server copy. Never rotate keys in an already bootstrapped staging.
 hostingConfig({publicOrigin});
 for(const relative of ['.local/runtime.json','.local/hosting/auth-secrets.json','supabase/.temp/project-ref','.supabase/project.json']){
  try{await fs.lstat(path.join(root,relative));throw failure();}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const filename=path.join(root,'supabase/config.toml');
 const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw failure();
 const original=await fs.readFile(filename,'utf8'),config=renderAuthConfig(original),secrets=createAuthSecrets(publicOrigin,{now});
 secrets.configSha256=sha256(config);
 const local=path.join(root,'.local'),directory=path.join(local,'hosting');
 await fs.mkdir(local,{recursive:true,mode:0o700});await privateDirectory(local);
 await fs.mkdir(directory,{recursive:true,mode:0o700});await privateDirectory(directory);
 // Every write is exclusive; an interrupted preparation requires deliberate review.
 for(const [name,content]of Object.entries({'original-config.toml':original,'signing-keys.json':json([secrets.signingKey]),'auth.env':authEnvironment(secrets),'auth-secrets.json':json(secrets)}))await fs.writeFile(path.join(directory,name),content,{mode:0o600,flag:'wx'});
 await fs.writeFile(filename+'.hosting-new',config,{mode:0o600,flag:'wx'});
 await fs.rename(filename+'.hosting-new',filename);
 await readPrepared({root,publicOrigin,now});
 return {ok:true,projectId:'ludy-staging',prepared:true};
}
