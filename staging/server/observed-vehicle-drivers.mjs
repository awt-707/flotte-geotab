import { normalizeGeotabPlate } from './geotab-matching.mjs';
import { trustedVehicleObservation, vehicleObservationWindow } from './vehicle-evidence.mjs';

const RANK={on_trip:4,to_pickup:3,available:2,on_break:1};
const active=vehicle=>vehicle.active!==false&&String(vehicle.active).trim().toUpperCase()!=='NON';
const fresh=(at,now,ttl)=>Number.isFinite(at)&&at<=now+5000&&now-at<=ttl;

/** Display-only evidence from already RLS-filtered rows. This never assigns a
 * vehicle, links a Ludy identity or authorizes offline movement monitoring. */
export function observedVehicleDrivers({drivers=[],latest=[],vehicles=[],sources=[],now=Date.now()}={}){
 if(!Number.isFinite(now)||![drivers,latest,vehicles,sources].every(Array.isArray))return [];
 const known=new Set(drivers.map(driver=>driver?.id).filter(id=>typeof id==='string'&&id)),claims=[],uncertainDrivers=new Set(),ambiguousVehicles=new Set();
 for(const row of latest){
  if(!known.has(row?.driver_id)||!['uber','bolt'].includes(row?.source)||!RANK[row.status]||['suspended','deactivated'].includes(String(row.evidence?.account_status||'').toLowerCase())||!trustedVehicleObservation(row))continue;
  const sourceRows=sources.filter(source=>source?.id===row.source);if(sourceRows.length!==1)continue;
  const source=sourceRows[0],ttl=Number(source.stale_after_s)*1000,observed=Date.parse(row.observed_at),success=Date.parse(source.last_success_at);
  if(source.status!=='healthy'||!Number.isFinite(ttl)||ttl<=0||!fresh(observed,now,ttl)||!fresh(success,now,ttl))continue;
  const window=vehicleObservationWindow(row,source);
  if(!Number.isFinite(window.observed)||window.observed>observed||window.observed>now+5000||!Number.isFinite(window.expires)||window.expires<=now)continue;
  const plate=normalizeGeotabPlate(row.vehicle_label);if(!plate)continue;
  const matches=vehicles.filter(vehicle=>typeof vehicle?.key==='string'&&vehicle.key&&active(vehicle)&&[vehicle.key,vehicle.plate,...String(vehicle.other_plates||'').split(/[,;]/)].some(value=>normalizeGeotabPlate(value)===plate));
  if(matches.length!==1){uncertainDrivers.add(row.driver_id);for(const vehicle of matches)ambiguousVehicles.add(vehicle.key);continue;}
  const expires=Math.min(window.expires,observed+ttl,success+ttl);if(expires<=now)continue;
  claims.push({vehicle_key:matches[0].key,driver_id:row.driver_id,source:row.source,status:row.status,observed_at:new Date(observed).toISOString(),expires_at:new Date(expires).toISOString()});
 }
 const owners=new Map(),cars=new Map();
 for(const claim of claims){
  if(!owners.has(claim.vehicle_key))owners.set(claim.vehicle_key,new Set());owners.get(claim.vehicle_key).add(claim.driver_id);
  if(!cars.has(claim.driver_id))cars.set(claim.driver_id,new Set());cars.get(claim.driver_id).add(claim.vehicle_key);
 }
 const unique=new Map();
 for(const claim of claims){
  if(uncertainDrivers.has(claim.driver_id)||ambiguousVehicles.has(claim.vehicle_key)||owners.get(claim.vehicle_key).size!==1||cars.get(claim.driver_id).size!==1)continue;
  const key=claim.vehicle_key+':'+claim.driver_id+':'+claim.source,prior=unique.get(key);
  if(!prior||RANK[claim.status]>RANK[prior.status]||RANK[claim.status]===RANK[prior.status]&&Date.parse(claim.observed_at)>Date.parse(prior.observed_at))unique.set(key,claim);
 }
 return [...unique.values()].sort((a,b)=>a.vehicle_key.localeCompare(b.vehicle_key)||a.source.localeCompare(b.source));
}
