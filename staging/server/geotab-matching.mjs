// Matching rules from collector/src/15_engine.gs (normPlate_, platesOf_,
// mapGeotabDevices). Only unique, unclaimed matches are proposed here.
// This module performs no I/O and never modifies its inputs.
export function normalizeGeotabPlate(value) {
  const text=String(value || '').toUpperCase().replace(/[^0-9A-Z]/g,'');
  return text.replace(/[^0-9]/g,'')+text.replace(/[^A-Z]/g,'');
}

export function matchGeotabVehicles(vehicles,devices) {
  if(!Array.isArray(vehicles)||!Array.isArray(devices))throw new TypeError('Listes de véhicules et de boîtiers requises');
  const result={matches:[],unmatched:[],ambiguous:[],conflicts:[],existing:[]};
  // Existing associations remain authoritative, including an inactive vehicle's.
  const claimed=new Set(vehicles.map(v=>v?.geotab_id).filter(id=>typeof id==='string'&&id));
  const pending=[],byDevice=new Map();
  for(const vehicle of vehicles) {
    if(!vehicle||typeof vehicle.key!=='string'||!vehicle.key||String(vehicle.active).toUpperCase()==='NON'||vehicle.active===false)continue;
    if(vehicle.geotab_id){result.existing.push(vehicle.key);continue;}
    if(vehicle.geotab_auto_link_disabled===true)continue;
    const aliases=String(vehicle.other_plates || '').split(/[,;]\s*/);
    // The persisted key is already canonical in production. Include it as-is,
    // alongside the normalized current and historical registration plates.
    const keys=new Set([vehicle.key,...[vehicle.plate,...aliases].map(normalizeGeotabPlate)].filter(Boolean));
    const vin=String(vehicle.vin || '').trim().toUpperCase();
    const candidates=new Map();
    for(const device of devices) {
      if(!device||typeof device.id!=='string'||!device.id)continue;
      const reasons=[];
      const name=normalizeGeotabPlate(device.name);
      const plates=[device.plate,device.licensePlate].map(normalizeGeotabPlate).filter(Boolean);
      if(name&&keys.has(name))reasons.push('Nom Geotab');
      if(plates.some(plate=>keys.has(plate)))reasons.push('Plaque Geotab');
      const deviceVin=String(device.vin || device.vehicleIdentificationNumber || '').trim().toUpperCase();
      if(vin.trim()&&deviceVin===vin)reasons.push('VIN');
      if(!reasons.length)continue;
      const candidate=candidates.get(device.id) || {device,reason:new Set(),vinConflict:false};
      if(vin&&deviceVin&&deviceVin!==vin)candidate.vinConflict=true;
      reasons.forEach(reason=>candidate.reason.add(reason));candidates.set(device.id,candidate);
    }
    pending.push({vehicle,candidates});
    for(const id of candidates.keys()) {
      const owners=byDevice.get(id) || new Set();owners.add(vehicle.key);byDevice.set(id,owners);
    }
  }
  for(const {vehicle,candidates} of pending) {
    if(!candidates.size){result.unmatched.push(vehicle.key);continue;}
    if(candidates.size>1){result.ambiguous.push(vehicle.key);continue;}
    const [id,candidate]=candidates.entries().next().value;
    if(candidate.vinConflict||claimed.has(id)||byDevice.get(id).size>1){result.conflicts.push(vehicle.key);continue;}
    result.matches.push({vehicle_key:vehicle.key,device_id:id,device_name:typeof candidate.device.name==='string'?candidate.device.name:'',reason:[...candidate.reason].join(' + ')});
  }
  return result;
}
