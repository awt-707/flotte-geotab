// Bounded historical views: measured counter deltas, provider trips and observed GPS.
export const HISTORY_DAY_MS=25*3600000, HISTORY_REPORT_MS=169*3600000, HISTORY_AGE_MS=90*86400000;
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const iso=x=>Number.isFinite(time(x))?new Date(time(x)).toISOString():null;
const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
const round=x=>Math.round(x*1000)/1000;
export const historyError=(status,message)=>Object.assign(new Error(message),{status});
export function historyWindow(input,max,now) {
  const from=time(input?.from),requestedTo=time(input?.to);
  if(!Number.isFinite(from)||!Number.isFinite(requestedTo)||requestedTo<=from||requestedTo-from>max||from>=now||from<now-HISTORY_AGE_MS)
    throw historyError(400,'Période invalide : choisissez une journée pour les trajets, sept jours pour un rapport, dans les 90 derniers jours.');
  // An open current-day request shares a stable minute boundary across screens.
  // Explicit historical boundaries retain their exact timestamps.
  const openEnd=Math.floor(now/60000)*60000;
  return {from:new Date(from).toISOString(),to:new Date(requestedTo>now&&openEnd>from?openEnd:Math.min(requestedTo,now)).toISOString()};
}
export function durationMinutes(value) {
  const m=String(value||'').match(/^(?:(\d+)\.)?(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/);
  return m?+(m[1]||0)*1440 + +m[2]*60 + +m[3] + (+m[4]+Number('0.'+(m[5]||0)))/60:null;
}
export function historyEvents(rows,id,from,to) {
  const a=time(from),b=time(to),seen=new Set();
  return (rows||[]).filter(e=>e?.device?.id===id&&typeof e.id==='string'&&!seen.has(e.id)&&seen.add(e.id)&&e.rule?.id
    &&e.state!=='ExceptionEventStateInvalidId'&&e.state!==1&&Number.isFinite(time(e.activeFrom))&&time(e.activeFrom)<b&&(!e.activeTo||time(e.activeTo)>=a))
    .map(e=>({id:e.id,rule:String(e.rule.id),at:iso(e.activeFrom),end:iso(e.activeTo),dur_min:durationMinutes(e.duration),km:number(e.distance)}))
    .sort((a,b)=>a.at.localeCompare(b.at));
}
export function historyTrips(rows,id,from,to) {
  const a=time(from),b=time(to),seen=new Set();
  return (rows||[]).filter(t=>t?.device?.id===id&&typeof t.id==='string'&&!seen.has(t.id)&&seen.add(t.id)&&Number.isFinite(time(t.start))
    &&time(t.start)<b&&(!t.nextTripStart||time(t.nextTripStart)>=a))
    .map(t=>{
      const start=iso(t.start),stop=iso(t.stop),next=iso(t.nextTripStart);
      const driveComplete=time(start)>=a&&Number.isFinite(time(stop))&&time(stop)<=b;
      const idleComplete=driveComplete&&Number.isFinite(time(next))&&time(next)<=b;
      return {id:t.id,start,stop,next_start:next,distance_km:number(t.distance),drive_min:durationMinutes(t.drivingDuration),idle_min:durationMinutes(t.idlingDuration),
        stop_min:durationMinutes(t.stopDuration),max_speed:number(t.maximumSpeed),average_speed:number(t.averageSpeed),
        partial:!idleComplete,drive_complete:driveComplete,idle_complete:idleComplete,
        stop_point:t.stopPoint&&Number.isFinite(t.stopPoint.x)&&Number.isFinite(t.stopPoint.y)?{lat:t.stopPoint.y,lon:t.stopPoint.x}:null};
    }).sort((a,b)=>a.start.localeCompare(b.start));
}
export function historyGps(rows,id,from,to) {
  const a=time(from),b=time(to),points=new Map();let interpolated=0;
  for(const p of rows||[]) {
    const at=time(p?.dateTime),lat=p?.latitude,lon=p?.longitude;
    if(p?.device?.id!==id||!Number.isFinite(at)||at<a||at>b||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||!(lat||lon))continue;
    if(!p.id)interpolated++;
    points.set(at,[at,number(p.speed),lat,lon]);
  }
  return {gps:[...points.values()].sort((a,b)=>a[0]-b[0]),gps_interpolated:interpolated};
}
export function historySummary(trips,events,counters,coverage,from,to) {
  const a=time(from),b=time(to),driven=trips.filter(t=>!t.stop||time(t.stop)>a);
  const sum=(rows,key)=>rows.every(t=>t[key]!==null)?round(rows.reduce((n,t)=>n+t[key],0)):null;
  const eventCounts=Object.create(null);for(const e of events)eventCounts[e.rule]=(eventCounts[e.rule]||0)+1;
  const result={km:counters?.km??null,fuel_l:counters?.fuel_l??null,idle_l:counters?.idle_l??null,
    drive_min:coverage.trips==='complete'&&driven.every(t=>t.drive_complete)?sum(driven,'drive_min'):null,
    idle_min:coverage.trips==='complete'&&trips.every(t=>t.idle_complete)?sum(trips,'idle_min'):null,
    trips:coverage.trips==='complete'?driven.length:null,max_speed:coverage.trips==='complete'&&driven.length&&driven.every(t=>t.max_speed!==null)?Math.max(...driven.map(t=>t.max_speed)):null,
    events:coverage.events==='complete'?events.length:null,event_counts:coverage.events==='complete'?eventCounts:null};
  result.l100=result.km>0&&result.fuel_l!==null?round(result.fuel_l/result.km*100):null;
  return result;
}
export function reportTotals(rows) {
  const totals={};
  for(const key of ['km','fuel_l','idle_l','drive_min','idle_min','trips','events'])totals[key]=rows.length&&rows.every(r=>r[key]!==null)?round(rows.reduce((n,r)=>n+r[key],0)):null;
  totals.l100=totals.km>0&&totals.fuel_l!==null?round(totals.fuel_l/totals.km*100):null;
  return totals;
}
