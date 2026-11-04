// A measured historical reference is fixed once, never trained on the same
// driving window that is being evaluated. Manual values always take priority.
import {rotationLocalDay} from './vehicle-rotations.mjs';
import {parseMyClicarLocalTime} from './myclicar-contracts.mjs';
const DAY=86400000;
const time=value=>typeof value==='string'?Date.parse(value):NaN;
export function fuelReferenceWindow(now=Date.now()){
 const day=rotationLocalDay(now),previous=new Date(Date.parse(day)-7*DAY).toISOString().slice(0,10);
 const midnight=d=>parseMyClicarLocalTime(d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4)+' 00:00');
 return {from:midnight(previous),to:midnight(day)};
}
export function measuredFuelReference(row,range,now=Date.now()){
 const from=time(range?.from),to=time(range?.to);
 if(!Number.isFinite(from)||!Number.isFinite(to)||to>now||to-from<167*3600000||to-from>169*3600000)return null;
 if(!row||!Number.isFinite(row.km)||row.km<100||!Number.isFinite(row.fuel_l)||row.fuel_l<=0)return null;
 for(const boundary of ['from','to']){
  const km=time(row.counter_at?.km?.[boundary]),fuel=time(row.counter_at?.fuel_l?.[boundary]),expected=boundary==='from'?from:to;
  // Counter differences must cover the same real period, with close endpoints.
  if(!Number.isFinite(km)||!Number.isFinite(fuel)||Math.abs(km-fuel)>300000||km>expected||fuel>expected||expected-km>300000||expected-fuel>300000)return null;
 }
 const value=Math.round(row.fuel_l/row.km*1000)/10;
 if(value<1||value>40||row.km/((to-from)/3600000)>160)return null;
 return {value,method:'geotab_history',from:range.from,to:range.to,distance_km:row.km,fuel_l:row.fuel_l,
  counter_at:{km:{from:row.counter_at.km.from,to:row.counter_at.km.to},fuel_l:{from:row.counter_at.fuel_l.from,to:row.counter_at.fuel_l.to}},calculated_at:new Date(now).toISOString()};
}
export function createFuelReferenceService({db,list,readReport,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 let pending=null,timer=null,closed=false,running=false;
 const status=async()=>((await db('ops_fuel_reference_runs',{params:{id:'eq.1'}}))?.[0]||{status:'pending'});
 const save=body=>db('ops_fuel_reference_runs',{method:'PATCH',params:{id:'eq.1'},body});
 async function perform(){
  const at=now(),old=await status();
  if(closed)return;
  if(time(old.next_attempt_at)>at)return {...old,waiting:true};
  const vehicles=(await list('vehicles',{select:'key,geotab_id,active,ref_l100',order:'key'})).filter(v=>v.geotab_id&&!['NON','FALSE'].includes(String(v.active).trim().toUpperCase())&&v.ref_l100==null);
  if(closed)return;
  if(!vehicles.length){await save({status:'complete',last_success_at:new Date(at).toISOString(),next_attempt_at:new Date(at+3600000).toISOString(),last_error:null,candidates:0,applied:0,insufficient:0});return status();}
  // A restart keeps this lease and cannot generate a loop of provider requests.
  await save({status:'reading',last_attempt_at:new Date(at).toISOString(),next_attempt_at:new Date(at+1800000).toISOString(),last_error:null,candidates:vehicles.length,applied:0,insufficient:0});
  let applied=0,insufficient=0;const range=fuelReferenceWindow(at);
  try{
   for(let offset=0;offset<vehicles.length;offset+=25){
    if(closed)return;
    const batch=vehicles.slice(offset,offset+25),report=await readReport({...range,keys:batch.map(v=>v.key).join(',')});
    if(closed)return;
    if(report.from!==range.from||report.to!==range.to||!Array.isArray(report.rows))throw Error('Historical period mismatch');
    for(const v of batch){
     if(closed)return;
     const rows=report.rows.filter(row=>row.key===v.key),reference=rows.length===1?measuredFuelReference(rows[0],range,at):null;
     if(!reference){insufficient++;continue;}
     const saved=await db('rpc/ops_set_measured_fuel_reference',{method:'POST',body:{p_vehicle:v.key,p_device:v.geotab_id,p_reference:reference}});
     if(saved===true)applied++;
    }
   }
   if(closed)return;
   await save({status:'complete',last_success_at:new Date(now()).toISOString(),next_attempt_at:new Date(at+DAY).toISOString(),last_error:null,applied,insufficient});
  }catch{
   if(!closed)await save({status:'waiting',last_error:'Références en attente : le suivi Geotab doit être actif et son historique disponible.',applied,insufficient});
  }
  return status();
 }
 const refresh=()=>{if(closed)return Promise.resolve(null);if(pending)return pending;pending=perform().finally(()=>{pending=null;});return pending;};
 function schedule(delay=900000){if(closed||!running)return;timer=setTimer(async()=>{timer=null;try{await refresh();}catch{}finally{schedule();}},delay);timer?.unref?.();}
 return {status,refresh,start:async()=>{if(!readReport||running||closed)return;running=true;schedule(45000);},close:()=>{closed=true;running=false;clearTimer(timer);timer=null;}};
}
