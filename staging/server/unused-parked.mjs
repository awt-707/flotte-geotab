import {currentPlatformObservation} from './platform-disconnections.mjs';
import {normalizeGeotabPlate} from './geotab-matching.mjs';
const vin=value=>String(value||'').trim().toUpperCase();
const fresh=(value,seconds,now)=>{const at=Date.parse(value);return Number.isFinite(at)&&at<=now+5000&&now-at<=seconds*1000;};
const healthy=(source,maxAge,now)=>source?.status==='healthy'&&Number.isFinite(Number(source.stale_after_s))&&Number(source.stale_after_s)>0&&fresh(source.last_success_at,Math.min(maxAge,Number(source.stale_after_s)),now);
const plates=vehicle=>new Set([vehicle?.key,vehicle?.plate,vehicle?.temporary_plate,...String(vehicle?.other_plates||'').split(/[,;]/)].map(normalizeGeotabPlate).filter(Boolean));
const intersects=(a,b)=>[...a].some(value=>b.has(value));

function verifiedReturn({vehicle,own,returns,returnSync,now}){
 if(returnSync?.status!=='healthy'||!fresh(returnSync.last_success_at,300,now))return null;
 const candidates=returns.filter(row=>row.vehicle_key===vehicle.key&&row.vehicle_external_id===own.external_id&&row.details_verified===true&&row.deleted===false&&row.status==='DONE'&&
  Date.parse(row.observed_at)===Date.parse(returnSync.last_success_at)&&Number.isFinite(Date.parse(row.effective_start_at))&&Number.isFinite(Date.parse(row.end_at))&&
  Date.parse(row.end_at)>=Date.parse(row.effective_start_at)&&Date.parse(row.end_at)<=now&&Date.parse(row.observed_at)>=Date.parse(row.end_at));
 return candidates.length?Math.max(...candidates.map(row=>Date.parse(row.end_at))):null;
}

/** Negative evidence is usable only with a complete, recent provider snapshot.
 * A missing driver link/duty or an old return is never proof of an unused car. */
function unusedVehicleUsage({vehicle,inventory=[],inventorySync,contracts=[],drivers=[],identities=[],latest=[],sources=[],returns=[],returnSync,now=Date.now()}){
 const source=id=>sources.filter(s=>s.id===id),myclicar=source('myclicar'),geotab=source('geotab');
 if(myclicar.length!==1||geotab.length!==1||!healthy(myclicar[0],300,now)||!healthy(geotab[0],120,now))return false;
 const count=myclicar[0].coverage?.contracts,at=Date.parse(myclicar[0].last_success_at);
 if(!Number.isSafeInteger(count)||count<0||contracts.length!==count||contracts.some(c=>c.current!==true||Date.parse(c.observed_at)!==at))return false;
 if(inventorySync?.status!=='healthy'||!fresh(inventorySync.last_success_at,300,now))return false;
 const current=inventory.filter(row=>row.current===true&&!row.archived),inventoryCount=inventorySync.counts?.current_vehicles;
 if(!Number.isSafeInteger(inventoryCount)||inventoryCount!==current.length||current.some(row=>Date.parse(row.observed_at)!==Date.parse(inventorySync.last_success_at)))return false;
 const own=current.filter(row=>row.vehicle_key===vehicle.key);
 if(own.length!==1||own[0].reason!=='matched'||own[0].external_id!==vehicle.myclicar_external_id||own[0].status!=='AVAILABLE'||own[0].is_blocked!==false||own[0].deleted_at!=null)return false;
 if(vin(vehicle.vin)&&vin(own[0].vin)&&vin(vehicle.vin)!==vin(own[0].vin))return false;
 const aliases=new Set([...plates(vehicle),...plates(own[0])]),knownVins=new Set([vin(vehicle.vin),vin(own[0].vin)].filter(Boolean));
 for(const c of contracts){
  // Even an ineligible/ambiguous or not-yet-confirmed IN_PROGRESS contract
  // prevents calling its possible vehicle unused.
  if(c.status!=='IN_PROGRESS'||c.deleted===true||Number.isFinite(Date.parse(c.end_at))&&Date.parse(c.end_at)<=now)continue;
  const catalog=inventory.filter(row=>row.external_id===c.vehicle_external_id);
  const ids=[c.vehicle_key,...(Array.isArray(c.vehicle_candidates)?c.vehicle_candidates:[])].filter(Boolean);
  if(ids.includes(vehicle.key)||c.vehicle_external_id===own[0].external_id||intersects(aliases,plates(c))||catalog.some(row=>row.vehicle_key===vehicle.key||intersects(aliases,plates(row))||vin(row.vin)&&knownVins.has(vin(row.vin))))return false;
  if(!ids.length&&!c.vehicle_external_id&&!plates(c).size)return false;
 }
 // A provider outage could conceal a current platform claim. A genuinely
 // unconfigured provider with no known account/observation does not block.
 for(const id of ['uber','bolt']){
  const rows=source(id),used=identities.some(i=>i.source===id)||latest.some(r=>r.source===id)||rows.some(s=>s.status!=='unconnected');
  if(used&&(rows.length!==1||!healthy(rows[0],id==='uber'?90:300,now)))return false;
 }
 const assigned=drivers.filter(d=>d.vehicle_key===vehicle.key);
 if(assigned.length>1||assigned.some(d=>d.vehicle_link_evidence?.assignment_conflict?.requires_confirmation===true))return false;
 const assignedIds=new Set(assigned.map(d=>d.id));
 const related=latest.filter(row=>['uber','bolt'].includes(row.source)&&(assignedIds.has(row.driver_id)||aliases.has(normalizeGeotabPlate(row.vehicle_label))));
 const returnedAt=verifiedReturn({vehicle,own:own[0],returns,returnSync,now});
 for(const d of assigned){if(!identities.some(i=>i.driver_id===d.id&&['uber','bolt'].includes(i.source)))return false;}
 for(const i of identities.filter(i=>assignedIds.has(i.driver_id)&&['uber','bolt'].includes(i.source))){if(related.filter(row=>row.identity_id===i.id).length!==1)return false;}
 for(const row of related){
  const identity=identities.filter(i=>i.id===row.identity_id&&i.driver_id===row.driver_id&&i.source===row.source);
  if(identity.length!==1)return false;
  // A verified actual return ends older, unassigned platform claims. Merely
  // disappearing from a list, an expired lease or AVAILABLE inventory cannot.
  const at=Date.parse(row.observed_at),vehicleAt=Date.parse(row.evidence?.vehicle_observed_at||row.observed_at);
  if(returnedAt!==null&&!assignedIds.has(row.driver_id)&&Number.isFinite(at)&&Number.isFinite(vehicleAt)&&at<=returnedAt&&vehicleAt<=returnedAt)continue;
  const inactive=['suspended','deactivated'].includes(String(row.evidence?.account_status||'').toLowerCase());
  if(!currentPlatformObservation(inactive?{...row,evidence:{...row.evidence,account_status:null}}:row,source(row.source)[0],now))return false;
  if(!inactive&&row.status!=='offline')return false;
 }
 return true;
}

export function unusedParkedVehicle(args){
 const {vehicle,now=Date.now()}=args;
 if(!vehicle?.parked||!vehicle.position?.fresh||!vehicle.geotab_id||!Number.isFinite(vehicle.position.speed)||vehicle.position.speed<0||vehicle.position.speed>3||vehicle.position.ign_on===true||!fresh(vehicle.position.at,120,now))return false;
 return unusedVehicleUsage(args);
}

// This proves current non-use but only a historical location. Poll receipt time
// must never replace the GPS timestamp or create a current parking entry.
export function lastKnownUnusedParking(args){
 const {vehicle,now=Date.now()}=args,p=vehicle?.position;
 if(!vehicle?.parked||!vehicle.geotab_id||!p||p.fresh!==false||p.ign_on!==false||!Number.isFinite(p.speed)||p.speed<0||p.speed>3||
  !Number.isFinite(p.lat)||!Number.isFinite(p.lon)||Math.abs(p.lat)>85||Math.abs(p.lon)>180||!fresh(p.at,7*86400,now)||now-Date.parse(p.at)<=120000)return false;
 const geotab=args.sources?.find(s=>s.id==='geotab');
 if(!healthy(geotab,120,now)||!fresh(p.received_at,Math.min(Number(geotab.stale_after_s),120),now))return false;
 return unusedVehicleUsage(args);
}
