import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../site/desktop-worker.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
const config={DESKTOP_PRODUCTION:true,STAGING:false,ENVIRONMENT:'production',SUPABASE_PROJECT_REF:'abcdefghijklmnopqrst',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',AUTH_STORAGE_KEY:'ludy-production-abcdefghijklmnopqrst-auth'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=value=>({ok:true,status:200,json:async()=>value});
const rejected=(status,error)=>({ok:false,status,json:async()=>({error})});
const session=(id='first',token='synthetic-token-'+id)=>({user:{id},access_token:token});
function fixture({cfg=config,fetchFn}={}){
  const calls=[],timers=new Map(),delays=new Map(),label={textContent:''},button={},uberButton={},uberLabel={},window={FLOTTE_CONFIG:cfg};let counter=0;
  const context=vm.createContext({window,location:{origin:'http://127.0.0.1:4173'},document:{querySelectorAll:selector=>selector.includes('toggle')?[button]:selector.includes('uber-open')?[uberButton]:selector.includes('uber-status')?[uberLabel]:[label]},AbortController,AbortSignal,
    setTimeout(fn,delay){timers.set(++counter,fn);delays.set(counter,delay);return counter;},clearTimeout(id){timers.delete(id);delays.delete(id);},
    localStorage:{setItem(){throw Error('Token must not be persisted');}},
    fetch:async(url,options)=>{calls.push({url,options});return fetchFn?fetchFn(url,options):response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'leader'}}:{ok:true});}});
  async function runTimer(){
    assert.equal(timers.size,1,'exactly one retry or status poll is scheduled');
    const [id,fn]=timers.entries().next().value,delay=delays.get(id);timers.delete(id);delays.delete(id);fn();await settle();return delay;
  }
  vm.runInContext(source,context);return {calls,timers,delays,runTimer,label,button,uberButton,uberLabel,...window};
}
test('staging keeps the desktop bridge entirely inactive',async()=>{
  const f=fixture({cfg:{STAGING:true,ENVIRONMENT:'staging'}});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  assert.deepEqual(f.calls,[]);assert.equal(f.desktopWorkerHtml(),'');assert.equal(f.timers.size,0);
});
test('user access tokens are sent in headers and only admins can toggle participation',async()=>{
  const f=fixture();await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:false});
  assert.deepEqual(f.calls.map(c=>c.url),['/api/desktop/session','/api/desktop/status']);
  assert.equal(f.calls[0].options.headers.Authorization,'Bearer synthetic-token-first');assert.equal(f.calls[0].options.body,'{}');
  assert.equal(f.label.textContent,'Collecte active sur ce poste');assert.equal(f.button.hidden,true);
  await f.button.onclick();assert.equal(f.calls.length,2);
  f.desktopWorkerMount({admin:true});assert.equal(f.button.hidden,false);await f.button.onclick();
  assert.equal(f.calls[2].url,'/api/desktop/participation');assert.deepEqual(JSON.parse(f.calls[2].options.body),{enabled:false});
  assert.doesNotMatch(f.desktopWorkerHtml()+f.label.textContent,/synthetic-token/);
});
test('logout serializes behind an in-flight session and suppresses its status poll',async()=>{
  const pending=deferred(),f=fixture({fetchFn:(url)=>url.endsWith('/session')?pending.promise:response({ok:true})});
  const login=f.desktopWorkerSessionChanged(session());await settle();
  const logout=f.desktopWorkerSessionChanged(null);assert.match(f.label.textContent,/Connectez-vous/);assert.equal(f.button.hidden,true);
  pending.resolve(response({ok:true}));await Promise.all([login,logout]);
  assert.deepEqual(f.calls.map(c=>c.url),['/api/desktop/session','/api/desktop/logout']);assert.equal(f.timers.size,0);
});
test('an old account status cannot repaint a new account and token refresh preserves the admin control',async()=>{
  const pending=deferred();let statuses=0;
  const f=fixture({fetchFn:(url)=>url.endsWith('/status')&&statuses++===0?pending.promise:response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'follower'}}:{ok:true})});
  const first=f.desktopWorkerSessionChanged(session());await settle();
  const second=f.desktopWorkerSessionChanged(session('second'));
  pending.resolve(response({participationEnabled:true,coordinator:{state:'leader'}}));await Promise.all([first,second]);
  assert.match(f.label.textContent,/autre poste/);f.desktopWorkerMount({admin:true});
  await f.desktopWorkerSessionChanged(session('second','refreshed-synthetic'));
  assert.equal(f.button.hidden,false);assert.equal(f.calls.at(-1).options.headers.Authorization,'Bearer refreshed-synthetic');
});
test('frontend permits the explicit local production target without weakening staging',()=>{
  const guard=app.slice(0,app.indexOf('const S ='));
  function run(cfg,origin='http://127.0.0.1:4173'){
    const calls=[],context=vm.createContext({window:{FLOTTE_CONFIG:cfg,supabase:{createClient:(url,key,options)=>{calls.push({url,key,options});return {};}}},location:{origin,protocol:new URL(origin).protocol},document:{getElementById:()=>({textContent:''})},cacheFetch:()=>()=>{}});
    vm.runInContext(guard,context);return calls;
  }
  const calls=run(config);assert.equal(calls[0].options.auth.storageKey,config.AUTH_STORAGE_KEY);
  assert.throws(()=>run({...config,STAGING:true,DESKTOP_PRODUCTION:false}),/refuse toute connexion/);
  assert.throws(()=>run({...config,SUPABASE_URL:'https://elsewhere.supabase.co'}),/refuse toute connexion/);
  assert.throws(()=>run({...config,AUTH_STORAGE_KEY:'ludy-staging-auth'}),/refuse toute connexion/);
  assert.throws(()=>run(config,'https://public.example'),/refuse toute connexion/);
  assert.equal(run({STAGING:true,SUPABASE_URL:'http://127.0.0.1:57421'})[0].options.auth.storageKey,'ludy-staging-auth');
});
test('Uber opens only from a participating administrator on the elected computer',async()=>{
  let state='follower';const f=fixture({fetchFn:url=>response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state},uber:{state:'login_required'}}:{ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  assert.equal(f.uberButton.disabled,true);await f.uberButton.onclick();assert.equal(f.calls.length,2);
  state='leader';await f.desktopWorkerSessionChanged(session('first','refreshed'));assert.equal(f.uberButton.disabled,false);
  await f.uberButton.onclick();assert.equal(f.calls.at(-2).url,'/api/desktop/uber/open');assert.match(f.uberLabel.textContent,/connexion requise/);
});
test('a new disabled desktop explains activation according to the account role',async()=>{
  const f=fixture({fetchFn:url=>response(url.endsWith('/status')?{participationEnabled:false,coordinator:{state:'paused'}}:{ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  assert.match(f.label.textContent,/Collecte désactivée/);assert.match(f.label.textContent,/Cliquez sur « Participer à la collecte »/);
  assert.equal(f.button.hidden,false);assert.equal(f.button.disabled,false);assert.equal(f.uberButton.disabled,true);
  f.desktopWorkerMount({admin:false});assert.match(f.label.textContent,/Un administrateur doit activer/);assert.equal(f.button.hidden,true);
  assert.equal(f.calls.length,2,'Mounting never silently activates collection');
});
test('coordination errors are visible even when collection is disabled and never expose arbitrary status text',async()=>{
  let error='Coordination non disponible : vérifier les migrations de production.';
  const f=fixture({fetchFn:url=>response(url.endsWith('/status')?{participationEnabled:false,coordinator:{state:'paused'},error}:{ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  assert.match(f.label.textContent,/vérifier la mise à jour de la base Ludy/);
  assert.doesNotMatch(f.label.textContent,/Cliquez sur/);
  error='Bearer secret-token https://user:password@example.invalid/?apikey=secret';
  await f.desktopWorkerSessionChanged(session('first','refreshed'));
  assert.match(f.label.textContent,/demande une vérification/);assert.doesNotMatch(f.label.textContent,/secret|password|apikey|example\.invalid|Bearer/);
});
test('a rejected participation request explains the backend failure without adding a second poll',async()=>{
  const f=fixture({fetchFn:url=>url.endsWith('/participation')?rejected(503,'Coordination Supabase indisponible.'):response(url.endsWith('/status')?{participationEnabled:false,coordinator:{state:'paused'}}:{ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});await f.button.onclick();
  assert.match(f.label.textContent,/Participation inchangée/);assert.match(f.label.textContent,/Vérifiez Internet/);
  assert.equal(f.timers.size,1);assert.equal(f.button.disabled,false);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/participation')).length,1);
});
test('an Uber connection warning does not hide the active collection state',async()=>{
  const f=fixture({fetchFn:url=>response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'leader'},error:'Connectez Uber sur ce poste pour reprendre ses rapports.'}:{ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  assert.match(f.label.textContent,/^Collecte active sur ce poste · Uber demande une connexion/);assert.equal(f.uberButton.disabled,false);
});
test('expired authentication shows a reconnect action and never displays response secrets',async()=>{
  const f=fixture({fetchFn:()=>rejected(401,'upstream secret-session-token')});
  await f.desktopWorkerSessionChanged(session());
  assert.match(f.label.textContent,/session Ludy a expiré/);assert.match(f.label.textContent,/reconnectez-vous/);
  assert.doesNotMatch(f.label.textContent,/secret|synthetic-token/);assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
});
test('transient binding failures recover automatically using only the current user token',async()=>{
  for(const failure of [408,429,500,503,'network','timeout']){
    let attempts=0;
    const f=fixture({fetchFn:url=>{
      if(url.endsWith('/session')&&attempts++===0){
        if(typeof failure==='number')return rejected(failure,'Bearer server-secret');
        throw Object.assign(Error('Bearer network-secret'),{name:failure==='timeout'?'TimeoutError':'TypeError'});
      }
      return response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'leader'}}:{ok:true});
    }});
    await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
    assert.match(f.label.textContent,/nouvelle tentative automatique/);assert.doesNotMatch(f.label.textContent,/Bearer|secret|synthetic-token/);
    assert.equal(f.button.disabled,true);assert.equal(f.calls.length,1);
    assert.equal(await f.runTimer(),2000);
    assert.deepEqual(f.calls.map(c=>c.url),['/api/desktop/session','/api/desktop/session','/api/desktop/status']);
    for(const call of f.calls)assert.equal(call.options.headers.Authorization,'Bearer synthetic-token-first');
    assert.equal(f.label.textContent,'Collecte active sur ce poste');assert.equal(f.button.disabled,false);
    assert.equal(f.timers.size,1);assert.equal([...f.delays.values()][0],5000);
  }
});
test('binding retries back off to a capped delay without duplicate events multiplying requests',async()=>{
  const f=fixture({fetchFn:()=>rejected(503,'temporary failure')});
  await f.desktopWorkerSessionChanged(session());
  for(const expected of [2000,4000,8000,16000,30000,30000,30000]){
    const before=f.calls.length,timer=[...f.timers.keys()][0];
    await f.desktopWorkerSessionChanged(session());await f.desktopWorkerSessionChanged(session());
    assert.equal(f.calls.length,before);assert.equal([...f.timers.keys()][0],timer);
    assert.equal(await f.runTimer(),expected);assert.equal(f.calls.length,before+1);
  }
  assert.equal(f.timers.size,1);assert.ok(f.calls.every(c=>c.url.endsWith('/session')));
});
test('authentication and other permanent binding rejections do not retry',async()=>{
  for(const code of [400,401,403,409]){
    const f=fixture({fetchFn:()=>rejected(code,'secret-session-token')});
    await f.desktopWorkerSessionChanged(session());await f.desktopWorkerSessionChanged(session());
    assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);assert.doesNotMatch(f.label.textContent,/secret|synthetic-token/);
  }
});
test('logout cancels pending binding retries and ignores an already queued old timer',async()=>{
  const f=fixture({fetchFn:url=>url.endsWith('/session')?rejected(503,'temporary'):response({ok:true})});
  await f.desktopWorkerSessionChanged(session());const staleRetry=[...f.timers.values()][0];
  await f.desktopWorkerSessionChanged(null);staleRetry();await settle();
  assert.deepEqual(f.calls.map(c=>c.url),['/api/desktop/session','/api/desktop/logout']);
  assert.equal(f.timers.size,0);assert.match(f.label.textContent,/Connectez-vous/);
});
test('token refresh replaces a pending binding retry and resets its backoff',async()=>{
  const f=fixture({fetchFn:()=>rejected(503,'temporary')});
  await f.desktopWorkerSessionChanged(session());await f.runTimer();
  const staleRetry=[...f.timers.values()][0];
  await f.desktopWorkerSessionChanged(session('first','synthetic-rotated'));
  assert.equal(f.timers.size,1);assert.equal([...f.delays.values()][0],2000);
  const timer=[...f.timers.keys()][0];staleRetry();await settle();
  assert.equal(f.calls.length,3);assert.equal([...f.timers.keys()][0],timer);
  await f.runTimer();assert.equal(f.calls.at(-1).options.headers.Authorization,'Bearer synthetic-rotated');
});
test('account changes invalidate pending binding retries even if the caller supplies the same token',async()=>{
  let failing=true;
  const f=fixture({fetchFn:url=>url.endsWith('/session')&&failing?rejected(503,'temporary'):response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'leader'}}:{ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  const staleRetry=[...f.timers.values()][0];failing=false;
  await f.desktopWorkerSessionChanged(session('second','synthetic-token-first'));staleRetry();await settle();
  assert.deepEqual(f.calls.map(c=>c.url),['/api/desktop/session','/api/desktop/session','/api/desktop/status']);
  assert.equal(f.button.hidden,true);assert.equal(f.timers.size,1);assert.equal([...f.delays.values()][0],5000);
});
test('logout during an in-flight retry aborts it and neither late success nor failure revives collection',async()=>{
  for(const failsLate of [false,true]){
    const pending=deferred();let attempts=0;
    const f=fixture({fetchFn:url=>url.endsWith('/session')?(attempts++===0?rejected(503,'temporary'):pending.promise):response({ok:true})});
    await f.desktopWorkerSessionChanged(session());await f.runTimer();
    const retrySignal=f.calls.at(-1).options.signal,logout=f.desktopWorkerSessionChanged(null);
    assert.equal(retrySignal.aborted,true);
    if(failsLate)pending.reject(Error('old network failure'));else pending.resolve(response({ok:true}));
    await logout;
    assert.deepEqual(f.calls.map(c=>c.url),['/api/desktop/session','/api/desktop/session','/api/desktop/logout']);
    assert.equal(f.timers.size,0);assert.match(f.label.textContent,/Connectez-vous/);
  }
});
test('a token refresh during an in-flight retry never polls with the obsolete token',async()=>{
  const pending=deferred();let attempts=0;
  const f=fixture({fetchFn:url=>{
    if(url.endsWith('/session')){attempts++;if(attempts===1)return rejected(503,'temporary');if(attempts===2)return pending.promise;}
    return response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'leader'}}:{ok:true});
  }});
  await f.desktopWorkerSessionChanged(session());await f.runTimer();
  const refresh=f.desktopWorkerSessionChanged(session('first','synthetic-rotated'));
  pending.resolve(response({ok:true}));await refresh;
  assert.equal(f.calls.filter(c=>c.url.endsWith('/status')).length,1);
  assert.equal(f.calls.at(-1).options.headers.Authorization,'Bearer synthetic-rotated');assert.equal(f.timers.size,1);
});
test('a failed status request keeps the actionable error and disables controls',async()=>{
  const f=fixture({fetchFn:url=>url.endsWith('/status')?rejected(403,'Accès administrateur requis.'):response({ok:true})});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});
  assert.match(f.label.textContent,/compte administrateur/);assert.equal(f.button.disabled,true);assert.equal(f.uberButton.disabled,true);assert.equal(f.timers.size,1);
});
test('unknown server and thrown transport errors never echo secret details',async()=>{
  let networkFailure=false;
  const f=fixture({fetchFn:url=>{
    if(url.endsWith('/participation')){if(networkFailure)throw Error('Bearer network-secret');return rejected(502,'token=server-secret');}
    return response(url.endsWith('/status')?{participationEnabled:false,coordinator:{state:'paused'}}:{ok:true});
  }});
  await f.desktopWorkerSessionChanged(session());f.desktopWorkerMount({admin:true});await f.button.onclick();
  assert.match(f.label.textContent,/fermez et rouvrez Ludy/);assert.doesNotMatch(f.label.textContent,/secret|token=/);
  networkFailure=true;await f.button.onclick();assert.match(f.label.textContent,/Vérifiez Internet/);assert.doesNotMatch(f.label.textContent,/Bearer|secret/);assert.equal(f.timers.size,1);
});
