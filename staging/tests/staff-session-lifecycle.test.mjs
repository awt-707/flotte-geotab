import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const planning=readFileSync(new URL('../site/planning.js',import.meta.url),'utf8');
const mineCode=planning.slice(0,planning.indexOf('/** Filtre'));
const rh=readFileSync(new URL('../site/rh.js',import.meta.url),'utf8');
const gateCode=rh.slice(rh.indexOf('async function rhGate('),rh.indexOf('function rhGateView('));
const session=id=>({user:{id}});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function mineFixture(){
  let shift={s:'Jour',day:'2026-11-03'};
  const calls=[],S={session:session('first'),sessionRevision:0,P:{},mine:null};
  const context=vm.createContext({S,shiftAt:()=>shift,rpc:(name,params)=>{const job=deferred();calls.push({name,params,...job});return job.promise;}});
  vm.runInContext(mineCode,context);
  return {S,calls,load:()=>context.mineLoad(),shift:value=>{shift=value;}};
}
test('planning retries a failed read and caches only a successful shift result',async()=>{
  const f=mineFixture();delete f.S.sessionRevision;const failed=f.load();assert.equal(f.S.mineKey,undefined);
  f.calls[0].reject(Error('temporary offline'));await failed;
  assert.equal(f.S.mineKey,undefined);assert.equal(f.S.mine,null);
  const next=f.load();assert.equal(f.calls.length,2);
  f.calls[1].resolve([{user_id:'first',vehicle_key:'OWN'},{user_id:'second',vehicle_key:'OTHER'}]);await next;
  assert.deepEqual([...f.S.mine],['OWN']);assert.equal(f.S.mineKey,'Jour|2026-11-03');
  await f.load();assert.equal(f.calls.length,2);
});
test('concurrent planning callers both wait for the same pending read, including an empty plan',async()=>{
  const f=mineFixture();let firstDone=false,secondDone=false;
  const first=f.load().then(()=>{firstDone=true;}),second=f.load().then(()=>{secondDone=true;});
  assert.equal(f.calls.length,1);await settle();assert.equal(firstDone,false);assert.equal(secondDone,false);
  f.calls[0].resolve([]);await Promise.all([first,second]);
  assert.equal(f.S.mine,null);assert.equal(f.S.mineKey,'Jour|2026-11-03');await f.load();assert.equal(f.calls.length,1);
});
test('an earlier account response cannot commit or clear another account pending planning read',async()=>{
  const f=mineFixture(),first=f.load();f.S.session=session('second');f.S.sessionRevision++;
  const second=f.load();assert.equal(f.calls.length,2);
  f.calls[0].resolve([{user_id:'second',vehicle_key:'OLD ACCOUNT SNAPSHOT'}]);await first;
  assert.equal(f.S.mine,null);assert.equal(f.S.mineKey,undefined);
  const joined=f.load();assert.equal(f.calls.length,2);
  f.calls[1].resolve([{user_id:'second',vehicle_key:'CURRENT'}]);await Promise.all([second,joined]);
  assert.deepEqual([...f.S.mine],['CURRENT']);
});
test('a new login of the same user ignores prior planning results and their failures',async()=>{
  for(const fails of [false,true]){
    const f=mineFixture(),old=f.load();f.S.sessionRevision+=2;
    const current=f.load();assert.equal(f.calls.length,2);
    f.calls[1].resolve([{user_id:'first',vehicle_key:'NEW SESSION'}]);await current;
    if(fails)f.calls[0].reject(Error('old request failed'));else f.calls[0].resolve([{user_id:'first',vehicle_key:'OLD SESSION'}]);
    await old;assert.deepEqual([...f.S.mine],['NEW SESSION']);assert.equal(f.S.mineKey,'Jour|2026-11-03');
    await f.load();assert.equal(f.calls.length,2);
  }
});
test('planning discards a completed old shift and refetches after logout without keeping a user filter',async()=>{
  const f=mineFixture(),day=f.load();f.shift({s:'Nuit',day:'2026-11-03'});const night=f.load();
  f.calls[1].resolve([{user_id:'first',vehicle_key:'NIGHT'}]);await night;
  f.calls[0].resolve([{user_id:'first',vehicle_key:'DAY'}]);await day;
  assert.deepEqual([...f.S.mine],['NIGHT']);assert.equal(f.S.mineKey,'Nuit|2026-11-03');
  f.S.session=null;await f.load();assert.equal(f.S.mine,null);assert.equal(f.S.mineKey,undefined);assert.equal(f.calls.length,2);
  f.S.session=session('first');const next=f.load();assert.equal(f.calls.length,3);f.calls[2].resolve([]);await next;
});
test('an old shift result is discarded even before another caller requests the new shift',async()=>{
  const f=mineFixture(),work=f.load();f.shift({s:'Nuit',day:'2026-11-03'});
  f.calls[0].resolve([{user_id:'first',vehicle_key:'DAY'}]);await work;
  assert.equal(f.S.mine,null);assert.equal(f.S.mineKey,undefined);
  const next=f.load();f.calls[1].resolve([]);await next;assert.equal(f.S.mineKey,'Nuit|2026-11-03');
});
test('a saved planning edit invalidates a pending snapshot even during the same shift and session',async()=>{
  for(const startsNewRead of [false,true]){
    const f=mineFixture(),old=f.load();f.S.mineKey=null;
    const next=startsNewRead?f.load():null;
    f.calls[0].resolve([{user_id:'first',vehicle_key:'BEFORE EDIT'}]);await old;
    assert.equal(f.S.mine,null);
    const refreshed=next||f.load();assert.equal(f.calls.length,2);
    f.calls[1].resolve([{user_id:'first',vehicle_key:'AFTER EDIT'}]);await refreshed;
    assert.deepEqual([...f.S.mine],['AFTER EDIT']);
  }
});

function gateFixture(){
  let admin=false,confirmed=false;
  const calls=[],views=[],S={session:session('first'),sessionRevision:0,rhMe:undefined,rhMeAt:0};
  const context=vm.createContext({S,ROUTING:1,isAdmin:()=>admin,rhOkGet:()=>confirmed,
    rhPauseView:()=>views.push('pause'),rhGateView:()=>views.push('identity'),
    sb:{rpc:name=>{const job=deferred();calls.push({name,...job});return job.promise;}}});
  vm.runInContext(gateCode,context);
  return {S,calls,views,context,gate:my=>context.rhGate(my??context.ROUTING),admin:value=>{admin=value;},confirmed:value=>{confirmed=value;}};
}
test('late staff profile responses never commit to a different route, account or login epoch',async()=>{
  for(const change of ['route','owner','epoch','logout']){
    const f=gateFixture(),old=f.gate();
    if(change==='route')f.context.ROUTING++;
    if(change==='owner')f.S.session=session('second');
    if(change==='epoch')f.S.sessionRevision+=2;
    if(change==='logout')f.S.session=null;
    const current={id:'CURRENT',pointage:false};f.S.rhMe=current;f.S.rhMeAt=123;
    f.calls[0].resolve({data:{id:'OLD',pointage:true,state:'pause'},error:null});
    assert.equal(await old,false,change);assert.equal(f.S.rhMe,current);assert.equal(f.S.rhMeAt,123);assert.deepEqual(f.views,[]);
  }
});
test('staff profile errors leave the read retryable and successful replies keep the current gate rules',async()=>{
  const f=gateFixture(),failed=f.gate();f.calls[0].reject(Error('temporary offline'));assert.equal(await failed,true);
  assert.equal(f.S.rhMe,undefined);assert.equal(f.S.rhMeAt,0);
  const next=f.gate();assert.equal(f.calls.length,2);f.calls[1].resolve({data:{id:'CURRENT',pointage:true,state:'on'},error:null});
  assert.equal(await next,false);assert.deepEqual(f.views,['identity']);assert.ok(f.S.rhMeAt>0);
  f.confirmed(true);const online=f.gate();f.calls[2].resolve({data:{id:'CURRENT',pointage:true,state:'on'},error:null});assert.equal(await online,true);
  const paused=f.gate();f.calls[3].resolve({data:{id:'CURRENT',pointage:true,state:'pause'},error:null});assert.equal(await paused,false);assert.deepEqual(f.views,['identity','pause']);
});
test('staff gate keeps the administrator exemption but a stale route cannot clear current staff state',async()=>{
  const f=gateFixture();f.admin(true);const current={id:'CURRENT',pointage:true};f.S.rhMe=current;
  assert.equal(await f.gate(0),false);assert.equal(f.S.rhMe,current);assert.equal(f.calls.length,0);
  assert.equal(await f.gate(),true);assert.equal(f.S.rhMe,null);assert.equal(f.calls.length,0);
  f.admin(false);f.S.rhMe={id:'CURRENT',pointage:false};f.S.rhMeAt=Date.now();
  assert.equal(await f.gate(),true);assert.equal(f.calls.length,0);
});
