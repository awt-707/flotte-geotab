import {moroccoParts} from './morocco-time.mjs';
import { createHash } from 'node:crypto';

export const STATES = new Set(['available','on_trip','to_pickup','offline','unknown','on_break']);
export function validTime(v) { return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null; }
export function normalizedName(s) { return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).sort().join(' '); }
export function sourceKey(org, id, name) { return String(org || 'unknown') + ':' + (id || 'name:' + createHash('sha256').update(normalizedName(name)).digest('hex').slice(0,24)); }
export function boltState(driver, online) {
  if (online) {
    const state = online.current_state?.code, order = online.current_order;
    if (state === 'waiting') return 'available';
    if (state === 'on_break') return 'on_break';
    if (state === 'on_ride') {
      const departed = order?.stops?.some(s => s.type === 'pickup' && validTime(s.departed_at_datetime));
      if (!departed && order?.state === 'driver_accepted') return 'to_pickup';
      return 'on_trip';
    }
    return 'unknown';
  }
  // Absence from the online list alone never proves offline.
  return driver?.is_online === false ? 'offline' : 'unknown';
}
export function effectiveState(row, source, now = Date.now()) {
  const age = Math.max(0,(now-Date.parse(row.observed_at))/1000);
  const healthy = source?.status === 'healthy';
  const stale = !Number.isFinite(age) || age > (source?.stale_after_s || 90) || !healthy;
  return { ...row, raw_status: row.status, status: stale ? 'unknown' : row.status, stale, stale_after_s:source?.stale_after_s || 90, age_s: Number.isFinite(age) ? Math.round(age) : null };
}
export function inSchedule(schedule, at) {
  if (!schedule) return true;
  const zone=schedule.timezone || 'Africa/Casablanca';
  const parts = ['Africa/Casablanca','Africa/El_Aaiun'].includes(zone)?moroccoParts(at):Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(x=>[x.type,x.value]));
  if(!parts)return false;
  let day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);const hm = String(parts.hour).padStart(2,'0')+':'+String(parts.minute).padStart(2,'0');
  // A night schedule belongs to the weekday on which it started.
  if(schedule.start>schedule.end && hm<schedule.end)day=(day+6)%7;
  if (Array.isArray(schedule.days) && !schedule.days.includes(day)) return false;
  return schedule.start <= schedule.end ? hm >= schedule.start && hm < schedule.end : hm >= schedule.start || hm < schedule.end;
}
export function nextCounters(previous, row, ttl) {
  const continuous = previous && Date.parse(row.observed_at)-Date.parse(previous.observed_at) <= ttl*1000 && Date.parse(row.observed_at)>Date.parse(previous.observed_at);
  const offlineContinuous=continuous && previous.status==='offline' && previous.offline_samples>0;
  return { offline_since: row.status==='offline' ? offlineContinuous ? previous.offline_since || previous.observed_at : row.observed_at : null,
    offline_samples: row.status==='offline' ? offlineContinuous ? (previous.offline_samples || 0)+1 : 1 : 0,
    recovery_samples: row.status!=='offline' && row.status!=='unknown' ? continuous ? (previous.recovery_samples || 0)+1 : 1 : 0 };
}
export function historyIntervals(observations,sources,events,from,to) {
  const start=Date.parse(from), end=Date.parse(to), out=[];
  for(const source of sources) {
    const rows=observations.filter(x=>x.source===source.id).sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
    let cursor=start;
    const add=(a,b,status,row)=>{if(b>a)out.push({source:source.id,from:new Date(a).toISOString(),to:new Date(b).toISOString(),status,duration_s:Math.round((b-a)/1000),estimated:true,evidence:row?.evidence || {},source_at:row?.source_at || null});};
    for(let i=0;i<rows.length;i++) {
      const r=rows[i], t=Date.parse(r.observed_at), next=rows[i+1] ? Date.parse(rows[i+1].observed_at) : end;
      const stop=events.filter(e=>e.source===source.id && e.status!=='healthy' && Date.parse(e.at)>=t).reduce((a,e)=>Math.min(a,Date.parse(e.at)),end);
      const a=Math.max(start,t), b=Math.min(end,next,t+source.stale_after_s*1000,stop);
      if(a>cursor)add(cursor,Math.min(a,end),'unknown');
      if(b>a)add(a,b,r.status,r);
      cursor=Math.max(cursor,b);
    }
    if(cursor<end)add(cursor,end,'unknown');
  }
  return out.sort((a,b)=>a.from.localeCompare(b.from)||a.source.localeCompare(b.source));
}
export function validateUberBatch(body, now=Date.now()) {
  if(!body || typeof body!=='object' || !['observing','stopped','error'].includes(body.status)) throw new Error('État du collecteur invalide');
  if(typeof body.collectorId!=='string' || body.collectorId.length>100 || !body.collectorId) throw new Error('Collecteur invalide');
  if(!Array.isArray(body.rows) || body.rows.length>200)throw new Error('Maximum 200 observations');
  const observed=validTime(body.observedAt);
  if(!observed || Math.abs(Date.parse(observed)-now)>30000)throw new Error('Lecture périmée : relancer la liaison');
  let coverage=null;
  if(body.coverage!==undefined){
    const c=body.coverage;
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['mode','complete','observed','reason','vehicleObserved','vehicleComplete'].includes(k))||c.mode!=='list_sweep'||typeof c.complete!=='boolean'||c.observed!==body.rows.length||c.reason!==undefined&&!/^[a-z_]{1,40}$/.test(c.reason)||body.status!=='observing'&&c.complete||c.vehicleObserved!==undefined&&(!Number.isSafeInteger(c.vehicleObserved)||c.vehicleObserved<0||c.vehicleObserved>body.rows.length)||c.vehicleComplete!==undefined&&(typeof c.vehicleComplete!=='boolean'||c.vehicleComplete&&(c.vehicleObserved!==body.rows.length||!c.complete)))throw new Error('Couverture Uber invalide');
    coverage={mode:c.mode,complete:c.complete,observed:c.observed,...(c.reason?{reason:c.reason}:{}),...(c.vehicleObserved!==undefined?{vehicleObserved:c.vehicleObserved,vehicleComplete:c.vehicleComplete===true}:{})};
  }
  const counts=new Map();
  for(const r of body.rows){if(!r || typeof r.name!=='string' || !r.name.trim() || r.name.length>160 || !STATES.has(r.state))throw new Error('Observation invalide');const key=r.sourceId || normalizedName(r.name);counts.set(key,(counts.get(key)||0)+1);}
  return {collectorId:body.collectorId,status:body.status,organizationId:String(body.organizationId||'unknown').slice(0,120),observedAt:observed,coverage,
    rows:body.rows.filter(r=>counts.get(r.sourceId || normalizedName(r.name))===1).map(r=>{
      const at=validTime(r.readAt);if(!at || Math.abs(Date.parse(at)-now)>30000 || Date.parse(at)>Date.parse(observed) || Date.parse(observed)-Date.parse(at)>20000)throw new Error('Observation périmée');
      let vehicleLabel=String(r.vehicleLabel||'').trim().slice(0,100)||null,vehicleModel=null,vehicleReadAt=null,vehicleState=null;
      if(vehicleLabel){
        vehicleReadAt=validTime(r.vehicleReadAt===undefined?at:r.vehicleReadAt);
        if(!vehicleReadAt||Date.parse(vehicleReadAt)>Date.parse(at)||r.vehicleModel!==undefined&&r.vehicleModel!==null&&typeof r.vehicleModel!=='string'||r.vehicleState!==undefined&&!STATES.has(r.vehicleState))throw new Error('Preuve véhicule Uber invalide');
        vehicleModel=String(r.vehicleModel||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,160)||null;
        vehicleState=r.vehicleState||r.state;
        // A cached vehicle detail has its own age. Expired detail never discards
        // a fresh platform status, and receipt cannot renew the vehicle proof.
        if(now-Date.parse(vehicleReadAt)>180000){vehicleLabel=null;vehicleModel=null;vehicleReadAt=null;vehicleState=null;}
      }
      return {sourceId:typeof r.sourceId==='string' ? r.sourceId.slice(0,120) : null,name:r.name.trim(),state:r.state,readAt:at,sourceAt:null,rawState:String(r.rawState||'').slice(0,100),vehicleLabel,vehicleModel,vehicleReadAt,vehicleState};
    }),ambiguous:body.rows.filter(r=>counts.get(r.sourceId || normalizedName(r.name))>1).length};
}
