import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {KIT_SOURCE_FILES,KIT_LAUNCHER,prepareMacTestKit} from '../scripts/build-mac-test-kit.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-mac-kit-test-')),source=path.join(root,'source'),out=path.join(root,'kit');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(source);
  for(const relative of KIT_SOURCE_FILES) {
    const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,relative==='desktop/package.json'?JSON.stringify({name:'synthetic-client',version:'0.1.1'}):'synthetic public source '+relative);
  }
  return {root,source,out};
}
test('Mac kit copies only the explicit client allowlist, with a complete verifiable manifest',async t=>{
  const {source,out}=await fixture(t);
  for(const relative of ['.local/credentials.json','server/credentials.mjs','desktop/node_modules/private.txt','desktop/server.json','desktop/.env','scripts/unrelated.mjs']) {
    await fs.mkdir(path.dirname(path.join(source,relative)),{recursive:true});await fs.writeFile(path.join(source,relative),'NEVER_EXPORT_PRIVATE_DATA');
  }
  const result=await prepareMacTestKit(out,source),manifest=JSON.parse(await fs.readFile(path.join(out,'manifest.json'),'utf8'));
  assert.deepEqual(manifest,result);assert.equal(manifest.format,'ludy-mac-local-kit-v1');assert.equal(manifest.version,'0.1.1');
  const expected=[...KIT_SOURCE_FILES.map(file=>'staging/'+file),'Preparer Ludy.command','LIRE-MOI.txt'].sort();
  assert.deepEqual(manifest.files.map(file=>file.path).sort(),expected);
  const exported=await fs.readdir(out,{recursive:true,withFileTypes:true});
  assert.equal(exported.filter(item=>item.isFile()).length,expected.length+1);
  let bytes=0;
  for(const entry of manifest.files) {
    const content=await fs.readFile(path.join(out,entry.path));bytes+=content.length;
    assert.equal(entry.sha256,createHash('sha256').update(content).digest('hex'),entry.path);
    assert.ok(!content.includes('NEVER_EXPORT_PRIVATE_DATA'));
  }
  assert.equal(manifest.totalBytes,bytes);
  assert.equal((await fs.stat(path.join(out,'Preparer Ludy.command'))).mode&0o777,0o755);
  assert.match(await fs.readFile(path.join(out,'LIRE-MOI.txt'),'utf8'),/signature ad hoc/);
});
test('Mac kit rejects symlink files, linked parent directories, hardlinks and missing required sources',async t=>{
  for(const variant of ['file-symlink','parent-symlink','hardlink','missing']) {
    await t.test(variant,async t=>{
      const {root,source,out}=await fixture(t),file=path.join(source,'desktop/main.cjs'),original=path.join(root,'outside.txt');
      if(variant==='parent-symlink') {
        await fs.rename(path.join(source,'desktop/assets'),path.join(root,'assets'));
        await fs.symlink(path.join(root,'assets'),path.join(source,'desktop/assets'));
      } else {
        await fs.rename(file,original);
        if(variant==='file-symlink')await fs.symlink(original,file);
        if(variant==='hardlink')await fs.link(original,file);
      }
      await assert.rejects(prepareMacTestKit(out,source));
      await assert.rejects(fs.stat(out),{code:'ENOENT'});
    });
  }
});
test('Mac kit never overwrites or removes an existing destination',async t=>{
  const {source,out}=await fixture(t);await fs.mkdir(out);await fs.writeFile(path.join(out,'sentinel'),'preserve');
  await assert.rejects(prepareMacTestKit(out,source),{code:'EEXIST'});
  assert.deepEqual(await fs.readdir(out),['sentinel']);assert.equal(await fs.readFile(path.join(out,'sentinel'),'utf8'),'preserve');
});
test('Mac source launcher quotes its working directory and preserves normal system protections',()=>{
  assert.match(KIT_LAUNCHER,/^#!\/bin\/sh\nset -eu\n/);
  assert.match(KIT_LAUNCHER,/cd -- "\$\(dirname -- "\$0"\)"/);
  assert.match(KIT_LAUNCHER,/command -v node/);assert.match(KIT_LAUNCHER,/https:\/\/nodejs\.org\/fr\/download/);
  assert.match(KIT_LAUNCHER,/exec node \.\/staging\/scripts\/mac-local-test\.mjs\n$/);
  assert.doesNotMatch(KIT_LAUNCHER,/sudo|xattr|spctl|no-sandbox|curl|wget/);
});
