import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createUberReportBrowserLease} from '../server/uber-report-browser-lease.mjs';

async function fixture(t,{ttlMs=90000}={}){
 const root=new URL('../.local/',import.meta.url);await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(new URL('uber-lease-test-',root).pathname);t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const filePath=dir+'/browser/lease.json';let at=Date.parse('2026-11-02T10:00:00Z');const identity={collectorId:randomUUID(),userId:randomUUID()},other={collectorId:randomUUID(),userId:randomUUID()};
 const create=()=>createUberReportBrowserLease({filePath,now:()=>at,ttlMs});return {dir,filePath,identity,other,create,now:()=>at,advance:ms=>{at+=ms;}};
}
const rejected=(promise,status)=>assert.rejects(promise,error=>error.status===status);

test('private lease persists its owner and expiration across restarts without storing other data',async t=>{
 const f=await fixture(t),lease=f.create();assert.equal(await lease.current(),null);
 const claimed=await lease.claim({...f.identity,token:'DO_NOT_STORE'});assert.deepEqual(claimed,{...f.identity,expiresAt:new Date(f.now()+90000).toISOString()});
 assert.deepEqual(await f.create().current(),claimed);assert.deepEqual(await lease.assertOwner(f.identity),claimed);
 assert.deepEqual(JSON.parse(await fs.readFile(f.filePath,'utf8')),claimed);assert.equal((await fs.stat(f.filePath)).mode&0o777,0o600);assert.equal((await fs.stat(f.dir+'/browser')).mode&0o777,0o700);
 const original=await fs.readFile(f.filePath,'utf8');await lease.current();await lease.assertOwner(f.identity);assert.equal(await fs.readFile(f.filePath,'utf8'),original);
 claimed.collectorId=f.other.collectorId;assert.equal((await lease.current()).collectorId,f.identity.collectorId);
});
test('claim and heartbeat renew only the matching live owner; UUID casing is immaterial',async t=>{
 const f=await fixture(t),lease=f.create();await lease.claim(f.identity);f.advance(1000);
 assert.equal((await lease.claim(f.identity)).expiresAt,new Date(f.now()+90000).toISOString());f.advance(2000);
 assert.equal((await lease.heartbeat({collectorId:f.identity.collectorId.toUpperCase(),userId:f.identity.userId.toUpperCase()})).expiresAt,new Date(f.now()+90000).toISOString());
 for(const identity of [f.other,{...f.identity,userId:f.other.userId},{...f.identity,collectorId:f.other.collectorId}]){
  await rejected(lease.claim(identity),409);await rejected(lease.heartbeat(identity),409);await rejected(lease.assertOwner(identity),409);await rejected(lease.release(identity),409);
 }
 assert.equal((await lease.current()).collectorId,f.identity.collectorId);
});
test('expired leases are invisible, cannot heartbeat, and may be claimed by a new owner',async t=>{
 const f=await fixture(t,{ttlMs:250}),lease=f.create();await lease.claim(f.identity);const original=await fs.readFile(f.filePath,'utf8');f.advance(250);
 assert.equal(await lease.current(),null);assert.equal(await f.create().current(),null);await rejected(lease.assertOwner(f.identity),409);await rejected(lease.heartbeat(f.identity),409);
 assert.deepEqual(await lease.release(f.identity),{released:false});assert.equal(await fs.readFile(f.filePath,'utf8'),original,'reads and expired release leave disk untouched');
 const next=await lease.claim(f.other);assert.equal(next.collectorId,f.other.collectorId);await rejected(lease.release(f.identity),409);assert.deepEqual(await lease.current(),next);
});
test('release removes only an owned live lease and is idempotent while absent',async t=>{
 const f=await fixture(t),lease=f.create();assert.deepEqual(await lease.release(f.identity),{released:false});await rejected(lease.heartbeat(f.identity),409);await rejected(lease.assertOwner(f.identity),409);
 await lease.claim(f.identity);assert.deepEqual(await lease.release(f.identity),{released:true});assert.equal(await f.create().current(),null);assert.deepEqual(await lease.release(f.identity),{released:false});
 await assert.rejects(fs.access(f.filePath),error=>error.code==='ENOENT');
 await lease.claim(f.other);assert.equal((await lease.current()).collectorId,f.other.collectorId);
});
test('concurrent claims have one winner and failed calls do not poison the serialization queue',async t=>{
 const f=await fixture(t),lease=f.create(),claims=await Promise.allSettled([lease.claim(f.identity),lease.claim(f.other)]);
 assert.equal(claims[0].status,'fulfilled');assert.equal(claims[1].status,'rejected');assert.equal(claims[1].reason.status,409);
 f.advance(1000);const changes=await Promise.allSettled([lease.heartbeat(f.identity),lease.release(f.other),lease.release(f.identity),lease.claim(f.other)]);
 assert.deepEqual(changes.map(result=>result.status),['fulfilled','rejected','fulfilled','fulfilled']);assert.equal((await lease.current()).collectorId,f.other.collectorId);
 assert.deepEqual(await fs.readdir(f.dir+'/browser'),['lease.json']);
});
test('malformed lease files fail closed for reads and every mutation without being overwritten',async t=>{
 const f=await fixture(t);await fs.mkdir(f.dir+'/browser',{mode:0o700});
 for(const value of ['broken','null','[]','{}',JSON.stringify({...f.identity,expiresAt:'not-a-date'}),JSON.stringify({...f.identity,expiresAt:'2026-11-02T10:00:00Z'}),JSON.stringify({...f.identity,expiresAt:'2026-11-02T10:00:00.000Z',unexpected:true}),JSON.stringify({...f.identity,collectorId:'bad',expiresAt:'2026-11-02T10:00:00.000Z'}),' '.repeat(1025)]){
  await fs.writeFile(f.filePath,value,{mode:0o600});const lease=f.create();
  for(const call of [()=>lease.current(),()=>lease.claim(f.identity),()=>lease.heartbeat(f.identity),()=>lease.assertOwner(f.identity),()=>lease.release(f.identity)])await rejected(call(),503);
  assert.equal(await fs.readFile(f.filePath,'utf8'),value);
 }
});
test('permissions, directories and symlinked lease paths fail closed, including after a previous valid read',async t=>{
 const f=await fixture(t),lease=f.create();await lease.claim(f.identity);const original=await fs.readFile(f.filePath,'utf8');
 await fs.chmod(f.filePath,0o644);await rejected(lease.current(),503);await rejected(lease.claim(f.identity),503);await fs.chmod(f.filePath,0o600);
 await fs.chmod(f.dir+'/browser',0o755);await rejected(lease.current(),503);await rejected(lease.heartbeat(f.identity),503);await fs.chmod(f.dir+'/browser',0o700);
 await fs.rename(f.filePath,f.dir+'/private.json');await fs.symlink(f.dir+'/private.json',f.filePath);await rejected(lease.current(),503);await rejected(lease.claim(f.identity),503);assert.equal(await fs.readFile(f.dir+'/private.json','utf8'),original);
 await fs.rm(f.filePath);await fs.mkdir(f.filePath,{mode:0o700});await rejected(lease.current(),503);
 await fs.rm(f.dir+'/browser',{recursive:true});await fs.mkdir(f.dir+'/real',{mode:0o700});await fs.symlink(f.dir+'/real',f.dir+'/browser');await rejected(lease.current(),503);await rejected(lease.claim(f.identity),503);
});
test('invalid identities and module options are rejected without creating a lease',async t=>{
 const f=await fixture(t),lease=f.create();for(const identity of [null,{},f.identity.collectorId,{collectorId:'bad',userId:f.identity.userId},{...f.identity,userId:1}]){
  for(const call of [()=>lease.claim(identity),()=>lease.heartbeat(identity),()=>lease.assertOwner(identity),()=>lease.release(identity)])await rejected(call(),400);
 }
 assert.equal(await lease.current(),null);for(const options of [{filePath:'relative.json'},{filePath:null},{ttlMs:0},{ttlMs:-1},{ttlMs:1.5},{now:123}])assert.throws(()=>createUberReportBrowserLease(options),TypeError);
 await rejected(createUberReportBrowserLease({filePath:f.filePath,now:()=>NaN}).claim(f.identity),503);
});
