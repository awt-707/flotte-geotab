import {validUberEarningsProvenance} from './provider-earnings-calculation.js';
import {revenueInstant, summarizeRevenue, sumRevenueMinor, getRevenuePeriod} from './revenue-metrics.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000, MAX_ROWS = 20000, MAX_WINDOWS = 100;
const FIELDS = Object.freeze({revenue: 'revenue_minor', gross: 'gross_minor', net: 'net_minor',
  reportedPayout: 'payout_minor', reportedNetEarnings: 'reported_net_earnings_minor', cash: 'cash_minor', fare: 'fare_minor', tips: 'tips_minor',
  tolls: 'tolls_minor', bonus: 'bonus_minor', commission: 'commission_minor', taxes: 'taxes_minor',
  refundsExpenses: 'refunds_expenses_minor', adjustments: 'adjustments_minor',
  startBalance: 'start_balance_minor', endBalance: 'end_balance_minor'});
const SUMMARY_FIELDS = ['revenue', 'gross', 'net', 'reportedPayout', 'cash', 'fare', 'tips', 'tolls', 'bonus', 'commission'];
// Only additive financial flows whose meaning is explicit on every driver row.
// Payouts, balances, refunds/expenses and prior-period adjustments are excluded.
const FLEET_DRIVER_FALLBACK_FIELDS = Object.freeze({revenue: 'Revenus déclarés', gross: 'Brut', net: 'Net',
  commission: 'Commissions', fare: 'Tarif', tips: 'Pourboires', tolls: 'Péages', bonus: 'Primes', cash: 'Espèces déclarées'});
const SNAPSHOT_COLUMNS = 'id,source,organization_id,period_start,period_end,time_zone,period_label,period_mode,currency,observed_at,received_at,revision,coverage,fleet_amounts,financial_provenance';
const ROW_COLUMNS = 'snapshot_id,provider_row,source,organization_id,period_start,period_end,time_zone,currency,observed_at,snapshot_revision,coverage_complete,mapping_complete,agency_rows_total,driver_rows_total,provider_driver_id,driver_name,driver_name_complete,fleet_driver_id,driver_code,agency_id,mapping_status,amounts,financial_provenance';
const aborted = () => new DOMException('Lecture remplacée ou session modifiée.', 'AbortError');
const accessError = (status, message) => Object.assign(Error(message), {status, code: status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN'});
function providerAccessError(result) {
  const code = result?.error?.code;
  if (Number(result?.status) === 401 || Number(result?.error?.status) === 401 || ['PGRST301', 'PGRST302', 'PGRST303'].includes(code)) return accessError(401, 'Connexion Ludy requise.');
  if (Number(result?.status) === 403 || Number(result?.error?.status) === 403 || code === '42501') return accessError(403, 'Accès aux revenus réservé à la gestion.');
  return null;
}
const emptyMetric = () => ({minor: null, known: 0, missing: 0, complete: false});

function scope({agencyId = null, driverCode = null, organizationIds = []} = {}) {
  if (agencyId !== null && (typeof agencyId !== 'string' || !/^[1-9]\d*$/.test(agencyId))) throw new TypeError('Agence invalide.');
  if (driverCode !== null && (typeof driverCode !== 'string' || !driverCode.trim() || driverCode.length > 100 || /[\u0000-\u001f]/.test(driverCode))) throw new TypeError('Chauffeur invalide.');
  if (!Array.isArray(organizationIds) || organizationIds.length > 100 || organizationIds.some(id => typeof id !== 'string' || !UUID.test(id))) throw new TypeError('Flottes fournisseur invalides.');
  return {agencyId, driverCode, organizationIds: [...new Set(organizationIds.map(id => id.toLowerCase()))].sort()};
}

function windowOf(period) {
  const start = revenueInstant(period?.start), end = revenueInstant(period?.end);
  if (end <= start || end - start > 367 * 86400000 || period?.timeZone !== 'Africa/Casablanca') throw new RangeError('Période fournisseur invalide.');
  return {start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone: period.timeZone};
}

function positiveRevision(value) {
  const revision = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Révision fournisseur invalide.');
  return revision;
}

function metadata(row, now) {
  if (row?.source !== 'uber' || !UUID.test(row.organization_id || '') || !UUID.test(row.snapshot_id || row.id || '') || !/^[A-Z]{3}$/.test(row.currency || '')) throw new TypeError('Identité fournisseur invalide.');
  const period = windowOf({start: row.period_start, end: row.period_end, timeZone: row.time_zone});
  const observed = revenueInstant(row.observed_at);
  if (observed > now + 60000) throw new TypeError('Date de lecture fournisseur invalide.');
  return {id: (row.snapshot_id || row.id).toLowerCase(), source: 'uber', organizationId: row.organization_id.toLowerCase(),
    period, currency: row.currency, observedAt: new Date(observed).toISOString(),
    revision: positiveRevision(row.snapshot_revision ?? row.revision)};
}

function amounts(value,provenance=null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Montants fournisseur invalides.');
  if(!validUberEarningsProvenance(value,provenance))throw new TypeError('Preuve financière incohérente.');
  return Object.fromEntries(Object.entries(FIELDS).map(([name, key]) => {
    const amount = value[key] ?? null;
    if (amount !== null && !Number.isSafeInteger(amount)) throw new TypeError('Montant fournisseur invalide.');
    return [name, amount];
  }));
}

function currencyGroup(values, currency) {
  return {currency, currencyCode: currency, records: values.length, assumedCurrencyRecords: 0,
    ...Object.fromEntries(Object.keys(FIELDS).map(field => [field, sumRevenueMinor(values.map(value => value[field]))]))};
}

function sameWindow(a, b) { return a.start === b.start && a.end === b.end && a.timeZone === b.timeZone; }
function canonicalWeek(period) {
  if (period?.kind !== 'week' || period.timeZone !== 'Africa/Casablanca') return false;
  return sameWindow(windowOf(period), getRevenuePeriod({kind: 'week', at: period.start, timeZone: period.timeZone}));
}
function sameMetadata(a, b) { return a.id === b.id && a.organizationId === b.organizationId && sameWindow(a.period, b.period) && a.currency === b.currency && a.observedAt === b.observedAt && a.revision === b.revision; }
function expectedCount(rows, key) { const values = new Set(rows.map(row => row.raw[key])); return values.size === 1 && Number.isSafeInteger([...values][0]) && [...values][0] >= 1 ? [...values][0] : null; }
function confirmedIdentity(raw) {
  return raw.mapping_status === 'confirmed' && UUID.test(raw.provider_driver_id || '') && UUID.test(raw.fleet_driver_id || '') &&
    typeof raw.driver_code === 'string' && raw.driver_code.length > 0 && raw.driver_code.length <= 100 && !/[\u0000-\u001f]/.test(raw.driver_code) &&
    Number.isSafeInteger(Number(raw.agency_id)) && Number(raw.agency_id) > 0;
}
function driverSummaries(rows, meta, queryComplete) {
  const grouped = new Map();
  for (const row of rows) {
    if (!confirmedIdentity(row.raw)) continue;
    const key = JSON.stringify([String(row.raw.agency_id), row.raw.driver_code]);
    if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row);
  }
  return [...grouped.values()].map(items => {
    const first = items[0].raw, names = [...new Set(items.map(({raw}) => raw.driver_name_complete === true && typeof raw.driver_name === 'string' &&
      raw.driver_name.trim().length > 0 && raw.driver_name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw.driver_name) ? raw.driver_name.trim() : null).filter(Boolean))];
    const expected = expectedCount(items, 'driver_rows_total');
    return {source: 'uber', driverKey: first.driver_code, driverName: names.length === 1 ? names[0] : null,
      agencyId: String(first.agency_id), records: 0, providerPeriods: 1, granularity: 'provider_period',
      currencies: [currencyGroup(items.map(item => item.amounts), meta.currency)], period: {...meta.period}, observedAt: meta.observedAt,
      coverage: {complete: queryComplete === true && expected === items.length && items.every(({raw}) => raw.coverage_complete === true && raw.mapping_complete === true),
        expectedDriverRows: expected, observedDriverRows: items.length}};
  });
}

/** Select immutable provider windows. A fleet header and its driver rows are
 * alternate views of the same money; they are never added to each other. */
export function selectProviderEarnings({snapshots = [], rows = [], period, agencyId = null, driverCode = null,
  organizationIds = [], role = 'manager', queryComplete = true, now = Date.now()} = {}) {
  if (!Array.isArray(snapshots) || !Array.isArray(rows) || !['admin', 'manager'].includes(role)) throw new TypeError('Lecture fournisseur invalide.');
  const requested = windowOf(period), selection = scope({agencyId, driverCode, organizationIds}), instant = revenueInstant(now);
  const weekly = canonicalWeek(period);
  const openWeek = weekly && instant >= Date.parse(requested.start) && instant < Date.parse(requested.end);
  const groups = new Map(), rejected = new Set(), issues = [];
  const permitted = meta => !selection.organizationIds.length || selection.organizationIds.includes(meta.organizationId);
  const add = meta => { if (!groups.has(meta.id)) groups.set(meta.id, {meta, header: null, rows: [], rowIds: new Set()}); return groups.get(meta.id); };
  for (const row of snapshots) {
    let meta;
    try {
      meta = metadata(row, instant); if (!permitted(meta)) continue;
      const group = add(meta);
      if (group.header || !sameMetadata(group.meta, meta)) throw new TypeError('Relevé dupliqué ou modifié.');
      group.header = {raw: row, amounts: amounts(row.fleet_amounts,row.financial_provenance)};
    } catch { if (meta) rejected.add(meta.id); issues.push('invalid_snapshot'); }
  }
  for (const row of rows) {
    let meta;
    try {
      meta = metadata(row, instant); if (!permitted(meta)) continue;
      const group = add(meta);
      if (!sameMetadata(group.meta, meta) || !Number.isSafeInteger(row.provider_row) || row.provider_row < 0 || group.rowIds.has(row.provider_row)) throw new TypeError('Lignes du relevé incohérentes.');
      group.rowIds.add(row.provider_row);
      group.rows.push({raw: row, amounts: amounts(row.amounts,row.financial_provenance)});
    } catch { if (meta) rejected.add(meta.id); issues.push('invalid_row'); }
  }
  const reports = [];
  for (const [snapshotId, group] of groups) {
    if (rejected.has(snapshotId)) continue;
    const {meta, header} = group;
    const selectedRows = group.rows.filter(({raw}) => (role === 'admin' || confirmedIdentity(raw)) && (!agencyId || String(raw.agency_id) === agencyId) && (!driverCode || raw.driver_code === driverCode));
    const fleet = role === 'admin' && agencyId === null && driverCode === null && header !== null;
    if (!fleet && !selectedRows.length) continue;
    const rowProof = selectedRows.length > 0 && selectedRows.every(({raw}) => raw.coverage_complete === true && raw.mapping_complete === true && confirmedIdentity(raw));
    let expected = null;
    if (fleet) expected = header.raw.coverage?.driver_rows_observed;
    else if (driverCode) expected = expectedCount(selectedRows, 'driver_rows_total');
    else if (agencyId) expected = expectedCount(selectedRows, 'agency_rows_total');
    // An all-agencies manager sees only their RLS scope. Without an explicit
    // agency there is no proof that it equals a full provider organization.
    const countMatches = Number.isSafeInteger(expected) && expected >= 0 && (fleet ? group.rows.length : selectedRows.length) === expected;
    const collectionComplete = fleet ? header.raw.coverage?.complete === true && group.rows.every(({raw}) => raw.coverage_complete === true) : rowProof;
    const complete = queryComplete === true && collectionComplete && countMatches;
    const values = fleet ? [header.amounts] : selectedRows.map(row => row.amounts);
    const currency = currencyGroup(values, meta.currency);
    const fieldBasis = Object.fromEntries(Object.keys(FIELDS).map(field => [field, currency[field].known > 0 ? fleet ? 'fleet_header' : 'sum_selected_driver_rows' : 'unavailable']));
    const fieldNotes = [];
    if (fleet && complete && group.rows.length > 0) {
      for (const [field, label] of Object.entries(FLEET_DRIVER_FALLBACK_FIELDS)) {
        if (header.amounts[field] !== null) continue;
        const total = sumRevenueMinor(group.rows.map(row => row.amounts[field]));
        if (!total.complete) continue;
        currency[field] = total;
        fieldBasis[field] = 'sum_complete_driver_rows';
        fieldNotes.push(label + ' : somme des montants explicitement renseignés pour tous les chauffeurs du relevé complet, car le total de flotte ne fournit pas ce champ.');
      }
    }
    const proofs=fleet?[header.raw.financial_provenance]:selectedRows.map(row=>row.raw.financial_provenance);
    const verifiedBreakdown=proofs.length>0&&proofs.every(proof=>proof?.status==='verified');
    if(verifiedBreakdown){fieldBasis.gross='calculated_before_uber_fees_and_provider_taxes';fieldBasis.net='calculated_after_uber_fees_before_provider_taxes';fieldNotes.push('Brut calculé = Fare + Tip + Promotion, avant frais Uber et Taxes. Net après commissions = brut + Service Fee signée, avant Taxes Uber. Le poste Taxes reste de nature non précisée. Revenus déclarés = net + Taxes signées ; égalité vérifiée sur la décomposition complète. Remboursements, ajustements et versements exclus de ces calculs.');}
    for (const field of Object.keys(FIELDS)) currency[field] = {...currency[field], basis: fieldBasis[field]};
    const exactWindow = sameWindow(meta.period, requested);
    const scopeKind = fleet ? 'fleet' : driverCode ? 'driver' : agencyId ? 'agency' : 'visible_drivers';
    const report = {...meta, granularity: 'provider_period', period: {...meta.period, label: header?.raw.period_label || null, mode: header?.raw.period_mode || null},
      scope: {kind: scopeKind, agencyId, driverCode}, currencies: [currency], fieldBasis,
      byDriver: driverSummaries(selectedRows, meta, queryComplete),
      ...(role === 'admin' ? {unmatched: {records: selectedRows.filter(({raw}) => !confirmedIdentity(raw)).length,
        currencies: selectedRows.some(({raw}) => !confirmedIdentity(raw)) ? [currencyGroup(selectedRows.filter(({raw}) => !confirmedIdentity(raw)).map(item => item.amounts), meta.currency)] : []}} : {}),
      observedDriverRows: fleet ? group.rows.length : selectedRows.length,
      freshness: {observedAt: meta.observedAt, ageMs: Math.max(0, instant - Date.parse(meta.observedAt)), periodClosed: Date.parse(meta.period.end) <= Date.parse(meta.observedAt)},
      coverage: {complete, queryComplete: queryComplete === true, collectionComplete, countMatches, expectedDriverRows: expected,
        mappingComplete: fleet ? group.rows.every(({raw}) => raw.mapping_complete === true) : rowProof},
      // Pagination completeness does not turn a pre-closing observation into
      // the final total of a now closed week.
      exactWindow, canReplaceLegacy: complete && exactWindow && currency.revenue.complete &&
        (!weekly || Date.parse(meta.observedAt) >= Date.parse(openWeek ? requested.start : requested.end)),
      byDay: [], notes: ['Les montants portent sur la fenêtre fournisseur entière ; aucune répartition quotidienne n’est calculée.',
        'Le solde initial et le solde final sont des stocks de compte, pas des revenus.', ...fieldNotes]};
    reports.push(report);
  }
  // For each organization/currency/window, prefer the newest complete snapshot
  // to an overlapping partial refresh. Stable ids are also versioned upstream.
  const latest = new Map();
  const ranked = reports.sort((a, b) => Number(b.coverage.complete) - Number(a.coverage.complete) || Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.revision - a.revision || a.id.localeCompare(b.id));
  for (const report of ranked) {
    const key = JSON.stringify([report.organizationId, report.currency, report.period.start, report.period.end]);
    if (!latest.has(key)) latest.set(key, report);
  }
  const available = [...latest.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const exact = available.filter(report => report.canReplaceLegacy);
  const allOrganizations = selection.organizationIds.length > 0 && selection.organizationIds.every(id => exact.some(report => report.organizationId === id));
  const allCurrencies = available.every(report => exact.some(candidate => candidate.organizationId === report.organizationId && candidate.currency === report.currency));
  const allowed = queryComplete === true && issues.length === 0 && allOrganizations && allCurrencies;
  return {source: 'uber', granularity: 'provider_period', requestedPeriod: requested, selection,
    ...(allowed && openWeek ? {basis: {kind: 'open_week', periodStart: requested.start, periodEnd: requested.end,
      observedAt: exact.map(report => report.observedAt).sort().at(-1), comparisonAllowed: false}} : {}),
    reports: available, selected: allowed ? exact : [],
    replacement: {allowed, source: 'uber', reason: allowed ? null : !queryComplete ? 'provider_read_failed' : issues.length ? 'provider_data_invalid' : !selection.organizationIds.length ? 'organization_scope_unproven' : !allCurrencies ? 'incomplete_currency_coverage' : 'exact_complete_scope_unavailable',
      message: !allowed && queryComplete && !issues.length && !allCurrencies ? 'Les imports Uber sont conservés : chaque devise fournisseur doit disposer d’un relevé complet sur la fenêtre exacte. Les relevés reçus restent affichés séparément.' : null},
    coverage: {queryComplete: queryComplete === true, complete: allowed, issues: [...new Set(issues)]}, fetchedAt: new Date(instant).toISOString()};
}

export function createProviderEarningsLoader({supabase, now = Date.now, maxRows = MAX_ROWS} = {}) {
  if (!supabase?.from || !supabase?.auth?.getSession || !Number.isInteger(maxRows) || maxRows < PAGE || maxRows > MAX_ROWS) throw new TypeError('Client de lecture fournisseur invalide.');
  let generation = 0, active = null, disposed = false;
  function dispose() { disposed = true; generation++; active?.abort(); }
  async function load({period, agencyId = null, driverCode = null, organizationIds = [], signal} = {}) {
    if (disposed) throw aborted();
    const requested = windowOf(period), selection = scope({agencyId, driverCode, organizationIds});
    active?.abort(); const controller = new AbortController(); active = controller;
    const own = ++generation, cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, {once: true});
    let signature;
    const check = () => { if (disposed || own !== generation || signal?.aborted || controller.signal.aborted) throw aborted(); };
    async function identity() {
      check(); const {data, error} = await supabase.auth.getSession(); check();
      const session = data?.session;
      if (error || !session?.user?.id || !session.access_token) throw accessError(401, 'Connexion Ludy requise.');
      const next = session.user.id + ':' + session.access_token;
      if (signature && signature !== next) throw aborted(); signature = next; return session.user.id;
    }
    async function read(table, columns, keys, filters = []) {
      const records = [], seen = new Set();
      for (let offset = 0; offset <= maxRows; offset += PAGE) {
        await identity(); let query = supabase.from(table).select(columns);
        for (const [op, field, value] of filters) query = query[op](field, value);
        for (const key of keys) query = query.order(key, {ascending: true});
        query = query.range(offset, offset + Math.min(PAGE, maxRows - offset + 1) - 1);
        if (query.abortSignal) query = query.abortSignal(controller.signal);
        const result = await query; await identity();
        const denied = providerAccessError(result); if (denied) throw denied;
        const {data, error} = result;
        if (error || !Array.isArray(data) || data.length > PAGE) throw Error('Lecture des relevés fournisseur indisponible.');
        for (const row of data) {
          if (keys.some(key => row?.[key] == null)) throw Error('Identité du relevé absente.');
          const key = JSON.stringify(keys.map(field => row[field]));
          if (seen.has(key)) throw Error('Le relevé a changé pendant la lecture. Actualisez.');
          seen.add(key); records.push(row);
        }
        if (records.length > maxRows) throw Error('Trop de relevés fournisseur ; réduisez la sélection.');
        if (data.length < PAGE) return records;
      }
      throw Error('Trop de relevés fournisseur ; réduisez la sélection.');
    }
    async function selectWindows() {
      await identity();
      let query = supabase.rpc('provider_earnings_select_windows', {p_start: requested.start, p_end: requested.end,
        p_organization_ids: selection.organizationIds, p_agency_id: agencyId, p_driver_code: driverCode});
      if (query.abortSignal) query = query.abortSignal(controller.signal);
      const result = await query; await identity();
      const denied = providerAccessError(result); if (denied) throw denied;
      const data = result?.data, ids = data?.snapshot_ids;
      if (result?.error || data?.version !== 1 || data?.selection_complete !== true || !Array.isArray(ids) ||
          ids.length > MAX_WINDOWS || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw Error('Sélection des relevés fournisseur indisponible.');
      const normalized = ids.map(id => id.toLowerCase());
      if (new Set(normalized).size !== normalized.length) throw Error('Sélection des relevés fournisseur incohérente.');
      return normalized;
    }
    try {
      const user = await identity();
      const profiles = await read('profiles', 'user_id,role', ['user_id'], [['eq', 'user_id', user]]);
      if (profiles.length !== 1 || !['admin', 'manager'].includes(profiles[0].role)) throw accessError(403, 'Accès aux revenus réservé à la gestion.');
      const role = profiles[0].role;
      const agencies = role === 'manager' ? await read('agencies', 'id', ['id']) : [];
      if (role === 'manager' && agencyId && !agencies.some(agency => String(agency.id) === agencyId)) throw accessError(403, 'Agence financière inaccessible.');
      const filters = [['eq', 'source', 'uber'], ['lt', 'period_start', requested.end], ['gt', 'period_end', requested.start]];
      if (selection.organizationIds.length) filters.push(['in', 'organization_id', selection.organizationIds]);
      const rowFilters = [...filters];
      if (agencyId) rowFilters.push(['eq', 'agency_id', agencyId]);
      if (driverCode) rowFilters.push(['eq', 'driver_code', driverCode]);
      let snapshots = [], rows = [], queryComplete = true;
      try {
        // Active periods produce a new end time on every collection. Select
        // relevant windows under RLS before loading money, never scan history.
        const ids = await selectWindows(), fleet = role === 'admin' && !agencyId && !driverCode;
        if (ids.length) {
          [snapshots, rows] = await Promise.all([
            fleet ? read('provider_earnings_snapshots', SNAPSHOT_COLUMNS, ['id'], [...filters, ['in', 'id', ids]]) : Promise.resolve([]),
            read('provider_earnings_rows', ROW_COLUMNS, ['snapshot_id', 'provider_row'], [...rowFilters, ['in', 'snapshot_id', ids]])
          ]);
          if (snapshots.some(row => !ids.includes(row.id)) || rows.some(row => !ids.includes(row.snapshot_id)) ||
              ids.some(id => !(fleet ? snapshots.some(row => row.id === id) : rows.some(row => row.snapshot_id === id)))) {
            throw Error('La sélection des relevés a changé pendant la lecture.');
          }
        }
      } catch (error) {
        check();
        if (error?.name === 'AbortError' || error?.status === 401 || error?.status === 403 || ['AUTH_REQUIRED', 'FORBIDDEN'].includes(error?.code)) throw error;
        queryComplete = false; snapshots = []; rows = [];
      }
      // RLS may silently return an empty page after access is revoked. A cached
      // session alone does not authorize publishing values already read.
      const finalProfiles = await read('profiles', 'user_id,role', ['user_id'], [['eq', 'user_id', user]]);
      if (finalProfiles.length !== 1 || finalProfiles[0].role !== role) throw accessError(403, 'Droits financiers modifiés. Actualisez votre session.');
      if (role === 'manager') {
        const finalAgencies = await read('agencies', 'id', ['id']);
        if (agencies.some(agency => !finalAgencies.some(current => String(current.id) === String(agency.id)))) throw accessError(403, 'Accès à une agence retiré.');
      }
      await identity();
      return selectProviderEarnings({snapshots, rows, period: {...requested, kind: period.kind}, ...selection, role, queryComplete, now: now()});
    } finally { signal?.removeEventListener('abort', cancel); if (active === controller) active = null; }
  }
  return {load, dispose};
}

function mergeCurrencies(groups) {
  const buckets = new Map();
  for (const group of groups) {
    if (!buckets.has(group.currency)) buckets.set(group.currency, []);
    buckets.get(group.currency).push(group);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([currency, values]) => ({
    currency, currencyCode: values[0].currencyCode, records: values.reduce((n, value) => n + value.records, 0),
    assumedCurrencyRecords: values.reduce((n, value) => n + (value.assumedCurrencyRecords || 0), 0),
    ...Object.fromEntries(SUMMARY_FIELDS.map(field => {
      const metrics = values.map(value => value[field] || emptyMetric());
      const sum = sumRevenueMinor(metrics.map(metric => metric.minor));
      const known = metrics.reduce((n, metric) => n + metric.known, 0), missing = metrics.reduce((n, metric) => n + metric.missing, 0);
      return [field, {minor: sum.minor, known, missing, complete: known > 0 && missing === 0 && metrics.every(metric => metric.complete)}];
    }))
  }));
}

/** Provider aggregates are added once, without inventing a transaction time.
 * Their daily detail and balances remain in providerReports, never in byDay. */
export function combineProviderEarnings({legacyRecords, providerResult, period, legacyPeriod = period, agencyId = null, driverCode = null} = {}) {
  if (!Array.isArray(legacyRecords)) throw new TypeError('Écritures historiques requises.');
  const requested = windowOf(period), legacyStart = revenueInstant(legacyPeriod?.start), legacyEnd = revenueInstant(legacyPeriod?.end);
  if (legacyEnd < legacyStart || legacyPeriod?.timeZone !== 'Africa/Casablanca') throw new RangeError('Fenêtre des écritures historiques invalide.');
  const legacyWindow = {start: new Date(legacyStart).toISOString(), end: new Date(legacyEnd).toISOString(), timeZone: legacyPeriod.timeZone};
  const selection = scope({agencyId, driverCode});
  // The date-only Uber calendar can report the whole current week while the
  // other sources stop at now. This exception is explicit and week-only;
  // daily/monthly/custom aggregates still require identical boundaries.
  if (!sameWindow(requested, legacyWindow) && (!canonicalWeek(period) || legacyWindow.start !== requested.start ||
      legacyWindow.timeZone !== requested.timeZone || Date.parse(legacyWindow.end) > Date.parse(requested.end))) {
    throw new RangeError('Fenêtres fournisseur et écritures historiques incompatibles.');
  }
  const scopeMatches = providerResult?.selection?.agencyId === selection.agencyId && providerResult?.selection?.driverCode === selection.driverCode && sameWindow(providerResult?.requestedPeriod || {}, requested);
  const eligible = scopeMatches && providerResult?.replacement?.allowed === true && providerResult.selected?.length > 0 && providerResult.selected.every(report => report.canReplaceLegacy === true && sameWindow(report.period, requested));
  const historicalUber = summarizeRevenue(legacyRecords.filter(row => row.source === 'uber'), {...legacyWindow, sourceComplete: false});
  const directCurrencies = new Set((providerResult?.selected || []).map(report => report.currency));
  const currenciesCovered = historicalUber.coverage.selectionComplete && historicalUber.currencies.every(group => group.currencyCode &&
    !group.assumedCurrencyRecords && directCurrencies.has(group.currencyCode));
  const replace = !!eligible && currenciesCovered;
  const retained = replace ? legacyRecords.filter(row => row.source !== 'uber') : legacyRecords;
  const summary = summarizeRevenue(retained, {...legacyWindow, sourceComplete: false});
  const selected = replace ? providerResult.selected : [];
  if (selected.length) {
    if (providerResult.basis?.kind === 'open_week') {
      summary.providerOpenWeek = true;
      summary.providerObservedAt = providerResult.basis.observedAt;
    }
    const currencies = mergeCurrencies(selected.flatMap(report => report.currencies));
    summary.currencies = mergeCurrencies([...summary.currencies, ...currencies]);
    summary.bySource.push({source: 'uber', records: 0, providerPeriods: selected.length, granularity: 'provider_period', currencies});
    const grouped = new Map();
    for (const driver of selected.flatMap(report => report.byDriver || [])) {
      const key = JSON.stringify([driver.agencyId, driver.driverKey]);
      if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(driver);
    }
    for (const drivers of grouped.values()) {
      const names = [...new Set(drivers.map(driver => driver.driverName).filter(Boolean))];
      summary.byDriver.push({source: 'uber', driverKey: drivers[0].driverKey, driverName: names.length === 1 ? names[0] : null,
        agencyId: drivers[0].agencyId, records: 0, providerPeriods: drivers.length, granularity: 'provider_period',
        currencies: mergeCurrencies(drivers.flatMap(driver => driver.currencies)), coverage: {complete: drivers.every(driver => driver.coverage.complete)}});
    }
  }
  return {summary, providerReports: providerResult?.reports || [], providerPeriods: selected.length,
    replacement: {applied: !!replace, excludedLegacyRecords: legacyRecords.length - retained.length,
      reason: eligible && !currenciesCovered ? 'legacy_currency_scope_unproven' : providerResult?.replacement?.reason || null,
      message: eligible && !currenciesCovered ? 'Les imports Uber sont conservés : leurs devises ne sont pas toutes confirmées et couvertes par les relevés exacts. Les montants fournisseurs restent affichés séparément.' : providerResult?.replacement?.message || null},
    dailyCoverage: {complete: selected.length === 0, excludedSources: selected.length ? ['uber'] : [], reason: selected.length ? 'provider_period_has_no_daily_detail' : null},
    coverage: {complete: false, providerComplete: !!replace, legacyComplete: false}};
}
