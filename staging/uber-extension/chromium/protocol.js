(() => {
  'use strict';
  const ENDPOINT='http://127.0.0.1:4173/api/fleet/uber/ingest';
  const COLLECTION_STATUS='http://127.0.0.1:4173/api/fleet/uber/collection-status';
  const STATES=new Set(['available','on_trip','to_pickup','offline','unknown']);
  const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const exact=(object,allowed)=>object && typeof object==='object' && !Array.isArray(object) && Object.keys(object).every(key=>allowed.includes(key));
  const bounded=(value,max)=>typeof value==='string' && value.length>0 && value.length<=max;
  const timestamp=value=>typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  function permittedUrl(value) {
    try {const url=new URL(value);return url.origin==='https://fleethub.uber.com' && !url.username && !url.password && /^\/orgs\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/livemap\/?$/i.test(url.pathname);}catch{return false;}
  }
  function payload(input,collectorId,now=Date.now()) {
    if(!exact(input,['observedAt','sourceAt','organizationId','status','rows','warnings','coverage']) || !UUID.test(collectorId) || !timestamp(input.observedAt) || input.sourceAt!==null || !['observing','error','stopped'].includes(input.status) || !Array.isArray(input.rows) || input.rows.length>200 || !Array.isArray(input.warnings) || input.warnings.length>10 || input.warnings.some(value=>!bounded(value,200)))throw Error('Lecture invalide.');
    if(now-Date.parse(input.observedAt)>30000 || Date.parse(input.observedAt)-now>5000)throw Error('Lecture trop ancienne.');
    if(input.organizationId!==undefined && !UUID.test(input.organizationId))throw Error('Flotte invalide.');
    if(input.status!=='observing' && input.rows.length || input.status==='observing' && !input.rows.length)throw Error('Périmètre invalide.');
    if(input.coverage!==undefined && (!exact(input.coverage,['mode','complete','observed','reason','vehicleObserved','vehicleComplete']) || input.coverage.mode!=='list_sweep' || typeof input.coverage.complete!=='boolean' || input.coverage.observed!==input.rows.length || input.coverage.reason!==undefined&&!/^[a-z_]{1,40}$/.test(input.coverage.reason) || input.status!=='observing'&&input.coverage.complete || input.coverage.vehicleObserved!==undefined&&(!Number.isInteger(input.coverage.vehicleObserved)||input.coverage.vehicleObserved!==input.rows.filter(row=>row.vehicleLabel).length)||input.coverage.vehicleComplete!==undefined&&(typeof input.coverage.vehicleComplete!=='boolean'||input.coverage.vehicleComplete&&(!input.coverage.complete||!input.rows.length||input.rows.some(row=>!row.vehicleLabel)))))throw Error('Couverture invalide.');
    const identities=new Set();
    for(const row of input.rows) {
      if(!exact(row,['sourceId','name','rawState','state','readAt','sourceAt','vehicleLabel','vehicleModel','vehicleReadAt','vehicleState']) || row.sourceId!==null && !UUID.test(row.sourceId) || !bounded(row.name,160) || !bounded(row.rawState,160) || !STATES.has(row.state) || !timestamp(row.readAt) || Date.parse(row.readAt)>Date.parse(input.observedAt) || Date.parse(input.observedAt)-Date.parse(row.readAt)>20000 || now-Date.parse(row.readAt)>30000 || row.sourceAt!==null || row.vehicleLabel!==undefined && !bounded(row.vehicleLabel,160)
        ||row.vehicleModel!==undefined&&(!row.vehicleLabel||!bounded(row.vehicleModel,100))||row.vehicleReadAt!==undefined&&(!row.vehicleLabel||!timestamp(row.vehicleReadAt)||Date.parse(row.vehicleReadAt)>Date.parse(row.readAt)||now-Date.parse(row.vehicleReadAt)>180000)||row.vehicleState!==undefined&&(!row.vehicleLabel||!STATES.has(row.vehicleState)))throw Error('Chauffeur invalide.');
      const key=row.sourceId || row.name.normalize('NFKC').trim().toLowerCase();if(identities.has(key))throw Error('Identité répétée.');identities.add(key);
    }
    const output={collectorId,...input};
    if(new TextEncoder().encode(JSON.stringify(output)).length>64*1024)throw Error('Lecture trop volumineuse.');
    return output;
  }
  function destination(value) {if(value!==ENDPOINT&&value!==COLLECTION_STATUS)throw Error('Seul le serveur local Ludy est autorisé.');return value;}
  globalThis.LudyUberProtocol=Object.freeze({ENDPOINT,COLLECTION_STATUS,permittedUrl,payload,destination});
})();
