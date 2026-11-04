import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BoltClient,readBoltCredentials,saveBoltCredentials,validateBoltCredentials} from '../server/bolt.mjs';
import {initializePrivateRoot} from '../server/private-files.mjs';
import {requiresCollector} from '../desktop-runtime/admin-context.mjs';

async function fixture(t){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-bolt-')));await initializePrivateRoot(dir);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,file:path.join(dir,'bolt.env')};}
test('Bolt credentials persist privately, preserve punctuation and replace atomically without sibling secrets',async t=>{
  const {dir,file}=await fixture(t),value={clientId:'synthetic-id',clientSecret:'  quoted"slash\\apostrophe\'and=equals  '};
  assert.equal(await readBoltCredentials(file),null);
  await saveBoltCredentials(file,value);assert.deepEqual(await readBoltCredentials(file),value);
  const next={clientId:'replacement',clientSecret:'second-secret'};await saveBoltCredentials(file,next);assert.deepEqual(await readBoltCredentials(file),next);
  assert.deepEqual(await fs.readdir(dir),['bolt.env']);if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await fs.writeFile(file,"BOLT_CLIENT_ID='legacy-id'\nBOLT_CLIENT_SECRET=legacy-secret\n",{mode:0o600});assert.deepEqual(await readBoltCredentials(file),{clientId:'legacy-id',clientSecret:'legacy-secret'});
});
test('Bolt credential validation rejects missing, excessive or injected properties before persistence',async t=>{
  const {dir,file}=await fixture(t);
  for(const value of [null,[],{}, {clientId:'id',clientSecret:'secret',url:'https://example.invalid'}, {clientId:'x'.repeat(513),clientSecret:'s'}, {clientId:'id',clientSecret:'x'.repeat(4097)}, {clientId:'id',clientSecret:'secret\nOTHER=value'}, {clientId:'id\0',clientSecret:'s'}]){
    assert.throws(()=>validateBoltCredentials(value),e=>e.status===400);
    await assert.rejects(saveBoltCredentials(file,value),e=>e.status===400);
  }
  assert.deepEqual(await fs.readdir(dir),[]);
});
test('Bolt rejects oversized and aliased files without returning credential contents',async t=>{
  const {dir,file}=await fixture(t);await fs.writeFile(file,'x'.repeat(32769),{mode:0o600});await assert.rejects(readBoltCredentials(file),e=>e.status===409&&!e.message.includes('xxx'));
  await fs.rm(file);const other=path.join(dir,'other.env');await fs.writeFile(other,'BOLT_CLIENT_ID=id\nBOLT_CLIENT_SECRET=secret\n',{mode:0o600});
  await fs.link(other,file);await assert.rejects(readBoltCredentials(file));await assert.rejects(saveBoltCredentials(file,{clientId:'id',clientSecret:'changed'}));await fs.rm(file);
  if(process.platform!=='win32'){await fs.symlink(other,file);await assert.rejects(readBoltCredentials(file));await assert.rejects(saveBoltCredentials(file,{clientId:'id',clientSecret:'changed'}));}
  assert.match(await fs.readFile(other,'utf8'),/SECRET=secret/);
});
test('replacing Bolt credentials invalidates cached tokens and discards authentication completed after reset',async()=>{
  let release,requests=0;const gate=new Promise(resolve=>{release=resolve;});
  const client=new BoltClient({credentials:async()=>({clientId:'synthetic-id',clientSecret:'synthetic-secret'}),fetchFn:async()=>{requests++;if(requests===1)await gate;return new Response(JSON.stringify({access_token:'token-'+requests,expires_in:600}),{status:200});}});
  const old=client.accessToken();await new Promise(resolve=>setImmediate(resolve));client.resetCredentials();release();
  await assert.rejects(old,e=>e.status===409);assert.equal(client.token,null);
  assert.equal(await client.accessToken(),'token-2');client.resetCredentials();assert.equal(await client.accessToken(),'token-3');
});
test('only exact local Bolt configuration POST is exempt from collector ownership',()=>{
  assert.equal(requiresCollector({method:'POST',url:'/api/fleet/bolt/config'}),false);
  for(const url of ['/api/fleet/bolt/start','/api/fleet/bolt/stop','/api/fleet/bolt/refresh','/api/fleet/bolt/rides','/api/fleet/bolt/config/','/api/fleet/geotab/connect'])assert.equal(requiresCollector({method:'POST',url}),true);
  assert.equal(requiresCollector({method:'DELETE',url:'/api/fleet/bolt/config'}),true);
});
