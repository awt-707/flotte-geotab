import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRuntime } from './guard.mjs';
import { API_URL, SITE_URL, LOCAL_DIR, PROJECT_ID, writePrivateJson } from './paths.mjs';
import { matchGeotabVehicles } from '../server/geotab-matching.mjs';

export async function associateGeotab(args=process.argv.slice(2)) {
  if(args.some(arg=>!['--apply','--start'].includes(arg))||args.includes('--start')&&!args.includes('--apply'))throw Error('Usage : npm --prefix staging run geotab:associate -- [--apply [--start]]');
  const runtime=readRuntime();
  const health=await fetch(SITE_URL+'/health',{redirect:'error',signal:AbortSignal.timeout(10000)});
  const marker=health.ok?await health.json():null;
  if(marker?.environment!=='staging'||marker?.project!==PROJECT_ID)throw Error('Serveur local ludy-staging requis.');
  const local=JSON.parse(await fs.readFile(path.join(LOCAL_DIR,'credentials.json'),'utf8'));
  if(local.environment!=='staging-local-only')throw Error('Compte administrateur local requis.');
  const login=await fetch(API_URL+'/auth/v1/token?grant_type=password',{method:'POST',redirect:'error',headers:{apikey:runtime.anonKey,'Content-Type':'application/json'},body:JSON.stringify({email:local.email,password:local.password}),signal:AbortSignal.timeout(10000)});
  if(!login.ok)throw Error('Connexion administrateur locale refusée.');
  const {access_token:token}=await login.json();
  const headers={apikey:runtime.anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const get=async table=>{
    const response=await fetch(API_URL+'/rest/v1/'+table,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Lecture du référentiel local refusée.');return response.json();
  };
  const api=async(action,body)=>{
    const response=await fetch(SITE_URL+'/api/fleet/geotab/'+action,{method:body===undefined?'GET':'POST',headers,redirect:'error',...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error('Opération locale Geotab '+action+' refusée (HTTP '+response.status+'). Consultez Connecteurs.');return response.json();
  };
  const env=await get('params?select=value&key=eq.environment');if(env[0]?.value!=='staging')throw Error('Marqueur staging absent.');
  const status=await api('status');if(!status.configured)throw Error('Connectez MyGeotab dans les Connecteurs du staging avant le rapprochement.');
  const vehicles=await get('vehicles?select=key,plate,other_plates,vin,geotab_id,geotab_name,geotab_auto_link_disabled,active&order=key');
  if(vehicles.length!==status.vehicles.length)throw Error('Référentiel local incomplet : rapprochement interrompu.');
  const result=matchGeotabVehicles(vehicles,status.devices);
  console.log(JSON.stringify({vehicles:vehicles.length,devices:status.devices.length,matches:result.matches.length,existing:result.existing.length,unmatched:result.unmatched.length,ambiguous:result.ambiguous.length,conflicts:result.conflicts.length}));
  if(!args.includes('--apply')){console.log('Simulation locale : aucune association modifiée. Ajouter --apply pour appliquer les correspondances uniques.');return;}
  if(result.matches.length){
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    writePrivateJson('geotab-associations-'+stamp+'.json',{at:new Date().toISOString(),before:vehicles.map(v=>({key:v.key,geotab_id:v.geotab_id,geotab_name:v.geotab_name})),matches:result.matches});
    for(const match of result.matches)await api('link',{vehicle_key:match.vehicle_key,device_id:match.device_id});
  }
  const after=await api('status');
  if(result.matches.some(match=>!after.vehicles.some(v=>v.key===match.vehicle_key&&v.geotab_id===match.device_id)))throw Error('Vérification des associations locales en échec.');
  console.log('Associations locales vérifiées : '+after.vehicles.filter(v=>v.geotab_id).length+'. Associations ambiguës et existantes conservées.');
  if(args.includes('--start')){const started=after.polling?after:await api('start',{});console.log('Suivi Geotab : '+(started.polling?'actif':'en pause')+'.');}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)associateGeotab().catch(error=>{console.error(error.message);process.exitCode=1;});
