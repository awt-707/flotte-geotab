import './timezone.js';

const MOROCCO = globalThis.LudyMoroccoTime;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ZONES = new Set(['Africa/Casablanca', 'Europe/Paris', 'UTC']);
const KINDS = new Set(['day', 'week', 'month']);
const SOURCES = new Set(['uber', 'bolt', 'private']);
const MONEY_FIELDS = Object.freeze(['revenue', 'reportedPayout', 'fare', 'tips', 'tolls', 'bonus', 'commission', 'gross', 'net', 'cash']);
const DATE_KEYS = ['year', 'month', 'day', 'hour', 'minute', 'second'];
let parisFormatter;

function zone(value) {
  if (!ZONES.has(value)) throw new TypeError('Fuseau du chiffre d’affaires non pris en charge.');
  return value;
}

export function revenueInstant(value) {
  let at;
  if (value instanceof Date) at = value.getTime();
  else if (typeof value === 'number') at = value;
  else if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) throw new TypeError('L’horodatage doit préciser son décalage horaire.');
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || month < 1 || month > 12 || day < 1 ||
        calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day ||
        hour > 23 || minute > 59 || second > 59) throw new TypeError('Horodatage invalide.');
    at = Date.parse(value);
  }
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new TypeError('Horodatage invalide.');
  const year = new Date(at).getUTCFullYear();
  if (year < 1900 || year > 9998) throw new RangeError('Année hors du calendrier pris en charge.');
  return at;
}

function wallParts(at, timeZone) {
  if (timeZone === 'Africa/Casablanca') return MOROCCO.moroccoParts(at);
  if (timeZone === 'Europe/Paris') {
    parisFormatter ||= new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    return Object.fromEntries(parisFormatter.formatToParts(at)
      .filter(part => DATE_KEYS.includes(part.type)).map(part => [part.type, Number(part.value)]));
  }
  const date = new Date(at);
  return {year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds()};
}

function wallNumber(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

function wallInstant(parts, timeZone) {
  if (timeZone === 'Africa/Casablanca') {
    const instant = MOROCCO.moroccoWallTime(parts);
    if (instant === null) throw new RangeError('La borne horaire est ambiguë ou inexistante.');
    return instant;
  }
  const local = wallNumber(parts);
  if (timeZone === 'UTC') return local;
  const wanted = {...parts, minute: parts.minute || 0, second: parts.second || 0};
  const offsets = new Set([-36, 0, 36].map(hours => {
    const candidate = local + hours * HOUR;
    return wallNumber(wallParts(candidate, timeZone)) - candidate;
  }));
  const matches = [...offsets].map(offset => local - offset).filter(candidate => {
    const actual = wallParts(candidate, timeZone);
    return DATE_KEYS.every(key => actual[key] === wanted[key]);
  });
  if (matches.length !== 1) throw new RangeError('La borne horaire est ambiguë ou inexistante.');
  return matches[0];
}

function shiftedDay(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate()};
}

function shiftedMonth(parts, months) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  return {...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1};
}

// Periods are [start, end). Weeks use Monday 04:00 by default; days and months
// use local midnight. All boundaries are calendar calculations, never +168 UTC h.
export function getRevenuePeriod({kind = 'week', at, timeZone = 'Africa/Casablanca', weekStartHour = 4} = {}) {
  if (!KINDS.has(kind)) throw new TypeError('Période de chiffre d’affaires invalide.');
  zone(timeZone);
  if (!Number.isInteger(weekStartHour) || weekStartHour < 0 || weekStartHour > 23) throw new TypeError('Heure de début de semaine invalide.');
  const instant = revenueInstant(at);
  const parts = wallParts(instant, timeZone);
  let beginning = {year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0};
  let next, previous;
  if (kind === 'week') {
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    beginning = shiftedDay({...beginning, hour: weekStartHour}, -((weekday + 6) % 7));
    if (instant < wallInstant(beginning, timeZone)) beginning = shiftedDay(beginning, -7);
    next = shiftedDay(beginning, 7);
    previous = shiftedDay(beginning, -7);
  } else if (kind === 'month') {
    beginning.day = 1;
    next = shiftedMonth(beginning, 1);
    previous = shiftedMonth(beginning, -1);
  } else {
    next = shiftedDay(beginning, 1);
    previous = shiftedDay(beginning, -1);
  }
  const start = wallInstant(beginning, timeZone), end = wallInstant(next, timeZone), previousStart = wallInstant(previous, timeZone);
  return Object.freeze({kind, timeZone, weekStartHour: kind === 'week' ? weekStartHour : null,
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    previousStart: new Date(previousStart).toISOString(), previousEnd: new Date(start).toISOString(),
    durationMs: end - start, previousDurationMs: start - previousStart});
}

export function revenueDay(value, {timeZone = 'Africa/Casablanca'} = {}) {
  const parts = wallParts(revenueInstant(value), zone(timeZone));
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dayParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new TypeError('Jour invalide.');
  revenueInstant(value + 'T12:00:00Z');
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0};
}

export function revenueLocalDayPeriod(day, {timeZone = 'Africa/Casablanca'} = {}) {
  return getRevenuePeriod({kind: 'day', at: wallInstant(dayParts(day), zone(timeZone)), timeZone});
}

export function getCustomRevenuePeriod({fromDay, toDay, timeZone = 'Africa/Casablanca'} = {}) {
  zone(timeZone);
  const first = dayParts(fromDay), last = dayParts(toDay);
  const days = (wallNumber(last) - wallNumber(first)) / DAY + 1;
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('La fin de période doit suivre son début.');
  const start = wallInstant(first, timeZone), end = wallInstant(shiftedDay(last, 1), timeZone);
  const previousStart = wallInstant(shiftedDay(first, -days), timeZone);
  return Object.freeze({kind: 'custom', timeZone, days, fromDay, toDay, weekStartHour: null,
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    previousStart: new Date(previousStart).toISOString(), previousEnd: new Date(start).toISOString(),
    durationMs: end - start, previousDurationMs: start - previousStart});
}

export function shiftRevenuePeriod(period, direction) {
  if (![1, -1].includes(direction)) throw new TypeError('Direction de période invalide.');
  if (period?.kind === 'custom') {
    const date = shiftedDay(dayParts(period.fromDay), period.days * direction);
    const last = shiftedDay(date, period.days - 1);
    const dayString = parts => `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    return getCustomRevenuePeriod({fromDay: dayString(date), toDay: dayString(last), timeZone: period.timeZone});
  }
  if (!KINDS.has(period?.kind)) throw new TypeError('Période invalide.');
  return getRevenuePeriod({kind: period.kind, at: direction === 1 ? period.end : period.previousStart,
    timeZone: period.timeZone, weekStartHour: period.weekStartHour ?? 4});
}

export function inRevenuePeriod(value, {start, end} = {}) {
  const first = revenueInstant(start), last = revenueInstant(end), at = revenueInstant(value);
  if (last <= first) throw new RangeError('La fin de période doit suivre son début.');
  return at >= first && at < last;
}

// Compare an in-progress interval with the same elapsed duration in the
// preceding calendar period. A shorter previous period is explicitly marked.
export function getRevenueComparisonWindow(period, through) {
  const start = revenueInstant(period?.start), end = revenueInstant(period?.end);
  const previousStart = revenueInstant(period?.previousStart), previousEnd = revenueInstant(period?.previousEnd);
  if (end <= start || previousEnd <= previousStart || previousEnd !== start) throw new RangeError('Périodes de comparaison invalides.');
  const cutoff = revenueInstant(through);
  if (cutoff < start || cutoff > end) throw new RangeError('La date de comparaison est hors de la période.');
  const elapsedMs = cutoff - start, previousCutoff = Math.min(previousStart + elapsedMs, previousEnd);
  return Object.freeze({start: period.start, end: new Date(cutoff).toISOString(),
    previousStart: period.previousStart, previousEnd: new Date(previousCutoff).toISOString(),
    durationMs: elapsedMs, previousDurationMs: previousCutoff - previousStart,
    equalDuration: previousCutoff - previousStart === elapsedMs});
}

function minorAmount(value) {
  if (value !== null && !Number.isSafeInteger(value)) throw new TypeError('Le montant doit être un entier en unité monétaire mineure, ou null.');
  return value;
}

export function sumRevenueMinor(values) {
  if (!Array.isArray(values)) throw new TypeError('Une liste de montants est requise.');
  let total = 0, known = 0, missing = 0;
  for (const value of values) {
    minorAmount(value);
    if (value === null) {missing++; continue;}
    total += value;
    if (!Number.isSafeInteger(total)) throw new RangeError('Somme monétaire hors limite.');
    known++;
  }
  return Object.freeze({minor: known ? total : null, known, missing, complete: known > 0 && missing === 0});
}

export function compareRevenueMinor(current, previous) {
  minorAmount(current); minorAmount(previous);
  if (current === null || previous === null) return Object.freeze({deltaMinor: null, percent: null, baselineZero: previous === 0});
  const deltaMinor = current - previous;
  if (!Number.isSafeInteger(deltaMinor)) throw new RangeError('Écart monétaire hors limite.');
  return Object.freeze({deltaMinor, percent: previous === 0 ? null : deltaMinor / Math.abs(previous) * 100, baselineZero: previous === 0});
}

function identifier(value, {optional = false} = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new TypeError('Identifiant financier invalide.');
  return value;
}

function normalizedRecord(row, timeZone) {
  if (!row || typeof row !== 'object' || !SOURCES.has(row.source)) throw new TypeError('Source financière invalide.');
  const sourceKind = row.sourceKind ?? 'reported';
  if (typeof sourceKind !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(sourceKind)) throw new TypeError('Nature financière invalide.');
  const id = identifier(row.id);
  const value = row.occurredAt ?? row.at;
  const at = value === undefined || value === null ? null : revenueInstant(value);
  if (row.day !== undefined && row.day !== null) dayParts(row.day);
  const day = at === null ? row.day : revenueDay(at, {timeZone});
  if (!day) throw new TypeError('Date financière absente.');
  const currency = row.currency ?? 'UNKNOWN';
  if (typeof currency !== 'string' || !/^(?:[A-Z]{3}|UNKNOWN|MAD_LEGACY)$/.test(currency)) throw new TypeError('Devise invalide.');
  const assumed = currency === 'MAD_LEGACY' || row.assumedCurrency === true || row.currencyBasis === 'legacy_mad_convention';
  const currencyCode = currency === 'UNKNOWN' ? null : currency === 'MAD_LEGACY' ? 'MAD' : currency;
  const currencyGroup = assumed && currencyCode ? currencyCode + '_LEGACY' : currency;
  const amounts = Object.fromEntries(MONEY_FIELDS.map(field => [field, minorAmount(row[field + 'Minor'] ?? null)]));
  const driverKey = identifier(row.driverKey, {optional: true});
  const driverName = typeof row.driverName === 'string' && row.driverName.length <= 200 ? row.driverName : null;
  return {source: row.source, sourceKind, id, at, day, amounts, currencyGroup, currencyCode, assumed,
    driverKey, driverName, void: row.void === true,
    estimated: row.estimated === true || sourceKind.endsWith('_estimate'),
    granularity: at === null ? 'day' : row.granularity === 'session' ? 'session' : 'transaction'};
}

function aggregateRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.currencyGroup)) groups.set(row.currencyGroup, []);
    groups.get(row.currencyGroup).push(row);
  }
  const currencies = [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([currency, group]) => ({
    currency, currencyCode: group[0].currencyCode, records: group.length,
    assumedCurrencyRecords: group.filter(row => row.assumed).length,
    // Unspecified currencies may represent different units, so even the UNKNOWN
    // bucket does not add their numeric amounts into a fictitious money total.
    ...Object.fromEntries(MONEY_FIELDS.map(field => [field, sumRevenueMinor(group.map(row => row.currencyCode ? row.amounts[field] : null))]))
  }));
  return {records: rows.length, currencies};
}

function groupedRows(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({...labelOf(group[0]), ...aggregateRows(group)}));
}

/** Aggregate reported financial movements, never estimates of ride prices.
 * Missing amounts are not zero. Totals describe the supplied records only;
 * sourceComplete must be supplied explicitly to claim complete source coverage.
 * A day-only movement cannot be assigned to one side of a 04:00 boundary.
 */
export function summarizeRevenue(records, {start, end, timeZone = 'Africa/Casablanca', sourceComplete = false} = {}) {
  if (!Array.isArray(records)) throw new TypeError('Une liste de mouvements financiers est requise.');
  zone(timeZone);
  const first = revenueInstant(start), last = revenueInstant(end);
  if (last < first) throw new RangeError('La fin de période doit suivre son début.');
  const counts = {input: records.length, invalid: 0, duplicates: 0, conflicts: 0, void: 0,
    estimates: 0, outside: 0, boundaryUncertain: 0};
  const unique = new Map();
  for (const input of records) {
    let row;
    try { row = normalizedRecord(input, timeZone); }
    catch { counts.invalid++; continue; }
    const key = JSON.stringify([row.source, row.sourceKind, row.id]);
    const signature = JSON.stringify([row.at, row.day, row.amounts, row.currencyGroup, row.driverKey, row.void, row.estimated, row.granularity]);
    const entry = unique.get(key);
    if (entry) {
      if (entry.signature === signature && !entry.conflict) counts.duplicates++;
      else if (!entry.conflict) {entry.conflict = true; counts.conflicts++;}
    } else unique.set(key, {row, signature, conflict: false});
  }
  const included = [], uncertainDay = [];
  for (const {row, conflict} of unique.values()) {
    if (conflict) continue;
    if (row.void) {counts.void++; continue;}
    if (row.estimated) {counts.estimates++; continue;}
    if (first === last) {counts.outside++; continue;}
    if (row.at !== null) {
      if (row.at < first || row.at >= last) {counts.outside++; continue;}
    } else {
      const period = revenueLocalDayPeriod(row.day, {timeZone});
      const beginning = Date.parse(period.start), ending = Date.parse(period.end);
      if (ending <= first || beginning >= last) {counts.outside++; continue;}
      if (beginning < first || ending > last) {counts.boundaryUncertain++; uncertainDay.push(row); continue;}
    }
    included.push(row);
  }
  const result = aggregateRows(included);
  const missingRevenueRecords = included.filter(row => row.amounts.revenue === null).length;
  const unknownCurrencyRecords = included.filter(row => row.currencyCode === null).length;
  const assumedCurrencyRecords = included.filter(row => row.assumed).length;
  const selectionComplete = counts.invalid === 0 && counts.conflicts === 0 && counts.boundaryUncertain === 0;
  const recordsComplete = selectionComplete && missingRevenueRecords === 0;
  return {
    ...result, period: {start: new Date(first).toISOString(), end: new Date(last).toISOString(), timeZone}, counts,
    bySource: groupedRows(included, row => row.source, row => ({source: row.source})),
    byDay: groupedRows(included, row => row.day, row => ({day: row.day})),
    byDriver: groupedRows(included, row => JSON.stringify([row.source, row.driverKey]), row => ({source: row.source, driverKey: row.driverKey, driverName: row.driverKey ? row.driverName : null})),
    uncertainDay: {
      ...aggregateRows(uncertainDay),
      bySource: groupedRows(uncertainDay, row => row.source, row => ({source: row.source})),
      byDay: groupedRows(uncertainDay, row => row.day, row => ({day: row.day})),
      byDriver: groupedRows(uncertainDay, row => JSON.stringify([row.source, row.driverKey]), row => ({source: row.source, driverKey: row.driverKey, driverName: row.driverKey ? row.driverName : null}))
    },
    coverage: {sourceComplete: sourceComplete === true, selectionComplete, recordsComplete, missingRevenueRecords,
      unknownCurrencyRecords, assumedCurrencyRecords,
      dayOnlyRecords: included.filter(row => row.at === null).length,
      sessionRecords: included.filter(row => row.granularity === 'session').length,
      complete: sourceComplete === true && recordsComplete && unknownCurrencyRecords === 0 && assumedCurrencyRecords === 0}
  };
}

export function compareRevenueSummaries(current, previous, {equalDuration = true} = {}) {
  if (!current || !previous || !Array.isArray(current.currencies) || !Array.isArray(previous.currencies)) throw new TypeError('Synthèses financières invalides.');
  const first = new Map(current.currencies.map(row => [row.currency, row]));
  const second = new Map(previous.currencies.map(row => [row.currency, row]));
  const currencies = [...new Set([...first.keys(), ...second.keys()])].sort().map(currency => {
    const now = first.get(currency), before = second.get(currency);
    return {currency, currencyCode: (now ?? before).currencyCode,
      ...Object.fromEntries(MONEY_FIELDS.map(field => {
        const comparable = equalDuration === true && current.coverage?.selectionComplete === true && previous.coverage?.selectionComplete === true && !!now?.[field]?.complete && !!before?.[field]?.complete;
        const change = compareRevenueMinor(comparable ? now[field].minor : null, comparable ? before[field].minor : null);
        return [field, {currentMinor: now?.[field]?.minor ?? null, previousMinor: before?.[field]?.minor ?? null,
          ...change, comparable}];
      }))};
  });
  return {currencies, equalDuration: equalDuration === true,
    complete: equalDuration === true && current.coverage?.complete === true && previous.coverage?.complete === true};
}
