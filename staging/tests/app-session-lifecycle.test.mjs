import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
const reads=source.slice(source.indexOf('const PK ='),source.indexOf('// ---------- Lectures gardées'));
const references=source.slice(source.indexOf('async function loadRef('),source.indexOf('// ---------- Agences'));
const authCode=source.slice(source.indexOf('let AUTH_EVENT_REVISION ='));
const routeCode=source.slice(source.indexOf('async function route()'),source.indexOf("window.addEventListener('hashchange'"));
const session=id=>({user:{id,email:id+'@example.invalid'}});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function readFixture(){
 const pending=[],S={session:session('first'),sessionRevision:1,P:null,vehList:[]};
 const query=()=>{const q={select:()=>q,order:()=>q,range:()=>{const d=deferred();pending.push(d);return d.promise;}};return q;};
 const context=vm.createContext({S,sb:{from:query,rpc:query},PARAM_DEFAULTS:{},CFG:{STAGING:true},STAGING_TZ_RULES:[],setTzRules(){},rptRuleFr:s=>s,HORS:'HORS'});
 vm.runInContext(reads+'\n'+references,context);return {S,pending,context};
}
test('paged table and RPC reads discard responses after an account changes',async()=>{
 for(const method of ['all','rpcAll']){
  const f=readFixture(),read=f.context[method]('vehicles'),rejected=assert.rejects(read,/session a changé/);
  f.S.session=session('second');f.S.sessionRevision++;
  f.pending[0].resolve({data:[{key:'first-session-row'}],error:null});await rejected;
  assert.equal(f.pending.length,1,'no further pages belong to the previous session');
 }
});
test('a new login of the same account invalidates the previous session reads',async()=>{
 const f=readFixture(),read=f.context.all('vehicles'),rejected=assert.rejects(read,/session a changé/);
 f.S.sessionRevision+=2;f.pending[0].resolve({data:[],error:null});await rejected;
});
test('reference tables commit together only for the current session',async()=>{
 const f=readFixture(),load=f.context.loadRef(),rejected=assert.rejects(load,/session a changé/);
 assert.equal(f.pending.length,5);f.S.session=session('second');f.S.sessionRevision++;
 for(const p of f.pending)p.resolve({data:[],error:null});await rejected;
 assert.equal(f.S.P,null);assert.deepEqual(f.S.vehList,[]);
 const fresh=f.context.loadRef();for(const p of f.pending.slice(5))p.resolve({data:[],error:null});await fresh;
 assert.deepEqual(JSON.parse(JSON.stringify(f.S.P)),{});assert.equal(f.S.agencies.length,0);
});

function authFixture(){
 const initial=deferred(),timers=[],password=deferred(),calls={routes:0,updates:0},S={session:session('first'),sessionRevision:1,profile:{role:'admin'},P:{},veh:{old:{}},vehList:[{key:'old'}],rules:{old:{}},drv:{old:'driver'},agencies:[{id:1}],agName:{1:'old'}};
 let callback;
 const context=vm.createContext({S,LIVE:{},SHELL_KEY:'old',sb:{auth:{onAuthStateChange:fn=>{callback=fn;},getSession:()=>initial.promise,updateUser:async()=>{calls.updates++;return {};}}},cacheUser(){},sessReset(){},$:()=>null,route:()=>{calls.routes++;},setTimeout:fn=>{timers.push(fn);},askText:()=>password.promise,alert(){}});
 vm.runInContext(authCode,context);return {S,initial,timers,password,calls,event:(event,value)=>callback(event,value)};
}
test('a delayed initial session cannot restore a session after logout',async()=>{
 const f=authFixture();f.event('SIGNED_OUT',null);f.initial.resolve({data:{session:session('first')}});await settle();
 assert.equal(f.S.session,null);assert.equal(f.calls.routes,1);assert.equal(f.S.veh,null);assert.equal(f.S.vehList.length,0);assert.equal(f.S.agencies.length,0);assert.equal(f.S.profile,null);
});
test('initial signed-out auth event still renders the login screen',async()=>{
 const f=authFixture();f.S.session=null;f.event('INITIAL_SESSION',null);f.initial.resolve({data:{session:null}});await settle();assert.equal(f.calls.routes,1);
});
test('password recovery releases the auth callback and ignores a changed session',async()=>{
 const f=authFixture();assert.equal(f.event('PASSWORD_RECOVERY',session('first')),undefined);
 assert.equal(f.timers.length,1);const prompt=f.timers[0]();f.event('SIGNED_IN',session('second'));
 f.password.resolve('synthetic-test-password');await prompt;assert.equal(f.calls.updates,0);
});
test('late profile lookup cannot populate another route or session',async()=>{
 for(const error of [null,{message:'temporary unavailable'}]){
  const profile=deferred(),app={innerHTML:'new screen'},S={session:session('first'),profile:null,timers:[],channel:null};
  const q={select:()=>q,eq:()=>q,maybeSingle:()=>profile.promise};
  const c=vm.createContext({S,ROUTING:0,SITE_NEW:false,document:{getElementById:()=>null},pageOf:()=> 'cockpit',extHide(){},clearInterval(){},sb:{from:()=>q},$:()=>app});
  vm.runInContext(routeCode,c);const work=c.route();c.ROUTING++;S.session=session('second');profile.resolve({data:error?null:{role:'admin'},error});await work;
  assert.equal(S.profile,null);assert.equal(app.innerHTML,'new screen');
 }
});
test('the staging access page keeps testers on the local or shared test origin',async()=>{
 const code=source.slice(source.indexOf('async function pageApplication()'),source.indexOf('// ---------- Volets visibles'));
 for(const shared of [false,true]){
  const origin=shared?'https://test.example.invalid':'http://127.0.0.1:4173',node={innerHTML:''};
  const c=vm.createContext({CFG:{STAGING:true,SHARED_STAGING:shared},location:{origin},$:()=>node,esc:s=>s});
  vm.runInContext(code,c);await c.pageApplication();assert.ok(node.innerHTML.includes(origin));
  assert.match(node.innerHTML,/navigateur/);assert.doesNotMatch(node.innerHTML,/\.exe|\.dmg|github\.com/);
  assert.ok(node.innerHTML.includes(shared?'code de partage':'cet ordinateur'));
 }
});
