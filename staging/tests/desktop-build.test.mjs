import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CLIENT_FILES, parseBuildArgs, prepareClientSource, assertBuildHost, macLocalSignOptions, main } from '../scripts/build-desktop.mjs';

test('desktop builds require an explicit destination or an explicitly unfinished draft',()=>{
  assert.throws(()=>parseBuildArgs([]));
  assert.equal(parseBuildArgs(['--local']).target,'linux-x64');
  assert.equal(parseBuildArgs(['--draft']).kind,'draft');
  for(const args of [ ['--local','--url','https://test.example'], ['--local','--target','windows-x64'], ['--url','http://test.example'], ['--url','https://test.supabase.co'], ['--url','https://ludy-flotte.pages.dev'], ['--url','https://test.example/path'], ['--url','https://test.example/#password'], ['--target','unknown','--draft'] ])assert.throws(()=>parseBuildArgs(args));
  assert.equal(parseBuildArgs(['--url','https://staging.example.com']).serverUrl,'https://staging.example.com');
});
test('Mac packaging refuses cross-builds and requires an explicit native local test',()=>{
  for(const platform of ['linux','win32']) {
    for(const target of ['all','macos-arm64','macos-x64']) {
      assert.throws(()=>assertBuildHost(parseBuildArgs(['--draft','--target',target]),{platform,arch:'x64'}),/Construction Mac refusée/);
    }
    assert.throws(()=>assertBuildHost(parseBuildArgs(['--draft','--target','macos-arm64','--mac-local-test']),{platform,arch:'arm64'}),/Construction Mac refusée/);
    for(const target of ['linux-x64','windows-x64']) assert.equal(assertBuildHost(parseBuildArgs(['--draft','--target',target]),{platform,arch:'x64'})[0][0],target);
  }
  assert.throws(()=>assertBuildHost(parseBuildArgs(['--draft','--target','macos-arm64']),{platform:'darwin',arch:'arm64'}),/Developer ID/);
  for(const target of ['all','linux-x64','windows-x64']) assert.throws(()=>assertBuildHost(parseBuildArgs(['--draft','--target',target,'--mac-local-test']),{platform:'darwin',arch:'arm64'}),/cible explicite/);
  assert.throws(()=>assertBuildHost(parseBuildArgs(['--draft','--target','macos-x64','--mac-local-test']),{platform:'darwin',arch:'arm64'}),/architecture/);
  for(const arch of ['arm64','x64']) assert.equal(assertBuildHost(parseBuildArgs(['--draft','--target','macos-'+arch,'--mac-local-test']),{platform:'darwin',arch})[0][1].arch,arch);
  assert.throws(()=>parseBuildArgs(['--draft','--mac-local-test','--mac-local-test']));
});
test('unsupported Mac build aborts before contacting a remote server',async()=>{
  const previousFetch=globalThis.fetch;
  let called=false;
  globalThis.fetch=async()=>{called=true;throw Error('The build guard must run before this probe');};
  try {
    await assert.rejects(main(['--url','https://staging.example.com','--target','macos-arm64']),/Construction Mac refusée|Developer ID/);
    assert.equal(called,false);
  } finally {globalThis.fetch=previousFetch;}
});
test('ad hoc test signing fails closed and never claims a Developer ID identity',()=>{
  const options=macLocalSignOptions();
  assert.equal(options.identity,'-');assert.equal(options.identityValidation,false);
  assert.equal(options.continueOnError,false,'Packager otherwise swallows a failed signing operation');
  assert.equal(options.strictVerify,true);
  assert.equal(options.preAutoEntitlements,false,'ad hoc signing has no Apple team ID');
  assert.equal(options.preEmbedProvisioningProfile,false);
  assert.equal(options.optionsForFile('main').timestamp,'none');
});
test('a distribution includes only the desktop runtime and public endpoint, never local data',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-package-test-'));
  try {
    const source=path.join(root,'source'),out=path.join(root,'client');await fs.mkdir(source);
    for(const name of CLIENT_FILES){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),'synthetic asset');}
    await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'test',version:'1.0.0',devDependencies:{never:'include'},scripts:{postinstall:'never run'}}));
    await fs.mkdir(path.join(source,'.local'));await fs.writeFile(path.join(source,'.local','credentials.json'),'synthetic password');
    await fs.writeFile(path.join(source,'server.json'),'private previous config');await fs.writeFile(path.join(source,'unknown.txt'),'never included');
    const options=parseBuildArgs(['--url','https://test.example']);await prepareClientSource(out,options,source);
    const entries=await fs.readdir(out,{recursive:true});assert.ok(!entries.some(x=>/\.local|credentials|unknown/.test(x)));
    const manifest=JSON.parse(await fs.readFile(path.join(out,'package.json'),'utf8'));assert.equal(manifest.scripts,undefined);assert.equal(manifest.devDependencies,undefined);
    const config=JSON.parse(await fs.readFile(path.join(out,'server.json'),'utf8'));assert.deepEqual(config,{environment:'staging',serverUrl:'https://test.example',appName:'Ludy Staging'});
    await fs.unlink(path.join(source,'main.cjs'));await fs.symlink(path.join(source,'.local','credentials.json'),path.join(source,'main.cjs'));
    await assert.rejects(prepareClientSource(path.join(root,'rejected'),options,source),/invalide/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('download locks reject active owners and resume after a terminated build',async()=>{
 const {downloadLock}=await import('../scripts/build-desktop.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-download-lock-')),lock=path.join(root,'runtime.lock');
 try{
  const release=await downloadLock(lock,{pid:123,host:'synthetic',isAlive:()=>true});
  await assert.rejects(downloadLock(lock,{pid:124,host:'synthetic',isAlive:()=>true}),/déjà/);
  const resumed=await downloadLock(lock,{pid:125,host:'synthetic',isAlive:()=>false});
  await release();assert.equal(JSON.parse(await fs.readFile(lock,'utf8')).pid,125);
  await resumed();await assert.rejects(fs.stat(lock),{code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
