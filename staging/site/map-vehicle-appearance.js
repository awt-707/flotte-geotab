// The vehicle assignment and platform observation must both still be current.
// A missing assignment is not evidence that the car is unused.
function mapParkingAppearance(row){
 if(!S.session?.user?.id||!row?.vehicle_key||row.crs)return null;
 const parking=typeof mapUnusedParking==='function'?mapUnusedParking(row.vehicle_key):null,now=Date.now();
 if(!parking)return null;
 const positionAt=Date.parse(row.last_pos_at),proofAt=Date.parse(parking.position_at);
 // A proof concerns this exact fix, never a later position that may have left.
 if(!Number.isFinite(positionAt)||positionAt!==proofAt||now-positionAt< -5000)return null;
 const suffix=parking.zone_name?' · '+parking.zone_name:'';
 if(parking.position_basis==='last_known_parking'){
  const source=typeof LIVE!=='undefined'?LIVE.localSource:null,sourceAt=Date.parse(source?.last_success_at),sourceTtl=Number(source?.stale_after_s)*1000;
  if(!source||LIVE.err||!source.polling||source.status!=='healthy'||!Number.isFinite(sourceAt)||now-sourceAt< -5000||!Number.isFinite(sourceTtl)||sourceTtl<=0||now-sourceAt>Math.min(sourceTtl,120000))return null;
  const checkedAt=Date.parse(parking.checked_at),device=S.veh?.[row.vehicle_key]?.geotab_id;
  if(parking.presence_current!==false||parking.ign_on!==false||row.ign_on===true||!device||device!==parking.device_id||!Number.isFinite(checkedAt)||now-checkedAt< -5000||now-checkedAt>15000||now-positionAt>7*86400000)return null;
  if(!Number.isFinite(row.lat)||!Number.isFinite(row.lon)||row.lat!==parking.lat||row.lon!==parking.lon||Number.isFinite(row.speed)&&(row.speed<0||row.speed>3))return null;
  const local=typeof stagingLocalDateParts==='function'?stagingLocalDateParts(parking.position_at):null;
  const date=typeof fmtHMS==='function'?fmtHMS(parking.position_at):local?`${local.day}/${local.month}/${local.year} ${local.hour}:${local.minute}`:new Date(proofAt).toISOString();
  return {kind:'parking',status:'parking',statusLabel:'Dernière position au parking',label:'Dernière position au parking · '+date+suffix,parkingFresh:false,lastKnown:true,positionBasis:'last_known_parking',positionAt:parking.position_at};
 }
 if(!row.live||!Number.isFinite(row.speed)||row.speed<0||row.speed>3||now-positionAt>120000)return null;
 return {kind:'parking',status:'parking',statusLabel:'Au parking',label:'Véhicule inutilisé au parking'+suffix,parkingFresh:true,lastKnown:false,positionBasis:'current_parking',positionAt:parking.position_at};
}
function mapVehicleAppearance(row) {
 const neutral={kind:'neutral',status:'unknown',statusLabel:'Statut non confirmé',label:'Plateforme à confirmer'},now=Date.now(),owner=S.session?.user?.id;
 if(!owner||!row?.vehicle_key)return neutral;
 const overview=typeof OPS!=='undefined'&&OPS.owner===owner&&now-OPS.overviewAt>=0&&now-OPS.overviewAt<=30000?OPS.overview:null;
 const assigned=overview&&typeof opsDriverForVehicle==='function'?opsDriverForVehicle(row.vehicle_key):null;
 const driver=assigned||(overview&&typeof opsObservedDriverForVehicle==='function'?opsObservedDriverForVehicle(row.vehicle_key):null),observedOnly=!!driver&&!assigned;
 const active=[],observations=new Map(),statusLabels={available:'Disponible',on_trip:'En course',to_pickup:'Vers le client',on_break:'En pause',offline:'Hors ligne'};
 if(driver&&typeof fleetObservation==='function')for(const provider of ['uber','bolt']){
  const source=overview.sources?.find(s=>s.id===provider),sourceAge=now-Date.parse(source?.last_success_at),ttl=Number(source?.stale_after_s)*1000;
  if(source?.status!=='healthy'||!Number.isFinite(sourceAge)||sourceAge< -5000||!Number.isFinite(ttl)||ttl<=0||sourceAge>ttl)continue;
  const observation=fleetObservation(driver,provider);
  if(!observation||['suspended','deactivated'].includes(String(observation.evidence?.account_status||'').toLowerCase()))continue;
  observations.set(provider,observation);
  const rank={on_trip:4,to_pickup:3,available:2,on_break:1}[observation.status];
  if(rank)active.push({provider,rank,status:observation.status});
 }
 if(active.length){
  const rank=Math.max(...active.map(a=>a.rank)),providers=active.filter(a=>a.rank===rank).map(a=>a.provider);
  const kind=providers.length>1?'both':providers[0],status=active.find(a=>a.rank===rank).status,statusLabel=statusLabels[status];
  return {kind,status,statusLabel,label:(kind==='both'?'Uber et Bolt':kind==='uber'?'Uber':'Bolt')+' · '+statusLabel};
 }
 const parking=mapParkingAppearance(row);if(parking)return parking;
 // sources[] contains only the newest account per platform. The server verdict
 // also covers other known accounts and identities with no recent observation.
 const activity=driver?.platform_activity,offline=activity?.offline_sources;
 if(!observedOnly&&activity?.status==='offline'&&activity.reason==='all_known_platforms_offline'&&Array.isArray(offline)&&offline.length&&offline.every(p=>['uber','bolt'].includes(p)&&observations.get(p)?.status==='offline')){
  const providers=[...new Set(offline)],kind=providers.length>1?'both':providers[0];
  return {kind,status:'offline',statusLabel:statusLabels.offline,label:(kind==='both'?'Uber et Bolt':kind==='uber'?'Uber':'Bolt')+' · '+statusLabels.offline};
 }
 return neutral;
}
