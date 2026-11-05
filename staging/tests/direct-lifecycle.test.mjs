import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../site/direct.js',import.meta.url),'utf8');
function fixture({production=false}={}){
 const calls=[],context=vm.createContext({window:{FLOTTE_CONFIG:{GEOTAB_LOCAL:true,DESKTOP_PRODUCTION:production}},document:{hidden:false,addEventListener(){}},CFG:{GEOTAB_LOCAL:true},S:{session:{user:{id:'first'}},sessionRevision:1,P:{}},ROUTING:1,MIN:60000,HOUR:3600000,STATE_CLS:{},fleetApi:()=>new Promise((resolve,reject)=>calls.push({resolve,reject})),Date,paintCount:0});
 vm.runInContext(code,context);vm.runInContext('applyDirect=()=>{paintCount++;};processLocalLive=()=>{};liveRows=()=>[];',context);return {context,calls,run:text=>vm.runInContext(text,context)};
}
test('desktop shared maps request five-second polling and hidden windows stop reading',async()=>{
 const f=fixture({production:true});assert.equal(f.run('LIVE_SEC'),5);assert.equal(fixture().run('LIVE_SEC'),2);
 f.context.document.hidden=true;await f.run('liveTick(1)');assert.equal(f.calls.length,0);
 f.context.document.hidden=false;const read=f.run('liveTick(1)');assert.equal(f.calls.length,1);f.calls[0].resolve({vehicles:[]});await read;
});
test('intentional map cancellation retains positions and never starts an outage backoff',async()=>{
 const f=fixture();f.run("LIVE.pos={CURRENT:{key:'CURRENT'}};LIVE.at=123;LIVE.localSource={status:'healthy'}");
 const read=f.run('liveTick(1)');f.calls[0].reject(Object.assign(Error('cancelled'),{name:'AbortError'}));await read;
 assert.equal(f.run('LIVE.pos.CURRENT.key'),'CURRENT');assert.equal(f.run('LIVE.at'),123);assert.equal(f.run('LIVE.localSource.status'),'healthy');assert.equal(f.run('LIVE.retryAt||0'),0);assert.equal(f.run('LIVE.busy'),false);
});
test('a slow previous route does not block the new live map or release its in-flight lock',async()=>{
 const f=fixture(),old=f.run('liveTick(1)');assert.equal(f.calls.length,1);f.context.ROUTING=2;const next=f.run('liveTick(2)');assert.equal(f.calls.length,2);
 f.calls[0].resolve({vehicles:[{key:'OLD'}]});await old;assert.equal(f.run('LIVE.busy'),true);assert.equal(f.run('Object.keys(LIVE.pos).length'),0);assert.equal(f.context.paintCount,0);await f.run('liveTick(2)');assert.equal(f.calls.length,2,'the new route coalesces its own calls');
 f.calls[1].resolve({vehicles:[{key:'CURRENT',lat:33.6,lon:-7.6}],source:{status:'healthy'}});await next;assert.equal(f.run('LIVE.busy'),false);assert.equal(f.run('LIVE.pos.CURRENT.key'),'CURRENT');assert.equal(f.context.paintCount,1);
});
test('old account and previous session errors cannot overwrite the current source or set its retry delay',async()=>{
 for(const sameUser of [false,true]){
  const f=fixture(),old=f.run('liveTick(1)');f.context.S.sessionRevision=3;if(!sameUser)f.context.S.session.user.id='next';const next=f.run('liveTick(1)');assert.equal(f.calls.length,2);
  f.calls[1].resolve({vehicles:[{key:'CURRENT'}],source:{status:'healthy'}});await next;f.calls[0].reject(Error('Old account failure'));await old;assert.equal(f.run('LIVE.localSource.status'),'healthy');assert.equal(f.run('LIVE.retryAt||0'),0);assert.equal(f.run('LIVE.pos.CURRENT.key'),'CURRENT');assert.equal(f.context.paintCount,1);
 }
});
test('late contract and private-mission reads never repopulate data after leaving the session',async()=>{
 const f=fixture();let resolveContracts;Object.assign(f.context,{num:(value,fallback)=>value??fallback,withSuccessors:rows=>rows,all:()=>new Promise(resolve=>resolveContracts=resolve)});
 const first=f.run('loadLiveContracts()');f.context.ROUTING=2;f.context.S.session.user.id='next';f.context.S.sessionRevision++;resolveContracts([{num:'OLD CONTRACT'}]);await first;assert.equal(f.run('LIVE.ctr.length'),0);
 let rejectMission;Object.assign(f.context,{all:async table=>table==='contracts'?[]:new Promise((resolve,reject)=>rejectMission=reject),sb:{from:()=>({select(){return this;},not(){return this;},order(){return this;},limit:async()=>({data:[]})})},CRS_BLOCK:[]});
 const second=f.run('loadLiveContracts()');await new Promise(setImmediate);assert.ok(rejectMission);f.context.ROUTING=3;f.context.S.sessionRevision++;f.run("LIVE.mis={current:{id:'CURRENT MISSION'}}");rejectMission(Error('Old mission read'));await second;assert.equal(f.run('LIVE.mis.current.id'),'CURRENT MISSION');
});
