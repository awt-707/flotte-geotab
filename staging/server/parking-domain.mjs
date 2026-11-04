import {createHash} from 'node:crypto';
import {trustedVehicleLease} from './vehicle-evidence.mjs';
import {currentPlatformObservation} from './platform-disconnections.mjs';
const fail=message=>Object.assign(Error(message),{status:400});
const rad=n=>n*Math.PI/180,EARTH=6371000;
export const validParkingPoint=p=>!!p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=85&&Math.abs(p.lon)<=180;
const validPoint=validParkingPoint;
export function parkingDistance(a,b){const dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);return EARTH*2*Math.atan2(Math.sqrt(Math.min(1,Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2)),Math.sqrt(Math.max(0,1-(Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2))));}
function xy(p,origin){return {x:rad(p.lon-origin.lon)*EARTH*Math.cos(rad(origin.lat)),y:rad(p.lat-origin.lat)*EARTH};}
function edgeDistance(p,a,b){const u=xy(a,p),v=xy(b,p),dx=v.x-u.x,dy=v.y-u.y,t=Math.max(0,Math.min(1,-(u.x*dx+u.y*dy)/(dx*dx+dy*dy||1)));return Math.hypot(u.x+t*dx,u.y+t*dy);}
function crosses(a,b,c,d){const orient=(p,q,r)=>(q.lon-p.lon)*(r.lat-p.lat)-(q.lat-p.lat)*(r.lon-p.lon);return orient(a,b,c)*orient(a,b,d)<0&&orient(c,d,a)*orient(c,d,b)<0;}
export function normalizeParkingZone(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Parking invalide');
 const name=String(input.name||'').trim(),agency_id=input.agency_id==null?null:Number(input.agency_id),kind=input.kind||'parking',s=input.shape;
 if(!name||name.length>120||agency_id!==null&&(!Number.isSafeInteger(agency_id)||agency_id<=0)||!['parking','exclusion','operating'].includes(kind)||kind==='operating'&&agency_id===null||!s||typeof input.enabled!=='boolean'||input.indicative!==undefined&&typeof input.indicative!=='boolean')throw fail('Nom, agence et zone valides requis ; une zone autorisée doit avoir une agence');
 let shape;
 if(s.type==='circle'){
  if(!validPoint(s.center)||!Number.isFinite(s.radius_m)||s.radius_m<40||s.radius_m>(kind==='parking'?2000:50000))throw fail('Choisissez un centre et un rayon adapté à la zone');
  shape={type:'circle',center:{lat:s.center.lat,lon:s.center.lon},radius_m:s.radius_m};
 }else if(s.type==='polygon'){
  if(!Array.isArray(s.points)||s.points.length<3||s.points.length>1000||!s.points.every(validPoint))throw fail('Le contour doit contenir 3 à 1 000 points valides');
  const points=s.points.map(p=>({lat:p.lat,lon:p.lon}));if(points.at(-1).lat===points[0].lat&&points.at(-1).lon===points[0].lon)points.pop();
  if(points.length<3||points.some(p=>parkingDistance(p,points[0])>(kind==='parking'?10000:500000)))throw fail('Contour trop étendu ou incomplet');
  let area=0;for(let i=0;i<points.length;i++){const a=xy(points[i],points[0]),b=xy(points[(i+1)%points.length],points[0]);area+=a.x*b.y-b.x*a.y;for(let j=i+2;j<points.length;j++){if(i===0&&j===points.length-1)continue;if(crosses(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]))throw fail('Le contour du parking se croise');}}
  if(Math.abs(area)/2<100||Math.abs(area)/2>(kind==='parking'?25000000:100000000000))throw fail('Surface de la zone invalide');shape={type:'polygon',points};
 }else throw fail('Forme de parking non reconnue');
 const result={name,agency_id,kind,shape,enabled:input.enabled,indicative:input.indicative===true};result.fingerprint=createHash('sha256').update(JSON.stringify(result)).digest('hex');return result;
}
// Positive distance is inside the perimeter; margins prevent edge jitter.
export function parkingSignedDistance(point,shape){
 if(!validPoint(point))return null;
 if(shape.type==='circle')return shape.radius_m-parkingDistance(point,shape.center);
 let inside=false,min=Infinity;const p=shape.points;
 for(let i=0,j=p.length-1;i<p.length;j=i++){
  if((p[i].lat>point.lat)!==(p[j].lat>point.lat)&&point.lon<(p[j].lon-p[i].lon)*(point.lat-p[i].lat)/(p[j].lat-p[i].lat)+p[i].lon)inside=!inside;
  min=Math.min(min,edgeDistance(point,p[i],p[j]));
 }return (inside?1:-1)*min;
}
export function advanceParking(previous,{vehicle,position,zones,source,now=Date.now()}){
 const at=Date.parse(position?.at),success=Date.parse(source?.last_success_at),ttl=Number(source?.stale_after_s)*1000;
 if(!vehicle?.key||!vehicle.geotab_id||position?.device_id!==vehicle.geotab_id||!validPoint(position)||!Number.isFinite(at)||at>now+5000||now-at>120000||source?.status!=='healthy'||!Number.isFinite(success)||success>now+5000||!Number.isFinite(ttl)||ttl<=0||now-success>Math.min(ttl,120000)||position.accuracy_m!=null&&(!Number.isFinite(position.accuracy_m)||position.accuracy_m<0||position.accuracy_m>40))return {state:null,event:null};
 const distances=zones.filter(z=>z.enabled).map(z=>({zone:z,distance:parkingSignedDistance(position,z.shape)}));
 const operating=zones.length===1&&zones[0].kind==='operating';
 if(operating&&(zones[0].agency_id==null||String(zones[0].agency_id)!==String(vehicle.agency_id)))return {state:null,event:null};
 const inside=distances.filter(z=>z.distance>=(z.zone.kind==='parking'?5:15)),border=distances.some(z=>z.distance>(z.zone.kind==='parking'?-15:-30)&&z.distance<(z.zone.kind==='parking'?5:15));
 if(inside.length>1)return {state:null,event:null};
 const fingerprint=createHash('sha256').update(JSON.stringify(distances.map(d=>[d.zone.id,d.zone.fingerprint,Number(d.zone.revision||1)]).sort())).digest('hex');
 const identity=vehicle.geotab_id+':'+fingerprint+(operating?':'+vehicle.agency_id:''),zoneId=inside[0]?.zone.id||null;
 if(previous?.identity===identity&&at<=Date.parse(previous.last_at))return {state:previous,event:null};
 const current=previous?.identity===identity&&at-Date.parse(previous.last_at)<=90000&&Date.parse(previous.last_at)<=at?previous:null;
 if(current&&at===Date.parse(current.last_at))return {state:current,event:null};
 if(border&&!inside.length)return {state:current?{...current,last_at:new Date(at).toISOString(),pending:null,...(operating&&!current.outside_confirmed_at?{outside_from_at:null,outside_samples:0,outside_confirmed_at:null}:{})}:null,event:null};
 const initial={identity,device_id:vehicle.geotab_id,zone_revision:zones.length===1?Number(zones[0].revision||1):null,zone_id:zoneId,since_at:new Date(at).toISOString(),last_at:new Date(at).toISOString(),pending:null};
 if(operating)Object.assign(initial,{agency_id:vehicle.agency_id,outside_from_at:zoneId?null:initial.last_at,outside_samples:zoneId?0:1,outside_confirmed_at:null});
 if(!current)return {state:initial,event:null};
 if(zoneId===current.zone_id){
  const state={...current,last_at:initial.last_at,pending:null};
  if(operating&&!zoneId){const from=current.outside_from_at||initial.last_at,samples=current.outside_from_at?Math.min(2,(current.outside_samples||0)+1):1;Object.assign(state,{outside_from_at:from,outside_samples:samples,outside_confirmed_at:current.outside_confirmed_at||(samples>=2&&at-Date.parse(from)>=5000?initial.last_at:null)});}
  return {state,event:null};
 }
 const pending=current.pending?.zone_id===zoneId?{...current.pending,samples:current.pending.samples+1}:{zone_id:zoneId,from_at:initial.last_at,samples:1};
 if(pending.samples<2||at-Date.parse(pending.from_at)<5000)return {state:{...current,last_at:initial.last_at,pending},event:null};
 const event={vehicle_key:vehicle.key,zone_id:zoneId||current.zone_id,kind:zoneId?'entered':'exited',observed_at:initial.last_at,first_observed_at:pending.from_at};
 event.event_key=createHash('sha256').update(JSON.stringify([vehicle.key,identity,current.zone_id,zoneId,pending.from_at])).digest('hex');
 if(zoneId){initial.entry_event_key=event.event_key;initial.entry_observed_at=event.observed_at;}
 else if(operating)Object.assign(initial,{outside_from_at:pending.from_at,outside_samples:2,outside_confirmed_at:initial.last_at});
 return {state:initial,event};
}

// A zone warning concerns the exact current driver/vehicle link. A stale account
// or another platform in a trip never becomes evidence of availability.
export function operatingAvailability({driver,vehicle,identities=[],latest=[],sources=[],now=Date.now()}){
 if(!driver?.id||!driver.ludy_driver_code||driver.vehicle_key!==vehicle?.key||driver.vehicle_link_evidence?.assignment_conflict?.requires_confirmation===true)return null;
 const sourceMap=new Map(sources.map(s=>[s.id,s])),proof=driver.vehicle_link_evidence;
 if(driver.vehicle_link_method==='manual'){
  const confirmed=Date.parse(driver.link_evidence?.at);if(driver.link_evidence?.method!=='manual'||!Number.isFinite(confirmed)||confirmed>now+5000)return null;
 }else if(['platform_plate','myclicar_contract'].includes(driver.vehicle_link_method)){
  const observed=Date.parse(proof?.observed_at),expiry=Date.parse(proof?.expires_at),source=sourceMap.get(proof?.source);
  if(!trustedVehicleLease(proof)||!Number.isFinite(observed)||observed>now+5000||!Number.isFinite(expiry)||expiry<=now||expiry<=observed||proof.method&&proof.method!==driver.vehicle_link_method||!currentPlatformObservation({observed_at:source?.last_success_at},source,now))return null;
  if(driver.vehicle_link_method==='myclicar_contract'&&(proof.source!=='myclicar'||proof.vehicle_key!==vehicle.key||proof.client_code!==driver.ludy_driver_code))return null;
  if(driver.vehicle_link_method==='platform_plate'&&!['uber','bolt'].includes(proof.source))return null;
 }else return null;
 const accounts=identities.filter(i=>i.driver_id===driver.id&&['uber','bolt'].includes(i.source));if(!accounts.length)return null;
 const available=[];
 for(const account of accounts){
  const observations=latest.filter(r=>r.identity_id===account.id);if(observations.length!==1)return null;
  const row=observations[0],source=sourceMap.get(account.source);
  if(row.driver_id!==driver.id||row.source!==account.source)return null;
  const inactive=['suspended','deactivated'].includes(String(row.evidence?.account_status||'').toLowerCase());
  if(!currentPlatformObservation(inactive?{...row,evidence:{...row.evidence,account_status:null}}:row,source,now))return null;
  if(inactive)continue;
  if(!['available','offline','on_break'].includes(row.status))return null;
  if(row.status==='available')available.push({source:row.source,observed_at:row.observed_at});
 }
 // Inconsistent snapshots must not omit an account observed under this driver.
 if(latest.some(row=>row.driver_id===driver.id&&['uber','bolt'].includes(row.source)&&!accounts.some(a=>a.id===row.identity_id)))return null;
 return available.length?{driver_id:driver.id,driver_name:driver.name,available_sources:available}:null;
}
