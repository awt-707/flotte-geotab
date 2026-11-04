import {createHash} from 'node:crypto';
import {trustedVehicleLease,conflictingVehicleAssignments} from './vehicle-evidence.mjs';
const stamp=value=>typeof value==='string'?Date.parse(value):NaN;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const fresh=(at,now)=>Number.isFinite(stamp(at))&&stamp(at)<=now+5000&&now-stamp(at)<=120000;
export function fuelDriver(vehicle,drivers,sources,conflicts,now){
 if(vehicle.agency_id==null||conflicts.has(vehicle.key))return null;
 const matches=drivers.filter(d=>d.vehicle_key===vehicle.key&&d.ludy_driver_code&&String(d.agency_id)===String(vehicle.agency_id));
 if(matches.length!==1)return null;const d=matches[0],proof=d.vehicle_link_evidence;
 if(proof?.assignment_conflict?.requires_confirmation)return null;
 if(d.vehicle_link_method==='manual')return d;
 const observed=stamp(proof?.observed_at),expires=stamp(proof?.expires_at),maxLease=d.vehicle_link_method==='myclicar_contract'?300000:180000;
 if(d.vehicle_link_method==='myclicar_contract'&&(proof?.source!=='myclicar'||proof.client_code!==d.ludy_driver_code||proof.vehicle_key!==vehicle.key)||d.vehicle_link_method==='platform_plate'&&!['uber','bolt'].includes(proof?.source)||proof?.vehicle_key&&proof.vehicle_key!==vehicle.key)return null;
 if(!['platform_plate','myclicar_contract'].includes(d.vehicle_link_method)||!trustedVehicleLease(proof)||!Number.isFinite(expires)||expires<=now||!Number.isFinite(observed)||observed>now+5000||expires<=observed||expires-observed>maxLease)return null;
 const source=sources.find(s=>s.id===proof.source),success=stamp(source?.last_success_at),ttl=Number(source?.stale_after_s);
 if(!source||source.status!=='healthy'||!Number.isFinite(success)||success>now+5000||observed>success+5000||!Number.isFinite(ttl)||ttl<=0||now-success>ttl*1000)return null;
 return d;
}
export function advanceFuel(previous,{vehicle,driver,row,settings,now=Date.now()}){
 if(!settings?.enabled||!driver||!finite(vehicle.ref_l100)||vehicle.ref_l100<=0||!row||row.id!==vehicle.geotab_id||!finite(row.odometer_m)||!finite(row.total_fuel_l)||row.odometer_m<0||row.total_fuel_l<0||!fresh(row.counter_at?.odometer_m,now)||!fresh(row.counter_at?.total_fuel_l,now)||!fresh(row.at,now))return {state:null,event:null};
 if(!finite(settings.min_distance_km)||settings.min_distance_km<5||settings.min_distance_km>100||!finite(settings.excess_pct)||settings.excess_pct<5||settings.excess_pct>200||!finite(settings.cooldown_minutes)||settings.cooldown_minutes<15||settings.cooldown_minutes>1440)return {state:null,event:null};
 // Counter samples must describe approximately the same instant. Otherwise a
 // recently updated fuel counter could be compared with an older odometer.
 if(Math.abs(stamp(row.counter_at.odometer_m)-stamp(row.counter_at.total_fuel_l))>5000)return {state:null,event:null};
 const observation=Math.min(stamp(row.counter_at.odometer_m),stamp(row.counter_at.total_fuel_l));
 const same=previous?.driver_code===driver.ludy_driver_code&&previous.device_id===vehicle.geotab_id&&previous.ref===vehicle.ref_l100&&previous.excess_pct===settings.excess_pct&&previous.min_distance_km===settings.min_distance_km&&previous.cooldown_minutes===settings.cooldown_minutes;
 const seed=()=>({driver_code:driver.ludy_driver_code,device_id:vehicle.geotab_id,ref:vehicle.ref_l100,excess_pct:settings.excess_pct,
  min_distance_km:settings.min_distance_km,cooldown_minutes:settings.cooldown_minutes,
  from_at:new Date(observation).toISOString(),at:new Date(observation).toISOString(),from_m:row.odometer_m,from_l:row.total_fuel_l,last_m:row.odometer_m,last_l:row.total_fuel_l,last_notice_at:same?previous.last_notice_at:null});
 if(same&&observation<=stamp(previous.at))return {state:previous,event:null};
 if(!same||observation-stamp(previous.at)>120000||row.odometer_m<previous.last_m||row.total_fuel_l<previous.last_l)return {state:seed(),event:null};
 const km=(row.odometer_m-previous.from_m)/1000,litres=row.total_fuel_l-previous.from_l;
 const next={...previous,at:new Date(observation).toISOString(),last_m:row.odometer_m,last_l:row.total_fuel_l};
 // Reject counter jumps instead of attributing them to a driver's behaviour.
 const elapsed=(observation-stamp(previous.at))/3600000;
 if((row.odometer_m-previous.last_m)/1000>Math.max(2,elapsed*220)||row.total_fuel_l-previous.last_l>Math.max(2,elapsed*100))return {state:seed(),event:null};
 if(km<settings.min_distance_km)return {state:next,event:null};
 const l100=100*litres/km;
 if(!Number.isFinite(l100)||l100<0||l100>100)return {state:seed(),event:null};
 const reset=seed();
 if(l100<=vehicle.ref_l100*(1+settings.excess_pct/100)||Number.isFinite(stamp(previous.last_notice_at))&&now-stamp(previous.last_notice_at)<settings.cooldown_minutes*60000)return {state:reset,event:null};
 const eventKey='fuel:'+createHash('sha256').update(JSON.stringify([vehicle.key,vehicle.geotab_id,driver.ludy_driver_code,previous.from_at])).digest('hex');
 return {state:{...reset,last_notice_at:new Date(now).toISOString()},event:{driverCode:driver.ludy_driver_code,eventKey,kind:'overconsumption',
  title:'Consommation élevée mesurée',message:`${l100.toFixed(1)} L/100 km mesurés sur ${km.toFixed(1)} km (référence ${vehicle.ref_l100.toFixed(1)}). Adoptez une conduite souple et évitez les accélérations inutiles. Si cela persiste, signalez-le à l’agence.`,
  observedAt:new Date(observation).toISOString(),evidence:{vehicle_key:vehicle.key,driver_id:driver.id,from_at:previous.from_at,to_at:new Date(observation).toISOString(),distance_km:km,fuel_l:litres,l100,reference_l100:vehicle.ref_l100,excess_pct:settings.excess_pct,method:'geotab_counter_difference',cause:'undetermined'}}};
}
export function createFuelCoach({db,list,notify,now=Date.now}){
 let pending=null,lastError=null,lastAt=null,summary={measured:0,missing_reference:0,unassigned:0,queued:0};
 async function perform(rows){
  const [settings,vehicles,drivers,sources,latest,checkpoints]=await Promise.all([
   db('ops_fuel_settings',{params:{id:'eq.1'}}),list('vehicles',{select:'key,plate,agency_id,geotab_id,other_plates,ref_l100'}),list('fleet_drivers'),list('fleet_sources'),list('fleet_latest'),list('ops_fuel_checkpoints')
  ]);
  const at=now(),conflicts=conflictingVehicleAssignments({vehicles,drivers,sources,latest,now:at}),old=new Map(checkpoints.map(r=>[r.vehicle_key,r.state]));
  const stats={measured:0,missing_reference:0,unassigned:0,queued:0};
  for(const vehicle of vehicles){
   const driver=fuelDriver(vehicle,drivers,sources,conflicts,at),row=rows.find(r=>r.key===vehicle.key),next=advanceFuel(old.get(vehicle.key),{vehicle,driver,row,settings:settings?.[0],now:at});
   if(!vehicle.ref_l100)stats.missing_reference++;if(!driver)stats.unassigned++;
   if(next.event){const result=await notify(next.event);if(result?.delivered)stats.queued++;else if(!result?.duplicate&&next.state)next.state.last_notice_at=old.get(vehicle.key)?.last_notice_at||null;}
   if(next.state){stats.measured++;await db('ops_fuel_checkpoints',{method:'POST',params:{on_conflict:'vehicle_key'},prefer:'resolution=merge-duplicates',body:{vehicle_key:vehicle.key,state:next.state,updated_at:new Date(at).toISOString()}});}
   else if(old.has(vehicle.key))await db('ops_fuel_checkpoints',{method:'DELETE',params:{vehicle_key:'eq.'+vehicle.key}});
  }
  lastAt=new Date(at).toISOString();summary=stats;lastError=null;return stats;
 }
 return {update:rows=>{if(pending)return pending;pending=perform(rows).catch(error=>{lastError='Notifications de consommation interrompues ; vérifiez le suivi et les associations.';throw error;}).finally(()=>{pending=null;});return pending;},status:()=>({at:lastAt,error:lastError,...summary})};
}
