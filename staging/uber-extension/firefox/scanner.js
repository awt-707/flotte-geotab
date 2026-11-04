/* Walk the rendered driver list only. No provider requests or hidden application state. */
(() => {
  'use strict';
  const MAX_MS = 18000, MAX_STEPS = 40, MAX_ROWS = 200, SETTLE_MS = 160;
  const VEHICLE_MS = 180000, MAX_DETAILS = 12, vehicleCache = new Map(), detailAttempts = new Map();
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const identity = row => row.sourceId || normalize(row.name);
  const scrollingKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab']);
  const messages = Object.freeze({
    end_of_list: 'Liste affichée parcourue du début à la fin ; les filtres Uber restent appliqués.',
    visible_only: 'Défilement non identifié : seules les lignes actuellement visibles sont transmises.',
    filtered_view: 'Liste filtrée parcourue : les chauffeurs masqués par les filtres restent inconnus.',
    ambiguous_identity: 'Identités répétées pendant le parcours : correspondances incertaines ignorées.',
    user_interaction: 'Parcours interrompu par votre action. Reprise lors de la prochaine lecture.',
    hidden: 'La page Uber doit rester visible pendant tout le parcours.',
    aborted: 'Parcours arrêté ; aucune observation partielle transmise.',
    timeout: 'Temps de parcours atteint : couverture partielle, sans état inventé pour les autres chauffeurs.',
    step_limit: 'Limite de parcours atteinte : couverture partielle de la liste affichée.',
    row_limit: 'Lecture limitée à 200 chauffeurs par parcours ; couverture partielle.',
    list_changed: 'La liste ou ses filtres ont changé pendant le parcours. Nouvelle lecture nécessaire.',
    unstable: 'La liste continue de changer ou de charger. Lecture suspendue pour éviter une association incertaine.',
    reader_error: 'Liste Uber momentanément inexploitable. Aucun absent déclaré hors ligne.'
  });

  async function scan({ signal } = {}) {
    const reader = globalThis.LudyUberReader, started = Date.now(), deadline = started + MAX_MS, monotonicStart = performance.now();
    let first, root = null, panel = null, originalTop = 0, ownedTop = 0, moved = false;
    let interruption = null, reason = 'visible_only', complete = false, filtered = false, ambiguous = false;
    const collected = new Map(), rejected = new Set(), warnings = new Set(), abort = new AbortController();
    const expandedInitially=new Set();
    const initialPath = location.pathname;
    const organizationId = initialPath.match(/^\/orgs\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/livemap\/?$/i)?.[1]?.toLowerCase();
    const cacheKey=key=>organizationId+':'+key;
    for(const [key,value] of vehicleCache)if(!key.startsWith(organizationId+':')||Date.now()-Date.parse(value.vehicleReadAt)>VEHICLE_MS||Date.parse(value.vehicleReadAt)>Date.now())vehicleCache.delete(key);
    for(const key of detailAttempts.keys())if(!key.startsWith(organizationId+':'))detailAttempts.delete(key);
    const stop = why => { if (!interruption) interruption = why; abort.abort(); };
    const interaction = event => {
      if (event.type === 'keydown' && !scrollingKeys.has(event.key)) return;
      stop('user_interaction');
    };
    const changed = event => { if (!panel || panel.contains(event.target)) stop('list_changed'); };
    const hidden = () => { if (document.visibilityState !== 'visible') stop('hidden'); };
    const externalAbort = () => stop('aborted');
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    for (const event of events) document.addEventListener(event, interaction, { capture: true, passive: true });
    document.addEventListener('input', changed, true); document.addEventListener('change', changed, true);
    document.addEventListener('visibilitychange', hidden);
    signal?.addEventListener('abort', externalAbort, { once: true });

    const ensure = () => {
      if (signal?.aborted) stop('aborted');
      hidden();
      if (location.pathname !== initialPath) stop('list_changed');
      if (interruption) throw Error(interruption);
      if (Date.now() >= deadline || performance.now() - monotonicStart >= MAX_MS) throw Error('timeout');
      if (root && (!root.isConnected || !panel?.isConnected)) throw Error('list_changed');
    };
    function pause(ms) {
      ensure();
      return new Promise((resolve, reject) => {
        const end = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); resolve(); };
        const cancelled = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); reject(Error(interruption || 'aborted')); };
        const timer = setTimeout(end, Math.min(ms, Math.max(1, deadline - Date.now()), Math.max(1, MAX_MS - (performance.now() - monotonicStart))));
        abort.signal.addEventListener('abort', cancelled, { once: true });
      }).then(ensure);
    }
    async function paint() {
      // A hidden/throttled frame must not leave a collector permanently pending.
      await Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), pause(80)]);
      ensure();
    }
    const inspect = () => {
      ensure();
      const inspected = reader.inspect();
      if (first && inspected.result?.organizationId !== first.result?.organizationId) throw Error('list_changed');
      if (first && inspected.filtered !== first.filtered) throw Error('list_changed');
      if (root && (inspected.panel !== panel || inspected.scrollRoot !== root)) throw Error('list_changed');
      if (root && Math.abs(root.scrollTop - ownedTop) > 2) throw Error('list_changed');
      return inspected;
    };
    const position = (entry, scrollRoot = root) => {
      if (!entry?.element?.isConnected) return null;
      const box = entry.element.getBoundingClientRect();
      return scrollRoot ? box.top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop : box.top;
    };
    const signature = inspected => JSON.stringify([
      inspected.result?.status, !!inspected.filtered, root?.scrollHeight, root?.clientHeight,
      ...(inspected.entries || []).map(entry => [identity(entry.row), entry.row.state, entry.row.vehicleLabel || '', Math.round(position(entry) ?? -1)])
    ]);
    async function settled() {
      await paint();
      let previous = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const inspected = inspect(), key = signature(inspected);
        if (inspected.result?.status === 'observing' && inspected.result.rows?.length && previous === key) return inspected;
        previous = key;
        await pause(SETTLE_MS);
      }
      throw Error('unstable');
    }
    function absorb(inspected) {
      const entries = new Map((inspected.entries || []).map(entry => [entry.row, entry]));
      filtered ||= inspected.filtered === true;
      for (const warning of inspected.result.warnings || []) if (typeof warning === 'string' && warning.length <= 200) warnings.add(warning);
      for (const key of inspected.ambiguousKeys || []) { rejected.add(key); collected.delete(key);vehicleCache.delete(cacheKey(key)); ambiguous = true; }
      if (!inspected.ambiguousKeys && (inspected.result.warnings || []).some(warning => /identités répétées/i.test(warning))) throw Error('unstable');
      for (const row of inspected.result.rows) {
        const key = identity(row), entry = entries.get(row), at = position(entry), previous = collected.get(key);
        if (rejected.has(key)) continue;
        // Without an explicit visible driver ID, only the same rendered slot may
        // bridge overlapping viewports. Homonyms or a moving sort are excluded.
        if (previous && !row.sourceId && (at === null || previous.position === null || Math.abs(previous.position - at) > 3)) {
          collected.delete(key); rejected.add(key);vehicleCache.delete(cacheKey(key)); ambiguous = true; continue;
        }
        if (!previous && collected.size >= MAX_ROWS) { reason = 'row_limit'; return false; }
        collected.set(key, { row: { ...row }, position: at });
        if(entry?.expanded)expandedInitially.add(key);
        rememberVehicle(key,row);
      }
      return true;
    }
    function rememberVehicle(key,row){
      if(!row.vehicleLabel||!row.vehicleReadAt)return;
      vehicleCache.set(cacheKey(key),{vehicleLabel:row.vehicleLabel,...(row.vehicleModel?{vehicleModel:row.vehicleModel}:{}),vehicleReadAt:row.vehicleReadAt,vehicleState:row.vehicleState||row.state});
      if(vehicleCache.size>MAX_ROWS)vehicleCache.delete(vehicleCache.keys().next().value);
    }
    function scroll(top) {
      ensure();
      root.scrollTo({ top, left: root.scrollLeft, behavior: 'instant' });
      ownedTop = root.scrollTop; moved = true;
    }
    // Open only a recognized driver's name, never its action menu or an external
    // link. Detail reads have their own time; closing a card never freshens them.
    async function enrichVehicles(){
      const wanted=new Set([...collected].filter(([key,value])=>!rejected.has(key)&&!value.row.vehicleLabel)
        .sort(([a],[b])=>(detailAttempts.get(cacheKey(a))||0)-(detailAttempts.get(cacheKey(b))||0)).slice(0,MAX_DETAILS).map(([key])=>key));
      if(!wanted.size||expandedInitially.size>1)return;
      let opened=null;
      const details=()=>{
        ensure();const found=reader.inspect();
        if(found.panel!==panel||found.result?.organizationId!==organizationId||found.filtered!==first.filtered||found.result?.status!=='observing')throw Error('list_changed');
        for(const key of found.ambiguousKeys||[]){rejected.add(key);collected.delete(key);vehicleCache.delete(cacheKey(key));ambiguous=true;}
        return found;
      };
      const entryFor=(key,found=details())=>(found.entries||[]).find(entry=>identity(entry.row)===key&&!rejected.has(key));
      const click=entry=>{ensure();const target=entry?.detailTarget;if(!target?.isConnected||target.closest('a,input,select,textarea,form,[contenteditable]'))return false;target.click();return true;};
      const closeOwned=async()=>{
        if(!opened)return;const entry=entryFor(opened);
        if(entry?.expanded&&click(entry))await pause(SETTLE_MS);
        opened=null;
      };
      if(root&&root.scrollTop>1)scroll(0);
      for(let step=0;step<MAX_STEPS&&wanted.size;step++){
        if(deadline-Date.now()<1200||MAX_MS-(performance.now()-monotonicStart)<1200)break;
        await paint();const inspected=details();
        for(const current of inspected.entries||[]){
          const key=identity(current.row);if(!wanted.has(key)||rejected.has(key))continue;
          if(deadline-Date.now()<1200||MAX_MS-(performance.now()-monotonicStart)<1200)break;
          wanted.delete(key);detailAttempts.set(cacheKey(key),Date.now());
          if(detailAttempts.size>MAX_ROWS)detailAttempts.delete(detailAttempts.keys().next().value);
          let entry=entryFor(key);if(!entry)continue;
          if(!entry.expanded){if(!click(entry))continue;opened=key;await pause(SETTLE_MS);}
          for(let attempt=0;attempt<3;attempt++){
            entry=entryFor(key);if(!entry)break;
            const box=entry.detailScope?.getBoundingClientRect(),bounds=root?.getBoundingClientRect();
            if(root&&box&&box.height<=root.clientHeight&&box.bottom>bounds.bottom-3){scroll(Math.min(root.scrollHeight-root.clientHeight,root.scrollTop+box.bottom-bounds.bottom+3));await paint();entry=entryFor(key);}
            if(entry?.row.vehicleLabel){rememberVehicle(key,entry.row);const previous=collected.get(key);if(previous)collected.set(key,{...previous,row:{...entry.row}});break;}
            if(attempt<2)await pause(SETTLE_MS);
          }
          if(entry?.expanded&&!entry.row.vehicleLabel)vehicleCache.delete(cacheKey(key));
          await closeOwned();
        }
        if(!root||!wanted.size||root.scrollTop>=root.scrollHeight-root.clientHeight-2)break;
        scroll(Math.min(root.scrollHeight-root.clientHeight,root.scrollTop+Math.max(20,root.clientHeight*.65)));
      }
      await closeOwned();
      // Restore the single card that was already open, if it remains uniquely
      // recognizable. Abort paths deliberately leave the person in control.
      const initial=[...expandedInitially][0],saved=initial&&collected.get(initial);
      if(initial&&saved&&!rejected.has(initial)&&deadline-Date.now()>400){
        if(root&&saved.position!==null)scroll(Math.max(0,Math.min(root.scrollHeight-root.clientHeight,saved.position-10)));
        await paint();const entry=entryFor(initial);if(entry&&!entry.expanded&&click(entry))await pause(SETTLE_MS);
      }
    }
    try {
      ensure();
      if (!reader?.inspect) {
        const result = reader?.read?.();
        first = { result };
        if (!result) throw Error('reader_error');
        for (const row of result.rows || []) collected.set(identity(row), { row: { ...row }, position: null });
        reason = result.status === 'observing' ? 'visible_only' : 'reader_error';
      } else {
        first = reader.inspect(); panel = first.panel; root = first.scrollRoot;
        for (const warning of first.result?.warnings || []) if (typeof warning === 'string' && warning.length <= 200) warnings.add(warning);
        if (!first.result || first.result.status !== 'observing' || !first.result.rows?.length) throw Error('reader_error');
        if (!(root instanceof Element) || !root.isConnected || root === document.scrollingElement || !(panel?.contains(root) || root.contains(panel)) || root.clientHeight < 40) {
          root = null; absorb(first); reason = 'visible_only';
        } else {
          originalTop = root.scrollTop; ownedTop = originalTop;
          if (originalTop > 1) scroll(0);
          for (let step = 0; step < MAX_STEPS; step++) {
            const inspected = await settled();
            if (!absorb(inspected)) break;
            const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
            if (root.scrollTop >= maximum - 2) {
              // One further settled pass gives a virtualized/infinite list time
              // to append its next viewport before declaring its visible end.
              await pause(500);
              const final = await settled();
              if (!absorb(final)) break;
              if (root.scrollTop >= root.scrollHeight - root.clientHeight - 2) { complete = true; reason = 'end_of_list'; break; }
            }
            if (step === MAX_STEPS - 1) { reason = 'step_limit'; break; }
            const heights = (inspected.entries || []).map(entry => entry.element?.getBoundingClientRect().height).filter(height => Number.isFinite(height) && height > 0);
            const overlap = Math.min(root.clientHeight * .45, Math.max(40, ...heights) * 2);
            const next = Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + Math.max(20, root.clientHeight - overlap));
            if (next <= root.scrollTop + 1) throw Error('unstable');
            scroll(next);
          }
        }
        if(collected.size&&reader?.inspect)await enrichVehicles();
      }
    } catch (error) {
      reason = interruption || (Object.hasOwn(messages, error?.message) ? error.message : 'reader_error'); complete = false;
    } finally {
      // Never pull the list away from a person, another route, or a hidden tab.
      if (moved && !interruption && reason !== 'list_changed' && root?.isConnected && document.visibilityState === 'visible' && location.pathname === initialPath && Math.abs(root.scrollTop - ownedTop) <= 2) {
        root.scrollTo({ top: originalTop, left: root.scrollLeft, behavior: 'instant' });
      }
      for (const event of events) document.removeEventListener(event, interaction, true);
      document.removeEventListener('input', changed, true); document.removeEventListener('change', changed, true);
      document.removeEventListener('visibilitychange', hidden); signal?.removeEventListener('abort', externalAbort);
    }
    const at = Date.now();
    if (at < started || [...collected.values()].some(value => Date.parse(value.row.readAt) > at)) { reason = 'reader_error'; complete = false; }
    const hardFailure = ['user_interaction', 'hidden', 'aborted', 'list_changed', 'unstable', 'reader_error'].includes(reason);
    const rows = hardFailure ? [] : [...collected.values()].map(value => value.row).filter(row => Number.isFinite(Date.parse(row.readAt)) && Date.parse(row.readAt) <= at && at - Date.parse(row.readAt) <= MAX_MS + 1000);
    if(hardFailure)vehicleCache.clear();
    for(const row of rows){
      const cached=vehicleCache.get(cacheKey(identity(row))),age=at-Date.parse(cached?.vehicleReadAt);
      if(!row.vehicleLabel&&cached&&age>=0&&age<=VEHICLE_MS&&Date.parse(cached.vehicleReadAt)<=Date.parse(row.readAt))Object.assign(row,cached);
    }
    if (complete && filtered) { complete = false; reason = 'filtered_view'; }
    if (complete && ambiguous) { complete = false; reason = 'ambiguous_identity'; }
    if (rows.length !== collected.size) complete = false;
    const orderedWarnings = reason === 'reader_error' ? [...warnings, messages[reason]] : [messages[reason], ...warnings];
    return { observedAt: new Date(at).toISOString(), sourceAt: null,
      ...((first?.result?.organizationId || organizationId) ? { organizationId: first?.result?.organizationId || organizationId } : {}),
      status: rows.length ? 'observing' : 'error', rows,
      warnings: [...new Set(orderedWarnings.filter(Boolean))].slice(0, 10),
      coverage: { mode: 'list_sweep', complete: complete && rows.length > 0, observed: rows.length, reason,
        vehicleObserved:rows.filter(row=>row.vehicleLabel).length,vehicleComplete:complete&&rows.length>0&&rows.every(row=>row.vehicleLabel) }
    };
  }
  globalThis.LudyUberScanner = Object.freeze({ scan });
})();
