import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createUberPairing} from '../server/uber-pairing.mjs';
const DAY=86400000;
async function fixture(t){
  const parent=new URL('../.local/',import.meta.url);await fs.mkdir(parent,{recursive:true,mode:0o700});
  const folder=await fs.mkdtemp(new URL('uber-pairs-test-',parent).pathname),path=folder+'/pairs.json';
  let clock=Date.parse('2026-10-30T12:00:00Z');const fresh=()=>createUberPairing({path,now:()=>clock});
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));return {path,folder,fresh,advance:ms=>{clock+=ms;},now:()=>clock};
}
test('pairing survives process recreation and only hashes persist in a private file',async t=>{
  const f=await fixture(t),pair=f.fresh(),issued=await pair.issue('local-admin');
  const saved=await fs.readFile(f.path,'utf8');assert.equal(saved.includes(issued.token),false);assert.equal((await fs.stat(f.path)).mode&0o777,0o600);
  assert.equal((await fs.stat(f.folder)).mode&0o777,0o700);assert.equal(JSON.parse(saved).entries[0].hash.length,64);
  pair.close();assert.equal((await f.fresh().verify(issued.token)).user,'local-admin');
  assert.equal(await f.fresh().verify('ludy_uber_bad'),null);assert.equal(await f.fresh().verify('ludy_uber_'+'a'.repeat(43)),null);
});
test('activity refreshes the 30-day idle expiry but cannot extend the 90-day maximum',async t=>{
  const f=await fixture(t),issued=await f.fresh().issue('local-admin'),expires=Date.parse(issued.expires_at);
  for(let i=0;i<3;i++){f.advance(29*DAY);assert.ok(await f.fresh().verify(issued.token));}
  assert.equal((await f.fresh().verify(issued.token)).expires,expires);
  f.advance(3*DAY);assert.equal(await f.fresh().verify(issued.token),null);
  const idle=await f.fresh().issue('another-admin');f.advance(30*DAY);assert.equal(await f.fresh().verify(idle.token),null);
});
test('rotating or revoking one administrator never keeps their old token valid',async t=>{
  const f=await fixture(t),pairs=f.fresh(),a=await pairs.issue('admin-a'),b=await pairs.issue('admin-b'),next=await pairs.issue('admin-a');
  assert.equal(await pairs.verify(a.token),null);assert.ok(await pairs.verify(next.token));assert.ok(await pairs.verify(b.token));
  await pairs.revokeUser('admin-a');assert.equal(await f.fresh().verify(next.token),null);assert.ok(await f.fresh().verify(b.token));
});
test('concurrent rotations remain serialized and activity writes are bounded',async t=>{
  const f=await fixture(t),pairs=f.fresh(),issued=await Promise.all(Array.from({length:10},()=>pairs.issue('admin')));
  const checks=await Promise.all(issued.map(p=>pairs.verify(p.token)));assert.equal(checks.filter(Boolean).length,1);
  const before=await fs.readFile(f.path,'utf8');f.advance(60000);await Promise.all(Array.from({length:20},()=>pairs.verify(issued.at(-1).token)));
  assert.equal(await fs.readFile(f.path,'utf8'),before);f.advance(4*60000);await pairs.verify(issued.at(-1).token);assert.notEqual(await fs.readFile(f.path,'utf8'),before);
});
test('untrusted file permissions, malformed state and symlinks fail closed without replacing data',async t=>{
  const f=await fixture(t);await fs.writeFile(f.path,'invalid',{mode:0o600});await assert.rejects(f.fresh().issue('admin'),/Stockage privé/);
  assert.equal(await fs.readFile(f.path,'utf8'),'invalid');await fs.rm(f.path);
  await f.fresh().issue('admin');await fs.chmod(f.path,0o644);await assert.rejects(f.fresh().issue('admin'),/Stockage privé/);
  await fs.chmod(f.path,0o600);await fs.rename(f.path,f.path+'.target');await fs.symlink(f.path+'.target',f.path);
  await assert.rejects(f.fresh().issue('admin'),/Stockage privé/);
});
