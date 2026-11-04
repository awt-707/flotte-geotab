import {summarizeRevenue, compareRevenueSummaries, getRevenueComparisonWindow, getRevenuePeriod, revenueDay, revenueInstant} from './revenue-metrics.js';
import {createProviderEarningsLoader, combineProviderEarnings} from './provider-earnings-data.js';

// This adapter only uses the application's authenticated Supabase client. No
// provider request, service credential, write, or cross-agency fallback exists.
const PAGE = 1000;
const MAX_ROWS = 50000;
const DAY = 86400000;
const SOURCES = ['uber', 'bolt', 'private'];
const TABLES = {
  uber: {table: 'uber_payments', key: 'tx', date: 'at', columns: 'tx,at,driver_uuid,driver_name,agency_id,revenue,payout,fare,tip,toll,bonus,cash,raw,imported_at'},
  bolt: {table: 'bolt_sessions', key: 'key', date: 'at', columns: 'key,at,driver_name,agency_id,total,cash,raw,imported_at'},
  private: {table: 'cash_moves', key: 'id', date: 'day', columns: 'id,day,driver_code,driver_name,agency_id,kind,caisse,course_amount,amount,cancelled_at,created_at,updated_at'}
};
const NOTES = {
  uber: 'Revenus du relevé Uber importé ; horodatage du relevé, sans garantie de couverture complète. Le versement déclaré ne représente pas le bénéfice net.',
  bolt: 'Total des paiements du relevé Bolt importé, attribué au début de la session. Les prix de courses observés par API ne sont pas ajoutés.',
  private: 'Montants bruts TTC des courses privées enregistrées en caisse, hors écritures annulées. Le cash remis et la prime chauffeur ne définissent pas un revenu net. Date métier sans heure ; les missions liées ne sont pas additionnées.'
};
const norm = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim();
const nameKey = value => norm(value || '').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).sort().join(' ');
const abort = () => new DOMException('Lecture remplacée ou session modifiée.', 'AbortError');
const accessError = (message, code) => Object.assign(new Error(message), {code});

function minor(value) {
  if (value === null || value === undefined || value === '') return null;
  let text = typeof value === 'number' ? String(value) : String(value).trim();
  text = text.replace(/\b(?:MAD|DH|EUR|USD|GBP)\b/gi, '').replace(/[€\s\u00a0\u202f]/g, '');
  if (!/^[+-]?\d+(?:[.,]\d+)*$/.test(text)) return null;
  if (text.includes('.') && text.includes(',')) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    text = text.replace(decimal === '.' ? /,/g : /\./g, '').replace(',', '.');
  } else if (text.includes(',')) {
    text = /^[+-]?\d{1,3}(?:,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  }
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const negative = text.startsWith('-'), [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? (negative ? -result : result) : null;
}

function rawEntries(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).filter(([key, value]) => key.length <= 250 && ['string', 'number'].includes(typeof value))
    .map(([key, value]) => ({key: norm(key), value}));
}
const baseHeader = key => key.replace(/\s*(?:\|\s*|\(\s*)(?:mad|dh|eur|usd|gbp)\s*\)?$/, '').trim();
function fields(entries, names) { return entries.filter(entry => names.includes(baseHeader(entry.key))); }
function rawAmount(entries, names) {
  const matched = fields(entries, names);
  if (!matched.length) return {present: false, value: null};
  const values = matched.map(entry => minor(entry.value));
  return {present: true, value: values.every(value => value !== null && value === values[0]) ? values[0] : null};
}
function reportedAmount(value, entries, names) {
  const typed = minor(value), original = rawAmount(entries, names);
  // Old importers replace absent cells with zero. A zero is known only when
  // an original, explicitly present financial cell confirms it.
  if (original.present) return original.value !== null && original.value === typed ? typed : null;
  return typed === 0 ? null : typed;
}
const COMMISSION_LABELS = ['commission', 'commissions', 'frais de service', 'service fee',
  'montant vous etant verse:vos revenus:frais de service', 'montant vous etant verse:vos revenus:prix de la course:frais de service'];
const EXPLICIT_NET_LABELS = ['net after commission', 'net after commissions', 'net earnings after commission', 'net earnings after commissions',
  'revenus nets apres commission', 'revenus nets apres commissions'];
const MONEY_LABELS = ['revenus bruts', 'gross earnings', 'revenus nets', 'net earnings', ...EXPLICIT_NET_LABELS, ...COMMISSION_LABELS,
  'montant vous etant verse', 'montant vous etant verse:vos revenus', 'montant vous etant verse:vos revenus:prix de la course',
  'montant vous etant verse:vos revenus:pourboire', 'montant vous etant verse:vos revenus:peage', 'total des paiements', 'espece'];
function statementCurrency(entries) {
  const currencies = new Set();
  const add = value => { const code = value.toUpperCase(); currencies.add(code === 'DH' ? 'MAD' : code === '€' ? 'EUR' : code); };
  for (const {key, value} of entries) {
    if (['currency', 'devise'].includes(key)) {
      const code = String(value).trim();
      if (/^(?:[a-z]{3}|DH)$/i.test(code)) add(code); else currencies.add('UNKNOWN');
    }
    if (!MONEY_LABELS.includes(baseHeader(key)) && !key.startsWith('montant vous etant verse:vos revenus:bonus')) continue;
    const unit = key.match(/(?:\||\()\s*(mad|dh|eur|usd|gbp)\s*\)?$/i)?.[1];
    if (unit) add(unit);
    const cellUnit = String(value).match(/\b(MAD|DH|EUR|USD|GBP)\b|€/i)?.[0];
    if (cellUnit) add(cellUnit);
  }
  if (currencies.size > 1 || currencies.has('UNKNOWN')) return {currency: 'UNKNOWN', assumedCurrency: false};
  if (currencies.size === 1) return {currency: [...currencies][0], assumedCurrency: false};
  return {currency: 'MAD', assumedCurrency: true, currencyBasis: 'legacy_mad_convention'};
}
function uniqueIndex(rows, keyOf) {
  const index = new Map();
  for (const row of rows) { const key = keyOf(row); if (key) index.set(key, index.has(key) ? null : row); }
  return index;
}
function normalizeStatement(source, row, identities) {
  const entries = rawEntries(row.raw);
  let driver;
  if (source === 'uber') driver = identities.uber.get(row.driver_uuid);
  else if (source === 'private') driver = identities.codes.get(String(row.driver_code));
  else driver = identities.names.get(String(row.agency_id) + ':' + nameKey(row.driver_name));
  const record = {
    id: String(row[TABLES[source].key]), source,
    sourceKind: source === 'uber' ? 'uber_payment' : source === 'bolt' ? 'bolt_session' : 'private_cash_course',
    ...(source === 'private' ? {day: row.day} : {occurredAt: row.at}),
    granularity: source === 'private' ? 'day' : source === 'bolt' ? 'session' : 'transaction',
    ...statementCurrency(entries), driverKey: driver?.code || null, driverName: driver?.name || row.driver_name || null,
    revenueMinor: null, reportedPayoutMinor: null, fareMinor: null, tipsMinor: null, tollsMinor: null, bonusMinor: null,
    grossMinor: rawAmount(entries, ['revenus bruts', 'gross earnings']).value,
    netMinor: rawAmount(entries, source === 'uber' ? EXPLICIT_NET_LABELS : ['revenus nets', 'net earnings', ...EXPLICIT_NET_LABELS]).value,
    commissionMinor: rawAmount(entries, COMMISSION_LABELS).value,
    cashMinor: null
  };
  if (source === 'uber') {
    // Uber's generic Net earnings label can include payouts and balances. Keep
    // that reported figure separate; only explicit after-commission labels
    // can populate netMinor and participate in the net summary.
    record.reportedNetEarningsMinor = rawAmount(entries, ['revenus nets', 'net earnings']).value;
    const prefix = 'montant vous etant verse:vos revenus';
    record.revenueMinor = reportedAmount(row.revenue, entries, [prefix]);
    record.reportedPayoutMinor = reportedAmount(row.payout, entries, ['montant vous etant verse']);
    record.fareMinor = reportedAmount(row.fare, entries, [prefix + ':prix de la course']);
    record.tipsMinor = reportedAmount(row.tip, entries, [prefix + ':pourboire']);
    record.tollsMinor = reportedAmount(row.toll, entries, [prefix + ':peage']);
    const bonuses = entries.filter(entry => entry.key.startsWith(prefix + ':bonus'));
    const bonusValues = bonuses.map(entry => minor(entry.value));
    const bonusSum = bonusValues.every(value => value !== null) ? bonusValues.reduce((sum, value) => sum + value, 0) : null;
    record.bonusMinor = bonuses.length ? (Number.isSafeInteger(bonusSum) && bonusSum === minor(row.bonus) ? bonusSum : null) : minor(row.bonus) === 0 ? null : minor(row.bonus);
    const cash = rawAmount(entries, ['montant vous etant verse:solde des courses:versements:especes collectees']);
    record.cashMinor = cash.present ? (cash.value !== null && -cash.value === minor(row.cash) ? minor(row.cash) : null) : minor(row.cash) === 0 ? null : minor(row.cash);
  } else if (source === 'bolt') {
    record.revenueMinor = reportedAmount(row.total, entries, ['total des paiements']);
    record.cashMinor = reportedAmount(row.cash, entries, ['espece']);
  } else {
    record.revenueMinor = minor(row.course_amount);
    // The private-course form records the full TTC course price. Neither the
    // amount remitted nor price minus driver bonus is a certified net income.
    record.grossMinor = minor(row.course_amount);
    record.cashMinor = minor(row.amount);
    record.void = !!row.cancelled_at;
  }
  return record;
}

function id(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new TypeError(label + ' invalide.');
  return value;
}
function latest(rows, key) {
  const values = rows.map(row => row[key]).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  return values.length ? values.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b) : null;
}

export function createRevenueDataLoader({supabase, now = Date.now, maxRows = MAX_ROWS, providerConfig = null} = {}) {
  if (!supabase?.from || !supabase?.auth?.getSession) throw new TypeError('Le client Supabase de la session est requis.');
  if (!Number.isInteger(maxRows) || maxRows < PAGE || maxRows > MAX_ROWS) throw new TypeError('Limite de lecture invalide.');
  if (providerConfig !== null && typeof providerConfig !== 'function') throw new TypeError('Lecture de configuration fournisseur invalide.');
  let generation = 0, active = null, disposed = false;
  function dispose() { disposed = true; generation++; active?.abort(); }

  async function load({period, source = 'all', agencyId = null, driverCode = null, signal, includeRecords = false} = {}) {
    if (disposed) throw abort();
    active?.abort(); const controller = new AbortController(); active = controller;
    const own = ++generation, cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    const check = () => { if (disposed || own !== generation || signal?.aborted || controller.signal.aborted) throw abort(); };
    let sessionSignature;
    async function identity() {
      check(); const {data, error} = await supabase.auth.getSession(); check();
      const session = data?.session;
      if (error || !session?.user?.id || !session.access_token) throw accessError('Connexion Ludy requise.', 'revenue_auth_required');
      const signature = session.user.id + ':' + session.access_token;
      if (sessionSignature && signature !== sessionSignature) throw abort();
      sessionSignature = signature; return session.user.id;
    }
    async function read(table, columns, key, filters = [], date = null) {
      const rows = [], seen = new Set();
      for (let offset = 0; offset <= maxRows; offset += PAGE) {
        await identity();
        let query = supabase.from(table).select(columns);
        for (const [op, field, value] of filters) query = query[op](field, value);
        if (date && date !== key) query = query.order(date, {ascending: true});
        query = query.order(key, {ascending: true}).range(offset, offset + Math.min(PAGE, maxRows - offset + 1) - 1);
        if (query.abortSignal) query = query.abortSignal(controller.signal);
        const {data, error, status} = await query; await identity();
        if (error) {
          if (status === 401 || error.status === 401 || ['PGRST301', 'PGRST302', 'PGRST303'].includes(error.code)) throw accessError('Connexion Ludy requise.', 'revenue_auth_required');
          if (status === 403 || error.status === 403 || error.code === '42501') throw accessError('Accès financier retiré.', 'revenue_access_denied');
          throw new Error('Lecture des données indisponible.');
        }
        if (!Array.isArray(data) || data.length > PAGE) throw new Error('Réponse de lecture invalide.');
        for (const row of data) {
          if (row?.[key] === undefined || row?.[key] === null) throw new Error('Identité de ligne absente.');
          const value = String(row[key]);
          if (seen.has(value)) throw new Error('Les données ont changé pendant la pagination. Actualisez.');
          seen.add(value); rows.push(row);
        }
        if (rows.length > maxRows) throw new Error('Période trop volumineuse ; réduisez la sélection.');
        if (data.length < PAGE) return rows;
      }
      throw new Error('Période trop volumineuse ; réduisez la sélection.');
    }
    try {
      check();
      if (source !== 'all' && !SOURCES.includes(source)) throw new TypeError('Source de revenus invalide.');
      agencyId = id(agencyId, 'Agence'); driverCode = id(driverCode, 'Chauffeur');
      if (agencyId !== null && !/^[1-9]\d*$/.test(agencyId)) throw new TypeError('Agence invalide.');
      if (period?.timeZone !== 'Africa/Casablanca') throw new TypeError('Le calendrier des revenus doit utiliser le Maroc.');
      const start = revenueInstant(period.start), end = revenueInstant(period.end), previousStart = revenueInstant(period.previousStart);
      if (end <= start || end - previousStart > 740 * DAY) throw new RangeError('Période trop longue ou invalide.');
      const fetched = revenueInstant(now());
      const window = getRevenueComparisonWindow(period, Math.max(start, Math.min(fetched, end)));
      const weekly = period.kind === 'week';
      if (weekly) {
        const canonical = getRevenuePeriod({kind: 'week', at: period.start, timeZone: period.timeZone});
        if (['start', 'end', 'previousStart', 'previousEnd'].some(key => revenueInstant(period[key]) !== revenueInstant(canonical[key]))) {
          throw new RangeError('La semaine fournisseur doit commencer le lundi à 04 h au Maroc.');
        }
      }
      const user = await identity();
      const profile = await read('profiles', 'user_id,role', 'user_id', [['eq', 'user_id', user]]);
      if (profile.length !== 1 || !['admin', 'manager'].includes(profile[0].role)) throw accessError('Accès aux revenus réservé à la gestion.', 'revenue_access_denied');
      const scope = agencyId ? [['eq', 'agency_id', agencyId]] : [];
      const [agencies, allDrivers] = await Promise.all([
        read('agencies', 'id,name', 'id'),
        read('drivers', 'code,name,uber_uuid,agency_id', 'code', scope)
      ]);
      if (agencyId && !agencies.some(row => String(row.id) === agencyId)) throw new Error('Agence inaccessible.');
      if (driverCode && !allDrivers.some(row => String(row.code) === driverCode)) throw new Error('Chauffeur inaccessible dans cette agence.');
      const identities = {
        codes: uniqueIndex(allDrivers, row => String(row.code)),
        uber: uniqueIndex(allDrivers, row => row.uber_uuid),
        names: uniqueIndex(allDrivers, row => nameKey(row.name) ? String(row.agency_id) + ':' + nameKey(row.name) : null)
      };
      const selected = source === 'all' ? SOURCES : [source];
      const results = await Promise.all(selected.map(async selectedSource => {
        const config = TABLES[selectedSource];
        let filters = [...scope];
        if (selectedSource === 'private') {
          filters.push(['eq', 'kind', 'course'], ['eq', 'caisse', 'courses'], ['is', 'cancelled_at', null],
            ['gte', 'day', revenueDay(previousStart)], ['lte', 'day', revenueDay(Math.max(start, Date.parse(window.end) - 1))]);
          if (driverCode) filters.push(['eq', 'driver_code', driverCode]);
        } else filters.push(['gte', 'at', period.previousStart], ['lt', 'at', window.end]);
        if (selectedSource === 'uber' && driverCode) {
          const uuid = identities.codes.get(driverCode)?.uber_uuid;
          if (uuid) filters.push(['eq', 'driver_uuid', uuid]);
          else return {source: selectedSource, rows: [], records: [], unmatched: 0, unmapped: true};
        }
        try {
          const rows = await read(config.table, config.columns, config.key, filters, config.date);
          const normalized = rows.map(row => ({row, record: normalizeStatement(selectedSource, row, identities)}));
          const scoped = driverCode ? normalized.filter(item => item.record.driverKey === driverCode) : normalized;
          return {source: selectedSource, rows: scoped.map(item => item.row), records: scoped.map(item => item.record),
            unmatched: normalized.filter(item => !item.record.driverKey).length};
        } catch (error) {
          check();
          if (error.name === 'AbortError' || ['revenue_auth_required', 'revenue_access_denied'].includes(error.code)) throw error;
          return {source: selectedSource, rows: [], records: [], error: error.message, unmatched: 0};
        }
      }));
      await identity();
      const records = results.flatMap(result => result.records);
      const summarize = (items, previous = false) => summarizeRevenue(items, {
        start: previous ? window.previousStart : window.start, end: previous ? window.previousEnd : window.end,
        timeZone: period.timeZone, sourceComplete: false
      });
      let current = summarize(records), previous = summarize(records, true);
      let provider = null;
      if (providerConfig) {
        provider = {config: null, current: null, previous: null, error: null};
        const readers = [];
        try {
          provider.config = await providerConfig({signal: controller.signal}); check(); await identity();
          if (selected.includes('uber') && provider.config?.uber?.enabled && provider.config.uber.organization_id) {
            const fetchPeriod = async(start, end) => {
              if (Date.parse(end) <= Date.parse(start)) return null;
              const reader = createProviderEarningsLoader({supabase, now}); readers.push(reader);
              return reader.load({period: {start, end, timeZone: period.timeZone, kind: period.kind}, agencyId, driverCode,
                organizationIds: [provider.config.uber.organization_id], signal: controller.signal});
            };
            const providerWindow = weekly && fetched >= start ? period : window;
            [provider.current, provider.previous] = await Promise.all([
              fetchPeriod(providerWindow.start, providerWindow.end), fetchPeriod(providerWindow.previousStart, providerWindow.previousEnd)
            ]);
            check(); await identity();
            if ([provider.current, provider.previous].some(result => result?.coverage?.queryComplete === false)) {
              provider.error = 'Lecture des relevés fournisseurs indisponible ; les imports détaillés de la période concernée sont conservés.';
            }
            const combine = (result, previous = false) => {
              const legacyPeriod = {start: previous ? window.previousStart : window.start,
                end: previous ? window.previousEnd : window.end, timeZone: period.timeZone};
              const combined = combineProviderEarnings({legacyRecords: records, providerResult: result,
                period: {...result.requestedPeriod, kind: period.kind}, legacyPeriod, agencyId, driverCode});
              if (!combined.replacement.applied) {
                result.replacement = {...result.replacement, allowed: false, reason: combined.replacement.reason, message: combined.replacement.message};
                result.selected = []; delete result.basis; result.coverage = {...result.coverage, complete: false};
              }
              return combined.summary;
            };
            if (provider.current?.replacement.allowed) current = combine(provider.current);
            if (provider.previous?.replacement.allowed) previous = combine(provider.previous, true);
          }
        } catch (error) {
          check();
          if (error.name === 'AbortError') throw error;
          if (error.status === 401 || ['AUTH_REQUIRED', 'revenue_auth_required'].includes(error.code)) throw accessError('Connexion Ludy requise.', 'revenue_auth_required');
          if (error.status === 403 || ['FORBIDDEN', 'revenue_access_denied'].includes(error.code)) throw accessError('Accès financier retiré.', 'revenue_access_denied');
          // Failed provider reads never turn into a zero or erase imported data.
          provider.error = 'Lecture des relevés fournisseurs indisponible ; les imports détaillés sont conservés.';
        } finally { readers.forEach(reader => reader.dispose()); }
      }
      const queryComplete = results.every(result => !result.error) && !provider?.error;
      const driverScopeComplete = !driverCode || results.every(result => !result.unmapped && !result.unmatched);
      const currentDirect = provider?.current?.replacement.allowed === true;
      const previousDirect = provider?.previous?.replacement.allowed === true;
      const providerExtentDiffers = currentDirect && provider.current.requestedPeriod.end !== window.end ||
        previousDirect && provider.previous.requestedPeriod.end !== window.previousEnd;
      const comparison = compareRevenueSummaries(current, previous, {equalDuration: window.equalDuration && !providerExtentDiffers && !current.providerOpenWeek});
      comparison.available = queryComplete && driverScopeComplete && !providerExtentDiffers && !current.providerOpenWeek;
      comparison.reason = !queryComplete ? 'Comparaison indisponible : une source sélectionnée n’a pas pu être lue.'
        : !driverScopeComplete ? 'Comparaison indisponible : des écritures ne peuvent pas être attribuées avec certitude au chauffeur sélectionné.'
        : providerExtentDiffers || current.providerOpenWeek ? 'Comparaison indisponible : le relevé Uber porte sur la semaine entière ; aucune plage fournisseur au même temps écoulé n’est disponible.' : null;
      if (!comparison.available) {
        comparison.complete = false;
        for (const group of comparison.currencies) for (const field of Object.values(group)) {
          if (field && typeof field === 'object' && Object.hasOwn(field, 'comparable')) {
            field.comparable = false; field.deltaMinor = null; field.percent = null;
          }
        }
      }
      if (currentDirect !== previousDirect && !providerExtentDiffers && !current.providerOpenWeek) {
        comparison.available = false; comparison.complete = false;
        comparison.reason = 'Comparaison indisponible : les deux périodes n’utilisent pas la même source financière.';
        for (const group of comparison.currencies) for (const field of Object.values(group)) {
          if (field && typeof field === 'object' && Object.hasOwn(field, 'comparable')) {
            field.comparable = false; field.deltaMinor = null; field.percent = null;
          }
        }
      }
      const sourceStatus = results.map(result => ({source: result.source,
        status: result.error ? 'error' : result.unmapped ? 'unmapped' : result.records.length ? 'partial' : 'no_data',
        lastRecordAt: TABLES[result.source].date === 'at' ? latest(result.rows, 'at') : null,
        lastRecordDay: TABLES[result.source].date === 'day' ? result.rows.map(row => row.day).sort().at(-1) || null : null,
        lastImportedAt: result.source === 'private' ? null : latest(result.rows, 'imported_at'),
        lastUpdatedAt: result.source === 'private' ? latest(result.rows, 'updated_at') || latest(result.rows, 'created_at') : null,
        records: result.records.length, unmatchedDrivers: result.unmatched,
        note: result.error || (result.unmapped ? 'Aucun identifiant Uber relié à ce chauffeur.' : NOTES[result.source])
      }));
      if (currentDirect) {
        const uberStatus = sourceStatus.find(status => status.source === 'uber');
        Object.assign(uberStatus, {status: 'complete', records: 0, providerPeriods: provider.current.selected.length,
          lastRecordAt: null, lastImportedAt: null,
          lastProviderObservedAt: latest(provider.current.selected, 'observedAt'),
          note: current.providerOpenWeek
            ? 'Relevé Uber de la semaine ouverte, du lundi 04 h au lundi suivant 04 h, observé à la date indiquée. Les imports Uber ne sont pas additionnés ; aucune durée écoulée comparable ni répartition quotidienne n’est déduite.'
            : 'Relevé Uber Fleet Earnings couvrant exactement la période et le périmètre sélectionnés. Les imports Uber correspondants ne sont pas additionnés ; aucun détail horaire n’est déduit de ce total.'});
      }
      const drivers = allDrivers.filter(driver => !driverCode || driver.code === driverCode).map(driver => ({
        code: driver.code, name: driver.name, summary: summarize(records.filter(record => record.driverKey === driver.code))
      })).filter(driver => driver.summary.records > 0 || driver.summary.uncertainDay?.records > 0);
      const notes = ['Les imports présents ne prouvent pas que toutes les courses ont été reçues.'];
      if (provider?.current?.replacement?.message) notes.push(provider.current.replacement.message);
      if (currentDirect) notes.push(current.providerOpenWeek
        ? 'Uber Fleet Earnings remplace les imports Uber par le relevé de la semaine ouverte, observé à ' + current.providerObservedAt + '. Les autres sources gardent leur borne réelle ; le total Uber n’est pas réparti par jour et la comparaison reste indisponible.'
        : 'Uber Fleet Earnings remplace les imports Uber pour cette fenêtre exacte ; son total de période n’est pas réparti sur la courbe quotidienne.');
      if (current.counts.boundaryUncertain) notes.push(current.counts.boundaryUncertain + ' écriture(s) datée(s) au jour ne peuvent pas être placées précisément de part et d’autre de la borne horaire ; elles restent hors du total.');
      if (current.coverage.assumedCurrencyRecords) notes.push('Les montants historiques en MAD supposé restent séparés des devises confirmées.');
      if (current.coverage.missingRevenueRecords) notes.push(current.coverage.missingRevenueRecords + ' montant(s) de revenu ne sont pas renseignés avec certitude.');
      if (results.some(result => result.error)) notes.push('Une source n’a pas pu être lue. Son absence ne signifie pas un revenu nul.');
      if (driverCode && results.some(result => result.unmatched)) notes.push('Des écritures sans association certaine à un chauffeur restent exclues de ce filtre.');
      // RLS can return an empty result after a role is revoked, without an HTTP
      // error. Recheck the role before returning any values read earlier.
      const finalProfile = await read('profiles', 'user_id,role', 'user_id', [['eq', 'user_id', user]]);
      if (finalProfile.length !== 1 || finalProfile[0].role !== profile[0].role) throw accessError('Droits financiers modifiés. Actualisez votre session.', 'revenue_access_denied');
      if (finalProfile[0].role === 'manager') {
        const finalAgencies = await read('agencies', 'id', 'id');
        if (agencies.some(agency => !finalAgencies.some(current => String(current.id) === String(agency.id)))) throw accessError('Accès à une agence retiré.', 'revenue_access_denied');
      }
      check();
      return {period, comparisonWindow: window, current, previous, provider,
        ...(includeRecords ? {records} : {}),
        comparison,
        sourceStatus, fetchedAt: new Date(fetched).toISOString(),
        choices: {agencies: agencies.map(({id, name}) => ({id, name})), drivers: allDrivers.map(({code, name, agency_id}) => ({code, name, agency_id}))},
        drivers, coverage: {complete: false, queryComplete, driverScopeComplete,
          sourceCoverageKnown: false, selectedSources: selected, failedSources: results.filter(result => result.error).map(result => result.source),
          current: current.coverage, previous: previous.coverage,
          notes}
      };
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (active === controller) active = null;
    }
  }
  return {load, dispose};
}

if (typeof window !== 'undefined') window.LudyRevenueData = Object.freeze({createRevenueDataLoader});
