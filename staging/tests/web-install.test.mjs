import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {verifyWebInstallation} from '../web-runtime/verify-install.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-web-install-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtimeRoot=path.join(root,'runtime'),stateDir=path.join(root,'private-state'),configPath=path.join(root,'public.json');
  const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_fixture',webOrigin:'https://ludy.example.test'};
  await fs.writeFile(configPath,JSON.stringify(config));
  const sources=[];
  for(const file of ['web-runtime/main.mjs','web-runtime/server.mjs','web-runtime/services.mjs','site/index.html']){
    const bytes=Buffer.from('synthetic web file '+file);const target=path.join(runtimeRoot,file);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
    sources.push({path:file,bytes:bytes.length,sha256:hash(bytes)});
  }
  const manifest={format:'ludy-web-runtime-v1',version:'0.1.0',collector:false,configurationEmbedded:false,sources,dependencies:[]};
  const writeManifest=async()=>{const bytes=Buffer.from(JSON.stringify(manifest));await fs.writeFile(path.join(runtimeRoot,'build-manifest.json'),bytes);return hash(bytes);};
  return {runtimeRoot,stateDir,configPath,manifestSha256:await writeManifest(),manifest,writeManifest};
}

test('web installation verifies the delivered files before preparing its separate private state',async t=>{
  const f=await fixture(t),result=await verifyWebInstallation(f);
  assert.deepEqual(result,{verified:true,version:'0.1.0',files:4});
  assert.equal((await fs.stat(f.stateDir)).isDirectory(),true);
  if(process.platform!=='win32')assert.equal((await fs.stat(f.stateDir)).mode&0o777,0o700);
});

test('web installation refuses modified delivery and misplaced private state',async t=>{
  const f=await fixture(t);
  await assert.rejects(verifyWebInstallation({...f,stateDir:path.join(f.runtimeRoot,'state')}));
  if(process.platform==='win32')await assert.rejects(verifyWebInstallation({...f,stateDir:path.join(f.runtimeRoot.toUpperCase(),'state')}));
  await assert.rejects(verifyWebInstallation({...f,manifestSha256:'0'.repeat(64)}));
  await fs.writeFile(path.join(f.runtimeRoot,'site/index.html'),'tampered');
  await assert.rejects(verifyWebInstallation(f));
  await assert.rejects(fs.stat(f.stateDir),{code:'ENOENT'});
});

test('web installation refuses duplicate, escaping, incomplete or collector manifests',async t=>{
  for(const mutate of [m=>m.sources.push(m.sources[0]),m=>{m.sources[0].path='../private.json';},m=>{m.sources.pop();},m=>{m.collector=true;}]){
    const f=await fixture(t);mutate(f.manifest);f.manifestSha256=await f.writeManifest();
    await assert.rejects(verifyWebInstallation(f));
    await assert.rejects(fs.stat(f.stateDir),{code:'ENOENT'});
  }
});
