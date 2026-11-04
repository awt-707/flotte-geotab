import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateMacHost,verifyKit,runMacLocalTest} from '../scripts/mac-local-test.mjs';

const host={platform:'darwin',arch:'arm64',nodeVersion:'22.12.0',macVersion:'15.7.7'};
test('native prerequisites reject Linux, old Node and old macOS before starting',()=>{
  validateMacHost(host);validateMacHost({...host,arch:'x64',nodeVersion:'24.0.0'});
  for(const override of [{platform:'linux'},{arch:'ia32'},{nodeVersion:'22.11.9'},{nodeVersion:'20.20.0'},{nodeVersion:'unknown'},{macVersion:'12.7.1'}])assert.throws(()=>validateMacHost({...host,...override}));
});

const validOutput={target:'macos-arm64',appPath:'/kit/staging/.local/releases/desktop/Local/Ludy Staging.app',folder:'/kit/staging/.local/releases/desktop/Local',signing:'adhoc-local-test',signatureVerified:true,notarized:false,distributable:false};
function runtime(overrides={}) {
  const events=[];
  return {events,options:{root:'/kit',host,verify:async()=>events.push('verify'),readMacVersion:async()=>'15.7.7',checkTools:async()=>events.push('tools'),run:async(command,args,options)=>events.push({command,args,options}),loadBuilder:async()=>({main:async(args)=>{events.push({build:args});return{outputs:[validOutput]};}}),log:()=>{},...overrides}};
}
test('damaged source kit and unsupported host never install packages or launch anything',async()=>{
  for(const override of [{host:{...host,platform:'linux'}},{verify:async()=>{throw Error('hash mismatch');}}]) {
    const r=runtime(override);await assert.rejects(runMacLocalTest(r.options));
    assert.ok(r.events.every(event=>!event?.command&&!event?.build));
  }
});
test('native flow installs locked tools, signs and starts diagnostic only after verification',async()=>{
  const r=runtime();await runMacLocalTest(r.options);
  assert.deepEqual(r.events.slice(0,2),['verify','tools']);
  assert.equal(r.events[2].command,'npm');assert.deepEqual(r.events[2].args,['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund']);
  assert.deepEqual(r.events[3].build,['--draft','--target','macos-arm64','--mac-local-test']);
  assert.equal(r.events[4].command,validOutput.appPath+'/Contents/MacOS/Ludy Staging');
  assert.deepEqual(r.events[4].args,['--diagnostic']);
  assert.equal(r.events.length,5);
});
test('installation, signing failure or incomplete signature evidence prevents diagnostic launch',async()=>{
  const cases=[
    {run:async()=>{throw Error('npm failed');}},
    {loadBuilder:async()=>({main:async()=>{throw Error('codesign failed');}})},
    ...[{signatureVerified:false},{signing:'unsigned'},{target:'macos-x64'},{distributable:true},{appPath:''}].map(changes=>({loadBuilder:async()=>({main:async()=>({outputs:[{...validOutput,...changes}]})})}))
  ];
  for(const override of cases){const r=runtime(override);await assert.rejects(runMacLocalTest(r.options));assert.equal(r.events.filter(x=>x?.command?.includes('.app/')).length,0);}
});
test('manifest validation detects incomplete, changed and redirected kit files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-mac-kit-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=[];
  for(const relative of ['staging/scripts/mac-local-test.mjs','staging/scripts/build-desktop.mjs','staging/scripts/paths.mjs','staging/desktop/package.json','staging/desktop/package-lock.json','staging/desktop/main.cjs']){
    await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),'original');
    files.push({path:relative,sha256:createHash('sha256').update('original').digest('hex')});
  }
  const manifest={format:'ludy-mac-local-kit-v1',files};
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest));
  assert.equal((await verifyKit(root)).files.length,6);
  const filename=path.join(root,files[0].path);
  await fs.writeFile(filename,'changed');await assert.rejects(verifyKit(root),/incomplet ou modifié/);
  await fs.rm(filename);await fs.symlink(path.join(root,files[1].path),filename);await assert.rejects(verifyKit(root),/Fichier du kit invalide/);
  await fs.rm(filename);await fs.writeFile(filename,'original');
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({...manifest,files:files.slice(1)}));await assert.rejects(verifyKit(root));
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({...manifest,files:[...files,{path:'../outside',sha256:files[0].sha256}]}));await assert.rejects(verifyKit(root),/Entrée du manifest invalide/);
});
