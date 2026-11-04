import {createHash, randomUUID} from 'node:crypto';
import {parseMyClicarLocalTime} from './myclicar-contracts.mjs';

const fail=(status,message)=>Object.assign(Error(message),{status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const eventFingerprint=row=>createHash('sha256').update(JSON.stringify([row.city,row.title,row.place,row.starts_at,row.ends_at,row.source_date_text,row.time_precision])).digest('hex');
function localDate(input,key,required){
 const value=input[key+'_local'];
 if(!value&&!required)return null;
 const match=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/);
 if(!match)throw fail(400,required?'Date et heure de début requises.':'Date de fin invalide.');
 try{return parseMyClicarLocalTime(match[3]+'/'+match[2]+'/'+match[1]+' '+match[4]);}
 catch{throw fail(400,'Heure marocaine ambiguë ou inexistante. Choisissez une autre heure.');}
}
export function normalizeManualEvent(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Formulaire invalide.');
 const title=typeof input.title==='string'?input.title.trim():'',place=typeof input.place==='string'?input.place.trim():'';
 if(!title||title.length>240||!place||place.length>240||!['Casablanca','Marrakech'].includes(input.city))throw fail(400,'Renseignez un titre, une adresse et la ville.');
 const starts_at=localDate(input,'starts',true),ends_at=localDate(input,'ends',false);
 if(ends_at&&Date.parse(ends_at)<Date.parse(starts_at))throw fail(400,'La fin doit être après le début.');
 const row={title,place,city:input.city,starts_at,ends_at,source_url:'',source_date_text:'Saisie de l’agence',time_precision:'minute'};
 return {...row,fingerprint:eventFingerprint(row)};
}
// Manual events have no network collector, timer or startup side effect.
export function createEventCatalog({db}){
 async function mutate(action,id,input,user){
  if(!UUID.test(id))throw fail(400,'Événement invalide.');
  if(action!=='create'&&!/^[a-f0-9]{64}$/.test(input?.fingerprint||''))throw fail(400,'Version de l’événement requise.');
  const row=action==='delete'?null:normalizeManualEvent(input);
  const result=await db('rpc/ops_mutate_manual_event',{method:'POST',body:{p_action:action,p_id:id,p_expected:action==='create'?null:input.fingerprint,p_row:row,p_user:user}});
  if(result?.conflict)throw fail(409,'Cet événement a changé. Relisez sa nouvelle version avant de modifier ou supprimer.');
  if(result?.missing)throw fail(404,'Événement introuvable.');
  if(!result?.ok)throw fail(502,'Enregistrement momentanément indisponible.');
  return result;
 }
 return {create:(input,user)=>mutate('create',input.request_id||randomUUID(),input,user),update:(id,input,user)=>mutate('update',id,input,user),remove:(id,input,user)=>mutate('delete',id,input,user)};
}
