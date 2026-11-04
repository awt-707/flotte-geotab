/** A formatting key, not transliteration or fuzzy matching. In particular,
 * Arabic plate letters retain their identity and leading zeroes are retained. */
export function teksatIdentifierKey(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const key = value.normalize('NFKC').toUpperCase()
    .replace(/[٠-٩]/gu, digit => String(digit.codePointAt(0) - 0x660))
    .replace(/[۰-۹]/gu, digit => String(digit.codePointAt(0) - 0x6f0))
    .replace(/[\s\p{Dash_Punctuation}\u200e\u200f\u061c]/gu, '');
  return key && /^[\p{L}\p{N}]+$/u.test(key) ? key : null;
}

const vinKey = value => typeof value === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
const fail = () => {throw new TypeError('Catalogue de rapprochement Teksat invalide.');};

/** Returns candidates only: no current or historical assignment is created.
 * Catalogue completeness must be proved by the caller. All provider rows,
 * including inactive vehicles, participate in ambiguity detection. */
export function findTeksatMappingCandidates(vehicles, catalogue, {catalogueComplete = false} = {}) {
  if (!Array.isArray(vehicles) || vehicles.length > 20000 || !Array.isArray(catalogue) || catalogue.length > 20000) fail();
  const localIds = new Set(), providerIds = new Set(), deviceCounts = new Map();
  const local = vehicles.map(row => {
    if (typeof row?.key !== 'string' || !row.key || localIds.has(row.key) || !Array.isArray(row.otherPlates ?? [])) fail();
    localIds.add(row.key);
    const aliases = new Map();
    const add = (value, reason) => {const key = teksatIdentifierKey(value); if (key) {const reasons = aliases.get(key) || []; reasons.push(reason); aliases.set(key, reasons);}};
    add(row.plate, 'current_plate'); for (const plate of row.otherPlates ?? []) add(plate, 'registered_plate_alias');
    add(row.geotabName, 'geotab_label');
    return {key: row.key, aliases, vin: vinKey(row.vin), active: row.active !== false && String(row.active).trim().toUpperCase() !== 'NON'};
  });
  const remote = catalogue.map(row => {
    if (typeof row?.providerVehicleId !== 'string' || !row.providerVehicleId || providerIds.has(row.providerVehicleId) || (row.deviceId !== null && (typeof row.deviceId !== 'string' || !row.deviceId))) fail();
    providerIds.add(row.providerVehicleId); if (row.deviceId) deviceCounts.set(row.deviceId, (deviceCounts.get(row.deviceId) || 0) + 1);
    return {...row, vin: vinKey(row.vin), keys: [...new Set([teksatIdentifierKey(row.plate), teksatIdentifierKey(row.identifier)].filter(Boolean))]};
  });
  const candidates = [];
  for (const source of remote) {
    for (const target of local) {
      const reasons = new Set();
      if (source.vin && target.vin && source.vin === target.vin) reasons.add('exact_vin');
      for (const key of source.keys) for (const reason of target.aliases.get(key) || []) reasons.add(reason);
      if (!reasons.size) continue;
      candidates.push({vehicleKey: target.key, providerVehicleId: source.providerVehicleId, deviceId: source.deviceId,
        reasons: [...reasons].sort(), active: source.active !== false && target.active,
        vinConflict: !!(source.vin && target.vin && source.vin !== target.vin), confirmed: false});
    }
  }
  const localCount = new Map(), remoteCount = new Map();
  for (const row of candidates) {localCount.set(row.vehicleKey, (localCount.get(row.vehicleKey) || 0) + 1); remoteCount.set(row.providerVehicleId, (remoteCount.get(row.providerVehicleId) || 0) + 1);}
  for (const row of candidates) {
    row.blockingReasons = [];
    if (!catalogueComplete) row.blockingReasons.push('catalogue_incomplete');
    if (localCount.get(row.vehicleKey) !== 1 || remoteCount.get(row.providerVehicleId) !== 1 || (row.deviceId && deviceCounts.get(row.deviceId) !== 1)) row.blockingReasons.push('ambiguous_identity');
    if (!row.deviceId) row.blockingReasons.push('missing_device');
    if (row.vinConflict) row.blockingReasons.push('vin_conflict');
    if (!row.active) row.blockingReasons.push('inactive_vehicle');
    if (row.reasons.every(reason => reason === 'geotab_label')) row.blockingReasons.push('label_only');
    row.unambiguousCandidate = row.blockingReasons.length === 0;
  }
  return {catalogueComplete, vehicles: local.length, providerVehicles: remote.length, candidates,
    unambiguousCandidates: candidates.filter(row => row.unambiguousCandidate).length,
    confirmedMappings: 0};
}
