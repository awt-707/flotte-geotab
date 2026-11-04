import { MyclicarClient, readMyclicarCredentials, saveMyclicarCredentials, validateMyclicarCredentials } from './myclicar.mjs';
import { normalizeMyClicarContracts } from './myclicar-contracts.mjs';

const INTERVAL_MS = 60000;
const STALE_SECONDS = 300;
const MAX_CONTRACTS = 2000;
const fail = (status, message) => Object.assign(new Error(message), { status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502 });
const UNAVAILABLE = 'Synchronisation MyClicar indisponible. Vérifiez les accès ou réessayez plus tard.';
const INCOMPLETE = 'Lecture MyClicar incomplète ou invalide ; les contrats précédents sont conservés.';
const COVERAGE_KEYS = ['contracts', 'active_contracts', 'matched_assignments', 'unmatched_contracts'];
const PUBLIC_ERRORS = new Set([UNAVAILABLE, INCOMPLETE, 'Connectez d’abord MyClicar.',
  'Protection HTTP MyClicar refusée : vérifiez les accès HTTP',
  'Authentification MyClicar refusée : vérifiez le compte',
  'Droits de lecture MyClicar insuffisants', 'Quota MyClicar atteint : lecture différée']);

function publicError(error) {
  if (PUBLIC_ERRORS.has(error?.message)) return error.message;
  return ({ http_authentication: 'Protection HTTP MyClicar refusée : vérifiez les accès HTTP',
    authentication: 'Authentification MyClicar refusée : vérifiez le compte',
    permission: 'Droits de lecture MyClicar insuffisants', quota: 'Quota MyClicar atteint : lecture différée' })[error?.kind] || UNAVAILABLE;
}

function coverage(value) {
  return Object.fromEntries(COVERAGE_KEYS.map(key => [key,
    Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0]));
}

// The supplied database functions belong to the guarded local Supabase adapter.
// Only a validated, complete snapshot reaches the transaction RPC.
export function createMyclicarService({ db, list, patch, health, credentialsPath, fetchFn = fetch, now = Date.now,
  Client = MyclicarClient, setTimer = setTimeout, clearTimer = clearTimeout, afterSync = async () => {},afterInventorySync=async()=>{} }) {
  const credentials = () => credentialsPath ? readMyclicarCredentials(credentialsPath) : Promise.resolve(null);
  let client = new Client({ credentials, fetchFn, now });
  let timer = null, polling = false, busy = null, busyGeneration = -1, generation = 0, nextAt = 0, failures = 0, closed = false;
  let queue = Promise.resolve();
  let historyBusy=null,historyNextAt=0;
  let inventoryBusy=null,inventoryNextAt=0;
  const serial = work => { const pending = queue.then(work); queue = pending.catch(() => {}); return pending; };
  const source = async () => (await db('fleet_sources', { params: {
    id: 'eq.myclicar', select: 'id,status,last_success_at,last_error,coverage'
  } }))?.[0] || {};
  const ignored = () => ({ ok: true, ignored: true, polling });

  function pause() {
    polling = false;
    clearTimer(timer); timer = null;
    generation++;
  }

  function scheduleNext() {
    if (!polling || closed) return;
    clearTimer(timer);
    const current = generation;
    timer = setTimer(async () => {
      timer = null;
      if (!polling || closed || current !== generation) return;
      try { await refresh(); }
      catch { /* refresh has recorded a bounded, redacted retry state. */ }
      finally { if (polling && current === generation) scheduleNext(); }
    }, Math.min(2147483647, Math.max(50, nextAt - now())));
    timer?.unref?.();
  }

  async function status() {
    const [creds, src] = await Promise.all([credentials(), source()]);
    const lastSuccess = Number.isFinite(Date.parse(src.last_success_at)) ? src.last_success_at : null;
    const sourceStatus = ['healthy', 'error', 'stale', 'paused', 'unconnected'].includes(src.status) ? src.status : 'paused';
    const state = !creds ? 'unconnected' : !polling ? (sourceStatus === 'error' ? 'error' : 'paused') :
      sourceStatus === 'healthy' && (!lastSuccess || now() - Date.parse(lastSuccess) > STALE_SECONDS * 1000) ? 'stale' : sourceStatus;
    return { configured: !!creds, email: creds?.email || '', httpUsername: creds?.httpUsername || '', httpConfigured: !!creds?.httpPassword,
      status: state, polling, interval_s: INTERVAL_MS / 1000,
      next_attempt_at: polling && nextAt ? new Date(Math.max(now(), nextAt)).toISOString() : null,
      retrying: polling && failures > 0, last_success_at: lastSuccess,
      last_error: src.last_error ? publicError({ message: src.last_error }) : null, coverage: coverage(src.coverage) };
  }

  async function connect(input) {
    if (!credentialsPath) throw fail(409, 'Configuration locale MyClicar absente');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Identifiants MyClicar requis');
    return serial(async () => {
      if (closed) throw fail(409, 'Service MyClicar arrêté.');
      const current = generation, previous = await credentials();
      const candidate = validateMyclicarCredentials({ ...input,
        password: input.password === undefined ? previous?.password : input.password,
        httpPassword: input.httpPassword === undefined ? previous?.httpPassword : input.httpPassword });
      const tested = new Client({ credentials: async () => candidate, fetchFn, now });
      try { await tested.test(); }
      catch (error) { tested.reset?.(); throw fail(error?.status || 502, publicError(error)); }
      if (closed || current !== generation) { tested.reset?.(); return { ...ignored(), ...await status() }; }
      pause();
      const savingGeneration = generation;
      try { await saveMyclicarCredentials(credentialsPath, candidate); }
      catch (error) { tested.reset?.(); throw error; }
      client.reset?.(); client = tested;
      nextAt = 0; failures = 0; historyNextAt = 0; inventoryNextAt=0;
      if (closed || savingGeneration !== generation) {
        if (closed) client.reset?.();
        return { ...ignored(), ...await status() };
      }
      await health('myclicar', 'paused', { last_error: null, last_attempt_at: new Date(now()).toISOString(), stale_after_s: STALE_SECONDS });
      return status();
    });
  }

  async function refresh() {
    if (closed) throw fail(409, 'Service MyClicar arrêté.');
    if (busy) {
      if (busyGeneration === generation) return busy;
      // Let a previous connection finish its bounded request before using the new one.
      await busy.catch(() => {});
      return refresh();
    }
    if (now() < nextAt) throw fail(429, 'Lecture MyClicar déjà récente ou différée.');
    const current = generation, activeClient = client;
    busyGeneration = current;
    const pending = (async () => {
      const startedAt = now(), at = new Date(startedAt).toISOString();
      try {
        if (!await credentials()) throw fail(409, 'Connectez d’abord MyClicar.');
        const ready = await serial(async () => {
          if (current !== generation) return false;
          await patch('fleet_sources', { id: 'eq.myclicar' }, { last_attempt_at: at });
          return current === generation;
        });
        if (!ready) return ignored();
        if(typeof activeClient.inventorySnapshot==='function')await refreshInventory();
        if(current!==generation)return ignored();
        const snapshot = await activeClient.snapshot({details:true});
        if (current !== generation) return ignored();
        const observed = typeof snapshot?.at === 'string' ? Date.parse(snapshot.at) : NaN;
        if (snapshot?.complete !== true || !Array.isArray(snapshot.contracts) || snapshot.contracts.length > MAX_CONTRACTS ||
          !Number.isFinite(observed) || observed < startedAt - INTERVAL_MS || observed > now() + INTERVAL_MS) throw fail(502, INCOMPLETE);
        const observedAt = new Date(observed).toISOString();
        let projection;
        try { projection = normalizeMyClicarContracts(snapshot.contracts, { observedAt, now: now() }); }
        catch { throw fail(502, INCOMPLETE); }
        if (!Array.isArray(projection?.contracts) || projection.contracts.length !== snapshot.contracts.length) throw fail(502, INCOMPLETE);
        return await serial(async () => {
          if (current !== generation) return ignored();
          const result = await db('rpc/fleet_sync_myclicar', { method: 'POST', body: { p_contracts: projection.contracts, p_observed_at: observedAt } });
          if (current !== generation) return ignored();
          const receipt = Array.isArray(result) ? result[0] : result;
          if (COVERAGE_KEYS.some(key => !Number.isSafeInteger(receipt?.[key]) || receipt[key] < 0) ||
            receipt.contracts !== projection.contracts.length || receipt.active_contracts > receipt.contracts ||
            receipt.matched_assignments > receipt.active_contracts || receipt.unmatched_contracts !== receipt.contracts - receipt.matched_assignments) throw fail(502, UNAVAILABLE);
          const counts = coverage(receipt);
          await health('myclicar', 'healthy', { last_success_at: observedAt, last_error: null, stale_after_s: STALE_SECONDS, coverage: counts });
          if (current !== generation) return ignored();
          await afterSync();
          if (current !== generation) return ignored();
          nextAt = startedAt + INTERVAL_MS; failures = 0;
          // History is independent: a failed return read cannot invalidate the
          // complete active-contract snapshot or delay the regular live loop.
          if(typeof activeClient.historySnapshot==='function')void refreshHistory().catch(()=>{});
          return { ok: true, received_at: observedAt, coverage: counts };
        });
      } catch (error) {
        if (current !== generation) return ignored();
        failures++;
        const requested = Number.isFinite(error?.retryAfter) && error.retryAfter >= 0 ? error.retryAfter : 0;
        const delay = Math.max(requested, Math.min(900, 30 * 2 ** Math.min(failures, 5)));
        nextAt = Math.min(8640000000000000, now() + delay * 1000);
        const message = publicError(error);
        try { await serial(async () => { if (current === generation) await health('myclicar', 'error', { last_error: message }); }); }
        catch { /* A local database failure must not expose its private diagnostic. */ }
        if (current !== generation) return ignored();
        throw fail(error?.status || 502, message);
      }
    })();
    busy = pending;
    try { return await pending; }
    finally { if (busy === pending) { busy = null; busyGeneration = -1; } }
  }

  async function refreshHistory() {
    if(closed||historyBusy||now()<historyNextAt||typeof client.historySnapshot!=='function')return historyBusy||{ignored:true};
    const current=generation,activeClient=client,started=now(),to=new Date(started).toISOString(),from=new Date(started-7*86400000).toISOString();
    historyNextAt=started+300000;
    const pending=(async()=>{
      try{
        const snapshot=await activeClient.historySnapshot({from,to,details:true});
        if(closed||current!==generation)return ignored();
        if(snapshot?.complete!==true||!Array.isArray(snapshot.contracts)||snapshot.contracts.length>MAX_CONTRACTS||!Number.isFinite(Date.parse(snapshot.at)))throw Error(INCOMPLETE);
        const projection=normalizeMyClicarContracts(snapshot.contracts,{observedAt:snapshot.at,now:now()});
        await serial(async()=>{
          if(closed||current!==generation)return;
          await db('rpc/fleet_sync_rotation_contracts',{method:'POST',body:{p_contracts:projection.contracts,p_observed_at:snapshot.at,p_from:from,p_to:to}});
        });
        return {ok:true,contracts:projection.contracts.length};
      }catch(error){
        if(!closed&&current===generation){
          historyNextAt=Math.max(historyNextAt,now()+Math.min(900,Number(error?.retryAfter)||300)*1000);
          await serial(async()=>{if(!closed&&current===generation)await patch('fleet_rotation_sync',{id:'eq.1'},{status:'error',last_attempt_at:new Date(started).toISOString(),last_error:'Lecture des retours MyClicar indisponible ; historique précédent conservé.'});}).catch(()=>{});
        }
        return {ok:false};
      }
    })();
    historyBusy=pending;
    try{return await pending;}finally{if(historyBusy===pending)historyBusy=null;}
  }

  async function refreshInventory(){
    if(closed||inventoryBusy||now()<inventoryNextAt||typeof client.inventorySnapshot!=='function')return inventoryBusy||{ignored:true};
    const current=generation,activeClient=client,started=now();inventoryNextAt=started+300000;
    const pending=(async()=>{try{
      const snapshot=await activeClient.inventorySnapshot();
      if(closed||current!==generation)return ignored();
      const at=Date.parse(snapshot?.at);
      if(snapshot?.complete!==true||!Array.isArray(snapshot.vehicles)||snapshot.vehicles.length>4000||!Array.isArray(snapshot.agencies)||snapshot.agencies.length>2000||!Number.isFinite(at)||at<started-60000||at>now()+5000)throw Error(INCOMPLETE);
      return await serial(async()=>{
        if(closed||current!==generation)return ignored();
        const result=await db('rpc/fleet_sync_inventory',{method:'POST',body:{p_vehicles:snapshot.vehicles,p_agencies:snapshot.agencies,p_observed_at:snapshot.at}});
        if(closed||current!==generation)return ignored();
        // The inventory is already committed. A secondary local association
        // failure must not misreport a successful provider read as failed.
        let associations;
        try{associations=await afterInventorySync();}catch{associations={ok:false,reason:'association_unavailable'};}
        return {ok:true,coverage:result,...(associations?{associations}:{})};
      });
    }catch(error){
      if(!closed&&current===generation){inventoryNextAt=Math.max(inventoryNextAt,now()+Math.min(900,Number(error?.retryAfter)||300)*1000);await serial(async()=>{if(!closed&&current===generation)await patch('fleet_inventory_sync',{id:'eq.1'},{status:'error',last_attempt_at:new Date(started).toISOString(),last_error:'Lecture du parc MyClicar indisponible ; dernier inventaire complet conservé.'});}).catch(()=>{});}
      return {ok:false};
    }})();inventoryBusy=pending;try{return await pending;}finally{if(inventoryBusy===pending)inventoryBusy=null;}
  }

  async function start() {
    if (closed) throw fail(409, 'Service MyClicar arrêté.');
    if (polling) return { ok: true, ...await status() };
    const current = generation;
    polling = true;
    let result;
    try { result = await refresh(); }
    catch { result = { ok: false, retrying: true }; }
    finally { if (polling && current === generation) scheduleNext(); }
    if (current !== generation) return { ...ignored(), ...await status() };
    return { ...result, ...await status() };
  }

  async function stop() {
    pause();
    await serial(() => health('myclicar', 'paused', { last_error: null }));
    return status();
  }

  function close() { closed = true; pause(); client.reset?.(); }

  return { status, connect, start, stop, refresh, refreshHistory, refreshInventory, close, get polling() { return polling; },
    get nextAttemptAt() { return polling && nextAt ? new Date(Math.max(now(), nextAt)).toISOString() : null; },
    get retrying() { return polling && failures > 0; } };
}
