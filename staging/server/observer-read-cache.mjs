/** Short-lived observer reads, isolated by the caller's token and service instance. */
export function createObserverReadCache({now=Date.now,ttlMs=5000,maxEntries=256}={}) {
  const entries=new Map();
  const keyFor=(resource,params,token)=>JSON.stringify([token,resource,Object.entries(params).sort(([a],[b])=>a.localeCompare(b))]);
  function invalidate(resources=null) {
    for(const [key,entry] of entries)if(resources===null||resources.includes(entry.resource))entries.delete(key);
  }
  async function read(resource,params,token,load) {
    if(!(ttlMs>0))return load();
    const key=keyFor(resource,params,token),at=now(),old=entries.get(key);
    if(old&&at>=old.startedAt&&at<old.expiresAt)return structuredClone(await old.pending);
    if(old)entries.delete(key);
    const entry={resource,startedAt:at,expiresAt:at+ttlMs,pending:null};
    entry.pending=Promise.resolve().then(load).then(value=>{
      if(value==null||now()<entry.startedAt||now()>=entry.expiresAt){if(entries.get(key)===entry)entries.delete(key);}
      return value;
    },error=>{if(entries.get(key)===entry)entries.delete(key);throw error;});
    entries.set(key,entry);
    while(entries.size>maxEntries)entries.delete(entries.keys().next().value);
    return structuredClone(await entry.pending);
  }
  return {read,invalidate};
}
