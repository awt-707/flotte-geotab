import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../site/operations.js',import.meta.url),'utf8'),code=source.slice(source.indexOf('async function opsOverview('),source.indexOf('function opsOnlineDrivers('));
function fixture(){const calls=[],S={session:{user:{id:'first'}}},OPS={overview:null,overviewAt:0,overviewBusy:null,owner:null};const context=vm.createContext({S,OPS,Date,document:{getElementById:()=>null},fleetApi:()=>new Promise((resolve,reject)=>calls.push({resolve,reject}))});vm.runInContext(code,context);vm.runInContext(source.slice(source.indexOf('function operationsCleanup()'),source.indexOf('function opsHTML(')),context);return {S,OPS,calls,cleanup:()=>context.operationsCleanup(),read:force=>context.opsOverview(force)};}
test('overview requests coalesce only for the same user; old completion cannot clear a new pending request',async()=>{
 const f=fixture(),first=f.read();const rejected=assert.rejects(first,/session a changé/);assert.equal(f.calls.length,1);f.S.session={user:{id:'second'}};const second=f.read();assert.equal(f.calls.length,2);f.calls[0].resolve({vehicles:[{key:'PRIVATE FIRST'}]});await rejected;const third=f.read();assert.equal(f.calls.length,2);assert.equal(f.OPS.overview,null);f.calls[1].resolve({vehicles:[{key:'VISIBLE SECOND'}]});await second;await third;assert.equal(f.S.vehList[0].key,'VISIBLE SECOND');assert.equal(f.OPS.overviewBusy,null);
});
test('overview retries after error and does not request data while logged out',async()=>{
 const f=fixture(),first=f.read();const failed=assert.rejects(first,/offline/);f.calls[0].reject(Error('offline'));await failed;assert.equal(f.OPS.overviewBusy,null);const next=f.read();assert.equal(f.calls.length,2);f.calls[1].resolve({vehicles:[]});await next;await f.read();assert.equal(f.calls.length,2);f.S.session=null;await assert.rejects(f.read(),/Reconnectez/);assert.equal(f.calls.length,2);assert.equal(f.OPS.overview,null);
});
test('a new session of the same user neither joins nor restores an earlier session overview',async()=>{
 const f=fixture();f.S.sessionRevision=1;const first=f.read(),old=assert.rejects(first,/session a changé/);f.S.sessionRevision=3;const next=f.read();assert.equal(f.calls.length,2);f.calls[1].resolve({vehicles:[{key:'CURRENT'}]});await next;f.calls[0].resolve({vehicles:[{key:'OLD'}]});await old;assert.equal(f.S.vehList[0].key,'CURRENT');f.S.sessionRevision=5;const fresh=f.read();assert.equal(f.calls.length,3);f.calls[2].resolve({vehicles:[]});await fresh;assert.equal(f.S.vehList.length,0);
});
test('navigation detaches an obsolete request while keeping the last valid snapshot',async()=>{
 const f=fixture(),initial=f.read();f.calls[0].resolve({vehicles:[{key:'KNOWN'}]});await initial;
 const old=f.read(true),failed=assert.rejects(old,{name:'AbortError'});f.cleanup();assert.equal(f.OPS.overview.vehicles[0].key,'KNOWN');
 const next=f.read(true),duplicate=f.read(true);assert.equal(f.calls.length,3,'the new route does not inherit its predecessor’s request');
 f.calls[1].reject(Object.assign(Error('navigation'),{name:'AbortError'}));await failed;assert.ok(f.OPS.overviewBusy);
 f.calls[2].resolve({vehicles:[{key:'CURRENT'}]});await Promise.all([next,duplicate]);assert.equal(f.OPS.overview.vehicles[0].key,'CURRENT');
});
