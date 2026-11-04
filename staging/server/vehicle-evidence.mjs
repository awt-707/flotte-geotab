import {normalizeGeotabPlate} from './geotab-matching.mjs';
const ONLINE_STATES = new Set(['available', 'on_trip', 'to_pickup', 'on_break']);

// A selected Bolt vehicle belongs to the account configuration. Reading it again
// does not prove that this driver is currently using it, especially while offline.
export function trustedVehicleObservation(row) {
  if (!row?.vehicle_label) return false;
  if (row.source === 'uber') return (!row.evidence?.method || row.evidence.method === 'visible_dom') &&
    (row.evidence?.vehicle_status ? ONLINE_STATES.has(row.evidence.vehicle_status)&&ONLINE_STATES.has(row.status) : !['offline','unknown'].includes(row.status));
  return row.source === 'bolt' && row.evidence?.method === 'official_api' &&
    row.evidence.vehicle_origin === 'bolt_live' && ONLINE_STATES.has(row.status);
}

// Vehicle details and platform availability may be read at different times.
export function vehicleObservationWindow(row, source) {
  const separate=row?.source==='uber'&&row.evidence?.vehicle_observed_at!=null;
  const observed=Date.parse(separate?row.evidence.vehicle_observed_at:row?.observed_at);
  const ttl=separate?180:Math.min(Number(source?.stale_after_s)||90,180);
  return {observed,expires:observed+ttl*1000};
}

// A live claim by a different driver suspends movement attribution even when
// an operator's manual association must remain untouched.
export function conflictingVehicleAssignments({drivers=[],latest=[],sources=[],vehicles=[],now=Date.now()}) {
  const conflicts=new Set(),sourceMap=new Map(sources.map(s=>[s.id,s])),driverMap=new Map(drivers.map(d=>[d.id,d])),claims=new Map();
  for(const row of latest){
    const source=sourceMap.get(row.source),at=Date.parse(row.observed_at),success=Date.parse(source?.last_success_at),window=vehicleObservationWindow(row,source),ttl=(source?.stale_after_s||90)*1000;
    if(!ONLINE_STATES.has(row.status)||!trustedVehicleObservation(row)||source?.status!=='healthy'||!Number.isFinite(at)||at>now+5000||now-at>ttl||!Number.isFinite(success)||success>now+5000||now-success>ttl||!Number.isFinite(window.observed)||window.observed>at||window.expires<=now||['suspended','deactivated'].includes(row.evidence?.account_status))continue;
    const plate=normalizeGeotabPlate(row.vehicle_label);if(!plate)continue;
    const matches=vehicles.filter(v=>[v.key,v.plate,...String(v.other_plates||'').split(/[,;]/)].some(p=>normalizeGeotabPlate(p)===plate));
    if(matches.length!==1)continue;
    const owners=claims.get(matches[0].key)||new Set();owners.add(row.driver_id);claims.set(matches[0].key,owners);
  }
  for(const driver of drivers){if(!driver.vehicle_key)continue;
    const other=[...(claims.get(driver.vehicle_key)||[])].some(id=>id!==driver.id&&(!driver.ludy_driver_code||driverMap.get(id)?.ludy_driver_code!==driver.ludy_driver_code));
    if(other)conflicts.add(driver.vehicle_key);
  }
  return conflicts;
}

// Legacy Bolt leases were also created from the roster's selected vehicle. They
// cannot establish a current assignment; manual assignments use another method.
export function trustedVehicleLease(evidence) {
  if(evidence?.source==='myclicar') {
    const observed=Date.parse(evidence.observed_at),expiry=Date.parse(evidence.expires_at);
    return evidence.method==='myclicar_contract'&&typeof evidence.contract_id==='string'&&!!evidence.contract_id&&
      typeof evidence.client_code==='string'&&!!evidence.client_code&&typeof evidence.vehicle_key==='string'&&!!evidence.vehicle_key&&
      Number.isFinite(observed)&&Number.isFinite(expiry)&&expiry>observed&&expiry-observed<=300000;
  }
  return evidence?.source === 'uber' || evidence?.source === 'bolt' && evidence.vehicle_origin === 'bolt_live';
}
