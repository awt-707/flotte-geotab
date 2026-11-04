// Run this exact test on Windows and Linux. All credentials are synthetic;
// no platform override, provider, Supabase session, or developer profile is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import https from 'node:https';
import {initializePrivateRoot} from '../server/private-files.mjs';
import {saveBoltCredentials,readBoltCredentials,BoltClient} from '../server/bolt.mjs';

async function fixture(t){
  let requests=0;
  const noNetwork=()=>{requests++;throw Error('Credential storage must not make an HTTP request');};
  t.mock.method(globalThis,'fetch',noNetwork);
  for(const transport of [http,https])for(const method of ['request','get'])t.mock.method(transport,method,noNetwork);
  const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'ludy-bolt-native-')));
  t.after(async()=>{await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});assert.equal(requests,0);});
  const protection=await initializePrivateRoot(directory);
  assert.equal(protection.protection,process.platform==='win32'?'windows-user-system-acl':'posix-0700');
  const filename=path.join(directory,'profil avec espaces','bolt.env');
  return {directory,filename,noNetwork,requests:()=>requests};
}

test(`native ${process.platform}: private Bolt credentials round-trip spaces, quotes and backslashes without network`,{timeout:60000},async t=>{
  const f=await fixture(t);
  assert.equal(await readBoltCredentials(f.filename),null);
  const input={clientId:'  synthetic client "one" \\path  ',clientSecret:'  synthetic "secret" with \\backslashes and spaces  '};
  assert.equal(await saveBoltCredentials(f.filename,input),undefined,'saving returns no credentials');
  const expected={clientId:input.clientId.trim(),clientSecret:input.clientSecret};
  assert.deepEqual(await readBoltCredentials(f.filename),expected);
  const info=await fs.lstat(f.filename);assert.equal(info.isFile(),true);assert.equal(info.isSymbolicLink(),false);assert.equal(info.nlink,1);
  if(process.platform!=='win32'){
    assert.equal(info.mode&0o777,0o600);assert.equal((await fs.stat(f.directory)).mode&0o777,0o700);
  }
  assert.deepEqual(await fs.readdir(path.dirname(f.filename)),['bolt.env']);assert.equal(f.requests(),0);
});

test(`native ${process.platform}: replacing Bolt credentials survives a new reader and keeps no temporary files`,{timeout:60000},async t=>{
  const f=await fixture(t);
  await saveBoltCredentials(f.filename,{clientId:'synthetic-first',clientSecret:'synthetic-first-secret'});
  const replacement={clientId:'  synthetic second client  ',clientSecret:' second \'quoted\' "secret" \\ remains literal '};
  await saveBoltCredentials(f.filename,replacement);
  // Reinitialization is the startup path. A fresh client reads from disk rather
  // than carrying the earlier credentials in memory; no accessToken is called.
  await initializePrivateRoot(f.directory);
  const restarted=new BoltClient({credentials:()=>readBoltCredentials(f.filename),fetchFn:f.noNetwork});
  assert.deepEqual(await restarted.credentials(),{clientId:replacement.clientId.trim(),clientSecret:replacement.clientSecret});
  assert.equal(restarted.token,null);assert.equal(restarted.tokenPromise,null);assert.equal(f.requests(),0);
  assert.deepEqual(await fs.readdir(path.dirname(f.filename)),['bolt.env']);
});

test(`native ${process.platform}: invalid replacements preserve the prior private Bolt file`,{timeout:60000},async t=>{
  const f=await fixture(t),original={clientId:'synthetic-valid',clientSecret:'synthetic-valid-secret'};
  await saveBoltCredentials(f.filename,original);
  const before=await fs.readFile(f.filename);
  for(const invalid of [
    {clientId:'synthetic-valid',clientSecret:'synthetic\ninjected'},
    {clientId:'x'.repeat(513),clientSecret:'synthetic-valid-secret'},
    {clientId:'synthetic-valid',clientSecret:'x'.repeat(4097)}
  ]){
    await assert.rejects(saveBoltCredentials(f.filename,invalid),error=>error.status===400);
    assert.deepEqual(await fs.readFile(f.filename),before);assert.deepEqual(await readBoltCredentials(f.filename),original);
  }
  assert.deepEqual(await fs.readdir(path.dirname(f.filename)),['bolt.env']);assert.equal(f.requests(),0);
});
