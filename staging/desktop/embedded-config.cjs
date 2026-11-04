const fs=require('node:fs');
const path=require('node:path');
const LOCAL_ORIGIN='http://127.0.0.1:4173';
const fail=()=>{throw Error('Configuration publique Ludy invalide : projet Supabase et clé publique attendus.');};
function validateEmbeddedConfig(input) {
  const fields=['environment','projectRef','supabaseUrl','publishableKey'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key))||fields.some(key=>typeof input[key]!=='string'))fail();
  if(input.environment!=='production'||!/^[a-z0-9]{20}$/.test(input.projectRef)||input.supabaseUrl!=='https://'+input.projectRef+'.supabase.co')fail();
  const key=input.publishableKey;
  if(key.length>4096||/[\s\u0000-\u001f]/.test(key))fail();
  if(!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
    const parts=key.split('.');if(parts.length!==3||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part)))fail();
    let payload;try{payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}catch{fail();}
    if(payload.role!=='anon'||payload.ref!==input.projectRef)fail();
  }
  return Object.freeze(Object.fromEntries(fields.map(key=>[key,input[key]])));
}
function readEmbeddedConfig(filename) {
  const stat=fs.lstatSync(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)fail();
  return validateEmbeddedConfig(JSON.parse(fs.readFileSync(filename,'utf8')));
}
function parsed(value){try{const url=new URL(value);return url.username||url.password?null:url;}catch{return null;}}
function trustedEmbeddedURL(value,{blob=false}={}) {
  const url=parsed(value);if(!url)return false;
  if(blob&&url.protocol==='blob:'){const inner=parsed(url.pathname);return !!inner&&inner.origin===LOCAL_ORIGIN;}
  return url.origin===LOCAL_ORIGIN;
}
function allowedEmbeddedRequest(value,type,config) {
  if(trustedEmbeddedURL(value,{blob:true}))return true;
  const url=parsed(value);if(!url)return false;
  if(url.protocol==='data:')return ['image','font'].includes(type);
  if(url.origin===config.supabaseUrl||url.origin===config.supabaseUrl.replace(/^https:/,'wss:'))return ['xhr','webSocket','other','image','media'].includes(type);
  if(url.origin==='https://tile.openstreetmap.org')return type==='image';
  if(url.origin==='https://photon.komoot.io')return type==='xhr';
  return false;
}
function stateDirectory(app,config){return path.join(app.getPath('appData'),'Ludy',config.projectRef);}
module.exports={LOCAL_ORIGIN,validateEmbeddedConfig,readEmbeddedConfig,trustedEmbeddedURL,allowedEmbeddedRequest,stateDirectory};
