import {validateTexatConfig} from './texat-config.mjs';

const ORIGIN = 'https://api.teksat.fr';
const LOGIN = '/api/v1/auth/login', POSITIONS = '/api/v1/carto/vehicules/positions-fuseau', VEHICLES = '/api/v1/vehicules';
const MAX_BYTES = 8 * 1024 * 1024, MAX_POSITIONS = 5000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (code, status = 502) => Object.assign(new Error('Lecture Teksat indisponible.'), {name: 'TeksatError', code, status});
const text = (value, maximum = 200) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const label = value => typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : value;
const timestamp = value => {
  if (!text(value, 50) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) throw fail('teksat_schema');
  return value;
};
const coordinate = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum;
const received = value => {
  if (!Number.isSafeInteger(value)) throw fail('teksat_clock');
  return new Date(value).toISOString();
};

/** Contract observed through the authenticated Minton UI on 2026-11-03.
 * It is deliberately narrower than the provider's undocumented full API.
 * No provider mutation, remote command, export job or endpoint discovery. */
export const TEKSAT_CONTRACT = Object.freeze({version: 'minton-ui-2026-11-03', portalOrigin: 'https://minton.teksat.fr', apiOrigin: ORIGIN,
  positionTimestamps: 'provider_datetime_without_confirmed_timezone', positionTimeZone: null,
  positionQuality: 'provider_status_codes_not_documented', networkStatus: false, odometer: false, fuelConsumption: false});

/** Preserve provider dates without guessing their timezone. Device and vehicle
 * identities remain separate. Private-mode locations never leave this adapter.
 * distance is not a proven odometer; statutBalise is not a network observation. */
export function normalizeTeksatPositions(input, {collectedAt} = {}) {
  if (!Array.isArray(input) || input.length > MAX_POSITIONS || typeof collectedAt !== 'string' || !Number.isFinite(Date.parse(collectedAt)) || new Date(collectedAt).toISOString() !== collectedAt) throw fail('teksat_schema');
  const ids = new Set(), devices = new Set();
  const rows = input.map(row => {
    if (!UUID.test(row?.sid || '') || !/^\d{14,17}$/.test(row.imei || '') || ids.has(row.sid.toLowerCase()) || devices.has(row.imei) ||
        !text(row.immatriculation) || typeof row.isViePrivee !== 'boolean' || typeof row.isEnRoute !== 'boolean' ||
        !coordinate(row.latitude, 90) || !coordinate(row.longitude, 180) || !Number.isSafeInteger(row.statutBalise)) throw fail('teksat_schema');
    ids.add(row.sid.toLowerCase()); devices.add(row.imei);
    const dateGps = timestamp(row.dateGps), datePosition = timestamp(row.datePosition);
    return {providerVehicleId: row.sid.toLowerCase(), deviceId: row.imei, plate: row.immatriculation,
      privateMode: row.isViePrivee, moving: row.isEnRoute, latitude: row.isViePrivee ? null : row.latitude,
      longitude: row.isViePrivee ? null : row.longitude, dateGpsRaw: dateGps, datePositionRaw: datePosition,
      providerStatusCode: row.statutBalise, collectedAt,
      usableAsObservation: false, reason: row.isViePrivee ? 'provider_private_mode' : 'provider_time_and_quality_unconfirmed'};
  });
  return {source: 'texat', contractVersion: TEKSAT_CONTRACT.version, collectedAt, rows,
    coverage: {responseComplete: true, populationComplete: false, records: rows.length}, activeFailover: false};
}

export function normalizeTeksatVehiclePage(input, {page = 1, itemsPerPage = 10} = {}) {
  if (!input || !Number.isSafeInteger(page) || page < 1 || itemsPerPage !== 10 ||
      !Number.isSafeInteger(input.totalCount) || input.totalCount < 0 || input.totalCount > 20000 ||
      !Number.isSafeInteger(input.totalPages) || input.totalPages !== Math.ceil(input.totalCount / itemsPerPage) ||
      input.currentPage !== page || !Array.isArray(input.results) || input.results.length !== Math.min(itemsPerPage, Math.max(0, input.totalCount - (page - 1) * itemsPerPage))) throw fail('teksat_pagination');
  const ids = new Set();
  const rows = input.results.map(row => {
    if (!UUID.test(row?.sid || '') || ids.has(row.sid.toLowerCase()) || (row.imei !== '' && row.imei !== null && !/^\d{14,17}$/.test(row.imei || '')) ||
        !text(row.immatriculation) || !text(row.numeroSerie || '') || !text(label(row.identifiant || '')) || typeof row.isActif !== 'boolean') throw fail('teksat_schema');
    ids.add(row.sid.toLowerCase());
    return {providerVehicleId: row.sid.toLowerCase(), deviceId: row.imei || null, plate: row.immatriculation,
      identifier: label(row.identifiant || '') || null, vin: row.numeroSerie || null, active: row.isActif};
  });
  return {source: 'texat', contractVersion: TEKSAT_CONTRACT.version, page, itemsPerPage, totalCount: input.totalCount,
    totalPages: input.totalPages, rows, nextPage: page < input.totalPages ? page + 1 : null};
}

/** Server-only client. Normal observed login; token stays in memory. Each
 * invocation makes at most one login and one requested read, without retries.
 * A 401 clears the session and fails; it never triggers an authentication loop.
 */
export function createTeksatClient({credentials, fetchFn = fetch, now = Date.now, timeoutMs = 15000} = {}) {
  let config = validateTexatConfig(credentials), token = null, signingIn = null, closed = false, generation = 0;
  const controllers = new Set();
  if (Object.values(config).some(value => !value) || typeof fetchFn !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('teksat_configuration', 400);
  async function request(path, {method = 'GET', query, body, authenticated = false, signal} = {}) {
    if (closed) throw fail('teksat_closed', 409);
    if (![LOGIN, POSITIONS, VEHICLES].includes(path) || (method === 'POST') !== (path === LOGIN)) throw fail('teksat_contract', 400);
    const controller = new AbortController(), own = generation; controllers.add(controller);
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    try {
      requestSignal.throwIfAborted();
      const response = await fetchFn(ORIGIN + path + (query ? '?' + query.toString() : ''), {method, redirect: 'error', credentials: 'omit',
        headers: {Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {}), ...(authenticated ? {Authorization: 'Bearer ' + token} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}), signal: requestSignal});
      if (closed || own !== generation) throw fail('teksat_closed', 409);
      if (response.status === 401 || response.status === 403) {token = null; throw fail('teksat_authentication', response.status);}
      if (response.status === 429) throw fail('teksat_rate_limited', 429);
      if (!response.ok) throw fail('teksat_upstream');
      if (Number(response.headers.get('content-length')) > MAX_BYTES || !(response.headers.get('content-type') || '').includes('json')) throw fail('teksat_response');
      const reader = response.body?.getReader(); if (!reader) throw fail('teksat_response');
      const parts = []; let bytes = 0;
      try {
        while (true) {
          requestSignal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > MAX_BYTES) throw fail('teksat_response_limit'); parts.push(chunk.value);
        }
      } finally {await reader.cancel().catch(() => {});}
      requestSignal.throwIfAborted(); if (closed || own !== generation) throw fail('teksat_closed', 409);
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
      if (error?.name === 'TeksatError') throw error;
      if (signal?.aborted) throw signal.reason;
      if (closed) throw fail('teksat_closed', 409);
      if (requestSignal.aborted) throw fail('teksat_timeout', 504);
      throw fail('teksat_upstream');
    } finally {controllers.delete(controller);}
  }
  async function login(signal) {
    if (closed) throw fail('teksat_closed', 409);
    if (token) return;
    if (!signingIn) signingIn = request(LOGIN, {method: 'POST', body: {identifiantSociete: config.TEXAT_SOCIETE,
      email: config.TEXAT_EMAIL, password: config.TEXAT_PASSWORD}, signal}).then(value => {
      if (!text(value?.token, 16384) || !value.token.trim()) throw fail('teksat_authentication', 401);
      token = value.token;
    }).finally(() => {signingIn = null;});
    await signingIn; signal?.throwIfAborted();
  }
  const filter = (value, minimum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw fail('teksat_filter', 400);
    return String(value);
  };
  const keywordValue = value => {if (!text(value)) throw fail('teksat_filter', 400); return value;};
  return Object.freeze({
    async readPositions({keyword = '', filialeId = -2, categorieId = -2, groupeId = -2, sousGroupeId = -2, signal} = {}) {
      const query = new URLSearchParams({keyword: keywordValue(keyword), filialeId: filter(filialeId, -2), categorieId: filter(categorieId, -2), groupeId: filter(groupeId, -2), sousGroupeId: filter(sousGroupeId, -2)});
      await login(signal); const data = await request(POSITIONS, {query, authenticated: true, signal});
      return normalizeTeksatPositions(data, {collectedAt: received(now())});
    },
    async readVehiclePage({keyword = '', page = 1, filialeId = -1, groupeId = -1, sousGroupeId = -1, signal} = {}) {
      const query = new URLSearchParams({keyword: keywordValue(keyword), filialeId: filter(filialeId, -1), groupeId: filter(groupeId, -1), sousGroupeId: filter(sousGroupeId, -1),
        itemsPerPage: '10', page: filter(page, 1), sortKey: 'immatriculation', sortOrder: 'asc'});
      await login(signal); return normalizeTeksatVehiclePage(await request(VEHICLES, {query, authenticated: true, signal}), {page});
    },
    status: () => ({source: 'texat', contractVersion: TEKSAT_CONTRACT.version, session: token ? 'authenticated' : 'not_authenticated',
      closed, activeFailover: false, normalization: 'awaiting_timezone_quality_and_confirmed_mapping', networkObservation: false, odometer: false, fuelConsumption: false}),
    close() {closed = true; generation++; token = null; config = null; for (const controller of controllers) controller.abort();}
  });
}
