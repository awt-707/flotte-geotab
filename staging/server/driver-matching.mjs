import {normalizedName} from './fleet-domain.mjs';
import {normalizeGeotabPlate} from './geotab-matching.mjs';
import {trustedVehicleObservation,trustedVehicleLease,vehicleObservationWindow} from './vehicle-evidence.mjs';
import {myClicarClaims} from './myclicar-contracts.mjs';

const active=v=>v.active!==false&&String(v.active).toUpperCase()!=='NON';
const online=new Set(['available','on_trip','to_pickup','on_break']);
const time=value=>Date.parse(value);
const fresh=(row,source,now)=>source?.status==='healthy'&&Number.isFinite(time(row.observed_at))&&time(row.observed_at)<=now+5000&&now-time(row.observed_at)<=source.stale_after_s*1000&&Number.isFinite(time(source.last_success_at))&&time(source.last_success_at)<=now+5000&&now-time(source.last_success_at)<=source.stale_after_s*1000&&!['deactivated','suspended'].includes(row.evidence?.account_status);
const nameIndex=rows=>{const map=new Map();for(const row of rows){const key=normalizedName(row.name);if(key)map.set(key,[...(map.get(key)||[]),row]);}return map;};
// A spacing-only variant keeps every letter in the original order. It never
// substitutes, removes or guesses part of a person's name.
export const spacedNameKey=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\s-]+/g,'');
const fullSpacedName=value=>String(value||'').trim().split(/[\s-]+/).length>=2&&spacedNameKey(value).length>=8&&/^[\p{L}]+$/u.test(spacedNameKey(value));
function suggestions(name,refs) {
  const tokens=new Set(normalizedName(name).split(' '));
  return refs.map(d=>{const words=normalizedName(d.name).split(' '),common=words.filter(w=>tokens.has(w)).length;return {...d,score:common/Math.max(tokens.size,words.length)};})
    .filter(d=>d.score>=0.5).sort((a,b)=>b.score-a.score||a.code.localeCompare(b.code)).slice(0,3).map(({code,name,agency_id})=>({code,name,agency_id}));
}

const sameContractAssignment=(contract,override)=>override.contract_id===contract.external_id&&override.client_code===contract.client_code&&override.vehicle_key===contract.vehicle_key&&Number.isFinite(time(contract.effective_start_at))&&time(override.effective_start_at)===time(contract.effective_start_at);

/** Exact names link people; live plates take priority over contract fallback. */
export function planDriverMatches({drivers=[],reference=[],identities=[],latest=[],vehicles=[],sources=[],myclicarContracts=[],contractOverrides=[],now=Date.now()}) {
  const names=nameIndex(reference),byCode=new Map(reference.map(d=>[d.code,d])),bySource=new Map(sources.map(s=>[s.id,s]));
  const byDriver=new Map(drivers.map(d=>[d.id,d]));
  const canonicalByCode=new Map(drivers.filter(d=>d.ludy_driver_code).map(d=>[d.ludy_driver_code,d]));
  const observedVehicles=latest.filter(l=>{const source=bySource.get(l.source),window=vehicleObservationWindow(l,source);return byDriver.has(l.driver_id)&&online.has(l.status)&&fresh(l,source,now)&&trustedVehicleObservation(l)&&Number.isFinite(window.observed)&&window.observed<=time(l.observed_at)&&window.observed<=now+5000&&window.expires>now;});
  const plateVehicles=label=>{const plate=normalizeGeotabPlate(label);return plate?vehicles.filter(v=>active(v)&&[v.key,v.plate,...String(v.other_plates||'').split(/[,;]/)].some(p=>normalizeGeotabPlate(p)===plate)):[];};
  const liveClaims=observedVehicles.flatMap(sample=>{const matches=plateVehicles(sample.vehicle_label);return matches.length===1?[{sample,vehicle:matches[0],driver:byDriver.get(sample.driver_id)}]:[];});
  // A contract describes a rental, not necessarily today's shift. A persisted
  // handover barrier outlives the platform observation, so expiry/offline cannot
  // silently restore the old contract holder as the current driver.
  const overriddenContracts=new Set(myclicarContracts.filter(contract=>
    contractOverrides.some(override=>sameContractAssignment(contract,override))||
    contract.vehicle_key&&liveClaims.some(({driver,vehicle})=>
      vehicle.key===contract.vehicle_key&&driver.ludy_driver_code!==contract.client_code||
      driver.ludy_driver_code&&driver.ludy_driver_code===contract.client_code&&vehicle.key!==contract.vehicle_key)
  ).map(contract=>contract.external_id));
  const overriddenCodes=new Set(myclicarContracts.filter(c=>overriddenContracts.has(c.external_id)).map(c=>c.client_code));
  const contractClaims=myClicarClaims({contracts:myclicarContracts.filter(c=>!overriddenContracts.has(c.external_id)),source:bySource.get('myclicar'),now});
  const automatic=d=>['platform_plate','myclicar_contract'].includes(d?.vehicle_link_method)&&!d.auto_link_disabled;
  const currentLease=d=>{
    if(!automatic(d))return true;
    if(!trustedVehicleLease(d.vehicle_link_evidence)||!Number.isFinite(time(d.vehicle_link_evidence?.expires_at))||time(d.vehicle_link_evidence.expires_at)<=now)return false;
    if(d.vehicle_link_method==='myclicar_contract'){
      const claim=contractClaims.get(d.ludy_driver_code);
      return !!claim?.eligible&&claim.contract.external_id===d.vehicle_link_evidence.contract_id&&claim.contract.vehicle_key===d.vehicle_key;
    }
    return true;
  };
  const rows=drivers.map(d=>{
    const key=normalizedName(d.name),exact=names.get(key)||[],spacing=fullSpacedName(d.name)?reference.filter(r=>fullSpacedName(r.name)&&spacedNameKey(r.name)===spacedNameKey(d.name)):[];
    const matches=exact.length?exact:spacing,spacingOnly=!exact.length&&spacing.length>0,linked=byCode.get(d.ludy_driver_code);
    const ownIds=identities.filter(i=>i.driver_id===d.id);
    const duplicateIdentity=ownIds.some(i=>identities.some(other=>other.driver_id!==d.id&&other.source===i.source&&other.organization_id===i.organization_id&&(normalizedName(drivers.find(v=>v.id===other.driver_id)?.name)===key||spacingOnly&&spacedNameKey(drivers.find(v=>v.id===other.driver_id)?.name)===spacedNameKey(d.name))));
    let status,reason,target=linked;
    if(d.ludy_driver_code){status='linked';reason=d.link_method==='name_spacing'?'Nom complet unique, espaces harmonisés':d.link_method==='exact_name'?'Nom complet unique, association automatique':'Association existante conservée';}
    else if(d.auto_link_disabled){status='manual';reason='Association manuelle prioritaire';}
    else if(matches.length>1||duplicateIdentity){status='ambiguous';reason=matches.length>1?'Plusieurs fiches Ludy portent ce nom':'Plusieurs comptes de la même plateforme portent ce nom';}
    else if(matches.length===1&&canonicalByCode.get(matches[0].code)?.auto_link_disabled){status='manual';reason='La fiche Ludy correspondante est en mode manuel : confirmation nécessaire';target=matches[0];}
    else if(matches.length===1&&key.split(' ').length>=2){status='ready';reason=spacingOnly?'Nom complet unique, seules les séparations changent':'Nom complet identique et unique (accents et ordre des mots harmonisés)';target=matches[0];}
    else{status='unmatched';reason=matches.length===1?'Nom trop court pour une association automatique':'Aucun nom complet identique';}
    const row={driver_id:d.id,driver_name:d.name,status,ludy_driver_code:target?.code||d.ludy_driver_code||null,ludy_name:target?.name||null,reason,
      vehicle_key:d.vehicle_key||null,vehicle_link_method:d.vehicle_link_method||null,vehicle_plate:vehicles.find(v=>v.key===d.vehicle_key)?.plate||null,vehicle_reason:d.vehicle_key?'Association existante':'Aucune preuve actuelle exploitable',
      candidates:['ambiguous','unmatched'].includes(status)?suggestions(d.name,reference):[],link_method:spacingOnly?'name_spacing':'exact_name',vehicle_ready:false,vehicle_evidence:null,
      vehicle_invalidate:!!(d.vehicle_key&&automatic(d)&&!currentLease(d)),vehicle_conflict:d.vehicle_link_evidence?.assignment_conflict?.requires_confirmation===true};
    if(row.vehicle_conflict)row.vehicle_reason='Affectation manuelle contredite pendant un changement de chauffeur : nouvelle confirmation nécessaire';
    if(!target||!['ready','linked'].includes(status)||d.auto_link_disabled||d.vehicle_link_method==='manual'||d.vehicle_key&&!d.vehicle_link_method)return row;
    const contractClaim=contractClaims.get(target.code);
    const observed=observedVehicles.filter(l=>l.driver_id===d.id);
    const claims=[];let invalid=false;
    for(const sample of observed){
      const matches=plateVehicles(sample.vehicle_label);
      if(matches.length!==1){invalid=true;continue;}
      claims.push({vehicle:matches[0],sample});
    }
    if(!observed.length&&contractClaim&&!contractClaim.eligible){row.vehicle_reason='Contrats MyClicar ambigus ou référence non reconnue : vérification nécessaire';row.vehicle_invalidate=!!(d.vehicle_key&&automatic(d));return row;}
    if(!observed.length&&contractClaim){
      const vehicle=vehicles.find(v=>v.key===contractClaim.contract.vehicle_key&&active(v));
      if(vehicle)claims.push({vehicle,contractClaim});else invalid=true;
    }
    if(invalid||new Set(claims.map(c=>c.vehicle.key)).size>1){row.vehicle_reason='Plaques contradictoires ou ambiguës : vérification nécessaire';row.vehicle_invalidate=!!(d.vehicle_key&&automatic(d));return row;}
    if(!claims.length){
      if(overriddenCodes.has(target.code))row.vehicle_reason='Contrat MyClicar écarté après une affectation observée sur les plateformes';
      else if(latest.some(l=>l.driver_id===d.id&&l.source==='bolt'&&l.vehicle_label&&!trustedVehicleObservation(l)))row.vehicle_reason='Véhicule sélectionné dans Bolt : affectation actuelle non confirmée';
      return row;
    }
    claims.sort((a,b)=>Number(!!b.contractClaim)-Number(!!a.contractClaim)||(vehicleObservationWindow(b.sample,bySource.get(b.sample?.source)).observed||0)-(vehicleObservationWindow(a.sample,bySource.get(a.sample?.source)).observed||0));
    const {vehicle,sample,contractClaim:chosenContract}=claims[0],src=bySource.get(sample?.source);
    if(target.agency_id!=null&&String(vehicle.agency_id)!==String(target.agency_id)){row.vehicle_reason='Plaque observée dans une autre agence';row.vehicle_invalidate=!!(d.vehicle_key&&automatic(d));return row;}
    row.vehicle_ready=true;row.vehicle_key=vehicle.key;row.vehicle_plate=vehicle.plate;
    if(chosenContract){row.vehicle_reason='Contrat MyClicar en cours, départ effectif confirmé';row.vehicle_evidence=chosenContract.evidence;}
    else {row.vehicle_reason='Plaque actuelle transmise par '+(sample.source==='uber'?'Uber Fleet':'Bolt');
      const window=vehicleObservationWindow(sample,src);
      row.vehicle_evidence={method:'platform_plate',source:sample.source,vehicle_origin:sample.source==='bolt'?'bolt_live':'uber_visible',observed_at:new Date(window.observed).toISOString(),expires_at:new Date(window.expires).toISOString(),
        ...(sample.evidence?.vehicle_model?{vehicle_model:sample.evidence.vehicle_model}:{}),...(sample.evidence?.vehicle_status?{vehicle_status:sample.evidence.vehicle_status}:{})};}
    return row;
  });
  // Both fresh claims and still-held assignments participate in conflicts. An
  // offline previous driver must lose an automatic lease as soon as another
  // person is observed using that car, rather than accumulating their distance.
  // Unknown names can contradict an old assignment without being auto-linked.
  const byRow=new Map(rows.map(row=>[row.driver_id,row])),claimsByVehicle=new Map();
  const person=row=>row.ludy_driver_code?'ludy:'+row.ludy_driver_code:'profile:'+row.driver_id;
  const claim=(vehicleKey,row)=>{const owners=claimsByVehicle.get(vehicleKey)||new Set();owners.add(person(row));claimsByVehicle.set(vehicleKey,owners);};
  for(const sample of observedVehicles){const matches=plateVehicles(sample.vehicle_label);if(matches.length===1)claim(matches[0].key,byRow.get(sample.driver_id));}
  for(const row of rows){
    const driver=byDriver.get(row.driver_id);
    if(row.vehicle_ready)claim(row.vehicle_key,row);
    if(driver.vehicle_key&&!row.vehicle_invalidate&&currentLease(driver))claim(driver.vehicle_key,row);
  }
  const contested=new Set([...claimsByVehicle].filter(([,owners])=>owners.size>1).map(([key])=>key));
  for(const row of rows){
    const driver=byDriver.get(row.driver_id),heldConflict=driver.vehicle_key&&contested.has(driver.vehicle_key),proposedConflict=row.vehicle_ready&&contested.has(row.vehicle_key);
    if(!heldConflict&&!proposedConflict)continue;
    row.vehicle_conflict=true;
    if(proposedConflict)row.vehicle_ready=false;
    row.vehicle_reason=driver.vehicle_link_method==='manual'?'Affectation manuelle conservée, mais contredite par un autre chauffeur : vérification nécessaire':'Véhicule déjà revendiqué par un autre chauffeur';
    if(heldConflict&&automatic(driver))row.vehicle_invalidate=true;
  }
  return {at:new Date(now).toISOString(),automatic:true,rows,counts:{eligible:rows.filter(r=>r.status==='ready').length,linked:rows.filter(r=>r.status==='linked').length,
    unmatched:rows.filter(r=>r.status==='unmatched').length,ambiguous:rows.filter(r=>r.status==='ambiguous').length,manual:rows.filter(r=>r.status==='manual').length,vehicle_ready:rows.filter(r=>r.vehicle_ready).length}};
}

export function createDriverMatcher({list,db,now=Date.now}) {
  let pending=null,lastRun=null,lastError=null,nextAt=0;
  async function snapshot(){const [drivers,reference,identities,latest,vehicles,sources,myclicarContracts,contractOverrides]=await Promise.all([
    list('fleet_drivers'),list('drivers',{select:'code,name,agency_id'}),list('fleet_identities',{select:'id,driver_id,source,organization_id'}),
    list('fleet_latest',{select:'driver_id,source,status,observed_at,vehicle_label,evidence'}),list('vehicles',{select:'key,plate,other_plates,agency_id,active'}),
    list('fleet_sources',{select:'id,status,last_success_at,stale_after_s'}),list('fleet_myclicar_contracts',{current:'eq.true'}),
    list('fleet_contract_assignment_overrides',{select:'contract_id,client_code,vehicle_key,effective_start_at'})]);return planDriverMatches({drivers,reference,identities,latest,vehicles,sources,myclicarContracts,contractOverrides,now:now()});}
  async function review(){return {...await snapshot(),last_run:lastRun,last_error:lastError};}
  async function run({force=false}={}){
    if(pending)return pending;if(!force&&now()<nextAt)return {ok:true,skipped:true};
    nextAt=now()+10000;
    pending=(async()=>{
      try{
        await db('rpc/fleet_reconcile_vehicle_contracts',{method:'POST',body:{}});
        const plan=await snapshot();let applied=0,vehicleLinked=0;
        for(const row of plan.rows.filter(r=>r.status==='ready')){
          const target=await db(row.link_method==='name_spacing'?'rpc/fleet_auto_link_driver_spacing':'rpc/fleet_auto_link_driver',{method:'POST',body:{p_driver:row.driver_id,p_ludy_code:row.ludy_driver_code,p_platform_name:row.driver_name,p_ludy_name:row.ludy_name}});
          if(target)applied++;
        }
        let cars=await snapshot();
        // Revoke uncertain automatic evidence before considering new assignments.
        // Guard every write so a concurrent manual correction remains authoritative.
        for(const row of cars.rows.filter(r=>r.vehicle_invalidate))await db('fleet_drivers',{method:'PATCH',params:{id:'eq.'+row.driver_id,vehicle_link_method:'eq.'+row.vehicle_link_method,auto_link_disabled:'eq.false'},body:{vehicle_key:null,vehicle_link_evidence:{}}});
        if(cars.rows.some(r=>r.vehicle_invalidate))cars=await snapshot();
        for(const row of cars.rows.filter(r=>r.status==='linked'&&r.vehicle_ready)){
          const applied=row.vehicle_evidence.method==='myclicar_contract'
            ?await db('rpc/fleet_auto_link_myclicar_vehicle',{method:'POST',body:{p_driver:row.driver_id,p_contract_id:row.vehicle_evidence.contract_id}})
            :await db('rpc/fleet_auto_link_vehicle',{method:'POST',body:{p_driver:row.driver_id,p_vehicle_key:row.vehicle_key,p_evidence:row.vehicle_evidence}});if(applied)vehicleLinked++;
        }
        lastRun=new Date(now()).toISOString();lastError=null;return {ok:true,applied,vehicle_linked:vehicleLinked,review:await review()};
      }catch(e){lastError='Rapprochement automatique interrompu. Les associations précédentes sont conservées.';throw e;}
    })().finally(()=>{pending=null;});return pending;
  }
  return {review,run,get error(){return lastError;}};
}
