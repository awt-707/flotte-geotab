import fs from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {validateEmbeddedConfig}=require('../desktop/embedded-config.cjs');
const fields=new Set(['environment','projectRef','supabaseUrl','publishableKey','webOrigin']);

export function validateWebConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.has(key)))throw Error('Configuration web Ludy invalide.');
  const base=validateEmbeddedConfig(Object.fromEntries(['environment','projectRef','supabaseUrl','publishableKey'].map(key=>[key,value[key]])));
  let origin;try{origin=new URL(value.webOrigin);}catch{throw Error('Adresse HTTPS du site Ludy requise.');}
  if(typeof value.webOrigin!=='string'||origin.protocol!=='https:'||origin.origin!==value.webOrigin||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
    throw Error('Adresse HTTPS exacte du site Ludy requise.');
  return Object.freeze({...base,webOrigin:origin.origin});
}

export function readWebConfig(filename){
  const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Fichier de configuration web invalide.');
  return validateWebConfig(JSON.parse(fs.readFileSync(filename,'utf8')));
}

export function publicWebConfig(input){
  const config=validateWebConfig(input);
  return Object.freeze({SUPABASE_URL:config.supabaseUrl,SUPABASE_ANON_KEY:config.publishableKey,
    SUPABASE_PROJECT_REF:config.projectRef,ENVIRONMENT:'production',WEB_PRODUCTION:true,WEB_ORIGIN:config.webOrigin,
    DESKTOP_PRODUCTION:false,STAGING:false,GEOTAB_ENABLED:false,GEOTAB_LOCAL:true,SOURCE_MODE:'mixed',
    AUTH_STORAGE_KEY:`ludy-web-production-${config.projectRef}-auth`});
}
