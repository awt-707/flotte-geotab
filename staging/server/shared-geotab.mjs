import {geotabIntervalMs,telemetryIntervalMs} from './geotab-service.mjs';
/** A standby reads the leader's persisted state under the viewer's vehicle RLS. */
export function sharedGeotabLive({source={},vehicles=[],positions=[],snapshots=[],motion={alerts:[],coverage:{}},now=Date.now()}){
  const selected=new Map(vehicles.filter(v=>v.geotab_id).map(v=>[v.key,v]));
  const interval=geotabIntervalMs(selected.size),stale=Math.max(20000,interval*3),sourceAge=now-Date.parse(source.last_success_at);
  const state=source.status==='healthy'&&(!Number.isFinite(sourceAge)||sourceAge>stale||sourceAge< -60000)?'stale':source.status||'unconnected';
  const current=new Map(snapshots.filter(s=>selected.get(s.vehicle_key)?.geotab_id===s.data?.device_id&&now-Date.parse(s.observed_at)>=-60000&&now-Date.parse(s.observed_at)<stale).map(s=>[s.vehicle_key,s.data]));
  const newest=[...current.values()].sort((a,b)=>Date.parse(b.captured_at)-Date.parse(a.captured_at))[0];
  const motionError=newest?.extra?.motion_error;
  const rows=positions.filter(r=>selected.has(r.vehicle_key));
  const telemetry={},events=[];
  for(const row of rows){
    const data=current.get(row.vehicle_key),age=now-Date.parse(row.last_pos_at),sensor=data?.telemetry;
    if(sensor)telemetry[row.vehicle_key]={...sensor,fresh:state==='healthy'&&data.extra?.telemetry_status!=='error'&&age>=-60000&&age<180000&&now-Date.parse(sensor.at)>=-60000&&now-Date.parse(sensor.at)<Math.max(90000,telemetryIntervalMs(selected.size)*3)};
    for(const event of data?.events||[])if(!event.end||now-Date.parse(event.end)<1800000)events.push({...event,key:row.vehicle_key,plate:selected.get(row.vehicle_key).plate});
  }
  return {at:source.last_success_at||null,source:{configured:state!=='unconnected',polling:!['unconnected','paused'].includes(state),status:state,collectionRemote:true,
    interval_s:interval/1000,stale_after_s:stale/1000,last_success_at:source.last_success_at||null,last_error:source.last_error||null,
    events_status:'pending',telemetry_status:'pending',...(newest?.extra||{})},events:events.sort((a,b)=>String(b.at).localeCompare(String(a.at))),telemetry,
    motion_alerts:(motion.alerts||[]).filter(a=>selected.has(a.key||a.vehicle_key)).map(a=>({...a,status:a.status==='open'&&(state!=='healthy'||motionError)?'suspended':a.status})),
    motion_coverage:motion.coverage||{},motion_watches:state==='healthy'&&!motionError?(motion.watches||[]).filter(w=>selected.has(w.key)):[],
    vehicles:rows.map(row=>{const age=now-Date.parse(row.last_pos_at),updatedAge=now-Date.parse(row.updated_at),fresh=state==='healthy'&&current.has(row.vehicle_key)&&age>=-60000&&age<180000&&updatedAge>=-60000&&updatedAge<stale;
      return {key:row.vehicle_key,plate:selected.get(row.vehicle_key).plate,at:row.last_pos_at,lat:row.lat,lon:row.lon,speed:fresh?row.speed:null,bearing:current.get(row.vehicle_key)?.bearing??null,
        state:fresh?row.state:'Position ancienne',since_min:row.since_min,ign_on:fresh?row.ign_on:null,fresh};})};
}
