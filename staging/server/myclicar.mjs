import {privateModeValid} from './private-files.mjs';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PORTAL_ORIGIN = 'https://new.clicar.ma';
const API_ORIGIN = 'https://new-api.clicar.ma';
const PLATFORM = 'clicarmaroc';
const CREDENTIAL_BYTES = 16384;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_MS = 15000;
const SESSION_MS = 10 * 60000;
const PAGE_SIZE = 10, MAX_PAGES = 200, SNAPSHOT_MS = 60000;
const contractEndpoint = page => `/contract?page=${page}&itemsPerPage=${PAGE_SIZE}&isBooking=false&isArchived=false&isCanceled=false&status%5B%5D=IN_PROGRESS`;
// These are the exact read route, query names, filter and page size observed in
// the portal. No caller can supply an arbitrary origin, route or query.
const READ_ENDPOINTS = new Set(Array.from({ length: MAX_PAGES }, (_, index) => contractEndpoint(index + 1)));
const inventoryEndpoint=(resource,page,archived=false)=>`/${resource}?page=${page}&itemsPerPage=${PAGE_SIZE}&isArchived=${archived}`;
for(let page=1;page<=MAX_PAGES;page++)for(const [resource,archived]of [['agency',false],['vehicle',false],['vehicle',true]])READ_ENDPOINTS.add(inventoryEndpoint(resource,page,archived));

export class MyclicarError extends Error {
  constructor(message, status = 502, retryAfter = 60, kind = 'upstream') {
    super(message);
    this.name = 'MyclicarError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.kind = kind;
  }
}

export function validateMyclicarCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MyclicarError('Identifiants MyClicar requis', 400);
  let origin;
  try {
    const parsed = new URL(input.origin === undefined ? PORTAL_ORIGIN : input.origin);
    if (parsed.origin !== PORTAL_ORIGIN || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error();
    origin = parsed.origin;
  } catch { throw new MyclicarError('Origine MyClicar non autorisée', 400); }
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const httpUsername = typeof input.httpUsername === 'string' ? input.httpUsername.trim() : '';
  if (!email || email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(email)) throw new MyclicarError('Adresse du compte MyClicar invalide', 400);
  if (!httpUsername || httpUsername.length > 254 || /[:\x00-\x1f\x7f]/.test(httpUsername)) throw new MyclicarError('Identifiant HTTP MyClicar invalide', 400);
  for (const key of ['password', 'httpPassword']) {
    if (typeof input[key] !== 'string' || !input[key].length || input[key].length > 4096 || input[key].includes('\0')) throw new MyclicarError(key === 'password' ? 'Mot de passe MyClicar requis' : 'Mot de passe HTTP MyClicar requis', 400);
  }
  const credentials = { origin, email, password: input.password, httpUsername, httpPassword: input.httpPassword };
  if (Buffer.byteLength(JSON.stringify(credentials) + '\n') > CREDENTIAL_BYTES) throw new MyclicarError('Identifiants MyClicar trop volumineux', 400);
  return credentials;
}

async function noSymlinkParents(filename) {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const segment of path.relative(current, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid credential directory');
  }
}

async function privateFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !privateModeValid(info, 0o600, filename) || info.size > CREDENTIAL_BYTES) throw new MyclicarError('Fichier MyClicar privé requis (permissions 0600)', 409);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function readMyclicarCredentials(filename) {
  if (!filename) return null;
  let file;
  try {
    await noSymlinkParents(filename);
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !privateModeValid(info, 0o600, filename) || info.size > CREDENTIAL_BYTES) throw new MyclicarError('Fichier MyClicar privé requis (permissions 0600)', 409);
    const bytes = Buffer.alloc(CREDENTIAL_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > CREDENTIAL_BYTES) throw new MyclicarError('Fichier MyClicar privé trop volumineux', 409);
    return validateMyclicarCredentials(JSON.parse(bytes.subarray(0, count).toString('utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof MyclicarError && error.status === 409) throw error;
    throw new MyclicarError('Lecture des identifiants MyClicar locaux impossible', 409);
  } finally { await file?.close(); }
}

export async function saveMyclicarCredentials(filename, input) {
  const credentials = validateMyclicarCredentials(input);
  if (typeof filename !== 'string' || !filename || !path.isAbsolute(filename)) throw new MyclicarError('Stockage MyClicar local non configuré', 409);
  const directory = path.dirname(filename), temporary = path.join(directory, '.myclicar-' + randomUUID() + '.tmp');
  let file;
  try {
    // Check each existing ancestor before mkdir as well as afterwards, so an
    // existing directory symlink cannot redirect a secret write or chmod.
    let ancestor = directory;
    while (true) {
      try { await noSymlinkParents(path.join(ancestor, '.check')); break; }
      catch (error) { if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error; ancestor = path.dirname(ancestor); }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await noSymlinkParents(filename);
    await privateFile(filename);
    await chmod(directory, 0o700);
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(credentials) + '\n', 'utf8');
    await file.sync();
    await file.close(); file = null;
    await privateFile(filename);
    await rename(temporary, filename);
  } catch {
    throw new MyclicarError('Enregistrement privé des identifiants MyClicar impossible', 409);
  } finally { await file?.close(); await rm(temporary, { force: true }).catch(() => {}); }
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new MyclicarError('Réponse MyClicar trop volumineuse');
  }
  const chunks = [], reader = response.body?.getReader();
  if (!reader) throw new MyclicarError('Réponse MyClicar invalide');
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MyclicarError('Réponse MyClicar trop volumineuse');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new MyclicarError('Réponse MyClicar invalide'); }
}

function tokenDeadline(token, now) {
  let until = now + SESSION_MS;
  try {
    const parts = token.split('.');
    if (parts.length === 3 && parts[1].length <= 8192) {
      const expiry = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp;
      if (Number.isFinite(expiry)) until = Math.min(until, expiry * 1000 - 30000);
    }
  } catch { /* Opaque access tokens are supported; expiry is bounded locally. */ }
  if (until <= now) throw new MyclicarError('Session MyClicar reçue expirée', 502, 60, 'authentication');
  return until;
}

function contractText(value, limit = 254, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new MyclicarError('Contrat MyClicar incomplet');
    return null;
  }
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new MyclicarError('Contrat MyClicar invalide');
  const text = value.trim();
  if (required && !text) throw new MyclicarError('Contrat MyClicar incomplet');
  return text || null;
}

function contractDate(value, now, { required = false, future = false } = {}) {
  const text = contractText(value, 64, required);
  if (text === null) return null;
  const at = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(at) || !future && at > now + 60000) throw new MyclicarError('Date de contrat MyClicar invalide');
  return new Date(at).toISOString();
}

function normalizedContract(row, now, returned = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !(returned ? ['DONE','VEHICLE_RETURNED'].includes(row.status) : row.status === 'IN_PROGRESS') || row.deletedAt != null) throw new MyclicarError('Filtre des contrats MyClicar incohérent');
  const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0 ? String(row.id) : contractText(row.id, 128, true);
  return {
    id, reference: contractText(row.reference, 128, true), status: row.status,
    departureDate: contractDate(row.departureDate, now, { required: true }),
    actualReturnDate: contractDate(row.actualReturnDate, now),
    // The portal also returns human-readable Moroccan local dates. Preserve
    // them as display text; never interpret them in the server's timezone.
    departureConditionDate: contractText(row.departureConditionDate, 100),
    checkoutDate: contractText(row.checkoutDate, 100),
    endDueDate: contractDate(row.endDueDate, now, { future: true }),
    vehicleRegistration: contractText(row.vehicleRegistration, 64),
    vehicleTemporaryRegistration: contractText(row.vehicleTemporaryRegistration, 64),
    vehicleBrand: contractText(row.vehicleBrand, 128), vehicleModel: contractText(row.vehicleModel, 128),
    contactName: contractText(row.contactName), clientReference: contractText(row.clientReference, 128),
    createdAt: contractDate(row.createdAt, now), updatedAt: contractDate(row.updatedAt, now), deletedAt: null,
    originType: contractText(row.originType, 100)
  };
}

function inventoryVehicle(row,now,archived){
 if(!row||typeof row!=='object'||Array.isArray(row)||!['AVAILABLE','RENTED','RESERVED'].includes(row.status)||!!row.deletedAt!==archived||typeof row.isBlocked!=='boolean')throw new MyclicarError('Inventaire MyClicar incohérent');
 return {external_id:contractText(row.id,120,true),reference:contractText(row.reference,120,true),plate:contractText(row.registration,120)||'',temporary_plate:contractText(row.temporaryRegistration,120)||'',
  brand:contractText(row.category?.brand,100)||'',model:contractText(row.category?.model,160)||'',vin:contractText(row.serialNumber,120)||'',fuel:contractText(row.fuelType,60)||'',
  status:row.status,is_blocked:row.isBlocked,archived,provider_updated_at:contractDate(row.updatedAt,now),deleted_at:contractDate(row.deletedAt,now)};
}
function inventoryAgency(row,now){
 if(!row||typeof row!=='object'||Array.isArray(row)||row.deletedAt!=null)throw new MyclicarError('Agence MyClicar incohérente');
 return {external_id:contractText(row.id,120,true),code:contractText(row.code,120,true),name:contractText(row.title,160,true),provider_updated_at:contractDate(row.updatedAt,now)};
}

export class MyclicarClient {
  #credentials;
  #fetch;
  #now;
  #lastNow = -Infinity;
  #session = null;
  #authPromise = null;
  #generation = 0;
  #blockedUntil = 0;
  #quotaFailures = 0;
  #snapshotPromise = null;
  #historyPromise = null;
  #historyWindow = null;
  #historyEndpoints = new Set();
  #inventoryPromise = null;
  #detailEndpoints = new Set();
  #detailCache = new Map();

  constructor({ credentials, fetchFn = fetch, now = Date.now }) {
    this.#credentials = typeof credentials === 'function' ? credentials : () => credentials;
    this.#fetch = fetchFn;
    this.#now = now;
  }

  #clock() { this.#lastNow = Math.max(this.#lastNow, this.#now()); return this.#lastNow; }

  reset() { this.#session = null; this.#authPromise = null; this.#snapshotPromise = null; this.#historyPromise = null; this.#historyWindow = null; this.#historyEndpoints.clear(); this.#inventoryPromise=null;this.#detailEndpoints.clear();this.#detailCache.clear();this.#generation++; }

  #quota(response) {
    const raw = response.headers.get('retry-after'), seconds = raw?.trim() ? Number(raw) : NaN;
    const date = raw ? Date.parse(raw) : NaN;
    const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds : Number.isFinite(date) ? Math.max(0, (date - this.#clock()) / 1000) : 0;
    const delay = Math.max(requested, Math.min(3600, 30 * 2 ** Math.min(this.#quotaFailures++, 7)));
    this.#blockedUntil = Math.max(this.#blockedUntil, this.#clock() + delay * 1000);
    return new MyclicarError('Quota MyClicar atteint : lecture différée', 429, Math.ceil(delay), 'quota');
  }

  async #request(url, options, { portal = false, login = false, deadline = Infinity } = {}) {
    const now = this.#clock();
    if (now < this.#blockedUntil) throw new MyclicarError('Quota MyClicar atteint : lecture différée', 429, Math.ceil((this.#blockedUntil - now) / 1000), 'quota');
    const timeout = Math.min(REQUEST_MS, deadline - now);
    if (timeout <= 0) throw new MyclicarError('Délai de lecture MyClicar dépassé');
    let response;
    try {
      response = await this.#fetch(url, { ...options, redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(Math.ceil(timeout)) });
      if (response.status === 429) throw this.#quota(response);
      if (response.status === 401) throw new MyclicarError(portal ? 'Protection HTTP MyClicar refusée : vérifiez les accès HTTP' : 'Authentification MyClicar refusée : vérifiez le compte', 502, 60, portal ? 'http_authentication' : 'authentication');
      if (response.status === 403) throw new MyclicarError(portal ? 'Protection HTTP MyClicar refusée : vérifiez les accès HTTP' : 'Droits de lecture MyClicar insuffisants', 502, 60, portal ? 'http_authentication' : 'permission');
      if (!response.ok || response.redirected || response.status >= 300 || login && response.status !== 201) throw new MyclicarError(portal ? 'Accès au portail MyClicar indisponible' : login ? 'Authentification MyClicar indisponible' : 'Lecture MyClicar indisponible');
      if (portal) { await response.body?.cancel().catch(() => {}); return; }
      const result = await boundedJson(response);
      this.#quotaFailures = 0;
      return result;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (error instanceof MyclicarError) throw error;
      throw new MyclicarError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Délai de lecture MyClicar dépassé' : 'Connexion MyClicar indisponible');
    }
  }

  async #authenticate(deadline = Infinity) {
    if (this.#session && this.#clock() < this.#session.until) return this.#session;
    if (this.#authPromise) return this.#authPromise;
    const generation = this.#generation;
    const promise = (async () => {
      let input;
      try { input = await this.#credentials(); }
      catch { throw new MyclicarError('Lecture des identifiants MyClicar locaux impossible', 409); }
      if (!input) throw new MyclicarError('Identifiants MyClicar non configurés', 409);
      const config = validateMyclicarCredentials(input);
      if (generation !== this.#generation) throw new MyclicarError('Connexion MyClicar remplacée ; réessayez', 409);
      await this.#request(PORTAL_ORIGIN + '/', { method: 'GET', headers: { Authorization: 'Basic ' + Buffer.from(config.httpUsername + ':' + config.httpPassword, 'utf8').toString('base64') } }, { portal: true, deadline });
      if (generation !== this.#generation) throw new MyclicarError('Connexion MyClicar remplacée ; réessayez', 409);
      const data = await this.#request(API_ORIGIN + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: config.email, password: config.password, platform: PLATFORM }) }, { login: true, deadline });
      const token = data?.accessToken;
      if (typeof token !== 'string' || !token.length || token.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new MyclicarError('Réponse d’authentification MyClicar invalide');
      if (generation !== this.#generation) throw new MyclicarError('Connexion MyClicar remplacée ; réessayez', 409);
      const session = { token, until: tokenDeadline(token, this.#clock()) };
      this.#session = session;
      return session;
    })();
    this.#authPromise = promise;
    try { return await promise; }
    finally { if (this.#authPromise === promise) this.#authPromise = null; }
  }

  async #read(endpoint, deadline = Infinity) {
    if (!READ_ENDPOINTS.has(endpoint) && !this.#historyEndpoints.has(endpoint) && !this.#detailEndpoints.has(endpoint)) throw new MyclicarError('Lecture MyClicar non autorisée', 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.#authenticate(deadline);
      try { return await this.#request(API_ORIGIN + endpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + session.token, Accept: 'application/json' } }, { deadline }); }
      catch (error) {
        if (error.kind !== 'authentication') throw error;
        if (this.#session === session) this.#session = null;
        if (attempt === 1) throw error;
      }
    }
  }

  async test() { await this.#authenticate(); return { ok: true }; }

  async inventorySnapshot(){
   if(this.#inventoryPromise)return this.#inventoryPromise;
   const generation=this.#generation,started=this.#clock();
   const promise=(async()=>{
    const vehicles=[],agencies=[],seen=new Set();
    for(const [resource,archived]of [['agency',false],['vehicle',false],['vehicle',true]]){
     let total,pages;
     for(let page=1;page<=MAX_PAGES;page++){
      const result=await this.#read(inventoryEndpoint(resource,page,archived),started+SNAPSHOT_MS),now=this.#clock(),meta=result?.meta,rows=result?.data;
      if(generation!==this.#generation)throw new MyclicarError('Connexion MyClicar remplacée ; réessayez',409);
      if(now-started>=SNAPSHOT_MS||!meta||!Array.isArray(rows)||!Number.isInteger(meta.total)||meta.total<0||meta.total>PAGE_SIZE*MAX_PAGES||meta.page!==page||meta.itemsPerPage!==PAGE_SIZE||!Number.isInteger(meta.pageCount)||meta.pageCount<0||meta.pageCount>MAX_PAGES||meta.pageCount!==Math.ceil(meta.total/PAGE_SIZE)&&!(meta.total===0&&meta.pageCount===1))throw new MyclicarError('Inventaire MyClicar incomplet');
      if(page===1){total=meta.total;pages=meta.pageCount;}
      if(meta.total!==total||meta.pageCount!==pages||rows.length!==Math.min(PAGE_SIZE,Math.max(0,total-(page-1)*PAGE_SIZE)))throw new MyclicarError('Inventaire MyClicar modifié ou incomplet');
      for(const raw of rows){const row=resource==='agency'?inventoryAgency(raw,now):inventoryVehicle(raw,now,archived),key=resource+':'+row.external_id;if(seen.has(key))throw new MyclicarError('Inventaire MyClicar dupliqué');seen.add(key);(resource==='agency'?agencies:vehicles).push(row);}
      if(page>=pages)break;
     }
    }
    return {at:new Date(this.#clock()).toISOString(),complete:true,vehicles,agencies,coverage:{vehicles:vehicles.length,current_vehicles:vehicles.filter(v=>!v.archived).length,archived_vehicles:vehicles.filter(v=>v.archived).length,agencies:agencies.length}};
   })();this.#inventoryPromise=promise;try{return await promise;}finally{if(this.#inventoryPromise===promise)this.#inventoryPromise=null;}
  }

  async #enrichContracts(contracts,deadline,generation){
   if(this.#detailCache.size>4000)for(const [key,value]of this.#detailCache){if(this.#detailCache.size<=4000)break;if(value.until<=this.#clock())this.#detailCache.delete(key);}
   const todo=[...contracts];
   await Promise.all(Array.from({length:Math.min(3,todo.length)},async()=>{while(todo.length){const row=todo.shift(),cached=this.#detailCache.get(row.id);
    if(cached&&cached.until>this.#clock()&&cached.updatedAt===row.updatedAt){Object.assign(row,cached.value);continue;}
    const endpoint='/contract/'+encodeURIComponent(row.id);this.#detailEndpoints.add(endpoint);
    try{
     const d=await this.#read(endpoint,deadline),now=this.#clock();
     if(generation!==this.#generation)throw new MyclicarError('Connexion MyClicar remplacée ; réessayez',409);
     if(!d||d.id!==row.id||d.reference!==row.reference||d.status!==row.status||d.deletedAt!=null||d.archivedAt!=null||d.canceledAt!=null||d.isBooking!==false||d.client?.reference!==row.clientReference||d.vehicleRegistration!==row.vehicleRegistration)throw new MyclicarError('Détails de contrat MyClicar contradictoires');
     const value={vehicleExternalId:contractText(d.vehicleId,120,true),departureAgencyExternalId:contractText(d.departureAgencyId,120),returnAgencyExternalId:contractText(d.returnAgencyId,120),
      effectiveDepartureAt:contractDate(d.departureConditionDate,now),effectiveReturnAt:contractDate(d.actualReturnDate,now),detailsVerified:true};
     Object.assign(row,value);this.#detailCache.set(row.id,{updatedAt:row.updatedAt,until:now+(row.status==='IN_PROGRESS'?300000:86400000),value});
     if(this.#detailCache.size>4000)this.#detailCache.delete(this.#detailCache.keys().next().value);
    }finally{this.#detailEndpoints.delete(endpoint);}
   }}));
  }

  // These status values and ISO from/to filters are used by the portal's own
  // contract list (verified 2026-11-02). Only this bounded read is allowed here.
  async historySnapshot({from,to,details=false}={}) {
    const started=this.#clock(),start=Date.parse(from),end=Date.parse(to);
    if(typeof from!=='string'||typeof to!=='string'||!Number.isFinite(start)||!Number.isFinite(end)||start>=end||end-start>31*86400000||start<started-90*86400000||end>started+86400000)throw new MyclicarError('Période historique MyClicar invalide',400);
    const windowKey=start+':'+end;
    if(this.#historyPromise){if(this.#historyWindow!==windowKey)throw new MyclicarError('Une autre période MyClicar est en cours de lecture',409);return this.#historyPromise;}
    const generation=this.#generation,permitted=new Set();
    const promise=(async()=>{
      const contracts=[],ids=new Set(),references=new Set();let expectedTotal,expectedPages;
      for(let page=1;page<=MAX_PAGES;page++){
        if(this.#clock()-started>=SNAPSHOT_MS)throw new MyclicarError('Délai de lecture des retours MyClicar dépassé');
        const params=new URLSearchParams({page:String(page),itemsPerPage:String(PAGE_SIZE),isBooking:'false',isArchived:'false',isCanceled:'false',from:new Date(start).toISOString(),to:new Date(end).toISOString()});
        params.append('status[]','DONE');params.append('status[]','VEHICLE_RETURNED');
        const endpoint='/contract?'+params;permitted.add(endpoint);this.#historyEndpoints.add(endpoint);
        const result=await this.#read(endpoint,started+SNAPSHOT_MS),now=this.#clock();
        if(generation!==this.#generation)throw new MyclicarError('Connexion MyClicar remplacée ; réessayez',409);
        const meta=result?.meta,rows=result?.data;
        if(now-started>=SNAPSHOT_MS||!meta||!Array.isArray(rows)||!Number.isInteger(meta.total)||meta.total<0||meta.total>PAGE_SIZE*MAX_PAGES||meta.page!==page||meta.itemsPerPage!==PAGE_SIZE||!Number.isInteger(meta.pageCount)||meta.pageCount<0||meta.pageCount>MAX_PAGES)throw new MyclicarError('Historique MyClicar incomplet');
        if(meta.pageCount!==Math.ceil(meta.total/PAGE_SIZE)&&!(meta.total===0&&meta.pageCount===1))throw new MyclicarError('Historique MyClicar incomplet');
        if(page===1){expectedTotal=meta.total;expectedPages=meta.pageCount;}
        if(meta.total!==expectedTotal||meta.pageCount!==expectedPages||rows.length!==Math.min(PAGE_SIZE,Math.max(0,expectedTotal-(page-1)*PAGE_SIZE)))throw new MyclicarError('Historique MyClicar modifié ou incomplet');
        for(const row of rows){const contract=normalizedContract(row,now,true);if(ids.has(contract.id)||references.has(contract.reference))throw new MyclicarError('Historique MyClicar dupliqué');ids.add(contract.id);references.add(contract.reference);contracts.push(contract);}
        if(page>=expectedPages){if(details)await this.#enrichContracts(contracts,started+SNAPSHOT_MS,generation);return {at:new Date(this.#clock()).toISOString(),contracts,complete:true,from:new Date(start).toISOString(),to:new Date(end).toISOString()};}
      }
      throw new MyclicarError('Limite de lecture des retours MyClicar atteinte');
    })();
    this.#historyPromise=promise;this.#historyWindow=windowKey;
    try{return await promise;}finally{for(const endpoint of permitted)this.#historyEndpoints.delete(endpoint);if(this.#historyPromise===promise){this.#historyPromise=null;this.#historyWindow=null;}}
  }

  async snapshot({details=false}={}) {
    if (this.#snapshotPromise) return this.#snapshotPromise;
    const generation = this.#generation, started = this.#clock();
    const promise = (async () => {
      const contracts = [], ids = new Set(), references = new Set();
      let expectedTotal, expectedPages;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (this.#clock() - started >= SNAPSHOT_MS) throw new MyclicarError('Délai de lecture des contrats MyClicar dépassé');
        const result = await this.#read(contractEndpoint(page), started + SNAPSHOT_MS);
        const now = this.#clock();
        if (generation !== this.#generation) throw new MyclicarError('Connexion MyClicar remplacée ; réessayez', 409);
        if (now - started >= SNAPSHOT_MS) throw new MyclicarError('Délai de lecture des contrats MyClicar dépassé');
        const meta = result?.meta, rows = result?.data;
        if (!meta || !Array.isArray(rows) || !Number.isInteger(meta.total) || meta.total < 0 || meta.total > PAGE_SIZE * MAX_PAGES || meta.page !== page || meta.itemsPerPage !== PAGE_SIZE || !Number.isInteger(meta.pageCount) || meta.pageCount < 0 || meta.pageCount > MAX_PAGES) throw new MyclicarError('Pagination des contrats MyClicar invalide');
        const calculatedPages = Math.ceil(meta.total / PAGE_SIZE);
        if (meta.pageCount !== calculatedPages && !(meta.total === 0 && meta.pageCount === 1)) throw new MyclicarError('Pagination des contrats MyClicar incomplète');
        if (page === 1) { expectedTotal = meta.total; expectedPages = meta.pageCount; }
        if (meta.total !== expectedTotal || meta.pageCount !== expectedPages || rows.length !== Math.min(PAGE_SIZE, Math.max(0, expectedTotal - (page - 1) * PAGE_SIZE))) throw new MyclicarError('Liste des contrats MyClicar modifiée ou incomplète : réessayez');
        for (const row of rows) {
          const contract = normalizedContract(row, now);
          if (ids.has(contract.id) || references.has(contract.reference)) throw new MyclicarError('Contrat MyClicar dupliqué : lecture interrompue');
          ids.add(contract.id); references.add(contract.reference); contracts.push(contract);
        }
        if (page >= expectedPages) {
          if (contracts.length !== expectedTotal) throw new MyclicarError('Liste des contrats MyClicar incomplète');
          if(details)await this.#enrichContracts(contracts,started+SNAPSHOT_MS,generation);
          if(generation!==this.#generation)throw new MyclicarError('Connexion MyClicar remplacée ; réessayez',409);
          return { at: new Date(this.#clock()).toISOString(), contracts, complete: true, coverage: { contracts: contracts.length, active_contracts: contracts.length } };
        }
      }
      throw new MyclicarError('Limite de lecture des contrats MyClicar atteinte');
    })();
    this.#snapshotPromise = promise;
    try { return await promise; }
    finally { if (this.#snapshotPromise === promise) this.#snapshotPromise = null; }
  }
}
