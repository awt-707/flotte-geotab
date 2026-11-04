import {resolveBackendTarget} from './database-target.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {assertLocalSupabase,requestAllowed} from './fleet.mjs';
import {advanceParking,normalizeParkingZone,validParkingPoint,operatingAvailability,parkingSignedDistance} from './parking-domain.mjs';
import {conflictingVehicleAssignments} from './vehicle-evidence.mjs';
import {unusedParkedVehicle,lastKnownUnusedParking} from './unused-parked.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fold=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const ROW_KEYS={vehicles:'key',live_status:'vehicle_key',fleet_parking_state:'vehicle_key,zone_id',fleet_parking_events:'event_key',fleet_latest:'identity_id',fleet_myclicar_vehicles:'external_id',fleet_myclicar_contracts:'external_id',fleet_rotation_contracts:'external_id'};
const knownKind=(zone,types)=>{const label=fold([zone.name,...(zone.zone_types||[]).map(id=>types.find(t=>t.id===id)?.name||id)].join(' '));
 if(/exclu|interdit|non autorise|prohib|forbidden|restricted|no.?go/.test(label))return 'exclusion';
 if(/parking|stationnement|depot/.test(label))return 'parking';return null;};
export function createParkingApi({supabaseUrl,databaseTarget,anonKey,serviceKey,getGeotabZones,fetchFn=fetch,now=Date.now}){
 const base=resolveBackendTarget(supabaseUrl,databaseTarget);let queue=Promise.resolve(),cache=null,catalog=null,catalogPending=null,lastError=null,lastAt=null,pending=null,running=false,closed=false,sourceRevision=0;
 async function db(table,{params={},method='GET',body,token=serviceKey,prefer}={}){
  const response=await fetchFn(base+'/rest/v1/'+table+'?'+new URLSearchParams(params),{method,headers:{apikey:token===serviceKey?serviceKey:anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw fail(502,'Données des zones indisponibles');const text=await response.text();return text.trim()?JSON.parse(text):null;
 }
 async function list(table,params={},token=serviceKey){
  const order=(params.order||'').split(',').filter(Boolean);
  for(const key of (ROW_KEYS[table]||'id').split(','))if(!order.some(term=>term.split('.')[0]===key))order.push(key);
  const rows=[];for(let offset=0;offset<20000;offset+=1000){const part=await db(table,{params:{...params,order:order.join(','),limit:'1000',offset:String(offset)},token});if(!Array.isArray(part))throw fail(502,'Données locales invalides');rows.push(...part);if(part.length<1000)return rows;}throw fail(413,'Catalogue trop volumineux');
 }
 async function returnsForVehicles(keys){
  const rows=[],unique=[...new Set(keys)];
  // Positive return proof is vehicle-specific. Keep complete pagination inside
  // bounded filters; active contracts/platform claims remain global below.
  for(let offset=0;offset<unique.length;offset+=50)rows.push(...await list('fleet_rotation_contracts',{
   vehicle_key:'in.('+unique.slice(offset,offset+50).map(key=>JSON.stringify(String(key))).join(',')+')',end_at:'not.is.null',
   select:'external_id,vehicle_key,vehicle_external_id,status,effective_start_at,end_at,observed_at,details_verified,deleted',order:'vehicle_key,end_at.desc,external_id'
  }));
  return rows;
 }
 async function auth(req){const token=String(req.headers.authorization||'').match(/^Bearer (\S+)$/)?.[1];if(!token)throw fail(401,'Connexion Ludy requise');const response=await fetchFn(base+'/auth/v1/user',{headers:{apikey:anonKey,Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw fail(401,'Session expirée');const user=await response.json(),profile=(await db('profiles',{token,params:{user_id:'eq.'+user.id,select:'role'}}))?.[0];if(!['admin','manager','viewer'].includes(profile?.role))throw fail(403,'Accès flotte requis');return {token,user,role:profile.role};}
 async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>100000)throw fail(413,'Contour trop volumineux');chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw fail(400,'Formulaire invalide');}}
 async function source(){return (await db('fleet_sources',{params:{id:'eq.geotab',select:'id,status,last_success_at,stale_after_s'}}))?.[0]||{};}
 async function readCatalog(){
  if(catalog&&now()-catalog.at<300000)return catalog;
  if(catalogPending)return catalogPending;if(typeof getGeotabZones!=='function')throw fail(409,'Geotab non configuré');
  catalogPending=(async()=>{const result=await getGeotabZones();if(!Array.isArray(result?.zones)||!Array.isArray(result?.types))throw fail(502,'Catalogue Geotab invalide');catalog={...result,at:now()};return catalog;})().finally(()=>{catalogPending=null;});return catalogPending;
 }
 async function update(rows,health){
  const revision=sourceRevision;
  if(!cache||now()-cache.at>30000){const [zones,vehicles,saved,interruptions]=await Promise.all([list('fleet_parking_zones',{enabled:'eq.true',archived_at:'is.null',order:'id'}),list('vehicles',{select:'key,plate,geotab_id,agency_id'}),list('fleet_parking_state'),db('fleet_source_events',{params:{source:'eq.geotab',status:'neq.healthy',select:'at',order:'at.desc',limit:'1'}})]);cache={at:now(),zones:zones.filter(z=>z.archived_at==null),vehicles,interruptedAt:Date.parse(interruptions?.[0]?.at),sourceRevision:revision,states:new Map(saved.map(r=>[r.vehicle_key+':'+r.zone_id,r.state]))};}
  const snapshot=cache;if(!snapshot.zones.length){lastAt=new Date(now()).toISOString();lastError=null;return;}
  const next=new Map(snapshot.states),changed=[],events=[];
  for(const row of rows){const vehicle=snapshot.vehicles.find(v=>v.key===row.key);if(!vehicle)continue;
   for(const zone of snapshot.zones){const key=vehicle.key+':'+zone.id,previous=next.get(key),usable=previous&&Date.parse(previous.last_at)>snapshot.interruptedAt&&snapshot.sourceRevision===revision?previous:!Number.isFinite(snapshot.interruptedAt)&&snapshot.sourceRevision===revision?previous:null,result=advanceParking(usable,{vehicle,position:row,zones:[zone],source:health,now:now()});
    if(JSON.stringify(previous||null)===JSON.stringify(result.state))continue;
    changed.push({vehicle_key:vehicle.key,zone_id:zone.id,zone_revision:Number(zone.revision||1),previous_at:previous?.last_at||null,state:result.state});if(result.state)next.set(key,result.state);else next.delete(key);if(result.event)events.push(result.event);
   }
  }
  // State and transitions commit together; a retry cannot duplicate an entry.
  for(let offset=0;offset<changed.length;offset+=1000){if(closed||revision!==sourceRevision)return;const batch=changed.slice(offset,offset+1000),keys=new Set(batch.map(r=>r.vehicle_key+':'+r.zone_id));await db('rpc/fleet_commit_parking',{method:'POST',body:{p_states:batch,p_events:events.filter(e=>keys.has(e.vehicle_key+':'+e.zone_id))}});}
  if(cache===snapshot&&revision===sourceRevision){cache.states=next;cache.sourceRevision=revision;}lastAt=new Date(now()).toISOString();lastError=null;
 }
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const handler=async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:4173');if(!url.pathname.startsWith('/api/parking/'))return false;
  try{if(!requestAllowed(req))throw fail(403,'Origine refusée');const a=await auth(req),path=url.pathname.slice('/api/parking/'.length);
   if(path==='zones'&&req.method==='GET'){
    const [zones,agencies]=await Promise.all([
     list('fleet_parking_zones',{select:'id,name,kind,agency_id,shape,enabled,indicative,revision',archived_at:'is.null',order:'name,id'},a.token),
     list('agencies',{select:'id,name,city',order:'id'},a.token)
    ]);
    send(res,200,{zones,agencies});return true;
   }
   if(['overview','alerts'].includes(path)&&req.method==='GET'){
    const [vehicles,positions,zoneRows,states,eventRows,agencies,health,interruptions]=await Promise.all([
     list('vehicles',{select:'key,plate,other_plates,brand,model,agency_id,geotab_id,active,vin,myclicar_external_id'},a.token),list('live_status',{select:'vehicle_key,lat,lon,speed,state,last_pos_at,updated_at,ign_on'},a.token),list('fleet_parking_zones',{order:'name'},a.token),list('fleet_parking_state',{},a.token),path==='alerts'?Promise.resolve([]):db('fleet_parking_events',{params:{order:'observed_at.desc',limit:'200'},token:a.token}),path==='alerts'?Promise.resolve([]):list('agencies',{select:'id,name,city'},a.token),source(),db('fleet_source_events',{params:{source:'eq.geotab',status:'neq.healthy',select:'at',order:'at.desc',limit:'1'}})]);
    const zones=zoneRows.filter(zone=>zone.archived_at==null),byZone=new Map(zoneRows.map(zone=>[zone.id,zone]));
    const events=(eventRows||[]).map(event=>{const zone=byZone.get(event.zone_id);return {...event,zone_name:zone?.name||null,zone_kind:zone?.kind||null,zone_archived:zone?.archived_at!=null};});
    if(health.status!=='healthy')handler.invalidateSource();
    const interruptedAt=Date.parse(interruptions?.[0]?.at);
    const currentState=(state,v,p,z)=>state&&z?.enabled&&(z.kind!=='operating'||String(state.agency_id)===String(v.agency_id))&&state.device_id===v.geotab_id&&Number(state.zone_revision)===Number(z.revision||1)&&Date.parse(state.last_at)===Date.parse(p?.last_pos_at)&&(!Number.isFinite(interruptedAt)||Date.parse(state.last_at)>interruptedAt);
    const rows=vehicles.map(v=>{const p=positions.find(p=>p.vehicle_key===v.key),age=now()-Date.parse(p?.last_pos_at),sourceAge=now()-Date.parse(health.last_success_at),ttl=Math.min(Number(health.stale_after_s)*1000,120000),receivedAge=now()-Date.parse(p?.updated_at);
     const fresh=!!v.geotab_id&&validParkingPoint(p)&&health.status==='healthy'&&Number.isFinite(ttl)&&ttl>0&&Number.isFinite(age)&&age>=-5000&&age<=120000&&Number.isFinite(sourceAge)&&sourceAge>=-5000&&sourceAge<=ttl&&Number.isFinite(receivedAge)&&receivedAge>=-5000&&receivedAge<=ttl;
     const inside=states.filter(s=>s.vehicle_key===v.key&&s.state.zone_id===s.zone_id&&currentState(s.state,v,p,zones.find(z=>z.id===s.zone_id))).map(s=>({zone_id:s.zone_id,since_at:s.state.since_at}));
     const {vin,myclicar_external_id,...publicVehicle}=v;
     return {...publicVehicle,position:p?{lat:p.lat,lon:p.lon,at:p.last_pos_at,speed:fresh?p.speed:null,ign_on:fresh?p.ign_on:null,fresh}:null,zones:inside,parked:fresh&&Number.isFinite(p.speed)&&p.speed<=3&&inside.some(s=>zones.find(z=>z.id===s.zone_id)?.kind==='parking'),unused_parked:false};});
    const current=rows.filter(v=>v.active!==false&&String(v.active||'').toUpperCase()!=='NON');
    const alerts=current.filter(v=>v.position?.fresh).flatMap(v=>v.zones.filter(s=>zones.find(z=>z.id===s.zone_id)?.kind==='exclusion').map(s=>{
      const z=zones.find(z=>z.id===s.zone_id),state=states.find(x=>x.vehicle_key===v.key&&x.zone_id===s.zone_id)?.state,entered=!!state?.entry_event_key;
      const id=entered?state.entry_event_key:createHash('sha256').update(JSON.stringify(['presence',v.key,s.zone_id,state?.identity,s.since_at])).digest('hex');
      return {id,vehicle_key:v.key,plate:v.plate,zone_id:z.id,zone_name:z.name,category:'exclusion',label:'Zone d’exclusion',indicative:false,kind:entered?'entered':'presence',entered_at:entered?state.entry_observed_at:null,observed_at:s.since_at};
     }));
    const candidates=current.filter(v=>v.position?.fresh).map(v=>{
     const allowed=zones.filter(z=>z.enabled&&z.kind==='operating'&&z.agency_id!==null&&String(z.agency_id)===String(v.agency_id)).sort((a,b)=>String(a.id).localeCompare(String(b.id))),p=positions.find(p=>p.vehicle_key===v.key);
     const proofs=allowed.map(z=>({zone:z,state:states.find(s=>s.zone_id===z.id&&s.vehicle_key===v.key)?.state}));
     // Several city areas form a union: being in any one is permitted. Missing
     // evidence for any contour cannot be interpreted as being outside it.
     return proofs.length&&proofs.every(({zone:z,state:s})=>currentState(s,v,p,z)&&s.zone_id===null&&Number(s.outside_samples)>=2&&Number.isFinite(Date.parse(s.outside_confirmed_at))&&Date.parse(s.outside_confirmed_at)-Date.parse(s.outside_from_at)>=5000&&Date.parse(s.outside_confirmed_at)<=Date.parse(s.last_at))?{vehicle:v,proofs}:null;
    }).filter(Boolean);
    let platformData;
    const readPlatforms=()=>Promise.all([list('fleet_drivers',{select:'id,name,vehicle_key,ludy_driver_code,agency_id,vehicle_link_method,vehicle_link_evidence,link_evidence'}),list('fleet_latest',{select:'identity_id,driver_id,source,status,observed_at,vehicle_label,evidence'}),list('fleet_identities',{select:'id,driver_id,source'}),list('fleet_sources',{select:'id,status,last_success_at,stale_after_s,coverage'})]);
    if(candidates.length){
     // Service reads establish conflicts across accounts. Only vehicles already
     // authorized by the caller's RLS can enter the response below.
     platformData=await readPlatforms();const [drivers,latest,identities,sources]=platformData;
     const conflicts=conflictingVehicleAssignments({drivers,latest,sources,vehicles,now:now()});
     for(const {vehicle:v,proofs} of candidates){
      const matched=drivers.filter(d=>d.vehicle_key===v.key);if(matched.length!==1||conflicts.has(v.key))continue;
      const availability=operatingAvailability({driver:matched[0],vehicle:v,identities,latest,sources,now:now()});if(!availability)continue;
      const first=proofs[0].zone,indicative=proofs.some(p=>p.zone.indicative===true),observed=proofs.map(p=>p.state.outside_confirmed_at).sort().at(-1),id=createHash('sha256').update(JSON.stringify(['outside_operating',v.key,availability.driver_id,proofs.map(p=>[p.zone.id,p.state.identity,p.state.outside_from_at])])).digest('hex');
      const alert={id,vehicle_key:v.key,plate:v.plate,zone_id:first.id,zone_ids:proofs.map(p=>p.zone.id),zone_name:proofs.map(p=>p.zone.name).join(' / '),category:'outside_operating',label:'Disponible hors zone'+(indicative?' · contour indicatif':''),indicative,kind:'outside',entered_at:null,observed_at:observed,position_at:v.position.at,...availability};
      alerts.push(alert);v.operating_alert=alert;
     }
    }
    const parkedVehicles=[];
    const historicalParking=new Map(rows.filter(v=>v.position&&!v.position.fresh).map(v=>{
     const p=positions.find(p=>p.vehicle_key===v.key);
     const zone=validParkingPoint(p)&&p.ign_on===false&&Number.isFinite(p.speed)&&p.speed>=0&&p.speed<=3
      ?zones.filter(z=>z.enabled&&z.kind==='parking'&&parkingSignedDistance(p,z.shape)>=5).sort((a,b)=>String(a.id).localeCompare(String(b.id)))[0]:null;
     return [v.key,zone];
    }).filter(([,zone])=>zone));
    const parkingCandidates=rows.filter(v=>v.parked||historicalParking.has(v.key));
    if(parkingCandidates.length){
     // Optional local proof must never interrupt existing zone alerts. Global
     // evidence detects conflicts; only RLS-authorized vehicles enter the DTO.
     try{
      const [inventory,inventorySync,contracts,platforms,returns,returnSync]=await Promise.all([
       list('fleet_myclicar_vehicles',{current:'eq.true',select:'external_id,vehicle_key,plate,temporary_plate,vin,status,is_blocked,archived,deleted_at,current,reason,observed_at'}),
       db('fleet_inventory_sync',{params:{id:'eq.1',select:'status,last_success_at,counts'}}),
       list('fleet_myclicar_contracts',{current:'eq.true',select:'external_id,vehicle_key,vehicle_candidates,vehicle_external_id,plate,temporary_plate,status,deleted,end_at,current,observed_at'}),
       platformData?Promise.resolve(platformData):readPlatforms(),
       returnsForVehicles(parkingCandidates.map(v=>v.key)),
       db('fleet_rotation_sync',{params:{id:'eq.1',select:'status,last_success_at'}})
      ]);
      const [drivers,latest,identities,sources]=platforms;
      for(const row of parkingCandidates){
       const evidence={vehicle:{...vehicles.find(v=>v.key===row.key),...row},inventory,inventorySync:inventorySync?.[0],contracts,drivers,latest,identities,sources,returns,returnSync:returnSync?.[0],now:now()};
       row.unused_parked=unusedParkedVehicle(evidence);
       if(row.unused_parked){const parking=row.zones.filter(s=>zones.find(z=>z.id===s.zone_id)?.kind==='parking').sort((a,b)=>String(a.zone_id).localeCompare(String(b.zone_id)))[0];parkedVehicles.push({vehicle_key:row.key,position_at:row.position.at,parked_at:parking?.since_at||null,zone_name:zones.find(z=>z.id===parking?.zone_id)?.name||null});}
       else if(historicalParking.has(row.key)){
        const p=positions.find(p=>p.vehicle_key===row.key),zone=historicalParking.get(row.key);
        const historicalVehicle={...evidence.vehicle,parked:true,position:{...row.position,speed:p.speed,ign_on:p.ign_on,received_at:p.updated_at}};
        if(lastKnownUnusedParking({...evidence,vehicle:historicalVehicle})){
         const proof={vehicle_key:row.key,position_basis:'last_known_parking',presence_current:false,checked_at:new Date(now()).toISOString(),
          position_at:row.position.at,position_received_at:p.updated_at,ign_on:false,lat:p.lat,lon:p.lon,device_id:row.geotab_id,zone_name:zone.name};
         row.last_known_unused_parking=proof;parkedVehicles.push(proof);
        }
       }
      }
     }catch{ /* Unknown usage stays false; parked presence and alerts remain usable. */ }
    }
    if(path==='alerts'){send(res,200,{alerts,parked_vehicles:parkedVehicles,at:new Date(now()).toISOString()});return true;}
    send(res,200,{vehicles:rows,zones,events,agencies,alerts,source:health,detector:{at:lastAt,error:lastError},counts:{total:rows.length,current:current.length,tracked:current.filter(v=>v.geotab_id).length,fresh:current.filter(v=>v.position?.fresh).length,parked:current.filter(v=>v.parked).length,exclusion:current.filter(v=>v.position?.fresh&&v.zones.some(s=>zones.find(z=>z.id===s.zone_id)?.kind==='exclusion')).length,outside_operating:alerts.filter(a=>a.category==='outside_operating').length}});return true;
   }
   if(a.role!=='admin')throw fail(403,'Administrateur requis');
   if(path==='geotab'&&req.method==='GET'){const data=await readCatalog();send(res,200,{at:new Date(data.at).toISOString(),zones:data.zones.map(z=>({...z,suggested_kind:knownKind(z,data.types)})),types:data.types});return true;}
   if(path==='zones/archive'&&req.method==='POST'){
    const input=await body(req);if(!uuid(input.id)||!Number.isSafeInteger(input.revision)||input.revision<=0)throw fail(400,'Zone et version valides requises');
    const result=await db('rpc/fleet_archive_parking_zone',{method:'POST',body:{p_id:input.id,p_revision:input.revision,p_user:a.user.id}});
    if(result?.outcome==='missing')throw fail(404,'Zone introuvable');
    if(result?.outcome==='conflict')throw fail(409,'Cette zone a changé ou a déjà été supprimée. Actualisez la liste.');
    if(result?.outcome!=='archived'||!result.id||!result.revision||!result.archived_at)throw fail(502,'Archivage de la zone non confirmé');
    cache=null;send(res,200,{ok:true,id:result.id,revision:result.revision,archived_at:result.archived_at});return true;
   }
   if(path==='zones'&&req.method==='POST'){
    const input=await body(req);let provider=null;
    if(input.source_id){const data=await readCatalog();provider=data.zones.find(z=>z.id===input.source_id);if(!provider)throw fail(400,'Zone absente du catalogue Geotab');input.shape={type:'polygon',points:provider.points};input.name=input.name||provider.name;}
    const row=normalizeParkingZone(input);
    if(row.agency_id!==null){const agencies=await db('agencies',{params:{id:'eq.'+row.agency_id},token:a.token});if(agencies.length!==1)throw fail(400,'Agence introuvable');}
    row.updated_at=new Date(now()).toISOString();
    let savedId=input.id,savedRevision;
    if(input.id){if(!uuid(input.id)||input.revision!==undefined&&(!Number.isSafeInteger(input.revision)||input.revision<=0))throw fail(400,'Zone ou version invalide');const old=(await db('fleet_parking_zones',{params:{id:'eq.'+input.id}}))?.[0];if(!old)throw fail(404,'Zone introuvable');if(old.archived_at!=null||input.revision!==undefined&&input.revision!==Number(old.revision))throw fail(409,'Cette zone a changé ou a été supprimée. Actualisez la liste.');
     const saved=await db('fleet_parking_zones',{method:'PATCH',params:{id:'eq.'+input.id,revision:'eq.'+old.revision,archived_at:'is.null'},body:row,prefer:'return=representation'});
     if(!Array.isArray(saved)||saved.length!==1)throw fail(409,'Cette zone a changé pendant l’enregistrement. Actualisez la liste.');savedRevision=saved[0].revision;
    }
    else{
     row.source=provider?'geotab':'manual';row.source_id=provider?.id||null;
     if(provider){row.archived_at=null;row.archived_by=null;}
     if(!provider){row.id=input.request_id||randomUUID();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.id))throw fail(400,'Identifiant de création invalide');}
     const saved=await db('fleet_parking_zones',{method:'POST',params:{on_conflict:provider?'source,source_id':'id'},body:row,prefer:'resolution='+(provider?'merge-duplicates':'ignore-duplicates')+',return=representation'});
     const stored=saved?.[0]||(await db('fleet_parking_zones',{params:provider?{source:'eq.geotab',source_id:'eq.'+provider.id}:{id:'eq.'+row.id}}))?.[0];
     if(!stored?.id)throw fail(502,'Création non confirmée. Réessayez le même formulaire.');
     if(stored.archived_at!=null)throw fail(409,'Cette création a déjà été supprimée. Ouvrez un nouveau formulaire.');
     if(!provider&&(stored.source!=='manual'||JSON.stringify(normalizeParkingZone(stored))!==JSON.stringify(normalizeParkingZone(row))))throw fail(409,'Cette création existe déjà avec un autre contenu. Rouvrez sa fiche avant de modifier.');
     savedId=stored.id;
     savedRevision=stored.revision;
    }
    cache=null;send(res,200,{ok:true,id:savedId,revision:savedRevision});return true;
   }
   throw fail(404,'Route de zones inconnue');
  }catch(error){send(res,error.status||500,{error:error.status&&error.status<500?error.message:'Suivi des parkings momentanément indisponible'});return true;}
 };
 handler.onPositions=(rows,health)=>{
  if(closed)return Promise.resolve();pending={rows:Array.isArray(rows)?rows.map(row=>({...row})):[],health:{...health}};
  if(!running){running=true;queue=(async()=>{while(pending&&!closed){const next=pending;pending=null;try{await update(next.rows,next.health);}catch{cache=null;lastError='Détection des zones indisponible. Dernières observations conservées.';}}})().finally(()=>{running=false;});}
  // A slow local persistence task must not delay the two-second GPS collector.
  return Promise.resolve();
 };
 handler.flush=()=>queue;handler.invalidateSource=()=>{sourceRevision++;pending=null;if(cache)cache.sourceRevision=-1;};handler.close=()=>{closed=true;pending=null;};
 return handler;
}
