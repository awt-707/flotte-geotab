const SOURCES = ['geotab', 'texat'];
const MAX_MAPPINGS = 20000;
const identifier = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Référence d’association télémétrique invalide.');
  return value;
};
function instant(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError('Date d’association avec fuseau requise.');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day)), at = Date.parse(value);
  if (year < 1900 || month < 1 || month > 12 || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || !Number.isSafeInteger(at)) throw new TypeError('Date d’association invalide.');
  return new Date(at).toISOString();
}

/** Explicit historical evidence only. The caller is responsible for verifying
 * the evidence and authorization before recording it. Neither a plate/name nor
 * today's vehicle-device association establishes an earlier assignment. */
export function normalizeTelemetryMapping(input) {
  if (!input || !SOURCES.includes(input.source)) throw new TypeError('Source d’association invalide.');
  const mapping = {id: identifier(input.id), source: input.source, sourceId: identifier(input.sourceId),
    vehicleKey: identifier(input.vehicleKey), validFrom: instant(input.validFrom),
    validTo: input.validTo === null ? null : instant(input.validTo), confirmedAt: instant(input.confirmedAt),
    evidenceId: identifier(input.evidenceId)};
  if (mapping.validTo !== null && mapping.validTo <= mapping.validFrom) throw new TypeError('Période d’association invalide.');
  return mapping;
}

/** Resolve [from,to) as a whole, or the point observedAt. No interpolation,
 * retroactive assumption or interval splitting occurs. knownAt preserves what
 * was actually confirmed at the time of the requested historical view. */
export function resolveTelemetryMapping(mappings, {source, sourceId, observedAt, from, to, knownAt, vehicleKey = null} = {}) {
  if (!Array.isArray(mappings) || mappings.length > MAX_MAPPINGS || !SOURCES.includes(source)) throw new TypeError('Historique d’association invalide.');
  identifier(sourceId); if (vehicleKey !== null) identifier(vehicleKey);
  const known = instant(knownAt), interval = from !== undefined || to !== undefined;
  if (interval && observedAt !== undefined) throw new TypeError('Choisir un instant ou un intervalle d’association.');
  const start = instant(interval ? from : observedAt), end = interval ? instant(to) : start;
  if (interval && end <= start || end > known) throw new TypeError('Fenêtre d’association invalide.');
  const unique = new Map();
  for (const value of mappings) {
    const mapping = normalizeTelemetryMapping(value), previous = unique.get(mapping.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(mapping)) throw new TypeError('Version d’association contradictoire.');
    unique.set(mapping.id, mapping);
  }
  const history = [...unique.values()].filter(mapping => mapping.source === source && mapping.confirmedAt <= known);
  const overlaps = mapping => interval ? mapping.validFrom < end && (mapping.validTo === null || mapping.validTo > start)
    : mapping.validFrom <= start && (mapping.validTo === null || mapping.validTo > start);
  const covers = mapping => mapping.validFrom <= start && (mapping.validTo === null || (interval ? mapping.validTo >= end : mapping.validTo > start));
  const device = history.filter(mapping => mapping.sourceId === sourceId && overlaps(mapping));
  const missing = reason => ({confirmed: false, reason, mapping: null});
  if (!device.length) return missing('no_confirmed_mapping_at_observation');
  if (device.length !== 1) return missing('conflicting_device_mapping');
  const mapping = device[0];
  if (!covers(mapping)) return missing('mapping_does_not_cover_interval');
  if (history.some(other => other.vehicleKey === mapping.vehicleKey && other.sourceId !== sourceId && overlaps(other))) return missing('multiple_devices_for_vehicle');
  if (vehicleKey !== null && mapping.vehicleKey !== vehicleKey) return missing('vehicle_mapping_mismatch');
  return {confirmed: true, reason: null, mapping: {...mapping}, basis: 'explicit_temporal_evidence', knownAt: known};
}
