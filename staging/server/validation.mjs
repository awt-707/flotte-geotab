import {privateModeValid} from './private-files.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {driverPlatformActivity} from './platform-activity.mjs';
import {trustedVehicleLease} from './vehicle-evidence.mjs';
const IDS=['uber','bolt','geotab','myclicar'],INTERVAL=60000,DURATION=86400000;
const stamp=v=>Date.parse(v),fresh=(s,now)=>s?.status==='healthy'&&Number.isFinite(stamp(s.last_success_at))&&stamp(s.last_success_at)<=now+5000&&now-stamp(s.last_success_at)<=(s.stale_after_s||90)*1000;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
// Only aggregate operational evidence is retained. No names, IDs, positions or secrets.
export function validationSample({sources=[],drivers=[],identities=[],latest=[],motion=[],duration=[],contracts=[],now=Date.now(),startedAt=new Date(now).toISOString(),previous=null}){
 const activity=new Map(drivers.map(d=>[d.id,driverPlatformActivity({driverId:d.id,sources,identities,latest,now})]));
 const currentAssignment=a=>{const d=drivers.find(d=>d.id===a.driver_id),p=d?.vehicle_link_evidence;
  if(!d||!d.vehicle_key||d.vehicle_key!==a.vehicle_key||drivers.filter(v=>v.vehicle_key===d.vehicle_key).length!==1||p?.assignment_conflict?.requires_confirmation===true)return false;
  if(!['platform_plate','myclicar_contract'].includes(d.vehicle_link_method))return true;
  if(!trustedVehicleLease(p)||!Number.isFinite(stamp(p?.observed_at))||stamp(p.observed_at)>now+5000||!Number.isFinite(stamp(p.expires_at))||stamp(p.expires_at)<=now||stamp(p.expires_at)<=stamp(p.observed_at)||!fresh(sources.find(s=>s.id===p.source),now))return false;
  if(p.method&&p.method!==d.vehicle_link_method)return false;
  return d.vehicle_link_method==='myclicar_contract'?p.source==='myclicar'&&p.vehicle_key===d.vehicle_key&&p.client_code===d.ludy_driver_code:['uber','bolt'].includes(p.source);
 };
 const open=[...motion,...duration].filter(a=>a.status==='open'),invalidMotion=motion.filter(a=>a.status==='open'&&!currentAssignment(a));
 const onlineAlerts=open.filter(a=>activity.get(a.driver_id)?.status==='online'),issues=new Set([
  ...onlineAlerts.filter(a=>a.id).map(a=>'online:'+a.id),...invalidMotion.filter(a=>a.id).map(a=>'assignment:'+a.id)]);
 const delta=now-stamp(previous?.at),confirmed=previous?.ok&&previous.issues instanceof Set&&delta>0&&delta<=90000?[...issues].filter(k=>previous.issues.has(k)).length:0;
 const sample={at:new Date(now).toISOString(),ok:true,confirmed_issues:confirmed,sources:Object.fromEntries(IDS.map(id=>{const s=sources.find(s=>s.id===id);return [id,{fresh:fresh(s,now),status:s?.status||'missing',age_s:Number.isFinite(stamp(s?.last_success_at))?Math.max(0,Math.round((now-stamp(s.last_success_at))/1000)):null,
   drivers:count(s?.coverage?.drivers),vehicles:count(s?.coverage?.vehicles),contracts:count(s?.coverage?.contracts),complete:typeof s?.coverage?.complete==='boolean'?s.coverage.complete:null}];})),
 counts:{profiles:drivers.length,unmatched_profiles:drivers.filter(d=>!d.ludy_driver_code).length,assigned:drivers.filter(d=>d.vehicle_key).length,
  active_contracts:contracts.length,contracts_without_profile:contracts.filter(c=>!drivers.some(d=>d.ludy_driver_code===c.client_code)).length,
  motion_open:motion.filter(a=>a.status==='open').length,duration_open:duration.filter(a=>a.status==='open').length,
  corrected_history:motion.filter(a=>a.evidence?.correction_reason).length,
  motion_since_start:motion.filter(a=>!a.evidence?.correction_reason&&Number.isFinite(stamp(a.opened_at))&&stamp(a.opened_at)>=stamp(startedAt)&&stamp(a.opened_at)<=now+5000).length,
  alerts_with_online_driver:onlineAlerts.length,motion_without_current_assignment:invalidMotion.length}};
 // Correlation IDs exist only in this process; JSON persistence excludes them.
 // After a restart, two new observations are needed to confirm persistence.
 Object.defineProperty(sample,'issues',{value:issues,enumerable:false});return sample;
}
export function validationSummary(state,now=Date.now()){
 if(!state)return {status:'not_started',interval_s:60,duration_h:24};
 const samples=state.samples||[],valid=samples.filter(s=>s.ok),last=samples.at(-1),begin=stamp(state.started_at),end=stamp(state.target_at);
 let gaps=0,gapSeconds=0,verifiedMs=0,confirmedContradictions=0;
 for(let i=1;i<samples.length;i++){
  const previous=samples[i-1],current=samples[i],delta=stamp(current.at)-stamp(previous.at);
  if(delta>90000){gaps++;gapSeconds+=Math.max(0,Math.round(delta/1000)-60);}
  if(delta>0&&delta<=90000&&previous.ok&&current.ok)verifiedMs+=delta;
  if(current.ok)confirmedContradictions+=current.confirmed_issues||0;
 }
 const sources=Object.fromEntries(IDS.map(id=>{const healthy=valid.filter(s=>s.sources[id]?.fresh).length,partial=valid.filter(s=>s.sources[id]?.complete===false).length;
  return [id,{fresh_samples:healthy,total_samples:samples.length,availability_pct:samples.length?Math.round(1000*healthy/samples.length)/10:0,partial_samples:partial,last:last?.sources?.[id]||null}];}));
 const elapsed=Math.max(0,Math.min(now,end)-begin),completed=state.status==='completed';
 return {status:state.status,started_at:state.started_at,target_at:state.target_at,last_sample_at:last?.at||null,interval_s:60,duration_h:24,
  progress_pct:Math.min(100,Math.round(elapsed/DURATION*1000)/10),samples:samples.length,read_errors:samples.length-valid.length,gaps,gap_seconds:gapSeconds,
  observed_hours:Math.round(verifiedMs/360000)/10,confirmed_contradictions:confirmedContradictions,sources,last_counts:last?.counts||null,
  conclusion:completed?(gaps||samples.length!==valid.length||verifiedMs<DURATION*.98?'incomplete':confirmedContradictions||Object.values(sources).some(s=>s.fresh_samples!==s.total_samples||s.partial_samples)?'needs_review':'observation_finished'):'in_progress',
  real_motion_incident_seen:(valid.at(-1)?.counts.motion_since_start||0)>0,last_error:state.last_error||null};
}
export function createValidationMonitor({filename,list,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 let state=null,loaded=false,timer=null,busy=null,closed=false;
 const privateError=()=>new Error('Rapport local de validation indisponible.');
 async function load(){if(loaded)return;if(!filename){loaded=true;return;}
  try{const info=await fs.lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!privateModeValid(info,0o600,filename)||info.size>4*1024*1024)throw privateError();
   const data=JSON.parse(await fs.readFile(filename,'utf8'));if(data.version!==1||!['running','completed'].includes(data.status)||!Number.isFinite(stamp(data.started_at))||!Number.isFinite(stamp(data.target_at))||!Array.isArray(data.samples)||data.samples.length>1600)throw privateError();state=data;
  }catch(e){if(e.code!=='ENOENT')throw privateError();}loaded=true;
 }
 async function save(){if(!filename)return;const dir=path.dirname(filename);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const info=await fs.lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())throw privateError();
  try{const f=await fs.lstat(filename);if(!f.isFile()||f.isSymbolicLink()||f.nlink!==1||!privateModeValid(f,0o600,filename))throw privateError();}catch(e){if(e.code!=='ENOENT')throw e;}
  const tmp=path.join(dir,'.validation-'+randomUUID()+'.tmp');try{await fs.writeFile(tmp,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,filename);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
 }
 function arm(){clearTimer(timer);if(closed||state?.status!=='running')return;
  const age=now()-stamp(state.samples.at(-1)?.at),delay=Number.isFinite(age)?Math.max(1000,Math.min(INTERVAL,INTERVAL-age)):INTERVAL;
  timer=setTimer(async()=>{try{await sample();}catch{}finally{arm();}},delay);timer?.unref?.();}
 async function sample(){await load();if(closed||state?.status!=='running')return validationSummary(state,now());if(busy)return busy;
  const at=now();if(state.samples.length&&at-stamp(state.samples.at(-1).at)<55000)return validationSummary(state,at);
  busy=(async()=>{let record;
   try{const [sources,drivers,identities,latest,motion,duration,contracts]=await Promise.all([
    list('fleet_sources',{select:'id,status,last_success_at,stale_after_s,coverage'}),
    list('fleet_drivers',{select:'id,ludy_driver_code,vehicle_key,vehicle_link_method,vehicle_link_evidence'}),
    list('fleet_identities',{select:'id,driver_id,source'}),list('fleet_latest',{select:'identity_id,driver_id,source,status,observed_at,offline_since,evidence'}),
    list('fleet_motion_alerts',{select:'id,driver_id,vehicle_key,status,opened_at,evidence'}),list('fleet_alerts',{select:'id,driver_id,status',status:'eq.open'}),
    list('fleet_myclicar_contracts',{select:'client_code,vehicle_key',current:'eq.true',eligible:'eq.true'})]);
    record=validationSample({sources,drivers,identities,latest,motion,duration,contracts,now:at,startedAt:state.started_at,previous:state.samples.at(-1)});state.last_error=null;
   }catch{record={at:new Date(at).toISOString(),ok:false};state.last_error='Lecture locale interrompue ; aucune donnée fournisseur supplémentaire demandée.';}
   state.samples.push(record);if(at>=stamp(state.target_at)||state.samples.length>=1600)state.status='completed';
   await save();return validationSummary(state,now());
  })();try{return await busy;}finally{busy=null;}
 }
 async function start(){await load();if(!filename)throw privateError();if(!state){const at=now();state={version:1,status:'running',started_at:new Date(at).toISOString(),target_at:new Date(at+DURATION).toISOString(),samples:[],last_error:null};await save();}
  const result=await sample();arm();return result;
 }
 async function resume(){await load();if(state?.status==='running'){await sample();arm();}}
 return {start,resume,sample,status:async()=>{await load();return validationSummary(state,now());},close:()=>{closed=true;clearTimer(timer);}};
}
