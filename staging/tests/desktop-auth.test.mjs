import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {GoTrueClient} from '@supabase/auth-js';

const source=readFileSync(new URL('../site/desktop-auth.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../site/index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const session=(id='one',token='synthetic-'+id)=>({user:{id},access_token:token});
function controller(auth,enabled=true){
  const window={};vm.runInNewContext(source,{window});return window.createDesktopAuthRefresh(auth,{enabled});
}
test('ordinary staging never takes control of Supabase refresh',async()=>{
  const inactive=controller(new Proxy({},{get(){assert.fail('Staging must not touch desktop Auth methods');}}),false);
  await inactive.sessionChanged(session());await inactive.sessionChanged(null);await inactive.dispose();
  assert.match(app,/const desktopAuthRefresh = DESKTOP_DATABASE \? window\.createDesktopAuthRefresh\(sb\.auth, \{ enabled: true \}\) : null/);
  assert.ok(html.indexOf('src="desktop-auth.js"')<html.indexOf('src="app.js"'));
});
test('refresh starts only after SDK initialization; logout while initialization is pending never starts it',async()=>{
  const initialized=deferred(),calls=[];
  const auth=controller({initialize:()=>{calls.push('initialize');return initialized.promise;},startAutoRefresh:async()=>calls.push('start'),stopAutoRefresh:async()=>calls.push('stop')});
  const login=auth.sessionChanged(session());await settle();assert.deepEqual(calls,['initialize']);
  const logout=auth.sessionChanged(null);initialized.resolve({error:null});await Promise.all([login,logout]);assert.deepEqual(calls,['initialize','stop']);
  await auth.sessionChanged(session('two'));assert.deepEqual(calls,['initialize','stop','start']);
  await auth.sessionChanged(session('two','rotated'));assert.deepEqual(calls,['initialize','stop','start'],'TOKEN_REFRESHED does not restart a second timer');
});
test('logout waits for an already-starting SDK timer then stops it; disposal prevents a late login',async()=>{
  const pending=deferred(),calls=[];
  const auth=controller({initialize:async()=>{},startAutoRefresh:async()=>{calls.push('start');await pending.promise;},stopAutoRefresh:async()=>calls.push('stop')});
  const login=auth.sessionChanged(session());await settle();const logout=auth.sessionChanged(null);pending.resolve();await Promise.all([login,logout]);assert.deepEqual(calls,['start','stop']);
  await auth.dispose();await auth.sessionChanged(session('late'));assert.deepEqual(calls,['start','stop']);
});
test('an SDK timer setup failure can be retried by the next valid Auth event',async()=>{
  let attempts=0;const auth=controller({initialize:async()=>{},startAutoRefresh:async()=>{if(++attempts===1)throw Error('synthetic setup failure');},stopAutoRefresh:async()=>{}});
  await assert.rejects(auth.sessionChanged(session()));await auth.sessionChanged(session('one','rotated'));assert.equal(attempts,2);
});

test('real installed Auth SDK refreshes a hidden desktop session, propagates rotation, stops on logout and resumes after login',async t=>{
  const callbacks=new Map(),storage=new Map(),http=[],events=[];let visibility='visible',refreshRejected=false;
  const originalWindow=globalThis.window,originalDocument=globalThis.document,originalChannel=globalThis.BroadcastChannel;
  globalThis.window={location:{href:'http://127.0.0.1:4173/'},addEventListener:(type,fn)=>{const list=callbacks.get(type)||new Set();list.add(fn);callbacks.set(type,list);},removeEventListener:(type,fn)=>callbacks.get(type)?.delete(fn)};
  globalThis.document={get visibilityState(){return visibility;}};globalThis.BroadcastChannel=undefined;
  t.after(()=>{if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;globalThis.BroadcastChannel=originalChannel;});
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:Date.parse('2026-11-05T10:00:00Z')});
  const user={id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid'};
  const jwt=offset=>Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+offset})).toString('base64url')+'.synthetic-signature';
  const initial={access_token:jwt(300),refresh_token:'synthetic-initial-refresh',expires_at:Math.floor(Date.now()/1000)+300,expires_in:300,token_type:'bearer',user};
  storage.set('synthetic-desktop-session',JSON.stringify(initial));
  const client=new GoTrueClient({url:'https://auth.example.invalid/auth/v1',storageKey:'synthetic-desktop-session',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,
    storage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>storage.delete(key)},
    fetch:async(url,options={})=>{
      http.push({url:String(url),options});
      if(String(url).includes('/token?grant_type=refresh_token'))return refreshRejected
        ?new Response(JSON.stringify({code:'refresh_token_not_found',msg:'Synthetic revoked session'}),{status:400,headers:{'Content-Type':'application/json'}})
        :new Response(JSON.stringify({access_token:jwt(3600),refresh_token:'synthetic-rotated-refresh',expires_in:3600,token_type:'bearer',user}),{status:200,headers:{'Content-Type':'application/json'}});
      if(String(url).endsWith('/user'))return new Response(JSON.stringify(user),{status:200,headers:{'Content-Type':'application/json'}});
      if(String(url).includes('/logout'))return new Response(null,{status:204});
      throw Error('Unexpected synthetic request '+url);
    }});
  const managed=controller(client);let latest=null;
  const {data:{subscription}}=client.onAuthStateChange((event,value)=>{events.push(event);latest=value;void managed.sessionChanged(value).catch(()=>{});});
  t.after(async()=>{subscription.unsubscribe();await managed.dispose();await client.dispose();});
  await client.initialize();await settle();await managed.sessionChanged((await client.getSession()).data.session);
  assert.equal(callbacks.get('visibilitychange')?.size||0,0,'managed SDK visibility callback is removed after initialization');
  visibility='hidden';for(const callback of callbacks.get('visibilitychange')||[])await callback();
  for(let n=0;n<8;n++){t.mock.timers.tick(30000);await settle();}
  assert.equal(http.filter(r=>r.url.includes('grant_type=refresh_token')).length,1);assert.ok(events.includes('TOKEN_REFRESHED'));assert.notEqual(latest.access_token,initial.access_token);
  assert.equal(JSON.parse(storage.get('synthetic-desktop-session')).refresh_token,'synthetic-rotated-refresh');
  assert.deepEqual([...storage.keys()],['synthetic-desktop-session'],'only the SDK session store holds credentials');
  await client.signOut();await settle();assert.equal(latest,null);assert.ok(events.includes('SIGNED_OUT'));
  const afterLogout=http.length;for(let n=0;n<8;n++){t.mock.timers.tick(30000);await settle();}assert.equal(http.length,afterLogout,'logged-out hidden app does not refresh');
  const signedIn=await client.setSession({access_token:jwt(300),refresh_token:'synthetic-relogin-refresh'});assert.equal(signedIn.error,null);await settle();
  for(let n=0;n<8;n++){t.mock.timers.tick(30000);await settle();}
  assert.equal(http.filter(r=>r.url.includes('grant_type=refresh_token')).length,2,'hidden login restarts one managed refresh loop');
  refreshRejected=true;
  for(let n=0;n<120;n++){t.mock.timers.tick(30000);await settle();}
  assert.equal(latest,null,'a revoked refresh token never keeps the desktop session alive');
  assert.equal(storage.has('synthetic-desktop-session'),false);
  assert.ok(http.filter(r=>r.url.includes('grant_type=refresh_token')).length>2,'the SDK received the synthetic Auth rejection');
  const afterRevocation=http.length;for(let n=0;n<8;n++){t.mock.timers.tick(30000);await settle();}
  assert.equal(http.length,afterRevocation,'the refresh loop stays stopped after the SDK signs out the revoked session');
});
