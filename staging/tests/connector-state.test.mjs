import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createConnectorState} from '../server/connector-state.mjs';

async function fixture(t){const root=new URL('../.local/',import.meta.url);await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(new URL('connector-test-',root).pathname);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('operator intent persists across restarts; sources default to paused and concurrent updates preserve all three',async t=>{
  const dir=await fixture(t),path=dir+'/state.json',state=createConnectorState({path});
  assert.deepEqual(await state.read(),{bolt:false,geotab:false,myclicar:false});
  await Promise.all([state.set('bolt',true),state.set('geotab',true),state.set('myclicar',true)]);
  const resumed=createConnectorState({path});assert.deepEqual(await resumed.read(),{bolt:true,geotab:true,myclicar:true});
  await resumed.set('bolt',false);assert.deepEqual(await createConnectorState({path}).read(),{bolt:false,geotab:true,myclicar:true});
  await resumed.set('myclicar',false);assert.deepEqual(await createConnectorState({path}).read(),{bolt:false,geotab:true,myclicar:false});
  assert.equal((await fs.stat(path)).mode&0o777,0o600);assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path,'utf8'))).sort(),['enabled','version']);
});
test('legacy version one preferences keep existing intent and default MyClicar to paused',async t=>{
  const dir=await fixture(t),path=dir+'/state.json',legacy='{"version":1,"enabled":{"bolt":true,"geotab":false}}\n';
  await fs.writeFile(path,legacy,{mode:0o600});
  const state=createConnectorState({path});assert.deepEqual(await state.read(),{bolt:true,geotab:false,myclicar:false});
  assert.equal(state.enabled('myclicar'),false);assert.equal(state.error,null);
  assert.equal(await fs.readFile(path,'utf8'),legacy,'reading old preferences does not rewrite the file');
  await state.set('myclicar',true);
  assert.deepEqual(JSON.parse(await fs.readFile(path,'utf8')),{version:1,enabled:{bolt:true,geotab:false,myclicar:true}});
  assert.deepEqual(await createConnectorState({path}).read(),{bolt:true,geotab:false,myclicar:true});
  assert.equal((await fs.stat(path)).mode&0o777,0o600);
});
test('corrupt, public or symlinked preferences cannot enable a connector or be overwritten silently',async t=>{
  const dir=await fixture(t),path=dir+'/state.json';
  for(const input of ['garbage','{"version":1,"enabled":{"bolt":"yes","geotab":false}}','{"version":1,"enabled":{"bolt":false,"geotab":false,"myclicar":"yes"}}','{"version":1,"enabled":{"bolt":false,"geotab":false,"myclicar":null}}']){
    await fs.writeFile(path,input,{mode:0o600});const state=createConnectorState({path});await assert.rejects(state.set('bolt',true),/indisponibles/);assert.equal(state.enabled('bolt'),false);assert.ok(state.error);assert.equal(await fs.readFile(path,'utf8'),input);
  }
  await fs.writeFile(path,'{"version":1,"enabled":{"bolt":true,"geotab":true}}');await fs.chmod(path,0o644);await assert.rejects(createConnectorState({path}).read(),/indisponibles/);
  await fs.chmod(path,0o600);await fs.symlink(path,dir+'/link.json');await assert.rejects(createConnectorState({path:dir+'/link.json'}).read(),/indisponibles/);
});
