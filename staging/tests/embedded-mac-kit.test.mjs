import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {prepareEmbeddedMacKit,MAC_EMBEDDED_TOOLS,MAC_EMBEDDED_LAUNCHER} from '../scripts/build-embedded-mac-kit.mjs';
import {verifyEmbeddedMacKit,prepareEmbeddedMac} from '../scripts/mac-embedded-local.mjs';
import {EMBEDDED_CLIENT_FILES,EMBEDDED_SITE_FILES,EMBEDDED_EXTENSION_FILES} from '../scripts/build-embedded-desktop.mjs';
const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_public_key_1234567890'};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-embedded-mac-kit-')),source=path.join(root,'source'),out=path.join(root,'kit');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(source);
  const files=[...new Set([...MAC_EMBEDDED_TOOLS,...EMBEDDED_CLIENT_FILES.map(f=>'desktop/'+f),...EMBEDDED_SITE_FILES.map(f=>'site/'+f),...EMBEDDED_EXTENSION_FILES,'desktop-runtime/server.mjs','server/fixture.mjs','package.json','package-lock.json','vendor/xlsx-0.20.3.tgz'])];
  for(const relative of files){const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,relative==='desktop/package.json'?JSON.stringify({version:'0.2.0'}):'synthetic public source');}
  return{root,source,out};
}
test('production Mac source kit includes allowlisted runtime and public configuration with verified hashes',async t=>{
  const {source,out}=await fixture(t);
  for(const name of ['.local/geotab.json','.env','desktop/server.json','desktop/node_modules/private.cjs','server/profile.json','site/private.json','scripts/secret.mjs','server/fixture.test.mjs']){const file=path.join(source,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'DO_NOT_EXPORT_PRIVATE');}
  const manifest=await prepareEmbeddedMacKit(out,config,source);assert.equal(manifest.version,'0.2.0');assert.equal(manifest.projectRef,config.projectRef);
  assert.deepEqual(await verifyEmbeddedMacKit(out),manifest);assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'desktop-public.json'),'utf8')),config);
  assert.ok(manifest.files.some(entry=>entry.path==='staging/desktop-runtime/server.mjs'));
  assert.ok(manifest.files.some(entry=>entry.path==='staging/site/desktop-worker.js'));
  for(const entry of manifest.files){const bytes=await fs.readFile(path.join(out,entry.path));assert.ok(!bytes.includes('DO_NOT_EXPORT_PRIVATE'));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);}
  await fs.writeFile(path.join(out,'staging/server/extra.mjs'),'unexpected');await assert.rejects(verifyEmbeddedMacKit(out),/Fichier inattendu/);
});
test('Mac source kit rejects secret configuration, linked sources and existing destination',async t=>{
  const {source,out,root}=await fixture(t);
  await assert.rejects(prepareEmbeddedMacKit(out,{...config,serviceKey:'synthetic-secret'},source));
  const linked=path.join(source,'desktop/embedded-main.cjs');await fs.rename(linked,path.join(root,'original.cjs'));await fs.symlink(path.join(root,'original.cjs'),linked);
  await assert.rejects(prepareEmbeddedMacKit(out,config,source));await assert.rejects(fs.stat(out),{code:'ENOENT'});
  await fs.unlink(linked);await fs.rename(path.join(root,'original.cjs'),linked);await fs.mkdir(out);await fs.writeFile(path.join(out,'keep'),'preserved');
  await assert.rejects(prepareEmbeddedMacKit(out,config,source),{code:'EEXIST'});assert.equal(await fs.readFile(path.join(out,'keep'),'utf8'),'preserved');
});
test('kit verification refuses altered payload, symlink payload and omitted bootstrap',async t=>{
  const {source,out}=await fixture(t);await prepareEmbeddedMacKit(out,config,source);
  const file=path.join(out,'staging/desktop/embedded-main.cjs'),original=await fs.readFile(file);await fs.writeFile(file,'modified');await assert.rejects(verifyEmbeddedMacKit(out),/modifiée/);
  await fs.writeFile(file,original);await fs.rm(file);await fs.symlink(path.join(source,'desktop/embedded-main.cjs'),file);await assert.rejects(verifyEmbeddedMacKit(out),/invalide/);
  await fs.rm(file);await fs.writeFile(file,original);
  const manifestPath=path.join(out,'manifest.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  manifest.files=manifest.files.filter(entry=>entry.path!=='staging/desktop/embedded-bootstrap.cjs');await fs.writeFile(manifestPath,JSON.stringify(manifest));await assert.rejects(verifyEmbeddedMacKit(out),/requise absente/);
});
test('native runner checks host and sources before downloads and builds only an ad hoc local app',async t=>{
  const {out}=await fixture(t);await fs.mkdir(out);const events=[],manifest={version:'0.2.0',projectRef:config.projectRef};
  const host={platform:'darwin',arch:'arm64',nodeVersion:'22.12.0'};
  const output={target:'macos-arm64',version:'0.2.0',projectRef:config.projectRef,signing:'adhoc-local-test',signed:true,notarized:false,distributable:false,appPath:path.join(out,'staging/.local/releases/embedded-desktop/local/Ludy.app')};
  const options={directory:out,host,readMacVersion:async()=>'15.7.7',checkTools:async()=>events.push('tools'),verify:async()=>{events.push('verify');return manifest;},run:async(name,args,opts)=>events.push({name,args,opts}),loadBuilder:async()=>({main:async args=>{events.push({builder:args});return output;}}),log:()=>{}};
  assert.equal(await prepareEmbeddedMac(options),output);assert.deepEqual(events.slice(0,2),['verify','tools']);
  assert.deepEqual(events[2].args,['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund']);assert.equal(events[2].opts.env.ELECTRON_SKIP_BINARY_DOWNLOAD,'1');
  assert.deepEqual(events[3].builder,['--config',path.join(out,'desktop-public.json'),'--target','macos-arm64','--mac-local-test']);
  assert.deepEqual(events[4].args,['--verify','--deep','--strict','--verbose=2',output.appPath]);assert.equal(events.length,5,'runner does not launch app or contact Supabase');
  events.length=0;await assert.rejects(prepareEmbeddedMac({...options,host:{...host,platform:'linux'}}),/sur le Mac/);assert.deepEqual(events,[]);
  await assert.rejects(prepareEmbeddedMac({...options,loadBuilder:async()=>({main:async()=>({...output,notarized:true})})}),/résultat de construction/);
});
test('Mac source launcher uses a quoted directory without altering system protections',()=>{
  assert.match(MAC_EMBEDDED_LAUNCHER,/^#!\/bin\/sh\nset -eu/);assert.match(MAC_EMBEDDED_LAUNCHER,/exec node \.\/staging\/scripts\/mac-embedded-local\.mjs/);
  assert.doesNotMatch(MAC_EMBEDDED_LAUNCHER,/sudo|xattr|spctl|no-sandbox|curl|wget/);
});
