import {moroccoParts} from './morocco-time.mjs';
import { createHash } from 'node:crypto';
import { isCurrentMyClicarContract, myClicarClaims } from './myclicar-contracts.mjs';

const MAX_SOURCE_AGE_S = 300;
const FUTURE_TOLERANCE_MS = 5000;
const MINUTE = 60000, DAY = 86400000;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const activeVehicle = vehicle => vehicle.active !== false && String(vehicle.active).toUpperCase() !== 'NON';
const sameAssignment = (contract, override) => override.contract_id === contract.external_id &&
  override.client_code === contract.client_code && override.vehicle_key === contract.vehicle_key &&
  Number.isFinite(timestamp(contract.effective_start_at)) &&
  timestamp(override.effective_start_at) === timestamp(contract.effective_start_at);

const messages = {
  invalid_mode: 'Mode de surveillance du service invalide.',
  invalid_time: 'Heure de référence du service invalide.',
  source_unavailable: 'Contrats MyClicar indisponibles ou trop anciens : service non confirmé.',
  stale_contract: 'Contrats trop anciens : service non confirmé pour ces chauffeurs.',
  invalid_contract: 'Contrats incomplets ou incohérents : service non confirmé.',
  contract_overridden: 'Contrats écartés après une affectation observée sur les plateformes.',
  contract_conflict: 'Contrats contradictoires ou références non confirmées : service à vérifier.',
  unknown_driver: 'Des titulaires de contrat ne sont pas associés à une fiche chauffeur plateforme.',
  ambiguous_driver: 'Plusieurs profils correspondent au même titulaire de contrat.',
  unknown_vehicle: 'Des véhicules de contrat ne sont pas reconnus dans Ludy.',
  ambiguous_vehicle: 'Plusieurs véhicules correspondent à une référence de contrat.',
  inactive_vehicle: 'Des véhicules de contrat sont inactifs dans Ludy.',
  missing_agency: 'Agence du chauffeur ou du véhicule manquante : service à vérifier.',
  agency_mismatch: 'Les agences du chauffeur et du véhicule ne correspondent pas.',
  invalid_shift_settings: 'Horaires de shift invalides : service non confirmé.',
  invalid_shift_boundary: 'Heure locale de début ou de fin du shift ambiguë ou inexistante.'
};

function shiftSettings(params) {
  const values = new Map();
  if (Array.isArray(params)) {
    for (const row of params) {
      if (!['shiftDay', 'shiftNight', 'shiftAdvance'].includes(row?.key)) continue;
      if (values.has(row.key)) return null;
      values.set(row.key, row.value);
    }
  } else if (params && typeof params === 'object') {
    for (const key of ['shiftDay', 'shiftNight', 'shiftAdvance']) if (Object.hasOwn(params, key)) values.set(key, params[key]);
  } else return null;
  const minute = (key, fallback) => {
    if (!values.has(key)) return fallback * 60;
    const value = values.get(key);
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) return NaN;
    const hours = Number(value), result = hours * 60;
    return Number.isFinite(hours) && hours >= 0 && hours < 24 && Number.isInteger(result) ? result : NaN;
  };
  const day = minute('shiftDay', 7), night = minute('shiftNight', 19), advance = minute('shiftAdvance', 2);
  return [day, night, advance].every(Number.isFinite) && day !== night ? { day, night, advance } : null;
}

const localParts = moroccoParts;
const wallEpoch = p => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0);

// Convert a Moroccan wall time without assuming a fixed UTC offset. Both sides
// of a time change are checked; an ambiguous/nonexistent boundary is refused.
function localBoundary(wall) {
  const offsets = new Set([-36, 0, 36].map(hours => {
    const at = wall + hours * 3600000;
    return wallEpoch(localParts(at)) - at;
  }));
  const matches = [...offsets].map(offset => wall - offset).filter(at => wallEpoch(localParts(at)) === wall);
  return matches.length === 1 ? matches[0] : null;
}

function contractShift(start, settings) {
  // The advance classifies an early handover; it never advances the duty window.
  const local = localParts(start + settings.advance * MINUTE), minute = local.hour * 60 + local.minute;
  const isDay = settings.day < settings.night
    ? minute >= settings.day && minute < settings.night
    : minute >= settings.day || minute < settings.night;
  const from = isDay ? settings.day : settings.night, to = isDay ? settings.night : settings.day;
  const date = Date.UTC(local.year, local.month - 1, local.day) - (minute < from ? DAY : 0);
  const startAt = localBoundary(date + from * MINUTE);
  const endAt = localBoundary(date + (to <= from ? DAY : 0) + to * MINUTE);
  return startAt === null || endAt === null || endAt <= startAt ? null : {
    label: isDay ? 'Jour' : 'Nuit', day: iso(date).slice(0, 10), startAt, endAt
  };
}

/** Pure eligibility calculation. It neither reads providers nor infers a driver
 * from a name, a selected vehicle, a manager schedule or a stale platform lease. */
export function serviceDuty({ drivers = [], contracts = [], contractOverrides = [], vehicles = [], sources = [],
  params = {}, now = Date.now(), mode = 'contract' } = {}) {
  const duties = [], warnings = [];
  const coverage = { mode, source_fresh: false, contracts_seen: contracts.length, contracts_current: 0,
    contracts_overridden: 0, expected_drivers: 0, excluded_contracts: 0, excluded_by_reason: {} };
  const exclude = (reason, count = 1) => {
    coverage.excluded_contracts += count;
    coverage.excluded_by_reason[reason] = (coverage.excluded_by_reason[reason] || 0) + count;
  };
  const result = () => {
    coverage.expected_drivers = duties.length;
    for (const [code, count] of Object.entries(coverage.excluded_by_reason)) {
      if (messages[code]) warnings.push({ code, count, message: messages[code] });
    }
    return { duties, coverage, warnings };
  };
  if (!['contract', 'shift'].includes(mode)) { exclude('invalid_mode', contracts.length); return result(); }
  if (!Number.isFinite(now)) { exclude('invalid_time', contracts.length); return result(); }
  const sourceRows = sources.filter(source => source.id === 'myclicar'), source = sourceRows[0];
  const sourceTtl = source?.stale_after_s == null ? MAX_SOURCE_AGE_S : Number(source.stale_after_s);
  const ttl = Math.min(sourceTtl, MAX_SOURCE_AGE_S);
  const success = timestamp(source?.last_success_at);
  coverage.source_fresh = sourceRows.length === 1 && source.status === 'healthy' && Number.isFinite(sourceTtl) && ttl > 0 &&
    Number.isFinite(success) && success <= now + FUTURE_TOLERANCE_MS && now - success <= ttl * 1000;
  if (!coverage.source_fresh) { exclude('source_unavailable', contracts.length); return result(); }
  const settings = mode === 'shift' ? shiftSettings(params) : null;
  if (mode === 'shift' && !settings) { exclude('invalid_shift_settings', contracts.length); return result(); }

  const current = [];
  for (const contract of contracts) {
    if (!contract.current || contract.status !== 'IN_PROGRESS' || contract.deleted || contract.end_at != null) { exclude('not_current'); continue; }
    const started = timestamp(contract.effective_start_at), observed = timestamp(contract.observed_at);
    if (!nonempty(contract.external_id) || !nonempty(contract.client_code) || !Number.isFinite(started) ||
      !Number.isFinite(observed) || observed > now + FUTURE_TOLERANCE_MS) { exclude('invalid_contract'); continue; }
    if (started > now) { exclude('not_started'); continue; }
    if (!isCurrentMyClicarContract(contract, now) || now - observed > ttl * 1000) { exclude('stale_contract'); continue; }
    coverage.contracts_current++;
    if (contractOverrides.some(override => sameAssignment(contract, override))) {
      coverage.contracts_overridden++; exclude('contract_overridden'); continue;
    }
    current.push(contract);
  }
  const claims = myClicarClaims({ contracts: current, source, now });
  for (const contract of current) {
    const people = drivers.filter(driver => driver.ludy_driver_code === contract.client_code);
    if (!people.length || people.length === 1 && !nonempty(people[0].id)) { exclude('unknown_driver'); continue; }
    if (people.length !== 1) { exclude('ambiguous_driver'); continue; }
    const cars = vehicles.filter(vehicle => vehicle.key === contract.vehicle_key);
    if (!nonempty(contract.vehicle_key) || !cars.length) { exclude('unknown_vehicle'); continue; }
    if (cars.length !== 1) { exclude('ambiguous_vehicle'); continue; }
    const driver = people[0], vehicle = cars[0], claim = claims.get(contract.client_code);
    if (!claim?.eligible || claim.contract.external_id !== contract.external_id) { exclude('contract_conflict'); continue; }
    if (!activeVehicle(vehicle)) { exclude('inactive_vehicle'); continue; }
    if (driver.agency_id == null || vehicle.agency_id == null) { exclude('missing_agency'); continue; }
    if (String(driver.agency_id) !== String(vehicle.agency_id)) { exclude('agency_mismatch'); continue; }

    const effectiveStart = timestamp(contract.effective_start_at), shift = mode === 'shift' ? contractShift(effectiveStart, settings) : null;
    if (mode === 'shift' && !shift) { exclude('invalid_shift_boundary'); continue; }
    const startedAt = shift ? Math.max(effectiveStart, shift.startAt) : effectiveStart;
    const endsAt = shift ? shift.endAt : null;
    if (now < startedAt || endsAt !== null && now >= endsAt) { exclude('outside_shift'); continue; }
    const fingerprint = hash([contract.external_id, contract.client_code, contract.vehicle_key, iso(effectiveStart)]);
    const duty = { driver_id: driver.id, ludy_driver_code: contract.client_code, vehicle_key: contract.vehicle_key,
      contract_id: contract.external_id, contract_fingerprint: fingerprint,
      duty_key: hash([mode, fingerprint, iso(startedAt), endsAt === null ? null : iso(endsAt)]),
      started_at: iso(startedAt), ends_at: endsAt === null ? null : iso(endsAt), evidence: {
        mode, source: 'myclicar', contract_id: contract.external_id, contract_num: contract.num || null,
        client_code: contract.client_code, vehicle_key: contract.vehicle_key,
        effective_start_at: iso(effectiveStart), contract_observed_at: contract.observed_at,
        source_last_success_at: source.last_success_at, timezone: 'Africa/Casablanca',
        ...(shift ? { shift: shift.label, shift_day: shift.day, shift_started_at: iso(shift.startAt),
          shift_ends_at: iso(shift.endAt), shift_day_minutes: settings.day,
          shift_night_minutes: settings.night, shift_advance_minutes: settings.advance } : {})
      } };
    duties.push(duty);
  }
  duties.sort((a, b) => a.driver_id.localeCompare(b.driver_id));
  return result();
}
