import {privateModeValid} from './private-files.mjs';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {historyWindow,HISTORY_DAY_MS,HISTORY_REPORT_MS,HISTORY_AGE_MS,historyTrips,historyEvents,historyGps,historySummary} from './geotab-history.mjs';
import {retryAfterSeconds,retryDeadline} from './provider-retry.mjs';

const LOGIN_HOST = 'my.geotab.com';
const DEVICE_PAGE_SIZE = 500;
const DEVICE_MAX_COUNT = 20000, DEVICE_MAX_PAGES = 60, DEVICE_MAX_MS = 60000;
const MAX_IDS = 100;
const MAX_BATCH_CALLS = 50, IGNITION_RETRY_MS = 30000;
const EVENTS_CACHE_MS = 10000, TELEMETRY_CACHE_MS = 30000, OPTIONAL_RETRY_MS = 60000;
const HISTORY_MAX_MS = 36 * 3600000, EVENTS_MAX_MS = 30 * 60000;
const COUNTERS = { odometer_m: 'DiagnosticOdometerId', total_fuel_l: 'DiagnosticDeviceTotalFuelId', total_idle_fuel_l: 'DiagnosticDeviceTotalIdleFuelId' };
const COUNTER_IDS = new Set(Object.values(COUNTERS));
const READ_BUDGET_MS = 60000;
const READ_BUDGETS = { StatusData: 850, DeviceStatusInfo: 750, ExceptionEvent: 1500, Device: 500, Trip: 200, LogRecord: 100, Road: 5, History: 200, Zone: 500, ZoneType: 100 };
const TIMEOUT_MS = 15000;
const SESSION_MS = 12 * 86400000;
const GET_TYPES = new Set(['Device', 'DeviceStatusInfo', 'StatusData', 'ExceptionEvent', 'Trip', 'LogRecord', 'Zone', 'ZoneType']);

export class GeotabError extends Error {
  constructor(message, status = 502, retryAfter = 60, kind = 'upstream') {
    super(message); this.name = 'GeotabError'; this.status = status; this.retryAfter = retryAfter; this.kind = kind;
  }
}

export function validateGeotabCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GeotabError('Identifiants Geotab requis', 400);
  const database = typeof input.database === 'string' ? input.database.trim() : '';
  const userName = typeof input.userName === 'string' ? input.userName.trim() : '';
  const password = input.password;
  if (!database || database.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(database)) throw new GeotabError('Nom de base Geotab invalide', 400);
  if (!userName || userName.length > 254 || /[\x00-\x1f\x7f]/.test(userName)) throw new GeotabError('Identifiant Geotab invalide', 400);
  if (typeof password !== 'string' || !password.length || password.length > 4096 || password.includes('\0')) throw new GeotabError('Mot de passe Geotab requis', 400);
  return { database, userName, password };
}

export async function readGeotabCredentials(filename) {
  if (!filename) return null;
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || !privateModeValid(info, 0o600, filename) || info.size > 16384) throw new GeotabError('Fichier Geotab privé requis (permissions 0600)', 409);
    return validateGeotabCredentials(JSON.parse(await file.readFile('utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof GeotabError) throw error;
    throw new GeotabError('Lecture des identifiants Geotab locaux impossible', 409);
  } finally { await file?.close(); }
}

export async function saveGeotabCredentials(filename, input) {
  const credentials = validateGeotabCredentials(input);
  if (typeof filename !== 'string' || !filename) throw new GeotabError('Stockage Geotab local non configuré', 409);
  const directory = path.dirname(filename), temporary = path.join(directory, '.geotab-' + randomUUID() + '.tmp');
  let file;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(credentials) + '\n', 'utf8'); await file.sync(); await file.close(); file = null;
    await rename(temporary, filename);
  } catch {
    throw new GeotabError('Enregistrement privé des identifiants Geotab impossible', 409);
  } finally { await file?.close(); await rm(temporary, { force: true }).catch(() => {}); }
}

function validHost(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.geotab\.com$/.test(value);
}
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function validReadCall(call, now, historical=false) {
  if (call?.method !== 'Get' || !validId(call.params?.search?.deviceSearch?.id) || call.params.credentials) return false;
  if (call.params.typeName === 'DeviceStatusInfo') return call.params.resultsLimit === 2;
  const search = call.params.search;
  const from = Date.parse(search.fromDate), to = Date.parse(search.toDate);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to > now + 60000 || from > to) return false;
  if(historical) {
    if(from<now-HISTORY_AGE_MS-60000)return false;
    if(call.params.typeName==='Trip')return call.params.resultsLimit===2000&&to-from<=HISTORY_REPORT_MS&&search.includeOverlappedTrips===true;
    if(call.params.typeName==='LogRecord')return call.params.resultsLimit===20000&&to-from<=HISTORY_DAY_MS;
    if(call.params.typeName==='ExceptionEvent')return call.params.resultsLimit===5000&&to-from<=HISTORY_REPORT_MS;
    if(call.params.typeName==='StatusData')return COUNTER_IDS.has(search.diagnosticSearch?.id)&&call.params.resultsLimit===100&&from===to
      ||search.diagnosticSearch?.id==='DiagnosticEngineRoadSpeedId'&&call.params.resultsLimit===5000&&to-from<=90*60000;
    return false;
  }
  if (call.params.typeName === 'ExceptionEvent') return call.params.resultsLimit === 1000 && to - from <= EVENTS_MAX_MS && from >= now - EVENTS_MAX_MS - 60000;
  return call.params.typeName === 'StatusData' && call.params.resultsLimit === 100
    && (search.diagnosticSearch?.id === 'DiagnosticIgnitionId' || COUNTER_IDS.has(search.diagnosticSearch?.id))
    && from >= now - HISTORY_MAX_MS - 60000 && search.fromDate === search.toDate;
}
function durationMinutes(value) {
  const m = String(value || '').match(/^(?:(\d+)\.)?(\d+):([0-5]\d):([0-5]\d)(?:\.\d+)?$/);
  return m ? +(m[1] || 0) * 1440 + +m[2] * 60 + +m[3] + +m[4] / 60 : null;
}
function errorType(error) {
  return [error?.name, error?.data?.type, ...(Array.isArray(error?.errors) ? error.errors.map(x => x?.name) : [])].filter(x => typeof x === 'string').join(' ');
}
function counterValue(rows, id, diagnostic, at) {
  return rows.filter(row => row?.device?.id === id && (!row.diagnostic?.id || row.diagnostic.id === diagnostic)
    && numeric(row.data) !== null && row.data >= 0 && timestamp(row.dateTime) && Date.parse(row.dateTime) <= at)
    .sort((a, b) => Date.parse(b.dateTime) - Date.parse(a.dateTime))[0] || null;
}
const counterDifference = (before, after, divisor = 1) => before !== null && after !== null && after >= before ? Math.round((after - before) / divisor * 1000) / 1000 : null;
function remember(map, id, value) {
  map.delete(id); map.set(id, value);
  while (map.size > MAX_IDS) map.delete(map.keys().next().value);
}
function wantedIds(ids) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS || ids.some(id => !validId(id))) throw new GeotabError('Liste Geotab invalide : 100 véhicules associés maximum', 400);
  return [...new Set(ids)];
}
function position(id, row, ignition, now) {
  if (!row) return { id, at: null, lat: null, lon: null, speed: null, bearing: null, ign_on: null, state: 'Pas de réponse Geotab', since_min: null };
  const at = timestamp(row.dateTime), age = at ? now - Date.parse(at) : null;
  let lat = numeric(row.latitude), lon = numeric(row.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) { lat = null; lon = null; }
  const contact = ignition.filter(x => x?.device?.id === id && numeric(x.data) !== null && timestamp(x.dateTime) && Date.parse(x.dateTime) <= now + 60000)
    .sort((a, b) => Date.parse(b.dateTime) - Date.parse(a.dateTime))[0];
  const ign_on = contact ? contact.data >= 1 : null;
  const state = row.isDeviceCommunicating === false ? 'Boîtier hors ligne'
    : age === null ? 'Date Geotab inconnue' : age < -60000 ? 'Date Geotab incohérente' : age > 180000 ? 'Position ancienne'
    : row.isDriving === true ? 'En route' : row.isDriving !== false ? 'État inconnu'
    : ign_on === true ? 'Arrêté, contact mis' : ign_on === false ? 'Garé' : 'Arrêté, contact inconnu';
  const speed = numeric(row.speed), bearing = numeric(row.bearing);
  return { id, at, lat, lon, speed: speed !== null && speed >= 0 ? speed : null, bearing: bearing !== null && bearing >= 0 && bearing <= 360 ? bearing : null,
    ign_on, state, since_min: durationMinutes(row.currentStateDuration) };
}

export class GeotabClient {
  constructor({ credentials, fetchFn = fetch, now = Date.now }) {
    this.credentials = credentials; this.fetch = fetchFn; this.now = now;
    this.session = null; this.authPromise = null; this.generation = 0; this.ignitionUnavailableUntil = 0;
    this.eventsCache = new Map(); this.telemetryCache = new Map(); this.baselines = new Map(); this.optionalUnavailable = new Map();
    this.eventsPending = null; this.telemetryPending = null;
    this.readBudget = new Map(); this.readBudgetAt = -Infinity; this.providerBlockedUntil = 0;
  }
  reset() {
    this.session = null; this.authPromise = null; this.ignitionUnavailableUntil = 0; this.generation++;
    this.eventsCache.clear(); this.telemetryCache.clear(); this.baselines.clear(); this.optionalUnavailable.clear();
  }

  async #rpc(host, method, params, historical=false) {
    if(this.now()<this.providerBlockedUntil)throw new GeotabError('Quota Geotab atteint : lecture différée',429,Math.max(1,Math.ceil((this.providerBlockedUntil-this.now())/1000)),'quota');
    const validBatch = method === 'ExecuteMultiCall' && Array.isArray(params.calls) && params.calls.length > 0 && params.calls.length <= MAX_BATCH_CALLS && params.calls.every(call => validReadCall(call, this.now(),historical));
    const validRoad=method==='GetRoadMaxSpeeds'&&historical&&validId(params.deviceSearch?.id)&&Number.isFinite(Date.parse(params.fromDate))&&Number.isFinite(Date.parse(params.toDate))
      &&Date.parse(params.fromDate)>=this.now()-HISTORY_AGE_MS&&Date.parse(params.toDate)<=this.now()+60000&&Date.parse(params.toDate)>=Date.parse(params.fromDate)&&Date.parse(params.toDate)-Date.parse(params.fromDate)<=90*60000;
    if (!validHost(host) || !['Authenticate', 'Get', 'ExecuteMultiCall','GetRoadMaxSpeeds'].includes(method) || method==='GetRoadMaxSpeeds'&&!validRoad || method === 'Get' && !GET_TYPES.has(params.typeName) || method === 'ExecuteMultiCall' && !validBatch) throw new GeotabError('Lecture Geotab non autorisée', 400);
    this.#reserveReadBudget(method, params,historical);
    let response, data;
    try {
      response = await this.fetch('https://' + host + '/apiv1', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Ludy-Staging/1.0' },
        body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const raw = await response.text();
      if (raw.length > 8 * 1024 * 1024) throw new GeotabError('Réponse Geotab trop volumineuse');
      try { data = JSON.parse(raw); } catch { data = null; }
    } catch (error) {
      if (error instanceof GeotabError) throw error;
      throw new GeotabError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Délai de lecture Geotab dépassé' : 'Connexion Geotab indisponible');
    }
    const type = errorType(data?.error);
    if (response.status === 429 || /OverLimit|RateLimit/i.test(type)) {
      const retry=Math.max(30,retryAfterSeconds(response.headers.get('retry-after'),this.now()));
      this.providerBlockedUntil=Math.max(this.providerBlockedUntil,retryDeadline(this.now(),retry));
      throw new GeotabError('Quota Geotab atteint : lecture différée',429,retry,'quota');
    }
    if (!response.ok || data?.error || !data || !Object.hasOwn(data, 'result')) {
      if (/InvalidUser|InvalidSession|SessionExpired|IncorrectLoginCredentials|ExpiredSession/i.test(type) || /incorrect login credentials|session.{0,30}expired/i.test(String(data?.error?.message || ''))) {
        throw new GeotabError('Authentification Geotab refusée : vérifiez le compte et la base', 502, 60, 'authentication');
      }
      if (response.status === 403 || /Security|Permission|AccessDenied|Unauthorized/i.test(type)) {
        const error = new GeotabError('Droits de lecture Geotab insuffisants', 502, 60, 'permission');
        // The ordinal is safe to retain; the provider's message and identifiers are not.
        const index = data?.error?.data?.requestIndex;
        if (Number.isInteger(index) && index >= 0 && index < MAX_BATCH_CALLS) error.requestIndex = index;
        throw error;
      }
      throw new GeotabError(method === 'Authenticate' ? 'Authentification Geotab refusée : vérifiez le compte et la base' : 'Lecture Geotab indisponible');
    }
    return data.result;
  }

  // Shared by GPS, ignition, counters and events. Each nested Get consumes its
  // entity budget, even when grouped into a single HTTP request. Reserve before
  // sending, including retries whose earlier request may have reached Geotab.
  // A clock rollback must not clear the rolling window or create extra capacity.
  #reserveReadBudget(method, params, historical=false) {
    if (method === 'Authenticate') return;
    const at = Math.max(this.readBudgetAt, this.now()); this.readBudgetAt = at;
    const wanted = new Map();
    for (const call of method === 'ExecuteMultiCall' ? params.calls : [{ method, params }]) {
      const kind = call.method==='GetRoadMaxSpeeds'?'Road':call.params.typeName; wanted.set(kind, (wanted.get(kind) || 0) + 1);
      if(historical)wanted.set('History',(wanted.get('History')||0)+1);
    }
    let retryAfter = 0;
    for (const [kind, limit] of Object.entries(READ_BUDGETS)) {
      const retained = (this.readBudget.get(kind) || []).filter(entry => entry.at > at - READ_BUDGET_MS);
      this.readBudget.set(kind, retained);
      const requested = wanted.get(kind) || 0;
      let used = retained.reduce((sum, entry) => sum + entry.count, 0);
      if (used + requested <= limit) continue;
      for (const entry of retained) {
        used -= entry.count;
        if (used + requested <= limit) { retryAfter = Math.max(retryAfter, Math.ceil((entry.at + READ_BUDGET_MS - at) / 1000)); break; }
      }
    }
    if (retryAfter) throw new GeotabError('Budget local de lectures Geotab atteint : lecture différée', 429, Math.max(1, retryAfter), 'quota');
    // The complete multi-call is reserved atomically; a rejected mixed batch must
    // not consume the allowance of its otherwise available entities.
    for (const [kind, count] of wanted) this.readBudget.get(kind).push({ at, count });
  }

  async #authenticate() {
    if (this.session && this.now() < this.session.until) return this.session;
    if (this.authPromise) return this.authPromise;
    const generation = this.generation;
    const promise = (async () => {
      let input;
      try { input = await this.credentials(); } catch { throw new GeotabError('Lecture des identifiants Geotab locaux impossible', 409); }
      if (!input) throw new GeotabError('Identifiants Geotab non configurés', 409);
      const config = validateGeotabCredentials(input), result = await this.#rpc(LOGIN_HOST, 'Authenticate', config);
      const host = result?.path === 'ThisServer' ? LOGIN_HOST : result?.path;
      const sessionId = result?.credentials?.sessionId;
      if (!validHost(host) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096) throw new GeotabError('Réponse d’authentification Geotab invalide');
      if (generation !== this.generation) throw new GeotabError('Connexion Geotab remplacée ; réessayez', 409);
      const session = { host, credentials: { database: config.database, userName: config.userName, sessionId }, until: this.now() + SESSION_MS };
      this.session = session; return session;
    })();
    this.authPromise = promise;
    try { return await promise; } finally { if (this.authPromise === promise) this.authPromise = null; }
  }

  async #authenticated(method, params, historical=false) {
    const session = await this.#authenticate();
    let result;
    try { result = await this.#rpc(session.host, method, { ...params, credentials: session.credentials },historical); }
    catch (error) {
      if (error.kind !== 'authentication') throw error;
      if (this.session === session) this.session = null;
      const renewed = await this.#authenticate();
      result = await this.#rpc(renewed.host, method, { ...params, credentials: renewed.credentials },historical);
    }
    return result;
  }

  async #get(typeName, search, resultsLimit, { sort, propertySelector, allowFullPage = false } = {}) {
    const result = await this.#authenticated('Get', { typeName, search, resultsLimit, ...(sort ? { sort } : {}), ...(propertySelector ? { propertySelector } : {}) });
    if (!Array.isArray(result)) throw new GeotabError('Liste Geotab invalide');
    if (result.length > resultsLimit || result.length === resultsLimit && !allowFullPage) throw new GeotabError('Limite de lecture Geotab atteinte : résultat incomplet refusé', 502);
    return result;
  }

  async #multi(calls,historical=false) {
    const result = await this.#authenticated('ExecuteMultiCall', { calls },historical);
    if (!Array.isArray(result) || result.length !== calls.length) throw new GeotabError('Réponse groupée Geotab incomplète');
    for (let i = 0; i < result.length; i++) {
      if (!Array.isArray(result[i])) throw new GeotabError('Liste Geotab invalide dans la lecture groupée');
      if (result[i].length >= calls[i].params.resultsLimit) throw new GeotabError('Limite de lecture Geotab atteinte : résultat incomplet refusé');
    }
    return result;
  }

  async devices() {
    const start = this.now(), search = { fromDate: new Date(start).toISOString() };
    const seen = new Set(), cursors = new Set(), result = [];
    let offset = null;
    // Device supports Get pagination. Id is opaque; lastId must be omitted for an id sort.
    // https://developers.geotab.com/myGeotab/guides/concepts/#pagination
    for (let page = 0; page < DEVICE_MAX_PAGES; page++) {
      if (this.now() - start >= DEVICE_MAX_MS) throw new GeotabError('Lecture du catalogue Geotab trop longue : aucune liste partielle enregistrée');
      const rows = await this.#get('Device', search, DEVICE_PAGE_SIZE, {
        sort: { sortBy: 'id', sortDirection: 'asc', offset },
        propertySelector: { fields: ['id', 'name', 'licensePlate', 'vehicleIdentificationNumber'], isIncluded: true }, allowFullPage: true
      });
      if (this.now() - start >= DEVICE_MAX_MS) throw new GeotabError('Lecture du catalogue Geotab trop longue : aucune liste partielle enregistrée');
      if (!rows.length) return result;
      const before = result.length;
      for (const row of rows) {
        if (!validId(row?.id)) throw new GeotabError('Identifiant de véhicule Geotab invalide');
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        result.push({ id: row.id, name: typeof row.name === 'string' ? row.name.slice(0, 500) : '', plate: typeof row.licensePlate === 'string' ? row.licensePlate.slice(0, 100) : '', vin:typeof row.vehicleIdentificationNumber==='string'?row.vehicleIdentificationNumber.trim().toUpperCase().slice(0,100):'' });
      }
      if (result.length > DEVICE_MAX_COUNT) throw new GeotabError('Catalogue Geotab supérieur à 20 000 boîtiers : réduisez les groupes accessibles au compte staging. Aucune liste partielle enregistrée.');
      offset = rows.at(-1).id;
      if (result.length === before || cursors.has(offset)) throw new GeotabError('Pagination du catalogue Geotab interrompue : la page ne progresse plus');
      cursors.add(offset);
    }
    throw new GeotabError('Trop de pages dans le catalogue Geotab : aucune liste partielle enregistrée');
  }

  async zones() {
    // Official Zone/Get: read only. Never create or change zones in MyGeotab.
    const rows=await this.#get('Zone',{fromDate:new Date(this.now()).toISOString()},1000);
    const seen=new Set(),invalid=()=>{throw new GeotabError('Catalogue de zones Geotab incohérent : aucune liste partielle conservée');};
    const date=value=>{if(value==null)return null;if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value)||!timestamp(value))return invalid();return timestamp(value);};
    return rows.map(row=>{
      if(!row||typeof row!=='object'||Array.isArray(row)||!validId(row.id)||seen.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>160||/[\u0000-\u001f\u007f]/.test(row.name))return invalid();seen.add(row.id);
      if(!Array.isArray(row.points)||row.points.length<3||row.points.length>20000)return invalid();
      const points=row.points.map(point=>{if(!point||typeof point!=='object'||Array.isArray(point)||numeric(point.x)===null||numeric(point.y)===null||Math.abs(point.x)>180||Math.abs(point.y)>90)return invalid();return {lat:point.y,lon:point.x};});
      // Geotab may repeat the first vertex at the end. Keep that valid closure;
      // parking geometry/area checks are applied separately before activation.
      if(new Set(points.map(point=>point.lat+':'+point.lon)).size<3)return invalid();
      const types=row.zoneTypes===undefined?[]:row.zoneTypes;if(!Array.isArray(types)||types.length>1000)return invalid();
      const zone_types=types.map(type=>{const id=typeof type==='string'?type:type&&!Array.isArray(type)&&typeof type==='object'?type.id:null;if(!validId(id))return invalid();return id;});
      return {id:row.id,name:row.name.trim(),points,zone_types,active_from:date(row.activeFrom),active_to:date(row.activeTo)};
    });
  }
  async zoneTypes(){
    const seen=new Set();return (await this.#get('ZoneType',{},1000)).map(row=>{
      // The API serializes these built-in entities as their ID alone. Keep the
      // provider ID as the label rather than discarding the entire catalogue.
      if(typeof row==='string'&&/^ZoneType(?:Home|Office|Customer|InHouseServiceCenter|VendorServiceCenter)Id$/.test(row))row={id:row,name:row};
      if(!row||typeof row!=='object'||Array.isArray(row)||!validId(row.id)||seen.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>160||/[\u0000-\u001f\u007f]/.test(row.name))throw new GeotabError('Types de zones Geotab incohérents : aucune liste partielle conservée');
      seen.add(row.id);return {id:row.id,name:row.name.trim()};
    });
  }

  async positions(ids) {
    const wanted = wantedIds(ids), result = [], at = this.now(), iso = new Date(at).toISOString();
    const statusCall = id => ({ method: 'Get', params: { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id } }, resultsLimit: 2 } });
    const ignitionCall = id => ({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id }, diagnosticSearch: { id: 'DiagnosticIgnitionId' }, fromDate: iso, toDate: iso }, resultsLimit: 100 } });
    // A single HTTP request covers the current eleven vehicles. Larger fleets use
    // sequential, bounded batches; each nested Get still counts toward its API quota.
    for (let offset = 0; offset < wanted.length; offset += MAX_BATCH_CALLS / 2) {
      const group = wanted.slice(offset, offset + MAX_BATCH_CALLS / 2);
      let withIgnition = this.now() >= this.ignitionUnavailableUntil;
      let calls = group.flatMap(id => withIgnition ? [statusCall(id), ignitionCall(id)] : [statusCall(id)]), data;
      try { data = await this.#multi(calls); }
      catch (error) {
        // MultiCall stops at its first failure. Never treat its partial work as a
        // successful snapshot. Re-read required positions only if optional contact
        // access was refused (or a 403 did not identify a nested request).
        if (!withIgnition || error.kind !== 'permission' || Number.isInteger(error.requestIndex) && calls[error.requestIndex]?.params.typeName !== 'StatusData') throw error;
        calls = group.map(statusCall); data = await this.#multi(calls);
        this.ignitionUnavailableUntil = this.now() + IGNITION_RETRY_MS; withIgnition = false;
      }
      group.forEach((id, index) => {
        const statuses = data[index * (withIgnition ? 2 : 1)], ignition = withIgnition ? data[index * 2 + 1] : [];
        result.push(position(id, statuses.find(row => row?.device?.id === id), ignition, at));
      });
    }
    return result;
  }

  // These optional reads have their own cache. The server schedules them separately
  // from positions, so a slow history request never delays the two-second GPS loop.
  async events(ids) {
    const wanted = wantedIds(ids);
    if (this.eventsPending) { await this.eventsPending; return this.events(wanted); }
    const at = this.now(), generation = this.generation;
    const missing = wanted.filter(id => !this.eventsCache.has(id) || at - this.eventsCache.get(id).cachedAt >= EVENTS_CACHE_MS);
    if (!missing.length) return structuredClone(wanted.map(id => this.eventsCache.get(id).value));
    const pending = (async () => {
      const from = new Date(at - EVENTS_MAX_MS).toISOString(), to = new Date(at).toISOString();
      const calls = missing.map(id => ({ method: 'Get', params: { typeName: 'ExceptionEvent', search: { deviceSearch: { id }, fromDate: from, toDate: to }, resultsLimit: 1000 } }));
      const result = await this.#optionalGroup('events', calls);
      if (generation !== this.generation) throw new GeotabError('Connexion Geotab remplacée ; réessayez', 409);
      const rows = missing.map((id, index) => {
        const data = result?.[index];
        const events = (data || []).filter(event => event?.device?.id === id && validId(event.id) && validId(event.rule?.id)
          && event.state !== 'ExceptionEventStateInvalidId' && event.state !== 1 && timestamp(event.activeFrom)
          && Date.parse(event.activeFrom) <= at && (!event.activeTo || timestamp(event.activeTo) && Date.parse(event.activeTo) >= at - EVENTS_MAX_MS))
          .map(event => ({ id: event.id, rule: event.rule.id, at: timestamp(event.activeFrom), end: timestamp(event.activeTo),
            dur_min: durationMinutes(event.duration), km: numeric(event.distance) !== null && event.distance >= 0 ? event.distance : null }))
          .sort((a, b) => b.at.localeCompare(a.at));
        return { id, at: to, events, status: data ? 'healthy' : 'unavailable', error: data ? null : 'Droits de lecture des événements Geotab insuffisants.' };
      });
      rows.forEach(value => remember(this.eventsCache, value.id, { cachedAt: at, value }));
    })();
    this.eventsPending = pending;
    try { await pending; return structuredClone(wanted.map(id => this.eventsCache.get(id).value)); }
    finally { if (this.eventsPending === pending) this.eventsPending = null; }
  }

  // Optional permissions are isolated by diagnostic. A denied fuel diagnostic does
  // not hide odometer readings, GPS, contact or driving events. Quotas, malformed
  // responses and incomplete pages remain errors, never successful empty snapshots.
  async #optionalGroup(kind, calls,historical=false) {
    if ((this.optionalUnavailable.get(kind) || 0) > this.now()) return null;
    const result = [];
    try {
      for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS) result.push(...await this.#multi(calls.slice(i, i + MAX_BATCH_CALLS),historical));
      return result;
    } catch (error) {
      if (error.kind !== 'permission') throw error;
      this.optionalUnavailable.set(kind, this.now() + OPTIONAL_RETRY_MS); return null;
    }
  }

  async telemetry(items) {
    if (!Array.isArray(items) || items.length > MAX_IDS) throw new GeotabError('Liste Geotab invalide : 100 véhicules associés maximum', 400);
    const at = this.now(), wanted = new Map();
    for (const item of items) {
      const from = timestamp(item?.from);
      if (!validId(item?.id) || !from || Date.parse(from) > at || at - Date.parse(from) > HISTORY_MAX_MS
        || wanted.has(item.id) && wanted.get(item.id).from !== from) throw new GeotabError('Période de compteurs Geotab invalide : 36 heures maximum', 400);
      wanted.set(item.id, { id: item.id, from });
    }
    if (this.telemetryPending) { await this.telemetryPending; return this.telemetry([...wanted.values()]); }
    const generation = this.generation, iso = new Date(at).toISOString();
    const missing = [...wanted.values()].filter(item => {
      const previous = this.telemetryCache.get(item.id);
      return !previous || previous.value.from !== item.from || at - previous.cachedAt >= TELEMETRY_CACHE_MS;
    });
    if (!missing.length) return structuredClone([...wanted.keys()].map(id => this.telemetryCache.get(id).value));
    const pending = (async () => {
      const snapshots = new Map(missing.map(item => [item.id, { id: item.id, from: item.from, at: iso, km: null, fuel_l: null, idle_l: null,
        odometer_m: null, total_fuel_l: null, total_idle_fuel_l: null, counter_at: {}, status: 'healthy', error: null }]));
      const baselines = new Map(missing.map(item => {
        const previous = this.baselines.get(item.id);
        return [item.id, previous?.from === item.from ? structuredClone(previous) : { from: item.from, values: {}, attemptedAt: {} }];
      }));
      for (const [field, diagnostic] of Object.entries(COUNTERS)) {
        const descriptors = missing.flatMap(item => {
          const baseline = baselines.get(item.id), value = baseline.values[field];
          const needBaseline = value == null && (baseline.attemptedAt[field] == null || at - baseline.attemptedAt[field] >= OPTIONAL_RETRY_MS);
          return [...(needBaseline ? [{ ...item, baseline: true, date: item.from }] : []), { ...item, baseline: false, date: iso }];
        });
        const calls = descriptors.map(item => ({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id: item.id }, diagnosticSearch: { id: diagnostic }, fromDate: item.date, toDate: item.date }, resultsLimit: 100 } }));
        const result = await this.#optionalGroup(diagnostic, calls);
        descriptors.forEach((item, index) => {
          const baseline = baselines.get(item.id), snapshot = snapshots.get(item.id);
          const sample = counterValue(result?.[index] || [], item.id, diagnostic, Date.parse(item.date));
          if (item.baseline) { baseline.values[field] = sample?.data ?? null; baseline.attemptedAt[field] = at; }
          else { snapshot[field] = sample?.data ?? null; snapshot.counter_at[field] = timestamp(sample?.dateTime); }
        });
      }
      if (generation !== this.generation) throw new GeotabError('Connexion Geotab remplacée ; réessayez', 409);
      for (const item of missing) {
        const value = snapshots.get(item.id), baseline = baselines.get(item.id);
        value.km = counterDifference(baseline.values.odometer_m ?? null, value.odometer_m, 1000);
        value.fuel_l = counterDifference(baseline.values.total_fuel_l ?? null, value.total_fuel_l);
        value.idle_l = counterDifference(baseline.values.total_idle_fuel_l ?? null, value.total_idle_fuel_l);
        const availability = Object.keys(COUNTERS).filter(field => value[field] !== null).length;
        if (availability < 3 || [value.km, value.fuel_l, value.idle_l].some(x => x === null)) {
          value.status = availability ? 'partial' : 'unavailable';
          value.error = availability ? 'Certains compteurs Geotab sont absents ou leur différence ne peut pas être calculée.' : 'Compteurs Geotab indisponibles pour ce véhicule ou ce compte.';
        }
        remember(this.baselines, item.id, baseline); remember(this.telemetryCache, item.id, { cachedAt: at, value });
      }
    })();
    this.telemetryPending = pending;
    try { await pending; return structuredClone([...wanted.keys()].map(id => this.telemetryCache.get(id).value)); }
    finally { if (this.telemetryPending === pending) this.telemetryPending = null; }
  }

  async #periodCounters(ids,from,to) {
    const values=new Map(ids.map(id=>[id,{km:null,fuel_l:null,idle_l:null,counter_at:{}}]));
    for(const [field,diagnostic] of Object.entries(COUNTERS)) {
      const calls=ids.flatMap(id=>[from,to].map(date=>({method:'Get',params:{typeName:'StatusData',search:{deviceSearch:{id},diagnosticSearch:{id:diagnostic},fromDate:date,toDate:date},resultsLimit:100}})));
      const result=await this.#optionalGroup('history:'+diagnostic,calls,true);
      ids.forEach((id,i)=>{
        const before=counterValue(result?.[2*i]||[],id,diagnostic,Date.parse(from)),after=counterValue(result?.[2*i+1]||[],id,diagnostic,Date.parse(to));
        const name=field==='odometer_m'?'km':field==='total_fuel_l'?'fuel_l':'idle_l';
        values.get(id)[name]=counterDifference(before?.data??null,after?.data??null,field==='odometer_m'?1000:1);
        values.get(id).counter_at[name]={from:timestamp(before?.dateTime),to:timestamp(after?.dateTime)};
      });
    }
    return values;
  }

  async #periodRows(ids,from,to) {
    const call=(id,typeName,resultsLimit)=>({method:'Get',params:{typeName,search:{deviceSearch:{id},fromDate:from,toDate:to,...(typeName==='Trip'?{includeOverlappedTrips:true}:{})},resultsLimit}});
    const trips=await this.#optionalGroup('history:Trip',ids.map(id=>call(id,'Trip',2000)),true);
    const events=await this.#optionalGroup('history:ExceptionEvent',ids.map(id=>call(id,'ExceptionEvent',5000)),true);
    const counters=await this.#periodCounters(ids,from,to),at=new Date(this.now()).toISOString();
    return ids.map((id,i)=>{
      const vehicleTrips=historyTrips(trips?.[i],id,from,to),vehicleEvents=historyEvents(events?.[i],id,from,to),measured=counters.get(id);
      const completeCounters=['km','fuel_l','idle_l'].filter(k=>measured[k]!==null).length;
      const coverage={trips:trips?'complete':'unavailable',events:events?'complete':'unavailable',counters:completeCounters===3?'complete':completeCounters?'partial':'unavailable'};
      const warnings=[];
      if(!trips)warnings.push('Les droits de ce compte ne permettent pas de lire les trajets.');
      if(!events)warnings.push('Les droits de ce compte ne permettent pas de lire les événements.');
      if(completeCounters<3)warnings.push('Certains compteurs sont absents ou ont été réinitialisés ; les différences concernées restent inconnues.');
      if(vehicleTrips.some(t=>t.partial))warnings.push('Des trajets chevauchent les limites de la période. Leurs mesures complètes sont conservées dans la liste ; les durées impossibles à attribuer exactement à la période restent inconnues.');
      const summary=historySummary(vehicleTrips,vehicleEvents,measured,coverage,from,to);
      return {id,from,to,at,trips:vehicleTrips,events:vehicleEvents,summary,counter_at:measured.counter_at,coverage,warnings,
        status:Object.values(coverage).every(v=>v==='complete')&&summary.drive_min!==null&&summary.idle_min!==null?'complete':Object.values(coverage).every(v=>v==='unavailable')?'unavailable':'partial'};
    });
  }

  async history(id,input) {
    if(!validId(id))throw new GeotabError('Véhicule Geotab invalide',400);
    const {from,to}=historyWindow(input,HISTORY_DAY_MS,this.now());
    const [result]=await this.#periodRows([id],from,to);
    const gps=await this.#optionalGroup('history:LogRecord',[{method:'Get',params:{typeName:'LogRecord',search:{deviceSearch:{id},fromDate:from,toDate:to},resultsLimit:20000}}],true);
    Object.assign(result,historyGps(gps?.[0],id,from,to));
    result.coverage.gps=gps?'complete':'unavailable';
    if(!gps){result.warnings.push('Les positions historiques ne sont pas accessibles pour ce compte.');result.status=result.status==='unavailable'?'unavailable':'partial';}
    if(result.gps_interpolated)result.warnings.push('Les points aux bornes de période peuvent être interpolés par Geotab ; ils servent au tracé, pas à la surveillance des 200 m.');
    return result;
  }

  async report(ids,input) {
    const wanted=wantedIds(ids);
    if(wanted.length>25)throw new GeotabError('Un rapport peut contenir au maximum 25 véhicules ; réduisez la sélection.',400);
    const {from,to}=historyWindow(input,HISTORY_REPORT_MS,this.now());
    if(!wanted.length)return [];
    return this.#periodRows(wanted,from,to);
  }

  async detail(id,input) {
    if(!validId(id))throw new GeotabError('Véhicule Geotab invalide',400);
    const {from,to}=historyWindow(input,90*60000,this.now()),search={deviceSearch:{id},fromDate:from,toDate:to};
    const gps=await this.#optionalGroup('detail:LogRecord',[{method:'Get',params:{typeName:'LogRecord',search,resultsLimit:20000}}],true);
    const speed=await this.#optionalGroup('detail:Speed',[{method:'Get',params:{typeName:'StatusData',search:{...search,diagnosticSearch:{id:'DiagnosticEngineRoadSpeedId'}},resultsLimit:5000}}],true);
    const events=await this.#optionalGroup('detail:ExceptionEvent',[{method:'Get',params:{typeName:'ExceptionEvent',search,resultsLimit:5000}}],true);
    let road=null,roadWarning=null;
    try {
      const raw=await this.#authenticated('GetRoadMaxSpeeds',{deviceSearch:{id},fromDate:from,toDate:to},true);
      const entries=Array.isArray(raw)?raw:raw&&typeof raw==='object'?Object.entries(raw).map(([key,value])=>({key,value})):[];
      if(entries.length>20000)throw new GeotabError('Limites de vitesse trop nombreuses ; réduisez la période.');
      road=entries.map(p=>[Date.parse(p.k||p.key||p.dateTime),numeric(p.v??p.value)]).filter(p=>Number.isFinite(p[0])&&p[0]>=Date.parse(from)&&p[0]<=Date.parse(to)&&p[1]!==null&&p[1]>=0).sort((a,b)=>a[0]-b[0]);
    }catch(error){roadWarning=error.kind==='quota'?'Lecture des limites de vitesse différée par le quota.':'Limites de vitesse de la route non disponibles.';}
    const points=(speed?.[0]||[]).filter(p=>p.device?.id===id&&numeric(p.data)!==null&&p.data>=0&&p.data<=350&&Date.parse(p.dateTime)>=Date.parse(from)&&Date.parse(p.dateTime)<=Date.parse(to))
      .map(p=>[Date.parse(p.dateTime),p.data]).sort((a,b)=>a[0]-b[0]);
    return {id,from,to,at:new Date(this.now()).toISOString(),...historyGps(gps?.[0],id,from,to),speed:points,road,events:historyEvents(events?.[0],id,from,to),
      coverage:{gps:gps?'complete':'unavailable',speed:speed?'complete':'unavailable',events:events?'complete':'unavailable',road:road===null?'unavailable':'complete'},warnings:roadWarning?[roadWarning]:[]};
  }
}
