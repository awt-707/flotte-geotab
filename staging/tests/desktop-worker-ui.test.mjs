import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../site/desktop-worker.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
const config={DESKTOP_PRODUCTION:true,STAGING:false,ENVIRONMENT:'production',SUPABASE_PROJECT_REF:'abcdefghijklmnopqrst',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',AUTH_STORAGE_KEY:'ludy-production-abcdefghijklmnopqrst-auth'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const response=value=>({ok:true,status:200,json:async()=>value});
const session=(id='first',token='synthetic-token-'+id)=>({user:{id},access_token:token});
function fixture({cfg=config,fetchFn}={}){
  const calls=[],timers=new Map(),label={textContent:''},button={},uberButton={},uberLabel={},window={FLOTTE_CONFIG:cfg};let counter=0;
  const context=vm.createContext({window,location:{origin:'http://127.0.0.1:4173'},document:{querySelectorAll:selector=>selector.includes('toggle')?[button]:selector.includes('uber-open')?[uberButton]:selector.includes('uber-status')?[uberLabel]:[label]},AbortController,AbortSignal,
    setTimeout(fn){timers.set(++counter,fn);return counter;},clearTimeout(id){timers.delete(id);},
    localStorage:{setItem(){throw Error('Token must not be persisted');}},
    fetch:async(url,options)=>{calls.push({url,options});return fetchFn?fetchFn(url,options):response(url.endsWith('/status')?{participationEnabled:true,coordinator:{state:'leader'}}:{ok:true});}});
  vm.runInContext(source,context);return {calls,timers,label,button,uberButton,uberLabel,...window};
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
